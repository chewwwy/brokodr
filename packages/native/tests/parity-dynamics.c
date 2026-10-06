/*
 * Parity dump for the C port of dsp/effects/dynamics.js (Compressor, Limiter,
 * Gate, TransientShaper).
 *
 * Producer half of the oracle; scripts/verify-dynamics-parity.mjs is the
 * consumer. See parity-io.h for the stream format.
 *
 * Same shape as parity-character.c: every case is an opcode script, the
 * script travels as the record's params, and the JS runner replays it op for
 * op. Every op goes through the effect's vtable. OP_INIT picks the effect (0
 * compressor, 1 limiter, 2 gate, 3 transient shaper) and the sample rate; a
 * script starts as a 48 kHz compressor.
 *
 * Stimulus: signal s of parity-io.h, or SIG_DC (a constant set by OP_DC),
 * scaled by OP_GAIN (default 1): l = gain * sig_l, r = gain * (-0.5 * sig_r),
 * each rounded to float32 once.
 *
 * Per PROCESS block: the smoothers, envelopes and discrete state and the meter
 * (through the vtable), then every output sample (out32). SNAP adds the whole
 * struct, filters included, and the float32 buffers (the lookahead lines and
 * the limiter window).
 *
 * No randomness and no deliberate divergences: there are no x_* scripts.
 *
 * Usage: parity-dynamics <out.bin>
 */

#include "brokodr/dsp/dynamics.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

enum {
  OP_END = 0,
  OP_INIT = 1,    /* a = type (0 comp, 1 limiter, 2 gate, 3 transient), b = sample rate */
  OP_PARAM = 2,   /* a = key, b = value */
  OP_PROCESS = 3, /* a = blocks, b = block size, c = left signal, d = right signal */
  OP_RESET = 4,
  OP_SNAP = 5,
  OP_POKE = 6,    /* next block only: channel a (0/1), sample b, value c */
  OP_REWIND = 7,  /* stimulus cursor back to 0 */
  OP_GAIN = 8,    /* a = stimulus gain */
  OP_DC = 9,      /* a = the SIG_DC level */
  OP_MONO = 10    /* as OP_PROCESS on one buffer, l and r aliased: a = blocks, b = size, c = signal */
};
#define OPW 5

#define SIG_N 65536
#define N_SIGS 5
#define SIG_DC 5
#define MAX_BLOCK 4096
#define MAX_POKES 32
#define MAX_P64 2000000
#define MAX_P32 4000000
#define STORE_FLOATS 16384

/* Per-block readings. Field order is the contract with blockState(). */
#define BK_COMP_BLOCK 14
#define BK_LIM_BLOCK 7
#define BK_GATE_BLOCK 8
#define BK_TRANS_BLOCK 7
/* Struct snapshots (doubles). Field order is the contract with snapState(). */
#define BK_COMP_SNAP 29
#define BK_LIM_SNAP 14
#define BK_GATE_SNAP 40
#define BK_TRANS_SNAP 15

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

static bk_compressor g_comp;
static bk_limiter g_lim;
static bk_gate g_gate;
static bk_transient_shaper g_trans;
static float g_store[STORE_FLOATS];
#define CANARY 64
static size_t g_need;
static void check_canary(void) {
  size_t k;
  for (k = g_need; k < g_need + CANARY; k++) {
    if (g_store[k] != 1234.5f) {
      fprintf(stderr, "write past bk_*_storage_floats() at %lu (need %lu)\n", (unsigned long)k, (unsigned long)g_need);
      exit(5);
    }
  }
}
static int g_type;
static void *g_fx;
static const bk_effect_vt *g_vt;

static int g_cursor;
static double g_gain;
static double g_dc;
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

static void env_state(const bk_env_follower *e) {
  push64((double)e->rms);
  push64(e->env);
  push64(e->ca);
  push64(e->cr);
}

static void line_state(const bk_delay_line *d) {
  push64((double)d->size);
  push64((double)d->w);
}

