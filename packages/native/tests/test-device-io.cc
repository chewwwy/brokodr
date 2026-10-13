// Bro.Kodr — device I/O tests (Phase 5b): PCM conversion and the duplex pump.
//
// Both headers are what the WASAPI driver leans on, and both are portable precisely so
// they can be proven here, on Linux, where the driver itself cannot run:
//   - pcm.h: every byte layout an endpoint can hand us, exhaustively where it is cheap
//     (all 2^16 int16 and all 2^24 int24 codes round-trip), at the edges where it is not.
//   - duplex.h: priming, exact latency, underflow, overflow, drift trim, block splitting,
//     and a long simulated stream with shared-mode-style uneven render requests.
// Built -O2 -Werror (with a glibc malloc counter on push/render) and under ASan + UBSan by
// scripts/verify-device-io.mjs, and cross-built with mingw and run under Wine when present.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

#include "brokodr/duplex.h"
#include "brokodr/pcm.h"

// ------------------------------------------------------------------ allocation counter

#if defined(__GLIBC__) && !defined(__SANITIZE_ADDRESS__) && !defined(__SANITIZE_THREAD__)
#define BK_COUNT_ALLOC 1
extern "C" void* __libc_malloc(size_t);
extern "C" void* __libc_calloc(size_t, size_t);
extern "C" void* __libc_realloc(void*, size_t);
extern "C" void __libc_free(void*);
static volatile int g_watch = 0;
static volatile unsigned long g_allocs = 0;
extern "C" void* malloc(size_t n) {
  if (g_watch) g_allocs = g_allocs + 1;
  return __libc_malloc(n);
}
extern "C" void* calloc(size_t a, size_t b) {
  if (g_watch) g_allocs = g_allocs + 1;
  return __libc_calloc(a, b);
}
extern "C" void* realloc(void* p, size_t n) {
  if (g_watch) g_allocs = g_allocs + 1;
  return __libc_realloc(p, n);
}
extern "C" void free(void* p) {
  if (g_watch && p) g_allocs = g_allocs + 1;
  __libc_free(p);
}
#else
#define BK_COUNT_ALLOC 0
static volatile int g_watch = 0;
static volatile unsigned long g_allocs = 0;
#endif

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

using brokodr::PcmFormat;
namespace pd = brokodr::pcm_detail;

static uint32_t bitsOf(float x) {
  uint32_t u;
  std::memcpy(&u, &x, 4);
  return u;
}
static std::string hex(uint64_t v) {
  char b[24];
  std::snprintf(b, sizeof b, "0x%llx", static_cast<unsigned long long>(v));
  return b;
}
static int32_t rd32(const uint8_t* p) {
  int32_t v;
  std::memcpy(&v, p, 4);
  return v;
}

// ------------------------------------------------------------------ PCM

