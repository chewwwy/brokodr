// Bro.Kodr — tests for the engine host (Phase 5b).
//
//   test-host                 the unit battery (allocation, ordering, sweep, batches, pulls,
//                             recording, chunking, the seqlock, a threaded stress run)
//   test-host replay <in.wav> <out.wav> <schedule.txt> <block> <events.txt> <rec.bin> <scope.bin>
//                             drive a Host through a schedule for verify-host.mjs, which
//                             replays the same schedule through worklet-processor.js
//
// The allocation counter is the glibc interposer from null-driver.cc: malloc, calloc,
// realloc and free are counted while render() runs, and must stay at zero. It is off
// under the sanitizers, which own those symbols.
//
// Schedule lines: `frame kind fields...`. An event applies before the first render whose
// start frame is >= `frame`, in file order.
//   0 op     o id key value aux1 aux2
//   1 call   verb target id key index a b c
//   2 add    target index type id position mix bypassed n (key value) * n
//   3 file   frames rate stereo                  (data: the input from frame 0)
//   4 pad    index layer frames rate offset      (data: the input's left from `offset`)
//   5 batch  (begin)
//   6 end    (batch end)
//   7 pull   kind target index id arg arg2
//   8 snap   (the meter block after this render)
// events.txt gets one line per answered pull (`P kind count m0 m1 m2 m3 values...`),
// per snap (`M v0 ... v191`), and per refused post (`R frame kind`), in order, then
// `S posted applied freed live dropped` at the end.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "brokodr/dsp/effect-registry.h"
#include "brokodr/dsp/eq.h"
#include "brokodr/dsp/param-keys.h"
#include "brokodr/host.h"
#include "brokodr/wav.h"

using namespace brokodr;

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
static int g_checks = 0;
static void check(bool cond, const char* name, const std::string& detail = "") {
  g_checks++;
  if (cond) {
    std::printf("  ok   %s\n", name);
  } else {
    g_fails++;
    std::printf("  FAIL %s%s%s\n", name, detail.empty() ? "" : " -- ", detail.c_str());
  }
  std::fflush(stdout);
}
static std::string num(double v) {
  char b[64];
  std::snprintf(b, sizeof b, "%.17g", v);
  return b;
}

// ------------------------------------------------------------------ helpers

static std::unique_ptr<Host> makeHost(uint32_t recordFrames = 0) {
  HostOptions o;
  o.sampleRate = 48000.0;
  o.maxBlock = 512;
  o.recordFrames = recordFrames;
  std::string err;
  auto h = Host::create(o, err);
  if (!h) std::printf("  host create failed: %s\n", err.c_str());
  return h;
}

/** Deterministic stereo stimulus: noise bursts over a tone, as verify-null-driver's. */
struct Stim {
  std::vector<float> l, r;
  explicit Stim(size_t n) : l(n), r(n) {
    uint32_t s = 0x1234567u;
    for (size_t j = 0; j < n; j++) {
      s ^= s << 13;
      s ^= s >> 17;
      s ^= s << 5;
      const double nz = s / 4294967296.0 - 0.5;
      const size_t k = j % 9600;
      const double env = k < 2400 ? (2400.0 - k) / 2400.0 : 0.0;
      const double tone = std::sin(2.0 * M_PI * 220.0 * static_cast<double>(j) / 48000.0);
      l[j] = static_cast<float>((nz * 0.9 + tone * 0.4) * env + tone * 0.05);
      r[j] = static_cast<float>((nz * 0.5 - tone * 0.3) * env - tone * 0.04);
    }
  }
};

/** Render `frames` from stimulus offset `pos` in one callback; output into ol/or at pos. */
static void renderAt(Host& h, const Stim& s, size_t pos, uint32_t frames, std::vector<float>& ol,
                     std::vector<float>& orr, bool counted = true) {
  const float* in[2] = {s.l.data() + pos, s.r.data() + pos};
  float* out[2] = {ol.data() + pos, orr.data() + pos};
  if (counted) g_in_render = 1;
  h.render(in, 2, out, 2, frames);
  if (counted) g_in_render = 0;
}

static void renderSilence(Host& h, uint32_t frames, int times = 1) {
  static std::vector<float> l(8192), r(8192);
  float* out[2] = {l.data(), r.data()};
  for (int i = 0; i < times; i++) {
    g_in_render = 1;
    h.render(nullptr, 0, out, 2, frames);
    g_in_render = 0;
  }
}

static bool addFx(Host& h, int target, double index, int type, int id, double pos = NAN, double mix = NAN,
                  int bypassed = -1) {
  return h.postFxAdd(target, index, type, id, pos, nullptr, nullptr, 0, mix, bypassed);
}

static Call call(Verb v, int target = BK_TARGET_MASTER, double index = 0, int id = 0, int key = 0, double a = 0,
                 double b = 0, double c = 0) {
  Call k;
  k.verb = v;
  k.target = target;
  k.index = index;
  k.id = id;
  k.key = key;
  k.a = a;
  k.b = b;
  k.c = c;
  return k;
}

static const bk_slot* masterSlot(Host& h, int id) { return bk_chain_find(&h.engineForTest()->chain, id); }

/** Poll a pull to completion, rendering silence between polls. Returns renders taken. */
static int finishPull(Host& h, std::vector<double>& vals, int32_t& count, double* meta, int maxRenders = 64) {
  vals.assign(Host::kPullCapacity, 0.0);
  for (int i = 1; i <= maxRenders; i++) {
    renderSilence(h, 128);
    if (h.pullPoll(vals.data(), count, meta)) return i;
  }
  return -1;
}

