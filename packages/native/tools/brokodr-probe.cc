// brokodr-probe — what the native audio path actually achieves on this Windows machine.
//
// PHASE 5b. A standalone console tool, built for Windows (mingw-w64 or MSVC), that opens
// the real WASAPI driver with the real engine behind it and prints what it got: mode,
// granted period and buffer, sample format, estimated round trip, callback timing and
// every xrun counter. With --loopback and a cable (or the interface's own loopback /
// direct-monitor routing) from an output to an input, it MEASURES the round trip.
//
//   brokodr-probe --list
//   brokodr-probe                                  shared, then exclusive, 128 frames, 5 s each
//   brokodr-probe --in UMC --out UMC --mic 2       UMC1820, mic on input 2 to both channels
//   brokodr-probe --mode exclusive --frames 64 --fx heavy --seconds 20
//   brokodr-probe --in UMC --out UMC --loopback    out 1 -> in 1 with a cable
//
// Safety: the engine's output is MUTED unless --monitor is given, because a mic feeding
// speakers through a probe is a feedback loop waiting to happen. Muted, the engine still
// runs every block, so the timing numbers are honest. --tone plays a quiet 440 Hz sine
// to prove the output path; --loopback plays a click train and nothing else.
//
// Output is plain text meant to be pasted back into a chat or an issue as-is.

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "brokodr/device.h"
#include "brokodr/dsp/effect-registry.h"
#include "brokodr/dsp/engine.h"

namespace {

struct Options {
  bool list = false;
  bool shared = true, exclusive = true;
  uint32_t frames = 128, rate = 48000;
  double seconds = 5.0;
  std::string in, out;
  int mic = 0;  // 1-based device channel feeding both engine inputs; 0 = channels 1 and 2
  std::vector<std::string> fx;
  bool monitor = false, tone = false, loopback = false;
};

void usage() {
  std::printf(
      "usage: brokodr-probe [options]\n"
      "  --list                 list WASAPI endpoints and exit\n"
      "  --mode M               shared | exclusive | both (default both)\n"
      "  --frames N             engine block / requested period in frames (default 128)\n"
      "  --rate HZ              sample rate (default 48000)\n"
      "  --seconds S            run time per mode (default 5)\n"
      "  --in X / --out X       endpoint: list index, id, or part of the name (default: system\n"
      "                         default). --in none opens output only.\n"
      "  --mic N                use device input channel N (1-based) for both engine channels\n"
      "  --fx a,b,c | heavy     effects on the master chain (eq comp limiter gate transient dist\n"
      "                         sat crush pitch vocoder talkbox chorus flanger phaser tremolo\n"
      "                         ringmod freqshift delay reverb character glitch noise)\n"
      "  --monitor              let the engine's output reach the speakers (default muted)\n"
      "  --tone                 add a -20 dBFS 440 Hz sine to the output\n"
      "  --loopback             click train out, detect it on the input: measured round trip\n");
}

bool parse(int argc, char** argv, Options& o) {
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    auto val = [&](const char* name) -> const char* {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "%s needs a value\n", name);
        return nullptr;
      }
      return argv[++i];
    };
    const char* v = nullptr;
    if (a == "--list") o.list = true;
    else if (a == "--monitor") o.monitor = true;
    else if (a == "--tone") o.tone = true;
    else if (a == "--loopback") o.loopback = true;
    else if (a == "--help" || a == "-h") return usage(), std::exit(0), true;
    else if (a == "--mode") {
      if (!(v = val("--mode"))) return false;
      const std::string m = v;
      o.shared = m == "shared" || m == "both";
      o.exclusive = m == "exclusive" || m == "both";
      if (!o.shared && !o.exclusive) return std::fprintf(stderr, "bad --mode %s\n", v), false;
    } else if (a == "--frames") {
      if (!(v = val("--frames"))) return false;
      o.frames = static_cast<uint32_t>(std::atoi(v));
    } else if (a == "--rate") {
      if (!(v = val("--rate"))) return false;
      o.rate = static_cast<uint32_t>(std::atoi(v));
    } else if (a == "--seconds") {
      if (!(v = val("--seconds"))) return false;
      o.seconds = std::atof(v);
    } else if (a == "--in") {
      if (!(v = val("--in"))) return false;
      o.in = v;
    } else if (a == "--out") {
      if (!(v = val("--out"))) return false;
      o.out = v;
    } else if (a == "--mic") {
      if (!(v = val("--mic"))) return false;
      o.mic = std::atoi(v);
    } else if (a == "--fx") {
      if (!(v = val("--fx"))) return false;
      std::string s = v;
      if (s == "heavy") s = "eq,comp,pitch,vocoder,chorus,delay,reverb,limiter";
      size_t p = 0;
      while (p <= s.size()) {
        const size_t q = std::min(s.find(',', p), s.size());
        if (q > p) o.fx.push_back(s.substr(p, q - p));
        p = q + 1;
      }
    } else {
      std::fprintf(stderr, "unknown option %s\n", a.c_str());
      return false;
    }
  }
  if (o.frames < 16 || o.frames > 4096 || o.rate < 8000 || o.seconds <= 0) {
    std::fprintf(stderr, "frames must be 16..4096, rate >= 8000, seconds > 0\n");
    return false;
  }
  if (o.mic < 0) return std::fprintf(stderr, "--mic is 1-based\n"), false;
  return true;
}

