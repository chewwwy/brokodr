/*
 * Parity dump for the C port of dsp/effects/eq.js.
 *
 * Producer half of the oracle; scripts/verify-eq-parity.mjs is the consumer.
 * See parity-io.h for the stream format.
 *
 * Same shape as parity-file-player.c: every case is an opcode script, the
 * script travels as the record's params, and the JS runner replays it op for
 * op. There is no second copy of the case table. Every op goes through
 * bk_eq_vt, so the vtable the chain will use is what is under test.
 *
 * Per PROCESS block the payload carries the output-gain smoother, the dirty
 * flag, both cascades' active counts and all 18 smoothed values (out64), and
 * every output sample of both channels (out32). SNAP adds the whole struct —
 * every biquad's coefficients, state and last-set parameters — and the curve.
 *
 * What the battery is built to reach, because a tidier port gets it wrong:
 *
 *   - the on/off tests on the RAW param at exactly 21 Hz and 19900 Hz and
 *     either side, including mid-glide, where raw and smoothed disagree;
 *   - every slope from 0 to 3, the Math.round half-way points (0.5, 1.5, 2.5,
 *     and 0.49999999999999994, where floor(x + 0.5) rounds up and JS does not),
 *     the clamps from both sides, NaN, both infinities and -0;
 *   - NaN and infinite frequencies, gains, Qs and output, which stick in the
 *     smoothers until reset;
 *   - frequencies past Nyquist and under 10 Hz, Q under the 0.02 floor;
 *   - NaN, infinite and over-range input samples (OP_POKE);
 *   - 22.05 / 44.1 / 48 / 96 kHz, max_block 0 (-> 128), negative (-> 1), 1,
 *     2, odd and large, and block sizes 0, 1, odd and 2048;
 *   - the curve: rendered on construction, after set_param, not after reset,
 *     and from the first block's coefficients only;
 *   - unknown keys.
 *
 * Stimulus is bk_fill_signal over a fixed 65536-sample period, narrowed to
 * float, read through a cursor that carries across blocks; the right channel
 * is halved and negated so a swapped-channel bug cannot hide.
 *
 * Usage: parity-eq <out.bin>
 */

#include "brokodr/dsp/eq.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

enum {
  OP_END = 0,
  OP_INIT = 1,    /* a = sample rate, b = max block */
  OP_PARAM = 2,   /* a = key, b = value */
  OP_PROCESS = 3, /* a = blocks, b = block size, c = left signal, d = right signal */
  OP_RESET = 4,
  OP_SNAP = 5,
  OP_POKE = 6,    /* next block only: channel a (0/1), sample b, value c */
  OP_REWIND = 7   /* stimulus cursor back to 0 */
};
#define OPW 5

#define SIG_N 65536
#define N_SIGS 5
#define MAX_BLOCK 4096
#define MAX_POKES 16
#define MAX_P64 2000000
#define MAX_P32 4000000

/* Per-block readings. Field order is the contract with blockState(). */
#define BK_EQ_BLOCK 23
/* Struct snapshot (without the curve). Field order is the contract with
   snapState(). */
#define BK_EQ_SNAP 373

static float g_sig[N_SIGS][SIG_N];
static double g_tmp[SIG_N];
static float g_l[MAX_BLOCK];
static float g_r[MAX_BLOCK];
static double g_p64[MAX_P64];
static float g_p32[MAX_P32];
static unsigned int n64, n32;
static bk_eq g_eq;

static int g_cursor;
static int n_pokes;
static int poke_ch[MAX_POKES];
static int poke_at[MAX_POKES];
static double poke_v[MAX_POKES];

static void push64(double v) {
  if (n64 < MAX_P64) g_p64[n64++] = v;
}
static void push32(float v) {
  if (n32 < MAX_P32) g_p32[n32++] = v;
}

