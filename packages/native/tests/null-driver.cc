// Bro.Kodr — the null-driver run of the composed native engine (Phase 5a).
//
// The parity battery (parity-engine.c) drives bk_engine_* directly. This drives it the way a
// host will: the engine is a brokodr::RenderSink behind the Device seam, the offline driver
// owns the block loop (including the short final block), and control arrives between blocks
// from a host-side schedule. Everything the render callback touches is built before open():
// the engine and its ~58 MB of storage, every effect the schedule will add, every pad
// sample. That is the real-time contract in device.h, and it is checked, not assumed:
// malloc/calloc/realloc/free are counted while render() runs, and must stay at zero.
//
//   null-driver <in.wav> <out.wav> <schedule.txt> <blockFrames> <meters.bin>
//
// schedule.txt: one command per line, `frame verb a b c d e`. A command applies before the
// first block whose start frame is >= `frame`, in file order. verify-null-driver.mjs writes
// the schedule and the input, runs this, and replays the same schedule through the JS
// Engine.applyCommand in the same block partition; this program checks the two things only
// the native side can see:
//   1. no allocation inside render();
//   2. the driver path is transparent: a second engine fed the same schedule by direct
//      bk_engine_process calls on the same partition produces the same float32 samples
//      as the WAV the driver wrote.
// meters.bin is the engine's readMeters block after the last render, as raw doubles.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "brokodr/device.h"
#include "brokodr/dsp/engine.h"
#include "brokodr/wav.h"

// ------------------------------------------------------------------ allocation counter

#if defined(__GLIBC__) && !defined(__SANITIZE_ADDRESS__) && !defined(__SANITIZE_THREAD__)
#define BK_COUNT_ALLOC 1
extern "C" void* __libc_malloc(size_t);
extern "C" void* __libc_calloc(size_t, size_t);
extern "C" void* __libc_realloc(void*, size_t);
extern "C" void __libc_free(void*);
static volatile int g_in_render = 0;
static volatile unsigned long g_render_allocs = 0;
extern "C" void* malloc(size_t n) {
  if (g_in_render) g_render_allocs = g_render_allocs + 1;
  return __libc_malloc(n);
}
extern "C" void* calloc(size_t a, size_t b) {
  if (g_in_render) g_render_allocs = g_render_allocs + 1;
  return __libc_calloc(a, b);
}
extern "C" void* realloc(void* p, size_t n) {
  if (g_in_render) g_render_allocs = g_render_allocs + 1;
  return __libc_realloc(p, n);
}
extern "C" void free(void* p) {
  if (g_in_render && p) g_render_allocs = g_render_allocs + 1;
  __libc_free(p);
}
#else
#define BK_COUNT_ALLOC 0
static volatile int g_in_render = 0;
static volatile unsigned long g_render_allocs = 0;
#endif

static int g_fails = 0;
static void check(bool cond, const char* name, const std::string& detail = "") {
  if (cond) {
    std::printf("  ok   %s\n", name);
  } else {
    g_fails++;
    std::printf("  FAIL %s%s%s\n", name, detail.empty() ? "" : " — ", detail.c_str());
  }
}

// ------------------------------------------------------------------ schedule

enum Verb {
  V_ADD = 0,       // target index type id at(-1 = append)
  V_FXPARAM = 1,   // target index id key value
  V_MIX = 2,       // target index id value
  V_BYPASS = 3,    // target index id value
  V_IO = 4,        // field value
  V_PADLOAD = 5,   // index layer frames rate  (data: the input's left channel from frame 0)
  V_PAD = 6,       // index vel
  V_PADPARAM = 7,  // index key value
  V_DRUM = 8,      // key value
  V_CLOCK = 9,     // key value
  V_LOOP = 10,     // op index
  V_LOOPPARAM = 11,  // index key value
  V_VOICE = 12,    // key value
  V_PADOFF = 13,   // index
  V_COUNT
};

struct Cmd {
  double frame;
  int verb;
  double a, b, c, d, e;
};

