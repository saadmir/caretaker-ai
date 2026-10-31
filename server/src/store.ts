import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiMode } from './config.js';

export type EventType = 'on' | 'off' | 'skip' | 'alert' | 'device' | 'weather' | 'info' | 'error' | 'ai';

export interface LogEvent {
  at: string;
  type: EventType;
  message: string;
}

export interface WateringRecord {
  zone: number;
  start: string;
  minutes: number;
  reason: string;
  gallons?: number; // measured by the flow meter; absent without one
}

export interface Note {
  at: string;
  text: string;
}

export interface AiCycle {
  startAt: string;
  minutes: number;
  status: 'pending' | 'started' | 'skipped';
}

export interface ZonePlan {
  zone: number;
  action: 'water' | 'skip';
  soilEstimate: string;
  note: string; // the AI's one-liner for this zone
  cycles: AiCycle[]; // after the guardrails; empty when skipping
  adjustments: string[]; // what the guardrails changed
}

export interface AiDecisionRecord {
  decidedAt: string;
  forDate: string; // local date of the watering window it plans
  mode: AiMode;
  action: 'water' | 'skip'; // 'water' if any zone waters
  headline: string;
  reasoning: string;
  zones: ZonePlan[];
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ZoneState {
  lastWateredAt: string | null; // when the valve last opened
  lastOffAt: string | null;
  autoEnabled: boolean; // this zone's switch; the global autoEnabled pauses them all
}

export interface PersistedState {
  installedAt: string;
  lastRainAt: string | null;
  autoEnabled: boolean;
  zones: Record<string, ZoneState>; // by zone id
  events: LogEvent[];
  waterings: WateringRecord[];
  notes: Note[];
  aiMode: AiMode;
  aiDecisions: AiDecisionRecord[];
  aiFailedDate: string | null; // a day the AI couldn't decide; the plain rule covers it
}

const MAX_EVENTS = 300;
const MAX_WATERINGS = 200;
const MAX_DECISIONS = 60;

/**
 * All state lives in one small JSON file. Lists are kept newest first.
 * Writes go to a temp file and are renamed into place, so a power cut can't leave half a file.
 */
export class Store {
  state: PersistedState;
  private readonly file: string;

  constructor(dataDir: string, defaults: { autoEnabled: boolean; aiMode: AiMode }) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'state.json');

    let saved: Partial<PersistedState> | null = null;
    try {
      saved = migrate(JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>);
    } catch {
      // first run
    }
    this.state = {
      installedAt: new Date().toISOString(),
      lastRainAt: null,
      autoEnabled: defaults.autoEnabled,
      zones: {},
      events: [],
      waterings: [],
      notes: [],
      aiMode: defaults.aiMode,
      aiDecisions: [],
      aiFailedDate: null,
      ...saved,
    };
    // Files from before watering records existed: rebuild them from the activity log.
    if (saved && !saved.waterings) this.state.waterings = wateringsFromLog(this.state.events);
    this.save();
  }

  /** A zone's own state. Zones added later start with their automatic watering off. */
  zone(id: number): ZoneState {
    return (this.state.zones[id] ??= { lastWateredAt: null, lastOffAt: null, autoEnabled: false });
  }

  updateZone(id: number, patch: Partial<ZoneState>): void {
    Object.assign(this.zone(id), patch);
    this.save();
  }

  update(patch: Partial<PersistedState>): void {
    Object.assign(this.state, patch);
    this.save();
  }

  /** Save after changing nested state in place, e.g. a cycle's status. */
  touch(): void {
    this.save();
  }

  log(type: EventType, message: string): LogEvent {
    const ev: LogEvent = { at: new Date().toISOString(), type, message };
    pushNewest(this.state.events, ev, MAX_EVENTS);
    this.save();
    console.log(`[${ev.at}] ${type.toUpperCase()}: ${message}`);
    return ev;
  }

  addWatering(w: WateringRecord): void {
    pushNewest(this.state.waterings, w, MAX_WATERINGS);
    this.save();
  }

  addDecision(d: AiDecisionRecord): void {
    pushNewest(this.state.aiDecisions, d, MAX_DECISIONS);
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}

function pushNewest<T>(list: T[], item: T, max: number): void {
  list.unshift(item);
  if (list.length > max) list.length = max;
}

/**
 * Bring a state file from the single-valve days up to date: its valve is zone 1,
 * and its AI decisions become zone 1 plans.
 */
export function migrate(saved: Record<string, unknown>): Partial<PersistedState> {
  const s = saved as Record<string, any>; // old shapes; fixed up below
  if (!s.zones) {
    s.zones = { 1: { lastWateredAt: s.lastWateredAt ?? null, lastOffAt: s.lastOffAt ?? null, autoEnabled: true } };
    delete s.lastWateredAt;
    delete s.lastOffAt;
  }
  for (const w of s.waterings ?? []) w.zone ??= 1;
  for (const d of s.aiDecisions ?? []) {
    if (d.zones) continue;
    d.zones = [{ zone: 1, action: d.action, soilEstimate: d.soilEstimate, note: '', cycles: d.cycles, adjustments: d.adjustments }];
    delete d.soilEstimate;
    delete d.cycles;
    delete d.adjustments;
  }
  return s as Partial<PersistedState>;
}

/** Pair up "Sprinkler ON" / "Sprinkler OFF" log entries into watering records (all from zone 1). */
export function wateringsFromLog(events: LogEvent[]): WateringRecord[] {
  const out: WateringRecord[] = [];
  let on: LogEvent | null = null;
  for (const ev of [...events].reverse()) {
    if (ev.type === 'on') on = ev;
    else if (ev.type === 'off' && on) {
      const minutes = (Date.parse(ev.at) - Date.parse(on.at)) / 60_000;
      const reason = /\((\w+)\)$/.exec(on.message)?.[1] ?? 'unknown';
      out.unshift({ zone: 1, start: on.at, minutes: Math.round(minutes * 10) / 10, reason });
      on = null;
    }
  }
  return out;
}