static void testPcmInt16() {
  std::printf("\npcm: int16\n");
  uint8_t b[2];
  b[0] = 0x00, b[1] = 0x80;
  check(pd::readOne(b, PcmFormat::Int16) == -1.0f, "int16 -32768 reads as exactly -1.0");
  b[0] = 0xff, b[1] = 0x7f;
  check(pd::readOne(b, PcmFormat::Int16) == 32767.0f / 32768.0f, "int16 +32767 reads as 32767/32768");
  b[0] = 0xff, b[1] = 0xff;
  check(pd::readOne(b, PcmFormat::Int16) == -1.0f / 32768.0f, "int16 -1 reads as -1/32768");

  auto w16 = [](float x) {
    uint8_t o[2];
    pd::writeOne(o, PcmFormat::Int16, x);
    return static_cast<int16_t>(static_cast<uint16_t>(o[0] | (o[1] << 8)));
  };
  check(w16(1.0f) == 32767, "+1.0 clips to +32767 (no wrap)");
  check(w16(-1.0f) == -32768, "-1.0 writes -32768");
  check(w16(4.0f) == 32767 && w16(-4.0f) == -32768, "over-range clamps both ways");
  const float inf = std::numeric_limits<float>::infinity();
  check(w16(inf) == 32767 && w16(-inf) == -32768, "+/-inf clamp");
  check(w16(std::numeric_limits<float>::quiet_NaN()) == 0, "NaN writes 0");
  check(w16(0.5f / 32768.0f) == 1 && w16(-0.5f / 32768.0f) == -1, "half an LSB rounds away from zero");
  check(w16(0.49f / 32768.0f) == 0 && w16(-0.49f / 32768.0f) == 0, "under half an LSB rounds to 0");
  check(w16(-0.0f) == 0, "-0.0 writes 0");

  int bad = 0;
  int firstBad = 0;
  for (int v = -32768; v <= 32767; v++) {
    uint8_t in[2] = {static_cast<uint8_t>(v & 0xff), static_cast<uint8_t>((v >> 8) & 0xff)};
    uint8_t out[2];
    pd::writeOne(out, PcmFormat::Int16, pd::readOne(in, PcmFormat::Int16));
    if (std::memcmp(in, out, 2) != 0 && bad++ == 0) firstBad = v;
  }
  check(bad == 0, "all 65536 int16 codes round-trip bit-exact", std::to_string(bad) + " bad, first " +
                                                                    std::to_string(firstBad));
}

static void testPcmInt24() {
  std::printf("\npcm: packed int24\n");
  uint8_t b[3];
  b[0] = 0x00, b[1] = 0x00, b[2] = 0x80;
  check(pd::readOne(b, PcmFormat::Int24) == -1.0f, "0x800000 sign-extends to exactly -1.0");
  b[0] = 0xff, b[1] = 0xff, b[2] = 0xff;
  check(pd::readOne(b, PcmFormat::Int24) == -1.0f / 8388608.0f, "0xffffff sign-extends to -1 LSB");
  b[0] = 0xff, b[1] = 0xff, b[2] = 0x7f;
  check(pd::readOne(b, PcmFormat::Int24) == 8388607.0f / 8388608.0f, "0x7fffff reads as max");
  b[0] = 0x01, b[1] = 0x00, b[2] = 0x00;
  check(pd::readOne(b, PcmFormat::Int24) == 1.0f / 8388608.0f, "byte order is little-endian");

  uint8_t o[4] = {0xaa, 0xaa, 0xaa, 0xaa};
  pd::writeOne(o, PcmFormat::Int24, 1.0f);
  check(o[0] == 0xff && o[1] == 0xff && o[2] == 0x7f && o[3] == 0xaa, "+1.0 clips to 0x7fffff, writes exactly 3 bytes");
  pd::writeOne(o, PcmFormat::Int24, -1.0f);
  check(o[0] == 0x00 && o[1] == 0x00 && o[2] == 0x80, "-1.0 writes 0x800000");
  pd::writeOne(o, PcmFormat::Int24, std::numeric_limits<float>::quiet_NaN());
  check(o[0] == 0 && o[1] == 0 && o[2] == 0, "NaN writes 0");

  // Every 24-bit code survives float: 24 bits fit a float mantissa exactly.
  uint32_t bad = 0, firstBad = 0;
  for (uint32_t u = 0; u < (1u << 24); u++) {
    uint8_t in[3] = {static_cast<uint8_t>(u), static_cast<uint8_t>(u >> 8), static_cast<uint8_t>(u >> 16)};
    uint8_t out[3];
    pd::writeOne(out, PcmFormat::Int24, pd::readOne(in, PcmFormat::Int24));
    if (std::memcmp(in, out, 3) != 0 && bad++ == 0) firstBad = u;
  }
  check(bad == 0, "all 2^24 packed int24 codes round-trip bit-exact",
        std::to_string(bad) + " bad, first " + hex(firstBad));
}