static void block_state(const bk_eq *e) {
  int k;
  push64(e->out_gain.value);
  push64(e->out_gain.target);
  push64((double)e->visual_dirty);
  push64((double)e->ch[0].hp.active);
  push64((double)e->ch[0].lp.active);
  for (k = 0; k < BK_P_EQ_COUNT; k++) push64(e->sm[k].value);
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

static void cascade_state(const bk_biquad_cascade *c) {
  int i;
  push64((double)c->active);
  push64((double)c->count);
  for (i = 0; i < BK_EQ_CASCADE_STAGES; i++) biquad_state(&c->stages[i]);
}

static void snap_state(const bk_eq *e) {
  int k, c;
  for (k = 0; k < BK_P_EQ_COUNT; k++) push64(e->p[k]);
  for (k = 0; k < BK_P_EQ_COUNT; k++) {
    push64(e->sm[k].value);
    push64(e->sm[k].target);
    push64(e->sm[k].a);
  }
  push64(e->out_gain.value);
  push64(e->out_gain.target);
  push64(e->out_gain.a);
  push64(e->sr);
  push64((double)e->max_block);
  push64(e->control_rate);
  push64((double)e->visual_dirty);
  for (c = 0; c < 2; c++) {
    const bk_eq_channel *ch = &e->ch[c];
    cascade_state(&ch->hp);
    biquad_state(&ch->ls);
    biquad_state(&ch->b1);
    biquad_state(&ch->b2);
    biquad_state(&ch->b3);
    biquad_state(&ch->hs);
    cascade_state(&ch->lp);
  }
  for (k = 0; k < BK_EQ_CURVE_POINTS; k++) push32(bk_eq_visual(e)[k]);
}

static double unsentinel(double v) {
  if (v == -3e9) return (double)NAN;
  if (v == 3e9) return (double)INFINITY;
  if (v == -4e9) return -(double)INFINITY;
  return v;
}

static void run_script(FILE *f, const char *name, const double *ops, size_t n_ops) {
  bk_eq *e = &g_eq;
  const bk_effect_vt *vt = &bk_eq_vt;
  size_t i;
  int k, j;

  n64 = 0;
  n32 = 0;
  g_cursor = 0;
  n_pokes = 0;
  /* What the chain will see of the EQ: no carrier bus, no latency, no meter. */
  push64(vt->set_carrier_bus == NULL ? 1.0 : 0.0);
  push64(vt->latency_samples == NULL ? 1.0 : 0.0);
  push64(vt->meter == NULL ? 1.0 : 0.0);
  bk_eq_init(e, 48000.0, 128);

  for (i = 0; i + OPW <= n_ops; i += OPW) {
    const int op = (int)ops[i];
    const double a = unsentinel(ops[i + 1]), b = unsentinel(ops[i + 2]);
    const double c = unsentinel(ops[i + 3]), d = unsentinel(ops[i + 4]);
    switch (op) {
      case OP_END:
        i = n_ops;
        break;
      case OP_INIT:
        bk_eq_init(e, a, (int)b);
        break;
      case OP_PARAM:
        vt->set_param(e, (int)a, b);
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
          vt->process(e, g_l, g_r, bs);
          block_state(e);
          for (j = 0; j < bs; j++) push32(g_l[j]);
          for (j = 0; j < bs; j++) push32(g_r[j]);
        }
        break;
      }
      case OP_RESET:
        vt->reset(e);
        break;
      case OP_SNAP:
        snap_state(e);
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
      default:
        break;
    }
  }
  snap_state(e);
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

#define HPF BK_P_EQ_HP_FREQ
#define HPS BK_P_EQ_HP_SLOPE
#define LSF BK_P_EQ_LS_FREQ
#define LSG BK_P_EQ_LS_GAIN
#define B1F BK_P_EQ_B1_FREQ
#define B1G BK_P_EQ_B1_GAIN
#define B1Q BK_P_EQ_B1_Q
#define B2F BK_P_EQ_B2_FREQ
#define B2G BK_P_EQ_B2_GAIN
#define B2Q BK_P_EQ_B2_Q
#define B3F BK_P_EQ_B3_FREQ
#define B3G BK_P_EQ_B3_GAIN
#define B3Q BK_P_EQ_B3_Q
#define HSF BK_P_EQ_HS_FREQ
#define HSG BK_P_EQ_HS_GAIN
#define LPF BK_P_EQ_LP_FREQ
#define LPS BK_P_EQ_LP_SLOPE
#define OUT BK_P_EQ_OUTPUT

