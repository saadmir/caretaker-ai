import type { Config } from '../config.js';
import type { WeatherSnapshot } from '../integrations/weather.js';
import type { PersistedState, ZoneState } from '../store.js';
import { fmtDayTime, HOUR, MIN } from '../util/time.js';

// The plain rule from before the AI: water a zone for AUTO_RUN_MINUTES once it's been
// DRY_HOURS_THRESHOLD hours since the last rain or since that zone was watered, inside the morning window,
// unless it's raining or rain is forecast. With the AI in auto mode, this only runs on
// days the AI couldn't decide.

export interface DryRuleStatus {
  checkedAt: string;
  dryClockFrom: string; // the later of last rain, the zone's last watering, install time
  hoursDry: number;
  dueAt: string;
  isDue: boolean;
  blockedBy: string | null; // why a due run won't start now; null = it would start
  blockedByWeather: boolean;
}

export interface DryRuleInput {
  now: Date;
  state: PersistedState;
  zone: ZoneState;
  weather: WeatherSnapshot | null;
  valveOn: boolean;
  online: boolean;
  aiInCharge: boolean;
  config: Pick<Config, 'schedule' | 'weather'>;
}

export function checkDryRule({ now, state, zone, weather, valveOn, online, aiInCharge, config }: DryRuleInput): DryRuleStatus {
  const sc = config.schedule;
  const dryFrom = Math.max(
    ...[state.lastRainAt, zone.lastWateredAt, state.installedAt].filter((x): x is string => !!x).map(Date.parse),
  );
  const dueAt = dryFrom + sc.dryHoursThreshold * HOUR;
  const isDue = now.getTime() >= dueAt;

  let blockedBy: string | null = null;
  let blockedByWeather = false;
  const weatherAge = weather ? now.getTime() - Date.parse(weather.fetchedAt) : Infinity;
  const hour = now.getHours();

  if (!state.autoEnabled) blockedBy = 'Automatic watering is paused';
  else if (!zone.autoEnabled) blockedBy = 'Automatic watering is off for this zone';
  else if (aiInCharge) blockedBy = 'AI gardener decides (auto mode)';
  else if (!isDue) blockedBy = null;
  else if (valveOn) blockedBy = 'Already running';
  else if (!online) blockedBy = 'Controller offline';
  else if (!weather || weatherAge > 3 * config.weather.pollMinutes * MIN)
    blockedBy = 'No recent weather data (safety: will not water blind)';
  else if (weather.rainingNow) {
    blockedBy = 'It is raining now';
    blockedByWeather = true;
  } else if (weather.rainForecast) {
    const f = weather.rainForecast;
    blockedBy = `Rain forecast ${fmtDayTime(f.at)} (${f.precipitationMm} mm${f.probability !== null ? `, ${f.probability}%` : ''})`;
    blockedByWeather = true;
  } else if (hour < sc.windowStartHour || hour >= sc.windowEndHour) {
    blockedBy = `Waiting for watering window (${sc.windowStartHour}:00-${sc.windowEndHour}:00)`;
  }

  return {
    checkedAt: now.toISOString(),
    dryClockFrom: new Date(dryFrom).toISOString(),
    hoursDry: Math.round(((now.getTime() - dryFrom) / HOUR) * 10) / 10,
    dueAt: new Date(dueAt).toISOString(),
    isDue,
    blockedBy,
    blockedByWeather,
  };
}

/** True when the rule says to start a run right now. */
export const shouldRunNow = (s: DryRuleStatus) => s.isDue && s.blockedBy === null;
