import type { AiLimits } from '../config.js';
import type { AiCycle } from '../store.js';
import { fmtClock, HOUR, localDate, localTime, MIN } from '../util/time.js';
import type { ZoneDecision } from './schema.js';

// Turns the AI's answer into concrete, safe cycle times. Everything here is a pure
// function of its inputs, so the safety rules can be unit-tested without the API.

export interface WateringWindow {
  startHour: number;
  endHour: number;
}

/** A decision made now plans today's window, or tomorrow's once today's has closed. */
export function planDateFor(now: Date, window: WateringWindow): string {
  if (now.getHours() < window.endHour) return localDate(now);
  return localDate(new Date(now.getTime() + 24 * HOUR));
}

export interface GuardrailInput {
  decision: ZoneDecision;
  forDate: string;
  now: Date;
  lastWateredAt: string | null;
  limits: AiLimits;
  window: WateringWindow;
}

export interface GuardedPlan {
  cycles: AiCycle[]; // empty = no watering
  adjustments: string[]; // human-readable list of what was changed, shown to the owner
}

/**
 * Clamp one zone's plan to the configured limits. The model is told the limits too, but this
 * is what actually holds them: cycle length, cycle count, daily total, soak time,
 * start inside the window, and a minimum gap since the last watering.
 */
export function applyGuardrails({ decision: d, forDate, now, lastWateredAt, limits, window }: GuardrailInput): GuardedPlan {
  const adjustments: string[] = [];
  const skip = (why: string): GuardedPlan => {
    adjustments.push(why);
    return { cycles: [], adjustments };
  };
  if (d.action === 'skip') return { cycles: [], adjustments };

  let minutes = d.cycle_minutes.map(Math.round).filter((m) => m > 0);
  if (minutes.length === 0) return skip('Plan had no cycles with run time; skipping.');

  if (minutes.some((m) => m > limits.maxCycleMinutes)) {
    adjustments.push(`Cycles capped at ${limits.maxCycleMinutes} min.`);
    minutes = minutes.map((m) => Math.min(m, limits.maxCycleMinutes));
  }
  if (minutes.length > limits.maxCycles) {
    adjustments.push(`Limited to ${limits.maxCycles} cycles.`);
    minutes = minutes.slice(0, limits.maxCycles);
  }
  const capped = capTotal(minutes, limits.maxMinutesPerDay);
  if (sum(capped) < sum(minutes)) {
    adjustments.push(`Total limited to ${limits.maxMinutesPerDay} min per day.`);
  }
  minutes = capped;

  let soak = Math.round(d.soak_minutes_between_cycles);
  if (minutes.length > 1 && (soak < limits.minSoakMinutes || soak > limits.maxSoakMinutes)) {
    soak = Math.min(Math.max(soak, limits.minSoakMinutes), limits.maxSoakMinutes);
    adjustments.push(`Soak time set to ${soak} min.`);
  }

  const windowStart = localTime(forDate, window.startHour);
  const windowEnd = localTime(forDate, window.endHour);
  let start = parseClock(d.start_time, forDate);
  if (!start || start < windowStart || start >= windowEnd) {
    start = windowStart;
    adjustments.push(`Start moved to ${fmtClock(start)} (inside the watering window).`);
  }
  // Asked late (e.g. "Ask AI now" at 7:15 for a 5:00 start): start in a minute instead.
  if (start.getTime() < now.getTime() + MIN) {
    start = new Date(now.getTime() + MIN);
    if (start >= windowEnd) return skip('The watering window has already closed; skipping.');
  }

  if (lastWateredAt) {
    const gapMs = start.getTime() - Date.parse(lastWateredAt);
    if (gapMs < limits.minHoursBetweenWaterings * HOUR) {
      return skip(
        `Last watered ${Math.round(gapMs / HOUR)} h before the planned start ` +
          `(minimum ${limits.minHoursBetweenWaterings} h); skipping.`,
      );
    }
  }

  let t = start.getTime();
  const cycles = minutes.map((m): AiCycle => {
    const c: AiCycle = { startAt: new Date(t).toISOString(), minutes: m, status: 'pending' };
    t += (m + soak) * MIN;
    return c;
  });
  return { cycles, adjustments };
}

/** e.g. "3 × 5 min, 30 min apart, from 5:00 AM (≈50 gal)"; no gallons while the flow rate is unknown */
export function describePlan(cycles: AiCycle[], gallonsPerMinute: number | null): string {
  if (!cycles.length) return 'No watering.';
  const mins = cycles.map((c) => c.minutes);
  const runs = mins.every((m) => m === mins[0]) ? `${cycles.length} × ${mins[0]} min` : `${mins.join(' + ')} min`;
  let gap = '';
  if (cycles.length > 1) {
    const soak = (Date.parse(cycles[1]!.startAt) - Date.parse(cycles[0]!.startAt)) / MIN - cycles[0]!.minutes;
    gap = `, ${Math.round(soak)} min apart`;
  }
  const first = fmtClock(new Date(cycles[0]!.startAt));
  const gal = gallonsPerMinute !== null ? ` (≈${Math.round(sum(mins) * gallonsPerMinute)} gal)` : '';
  return `${runs}${gap}, from ${first}${gal}`;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Keep cycles in order until the daily total is used up; the last one may be shortened. */
function capTotal(minutes: number[], max: number): number[] {
  const out: number[] = [];
  let total = 0;
  for (const m of minutes) {
    const take = Math.min(m, max - total);
    if (take <= 0) break;
    out.push(take);
    total += take;
  }
  return out;
}

function parseClock(hhmm: string, date: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? localTime(date, Number(m[1]), Number(m[2])) : null;
}