#define O(op, a, b, c, d) (double)(op), (double)(a), (double)(b), (double)(c), (double)(d)
#define INIT(sr, mb) O(OP_INIT, sr, mb, 0, 0)
#define SET(k, v) (double)OP_PARAM, (double)(k), (double)(v), 0.0, 0.0
#define PROC(n, bs, l, r) O(OP_PROCESS, n, bs, l, r)
#define SNAP O(OP_SNAP, 0, 0, 0, 0)
#define RESET O(OP_RESET, 0, 0, 0, 0)
#define POKE(ch, at, v) O(OP_POKE, ch, at, v, 0)
#define REWIND O(OP_REWIND, 0, 0, 0, 0)
#define END O(OP_END, 0, 0, 0, 0)

/* Sentinels, mapped to NaN / +inf / -inf at run time: a NaN or an infinity
   in a static initialiser is not portable to MSVC. The JS runner applies the
   same map to the same params. No real operand is anywhere near them. */
#define NAN_ (-3e9)
#define INF_ (3e9)
#define NINF_ (-4e9)

typedef struct {
  const char *name;
  const double *ops;
  size_t n;
} script;

/* Defaults: hp and lp both off, every band at 0 dB. */
static const double s_default[] = {PROC(40, 128, NOISE, RAMP), SNAP, END};
/* Every band in use, both directions, all Qs different. */
static const double s_bands[] = {SET(LSG, 6), SET(B1G, -9), SET(B1Q, 2.5), SET(B2G, 12), SET(B2Q, 0.3),
                                 SET(B3G, -4.5), SET(B3Q, 7), SET(HSG, 3), SET(LSF, 80), SET(B1F, 450),
                                 SET(B2F, 2500), SET(B3F, 9000), SET(HSF, 12000), PROC(120, 128, NOISE, RAMP),
                                 SNAP, END};
/* An impulse through the same, so the full response is in the payload. */
static const double s_impulse[] = {SET(LSG, -12), SET(B1G, 18), SET(B1Q, 12), SET(B2G, -18), SET(B3G, 9),
                                   SET(HSG, -6), SET(HPF, 80), SET(HPS, 1), SET(LPF, 9000), SET(LPS, 2),
                                   PROC(60, 128, ZERO, ZERO), REWIND, PROC(40, 128, IMP, IMP), SNAP, END};
/* Each hp slope in turn, with processing between. */
static const double s_hp_slopes[] = {SET(HPF, 200), PROC(30, 128, NOISE, NOISE), SNAP, SET(HPS, 1),
                                     PROC(20, 128, NOISE, NOISE), SNAP, SET(HPS, 2), PROC(20, 128, NOISE, NOISE),
                                     SET(HPS, 3), PROC(20, 128, NOISE, NOISE), SNAP, SET(HPS, 0),
                                     PROC(20, 128, NOISE, NOISE), END};
static const double s_lp_slopes[] = {SET(LPF, 3000), PROC(30, 128, RAMP, NOISE), SNAP, SET(LPS, 1),
                                     PROC(20, 128, RAMP, NOISE), SET(LPS, 2), PROC(20, 128, RAMP, NOISE), SNAP,
                                     SET(LPS, 3), PROC(20, 128, RAMP, NOISE), SET(LPS, 0),
                                     PROC(20, 128, RAMP, NOISE), SNAP, END};
/* The 21 Hz switch on the raw param: exactly 21 is off, just above is on;
   and a glide down to 20 that switches off at once while the smoothed
   frequency is still high. */