static void testPcmInt32() {
  std::printf("\npcm: int32 and 24-in-32\n");
  uint8_t o[4];
  pd::writeOne(o, PcmFormat::Int32, 1.0f);
  check(rd32(o) == INT32_MAX, "int32: +1.0 clips to INT32_MAX");
  pd::writeOne(o, PcmFormat::Int32, -1.0f);
  check(rd32(o) == INT32_MIN, "int32: -1.0 writes INT32_MIN");
  pd::writeOne(o, PcmFormat::Int32, std::numeric_limits<float>::quiet_NaN());
  check(rd32(o) == 0, "int32: NaN writes 0");
  {
    const int32_t v = INT32_MIN;
    std::memcpy(o, &v, 4);
    check(pd::readOne(o, PcmFormat::Int32) == -1.0f, "int32: INT32_MIN reads as exactly -1.0");
  }
  // int32 codes that a float can hold exactly (24 significant bits) must round-trip.
  uint32_t bad = 0;
  uint32_t rng = 0x9e3779b9u;
  for (int i = 0; i < 200000; i++) {
    rng ^= rng << 13, rng ^= rng >> 17, rng ^= rng << 5;
    const int shift = static_cast<int>(rng % 9);  // 0..8: low `shift` bits zero
    int32_t v = static_cast<int32_t>(rng & 0xffffff00u) >> shift;
    v = static_cast<int32_t>(static_cast<uint32_t>(v) & ~((1u << shift) - 1u) & 0xffffff00u);
    std::memcpy(o, &v, 4);
    uint8_t back[4];
    pd::writeOne(back, PcmFormat::Int32, pd::readOne(o, PcmFormat::Int32));
    if (std::memcmp(o, back, 4) != 0) bad++;
  }
  check(bad == 0, "int32: 200000 float-representable codes round-trip", std::to_string(bad) + " bad");

  pd::writeOne(o, PcmFormat::Int32Valid24, 1.0f);
  check(rd32(o) == 0x7fffff00, "24-in-32: +1.0 writes 0x7fffff00");
  pd::writeOne(o, PcmFormat::Int32Valid24, -1.0f);
  check(static_cast<uint32_t>(rd32(o)) == 0x80000000u, "24-in-32: -1.0 writes 0x80000000");
  uint32_t lowBits = 0, badRt = 0;
  for (uint32_t u = 0; u < (1u << 24); u += 7) {
    const int32_t v = static_cast<int32_t>(u << 8);
    std::memcpy(o, &v, 4);
    uint8_t back[4];
    pd::writeOne(back, PcmFormat::Int32Valid24, pd::readOne(o, PcmFormat::Int32Valid24));
    if (std::memcmp(o, back, 4) != 0) badRt++;
  }
  for (int i = 0; i < 200000; i++) {
    rng ^= rng << 13, rng ^= rng >> 17, rng ^= rng << 5;
    const float x = static_cast<float>(static_cast<int32_t>(rng)) / 2147483648.0f * 1.1f;
    pd::writeOne(o, PcmFormat::Int32Valid24, x);
    if (o[0] != 0) lowBits++;
  }
  check(badRt == 0, "24-in-32: every 7th 24-bit code round-trips", std::to_string(badRt) + " bad");
  check(lowBits == 0, "24-in-32: low byte always written as zero (200000 random floats)",
        std::to_string(lowBits) + " non-zero");
  // A device that ignores wValidBitsPerSample and fills the low byte anyway still reads.
  {
    const int32_t v = 0x40000080;
    std::memcpy(o, &v, 4);
    check(pd::readOne(o, PcmFormat::Int32Valid24) == static_cast<float>(0x40000080 / 2147483648.0),
          "24-in-32: a dirty low byte reads at full 32-bit scale");
  }
}

