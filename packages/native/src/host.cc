// Bro.Kodr — the engine host. See host.h for the threading contract.
//
// Everything below the "audio thread" line runs inside render(): no allocation, no
// free, no lock, no log, no throw. The control-thread half allocates freely and hands
// finished objects across.

#include "brokodr/host.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <new>

#include "brokodr/dsp/eq.h"
#include "brokodr/dsp/onset.h"
#include "brokodr/dsp/vocoder.h"

namespace brokodr {

static_assert(BK_ENGINE_METER_COUNT <= BK_METER_FIELDS, "the engine writes past the shared meter block");
static_assert(BK_VOICE_CAP_SLOTS * BK_VOICE_CAP_STRIDE <= Host::kPullCapacity, "voice capture pull overflows");
static_assert(BK_EQ_CURVE_POINTS <= Host::kPullCapacity, "EQ visual pull overflows");
static_assert(BK_CHAIN_MAX_SLOTS * 3 <= Host::kPullCapacity, "chain report pull overflows");
static_assert(4096 * 2 <= Host::kPullCapacity, "loop peak pull overflows");

// Every pointer the engine can hold to something a Host owns: the master chain, 16 pad
// chains and 4 loop-track chains (BK_CHAIN_MAX_SLOTS each), 16 pads x 4 layers, and the
// file player's left channel (its right is the same allocation's sibling, see Owned).
static constexpr uint32_t kMaxRefs =
    (1 + BK_PAD_COUNT + BK_LOOP_TRACKS) * BK_CHAIN_MAX_SLOTS + BK_PAD_COUNT * BK_DRUM_MAX_LAYERS + 1;

/**
 * One allocation the engine may point at. `key` is the pointer the engine stores (an
 * effect struct, a sample buffer's first float); `a` and `b` are what to free.
 */
struct Host::Owned {
  Owned* next = nullptr;
  const void* key = nullptr;
  void* a = nullptr;
  void* b = nullptr;
};

struct Host::Msg {
  Call call;
  uint64_t fence = 0;
  Msg* next = nullptr;      // the rest of a batch
  Owned* carry = nullptr;   // installed by this message; joins live_ when applied
  Owned* freed = nullptr;   // on the way back: what the audio thread detached
  // FxAdd
  const bk_effect_vt* vt = nullptr;
  int fxType = -1;
  double mix = NAN;
  int bypassed = -1;
  // FileLoad / PadLoad
  const float* l = nullptr;
  const float* r = nullptr;
  int frames = 0;
  // PadLoad: the pad's layer count after the load, the worklet's "padready".layers
  double reply0 = 0.0;
};

// ------------------------------------------------------------------ helpers

namespace {

// The battery's random source (tests/null-driver.cc, verify-null-driver.mjs): xorshift32
// over one seed shared by every effect, the native stand-in for the JS's one Math.random.
double xorshiftRandom(void* user) {
  uint32_t* seed = static_cast<uint32_t*>(user);
  uint32_t x = *seed;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  *seed = x;
  return static_cast<double>(x) / 4294967296.0;
}

// `x | 0`.
inline int i32(double x) { return bk_onset_to_int32(x); }

// A JS `===` match against an int slot id or table index: true only for an integral
// double in int range (-0 included, as -0 === 0).
inline bool exactInt(double x, int& out) {
  if (!(x >= -2147483648.0 && x <= 2147483647.0)) return false;  // NaN fails too
  const double t = std::trunc(x);
  if (t != x) return false;
  out = static_cast<int>(t);
  return true;
}

// A chain insert position as splice() reads clamp(pos, 0, len): truncated, NaN 0. The
// chain clamps the int itself.
inline int position(double x) {
  if (std::isnan(x)) return 0;
  if (x >= 2147483647.0) return 2147483647;
  if (x <= -2147483647.0) return -2147483647;
  return static_cast<int>(std::trunc(x));
}

inline double flag(double v) { return v >= 0.5 ? 1.0 : 0.0; }

void* zalloc(size_t n) { return std::calloc(n ? n : 1, 1); }

}  // namespace

// ------------------------------------------------------------------ lifetime

std::unique_ptr<Host> Host::create(const HostOptions& opt, std::string& error) {
  std::unique_ptr<Host> h(new (std::nothrow) Host());
  if (!h) {
    error = "out of memory";
    return nullptr;
  }
  if (!h->init(opt, error)) return nullptr;
  return h;
}

bool Host::init(const HostOptions& opt, std::string& error) {
  if (!(opt.sampleRate >= 8000.0 && opt.sampleRate <= 384000.0)) {
    error = "sample rate out of range";
    return false;
  }
  if (opt.maxBlock < 1 || opt.maxBlock > 8192) {
    error = "max block out of range";
    return false;
  }
  sr_ = opt.sampleRate;
  maxBlock_ = opt.maxBlock;
  seed_ = opt.seed;

  storage_ = static_cast<float*>(std::calloc(bk_engine_storage_floats(sr_, maxBlock_), sizeof(float)));
  if (!storage_) {
    error = "out of memory (engine storage)";
    return false;
  }
  if (bk_engine_init(&e_, sr_, maxBlock_, storage_) != 0) {
    error = "engine refused the sample rate / block size";
    return false;
  }

  const size_t mb = static_cast<size_t>(maxBlock_);
  silent_ = static_cast<float*>(std::calloc(mb, sizeof(float)));
  scratch_ = static_cast<float*>(std::calloc(mb * 2, sizeof(float)));

  scopeIn_ = new (std::nothrow) std::atomic<float>[BK_SCOPE_SIZE];
  scopeOut_ = new (std::nothrow) std::atomic<float>[BK_SCOPE_SIZE];

  recCap_ = opt.recordFrames ? opt.recordFrames : static_cast<uint32_t>(std::ceil(sr_ * 2.0));
  recWet_ = new (std::nothrow) std::atomic<float>[static_cast<size_t>(recCap_) * 2];
  recDry_ = new (std::nothrow) std::atomic<float>[static_cast<size_t>(recCap_) * 2];

  pullValues_ = new (std::nothrow) double[kPullCapacity];
  refsCap_ = kMaxRefs;
  refs_ = new (std::nothrow) const void*[refsCap_];

  if (!silent_ || !scratch_ || !scopeIn_ || !scopeOut_ || !recWet_ || !recDry_ || !pullValues_ || !refs_) {
    error = "out of memory (host buffers)";
    return false;
  }
  for (uint32_t i = 0; i < BK_SCOPE_SIZE; i++) {
    scopeIn_[i].store(0.0f, std::memory_order_relaxed);
    scopeOut_[i].store(0.0f, std::memory_order_relaxed);
  }
  for (size_t i = 0; i < static_cast<size_t>(recCap_) * 2; i++) {
    recWet_[i].store(0.0f, std::memory_order_relaxed);
    recDry_[i].store(0.0f, std::memory_order_relaxed);
  }
  for (uint32_t i = 0; i < BK_METER_FIELDS; i++) meters_[i].store(0.0, std::memory_order_relaxed);
  return true;
}

Host::~Host() {
  // The device is closed (the owner's job), so this thread may play both sides.
  collect();
  while (Msg* m = mailbox_.pop()) freeMsg(m);
  if (batchHead_) freeMsg(batchHead_);
  while (live_) {
    Owned* o = live_;
    live_ = o->next;
    freeOwned(o);
  }
  delete[] refs_;
  delete[] pullValues_;
  delete[] recDry_;
  delete[] recWet_;
  delete[] scopeOut_;
  delete[] scopeIn_;
  std::free(scratch_);
  std::free(silent_);
  std::free(storage_);
}

void Host::freeOwned(Owned* o) {
  std::free(o->a);
  std::free(o->b);
  delete o;
}

void Host::freeMsg(Msg* m) {
  while (m) {
    Msg* next = m->next;
    for (Owned* o = m->carry; o;) {
      Owned* n = o->next;
      freeOwned(o);
      o = n;
    }
    for (Owned* o = m->freed; o;) {
      Owned* n = o->next;
      freeOwned(o);
      freed_++;
      o = n;
    }
    delete m;
    m = next;
  }
}

// ------------------------------------------------------------------ control thread

bool Host::command(double op, double id, double key, double value, double aux1, double aux2) {
  return ring_.push(op, id, key, value, aux1, aux2);
}

bool Host::postMsg(Msg* m) {
  if (batching_) {
    if (batchTail_) batchTail_->next = m;
    else batchHead_ = m;
    batchTail_ = m;
    return true;
  }
  collect();
  if (outstanding_ >= kMailbox) {
    freeMsg(m);
    return false;
  }
  m->fence = ring_.writeIndex();
  if (!mailbox_.push(m)) {  // cannot happen while outstanding_ < kMailbox
    freeMsg(m);
    return false;
  }
  outstanding_++;
  posted_++;
  return true;
}

void Host::batchBegin() { batching_ = true; }

bool Host::batchEnd() {
  batching_ = false;
  Msg* head = batchHead_;
  batchHead_ = batchTail_ = nullptr;
  if (!head) return true;
  return postMsg(head);
}

bool Host::post(const Call& c) {
  if (c.verb == Verb::FxAdd || c.verb == Verb::FileLoad || c.verb == Verb::PadLoad) return false;  // payload verbs
  if (static_cast<int32_t>(c.verb) < 0 || c.verb >= Verb::Count) return false;
  Msg* m = new (std::nothrow) Msg();
  if (!m) return false;
  m->call = c;
  return postMsg(m);
}

bool Host::postFxAdd(int target, double index, int type, int id, double position, const int* keys,
                     const double* values, int n, double mix, int bypassed) {
  const size_t sz = bk_effect_size(type);
  if (sz == 0) return false;  // createEffect returned null: nothing is posted
  const size_t nf = bk_effect_storage_floats(type, sr_, maxBlock_);
  Owned* o = new (std::nothrow) Owned();
  Msg* m = o ? new (std::nothrow) Msg() : nullptr;
  if (!m) {
    delete o;
    return false;
  }
  o->a = zalloc(sz);
  o->b = nf ? std::calloc(nf, sizeof(float)) : nullptr;
  const bk_effect_vt* vt =
      (o->a && (nf == 0 || o->b)) ? bk_effect_create(type, o->a, static_cast<float*>(o->b), sr_, maxBlock_) : nullptr;
  if (!vt) {
    freeOwned(o);
    delete m;
    return false;
  }
  bk_effect_set_random(type, o->a, xorshiftRandom, &seed_);
  // chain.js add(): params first, in the order given, before mix and bypass.
  const int count = bk_effect_param_count(type);
  for (int i = 0; i < n; i++) {
    if (keys[i] >= 0 && keys[i] < count) vt->set_param(o->a, keys[i], values[i]);
  }
  o->key = o->a;
  m->call.verb = Verb::FxAdd;
  m->call.target = target;
  m->call.index = index;
  m->call.id = id;
  m->call.a = position;
  m->carry = o;
  m->vt = vt;
  m->fxType = type;
  m->mix = mix;
  m->bypassed = bypassed;
  return postMsg(m);
}

bool Host::postFileLoad(const float* l, const float* r, int frames, double rate) {
  if (frames < 0 || (!l && frames > 0)) return false;
  Owned* o = new (std::nothrow) Owned();
  Msg* m = o ? new (std::nothrow) Msg() : nullptr;
  if (!m) {
    delete o;
    return false;
  }
  const size_t bytes = static_cast<size_t>(frames) * sizeof(float);
  o->a = zalloc(bytes);
  o->b = r ? zalloc(bytes) : nullptr;
  if (!o->a || (r && !o->b)) {
    freeOwned(o);
    delete m;
    return false;
  }
  if (bytes) {
    std::memcpy(o->a, l, bytes);
    if (r) std::memcpy(o->b, r, bytes);
  }
  o->key = o->a;  // the player's ch_l; ch_r is b, or a again for mono
  m->call.verb = Verb::FileLoad;
  m->call.a = rate;
  m->carry = o;
  m->l = static_cast<const float*>(o->a);
  m->r = r ? static_cast<const float*>(o->b) : m->l;
  m->frames = frames;
  return postMsg(m);
}

bool Host::postPadLoad(double index, double layer, const float* data, int frames, double rate) {
  if (frames < 0 || (!data && frames > 0)) return false;
  Owned* o = new (std::nothrow) Owned();
  Msg* m = o ? new (std::nothrow) Msg() : nullptr;
  if (!m) {
    delete o;
    return false;
  }
  const size_t bytes = static_cast<size_t>(frames) * sizeof(float);
  o->a = zalloc(bytes);
  if (!o->a) {
    freeOwned(o);
    delete m;
    return false;
  }
  if (bytes) std::memcpy(o->a, data, bytes);
  o->key = o->a;
  m->call.verb = Verb::PadLoad;
  m->call.index = index;
  m->call.a = layer;
  m->call.b = rate;
  m->carry = o;
  m->l = static_cast<const float*>(o->a);
  m->frames = frames;
  return postMsg(m);
}

uint32_t Host::collect(ReplyFn onReply, void* user) {
  uint32_t n = 0;
  while (Msg* m = returns_.pop()) {
    if (onReply) {
      for (Msg* x = m; x; x = x->next) onReply(user, x->call, x->reply0);
    }
    freeMsg(m);
    outstanding_--;
    n++;
  }
  return n;
}

void Host::pump() {
  drainControl(true);
  runPull(true);
}

bool Host::readMeters(double* out) const {
  for (int attempt = 0; attempt < 4; attempt++) {
    const uint32_t s1 = meterSeq_.load(std::memory_order_acquire);
    if (s1 & 1u) continue;
    // Acquire loads (no fence: TSan does not model fences). A field from a newer write
    // synchronises with its release store, so the re-read below sees that write's odd seq.
    for (uint32_t i = 0; i < BK_METER_FIELDS; i++) out[i] = meters_[i].load(std::memory_order_acquire);
    if (meterSeq_.load(std::memory_order_relaxed) == s1) return true;
  }
  return false;
}

uint32_t Host::readScope(float* in, float* out, uint32_t n) const {
  if (n > BK_SCOPE_SIZE) n = BK_SCOPE_SIZE;
  const uint32_t w = scopeWrite_.load(std::memory_order_acquire);
  const uint32_t mask = BK_SCOPE_SIZE - 1;
  const uint32_t start = (w - n) & mask;
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t idx = (start + i) & mask;
    if (in) in[i] = scopeIn_[idx].load(std::memory_order_relaxed);
    if (out) out[i] = scopeOut_[idx].load(std::memory_order_relaxed);
  }
  return w;
}