static const double s_hp_edge[] = {SET(HPS, 2), SET(HPF, 21), PROC(5, 128, NOISE, RAMP), SNAP,
                                   SET(HPF, 21.000001), PROC(5, 128, NOISE, RAMP), SNAP, SET(HPF, 20.999999),
                                   PROC(5, 128, NOISE, RAMP), SET(HPF, 600), PROC(40, 128, NOISE, RAMP),
                                   SET(HPF, 20), PROC(3, 128, NOISE, RAMP), SNAP, PROC(20, 128, NOISE, RAMP),
                                   SET(HPF, 400), PROC(1, 128, NOISE, RAMP), SNAP, END};
static const double s_lp_edge[] = {SET(LPS, 1), SET(LPF, 19900), PROC(5, 128, RAMP, NOISE), SNAP,
                                   SET(LPF, 19899.99), PROC(5, 128, RAMP, NOISE), SNAP, SET(LPF, 19900.01),
                                   PROC(5, 128, RAMP, NOISE), SET(LPF, 1500), PROC(40, 128, RAMP, NOISE),
                                   SET(LPF, 20000), PROC(3, 128, RAMP, NOISE), SNAP, SET(LPF, 900),
                                   PROC(1, 128, RAMP, NOISE), SNAP, END};
/* Slope rounding and clamping, hp and lp, each followed by a block so the
   stage count lands in the per-block readings. */
#define SLOPE_STEP(k, v) SET(k, v), PROC(1, 32, NOISE, NOISE)
static const double s_slope_round[] = {
    SET(HPF, 300), SET(LPF, 5000), PROC(5, 32, NOISE, NOISE), SLOPE_STEP(HPS, 0.5),
    SLOPE_STEP(LPS, 0.49999999999999994), SLOPE_STEP(HPS, 1.5), SLOPE_STEP(LPS, 1.4999999999999998),
    SLOPE_STEP(HPS, 2.5), SLOPE_STEP(LPS, 2.5), SLOPE_STEP(HPS, 2.4999999), SLOPE_STEP(LPS, 0.5),
    SLOPE_STEP(HPS, -1), SLOPE_STEP(LPS, 5), SLOPE_STEP(HPS, 3.4), SLOPE_STEP(LPS, 3.6),
    SLOPE_STEP(HPS, -0.0), SLOPE_STEP(LPS, -0.0), SLOPE_STEP(HPS, 0.49999999999999994),
    SLOPE_STEP(LPS, 1.5), SLOPE_STEP(HPS, 2.0000001), SLOPE_STEP(LPS, 0.9999999), SNAP, END};
static const double s_slope_nonfinite[] = {SET(HPF, 300), SET(LPF, 5000), SET(HPS, 1), SET(LPS, 1),
                                           PROC(5, 64, NOISE, RAMP), SLOPE_STEP(HPS, NAN_), SNAP,
                                           SLOPE_STEP(LPS, NAN_), SNAP, SLOPE_STEP(HPS, INF_),
                                           SLOPE_STEP(LPS, NINF_), SNAP, SLOPE_STEP(HPS, NINF_),
                                           SLOPE_STEP(LPS, INF_), SNAP, END};
/* NaN params stick in the smoothers until reset. */
static const double s_nan_freq[] = {SET(B2G, 6), PROC(5, 128, NOISE, RAMP), SET(B2F, NAN_), PROC(5, 128, NOISE, RAMP),
                                    SNAP, SET(B2F, 1000), PROC(5, 128, NOISE, RAMP), SNAP, RESET,
                                    PROC(5, 128, NOISE, RAMP), SNAP, END};
static const double s_nan_gain[] = {SET(LSG, NAN_), PROC(3, 128, NOISE, RAMP), SNAP, SET(LSG, 0), RESET,
                                    SET(HSG, INF_), PROC(3, 128, NOISE, RAMP), SNAP, RESET, SET(HSG, NINF_),
                                    PROC(3, 128, NOISE, RAMP), SNAP, END};
