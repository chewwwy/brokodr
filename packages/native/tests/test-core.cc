// Bro.Kodr — native core tests (Phase 5a).
//
// Covers the three things that must be right before any DSP is ported: the command ring's
// SPSC behaviour under genuine thread contention, the layout contract, and the offline
// device driver's block handling.
//
// The ring test runs two real threads rather than interleaving calls on one, because a
// single-threaded test of a lock-free structure proves nothing about the memory ordering
// that makes it lock-free. Built with -fsanitize=thread in `verify-native-core.mjs`, so a
// missing acquire/release is a hard failure rather than a coin flip.

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "brokodr/device.h"
#include "brokodr/layout.h"
#include "brokodr/ring.h"
#include "brokodr/wav.h"

static int g_fails = 0;
static int g_checks = 0;

static void check(bool cond, const char* name, const std::string& detail = "") {
  g_checks++;
  if (cond) {
    std::printf("  ok   %s\n", name);
  } else {
    g_fails++;
    std::printf("  FAIL %s%s%s\n", name, detail.empty() ? "" : " — ", detail.c_str());
  }
}

// ------------------------------------------------------------------ layout contract

static void testLayout() {
  std::printf("layout contract\n");
  check(BK_CMD_STRIDE == 6, "command stride is 6");
  check(BK_CMD_SLOTS == 1024, "command ring holds 1024 slots");
  check(BK_LOOP_METER_BASE == 68, "loop meters start at 68");
  check(BK_TRANSPORT_METER_BASE == 100, "transport meters start at 100",
        "got " + std::to_string(BK_TRANSPORT_METER_BASE));
  check(BK_VOICE_METER_BASE == 108, "voice meters start at 108", "got " + std::to_string(BK_VOICE_METER_BASE));
  check(BK_METER_USED == 127, "meter block ends at 127", "got " + std::to_string(BK_METER_USED));
  // The append-only rule, mechanically: a new block must fit without moving anything.
  check(BK_METER_USED <= BK_METER_FIELDS, "used meters fit the shared block");
  check(BK_METER_FIELDS - BK_METER_USED >= 16, "room left to append a block without a layout break",
        std::to_string(BK_METER_FIELDS - BK_METER_USED) + " free");
  // Masked ring: a non-power-of-two silently corrupts the scope on wrap.
  check((BK_SCOPE_SIZE & (BK_SCOPE_SIZE - 1)) == 0, "scope ring is a power of two");
  check(BK_SCOPE_WINDOW < BK_SCOPE_SIZE, "scope window fits inside the ring");
}

// ------------------------------------------------------------------ ring, single thread

static void testRingBasics() {
  std::printf("\ncommand ring — semantics\n");
  brokodr::CommandRing ring;
  brokodr::Command c{};

  check(!ring.pop(c), "empty ring pops nothing");
  check(ring.pending() == 0, "empty ring reports 0 pending");

  check(ring.push(BK_OP_PARAM, 3, 7, 0.25, 1, 2), "push accepted");
  check(ring.pending() == 1, "one pending after one push");
  check(ring.pop(c), "pop succeeds");
  check(c.op == BK_OP_PARAM && c.id == 3 && c.key == 7 && c.value == 0.25 && c.aux1 == 1 && c.aux2 == 2,
        "all six fields survive the round trip");
  check(!ring.pop(c), "ring is empty again");

  // Doubles, not floats: `value` carries raw units and f32 would round a 19200 Hz cutoff.
  const double precise = 19200.000000123;
  ring.push(BK_OP_PARAM, 1, 1, precise);
  ring.pop(c);
  check(c.value == precise, "value keeps full double precision");

  // Fill exactly, then one more must be dropped rather than overwrite an unread slot.
  brokodr::CommandRing full;
  for (uint32_t i = 0; i < brokodr::CommandRing::kSlots; i++) {
    if (!full.push(BK_OP_MIX, i, 0, static_cast<double>(i))) {
      check(false, "ring accepted fewer than kSlots commands", "stopped at " + std::to_string(i));
      return;
    }
  }
  check(full.pending() == brokodr::CommandRing::kSlots, "ring holds exactly kSlots");
  check(!full.push(BK_OP_MIX, 9999, 0, 0), "push past full is refused");
  check(full.dropped() == 1, "the drop is counted, not hidden");
  // The refused push must not have clobbered slot 0.
  full.pop(c);
  check(c.id == 0 && c.value == 0.0, "oldest unread command is intact after a refused push");

  // Draining frees capacity again — i.e. the counters are absolute and don't wrap.
  uint32_t drained = full.drain([](const brokodr::Command&) {});
  check(drained == brokodr::CommandRing::kSlots - 1, "drain returns the remaining count",
        "got " + std::to_string(drained));
  check(full.push(BK_OP_MIX, 1, 0, 0), "ring accepts again after draining");
}

