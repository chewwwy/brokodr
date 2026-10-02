/*
 * Parity dump for the C port of dsp/effects/drive.js (Distortion, Saturation,
 * BitCrusher).
 *
 * Producer half of the oracle; scripts/verify-drive-parity.mjs is the
 * consumer. See parity-io.h for the stream format.
 *
 * Same shape as parity-eq.c: every case is an opcode script, the script
 * travels as the record's params, and the JS runner replays it op for op.
 * Every op goes through bk_drive_vt / bk_crush_vt. OP_INIT picks the effect
 * (0 dist, 1 sat, 2 crush); a script starts as a 48 kHz, 128-frame dist.
 *
 * Per PROCESS block: the smoothers, the block-rate snapshot, the meter (through
 * the vtable, 0 when it has none) and the discrete state (out64), then every
 * output sample (out32). SNAP adds the whole struct, filters included, and the
 * float32 work buffers (pre-HP output and both oversampler buffers).
 *
 * Randomness: the crusher's Math.random() is a seeded xorshift32 the JS
 * mirrors (OP_SEED), reseeded to 1 at every script start and every INIT. Seed 0
 * selects the crusher's internal generator, which the JS mirrors too. Every
 * draw is counted.
 *
 * Scripts named x_* exercise the deliberate divergences in drive.h (NaN curve,
 * foldback past BK_DRIVE_FOLD_LIMIT, frames > max_block). The verifier replays
 * them against the C contract expressed in JS, and asserts that ONLY x_*
 * scripts need it.
 *
 * Usage: parity-drive <out.bin>
 */

#include "brokodr/dsp/drive.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

enum {
  OP_END = 0,
  OP_INIT = 1,    /* a = type (0 dist, 1 sat, 2 crush), b = sample rate, c = max block */
  OP_PARAM = 2,   /* a = key, b = value */
  OP_PROCESS = 3, /* a = blocks, b = block size, c = left signal, d = right signal */
  OP_RESET = 4,
  OP_SNAP = 5,
  OP_POKE = 6,    /* next block only: channel a (0/1), sample b, value c */
  OP_REWIND = 7,  /* stimulus cursor back to 0 */
  OP_SEED = 8,    /* crusher random: a = seed, 0 = the internal generator */
  OP_SHAPE = 9,   /* push bk_drive_shape(a, b) */
  OP_MONO = 10    /* as OP_PROCESS on one buffer, l and r aliased: a = blocks, b = size, c = signal */
};
#define OPW 5

#define SIG_N 65536
#define N_SIGS 5
#define MAX_BLOCK 4096
#define MAX_POKES 32
#define MAX_P64 2000000
#define MAX_P32 4000000

/* Per-block readings. Field order is the contract with blockState(). */
#define BK_DRIVE_BLOCK 12
#define BK_CRUSH_BLOCK 9
/* Struct snapshots (doubles). Field order is the contract with snapState(). */
#define BK_DRIVE_SNAP 153
#define BK_CRUSH_SNAP 36

#define NAN_ (-3e9)
#define INF_ (3e9)
#define NINF_ (-4e9)

static float g_sig[N_SIGS][SIG_N];
static double g_tmp[SIG_N];
static float g_l[MAX_BLOCK];
static float g_r[MAX_BLOCK];
static double g_p64[MAX_P64];
static float g_p32[MAX_P32];
static unsigned int n64, n32;

static bk_drive g_drive;
static bk_crush g_crush;
static float g_scratch[BK_DRIVE_SCRATCH_FLOATS(MAX_BLOCK)];
static int g_type;
static void *g_fx;
static const bk_effect_vt *g_vt;

static int g_cursor;
static int n_pokes;
static int poke_ch[MAX_POKES];
static int poke_at[MAX_POKES];
static double poke_v[MAX_POKES];

/* Mirrored in the verifier as Math.random. */
static unsigned int g_seed;
static double g_draws;
/* The state travels through the user pointer (always &g_seed), so a crusher
   that dropped its random_user would be seen. */
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
/* Counts draws made through the crusher's internal generator, delegating to
   the function bk_crush_set_random(NULL) installed so that it is what runs. */
static bk_random_fn g_internal;
static double counted_internal(void *user) {
  g_draws += 1.0;
  return g_internal(user);
}

static void push64(double v) {
  if (n64 < MAX_P64) g_p64[n64++] = v;
}
static void push32(float v) {
  if (n32 < MAX_P32) g_p32[n32++] = v;
}

static void smoother_state(const bk_smoother *s) {
  push64(s->value);
  push64(s->target);
  push64(s->a);
}

static void biquad_state(const bk_biquad *f) {
  push64(f->b0);
  push64(f->b1);
  push64(f->b2);
  push64(f->a1);
  push64(f->a2);
  push64(f->z1);
  push64(f->z2);
  push64((double)f->type);
  push64(f->freq);
  push64(f->q);
  push64(f->gain_db);
}

static void lp2_state(const bk_lp2 *f) {
  push64(f->b0);
  push64(f->b1);
  push64(f->b2);
  push64(f->a1);
  push64(f->a2);
  push64(f->z1);
  push64(f->z2);
}

