# Roadmap

Watering was the first job because it's a real daily decision with real consequences.
The goal is one agent that looks after the whole property: it reasons across the
garden, doors, cameras, lights and power, acts within limits enforced in code, and asks
me before doing anything that matters.

The hardware for most of this is already on hand: two more ESP32 boards, about 200 ft of
LED strip, a solar panel with a battery, door sensors, and cameras.

## Principles that carry over

- **The model proposes, code disposes.** Every action goes through deterministic limits that are tested without the model.
- **Devices fail safe on their own.** Each ESP32 keeps its hardware safe even if the server, Wi-Fi or the AI is gone.
- **Permission levels per action:**
  - *read* (door state, battery level),
  - *act* (lights on),
  - *act with confirmation* (close the garage door),
  - *never* (unlock a door).
- **Local first.** Everything works on the LAN, and cloud services are optional add-ons.

## Garage door (ESP32 #2)

- [ ] Door position: magnetic reed switches for fully open and fully closed, so "stuck halfway" is detectable
- [ ] Control: a relay wired in parallel with the opener's wall button (the opener keeps its own safety sensors)
- [ ] Driver `devices/garage-door.ts` and MQTT topics `garage/door/{cmd,state,availability}`
- [ ] Alerts: open after dark, open longer than N minutes, opened while I'm away
- [ ] Agent action "close the garage door" at the *act with confirmation* level, via an actionable notification, and only after a camera check that the doorway is clear

## Front door

- [ ] Open/closed sensing with a magnetic reed switch or a ball-plunger switch in the frame
- [ ] Events in the activity log; alert on a door left open, or opened at unusual hours
- [ ] Monitoring only: no lock control, by design

## Cameras

- [ ] Local recording and object detection (e.g. Frigate with RTSP cameras); no cloud video
- [ ] Event clips summarized by Claude vision: "delivery left a package", "garage door is closed, driveway clear"
- [ ] Give the agent a `look(camera)` tool, so it can verify things before acting (garage doorway clear) and check the garden (plants wilting, runoff on the sidewalk)

## Solar-powered LED lighting (ESP32 #3)

- [ ] About 200 ft of LED strip on a dedicated ESP32 with MOSFET or WLED-style control over MQTT
- [ ] Solar panel + battery: read the charge controller (Modbus/RS485, or an INA219 shunt) for state of charge and solar input
- [ ] Agent-planned lighting: sunset schedule, brightness scaled to the battery's charge and tomorrow's solar forecast, never draining the battery below a floor enforced in firmware
- [ ] Lights as a signal: flash on an urgent alert, light the path when a door opens at night

## Network watchdog

One mesh Wi-Fi point in a corner of the house regularly loses its wireless link to
the main router and stays stuck until someone power-cycles it by hand. Until it gets
wired backhaul, the house can fix this itself.

- [ ] An ESP32 with a relay on the mesh point's power, near the point
- [ ] Every minute it checks that it can reach the main router (gateway ping) and an outside address
- [ ] If both have failed for 10 minutes, it power-cycles the point. Then it backs off: no more than one restart every 30 minutes, and it stops after 3 in a row so a real outage doesn't cause endless reboots
- [ ] The decision logic runs on the ESP32 itself, because the network is down exactly when it's needed
- [ ] Once reconnected, it reports each restart (time, how long the link was down) over MQTT. The server logs it, shows uptime on the dashboard, and notifies me if it starts happening more often
- [ ] Later: the agent spots patterns, e.g. drops tied to time of day or to heavy use of the Starlink router's Wi-Fi, and suggests a fix

## Voice assistants

- [ ] **Matter** as the main route: an ESP32 Matter bridge, or Matter exposure from the server, works with both Alexa and Google Home without a custom cloud skill
- [ ] Alexa Smart Home skill and Google Home cloud-to-cloud as alternatives (both need a cloud endpoint; weigh against local first)
- [ ] Voice requests go through the same permission levels and guardrails as everything else

## The agent

- [ ] **Tool-using agent.** Move from one structured decision per day to an event-driven agent with tools across devices:
  - read tools: `get_weather`, `get_door_state`, `get_battery`, `look`
  - action tools: `water_plan`, `set_lights`
  - asking me: `ask_owner`
- [ ] **Policy layer.** A single place that checks every tool call against its permission level and the device's limits
- [ ] **MCP server.** Expose the home's devices as an MCP server, so other Claude clients can use them under the same policy
- [ ] **Evaluation harness.** Replay past days and check against baselines and labeled cases; regression-test prompt and model changes
- [ ] **Observability.** A decision timeline, token cost per day, and guardrail hit rates on the dashboard
- [ ] **Memory.** Seasonal patterns and my preferences, summarized into the prompt

## Engineering

- [ ] GitHub Actions: typecheck, unit tests and a firmware build on every push
- [ ] Multi-device dashboard (one card per device)
- [ ] Multiple irrigation zones
- [ ] Soil moisture sensors
- [ ] Backup and restore for `.env` and `state.json`; SQLite once the history outgrows a JSON file
