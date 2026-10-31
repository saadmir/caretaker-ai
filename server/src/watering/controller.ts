import { EventEmitter } from 'node:events';
import { config, type AiMode, type ZoneConfig } from '../config.js';
import type { Sprinkler, SprinklerStatus, ValveState } from '../devices/sprinkler.js';
import { notify } from '../integrations/bark.js';
import { fetchWeather, type WeatherSnapshot } from '../integrations/weather.js';
import type { Store } from '../store.js';
import { fmtDayTime, fmtDuration, HOUR, MIN } from '../util/time.js';
import { AiSchedule } from './ai-schedule.js';
import { Alerts } from './alerts.js';
import { checkDryRule, shouldRunNow, type DryRuleStatus } from './dry-rule.js';

const TICK_MS = 15_000;
const WEATHER_RETRY_MS = MIN;
const SKIP_NOTICE_EVERY_MS = 12 * HOUR;

/** One valve: its settings, its device, and the controller's bookkeeping for it. */
export class Zone {
  dryRule: DryRuleStatus | null = null;
  readonly alerts: Alerts;
  lastSkipNoticeAt = 0;
  pendingReason: string | null = null; // reason of a command not yet confirmed by the ESP32
  runReason: string | null = null; // why the valve opened, for the record written when it closes

  constructor(
    readonly cfg: ZoneConfig,
    readonly sprinkler: Sprinkler,
    store: Store,
    watchOnline: boolean,
  ) {
    this.alerts = new Alerts(sprinkler, store, cfg.name, watchOnline);
  }

  get id(): number {
    return this.cfg.id;
  }

  get name(): string {
    return this.cfg.name;
  }
}

/**
 * Owns the watering side of the house: polls the weather, runs the plain dry rule
 * for each zone and the AI schedule every 15 s, handles dashboard commands, and turns
 * the ESP32's valve reports into log entries, watering records and notifications.
 */
export class WateringController extends EventEmitter<{ change: [] }> {
  weather: WeatherSnapshot | null = null;
  weatherError: string | null = null;
  readonly zones: Zone[];
  readonly ai: AiSchedule;

  private timers: NodeJS.Timeout[] = [];
  private weatherRetry: NodeJS.Timeout | null = null;

  constructor(
    sprinklers: Sprinkler[],
    private readonly store: Store,
  ) {
    super();
    // All zones are valves on the same ESP32, so the first one speaks for the board's online state.
    this.zones = sprinklers.map((s, i) => new Zone(config.zones[i]!, s, store, i === 0));
    this.ai = new AiSchedule({
      store,
      zones: this.zones,
      weather: () => this.weather,
      startRun: (zone, minutes, reason) => this.startRun(zone, minutes, reason),
    });
  }

  start(): void {
    for (const z of this.zones) {
      z.sprinkler.on('valve', (next, prev, status) => void this.onValveChange(z, next, prev, status));
      z.sprinkler.on('update', () => this.emit('change'));
    }
    this.zones[0]!.sprinkler.on('online', (online) => void this.onOnlineChange(online));
    this.ai.on('change', () => this.changed());

    void this.refreshWeather();
    this.timers.push(setInterval(() => void this.refreshWeather(), config.weather.pollMinutes * MIN));
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    if (this.weatherRetry) clearTimeout(this.weatherRetry);
  }

  zone(id: number): Zone {
    const z = this.zones.find((z) => z.id === id);
    if (!z) throw new Error(`No zone ${id}`);
    return z;
  }

  // Dashboard commands

  manualOn(zoneId: number, minutes: number): void {
    const z = this.zone(zoneId);
    this.requireOnline(z);
    this.startRun(z, minutes, 'manual'); // 0 = until turned off (the firmware failsafe still caps it)
  }

  manualOff(zoneId: number): void {
    const z = this.zone(zoneId);
    this.requireOnline(z);
    z.pendingReason = 'manual';
    z.sprinkler.turnOff('manual');
  }

  setAutoEnabled(enabled: boolean): void {
    this.store.update({ autoEnabled: enabled });
    this.store.log('info', `Automatic watering ${enabled ? 'enabled' : 'paused'}`);
    this.changed();
  }

  setZoneAutoEnabled(zoneId: number, enabled: boolean): void {
    const z = this.zone(zoneId);
    this.store.updateZone(z.id, { autoEnabled: enabled });
    this.store.log('info', `Automatic watering ${enabled ? 'enabled' : 'turned off'} for ${z.name}`);
    this.changed();
  }

  setAiMode(mode: AiMode): void {
    this.store.update({ aiMode: mode });
    this.store.log('info', `AI gardener mode: ${mode}`);
    this.changed();
  }

  async refreshWeather(): Promise<void> {
    try {
      const w = await fetchWeather();
      const firstFetch = this.weather === null;
      this.weather = w;
      if (this.weatherError) this.store.log('weather', 'Weather data available again');
      this.weatherError = null;
      this.recordRain(w, firstFetch);
    } catch (err) {
      const msg = (err as Error).message;
      if (this.weatherError !== msg) this.store.log('error', `Weather fetch failed: ${msg}`);
      this.weatherError = msg;
      // Don't wait a whole poll interval, e.g. when the network isn't up yet after boot.
      this.weatherRetry ??= setTimeout(() => {
        this.weatherRetry = null;
        void this.refreshWeather();
      }, WEATHER_RETRY_MS);
    }
    this.changed();
  }

  // Internals

  private tick(): void {
    const now = Date.now();
    for (const z of this.zones) {
      z.sprinkler.checkHeartbeat(now);
      z.alerts.check(now);
    }
    this.evaluateDryRule();
    this.ai.tick(new Date(now));
  }

