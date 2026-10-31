import { config } from '../config.js';
import type { Store } from '../store.js';
import { gallonsPerMinute, measuredGpm } from '../watering/flow-rate.js';
import type { WateringController } from '../watering/controller.js';

/** Everything the dashboard shows, in one object. Sent on load and on every change. */
export function snapshot(watering: WateringController, store: Store) {
  const st = store.state;
  const gpm = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
  return {
    device: watering.zones[0]!.sprinkler.status, // the ESP32 itself: online, Wi-Fi, firmware
    zones: watering.zones.map((z) => {
      const zs = store.zone(z.id);
      return {
        id: z.id,
        name: z.name,
        valve: z.sprinkler.status,
        autoEnabled: zs.autoEnabled,
        lastWateredAt: zs.lastWateredAt,
        lastOffAt: zs.lastOffAt,
        decision: z.dryRule,
        gallonsPerMinute: gpm(gallonsPerMinute(st.waterings, z.cfg)),
        flowMeasured: measuredGpm(st.waterings, z.id) !== null,
      };
    }),
    weather: watering.weather,
    weatherError: watering.weatherError,
    history: { lastRainAt: st.lastRainAt },
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
    },
    events: st.events.slice(0, 50),
    serverTime: new Date().toISOString(),
  };
}