static void testPcmFloat() {
  std::printf("\npcm: float32\n");
  uint8_t o[4];
  const float vals[] = {0.0f, -0.0f, 1.0f, -1.0f, 1.5f, 1e-30f, -3.25e-7f};
  bool exact = true;
  for (float v : vals) {
    pd::writeOne(o, PcmFormat::Float32, v);
    if (bitsOf(pd::readOne(o, PcmFormat::Float32)) != bitsOf(v)) exact = false;
  }
  check(exact, "float32 passes through bit-exact (incl. -0.0, over-range, denormal-adjacent)");
  pd::writeOne(o, PcmFormat::Float32, std::numeric_limits<float>::quiet_NaN());
  check(bitsOf(pd::readOne(o, PcmFormat::Float32)) == 0, "float32: NaN writes +0.0");
  check(brokodr::pcmBytes(PcmFormat::Float32) == 4 && brokodr::pcmBytes(PcmFormat::Int16) == 2 &&
            brokodr::pcmBytes(PcmFormat::Int24) == 3 && brokodr::pcmBytes(PcmFormat::Int32) == 4 &&
            brokodr::pcmBytes(PcmFormat::Int32Valid24) == 4,
        "pcmBytes for every format");
}

static void testPcmBuffers() {
  std::printf("\npcm: interleaved buffers\n");
  // A 4-channel packed int24 capture buffer, channel c of frame i holds (i*4 + c + 1) LSB.
  const uint32_t ch = 4, frames = 37;
  std::vector<uint8_t> buf(frames * ch * 3);
  for (uint32_t i = 0; i < frames; i++)
    for (uint32_t c = 0; c < ch; c++) {
      const int32_t v = -static_cast<int32_t>(i * 4 + c + 1);
      uint8_t* p = &buf[(i * ch + c) * 3];
      p[0] = static_cast<uint8_t>(v), p[1] = static_cast<uint8_t>(v >> 8), p[2] = static_cast<uint8_t>(v >> 16);
    }
  std::vector<float> l(frames, 9.0f), r(frames, 9.0f);
  brokodr::pcmToFloat(buf.data(), PcmFormat::Int24, ch, 1, 1, l.data(), r.data(), frames);
  bool ok = true;
  for (uint32_t i = 0; i < frames; i++) {
    const float want = -static_cast<float>(i * 4 + 2) / 8388608.0f;
    if (l[i] != want || r[i] != want) ok = false;
  }
  check(ok, "mic on device input 2 (chL = chR = 1) feeds both engine channels");
  brokodr::pcmToFloat(buf.data(), PcmFormat::Int24, ch, 3, 0, l.data(), r.data(), frames);
  ok = true;
  for (uint32_t i = 0; i < frames; i++)
    if (l[i] != -static_cast<float>(i * 4 + 4) / 8388608.0f || r[i] != -static_cast<float>(i * 4 + 1) / 8388608.0f)
      ok = false;
  check(ok, "arbitrary channel pick (3 -> L, 0 -> R)");
  brokodr::pcmToFloat(buf.data(), PcmFormat::Int24, ch, 0, 7, l.data(), r.data(), frames);
  ok = true;
  for (uint32_t i = 0; i < frames; i++)
    if (r[i] != 0.0f) ok = false;
  check(ok, "a channel index past the device's channels reads silence");
  std::fill(l.begin(), l.end(), 9.0f);
  std::fill(r.begin(), r.end(), 9.0f);
  brokodr::pcmToFloat(nullptr, PcmFormat::Int24, ch, 0, 1, l.data(), r.data(), frames);
  ok = true;
  for (uint32_t i = 0; i < frames; i++)
    if (l[i] != 0.0f || r[i] != 0.0f) ok = false;
  check(ok, "a null (AUDCLNT_BUFFERFLAGS_SILENT) packet reads silence");

  // Render side: 4-channel int32 endpoint, extra channels must be silent.
  std::vector<float> inL(frames), inR(frames);
  for (uint32_t i = 0; i < frames; i++) inL[i] = 0.25f, inR[i] = -0.5f;
  std::vector<uint8_t> outb(frames * ch * 4, 0xcc);
  brokodr::floatToPcm(inL.data(), inR.data(), outb.data(), PcmFormat::Int32Valid24, ch, frames);
  ok = true;
  for (uint32_t i = 0; i < frames; i++) {
    const uint8_t* f = &outb[i * ch * 4];
    if (rd32(f) != 0x20000000 || rd32(f + 4) != static_cast<int32_t>(0xc0000000u) || rd32(f + 8) != 0 ||
        rd32(f + 12) != 0)
      ok = false;
  }
  check(ok, "render: L -> ch0, R -> ch1, channels 2..3 written as silence");
  std::vector<uint8_t> mono(frames * 2, 0xcc);
  brokodr::floatToPcm(inL.data(), inR.data(), mono.data(), PcmFormat::Int16, 1, frames);
  ok = true;
  for (uint32_t i = 0; i < frames; i++)
    if (mono[i * 2] != 0x00 || mono[i * 2 + 1] != 0x20) ok = false;
  check(ok, "render: a mono endpoint gets L only, exactly frames*2 bytes");

  // Every format: float -> device -> float is the identity on values the format can hold.
  const PcmFormat all[] = {PcmFormat::Float32, PcmFormat::Int16, PcmFormat::Int24, PcmFormat::Int32,
                           PcmFormat::Int32Valid24};
  ok = true;
  std::string which;
  for (PcmFormat f : all) {
    std::vector<float> a(frames), b(frames), a2(frames), b2(frames);
    for (uint32_t i = 0; i < frames; i++) {
      a[i] = static_cast<float>(static_cast<int>(i) - 18) / 32.0f;  // multiples of 2^-5, in [-0.5625, 0.5625]
      b[i] = -a[i];
    }
    std::vector<uint8_t> dev(frames * 2 * brokodr::pcmBytes(f));
    brokodr::floatToPcm(a.data(), b.data(), dev.data(), f, 2, frames);
    brokodr::pcmToFloat(dev.data(), f, 2, 0, 1, a2.data(), b2.data(), frames);
    if (a != a2 || b != b2) ok = false, which += std::string(" ") + brokodr::pcmName(f);
  }
  check(ok, "stereo float -> device -> float is exact in every format", which);
}

