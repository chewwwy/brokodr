/* Bro.Kodr engine parity producer; replayed by verify-engine-parity.mjs.
 *
 * The composed engine, driven verb by verb. Effects are built through the
 * registry (as a host must: engine.h "Effects"), every one of them handed the
 * same battery xorshift and the same state pointer, which is the C side of the
 * JS's single global Math.random. The JS oracle builds the same command
 * objects engine.applyCommand() receives and maps every numeric key back to
 * its name through param-schema.ts / backend.ts.
 */
#include "brokodr/dsp/engine.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

enum {
  OP_END = 0,
  OP_INIT = 1,      /* a = sample rate, b = max block */
  OP_PROCESS = 2,   /* a = blocks, b = block size, c = left signal, d = right signal */
  OP_INPLACE = 3,   /* as OP_PROCESS, out_* aliasing in_* */
  OP_SNAP = 4,
  OP_POKE = 5,      /* next block only: channel a, sample b, value c */
  OP_REWIND = 6,
  OP_GAIN = 7,      /* a = stimulus gain */
  OP_DC = 8,        /* a = SIG_DC level */
  OP_SEED = 9,      /* a = new xorshift state (> 0) */
  OP_ADD = 10,      /* a = target, b = chain index, c = type, d = id, e = at (master only) */
  OP_ADDOPT = 11,   /* the next OP_ADD only: a = mix, b = bypassed (UNDEF_ = absent) */
  OP_REMOVE = 12,   /* a = target, b = index, c = id */
  OP_MOVE = 13,     /* a = target, b = index, c = id, d = to */
  OP_FXPARAM = 14,  /* a = target, b = index, c = id, d = key, e = value */
  OP_MIX = 15,      /* a = target, b = index, c = id, d = value */
  OP_BYPASS = 16,   /* a = target, b = index, c = id, d = value */
  OP_FXRESET = 17,  /* a = target, b = index, c = id */
  OP_FXCLEAR = 18,  /* a = target, b = index */
  OP_IO = 19,       /* a = field, b = value */
  OP_FILELOAD = 20, /* a = left signal, b = right signal, c = frames, d = rate */
  OP_FILECLEAR = 21,
  OP_FILE = 22,     /* a = key, b = value */
  OP_FILEROUTE = 23,/* a = value */
  OP_PAD = 24,      /* a = index, b = velocity (UNDEF_ = absent) */
  OP_PADOFF = 25,   /* a = index */
  OP_PADPARAM = 26, /* a = index, b = key, c = value */
  OP_PADLOAD = 27,  /* a = index, b = layer, c = signal, d = frames, e = rate */
  OP_PADCLEAR = 28, /* a = index */
  OP_DRUM = 29,     /* a = key, b = value */
  OP_DRUMRESET = 30,
  OP_LOOP = 31,     /* a = op, b = index */
  OP_LOOPPARAM = 32,/* a = index, b = key, c = value */
  OP_LOOPER = 33,   /* a = key, b = value */
  OP_VOICE = 34,    /* a = key, b = value */
  OP_VOICECAL = 35, /* a = op, b = cls, c = arg, d = value (UNDEF_ in c = absent) */
  OP_CLOCK = 36,    /* a = key, b = value */
  OP_CLIPRESET = 37,
  OP_PANIC = 38,
  OP_RECALC = 39,
  OP_CAPS = 40      /* every readable capture: a = first n, b = last n (inclusive) */
};
#define OPW 6

#define SIG_N 65536
#define N_SIGS 5
#define SIG_DC 5
#define SIG_VOICE 6
#define SIG_BEAT 7
#define MAX_BLOCK 4096
#define MAX_POKES 32
#define MAX_FX 256
#define MAX_P64 1000000
#define MAX_P32 2000000
#define METER_FILL (-7.0)

#define NAN_ (-3e9)
#define INF_ (3e9)
#define NINF_ (-4e9)
#define UNDEF_ (-5e9)

static float g_sig[N_SIGS + 3][SIG_N];
static double g_tmp[SIG_N];
static float g_l[MAX_BLOCK];
static float g_r[MAX_BLOCK];
static float g_ol[MAX_BLOCK];
static float g_or[MAX_BLOCK];
static double g_p64[MAX_P64];
static float g_p32[MAX_P32];
static unsigned int n64, n32;
static double g_meters[BK_ENGINE_METER_COUNT];

#define CANARY 64
static struct { bk_engine e; float canary[CANARY]; } g_box;
static bk_engine *const g_e = &g_box.e;
static float *g_store;
static size_t g_store_n;
static void check_canary(void) {
  int k;
  for (k = 0; k < CANARY; k++) {
    if (g_box.canary[k] != 1234.5f) {
      fprintf(stderr, "write past the engine struct at %d\n", k);
      exit(5);
    }
    if (g_store[g_store_n + (size_t)k] != 1234.5f) {
      fprintf(stderr, "write past the engine storage at %d\n", k);
      exit(5);
    }
  }
}

/* The single Math.random every effect shares, mirrored in the verifier. */
static unsigned int g_seed;
static double g_draws;
static double test_random(void *user) {
  unsigned int *seed = (unsigned int *)user;
  unsigned int x = *seed;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  *seed = x;
  g_draws += 1.0;
  return (double)x / 4294967296.0;
}

/* Every effect built this script, freed on the next INIT. */
static void *g_fx_mem[MAX_FX];
static float *g_fx_store[MAX_FX];
static int n_fx;
static void free_fx(void) {
  int k;
  for (k = 0; k < n_fx; k++) {
    free(g_fx_mem[k]);
    free(g_fx_store[k]);
  }
  n_fx = 0;
}

static int g_cursor;
static double g_gain;
static double g_dc;
static int n_pokes;
static int poke_ch[MAX_POKES];
static int poke_at[MAX_POKES];
static double poke_v[MAX_POKES];
static double g_add_mix;
static double g_add_bypassed;

static void push64(double v) {
  if (n64 < MAX_P64) g_p64[n64++] = v;
}
static void push32(float v) {
  if (n32 < MAX_P32) g_p32[n32++] = v;
}
static void smoother_state(const bk_smoother *s) {
  push64(s->value); push64(s->target); push64(s->a);
}

/* BK_ENGINE_METER_COUNT meters + 21 scalars. */
static void block_state(void) {
  const bk_engine *e = g_e;
  int k;
  bk_engine_read_meters(e, g_meters);
  for (k = 0; k < BK_ENGINE_METER_COUNT; k++) push64(g_meters[k]);
  smoother_state(&e->in_gain); smoother_state(&e->out_gain); smoother_state(&e->master_mix);
  push64((double)e->in_muted); push64((double)e->master_bypass);
  push64((double)e->mono_input); push64((double)e->input_swap);
  push64(e->file_route); push64(e->drum_route);
  push64(e->block_count); push64((double)bk_engine_latency_samples(e));
  push64(e->peak_hold_in); push64(e->peak_hold_out);
  push64((double)e->voice.capture_count); push64(g_draws);
}
/* Block state, then the engine's own scratch buffers, max_block each. */
static void snap_state(void) {
  const bk_engine *e = g_e;
  const float *bufs[13];
  int b, k;
  block_state();
  bufs[0] = e->dry_l; bufs[1] = e->dry_r; bufs[2] = e->cin_l; bufs[3] = e->cin_r;
  bufs[4] = e->car_l; bufs[5] = e->car_r; bufs[6] = e->drum_l; bufs[7] = e->drum_r;
  bufs[8] = e->tap_l; bufs[9] = e->tap_r; bufs[10] = e->loop_l; bufs[11] = e->loop_r;
  bufs[12] = e->voice_buf;
  for (b = 0; b < 13; b++)
    for (k = 0; k < e->max_block; k++) push32(bufs[b][k]);
}

static double unsentinel(double v) {
  if (v == NAN_) return (double)NAN;
  if (v == INF_) return (double)INFINITY;
  if (v == NINF_) return -(double)INFINITY;
  return v;
}