static void block_state(void) {
  const double meter = g_vt->meter ? g_vt->meter(g_fx) : 0.0;
  if (g_type == 1) {
    const bk_limiter *m = &g_lim;
    push64(m->env);
    push64((double)m->wi);
    push64(m->gain_db);
    push64(m->r_coef);
    push64((double)m->d[0].w);
    push64((double)m->d[1].w);
    push64(meter);
  } else if (g_type == 2) {
    const bk_gate *g = &g_gate;
    push64(g->env.env);
    push64(g->gain_sm.value);
    push64(g->gain_sm.target);
    push64(g->gain_sm.a);
    push64((double)g->open);
    push64((double)g->hold_counter);
    push64(g->hp[0].z1);
    push64(meter);
  } else if (g_type == 3) {
    const bk_transient_shaper *t = &g_trans;
    push64(t->fast.env);
    push64(t->slow.env);
    push64(t->fast.ca);
    push64(t->slow.ca);
    push64(t->gain_sm.value);
    push64(t->gain_sm.target);
    push64(meter);
  } else {
    const bk_compressor *c = &g_comp;
    push64(c->attack.value);
    push64(c->attack.target);
    push64(c->release.value);
    push64(c->release.target);
    push64(c->mk_gain.value);
    push64(c->mk_gain.target);
    push64(c->env_db);
    push64(c->gain_db);
    push64(c->a_coef);
    push64(c->r_coef);
    push64(c->rms.env);
    push64((double)c->la[0].w);
    push64((double)c->la[1].w);
    push64(meter);
  }
}

static void snap_state(void) {
  int k, j;
  if (g_type == 1) {
    const bk_limiter *m = &g_lim;
    push64(m->sr);
    push64(m->ceiling_db);
    push64(m->release_ms);
    push64(m->gain_db);
    push64((double)m->lookahead);
    push64((double)m->wi);
    push64(m->env);
    push64(m->r_coef);
    push64(m->a_coef);
    push64(m->meter);
    line_state(&m->d[0]);
    line_state(&m->d[1]);
    for (k = 0; k < 2; k++) {
      for (j = 0; j < m->d[k].size; j++) push32(m->d[k].buf[j]);
    }
    for (j = 0; j < m->lookahead; j++) push32(m->win[j]);
  } else if (g_type == 2) {
    const bk_gate *g = &g_gate;
    push64(g->sr);
    push64(g->threshold_db);
    push64(g->range_db);
    push64(g->hold_ms);
    push64(g->hysteresis_db);
    push64(g->sc_hp_freq);
    push64((double)g->open);
    push64((double)g->hold_counter);
    push64(g->attack_ms);
    push64(g->release_ms);
    push64(g->meter);
    env_state(&g->env);
    biquad_state(&g->hp[0]);
    biquad_state(&g->hp[1]);
    smoother_state(&g->gain_sm);
  } else if (g_type == 3) {
    const bk_transient_shaper *t = &g_trans;
    push64(t->sr);
    push64(t->attack_amt);
    push64(t->sustain_amt);
    push64(t->meter);
    env_state(&t->fast);
    env_state(&t->slow);
    smoother_state(&t->gain_sm);
  } else {
    const bk_compressor *c = &g_comp;
    push64(c->sr);
    push64(c->threshold);
    push64(c->ratio);
    push64(c->knee);
    push64(c->makeup);
    push64((double)c->rms_mode);
    push64(c->lookahead_ms);
    push64(c->env_db);
    push64(c->gain_db);
    push64(c->a_coef);
    push64(c->r_coef);
    push64(c->meter);
    smoother_state(&c->attack);
    smoother_state(&c->release);
    smoother_state(&c->mk_gain);
    env_state(&c->rms);
    line_state(&c->la[0]);
    line_state(&c->la[1]);
    for (k = 0; k < 2; k++) {
      for (j = 0; j < c->la[k].size; j++) push32(c->la[k].buf[j]);
    }
  }
}

static double unsentinel(double v) {
  if (v == NAN_) return (double)NAN;
  if (v == INF_) return (double)INFINITY;
  if (v == NINF_) return -(double)INFINITY;
  return v;
}

static void vt_flags(void) {
  /* What the chain will see: no carrier bus, no latency, a meter. */
  push64(g_vt->set_carrier_bus == NULL ? 1.0 : 0.0);
  push64(g_vt->latency_samples == NULL ? 1.0 : 0.0);
  push64(g_vt->meter == NULL ? 1.0 : 0.0);
}