static void block_state(void) {
  const double meter = g_vt->meter ? g_vt->meter(g_fx) : 0.0;
  if (g_type == 2) {
    const bk_crush *c = &g_crush;
    push64(c->drive_sm.value);
    push64(c->drive_sm.target);
    push64(c->out_sm.value);
    push64(c->out_sm.target);
    push64(c->phase);
    push64(c->hold_l);
    push64(c->hold_r);
    push64(g_draws);
    push64(meter);
  } else {
    const bk_drive *d = &g_drive;
    push64(d->drive.value);
    push64(d->drive.target);
    push64(d->bias_sm.value);
    push64(d->bias_sm.target);
    push64(d->out_sm.value);
    push64(d->out_sm.target);
    push64(d->drive_val);
    push64(d->bias_val);
    push64(meter);
    push64((double)d->curve);
    push64(d->tone_mode);
    push64((double)d->oversample);
  }
}

static void snap_state(void) {
  int k;
  if (g_type == 2) {
    const bk_crush *c = &g_crush;
    push64(c->sr);
    push64(c->bits);
    push64(c->rate_hz);
    push64(c->dither_amt);
    push64(c->phase);
    push64(c->hold_l);
    push64(c->hold_r);
    push64(c->anti_alias);
    smoother_state(&c->drive_sm);
    smoother_state(&c->out_sm);
    biquad_state(&c->lp_l);
    biquad_state(&c->lp_r);
  } else {
    const bk_drive *d = &g_drive;
    push64(d->sr);
    push64((double)d->max_block);
    push64((double)d->curve);
    push64(d->tone_freq);
    push64(d->tone_mode);
    push64(d->pre_freq);
    push64((double)d->oversample);
    push64(d->drive_val);
    push64(d->bias_val);
    push64(d->meter);
    smoother_state(&d->drive);
    smoother_state(&d->out_sm);
    smoother_state(&d->bias_sm);
    for (k = 0; k < 2; k++) {
      int j;
      for (j = 0; j < 3; j++) lp2_state(&d->os[k].up_filters[j]);
      for (j = 0; j < 3; j++) lp2_state(&d->os[k].down_filters[j]);
    }
    push64(d->dc_l.r);
    push64(d->dc_l.x1);
    push64(d->dc_l.y1);
    push64(d->dc_r.r);
    push64(d->dc_r.x1);
    push64(d->dc_r.y1);
    biquad_state(&d->tone_l);
    biquad_state(&d->tone_r);
    biquad_state(&d->pre_l);
    biquad_state(&d->pre_r);
    for (k = 0; k < d->max_block; k++) push32(d->tmp_l[k]);
    for (k = 0; k < d->max_block; k++) push32(d->tmp_r[k]);
    for (k = 0; k < d->os[0].up_len; k++) push32(d->os[0].up[k]);
    for (k = 0; k < d->os[1].up_len; k++) push32(d->os[1].up[k]);
  }
}

static double unsentinel(double v) {
  if (v == NAN_) return (double)NAN;
  if (v == INF_) return (double)INFINITY;
  if (v == NINF_) return -(double)INFINITY;
  return v;
}

static void vt_flags(void) {
  /* What the chain will see: no carrier bus, no latency; a meter on dist/sat. */
  push64(g_vt->set_carrier_bus == NULL ? 1.0 : 0.0);
  push64(g_vt->latency_samples == NULL ? 1.0 : 0.0);
  push64(g_vt->meter == NULL ? 1.0 : 0.0);
}

static void init_fx(int type, double sr, int mb) {
  g_type = type;
  if (type == 2) {
    bk_crush_init(&g_crush, sr);
    g_seed = 1u;
    bk_crush_set_random(&g_crush, test_random, &g_seed);
    g_fx = &g_crush;
    g_vt = &bk_crush_vt;
  } else {
    if (type == 1) bk_sat_init(&g_drive, sr, mb, g_scratch);
    else bk_dist_init(&g_drive, sr, mb, g_scratch);
    g_fx = &g_drive;
    g_vt = &bk_drive_vt;
  }
  vt_flags();
}

