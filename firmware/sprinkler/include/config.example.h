// Copy to config.h (gitignored) and fill in:  cp include/config.example.h include/config.h
#pragma once

// Wi-Fi (the ESP32 only does 2.4 GHz)
#define WIFI_SSID       "your-wifi-name"
#define WIFI_PASSWORD   "your-wifi-password"
#define DEVICE_HOSTNAME "sprinkler-esp32"   // also the OTA target: sprinkler-esp32.local

// MQTT broker = the computer running the Caretaker server. "<hostname>.local" is
// found over mDNS, so that computer needs no fixed IP. A plain IP works too.
#define MQTT_HOST       "your-server.local"
#define MQTT_PORT       1883
#define MQTT_USER       "sprinkler"
#define MQTT_PASSWORD   "change-me"         // MQTT_PASSWORD in server/.env
#define MQTT_TOPIC_BASE "sprinkler"         // zones publish under sprinkler/zone1, sprinkler/zone2, ...

// Relays, one per zone (valve), in zone order: zone 1, zone 2, ...
// GPIO 26 and 25 are safe outputs (not boot-strapping pins). One valve: {26}
#define RELAY_PINS       {26, 25}
// true  = relay turns on when IN is pulled LOW (most opto-isolated modules)
// false = relay turns on when IN is HIGH (H/L jumper on H, or a transistor driver)
#define RELAY_ACTIVE_LOW true

// Flow meter on the valve outlet, signal through a diode (docs/hardware.md). -1 = none.
#define FLOW_PIN 27
#define FLOW_ZONE 1   // which zone's valve outlet the meter is on

// Hard limit on any run, enforced on the ESP32 itself, so a crashed server or lost
// Wi-Fi can never leave the water on.
#define FAILSAFE_MAX_MINUTES 120

// Password for firmware updates over Wi-Fi (also read by scripts/ota_auth.py)
#define OTA_PASSWORD    "change-me-too"