std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

/** Resolve --in/--out: "" (default), "none", a list index, an exact id, or a name fragment. */
bool resolve(const std::vector<brokodr::DeviceInfo>& devs, const std::string& want, bool capture, std::string& id,
             std::string& err) {
  id.clear();
  if (want.empty() || want == "none") return id = want, true;
  bool digits = !want.empty();
  for (char c : want) digits = digits && c >= '0' && c <= '9';
  if (digits) {
    const size_t i = static_cast<size_t>(std::atoi(want.c_str()));
    if (i < devs.size()) {
      const bool isCap = devs[i].inputChannels > 0;
      if (isCap != capture) return err = "endpoint " + want + " is not an " + (capture ? "input" : "output"), false;
      return id = devs[i].id, true;
    }
    return err = "no endpoint " + want, false;
  }
  std::vector<size_t> hits;
  for (size_t i = 0; i < devs.size(); i++) {
    const bool isCap = devs[i].inputChannels > 0;
    if (isCap != capture) continue;
    if (devs[i].id == want) return id = devs[i].id, true;
    if (lower(devs[i].name).find(lower(want)) != std::string::npos) hits.push_back(i);
  }
  if (hits.empty()) return err = std::string("no ") + (capture ? "input" : "output") + " matching '" + want + "'", false;
  if (hits.size() > 1)
    std::printf("  note: '%s' matches %zu %s endpoints, using [%zu] %s\n", want.c_str(), hits.size(),
                capture ? "input" : "output", hits[0], devs[hits[0]].name.c_str());
  id = devs[hits[0]].id;
  return true;
}

// ------------------------------------------------------------------ the engine

// Owns one engine and its master chain. Construction allocates; render() never does.
class ProbeSink final : public brokodr::RenderSink {
 public:
  ProbeSink(const Options& o, std::string& err) : o_(o) {
    const double sr = o.rate;
    const int mb = static_cast<int>(o.frames);
    storage_ = static_cast<float*>(std::calloc(bk_engine_storage_floats(sr, mb), sizeof(float)));
    if (!storage_ || bk_engine_init(&e_, sr, mb, storage_) != 0) {
      err = "engine init failed";
      return;
    }
    int id = 1;
    for (const std::string& name : o.fx) {
      const int type = bk_effect_type_from_name(name.c_str());
      if (type < 0) {
        err = "unknown effect '" + name + "'";
        return;
      }
      Fx fx;
      const size_t n = bk_effect_size(type), nf = bk_effect_storage_floats(type, sr, mb);
      fx.mem = n ? std::calloc(1, n) : nullptr;
      fx.st = nf ? static_cast<float*>(std::calloc(nf, sizeof(float))) : nullptr;
      const bk_effect_vt* vt = fx.mem ? bk_effect_create(type, fx.mem, fx.st, sr, mb) : nullptr;
      fx_.push_back(fx);
      if (!vt) {
        err = "could not build effect '" + name + "'";
        return;
      }
      bk_slot_spec spec;
      std::memset(&spec, 0, sizeof spec);
      spec.id = id++;
      spec.type = type;
      spec.index = BK_CHAIN_APPEND;
      spec.mix = NAN;
      spec.bypassed = BK_CHAIN_KEEP;
      spec.effect = fx.mem;
      spec.vt = vt;
      if (!bk_engine_fx_add(&e_, BK_TARGET_MASTER, 0, &spec)) {
        err = "master chain refused '" + name + "'";
        return;
      }
    }
    bk_engine_recalc_latency(&e_);
    bk_engine_io(&e_, BK_IO_MUTE, o.monitor ? 0.0 : 1.0);
    scratchL_.assign(o.frames, 0.0f);
    scratchR_.assign(o.frames, 0.0f);
    ok_ = true;
  }
  ~ProbeSink() override {
    for (Fx& f : fx_) std::free(f.mem), std::free(f.st);
    std::free(storage_);
  }
  ProbeSink(const ProbeSink&) = delete;
  ProbeSink& operator=(const ProbeSink&) = delete;