uint32_t Host::readRecording(uint64_t& from, float* wet, float* dry, uint32_t max, uint64_t& total,
                             uint64_t& lost) const {
  const uint64_t w = recWrite_.load(std::memory_order_acquire);
  total = w;
  if (from > w) from = w;  // a reset moved the take back to 0
  const uint64_t cap = recCap_;
  const uint64_t oldest = w > cap ? w - cap : 0;
  if (from < oldest) {
    lost += oldest - from;
    from = oldest;
  }
  uint64_t n = w - from;
  if (n > max) n = max;
  for (uint64_t i = 0; i < n; i++) {
    const size_t o = static_cast<size_t>(((from + i) % cap) * 2);
    if (wet) {
      wet[i * 2] = recWet_[o].load(std::memory_order_acquire);
      wet[i * 2 + 1] = recWet_[o + 1].load(std::memory_order_acquire);
    }
    if (dry) {
      dry[i * 2] = recDry_[o].load(std::memory_order_acquire);
      dry[i * 2 + 1] = recDry_[o + 1].load(std::memory_order_acquire);
    }
  }
  // Frames the writer lapped while we copied are not trustworthy: drop them as lost. The
  // writer claims a block before storing it, and a frame we read from that block synchronises
  // with its release store, so the claim covers every overwrite we could have seen.
  const uint64_t w2 = recClaim_.load(std::memory_order_relaxed);
  const uint64_t safe = w2 > cap ? w2 - cap : 0;
  if (w2 >= w && safe > from) {
    const uint64_t bad = std::min<uint64_t>(safe - from, n);
    if (bad) {
      if (wet) std::memmove(wet, wet + bad * 2, static_cast<size_t>((n - bad) * 2) * sizeof(float));
      if (dry) std::memmove(dry, dry + bad * 2, static_cast<size_t>((n - bad) * 2) * sizeof(float));
      lost += bad;
      from += bad;
      n -= bad;
    }
  }
  from += n;
  return static_cast<uint32_t>(n);
}