  /** Re-check the rules and push the new state to the dashboard. */
  private changed(): void {
    this.evaluateDryRule();
    this.emit('change');
  }

  private startRun(z: Zone, minutes: number, reason: string): void {
    z.pendingReason = reason;
    z.sprinkler.turnOn(minutes * 60, reason);
  }

  private requireOnline(z: Zone): void {
    if (!z.sprinkler.status.online) throw new Error('Sprinkler controller (ESP32) is offline');
  }

  /** Remember the latest rain: either the model shows a wet hour, or it's raining right now. */
  private recordRain(w: WeatherSnapshot, firstFetch: boolean): void {
    for (const at of [w.lastRainHourAt, w.rainingNow ? w.fetchedAt : null]) {
      if (!at) continue;
      const prev = this.store.state.lastRainAt;
      if (prev && new Date(at) <= new Date(prev)) continue;
      this.store.update({ lastRainAt: at });
      if (!firstFetch || !prev) this.store.log('weather', `Rain recorded at ${fmtDayTime(at)}`);
    }
  }

  private evaluateDryRule(): void {
    const now = new Date();
    const aiInCharge = this.ai.inCharge(now);
    for (const z of this.zones) {
      const s = z.sprinkler.status;
      const rule = checkDryRule({
        now,
        state: this.store.state,
        zone: this.store.zone(z.id),
        weather: this.weather,
        valveOn: s.valve === 'on',
        online: s.online,
        aiInCharge,
        config,
      });
      z.dryRule = rule;

      if (rule.blockedByWeather && now.getTime() - z.lastSkipNoticeAt > SKIP_NOTICE_EVERY_MS) {
        z.lastSkipNoticeAt = now.getTime();
        this.store.log('skip', `${z.name}: watering due but skipped: ${rule.blockedBy}`);
        void notify('Sprinkler skipped', `${z.name}: watering is due but skipped: ${rule.blockedBy}.`, { priority: 'low' });
      }
      if (!shouldRunNow(rule)) continue;

      this.store.log('info', `${z.name}: starting automatic run, ${Math.round(rule.hoursDry)} h since last rain/watering`);
      this.startRun(z, config.schedule.autoRunMinutes, 'auto');
      // Count it as watered now, so the rule can't fire again before the ESP32 confirms.
      this.store.updateZone(z.id, { lastWateredAt: now.toISOString() });
    }
  }

  private async onValveChange(z: Zone, next: ValveState, prev: ValveState, s: SprinklerStatus): Promise<void> {
    const reason = s.reason ?? z.pendingReason ?? 'unknown';
    z.pendingReason = null;
    z.alerts.onValveChange();

    if (next === 'on') {
      z.runReason = reason;
      this.store.updateZone(z.id, { lastWateredAt: s.onSince ?? new Date().toISOString() });
      this.store.log('on', `${z.name} ON (${reason})`);
      const detail = describeRun(reason, s.remainingSec);
      await notify(`${z.name} ON`, prev === 'unknown' ? `Detected ON at startup. ${detail}` : `${label(reason)}. ${detail}`);
    } else if (next === 'off' && prev === 'on') {
      await this.recordWatering(z, reason, s);
    }
    this.emit('change');
  }

  private async recordWatering(z: Zone, reason: string, s: SprinklerStatus): Promise<void> {
    const now = new Date();
    const ranMs = s.onSince ? now.getTime() - Date.parse(s.onSince) : null;
    // After an ESP32 reboot the run's pulse count is gone; don't record a bogus 0 gal.
    const gallons = s.runGallons !== null && reason !== 'boot' ? Math.round(s.runGallons * 10) / 10 : undefined;

    this.store.updateZone(z.id, { lastOffAt: now.toISOString() });
    if (s.onSince && ranMs !== null) {
      this.store.addWatering({
        zone: z.id,
        start: s.onSince,
        minutes: Math.round((ranMs / MIN) * 10) / 10,
        reason: z.runReason ?? reason,
        ...(gallons !== undefined && { gallons }),
      });
    }
    z.runReason = null;

    const ran = ranMs !== null ? ` after ${fmtDuration(ranMs)}` : '';
    const used = gallons !== undefined ? `, ${gallons.toFixed(1)} gal` : '';
    this.store.log('off', `${z.name} OFF${ran}${used} (${reason})`);
    await notify(`${z.name} OFF`, `${label(reason)}${ran}${used}.`, {
      priority: reason === 'failsafe' ? 'high' : 'default',
    });
  }

  private async onOnlineChange(online: boolean): Promise<void> {
    const wasAlerted = this.zones[0]!.alerts.onOnlineChange(online);
    this.store.log('device', online ? 'Controller online' : 'Controller offline');
    if (online && wasAlerted) await notify('Sprinkler controller back online', 'The ESP32 reconnected.');
    this.emit('change');
  }
}

function describeRun(reason: string, remainingSec: number | null): string {
  if (reason === 'auto') return `Automatic run for ${config.schedule.autoRunMinutes} min.`;
  if (!remainingSec) return 'Running.';
  const left = fmtDuration(remainingSec * 1000);
  return reason === 'ai' ? `AI plan, ${left}.` : `Will turn off in ${left}.`;
}

function label(reason: string): string {
  switch (reason) {
    case 'auto': return `Automatic watering (${config.schedule.dryHoursThreshold} h dry rule)`;
    case 'manual': return 'Manual (dashboard)';
    case 'ai': return 'AI gardener';
    case 'timer': return 'Run timer finished';
    case 'failsafe': return 'ESP32 failsafe limit reached';
    case 'boot': return 'Controller restarted';
    default: return `Reason: ${reason}`;
  }
}
