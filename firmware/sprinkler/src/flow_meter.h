#pragma once
// Hall-effect flow meter on the valve outlet (e.g. FS400A G1"). The turbine gives one
// pulse per small volume of water; we just count pulses and let the server convert
// them to gallons, so calibration never needs a re-flash.

#include <Arduino.h>

class FlowMeter {
 public:
  explicit FlowMeter(int pin) : pin_(pin) {}

  bool present() const { return pin_ >= 0; }

  void begin() {
    if (!present()) return;
    instance_ = this;
    // The sensor pulls the line low through a diode; the pull-up supplies the high level.
    pinMode(pin_, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(pin_), onPulse, FALLING);
    sampleMs_ = millis();
  }

  /** Total pulses since boot. Wraps at 2^32; the server only uses differences. */
  uint32_t pulses() const { return pulses_; }

  /** Pulses per second, averaged over the last sample period. */
  float pulsesPerSec() const { return pps_; }

  /** Call from loop(). Updates the rate every `periodMs`. */
  void sample(uint32_t nowMs, uint32_t periodMs) {
    if (!present() || nowMs - sampleMs_ < periodMs) return;
    const uint32_t p = pulses_;
    pps_ = (p - samplePulses_) * 1000.0f / (nowMs - sampleMs_);
    samplePulses_ = p;
    sampleMs_ = nowMs;
  }

 private:
  // Edges closer than 1 ms are noise on the cable: at its 60 L/min maximum the
  // sensor gives about 290 pulses/s, i.e. 3.5 ms apart.
  static constexpr uint32_t kMinPulseGapUs = 1000;

  static void onPulse();  // interrupt handler, in flow_meter.cpp (IRAM code can't be inline)

  static FlowMeter *instance_;
  const int pin_;
  volatile uint32_t pulses_ = 0;
  volatile uint32_t lastPulseUs_ = 0;
  uint32_t sampleMs_ = 0;
  uint32_t samplePulses_ = 0;
  float pps_ = 0;
};