// ------------------------------------------------------------------ unit tests

static void testAllocationFree() {
  std::printf("\nrender() never allocates, frees or locks\n");
  auto h = makeHost();
  if (!h) return check(false, "host created");
  Stim s(48000);
  std::vector<float> ol(s.l.size()), orr(s.l.size());
  // Every effect type once on the master (22 of 24 slots), one on a pad and a loop chain.
  for (int t = 0; t < BK_FX_COUNT; t++) addFx(*h, BK_TARGET_MASTER, 0, t, 100 + t);
  addFx(*h, BK_TARGET_PAD, 2, BK_FX_SAT, 7);
  addFx(*h, BK_TARGET_LOOP, 1, BK_FX_DELAY, 8);
  h->postPadLoad(0, 0, s.l.data(), 4800, 48000);
  h->postFileLoad(s.l.data(), s.r.data(), 20000, 44100);
  h->post(call(Verb::Clock, 0, 0, 0, BK_CLOCK_P_RUN, 1));
  h->post(call(Verb::Voice, 0, 0, 0, 0, 1));
  h->post(call(Verb::RecState, 0, 0, 0, 0, 1, 0, 1));
  h->command(BK_OP_FILE, 0, BK_FILE_P_PLAY, 1);
  size_t pos = 0;
  const unsigned long before = g_render_allocs;
  for (int b = 0; b < 300 && pos + 128 <= s.l.size(); b++, pos += 128) {
    if (b % 7 == 0) h->command(BK_OP_PAD, 0, 0, 0.8);
    if (b % 5 == 0) h->command(BK_OP_PARAM, 100 + BK_FX_DELAY, BK_P_DELAY_FEEDBACK, 0.3 + 0.001 * b);
    if (b == 40) h->post(call(Verb::FxRemove, BK_TARGET_MASTER, 0, 100 + BK_FX_REVERB));
    if (b == 50) {
      h->batchBegin();
      h->post(call(Verb::FxClear));
      for (int t = 0; t < 6; t++) addFx(*h, BK_TARGET_MASTER, 0, t * 3, 200 + t);
      h->batchEnd();
    }
    if (b == 60) h->postPadLoad(0, 0, s.r.data(), 2400, 44100);
    if (b == 70) h->pullBegin(PullKind::Chain, BK_TARGET_MASTER, 0, 0, 0, 0);
    if (b == 90) h->pullBegin(PullKind::Visual, 0, 0, 200, 0, 0);
    if (b == 120) h->post(call(Verb::FileClear));
    if (b == 150) h->post(call(Verb::PadClear, 0, 2));
    if (b % 10 == 0) {
      double m[4];
      int32_t n;
      std::vector<double> v(Host::kPullCapacity);
      h->pullPoll(v.data(), n, m);
    }
    renderAt(*h, s, pos, 128, ol, orr);
    h->collect();
  }
  // A long callback the host has to chunk, and one with no input at all.
  renderSilence(*h, 1500, 4);
  const unsigned long allocs = g_render_allocs - before;
  if (BK_COUNT_ALLOC) check(allocs == 0, "zero allocations inside 304 renders with messages in flight",
                            std::to_string(allocs) + " counted");
  else std::printf("  --   allocation counter off (sanitizer build)\n");
  const HostStats st = h->stats();
  check(st.messagesApplied == st.messagesPosted, "every posted message applied",
        num(st.messagesApplied) + "/" + num(st.messagesPosted));
  double peak = 0;
  for (size_t i = 0; i < pos; i++) peak = std::max(peak, static_cast<double>(std::fabs(ol[i])));
  check(peak > 0.01 && std::isfinite(peak), "the engine produced finite, non-silent output", num(peak));
}

static void testOrdering() {
  std::printf("\ncontrol order is kept across the ring and the mailbox\n");
  auto h = makeHost();
  if (!h) return check(false, "host created");
  // An op pushed before the add it targets finds no slot (the worklet would apply it: there
  // the message lands first and the ring drains at the next block).
  h->command(BK_OP_MIX, 6, 0, 0.25);
  addFx(*h, BK_TARGET_MASTER, 0, BK_FX_DELAY, 6);
  // An op pushed after the add lands on the new slot in the same render.
  addFx(*h, BK_TARGET_MASTER, 0, BK_FX_DELAY, 5);
  h->command(BK_OP_MIX, 5, 0, 0.25);
  // Interleaved: add, op, message, op, message.
  addFx(*h, BK_TARGET_MASTER, 0, BK_FX_CHORUS, 7);
  h->command(BK_OP_MIX, 7, 0, 0.5);
  h->post(call(Verb::FxMix, BK_TARGET_MASTER, 0, 7, 0, 0.75));
  h->command(BK_OP_BYPASS, 7, 0, 1);
  h->post(call(Verb::FxBypass, BK_TARGET_MASTER, 0, 7, 0, 0));
  renderSilence(*h, 128);
  const bk_slot* s6 = masterSlot(*h, 6);
  const bk_slot* s5 = masterSlot(*h, 5);
  const bk_slot* s7 = masterSlot(*h, 7);
  check(s6 && s6->mix_target == 1.0, "an op before the add does not reach the slot", s6 ? num(s6->mix_target) : "no slot");
  check(s5 && s5->mix_target == 0.25, "an op after the add reaches it in the same render", s5 ? num(s5->mix_target) : "no slot");
  check(s7 && s7->mix_target == 0.75 && s7->bypassed == 0, "op, message, op, message apply in that order",
        s7 ? num(s7->mix_target) + " bypassed " + num(s7->bypassed) : "no slot");
  // Ring ops pushed while a batch is open land before the batch (it is posted at batchEnd).
  h->batchBegin();
  addFx(*h, BK_TARGET_MASTER, 0, BK_FX_EQ, 40);
  h->command(BK_OP_MIX, 40, 0, 0.3);
  h->batchEnd();
  renderSilence(*h, 128);
  const bk_slot* s40 = masterSlot(*h, 40);
  check(s40 && s40->mix_target == 1.0, "an op pushed inside an open batch lands before the batch");
  // The worklet's decode rules on the ring: `===` on ids and opcodes, |0 on fields.
  h->command(BK_OP_MIX, 5.5, 0, 0.1);   // no slot 5.5
  h->command(2.0000001, 5, 0, 0.1);     // not opcode 2
  h->command(BK_OP_MIX, -0.0, 0, 0.1);  // -0 === 0: no slot 0, harmless
  h->command(9, 5, 0, 0.1);             // the removed REC_STATE
  h->command(BK_OP_PARAM, 5, 99, 1);    // past the param table
  h->command(BK_OP_PARAM, 5, 1.5, 1);   // not an index
  h->command(BK_OP_PARAM, 5, BK_P_DELAY_FEEDBACK, 0.9);
  renderSilence(*h, 128);
  check(masterSlot(*h, 5)->mix_target == 0.25, "non-integral ids and opcodes are ignored, as `===` does");
  // pump() applies the queue with no device.
  h->post(call(Verb::FxRemove, BK_TARGET_MASTER, 0, 6));
  h->pump();
  check(masterSlot(*h, 6) == nullptr, "pump() applies the mailbox with no render");
}