bool Host::pullBegin(PullKind kind, int target, double index, int id, double arg, double arg2) {
  if (kind == PullKind::None) return false;
  if (pullState_.load(std::memory_order_acquire) != 0) return false;
  pullKind_ = kind;
  pullTarget_ = target;
  pullIndex_ = index;
  pullId_ = id;
  pullArg_ = arg;
  pullArg2_ = arg2;
  pullCount_ = 0;
  for (double& v : pullMeta_) v = 0.0;
  peakBucket_ = -1;  // the audio thread sets the scan up on first sight
  pullState_.store(1, std::memory_order_release);
  return true;
}

bool Host::pullPoll(double* values, int32_t& count, double* meta) {
  if (pullState_.load(std::memory_order_acquire) != 2) return false;
  count = pullCount_;
  if (values && count > 0) std::memcpy(values, pullValues_, static_cast<size_t>(count) * sizeof(double));
  if (meta) std::memcpy(meta, pullMeta_, sizeof(pullMeta_));
  pullKind_ = PullKind::None;
  pullState_.store(0, std::memory_order_release);
  return true;
}

HostStats Host::stats() const {
  HostStats s;
  s.renders = renders_.load(std::memory_order_relaxed);
  s.frames = frames_.load(std::memory_order_relaxed);
  s.commandsDropped = ring_.dropped();
  s.messagesPosted = posted_;
  s.messagesApplied = applied_.load(std::memory_order_relaxed);
  s.objectsFreed = freed_;
  s.liveObjects = liveCount_.load(std::memory_order_relaxed);
  s.loadAvg = loadPub_.load(std::memory_order_relaxed);
  return s;
}

