/* Bro.Kodr Vocoder parity producer; replayed by verify-vocoder-parity.mjs. */
#include "brokodr/dsp/vocoder.h"

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
  OP_REWIND = 7,  /* stimulus cursor back to 0 */
  OP_GAIN = 8,    /* a = stimulus gain */
  OP_DC = 9,      /* a = the SIG_DC level */
  OP_MONO = 10,   /* as OP_PROCESS on one buffer, l and r aliased: a = blocks, b = size, c = signal */
  OP_BUS = 11,    /* attach the carrier bus: a = left signal, b = right signal, c = bus gain */
  OP_SEED = 12    /* a > 0: battery xorshift seeded with a; a == 0: the effect's own generator */
};
#define OPW 5

#define SIG_N 65536
#define N_SIGS 5
#define SIG_DC 5
#define SIG_VOICE 6
#define BUS_OFFSET 7777
#define MAX_BLOCK 4096
#define MAX_POKES 32
#define MAX_P64 6000000
#define MAX_P32 8000000

#define NAN_ (-3e9)
#define INF_ (3e9)
#define NINF_ (-4e9)

static float g_sig[N_SIGS + 2][SIG_N];
static double g_tmp[SIG_N];
static float g_l[MAX_BLOCK];
static float g_r[MAX_BLOCK];
static float g_cl[MAX_BLOCK];
static float g_cr[MAX_BLOCK];
static double g_p64[MAX_P64];
static float g_p32[MAX_P32];
static unsigned int n64, n32;

#define CANARY 64
static struct { bk_vocoder e; float canary[CANARY]; } g_box;
static bk_vocoder *const g_fx = &g_box.e;
static const bk_effect_vt *const g_vt = &bk_vocoder_vt;
static void check_canary(void) {
  int k;
  for (k = 0; k < CANARY; k++) {
    if (g_box.canary[k] != 1234.5f) {
      fprintf(stderr, "write past the effect struct at %d\n", k);
      exit(5);
    }
  }
}

/* Mirrored in the verifier as Math.random. The state travels through the
   user pointer (always &g_seed), so an effect that dropped random_user would
   be seen. */
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
/* Counts draws made through the effect's internal generator, delegating to
   the function set_random(NULL) installed so that it is what runs. */
static bk_random_fn g_internal_fn;
static double counted_internal(void *user) {
  g_draws += 1.0;
  return g_internal_fn(user);
}

static int g_cursor;
static double g_gain;
static double g_dc;
static int g_bus;
static int g_bus_l, g_bus_r;
static double g_bus_gain;
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
  push64(s->value); push64(s->target); push64(s->a);
}
static void biquad_state(const bk_biquad *f) {
  push64(f->b0); push64(f->b1); push64(f->b2); push64(f->a1); push64(f->a2);
  push64(f->z1); push64(f->z2);
  push64((double)f->type); push64(f->freq); push64(f->q); push64(f->gain_db);
}
static void env_state(const bk_env_follower *e) {
  push64(e->env); push64(e->ca); push64(e->cr); push64((double)e->rms);
}
static void osc_state(const bk_oscillator *o) {
  push64(o->phase); push64(o->inc); push64(o->pw);
}

