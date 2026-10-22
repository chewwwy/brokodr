// Bro.Kodr — the engine host: everything between a control thread and the audio callback.
//
// PHASE 5b. The AudioWorklet adapter (worklet-processor.js) does four jobs around the
// engine: it drains the command ring, applies structural messages, and publishes meters,
// scope and the recording through shared memory. Host is the native version of that
// adapter, so the N-API addon, the probe and any later plugin build share one
// implementation of it. Host is a RenderSink: a Device calls render() on its audio thread.
//
// Threads. Exactly two touch a Host. The CONTROL thread (Electron's main thread, a test)
// calls everything except render(); the AUDIO thread calls render(). Without a device the
// control thread may call pump() to apply what is queued; render() and pump() must never
// run at the same time, which is the device owner's job (open/close order), not Host's.
//
// What crosses, and how:
//   hot ops      command(): the CommandRing, same opcodes and fields as the worklet's
//                #applyOp. Allocation-free on both sides.
//   structural   post*(): a Msg built on the control thread, carrying anything it needs
//                already constructed (an effect, a copied sample buffer), sent through an
//                SPSC pointer ring. The audio thread splices it in, then hands the Msg
//                back through a second ring together with every object the engine no
//                longer references, and the control thread frees them in collect().
//                "No longer referenced" is decided by a mark-and-sweep over the engine's
//                own pointers (chains, pad layers, the file player) after each message,
//                so remove, clear, padclear, a rejected add, a pad layer replaced by a
//                newer load, and every case the JS GC covers silently are all one rule.
//   ordering     every Msg carries the ring's write index at post time as a fence; the
//                audio thread drains ring ops up to the fence before applying the Msg.
//                Control order is preserved exactly. (The worklet applies port messages
//                as they arrive and drains the ring at the next block, so an op pushed
//                before a message can land after it there. Native is stricter.)
//   meters       a seqlock'd block of BK_METER_FIELDS doubles, written once per render,
//                the worklet's slots 10/13/14/15 included (load, recording, rec write,
//                rec overflow). readMeters() returns false on a torn read.
//   scope        BK_SCOPE_SIZE mono floats of input and output and a write index.
//   recording    a preallocated circular wet (and dry) take with a monotonic frame
//                counter, the SAB contract: the control thread drains it on a timer.
//   pulls        getvisual / getlooppeaks / getvoicecaps / the chain reports: one
//                request at a time, answered by the audio thread into a preallocated
//                reply. pullBegin() then pullPoll() until it returns true; nothing waits.
//                Loop peaks are scanned in slices (kPeakSliceFrames per render), since a
//                30-second track is 1.4 M samples and the worklet's one-shot scan would
//                cost a native callback its whole budget.
//
// render() never allocates, frees, locks, logs or throws (tests/test-host.cc counts it).

#ifndef BROKODR_HOST_H
#define BROKODR_HOST_H

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

#include "brokodr/device.h"
#include "brokodr/dsp/engine.h"
#include "brokodr/layout.h"
#include "brokodr/ring.h"

namespace brokodr {

/** SPSC ring of pointers. Same counter discipline as CommandRing; N is a power of two. */
template <typename T, uint32_t N>
class PtrRing {
  static_assert((N & (N - 1)) == 0, "PtrRing size must be a power of two");

 public:
  PtrRing() {
    for (uint32_t i = 0; i < N; i++) slots_[i].store(nullptr, std::memory_order_relaxed);
  }
  bool push(T* p) {
    const uint64_t w = write_.load(std::memory_order_relaxed);
    if (w - read_.load(std::memory_order_acquire) >= N) return false;
    slots_[w & (N - 1)].store(p, std::memory_order_relaxed);
    write_.store(w + 1, std::memory_order_release);
    return true;
  }
  T* peek() const {
    const uint64_t r = read_.load(std::memory_order_relaxed);
    if (r == write_.load(std::memory_order_acquire)) return nullptr;
    return slots_[r & (N - 1)].load(std::memory_order_relaxed);
  }
  void drop() { read_.store(read_.load(std::memory_order_relaxed) + 1, std::memory_order_release); }
  T* pop() {
    T* p = peek();
    if (p) drop();
    return p;
  }
  uint64_t writeIndex() const { return write_.load(std::memory_order_acquire); }
  uint64_t readIndex() const { return read_.load(std::memory_order_acquire); }