// ------------------------------------------------------------------ duplex pump

// Records exactly what the engine was handed: every input sample, every block length.
// Output = input * 2 on L, a constant on R, so the test can see both directions.
class RecSink : public brokodr::RenderSink {
 public:
  explicit RecSink(size_t reserve) {
    inL.reserve(reserve);
    inR.reserve(reserve);
    blocks.reserve(reserve);
  }
  void render(const float* const* in, uint32_t inCh, float* const* out, uint32_t outCh, uint32_t frames) override {
    if (inCh != 2 || outCh != 2) badShape = true;
    for (uint32_t i = 0; i < frames; i++) {
      if (out[0][i] != 0.0f || out[1][i] != 0.0f) dirtyOut = true;
      if (inL.size() < inL.capacity()) inL.push_back(in[0][i]), inR.push_back(in[1][i]);
      if (writes) out[0][i] = in[0][i] * 2.0f, out[1][i] = 0.125f;
    }
    if (blocks.size() < blocks.capacity()) blocks.push_back(frames);
  }
  std::vector<float> inL, inR;
  std::vector<uint32_t> blocks;
  bool badShape = false, dirtyOut = false, writes = true;
};

static std::vector<float> ramp(uint32_t from, uint32_t n) {
  std::vector<float> v(n);
  for (uint32_t i = 0; i < n; i++) v[i] = static_cast<float>(from + i + 1);  // 1-based: 0 means "silence"
  return v;
}

