import assert from 'node:assert/strict';
import { it } from 'node:test';
import { migrate, wateringsFromLog, type LogEvent } from '../src/store.js';

it('rebuilds watering records from ON/OFF log entries (newest first)', () => {
  const events: LogEvent[] = [
    { at: '2026-10-15T13:10:00.000Z', type: 'off', message: 'Sprinkler OFF after 10 min (timer)' },
    { at: '2026-10-15T13:00:00.000Z', type: 'on', message: 'Sprinkler ON (auto)' },
    { at: '2026-10-12T08:05:30.000Z', type: 'off', message: 'Sprinkler OFF after 5 min (manual)' },
    { at: '2026-10-12T08:00:00.000Z', type: 'on', message: 'Sprinkler ON (manual)' },
  ];
  assert.deepEqual(wateringsFromLog(events), [
    { zone: 1, start: '2026-10-15T13:00:00.000Z', minutes: 10, reason: 'auto' },
    { zone: 1, start: '2026-10-12T08:00:00.000Z', minutes: 5.5, reason: 'manual' },
  ]);
});

it('migrates a single-valve state file: its valve becomes zone 1', () => {
  const s = migrate({
    lastWateredAt: 'W',
    lastOffAt: 'O',
    waterings: [{ start: 'W', minutes: 2, reason: 'manual', gallons: 13.6 }],
    aiDecisions: [{ action: 'skip', headline: 'h', soilEstimate: 'moist', cycles: [], adjustments: ['a'] }],
  });
  assert.deepEqual(s.zones, { 1: { lastWateredAt: 'W', lastOffAt: 'O', autoEnabled: true } });
  assert.ok(!('lastWateredAt' in s));
  assert.equal(s.waterings![0]!.zone, 1);
  assert.deepEqual(s.aiDecisions![0]!.zones, [
    { zone: 1, action: 'skip', soilEstimate: 'moist', note: '', cycles: [], adjustments: ['a'] },
  ]);
  assert.deepEqual(migrate(structuredClone(s) as Record<string, unknown>), s); // a second run changes nothing
});
