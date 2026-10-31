/**
 * Fake ESP32 that speaks the same MQTT protocol as the firmware.
 * Lets you test the dashboard, notifications and rules before any wiring.
 *
 *   npm run simulate                 # connects to localhost
 *   MQTT_HOST=192.168.1.10 npm run simulate
 *   SIM_FLOW_GPM=0 npm run simulate  # valve opens but no water flows
 *   SIM_LEAK_GPM=1 npm run simulate  # water flows with the valve closed
 *
 * It has ZONE_COUNT valves (from .env), with the flow meter on zone 1 like the real board.
 */
import 'dotenv/config';
import mqtt from 'mqtt';

const host = process.env.MQTT_HOST ?? '127.0.0.1';
const port = Number(process.env.MQTT_PORT ?? 1883);
const base = process.env.MQTT_TOPIC_BASE ?? 'sprinkler';
const ZONES = Number(process.env.ZONE_COUNT ?? 1);
const FAILSAFE_MIN = Number(process.env.SIM_FAILSAFE_MINUTES ?? 120);
/** Speed up simulated time, e.g. SIM_SPEED=60 makes a 30-min run take 30 s. */
const SPEED = Number(process.env.SIM_SPEED ?? 1);
/** Simulated flow sensor: gallons/min with the valve open and closed. */
const FLOW_GPM = Number(process.env.SIM_FLOW_GPM ?? 3);
const LEAK_GPM = Number(process.env.SIM_LEAK_GPM ?? 0);
const PULSES_PER_GALLON = Number(process.env.FLOW_PULSES_PER_LITER ?? 288) * 3.78541;

interface Valve {
  zone: number;
  on: boolean;
  onSince: number;
  limitMs: number;
  reason: string;
}
const valves: Valve[] = Array.from({ length: ZONES }, (_, i) => ({ zone: i + 1, on: false, onSince: 0, limitMs: 0, reason: 'boot' }));
const metered = valves[0]!;

let pulses = 0;
let runStartPulses = 0;
let runPulses = 0;
let lastFlowAt = Date.now();
const started = Date.now();
const simNow = () => started + (Date.now() - started) * SPEED;

const client = mqtt.connect(`mqtt://${host}:${port}`, {
  username: process.env.MQTT_USERNAME ?? 'sprinkler',
  password: process.env.MQTT_PASSWORD,
  clientId: 'sprinkler-sim',
  keepalive: 15,
  will: { topic: `${base}/availability`, payload: Buffer.from('offline'), qos: 1, retain: true },
});

const gpmNow = () => (metered.on ? FLOW_GPM : LEAK_GPM);

function countFlow() {
  const t = Date.now();
  pulses += (((t - lastFlowAt) * SPEED) / 60_000) * gpmNow() * PULSES_PER_GALLON;
  lastFlowAt = t;
}

function publishState(v: Valve) {
  const now = simNow();
  const payload: Record<string, unknown> = {
    state: v.on ? 'on' : 'off',
    reason: v.reason,
    uptimeSec: Math.floor((now - started) / 1000),
    rssi: -55,
    ip: '127.0.0.1',
    fw: 'sim',
    failsafeMin: FAILSAFE_MIN,
  };
  if (v === metered) {
    countFlow();
    payload.flowPulses = Math.floor(pulses);
    payload.runPulses = Math.floor(v.on ? pulses - runStartPulses : runPulses);
    payload.flowPps = Math.round(((gpmNow() * PULSES_PER_GALLON) / 60) * 10) / 10;
  }
  if (v.on) {
    const el = now - v.onSince;
    payload.onForSec = Math.floor(el / 1000);
    payload.remainingSec = Math.max(0, Math.floor((v.limitMs - el) / 1000));
  }
  client.publish(`${base}/zone${v.zone}/state`, JSON.stringify(payload), { qos: 0, retain: true });
}

function publishAll() {
  valves.forEach(publishState);
  lastPublishAt = Date.now();
}

function setValve(v: Valve, next: boolean, why: string, durationSec = 0) {
  if (v === metered) countFlow();
  if (next) {
    const fs = FAILSAFE_MIN * 60_000;
    v.limitMs = durationSec > 0 ? Math.min(durationSec * 1000, fs) : fs;
    if (!v.on) {
      v.onSince = simNow();
      if (v === metered) runStartPulses = pulses;
    }
  } else if (v.on && v === metered) {
    runPulses = pulses - runStartPulses;
  }
  v.on = next;
  v.reason = why;
  console.log(`[sim] zone ${v.zone} valve ${v.on ? 'ON' : 'OFF'} (${why}${v.on ? `, ${v.limitMs / 1000}s` : ''})`);
  publishState(v);
}

client.on('connect', () => {
  console.log(`[sim] connected to ${host}:${port}, ${ZONES} zone(s)`);
  client.publish(`${base}/availability`, 'online', { qos: 1, retain: true });
  for (const v of valves) client.subscribe(`${base}/zone${v.zone}/cmd`, { qos: 1 });
  publishAll();
});
client.on('error', (e) => console.error('[sim] error', e.message));
client.on('message', (topic, buf) => {
  const v = valves.find((x) => topic === `${base}/zone${x.zone}/cmd`);
  if (!v) return;
  const cmd = JSON.parse(buf.toString()) as { action: string; durationSec?: number; reason?: string };
  if (cmd.action === 'on') setValve(v, true, cmd.reason ?? 'remote', cmd.durationSec ?? 0);
  else if (cmd.action === 'off') setValve(v, false, cmd.reason ?? 'remote');
  else if (cmd.action === 'ping') publishState(v);
});

setInterval(() => {
  for (const v of valves) {
    if (v.on && simNow() - v.onSince >= v.limitMs) setValve(v, false, v.limitMs >= FAILSAFE_MIN * 60_000 ? 'failsafe' : 'timer');
  }
}, 200);
// Like the firmware: report every 5 s while water flows or a valve is open, else every 30 s.
let lastPublishAt = 0;
setInterval(() => {
  const busy = gpmNow() > 0 || valves.some((v) => v.on);
  const every = (busy ? 5_000 : 30_000) / Math.max(1, Math.min(SPEED, 10));
  if (Date.now() - lastPublishAt >= every) publishAll();
}, 500);