static void init_engine(double sr, int max_block) {
  int k;
  free_fx();
  free(g_store);
  for (k = 0; k < CANARY; k++) g_box.canary[k] = 1234.5f;
  g_store_n = bk_engine_storage_floats(sr, max_block);
  g_store = (float *)calloc(g_store_n + CANARY, sizeof(float));
  if (!g_store) {
    fprintf(stderr, "out of memory\n");
    exit(4);
  }
  for (k = 0; k < CANARY; k++) g_store[g_store_n + (size_t)k] = 1234.5f;
  if (bk_engine_init(g_e, sr, max_block, g_store) != 0) {
    fprintf(stderr, "engine init refused\n");
    exit(4);
  }
  /* C-only layout check: the last carved region (the undo slot) must end
     exactly where bk_engine_storage_floats says the storage does. A region the
     sizing forgot is otherwise invisible until a near-max-length loop writes
     its tail past the end. */
  if (g_e->looper.undo_r + g_e->looper.max_frames != g_store + g_store_n) {
    fprintf(stderr, "engine storage layout does not match bk_engine_storage_floats\n");
    exit(5);
  }
  for (k = 0; k < BK_ENGINE_METER_COUNT; k++) g_meters[k] = METER_FILL;
  g_seed = 0x2545f491u;
  g_add_mix = UNDEF_;
  g_add_bypassed = UNDEF_;
  check_canary();
}

static int js_truthy(double x) { return x != 0.0 && x == x; }

/* What engine.js's add verbs do inside Chain.add: createEffect, then insert. */
static void add_fx(int target, double index, int type, int id, double at) {
  bk_slot_spec spec;
  const size_t size = bk_effect_size(type);
  const size_t nf = bk_effect_storage_floats(type, g_e->sr, g_e->max_block);
  void *mem = NULL;
  float *st = NULL;
  const bk_effect_vt *vt = NULL;
  if (size > 0 && n_fx < MAX_FX) {
    mem = calloc(1, size);
    st = nf > 0 ? (float *)calloc(nf, sizeof(float)) : NULL;
    vt = bk_effect_create(type, mem, st, g_e->sr, g_e->max_block);
    bk_effect_set_random(type, mem, test_random, &g_seed);
    g_fx_mem[n_fx] = mem;
    g_fx_store[n_fx] = st;
    n_fx++;
  }
  spec.id = id;
  spec.type = type;
  /* The master's insert position is cmd.index. padfx / loopfx hand the whole
     command to Chain.add, so cmd.index -- the pad or track -- is ALSO the
     insert position there (engine.h, "padfx / loopfx add"). A NaN position
     is clamp(NaN) = NaN in chain.js, which splice() reads as 0. */
  if (target == BK_TARGET_MASTER)
    spec.index = at == UNDEF_ ? BK_CHAIN_APPEND : at != at ? 0 : (int)at;
  else
    spec.index = index != index ? 0 : (int)index;
  spec.mix = g_add_mix == UNDEF_ ? (double)NAN : g_add_mix;
  spec.bypassed = g_add_bypassed == UNDEF_ ? BK_CHAIN_KEEP : js_truthy(g_add_bypassed);
  spec.effect = vt ? mem : NULL;
  spec.vt = vt;
  bk_engine_fx_add(g_e, target, index, &spec);
  g_add_mix = UNDEF_;
  g_add_bypassed = UNDEF_;
}

static double sig_at(int s, int at) { return s == SIG_DC ? g_dc : (double)g_sig[s][at]; }

/* A file or pad load of SIG_DC reads a fresh buffer of the current level, as
   the JS's new Float32Array(n).fill(dc) does: the engine keeps the pointer. */
#define DC_POOL 4
static float g_dcpool[DC_POOL][SIG_N];
static int n_dcpool;
static const float *load_sig(int s) {
  int j;
  float *d;
  if (s != SIG_DC) return g_sig[s];
  if (n_dcpool >= DC_POOL) {
    fprintf(stderr, "SIG_DC load pool exhausted\n");
    exit(6);
  }
  d = g_dcpool[n_dcpool++];
  for (j = 0; j < SIG_N; j++) d[j] = (float)g_dc;
  return d;
}

static void run_block(int bs, int sl, int sr, int inplace) {
  int j;
  for (j = 0; j < bs; j++) {
    const int at = (g_cursor + j) % SIG_N;
    g_l[j] = (float)(g_gain * sig_at(sl, at));
    g_r[j] = (float)(g_gain * (-0.5 * sig_at(sr, at)));
  }
  g_cursor = (g_cursor + (bs > 0 ? bs : 0)) % SIG_N;
  for (j = 0; j < n_pokes; j++) {
    if (poke_at[j] < bs) (poke_ch[j] ? g_r : g_l)[poke_at[j]] = (float)poke_v[j];
  }
  n_pokes = 0;
  if (inplace) {
    bk_engine_process(g_e, g_l, g_r, g_l, g_r, bs);
  } else {
    bk_engine_process(g_e, g_l, g_r, g_ol, g_or, bs);
  }
  check_canary();
  block_state();
  for (j = 0; j < bs; j++) push32(inplace ? g_l[j] : g_ol[j]);
  for (j = 0; j < bs; j++) push32(inplace ? g_r[j] : g_or[j]);
}

static void run_script(FILE *f, const char *name, const double *ops, size_t n_ops) {
  size_t i;
  int k;
  static float row[BK_VOICE_CAP_STRIDE];

  n64 = 0;
  n32 = 0;
  g_cursor = 0;
  g_gain = 1.0;
  g_dc = 0.0;
  n_dcpool = 0;
  n_pokes = 0;
  g_draws = 0.0;
  init_engine(48000.0, 128);

  for (i = 0; i + OPW <= n_ops; i += OPW) {
    const int op = (int)ops[i];
    const double a = unsentinel(ops[i + 1]), b = unsentinel(ops[i + 2]);
    const double c = unsentinel(ops[i + 3]), d = unsentinel(ops[i + 4]);
    const double e5 = unsentinel(ops[i + 5]);
    switch (op) {
      case OP_END: i = n_ops; break;
      case OP_INIT: init_engine(a, (int)b); break;
      case OP_PROCESS:
      case OP_INPLACE:
        for (k = 0; k < (int)a; k++) run_block((int)b, (int)c, (int)d, op == OP_INPLACE);
        break;
      case OP_SNAP: snap_state(); break;
      case OP_POKE:
        if (n_pokes < MAX_POKES) {
          poke_ch[n_pokes] = (int)a;
          poke_at[n_pokes] = (int)b;
          poke_v[n_pokes] = c;
          n_pokes++;
        }
        break;
      case OP_REWIND: g_cursor = 0; break;
      case OP_GAIN: g_gain = a; break;
      case OP_DC: g_dc = a; break;
      case OP_SEED: g_seed = (unsigned int)a; break;
      case OP_ADD: add_fx((int)a, b, (int)c, (int)d, ops[i + 5]); break;
      case OP_ADDOPT:
        g_add_mix = ops[i + 1] == UNDEF_ ? UNDEF_ : a;
        g_add_bypassed = ops[i + 2] == UNDEF_ ? UNDEF_ : b;
        break;
      case OP_REMOVE: bk_engine_fx_remove(g_e, (int)a, b, (int)c); break;
      case OP_MOVE: bk_engine_fx_move(g_e, (int)a, b, (int)c, (int)d); break;
      case OP_FXPARAM: bk_engine_fx_param(g_e, (int)a, b, (int)c, (int)d, e5); break;
      case OP_MIX: bk_engine_fx_mix(g_e, (int)a, b, (int)c, d); break;
      case OP_BYPASS: bk_engine_fx_bypass(g_e, (int)a, b, (int)c, d); break;
      case OP_FXRESET: bk_engine_fx_reset(g_e, (int)a, b, (int)c); break;
      case OP_FXCLEAR: bk_engine_fx_clear(g_e, (int)a, b); break;
      case OP_IO: bk_engine_io(g_e, (int)a, b); break;
      case OP_FILELOAD: bk_engine_file_load(g_e, load_sig((int)a), load_sig((int)b), (int)c, d); break;
      case OP_FILECLEAR: bk_engine_file_clear(g_e); break;
      case OP_FILE: bk_engine_file_param(g_e, (int)a, b); break;
      case OP_FILEROUTE: bk_engine_file_route(g_e, a); break;
      /* `cmd.vel === undefined ? 1 : cmd.vel`: the default is the host's. */
      case OP_PAD: bk_engine_pad(g_e, a, ops[i + 2] == UNDEF_ ? 1.0 : b); break;
      case OP_PADOFF: bk_engine_pad_off(g_e, a); break;
      case OP_PADPARAM: bk_engine_pad_param(g_e, a, (int)b, c); break;
      case OP_PADLOAD: bk_engine_pad_load(g_e, a, b, load_sig((int)c), (int)d, e5); break;
      case OP_PADCLEAR: bk_engine_pad_clear(g_e, a); break;
      case OP_DRUM: bk_engine_drum(g_e, (int)a, b); break;
      case OP_DRUMRESET: bk_engine_drum_reset(g_e); break;
      case OP_LOOP: bk_engine_loop(g_e, (int)a, b); break;
      case OP_LOOPPARAM: bk_engine_loop_param(g_e, a, (int)b, c); break;
      case OP_LOOPER: bk_engine_looper_param(g_e, (int)a, b); break;
      case OP_VOICE: bk_engine_voice(g_e, (int)a, b); break;
      /* An absent pad / capture class is -1, as engine.js defaults them. */
      case OP_VOICECAL:
        if ((int)a == BK_VOICECAL_CAPTURE)
          bk_engine_voicecal(g_e, (int)a, ops[i + 2] == UNDEF_ ? -1.0 : b, c, d);
        else
          bk_engine_voicecal(g_e, (int)a, b, ops[i + 3] == UNDEF_ ? -1.0 : c, d);
        break;
      case OP_CLOCK: bk_engine_clock(g_e, (int)a, b); break;
      case OP_CLIPRESET: bk_engine_clip_reset(g_e); break;
      case OP_PANIC: bk_engine_panic(g_e); break;
      case OP_RECALC: push64((double)bk_engine_recalc_latency(g_e)); break;
      case OP_CAPS: {
        long long n;
        for (n = (long long)a; n <= (long long)b; n++) {
          int got, q;
          for (q = 0; q < BK_VOICE_CAP_STRIDE; q++) row[q] = -7.0f;
          got = bk_engine_read_voice_capture(g_e, n, row);
          push64((double)got);
          for (q = 0; q < BK_VOICE_CAP_STRIDE; q++) push32(row[q]);
        }
        break;
      }
      default: break;
    }
  }
  snap_state();
  if (n64 >= MAX_P64 || n32 >= MAX_P32) {
    fprintf(stderr, "%s: payload overflow\n", name);
    exit(3);
  }
  bk_parity_emit(f, name, ops, (unsigned int)n_ops, g_p64, n64, g_p32, n32);
}

