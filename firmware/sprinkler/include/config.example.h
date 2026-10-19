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
#define MQTT_TOPIC_BASE "sprinkler/zone1"

// Relay. GPIO 26 is a safe output (not a boot-strapping pin).
#define RELAY_PIN        26
// true  = relay turns on when IN is pulled LOW (most opto-isolated modules)
// false = relay turns on when IN is HIGH (H/L jumper on H, or a transistor driver)
#define RELAY_ACTIVE_LOW true

// Flow meter on the valve outlet, signal through a diode (docs/hardware.md). -1 = none.
#define FLOW_PIN 27

// Hard limit on any run, enforced on the ESP32 itself, so a crashed server or lost
// Wi-Fi can never leave the water on.
#define FAILSAFE_MAX_MINUTES 120

// Password for firmware updates over Wi-Fi (also read by scripts/ota_auth.py)
#define OTA_PASSWORD    "change-me-too"