static const double s_nan_q[] = {SET(B1G, 9), SET(B1Q, NAN_), PROC(3, 128, NOISE, RAMP), SNAP, SET(B1Q, 1), RESET,
                                 SET(B3G, -9), SET(B3Q, INF_), PROC(3, 128, NOISE, RAMP), SNAP, SET(B3Q, 0),
                                 PROC(3, 128, NOISE, RAMP), SET(B3Q, -2), PROC(3, 128, NOISE, RAMP), SNAP, END};
static const double s_nan_hp_lp[] = {SET(HPF, NAN_), SET(LPF, NAN_), PROC(3, 128, NOISE, RAMP), SNAP,
                                     SET(HPF, INF_), SET(LPF, NINF_), RESET, PROC(3, 128, NOISE, RAMP), SNAP,
                                     SET(HPF, NINF_), SET(LPF, INF_), RESET, PROC(3, 128, NOISE, RAMP), SNAP, END};
static const double s_nan_output[] = {PROC(3, 128, NOISE, RAMP), SET(OUT, NAN_), PROC(3, 128, NOISE, RAMP), SNAP,
                                      RESET, SET(OUT, INF_), RESET, PROC(3, 128, NOISE, RAMP), SNAP,
                                      SET(OUT, NINF_), RESET, PROC(3, 128, NOISE, RAMP), SNAP, END};
/* Output gain: the per-sample smoother following the block-rate one. */
static const double s_output[] = {SET(OUT, 12), PROC(30, 128, NOISE, RAMP), SNAP, SET(OUT, -24),
                                  PROC(30, 128, NOISE, RAMP), SET(OUT, 24), PROC(5, 128, STEP, STEP),
                                  SET(OUT, -0.0), PROC(20, 128, NOISE, RAMP), SNAP, END};
/* Out-of-range filter settings: past Nyquist, under 10 Hz, Q under 0.02,
   huge gains. */
static const double s_extremes[] = {SET(B1F, 5), SET(B1G, 18), SET(B1Q, 0.001), SET(B2F, 30000), SET(B2G, -18),
                                    SET(B3F, 23900), SET(B3G, 40), SET(B3Q, 50), SET(LSF, -100), SET(LSG, 30),
                                    SET(HSF, 1e6), SET(HSG, -40), SET(HPF, 1e5), SET(HPS, 3), SET(LPF, 1),
                                    SET(LPS, 3), PROC(60, 128, NOISE, RAMP), SNAP, END};
/* Schema minimum and maximum of every knob. */
static const double s_schema_min[] = {SET(HPF, 20), SET(LSF, 30), SET(LSG, -18), SET(B1F, 40), SET(B1G, -18),
                                      SET(B1Q, 0.2), SET(B2F, 200), SET(B2G, -18), SET(B2Q, 0.2), SET(B3F, 1000),
                                      SET(B3G, -18), SET(B3Q, 0.2), SET(HSF, 2000), SET(HSG, -18), SET(LPF, 500),
                                      SET(LPS, 3), SET(OUT, -24), PROC(60, 128, NOISE, RAMP), SNAP, END};
static const double s_schema_max[] = {SET(HPF, 1000), SET(HPS, 3), SET(LSF, 500), SET(LSG, 18), SET(B1F, 2000),
                                      SET(B1G, 18), SET(B1Q, 12), SET(B2F, 8000), SET(B2G, 18), SET(B2Q, 12),
                                      SET(B3F, 18000), SET(B3G, 18), SET(B3Q, 12), SET(HSF, 18000), SET(HSG, 18),
                                      SET(LPF, 20000), SET(OUT, 24), PROC(60, 128, NOISE, RAMP), SNAP, END};
/* Sample rates and control rates. max_block 0 means 128; below 1 means 1. */
static const double s_rate441[] = {INIT(44100, 128), SET(B2G, 6), SET(HPF, 100), PROC(40, 128, NOISE, RAMP), SNAP,
                                   END};