// ================================================================== audio thread

void Host::applyOp(const Command& c) {
  bk_engine* e = &e_;
  int op;
  if (!exactInt(c.op, op)) return;  // the worklet's switch is `===` on the opcode
  const double id = c.id, key = c.key, value = c.value, aux1 = c.aux1;
  switch (op) {
    case BK_OP_PARAM: {
      // slot.paramNames[key]: an exact index into the type's table, or nothing.
      int sid, k;
      if (!exactInt(id, sid) || !exactInt(key, k)) break;
      const bk_slot* s = bk_chain_find(&e->chain, sid);
      if (!s || k < 0 || k >= bk_effect_param_count(s->type)) break;
      bk_engine_fx_param(e, BK_TARGET_MASTER, 0.0, sid, k, value);  // recalcs on "quality"
      break;
    }
    case BK_OP_MIX: {
      int sid;
      if (exactInt(id, sid)) bk_engine_fx_mix(e, BK_TARGET_MASTER, 0.0, sid, value);
      break;
    }
    case BK_OP_BYPASS: {
      int sid;
      if (exactInt(id, sid)) bk_engine_fx_bypass(e, BK_TARGET_MASTER, 0.0, sid, flag(value));
      break;
    }
    case BK_OP_MOVE: {
      int sid;
      if (exactInt(id, sid)) bk_engine_fx_move(e, BK_TARGET_MASTER, 0.0, sid, i32(value));
      break;
    }
    case BK_OP_IO: {
      const int f = i32(key);
      switch (f) {
        case BK_IO_IN_GAIN:
        case BK_IO_OUT_GAIN:
        case BK_IO_MASTER_MIX: bk_engine_io(e, f, value); break;
        case BK_IO_MUTE:
        case BK_IO_BYPASS:
        case BK_IO_MONO:
        case BK_IO_SWAP: bk_engine_io(e, f, flag(value)); break;
        default: break;
      }
      break;
    }
    case BK_OP_CLIPRESET: bk_engine_clip_reset(e); break;
    case BK_OP_RESET: {
      int sid;
      if (exactInt(id, sid)) bk_engine_fx_reset(e, BK_TARGET_MASTER, 0.0, sid);
      break;
    }
    case BK_OP_PANIC: bk_engine_panic(e); break;
    case BK_OP_PAD: {
      const int f = i32(key);
      if (f == 0) bk_engine_pad(e, id, value);
      else if (f == 1) bk_engine_pad_off(e, id);
      else {
        const int k = i32(aux1);
        if (k >= 0 && k < BK_PAD_P_COUNT) bk_engine_pad_param(e, id, k, value);
      }
      break;
    }
    case BK_OP_DRUM: {
      const int k = i32(key);
      if (k >= 0 && k < BK_DRUM_P_COUNT) bk_engine_drum(e, k, value);
      break;
    }
    case BK_OP_PADFX:
    case BK_OP_LOOPFX: {
      // aux1 = pad / track, id = slot, key|0 = param. Straight to the effect, as the
      // worklet's slot.effect.setParam: no latency recalc on these chains.
      bk_chain* ch = bk_engine_chain(e, op == BK_OP_PADFX ? BK_TARGET_PAD : BK_TARGET_LOOP, aux1);
      int sid;
      if (!ch || !exactInt(id, sid)) break;
      const bk_slot* s = bk_chain_find(ch, sid);
      const int k = i32(key);
      if (s && k >= 0 && k < bk_effect_param_count(s->type)) bk_chain_set_param(ch, sid, k, value);
      break;
    }
    case BK_OP_LOOP: {
      const int f = i32(key);
      switch (f) {
        case BK_LOOPOP_REC:
        case BK_LOOPOP_PLAY:
        case BK_LOOPOP_STOP:
        case BK_LOOPOP_CLEAR:
        case BK_LOOPOP_UNDO: bk_engine_loop(e, f, id); break;
        case BK_LOOPOP_CLEARALL: bk_engine_loop(e, f, 0.0); break;
        default: {
          // LOOP_FIELD.PARAM, and, as the worklet's final `else`, any other field.
          const int k = i32(aux1);
          if (k >= 0 && k < BK_LOOP_P_COUNT) bk_engine_loop_param(e, id, k, value);
          break;
        }
      }
      break;
    }
    case BK_OP_LOOPER: {
      const int k = i32(key);
      if (k >= 0 && k < BK_LOOPER_P_COUNT) bk_engine_looper_param(e, k, value);
      break;
    }
    case BK_OP_CLOCK: {
      const int k = i32(key);
      if (k >= 0 && k < BK_CLOCK_P_COUNT) bk_engine_clock(e, k, value);
      break;
    }
    case BK_OP_VOICE: {
      const int k = i32(key);
      if (k >= 0 && k < BK_VOICE_PARAM_COUNT) bk_engine_voice(e, k, value);
      break;
    }
    case BK_OP_VOICECAL: {
      const int f = i32(key);
      const double cls = static_cast<double>(i32(id));
      switch (f) {
        case BK_VOICECAL_CENTROID:
        case BK_VOICECAL_ATTACK: bk_engine_voicecal(e, f, cls, static_cast<double>(i32(aux1)), value); break;
        case BK_VOICECAL_PAD: bk_engine_voicecal(e, f, cls, static_cast<double>(i32(value)), value); break;
        case BK_VOICECAL_CAPTURE: bk_engine_voicecal(e, f, static_cast<double>(i32(value)), 0.0, value); break;
        case BK_VOICECAL_CLEAR:
        case BK_VOICECAL_RESET:
        case BK_VOICECAL_DETRESET: bk_engine_voicecal(e, f, 0.0, 0.0, 0.0); break;
        default: break;
      }
      break;
    }
    case BK_OP_FILE: {
      const int f = i32(key);
      if (f == 8) bk_engine_file_route(e, value);
      else if (f >= 0 && f < BK_FILE_P_COUNT) bk_engine_file_param(e, f, value);
      break;
    }
    default: break;  // 9 (the removed REC_STATE) and anything unknown
  }
}