static bool readSchedule(const char* path, std::vector<Cmd>& out) {
  FILE* f = std::fopen(path, "r");
  if (!f) return false;
  Cmd c{};
  while (std::fscanf(f, "%lf %d %lf %lf %lf %lf %lf", &c.frame, &c.verb, &c.a, &c.b, &c.c, &c.d, &c.e) == 7) {
    if (c.verb < 0 || c.verb >= V_COUNT) {
      std::fclose(f);
      return false;
    }
    out.push_back(c);
  }
  std::fclose(f);
  return true;
}

// The battery's random source: xorshift32 over one seed shared by every effect, mirrored
// by the verifier's Math.random replacement.
static const unsigned int kSeed = 0x2545f491u;
static double xorshiftRandom(void* user) {
  unsigned int* seed = static_cast<unsigned int*>(user);
  unsigned int x = *seed;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  *seed = x;
  return static_cast<double>(x) / 4294967296.0;
}

// ------------------------------------------------------------------ the engine host

// Owns one engine and everything its schedule will hand it. Construction allocates;
// apply() and process() never do.
class EngineHost {
 public:
  EngineHost(double sr, int maxBlock, const std::vector<Cmd>& sched, const float* padData)
      : sched_(sched), padData_(padData) {
    storage_ = static_cast<float*>(std::calloc(bk_engine_storage_floats(sr, maxBlock), sizeof(float)));
    ok_ = storage_ && bk_engine_init(&e_, sr, maxBlock, storage_) == 0;
    fx_.resize(sched.size());
    for (size_t i = 0; ok_ && i < sched.size(); i++) {
      if (sched[i].verb != V_ADD) continue;
      const int type = static_cast<int>(sched[i].c);
      Fx& fx = fx_[i];
      const size_t n = bk_effect_size(type);
      const size_t nf = bk_effect_storage_floats(type, sr, maxBlock);
      fx.mem = n ? std::calloc(1, n) : nullptr;
      fx.st = nf ? static_cast<float*>(std::calloc(nf, sizeof(float))) : nullptr;
      fx.vt = fx.mem ? bk_effect_create(type, fx.mem, fx.st, sr, maxBlock) : nullptr;
      if (!fx.vt) ok_ = false;
      else bk_effect_set_random(type, fx.mem, xorshiftRandom, &seed_);
    }
  }
  ~EngineHost() {
    for (Fx& fx : fx_) {
      std::free(fx.mem);
      std::free(fx.st);
    }
    std::free(storage_);
  }
  EngineHost(const EngineHost&) = delete;
  EngineHost& operator=(const EngineHost&) = delete;

  bool ok() const { return ok_; }
  bk_engine* engine() { return &e_; }

  /** Apply every scheduled command due at or before `frame`. */
  void applyDue(double frame) {
    while (next_ < sched_.size() && sched_[next_].frame <= frame) apply(next_++);
  }

  void process(const float* inL, const float* inR, float* outL, float* outR, uint32_t n, double startFrame) {
    applyDue(startFrame);
    bk_engine_process(&e_, inL, inR, outL, outR, static_cast<int>(n));
  }

 private:
  struct Fx {
    void* mem = nullptr;
    float* st = nullptr;
    const bk_effect_vt* vt = nullptr;
  };