static void run_script(FILE *f, const char *name, const double *ops, size_t n_ops) {
  size_t i;
  int k, j;

  n64 = 0;
  n32 = 0;
  g_cursor = 0;
  n_pokes = 0;
  g_draws = 0.0;
  g_seed = 1u;
  init_fx(0, 48000.0, 128);

  for (i = 0; i + OPW <= n_ops; i += OPW) {
    const int op = (int)ops[i];
    const double a = unsentinel(ops[i + 1]), b = unsentinel(ops[i + 2]);
    const double c = unsentinel(ops[i + 3]), d = unsentinel(ops[i + 4]);
    switch (op) {
      case OP_END:
        i = n_ops;
        break;
      case OP_INIT:
        init_fx((int)a, b, (int)c);
        break;
      case OP_PARAM:
        g_vt->set_param(g_fx, (int)a, b);
        break;
      case OP_PROCESS: {
        const int blocks = (int)a, bs = (int)b, sl = (int)c, sr = (int)d;
        for (k = 0; k < blocks; k++) {
          for (j = 0; j < bs; j++) {
            const int at = (g_cursor + j) % SIG_N;
            g_l[j] = g_sig[sl][at];
            g_r[j] = -0.5f * g_sig[sr][at];
          }
          g_cursor = (g_cursor + bs) % SIG_N;
          for (j = 0; j < n_pokes; j++) {
            if (poke_at[j] < bs) (poke_ch[j] ? g_r : g_l)[poke_at[j]] = (float)poke_v[j];
          }
          n_pokes = 0;
          g_vt->process(g_fx, g_l, g_r, bs);
          block_state();
          for (j = 0; j < bs; j++) push32(g_l[j]);
          for (j = 0; j < bs; j++) push32(g_r[j]);
        }
        break;
      }
      case OP_MONO: {
        const int blocks = (int)a, bs = (int)b, sl = (int)c;
        for (k = 0; k < blocks; k++) {
          for (j = 0; j < bs; j++) g_l[j] = g_sig[sl][(g_cursor + j) % SIG_N];
          g_cursor = (g_cursor + bs) % SIG_N;
          for (j = 0; j < n_pokes; j++) {
            if (poke_at[j] < bs) g_l[poke_at[j]] = (float)poke_v[j];
          }
          n_pokes = 0;
          g_vt->process(g_fx, g_l, g_l, bs);
          block_state();
          for (j = 0; j < bs; j++) push32(g_l[j]);
        }
        break;
      }
      case OP_RESET:
        g_vt->reset(g_fx);
        break;
      case OP_SNAP:
        snap_state();
        break;
      case OP_POKE:
        if (n_pokes < MAX_POKES) {
          poke_ch[n_pokes] = (int)a;
          poke_at[n_pokes] = (int)b;
          poke_v[n_pokes] = c;
          n_pokes++;
        }
        break;
      case OP_REWIND:
        g_cursor = 0;
        break;
      case OP_SEED:
        if (a == 0.0) {
          bk_crush_set_random(&g_crush, NULL, NULL);
          /* Count draws without changing what the internal generator does. */
          g_internal = g_crush.random;
          g_crush.random = counted_internal;
        } else {
          g_seed = (unsigned int)a;
          bk_crush_set_random(&g_crush, test_random, &g_seed);
        }
        break;
      case OP_SHAPE:
        push64(bk_drive_shape((int)a, b));
        break;
      default:
        break;
    }
  }
  snap_state();
  if (n64 >= MAX_P64 || n32 >= MAX_P32) {
    fprintf(stderr, "%s: payload overflow\n", name);
    exit(3);
  }
  bk_parity_emit(f, name, ops, (unsigned int)n_ops, g_p64, n64, g_p32, n32);
}

/* --- the scripts -------------------------------------------------------- */

#define NOISE BK_SIG_NOISE
#define RAMP BK_SIG_RAMP
#define STEP BK_SIG_STEP
#define IMP BK_SIG_IMPULSE
#define ZERO BK_SIG_ZERO

#define DRV BK_P_DIST_DRIVE
#define CRV BK_P_DIST_CURVE
#define TONE BK_P_DIST_TONE
#define TMODE BK_P_DIST_TONEMODE
#define BIAS BK_P_DIST_BIAS
#define PREHP BK_P_DIST_PREHP
#define DOUT BK_P_DIST_OUTPUT
#define OS BK_P_DIST_OVERSAMPLE

#define BITS BK_P_CRUSH_BITS
#define RATE BK_P_CRUSH_RATE
#define DITH BK_P_CRUSH_DITHER
#define CDRV BK_P_CRUSH_DRIVE
#define COUT BK_P_CRUSH_OUTPUT
#define SMOOTH BK_P_CRUSH_SMOOTH

#define O(op, a, b, c, d) (double)(op), (double)(a), (double)(b), (double)(c), (double)(d)
#define INIT(t, sr, mb) O(OP_INIT, t, sr, mb, 0)
#define DIST O(OP_INIT, 0, 48000, 128, 0)
#define SAT O(OP_INIT, 1, 48000, 128, 0)
#define CRUSH O(OP_INIT, 2, 48000, 128, 0)
#define SET(k, v) (double)OP_PARAM, (double)(k), (double)(v), 0.0, 0.0
#define PROC(n, bs, l, r) O(OP_PROCESS, n, bs, l, r)
#define SNAP O(OP_SNAP, 0, 0, 0, 0)
#define RESET O(OP_RESET, 0, 0, 0, 0)
#define POKE(ch, at, v) O(OP_POKE, ch, at, v, 0)
#define REWIND O(OP_REWIND, 0, 0, 0, 0)
#define SEED(s) O(OP_SEED, s, 0, 0, 0)
#define SHAPE(c, x) O(OP_SHAPE, c, x, 0, 0)
#define MONO(n, bs, s) O(OP_MONO, n, bs, s, 0)
#define END O(OP_END, 0, 0, 0, 0)

/* ---- distortion / saturation ---- */

static const double s_default[] = {PROC(4, 128, NOISE, RAMP), SNAP, END};
static const double s_sat_default[] = {SAT, PROC(4, 128, NOISE, RAMP), SNAP, END};
/* Every curve, oversampled, driven hard enough to bend. */
#define CURVE_RUN(k) SET(CRV, k), PROC(3, 128, NOISE, RAMP)
static const double s_curves[] = {SET(DRV, 18), PROC(8, 128, NOISE, RAMP), CURVE_RUN(0), CURVE_RUN(1), CURVE_RUN(2),
                                  CURVE_RUN(3), CURVE_RUN(4), CURVE_RUN(5), SNAP, END};
static const double s_curves_noos[] = {SET(OS, 0), SET(DRV, 18), PROC(8, 128, NOISE, RAMP), CURVE_RUN(0),
                                       CURVE_RUN(1), CURVE_RUN(2), CURVE_RUN(3), CURVE_RUN(4), CURVE_RUN(5), SNAP, END};