static void testRingDrainIsBounded() {
  std::printf("\ncommand ring — bounded drain\n");
  brokodr::CommandRing ring;
  for (int i = 0; i < 10; i++) ring.push(BK_OP_PARAM, i, 0, 0);

  // A drain must not extend itself with commands pushed DURING the drain, or one control
  // burst can hold an audio callback past its deadline.
  int seen = 0;
  ring.drain([&](const brokodr::Command&) {
    seen++;
    if (seen < 3) ring.push(BK_OP_PARAM, 99, 0, 0);  // producer racing the consumer
  });
  check(seen == 10, "drain stops at the write index captured on entry", "saw " + std::to_string(seen));
  check(ring.pending() == 2, "commands pushed mid-drain wait for the next one",
        std::to_string(ring.pending()) + " pending");
}

// ------------------------------------------------------------------ ring, two threads

static void testRingConcurrent() {
  std::printf("\ncommand ring — two real threads\n");
  brokodr::CommandRing ring;
  const uint64_t target = 200000;

  std::atomic<bool> orderOk{true};
  std::atomic<bool> payloadOk{true};
  std::atomic<uint64_t> received{0};

  // Consumer: every command must arrive in order, exactly once, with a payload that
  // matches its sequence number. A torn slot or a missing release shows up as a payload
  // mismatch, which is the failure a single-threaded test can never produce.
  std::thread consumer([&] {
    uint64_t expect = 0;
    brokodr::Command c{};
    while (expect < target) {
      if (ring.pop(c)) {
        if (c.id != static_cast<double>(expect)) orderOk = false;
        if (c.value != static_cast<double>(expect) * 0.5 || c.aux1 != static_cast<double>(expect % 7)) {
          payloadOk = false;
        }
        expect++;
        received++;
      } else {
        std::this_thread::yield();
      }
    }
  });

  std::thread producer([&] {
    uint64_t sent = 0;
    while (sent < target) {
      // Retry on full rather than dropping, so the test can assert exact delivery of a
      // known sequence. Real UI code drops; that path is covered above.
      if (ring.push(BK_OP_PARAM, static_cast<double>(sent), 0, static_cast<double>(sent) * 0.5,
                    static_cast<double>(sent % 7))) {
        sent++;
      } else {
        std::this_thread::yield();
      }
    }
  });

  producer.join();
  consumer.join();

  check(received == target, "every command crossed the thread boundary",
        std::to_string(received.load()) + "/" + std::to_string(target));
  check(orderOk.load(), "commands arrived strictly in order");
  check(payloadOk.load(), "no slot was read torn or half-published");
  check(ring.pending() == 0, "ring drains to empty");
}

// ------------------------------------------------------------------ WAV round trip

static void testWav() {
  std::printf("\nWAV round trip\n");
  const std::string path = "/tmp/brokodr-wav-test.wav";
  brokodr::AudioBuffer a;
  a.sampleRate = 48000;
  a.resize(1000, true);
  for (size_t i = 0; i < 1000; i++) {
    a.left[i] = std::sin(static_cast<float>(i) * 0.05f);
    a.right[i] = -std::sin(static_cast<float>(i) * 0.05f);  // inverted: catches a channel swap
  }

  std::string err;
  check(brokodr::writeWav(path, a, err), "write float WAV", err);

  brokodr::AudioBuffer b;
  check(brokodr::readWav(path, b, err), "read it back", err);
  check(b.frames() == 1000, "frame count preserved", std::to_string(b.frames()));
  check(b.sampleRate == 48000, "sample rate preserved");

  bool exact = true;
  for (size_t i = 0; i < 1000; i++) {
    if (b.left[i] != a.left[i] || b.right[i] != a.right[i]) exact = false;
  }
  // Bit-exact, not approximate: parity tests diff samples, so a lossy round trip here
  // would put a noise floor under every future comparison.
  check(exact, "float round trip is bit-exact");
  check(b.right[3] == -b.left[3], "channels did not get swapped");

  brokodr::AudioBuffer junk;
  check(!brokodr::readWav("/tmp/brokodr-does-not-exist.wav", junk, err), "missing file fails cleanly");
  std::remove(path.c_str());
}

// ------------------------------------------------------------------ offline driver