  bool ok() const { return ok_; }
  int engineLatency() { return bk_engine_latency_samples(&e_); }

  void render(const float* const* in, uint32_t inCh, float* const* out, uint32_t outCh, uint32_t frames) override {
    if (inCh < 2 || outCh < 2 || frames > o_.frames) return;
    const bool lb = o_.loopback;
    float* oL = lb ? scratchL_.data() : out[0];
    float* oR = lb ? scratchR_.data() : out[1];
    bk_engine_process(&e_, in[0], in[1], oL, oR, static_cast<int>(frames));
    if (o_.tone && !lb) {
      for (uint32_t i = 0; i < frames; i++) {
        const float s = 0.1f * static_cast<float>(std::sin(phase_));
        phase_ += 2.0 * 3.14159265358979323846 * 440.0 / o_.rate;
        if (phase_ > 6.283185307179586) phase_ -= 6.283185307179586;
        out[0][i] += s;
        out[1][i] += s;
      }
    }
    if (lb) loopback(in[0], in[1], out[0], out[1], frames);
    pos_ += frames;
    double pk = 0.0;
    for (uint32_t i = 0; i < frames; i++) pk = std::max(pk, static_cast<double>(std::fabs(in[0][i])));
    if (pk > inPeak_.load(std::memory_order_relaxed)) inPeak_.store(pk, std::memory_order_relaxed);
  }

  // Loopback: a 16-sample click every 0.5 s on both outputs; the first input sample above
  // the threshold after a click (and before the next) is its arrival. Results go into a
  // fixed array; the main thread reads them after close().
  static const int kMaxHits = 512;
  int hits() const { return hits_.load(std::memory_order_acquire); }
  long long hit(int i) const { return hitFrames_[i]; }
  double inputPeak() { return inPeak_.exchange(0.0); }

 private:
  void loopback(const float* inL, const float* inR, float* outL, float* outR, uint32_t frames) {
    const long long interval = o_.rate / 2;
    for (uint32_t i = 0; i < frames; i++) {
      const long long t = pos_ + i;
      const long long ph = t % interval;
      const float c = (t >= interval && ph < 16) ? 0.5f : 0.0f;
      outL[i] = c;
      outR[i] = c;
      if (t >= interval && ph == 0) {
        sentAt_ = t;
        armed_ = true;
      }
      if (armed_ && t > sentAt_ && (std::fabs(inL[i]) > 0.05f || std::fabs(inR[i]) > 0.05f)) {
        armed_ = false;
        const int n = hits_.load(std::memory_order_relaxed);
        if (n < kMaxHits) {
          hitFrames_[n] = t - sentAt_;
          hits_.store(n + 1, std::memory_order_release);
        }
      }
    }
  }

  struct Fx {
    void* mem = nullptr;
    float* st = nullptr;
  };
  const Options& o_;
  bk_engine e_{};
  float* storage_ = nullptr;
  std::vector<Fx> fx_;
  std::vector<float> scratchL_, scratchR_;
  bool ok_ = false;
  double phase_ = 0.0;
  long long pos_ = 0, sentAt_ = 0;
  bool armed_ = false;
  long long hitFrames_[kMaxHits] = {};
  std::atomic<int> hits_{0};
  std::atomic<double> inPeak_{0.0};
};