static const double s_sat_curves[] = {SAT, SET(DRV, 24), SET(BIAS, 0.2), PROC(8, 128, NOISE, RAMP), CURVE_RUN(5),
                                      CURVE_RUN(4), CURVE_RUN(3), CURVE_RUN(2), CURVE_RUN(1), CURVE_RUN(0), SNAP, END};
/* Math.round and the clamp: half-way points, the 0.49999999999999994 trap,
   -0, negatives, out of range, both infinities. */
#define CR(v) SET(CRV, v), PROC(1, 64, NOISE, RAMP)
static const double s_curve_round[] = {SET(DRV, 20), CR(0.5), CR(1.5), CR(2.4999999999999996), CR(2.5), CR(3.5),
                                       CR(4.5), CR(4.49999999999999), CR(0.49999999999999994), CR(-0.3), CR(-0.7),
                                       CR(-0.0), CR(7), CR(5.5), CR(NINF_), CR(INF_), CR(1e300), CR(-1e300),
                                       SNAP, END};
/* Bias moves the operating point: asymmetric curves, and a block-rate read
   while the smoother glides (block sizes 1 and 37). */
static const double s_bias[] = {SET(CRV, 0), SET(DRV, 12), SET(BIAS, 0.4), PROC(4, 128, NOISE, RAMP), SET(CRV, 3),
                                SET(BIAS, -0.5), PROC(4, 128, NOISE, RAMP), SET(CRV, 5), SET(BIAS, 0.5),
                                PROC(40, 1, NOISE, RAMP), PROC(9, 37, NOISE, RAMP), SET(BIAS, NAN_),
                                PROC(2, 128, NOISE, RAMP), SNAP, SET(BIAS, 0), RESET, PROC(2, 128, NOISE, RAMP), END};
/* Tone: highpass only when tonemode rounds to exactly 1. */
#define TM(v) SET(TMODE, v), PROC(2, 128, NOISE, RAMP)
static const double s_tonemode[] = {SET(DRV, 6), SET(TONE, 2000), TM(1), TM(0), TM(0.5), TM(0.49999999999999994),
                                    TM(1.4999999999999998), TM(1.5), TM(-0.3), TM(NAN_), TM(2), TM(INF_), TM(1),
                                    SNAP, END};
static const double s_tone[] = {SET(TONE, 200), PROC(3, 128, NOISE, RAMP), SET(TONE, 20000), PROC(3, 128, NOISE, RAMP),
                                SET(TONE, 30000), PROC(3, 128, NOISE, RAMP), SET(TONE, 5), PROC(3, 128, NOISE, RAMP),
                                SET(TMODE, 1), SET(TONE, 800), PROC(3, 128, NOISE, RAMP), SET(TONE, NAN_),
                                PROC(2, 128, NOISE, RAMP), SNAP, SET(TONE, 900), RESET, PROC(2, 128, NOISE, RAMP),
                                SNAP, END};
static const double s_prehp[] = {SET(PREHP, 800), PROC(3, 128, NOISE, RAMP), SET(PREHP, 5), PROC(3, 128, NOISE, RAMP),
                                 SET(PREHP, 30000), PROC(3, 128, NOISE, RAMP), SET(PREHP, 120), SET(OS, 0),
                                 PROC(3, 128, NOISE, RAMP), SET(PREHP, NAN_), PROC(2, 128, NOISE, RAMP), SNAP,
                                 SET(PREHP, 50), RESET, PROC(2, 128, NOISE, RAMP), SNAP, END};
/* Output 6165 dB (1.78e308, still finite) overflows the double product on a
   DC-blocked, unfiltered square: the meter goes to inf, the samples sanitise
   to 0. */
static const double s_output[] = {SET(DOUT, -36), PROC(6, 128, NOISE, RAMP), SET(DOUT, 12), PROC(6, 128, NOISE, RAMP),
                                  SET(DRV, 40), SET(TONE, 20000), SET(DOUT, 6165), PROC(30, 128, NOISE, RAMP),
                                  SET(DRV, 12), SET(TONE, 8000),
                                  SET(DOUT, NAN_), PROC(2, 128, NOISE, RAMP), SNAP, SET(DOUT, INF_),
                                  PROC(2, 128, NOISE, RAMP), SET(DOUT, NINF_), PROC(2, 128, NOISE, RAMP), SNAP, END};
static const double s_drive[] = {SET(DRV, 0), PROC(3, 128, NOISE, RAMP), SET(DRV, 40), PROC(30, 128, NOISE, RAMP),
                                 SET(DRV, NINF_), PROC(4, 128, NOISE, RAMP), SET(DRV, NAN_), PROC(2, 128, NOISE, RAMP),
                                 SNAP, END};
static const double s_drive_inf[] = {SET(CRV, 4), SET(DRV, INF_), PROC(3, 128, NOISE, RAMP), SET(CRV, 1),
                                     PROC(2, 128, NOISE, RAMP), SET(CRV, 0), PROC(2, 128, NOISE, RAMP), SNAP, END};
/* oversample is v >= 0.5; NaN is off. Toggled mid-stream, filters keep state. */
#define OSV(v) SET(OS, v), PROC(2, 128, NOISE, RAMP)
static const double s_oversample[] = {SET(DRV, 20), SET(CRV, 2), OSV(0), OSV(0.5), OSV(0.49999999999999994), OSV(1),
                                      OSV(NAN_), OSV(INF_), OSV(-1), OSV(0.75), SNAP, END};
