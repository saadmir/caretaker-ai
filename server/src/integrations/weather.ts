import { config } from '../config.js';

/** WMO weather codes that mean it is actually raining (drizzle 53+, rain, showers, thunderstorms). */
const RAIN_CODES = new Set([53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

export interface ForecastHour {
  at: string; // ISO, END of the hour the precipitation fell in
  precipitationMm: number;
  probability: number | null;
}

export interface WeatherSnapshot {
  fetchedAt: string;
  temperatureC: number | null;
  currentPrecipitationMm: number;
  weatherCode: number | null;
  rainingNow: boolean;
  /** Most recent past hour with >= rainRecordMinMm, according to the model. */
  lastRainHourAt: string | null;
  /** First upcoming hour (within horizon) that trips the forecast threshold. */
  rainForecast: ForecastHour | null;
  next24hTotalMm: number;
  next24hMaxProbability: number;
}

interface OpenMeteoResponse {
  current?: {
    time: string;
    temperature_2m?: number;
    precipitation?: number;
    weather_code?: number;
  };
  hourly?: {
    time: string[];
    precipitation: (number | null)[];
    precipitation_probability?: (number | null)[];
  };
}

// Open-Meteo is called with timezone=GMT, so times are UTC without a suffix.
const utc = (t: string) => new Date(t.length === 16 ? `${t}:00Z` : `${t}Z`);

/** Current conditions plus recent and upcoming rain, for the watering rules. */
export async function fetchWeather(now = new Date()): Promise<WeatherSnapshot> {
  const w = config.weather;
  const params = new URLSearchParams({
    latitude: String(config.location.latitude),
    longitude: String(config.location.longitude),
    current: 'temperature_2m,precipitation,weather_code',
    hourly: 'precipitation,precipitation_probability',
    past_days: '3',
    forecast_days: '2',
    timezone: 'GMT',
    precipitation_unit: 'mm',
  });
  const res = await fetch(`${w.url}?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = (await res.json()) as OpenMeteoResponse;
  if (!data.hourly?.time?.length) throw new Error('Open-Meteo response missing hourly data');

  const nowMs = now.getTime();
  const horizonMs = nowMs + w.forecastHorizonHours * 3600_000;
  let lastRainHourAt: string | null = null;
  let rainForecast: ForecastHour | null = null;
  let next24hTotalMm = 0;
  let next24hMaxProbability = 0;

  const { time, precipitation, precipitation_probability: prob } = data.hourly;
  for (let i = 0; i < time.length; i++) {
    // Open-Meteo hourly precipitation is the sum over the PRECEDING hour,
    // so the timestamp is the end of the rain interval.
    const end = utc(time[i]!);
    const endMs = end.getTime();
    const mm = precipitation[i] ?? 0;
    const p = prob?.[i] ?? null;

    if (endMs <= nowMs) {
      if (mm >= w.rainRecordMinMm) lastRainHourAt = end.toISOString();
    } else if (endMs - 3600_000 < horizonMs) {
      next24hTotalMm += mm;
      if (p !== null) next24hMaxProbability = Math.max(next24hMaxProbability, p);
      const trips = mm >= w.forecastRainMinMm || (p !== null && p >= w.forecastRainMinProb);
      if (trips && !rainForecast) {
        rainForecast = { at: end.toISOString(), precipitationMm: mm, probability: p };
      }
    }
  }

  const currentMm = data.current?.precipitation ?? 0;
  const code = data.current?.weather_code ?? null;
  return {
    fetchedAt: new Date().toISOString(),
    temperatureC: data.current?.temperature_2m ?? null,
    currentPrecipitationMm: currentMm,
    weatherCode: code,
    rainingNow: currentMm >= 0.1 || (code !== null && RAIN_CODES.has(code)),
    lastRainHourAt,
    rainForecast,
    next24hTotalMm: Math.round(next24hTotalMm * 10) / 10,
    next24hMaxProbability,
  };
}

export interface DailyWeather {
  units: Record<string, string>;
  /** One row per local day: past 14 days, today, and the next 2 days. */
  days: Record<string, string | number | null>[];
}

/** Daily summary for the AI: rain, temperature, evapotranspiration (ET0), wind. US units, local days. */
export async function fetchDailyWeather(): Promise<DailyWeather> {
  const params = new URLSearchParams({
    latitude: String(config.location.latitude),
    longitude: String(config.location.longitude),
    daily: [
      'precipitation_sum',
      'precipitation_probability_max',
      'temperature_2m_max',
      'temperature_2m_min',
      'et0_fao_evapotranspiration',
      'wind_speed_10m_max',
      'relative_humidity_2m_mean',
      'sunshine_duration',
    ].join(','),
    past_days: '14',
    forecast_days: '3',
    timezone: config.timezone,
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
  });
  const res = await fetch(`${config.weather.url}?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = (await res.json()) as {
    daily?: Record<string, (string | number | null)[]>;
    daily_units?: Record<string, string>;
  };
  const daily = data.daily;
  if (!daily?.time?.length) throw new Error('Open-Meteo response missing daily data');
  const keys = Object.keys(daily);
  const days = daily.time.map((_, i) => Object.fromEntries(keys.map((k) => [k, daily[k]![i] ?? null])));
  return { units: data.daily_units ?? {}, days };
}
