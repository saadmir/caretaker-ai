import assert from 'node:assert/strict';
import { it } from 'node:test';
import { wateringsFromLog, type LogEvent } from '../src/store.js';

it('rebuilds watering records from ON/OFF log entries (newest first)', () => {
  const events: LogEvent[] = [
    { at: '2026-10-15T13:10:00.000Z', type: 'off', message: 'Sprinkler OFF after 10 min (timer)' },
    { at: '2026-10-15T13:00:00.000Z', type: 'on', message: 'Sprinkler ON (auto)' },
    { at: '2026-10-12T08:05:30.000Z', type: 'off', message: 'Sprinkler OFF after 5 min (manual)' },
    { at: '2026-10-12T08:00:00.000Z', type: 'on', message: 'Sprinkler ON (manual)' },
  ];
  assert.deepEqual(wateringsFromLog(events), [
    { start: '2026-10-15T13:00:00.000Z', minutes: 10, reason: 'auto' },
    { start: '2026-10-12T08:00:00.000Z', minutes: 5.5, reason: 'manual' },
  ]);
});