static const double s_reset[] = {SET(DRV, 24), SET(CRV, 3), SET(BIAS, 0.3), SET(TONE, 3000), SET(PREHP, 200),
                                 PROC(6, 128, NOISE, RAMP), SNAP, RESET, SNAP, PROC(2, 128, NOISE, RAMP), SET(OS, 0),
                                 PROC(2, 128, NOISE, RAMP), RESET, SNAP, PROC(2, 128, IMP, IMP), SNAP, END};
/* Block sizes: 0 (drive/bias still step once), 1, odd, and max. */
static const double s_blocks[] = {SET(DRV, 12), SET(BIAS, 0.25), PROC(3, 0, NOISE, RAMP), PROC(20, 1, NOISE, RAMP),
                                  PROC(7, 7, NOISE, RAMP), PROC(3, 128, NOISE, RAMP), PROC(2, 0, NOISE, RAMP), PROC(1, -3, NOISE, RAMP),
                                  REWIND, PROC(1, 128, NOISE, RAMP), SNAP,
                                  END};
static const double s_rates[] = {INIT(0, 44100, 128), SET(DRV, 18), PROC(5, 128, NOISE, RAMP), SNAP,
                                 INIT(1, 96000, 128), SET(DRV, 18), PROC(5, 128, NOISE, RAMP), SNAP,
                                 INIT(0, 22050, 128), SET(DRV, 18), SET(TONE, 20000), PROC(5, 128, NOISE, RAMP), END};
static const double s_maxblock[] = {INIT(0, 48000, 1), SET(DRV, 12), PROC(40, 1, NOISE, RAMP), SNAP,
                                    INIT(0, 48000, 2048), SET(DRV, 30),
                                    PROC(3, 2048, NOISE, RAMP), SNAP, INIT(1, 48000, 333), PROC(2, 333, NOISE, RAMP),
                                    PROC(2, 100, NOISE, RAMP), SNAP, END};
/* Non-finite and extreme input samples on every non-fold curve, oversampled
   and not. The meter skips NaN frames but not inf ones. */
#define POKES                                                                                                   \
  POKE(0, 3, NAN_), POKE(1, 3, 0.5), POKE(0, 20, INF_), POKE(1, 40, NINF_), POKE(0, 60, 1e30), POKE(1, 61, -1e30), \
      POKE(0, 80, 1e-20), POKE(1, 100, 3)
static const double s_poke[] = {SET(DRV, 6), POKES, PROC(1, 128, NOISE, RAMP), PROC(2, 128, NOISE, RAMP),
                                SET(CRV, 0), POKES, PROC(2, 128, NOISE, RAMP), SET(CRV, 3), POKES,
                                PROC(2, 128, NOISE, RAMP), SET(CRV, 4), SET(OS, 0), POKES, PROC(2, 128, NOISE, RAMP),
                                SET(CRV, 5), POKES, PROC(2, 128, NOISE, RAMP), SNAP, RESET, PROC(2, 128, NOISE, RAMP),
                                SNAP, END};
static const double s_meter_nan[] = {SET(PREHP, 20), SET(OS, 0), POKE(0, 5, NAN_), POKE(1, 9, NAN_),
                                     PROC(1, 64, NOISE, RAMP), SET(CRV, 4), POKE(1, 0, NAN_), PROC(1, 64, STEP, STEP),
                                     RESET, PROC(1, 64, ZERO, ZERO), PROC(1, 64, ZERO, NOISE), SNAP, END};
/* Foldback inside the limit: drive 40 dB on a STEP (y up to ~50) and pokes
   up to |y| ~ 4000, every one through the JS loop. */
static const double s_fold[] = {SET(CRV, 2), SET(DRV, 40), PROC(4, 128, STEP, RAMP), SET(OS, 0),
                                PROC(4, 128, STEP, RAMP), POKE(0, 10, 30), POKE(1, 11, -38), POKE(0, 12, 0.8),
                                POKE(1, 13, -0.008), PROC(1, 128, ZERO, ZERO), SET(BIAS, -0.5),
                                PROC(4, 128, NOISE, RAMP), SET(OS, 1), PROC(4, 128, NOISE, NOISE), SNAP, END};
static const double s_signed_zero[] = {PROC(2, 128, ZERO, ZERO), SET(CRV, 0), POKE(0, 0, -0.0), POKE(1, 1, -0.0),
                                       PROC(2, 128, ZERO, ZERO), SET(OS, 0), SET(CRV, 5), PROC(2, 128, ZERO, ZERO),
                                       SET(CRV, 3), PROC(2, 128, ZERO, IMP), SNAP, END};
/* The shapers directly, inside the fold limit. */
#define SH6(x) SHAPE(0, x), SHAPE(1, x), SHAPE(2, x), SHAPE(3, x), SHAPE(4, x), SHAPE(5, x)
static const double s_shape[] = {SH6(0), SH6(-0.0), SH6(0.3), SH6(-0.3), SH6(0.8), SH6(-0.8), SH6(0.8000000000000002),
                                 SH6(0.85), SH6(-0.85), SH6(1), SH6(-1), SH6(1.6), SH6(2.4), SH6(3), SH6(-3),
                                 SH6(3.0000000000000004), SH6(10), SH6(-10), SH6(100.7), SH6(4095.9), SH6(4096),
                                 SH6(-4096), SH6(1e-300), SH6(-1e-300), SH6(NAN_), SHAPE(0, INF_), SHAPE(1, INF_),
                                 SHAPE(3, INF_), SHAPE(4, INF_), SHAPE(5, INF_), SHAPE(0, NINF_), SHAPE(1, NINF_),
                                 SHAPE(3, NINF_), SHAPE(4, NINF_), SHAPE(5, NINF_), SHAPE(0, 1e300), SHAPE(1, 1e300), SHAPE(3, 1e300),
                                 SHAPE(4, 1e300), SHAPE(5, 1e300), SHAPE(3, -1e300), END};
