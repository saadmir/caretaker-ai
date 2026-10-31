import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../src/config.js';
import type { WeatherSnapshot } from '../src/integrations/weather.js';
import type { PersistedState, ZoneState } from '../src/store.js';
import { checkDryRule, shouldRunNow } from '../src/watering/dry-rule.js';

const now = new Date('2026-10-19T06:00:00'); // inside the 5-9 AM window
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

const state = (patch: Partial<PersistedState> = {}): PersistedState => ({
  installedAt: daysAgo(30),
  lastRainAt: daysAgo(20),
  autoEnabled: true,
  zones: {},
  events: [],
  waterings: [],
  notes: [],
  aiMode: 'off',
  aiDecisions: [],
  aiFailedDate: null,
  ...patch,
});

const zone = (patch: Partial<ZoneState> = {}): ZoneState => ({
  lastWateredAt: daysAgo(11), // 264 h > the 240 h default threshold
  lastOffAt: null,
  autoEnabled: true,
  ...patch,
});

const dryWeather: WeatherSnapshot = {
  fetchedAt: now.toISOString(),
  temperatureC: 15,
  currentPrecipitationMm: 0,
  weatherCode: 0,
  rainingNow: false,
  lastRainHourAt: null,
  rainForecast: null,
  next24hTotalMm: 0,
  next24hMaxProbability: 0,
};

const check = (patch: Partial<Parameters<typeof checkDryRule>[0]> = {}) =>
  checkDryRule({ now, state: state(), zone: zone(), weather: dryWeather, valveOn: false, online: true, aiInCharge: false, config, ...patch });

describe('checkDryRule', () => {
  it('runs when due, dry and inside the window', () => {
    assert.ok(shouldRunNow(check()));
  });

  it('is not due when it rained recently', () => {
    const r = check({ state: state({ lastRainAt: daysAgo(2) }) });
    assert.equal(r.isDue, false);
    assert.equal(shouldRunNow(r), false);
  });

  it('holds off for rain now or forecast, and flags it as weather', () => {
    const raining = check({ weather: { ...dryWeather, rainingNow: true } });
    assert.equal(raining.blockedBy, 'It is raining now');
    assert.ok(raining.blockedByWeather);

    const forecast = check({ weather: { ...dryWeather, rainForecast: { at: daysAgo(-0.5), precipitationMm: 2, probability: 80 } } });
    assert.match(forecast.blockedBy!, /^Rain forecast/);
  });

  it('will not water without fresh weather data', () => {
    assert.match(check({ weather: null }).blockedBy!, /will not water blind/);
    assert.match(check({ weather: { ...dryWeather, fetchedAt: daysAgo(1) } }).blockedBy!, /will not water blind/);
  });

  it('waits for the watering window', () => {
    const noon = new Date('2026-10-19T12:00:00');
    const r = check({ now: noon, weather: { ...dryWeather, fetchedAt: noon.toISOString() } });
    assert.match(r.blockedBy!, /Waiting for watering window/);
  });

  it("counts from the zone's own last watering", () => {
    assert.equal(check({ zone: zone({ lastWateredAt: daysAgo(1) }) }).isDue, false);
  });

  it('stands down when paused, off for the zone, or when the AI is in charge', () => {
    assert.equal(check({ state: state({ autoEnabled: false }) }).blockedBy, 'Automatic watering is paused');
    assert.equal(check({ zone: zone({ autoEnabled: false }) }).blockedBy, 'Automatic watering is off for this zone');
    assert.equal(check({ aiInCharge: true }).blockedBy, 'AI gardener decides (auto mode)');
  });
});