/* Opcodes travel in record.params: the JS oracle replays the same scripts. */
#define NOISE BK_SIG_NOISE
#define RAMP BK_SIG_RAMP
#define STEP BK_SIG_STEP
#define IMP BK_SIG_IMPULSE
#define ZERO BK_SIG_ZERO
#define DC SIG_DC
#define VOICE SIG_VOICE
#define BEAT SIG_BEAT
#define U UNDEF_
#define O(op,a,b,c,d,e) (double)(op),(double)(a),(double)(b),(double)(c),(double)(d),(double)(e)
#define INIT(sr,mb) O(OP_INIT,sr,mb,0,0,0)
#define PROC(n,bs,l,r) O(OP_PROCESS,n,bs,l,r,0)
#define INPL(n,bs,l,r) O(OP_INPLACE,n,bs,l,r,0)
#define SNAP O(OP_SNAP,0,0,0,0,0)
#define POKE(ch,at,v) O(OP_POKE,ch,at,v,0,0)
#define REWIND O(OP_REWIND,0,0,0,0,0)
#define GAIN(v) O(OP_GAIN,v,0,0,0,0)
#define LEVEL(v) O(OP_DC,v,0,0,0,0)
#define SEED(s) O(OP_SEED,s,0,0,0,0)
#define ADD(t,ix,ty,id,at) O(OP_ADD,t,ix,ty,id,at)
#define MADD(ty,id) ADD(BK_TARGET_MASTER,0,ty,id,U)
#define ADDOPT(m,byp) O(OP_ADDOPT,m,byp,0,0,0)
#define REMOVE(t,ix,id) O(OP_REMOVE,t,ix,id,0,0)
#define MOVE(t,ix,id,to) O(OP_MOVE,t,ix,id,to,0)
#define FXP(t,ix,id,k,v) O(OP_FXPARAM,t,ix,id,k,v)
#define MP(id,k,v) FXP(BK_TARGET_MASTER,0,id,k,v)
#define MIX(t,ix,id,v) O(OP_MIX,t,ix,id,v,0)
#define BYP(t,ix,id,v) O(OP_BYPASS,t,ix,id,v,0)
#define FXRESET(t,ix,id) O(OP_FXRESET,t,ix,id,0,0)
#define FXCLEAR(t,ix) O(OP_FXCLEAR,t,ix,0,0,0)
#define IO(f,v) O(OP_IO,f,v,0,0,0)
#define FLOAD(l,r,n,rate) O(OP_FILELOAD,l,r,n,rate,0)
#define FCLEAR O(OP_FILECLEAR,0,0,0,0,0)
#define FILEP(k,v) O(OP_FILE,k,v,0,0,0)
#define FROUTE(v) O(OP_FILEROUTE,v,0,0,0,0)
#define PAD(ix,v) O(OP_PAD,ix,v,0,0,0)
#define PADOFF(ix) O(OP_PADOFF,ix,0,0,0,0)
#define PADP(ix,k,v) O(OP_PADPARAM,ix,k,v,0,0)
#define PLOAD(ix,ly,s,n,rate) O(OP_PADLOAD,ix,ly,s,n,rate)
#define PCLEAR(ix) O(OP_PADCLEAR,ix,0,0,0,0)
#define DRUM(k,v) O(OP_DRUM,k,v,0,0,0)
#define DRESET O(OP_DRUMRESET,0,0,0,0,0)
#define LOOP(op,ix) O(OP_LOOP,op,ix,0,0,0)
#define LOOPP(ix,k,v) O(OP_LOOPPARAM,ix,k,v,0,0)
#define LOOPER(k,v) O(OP_LOOPER,k,v,0,0,0)
#define VOICEP(k,v) O(OP_VOICE,k,v,0,0,0)
#define VCAL(op,cls,arg,v) O(OP_VOICECAL,op,cls,arg,v,0)
#define CLOCK(k,v) O(OP_CLOCK,k,v,0,0,0)
#define CLIPRESET O(OP_CLIPRESET,0,0,0,0,0)
#define PANIC O(OP_PANIC,0,0,0,0,0)
#define RECALC O(OP_RECALC,0,0,0,0,0)
#define CAPS(a,b) O(OP_CAPS,a,b,0,0,0)
#define END O(OP_END,0,0,0,0,0)
#define SHORT PROC(12,128,VOICE,VOICE)
#define LONG PROC(40,128,VOICE,VOICE),PROC(10,128,NOISE,RAMP),PROC(10,128,STEP,IMP)
#define TAIL PROC(30,128,ZERO,ZERO)
#define TB INIT(48000,128)
#define T_M BK_TARGET_MASTER
#define T_P BK_TARGET_PAD
#define T_L BK_TARGET_LOOP
/* A 3000-frame drum one-shot on pad 0 and a 600-frame click on pad 1. */
#define KIT PLOAD(0,0,BEAT,3000,48000),PLOAD(1,0,NOISE,600,48000)