/* Both sides of the loop/closed-form edge at |y| = BK_DRIVE_FOLD_LIMIT, inside
   it only. The loop and the closed form differ in the last bits at every one
   of these (1e-10..1e-13), well inside tolerance, so the verifier requires
   this record bit-identical: fold() is fabs, compare, add, mul and fmod, all
   correctly rounded in IEEE 754, so identity is guaranteed, not empirical. */
static const double s_fold_edge[] = {SHAPE(2, 4096), SHAPE(2, -4096), SHAPE(2, 4095.999999999999),
                                     SHAPE(2, 4000.123), SHAPE(2, 3000.3), SHAPE(2, -3000.3), SHAPE(2, 2048.5),
                                     SHAPE(2, -2049), SHAPE(2, 2047.9), END};
/* curve 3 at tiny |x|: exp(+-tiny) is exactly 1 in glibc, musl and V8, so
   1 - exp(..) is +-0 here and the record is required bit-identical (Object.is)
   by name; an expm1 form would give the tiny value, or flip a zero's sign. */
static const double s_diode_tiny[] = {SHAPE(3, 1e-300), SHAPE(3, -1e-300), SHAPE(3, 1e-20), SHAPE(3, -1e-20),
                                      SHAPE(3, 0), SHAPE(3, -0.0), END};
/* A sample rate in (2^-3, 2^-2) * DBL_MAX: the oversampler's 4x rate is
   still finite, 8x would not be. */
static const double s_huge_sr[] = {INIT(0, 3e307, 128), SET(DRV, 12), SET(OS, 1), PROC(2, 128, NOISE, RAMP), SNAP,
                                   END};
/* One buffer passed as both l and r (a mono caller): every read of a sample
   must come before that sample is written, as in the JS. */
static const double s_alias[] = {SET(DRV, 18), MONO(3, 128, NOISE), SET(OS, 0), POKE(0, 3, NAN_), MONO(2, 128, NOISE),
                                 SNAP, SAT, MONO(2, 128, STEP), CRUSH, SET(BITS, 5), SET(RATE, 9000), SET(DITH, 0.5),
                                 SET(SMOOTH, 0.4), MONO(3, 128, NOISE), SNAP, END};
/* Unknown keys are ignored. */
static const double s_unknown[] = {SET(-1, 5), SET(8, 5), SET(99, 5), PROC(2, 128, NOISE, RAMP), CRUSH, SET(-1, 5),
                                   SET(6, 5), SET(99, 5), PROC(2, 128, NOISE, RAMP), SNAP, END};

/* ---- deliberate divergences (drive.h), replayed against the C contract ---- */

static const double x_curve_nan[] = {SET(CRV, 3), SET(DRV, 12), PROC(2, 128, NOISE, RAMP), SET(CRV, NAN_),
                                     PROC(2, 128, NOISE, RAMP), SET(CRV, 0), PROC(1, 128, NOISE, RAMP),
                                     SET(CRV, NAN_), PROC(1, 128, NOISE, RAMP), SNAP, END};
static const double x_fold_huge[] = {SET(CRV, 2), SET(DRV, 40), SET(OS, 0), POKE(0, 5, 1000), POKE(1, 9, INF_),
                                     POKE(0, 30, NINF_), POKE(1, 50, -400), PROC(1, 128, NOISE, RAMP),
                                     PROC(2, 128, NOISE, RAMP), SET(OS, 1), POKE(0, 7, 900), PROC(2, 128, NOISE, RAMP),
                                     SNAP, END};
static const double x_shape_huge[] = {SHAPE(2, 4096.000000000001), SHAPE(2, -4096.000000000001), SHAPE(2, 1e6),
                                      SHAPE(2, -1e6), SHAPE(2, 1e300), SHAPE(2, -1e300), SHAPE(2, INF_),
                                      SHAPE(2, NINF_), SHAPE(2, 5000.4), SHAPE(2, -5000.4), SHAPE(2, 4096.8),
                                      /* fmod gives +0 then -0: the wrap's p < 0 edge */
                                      SHAPE(2, 6552.8000000000002), SHAPE(2, -6554.4000000000005), END};
static const double x_chunk[] = {INIT(0, 48000, 64), SET(DRV, 18), SET(CRV, 3), PROC(3, 200, NOISE, RAMP),
                                 PROC(1, 64, NOISE, RAMP), PROC(1, 129, NOISE, RAMP), SET(OS, 0),
                                 PROC(2, 150, NOISE, RAMP), POKE(0, 70, NAN_), POKE(1, 130, 4), PROC(1, 140, NOISE, RAMP),
                                 SNAP, INIT(1, 48000, 1), PROC(2, 5, NOISE, RAMP), SNAP, END};

/* max_block < 1: the JS makes empty buffers (0) or throws a RangeError
   (negative); the C takes it as 1. */