  void apply(size_t i) {
    const Cmd& c = sched_[i];
    bk_engine* e = &e_;
    switch (c.verb) {
      case V_ADD: {
        const int target = static_cast<int>(c.a);
        bk_slot_spec spec;
        spec.id = static_cast<int>(c.d);
        spec.type = static_cast<int>(c.c);
        // Master: cmd.index is the position. padfx / loopfx: cmd.index (the pad / track)
        // is also the position (engine.h, "padfx / loopfx add").
        spec.index = target == BK_TARGET_MASTER ? (c.e < 0 ? BK_CHAIN_APPEND : static_cast<int>(c.e))
                                                : static_cast<int>(c.b);
        spec.mix = NAN;
        spec.bypassed = BK_CHAIN_KEEP;
        spec.effect = fx_[i].mem;
        spec.vt = fx_[i].vt;
        bk_engine_fx_add(e, target, c.b, &spec);
        break;
      }
      case V_FXPARAM:
        bk_engine_fx_param(e, static_cast<int>(c.a), c.b, static_cast<int>(c.c), static_cast<int>(c.d), c.e);
        break;
      case V_MIX: bk_engine_fx_mix(e, static_cast<int>(c.a), c.b, static_cast<int>(c.c), c.d); break;
      case V_BYPASS: bk_engine_fx_bypass(e, static_cast<int>(c.a), c.b, static_cast<int>(c.c), c.d); break;
      case V_IO: bk_engine_io(e, static_cast<int>(c.a), c.b); break;
      case V_PADLOAD: bk_engine_pad_load(e, c.a, c.b, padData_, static_cast<int>(c.c), c.d); break;
      case V_PAD: bk_engine_pad(e, c.a, c.b); break;
      case V_PADPARAM: bk_engine_pad_param(e, c.a, static_cast<int>(c.b), c.c); break;
      case V_DRUM: bk_engine_drum(e, static_cast<int>(c.a), c.b); break;
      case V_CLOCK: bk_engine_clock(e, static_cast<int>(c.a), c.b); break;
      case V_LOOP: bk_engine_loop(e, static_cast<int>(c.a), c.b); break;
      case V_LOOPPARAM: bk_engine_loop_param(e, c.a, static_cast<int>(c.b), c.c); break;
      case V_VOICE: bk_engine_voice(e, static_cast<int>(c.a), c.b); break;
      case V_PADOFF: bk_engine_pad_off(e, c.a); break;
      default: break;
    }
  }

  bk_engine e_{};
  float* storage_ = nullptr;
  bool ok_ = false;
  unsigned int seed_ = kSeed;
  const std::vector<Cmd>& sched_;
  const float* padData_;
  std::vector<Fx> fx_;
  size_t next_ = 0;
};

class EngineSink final : public brokodr::RenderSink {
 public:
  explicit EngineSink(EngineHost& h) : h_(h) {}
  void render(const float* const* in, uint32_t inChannels, float* const* out, uint32_t outChannels,
              uint32_t frames) override {
    g_in_render = 1;
    if (inChannels >= 2 && outChannels >= 2) {
      h_.process(in[0], in[1], out[0], out[1], frames, pos_);
    }
    pos_ += frames;
    blocks_++;
    if (frames < minBlock_) minBlock_ = frames;
    g_in_render = 0;
  }
  double pos_ = 0.0;
  uint64_t blocks_ = 0;
  uint32_t minBlock_ = 0xffffffffu;

 private:
  EngineHost& h_;
};