static const double s_rate96[] = {INIT(96000, 512), SET(B3G, -6), SET(LPF, 12000), SET(LPS, 3),
                                  PROC(30, 512, RAMP, NOISE), SNAP, END};
static const double s_rate22[] = {INIT(22050, 256), SET(B3F, 18000), SET(B3G, 6), SET(HSF, 15000), SET(HSG, 6),
                                  PROC(30, 256, NOISE, RAMP), SNAP, END};
static const double s_mb_zero[] = {INIT(48000, 0), SET(B1G, 9), PROC(20, 128, NOISE, RAMP), SNAP, END};
static const double s_mb_neg[] = {INIT(48000, -5), SET(B1G, 9), PROC(20, 16, NOISE, RAMP), SNAP, END};
static const double s_mb_one[] = {INIT(48000, 1), SET(B1G, 9), SET(OUT, 6), PROC(200, 1, NOISE, RAMP), SNAP, END};
static const double s_mb_two[] = {INIT(48000, 2), SET(B1G, 9), PROC(100, 2, NOISE, RAMP), SNAP, END};
static const double s_mb_odd[] = {INIT(44100, 37), SET(B2G, -9), SET(HPF, 150), PROC(60, 37, NOISE, RAMP), SNAP,
                                  END};
static const double s_mb_big[] = {INIT(48000, 2048), SET(B2G, -9), SET(LPF, 4000), PROC(10, 2048, NOISE, RAMP),
                                  SNAP, END};
/* Block sizes that do not match max_block, including 0. */
static const double s_blocks[] = {SET(B1G, 6), SET(HPF, 90), SET(OUT, -3), PROC(3, 0, NOISE, RAMP), SNAP,
                                  PROC(50, 1, NOISE, RAMP), PROC(20, 7, NOISE, RAMP), PROC(5, 1000, NOISE, RAMP),
                                  PROC(2, 2048, NOISE, RAMP), SNAP, END};
/* Reset mid-glide: smoothers jump to the raw params, filter state clears,
   and the curve is NOT marked dirty. */
static const double s_reset[] = {SET(B2G, 12), SET(LPF, 2000), SET(LPS, 1), PROC(4, 128, NOISE, RAMP), SNAP, RESET,
                                 SNAP, PROC(4, 128, NOISE, RAMP), SET(B2G, -12), RESET, SNAP,
                                 PROC(4, 128, NOISE, RAMP), END};
static const double s_reset_clean[] = {SET(B1G, 6), PROC(30, 128, NOISE, RAMP), SNAP, RESET, SNAP,
                                       PROC(2, 128, NOISE, RAMP), SNAP, END};
static const double s_unknown[] = {SET(-1, 5), SET(18, 5), SET(99, 5), SET(-1000, 1), PROC(2, 128, NOISE, RAMP),
                                   SNAP, END};
/* The curve: several params set between two blocks; a second block with no
   change does not re-render, so the curve keeps the first block's partly
   glided coefficients. */
static const double s_curve[] = {SET(LSG, 9), SET(B2G, -6), SET(HSG, 4), SET(HPF, 120), SET(HPS, 3), SET(LPF, 7000),
                                 SET(LPS, 1), SET(OUT, 3), PROC(1, 128, NOISE, RAMP), SNAP,
                                 PROC(30, 128, NOISE, RAMP), SNAP, SET(OUT, 3), PROC(1, 128, NOISE, RAMP), SNAP,
                                 END};