static void testSweep() {
  std::printf("\nmark and sweep frees exactly what the engine dropped\n");
  auto h = makeHost();
  if (!h) return check(false, "host created");
  auto step = [&]() {
    renderSilence(*h, 128);
    h->collect();
    return h->stats();
  };
  std::vector<float> data(4800, 0.1f);
  for (int i = 1; i <= 3; i++) addFx(*h, BK_TARGET_MASTER, 0, BK_FX_COMP, i);
  HostStats st = step();
  check(st.liveObjects == 3 && st.objectsFreed == 0, "three adds: 3 live, 0 freed");
  h->post(call(Verb::FxRemove, BK_TARGET_MASTER, 0, 2));
  st = step();
  check(st.liveObjects == 2 && st.objectsFreed == 1, "remove: 2 live, 1 freed");
  h->post(call(Verb::FxClear));
  st = step();
  check(st.liveObjects == 0 && st.objectsFreed == 3, "clear: 0 live, 3 freed");
  for (int i = 0; i < 26; i++) addFx(*h, BK_TARGET_PAD, 3, BK_FX_GATE, 50 + i);
  st = step();
  check(st.liveObjects == BK_CHAIN_MAX_SLOTS && st.objectsFreed == 5, "26 adds on a 24-slot pad chain: the 2 rejected are freed",
        num(st.liveObjects) + " live, " + num(st.objectsFreed) + " freed");
  h->post(call(Verb::PadClear, 0, 3));
  st = step();
  check(st.liveObjects == 0 && st.objectsFreed == 29, "padclear frees the pad chain");
  h->postPadLoad(0, 0, data.data(), 4800, 48000);
  st = step();
  check(st.liveObjects == 1, "pad load: 1 live");
  h->postPadLoad(0, 0, data.data(), 2400, 48000);
  st = step();
  check(st.liveObjects == 1 && st.objectsFreed == 30, "the same layer reloaded: the old sample is freed");
  h->postPadLoad(0, 1, data.data(), 2400, 48000);
  st = step();
  check(st.liveObjects == 2, "a second layer: 2 live");
  h->postPadLoad(0, 7, data.data(), 2400, 48000);
  h->postPadLoad(99, 0, data.data(), 2400, 48000);
  st = step();
  check(st.liveObjects == 3 && st.objectsFreed == 31, "layer 7 clamps to layer 3 (kept); a load on pad 99 is refused and freed",
        num(st.liveObjects) + " live, " + num(st.objectsFreed) + " freed");
  h->post(call(Verb::PadClear, 0, 0));
  st = step();
  check(st.liveObjects == 0 && st.objectsFreed == 34, "padclear frees the layers");
  h->postFileLoad(data.data(), nullptr, 4800, 44100);
  st = step();
  check(st.liveObjects == 1, "file load: 1 live");
  h->postFileLoad(data.data(), data.data(), 4800, 44100);
  st = step();
  check(st.liveObjects == 1 && st.objectsFreed == 35, "file reload frees the previous buffer");
  h->post(call(Verb::FileClear));
  st = step();
  check(st.liveObjects == 0 && st.objectsFreed == 36, "fileclear frees it");
  addFx(*h, BK_TARGET_LOOP, 2, BK_FX_DELAY, 1);
  addFx(*h, BK_TARGET_LOOP, 9, BK_FX_DELAY, 2);  // no track 9: rejected
  addFx(*h, BK_TARGET_PAD, 16, BK_FX_DELAY, 3);  // no pad 16: rejected
  st = step();
  check(st.liveObjects == 1 && st.objectsFreed == 38, "adds to a missing chain are freed");
  h->post(call(Verb::FxRemove, BK_TARGET_LOOP, 2, 1));
  st = step();
  check(st.liveObjects == 0 && st.objectsFreed == 39, "loop-chain remove frees");
  check(!addFx(*h, BK_TARGET_MASTER, 0, 99, 1), "a bad effect type posts nothing (createEffect -> null)");
  check(!addFx(*h, BK_TARGET_MASTER, 0, -1, 1), "a negative effect type posts nothing");
  check(!h->post(call(Verb::FxAdd)), "payload verbs cannot go through post()");
  // The same effect id twice: both slots live until each is removed (the JS splices both).
  addFx(*h, BK_TARGET_MASTER, 0, BK_FX_EQ, 9);
  addFx(*h, BK_TARGET_MASTER, 0, BK_FX_EQ, 9);
  st = step();
  check(st.liveObjects == 2, "a duplicate id is a second live slot");
  h->post(call(Verb::FxRemove, BK_TARGET_MASTER, 0, 9));
  st = step();
  check(st.liveObjects == 1 && h->engineForTest()->chain.n_slots == 1, "remove takes one of them");
}

