import { config, type ZoneConfig } from '../config.js';
import type { WateringRecord } from '../store.js';

/** Gallons per minute the zone's emitters should deliver, or null while the emitter count is unknown (0). */
export const estimatedGpm = (zone: ZoneConfig): number | null =>
  zone.emitterCount > 0 ? (zone.emitterCount * zone.emitterGph) / 60 : null;

/**
 * Typical measured flow of one zone: the median of its last five metered waterings of
 * 2+ minutes, or null before there are any. Runs with almost no flow are left out, since
 * they mean the supply was off or the sensor failed, not that the garden's flow changed.
 */
export function measuredGpm(waterings: WateringRecord[], zone: number): number | null {
  const rates = waterings
    .filter((w) => w.zone === zone && w.gallons !== undefined && w.minutes >= 2)
    .map((w) => w.gallons! / w.minutes)
    .filter((r) => r >= config.flow.noFlowGpm)
    .slice(0, 5)
    .sort((a, b) => a - b);
  return rates.length ? rates[Math.floor(rates.length / 2)]! : null;
}

/** Measured when the zone's flow meter has data, estimated from its emitters otherwise; null if neither. */
export const gallonsPerMinute = (waterings: WateringRecord[], zone: ZoneConfig) =>
  measuredGpm(waterings, zone.id) ?? estimatedGpm(zone);