int main(int argc, char** argv) {
  if (argc < 6) {
    std::fprintf(stderr, "usage: %s <in.wav> <out.wav> <schedule.txt> <blockFrames> <meters.bin>\n", argv[0]);
    return 2;
  }
  const std::string inPath = argv[1], outPath = argv[2];
  const int block = std::atoi(argv[4]);
  std::string err;

  brokodr::AudioBuffer input;
  if (!brokodr::readWav(inPath, input, err) || !input.stereo()) {
    std::fprintf(stderr, "input: %s\n", err.empty() ? "not stereo" : err.c_str());
    return 1;
  }
  std::vector<Cmd> sched;
  if (!readSchedule(argv[3], sched) || sched.empty()) {
    std::fprintf(stderr, "bad schedule %s\n", argv[3]);
    return 1;
  }
  const double sr = static_cast<double>(input.sampleRate);
  const size_t frames = input.frames();
  std::printf("null driver: %zu frames, block %d, %zu commands, allocation counter %s\n", frames, block,
              sched.size(), BK_COUNT_ALLOC ? "on" : "off (sanitizer build)");

#if BK_COUNT_ALLOC
  {
    // The counter must see what it is there to see: one malloc and one free, flagged.
    g_in_render = 1;
    void* volatile probe = std::malloc(16);
    std::free(probe);
    g_in_render = 0;
    check(g_render_allocs == 2, "allocation counter sees a flagged malloc + free",
          std::to_string(g_render_allocs) + " counted");
    g_render_allocs = 0;
  }
#endif

  // ---- 1. through the Device seam
  EngineHost host(sr, block, sched, input.left.data());
  check(host.ok(), "engine, storage and every scheduled effect built before open()");
  if (!host.ok()) return 1;
  EngineSink sink(host);
  brokodr::Device* dev = brokodr::makeOfflineDriver(inPath, outPath, 0);
  brokodr::StreamConfig cfg;
  cfg.sampleRate = input.sampleRate;
  cfg.blockFrames = static_cast<uint32_t>(block);
  cfg.kind = brokodr::DriverKind::Offline;
  const bool opened = dev->open(cfg, &sink, err);
  check(opened, "offline driver ran the engine to completion", err);
  delete dev;
  if (!opened) return 1;
  const uint64_t expectBlocks = (frames + static_cast<size_t>(block) - 1) / static_cast<size_t>(block);
  check(sink.blocks_ == expectBlocks, "one render per block", std::to_string(sink.blocks_) + " renders");
  const uint32_t tail = static_cast<uint32_t>(frames % static_cast<size_t>(block));
  check(tail == 0 || sink.minBlock_ == tail, "the short final block reached the engine as-is",
        "min block " + std::to_string(sink.minBlock_));
#if BK_COUNT_ALLOC
  check(g_render_allocs == 0, "no malloc/calloc/realloc/free inside render()",
        std::to_string(g_render_allocs) + " calls");
#endif

  {
    std::vector<double> meters(BK_ENGINE_METER_COUNT, 0.0);
    bk_engine_read_meters(host.engine(), meters.data());
    FILE* f = std::fopen(argv[5], "wb");
    const bool wrote = f && std::fwrite(meters.data(), sizeof(double), meters.size(), f) == meters.size();
    if (f) std::fclose(f);
    check(wrote, "final meter block written");
  }

  // ---- 2. the same schedule by direct calls, compared with the WAV the driver wrote
  brokodr::AudioBuffer written;
  check(brokodr::readWav(outPath, written, err) && written.frames() == frames, "driver output reads back", err);
  {
    EngineHost direct(sr, block, sched, input.left.data());
    std::vector<float> oL(static_cast<size_t>(block)), oR(static_cast<size_t>(block));
    size_t diffs = 0, finite = 0, bounded = 0;
    for (size_t pos = 0; pos < frames; pos += static_cast<size_t>(block)) {
      const size_t n = std::min(static_cast<size_t>(block), frames - pos);
      direct.process(input.left.data() + pos, input.right.data() + pos, oL.data(), oR.data(),
                     static_cast<uint32_t>(n), static_cast<double>(pos));
      for (size_t j = 0; j < n; j++) {
        const float a[2] = {oL[j], oR[j]};
        const float b[2] = {written.left[pos + j], written.right[pos + j]};
        for (int ch = 0; ch < 2; ch++) {
          uint32_t ua, ub;
          std::memcpy(&ua, &a[ch], 4);
          std::memcpy(&ub, &b[ch], 4);
          if (ua != ub) diffs++;
          if (std::isfinite(b[ch])) finite++;
          if (std::fabs(b[ch]) <= 1.4f) bounded++;
        }
      }
    }
    check(diffs == 0, "driver path bit-identical to direct bk_engine_process calls",
          std::to_string(diffs) + " samples differ");
    check(finite == 2 * frames && bounded == 2 * frames, "every output sample finite and within +-1.4");
  }

  std::printf(g_fails == 0 ? "null driver: PASS\n" : "null driver: %d FAILED\n", g_fails);
  return g_fails == 0 ? 0 : 1;
}