void Host::applyOne(Msg* m) {
  if (m->carry) {
    Owned* o = m->carry;
    m->carry = nullptr;
    o->next = live_;
    live_ = o;
    liveN_++;
  }
  bk_engine* e = &e_;
  const Call& c = m->call;
  switch (c.verb) {
    case Verb::FxAdd: {
      bk_slot_spec spec;
      spec.id = c.id;
      spec.type = m->fxType;
      // Master: the position (NaN appends, the JS's undefined). Pad / loop: cmd.index is
      // both the chain and the position (engine.h, "padfx / loopfx add").
      if (c.target == BK_TARGET_MASTER) spec.index = std::isnan(c.a) ? BK_CHAIN_APPEND : position(c.a);
      else spec.index = position(c.index);
      spec.mix = m->mix;
      spec.bypassed = m->bypassed < 0 ? BK_CHAIN_KEEP : (m->bypassed ? 1 : 0);
      spec.effect = live_->a;
      spec.vt = m->vt;
      bk_engine_fx_add(e, c.target, c.index, &spec);  // a rejected add is swept below
      break;
    }
    case Verb::FxRemove: bk_engine_fx_remove(e, c.target, c.index, c.id); break;
    case Verb::FxMove: bk_engine_fx_move(e, c.target, c.index, c.id, position(c.a)); break;
    case Verb::FxParam: bk_engine_fx_param(e, c.target, c.index, c.id, c.key, c.a); break;
    case Verb::FxMix: bk_engine_fx_mix(e, c.target, c.index, c.id, c.a); break;
    case Verb::FxBypass: bk_engine_fx_bypass(e, c.target, c.index, c.id, c.a); break;
    case Verb::FxReset: bk_engine_fx_reset(e, c.target, c.index, c.id); break;
    case Verb::FxClear: bk_engine_fx_clear(e, c.target, c.index); break;
    case Verb::Io: bk_engine_io(e, c.key, c.a); break;
    case Verb::FileLoad: bk_engine_file_load(e, m->l, m->r, m->frames, c.a); break;
    case Verb::FileClear: bk_engine_file_clear(e); break;
    case Verb::FileParam: bk_engine_file_param(e, c.key, c.a); break;
    case Verb::FileRoute: bk_engine_file_route(e, c.a); break;
    case Verb::Pad: bk_engine_pad(e, c.index, c.a); break;
    case Verb::PadOff: bk_engine_pad_off(e, c.index); break;
    case Verb::PadParam: bk_engine_pad_param(e, c.index, c.key, c.a); break;
    case Verb::PadLoad: {
      bk_engine_pad_load(e, c.index, c.a, m->l, m->frames, c.b);
      const bk_drum_voice* v = bk_drum_rack_pad(&e->drums, i32(c.index));
      m->reply0 = v ? static_cast<double>(v->layer_count) : 0.0;
      break;
    }
    case Verb::PadClear: bk_engine_pad_clear(e, c.index); break;
    case Verb::Drum: bk_engine_drum(e, c.key, c.a); break;
    case Verb::DrumReset: bk_engine_drum_reset(e); break;
    case Verb::Loop: bk_engine_loop(e, c.key, c.index); break;
    case Verb::LoopParam: bk_engine_loop_param(e, c.index, c.key, c.a); break;
    case Verb::LooperParam: bk_engine_looper_param(e, c.key, c.a); break;
    case Verb::Voice: bk_engine_voice(e, c.key, c.a); break;
    case Verb::VoiceCal: bk_engine_voicecal(e, c.key, c.a, c.b, c.c); break;
    case Verb::Clock: bk_engine_clock(e, c.key, c.a); break;
    case Verb::ClipReset: bk_engine_clip_reset(e); break;
    case Verb::Panic: bk_engine_panic(e); break;
    case Verb::RecState:
      recording_ = c.a != 0.0 ? 1 : 0;
      recPaused_ = c.b != 0.0 ? 1 : 0;
      if (c.c != 0.0) {
        recClaim_.store(0, std::memory_order_relaxed);
        recWrite_.store(0, std::memory_order_release);
        recOverflow_ = 0.0;
      }
      break;
    case Verb::Count: break;
  }
}