static void testBatches() {
  std::printf("\nbatches apply as one unit; the per-render message cap\n");
  auto h = makeHost();
  if (!h) return check(false, "host created");
  for (int i = 0; i < 70; i++) h->post(call(Verb::PadParam, 0, 0, 0, BK_PAD_P_GAIN, -0.1 * i));
  renderSilence(*h, 128);
  check(h->stats().messagesApplied == Host::kMsgsPerRender, "one render applies at most kMsgsPerRender messages",
        num(h->stats().messagesApplied));
  renderSilence(*h, 128);
  check(h->stats().messagesApplied == 70, "the rest apply on the next");
  h->collect();
  for (int i = 1; i <= 3; i++) addFx(*h, BK_TARGET_MASTER, 0, BK_FX_COMP, i);
  renderSilence(*h, 128);
  const uint64_t applied0 = h->stats().messagesApplied;
  h->batchBegin();
  h->post(call(Verb::FxClear));
  for (int i = 0; i < BK_CHAIN_MAX_SLOTS; i++) addFx(*h, BK_TARGET_MASTER, 0, i % BK_FX_COUNT, 300 + i);
  for (int i = 0; i < 60; i++) h->post(call(Verb::Io, 0, 0, 0, BK_IO_IN_GAIN, -0.05 * i));
  check(h->batchEnd(), "batchEnd posts");
  renderSilence(*h, 128);
  h->collect();
  check(h->engineForTest()->chain.n_slots == BK_CHAIN_MAX_SLOTS && masterSlot(*h, 300) && !masterSlot(*h, 1),
        "an 85-entry batch (clear + 24 adds + 60 io) lands in one render");
  check(h->stats().messagesApplied == applied0 + 1, "a batch counts as one message");
  check(h->stats().liveObjects == BK_CHAIN_MAX_SLOTS && h->stats().objectsFreed == 3, "the cleared slots were swept");
  check(h->batchEnd(), "an empty batch is fine");
  // Mailbox back-pressure: with nothing rendering, post until refused.
  int ok = 0;
  while (ok < 1000 && h->post(call(Verb::PadParam, 0, 0, 0, BK_PAD_P_GAIN, 0))) ok++;
  check(ok == static_cast<int>(Host::kMailbox), "the mailbox refuses past kMailbox outstanding", num(ok));
  renderSilence(*h, 128, 5);
  check(h->post(call(Verb::Panic)), "and accepts again once the audio thread hands them back");
}

