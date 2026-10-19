import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyGuardrails, describePlan, planDateFor } from '../src/agent/plan.js';
import type { WateringDecision } from '../src/agent/schema.js';

const limits = {
  maxMinutesPerDay: 30,
  maxCycleMinutes: 15,
  maxCycles: 4,
  minSoakMinutes: 15,
  maxSoakMinutes: 90,
  minHoursBetweenWaterings: 48,
};
const window = { startHour: 5, endHour: 9 };
const day = '2026-10-19';
const at = (local: string) => new Date(`${day}T${local}:00`);

function plan(d: Partial<WateringDecision>, opts: { now?: Date; lastWateredAt?: string | null } = {}) {
  const decision: WateringDecision = {
    action: 'water',
    start_time: '05:00',
    cycle_minutes: [10],
    soak_minutes_between_cycles: 0,
    soil_estimate: 'dry',
    headline: '',
    reasoning: '',
    ...d,
  };
  return applyGuardrails({
    decision,
    forDate: day,
    now: opts.now ?? at('04:30'),
    lastWateredAt: opts.lastWateredAt ?? null,
    limits,
    window,
  });
}
const startTimes = (r: ReturnType<typeof plan>) =>
  r.cycles.map((c) => new Date(c.startAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));

describe('applyGuardrails', () => {
  it('keeps a plan that is within the limits', () => {
    const r = plan({ cycle_minutes: [5, 5, 5], soak_minutes_between_cycles: 30 });
    assert.deepEqual(r.adjustments, []);
    assert.deepEqual(startTimes(r), ['05:00', '05:35', '06:10']);
  });

  it('caps cycle length, cycle count, daily total and soak time', () => {
    const r = plan({ cycle_minutes: [20, 20, 20, 20, 20], soak_minutes_between_cycles: 5 });
    assert.deepEqual(r.cycles.map((c) => c.minutes), [15, 15]);
    assert.equal(r.adjustments.length, 4);
    assert.deepEqual(startTimes(r), ['05:00', '05:30']); // 15 min run + 15 min minimum soak
  });

  it('moves a start outside the window to the window start', () => {
    const r = plan({ start_time: '13:00' });
    assert.deepEqual(startTimes(r), ['05:00']);
    assert.match(r.adjustments[0]!, /Start moved/);
  });

  it('starts a minute from now when asked after the planned start', () => {
    assert.deepEqual(startTimes(plan({}, { now: at('07:15') })), ['07:16']);
  });

  it('skips once the window has closed', () => {
    const r = plan({}, { now: at('08:59') });
    assert.equal(r.cycles.length, 0);
    assert.match(r.adjustments[0]!, /window has already closed/);
  });

  it('skips when the last watering was too recent', () => {
    const r = plan({}, { lastWateredAt: new Date('2026-10-17T23:00:00').toISOString() });
    assert.equal(r.cycles.length, 0);
    assert.match(r.adjustments[0]!, /minimum 48 h/);
  });

  it('passes a skip through unchanged', () => {
    const r = plan({ action: 'skip', cycle_minutes: [] });
    assert.deepEqual(r, { cycles: [], adjustments: [] });
  });
});

describe('planDateFor', () => {
  it("plans today's window until it closes, then tomorrow's", () => {
    assert.equal(planDateFor(at('08:59'), window), '2026-10-19');
    assert.equal(planDateFor(at('09:00'), window), '2026-10-20');
  });
});

describe('describePlan', () => {
  it('summarizes cycles, soak and gallons', () => {
    const r = plan({ cycle_minutes: [5, 5, 5], soak_minutes_between_cycles: 30 });
    assert.equal(describePlan(r.cycles, 3), '3 × 5 min, 30 min apart, from 5:00 AM (≈45 gal)');
  });
});
