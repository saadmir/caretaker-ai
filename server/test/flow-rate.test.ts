import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WateringRecord } from '../src/store.js';
import { estimatedGpm, gallonsPerMinute, measuredGpm } from '../src/watering/flow-rate.js';

const run = (minutes: number, gallons?: number, zone = 1): WateringRecord => ({ zone, start: '', minutes, reason: 'ai', gallons });
const zone = { id: 1, name: 'Zone 1', emitterCount: 40, emitterGph: 6, minHoursBetweenWaterings: 48 };

describe('measuredGpm', () => {
  it('is null without metered waterings', () => {
    assert.equal(measuredGpm([run(10)], 1), null);
    assert.equal(gallonsPerMinute([run(10)], zone), estimatedGpm(zone));
    assert.equal(estimatedGpm(zone), 4);
  });

  it('takes the median, ignoring short runs and no-flow runs', () => {
    const runs = [run(10, 30), run(10, 32), run(10, 0), run(1, 50), run(10, 31)];
    assert.equal(measuredGpm(runs, 1), 3.1);
  });

  it("only uses the zone's own waterings", () => {
    assert.equal(measuredGpm([run(10, 30, 2)], 1), null);
    assert.equal(measuredGpm([run(10, 30, 2)], 2), 3);
  });
});

describe('estimatedGpm', () => {
  it('is unknown while the emitter count is 0', () => {
    assert.equal(estimatedGpm({ ...zone, emitterCount: 0 }), null);
  });
});
