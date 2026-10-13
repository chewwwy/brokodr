// Bro.Kodr — the duplex pump: capture packets in, engine blocks through, render frames out.
//
// PHASE 5b. WASAPI gives capture and render as two separate clients. Even on one USB
// interface they wake independently, deliver different packet sizes (shared mode renders
// "bufferFrames - padding", which is not the period), and drift slightly against each
// other when the endpoints are on different clocks. This class is the policy between
// them, and it is portable so tests/test-duplex.cc can drive it on Linux with simulated
// packet patterns, drift and dropouts; the Windows driver only feeds it.
//
// Single thread. The driver's audio thread both pushes capture and pulls render, so
// there is no concurrency here and no atomics. Real-time safe after init(): no
// allocation, no locks, no libm.
//
// Policy, and why:
//   - The FIFO starts PRIMED with `target` frames of silence. Capture packets arrive once
//     per device period, so without that the first render pulls from an empty FIFO and
//     every stream would open with a counted underflow.
//   - WARM-UP: until the first capture packet arrives, the engine's input is the
//     primed silence, kept topped up at `target`, and none of it counts as underflow.
//     A capture endpoint routinely starts delivering some hundreds of ms after render
//     (measured under Wine: 0.6-0.7 s), and counting that as an xrun would make every
//     stream open with a fault on the device panel. It is reported as warmupFrames,
//     so a capture side that never starts is still visible.
//   - On underflow (capture late or stopped) the missing input frames are zero, the
//     engine still runs and the output is still written. Counted, never blocking. The
//     FIFO is then RE-PRIMED to `target` with silence. Without that, a capture clock
//     that runs slow by a few hundred ppm empties the cushion once and then underflows
//     by a frame or two on nearly every period — a click every ~40 ms, heard as buzz.
//     Re-priming turns that into one short gap per `target / drift` periods (about one
//     10 ms gap every 20 s at -500 ppm), the mirror image of the drift trim below.
//   - On overflow (capture faster than render, or a stalled render) the OLDEST input is
//     dropped. Latency must not grow without bound; that is the failure that makes a
//     monitoring path drift out of time with the player over an hour.
//   - Drift trim: when the fill sits above target + `slack` after a render, the excess is
//     dropped down to target. Counted separately from overflow, because a non-zero trim
//     count on a single USB interface means its two endpoints are not on one clock.
//   - The engine never sees a block longer than `blockFrames`. A render request is cut
//     into blockFrames chunks with a short last chunk, which the engine accepts.

#ifndef BROKODR_DUPLEX_H
#define BROKODR_DUPLEX_H

#include <algorithm>
#include <cstdint>
#include <vector>

#include "brokodr/device.h"

namespace brokodr {

struct DuplexCounters {
  uint64_t underflowFrames = 0;  // input frames zero-filled because the FIFO ran dry
  uint64_t underflowEvents = 0;
  uint64_t warmupFrames = 0;     // input frames rendered before the first capture packet
  uint64_t reprimeFrames = 0;    // silence inserted to restore the cushion after an underflow
  uint64_t overflowFrames = 0;  // input frames dropped because the FIFO was full
  uint64_t trimFrames = 0;      // input frames dropped by the drift trim
  uint64_t trimEvents = 0;
  uint64_t renderedFrames = 0;
  uint64_t engineBlocks = 0;
};

class DuplexPump {
 public:
  /**
   * Allocates. Call before the stream starts, never from the callback.
   *   blockFrames  largest block the engine is given (its max_block).
   *   capacity     FIFO size in frames; at least target + slack + the largest capture
   *                packet, rounded up here to a power of two.
   *   target       steady-state fill, normally one device period.
   *   slack        how far above target the fill may wander before it is trimmed.
   */
  bool init(uint32_t blockFrames, uint32_t capacity, uint32_t target, uint32_t slack) {
    if (blockFrames == 0 || target + slack >= capacity) return false;
    uint32_t cap = 1;
    while (cap < capacity) cap <<= 1;
    mask_ = cap - 1;
    fifoL_.assign(cap, 0.0f);
    fifoR_.assign(cap, 0.0f);
    inL_.assign(blockFrames, 0.0f);
    inR_.assign(blockFrames, 0.0f);
    block_ = blockFrames;
    target_ = target;
    slack_ = slack;
    head_ = 0;
    tail_ = target;  // primed: `target` frames of silence already queued
    c_ = DuplexCounters{};
    started_ = false;
    return true;
  }

