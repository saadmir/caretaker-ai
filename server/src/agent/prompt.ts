import { config, type ZoneConfig } from '../config.js';
import type { DailyWeather, WeatherSnapshot } from '../integrations/weather.js';
import type { PersistedState, WateringRecord } from '../store.js';
import { HOUR, localDate } from '../util/time.js';
import { estimatedGpm, gallonsPerMinute, measuredGpm } from '../watering/flow-rate.js';

// Everything the AI knows comes from here. The prompt is rebuilt from scratch each
// morning with all the evidence up front, so the model needs no tools or memory:
// the decision history and the owner's notes are its memory.

export const SYSTEM_PROMPT = `You are the irrigation manager for a home garden. Each morning, before the watering window opens, you decide for each of the garden's irrigation zones (one valve each) whether it should run today and, if so, how. Zones differ in plants, sun and emitters, so judge each on its own; they can run at the same time.

You know horticulture, soil-water balance and how local climate shapes plant water use. Use the evidence you're given: the garden description, the recent and forecast weather (rain, temperature, reference evapotranspiration ET0, wind, humidity), what was watered recently, your own previous decisions, and the owner's notes. The owner's notes are first-hand observations of the garden and outrank general rules of thumb. Think about how much water the plants have actually received versus used since they were last wet, rather than counting days.

Plan within the limits you're given; the controller enforces them regardless and will cut anything beyond them. When water is likely to run off (steep slopes, high-flow emitters), split the run into shorter cycles with soak time between them. Skipping is a normal, frequent outcome for drought-tolerant plants; don't water just because you were asked.

The owner reads your headline and reasoning on a phone. Write them for a homeowner, in plain words, using gallons and inches rather than jargon. Mention the key facts that drove the decision, and refer to zones by their names.`;

export interface PromptInput {
  now: Date;
  forDate: string;
  garden: string;
  state: PersistedState;
  weather: WeatherSnapshot | null;
  daily: DailyWeather;
}

export function buildPrompt({ now, forDate, garden, state, weather, daily }: PromptInput): string {
  const sc = config.schedule;
  const limits = config.ai.limits;
  const gaps = config.zones.map((z) => `${z.minHoursBetweenWaterings} h for ${z.name}`).join(', ');

  return `Today is ${now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${config.timezone}).
Decide for the watering window on ${forDate}, ${sc.windowStartHour}:00–${sc.windowEndHour}:00 local time.

<garden>
${garden}
</garden>

<irrigation_zones>
${config.zones.map((z) => irrigationSummary(z, state.waterings)).join('\n')}
</irrigation_zones>

<limits>
These apply to each zone separately.
- Each cycle: at most ${limits.maxCycleMinutes} min. At most ${limits.maxCycles} cycles and ${limits.maxMinutesPerDay} min in total per day.
- Soak time between cycles: ${limits.minSoakMinutes}–${limits.maxSoakMinutes} min.
- The first cycle must start inside the window. Minimum time since the zone's previous watering: ${gaps}.
- The controller will not start a cycle while it is raining.
</limits>

<daily_weather>
Past 14 days, today, and the next 2 days (local days).
${weatherTable(daily)}
</daily_weather>

<current_conditions>
${currentConditions(weather)}
</current_conditions>

<watering_history_last_30_days>
${wateringHistory(state.waterings, now) || 'None recorded.'}
</watering_history_last_30_days>

<your_previous_decisions>
${previousDecisions(state) || 'None yet; this is your first decision.'}
</your_previous_decisions>

<owner_notes>
${state.notes.slice(0, 20).map((n) => `- ${localDate(new Date(n.at))}: ${n.text}`).join('\n') || 'None.'}
</owner_notes>`;
}

function irrigationSummary(zone: ZoneConfig, waterings: WateringRecord[]): string {
  const head = zone.name === `Zone ${zone.id}` ? `- ${zone.name}:` : `- Zone ${zone.id} (${zone.name}):`;
  const n = zone.emitterCount;
  const measured = measuredGpm(waterings, zone.id);
  if (measured !== null) {
    const perEmitter = n > 0 ? ` across ${n} emitters (≈${((measured * 60) / n).toFixed(1)} GPH each)` : '';
    return `${head} a flow meter measures every watering. Recent waterings averaged ${measured.toFixed(2)} gallons per minute${perEmitter}.`;
  }
  const est = estimatedGpm(zone);
  if (est === null) return `${head} no flow meter, and the emitter count is not known yet. Plan in minutes; gallons are unknown.`;
  return `${head} ${n} emitters at about ${zone.emitterGph} GPH each ≈ ${est.toFixed(1)} gallons per minute (an estimate; no flow meter).`;
}

function weatherTable(daily: DailyWeather): string {
  const cols = Object.keys(daily.days[0] ?? {});
  const header = cols.map((c) => (daily.units[c] && c !== 'time' ? `${c} (${daily.units[c]})` : c)).join(' | ');
  const rows = daily.days.map((d) => cols.map((c) => d[c] ?? '').join(' | '));
  return [header, ...rows].join('\n');
}

function currentConditions(w: WeatherSnapshot | null): string {
  if (!w) return 'Current conditions unavailable.';
  return (
    `Raining right now: ${w.rainingNow ? 'yes' : 'no'}. Next 24 h: ${(w.next24hTotalMm / 25.4).toFixed(2)} in ` +
    `total forecast, max hourly chance ${w.next24hMaxProbability}%.`
  );
}

function wateringHistory(waterings: WateringRecord[], now: Date): string {
  const since = now.getTime() - 30 * 24 * HOUR;
  const gpm = new Map(config.zones.map((z) => [z.id, gallonsPerMinute(waterings, z)]));
  return waterings
    .filter((w) => Date.parse(w.start) >= since)
    .map((w) => {
      const when = new Date(w.start).toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      return `- ${when}: ${zoneName(w.zone)}, ${w.minutes} min, ${gallonsNote(w, gpm.get(w.zone) ?? null)} (${w.reason})`;
    })
    .join('\n');
}

function gallonsNote(w: WateringRecord, gpm: number | null): string {
  if (w.gallons === undefined) return gpm !== null ? `≈${Math.round(w.minutes * gpm)} gal (estimated)` : 'gallons unknown';
  if (w.gallons / Math.max(w.minutes, 0.1) < config.flow.noFlowGpm) {
    return `${w.gallons} gal measured: almost no flow (supply off or sensor fault, unclear which)`;
  }
  return `${w.gallons} gal measured`;
}

function previousDecisions(state: PersistedState): string {
  return state.aiDecisions
    .slice(0, 7)
    .map((d) => {
      const zones = d.zones.map((z) => {
        const total = z.cycles.reduce((a, c) => a + c.minutes, 0);
        const plan = z.action === 'water' ? ` ${z.cycles.length} cycle(s), ${total} min total` : '';
        return `${zoneName(z.zone)}: ${z.action}${plan} (soil estimate: ${z.soilEstimate})`;
      });
      return `- for ${d.forDate}: ${zones.join('; ')} — "${d.headline}"`;
    })
    .join('\n');
}

const zoneName = (id: number) => config.zones.find((z) => z.id === id)?.name ?? `Zone ${id}`;
