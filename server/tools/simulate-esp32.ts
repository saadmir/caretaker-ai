/**
 * Fake ESP32 that speaks the same MQTT protocol as the firmware.
 * Lets you test the dashboard, notifications and rules before any wiring.
 *
 *   npm run simulate                 # connects to localhost
 *   MQTT_HOST=192.168.1.10 npm run simulate
 *   SIM_FLOW_GPM=0 npm run simulate  # valve opens but no water flows
 *   SIM_LEAK_GPM=1 npm run simulate  # water flows with the valve closed
 */
import 'dotenv/config';
import mqtt from 'mqtt';

const host = process.env.MQTT_HOST ?? '127.0.0.1';
const port = Number(process.env.MQTT_PORT ?? 1883);
const base = process.env.MQTT_TOPIC_BASE ?? 'sprinkler/zone1';
const FAILSAFE_MIN = Number(process.env.SIM_FAILSAFE_MINUTES ?? 120);
/** Speed up simulated time, e.g. SIM_SPEED=60 makes a 30-min run take 30 s. */
const SPEED = Number(process.env.SIM_SPEED ?? 1);
/** Simulated flow sensor: gallons/min with the valve open and closed. */
const FLOW_GPM = Number(process.env.SIM_FLOW_GPM ?? 3);
const LEAK_GPM = Number(process.env.SIM_LEAK_GPM ?? 0);
const PULSES_PER_GALLON = Number(process.env.FLOW_PULSES_PER_LITER ?? 288) * 3.78541;

let on = false;
let onSince = 0;
let limitMs = 0;
let reason = 'boot';
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

const gpmNow = () => (on ? FLOW_GPM : LEAK_GPM);

function countFlow() {
  const t = Date.now();
  pulses += (((t - lastFlowAt) * SPEED) / 60_000) * gpmNow() * PULSES_PER_GALLON;
  lastFlowAt = t;
}

function publishState() {
  countFlow();
  const now = simNow();
  const payload: Record<string, unknown> = {
    state: on ? 'on' : 'off',
    reason,
    uptimeSec: Math.floor((now - started) / 1000),
    rssi: -55,
    ip: '127.0.0.1',
    fw: 'sim',
    failsafeMin: FAILSAFE_MIN,
    flowPulses: Math.floor(pulses),
    runPulses: Math.floor(on ? pulses - runStartPulses : runPulses),
    flowPps: Math.round((gpmNow() * PULSES_PER_GALLON / 60) * 10) / 10,
  };
  if (on) {
    const el = now - onSince;
    payload.onForSec = Math.floor(el / 1000);
    payload.remainingSec = Math.max(0, Math.floor((limitMs - el) / 1000));
  }
  client.publish(`${base}/state`, JSON.stringify(payload), { qos: 0, retain: true });
  lastPublishAt = Date.now();
}

function setValve(next: boolean, why: string, durationSec = 0) {
  if (next) {
    const fs = FAILSAFE_MIN * 60_000;
    limitMs = durationSec > 0 ? Math.min(durationSec * 1000, fs) : fs;
    countFlow();
    if (!on) {
      onSince = simNow();
      runStartPulses = pulses;
    }
  } else if (on) {
    countFlow();
    runPulses = pulses - runStartPulses;
  }
  on = next;
  reason = why;
  console.log(`[sim] valve ${on ? 'ON' : 'OFF'} (${why}${on ? `, ${limitMs / 1000}s` : ''})`);
  publishState();
}

client.on('connect', () => {
  console.log(`[sim] connected to ${host}:${port}`);
  client.publish(`${base}/availability`, 'online', { qos: 1, retain: true });
  client.subscribe(`${base}/cmd`, { qos: 1 });
  publishState();
});
client.on('error', (e) => console.error('[sim] error', e.message));
client.on('message', (_t, buf) => {
  const cmd = JSON.parse(buf.toString()) as { action: string; durationSec?: number; reason?: string };
  if (cmd.action === 'on') setValve(true, cmd.reason ?? 'remote', cmd.durationSec ?? 0);
  else if (cmd.action === 'off') setValve(false, cmd.reason ?? 'remote');
  else if (cmd.action === 'ping') publishState();
});

setInterval(() => {
  if (on && simNow() - onSince >= limitMs) setValve(false, limitMs >= FAILSAFE_MIN * 60_000 ? 'failsafe' : 'timer');
}, 200);
// Like the firmware: report every 5 s while water flows, else every 30 s.
let lastPublishAt = 0;
setInterval(() => {
  const every = (gpmNow() > 0 ? 5_000 : 30_000) / Math.max(1, Math.min(SPEED, 10));
  if (Date.now() - lastPublishAt >= every) publishState();
}, 500);