/* ---- the engine on its own */
static const double e_default[] = {TB,SNAP,LONG,TAIL,SNAP,END};
static const double e_fresh[] = {TB,SNAP,PROC(1,50,VOICE,VOICE),SNAP,END};
static const double e_silence[] = {TB,PROC(20,128,ZERO,ZERO),SNAP,END};
static const double e_inplace[] = {TB,MADD(BK_FX_DELAY,1),INPL(30,128,VOICE,NOISE),SNAP,END};
static const double e_blocks[] = {TB,PROC(2,0,VOICE,VOICE),PROC(300,1,VOICE,RAMP),PROC(40,7,STEP,NOISE),PROC(10,128,VOICE,VOICE),SNAP,INIT(48000,4096),PROC(3,4096,VOICE,NOISE),SNAP,END};
static const double e_rates[] = {INIT(44100,256),PROC(20,256,VOICE,NOISE),SNAP,INIT(8000,64),PROC(30,64,VOICE,RAMP),SNAP,END};

/* ---- io */
static const double e_io_gain[] = {TB,IO(BK_IO_IN_GAIN,-6),SHORT,IO(BK_IO_IN_GAIN,12),SHORT,IO(BK_IO_OUT_GAIN,-12),SHORT,IO(BK_IO_OUT_GAIN,NINF_),SHORT,IO(BK_IO_IN_GAIN,NAN_),SHORT,SNAP,IO(BK_IO_IN_GAIN,0),IO(BK_IO_OUT_GAIN,INF_),SHORT,SNAP,END};
static const double e_io_flags[] = {TB,IO(BK_IO_MUTE,1),SHORT,IO(BK_IO_MUTE,NAN_),SHORT,IO(BK_IO_MUTE,-0.0),SHORT,IO(BK_IO_MUTE,0.2),SHORT,SNAP,IO(BK_IO_MUTE,0),IO(BK_IO_SWAP,1),PROC(6,128,VOICE,NOISE),IO(BK_IO_MONO,1),PROC(6,128,VOICE,NOISE),IO(BK_IO_SWAP,0),PROC(6,128,VOICE,NOISE),IO(BK_IO_MONO,NAN_),PROC(6,128,VOICE,NOISE),SNAP,END};
static const double e_io_mute_gain[] = {TB,IO(BK_IO_MUTE,1),IO(BK_IO_IN_GAIN,-20),PROC(4,128,NOISE,NOISE),IO(BK_IO_MUTE,0),PROC(4,128,NOISE,NOISE),SNAP,END};
static const double e_io_bypass[] = {TB,MADD(BK_FX_DIST,1),MP(1,0,30),SHORT,IO(BK_IO_BYPASS,1),SHORT,SNAP,IO(BK_IO_BYPASS,NAN_),SHORT,IO(BK_IO_BYPASS,-1),SHORT,SNAP,END};
static const double e_io_mix[] = {TB,MADD(BK_FX_DIST,1),MP(1,0,24),IO(BK_IO_MASTER_MIX,0),SHORT,IO(BK_IO_MASTER_MIX,0.3),SHORT,IO(BK_IO_MASTER_MIX,2),SHORT,IO(BK_IO_MASTER_MIX,-1),SHORT,IO(BK_IO_MASTER_MIX,NAN_),SHORT,SNAP,IO(BK_IO_MASTER_MIX,1),SHORT,SNAP,END};
static const double e_io_unknown[] = {TB,IO(7,1),IO(-1,1),IO(99,0),SHORT,SNAP,END};
static const double e_clip[] = {TB,GAIN(2),SHORT,SNAP,GAIN(1),SHORT,SNAP,CLIPRESET,SHORT,SNAP,IO(BK_IO_OUT_GAIN,12),SHORT,CLIPRESET,SNAP,END};
static const double e_clip_edge[] = {INIT(48000,4),POKE(0,0,0.999),POKE(1,0,0),POKE(0,1,0),POKE(1,1,0),PROC(1,2,ZERO,ZERO),SNAP,CLIPRESET,POKE(0,0,0.99899995),PROC(1,2,ZERO,ZERO),SNAP,END};
static const double e_poke[] = {TB,PROC(4,128,VOICE,VOICE),POKE(0,3,NAN_),POKE(1,20,INF_),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),PROC(1,128,VOICE,VOICE),SNAP,END};
static const double e_huge[] = {TB,GAIN(1e35),PROC(6,128,VOICE,VOICE),SNAP,MADD(BK_FX_COMP,1),PROC(6,128,VOICE,VOICE),SNAP,END};
static const double e_dc[] = {TB,LEVEL(0.5),PROC(20,128,DC,DC),SNAP,END};

/* ---- master chain verbs */
static const double e_chain[] = {TB,MADD(BK_FX_EQ,1),MADD(BK_FX_COMP,2),MADD(BK_FX_DELAY,3),SHORT,SNAP,MOVE(T_M,0,3,0),SHORT,MOVE(T_M,0,1,99),SHORT,REMOVE(T_M,0,2),SHORT,SNAP,MIX(T_M,0,1,0.25),SHORT,MIX(T_M,0,3,NAN_),SHORT,BYP(T_M,0,1,1),SHORT,BYP(T_M,0,1,0),SHORT,FXRESET(T_M,0,3),SHORT,SNAP,FXCLEAR(T_M,0),SHORT,SNAP,END};
static const double e_chain_at[] = {TB,ADD(T_M,0,BK_FX_EQ,1,U),ADD(T_M,0,BK_FX_SAT,2,0),ADD(T_M,0,BK_FX_GATE,3,-4),ADD(T_M,0,BK_FX_CRUSH,4,99),ADD(T_M,0,BK_FX_LIMITER,5,2),SHORT,SNAP,END};
static const double e_chain_opts[] = {TB,ADDOPT(0.4,U),MADD(BK_FX_DIST,1),ADDOPT(U,1),MADD(BK_FX_SAT,2),ADDOPT(1.5,NAN_),MADD(BK_FX_CRUSH,3),ADDOPT(-0.5,0.0),MADD(BK_FX_DELAY,4),SHORT,SNAP,END};
static const double e_chain_bad[] = {TB,MADD(-1,1),MADD(BK_FX_COUNT,2),MADD(99,3),MADD(BK_FX_EQ,4),REMOVE(T_M,0,77),MOVE(T_M,0,77,0),MIX(T_M,0,77,0.5),BYP(T_M,0,77,1),FXRESET(T_M,0,77),MP(77,0,5),SHORT,SNAP,END};
static const double e_chain_full[] = {TB,MADD(BK_FX_EQ,1),MADD(BK_FX_EQ,2),MADD(BK_FX_EQ,3),MADD(BK_FX_EQ,4),MADD(BK_FX_EQ,5),MADD(BK_FX_EQ,6),MADD(BK_FX_EQ,7),MADD(BK_FX_EQ,8),MADD(BK_FX_EQ,9),MADD(BK_FX_EQ,10),MADD(BK_FX_EQ,11),MADD(BK_FX_EQ,12),MADD(BK_FX_EQ,13),MADD(BK_FX_EQ,14),MADD(BK_FX_EQ,15),MADD(BK_FX_EQ,16),MADD(BK_FX_EQ,17),MADD(BK_FX_EQ,18),MADD(BK_FX_EQ,19),MADD(BK_FX_EQ,20),MADD(BK_FX_EQ,21),MADD(BK_FX_EQ,22),MADD(BK_FX_EQ,23),MADD(BK_FX_TREMOLO,24),MADD(BK_FX_TREMOLO,25),SHORT,SNAP,REMOVE(T_M,0,1),MADD(BK_FX_TREMOLO,26),SHORT,SNAP,END};
/* Every type through the master chain, with sound. */
static const double e_all_types[] = {TB,MADD(BK_FX_EQ,1),MADD(BK_FX_COMP,2),MADD(BK_FX_LIMITER,3),MADD(BK_FX_GATE,4),MADD(BK_FX_TRANSIENT,5),MADD(BK_FX_DIST,6),MADD(BK_FX_SAT,7),MADD(BK_FX_CRUSH,8),MADD(BK_FX_PITCH,9),MADD(BK_FX_VOCODER,10),MADD(BK_FX_TALKBOX,11),SHORT,SNAP,MADD(BK_FX_CHORUS,12),MADD(BK_FX_FLANGER,13),MADD(BK_FX_PHASER,14),MADD(BK_FX_TREMOLO,15),MADD(BK_FX_RINGMOD,16),MADD(BK_FX_FREQSHIFT,17),MADD(BK_FX_DELAY,18),MADD(BK_FX_REVERB,19),MADD(BK_FX_CHARACTER,20),MADD(BK_FX_GLITCH,21),MADD(BK_FX_NOISE,22),LONG,SNAP,PANIC,SHORT,SNAP,END};
/* Randomness: every drawing type at once, then a reseed. Keys: crush 2
   dither, vocoder 1 carrier (3 = noise), character 0 mode / 3 noise, glitch,
   noise, and LFO shape 4 (S&H) on flanger / phaser / tremolo. */
