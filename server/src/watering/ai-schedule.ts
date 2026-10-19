import { EventEmitter } from 'node:events';
import { aiErrorIsPermanent, aiErrorMessage, decideWatering } from '../agent/gardener.js';
import { describePlan } from '../agent/plan.js';
import { config } from '../config.js';
import type { Sprinkler } from '../devices/sprinkler.js';
import { notify } from '../integrations/bark.js';
import type { WeatherSnapshot } from '../integrations/weather.js';
import type { AiDecisionRecord, Store } from '../store.js';
import { HOUR, localDate, MIN } from '../util/time.js';
import { gallonsPerMinute } from './flow-rate.js';

const RETRY_MS = 10 * MIN;
const MAX_ATTEMPTS = 3;
const CYCLE_STALE_MS = 2 * HOUR; // a planned cycle that can't start this late is dropped

export interface AiScheduleDeps {
  store: Store;
  sprinkler: Sprinkler;
  weather: () => WeatherSnapshot | null;
  startRun: (minutes: number, reason: string) => void;
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
    if (st.aiMode === 'auto' && st.autoEnabled) this.runDuePlanCycle(now);
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

  /** Start the next cycle of today's plan once it's due, if it's still safe to. */
  private runDuePlanCycle(now: Date): void {
    const { store, sprinkler } = this.deps;
    const d = store.state.aiDecisions[0];
    if (!d || d.forDate !== localDate(now)) return;
    const i = d.cycles.findIndex((c) => c.status === 'pending');
    if (i < 0) return;
    const cycle = d.cycles[i]!;
    const due = Date.parse(cycle.startAt);
    if (now.getTime() < due) return;

    const stopPlan = (why: string) => {
      for (const c of d.cycles) if (c.status === 'pending') c.status = 'skipped';
      store.touch();
      store.log('skip', `AI plan stopped: ${why}`);
      void notify('Sprinkler skipped', `Today's AI watering plan was stopped: ${why}.`, { priority: 'low' });
      this.emit('change');
    };

    if (sprinkler.status.valve === 'on') return; // e.g. a manual run; wait for it to finish
    if (!sprinkler.status.online) {
      if (now.getTime() - due > CYCLE_STALE_MS) stopPlan('controller offline');
      return;
    }
    if (this.deps.weather()?.rainingNow) return stopPlan('it is raining');
    if (i > 0 && d.cycles[i - 1]!.status !== 'started') return stopPlan('an earlier cycle did not run');
    const last = store.state.lastWateredAt;
    if (i === 0 && last) {
      const since = now.getTime() - Date.parse(last);
      if (since < config.ai.limits.minHoursBetweenWaterings * HOUR) {
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
    store.log('info', `AI plan: cycle ${i + 1} of ${d.cycles.length}, ${cycle.minutes} min`);
    this.deps.startRun(cycle.minutes, 'ai');
  }

  private announce(d: AiDecisionRecord, trigger: string): void {
    const { store } = this.deps;
    const mode = store.state.aiMode;
    const plan = describePlan(d.cycles, gallonsPerMinute(store.state.waterings));
    store.log('ai', `AI (${trigger}) for ${d.forDate}: ${d.action === 'water' ? plan : 'skip'} — ${d.headline}`);
    for (const a of d.adjustments) store.log('ai', `Guardrail: ${a}`);

    const willWater = mode === 'auto' && store.state.autoEnabled;
    let footer = '';
    if (d.action === 'water') {
      footer = willWater
        ? `\n\nPlan: ${plan}.`
        : `\n\nSuggested: ${plan}. Not watering automatically (${mode === 'auto' ? 'automatic watering is paused' : `${mode} mode`}).`;
    }
    const adjusted = d.adjustments.length ? `\n\nAdjusted by limits: ${d.adjustments.join(' ')}` : '';
    void notify(`AI: ${d.headline}`, `${d.reasoning}${footer}${adjusted}`, {
      priority: d.action === 'water' && willWater ? 'default' : 'low',
    });
  }
}