 private:
  alignas(64) std::atomic<uint64_t> write_{0};
  alignas(64) std::atomic<uint64_t> read_{0};
  alignas(64) std::atomic<T*> slots_[N];
};

/** The structural verbs: engine.js applyCommand's, numeric, plus the adapter's own. */
enum class Verb : int32_t {
  FxAdd = 0,  // target, index, id, a = position (NaN append); the effect rides in the Msg
  FxRemove,   // target, index, id
  FxMove,     // target, index, id, a = position
  FxParam,    // target, index, id, key, a
  FxMix,      // target, index, id, a
  FxBypass,   // target, index, id, a
  FxReset,    // target, index, id
  FxClear,    // target, index
  Io,         // key = BK_IO_*, a
  FileLoad,   // a = rate; the buffer rides in the Msg
  FileClear,
  FileParam,  // key = BK_FILE_P_*, a
  FileRoute,  // a
  Pad,        // index, a = velocity
  PadOff,     // index
  PadParam,   // index, key = BK_PAD_P_*, a
  PadLoad,    // index, a = layer, b = rate; the buffer rides in the Msg. reply[0] = layers
  PadClear,   // index
  Drum,       // key = BK_DRUM_P_*, a
  DrumReset,
  Loop,       // key = BK_LOOPOP_*, index
  LoopParam,  // index, key = BK_LOOP_P_*, a
  LooperParam,  // key, a
  Voice,      // key, a
  VoiceCal,   // key = BK_VOICECAL_*, a = cls, b = arg, c = value
  Clock,      // key, a
  ClipReset,
  Panic,
  RecState,   // a = recording, b = paused, c = reset (each 0/1)
  Count
};

struct Call {
  Verb verb = Verb::Panic;
  int32_t target = BK_TARGET_MASTER;
  int32_t id = 0;
  int32_t key = 0;
  double index = 0.0;
  double a = 0.0, b = 0.0, c = 0.0;
};

/** What a pull asks for. */
enum class PullKind : int32_t {
  None = 0,
  Visual,     // id: master slot id. Reply: the EQ curve or the vocoder ladder; count -1 = null
  LoopPeaks,  // index: track, arg: buckets. Reply: [lo, hi] * buckets; count -1 = null
  VoiceCaps,  // arg: from, arg2: max. Reply: rows; meta = from, total, stride
  Chain,      // target, index. Reply: (id, type, bypassed) * n; meta[0] = latency (master)
};

struct HostOptions {
  double sampleRate = 48000.0;
  /** The engine's max block. 512 is the worklet's; render() chunks longer callbacks. */
  int maxBlock = 512;
  /** Take ring capacity in stereo frames; 0 means two seconds, the worklet's headroom. */
  uint32_t recordFrames = 0;
  /** Seed for the xorshift32 every effect draws from (the JS uses Math.random). */
  uint32_t seed = 0x2545f491u;
};

struct HostStats {
  uint64_t renders = 0;
  uint64_t frames = 0;
  uint64_t commandsDropped = 0;
  uint64_t messagesPosted = 0;
  uint64_t messagesApplied = 0;
  uint64_t objectsFreed = 0;
  uint64_t liveObjects = 0;
  double loadAvg = 0.0;
};

class Host final : public RenderSink {
 public:
  static constexpr uint32_t kMailbox = 256;
  static constexpr uint32_t kMsgsPerRender = 64;
  static constexpr uint32_t kPeakSliceFrames = 32768;
  static constexpr uint32_t kPullCapacity = 8192;  // doubles: 4096 peak buckets * 2

  /** Builds the engine and its ~58 MB of storage. Returns null (and why) on failure. */
  static std::unique_ptr<Host> create(const HostOptions& opt, std::string& error);
  ~Host() override;
  Host(const Host&) = delete;
  Host& operator=(const Host&) = delete;

  // ------------------------------------------------------------ control thread

  /** A hot op, exactly the worklet ring's six fields. False when the ring was full. */
  bool command(double op, double id, double key, double value, double aux1 = 0.0, double aux2 = 0.0);

  /** A structural verb with no payload. False when the mailbox is full. */
  bool post(const Call& c);
  /**
   * Insert an effect: built here (struct, storage, random source, then `n` initial params
   * as param-keys.h indices in the order given), spliced on the audio thread. `type` is
   * a bk_effect_type; a bad one returns false with nothing posted, the JS's
   * createEffect-returned-null path. `position` NaN appends. `mix` NaN keeps the default;
   * `bypassed` < 0 keeps it.
   */
  bool postFxAdd(int target, double index, int type, int id, double position, const int* keys,
                 const double* values, int n, double mix, int bypassed);
  /**
   * Group what is posted between these two calls into one unit the audio thread applies
   * between two blocks, as the worklet applies one "cmds" list (setChain is a clear plus
   * N adds, and the user must not hear the rack rebuild one slot per callback). A batch
   * counts as one mailbox entry. Ring ops pushed while a batch is open land before it.
   * batchEnd() returns false (and frees the batch) when the mailbox was full.
   */
  void batchBegin();
  bool batchEnd();

  /** Copies the samples. `r` null means mono (both channels read `l`). */
  bool postFileLoad(const float* l, const float* r, int frames, double rate);
  bool postPadLoad(double index, double layer, const float* data, int frames, double rate);

  /**
   * Frees what the audio thread has handed back. Call it regularly (each meter poll is
   * fine); the post functions call it too. Returns how many messages came back. For each
   * returned message, `onReply(user, call, reply0)` runs (PadLoad: the pad's layer count).
   */
  using ReplyFn = void (*)(void* user, const Call& call, double reply0);
  uint32_t collect(ReplyFn onReply = nullptr, void* user = nullptr);

  /** Apply what is queued, on this thread, when no device is rendering. */
  void pump();