/* Init alone: the curve stays at zeros until the first block renders it. */
static const double s_curve_init[] = {SNAP, PROC(1, 128, ZERO, ZERO), SNAP, END};
/* Non-finite and over-range input samples. */
static const double s_poke[] = {SET(B2G, 6), PROC(5, 128, NOISE, RAMP), POKE(0, 10, NAN_), POKE(1, 3, INF_),
                                PROC(5, 128, NOISE, RAMP), SNAP, POKE(0, 0, 1e30), POKE(1, 127, NINF_),
                                PROC(5, 128, NOISE, RAMP), POKE(0, 5, 3e38), POKE(1, 5, -3e38),
                                PROC(5, 128, NOISE, RAMP), SNAP, END};
/* A long glide of everything at once, so every smoother is mid-flight at
   every block and every biquad recomputes every block. */
static const double s_sweep[] = {SET(HPS, 1), SET(LPS, 2), PROC(2, 128, NOISE, RAMP), SET(HPF, 900), SET(LPF, 900),
                                 SET(LSF, 400), SET(LSG, -18), SET(B1F, 1800), SET(B1G, 18), SET(B1Q, 11),
                                 SET(B2F, 250), SET(B2G, -18), SET(B2Q, 0.25), SET(B3F, 1100), SET(B3G, 18),
                                 SET(B3Q, 0.3), SET(HSF, 2100), SET(HSG, 18), SET(OUT, -12),
                                 PROC(80, 128, NOISE, RAMP), SNAP, END};
/* A step through heavy boost, the release ringing included. */
static const double s_step[] = {SET(B1F, 100), SET(B1G, 18), SET(B1Q, 12), SET(LSG, 18), SET(LSF, 40),
                                PROC(520, 128, STEP, STEP), SNAP, END};
/* Reset with every stage carrying state and the output gain off unity:
   every filter clears and the output smoother is NOT reset (the JS leaves
   outGain alone). Then a reset mid output glide. */
static const double s_reset_every[] = {SET(HPF, 150), SET(HPS, 2), SET(LSG, 8), SET(B1G, 5), SET(B2G, -7),
                                       SET(B3G, 6), SET(HSG, -5), SET(LPF, 6000), SET(LPS, 1), SET(OUT, 6),
                                       PROC(40, 128, NOISE, RAMP), SNAP, RESET, SNAP, PROC(2, 128, NOISE, RAMP),
                                       SNAP, SET(OUT, -9), PROC(1, 128, NOISE, RAMP), RESET,
                                       PROC(2, 128, NOISE, RAMP), SNAP, END};
/* An unknown key must not mark the curve dirty: the curve holds the first
   block's mid-glide coefficients, so a spurious re-render would show the
   settled ones. Key BK_P_EQ_COUNT is the off-by-one edge. */
static const double s_unknown_dirty[] = {SET(B2G, 12), SET(HSG, -6), PROC(1, 128, NOISE, RAMP),
                                         PROC(40, 128, NOISE, RAMP), SNAP, SET(BK_P_EQ_COUNT, 5),
                                         PROC(1, 128, NOISE, RAMP), SNAP, SET(-1, 5), PROC(1, 128, NOISE, RAMP),
                                         SNAP, END};

#define S(n) {#n, n, sizeof(n) / sizeof(n[0])}

static const script scripts[] = {
    S(s_default),     S(s_bands),         S(s_impulse),    S(s_hp_slopes),  S(s_lp_slopes),
    S(s_hp_edge),     S(s_lp_edge),       S(s_slope_round), S(s_slope_nonfinite), S(s_nan_freq),
    S(s_nan_gain),    S(s_nan_q),         S(s_nan_hp_lp),  S(s_nan_output), S(s_output),
    S(s_extremes),    S(s_schema_min),    S(s_schema_max), S(s_rate441),    S(s_rate96),
    S(s_rate22),      S(s_mb_zero),       S(s_mb_neg),     S(s_mb_one),     S(s_mb_two),
    S(s_mb_odd),      S(s_mb_big),        S(s_blocks),     S(s_reset),      S(s_reset_clean),
    S(s_unknown),     S(s_curve),         S(s_curve_init), S(s_poke),       S(s_sweep),
    S(s_step),        S(s_reset_every),   S(s_unknown_dirty),
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