static void testDuplexBasics() {
  std::printf("\nduplex: init, priming, latency\n");
  brokodr::DuplexPump p;
  check(!p.init(0, 1024, 128, 128), "init rejects blockFrames 0");
  check(!p.init(128, 256, 128, 128), "init rejects target + slack >= capacity");
  check(p.init(128, 1000, 480, 240), "init accepts a sane config");
  check(p.capacity() == 1024, "capacity rounds up to a power of two", std::to_string(p.capacity()));
  check(p.fill() == 480, "primed with `target` frames", std::to_string(p.fill()));

  // Push one period per render of one period: the engine sees exactly `target` frames of
  // silence and then the capture stream, sample-accurate, with no underflow.
  RecSink s(8192);
  std::vector<float> oL(480), oR(480);
  for (uint32_t k = 0; k < 8; k++) {
    const auto x = ramp(k * 480, 480);
    p.push(x.data(), x.data(), 480);
    p.render(&s, oL.data(), oR.data(), 480);
  }
  bool silentThenRamp = s.inL.size() == 8 * 480;
  for (uint32_t i = 0; silentThenRamp && i < s.inL.size(); i++) {
    const float want = i < 480 ? 0.0f : static_cast<float>(i - 480 + 1);
    if (s.inL[i] != want || s.inR[i] != want) silentThenRamp = false;
  }
  check(silentThenRamp, "engine input = capture delayed by exactly `target` frames");
  const auto& c = p.counters();
  check(c.underflowFrames == 0 && c.overflowFrames == 0 && c.trimFrames == 0, "steady state: no xruns counted");
  check(c.renderedFrames == 8 * 480, "renderedFrames counts output frames");
  check(p.fill() == 480, "fill returns to target after each cycle", std::to_string(p.fill()));
  check(!s.badShape, "sink always called with 2 in / 2 out channels");
  check(oL[0] == 2.0f * (7 * 480 - 480 + 1) && oR[0] == 0.125f, "sink output reaches the caller's buffers");
}

static void testDuplexBlocks() {
  std::printf("\nduplex: block splitting and zeroed output\n");
  brokodr::DuplexPump p;
  p.init(128, 2048, 0, 512);
  RecSink s(64);
  std::vector<float> oL(300, 7.0f), oR(300, 7.0f);
  const auto x = ramp(0, 300);
  p.push(x.data(), x.data(), 300);
  p.render(&s, oL.data(), oR.data(), 300);
  check(s.blocks.size() == 3 && s.blocks[0] == 128 && s.blocks[1] == 128 && s.blocks[2] == 44,
        "300 frames at block 128 -> 128, 128, 44");
  check(p.counters().engineBlocks == 3, "engineBlocks counts sink calls");
  check(!s.dirtyOut, "output is zeroed before every sink call (pre-filled with 7.0)");
  RecSink quiet(64);
  quiet.writes = false;
  std::fill(oL.begin(), oL.end(), 7.0f);
  std::fill(oR.begin(), oR.end(), 7.0f);
  p.render(&quiet, oL.data(), oR.data(), 300);
  bool zero = true;
  for (uint32_t i = 0; i < 300; i++)
    if (oL[i] != 0.0f || oR[i] != 0.0f) zero = false;
  check(zero, "a sink that writes nothing yields silence, not stale data");
  std::fill(oL.begin(), oL.end(), 7.0f);
  p.render(nullptr, oL.data(), oR.data(), 100);
  zero = true;
  for (uint32_t i = 0; i < 100; i++)
    if (oL[i] != 0.0f) zero = false;
  check(zero, "a null sink yields silence");
  p.render(&s, oL.data(), oR.data(), 0);
  check(s.blocks.size() == 3, "a zero-frame render calls nothing");
}

