/*
 * Parity dump for the C port of dsp/effects/character.js (Character, Glitch,
 * NoiseGen).
 *
 * Producer half of the oracle; scripts/verify-character-parity.mjs is the
 * consumer. See parity-io.h for the stream format.
 *
 * Same shape as parity-drive.c: every case is an opcode script, the script
 * travels as the record's params, and the JS runner replays it op for op.
 * Every op goes through bk_character_vt / bk_glitch_vt / bk_noise_gen_vt.
 * OP_INIT picks the effect (0 character, 1 glitch, 2 noise) and the sample
 * rate; a script starts as a 48 kHz character.
 *
 * Per PROCESS block: the smoothers, the clocks and the discrete state, the
 * draw count and the meter (through the vtable, 0 when it has none), then
 * every output sample (out32). SNAP adds the whole struct, filters included,
 * and the float32 buffers (both wow/flutter lines, both glitch buffers).
 *
 * Randomness: every Math.random() is a seeded xorshift32 the JS mirrors
 * (OP_SEED), reseeded to 1 at every script start and every INIT. Seed 0
 * selects the effect's internal generator, which the JS mirrors too. Every
 * draw is counted.
 *
 * Scripts named x_* exercise the deliberate divergence in character.h (NaN
 * mode). The verifier replays them against the C contract expressed in JS,
 * and asserts that ONLY x_* scripts need it.
 *
 * Usage: parity-character <out.bin>
 */

#include "brokodr/dsp/character.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

enum {
  OP_END = 0,
  OP_INIT = 1,    /* a = type (0 character, 1 glitch, 2 noise), b = sample rate */
  OP_PARAM = 2,   /* a = key, b = value */
  OP_PROCESS = 3, /* a = blocks, b = block size, c = left signal, d = right signal */
  OP_RESET = 4,
  OP_SNAP = 5,
  OP_POKE = 6,    /* next block only: channel a (0/1), sample b, value c */
  OP_REWIND = 7,  /* stimulus cursor back to 0 */
  OP_SEED = 8,    /* a = seed, 0 = the effect's internal generator */
  OP_MONO = 10    /* as OP_PROCESS on one buffer, l and r aliased: a = blocks, b = size, c = signal */
};
#define OPW 5

#define SIG_N 65536
#define N_SIGS 5
#define MAX_BLOCK 4096
#define MAX_POKES 32
#define MAX_P64 2000000
#define MAX_P32 4000000
#define MAX_SR 96000
#define STORE_FLOATS (4 * MAX_SR + 64)

/* Per-block readings. Field order is the contract with blockState(). */
#define BK_CHAR_BLOCK 12
#define BK_GLITCH_BLOCK 11
#define BK_NOISE_BLOCK 9
/* Struct snapshots (doubles). Field order is the contract with snapState(). */
#define BK_CHAR_SNAP 148
#define BK_GLITCH_SNAP 18
#define BK_NOISE_SNAP 41

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

static bk_character g_char;
static bk_glitch g_glitch;
static bk_noise_gen g_noise;
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
static int n_pokes;
static int poke_ch[MAX_POKES];
static int poke_at[MAX_POKES];
static double poke_v[MAX_POKES];

/* Mirrored in the verifier as Math.random. */
static unsigned int g_seed;
static double g_draws;
/* The state travels through the user pointer (always &g_seed), so an effect
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
/* Counts draws made through an effect's internal generator, delegating to the
   function set_random(NULL) installed so that it is what runs. */