static void testPulls() {
  std::printf("\npulls\n");
  auto h = makeHost();
  if (!h) return check(false, "host created");
  std::vector<double> v;
  int32_t n = 0;
  double meta[4];
  addFx(*h, BK_TARGET_MASTER, 0, BK_FX_EQ, 1);
  addFx(*h, BK_TARGET_MASTER, 0, BK_FX_PITCH, 2, NAN, NAN, 1);
  addFx(*h, BK_TARGET_MASTER, 0, BK_FX_VOCODER, 3, 0);
  addFx(*h, BK_TARGET_MASTER, 0, BK_FX_REVERB, 4);
  renderSilence(*h, 128);
  check(h->pullBegin(PullKind::Chain, BK_TARGET_MASTER, 0, 0, 0, 0), "chain pull starts");
  check(!h->pullBegin(PullKind::Chain, BK_TARGET_MASTER, 0, 0, 0, 0), "a second pull is refused while one is in flight");
  finishPull(*h, v, n, meta);
  const bool order = n == 12 && v[0] == 3 && v[1] == BK_FX_VOCODER && v[3] == 1 && v[4] == BK_FX_EQ && v[6] == 2 &&
                     v[8] == 1 && v[9] == 4;
  check(order, "chain: (id, type, bypassed) in rack order", num(n));
  check(meta[0] == bk_engine_latency_samples(h->engineForTest()), "chain: latency", num(meta[0]));
  h->pullBegin(PullKind::Visual, 0, 0, 1, 0, 0);
  finishPull(*h, v, n, meta);
  check(n == BK_EQ_CURVE_POINTS, "visual: an EQ returns its curve", num(n));
  h->pullBegin(PullKind::Visual, 0, 0, 3, 0, 0);
  finishPull(*h, v, n, meta);
  check(n > 0 && n <= 64, "visual: a vocoder returns its ladder", num(n));
  h->pullBegin(PullKind::Visual, 0, 0, 4, 0, 0);
  finishPull(*h, v, n, meta);
  check(n == -1, "visual: a reverb has none (null)");
  h->pullBegin(PullKind::Visual, 0, 0, 77, 0, 0);
  finishPull(*h, v, n, meta);
  check(n == -1, "visual: a missing slot (null)");

  // Loop peaks, scanned in slices across renders. The track is filled in place (nothing renders).
  bk_loop_track* t = bk_looper_track(&h->engineForTest()->looper, 0);
  const int frames = std::min(100000, t->max_frames);
  for (int i = 0; i < frames; i++) {
    t->buf_l[i] = static_cast<float>(std::sin(i * 0.001) * 0.8);
    t->buf_r[i] = static_cast<float>(std::cos(i * 0.0007) * 0.5);
  }
  t->frames = frames;
  t->state = 4;  // stopped: holds audio, renders nothing
  auto ref = [&](int nb, std::vector<double>& out) {
    out.assign(nb * 2, 0.0);
    for (int b = 0; b < nb; b++) {
      const int s = static_cast<int>(std::floor((b * static_cast<double>(frames)) / nb));
      const int e = std::max(s + 1, static_cast<int>(std::floor(((b + 1) * static_cast<double>(frames)) / nb)));
      double lo = 0, hi = 0;
      for (int i = s; i < e; i++) {
        const double x = (static_cast<double>(t->buf_l[i]) + static_cast<double>(t->buf_r[i])) * 0.5;
        lo = std::min(lo, x);
        hi = std::max(hi, x);
      }
      out[b * 2] = lo;
      out[b * 2 + 1] = hi;
    }
  };
  std::vector<double> want;
  for (const auto& c : std::vector<std::pair<double, int>>{{480, 480}, {0, 480}, {99999, 4096}, {-3, 1}, {7.9, 7}}) {
    h->pullBegin(PullKind::LoopPeaks, 0, 0, 0, c.first, 0);
    const int renders = finishPull(*h, v, n, meta);
    ref(c.second, want);
    bool same = n == c.second * 2;
    for (int i = 0; same && i < n; i++) same = v[i] == want[i];
    const std::string label = "loop peaks, buckets " + num(c.first) + " -> " + num(c.second);
    check(same, label.c_str(), num(n));
    if (c.second == 480) {
      check(renders > 1, "a 100k-frame scan is sliced across renders", num(renders));
    }
  }
  h->pullBegin(PullKind::LoopPeaks, 0, 2, 0, 480, 0);
  finishPull(*h, v, n, meta);
  check(n == -1, "loop peaks: an empty track is null");
  h->pullBegin(PullKind::LoopPeaks, 0, 9, 0, 480, 0);
  finishPull(*h, v, n, meta);
  check(n == -1, "loop peaks: no such track is null");
  h->pullBegin(PullKind::VoiceCaps, 0, 0, 0, 0, 0);
  finishPull(*h, v, n, meta);
  check(n == 0 && meta[1] == 0 && meta[2] == BK_VOICE_CAP_STRIDE, "voice caps: none yet");
}

static void testRecording() {
  std::printf("\nthe take ring\n");
  auto h = makeHost(1000);
  if (!h) return check(false, "host created");
  Stim s(4000);
  std::vector<float> ol(4000), orr(4000);
  h->post(call(Verb::RecState, 0, 0, 0, 0, 1, 0, 1));
  for (int b = 0; b < 25; b++) renderAt(*h, s, b * 120, 120, ol, orr);
  uint64_t from = 0, total = 0, lost = 0;
  std::vector<float> wet(8000), dry(8000);
  uint32_t got = h->readRecording(from, wet.data(), dry.data(), 4000, total, lost);
  check(total == 3000 && lost == 2000 && got == 1000 && from == 3000, "a reader 3000 frames late keeps the last 1000, loses 2000",
        num(total) + " " + num(lost) + " " + num(got) + " " + num(from));
  bool same = true, drySame = true;
  for (uint32_t i = 0; i < got; i++) {
    same = same && wet[i * 2] == ol[2000 + i] && wet[i * 2 + 1] == orr[2000 + i];
    drySame = drySame && dry[i * 2] == s.l[2000 + i] && dry[i * 2 + 1] == s.r[2000 + i];
  }
  check(same, "wet is the output, sample for sample");
  check(drySame, "dry is the input (0 dB, empty rack)");
  got = h->readRecording(from, wet.data(), dry.data(), 4000, total, lost);
  check(got == 0, "nothing new, nothing read");
  double m[BK_METER_FIELDS];
  h->readMeters(m);
  check(m[13] == 1 && m[14] == 3000, "meters 13/14: recording, frames written");
  h->post(call(Verb::RecState, 0, 0, 0, 0, 1, 1, 0));
  for (int b = 25; b < 28; b++) renderAt(*h, s, b * 120, 120, ol, orr);
  h->readRecording(from, nullptr, nullptr, 4000, total, lost);
  check(total == 3000, "paused: nothing written");
  h->post(call(Verb::RecState, 0, 0, 0, 0, 1, 0, 1));
  renderAt(*h, s, 28 * 120, 100, ol, orr);
  from = 0;
  lost = 0;
  got = h->readRecording(from, wet.data(), nullptr, 4000, total, lost);
  check(total == 100 && got == 100 && lost == 0 && wet[0] == ol[28 * 120], "reset starts the take at frame 0");
  h->post(call(Verb::RecState, 0, 0, 0, 0, 0, 0, 0));
  renderAt(*h, s, 3500, 100, ol, orr);
  h->readMeters(m);
  check(m[13] == 0 && m[14] == 100, "stopped");
}

