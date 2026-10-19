import { config } from '../config.js';
import type { Sprinkler } from '../devices/sprinkler.js';
import type { Store } from '../store.js';
import { gallonsPerMinute, measuredGpm } from '../watering/flow-rate.js';
import type { WateringController } from '../watering/controller.js';

/** Everything the dashboard shows, in one object. Sent on load and on every change. */
export function snapshot(sprinkler: Sprinkler, watering: WateringController, store: Store) {
  const st = store.state;
  return {
    device: sprinkler.status,
    weather: watering.weather,
    weatherError: watering.weatherError,
    decision: watering.dryRule,
    history: { lastRainAt: st.lastRainAt, lastWateredAt: st.lastWateredAt, lastOffAt: st.lastOffAt },
    autoEnabled: st.autoEnabled,
    ai: {
      mode: st.aiMode,
      apiKeySet: config.ai.apiKeySet,
      model: config.ai.model,
      busy: watering.ai.busy,
      error: watering.ai.error,
      failedToday: st.aiFailedDate,
      decisions: st.aiDecisions.slice(0, 7),
      notes: st.notes,
      decisionTime: `${config.ai.decisionHour}:${String(config.ai.decisionMinute).padStart(2, '0')}`,
    },
    waterings: st.waterings.slice(0, 10),
    settings: {
      dryHoursThreshold: config.schedule.dryHoursThreshold,
      autoRunMinutes: config.schedule.autoRunMinutes,
      windowStartHour: config.schedule.windowStartHour,
      windowEndHour: config.schedule.windowEndHour,
      longRunMinutes: config.alerts.longRunMinutes,
      defaultManualMinutes: config.schedule.defaultManualMinutes,
      timezone: config.timezone,
      gallonsPerMinute: Math.round(gallonsPerMinute(st.waterings) * 100) / 100,
      flowMeasured: measuredGpm(st.waterings) !== null,
    },
    events: st.events.slice(0, 50),
    serverTime: new Date().toISOString(),
  };
}