static const double x_maxblock[] = {INIT(0, 48000, 0), SET(DRV, 12), PROC(5, 1, NOISE, RAMP), PROC(1, 3, NOISE, RAMP),
                                    SNAP, INIT(1, 48000, -5), PROC(5, 1, NOISE, RAMP), PROC(1, 0, NOISE, RAMP), SNAP,
                                    END};

/* ---- bit crusher ---- */

static const double c_default[] = {CRUSH, PROC(4, 128, NOISE, RAMP), SNAP, END};
#define BT(v) SET(BITS, v), PROC(1, 128, NOISE, RAMP)
static const double c_bits[] = {CRUSH, BT(1), BT(2), BT(4), BT(7.5), BT(8), BT(16), BT(24), BT(0), BT(30), BT(3.3),
                                BT(NAN_), BT(INF_), BT(NINF_), BT(12), SNAP, END};
#define RT(v) SET(RATE, v), PROC(3, 128, NOISE, RAMP)
static const double c_rate[] = {CRUSH, SET(BITS, 6), RT(200), RT(100), RT(1000), RT(7000), RT(12000), RT(47999),
                                RT(48000), RT(60000), RT(44100.5), RT(NAN_), RT(3000), RT(INF_), RT(NINF_), SNAP, END};
static const double c_dither[] = {CRUSH, SET(BITS, 4), SET(RATE, 16000), SET(DITH, 1), PROC(4, 128, NOISE, RAMP),
                                  SET(DITH, 0.5), PROC(4, 128, STEP, NOISE), SEED(12345), SET(BITS, 2),
                                  PROC(3, 128, NOISE, RAMP), SET(DITH, NAN_), PROC(2, 128, NOISE, RAMP), SET(DITH, -1),
                                  PROC(1, 128, NOISE, RAMP), SET(DITH, 3), SET(BITS, 24), PROC(2, 128, NOISE, RAMP),
                                  SNAP, END};
static const double c_dither_internal[] = {CRUSH, SEED(0), SET(BITS, 5), SET(DITH, 1), SET(RATE, 9000),
                                           PROC(4, 128, NOISE, RAMP), SEED(7), PROC(2, 128, NOISE, RAMP), SEED(0),
                                           PROC(2, 128, NOISE, RAMP), SNAP, CRUSH, SEED(0), SET(DITH, 1),
                                           PROC(2, 128, NOISE, RAMP), END};
static const double c_drive_out[] = {CRUSH, SET(BITS, 8), SET(CDRV, 24), PROC(6, 128, NOISE, RAMP), SET(CDRV, -12),
                                     SET(COUT, -24), PROC(6, 128, NOISE, RAMP), SET(COUT, 12), PROC(3, 128, NOISE, RAMP),
                                     SET(CDRV, NAN_), PROC(2, 128, NOISE, RAMP), SET(COUT, NAN_), SET(CDRV, 0),
                                     PROC(2, 128, NOISE, RAMP), SNAP, SET(COUT, INF_), SET(CDRV, INF_),
                                     PROC(2, 128, NOISE, RAMP), SET(CDRV, NINF_), PROC(2, 128, NOISE, RAMP), SNAP, END};
#define SM(v) SET(SMOOTH, v), PROC(2, 128, NOISE, RAMP)
static const double c_smooth[] = {CRUSH, SET(BITS, 5), SET(RATE, 6000), SM(0.5), SM(1), SM(0.001), SM(0.0011),
                                  SM(0), SM(0.8), SET(RATE, 900), SM(0.2), SM(NAN_), SM(INF_), SET(RATE, NAN_),
                                  SM(0.5), SNAP, END};
/* Mid-tread rounding at bits = 1 (one level): halves, -0, out of range. The
   pokes are float32, so 0.49999999999999994 itself cannot be poked; the last
   block reaches it as 0.5 * dbToGain(-9.6240074027511375e-16) = 0.5 * (1 -
   2^-53), the same in glibc and V8 (checked by the verifier's reach probe). */
#define PK(at, v) POKE(0, at, v), POKE(1, at, -2 * (v))
static const double c_round[] = {CRUSH, SET(BITS, 1), PK(0, 0.5), PK(1, -0.5), PK(2, -0.3), PK(3, 0.49999999999999994),
                                 PK(4, -0.49999999999999994), PK(5, -0.0), PK(6, -0.7), PK(7, 0.7), PK(8, 1e-30),
                                 PK(9, -1e-30), PK(10, 2), PK(11, -2), PROC(1, 16, ZERO, ZERO), SET(BITS, 2),
                                 PK(0, 0.5), PK(1, -0.5), PK(2, -1.0 / 6.0), PK(3, 1.0 / 6.0), PK(4, -0.1),
                                 PROC(1, 16, ZERO, ZERO), SET(BITS, 1), SET(CDRV, -9.6240074027511375e-16),
                                 POKE(0, 0, 0.5), POKE(1, 1, -0.5), POKE(0, 2, -0.5), PROC(1, 16, ZERO, ZERO), SNAP,
                                 END};
static const double c_reset[] = {CRUSH, SET(BITS, 3), SET(RATE, 7000), SET(SMOOTH, 0.6), PROC(5, 128, NOISE, RAMP),
                                 SNAP, RESET, SNAP, PROC(2, 128, NOISE, RAMP), SET(SMOOTH, 0), RESET,
                                 PROC(2, 128, NOISE, RAMP), SET(SMOOTH, 0.6), PROC(2, 128, NOISE, RAMP), SNAP, END};
