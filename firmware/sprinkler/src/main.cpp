// Caretaker AI: sprinkler valve controller (ESP32).
//
// Deliberately simple. All the decisions are made on the server; this board just:
//   - drives the relay that switches 24 VAC to the valve,
//   - takes on/off commands over MQTT,
//   - enforces the run time and an absolute failsafe locally, so the valve closes
//     even if the server or Wi-Fi disappears mid-run,
//   - always boots with the valve closed,
//   - counts flow meter pulses and reports state (on change, every 30 s, every 5 s while water flows).
//
// MQTT topics, under MQTT_TOPIC_BASE:
//   cmd           in   {"action":"on","durationSec":600,"reason":"ai"}, {"action":"off"}, {"action":"ping"}
//   state         out  retained JSON, see publishState()
//   availability  out  "online" / "offline" (retained; "offline" is the last will)

#include <Arduino.h>
#include <ArduinoJson.h>
#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <PubSubClient.h>
#include <WiFi.h>

#if __has_include("config.h")
#include "config.h"
#else
#error "Missing include/config.h: copy include/config.example.h to include/config.h and fill it in."
#endif

#include "flow_meter.h"

#ifndef FLOW_PIN
#define FLOW_PIN -1
#endif

static const char *FW_VERSION = "1.1.0";
static const uint32_t HEARTBEAT_MS = 30000;
static const uint32_t FLOWING_REPORT_MS = 5000;
static const uint32_t FAILSAFE_MS = (uint32_t)FAILSAFE_MAX_MINUTES * 60000UL;

static const String TOPIC_CMD = String(MQTT_TOPIC_BASE) + "/cmd";
static const String TOPIC_STATE = String(MQTT_TOPIC_BASE) + "/state";
static const String TOPIC_AVAIL = String(MQTT_TOPIC_BASE) + "/availability";

static WiFiClient wifiClient;
static PubSubClient mqtt(wifiClient);
static FlowMeter flow(FLOW_PIN);

struct Valve {
  bool on = false;
  uint32_t onSinceMs = 0;
  uint32_t limitMs = 0;          // requested run time, never more than FAILSAFE_MS
  uint32_t startPulses = 0;      // flow pulse count when it opened
  uint32_t runPulses = 0;        // pulses of the current run, or the last one once closed
  String reason = "boot";
} valve;

static uint32_t lastReportMs = 0;
static uint32_t lastMqttAttemptMs = 0;
static uint32_t lastWifiAttemptMs = 0;

// ---------------------------------------------------------------------------
// Relay

static void writeRelay(bool on) {
  const int level = (on == RELAY_ACTIVE_LOW) ? LOW : HIGH;
  static bool pinReady = false;
  if (!pinReady) {
    // Set the level before the pin becomes an output, so the relay never sees the
    // "on" level at boot, not even for a moment. Core 3.x's digitalWrite() ignores
    // pins that aren't outputs yet, hence the IDF call.
    gpio_set_level((gpio_num_t)RELAY_PIN, level);
    pinMode(RELAY_PIN, OUTPUT);
    pinReady = true;
  }
  digitalWrite(RELAY_PIN, level);
}

// ---------------------------------------------------------------------------
// State reports

static void publishState() {
  if (!mqtt.connected()) return;
  const uint32_t now = millis();
  JsonDocument doc;
  doc["state"] = valve.on ? "on" : "off";
  doc["reason"] = valve.reason;
  if (valve.on) {
    const uint32_t elapsed = now - valve.onSinceMs;
    doc["onForSec"] = elapsed / 1000;
    doc["remainingSec"] = elapsed >= valve.limitMs ? 0 : (valve.limitMs - elapsed) / 1000;
  }
  doc["uptimeSec"] = now / 1000;
  doc["rssi"] = WiFi.RSSI();
  doc["ip"] = WiFi.localIP().toString();
  doc["fw"] = FW_VERSION;
  doc["failsafeMin"] = FAILSAFE_MAX_MINUTES;
  if (flow.present()) {
    if (valve.on) valve.runPulses = flow.pulses() - valve.startPulses;
    doc["flowPulses"] = flow.pulses();
    doc["runPulses"] = valve.runPulses;
    doc["flowPps"] = roundf(flow.pulsesPerSec() * 10) / 10;
  }

  char buf[384];
  const size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(TOPIC_STATE.c_str(), (const uint8_t *)buf, n, true);
  lastReportMs = now;
}

// ---------------------------------------------------------------------------
// Valve

static void setValve(bool on, const char *reason, uint32_t durationSec = 0) {
  if (on) {
    const uint32_t requested = durationSec > 0 ? durationSec * 1000UL : FAILSAFE_MS;
    valve.limitMs = min(requested, FAILSAFE_MS);
    if (!valve.on) {  // "on" while already on only changes the time limit
      valve.onSinceMs = millis();
      valve.startPulses = flow.pulses();
      valve.runPulses = 0;
    }
  } else {
    if (valve.on) valve.runPulses = flow.pulses() - valve.startPulses;  // final total for this run
    valve.limitMs = 0;
  }
  valve.on = on;
  valve.reason = reason;
  writeRelay(on);
  Serial.printf("[valve] %s (reason=%s, limit=%lus)\n", on ? "ON" : "OFF", reason,
                (unsigned long)(valve.limitMs / 1000));
  publishState();
}