static const double e_random[] = {TB,MADD(BK_FX_CRUSH,1),MP(1,BK_P_CRUSH_DITHER,100),MADD(BK_FX_VOCODER,2),MP(2,BK_P_VOCODER_CARRIER,3),MP(2,BK_P_VOCODER_SIBILANCE,1),MADD(BK_FX_CHARACTER,3),MP(3,BK_P_CHARACTER_NOISE,100),MADD(BK_FX_GLITCH,4),MADD(BK_FX_NOISE,5),MADD(BK_FX_FLANGER,6),MP(6,BK_P_FLANGER_SHAPE,4),MP(6,BK_P_FLANGER_RATE,40),MADD(BK_FX_PHASER,7),MP(7,BK_P_PHASER_SHAPE,4),MP(7,BK_P_PHASER_RATE,40),MADD(BK_FX_TREMOLO,8),MP(8,BK_P_TREMOLO_SHAPE,4),MP(8,BK_P_TREMOLO_RATE,40),LONG,SNAP,SEED(7),SHORT,SNAP,END};

/* ---- latency and the quality key */
static const double e_latency[] = {TB,MADD(BK_FX_PITCH,1),SNAP,MP(1,BK_P_PITCH_QUALITY_KEY,3),SNAP,MP(1,BK_P_PITCH_QUALITY_KEY,0),MP(1,BK_P_PITCH_PITCH,7),SHORT,SNAP,MADD(BK_FX_PITCH,2),MP(2,BK_P_PITCH_QUALITY_KEY,2),BYP(T_M,0,1,1),SNAP,BYP(T_M,0,1,0),RECALC,MP(2,BK_P_PITCH_QUALITY_KEY,NAN_),SNAP,MP(1,BK_P_PITCH_QUALITY_KEY,INF_),SHORT,SNAP,MP(99,BK_P_PITCH_QUALITY_KEY,1),REMOVE(T_M,0,1),SNAP,FXCLEAR(T_M,0),RECALC,SNAP,END};
/* Key 5 on a type whose key 5 is not "quality": no recalc. */
static const double e_latency_other[] = {TB,MADD(BK_FX_PITCH,1),MADD(BK_FX_VOCODER,2),MP(2,5,1000),MP(2,-1,5),MP(1,BK_P_PITCH_QUALITY_KEY,3),SNAP,END};

/* ---- file player and carrier bus */
static const double e_file[] = {TB,FLOAD(NOISE,RAMP,20000,48000),FILEP(BK_FILE_P_PLAY,1),SHORT,SNAP,FROUTE(0),SHORT,FROUTE(2),SHORT,FROUTE(3),SHORT,SNAP,FROUTE(NAN_),SHORT,SNAP,FROUTE(-0.4),SHORT,FROUTE(2.5),SHORT,FROUTE(9),SHORT,FROUTE(1.4999999999999998),SHORT,SNAP,END};
static const double e_file_params[] = {TB,FLOAD(VOICE,NOISE,5000,44100),FILEP(BK_FILE_P_PLAY,1),FILEP(BK_FILE_P_LOOP,1),FILEP(BK_FILE_P_LOOP_IN,0.1),FILEP(BK_FILE_P_LOOP_OUT,0.6),FILEP(BK_FILE_P_SPEED,1.5),FILEP(BK_FILE_P_GAIN,-6),LONG,SNAP,FILEP(BK_FILE_P_SEEK,0.5),FILEP(BK_FILE_P_PITCH,5),SHORT,FILEP(BK_FILE_P_PLAY,0),SHORT,SNAP,FCLEAR,SHORT,FILEP(99,1),SHORT,SNAP,END};
static const double e_file_end[] = {TB,FLOAD(RAMP,RAMP,700,48000),FILEP(BK_FILE_P_PLAY,1),PROC(10,128,ZERO,ZERO),SNAP,END};
static const double e_carrier[] = {TB,FLOAD(RAMP,NOISE,30000,48000),FILEP(BK_FILE_P_PLAY,1),FROUTE(2),MADD(BK_FX_VOCODER,1),MP(1,BK_P_VOCODER_SOURCE,1),MADD(BK_FX_TALKBOX,2),MP(2,BK_P_TALKBOX_SOURCE,1),LONG,SNAP,FROUTE(3),SHORT,FROUTE(0),SHORT,SNAP,END};

/* ---- BROBEATS */
static const double e_drums[] = {TB,KIT,PAD(0,U),SHORT,SNAP,PAD(1,0.5),PAD(0,1),SHORT,SNAP,DRUM(BK_DRUM_P_ROUTE,0),PAD(0,U),SHORT,DRUM(BK_DRUM_P_ROUTE,2),PAD(0,U),SHORT,SNAP,DRUM(BK_DRUM_P_ROUTE,NAN_),PAD(0,U),SHORT,SNAP,DRUM(BK_DRUM_P_ROUTE,-0.3),PAD(0,U),SHORT,DRUM(BK_DRUM_P_ROUTE,5),PAD(1,U),SHORT,SNAP,END};
static const double e_drums_mix[] = {TB,KIT,MADD(BK_FX_DIST,1),MP(1,0,30),IO(BK_IO_MASTER_MIX,0),PAD(0,U),SHORT,SNAP,DRUM(BK_DRUM_P_ROUTE,2),PAD(0,U),SHORT,SNAP,IO(BK_IO_MUTE,1),PAD(0,U),SHORT,IO(BK_IO_BYPASS,1),PAD(1,U),SHORT,SNAP,END};
static const double e_drum_params[] = {TB,KIT,DRUM(BK_DRUM_P_GAIN,-6),PAD(0,U),SHORT,DRUM(BK_DRUM_P_MUTE,1),PAD(0,U),SHORT,DRUM(BK_DRUM_P_MUTE,0),PADP(0,BK_PAD_P_PITCH,7),PADP(0,BK_PAD_P_REVERSE,1),PADP(1,BK_PAD_P_PAN,-1),PADP(1,BK_PAD_P_CHOKE,1),PADP(0,BK_PAD_P_CHOKE,1),PAD(0,U),PAD(1,0.8),SHORT,SNAP,PADP(0,BK_PAD_P_MODE,1),PAD(0,U),PROC(3,128,ZERO,ZERO),PADOFF(0),SHORT,SNAP,DRUM(BK_DRUM_P_SOLO,1),PADP(1,BK_PAD_P_MUTE,1),PAD(1,U),PAD(0,U),SHORT,DRUM(99,1),PADP(0,99,1),SNAP,END};
static const double e_drum_bad[] = {TB,KIT,PAD(-1,U),PAD(16,U),PAD(0.9,U),PAD(NAN_,U),PAD(1.5,NAN_),PADOFF(99),PADP(-3,0,1),PLOAD(40,0,NOISE,100,48000),PLOAD(2,9,NOISE,100,48000),PCLEAR(77),SHORT,SNAP,PAD(4294967296,U),PAD(-4294967295,U),SHORT,SNAP,END};
static const double e_drum_clear[] = {TB,KIT,PAD(0,U),PAD(1,U),SHORT,PCLEAR(0),PAD(0,U),SHORT,SNAP,PAD(1,U),PROC(2,128,VOICE,VOICE),DRESET,SHORT,SNAP,PAD(1,U),PROC(2,128,VOICE,VOICE),PANIC,SHORT,SNAP,END};
static const double e_drum_idle[] = {TB,KIT,PAD(1,U),PROC(30,128,ZERO,ZERO),SNAP,PROC(10,128,VOICE,VOICE),SNAP,END};

