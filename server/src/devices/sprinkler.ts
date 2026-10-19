import { EventEmitter } from 'node:events';
import type { Broker } from '../mqtt/broker.js';

// The sprinkler ESP32 (firmware/sprinkler). It owns the relay and its own run timer;
// this class sends it commands and keeps track of what it reports.
//
// Topics, under e.g. "sprinkler/zone1":
//   cmd           server -> ESP32   {"action":"on","durationSec":600,"reason":"ai"} | {"action":"off"} | {"action":"ping"}
//   state         ESP32 -> server   retained JSON, on every change and every 30 s (5 s while water flows)
//   availability  ESP32 -> server   "online" / "offline" (retained; "offline" is the MQTT last will)

export type ValveState = 'on' | 'off' | 'unknown';

export interface SprinklerStatus {
  online: boolean;
  valve: ValveState;
  onSince: string | null; // server clock, worked out from the ESP32's onForSec
  remainingSec: number | null;
  reason: string | null;
  lastSeenAt: string | null;
  ip: string | null;
  rssi: number | null;
  fw: string | null;
  failsafeMin: number | null;
  flowGpm: number | null; // null = no flow sensor reporting
  runGallons: number | null; // this run so far, or the last run once the valve is off
}

/** What the firmware publishes on the state topic. */
interface StatePayload {
  state: 'on' | 'off';
  reason?: string;
  onForSec?: number;
  remainingSec?: number;
  uptimeSec?: number;
  rssi?: number;
  ip?: string;
  fw?: string;
  failsafeMin?: number;
  flowPulses?: number;
  runPulses?: number;
  flowPps?: number;
}

export interface SprinklerEvents {
  valve: [next: ValveState, prev: ValveState, status: SprinklerStatus];
  online: [online: boolean];
  update: [status: SprinklerStatus];
}

const LITERS_PER_GALLON = 3.78541;
const STALE_AFTER_MS = 95_000; // three missed 30 s heartbeats

export class Sprinkler extends EventEmitter<SprinklerEvents> {
  status: SprinklerStatus = {
    online: false,
    valve: 'unknown',
    onSince: null,
    remainingSec: null,
    reason: null,
    lastSeenAt: null,
    ip: null,
    rssi: null,
    fw: null,
    failsafeMin: null,
    flowGpm: null,
    runGallons: null,
  };

  constructor(
    private readonly broker: Broker,
    private readonly topicBase: string,
    private readonly pulsesPerLiter: number,
  ) {
    super();
    broker.subscribe(`${topicBase}/state`, (raw) => this.onState(raw));
    broker.subscribe(`${topicBase}/availability`, (raw) => this.setOnline(raw === 'online'));
  }

  /** durationSec = 0 means "until turned off"; the firmware's failsafe still caps it. */
  turnOn(durationSec: number, reason: string): void {
    this.send({ action: 'on', durationSec: Math.max(0, Math.round(durationSec)), reason });
  }

  turnOff(reason: string): void {
    this.send({ action: 'off', reason });
  }

  /**
   * A half-open TCP connection can look "online" forever, so also treat
   * missing heartbeats as offline. Called from the controller's tick.
   */
  checkHeartbeat(now: number): void {
    const seen = this.status.lastSeenAt;
    if (this.status.online && seen && now - Date.parse(seen) > STALE_AFTER_MS) this.setOnline(false);
  }

  pulsesToGallons(pulses: number): number {
    return Math.round((pulses / this.pulsesPerLiter / LITERS_PER_GALLON) * 100) / 100;
  }

  private send(cmd: object): void {
    // Never retained: a rebooting ESP32 must not replay an old "on".
    this.broker.publish(`${this.topicBase}/cmd`, cmd, { qos: 1, retain: false });
  }

  private setOnline(online: boolean): void {
    if (online === this.status.online) return;
    this.status.online = online;
    if (!online) this.status.remainingSec = null;
    this.emit('online', online);
    this.emit('update', this.status);
  }

  private onState(raw: string): void {
    let p: StatePayload;
    try {
      p = JSON.parse(raw) as StatePayload;
    } catch {
      console.warn('[sprinkler] bad state payload', raw);
      return;
    }
    if (p.state !== 'on' && p.state !== 'off') return;

    const s = this.status;
    const prev = s.valve;
    const now = Date.now();
    s.lastSeenAt = new Date(now).toISOString();
    s.ip = p.ip ?? s.ip;
    s.rssi = p.rssi ?? s.rssi;
    s.fw = p.fw ?? s.fw;
    s.failsafeMin = p.failsafeMin ?? s.failsafeMin;
    s.reason = p.reason ?? null;
    s.valve = p.state;
    if (p.flowPps !== undefined) s.flowGpm = this.pulsesToGallons(p.flowPps * 60);
    if (p.runPulses !== undefined) s.runGallons = this.pulsesToGallons(p.runPulses);

    if (p.state === 'on') {
      // Work out onSince once per run, so it doesn't drift with each heartbeat.
      if (prev !== 'on' || !s.onSince) s.onSince = new Date(now - (p.onForSec ?? 0) * 1000).toISOString();
      s.remainingSec = p.remainingSec ?? null;
    } else {
      s.remainingSec = null;
    }

    // A state message proves the ESP32 is alive, even if we missed its "online".
    this.setOnline(true);
    if (prev !== p.state) this.emit('valve', p.state, prev, { ...s });
    if (p.state === 'off') s.onSince = null;
    this.emit('update', s);
  }
}
