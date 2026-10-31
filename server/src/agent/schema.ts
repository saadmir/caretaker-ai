import { z } from 'zod';

// The shape Claude must answer in. The API enforces it (structured output), so the
// reply always parses; whether the plan is *safe* is checked separately in plan.ts.

export const ZoneDecision = z.object({
  zone: z.number().describe('The zone number this plan is for.'),
  action: z.enum(['water', 'skip']),
  start_time: z
    .string()
    .describe('Local 24-hour start time HH:MM inside the watering window. Use the window start when skipping.'),
  cycle_minutes: z.array(z.number()).describe('Run minutes for each watering cycle, in order. Empty when skipping.'),
  soak_minutes_between_cycles: z
    .number()
    .describe('Pause between cycles so water soaks in. 0 for a single cycle or when skipping.'),
  soil_estimate: z.enum(['dry', 'slightly dry', 'moist', 'wet']),
  note: z.string().describe('One short sentence for the homeowner about this zone.'),
});

export const WateringDecision = z.object({
  zones: z.array(ZoneDecision).describe('Exactly one plan per zone.'),
  headline: z.string().describe('One short line for a phone notification, covering all zones.'),
  reasoning: z.string().describe('2-6 plain-English sentences for the homeowner explaining the decision for each zone.'),
});

export type ZoneDecision = z.infer<typeof ZoneDecision>;
export type WateringDecision = z.infer<typeof WateringDecision>;