/* ---- pad and loop-track chains */
static const double e_padfx[] = {TB,KIT,ADD(T_P,0,BK_FX_DIST,1,U),FXP(T_P,0,1,0,30),ADD(T_P,1,BK_FX_DELAY,2,U),PAD(0,U),PAD(1,U),SHORT,SNAP,MIX(T_P,0,1,0.5),BYP(T_P,1,2,1),SHORT,BYP(T_P,1,2,0),FXRESET(T_P,1,2),PAD(1,U),SHORT,SNAP,REMOVE(T_P,0,1),PAD(0,U),SHORT,FXCLEAR(T_P,1),PAD(1,U),SHORT,SNAP,END};
/* cmd.index is the pad AND the insert position: on pad 1, the second add
   lands at position 1, the third at position 1 again, ahead of the second. */
static const double e_padfx_order[] = {TB,KIT,ADD(T_P,1,BK_FX_EQ,1,U),ADD(T_P,1,BK_FX_DIST,2,U),ADD(T_P,1,BK_FX_SAT,3,U),MOVE(T_P,1,1,2),FXP(T_P,1,2,0,24),PAD(1,U),SHORT,SNAP,ADD(T_P,0,BK_FX_EQ,4,U),ADD(T_P,0,BK_FX_DIST,5,U),PAD(0,U),SHORT,SNAP,END};
static const double e_padfx_bad[] = {TB,KIT,ADD(T_P,-1,BK_FX_EQ,1,U),ADD(T_P,16,BK_FX_EQ,2,U),ADD(T_P,NAN_,BK_FX_DIST,3,U),FXP(T_P,0,3,0,30),ADD(T_L,4,BK_FX_EQ,4,U),ADD(T_L,-1,BK_FX_EQ,5,U),ADD(9,0,BK_FX_EQ,6,U),FXCLEAR(T_P,99),PAD(0,U),SHORT,SNAP,END};
/* Every chain verb on a pad / track / target with no chain, and a param on a
   missing slot with a quality-numbered key: all no-ops. */
static const double e_fx_nochain[] = {TB,KIT,ADD(T_P,0,BK_FX_DIST,1,U),FXP(T_P,0,1,0,30),REMOVE(T_P,16,1),MOVE(T_L,-1,1,0),FXP(T_P,16,1,0,0),FXP(9,0,1,0,0),MIX(T_P,99,1,0),BYP(T_L,4,1,1),FXRESET(9,0,1),FXCLEAR(9,0),FXP(T_P,0,77,BK_P_PITCH_QUALITY_KEY,1),PAD(0,U),SHORT,SNAP,END};
static const double e_padfx_clear[] = {TB,KIT,ADD(T_P,0,BK_FX_DIST,1,U),FXP(T_P,0,1,0,30),PAD(0,U),SHORT,PCLEAR(0),PLOAD(0,0,BEAT,3000,48000),PAD(0,U),SHORT,SNAP,END};

/* ---- looper and clock. Loop ops: 0 rec 1 play 2 stop 3 clear 4 undo 6 clearall. */
static const double e_loop[] = {TB,CLOCK(BK_CLOCK_P_QUANTIZE,0),LOOP(0,0),PROC(40,128,VOICE,NOISE),LOOP(0,0),PROC(40,128,ZERO,ZERO),SNAP,LOOP(0,0),PROC(20,128,RAMP,RAMP),LOOP(0,0),PROC(20,128,ZERO,ZERO),SNAP,LOOP(4,0),PROC(10,128,ZERO,ZERO),LOOP(2,0),SHORT,LOOP(1,0),SHORT,SNAP,LOOP(3,0),SHORT,SNAP,END};
static const double e_loop_params[] = {TB,CLOCK(BK_CLOCK_P_QUANTIZE,0),LOOP(0,1),PROC(30,128,VOICE,VOICE),LOOP(0,1),LOOPP(1,BK_LOOP_P_GAIN,-6),LOOPP(1,BK_LOOP_P_PAN,0.7),SHORT,SNAP,LOOPP(1,BK_LOOP_P_MUTE,1),SHORT,LOOPP(1,BK_LOOP_P_MUTE,0),LOOPP(1,BK_LOOP_P_SOLO,1),SHORT,LOOPER(BK_LOOPER_P_GAIN,-12),SHORT,LOOPER(BK_LOOPER_P_MUTE,1),SHORT,SNAP,LOOPER(BK_LOOPER_P_MUTE,0),LOOPP(1,99,1),LOOPER(99,1),LOOPP(9,0,1),SHORT,SNAP,END};
static const double e_loop_drums[] = {TB,KIT,CLOCK(BK_CLOCK_P_QUANTIZE,0),LOOPP(2,BK_LOOP_P_SOURCE,1),LOOP(0,2),PAD(0,U),PROC(10,128,VOICE,VOICE),PROC(10,128,VOICE,VOICE),LOOP(0,2),PROC(30,128,ZERO,ZERO),SNAP,DRUM(BK_DRUM_P_ROUTE,0),LOOP(0,3),PAD(0,U),PROC(10,128,VOICE,VOICE),LOOP(0,3),PROC(10,128,ZERO,ZERO),SNAP,END};
static const double e_loop_quant[] = {TB,CLOCK(BK_CLOCK_P_BPM,180),CLOCK(BK_CLOCK_P_BEATS_PER_BAR,3),CLOCK(BK_CLOCK_P_QUANTIZE,1),PROC(5,128,ZERO,ZERO),LOOP(0,0),PROC(80,128,VOICE,VOICE),LOOP(0,0),PROC(160,128,NOISE,NOISE),SNAP,CLOCK(BK_CLOCK_P_RUN,0),SHORT,CLOCK(BK_CLOCK_P_RESET,1),CLOCK(BK_CLOCK_P_RUN,1),SHORT,SNAP,CLOCK(99,1),CLOCK(BK_CLOCK_P_BPM,NAN_),SHORT,SNAP,END};
static const double e_loop_fx[] = {TB,CLOCK(BK_CLOCK_P_QUANTIZE,0),LOOP(0,0),PROC(30,128,VOICE,VOICE),LOOP(0,0),ADD(T_L,0,BK_FX_DIST,1,U),FXP(T_L,0,1,0,30),ADD(T_L,0,BK_FX_DELAY,2,U),SHORT,SNAP,MIX(T_L,0,1,0.3),BYP(T_L,0,2,1),SHORT,MOVE(T_L,0,1,1),REMOVE(T_L,0,2),SHORT,FXCLEAR(T_L,0),SHORT,SNAP,END};
static const double e_loop_bad[] = {TB,LOOP(0,-1),LOOP(1,4),LOOP(2,NAN_),LOOP(3,99),LOOP(5,0),LOOP(7,0),LOOP(-1,0),SHORT,SNAP,LOOP(6,0),SHORT,SNAP,END};
static const double e_loop_panic[] = {TB,CLOCK(BK_CLOCK_P_QUANTIZE,0),LOOP(0,0),PROC(20,128,VOICE,VOICE),LOOP(0,0),LOOP(0,1),PROC(10,128,NOISE,NOISE),PANIC,SHORT,SNAP,LOOP(1,0),SHORT,LOOP(6,0),SHORT,SNAP,END};
static const double e_loop_mix[] = {TB,MADD(BK_FX_SAT,1),IO(BK_IO_MASTER_MIX,0.25),IO(BK_IO_OUT_GAIN,-3),CLOCK(BK_CLOCK_P_QUANTIZE,0),LOOP(0,0),PROC(20,128,VOICE,VOICE),IO(BK_IO_MASTER_MIX,0.75),PROC(20,128,VOICE,VOICE),LOOP(0,0),PROC(40,128,NOISE,NOISE),SNAP,END};

/* ---- Smart Voice. Voice keys: 0 enabled ... 9 monitor. Cal ops: 0 centroid
   1 attack 2 pad 3 capture 4 clear 5 reset 6 detreset. */