static void testDuplexXruns() {
  std::printf("\nduplex: underflow, overflow, trim\n");
  {
    brokodr::DuplexPump p;
    p.init(256, 1024, 100, 200);
    RecSink s(4096);
    std::vector<float> oL(512), oR(512);
    // Warm-up: render runs before the capture endpoint has delivered anything.
    p.render(&s, oL.data(), oR.data(), 256);
    p.render(&s, oL.data(), oR.data(), 300);
    const auto& c = p.counters();
    check(!p.started() && c.warmupFrames == 556 && c.underflowFrames == 0 && c.underflowEvents == 0,
          "warm-up: frames before the first capture packet are warm-up, not underflow",
          "warmup " + std::to_string(c.warmupFrames) + " underflow " + std::to_string(c.underflowFrames));
    bool zero = true;
    for (float v : s.inL)
      if (v != 0.0f) zero = false;
    check(zero && s.inL.size() == 556, "warm-up: the engine still ran, on silence");
    check(oR[299] == 0.125f, "warm-up: output still written");
    check(p.fill() == 100 && c.reprimeFrames == 0, "warm-up: cushion kept at target, not counted as re-prime",
          "fill " + std::to_string(p.fill()));
    const auto x = ramp(0, 50);
    p.push(x.data(), x.data(), 50);
    s.inL.clear();
    p.render(&s, oL.data(), oR.data(), 150);
    check(p.started() && s.inL[99] == 0.0f && s.inL[100] == 1.0f && s.inL[149] == 50.0f && c.warmupFrames == 556,
          "first capture plays exactly `target` frames late; warm-up ends");
    // Now capture stalls: a real underflow.
    s.inL.clear();
    p.render(&s, oL.data(), oR.data(), 256);
    check(c.underflowFrames == 256 && c.underflowEvents == 1, "underflow after start: counted once per short block",
          std::to_string(c.underflowFrames) + " frames / " + std::to_string(c.underflowEvents));
    check(s.inL.size() == 256 && s.inL[255] == 0.0f && oR[255] == 0.125f, "underflow: engine ran on zeros, output written");
    check(p.fill() == 100 && c.reprimeFrames == 100, "underflow: FIFO re-primed to target with silence",
          "fill " + std::to_string(p.fill()));
    p.push(x.data(), x.data(), 50);
    s.inL.clear();
    p.render(&s, oL.data(), oR.data(), 150);
    check(s.inL[99] == 0.0f && s.inL[100] == 1.0f && s.inL[149] == 50.0f,
          "recovery: capture resumes `target` frames late, the cushion restored");
    check(c.underflowEvents == 1, "recovery: no further underflow");
  }
  {
    brokodr::DuplexPump p;
    p.init(128, 256, 0, 128);  // capacity 256, empty
    const auto x = ramp(0, 400);
    p.push(x.data(), x.data(), 200);
    p.push(x.data() + 200, x.data() + 200, 100);  // 300 into 256: oldest 44 dropped
    check(p.counters().overflowFrames == 44 && p.fill() == 256, "overflow: oldest frames dropped and counted",
          std::to_string(p.counters().overflowFrames));
    RecSink s(512);
    std::vector<float> oL(256), oR(256);
    p.render(&s, oL.data(), oR.data(), 256);
    check(s.inL.front() == 45.0f && s.inL.back() == 300.0f, "overflow: the newest 256 survive, in order");
    p.push(x.data(), nullptr, 400);  // a single packet bigger than the FIFO
    check(p.counters().overflowFrames == 44 + 144 && p.fill() == 256, "a packet larger than the FIFO keeps its tail");
    s.inL.clear(), s.inR.clear();
    p.render(&s, oL.data(), oR.data(), 256);
    check(s.inL.front() == 145.0f && s.inL.back() == 400.0f && s.inR.front() == 0.0f,
          "  ...the newest 256 frames, and a null channel queued silence");
  }
  {
    brokodr::DuplexPump p;
    p.init(128, 2048, 128, 64);
    RecSink s(64);
    std::vector<float> oL(128), oR(128);
    const auto x = ramp(0, 512);
    p.push(x.data(), x.data(), 256);  // fill 384, render 128 -> 256 > 192 -> trim to 128
    p.render(&s, oL.data(), oR.data(), 128);
    check(p.counters().trimEvents == 1 && p.counters().trimFrames == 128 && p.fill() == 128,
          "drift trim: fill above target + slack is cut back to target",
          std::to_string(p.counters().trimFrames) + " frames, fill " + std::to_string(p.fill()));
    check(p.counters().overflowFrames == 0, "trim is not counted as overflow");
    p.push(x.data(), x.data(), 128 + 64);
    p.render(&s, oL.data(), oR.data(), 128);  // fill 192 == target + slack: kept
    check(p.counters().trimEvents == 1 && p.fill() == 192, "fill at exactly target + slack is left alone");
  }
}