double dbfs(double x) { return x > 0 ? 20.0 * std::log10(x) : -999.0; }

void printStatus(const brokodr::StreamStatus& s) {
  std::printf("  mode              %s%s\n", brokodr::driverName(s.kind),
              s.exclusiveDenied ? "  (exclusive was requested and REFUSED)" : "");
  std::printf("  output            %s\n", s.outputName.c_str());
  std::printf("  input             %s\n", s.inputName.c_str());
  std::printf("  format            %s @ %u Hz\n", s.format.c_str(), s.sampleRate);
  std::printf("  engine block      %u frames (%.2f ms)\n", s.blockFrames, 1000.0 * s.blockFrames / s.sampleRate);
  std::printf("  device period     %u frames (%.2f ms)\n", s.periodFrames, 1000.0 * s.periodFrames / s.sampleRate);
  std::printf("  device buffer     %u frames (%.2f ms)\n", s.bufferFrames, 1000.0 * s.bufferFrames / s.sampleRate);
  std::printf("  est. round trip   %.2f ms (estimate: buffers + FIFO, not measured)\n", s.estimatedRoundTripMs);
  std::printf("  note              %s\n", s.note.c_str());
}

void printCounters(const brokodr::StreamStatus& s, double secs) {
  std::printf("  callbacks         %llu (%.1f/s)\n", static_cast<unsigned long long>(s.callbacks),
              secs > 0 ? s.callbacks / secs : 0.0);
  std::printf("  slowest callback  %.0f us (budget %.0f us per period)\n", s.maxCallbackUs,
              s.sampleRate ? 1e6 * s.periodFrames / s.sampleRate : 0.0);
  std::printf("  underruns         %llu\n", static_cast<unsigned long long>(s.underruns));
  std::printf("  capture glitches  %llu\n", static_cast<unsigned long long>(s.captureGlitches));
  std::printf("  input underflow   %llu frames\n", static_cast<unsigned long long>(s.inputUnderflowFrames));
  std::printf("  input dropped     %llu frames\n", static_cast<unsigned long long>(s.inputDroppedFrames));
  if (s.inputName == "(none)")
    std::printf("  input start       no input opened\n");
  else
    std::printf("  input start       %s after %.0f ms of output\n", s.inputStarted ? "started" : "NEVER STARTED",
                s.inputWarmupMs);
}

