# The AI gardener

The AI gardener decides each morning whether to water, and how. This page covers what
it sees, what it may answer, how its answer is made safe, and how it learns from what
actually happened. The code is in `server/src/agent/` and `server/src/watering/ai-schedule.ts`.

## The problem

My garden is drought-tolerant succulents on a steep, windy slope with a sidewalk at the
bottom. A fixed timer is wrong most days:
- **Overwatering** rots succulents and runs off onto the sidewalk.
- **Underwatering** shows up slowly and only after hot spells.

The right answer depends on more than a timer can know: recent rain, evapotranspiration,
wind, cloud and fog, the season, half the slope being shaded, and how much water actually
came out of the emitters. That kind of judgment from messy evidence is what LLMs are good
at. A wrong answer, though, wastes water or kills plants, so the system around the model
matters as much as the model.

## Inputs (`prompt.ts`)

The prompt is rebuilt from scratch every morning. Everything the model knows is in it,
so it needs no tools and no hidden memory:

| Section | Source |
|---|---|
| `garden` | `garden.md`, my description of the site, plants and irrigation (kept private; see `garden.example.md`) |
| `irrigation_system` | Measured flow rate (median of recent metered waterings), or the emitter estimate before there are any |
| `limits` | The same limits the guardrails enforce, so the model plans within them |
| `daily_weather` | Open-Meteo: 14 past days, today and 2 forecast days. Rain, rain probability, high/low temperature, **ET0** (reference evapotranspiration), wind, humidity, sunshine |
| `current_conditions` | Raining now? Rain total and probability for the next 24 h |
| `watering_history_last_30_days` | Every watering with duration, reason and **measured gallons**. A near-zero reading is flagged as "supply off or sensor fault" |
| `your_previous_decisions` | Its own last 7 decisions and soil estimates, which give it continuity from day to day |
| `owner_notes` | Notes I add on the dashboard ("bottom row looks shriveled", "planted new aloes"). The system prompt says these outrank rules of thumb |

The system prompt (`SYSTEM_PROMPT`) frames the role:
- reason about water received vs. used, not days elapsed,
- split runs into cycles where runoff is likely,
- treat skipping as a normal outcome,
- write the explanation for a homeowner, in gallons and inches.

## Output (`schema.ts`)

The call uses **structured output**: the API constrains the reply to a Zod schema, so it
always parses:

```ts
{
  action: 'water' | 'skip',
  start_time: 'HH:MM',
  cycle_minutes: number[],              // e.g. [5, 5, 5]
  soak_minutes_between_cycles: number,
  soil_estimate: 'dry' | 'slightly dry' | 'moist' | 'wet',
  headline: string,                     // one line for the notification
  reasoning: string,                    // 2-5 sentences for the homeowner
}
```

Request details (`gardener.ts`):
- **Model and effort:** `claude-opus-5-5` with effort `high`.
- **Server-side fallback:** if the model declines, the API retries on its default fallback model.
- **Stop reasons:** refusals, truncation and unparseable replies all raise errors, and the scheduler handles those (see "Modes, schedule and fallback" below).

## Guardrails (`plan.ts`)

The model is *told* the limits, but `applyGuardrails()` is what enforces them. It is a
pure function: decision, date, time, last watering and limits in; concrete cycle times
and a list of adjustments out. It has unit tests (`server/test/plan.test.ts`).

| Rule | Default |
|---|---|
| Max minutes per cycle | 15 |
| Max cycles per day | 4 |
| Max total minutes per day | 30 |
| Soak time between cycles | 15–90 min |
| First cycle starts inside the watering window | 5:00–9:00 |
| Asked late? Start a minute from now, or skip if the window has closed | |
| Minimum time since the last watering | 48 h |

Every adjustment is logged, shown on the dashboard, and included in the notification
("Adjusted by limits: Cycles capped at 15 min."). I can see when the model pushes against
a limit and decide whether the limit or the prompt is wrong.

**Checks when each cycle starts (`ai-schedule.ts`).** Cycles are rechecked right before
they run, not only when planned:
- **Valve already on** (e.g. a manual run): wait for it to finish.
- **ESP32 offline:** wait; after 2 h, drop the rest of the plan.
- **Raining:** stop the plan.
- **Previous cycle didn't run:** stop the plan.
- **Late start:** later cycles shift too, so the soak time is kept.

Below all of this, the ESP32 enforces each run's duration and an absolute 120-minute
failsafe on its own.

## Modes, schedule and fallback

| Mode | The AI decides | It waters | The plain rule |
|---|---|---|---|
| Off | no | no | runs |
| Advise | yes, and notifies | no | runs |
| Auto | yes, and notifies | yes | only on days the AI failed |

- **When it decides:** daily at 4:30 local time, or on demand with **Ask AI now**.
- **Retries:** up to 3 tries, 10 minutes apart.
- **Fallback:** an invalid key or missing credit skips the retries. Either way, a failure marks the day failed, the plain weather-aware rule covers it, and I get a notification.
- **No decision, no watering:** auto mode never waters on a plan it doesn't have.

## Feedback loops

- **Measured flow.** Gallons per watering come from the flow meter, not from minutes × an
  assumed emitter rate. The AI's gallon numbers, and the dashboard's, use the median of
  recent measured flow.
- **Its own history.** Previous decisions and soil estimates give continuity ("I watered
  two days ago and estimated moist; ET0 has been low, so skip").
- **My observations.** Notes carry what no sensor sees yet: wilting, new plantings, a trip
  away.

## Cost

One decision is a single request with a few thousand input tokens, so it costs a few
cents. Token counts are stored with each decision. A spend limit on the API account caps
the worst case.

## What's next for the agent

- **Evaluation harness.** Replay historical weather and record what the model would have
  done, compare it against simple baselines and a hand-labeled set of "obvious" days, and
  track how often guardrails fire. That's what makes prompt and model changes safe.
- **Tool use across devices.** As doors, cameras and lights join, move from one structured
  call to an agent with tools (`get_weather`, `get_door_state`, `set_lights`,
  `ask_owner`). Each tool gets a permission level, from read-only through act and
  act-with-confirmation, with the same guardrail-in-code principle. See
  [roadmap.md](roadmap.md).
- **Soil moisture sensors** to replace the model's soil *estimate* with a measurement.