void Host::applyMsg(Msg* m) {
  for (Msg* x = m; x; x = x->next) applyOne(x);
}

// Mark and sweep: every Owned the engine no longer points at moves onto `to->freed`.
void Host::sweep(Msg* to) {
  if (!live_) return;
  uint32_t n = 0;
  auto ref = [&](const void* p) {
    if (p && n < refsCap_) refs_[n++] = p;
  };
  auto chainRefs = [&](const bk_chain* c) {
    for (int i = 0; i < c->n_slots; i++) ref(c->slots[i].effect);
  };
  chainRefs(&e_.chain);
  for (int p = 0; p < BK_PAD_COUNT; p++) {
    chainRefs(&e_.drums.pad_chains[p]);
    // Every layer, not just layer_count: a layer is only ever read through this array,
    // and a pointer still in it (a hole below the top layer) must stay alive.
    for (int l = 0; l < BK_DRUM_MAX_LAYERS; l++) ref(e_.drums.pads[p].layers[l].data);
  }
  for (int t = 0; t < BK_LOOP_TRACKS; t++) chainRefs(&e_.looper.tracks[t].chain);
  ref(e_.player.ch_l);
  std::sort(refs_, refs_ + n);

  Owned** link = &live_;
  while (Owned* o = *link) {
    if (std::binary_search(refs_, refs_ + n, o->key)) {
      link = &o->next;
    } else {
      *link = o->next;
      o->next = to->freed;
      to->freed = o;
      liveN_--;
    }
  }
}