static void enforceTimeLimit(uint32_t now) {
  if (valve.on && now - valve.onSinceMs >= valve.limitMs) {
    setValve(false, valve.limitMs >= FAILSAFE_MS ? "failsafe" : "timer");
  }
}

// ---------------------------------------------------------------------------
// MQTT

static void onMqttMessage(char *topic, byte *payload, unsigned int length) {
  if (TOPIC_CMD != topic) return;
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) {
    Serial.println("[mqtt] ignoring command that isn't valid JSON");
    return;
  }
  const char *action = doc["action"] | "";
  const char *reason = doc["reason"] | "remote";
  if (strcmp(action, "on") == 0) setValve(true, reason, doc["durationSec"] | 0);
  else if (strcmp(action, "off") == 0) setValve(false, reason);
  else if (strcmp(action, "ping") == 0) publishState();
}

// The server has no fixed IP, so MQTT_HOST is usually "<hostname>.local". Look it up
// over mDNS before every connect attempt (picks up a new DHCP address), and fall
// back to the last address that worked if nobody answers.
static IPAddress lastServerIp;

static bool resolveServer() {
  const String host = MQTT_HOST;
  if (!host.endsWith(".local")) {
    mqtt.setServer(MQTT_HOST, MQTT_PORT);
    return true;
  }
  const IPAddress ip = MDNS.queryHost(host.substring(0, host.length() - 6).c_str(), 2000);
  if (ip != IPAddress()) {
    if (ip != lastServerIp) Serial.printf("[mdns] %s -> %s\n", MQTT_HOST, ip.toString().c_str());
    lastServerIp = ip;
  } else if (lastServerIp == IPAddress()) {
    Serial.printf("[mdns] no answer for %s\n", MQTT_HOST);
    return false;
  } else {
    Serial.printf("[mdns] no answer for %s, trying %s\n", MQTT_HOST, lastServerIp.toString().c_str());
  }
  mqtt.setServer(lastServerIp, MQTT_PORT);
  return true;
}

static void keepMqttConnected() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  const uint32_t now = millis();
  if (now - lastMqttAttemptMs < 5000) return;
  lastMqttAttemptMs = now;
  if (!resolveServer()) return;

  const String clientId = String(DEVICE_HOSTNAME) + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  Serial.printf("[mqtt] connecting to %s:%d\n", MQTT_HOST, MQTT_PORT);
  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASSWORD, TOPIC_AVAIL.c_str(), 1, true, "offline")) {
    Serial.println("[mqtt] connected");
    mqtt.publish(TOPIC_AVAIL.c_str(), "online", true);
    mqtt.subscribe(TOPIC_CMD.c_str(), 1);
    publishState();
  } else {
    Serial.printf("[mqtt] failed, rc=%d\n", mqtt.state());
  }
}

static void keepWifiConnected() {
  if (WiFi.status() == WL_CONNECTED) return;
  const uint32_t now = millis();
  if (now - lastWifiAttemptMs < 15000) return;
  lastWifiAttemptMs = now;
  Serial.println("[wifi] reconnecting");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// ---------------------------------------------------------------------------

void setup() {
  writeRelay(false);  // before anything else: valve closed
  Serial.begin(115200);
  delay(100);
  Serial.printf("\n[boot] sprinkler fw %s, relay GPIO %d (%s)\n", FW_VERSION, RELAY_PIN,
                RELAY_ACTIVE_LOW ? "active-low" : "active-high");

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(DEVICE_HOSTNAME);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttemptMs = millis();
  for (uint32_t start = millis(); WiFi.status() != WL_CONNECTED && millis() - start < 20000;) delay(250);
  if (WiFi.status() == WL_CONNECTED) Serial.printf("[wifi] connected, IP %s\n", WiFi.localIP().toString().c_str());
  else Serial.println("[wifi] not connected yet, will keep trying");

  MDNS.begin(DEVICE_HOSTNAME);
  ArduinoOTA.setHostname(DEVICE_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() {  // never water during a firmware update
    writeRelay(false);
    valve.on = false;
  });
  ArduinoOTA.begin();

  flow.begin();
  if (flow.present()) Serial.printf("[flow] meter on GPIO %d\n", FLOW_PIN);

  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(15);
}

void loop() {
  keepWifiConnected();
  keepMqttConnected();
  mqtt.loop();
  ArduinoOTA.handle();

  const uint32_t now = millis();
  enforceTimeLimit(now);
  flow.sample(now, FLOWING_REPORT_MS);
  const bool flowing = flow.present() && (valve.on || flow.pulsesPerSec() > 0);
  if (now - lastReportMs >= (flowing ? FLOWING_REPORT_MS : HEARTBEAT_MS)) publishState();
  delay(10);
}