  uint32_t fill() const { return static_cast<uint32_t>(tail_ - head_); }
  uint32_t capacity() const { return mask_ + 1; }
  /** True once a capture packet (silent or not) has been pushed. */
  bool started() const { return started_; }
  const DuplexCounters& counters() const { return c_; }

  /** Queue captured frames. nullptr channels (a silent packet) queue silence. */
  void push(const float* l, const float* r, uint32_t n) {
    if (n) started_ = true;
    const uint32_t cap = mask_ + 1;
    if (n > cap) {  // a packet larger than the FIFO: keep only its newest `cap` frames
      c_.overflowFrames += n - cap;
      if (l) l += n - cap;
      if (r) r += n - cap;
      n = cap;
    }
    const uint32_t room = cap - fill();
    if (n > room) {
      const uint32_t drop = n - room;
      head_ += drop;
      c_.overflowFrames += drop;
    }
    for (uint32_t i = 0; i < n; i++) {
      const uint32_t k = static_cast<uint32_t>(tail_ + i) & mask_;
      fifoL_[k] = l ? l[i] : 0.0f;
      fifoR_[k] = r ? r[i] : 0.0f;
    }
    tail_ += n;
  }

  /**
   * Render `frames` output frames into outL/outR through `sink`, consuming the same
   * number of input frames. outL/outR must hold `frames` floats. The output is zeroed
   * before each sink call, so a sink that writes nothing yields silence.
   */
  void render(RenderSink* sink, float* outL, float* outR, uint32_t frames) {
    uint32_t done = 0;
    bool starved = false;
    while (done < frames) {
      const uint32_t n = std::min(block_, frames - done);
      const uint32_t have = std::min(n, fill());
      for (uint32_t i = 0; i < have; i++) {
        const uint32_t k = static_cast<uint32_t>(head_ + i) & mask_;
        inL_[i] = fifoL_[k];
        inR_[i] = fifoR_[k];
      }
      head_ += have;
      if (have < n) {
        std::fill(inL_.begin() + have, inL_.begin() + n, 0.0f);
        std::fill(inR_.begin() + have, inR_.begin() + n, 0.0f);
        if (started_) {
          c_.underflowFrames += n - have;
          c_.underflowEvents++;
        }
        starved = true;
      }
      if (!started_) c_.warmupFrames += n;
      std::fill(outL + done, outL + done + n, 0.0f);
      std::fill(outR + done, outR + done + n, 0.0f);
      const float* in[2] = {inL_.data(), inR_.data()};
      float* out[2] = {outL + done, outR + done};
      if (sink) sink->render(in, 2, out, 2, n);
      done += n;
      c_.engineBlocks++;
    }
    c_.renderedFrames += frames;
    if ((starved || !started_) && fill() < target_) {
      const uint32_t add = target_ - fill();
      for (uint32_t i = 0; i < add; i++) {
        const uint32_t k = static_cast<uint32_t>(tail_ + i) & mask_;
        fifoL_[k] = 0.0f;
        fifoR_[k] = 0.0f;
      }
      tail_ += add;
      if (started_) c_.reprimeFrames += add;
    }
    if (fill() > target_ + slack_) {
      const uint32_t drop = fill() - target_;
      head_ += drop;
      c_.trimFrames += drop;
      c_.trimEvents++;
    }
  }

 private:
  std::vector<float> fifoL_, fifoR_, inL_, inR_;
  uint64_t head_ = 0, tail_ = 0;  // absolute counters; only the index wraps
  uint32_t mask_ = 0, block_ = 0, target_ = 0, slack_ = 0;
  bool started_ = false;
  DuplexCounters c_{};
};

}  // namespace brokodr

#endif  // BROKODR_DUPLEX_H
