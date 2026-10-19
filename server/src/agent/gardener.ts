import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { readFileSync } from 'node:fs';
import { config, type AiMode } from '../config.js';
import { fetchDailyWeather, type WeatherSnapshot } from '../integrations/weather.js';
import type { AiDecisionRecord, PersistedState } from '../store.js';
import { applyGuardrails, planDateFor } from './plan.js';
import { buildPrompt, SYSTEM_PROMPT } from './prompt.js';
import { WateringDecision } from './schema.js';

// The AI gardener: one Claude call per day that returns a structured watering plan.
// The plan then goes through the guardrails before anything can act on it.

let client: Anthropic | null = null;

/** Ask Claude for the next watering window's plan. Throws on any failure; the caller falls back. */
export async function decideWatering(
  state: PersistedState,
  weather: WeatherSnapshot | null,
  mode: AiMode,
  now = new Date(),
): Promise<AiDecisionRecord> {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY
  const window = { startHour: config.schedule.windowStartHour, endHour: config.schedule.windowEndHour };
  const forDate = planDateFor(now, window);
  const daily = await fetchDailyWeather();
  const prompt = buildPrompt({ now, forDate, garden: readGarden(), state, weather, daily });

  const res = await client.beta.messages.parse({
    model: config.ai.model,
    max_tokens: 16_000,
    // If the model declines for policy reasons, the API retries on its default fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: config.ai.effort, format: betaZodOutputFormat(WateringDecision) },
  });

  if (res.stop_reason === 'refusal') throw new Error('The AI declined to answer');
  if (res.stop_reason === 'max_tokens') throw new Error('The AI response was cut off');
  const decision = res.parsed_output;
  if (!decision) throw new Error('The AI response could not be parsed');

  const { cycles, adjustments } = applyGuardrails({
    decision,
    forDate,
    now,
    lastWateredAt: state.lastWateredAt,
    limits: config.ai.limits,
    window,
  });
  return {
    decidedAt: now.toISOString(),
    forDate,
    mode,
    action: cycles.length ? 'water' : 'skip',
    headline: decision.headline,
    reasoning: decision.reasoning,
    soilEstimate: decision.soil_estimate,
    cycles,
    adjustments,
    model: res.model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  };
}

function readGarden(): string {
  try {
    return readFileSync(config.ai.gardenFile, 'utf8').trim();
  } catch {
    return '(No garden description file found.)';
  }
}

/** A short message for the log and dashboard. */
export function aiErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid ANTHROPIC_API_KEY';
  if (err instanceof Anthropic.PermissionDeniedError) return 'API key not permitted (check billing/credits)';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Claude API';
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}: ${err.message}`.trim();
  return (err as Error).message;
}

/** Errors that retrying in ten minutes won't fix. */
export const aiErrorIsPermanent = (err: unknown) =>
  err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError;