void Host::drainControl(bool unbounded) {
  // The ring's write index FIRST: a ring op pushed after a message is then never seen
  // without the message (the control thread published the message before the op).
  const uint64_t w0 = ring_.writeIndex();
  auto apply = [this](const Command& c) { applyOp(c); };
  Msg* done[kMsgsPerRender];
  uint32_t nd = 0;
  for (;;) {
    Msg* m = mailbox_.peek();
    if (!m) break;
    if (nd == kMsgsPerRender) {
      if (!unbounded) break;
      sweep(done[nd - 1]);
      for (uint32_t i = 0; i < nd; i++) returns_.push(done[i]);
      nd = 0;
    }
    ring_.drainUntil(m->fence, apply);
    mailbox_.drop();
    applyMsg(m);
    done[nd++] = m;
    applied_.fetch_add(1, std::memory_order_relaxed);
  }
  uint64_t limit = unbounded ? UINT64_MAX : w0;
  if (Msg* next = mailbox_.peek()) limit = std::min(limit, next->fence);
  ring_.drainUntil(limit, apply);
  if (nd) {
    sweep(done[nd - 1]);
    for (uint32_t i = 0; i < nd; i++) returns_.push(done[i]);  // never full: outstanding_ <= kMailbox
  }
  liveCount_.store(liveN_, std::memory_order_relaxed);
}

void Host::runPull(bool unbounded) {
  if (pullState_.load(std::memory_order_acquire) != 1) return;
  double* out = pullValues_;
  int32_t count = 0;
  switch (pullKind_) {
    case PullKind::Visual: {
      const bk_slot* s = bk_chain_find(&e_.chain, pullId_);
      count = -1;
      if (s && s->type == BK_FX_EQ) {
        const float* v = bk_eq_visual(static_cast<const bk_eq*>(s->effect));
        for (int i = 0; i < BK_EQ_CURVE_POINTS; i++) out[i] = v[i];
        count = BK_EQ_CURVE_POINTS;
      } else if (s && s->type == BK_FX_VOCODER) {
        float ladder[BK_VOCODER_MAX_BANDS];
        const int n = bk_vocoder_visual(static_cast<const bk_vocoder*>(s->effect), ladder);
        for (int i = 0; i < n; i++) out[i] = ladder[i];
        count = n;
      }
      break;
    }
    case PullKind::LoopPeaks: {
      if (peakBucket_ < 0) {
        peakTrack_ = i32(pullIndex_);
        const bk_loop_track* t = bk_looper_track(&e_.looper, peakTrack_);
        if (!t || t->frames <= 0) {
          count = -1;
          break;
        }
        const int b = i32(pullArg_);
        peakBuckets_ = std::max(1, std::min(4096, b ? b : 480));
        peakFrames_ = t->frames;
        peakBucket_ = 0;
      }
      const bk_loop_track* t = bk_looper_track(&e_.looper, peakTrack_);
      const float* l = t->buf_l;
      const float* r = t->buf_r ? t->buf_r : t->buf_l;
      const double frames = peakFrames_, nb = peakBuckets_;
      // At least one bucket per render, then stop once a slice's worth has been read.
      uint64_t scanned = 0;
      while (peakBucket_ < peakBuckets_ && (unbounded || scanned < kPeakSliceFrames)) {
        const int b = peakBucket_;
        const int start = static_cast<int>(std::floor((b * frames) / nb));
        const int end = std::max(start + 1, static_cast<int>(std::floor(((b + 1) * frames) / nb)));
        double lo = 0.0, hi = 0.0;
        for (int i = start; i < end; i++) {
          const double v = (static_cast<double>(l[i]) + static_cast<double>(r[i])) * 0.5;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        out[b * 2] = lo;
        out[b * 2 + 1] = hi;
        peakBucket_++;
        scanned += static_cast<uint64_t>(end - start);
      }
      if (peakBucket_ < peakBuckets_) return;  // more next render
      count = peakBuckets_ * 2;
      pullMeta_[0] = peakTrack_;
      pullMeta_[1] = peakBuckets_;
      break;
    }
    case PullKind::VoiceCaps: {
      const int stride = BK_VOICE_CAP_STRIDE;
      const int mx = i32(pullArg2_);
      const int want = std::max(0, std::min(BK_VOICE_CAP_SLOTS, mx ? mx : BK_VOICE_CAP_SLOTS));
      const long long total = e_.voice.capture_count;
      long long first = std::max(0, i32(pullArg_));
      if (first < total - BK_VOICE_CAP_SLOTS) first = total - BK_VOICE_CAP_SLOTS;
      float row[BK_VOICE_CAP_STRIDE];
      int rows = 0;
      for (long long n = first; n < total && rows < want; n++) {
        if (!bk_engine_read_voice_capture(&e_, n, row)) continue;
        for (int i = 0; i < stride; i++) out[rows * stride + i] = row[i];
        rows++;
      }
      count = rows * stride;
      pullMeta_[0] = static_cast<double>(first);
      pullMeta_[1] = static_cast<double>(total);
      pullMeta_[2] = stride;
      pullMeta_[3] = rows;
      break;
    }
    case PullKind::Chain: {
      bk_chain* c = bk_engine_chain(&e_, pullTarget_, pullIndex_);
      const int n = c ? c->n_slots : 0;
      for (int i = 0; i < n; i++) {
        out[i * 3] = c->slots[i].id;
        out[i * 3 + 1] = c->slots[i].type;
        out[i * 3 + 2] = c->slots[i].bypassed ? 1.0 : 0.0;
      }
      count = n * 3;
      pullMeta_[0] = pullTarget_ == BK_TARGET_MASTER ? bk_engine_latency_samples(&e_) : 0.0;
      pullMeta_[1] = n;
      break;
    }
    case PullKind::None: count = -1; break;
  }
  pullCount_ = count;
  pullState_.store(2, std::memory_order_release);
}

void Host::publish(const float* inL, const float* inR, const float* outL, const float* outR, uint32_t n) {
  // Scope: mono (L + R) * 0.5 of each side, masked.
  const uint32_t mask = BK_SCOPE_SIZE - 1;
  const uint32_t w = scopeWrite_.load(std::memory_order_relaxed);
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t idx = (w + i) & mask;
    scopeIn_[idx].store((inL[i] + inR[i]) * 0.5f, std::memory_order_relaxed);
    scopeOut_[idx].store((outL[i] + outR[i]) * 0.5f, std::memory_order_relaxed);
  }
  scopeWrite_.store((w + n) & mask, std::memory_order_release);

  // The take: wet is the output, dry the engine's post-input-gain pre-effects signal.
  if (!recording_ || recPaused_) return;
  const uint64_t total = recWrite_.load(std::memory_order_relaxed);
  const uint64_t cap = recCap_;
  recClaim_.store(total + n, std::memory_order_relaxed);
  for (uint32_t i = 0; i < n; i++) {
    const size_t o = static_cast<size_t>(((total + i) % cap) * 2);
    recWet_[o].store(outL[i], std::memory_order_release);
    recWet_[o + 1].store(outR[i], std::memory_order_release);
    recDry_[o].store(e_.dry_l[i], std::memory_order_release);
    recDry_[o + 1].store(e_.dry_r[i], std::memory_order_release);
  }
  recWrite_.store(total + n, std::memory_order_release);
}