/* Per-block scalars, then every band's moving state: 71 + 32 * 10 = 391 doubles. */
static void block_state(void) {
  const bk_vocoder *e = g_fx;
  const bk_pitch_tracker *t = &e->tracker;
  int k;
  push64(g_vt->meter(e));
  push64(e->sr); push64((double)e->max_block); push64(e->band_count); push64(e->freq_lo);
  push64(e->freq_hi); push64(e->q_factor); push64(e->carrier_type); push64(e->carrier_pitch_hz);
  push64((double)e->pitch_follow); push64(e->depth); push64(e->tone); push64(e->sibilance);
  push64(e->attack_ms); push64(e->release_ms); push64(e->carrier_level); push64(e->stereo_spread);
  push64((double)e->source); push64(e->car_rms); push64(e->car_rms_a); push64(e->tracked_hz);
  push64((double)e->dirty); push64(e->car_l != NULL ? 1.0 : 0.0); push64(g_draws);
  osc_state(&e->osc1); osc_state(&e->osc2); osc_state(&e->osc_sub);
  push64((double)t->decim); push64(t->dsr); push64((double)t->min_lag); push64((double)t->max_lag);
  push64((double)t->size); push64((double)t->w); push64((double)t->decim_count);
  push64(t->acc); push64(t->freq); push64(t->confidence);
  smoother_state(&e->pitch_sm); smoother_state(&e->depth_sm); smoother_state(&e->out_sm);
  biquad_state(&e->sib_hp);
  env_state(&e->sib_env); env_state(&e->in_env);
  for (k = 0; k < BK_VOCODER_MAX_BANDS; k++) {
    const bk_vocoder_band *b = &e->bands[k];
    push64(b->mod_a.z1); push64(b->mod_a.z2); push64(b->mod_b.z1); push64(b->mod_b.z2);
    push64(b->car_a.z1); push64(b->car_a.z2); push64(b->car_b.z1); push64(b->car_b.z2);
    push64(b->env.env); push64(b->level);
  }
}
/* Full snapshot: the scalars, every band's settings, the tracker buffer and
   the UI ladder. */
static void snap_state(void) {
  const bk_vocoder *e = g_fx;
  static float vis[BK_VOCODER_MAX_BANDS];
  int k, n;
  block_state();
  for (k = 0; k < BK_VOCODER_MAX_BANDS; k++) {
    const bk_vocoder_band *b = &e->bands[k];
    biquad_state(&b->mod_a); biquad_state(&b->mod_b);
    biquad_state(&b->car_a); biquad_state(&b->car_b);
    env_state(&b->env);
    push64(b->freq); push64(b->gain); push64(b->pan);
  }
  for (k = 0; k < e->tracker.size; k++) push32(e->tracker.buf[k]);
  n = bk_vocoder_visual(e, vis);
  push64((double)n);
  for (k = 0; k < n; k++) push32(vis[k]);
}

static double unsentinel(double v) {
  if (v == NAN_) return (double)NAN;
  if (v == INF_) return (double)INFINITY;
  if (v == NINF_) return -(double)INFINITY;
  return v;
}

static void vt_flags(void) {
  /* What the chain will see: a carrier bus hook, no latency, a meter. */
  push64(g_vt->set_carrier_bus == NULL ? 1.0 : 0.0);
  push64(g_vt->latency_samples == NULL ? 1.0 : 0.0);
  push64(g_vt->meter == NULL ? 1.0 : 0.0);
}

static void init_fx(double sr, int max_block) {
  int k;
  for (k = 0; k < CANARY; k++) g_box.canary[k] = 1234.5f;
  bk_vocoder_init(g_fx, sr, max_block);
  g_seed = 0x2545f491u;
  bk_vocoder_set_random(g_fx, test_random, &g_seed);
  g_bus = 0;
  check_canary();
  vt_flags();
}

static double sig_at(int s, int at) { return s == SIG_DC ? g_dc : (double)g_sig[s][at]; }

static void fill_bus(int bs) {
  int j;
  for (j = 0; j < bs; j++) {
    const int at = (g_cursor + j + BUS_OFFSET) % SIG_N;
    g_cl[j] = (float)(g_bus_gain * sig_at(g_bus_l, at));
    g_cr[j] = (float)(g_bus_gain * sig_at(g_bus_r, at));
  }
}

