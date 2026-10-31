import { EventEmitter } from 'node:events';
import { aiErrorIsPermanent, aiErrorMessage, decideWatering } from '../agent/gardener.js';
import { describePlan } from '../agent/plan.js';
import { config } from '../config.js';
import { notify } from '../integrations/bark.js';
import type { WeatherSnapshot } from '../integrations/weather.js';
import type { AiDecisionRecord, Store, ZonePlan } from '../store.js';
import { HOUR, localDate, MIN } from '../util/time.js';
import type { Zone } from './controller.js';
import { gallonsPerMinute } from './flow-rate.js';

const RETRY_MS = 10 * MIN;
const MAX_ATTEMPTS = 3;
const CYCLE_STALE_MS = 2 * HOUR; // a planned cycle that can't start this late is dropped

export interface AiScheduleDeps {
  store: Store;
  zones: Zone[];
  weather: () => WeatherSnapshot | null;
  startRun: (zone: Zone, minutes: number, reason: string) => void;
}

/**
 * Runs the AI gardener on its daily schedule and carries out its plan.
 *
 * Modes: off (AI not used), advise (AI decides and notifies, nothing waters),
 * auto (the plan waters). If the AI fails three times, or with an error retrying
 * won't fix, the day is marked failed and the plain dry rule takes over until tomorrow.
 */
export class AiSchedule extends EventEmitter<{ change: [] }> {
  busy = false;
  error: string | null = null;
  private attempts = { date: '', count: 0, nextAt: 0 };

  constructor(private readonly deps: AiScheduleDeps) {
    super();
  }

  /** In auto mode with a working AI, the dry rule stands down. */
  inCharge(now: Date): boolean {
    const st = this.deps.store.state;
    return st.aiMode === 'auto' && config.ai.apiKeySet && st.aiFailedDate !== localDate(now);
  }

  tick(now: Date): void {
    const st = this.deps.store.state;
    if (st.aiMode === 'off' || !config.ai.apiKeySet) return;
    if (this.dailyDecisionDue(now)) this.runScheduledDecision(now);
    if (st.aiMode !== 'auto' || !st.autoEnabled) return;
    const d = st.aiDecisions[0];
    if (!d || d.forDate !== localDate(now)) return;
    for (const zone of this.deps.zones) {
      const plan = d.zones.find((p) => p.zone === zone.id);
      if (plan && this.deps.store.zone(zone.id).autoEnabled) this.runDuePlanCycle(now, zone, plan);
    }
  }

  /** Ask for a decision now (daily schedule, or the dashboard's "Ask AI now"). */
  async decide(trigger: 'scheduled' | 'manual'): Promise<AiDecisionRecord> {
    if (!config.ai.apiKeySet) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    if (this.busy) throw new Error('The AI is already deciding');
    const { store } = this.deps;
    this.busy = true;
    this.emit('change');
    try {
      const mode = store.state.aiMode;
      const d = await decideWatering(store.state, this.deps.weather(), mode);
      this.error = null;
      store.addDecision(d);
      this.announce(d, trigger);
      return d;
    } catch (err) {
      this.error = aiErrorMessage(err);
      store.log('error', `AI decision failed: ${this.error}`);
      throw err;
    } finally {
      this.busy = false;
      this.emit('change');
    }
  }

  private dailyDecisionDue(now: Date): boolean {
    const st = this.deps.store.state;
    const today = localDate(now);
    if (this.attempts.date !== today) this.attempts = { date: today, count: 0, nextAt: 0 };

    const minutesNow = now.getHours() * 60 + now.getMinutes();
    const afterDecisionTime = minutesNow >= config.ai.decisionHour * 60 + config.ai.decisionMinute;
    const beforeWindowEnd = now.getHours() < config.schedule.windowEndHour;
    const alreadyDecided = st.aiDecisions.some((d) => d.forDate === today);
    return (
      afterDecisionTime && beforeWindowEnd && !alreadyDecided && st.aiFailedDate !== today &&
      !this.busy && now.getTime() >= this.attempts.nextAt
    );
  }