static void init_fx(int type, double sr) {
  size_t need;
  g_type = type;
  if (type == 0) need = bk_compressor_storage_floats(sr);
  else if (type == 1) need = bk_limiter_storage_floats(sr);
  else need = 0;
  if (need + CANARY > STORE_FLOATS) {
    fprintf(stderr, "storage overflow at sr %g\n", sr);
    exit(4);
  }
  /* A canary right after what the effect says it needs: an undersized
     bk_*_storage_floats() shows up as a write past it. */
  {
    size_t k;
    for (k = 0; k < STORE_FLOATS; k++) g_store[k] = 1234.5f;
  }
  g_need = need;
  if (type == 1) {
    bk_limiter_init(&g_lim, sr, g_store);
    g_fx = &g_lim;
    g_vt = &bk_limiter_vt;
  } else if (type == 2) {
    bk_gate_init(&g_gate, sr);
    g_fx = &g_gate;
    g_vt = &bk_gate_vt;
  } else if (type == 3) {
    bk_transient_shaper_init(&g_trans, sr);
    g_fx = &g_trans;
    g_vt = &bk_transient_shaper_vt;
  } else {
    bk_compressor_init(&g_comp, sr, g_store);
    g_fx = &g_comp;
    g_vt = &bk_compressor_vt;
  }
  check_canary();
  vt_flags();
}

static double sig_at(int s, int at) { return s == SIG_DC ? g_dc : (double)g_sig[s][at]; }