namespace {
/** Unity-gain passthrough that also counts the blocks and sizes it was handed. */
class PassThrough final : public brokodr::RenderSink {
 public:
  void render(const float* const* in, uint32_t inCh, float* const* out, uint32_t outCh, uint32_t frames) override {
    blocks++;
    totalFrames += frames;
    if (frames > maxFrames) maxFrames = frames;
    if (inCh < 2 || outCh < 2) badChannels = true;
    for (uint32_t c = 0; c < 2; c++) {
      for (uint32_t i = 0; i < frames; i++) out[c][i] = in[c][i] * 0.5f;
    }
  }
  uint64_t blocks = 0;
  uint64_t totalFrames = 0;
  uint32_t maxFrames = 0;
  bool badChannels = false;
};

/** Writes nothing at all — proves the driver zeroes its scratch between blocks. */
class SilentSink final : public brokodr::RenderSink {
 public:
  void render(const float* const*, uint32_t, float* const*, uint32_t, uint32_t) override {}
};
}  // namespace

static void testOfflineDriver() {
  std::printf("\noffline device driver\n");
  const std::string inPath = "/tmp/brokodr-drv-in.wav";
  const std::string outPath = "/tmp/brokodr-drv-out.wav";

  // 1000 frames at a 128 block: 7 full blocks plus a 104-frame tail, so the short final
  // block is exercised rather than assumed away.
  brokodr::AudioBuffer in;
  in.sampleRate = 48000;
  in.resize(1000, true);
  for (size_t i = 0; i < 1000; i++) {
    in.left[i] = 0.8f;
    in.right[i] = 0.4f;
  }
  std::string err;
  brokodr::writeWav(inPath, in, err);

  brokodr::StreamConfig cfg;
  cfg.blockFrames = BK_WEB_QUANTUM;
  cfg.sampleRate = 48000;
  cfg.kind = brokodr::DriverKind::Offline;

  PassThrough sink;
  brokodr::Device* dev = brokodr::makeOfflineDriver(inPath, outPath, 0);
  check(dev->enumerate().size() == 1, "offline driver enumerates one device");
  check(dev->open(cfg, &sink, err), "offline run completes", err);
  check(sink.blocks == 8, "1000 frames at 128 is 8 blocks", std::to_string(sink.blocks));
  check(sink.totalFrames == 1000, "every frame reached the sink", std::to_string(sink.totalFrames));
  check(sink.maxFrames == 128, "no block exceeded the requested size");
  check(!sink.badChannels, "sink always got 2 in / 2 out");

  brokodr::AudioBuffer out;
  check(brokodr::readWav(outPath, out, err), "output file readable", err);
  check(out.frames() == 1000, "output length matches input");
  bool gainOk = true;
  for (size_t i = 0; i < out.frames(); i++) {
    if (std::fabs(out.left[i] - 0.4f) > 1e-6f || std::fabs(out.right[i] - 0.2f) > 1e-6f) gainOk = false;
  }
  check(gainOk, "the sink's 0.5 gain landed in the file, per channel");
  delete dev;

  // A sink that writes nothing must yield silence — not a repeat of the previous block.
  SilentSink silent;
  brokodr::Device* dev2 = brokodr::makeOfflineDriver(inPath, outPath, 0);
  check(dev2->open(cfg, &silent, err), "silent run completes", err);
  brokodr::AudioBuffer out2;
  brokodr::readWav(outPath, out2, err);
  bool allZero = true;
  for (size_t i = 0; i < out2.frames(); i++) {
    if (out2.left[i] != 0.0f || out2.right[i] != 0.0f) allZero = false;
  }
  check(allZero, "driver zeroes output scratch between blocks");
  delete dev2;

  // Silence-in mode, for testing tails with no input file.
  PassThrough tailSink;
  brokodr::Device* dev3 = brokodr::makeOfflineDriver("", outPath, 512);
  check(dev3->open(cfg, &tailSink, err), "silence-driven run completes", err);
  check(tailSink.totalFrames == 512, "silent run renders the requested frames",
        std::to_string(tailSink.totalFrames));
  delete dev3;

  brokodr::Device* bad = brokodr::makeOfflineDriver("/tmp/brokodr-nope.wav", outPath, 0);
  check(!bad->open(cfg, &tailSink, err), "missing input fails with an error, not a crash");
  delete bad;

  std::remove(inPath.c_str());
  std::remove(outPath.c_str());
}

int main() {
  std::printf("Bro.Kodr native core — Phase 5a\n\n");
  testLayout();
  testRingBasics();
  testRingDrainIsBounded();
  testRingConcurrent();
  testWav();
  testOfflineDriver();
  std::printf("\n%d checks, %d failed\n", g_checks, g_fails);
  return g_fails == 0 ? 0 : 1;
}