void Host::publishMeters() {
  double* s = meterScratch_;
  for (uint32_t i = 0; i < BK_METER_FIELDS; i++) s[i] = 0.0;
  bk_engine_read_meters(&e_, s);
  s[10] = loadAvg_;
  s[13] = recording_;
  s[14] = static_cast<double>(recWrite_.load(std::memory_order_relaxed));
  s[15] = recOverflow_;
  const uint32_t seq = meterSeq_.load(std::memory_order_relaxed);
  meterSeq_.store(seq + 1, std::memory_order_relaxed);
  // Release stores order the odd seq before every field (fence-free so TSan can check it).
  for (uint32_t i = 0; i < BK_METER_FIELDS; i++) meters_[i].store(s[i], std::memory_order_release);
  meterSeq_.store(seq + 2, std::memory_order_release);
}

void Host::render(const float* const* in, uint32_t inChannels, float* const* out, uint32_t outChannels,
                  uint32_t frames) {
  const auto t0 = std::chrono::steady_clock::now();
  drainControl(false);
  runPull(false);
  if (frames == 0) return;

  const uint32_t mb = static_cast<uint32_t>(maxBlock_);
  for (uint32_t off = 0; off < frames; off += mb) {
    const uint32_t n = std::min(mb, frames - off);
    // A missing or mono input is silence or the one channel, as the worklet's
    // `input[1] ? input[1] : input[0]`; a mono output aliases L and R as it does.
    const float* inL = inChannels > 0 && in && in[0] ? in[0] + off : silent_;
    const float* inR = inChannels > 1 && in && in[1] ? in[1] + off : inL;
    float* outL = outChannels > 0 && out && out[0] ? out[0] + off : scratch_;
    float* outR = outChannels > 1 && out && out[1] ? out[1] + off : (outChannels > 0 ? outL : scratch_ + mb);
    bk_engine_process(&e_, inL, inR, outL, outR, static_cast<int>(n));
    publish(inL, inR, outL, outR, n);
    for (uint32_t ch = 2; ch < outChannels; ch++) {
      if (out && out[ch]) std::memset(out[ch] + off, 0, n * sizeof(float));
    }
  }

  const double us =
      std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count();
  blockPeriodUs_ = static_cast<double>(frames) / sr_ * 1e6;
  double inst = us / blockPeriodUs_;
  if (!(inst >= 0.0 && inst < 10.0)) inst = 0.0;
  loadAvg_ = loadAvg_ * 0.95 + inst * 0.05;
  publishMeters();

  loadPub_.store(loadAvg_, std::memory_order_relaxed);
  renders_.fetch_add(1, std::memory_order_relaxed);
  frames_.fetch_add(frames, std::memory_order_relaxed);
}

}  // namespace brokodr