static void run_script(FILE *f, const char *name, const double *ops, size_t n_ops) {
  size_t i;
  int k, j;

  n64 = 0;
  n32 = 0;
  g_cursor = 0;
  g_gain = 1.0;
  g_dc = 0.0;
  n_pokes = 0;
  g_draws = 0.0;
  init_fx(48000.0, 128);

  for (i = 0; i + OPW <= n_ops; i += OPW) {
    const int op = (int)ops[i];
    const double a = unsentinel(ops[i + 1]), b = unsentinel(ops[i + 2]);
    const double c = unsentinel(ops[i + 3]), d = unsentinel(ops[i + 4]);
    switch (op) {
      case OP_END:
        i = n_ops;
        break;
      case OP_INIT:
        init_fx(a, (int)b);
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
          if (g_bus) fill_bus(bs);
          g_cursor = (g_cursor + (bs > 0 ? bs : 0)) % SIG_N;
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
          if (g_bus) fill_bus(bs);
          g_cursor = (g_cursor + (bs > 0 ? bs : 0)) % SIG_N;
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
      case OP_BUS:
        g_bus = 1;
        g_bus_l = (int)a;
        g_bus_r = (int)b;
        g_bus_gain = c;
        g_vt->set_carrier_bus(g_fx, g_cl, g_cr);
        break;
      case OP_SEED:
        if (a > 0.0) {
          g_seed = (unsigned int)a;
          bk_vocoder_set_random(g_fx, test_random, &g_seed);
        } else {
          bk_vocoder_set_random(g_fx, NULL, NULL);
          g_internal_fn = g_fx->random;
          g_fx->random = counted_internal;
        }
        break;
      default:
        (void)d;
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

/* Opcodes travel in record.params: the JS oracle replays the same scripts. */
#define NOISE BK_SIG_NOISE
#define RAMP BK_SIG_RAMP
#define STEP BK_SIG_STEP
#define IMP BK_SIG_IMPULSE
#define ZERO BK_SIG_ZERO
#define DC SIG_DC
#define VOICE SIG_VOICE
#define O(op,a,b,c,d) (double)(op),(double)(a),(double)(b),(double)(c),(double)(d)
#define INIT(sr,mb) O(OP_INIT,sr,mb,0,0)
#define SET(k,v) O(OP_PARAM,k,v,0,0)
#define PROC(n,bs,l,r) O(OP_PROCESS,n,bs,l,r)
#define SNAP O(OP_SNAP,0,0,0,0)
#define RESET O(OP_RESET,0,0,0,0)
#define POKE(ch,at,v) O(OP_POKE,ch,at,v,0)
#define GAIN(v) O(OP_GAIN,v,0,0,0)
#define MONO(n,bs,s) O(OP_MONO,n,bs,s,0)
#define LEVEL(v) O(OP_DC,v,0,0,0)
#define BUS(l,r,g) O(OP_BUS,l,r,g,0)
#define SEED(s) O(OP_SEED,s,0,0,0)
#define REWIND O(OP_REWIND,0,0,0,0)
#define END O(OP_END,0,0,0,0)
/* LONG passes 7680 samples (gated voice, then mixed); TAIL 3840 of silence. */
#define LONG PROC(40,128,VOICE,VOICE),PROC(10,128,NOISE,RAMP),PROC(10,128,STEP,IMP)
#define SHORT PROC(12,128,VOICE,VOICE)
#define TAIL PROC(30,128,ZERO,ZERO)
/* Keys: 0 bands 1 carrier 2 pitch 3 follow 4 freqlo 5 freqhi 6 q 7 depth
   8 tone 9 sibilance 10 attack 11 release 12 carrierlevel 13 spread
   14 output 15 source. Scripts run at 48 kHz, where the constructor's exp
   coefficients are not at a known glibc/V8 ulp split (16 kHz has one);
   t_rates covers other rates. */
#define TB INIT(48000,128)
static const double v_default[] = {TB,SNAP,LONG,TAIL,SNAP,END};
static const double v_fresh[] = {TB,SNAP,PROC(1,50,VOICE,VOICE),SNAP,PROC(1,50,VOICE,VOICE),SNAP,END};
static const double v_silence[] = {TB,PROC(40,128,ZERO,ZERO),SNAP,END};
static const double v_bands[] = {TB,SET(0,4),SHORT,SNAP,SET(0,32),SHORT,SNAP,SET(0,3),SHORT,SET(0,33),SHORT,SET(0,7.5),SHORT,SET(0,-0.4),SHORT,SET(0,INF_),SHORT,SET(0,NINF_),SHORT,SET(0,9.49),SHORT,SNAP,END};
static const double v_bands_nan[] = {TB,SET(0,NAN_),SHORT,SNAP,SET(0,12),SHORT,SNAP,END};
static const double v_carrier[] = {TB,SET(1,1),SHORT,SET(1,2),SHORT,SET(1,3),SHORT,SET(1,4),SHORT,SET(1,0),SHORT,SET(1,-0.4),SHORT,SET(1,0.5),SHORT,SET(1,2.5),SHORT,SET(1,9),SHORT,SET(1,-3),SHORT,SET(1,INF_),SHORT,SET(1,NAN_),SHORT,SET(1,1.49),SHORT,SNAP,END};
static const double v_pitch[] = {TB,SET(1,1),SET(2,20),SHORT,SET(2,2000),SHORT,SET(2,10),SNAP,SHORT,SET(2,5000),SHORT,SET(2,NAN_),SHORT,SET(2,330),SHORT,SET(3,1),SET(2,700),SNAP,SHORT,SNAP,END};
static const double v_follow[] = {TB,SET(3,1),LONG,SET(3,0.49999999999999994),SHORT,SET(3,0.5),SHORT,SET(3,NAN_),SHORT,SET(3,1),PROC(30,128,RAMP,RAMP),PROC(10,128,ZERO,ZERO),SNAP,END};
static const double v_range[] = {TB,SET(4,130),SET(5,30000),SHORT,SET(5,100),SHORT,SET(4,500),SET(5,600),SHORT,SET(4,NAN_),SHORT,SNAP,SET(4,150),SET(5,NAN_),SHORT,SNAP,SET(5,INF_),SHORT,SET(4,700),SET(5,7000),SHORT,SNAP,END};
/* Settings whose band coefficients meet a glibc/V8 one-ulp sin or cos split. */
static const double v_range_ulp[] = {TB,SET(4,40),SHORT,SET(4,20),SHORT,SET(4,3000),SET(5,4000),SHORT,SET(4,NINF_),SET(5,7000),SHORT,SNAP,END};
static const double v_q[] = {TB,SET(6,0.5),SHORT,SET(6,0.2),SHORT,SET(6,20),SHORT,SET(6,NAN_),SHORT,SNAP,SET(6,INF_),SHORT,SET(6,6),SHORT,SNAP,END};
static const double v_depth[] = {TB,SET(7,0),SHORT,SET(7,1),SHORT,SET(7,-1),SHORT,SET(7,2),SHORT,SET(7,0.4),SHORT,SET(7,NAN_),SHORT,SNAP,END};
static const double v_tone[] = {TB,SET(8,-1),SHORT,SNAP,SET(8,1),SHORT,SET(8,-2),SHORT,SET(8,2),SHORT,SET(8,0.3),SHORT,SET(8,NAN_),SHORT,SNAP,END};
static const double v_sibilance[] = {TB,SET(9,1),LONG,SET(9,0),SHORT,SET(9,2),SHORT,SET(9,-1),SHORT,SET(9,NAN_),SHORT,SET(9,0.5),SET(5,2500),SHORT,SNAP,END};
static const double v_env[] = {TB,SET(10,0.2),SHORT,SET(10,0.1),SHORT,SET(10,50),SHORT,SET(11,2),SHORT,SET(11,1),SHORT,SET(11,400),SHORT,SNAP,SET(10,NAN_),SHORT,SET(11,NAN_),SHORT,SNAP,SET(10,3),SET(11,25),SHORT,SNAP,END};
static const double v_level[] = {TB,SET(12,0),LONG,SET(12,1),SHORT,SET(12,-20),SHORT,SET(12,NAN_),SHORT,SET(12,INF_),SHORT,SET(12,-60),SHORT,SNAP,END};
static const double v_squelch[] = {TB,SET(12,0),GAIN(0.0008),LONG,GAIN(0.004),LONG,GAIN(0.2),LONG,SNAP,END};
static const double v_spread[] = {TB,SET(13,1),SHORT,SNAP,SET(13,0.001),SHORT,SET(13,0.0010000000000000002),SHORT,SET(13,2),SHORT,SET(13,-1),SHORT,SET(13,NAN_),SHORT,SNAP,SET(13,0.5),SHORT,SNAP,END};
static const double v_output[] = {TB,SET(14,-6),SHORT,SET(14,12),SHORT,SET(14,-200),SHORT,SET(14,NINF_),SHORT,SET(14,0),SHORT,SNAP,END};
static const double v_output_inf[] = {TB,SET(14,INF_),SHORT,SET(14,0),SHORT,SNAP,END};
static const double v_output_nan[] = {TB,SET(14,NAN_),SHORT,SNAP,END};
static const double v_source[] = {TB,SET(15,1),SHORT,BUS(NOISE,RAMP,1),SHORT,SET(15,0.49999999999999994),SHORT,SET(15,0.5),SHORT,BUS(ZERO,ZERO,1),SHORT,SNAP,SET(15,NAN_),SHORT,SET(15,1),BUS(IMP,STEP,1e-6),SHORT,BUS(NOISE,NOISE,5e-5),SHORT,BUS(NOISE,ZERO,1),SHORT,BUS(RAMP,NOISE,1),RESET,SHORT,SNAP,BUS(VOICE,VOICE,0.5),SET(1,3),SHORT,SNAP,END};
/* A quiet bus from a fresh state: the carrier RMS stays under 1e-5, so the
   normalised carrier is 0; the last leg decays a loud bus back through it. */
static const double v_source_quiet[] = {TB,SET(15,1),BUS(ZERO,ZERO,1),SHORT,SNAP,BUS(IMP,STEP,1e-6),SHORT,SNAP,BUS(NOISE,NOISE,1),SHORT,BUS(ZERO,ZERO,1),PROC(200,128,VOICE,VOICE),SNAP,END};
/* Boundary stimuli, one comparison each. v_bus_edge: at this sample rate the
   first sample of a DC bus at the float 1.2024000170640647e-5 makes
   sqrt(carRms) exactly 1e-5, so the carrier is 0, not c/rms (glibc and V8
   agree on every init exp, sin and cos here; 8.434380694065656 also hits but
   splits the 20 ms smoother exp). v_bus_mid: a quiet bus
   from rest whose RMS settles between 1e-5 and 1e-4. v_squelch_edge: at 1 Hz
   the input envelope after these two frames is exactly 0.0005, which is not
   squelched. v_noise_edge: nyq * 0.45 is exactly 3000 there and 15 of the 16
   bands sit on it, which take no noise. v_reset_wide: reset clears all 32
   bands. v_bus_negzero: a -0 bus carrier (negative gain on silence) while the
   carrier RMS is still high. */
static const double v_bus_edge[] = {INIT(8.499059887809432,16),SET(15,1),LEVEL(1.2024000170640647e-5),BUS(DC,DC,1),PROC(2,16,VOICE,VOICE),SNAP,END};
static const double v_bus_mid[] = {TB,SET(15,1),BUS(NOISE,NOISE,1e-4),PROC(60,128,VOICE,VOICE),SNAP,END};
static const double v_squelch_edge[] = {INIT(1,2),SET(12,0),POKE(0,0,0.3108086884021759),POKE(1,0,9.728271521680654e-9),POKE(0,1,0.000800000037997961),POKE(1,1,0),PROC(1,2,ZERO,ZERO),SNAP,END};
static const double v_noise_edge[] = {INIT(6666.666666666666,128),SET(4,5000),SET(9,1),SHORT,SNAP,END};
static const double v_reset_wide[] = {TB,SET(0,32),LONG,RESET,SNAP,END};
static const double v_bus_negzero[] = {TB,SET(15,1),BUS(NOISE,NOISE,1),SHORT,BUS(ZERO,ZERO,-1),PROC(200,128,ZERO,ZERO),SNAP,END};
/* wet = outL * invN * 8 * depth, left to right. With 5 bands invN * 8 is not
   a power of two and depth is not one, so regrouping the product changes the
   double in about a third of the frames, but the float store hides that unless
   the two doubles straddle a float rounding boundary. A search over noise
   gains found frame 981 of this block, left channel, where they do (one hit in
   400000 gains of 4096 frames). */
static const double v_wet_order[] = {INIT(48000,1024),SET(0,5),SET(7,0.8),SET(13,0.6),GAIN(0.96926975250244141),PROC(1,1024,NOISE,NOISE),SNAP,END};
static const double v_source_off[] = {TB,BUS(NOISE,NOISE,0.5),SHORT,SET(1,3),SHORT,SNAP,END};
static const double v_reset[] = {TB,SET(3,1),LONG,SNAP,RESET,SNAP,LONG,RESET,SNAP,END};
static const double v_alias[] = {TB,SET(13,0.7),MONO(40,128,VOICE),MONO(4,128,ZERO),SNAP,END};
static const double v_blocks[] = {TB,PROC(2,0,VOICE,VOICE),PROC(1,-3,ZERO,ZERO),PROC(300,1,VOICE,RAMP),PROC(50,7,STEP,NOISE),PROC(10,128,VOICE,VOICE),SNAP,INIT(48000,4096),SET(3,1),PROC(3,4096,VOICE,NOISE),SNAP,END};
static const double v_rates[] = {INIT(44100,128),LONG,SNAP,INIT(8000,64),PROC(40,64,VOICE,RAMP),SNAP,END};
static const double v_rates_ulp[] = {INIT(96000,256),PROC(40,256,VOICE,VOICE),SNAP,INIT(4500.3,1),SET(5,8000),PROC(500,1,VOICE,VOICE),SNAP,END};
static const double v_unknown[] = {TB,SET(-1,5),SET(16,5),SET(99,5),SHORT,SNAP,END};
static const double v_poke[] = {TB,PROC(9,128,VOICE,VOICE),POKE(0,3,NAN_),POKE(1,20,INF_),PROC(1,128,VOICE,VOICE),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),PROC(12,128,VOICE,VOICE),SNAP,RESET,LONG,SNAP,END};
static const double v_gain[] = {TB,GAIN(1e-20),LONG,GAIN(1000),LONG,SNAP,END};
static const double v_huge[] = {TB,GAIN(1e35),PROC(20,128,VOICE,VOICE),SNAP,END};
static const double v_dc[] = {TB,LEVEL(0.5),PROC(60,128,DC,DC),SNAP,END};
static const double v_seed[] = {TB,SET(1,3),SEED(0),SHORT,SNAP,SEED(7),SHORT,SEED(0),SHORT,SNAP,END};
static const double v_combo[] = {TB,SET(0,24),SET(1,4),SET(3,1),SET(4,90),SET(5,9000),SET(6,8),SET(7,0.8),SET(8,-0.4),SET(9,0.6),SET(10,1.5),SET(11,60),SET(12,-12),SET(13,0.6),SET(14,3),LONG,TAIL,SNAP,END};
static const double mixed_inits[] = {INIT(48000,128),SHORT,INIT(8000,32),PROC(20,32,VOICE,VOICE),SNAP,END};
#define S(n) {#n,n,sizeof(n)/sizeof(n[0])}
typedef struct { const char *name; const double *ops; size_t n; } script;
static const script scripts[] = {S(v_default),S(v_fresh),S(v_silence),S(v_bands),S(v_bands_nan),S(v_carrier),S(v_pitch),S(v_follow),S(v_range),S(v_range_ulp),S(v_q),S(v_depth),S(v_tone),S(v_sibilance),S(v_env),S(v_level),S(v_squelch),S(v_spread),S(v_output),S(v_output_inf),S(v_output_nan),S(v_source),S(v_source_quiet),S(v_bus_edge),S(v_bus_mid),S(v_squelch_edge),S(v_noise_edge),S(v_reset_wide),S(v_bus_negzero),S(v_wet_order),S(v_source_off),S(v_reset),S(v_alias),S(v_blocks),S(v_rates),S(v_rates_ulp),S(v_unknown),S(v_poke),S(v_gain),S(v_huge),S(v_dc),S(v_seed),S(v_combo),S(mixed_inits)};

/* Gated two-period voice-like buzz. Integer phases and correctly rounded
   arithmetic only, one operation per statement, so it is bit-exact in JS. */
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