/* Non-integer bits where glibc's pow(2, x) and exp2(x) differ by an ulp and V8's
   Math.pow agrees with glibc's pow (musl's pow and exp2 agree everywhere). */
static const double c_bits_pow[] = {CRUSH, SET(BITS, 0x1.70733f4af980cp+1), PROC(2, 128, NOISE, RAMP), SNAP, END};
/* Reset mid-hold at rate < sr with both holds nonzero: the next samples, until
   the phase wraps, output the reset holds. */
static const double c_reset_hold[] = {CRUSH, SET(BITS, 8), SET(RATE, 4000), PROC(2, 128, NOISE, NOISE), RESET,
                                      PROC(1, 128, NOISE, NOISE), SNAP, END};
/* dither 4 * 2^-1074 at bits 2: (dither * inv) / 2 rounds twice, to m then to
   0 (ties to even), so no draws; dither * (inv / 2) would round once, to m. */
static const double c_dither_sub[] = {CRUSH, SET(BITS, 2), SET(DITH, 0x1p-1072), PROC(2, 64, NOISE, RAMP), SNAP, END};
/* The anti-alias gate (> 0.001) at 0.0005 and at 0.001 exactly, each on a
   fresh crusher and snapped before anything re-sets the filters. */
static const double c_aa_gate[] = {CRUSH, SET(RATE, 6000), SM(0.0005), SNAP, CRUSH, SET(RATE, 6000), SM(0.001), SNAP,
                                   END};
/* Phase landing on exactly 2.0: step 1 - 2^-53 (rate = 48000 - 2^-37), then
   step 1, and (1 - 2^-53) + 1 rounds to 2 (ties to even). */
static const double c_phase2[] = {CRUSH, SET(BITS, 6), SET(RATE, 48000.0 - 0x1p-37), PROC(1, 1, NOISE, RAMP),
                                  SET(RATE, 48000), PROC(1, 4, NOISE, RAMP), SNAP, END};
static const double c_rates[] = {INIT(2, 44100, 128), SET(RATE, 48000), SET(BITS, 6), PROC(4, 128, NOISE, RAMP), SNAP,
                                 INIT(2, 96000, 128), SET(RATE, 96000), SET(SMOOTH, 0.3), PROC(4, 128, NOISE, RAMP),
                                 SET(RATE, 50000), PROC(2, 128, NOISE, RAMP), SNAP, INIT(2, 22050, 128),
                                 SET(SMOOTH, 0.9), SET(RATE, 20000), PROC(3, 128, NOISE, RAMP), END};
static const double c_poke[] = {CRUSH, SET(BITS, 6), POKE(0, 0, NAN_), POKE(1, 1, INF_), POKE(0, 2, NINF_),
                                POKE(1, 3, 1e30), PROC(1, 64, NOISE, RAMP), SET(RATE, 4000), POKE(0, 0, NAN_),
                                PROC(2, 64, NOISE, RAMP), SET(SMOOTH, 0.5), POKE(1, 0, NAN_), PROC(2, 64, NOISE, RAMP),
                                SNAP, END};
static const double c_blocks[] = {CRUSH, SET(RATE, 5000), SET(BITS, 4), PROC(3, 0, NOISE, RAMP),
                                  PROC(30, 1, NOISE, RAMP), PROC(5, 77, NOISE, RAMP), PROC(1, 2048, NOISE, RAMP), PROC(2, -3, NOISE, RAMP),
                                  REWIND, PROC(1, 64, NOISE, RAMP), SNAP,
                                  END};

#define S(n) {#n, n, sizeof(n) / sizeof(n[0])}

typedef struct {
  const char *name;
  const double *ops;
  size_t n;
} script;

static const script scripts[] = {
    S(s_default),     S(s_sat_default), S(s_curves),     S(s_curves_noos), S(s_sat_curves),  S(s_curve_round),
    S(s_bias),        S(s_tonemode),    S(s_tone),       S(s_prehp),       S(s_output),      S(s_drive),
    S(s_drive_inf),   S(s_oversample),  S(s_reset),      S(s_blocks),      S(s_rates),       S(s_maxblock),
    S(s_poke),        S(s_meter_nan),   S(s_fold),       S(s_signed_zero), S(s_shape),       S(s_fold_edge),   S(s_diode_tiny),
    S(s_huge_sr),     S(s_alias),       S(s_unknown),
    S(x_curve_nan),   S(x_fold_huge),   S(x_shape_huge), S(x_chunk),       S(x_maxblock),    S(c_default),     S(c_bits),
    S(c_rate),        S(c_dither),      S(c_dither_internal), S(c_drive_out), S(c_smooth),   S(c_round),
    S(c_reset),       S(c_bits_pow),    S(c_reset_hold), S(c_dither_sub),  S(c_aa_gate),     S(c_phase2),
    S(c_rates),       S(c_poke),       S(c_blocks),
};

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
  bk_parity_open(f);
  for (i = 0; i < sizeof(scripts) / sizeof(scripts[0]); i++) {
    run_script(f, scripts[i].name, scripts[i].ops, scripts[i].n);
  }
  if (!bk_parity_close(f)) {
    fprintf(stderr, "cannot patch record count\n");
    fclose(f);
    return 1;
  }
  fprintf(stderr, "wrote %u records to %s\n", bk_parity_records, argv[1]);
  fclose(f);
  return 0;
}