static void testChunking() {
  std::printf("\ncallback size and channel counts\n");
  auto a = makeHost(), b = makeHost();
  if (!a || !b) return check(false, "hosts created");
  for (Host* h : {a.get(), b.get()}) {
    addFx(*h, BK_TARGET_MASTER, 0, BK_FX_CHORUS, 1);
    addFx(*h, BK_TARGET_MASTER, 0, BK_FX_DELAY, 2);
    addFx(*h, BK_TARGET_MASTER, 0, BK_FX_REVERB, 3);
  }
  Stim s(20000);
  std::vector<float> al(20000), ar(20000), bl(20000), br(20000);
  for (size_t p = 0; p + 1000 <= 20000; p += 1000) {
    renderAt(*a, s, p, 1000, al, ar);
    renderAt(*b, s, p, 512, bl, br);
    renderAt(*b, s, p + 512, 488, bl, br);
  }
  bool same = std::memcmp(al.data(), bl.data(), al.size() * 4) == 0 && std::memcmp(ar.data(), br.data(), ar.size() * 4) == 0;
  check(same, "a 1000-frame callback is the engine's 512 + 488, bit for bit");
  std::vector<float> c0(256), c1(256), c2(256, 9.f), c3(256, 9.f);
  float* out4[4] = {c0.data(), c1.data(), c2.data(), c3.data()};
  const float* in1[1] = {s.l.data()};
  a->render(in1, 1, out4, 4, 256);
  check(c2[0] == 0 && c2[255] == 0 && c3[100] == 0, "output channels past 2 are zeroed");
  float* out1[1] = {c0.data()};
  a->render(in1, 1, out1, 1, 256);
  a->render(nullptr, 0, nullptr, 0, 256);
  a->render(in1, 1, out4, 2, 0);
  check(true, "mono out, no out, zero frames: no crash");
  float sc[1024], so[1024];
  a->readScope(sc, so, 1024);
  check(std::isfinite(sc[1023]) && std::isfinite(so[1023]), "scope readable");
}

static void testSeqlock() {
  std::printf("\nseqlock: no torn meter block\n");
  auto h = makeHost();
  if (!h) return check(false, "host created");
  h->post(call(Verb::RecState, 0, 0, 0, 0, 1, 0, 1));
  renderSilence(*h, 128);  // the first snapshot is a render's, not the zeroed block
  std::atomic<bool> stop{false};
  std::thread audio([&] {
    std::vector<float> l(128), r(128);
    float* out[2] = {l.data(), r.data()};
    while (!stop.load(std::memory_order_relaxed)) h->render(nullptr, 0, out, 2, 128);
  });
  double m[BK_METER_FIELDS];
  uint64_t good = 0, torn = 0, bad = 0;
  double last = 0;
  const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(400);
  while (std::chrono::steady_clock::now() < until) {
    if (!h->readMeters(m)) {
      torn++;
      continue;
    }
    good++;
    const double w = m[14];
    if (m[13] != 1 || std::fmod(w, 128.0) != 0.0 || w < last) bad++;
    last = w;
  }
  stop = true;
  audio.join();
  check(good > 100 && bad == 0, "every snapshot is one render's (recording, frames % 128, monotonic)",
        num(good) + " good, " + num(bad) + " bad, " + num(torn) + " retried out");
}

