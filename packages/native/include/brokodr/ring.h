// Bro.Kodr — the lock-free control ring, native side.
//
// PHASE 5a. This is the seam between the UI thread (which may allocate, block, and be
// descheduled at will) and the audio thread (which may do none of those things). It is a
// straight port of the ring already running in the browser build, kept deliberately
// identical in semantics so the two backends behave the same under load:
//
//   * Single producer, single consumer. One writer thread, one reader thread, no locks,
//     no CAS loops — just two monotonically increasing counters and release/acquire
//     ordering between them.
//   * Counters are ABSOLUTE and never wrapped; only the slot index wraps. Wrapping the
//     counters is the classic way to make "full" and "empty" indistinguishable.
//   * The writer DROPS when full rather than blocking or overwriting. Losing one
//     intermediate knob position is invisible. Blocking the UI is not, and overwriting an
//     unread slot would let a stale value win over a fresh one.
//   * The reader drains to the write index captured ONCE at entry, so a burst of writes
//     during a drain cannot extend that drain unboundedly inside one audio callback.
//
// The memory ordering is the load-bearing part and the reason this is a header with
// comments rather than three obvious lines: on x86 the naive version usually works by
// accident, and then fails on ARM (which Electron now ships on). Atomics here are not
// decoration.

#ifndef BROKODR_RING_H
#define BROKODR_RING_H

#include <atomic>
#include <cstdint>

#include "brokodr/layout.h"

namespace brokodr {

/** One decoded command. Field names match the JS `#applyOp(op, id, key, value, aux1, aux2)`. */
struct Command {
  double op;
  double id;
  double key;
  double value;
  double aux1;
  double aux2;
};

/**
 * SPSC command ring with the same slot count and stride as the JS SharedArrayBuffer ring.
 *
 * Layout note: `data` is a flat array of doubles indexed `(seq % slots) * stride + field`,
 * byte-for-byte what the JS `Float64Array` view produces. That is what lets a future
 * build hand this exact memory to a worklet, or a worklet's SAB to this class, without a
 * translation layer.
 */
class CommandRing {
 public:
  static constexpr uint32_t kSlots = BK_CMD_SLOTS;
  static constexpr uint32_t kStride = BK_CMD_STRIDE;

  CommandRing() : write_(0), read_(0) {
    for (uint32_t i = 0; i < kSlots * kStride; i++) data_[i] = 0.0;
  }

  /**
   * Producer side. Returns false if the ring is full and the command was dropped.
   *
   * `relaxed` on the write counter is safe because only this thread writes it. The
   * `acquire` on the read counter pairs with the consumer's `release` so we observe slots
   * it has actually finished with. The final `release` publishes the slot payload: it
   * guarantees the six doubles are visible BEFORE the incremented index that advertises
   * them, which is the entire correctness argument.
   */
  bool push(double op, double id, double key, double value, double aux1 = 0.0, double aux2 = 0.0) {
    const uint64_t w = write_.load(std::memory_order_relaxed);
    const uint64_t r = read_.load(std::memory_order_acquire);
    if (w - r >= kSlots) {
      dropped_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    double* slot = &data_[(w % kSlots) * kStride];
    slot[0] = op;
    slot[1] = id;
    slot[2] = key;
    slot[3] = value;
    slot[4] = aux1;
    slot[5] = aux2;
    write_.store(w + 1, std::memory_order_release);
    return true;
  }

  bool push(const Command& c) { return push(c.op, c.id, c.key, c.value, c.aux1, c.aux2); }

  /**
   * Consumer side. Pops one command, or returns false when empty.
   *
   * The `acquire` load of the write counter pairs with the producer's `release` store, so
   * the payload we then read is guaranteed to be the published one and not a torn
   * half-written slot.
   */
  bool pop(Command& out) {
    const uint64_t r = read_.load(std::memory_order_relaxed);
    const uint64_t w = write_.load(std::memory_order_acquire);
    if (r == w) return false;
    const double* slot = &data_[(r % kSlots) * kStride];
    out.op = slot[0];
    out.id = slot[1];
    out.key = slot[2];
    out.value = slot[3];
    out.aux1 = slot[4];
    out.aux2 = slot[5];
    read_.store(r + 1, std::memory_order_release);
    return true;
  }

  /**
   * Drain everything published as of NOW, and no more.
   *
   * Snapshotting the write index up front bounds the work in one audio callback: a UI
   * spraying automation cannot keep a drain alive past the frames it was budgeted, which
   * is how a "harmless" control burst turns into an underrun.
   */
  template <typename Fn>
  uint32_t drain(Fn&& apply) {
    const uint64_t w = write_.load(std::memory_order_acquire);
    uint64_t r = read_.load(std::memory_order_relaxed);
    uint32_t n = 0;
    Command c{};
    while (r != w) {
      const double* slot = &data_[(r % kSlots) * kStride];
      c.op = slot[0];
      c.id = slot[1];
      c.key = slot[2];
      c.value = slot[3];
      c.aux1 = slot[4];
      c.aux2 = slot[5];
      apply(c);
      r++;
      n++;
    }
    read_.store(r, std::memory_order_release);
    return n;
  }

  /** Published-but-unread commands. Diagnostic only; never gate audio work on it. */
  uint32_t pending() const {
    const uint64_t w = write_.load(std::memory_order_acquire);
    const uint64_t r = read_.load(std::memory_order_acquire);
    return static_cast<uint32_t>(w - r);
  }

  /** Commands the producer had to throw away. Surfaced in the device panel, not hidden. */
  uint64_t dropped() const { return dropped_.load(std::memory_order_relaxed); }

  uint64_t writeIndex() const { return write_.load(std::memory_order_acquire); }
  uint64_t readIndex() const { return read_.load(std::memory_order_acquire); }

  /** Raw slot storage, for handing to shared memory or asserting layout in tests. */
  double* data() { return data_; }
  const double* data() const { return data_; }
  static constexpr uint32_t dataLength() { return kSlots * kStride; }

 private:
  // Counters on their own cache lines. Without the padding the producer's store to
  // `write_` invalidates the line holding `read_` on every push, and the consumer pays a
  // coherence miss per command — false sharing, and it lands precisely on the thread that
  // cannot afford stalls.
  alignas(64) std::atomic<uint64_t> write_;
  alignas(64) std::atomic<uint64_t> read_;
  alignas(64) std::atomic<uint64_t> dropped_{0};
  alignas(64) double data_[kSlots * kStride];
};

static_assert(sizeof(double) == 8, "The ring's wire format is Float64; this target disagrees.");

}  // namespace brokodr

#endif  // BROKODR_RING_H