  private runScheduledDecision(now: Date): void {
    const today = localDate(now);
    this.attempts.count++;
    this.decide('scheduled').catch((err) => {
      if (this.attempts.count < MAX_ATTEMPTS && !aiErrorIsPermanent(err)) {
        this.attempts.nextAt = Date.now() + RETRY_MS;
        return;
      }
      this.deps.store.update({ aiFailedDate: today });
      this.deps.store.log('alert', 'AI unavailable today; the plain watering rules apply');
      void notify(
        'AI gardener unavailable',
        `Today's decision failed (${this.error}). The plain watering rules cover today.`,
        { priority: 'high' },
      );
      this.emit('change');
    });
  }

  /** Start the zone's next cycle of today's plan once it's due, if it's still safe to. */
  private runDuePlanCycle(now: Date, zone: Zone, d: ZonePlan): void {
    const { store } = this.deps;
    const sprinkler = zone.sprinkler;
    const i = d.cycles.findIndex((c) => c.status === 'pending');
    if (i < 0) return;
    const cycle = d.cycles[i]!;
    const due = Date.parse(cycle.startAt);
    if (now.getTime() < due) return;

    const stopPlan = (why: string) => {
      for (const c of d.cycles) if (c.status === 'pending') c.status = 'skipped';
      store.touch();
      store.log('skip', `${zone.name}: AI plan stopped: ${why}`);
      void notify('Sprinkler skipped', `${zone.name}: today's AI watering plan was stopped: ${why}.`, { priority: 'low' });
      this.emit('change');
    };

    if (sprinkler.status.valve === 'on') return; // e.g. a manual run; wait for it to finish
    if (!sprinkler.status.online) {
      if (now.getTime() - due > CYCLE_STALE_MS) stopPlan('controller offline');
      return;
    }
    if (this.deps.weather()?.rainingNow) return stopPlan('it is raining');
    if (i > 0 && d.cycles[i - 1]!.status !== 'started') return stopPlan('an earlier cycle did not run');
    const last = store.zone(zone.id).lastWateredAt;
    if (i === 0 && last) {
      const since = now.getTime() - Date.parse(last);
      if (since < zone.cfg.minHoursBetweenWaterings * HOUR) {
        return stopPlan(`already watered ${Math.round(since / HOUR)} h ago`);
      }
    }

    // Starting late? Shift the later cycles too, so each still gets its full soak time.
    const late = now.getTime() - due;
    if (late > MIN) {
      for (const c of d.cycles.slice(i + 1)) c.startAt = new Date(Date.parse(c.startAt) + late).toISOString();
    }
    cycle.status = 'started';
    store.touch();
    store.log('info', `${zone.name}: AI plan cycle ${i + 1} of ${d.cycles.length}, ${cycle.minutes} min`);
    this.deps.startRun(zone, cycle.minutes, 'ai');
  }

  private announce(d: AiDecisionRecord, trigger: string): void {
    const { store } = this.deps;
    const mode = store.state.aiMode;
    const lines: string[] = [];
    let anyWillWater = false;
    for (const zone of this.deps.zones) {
      const p = d.zones.find((z) => z.zone === zone.id);
      if (!p) continue;
      const plan = p.action === 'water' ? describePlan(p.cycles, gallonsPerMinute(store.state.waterings, zone.cfg)) : 'skip';
      store.log('ai', `AI (${trigger}) for ${d.forDate}, ${zone.name}: ${plan}${p.note ? ` — ${p.note}` : ''}`);
      for (const a of p.adjustments) store.log('ai', `Guardrail (${zone.name}): ${a}`);

      let why = '';
      if (p.action === 'water') {
        const willWater = mode === 'auto' && store.state.autoEnabled && store.zone(zone.id).autoEnabled;
        anyWillWater ||= willWater;
        if (!willWater) {
          why = mode !== 'auto' ? `${mode} mode` : !store.state.autoEnabled ? 'automatic watering is paused' : 'automatic watering is off for this zone';
          why = ` (suggested only: ${why})`;
        }
      }
      const adjusted = p.adjustments.length ? ` Adjusted by limits: ${p.adjustments.join(' ')}` : '';
      lines.push(`${zone.name}: ${plan}${why}.${adjusted}`);
    }
    store.log('ai', `AI headline: ${d.headline}`);
    void notify(`AI: ${d.headline}`, `${d.reasoning}\n\n${lines.join('\n')}`, {
      priority: anyWillWater ? 'default' : 'low',
    });
  }
}