static void testStress() {
  std::printf("\nthreaded stress: a control thread posting while the audio thread renders\n");
  auto h = makeHost();
  if (!h) return check(false, "host created");
  std::atomic<bool> stop{false};
  std::thread audio([&] {
    Stim s(48000);
    std::vector<float> l(256), r(256);
    float* out[2] = {l.data(), r.data()};
    size_t pos = 0;
    uint32_t sizes[4] = {128, 64, 256, 97};
    int k = 0;
    while (!stop.load(std::memory_order_relaxed)) {
      const uint32_t n = sizes[k++ & 3];
      if (pos + n > s.l.size()) pos = 0;
      const float* in[2] = {s.l.data() + pos, s.r.data() + pos};
      h->render(in, 2, out, 2, n);
      pos += n;
    }
  });
  uint32_t rng = 0xbeef;
  auto next = [&](uint32_t m) {
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return rng % m;
  };
  std::vector<float> data(6000, 0.05f);
  std::vector<double> vals(Host::kPullCapacity);
  std::vector<float> wet(4096), dry(4096);
  double meters[BK_METER_FIELDS];
  float sc[256], so[256];
  uint64_t from = 0, total = 0, lost = 0, pulls = 0, refused = 0;
  h->post(call(Verb::RecState, 0, 0, 0, 0, 1, 0, 1));
  const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(1200);
  int iter = 0;
  while (std::chrono::steady_clock::now() < until) {
    iter++;
    bool ok = true;
    switch (next(12)) {
      case 0: ok = addFx(*h, BK_TARGET_MASTER, 0, static_cast<int>(next(BK_FX_COUNT)), static_cast<int>(next(30))); break;
      case 1: ok = h->post(call(Verb::FxRemove, BK_TARGET_MASTER, 0, static_cast<int>(next(30)))); break;
      case 2: ok = addFx(*h, BK_TARGET_PAD, next(16), static_cast<int>(next(BK_FX_COUNT)), static_cast<int>(next(8))); break;
      case 3: ok = h->postPadLoad(next(16), next(4), data.data(), 100 + next(5000), 48000); break;
      case 4: h->command(BK_OP_PARAM, next(30), next(12), next(100) * 0.01); break;
      case 5: h->command(BK_OP_PAD, next(16), 0, 0.7); break;
      case 6: {
        h->batchBegin();
        h->post(call(Verb::FxClear));
        for (int i = 0; i < 4; i++) addFx(*h, BK_TARGET_MASTER, 0, static_cast<int>(next(BK_FX_COUNT)), i);
        ok = h->batchEnd();
        break;
      }
      case 7: ok = h->postFileLoad(data.data(), next(2) ? data.data() : nullptr, 6000, 44100); break;
      case 8: {
        int32_t n;
        double meta[4];
        if (h->pullPoll(vals.data(), n, meta)) pulls++;
        h->pullBegin(static_cast<PullKind>(1 + next(4)), BK_TARGET_MASTER, 0, static_cast<int>(next(30)), 480, 0);
        break;
      }
      case 9: h->readMeters(meters); h->readScope(sc, so, 256); break;
      case 10: h->readRecording(from, wet.data(), dry.data(), 2048, total, lost); break;
      default: ok = h->post(call(Verb::PadClear, 0, next(16))); break;
    }
    if (!ok) refused++;
    h->collect();
    if (iter % 64 == 0) std::this_thread::sleep_for(std::chrono::microseconds(200));
  }
  // Let the audio thread drain what is queued, then stop it.
  for (int i = 0; i < 200 && h->stats().messagesApplied < h->stats().messagesPosted; i++) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  stop = true;
  audio.join();
  h->pump();
  h->collect();
  const HostStats st = h->stats();
  // Count what the engine still references; the host must hold exactly those.
  bk_engine* e = h->engineForTest();
  uint64_t refs = e->chain.n_slots + (e->player.ch_l ? 1 : 0);
  for (int p = 0; p < BK_PAD_COUNT; p++) {
    refs += e->drums.pad_chains[p].n_slots;
    for (int l = 0; l < BK_DRUM_MAX_LAYERS; l++) refs += e->drums.pads[p].layers[l].data ? 1 : 0;
  }
  for (int t = 0; t < BK_LOOP_TRACKS; t++) refs += e->looper.tracks[t].chain.n_slots;
  check(st.messagesApplied == st.messagesPosted, "every accepted message applied",
        num(st.messagesApplied) + "/" + num(st.messagesPosted) + " (" + num(refused) + " refused, " + num(iter) + " ops)");
  check(st.liveObjects == refs, "live objects == what the engine references", num(st.liveObjects) + " vs " + num(refs));
  check(st.renders > 100 && pulls > 0, "the audio thread ran and pulls completed", num(st.renders) + " renders, " + num(pulls) + " pulls");
}

// ------------------------------------------------------------------ replay

struct Ev {
  double frame = 0;
  int kind = 0;
  std::vector<double> f;
};

static bool readEvents(const char* path, std::vector<Ev>& out) {
  FILE* fp = std::fopen(path, "r");
  if (!fp) return false;
  char line[16384];
  while (std::fgets(line, sizeof line, fp)) {
    char* p = line;
    char* end = nullptr;
    Ev ev;
    ev.frame = std::strtod(p, &end);
    if (end == p) continue;
    p = end;
    ev.kind = static_cast<int>(std::strtod(p, &end));
    p = end;
    for (;;) {
      const double v = std::strtod(p, &end);
      if (end == p) break;
      ev.f.push_back(v);
      p = end;
    }
    out.push_back(std::move(ev));
  }
  std::fclose(fp);
  return true;
}