static const double e_voice[] = {TB,KIT,VOICEP(BK_VOICE_ENABLED,1),PROC(60,128,BEAT,BEAT),SNAP,IO(BK_IO_MUTE,1),PROC(60,128,BEAT,BEAT),SNAP,VOICEP(BK_VOICE_ENABLED,0),PROC(20,128,BEAT,BEAT),SNAP,END};
static const double e_voice_params[] = {TB,KIT,VOICEP(BK_VOICE_ENABLED,1),VOICEP(BK_VOICE_SENSITIVITY,0.9),VOICEP(BK_VOICE_FLOOR_DB,-50),VOICEP(BK_VOICE_MIN_GAP_MS,30),VOICEP(BK_VOICE_MODE,1),VOICEP(BK_VOICE_MARGIN,0.1),VOICEP(BK_VOICE_VEL_MIN,0.4),VOICEP(BK_VOICE_VEL_DB,30),PROC(80,128,BEAT,BEAT),SNAP,VOICEP(BK_VOICE_FEATURE_MS,5),VOICEP(BK_VOICE_MONITOR,1),PROC(40,128,BEAT,NOISE),VOICEP(99,1),VOICEP(BK_VOICE_ENABLED,NAN_),SHORT,SNAP,END};
static const double e_voice_cal[] = {TB,KIT,VOICEP(BK_VOICE_ENABLED,1),VCAL(2,0,1,0),VCAL(2,1,0,0),VCAL(2,2,U,0),VCAL(2,3,-0.5,0),VCAL(0,0,1,0.3),VCAL(0,1,2.7,0.8),VCAL(1,2,1,0.4),VCAL(1,-1,0,0.4),VCAL(0,9,0,1),PROC(60,128,BEAT,BEAT),SNAP,VCAL(5,0,0,0),VCAL(6,0,0,0),PROC(20,128,BEAT,BEAT),SNAP,VCAL(9,0,0,0),VCAL(-1,0,0,0),SNAP,END};
static const double e_voice_capture[] = {TB,VOICEP(BK_VOICE_ENABLED,1),VCAL(3,1,0,0),PROC(80,128,BEAT,BEAT),SNAP,CAPS(-1,12),VCAL(3,U,0,0),PROC(40,128,BEAT,BEAT),SNAP,CAPS(0,12),VCAL(4,0,0,0),SNAP,CAPS(0,3),VCAL(3,2.9,0,0),PROC(400,128,BEAT,BEAT),SNAP,CAPS(0,90),END};
static const double e_voice_mixed[] = {TB,KIT,VOICEP(BK_VOICE_ENABLED,1),IO(BK_IO_IN_GAIN,-30),IO(BK_IO_SWAP,1),IO(BK_IO_MONO,1),DRUM(BK_DRUM_P_ROUTE,2),MADD(BK_FX_COMP,1),PROC(80,128,BEAT,VOICE),SNAP,PANIC,PROC(20,128,BEAT,VOICE),SNAP,END};

/* ---- everything at once */
static const double e_combo[] = {TB,KIT,FLOAD(VOICE,RAMP,40000,44100),FILEP(BK_FILE_P_PLAY,1),FILEP(BK_FILE_P_LOOP,1),FROUTE(3),MADD(BK_FX_VOCODER,1),MP(1,BK_P_VOCODER_SOURCE,1),MADD(BK_FX_PITCH,2),MP(2,BK_P_PITCH_PITCH,-5),MADD(BK_FX_REVERB,3),MADD(BK_FX_CHARACTER,4),MP(4,BK_P_CHARACTER_NOISE,60),ADD(T_P,0,BK_FX_SAT,5,U),VOICEP(BK_VOICE_ENABLED,1),IO(BK_IO_MASTER_MIX,0.8),IO(BK_IO_IN_GAIN,3),CLOCK(BK_CLOCK_P_QUANTIZE,0),LOOP(0,0),PROC(60,128,BEAT,VOICE),LOOP(0,0),ADD(T_L,0,BK_FX_PHASER,6,U),FXP(T_L,0,6,BK_P_PHASER_SHAPE,4),PROC(60,128,BEAT,NOISE),SNAP,PROC(30,128,ZERO,ZERO),SNAP,END};
/* ---- verbs whose effect the scripts above leave unobservable. */
/* A mid-chain move: [1,2,3] -> [1,3,2], order-sensitive (dist, delay, sat). */
static const double e_move_mid[] = {TB,MADD(BK_FX_DIST,1),MP(1,0,30),MADD(BK_FX_DELAY,2),MADD(BK_FX_SAT,3),SHORT,MOVE(T_M,0,3,1),SHORT,SNAP,END};
/* A reset on a slot with a live tail, then silence. */
static const double e_reset_tail[] = {TB,MADD(BK_FX_DELAY,1),SHORT,FXRESET(T_M,0,1),PROC(120,128,ZERO,ZERO),SNAP,END};
/* NaN is falsy: bypass and swap both switch off. */
static const double e_nan_flags[] = {TB,MADD(BK_FX_DIST,1),MP(1,0,30),BYP(T_M,0,1,1),IO(BK_IO_SWAP,1),PROC(6,128,VOICE,NOISE),BYP(T_M,0,1,NAN_),IO(BK_IO_SWAP,NAN_),PROC(6,128,VOICE,NOISE),SNAP,END};
/* Gate mode (< 0.5) is the one a pad-off releases. */
static const double e_pad_gate[] = {TB,KIT,PADP(0,BK_PAD_P_MODE,0),PAD(0,U),PROC(3,128,ZERO,ZERO),PADOFF(0),PROC(12,128,ZERO,ZERO),SNAP,END};
/* A second layer: round robin between the beat and the click. */
static const double e_pad_layers[] = {TB,KIT,PLOAD(0,1,NOISE,600,48000),PAD(0,U),SHORT,PAD(0,U),SHORT,SNAP,END};
/* Clear of one track leaves the other playing. */
static const double e_loop_two[] = {TB,CLOCK(BK_CLOCK_P_QUANTIZE,0),LOOP(0,0),PROC(20,128,VOICE,VOICE),LOOP(0,0),LOOP(0,1),PROC(20,128,NOISE,NOISE),LOOP(0,1),SHORT,LOOP(3,0),SHORT,SNAP,END};
/* A peak of exactly 0.999 (0.5 * 1.998; pow(10, 6.0119096777992693 * 0.05)
   is 1.998 exactly in glibc and V8) sets both clip flags: `>=`, not `>`. */
#define G1998 6.0119096777992693
static const double e_clip_exact[] = {TB,LEVEL(0.5),IO(BK_IO_IN_GAIN,G1998),PROC(200,128,DC,DC),SNAP,TB,LEVEL(0.5),IO(BK_IO_OUT_GAIN,G1998),PROC(200,128,DC,DC),SNAP,END};
/* Sums past the 1e30 sanitize bound: file + input, drums + input, and the
   order of the two adds when both reach the input. */
static const double e_huge_sum[] = {TB,LEVEL(9e29),FLOAD(DC,DC,20000,48000),FILEP(BK_FILE_P_PLAY,1),LEVEL(5e28),PLOAD(0,0,DC,20000,48000),LEVEL(9e29),DRUM(BK_DRUM_P_ROUTE,2),PAD(0,U),PROC(20,128,DC,DC),SNAP,END};
static const double e_drum_huge[] = {TB,LEVEL(9e29),PLOAD(0,0,DC,20000,48000),DRUM(BK_DRUM_P_ROUTE,2),PAD(0,U),PROC(4,128,DC,DC),SNAP,END};
/* A panned pad, through the chain and direct, with a master mix below 1. */
static const double e_drum_pan[] = {TB,KIT,PADP(0,BK_PAD_P_PAN,-0.8),IO(BK_IO_MASTER_MIX,0.5),PAD(0,U),SHORT,SNAP,DRUM(BK_DRUM_P_ROUTE,2),PAD(0,U),SHORT,SNAP,END};
/* Smart Voice's mono feed: a NaN, an inf, a tiny, and a pair whose double
   mean is <= 1e30 but whose float sum's mean is not. */