static bk_random_fn g_internal_fn;
static double counted_internal(void *user) {
  g_draws += 1.0;
  return g_internal_fn(user);
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

static void lfo_state(const bk_lfo *o) {
  push64(o->phase);
  push64(o->inc);
  push64((double)o->shape);
  push64(o->rand);
  push64(o->last_quad);
}

static void env_state(const bk_env_follower *e) {
  push64((double)e->rms);
  push64(e->env);
  push64(e->ca);
  push64(e->cr);
}

static void pink_state(const bk_pink_noise *p) {
  int k;
  for (k = 0; k < 7; k++) push64((double)p->b[k]);
}

static void block_state(void) {
  const double meter = g_vt->meter ? g_vt->meter(g_fx) : 0.0;
  if (g_type == 1) {
    const bk_glitch *g = &g_glitch;
    push64((double)g->w);
    push64(g->slice_len);
    push64((double)g->active);
    push64(g->slice_start);
    push64(g->repeat_count);
    push64(g->read_pos);
    push64(g->counter);
    push64((double)g->freeze);
    push64(g->division);
    push64(g_draws);
    push64(meter);
  } else if (g_type == 2) {
    const bk_noise_gen *n = &g_noise;
    push64(n->level_sm.value);
    push64(n->level_sm.target);
    push64(n->brown);
    push64(n->env.env);
    push64(n->type);
    push64(n->follow);
    push64(n->lp_freq);
    push64(g_draws);
    push64(meter);
  } else {
    const bk_character *c = &g_char;
    push64(c->squelch_sm.value);
    push64(c->squelch_sm.target);
    push64(c->out_sm.value);
    push64(c->out_sm.target);
    push64(c->crackle_state);
    push64(c->gate_env.env);
    push64(c->wobble_lfo.phase);
    push64(c->flutter_lfo.phase);
    push64((double)c->wobble_line[0].w);
    push64((double)c->mode);
    push64(g_draws);
    push64(meter);
  }
}

static void snap_state(void) {
  int k, j;
  if (g_type == 1) {
    const bk_glitch *g = &g_glitch;
    push64(g->sr);
    push64((double)g->buf_size);
    push64((double)g->w);
    push64(g->bpm);
    push64(g->division);
    push64(g->probability);
    push64(g->reverse);
    push64(g->pitch_ratio);
    push64(g->repeats);
    push64(g->xfade);
    push64(g->slice_len);
    push64((double)g->active);
    push64(g->slice_start);
    push64(g->repeat_count);
    push64(g->read_pos);
    push64(g->counter);
    push64((double)g->freeze);
    push64(g->meter);
    for (k = 0; k < g->buf_size; k++) push32(g->buf_l[k]);
    for (k = 0; k < g->buf_size; k++) push32(g->buf_r[k]);
  } else if (g_type == 2) {
    const bk_noise_gen *n = &g_noise;
    push64(n->sr);
    push64(n->type);
    push64(n->brown);
    push64(n->follow);
    push64(n->lp_freq);
    smoother_state(&n->level_sm);
    pink_state(&n->pink);
    env_state(&n->env);
    biquad_state(&n->lp[0]);
    biquad_state(&n->lp[1]);
  } else {
    const bk_character *c = &g_char;
    push64(c->sr);
    push64((double)c->mode);
    push64(c->amount);
    push64(c->drive_trim);
    push64(c->noise_trim);
    push64(c->wobble_trim);
    push64(c->crackle_state);
    for (k = 0; k < 2; k++) {
      for (j = 0; j < 2; j++) biquad_state(&c->hp[k].stages[j]);
      for (j = 0; j < 2; j++) biquad_state(&c->lp[k].stages[j]);
      biquad_state(&c->res[k]);
    }
    pink_state(&c->noise);
    lfo_state(&c->wobble_lfo);
    lfo_state(&c->flutter_lfo);
    for (k = 0; k < 2; k++) {
      push64((double)c->wobble_line[k].size);
      push64((double)c->wobble_line[k].w);
    }
    env_state(&c->gate_env);
    smoother_state(&c->squelch_sm);
    smoother_state(&c->out_sm);
    for (k = 0; k < 2; k++) {
      for (j = 0; j < c->wobble_line[k].size; j++) push32(c->wobble_line[k].buf[j]);
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
  /* What the chain will see: no carrier bus, no latency; a meter on glitch. */
  push64(g_vt->set_carrier_bus == NULL ? 1.0 : 0.0);
  push64(g_vt->latency_samples == NULL ? 1.0 : 0.0);
  push64(g_vt->meter == NULL ? 1.0 : 0.0);
}

static void wrap_internal(void);
static void init_fx(int type, double sr, int raw) {
  size_t need;
  g_type = type;
  g_seed = 1u;
  if (type == 1) {
    need = bk_glitch_storage_floats(sr);
  } else if (type == 2) {
    need = 0;
  } else {
    need = bk_character_storage_floats(sr);
  }
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
    bk_glitch_init(&g_glitch, sr, g_store);
    if (!raw) bk_glitch_set_random(&g_glitch, test_random, &g_seed);
    g_fx = &g_glitch;
    g_vt = &bk_glitch_vt;
  } else if (type == 2) {
    bk_noise_gen_init(&g_noise, sr);
    if (!raw) bk_noise_gen_set_random(&g_noise, test_random, &g_seed);
    g_fx = &g_noise;
    g_vt = &bk_noise_gen_vt;
  } else {
    bk_character_init(&g_char, sr, g_store);
    if (!raw) bk_character_set_random(&g_char, test_random, &g_seed);
    g_fx = &g_char;
    g_vt = &bk_character_vt;
  }
  /* raw: keep the generator init() installed (never call set_random), only
     counting its draws. */
  if (raw) wrap_internal();
  vt_flags();
}

static void wrap_internal(void) {
  if (g_type == 1) {
    g_internal_fn = g_glitch.random;
    g_glitch.random = counted_internal;
  } else if (g_type == 2) {
    g_internal_fn = g_noise.random;
    g_noise.random = counted_internal;
  } else {
    g_internal_fn = g_char.random;
    g_char.random = counted_internal;
  }
}

static void seed(double a) {
  if (a == 0.0) {
    /* Count draws without changing what the internal generator does. */
    if (g_type == 1) bk_glitch_set_random(&g_glitch, NULL, NULL);
    else if (g_type == 2) bk_noise_gen_set_random(&g_noise, NULL, NULL);
    else bk_character_set_random(&g_char, NULL, NULL);
    wrap_internal();
    return;
  }
  g_seed = (unsigned int)a;
  if (g_type == 1) bk_glitch_set_random(&g_glitch, test_random, &g_seed);
  else if (g_type == 2) bk_noise_gen_set_random(&g_noise, test_random, &g_seed);
  else bk_character_set_random(&g_char, test_random, &g_seed);
}

static void run_script(FILE *f, const char *name, const double *ops, size_t n_ops) {
  size_t i;
  int k, j;

  n64 = 0;
  n32 = 0;
  g_cursor = 0;
  n_pokes = 0;
  g_draws = 0.0;
  init_fx(0, 48000.0, 0);

  for (i = 0; i + OPW <= n_ops; i += OPW) {
    const int op = (int)ops[i];
    const double a = unsentinel(ops[i + 1]), b = unsentinel(ops[i + 2]);
    const double c = unsentinel(ops[i + 3]), d = unsentinel(ops[i + 4]);
    switch (op) {
      case OP_END:
        i = n_ops;
        break;
      case OP_INIT:
        init_fx((int)a, b, c != 0.0);
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
          for (j = 0; j < bs; j++) g_l[j] = g_sig[sl][(g_cursor + j) % SIG_N];
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
      case OP_SEED:
        seed(a);
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

#define MODE BK_P_CHARACTER_MODE
#define AMT BK_P_CHARACTER_AMOUNT
#define CDRV BK_P_CHARACTER_DRIVE
#define CNOISE BK_P_CHARACTER_NOISE
#define WOB BK_P_CHARACTER_WOBBLE
#define COUT BK_P_CHARACTER_OUTPUT

#define PROB BK_P_GLITCH_PROBABILITY
#define BPM BK_P_GLITCH_BPM
#define DIV BK_P_GLITCH_DIVISION
#define REP BK_P_GLITCH_REPEATS
#define REV BK_P_GLITCH_REVERSE
#define PITCH BK_P_GLITCH_PITCH
#define FRZ BK_P_GLITCH_FREEZE

#define LVL BK_P_NOISE_LEVEL
#define TYPE BK_P_NOISE_TYPE
#define FOL BK_P_NOISE_FOLLOW
#define TONE BK_P_NOISE_TONE

#define O(op, a, b, c, d) (double)(op), (double)(a), (double)(b), (double)(c), (double)(d)
#define INIT(t, sr) O(OP_INIT, t, sr, 0, 0)
#define CHAR O(OP_INIT, 0, 48000, 0, 0)
#define GLITCH(sr) O(OP_INIT, 1, sr, 0, 0)
#define NGEN O(OP_INIT, 2, 48000, 0, 0)
#define SET(k, v) (double)OP_PARAM, (double)(k), (double)(v), 0.0, 0.0
#define PROC(n, bs, l, r) O(OP_PROCESS, n, bs, l, r)
#define SNAP O(OP_SNAP, 0, 0, 0, 0)
#define RESET O(OP_RESET, 0, 0, 0, 0)
#define POKE(ch, at, v) O(OP_POKE, ch, at, v, 0)
#define REWIND O(OP_REWIND, 0, 0, 0, 0)
#define SEED(s) O(OP_SEED, s, 0, 0, 0)
#define MONO(n, bs, s) O(OP_MONO, n, bs, s, 0)
#define END O(OP_END, 0, 0, 0, 0)

/* ---- character ---- */

static const double h_default[] = {PROC(4, 128, NOISE, RAMP), SNAP, END};
/* Every mode, a few blocks each, then back: filters keep their state. */
#define MR(k) SET(MODE, k), PROC(3, 128, NOISE, RAMP)
static const double h_modes[] = {MR(0), MR(1), MR(2), MR(3), MR(4), MR(5), MR(6), MR(7), MR(2), SNAP, END};
static const double h_modes_hot[] = {SET(CDRV, 12), MR(7), MR(6), MR(5), MR(4), MR(3), MR(2), MR(1), MR(0),
                                     SET(CDRV, 0), SET(AMT, 0.5), MR(6), MR(2), SNAP, END};
/* Math.round and the clamp: halves, the 0.49999999999999994 trap, -0,
   negatives, out of range, both infinities. */
#define MO(v) SET(MODE, v), PROC(1, 64, NOISE, RAMP)
static const double h_mode_round[] = {MO(0.5), MO(1.5), MO(2.4999999999999996), MO(2.5), MO(0.49999999999999994),
                                      MO(-0.3), MO(-0.7), MO(-0.0), MO(6.5), MO(7.5), MO(7.4999), MO(3.5),
                                      MO(INF_), MO(NINF_), MO(1e300), MO(-1e300), MO(4.5), SNAP, END};
/* AMOUNT blends edges, resonance, drive, noise, crackle and wobble. */
#define AM(v) SET(AMT, v), PROC(3, 128, NOISE, RAMP)
static const double h_amount[] = {SET(MODE, 4), AM(0), AM(0.25), AM(1), AM(2), AM(-1), AM(0.5), SET(MODE, 5),
                                  AM(0.001), AM(1), AM(NAN_), AM(INF_), AM(NINF_), AM(0.7), SNAP, END};
static const double h_drive[] = {SET(MODE, 2), SET(CDRV, -24), PROC(3, 128, NOISE, RAMP), SET(CDRV, 18),
                                 PROC(3, 128, NOISE, RAMP), SET(MODE, 6), PROC(3, 128, NOISE, RAMP), SET(MODE, 0),
                                 SET(CDRV, 30), PROC(3, 128, NOISE, RAMP), SET(CDRV, NAN_), PROC(2, 128, NOISE, RAMP),
                                 SET(CDRV, INF_), PROC(2, 128, NOISE, RAMP), SET(AMT, 0), PROC(2, 128, NOISE, RAMP),
                                 SET(AMT, 1), SET(CDRV, NINF_), PROC(2, 128, NOISE, RAMP), SNAP, END};
static const double h_noise_trim[] = {SET(MODE, 3), SET(CNOISE, 0), PROC(3, 128, NOISE, RAMP), SET(CNOISE, 2),
                                      PROC(3, 128, NOISE, RAMP), SET(CNOISE, 4), PROC(3, 128, NOISE, RAMP),
                                      SET(CNOISE, 9), PROC(3, 128, NOISE, RAMP), SET(CNOISE, -1),
                                      PROC(3, 128, NOISE, RAMP), SET(CNOISE, NAN_), PROC(2, 128, NOISE, RAMP),
                                      SET(CNOISE, 1), SET(MODE, 1), PROC(3, 128, NOISE, RAMP), SNAP, END};
static const double h_wobble[] = {SET(MODE, 4), PROC(6, 128, NOISE, RAMP), SET(WOB, 2), PROC(6, 128, NOISE, RAMP),
                                  SET(WOB, 3), PROC(3, 128, NOISE, RAMP), SET(WOB, 0), PROC(3, 128, NOISE, RAMP),
                                  SET(WOB, -1), PROC(2, 128, NOISE, RAMP), SET(WOB, 1), SET(MODE, 7),
                                  PROC(6, 128, NOISE, RAMP), SET(WOB, NAN_), PROC(2, 128, NOISE, RAMP), SET(WOB, 1.5),
                                  SET(MODE, 1), PROC(4, 128, NOISE, RAMP), SNAP, END};
/* wob depth = 0.5 * a * 1 * 0.0012 * 48000 == 0.001 exactly: the `> 0.001`
   gate is closed. Then one ulp above, on a fresh effect: open. */
static const double h_wob_edge[] = {SET(MODE, 4), SET(AMT, 0x1.23456789abce0p-15), PROC(2, 64, NOISE, RAMP), SNAP,
                                    CHAR, SET(MODE, 4), SET(AMT, 0x1.23456789abce1p-15), PROC(2, 64, NOISE, RAMP),
                                    SNAP, END};
static const double h_output[] = {SET(COUT, -12), PROC(4, 128, NOISE, RAMP), SET(COUT, 6), PROC(4, 128, NOISE, RAMP),
                                  SET(COUT, NAN_), PROC(2, 128, NOISE, RAMP), SNAP, SET(COUT, INF_),
                                  PROC(2, 128, NOISE, RAMP), SET(COUT, NINF_), PROC(2, 128, NOISE, RAMP), SET(COUT, 0),
                                  PROC(2, 128, NOISE, RAMP), SNAP, END};
/* Walkie squelch: closed on silence, opening on signal, closing again. */
static const double h_squelch[] = {SET(MODE, 3), PROC(10, 128, ZERO, ZERO), PROC(10, 128, NOISE, RAMP),
                                   PROC(40, 128, ZERO, ZERO), PROC(4, 128, IMP, ZERO), PROC(30, 128, STEP, STEP),
                                   SET(MODE, 0), PROC(2, 128, ZERO, ZERO), SET(MODE, 3), PROC(2, 128, ZERO, ZERO),
                                   SNAP, END};
/* One frame of 0.0125 from a zero envelope at this rate puts the gate
   envelope at a double whose gainToDb is exactly -42: `> -42` stays shut. */
static const double h_squelch_edge[] = {INIT(0, 495.47823245956704), SET(MODE, 3), POKE(0, 0, 0.0125),
                                        PROC(1, 1, ZERO, ZERO), SNAP, END};
/* Crackle: vinyl, with and without the noise floor drawing first. */
static const double h_crackle[] = {SET(MODE, 5), PROC(60, 128, NOISE, RAMP), SET(CNOISE, 0), PROC(60, 128, ZERO, ZERO),
                                   SEED(987654321), SET(MODE, 1), PROC(40, 128, NOISE, RAMP), SET(AMT, 0),
                                   PROC(2, 128, NOISE, RAMP), SNAP, END};
static const double h_internal[] = {SEED(0), SET(MODE, 5), PROC(40, 128, NOISE, RAMP), SEED(7),
                                    PROC(4, 128, NOISE, RAMP), SEED(0), SET(MODE, 3), PROC(4, 128, NOISE, RAMP), SNAP,
                                    CHAR, SEED(0), SET(MODE, 1), PROC(20, 128, NOISE, RAMP), END};
/* Seed 1's first draw is 270369 / 2^32. Vinyl at amount 0.5 with no noise
   floor: crackleP = 0.0002, so frame 0 crackles at half strength; reset()
   keeps the crackle state (as the JS does), and it decays into the next block. */
static const double h_crackle_reset[] = {SET(MODE, 5), SET(CNOISE, 0), SET(AMT, 0.5), PROC(1, 1, ZERO, ZERO), SNAP,
                                         RESET, PROC(1, 64, ZERO, ZERO), SNAP, END};
/* Amount 0x1.424e122p-3 makes crackleP == 270369 / 2^32 exactly: the first
   draw equals it and `<` does not fire. */
static const double h_crackle_edge[] = {SET(MODE, 5), SET(CNOISE, 0), SET(AMT, 0x1.424e122p-3), PROC(1, 1, ZERO, ZERO),
                                        SNAP, PROC(1, 64, ZERO, ZERO), SNAP, END};
/* init() without set_random: its own default generator draws. */
static const double h_init_internal[] = {O(OP_INIT, 0, 48000, 1, 0), SET(MODE, 5), PROC(20, 128, NOISE, RAMP), SNAP,
                                         END};
/* reset(): filters, delay lines and gate envelope only. */
static const double h_reset[] = {SET(MODE, 3), SET(COUT, -6), PROC(6, 128, NOISE, RAMP), SET(MODE, 4),
                                 PROC(6, 128, NOISE, RAMP), SNAP, RESET, SNAP, PROC(2, 128, NOISE, RAMP), SET(MODE, 3),
                                 PROC(3, 128, NOISE, RAMP), RESET, SNAP, PROC(2, 128, IMP, IMP), SNAP, END};
/* Block sizes: 0 and negative (per-block filter sets still run), 1, odd, max. */
static const double h_blocks[] = {SET(MODE, 7), PROC(3, 0, NOISE, RAMP), PROC(30, 1, NOISE, RAMP),
                                  PROC(7, 7, NOISE, RAMP), PROC(1, 4096, NOISE, RAMP), PROC(1, -3, NOISE, RAMP),
                                  REWIND, SET(MODE, 3), PROC(2, 0, NOISE, RAMP), PROC(1, 128, NOISE, RAMP), SNAP, END};
static const double h_rates[] = {INIT(0, 44100), SET(MODE, 4), PROC(5, 128, NOISE, RAMP), SNAP, INIT(0, 96000),
                                 SET(MODE, 7), PROC(5, 128, NOISE, RAMP), SNAP, INIT(0, 22050), SET(MODE, 5),
                                 PROC(5, 128, NOISE, RAMP), SNAP, INIT(0, 8000), SET(MODE, 4), SET(WOB, 2),
                                 PROC(5, 128, NOISE, RAMP), SNAP, INIT(0, 1000), SET(MODE, 3), PROC(3, 64, NOISE, RAMP),
                                 END};
/* Below ~500 Hz the read position outruns the line: at 130 Hz the line holds
   ceil(2.6) = 3 samples of delay and the lofi-tape read wants ~8.5, so the
   upper clamp (size - 4) binds. Pins the wobble line's sizing. */
static const double h_wob_clamp[] = {INIT(0, 130), SET(MODE, 7), SET(WOB, 2), PROC(4, 64, NOISE, RAMP), SNAP,
                                     INIT(0, 4321), SET(MODE, 4), SET(WOB, 2), PROC(2, 64, NOISE, RAMP), END};
#define POKES                                                                                                   \
  POKE(0, 3, NAN_), POKE(1, 3, 0.5), POKE(0, 20, INF_), POKE(1, 40, NINF_), POKE(0, 60, 1e30), POKE(1, 61, -1e30), \
      POKE(0, 80, 1e-20), POKE(1, 100, 3)
static const double h_poke[] = {POKES, PROC(2, 128, NOISE, RAMP), SET(MODE, 2), POKES, PROC(2, 128, NOISE, RAMP),
                                SET(MODE, 6), POKES, PROC(2, 128, NOISE, RAMP), SET(MODE, 3), POKES,
                                PROC(2, 128, NOISE, RAMP), SET(MODE, 4), POKES, PROC(2, 128, NOISE, RAMP), SNAP, RESET,
                                PROC(2, 128, NOISE, RAMP), SNAP, END};
/* The rectifier's Math.sign at +-0 and the clip's edges, from silence. */
static const double h_signed_zero[] = {SET(MODE, 6), SET(CNOISE, 0), PROC(2, 128, ZERO, ZERO), POKE(0, 0, -0.0),
                                       POKE(1, 1, -0.0), PROC(2, 128, ZERO, ZERO), SET(MODE, 2),
                                       PROC(2, 128, ZERO, ZERO), SET(MODE, 0), PROC(2, 128, ZERO, IMP), SNAP, END};
/* One buffer as l and r (a mono caller): both channels read the input frame
   before either is written. */
static const double h_alias[] = {SET(MODE, 4), MONO(3, 128, NOISE), SET(MODE, 3), POKE(0, 3, NAN_),
                                 MONO(3, 128, NOISE), SET(MODE, 6), MONO(2, 128, STEP), SNAP, END};
static const double h_unknown[] = {SET(-1, 5), SET(6, 5), SET(99, 5), PROC(2, 128, NOISE, RAMP), SNAP, END};

/* ---- deliberate divergence (character.h), replayed against the C contract ---- */

static const double x_mode_nan[] = {SET(MODE, 3), PROC(2, 128, NOISE, RAMP), SET(MODE, NAN_), PROC(2, 128, NOISE, RAMP),
                                    SET(MODE, 5), PROC(1, 128, NOISE, RAMP), SET(MODE, NAN_), SET(AMT, 0.5),
                                    PROC(1, 128, NOISE, RAMP), SNAP, END};

/* ---- glitch ---- */

static const double g_default[] = {GLITCH(48000), PROC(60, 128, NOISE, RAMP), SNAP, END};
static const double g_basic[] = {GLITCH(8000), SET(PROB, 1), SET(REP, 3), PROC(80, 64, NOISE, RAMP), SNAP, END};
#define GP(v) SET(PROB, v), PROC(20, 64, NOISE, RAMP)
static const double g_prob[] = {GLITCH(8000), SET(DIV, 16), GP(0), GP(0.5), GP(1), GP(NAN_), GP(-1), GP(2), GP(0.2),
                                SNAP, END};
#define GR(v) SET(REV, v), PROC(25, 64, NOISE, RAMP)
static const double g_reverse[] = {GLITCH(8000), SET(PROB, 1), SET(DIV, 8), GR(1), GR(0.5), GR(0.75), GR(NAN_), GR(0),
                                   GR(2), SNAP, END};
#define GPT(v) SET(PITCH, v), PROC(25, 64, NOISE, RAMP)
static const double g_pitch[] = {GLITCH(8000), SET(PROB, 1), SET(DIV, 8), GPT(12), GPT(-12), GPT(24), GPT(30),
                                 GPT(-30), GPT(7), SET(REV, 1), GPT(5), GPT(-24), GPT(NAN_), GPT(0), GPT(INF_), SNAP,
                                 END};
#define GRP(v) SET(REP, v), PROC(25, 64, NOISE, RAMP)
static const double g_repeats[] = {GLITCH(8000), SET(PROB, 1), SET(DIV, 16), GRP(1), GRP(16), GRP(0.5), GRP(2.5),
                                   GRP(20), GRP(-3), GRP(4), GRP(NAN_), SNAP, GRP(2), SNAP, END};
#define GD(v) SET(DIV, v), PROC(25, 64, NOISE, RAMP)
static const double g_division[] = {GLITCH(8000), SET(PROB, 1), GD(1), GD(16), GD(0.4), GD(16.5), GD(2.5), GD(-0.0),
                                    GD(7), GD(NAN_), GD(3), SNAP, END};
#define GB(v) SET(BPM, v), PROC(25, 64, NOISE, RAMP)
static const double g_bpm[] = {GLITCH(8000), SET(PROB, 0.6), SET(DIV, 4), GB(20), GB(300), GB(10), GB(400), GB(97.3),
                               GB(NAN_), GB(140), GB(INF_), GB(NINF_), SNAP, END};
#define GF(v) SET(FRZ, v), PROC(25, 64, NOISE, RAMP)
static const double g_freeze[] = {GLITCH(8000), SET(PROB, 0), SET(DIV, 8), GF(1), GF(0), GF(0.5),
                                  GF(0.49999999999999994), GF(NAN_), GF(INF_), SET(PROB, 1), GF(0), GF(1), SNAP, END};
/* A 3 s slice (bpm 20, division 1) against the 2 s buffer: a negative slice
   start; then the slice shrinks mid-slice under a reversed, pitched read and
   the index goes negative, reading undefined (NaN) in the JS. */
static const double g_neg_index[] = {GLITCH(4800), SET(PITCH, 24), SET(REV, 1), SET(BPM, 300), SET(DIV, 16),
                                     SET(PROB, 0), PROC(80, 64, STEP, STEP), SET(BPM, 20), SET(DIV, 1), SET(FRZ, 1),
                                     PROC(260, 64, STEP, NOISE), SET(BPM, 80), PROC(4, 64, STEP, NOISE), SNAP,
                                     PROC(40, 64, NOISE, NOISE), SNAP, END};
static const double g_long_slice[] = {GLITCH(4800), SET(PROB, 1), SET(BPM, 20), SET(DIV, 1), PROC(300, 64, NOISE, RAMP),
                                      SET(REV, 1), PROC(300, 64, NOISE, RAMP), SET(PITCH, -24),
                                      PROC(100, 64, NOISE, RAMP), SNAP, END};
/* At 100 Hz the crossfade rounds to 0 samples: 0 / 0 is NaN, n / 0 inf. */
static const double g_xfade0[] = {GLITCH(100), SET(PROB, 1), PROC(10, 64, NOISE, RAMP), SET(REV, 1),
                                  PROC(4, 64, NOISE, RAMP), SNAP, END};
/* The meter reads the active flag at the end of a block. */
static const double g_meter[] = {GLITCH(8000), SET(PROB, 1), SET(DIV, 16), SET(REP, 1), PROC(40, 16, NOISE, RAMP),
                                 SET(PROB, 0), PROC(10, 16, NOISE, RAMP), SNAP, END};
/* reset(): buffers, write head, active flag and counter only. */
static const double g_reset[] = {GLITCH(8000), SET(PROB, 1), SET(DIV, 8), PROC(30, 64, NOISE, RAMP), SNAP, RESET, SNAP,
                                 PROC(30, 64, NOISE, RAMP), SET(FRZ, 1), PROC(20, 64, NOISE, RAMP), RESET,
                                 PROC(10, 64, NOISE, RAMP), SNAP, END};
/* reset() clears the whole buffer and the active flag: fill all 2 s, reset
   while a slice plays, then stretch one slice across the entire buffer so
   every sample is read back. */
static const double g_reset_full[] = {GLITCH(4800), SET(PROB, 1), SET(DIV, 16), SET(BPM, 300),
                                      PROC(160, 64, NOISE, RAMP), PROC(1, 37, NOISE, RAMP), SNAP, RESET, SNAP,
                                      PROC(2, 64, NOISE, RAMP), SET(FRZ, 1), SET(BPM, 20), SET(DIV, 1),
                                      PROC(160, 64, ZERO, ZERO), SNAP, END};
/* A fractional rate: buffer is ceil(2 sr) = 9001, crossfade Math.round(13.5009)
   = 14; the meter is read before the first block. */
static const double g_frac_rate[] = {GLITCH(4500.3), SNAP, SET(PROB, 1), SET(DIV, 16), SET(REP, 2.4),
                                     PROC(160, 64, NOISE, RAMP), SNAP, SET(FRZ, 1), SET(BPM, 20), SET(DIV, 1),
                                     PROC(160, 64, ZERO, ZERO), SNAP, END};
/* probability == the first draw (270369 / 2^32): `<` does not trigger. */
static const double g_trig_edge[] = {GLITCH(8000), SET(PROB, 0x1.08084p-14), SET(DIV, 16), PROC(20, 64, NOISE, RAMP),
                                     SNAP, END};
static const double g_blocks[] = {GLITCH(8000), SET(PROB, 1), SET(DIV, 16), PROC(3, 0, NOISE, RAMP),
                                  PROC(300, 1, NOISE, RAMP), PROC(9, 37, NOISE, RAMP), PROC(1, 4096, NOISE, RAMP),
                                  PROC(1, -3, NOISE, RAMP), REWIND, SET(BPM, 60), PROC(2, 0, NOISE, RAMP),
                                  PROC(3, 128, NOISE, RAMP), SNAP, END};
static const double g_rates[] = {GLITCH(44100), SET(PROB, 1), SET(DIV, 16), PROC(40, 128, NOISE, RAMP), SNAP,
                                 GLITCH(22050), SET(PROB, 0.5), SET(DIV, 16), PROC(40, 128, NOISE, RAMP), SNAP,
                                 GLITCH(11025), SET(PROB, 1), SET(DIV, 9), SET(REV, 1), PROC(40, 128, NOISE, RAMP),
                                 END};
static const double g_poke[] = {GLITCH(8000), SET(PROB, 1), SET(DIV, 16), POKES, PROC(1, 128, NOISE, RAMP),
                                PROC(10, 128, NOISE, RAMP), POKES, PROC(1, 128, NOISE, RAMP), SET(PITCH, 3),
                                PROC(10, 128, NOISE, RAMP), SNAP, END};
static const double g_alias[] = {GLITCH(8000), SET(PROB, 1), SET(DIV, 16), MONO(20, 64, NOISE), SET(REV, 1),
                                 MONO(10, 64, RAMP), SNAP, END};
static const double g_internal[] = {GLITCH(8000), SEED(0), SET(DIV, 16), PROC(40, 64, NOISE, RAMP), SEED(99),
                                    PROC(20, 64, NOISE, RAMP), SEED(0), PROC(20, 64, NOISE, RAMP), SNAP, END};
static const double g_unknown[] = {GLITCH(8000), SET(-1, 5), SET(7, 5), SET(99, 5), PROC(20, 64, NOISE, RAMP), SNAP,
                                   END};

/* ---- noise bed ---- */

static const double n_default[] = {NGEN, PROC(4, 128, NOISE, RAMP), SNAP, END};
#define NT(v) SET(TYPE, v), PROC(3, 128, NOISE, RAMP)
static const double n_types[] = {NGEN, SET(LVL, -12), NT(0), NT(1), NT(2), NT(-0.3), NT(0.5), NT(1.5), NT(2.5),
                                 NT(0.49999999999999994), NT(NAN_), NT(-0.0), NT(INF_), NT(NINF_), NT(1), SNAP, END};
/* A brown walk long enough to hit both rails. */
static const double n_brown[] = {NGEN, SET(LVL, -6), SET(TYPE, 2), PROC(200, 128, ZERO, ZERO), SEED(31337),
                                 PROC(200, 128, ZERO, ZERO), SNAP, END};
#define NL(v) SET(LVL, v), PROC(3, 128, NOISE, RAMP)
static const double n_level[] = {NGEN, NL(-12), NL(-60), NL(-59.99999999999999), NL(0), NL(-60.00000000000001),
                                 NL(-120), NL(12), NL(NAN_), NL(-20), NL(INF_), NL(NINF_), NL(-6), SNAP, END};
#define NF(v) SET(FOL, v), PROC(3, 128, NOISE, RAMP)
static const double n_follow[] = {NGEN, SET(LVL, -6), NF(1), NF(0.001), NF(0.0011), NF(0.5), NF(2), NF(-1), NF(1),
                                  PROC(10, 128, ZERO, ZERO), PROC(3, 128, STEP, STEP), NF(NAN_), NF(0.25), SNAP, END};
#define NTN(v) SET(TONE, v), PROC(3, 128, NOISE, RAMP)
static const double n_tone[] = {NGEN, SET(LVL, -6), NTN(200), NTN(20000), NTN(30000), NTN(5), NTN(-100),
                                NTN(NAN_), NTN(3000), SET(TYPE, 0), NTN(800), SNAP, END};
static const double n_reset[] = {NGEN, SET(LVL, -6), SET(FOL, 0.5), SET(TYPE, 2), PROC(6, 128, NOISE, RAMP), SNAP,
                                 RESET, SNAP, PROC(2, 128, NOISE, RAMP), SNAP, END};
static const double n_blocks[] = {NGEN, SET(LVL, -6), SET(FOL, 0.5), PROC(3, 0, NOISE, RAMP),
                                  PROC(30, 1, NOISE, RAMP), PROC(7, 7, NOISE, RAMP), PROC(1, 4096, NOISE, RAMP),
                                  PROC(1, -3, NOISE, RAMP), REWIND, PROC(1, 128, NOISE, RAMP), SNAP, END};
static const double n_rates[] = {INIT(2, 44100), SET(LVL, -6), PROC(4, 128, NOISE, RAMP), SNAP, INIT(2, 96000),
                                 SET(LVL, -6), SET(FOL, 1), PROC(4, 128, NOISE, RAMP), SNAP, INIT(2, 8000),
                                 SET(LVL, -6), SET(TYPE, 2), PROC(4, 128, NOISE, RAMP), END};
static const double n_poke[] = {NGEN, SET(LVL, -6), SET(FOL, 0.7), POKES, PROC(2, 128, NOISE, RAMP), SET(FOL, 0),
                                POKES, PROC(2, 128, NOISE, RAMP), SNAP, END};
/* l is written before r is read: aliased, the right channel adds the noise a
   second time, as the JS does. */
static const double n_alias[] = {NGEN, SET(LVL, -6), MONO(3, 128, NOISE), SET(FOL, 0.6), SET(TYPE, 0),
                                 MONO(3, 128, STEP), SNAP, END};
static const double n_internal[] = {NGEN, SEED(0), SET(LVL, -6), PROC(4, 128, NOISE, RAMP), SET(TYPE, 0),
                                    PROC(2, 128, NOISE, RAMP), SET(TYPE, 2), PROC(2, 128, NOISE, RAMP), SEED(5),
                                    PROC(2, 128, NOISE, RAMP), SNAP, END};
static const double n_unknown[] = {NGEN, SET(-1, 5), SET(4, 5), SET(99, 5), SET(LVL, -6), PROC(2, 128, NOISE, RAMP),
                                   SNAP, END};

#define S(n) {#n, n, sizeof(n) / sizeof(n[0])}

typedef struct {
  const char *name;
  const double *ops;
  size_t n;
} script;

static const script scripts[] = {
    S(h_default),   S(h_modes),     S(h_modes_hot), S(h_mode_round), S(h_amount),     S(h_drive),
    S(h_noise_trim), S(h_wobble),   S(h_wob_edge),  S(h_output),     S(h_squelch),    S(h_squelch_edge),
    S(h_crackle),   S(h_internal),  S(h_crackle_reset), S(h_crackle_edge), S(h_init_internal), S(h_reset),     S(h_blocks),     S(h_rates),      S(h_poke),
    S(h_wob_clamp), S(h_signed_zero), S(h_alias),   S(h_unknown),   S(x_mode_nan),   S(g_default),    S(g_basic),
    S(g_prob),      S(g_reverse),   S(g_pitch),     S(g_repeats),    S(g_division),   S(g_bpm),
    S(g_freeze),    S(g_neg_index), S(g_long_slice), S(g_xfade0),    S(g_meter),      S(g_reset), S(g_reset_full), S(g_frac_rate), S(g_trig_edge),
    S(g_blocks),    S(g_rates),     S(g_poke),      S(g_alias),      S(g_internal),   S(g_unknown),
    S(n_default),   S(n_types),     S(n_brown),     S(n_level),      S(n_follow),     S(n_tone),
    S(n_reset),     S(n_blocks),    S(n_rates),     S(n_poke),       S(n_alias),      S(n_internal),
    S(n_unknown),
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