static void run_script(FILE *f, const char *name, const double *ops, size_t n_ops) {
  size_t i;
  int k, j;

  n64 = 0;
  n32 = 0;
  g_cursor = 0;
  g_gain = 1.0;
  g_dc = 0.0;
  n_pokes = 0;
  init_fx(0, 48000.0);

  for (i = 0; i + OPW <= n_ops; i += OPW) {
    const int op = (int)ops[i];
    const double a = unsentinel(ops[i + 1]), b = unsentinel(ops[i + 2]);
    const double c = unsentinel(ops[i + 3]), d = unsentinel(ops[i + 4]);
    switch (op) {
      case OP_END:
        i = n_ops;
        break;
      case OP_INIT:
        init_fx((int)a, b);
        break;
      case OP_PARAM:
        g_vt->set_param(g_fx, (int)a, b);
        break;
      case OP_PROCESS: {
        const int blocks = (int)a, bs = (int)b, sl = (int)c, sr = (int)d;
        for (k = 0; k < blocks; k++) {
          for (j = 0; j < bs; j++) {
            const int at = (g_cursor + j) % SIG_N;
            g_l[j] = (float)(g_gain * sig_at(sl, at));
            g_r[j] = (float)(g_gain * (-0.5 * sig_at(sr, at)));
          }
          g_cursor = (g_cursor + bs) % SIG_N;
          for (j = 0; j < n_pokes; j++) {
            if (poke_at[j] < bs) (poke_ch[j] ? g_r : g_l)[poke_at[j]] = (float)poke_v[j];
          }
          n_pokes = 0;
          g_vt->process(g_fx, g_l, g_r, bs);
          check_canary();
          block_state();
          for (j = 0; j < bs; j++) push32(g_l[j]);
          for (j = 0; j < bs; j++) push32(g_r[j]);
        }
        break;
      }
      case OP_MONO: {
        const int blocks = (int)a, bs = (int)b, sl = (int)c;
        for (k = 0; k < blocks; k++) {
          for (j = 0; j < bs; j++) g_l[j] = (float)(g_gain * sig_at(sl, (g_cursor + j) % SIG_N));
          g_cursor = (g_cursor + bs) % SIG_N;
          for (j = 0; j < n_pokes; j++) {
            if (poke_at[j] < bs) g_l[poke_at[j]] = (float)poke_v[j];
          }
          n_pokes = 0;
          g_vt->process(g_fx, g_l, g_l, bs);
          check_canary();
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
      case OP_GAIN:
        g_gain = a;
        break;
      case OP_DC:
        g_dc = a;
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
#define DC SIG_DC

#define THR BK_P_COMP_THRESHOLD
#define RATIO BK_P_COMP_RATIO
#define ATK BK_P_COMP_ATTACK
#define REL BK_P_COMP_RELEASE
#define KNEE BK_P_COMP_KNEE
#define MKUP BK_P_COMP_MAKEUP
#define DET BK_P_COMP_DETECTOR
#define LA BK_P_COMP_LOOKAHEAD

#define CEIL BK_P_LIMITER_CEILING
#define LREL BK_P_LIMITER_RELEASE

#define GTHR BK_P_GATE_THRESHOLD
#define GRANGE BK_P_GATE_RANGE
#define GATK BK_P_GATE_ATTACK
#define GREL BK_P_GATE_RELEASE
#define HOLD BK_P_GATE_HOLD
#define HYST BK_P_GATE_HYSTERESIS
#define SCF BK_P_GATE_SCFREQ

#define TATK BK_P_TRANSIENT_ATTACK
#define TSUS BK_P_TRANSIENT_SUSTAIN
#define TSPD BK_P_TRANSIENT_SPEED

#define O(op, a, b, c, d) (double)(op), (double)(a), (double)(b), (double)(c), (double)(d)
#define INIT(t, sr) O(OP_INIT, t, sr, 0, 0)
#define COMP(sr) INIT(0, sr)
#define LIM(sr) INIT(1, sr)
#define GATE(sr) INIT(2, sr)
#define TRANS(sr) INIT(3, sr)
#define SET(k, v) (double)OP_PARAM, (double)(k), (double)(v), 0.0, 0.0
#define PROC(n, bs, l, r) O(OP_PROCESS, n, bs, l, r)
#define SNAP O(OP_SNAP, 0, 0, 0, 0)
#define RESET O(OP_RESET, 0, 0, 0, 0)
#define POKE(ch, at, v) O(OP_POKE, ch, at, v, 0)
#define REWIND O(OP_REWIND, 0, 0, 0, 0)
#define GAIN(g) O(OP_GAIN, g, 0, 0, 0)
#define LEVEL(v) O(OP_DC, v, 0, 0, 0)
#define MONO(n, bs, s) O(OP_MONO, n, bs, s, 0)
#define END O(OP_END, 0, 0, 0, 0)

/* Loud / quiet / silent bursts, so every detector rises and falls. */
#define BURSTS(bs)                                                                                             \
  GAIN(1), PROC(4, bs, NOISE, RAMP), GAIN(0.05), PROC(4, bs, NOISE, RAMP), GAIN(1), PROC(3, bs, ZERO, ZERO), \
      GAIN(0.6), PROC(4, bs, STEP, NOISE), GAIN(0.001), PROC(3, bs, NOISE, NOISE), GAIN(1)

#define POKES                                                                                                   \
  POKE(0, 3, NAN_), POKE(1, 3, 0.5), POKE(0, 20, INF_), POKE(1, 40, NINF_), POKE(0, 60, 1e30), POKE(1, 61, -1e30), \
      POKE(0, 80, 1e-20), POKE(1, 100, 3), POKE(0, 101, -0.0), POKE(1, 102, 1e-40)

/* ---- compressor ---- */

static const double c_default[] = {PROC(6, 128, NOISE, RAMP), SNAP, BURSTS(128), SNAP, END};
/* Observe constructor coefficients and parameter clamps before processing;
   zero-frame blocks still advance attack/release smoothing to their targets. */
static const double c_guards[] = {SNAP, SET(KNEE, -3), SNAP, SET(ATK, 0.01), SET(REL, 0.5),
                                 PROC(6000, 0, ZERO, ZERO), SNAP, PROC(2, 64, NOISE, RAMP), SNAP, END};
#define CT(v) SET(THR, v), BURSTS(64)
static const double c_threshold[] = {CT(-40), CT(0), CT(10), CT(-60), CT(NAN_), CT(-18), CT(INF_), CT(NINF_), CT(-24),
                                     SNAP, END};
#define CR(v) SET(RATIO, v), BURSTS(64)
static const double c_ratio[] = {SET(THR, -30), CR(1), CR(0.5), CR(2), CR(20), CR(1e9), CR(NAN_), CR(INF_),
                                 CR(NINF_), CR(3), SNAP, END};
#define CK(v) SET(KNEE, v), BURSTS(64)
static const double c_knee[] = {SET(THR, -24), CK(0), CK(-3), CK(12), CK(40), CK(NAN_), CK(INF_), CK(0.001), CK(6),
                                SNAP, END};
/* A DC level of 1 holds the envelope at exactly 0 dB (it starts there). With
   threshold -3 and knee 6 that is the knee's upper edge: x < t + w/2 is
   false, x >= t + w/2 true, so the straight line (-2.25 dB at ratio 4, -2 at
   ratio 3). Threshold 3 puts it on the lower edge: unity. Knee 0 at
   threshold 0: x >= t, ratio applied to 0 -> 0. */
static const double c_knee_edge[] = {LEVEL(1), SET(THR, -3), SET(KNEE, 6), PROC(2, 16, DC, DC), SET(RATIO, 3),
                                     PROC(2, 16, DC, DC), SET(THR, 3), PROC(2, 16, DC, DC), SET(KNEE, 0), SET(THR, 0),
                                     PROC(2, 16, DC, DC), SET(THR, -1), PROC(2, 16, DC, DC), SET(THR, 1e-300),
                                     PROC(2, 16, DC, DC), SET(KNEE, 2), SET(THR, -0.5), PROC(2, 16, DC, DC), SNAP, END};
/* attack/release are smoothed per BLOCK: change them and watch the
   coefficients move block by block. 0.05 ms and 1 ms are the clamps. */
static const double c_ballistics[] = {SET(THR, -30), SET(ATK, 0.01), BURSTS(32), SET(ATK, 0.05), BURSTS(32),
                                      SET(ATK, 100), SET(REL, 0.5), BURSTS(32), SET(REL, 1), BURSTS(32),
                                      SET(REL, 2000), SET(ATK, 1), BURSTS(32), SET(ATK, NAN_), BURSTS(16), SNAP,
                                      COMP(48000), SET(REL, NAN_), BURSTS(16), SET(REL, NINF_), SET(ATK, INF_),
                                      BURSTS(16), SNAP, END};
/* The smoothers settle: |value - target| < 1e-9 snaps to target. */
static const double c_settle[] = {SET(ATK, 10.5), SET(REL, 119.9), SET(MKUP, 1e-8), PROC(400, 16, NOISE, RAMP), SNAP,
                                  END};
#define CM(v) SET(MKUP, v), BURSTS(64)
static const double c_makeup[] = {CM(-12), CM(12), CM(0), CM(NAN_), CM(6), CM(INF_), CM(NINF_), CM(3), SNAP, END};
#define CD(v) SET(DET, v), BURSTS(64)
static const double c_detector[] = {SET(THR, -30), CD(1), CD(0), CD(0.5), CD(0.49999999999999994), CD(NAN_), CD(2),
                                    CD(-1), CD(1), SNAP, END};
/* Lookahead in ms -> (ms * 0.001 * sr) | 0 samples, clamped to [0, 10]. */
#define CL(v) SET(LA, v), BURSTS(64)
static const double c_lookahead[] = {SET(THR, -30), CL(0.5), CL(10), CL(11), CL(0), CL(-1), CL(0.01), CL(NAN_),
                                     CL(2.5), CL(INF_), CL(0.02), CL(5), SNAP, END};
static const double c_la_rates[] = {COMP(4500.3), SET(LA, 10), BURSTS(64), SNAP, COMP(1000), SET(LA, 10), BURSTS(16),
                                    SET(LA, 0.999), BURSTS(16), SNAP, COMP(96000), SET(LA, 7.3), BURSTS(128), SNAP,
                                    COMP(333.3), SET(LA, 10), BURSTS(8), SNAP, END};
/* reset(): envelope -120 dB, gain 0, lines and RMS follower cleared; the
   smoothers carry on. */
static const double c_reset[] = {SET(THR, -30), SET(DET, 1), SET(LA, 3), SET(MKUP, 6), SET(ATK, 40), BURSTS(64),
                                 SNAP, RESET, SNAP, PROC(2, 64, NOISE, RAMP), SET(DET, 0), RESET,
                                 PROC(2, 64, ZERO, ZERO), SNAP, END};
static const double c_blocks[] = {SET(THR, -30), SET(LA, 1), PROC(3, 0, NOISE, RAMP), PROC(40, 1, NOISE, RAMP),
                                  PROC(7, 7, NOISE, RAMP), PROC(1, 4096, NOISE, RAMP), PROC(1, -3, NOISE, RAMP),
                                  SET(ATK, 50), PROC(2, 0, NOISE, RAMP), REWIND, PROC(1, 128, NOISE, RAMP), SNAP, END};
static const double c_rates[] = {COMP(44100), BURSTS(128), SNAP, COMP(22050), SET(DET, 1), BURSTS(128), SNAP,
                                 COMP(8000), SET(THR, -40), BURSTS(64), SNAP, END};
/* Pokes with and without lookahead: the line write sanitises NaN, inf, huge
   and tiny values, the direct path does not. */
static const double c_poke[] = {POKES, PROC(2, 128, NOISE, RAMP), SET(THR, -30), POKES, PROC(2, 128, NOISE, RAMP),
                                SNAP, COMP(48000), SET(LA, 1), POKES, PROC(2, 128, NOISE, RAMP), SET(DET, 1), POKES,
                                PROC(2, 128, NOISE, RAMP), SNAP, COMP(48000), SET(DET, 1), POKES,
                                PROC(2, 128, NOISE, RAMP), SNAP, END};
static const double c_signed_zero[] = {PROC(2, 64, ZERO, ZERO), POKE(0, 0, -0.0), POKE(1, 1, -0.0),
                                       PROC(1, 64, ZERO, ZERO), SET(LA, 1), POKE(0, 0, -0.0), PROC(1, 64, ZERO, ZERO),
                                       SNAP, END};
static const double c_alias[] = {SET(THR, -30), MONO(6, 128, NOISE), SET(LA, 2), MONO(6, 128, NOISE), SET(DET, 1),
                                 MONO(4, 128, STEP), SNAP, END};
static const double c_unknown[] = {SET(-1, 5), SET(8, 5), SET(99, 5), PROC(2, 128, NOISE, RAMP), SNAP, END};

/* ---- limiter ---- */

static const double l_default[] = {LIM(48000), PROC(6, 128, NOISE, RAMP), SNAP, BURSTS(128), SNAP, END};
#define LC(v) SET(CEIL, v), BURSTS(64)
static const double l_ceiling[] = {LIM(48000), LC(-6), LC(0), LC(6), LC(-60), LC(NAN_), LC(-0.3), LC(INF_),
                                   LC(NINF_), LC(-3), SNAP, END};
#define LR(v) SET(LREL, v), BURSTS(64)
static const double l_release[] = {LIM(48000), SET(CEIL, -12), LR(1), LR(5), LR(500), LR(NAN_), LR(20), LR(NINF_),
                                   LR(INF_), LR(80), SNAP, END};
/* The lookahead is max(8, Math.round(sr * 0.0015)): 8 below 5333 Hz, and the
   rounding at 9000 Hz (13.5 -> 14) and 8333 / 8334 Hz. */
static const double l_rates[] = {LIM(4000), BURSTS(32), SNAP, LIM(5333.4), BURSTS(32), SNAP, LIM(9000), BURSTS(32),
                                 SNAP, LIM(8333), BURSTS(32), SNAP, LIM(8334), BURSTS(32), SNAP, LIM(44100),
                                 BURSTS(128), SNAP, LIM(96000), BURSTS(128), SNAP, LIM(1000.7), BURSTS(16), END};
/* A loud DC step from silence: env starts at 0, so the attack coefficient
   applies on the first frame; then a hold at exactly the ceiling. */
static const double l_dc[] = {LIM(48000), LEVEL(2), PROC(4, 32, DC, DC), LEVEL(0.5), PROC(8, 32, DC, DC), SET(CEIL, 0),
                              LEVEL(1), PROC(4, 32, DC, DC), LEVEL(0), PROC(8, 32, DC, DC), SNAP, END};
/* reset(): lines, window, envelope; NOT the window index. */
static const double l_reset[] = {LIM(48000), SET(CEIL, -6), PROC(3, 37, NOISE, RAMP), SNAP, RESET, SNAP,
                                 PROC(2, 64, NOISE, RAMP), RESET, PROC(2, 64, ZERO, ZERO), SNAP, END};
static const double l_blocks[] = {LIM(48000), PROC(3, 0, NOISE, RAMP), PROC(200, 1, NOISE, RAMP),
                                  PROC(7, 7, NOISE, RAMP), PROC(1, 4096, NOISE, RAMP), PROC(1, -3, NOISE, RAMP),
                                  REWIND, PROC(1, 128, NOISE, RAMP), SNAP, END};
static const double l_poke[] = {LIM(48000), POKES, PROC(2, 128, NOISE, RAMP), SET(CEIL, -12), POKES,
                                PROC(2, 128, NOISE, RAMP), SNAP, END};
static const double l_alias[] = {LIM(48000), SET(CEIL, -6), MONO(6, 128, NOISE), SNAP, END};
static const double l_unknown[] = {LIM(48000), SET(-1, 5), SET(2, 5), SET(99, 5), PROC(2, 128, NOISE, RAMP), SNAP,
                                   END};

/* ---- gate ---- */

static const double g_default[] = {GATE(48000), PROC(6, 128, NOISE, RAMP), SNAP, BURSTS(128), SNAP, END};
/* A negative fractional sample count must truncate toward zero, not floor.
   Snapshot it while the detector is above the threshold (counter just set). */
static const double g_hold_fraction[] = {GATE(48000), SET(GTHR, -180), SET(HOLD, -0.01),
                                        PROC(1, 1, NOISE, NOISE), SNAP, END};
/* Open, hold, close: the hold counter counts down only below the close
   threshold. */
#define GH(v) SET(HOLD, v), GAIN(1), PROC(3, 128, NOISE, RAMP), GAIN(0.003), PROC(6, 128, NOISE, RAMP), \
  PROC(4, 128, ZERO, ZERO)
static const double g_hold[] = {GATE(48000), SET(GREL, 5), GH(40), GH(0), GH(10), GH(200), GH(-10), GH(NAN_),
                                GH(INF_), GH(1e9), GH(50000), GH(3), SNAP, END};
#define GT(v) SET(GTHR, v), BURSTS(64)
static const double g_threshold[] = {GATE(48000), GT(-60), GT(-20), GT(0), GT(NAN_), GT(-100), GT(INF_), GT(NINF_),
                                     GT(-45), SNAP, END};
#define GY(v) SET(HYST, v), BURSTS(64)
static const double g_hysteresis[] = {GATE(48000), SET(GTHR, -40), GY(0), GY(-10), GY(20), GY(NAN_), GY(4), GY(INF_),
                                      GY(6), SNAP, END};
#define GR(v) SET(GRANGE, v), BURSTS(64)
static const double g_range[] = {GATE(48000), GR(0), GR(-20), GR(NINF_), GR(NAN_), GR(10), GR(-60), GR(INF_), GR(-30),
                                 SNAP, END};
#define GA(v) SET(GATK, v), BURSTS(64)
static const double g_attack[] = {GATE(48000), GA(0.1), GA(0.5), GA(5), GA(NAN_), GA(0.001), GA(50), GA(-3), GA(1),
                                  SNAP, END};
#define GL(v) SET(GREL, v), BURSTS(64)
static const double g_release[] = {GATE(48000), GL(0.001), GL(500), GL(NAN_), GL(30), GL(-1), GL(120), SNAP, END};
#define GS(v) SET(SCF, v), BURSTS(64)
static const double g_scfreq[] = {GATE(48000), GS(20), GS(2000), GS(30000), GS(NAN_), GS(-5), GS(80), GS(0), GS(500),
                                  SNAP, END};
/* gainToDb of silence is 20 * log10(1e-9) = -180 exactly: threshold -180
   must stay shut (db > openDb is false). */
static const double g_open_edge[] = {GATE(48000), SET(GTHR, -180), PROC(4, 64, ZERO, ZERO), SET(GTHR, -180.00000000000003),
                                     PROC(2, 64, ZERO, ZERO), SNAP, END};
/* closeDb = -170 - 10 = -180: silence is not below it, so the gate never
   closes; one ulp lower and it does. */
static const double g_close_edge[] = {GATE(48000), SET(GTHR, -170), SET(HYST, 10), SET(HOLD, 0), SET(GREL, 0.001),
                                      PROC(3, 64, NOISE, NOISE), PROC(60, 64, ZERO, ZERO), SNAP, SET(HYST, 9.999999999999972),
                                      PROC(4, 64, ZERO, ZERO), SNAP, END};
/* reset(): gain smoother to 0, closed, hold cleared, filters and follower. */
static const double g_reset[] = {GATE(48000), SET(GATK, 3), PROC(4, 64, NOISE, RAMP), SNAP, RESET, SNAP,
                                 PROC(2, 64, NOISE, RAMP), RESET, PROC(2, 64, ZERO, ZERO), SNAP, END};
static const double g_blocks[] = {GATE(48000), PROC(3, 0, NOISE, RAMP), PROC(40, 1, NOISE, RAMP),
                                  PROC(7, 7, NOISE, RAMP), PROC(1, 4096, NOISE, RAMP), PROC(1, -3, NOISE, RAMP),
                                  SET(SCF, 300), PROC(2, 0, NOISE, RAMP), REWIND, PROC(1, 128, NOISE, RAMP), SNAP, END};
static const double g_rates[] = {GATE(44100), BURSTS(128), SNAP, GATE(8000), BURSTS(64), SNAP, GATE(4500.3),
                                 SET(HOLD, 13.7), BURSTS(64), SNAP, END};
static const double g_poke[] = {GATE(48000), POKES, PROC(2, 128, NOISE, RAMP), SET(GTHR, -20), POKES,
                                PROC(2, 128, NOISE, RAMP), SNAP, END};
static const double g_alias[] = {GATE(48000), MONO(4, 128, NOISE), SET(GRANGE, -20), MONO(4, 128, ZERO),
                                 MONO(4, 128, STEP), SNAP, END};
static const double g_unknown[] = {GATE(48000), SET(-1, 5), SET(7, 5), SET(99, 5), PROC(2, 128, NOISE, RAMP), SNAP,
                                   END};

/* ---- transient shaper ---- */

static const double t_default[] = {TRANS(48000), BURSTS(128), SNAP, END};
#define TA(a, s) SET(TATK, a), SET(TSUS, s), BURSTS(64)
static const double t_amounts[] = {TRANS(48000), TA(12, 0), TA(-12, 0), TA(0, 12), TA(0, -12), TA(6, -6), TA(NAN_, 0),
                                   TA(0, NAN_), TA(INF_, 0), TA(0, NINF_), TA(-0.0, -0.0), TA(3, 3), SNAP, END};
#define TS(v) SET(TSPD, v), BURSTS(64)
static const double t_speed[] = {TRANS(48000), SET(TATK, 9), SET(TSUS, -6), TS(0.1), TS(0.6666666666666667), TS(1),
                                 TS(10), TS(100), TS(NAN_), TS(-5), TS(INF_), TS(2), SNAP, END};
/* A slow attack makes the fast follower lag less than the slow one: the
   transient region on onsets, sustain on the tail. Impulses and steps. */
static const double t_shapes[] = {TRANS(48000), SET(TATK, 12), SET(TSUS, -9), PROC(6, 128, IMP, STEP), REWIND,
                                  PROC(6, 128, STEP, IMP), GAIN(0.25), PROC(260, 128, STEP, STEP), SNAP, END};
static const double t_reset[] = {TRANS(48000), SET(TATK, 6), SET(TSUS, 6), BURSTS(64), SNAP, RESET, SNAP,
                                 PROC(2, 64, NOISE, RAMP), SNAP, END};
static const double t_blocks[] = {TRANS(48000), SET(TATK, 6), PROC(3, 0, NOISE, RAMP), PROC(40, 1, NOISE, RAMP),
                                  PROC(7, 7, NOISE, RAMP), PROC(1, 4096, NOISE, RAMP), PROC(1, -3, NOISE, RAMP), REWIND,
                                  PROC(1, 128, NOISE, RAMP), SNAP, END};
static const double t_rates[] = {TRANS(44100), SET(TATK, 6), BURSTS(128), SNAP, TRANS(8000), SET(TSUS, 6), BURSTS(64),
                                 SNAP, END};
static const double t_poke[] = {TRANS(48000), POKES, PROC(2, 128, NOISE, RAMP), SET(TATK, 12), POKES,
                                PROC(2, 128, NOISE, RAMP), SNAP, END};
/* Silence from init: both followers at 0, diff exactly 0 (neutral). */
static const double t_silence[] = {TRANS(48000), SET(TATK, 6), SET(TSUS, 6), PROC(2, 64, ZERO, ZERO),
                                   PROC(2, 64, NOISE, RAMP), SNAP, END};
static const double t_alias[] = {TRANS(48000), SET(TATK, 6), SET(TSUS, -6), MONO(6, 128, NOISE), SNAP, END};
static const double t_unknown[] = {TRANS(48000), SET(-1, 5), SET(3, 5), SET(99, 5), PROC(2, 128, NOISE, RAMP), SNAP,
                                   END};

#define S(n) {#n, n, sizeof(n) / sizeof(n[0])}

typedef struct {
  const char *name;
  const double *ops;
  size_t n;
} script;

static const script scripts[] = {
    S(c_default),   S(c_threshold), S(c_ratio),     S(c_knee),      S(c_knee_edge),  S(c_ballistics),
    S(c_settle),    S(c_makeup),    S(c_detector),  S(c_lookahead), S(c_la_rates),   S(c_reset),
    S(c_blocks),    S(c_rates),     S(c_poke),      S(c_signed_zero), S(c_alias),    S(c_unknown),
    S(l_default),   S(l_ceiling),   S(l_release),   S(l_rates),     S(l_dc),         S(l_reset),
    S(l_blocks),    S(l_poke),      S(l_alias),     S(l_unknown),   S(g_default),    S(g_hold),
    S(g_threshold), S(g_hysteresis), S(g_range),    S(g_attack),    S(g_release),    S(g_scfreq),
    S(g_open_edge), S(g_close_edge), S(g_reset),    S(g_blocks),    S(g_rates),      S(g_poke),
    S(g_alias),     S(g_unknown),   S(t_default),   S(t_amounts),   S(t_speed),      S(t_shapes),
    S(t_reset),     S(t_blocks),    S(t_rates),     S(t_poke),      S(t_silence),    S(t_alias),
    S(t_unknown), S(c_guards), S(g_hold_fraction),
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