  /** Torn-read-safe copy of the meter block (BK_METER_FIELDS doubles). */
  bool readMeters(double* out) const;
  /** The newest `n` (<= BK_SCOPE_SIZE) scope frames, oldest first. Returns the write index. */
  uint32_t readScope(float* in, float* out, uint32_t n) const;

  /**
   * Copy take frames from absolute frame `from` on, at most `max`. Returns frames copied;
   * `total` gets the take length so far. When the reader fell more than the ring behind,
   * `from` is moved up to the oldest frame still held and `lost` counts the gap.
   */
  uint32_t readRecording(uint64_t& from, float* wetInterleaved, float* dryInterleaved, uint32_t max,
                         uint64_t& total, uint64_t& lost) const;
  uint32_t recordCapacity() const { return recCap_; }

  /** Start a pull. False while one is still in flight. */
  bool pullBegin(PullKind kind, int target, double index, int id, double arg, double arg2);
  /**
   * True once answered: `count` values in `values` (-1 for the JS's null), `meta` 4
   * doubles. The pull slot is free again after this returns true.
   */
  bool pullPoll(double* values, int32_t& count, double* meta);

  HostStats stats() const;
  double sampleRate() const { return sr_; }
  int maxBlock() const { return maxBlock_; }

  // ------------------------------------------------------------ audio thread

  void render(const float* const* in, uint32_t inChannels, float* const* out, uint32_t outChannels,
              uint32_t frames) override;

  /** Test hook: the engine, for reading state back. Control thread, nothing rendering. */
  bk_engine* engineForTest() { return &e_; }

  struct Owned;
  struct Msg;

 private:
  Host() = default;
  bool init(const HostOptions& opt, std::string& error);
  bool postMsg(Msg* m);
  void applyOp(const Command& c);
  void applyMsg(Msg* m);
  void applyOne(Msg* m);
  void sweep(Msg* to);
  void runPull(bool unbounded);
  void drainControl(bool unbounded);
  void publish(const float* inL, const float* inR, const float* outL, const float* outR, uint32_t n);
  void publishMeters();
  void freeMsg(Msg* m);
  void freeOwned(Owned* o);

  double sr_ = 48000.0;
  int maxBlock_ = 512;
  bk_engine e_{};
  float* storage_ = nullptr;
  uint32_t seed_ = 0;  // audio thread only, through the effects' random source

  CommandRing ring_;
  PtrRing<Msg, kMailbox> mailbox_;
  PtrRing<Msg, kMailbox> returns_;
  uint64_t outstanding_ = 0;  // control: posted - collected; never more than kMailbox

  Owned* live_ = nullptr;  // audio thread: every object the engine may reference

  // silence / scratch for missing channels, maxBlock each
  float* silent_ = nullptr;
  float* scratch_ = nullptr;

  // meters
  alignas(64) std::atomic<uint32_t> meterSeq_{0};
  std::atomic<double> meters_[BK_METER_FIELDS];
  double meterScratch_[BK_METER_FIELDS] = {};

  // scope
  std::atomic<float>* scopeIn_ = nullptr;
  std::atomic<float>* scopeOut_ = nullptr;
  std::atomic<uint32_t> scopeWrite_{0};

  // recording (audio-thread state, published through recWrite_)
  std::atomic<float>* recWet_ = nullptr;
  std::atomic<float>* recDry_ = nullptr;
  uint32_t recCap_ = 0;
  std::atomic<uint64_t> recWrite_{0};
  // Claimed before a block's frames are stored, so a reader that saw any of them sees the claim.
  std::atomic<uint64_t> recClaim_{0};
  int recording_ = 0, recPaused_ = 0;
  double recOverflow_ = 0.0;

  // load
  double loadAvg_ = 0.0;
  double blockPeriodUs_ = 0.0;

  // pull: state 0 idle, 1 posted (control -> audio), 2 answered (audio -> control)
  std::atomic<int> pullState_{0};
  PullKind pullKind_ = PullKind::None;
  int pullTarget_ = 0, pullId_ = 0;
  double pullIndex_ = 0.0, pullArg_ = 0.0, pullArg2_ = 0.0;
  int32_t pullCount_ = 0;
  double pullMeta_[4] = {};
  double* pullValues_ = nullptr;
  // loop-peak scan cursor, audio thread
  int peakBucket_ = 0, peakBuckets_ = 0, peakFrames_ = 0, peakTrack_ = 0;

  // sweep scratch, audio thread: every pointer the engine may hold, sorted per sweep
  const void** refs_ = nullptr;
  uint32_t refsCap_ = 0;
  uint64_t liveN_ = 0;

  // batching, control thread
  Msg* batchHead_ = nullptr;
  Msg* batchTail_ = nullptr;
  bool batching_ = false;

  // stats
  std::atomic<uint64_t> renders_{0}, frames_{0}, applied_{0};
  std::atomic<double> loadPub_{0.0};
  std::atomic<uint64_t> liveCount_{0};
  uint64_t posted_ = 0, freed_ = 0;
};

}  // namespace brokodr

#endif  // BROKODR_HOST_H
