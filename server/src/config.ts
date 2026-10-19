import 'dotenv/config';

// All settings come from server/.env (see .env.example for what each one means).

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required setting ${name} in .env (see .env.example)`);
}

function num(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required setting ${name} in .env (see .env.example)`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export type AiMode = 'off' | 'advise' | 'auto';
export function parseAiMode(raw: string): AiMode {
  if (raw === 'off' || raw === 'advise' || raw === 'auto') return raw;
  throw new Error(`AI mode must be off, advise or auto, got "${raw}"`);
}

// Set the process timezone before any date is formatted, so "local time" is the garden's.
process.env.TZ = str('TIMEZONE', Intl.DateTimeFormat().resolvedOptions().timeZone);

export const config = {
  timezone: process.env.TZ,
  dataDir: str('DATA_DIR', './data'),

  web: {
    port: num('WEB_PORT', 8080),
    password: process.env.WEB_PASSWORD ?? '', // empty = no login, LAN only
  },

  mqtt: {
    port: num('MQTT_PORT', 1883),
    username: str('MQTT_USERNAME', 'sprinkler'),
    password: str('MQTT_PASSWORD'),
    topicBase: str('MQTT_TOPIC_BASE', 'sprinkler/zone1'),
  },

  // Required: the weather forecast and the AI both depend on where the garden is.
  location: {
    latitude: num('LATITUDE'),
    longitude: num('LONGITUDE'),
  },

  weather: {
    url: str('OPEN_METEO_URL', 'https://api.open-meteo.com/v1/forecast'),
    pollMinutes: num('WEATHER_POLL_MINUTES', 15),
    rainRecordMinMm: num('RAIN_RECORD_MIN_MM', 0.5), // a past hour this wet counts as rain
    forecastRainMinMm: num('FORECAST_RAIN_MIN_MM', 0.5),
    forecastRainMinProb: num('FORECAST_RAIN_MIN_PROBABILITY', 50),
    forecastHorizonHours: num('FORECAST_HORIZON_HOURS', 24),
  },

  // The plain "dry for N hours" rule. In AI auto mode it only covers days the AI is unavailable.
  schedule: {
    autoEnabledDefault: bool('AUTO_ENABLED', true),
    dryHoursThreshold: num('DRY_HOURS_THRESHOLD', 240),
    autoRunMinutes: num('AUTO_RUN_MINUTES', 10),
    windowStartHour: num('WATER_WINDOW_START_HOUR', 5), // automatic runs start in [start, end)
    windowEndHour: num('WATER_WINDOW_END_HOUR', 9),
    defaultManualMinutes: num('DEFAULT_MANUAL_MINUTES', 30),
  },

  alerts: {
    longRunMinutes: num('LONG_RUN_ALERT_MINUTES', 30),
    longRunRepeatMinutes: num('LONG_RUN_ALERT_REPEAT_MINUTES', 15),
    offlineAfterMinutes: num('OFFLINE_ALERT_MINUTES', 3),
  },

  // Used to estimate gallons until the flow meter has measured a few waterings.
  irrigation: {
    emitterCount: num('EMITTER_COUNT', 40),
    emitterGph: num('EMITTER_GPH', 5),
  },

  flow: {
    // FS400A G1": pulse Hz = 4.8 x L/min, i.e. 288 pulses per liter. Calibrate against the water meter.
    pulsesPerLiter: num('FLOW_PULSES_PER_LITER', 288),
    leakGpm: num('FLOW_LEAK_GPM', 0.25),
    leakMinutes: num('FLOW_LEAK_MINUTES', 3),
    noFlowSeconds: num('FLOW_NO_FLOW_SECONDS', 90),
    noFlowGpm: num('FLOW_NO_FLOW_GPM', 0.1),
  },

  ai: {
    defaultMode: parseAiMode(process.env.AI_MODE || 'advise'),
    apiKeySet: !!process.env.ANTHROPIC_API_KEY,
    model: str('AI_MODEL', 'claude-opus-5-5'),
    effort: str('AI_EFFORT', 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    decisionHour: num('AI_DECISION_HOUR', 4),
    decisionMinute: num('AI_DECISION_MINUTE', 30),
    gardenFile: str('GARDEN_FILE', './garden.md'),
    // Hard limits on what the AI can plan. Enforced in code, whatever the model asks for.
    limits: {
      maxMinutesPerDay: num('AI_MAX_MINUTES_PER_DAY', 30),
      maxCycleMinutes: num('AI_MAX_CYCLE_MINUTES', 15),
      maxCycles: num('AI_MAX_CYCLES', 4),
      minSoakMinutes: num('AI_MIN_SOAK_MINUTES', 15),
      maxSoakMinutes: num('AI_MAX_SOAK_MINUTES', 90),
      minHoursBetweenWaterings: num('AI_MIN_HOURS_BETWEEN_WATERINGS', 48),
    },
  },

  bark: {
    server: str('BARK_SERVER', 'https://api.day.app'),
    deviceKey: process.env.BARK_DEVICE_KEY ?? '',
    encryptionKey: process.env.BARK_ENCRYPTION_KEY ?? '', // 32 chars, same as the app's AES-256 key
    group: str('BARK_GROUP', 'Caretaker'),
    criticalAlerts: bool('BARK_CRITICAL_ALERTS', false), // urgent alerts ring even on silent
  },
} as const;

if (config.bark.encryptionKey && Buffer.byteLength(config.bark.encryptionKey) !== 32) {
  throw new Error('BARK_ENCRYPTION_KEY must be exactly 32 characters (AES-256)');
}

export type Config = typeof config;
export type AiLimits = Config['ai']['limits'];
