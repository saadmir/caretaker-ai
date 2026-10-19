import { config } from '../config.js';
import type { Sprinkler } from '../devices/sprinkler.js';
import { notify } from '../integrations/bark.js';
import type { Store } from '../store.js';
import { fmtDuration, MIN } from '../util/time.js';

/**
 * Things worth waking the owner for: the controller going offline, the valve running
 * long, water flowing past a closed valve, or no water with the valve open.
 * check() runs on every controller tick; each alert fires once until its cause clears.
 */
export class Alerts {
  private offlineSince: number | null = Date.now(); // offline until the ESP32 first reports
  private offlineAlerted = false;
  private longRunAlertedAt: number | null = null;
  private flowWhileOffSince: number | null = null;
  private leakAlerted = false;
  private noFlowAlerted = false;

  constructor(
    private readonly sprinkler: Sprinkler,
    private readonly store: Store,
  ) {}

  check(now: number): void {
    this.checkOffline(now);
    this.checkLongRun(now);
    this.checkLeak(now);
    this.checkNoFlow(now);
  }

  onValveChange(): void {
    this.longRunAlertedAt = null;
    this.noFlowAlerted = false;
  }

  /** Returns true if an "offline" alert had gone out, so the caller can say it's back. */
  onOnlineChange(online: boolean): boolean {
    const wasAlerted = this.offlineAlerted;
    this.offlineSince = online ? null : Date.now();
    this.offlineAlerted = false;
    return wasAlerted;
  }

  private checkOffline(now: number): void {
    const limit = config.alerts.offlineAfterMinutes * MIN;
    if (this.sprinkler.status.online || !this.offlineSince || this.offlineAlerted) return;
    if (now - this.offlineSince <= limit) return;
    this.offlineAlerted = true;
    this.store.log('alert', 'Sprinkler controller is offline');
    void notify(
      'Sprinkler controller offline',
      `The ESP32 has not reported for ${config.alerts.offlineAfterMinutes}+ minutes. ` +
        `If the valve was on, the ESP32's own timer will still close it.`,
      { priority: 'high' },
    );
  }

  private checkLongRun(now: number): void {
    const s = this.sprinkler.status;
    if (s.valve !== 'on' || !s.onSince) return;
    const onFor = now - Date.parse(s.onSince);
    const limit = config.alerts.longRunMinutes * MIN;
    const grace = Math.min(MIN, limit * 0.05); // a 30 min run that closes on time shouldn't alert
    const repeatDue = !this.longRunAlertedAt || now - this.longRunAlertedAt >= config.alerts.longRunRepeatMinutes * MIN;
    if (onFor <= limit + grace || !repeatDue) return;
    this.longRunAlertedAt = now;
    this.store.log('alert', `Sprinkler has been ON for ${fmtDuration(onFor)}`);
    void notify(
      'Sprinkler running long',
      `The sprinkler has been on for ${fmtDuration(onFor)} (limit ${config.alerts.longRunMinutes} min). ` +
        `Turn it off from the dashboard if this is not intended.`,
      { priority: 'urgent' },
    );
  }

  /** Water flowing with the valve closed: stuck diaphragm or a leak. The relay can't fix this. */
  private checkLeak(now: number): void {
    const s = this.sprinkler.status;
    const f = config.flow;
    if (!s.online || s.flowGpm === null) return;
    const offAt = this.store.state.lastOffAt ? Date.parse(this.store.state.lastOffAt) : 0;
    const drained = now - offAt > MIN; // lines keep draining for a bit after the valve closes

    if (s.valve === 'off' && drained && s.flowGpm >= f.leakGpm) {
      this.flowWhileOffSince ??= now;
      if (this.leakAlerted || now - this.flowWhileOffSince < f.leakMinutes * MIN) return;
      this.leakAlerted = true;
      this.store.log('alert', `Water flowing with the valve closed: ${s.flowGpm} gal/min`);
      void notify(
        'Water flowing with valve closed',
        `The flow meter reads ${s.flowGpm} gal/min although the valve is off. The valve may be stuck open ` +
          `(debris in the diaphragm) or a line is leaking. Close the supply valve and check it.`,
        { priority: 'urgent' },
      );
    } else if (s.valve !== 'on') {
      if (this.leakAlerted) this.store.log('info', 'Flow with valve closed has stopped');
      this.flowWhileOffSince = null;
      this.leakAlerted = false;
    }
  }

  private checkNoFlow(now: number): void {
    const s = this.sprinkler.status;
    const f = config.flow;
    if (!s.online || s.flowGpm === null || s.valve !== 'on' || !s.onSince || this.noFlowAlerted) return;
    const openFor = now - Date.parse(s.onSince);
    if (openFor < f.noFlowSeconds * 1000 || s.flowGpm >= f.noFlowGpm) return;
    this.noFlowAlerted = true;
    this.store.log('alert', 'Valve is open but no water is flowing');
    void notify(
      'No water flowing',
      `The valve has been open for ${fmtDuration(openFor)} but the flow meter reads ${s.flowGpm} gal/min. ` +
        `Check the supply valve, the 24 VAC transformer and the flow sensor wiring.`,
      { priority: 'high' },
    );
  }
}
