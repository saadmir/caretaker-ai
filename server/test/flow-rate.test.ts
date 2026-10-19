import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WateringRecord } from '../src/store.js';
import { estimatedGpm, gallonsPerMinute, measuredGpm } from '../src/watering/flow-rate.js';

const run = (minutes: number, gallons?: number): WateringRecord => ({ start: '', minutes, reason: 'ai', gallons });

describe('measuredGpm', () => {
  it('is null without metered waterings', () => {
    assert.equal(measuredGpm([run(10)]), null);
    assert.equal(gallonsPerMinute([run(10)]), estimatedGpm());
  });

  it('takes the median, ignoring short runs and no-flow runs', () => {
    const runs = [run(10, 30), run(10, 32), run(10, 0), run(1, 50), run(10, 31)];
    assert.equal(measuredGpm(runs), 3.1);
  });
});