#ifdef _WIN32
int runMode(const Options& o, bool exclusive, const std::string& inId, const std::string& outId) {
  std::printf("\n== %s, %u frames, %.1f s%s ==\n", exclusive ? "exclusive" : "shared", o.frames, o.seconds,
              o.fx.empty() ? "" : ", with effects");
  std::string err;
  ProbeSink sink(o, err);
  if (!sink.ok()) return std::printf("  FAIL engine: %s\n", err.c_str()), 1;
  if (sink.engineLatency()) std::printf("  engine latency    %d frames (from the effects)\n", sink.engineLatency());
  brokodr::Device* dev = brokodr::makeWasapiDriver();
  brokodr::StreamConfig cfg;
  cfg.sampleRate = o.rate;
  cfg.blockFrames = o.frames;
  cfg.kind = exclusive ? brokodr::DriverKind::WasapiExclusive : brokodr::DriverKind::WasapiShared;
  cfg.wantExclusive = exclusive;
  cfg.inputId = inId;
  cfg.outputId = outId;
  if (o.mic > 0) cfg.inputChannelL = cfg.inputChannelR = static_cast<uint32_t>(o.mic - 1);
  const auto t0 = std::chrono::steady_clock::now();
  if (!dev->open(cfg, &sink, err)) {
    std::printf("  FAIL open: %s\n", err.c_str());
    delete dev;
    return 1;
  }
  const double openMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  printStatus(dev->status());
  std::printf("  open took         %.0f ms\n", openMs);
  const int ticks = static_cast<int>(std::ceil(o.seconds));
  uint64_t lastUnder = 0;
  for (int k = 0; k < ticks; k++) {
    std::this_thread::sleep_for(std::chrono::milliseconds(static_cast<int>(1000.0 * o.seconds / ticks)));
    const brokodr::StreamStatus s = dev->status();
    std::printf("  t=%2ds  callbacks %7llu  slowest %5.0f us  underruns %llu%s  input peak %6.1f dBFS%s\n", k + 1,
                static_cast<unsigned long long>(s.callbacks), s.maxCallbackUs,
                static_cast<unsigned long long>(s.underruns), s.underruns > lastUnder ? " (+)" : "",
                dbfs(sink.inputPeak()), s.open ? "" : "  STREAM CLOSED");
    lastUnder = s.underruns;
    if (!s.open) break;
  }
  const brokodr::StreamStatus s = dev->status();
  dev->close();
  delete dev;
  printCounters(s, o.seconds);
  int rc = s.callbacks == 0 ? 1 : 0;
  if (s.callbacks == 0) std::printf("  FAIL no callbacks — the device never asked for audio\n");
  if (o.loopback) {
    const int n = sink.hits();
    if (n == 0) {
      std::printf("  loopback          no clicks came back (cable / routing from output to input?)\n");
    } else {
      std::vector<long long> v;
      for (int i = 0; i < n; i++) v.push_back(sink.hit(i));
      std::sort(v.begin(), v.end());
      const double ms = 1000.0 / o.rate;
      std::printf("  MEASURED round trip  median %.2f ms  (min %.2f, max %.2f, %d clicks, %lld..%lld frames)\n",
                  v[v.size() / 2] * ms, v.front() * ms, v.back() * ms, n, v.front(), v.back());
      if (v.back() - v.front() > 2) std::printf("  note: the round trip moved by %lld frames during the run\n",
                                                v.back() - v.front());
    }
  }
  std::printf("  verdict           %s\n", s.underruns == 0 && s.captureGlitches == 0 && s.callbacks > 0 &&
                                                      s.inputStarted && s.inputUnderflowFrames == 0
                                              ? "clean"
                                              : s.callbacks == 0      ? "no audio"
                                              : !s.inputStarted        ? "INPUT NEVER STARTED"
                                                                       : "GLITCHES — see counters");
  return rc;
}
#endif

}  // namespace

int main(int argc, char** argv) {
  Options o;
  if (!parse(argc, argv, o)) {
    usage();
    return 2;
  }
#ifndef _WIN32
  std::printf("brokodr-probe drives the WASAPI driver and runs on Windows only.\n");
  return 2;
#else
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  std::printf("brokodr-probe (Bro.Kodr native audio, phase 5b)\n");
  brokodr::Device* lister = brokodr::makeWasapiDriver();
  const std::vector<brokodr::DeviceInfo> devs = lister->enumerate();
  delete lister;
  std::printf("\nendpoints (%zu):\n", devs.size());
  for (size_t i = 0; i < devs.size(); i++) {
    const auto& d = devs[i];
    std::printf("  [%2zu] %-6s %s%s  %u ch @ %u Hz%s%s\n", i, d.inputChannels ? "in" : "out", d.name.c_str(),
                d.isDefault ? "  (default)" : "", d.inputChannels ? d.inputChannels : d.outputChannels,
                d.defaultSampleRate, d.pairLabel.empty() ? "" : "  pair: ", d.pairLabel.c_str());
  }
  if (o.list) {
    std::printf("\nids:\n");
    for (size_t i = 0; i < devs.size(); i++) std::printf("  [%2zu] %s\n", i, devs[i].id.c_str());
    return 0;
  }
  std::string inId, outId, err;
  if (!resolve(devs, o.in, true, inId, err) || !resolve(devs, o.out, false, outId, err)) {
    std::printf("FAIL %s\n", err.c_str());
    return 2;
  }
  std::printf("\nengine output %s%s%s\n", o.monitor ? "MONITORED (audible)" : "muted (pass --monitor to hear it)",
              o.tone ? ", test tone on" : "", o.loopback ? ", loopback click train" : "");
  int rc = 0;
  if (o.shared) rc |= runMode(o, false, inId, outId);
  if (o.exclusive) rc |= runMode(o, true, inId, outId);
  std::printf("\ndone. Paste everything above back into the chat.\n");
  return rc;
#endif
}