static int replay(int argc, char** argv) {
  if (argc != 9) {
    std::fprintf(stderr, "usage: test-host replay in.wav out.wav schedule.txt block events.txt rec.bin scope.bin\n");
    return 2;
  }
  AudioBuffer in;
  std::string err;
  if (!readWav(argv[2], in, err)) {
    std::fprintf(stderr, "read %s: %s\n", argv[2], err.c_str());
    return 2;
  }
  std::vector<Ev> evs;
  if (!readEvents(argv[4], evs)) {
    std::fprintf(stderr, "read %s failed\n", argv[4]);
    return 2;
  }
  const uint32_t block = static_cast<uint32_t>(std::atoi(argv[5]));
  FILE* evOut = std::fopen(argv[6], "w");
  if (!evOut || block == 0) return 2;

  HostOptions o;
  o.sampleRate = in.sampleRate;
  auto h = Host::create(o, err);
  if (!h) {
    std::fprintf(stderr, "host: %s\n", err.c_str());
    return 2;
  }
  const size_t frames = in.frames();
  AudioBuffer outBuf;
  outBuf.sampleRate = in.sampleRate;
  outBuf.resize(frames, true);
  std::vector<double> vals(Host::kPullCapacity);
  double meta[4];
  bool pulling = false;
  size_t next = 0;
  const unsigned long before = g_render_allocs;

  for (size_t pos = 0; pos < frames; pos += block) {
    const uint32_t n = static_cast<uint32_t>(std::min<size_t>(block, frames - pos));
    bool snap = false;
    while (next < evs.size() && evs[next].frame <= static_cast<double>(pos)) {
      const Ev& ev = evs[next++];
      const std::vector<double>& f = ev.f;
      auto at = [&](size_t i) { return i < f.size() ? f[i] : 0.0; };
      bool ok = true;
      switch (ev.kind) {
        case 0: ok = h->command(at(0), at(1), at(2), at(3), at(4), at(5)); break;
        case 1: {
          Call c = call(static_cast<Verb>(static_cast<int>(at(0))), static_cast<int>(at(1)), at(4), static_cast<int>(at(2)),
                        static_cast<int>(at(3)), at(5), at(6), at(7));
          ok = h->post(c);
          break;
        }
        case 2: {
          const int np = static_cast<int>(at(7));
          std::vector<int> keys;
          std::vector<double> values;
          for (int i = 0; i < np; i++) {
            keys.push_back(static_cast<int>(at(8 + i * 2)));
            values.push_back(at(9 + i * 2));
          }
          ok = h->postFxAdd(static_cast<int>(at(0)), at(1), static_cast<int>(at(2)), static_cast<int>(at(3)), at(4),
                            keys.data(), values.data(), np, at(5), static_cast<int>(at(6)));
          break;
        }
        case 3: {
          const int nf = static_cast<int>(std::min<double>(at(0), static_cast<double>(frames)));
          ok = h->postFileLoad(in.left.data(), at(2) != 0 ? in.right.data() : nullptr, nf, at(1));
          break;
        }
        case 4: {
          const size_t off = static_cast<size_t>(at(4));
          const int nf = static_cast<int>(std::min<double>(at(2), static_cast<double>(frames - off)));
          ok = h->postPadLoad(at(0), at(1), in.left.data() + off, nf, at(3));
          break;
        }
        case 5: h->batchBegin(); break;
        case 6: ok = h->batchEnd(); break;
        case 7:
          ok = !pulling && h->pullBegin(static_cast<PullKind>(static_cast<int>(at(0))), static_cast<int>(at(1)), at(2),
                                        static_cast<int>(at(3)), at(4), at(5));
          pulling = pulling || ok;
          break;
        case 8: snap = true; break;
        default: ok = false; break;
      }
      if (!ok) std::fprintf(evOut, "R %.17g %d\n", ev.frame, ev.kind);
    }
    const float* inp[2] = {in.left.data() + pos, in.right.data() + pos};
    float* outp[2] = {outBuf.left.data() + pos, outBuf.right.data() + pos};
    g_in_render = 1;
    h->render(inp, 2, outp, 2, n);
    g_in_render = 0;
    h->collect();
    int32_t count = 0;
    if (pulling && h->pullPoll(vals.data(), count, meta)) {
      pulling = false;
      std::fprintf(evOut, "P %d %.17g %.17g %.17g %.17g", count, meta[0], meta[1], meta[2], meta[3]);
      for (int i = 0; i < count; i++) std::fprintf(evOut, " %.17g", vals[i]);
      std::fprintf(evOut, "\n");
    }
    if (snap) {
      double m[BK_METER_FIELDS];
      while (!h->readMeters(m)) {
      }
      std::fprintf(evOut, "M");
      for (double v : m) std::fprintf(evOut, " %.17g", v);
      std::fprintf(evOut, "\n");
    }
  }
  const HostStats st = h->stats();
  std::fprintf(evOut, "S %llu %llu %llu %llu %llu\n", static_cast<unsigned long long>(st.messagesPosted),
               static_cast<unsigned long long>(st.messagesApplied), static_cast<unsigned long long>(st.objectsFreed),
               static_cast<unsigned long long>(st.liveObjects), static_cast<unsigned long long>(st.commandsDropped));
  std::fclose(evOut);
  if (!writeWav(argv[3], outBuf, err)) {
    std::fprintf(stderr, "write: %s\n", err.c_str());
    return 2;
  }
  // The take: total, then wet and dry interleaved, read from frame 0.
  {
    uint64_t from = 0, total = 0, lost = 0;
    std::vector<float> wet(static_cast<size_t>(h->recordCapacity()) * 2), dry(wet.size());
    const uint32_t got = h->readRecording(from, wet.data(), dry.data(), h->recordCapacity(), total, lost);
    FILE* fp = std::fopen(argv[7], "wb");
    if (!fp) return 2;
    const double head[3] = {static_cast<double>(total), static_cast<double>(lost), static_cast<double>(got)};
    std::fwrite(head, sizeof(double), 3, fp);
    std::fwrite(wet.data(), sizeof(float), static_cast<size_t>(got) * 2, fp);
    std::fwrite(dry.data(), sizeof(float), static_cast<size_t>(got) * 2, fp);
    std::fclose(fp);
  }
  {
    std::vector<float> si(BK_SCOPE_SIZE), so(BK_SCOPE_SIZE);
    const uint32_t w = h->readScope(si.data(), so.data(), BK_SCOPE_SIZE);
    FILE* fp = std::fopen(argv[8], "wb");
    if (!fp) return 2;
    const double head = w;
    std::fwrite(&head, sizeof(double), 1, fp);
    std::fwrite(si.data(), sizeof(float), si.size(), fp);
    std::fwrite(so.data(), sizeof(float), so.size(), fp);
    std::fclose(fp);
  }
  const unsigned long allocs = g_render_allocs - before;
  if (BK_COUNT_ALLOC) std::printf("render allocations: %lu\n", allocs);
  std::printf(allocs == 0 ? "replay: PASS\n" : "replay: FAIL (render allocated)\n");
  return allocs == 0 ? 0 : 1;
}

int main(int argc, char** argv) {
  if (argc > 1 && std::strcmp(argv[1], "replay") == 0) return replay(argc, argv);
  const bool quick = argc > 1 && std::strcmp(argv[1], "--threads-only") == 0;
  if (!quick) {
    testAllocationFree();
    testOrdering();
    testSweep();
    testBatches();
    testPulls();
    testRecording();
    testChunking();
  }
  testSeqlock();
  testStress();
  std::printf(g_fails == 0 ? "\n%d checks, 0 failed -- host: PASS\n" : "\n%d checks, %d FAILED\n", g_checks, g_fails);
  return g_fails == 0 ? 0 : 1;
}