static const double e_voice_edge[] = {TB,VOICEP(BK_VOICE_ENABLED,1),PROC(4,128,BEAT,BEAT),POKE(0,5,NAN_),POKE(1,6,INF_),POKE(0,7,1e-20),POKE(0,9,1.999999878979205e+30),POKE(1,9,7.555786372591432e+22),PROC(1,128,BEAT,BEAT),SNAP,END};
/* The output stage's clamp and sanitize, both paths: 2.0 clamps, 5e30
   clamps (not sanitises), and a sub-1e-18 output sanitises. */
static const double e_out_edge[] = {TB,LEVEL(0.5),IO(BK_IO_OUT_GAIN,12),PROC(40,128,DC,DC),SNAP,IO(BK_IO_OUT_GAIN,620),PROC(40,128,DC,DC),SNAP,TB,CLOCK(BK_CLOCK_P_QUANTIZE,0),LOOP(0,0),LEVEL(1.5e-18),IO(BK_IO_OUT_GAIN,-12),PROC(40,128,DC,DC),SNAP,END};
/* Smart Voice firing more than one pad in one 4096-frame block: a noise-kind
   onset in a 200-frame block, then a rewind to the beat's first (triangle-kind)
   onset. Measured, not designed: the `hit pad` mutant is what shows it. */
static const double e_voice_burst[] = {INIT(48000,4096),KIT,PROC(1,4096,ZERO,ZERO),PROC(1,704,ZERO,ZERO),VOICEP(BK_VOICE_ENABLED,1),VOICEP(BK_VOICE_MIN_GAP_MS,1),PROC(1,200,BEAT,BEAT),REWIND,PROC(2,4096,BEAT,BEAT),SNAP,END};
/* A drum-sourced track recorded after the drums stop sounding to the engine
   (route off): the stale drum block must not be recorded. Panned. */
static const double e_loop_src[] = {TB,PLOAD(0,0,NOISE,20000,48000),CLOCK(BK_CLOCK_P_QUANTIZE,0),PADP(0,BK_PAD_P_PAN,-0.8),LOOPP(2,BK_LOOP_P_SOURCE,1),PAD(0,U),PROC(6,128,ZERO,ZERO),LOOP(0,2),PROC(6,128,ZERO,ZERO),DRUM(BK_DRUM_P_ROUTE,0),PROC(10,128,ZERO,ZERO),LOOP(0,2),PROC(20,128,ZERO,ZERO),SNAP,END};
static const double mixed_inits[] = {TB,KIT,PAD(0,U),MADD(BK_FX_DELAY,1),SHORT,INIT(8000,32),PROC(20,32,VOICE,VOICE),PLOAD(0,0,BEAT,300,8000),PAD(0,U),MADD(BK_FX_REVERB,1),PROC(20,32,VOICE,VOICE),SNAP,END};

#define S(n) {#n,n,sizeof(n)/sizeof(n[0])}
typedef struct { const char *name; const double *ops; size_t n; } script;
static const script scripts[] = {
  S(e_default),S(e_fresh),S(e_silence),S(e_inplace),S(e_blocks),S(e_rates),
  S(e_io_gain),S(e_io_flags),S(e_io_mute_gain),S(e_io_bypass),S(e_io_mix),S(e_io_unknown),S(e_clip),S(e_clip_edge),S(e_poke),S(e_huge),S(e_dc),
  S(e_chain),S(e_chain_at),S(e_chain_opts),S(e_chain_bad),S(e_chain_full),S(e_all_types),S(e_random),
  S(e_latency),S(e_latency_other),
  S(e_file),S(e_file_params),S(e_file_end),S(e_carrier),
  S(e_drums),S(e_drums_mix),S(e_drum_params),S(e_drum_bad),S(e_drum_clear),S(e_drum_idle),
  S(e_padfx),S(e_padfx_order),S(e_padfx_bad),S(e_fx_nochain),S(e_padfx_clear),
  S(e_loop),S(e_loop_params),S(e_loop_drums),S(e_loop_quant),S(e_loop_fx),S(e_loop_bad),S(e_loop_panic),S(e_loop_mix),
  S(e_voice),S(e_voice_params),S(e_voice_cal),S(e_voice_capture),S(e_voice_mixed),
  S(e_move_mid),S(e_reset_tail),S(e_nan_flags),S(e_pad_gate),S(e_pad_layers),S(e_loop_two),S(e_clip_exact),
  S(e_huge_sum),S(e_drum_huge),S(e_drum_pan),S(e_voice_edge),S(e_out_edge),S(e_voice_burst),S(e_loop_src),
  S(e_combo),S(mixed_inits)};

/* Gated two-period voice-like buzz, as in the vocoder battery. */
static void fill_voice(float *dst) {
  int j;
  for (j = 0; j < SIG_N; j++) {
    const double p1 = (double)(j % 53) / 53.0 - 0.5;
    const double p2 = (double)(j % 37) / 37.0 - 0.5;
    const double v1 = p1 * 0.6;
    const double v2 = p2 * 0.2;
    const double v = v1 + v2;
    dst[j] = (float)((j % 6000) < 4000 ? v : 0.0);
  }
}

/* A beatbox stand-in: a hit every 4800 frames, cycling a low triangle thump,
   a noise burst and a mix, each with a 1200-frame linear decay. One correctly
   rounded operation per statement, so it is bit-exact in JS. */
static void fill_beat(float *dst, const float *noise) {
  int j;
  for (j = 0; j < SIG_N; j++) {
    const int k = j % 4800;
    const int kind = (j / 4800) % 3;
    const double env = k < 1200 ? (double)(1200 - k) / 1200.0 : 0.0;
    const double ph = (double)(j % 80) / 40.0;
    const double tri = fabs(ph - 1.0) * 2.0 - 1.0;
    const double nz = (double)noise[j];
    double v;
    if (kind == 0) {
      v = tri * 0.8;
    } else if (kind == 1) {
      v = nz * 0.5;
    } else {
      const double a = nz * 0.3;
      const double b = tri * 0.3;
      v = a + b;
    }
    dst[j] = (float)(v * env);
  }
}

int main(int argc, char **argv) {
  FILE *f;
  size_t i;
  int s, k;

  if (argc < 2) {
    fprintf(stderr, "usage: %s <out.bin>\n", argv[0]);
    return 2;
  }
  f = fopen(argv[1], "wb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 1;
  }
  for (s = 0; s < N_SIGS; s++) {
    bk_fill_signal(g_tmp, SIG_N, s);
    for (k = 0; k < SIG_N; k++) g_sig[s][k] = (float)g_tmp[k];
  }
  fill_voice(g_sig[SIG_VOICE]);
  fill_beat(g_sig[SIG_BEAT], g_sig[BK_SIG_NOISE]);
  /* Argument guards (C-only; no JS counterpart). Each must refuse. */
  {
    static bk_engine guard;
    float one = 0.0f;
    if (bk_engine_init(NULL, 48000.0, 128, &one) != -1 || bk_engine_init(&guard, 48000.0, 128, NULL) != -1 ||
        bk_engine_init(&guard, 48000.0, 0, &one) != -1) {
      fprintf(stderr, "bk_engine_init argument guard did not refuse\n");
      fclose(f);
      return 1;
    }
  }
  /* sample_rate 0 passes the engine's own guard and is refused by the drum rack's init. */
  {
    static bk_engine guard0;
    float *st0 = (float *)calloc(bk_engine_storage_floats(0.0, 128) + 1, sizeof(float));
    int r0 = st0 ? bk_engine_init(&guard0, 0.0, 128, st0) : 0;
    free(st0);
    if (r0 != -1) {
      fprintf(stderr, "bk_engine_init argument guard did not refuse\n");
      fclose(f);
      return 1;
    }
  }
  bk_parity_open(f);
  for (i = 0; i < sizeof(scripts) / sizeof(scripts[0]); i++) {
    run_script(f, scripts[i].name, scripts[i].ops, scripts[i].n);
  }
  free_fx();
  free(g_store);
  if (!bk_parity_close(f)) {
    fprintf(stderr, "cannot patch record count\n");
    fclose(f);
    return 1;
  }
  fprintf(stderr, "wrote %u records to %s\n", bk_parity_records, argv[1]);
  fclose(f);
  return 0;
}
