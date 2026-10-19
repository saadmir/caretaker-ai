#include "flow_meter.h"

FlowMeter *FlowMeter::instance_ = nullptr;

void IRAM_ATTR FlowMeter::onPulse() {
  const uint32_t t = micros();
  if (t - instance_->lastPulseUs_ < kMinPulseGapUs) return;
  instance_->lastPulseUs_ = t;
  instance_->pulses_++;
}
