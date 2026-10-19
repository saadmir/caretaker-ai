import { config } from '../config.js';
import type { WateringRecord } from '../store.js';

/** Gallons per minute the emitters should deliver, from EMITTER_COUNT x EMITTER_GPH. */
export const estimatedGpm = () => (config.irrigation.emitterCount * config.irrigation.emitterGph) / 60;

/**
 * Typical measured flow: the median of the last five metered waterings of 2+ minutes,
 * or null before there are any. Runs with almost no flow are left out, since they mean
 * the supply was off or the sensor failed, not that the garden's flow changed.
 */
export function measuredGpm(waterings: WateringRecord[]): number | null {
  const rates = waterings
    .filter((w) => w.gallons !== undefined && w.minutes >= 2)
    .map((w) => w.gallons! / w.minutes)
    .filter((r) => r >= config.flow.noFlowGpm)
    .slice(0, 5)
    .sort((a, b) => a - b);
  return rates.length ? rates[Math.floor(rates.length / 2)]! : null;
}

/** Measured when the flow meter has data, estimated otherwise. */
export const gallonsPerMinute = (waterings: WateringRecord[]) => measuredGpm(waterings) ?? estimatedGpm();
