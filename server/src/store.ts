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

export interface AiDecisionRecord {
  decidedAt: string;
  forDate: string; // local date of the watering window it plans
  mode: AiMode;
  action: 'water' | 'skip';
  headline: string;
  reasoning: string;
  soilEstimate: string;
  cycles: AiCycle[]; // after the guardrails; empty when skipping
  adjustments: string[]; // what the guardrails changed
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface PersistedState {
  installedAt: string;
  lastRainAt: string | null;
  lastWateredAt: string | null; // when the valve last opened
  lastOffAt: string | null;
  autoEnabled: boolean;
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
      saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedState>;
    } catch {
      // first run
    }
    this.state = {
      installedAt: new Date().toISOString(),
      lastRainAt: null,
      lastWateredAt: null,
      lastOffAt: null,
      autoEnabled: defaults.autoEnabled,
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

/** Pair up "Sprinkler ON" / "Sprinkler OFF" log entries into watering records. */
export function wateringsFromLog(events: LogEvent[]): WateringRecord[] {
  const out: WateringRecord[] = [];
  let on: LogEvent | null = null;
  for (const ev of [...events].reverse()) {
    if (ev.type === 'on') on = ev;
    else if (ev.type === 'off' && on) {
      const minutes = (Date.parse(ev.at) - Date.parse(on.at)) / 60_000;
      const reason = /\((\w+)\)$/.exec(on.message)?.[1] ?? 'unknown';
      out.unshift({ start: on.at, minutes: Math.round(minutes * 10) / 10, reason });
      on = null;
    }
  }
  return out;
}