// Shared-mode style: capture arrives in fixed 480-frame packets, render asks for
// "bufferFrames - padding", which wanders. Then the two clocks are made to disagree.
static void simulate(const char* label, double captureRatio, bool expectTrim, bool expectUnder) {
  brokodr::DuplexPump p;
  const uint32_t period = 480;
  p.init(128, 4096, period, period);
  RecSink s(0);
  std::vector<float> oL(1024), oR(1024), x(1024, 0.5f);
  uint32_t rng = 12345;
  double capAcc = 0.0;
  uint32_t maxFill = 0, minFill = UINT32_MAX, debt = 0;
  g_watch = 1;
  for (int k = 0; k < 6000; k++) {  // ~60 s at 48 kHz
    capAcc += period * captureRatio;
    const uint32_t cap = static_cast<uint32_t>(capAcc);
    capAcc -= cap;
    p.push(x.data(), x.data(), cap);
    // Even cycles ask for 416..480 frames, odd cycles repay the difference, so each pair
    // renders exactly two periods — the shape of "bufferFrames - padding" in shared mode.
    uint32_t n;
    if (k % 2 == 0) {
      rng ^= rng << 13, rng ^= rng >> 17, rng ^= rng << 5;
      n = period - rng % 65;
      debt = 2 * period - n;
    } else {
      n = debt;
    }
    p.render(&s, oL.data(), oR.data(), n);
    maxFill = std::max(maxFill, p.fill());
    minFill = std::min(minFill, p.fill());
  }
  g_watch = 0;
  const auto& c = p.counters();
  const std::string stats = "under " + std::to_string(c.underflowFrames) + "/" + std::to_string(c.underflowEvents) + "x trim " + std::to_string(c.trimFrames) +
                            " over " + std::to_string(c.overflowFrames) + " fill " + std::to_string(minFill) + ".." +
                            std::to_string(maxFill);
  std::printf("    %s: %s\n", label, stats.c_str());
  check(c.overflowFrames == 0, (std::string(label) + ": never overflows").c_str(), stats);
  check((c.trimFrames > 0) == expectTrim, (std::string(label) + (expectTrim ? ": trims drift" : ": no trim")).c_str(),
        stats);
  check((c.underflowFrames > 0) == expectUnder,
        (std::string(label) + (expectUnder ? ": underflows (capture too slow)" : ": no underflow")).c_str(), stats);
  check(maxFill <= 2 * period, (std::string(label) + ": latency bounded by target + slack").c_str(), stats);
  check(c.underflowEvents <= 4 && c.trimEvents <= 4,
        (std::string(label) + ": xrun events are rare (one per target/drift periods, not per period)").c_str(),
        stats);
#if BK_COUNT_ALLOC
  check(g_allocs == 0, (std::string(label) + ": push/render never allocate").c_str(),
        std::to_string(g_allocs) + " calls");
#endif
  g_allocs = 0;
}

int main() {
  std::printf("device io tests (allocation counter %s)\n", BK_COUNT_ALLOC ? "on" : "off");
#if BK_COUNT_ALLOC
  g_watch = 1;
  void* volatile probe = std::malloc(16);
  std::free(probe);
  g_watch = 0;
  check(g_allocs == 2, "allocation counter sees a flagged malloc + free", std::to_string(g_allocs));
  g_allocs = 0;
#endif
  testPcmInt16();
  testPcmInt24();
  testPcmInt32();
  testPcmFloat();
  testPcmBuffers();
  testDuplexBasics();
  testDuplexBlocks();
  testDuplexXruns();
  std::printf("\nduplex: 60 s simulated streams, uneven render requests\n");
  simulate("same clock", 1.0, false, false);
  simulate("capture +500 ppm", 1.0005, true, false);
  simulate("capture -500 ppm", 0.9995, false, true);
  std::printf("\n%d checks, %d failed — device io: %s\n", g_checks, g_fails, g_fails ? "FAIL" : "PASS");
  return g_fails ? 1 : 0;
}
