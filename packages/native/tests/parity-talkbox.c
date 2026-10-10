/* Bro.Kodr TalkBox parity producer; replayed by verify-talkbox-parity.mjs. */
#include "brokodr/dsp/talkbox.h"

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
  OP_BUS = 11     /* attach the carrier bus: a = left signal, b = right signal, c = bus gain */
};
#define OPW 5

#define SIG_N 65536
#define N_SIGS 5
#define SIG_DC 5
#define SIG_VOICE 6
#define SIG_ALT 7
#define BUS_OFFSET 7777
#define MAX_BLOCK 4096
#define MAX_POKES 32
#define MAX_P64 4000000
#define MAX_P32 8000000
#define MAX_STORE 100000

#define NAN_ (-3e9)
#define INF_ (3e9)
#define NINF_ (-4e9)

static float g_sig[N_SIGS + 3][SIG_N];
static double g_tmp[SIG_N];
static float g_l[MAX_BLOCK];
static float g_r[MAX_BLOCK];
static float g_cl[MAX_BLOCK];
static float g_cr[MAX_BLOCK];
static double g_p64[MAX_P64];
static float g_p32[MAX_P32];
static unsigned int n64, n32;

#define CANARY 64
static struct { bk_talkbox e; float canary[CANARY]; } g_box;
static float g_store[MAX_STORE + CANARY];
static size_t g_used;
static bk_talkbox *const g_fx = &g_box.e;
static const bk_effect_vt *const g_vt = &bk_talkbox_vt;
static void check_canary(void) {
  int k;
  for (k = 0; k < CANARY; k++) {
    if (g_box.canary[k] != 1234.5f || g_store[g_used + (size_t)k] != 1234.5f) {
      fprintf(stderr, "write past the effect struct or storage at %d\n", k);
      exit(5);
    }
  }
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
static void lp2_state(const bk_lp2 *f) {
  push64(f->b0); push64(f->b1); push64(f->b2); push64(f->a1); push64(f->a2);
  push64(f->z1); push64(f->z2);
}
static void osc_state(const bk_oscillator *o) {
  push64(o->phase); push64(o->inc); push64(o->pw);
}
static double int32_of(unsigned int u) {
  return u >= 0x80000000u ? (double)u - 4294967296.0 : (double)u;
}

/* Per-block scalars and coefficient arrays: 270 doubles. */
static void block_state(void) {
  const bk_talkbox *e = g_fx;
  const bk_pitch_tracker *t = &e->tracker;
  int k;
  push64(g_vt->meter(e));
  push64(e->sr); push64((double)e->max_block); push64(e->carrier_type); push64(e->pitch_hz);
  push64(e->glide_ms); push64(e->order); push64(e->tract_size); push64(e->tract_q);
  push64(e->brightness); push64(e->breath); push64(e->squelch_db); push64(e->drive_amt);
  push64(e->out_db); push64((double)e->follow); push64((double)e->source);
  push64(e->car_rms); push64(e->car_rms_a);
  push64((double)e->frame_len); push64((double)e->hop); push64((double)e->hist_len);
  push64((double)e->hist_w); push64((double)e->hop_count); push64((double)e->active_order);
  push64(e->gain_target); push64(int32_of(e->noise_state)); push64(e->tracked_hz);
  push64(e->de_z); push64(e->drive_gain); push64(e->car_l != NULL ? 1.0 : 0.0);
  osc_state(&e->osc1); osc_state(&e->osc2); osc_state(&e->osc_sub);
  push64((double)t->decim); push64(t->dsr); push64((double)t->min_lag); push64((double)t->max_lag);
  push64((double)t->size); push64((double)t->w); push64((double)t->decim_count);
  push64(t->acc); push64(t->freq); push64(t->confidence);
  smoother_state(&e->pitch_sm); smoother_state(&e->gate_sm); smoother_state(&e->gain_sm);
  smoother_state(&e->out_sm); smoother_state(&e->breath_sm);
  push64(e->in_env.env); push64(e->in_env.ca); push64(e->in_env.cr);
  push64((double)e->in_env.rms);
  biquad_state(&e->breath_hp); biquad_state(&e->tilt_low); biquad_state(&e->tilt_high);
  push64(e->dc.r); push64(e->dc.x1); push64(e->dc.y1);
  push64((double)e->os.factor); push64(e->os.osr); push64((double)e->os.up_len);
  for (k = 0; k < 3; k++) lp2_state(&e->os.up_filters[k]);
  for (k = 0; k < 3; k++) lp2_state(&e->os.down_filters[k]);
  for (k = 0; k < BK_TALKBOX_MAX_ORDER; k++) push64(e->k_target[k]);
  for (k = 0; k < BK_TALKBOX_MAX_ORDER; k++) push64(e->k_now[k]);
  for (k = 0; k <= BK_TALKBOX_MAX_ORDER; k++) push64(e->b[k]);
}
/* Full snapshot: the scalars plus every buffer. */
static void snap_state(void) {
  const bk_talkbox *e = g_fx;
  int k;
  block_state();
  for (k = 0; k < e->frame_len; k++) push64(e->frame[k]);
  for (k = 0; k <= BK_TALKBOX_MAX_ORDER; k++) push64(e->acf[k]);
  for (k = 0; k <= BK_TALKBOX_MAX_ORDER; k++) push64(e->lpc[k]);
  for (k = 0; k <= BK_TALKBOX_MAX_ORDER; k++) push64(e->lpc_tmp[k]);
  for (k = 0; k < e->hist_len; k++) push32(e->hist[k]);
  for (k = 0; k < e->frame_len; k++) push32(e->window[k]);
  for (k = 0; k < e->max_block; k++) push32(e->mono[k]);
  for (k = 0; k < e->os.up_len; k++) push32(e->os.up[k]);
  for (k = 0; k < e->tracker.size; k++) push32(e->tracker.buf[k]);
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
  size_t k;
  for (k = 0; k < CANARY; k++) g_box.canary[k] = 1234.5f;
  g_used = bk_talkbox_storage_floats(sr, max_block);
  if (g_used > MAX_STORE) {
    fprintf(stderr, "storage %lu exceeds the arena\n", (unsigned long)g_used);
    exit(4);
  }
  /* Fresh storage, poisoned so an unwritten float read shows as NaN. */
  for (k = 0; k < g_used; k++) g_store[k] = NAN;
  for (k = 0; k < CANARY; k++) g_store[g_used + k] = 1234.5f;
  bk_talkbox_init(g_fx, sr, max_block, g_store);
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
#define ALT SIG_ALT
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
#define REWIND O(OP_REWIND,0,0,0,0)
#define END O(OP_END,0,0,0,0)
/* LONG passes 7680 samples (gated voice, then mixed); TAIL 3840 of silence. */
#define LONG PROC(40,128,VOICE,VOICE),PROC(10,128,NOISE,RAMP),PROC(10,128,STEP,IMP)
#define SHORT PROC(12,128,VOICE,VOICE)
#define TAIL PROC(30,128,ZERO,ZERO)
/* Keys: 0 carrier 1 pitch 2 follow 3 glide 4 order 5 tract 6 tractq
   7 brightness 8 breath 9 squelch 10 drive 11 output 12 source. Most scripts
   run at 48 kHz (frame 1200, hop 288), where glibc and V8 agree on every
   exp the constructor takes; at 16 kHz exp(-1/48) is one ulp apart, which
   drifted every record and blinded the identity pins. t_rates covers others.
   TB also turns the drive off: the shaper's tanh is where native and V8 part
   (the oversampler down-filter state is the first field to differ), and a
   drifting record is only checked to tolerance, which hid real mutants.
   t_default, t_drive, t_combo, t_rates and mixed_inits keep a drive. */
#define TB INIT(48000,128),SET(10,0)
static const double t_default[] = {INIT(48000,128),SNAP,LONG,TAIL,SNAP,END};
static const double t_fresh[] = {TB,SNAP,PROC(1,50,VOICE,VOICE),SNAP,PROC(1,50,VOICE,VOICE),SNAP,END};
static const double t_voice[] = {TB,PROC(100,128,VOICE,ZERO),SNAP,END};
static const double t_silence[] = {TB,PROC(50,128,ZERO,ZERO),SNAP,END};
static const double t_carrier[] = {TB,SET(0,1),SHORT,SET(0,2),SHORT,SET(0,3),SHORT,SET(0,4),SHORT,SET(0,5),SHORT,SET(0,0),SHORT,SET(0,-0.4),SHORT,SET(0,0.5),SHORT,SET(0,2.5),SHORT,SET(0,9),SHORT,SET(0,-3),SHORT,SET(0,INF_),SHORT,SET(0,NINF_),SHORT,SET(0,1.49),SHORT,SNAP,END};
static const double t_carrier_nan[] = {TB,SET(0,NAN_),LONG,SNAP,SET(0,1),SHORT,RESET,SHORT,SNAP,END};
static const double t_noise[] = {TB,SET(0,5),PROC(200,128,VOICE,VOICE),SNAP,END};
static const double t_pitch[] = {TB,SET(2,0),SET(1,20),SHORT,SET(1,2000),SHORT,SET(1,10),SHORT,SET(1,5000),SHORT,SET(1,NAN_),SHORT,SET(1,330),SHORT,SET(2,1),SET(1,700),SHORT,SNAP,END};
static const double t_follow[] = {TB,SET(2,1),LONG,SET(2,0.49999999999999994),SHORT,SET(2,0.5),SHORT,SET(2,NAN_),SHORT,SET(2,1),PROC(30,128,RAMP,RAMP),SNAP,END};
static const double t_glide[] = {TB,SET(2,0),SET(3,0),SET(1,500),SHORT,SET(3,400),SET(1,100),SHORT,SET(3,-5),SHORT,SET(3,1000),SHORT,SET(3,40),SHORT,SET(3,NAN_),SET(1,300),SHORT,SNAP,END};
static const double t_order[] = {TB,SET(4,8),SHORT,SET(4,40),SHORT,SET(4,7),SHORT,SET(4,9),SHORT,SET(4,13),SHORT,SET(4,100),SHORT,SET(4,-5),SHORT,SET(4,INF_),SHORT,SET(4,NINF_),SHORT,SET(4,22),SHORT,SNAP,END};
static const double t_order_nan[] = {TB,LONG,SET(4,NAN_),LONG,SNAP,SET(4,30),SHORT,SNAP,END};
static const double t_tract[] = {TB,SET(5,0.5),SHORT,SET(5,2),SHORT,SET(5,0.3),SHORT,SET(5,3),SHORT,SET(5,1.37),SHORT,SET(5,NAN_),SHORT,SET(5,INF_),SHORT,SET(5,0.8),SHORT,SNAP,END};
static const double t_tractq[] = {TB,SET(6,0),SHORT,SET(6,1),SHORT,SET(6,-1),SHORT,SET(6,2),SHORT,SET(6,NAN_),SHORT,SET(6,0.5),SHORT,SNAP,END};
static const double t_brightness[] = {TB,SET(7,-1),SHORT,SET(7,1),SHORT,SET(7,-2),SHORT,SET(7,2),SHORT,SET(7,NAN_),SHORT,SET(7,0.3),SHORT,SNAP,END};
static const double t_breath[] = {TB,SET(8,1),SHORT,SET(8,0),LONG,SET(8,2),SHORT,SET(8,-1),SHORT,SET(8,0.5),SHORT,SET(8,NAN_),SHORT,SNAP,END};
static const double t_squelch[] = {TB,SET(9,-90),SHORT,SET(9,-10),SHORT,SET(9,-100),SHORT,SET(9,0),SHORT,SET(9,NAN_),SHORT,SET(9,-40),LONG,SNAP,END};
static const double t_drive[] = {TB,GAIN(3),SET(10,0),SHORT,SET(10,0.001),SHORT,SET(10,0.0010000000000000002),SHORT,SET(10,1),SHORT,SET(10,NAN_),SHORT,SET(10,2),SHORT,SET(10,-1),SHORT,SET(10,0.5),SHORT,SNAP,END};
static const double t_output[] = {TB,SET(11,-6),SHORT,SET(11,12),SHORT,SET(11,-200),SHORT,SET(11,NINF_),SHORT,SET(11,0),SHORT,SNAP,END};
static const double t_output_inf[] = {TB,SET(11,INF_),SHORT,SET(11,0),SHORT,SNAP,END};
static const double t_output_nan[] = {TB,SET(11,NAN_),SHORT,SNAP,END};
static const double t_source[] = {TB,SET(12,1),SHORT,BUS(NOISE,RAMP,1),SHORT,SET(12,0.49999999999999994),SHORT,SET(12,0.5),SHORT,BUS(ZERO,ZERO,1),PROC(300,128,VOICE,VOICE),SNAP,SET(12,NAN_),SHORT,SET(12,1),BUS(IMP,STEP,1e-6),SHORT,BUS(RAMP,NOISE,1),RESET,SHORT,SNAP,BUS(ZERO,ZERO,1),RESET,SHORT,SNAP,END};
static const double t_source_off[] = {TB,BUS(NOISE,NOISE,0.5),SHORT,SET(0,5),SHORT,SNAP,END};
static const double t_reset[] = {TB,LONG,SNAP,RESET,SNAP,LONG,RESET,SNAP,END};
static const double t_alias[] = {TB,MONO(40,128,VOICE),MONO(4,128,ZERO),SNAP,END};
static const double t_blocks[] = {TB,PROC(2,0,VOICE,VOICE),PROC(1,-3,ZERO,ZERO),PROC(300,1,VOICE,RAMP),PROC(50,7,STEP,NOISE),PROC(10,128,VOICE,VOICE),INIT(16000,4096),PROC(3,4096,VOICE,NOISE),SNAP,END};
static const double t_rates[] = {INIT(4500.3,128),SET(2,0),SET(1,2000),LONG,SNAP,INIT(44100,128),LONG,INIT(96000,256),PROC(40,256,VOICE,VOICE),SNAP,INIT(1000,64),PROC(40,64,VOICE,RAMP),SNAP,INIT(8000,1),PROC(500,1,VOICE,VOICE),SNAP,END};
static const double t_unknown[] = {TB,SET(-1,5),SET(13,5),SET(99,5),SHORT,SNAP,END};
static const double t_poke[] = {TB,PROC(9,128,VOICE,VOICE),POKE(0,3,NAN_),POKE(1,20,INF_),PROC(1,128,VOICE,VOICE),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),PROC(12,128,VOICE,VOICE),SNAP,RESET,LONG,SNAP,END};
static const double t_poke_big[] = {TB,PROC(9,128,VOICE,VOICE),POKE(0,3,1e30),POKE(1,3,-1e30),PROC(4,128,VOICE,VOICE),SNAP,END};
static const double t_gain[] = {TB,GAIN(1e-20),LONG,GAIN(1000),LONG,SNAP,END};
static const double t_huge[] = {TB,GAIN(1e35),PROC(20,128,VOICE,VOICE),SNAP,END};
static const double t_dc[] = {TB,LEVEL(0.5),PROC(60,128,DC,DC),SNAP,END};
static const double t_kclamp[] = {TB,SET(6,1),SET(4,40),PROC(60,128,RAMP,ZERO),PROC(40,128,STEP,ZERO),SNAP,END};
static const double t_combo[] = {TB,SET(0,4),SET(2,1),SET(3,120),SET(4,32),SET(5,1.4),SET(6,0.7),SET(7,-0.4),SET(8,0.6),SET(9,-60),SET(10,0.8),SET(11,3),LONG,TAIL,SNAP,END};
static const double t_quiet[] = {TB,GAIN(1e-5),LONG,SNAP,GAIN(1e-9),LONG,SNAP,GAIN(3e-7),LONG,SNAP,END};
static const double t_poke_inf[] = {TB,PROC(9,128,VOICE,VOICE),POKE(0,3,INF_),PROC(1,128,VOICE,VOICE),PROC(12,128,VOICE,VOICE),SNAP,END};
static const double t_poke_ninf[] = {TB,PROC(9,128,VOICE,VOICE),POKE(1,40,NINF_),PROC(1,128,VOICE,VOICE),PROC(12,128,VOICE,VOICE),SNAP,END};
static const double t_poke_max[] = {TB,PROC(9,128,VOICE,VOICE),POKE(0,3,3e38),POKE(1,3,3e38),POKE(0,4,-3e38),POKE(1,4,-3e38),PROC(1,128,VOICE,VOICE),PROC(12,128,VOICE,VOICE),SNAP,END};
static const double t_kpos[] = {TB,SET(5,1),SET(6,1),SET(4,40),MONO(60,128,ALT),SNAP,SET(4,8),MONO(20,128,ALT),SNAP,END};
static const double t_bus_quiet[] = {TB,SET(12,1),BUS(NOISE,NOISE,5e-5),SHORT,SNAP,BUS(NOISE,STEP,2e-5),SHORT,SNAP,END};
static const double t_bus_lr[] = {TB,SET(12,1),BUS(NOISE,ZERO,1),SHORT,SNAP,END};
static const double t_reset40[] = {TB,SET(4,40),LONG,RESET,SHORT,SNAP,END};
static const double t_tail_long[] = {TB,LONG,PROC(200,128,ZERO,ZERO),SNAP,END};
/* Non-integer resample ratio: an inf that is only ever the upper lerp
   neighbour reads as inf, not NaN, so the frame energy is inf and the first
   reflection coefficient is inf/inf. */
static const double t_inf_frac[] = {TB,SET(5,0.7),PROC(12,128,VOICE,VOICE),POKE(0,5,INF_),PROC(20,128,VOICE,VOICE),SNAP,POKE(0,64,INF_),PROC(20,128,VOICE,VOICE),SNAP,RESET,SET(5,0.6),PROC(12,128,VOICE,VOICE),POKE(1,9,NINF_),PROC(20,128,VOICE,VOICE),SNAP,END};
/* Pitch set while following: only the snapshot sees the smoother target. */
static const double t_pitch_snap[] = {TB,SHORT,SET(1,300),SNAP,SET(2,0),SET(1,500),SNAP,SHORT,SNAP,END};
static const double t_breath_small[] = {TB,SET(8,0.0005),LONG,SNAP,SET(8,0.00011),LONG,SNAP,END};
/* A NaN tract size makes every lerp position NaN: the frame is all NaN and
   the snapshot right after shows it. */
static const double t_tract_nan[] = {TB,SHORT,SET(5,NAN_),SHORT,SNAP,SET(5,1),SHORT,SNAP,END};
static const double mixed_inits[] = {INIT(48000,128),SHORT,INIT(8000,32),PROC(20,32,VOICE,VOICE),SNAP,END};
#define S(n) {#n,n,sizeof(n)/sizeof(n[0])}
typedef struct { const char *name; const double *ops; size_t n; } script;
/* TB turns the drive off; this runs the odd block sizes (0, -3, 7) and a reset
   through the oversampled shaper. */
static const double t_drive_blocks[] = {INIT(48000,128),SET(10,0.6),SHORT,PROC(1,-3,ZERO,ZERO),PROC(2,0,VOICE,VOICE),PROC(5,7,VOICE,NOISE),SNAP,RESET,SHORT,SNAP,END};
static const script scripts[] = {S(t_default),S(t_fresh),S(t_voice),S(t_silence),S(t_carrier),S(t_carrier_nan),S(t_noise),S(t_pitch),S(t_follow),S(t_glide),S(t_order),S(t_order_nan),S(t_tract),S(t_tractq),S(t_brightness),S(t_breath),S(t_squelch),S(t_drive),S(t_output),S(t_output_inf),S(t_output_nan),S(t_source),S(t_source_off),S(t_reset),S(t_alias),S(t_blocks),S(t_rates),S(t_unknown),S(t_poke),S(t_poke_big),S(t_gain),S(t_huge),S(t_dc),S(t_kclamp),S(t_combo),S(t_quiet),S(t_poke_inf),S(t_poke_ninf),S(t_poke_max),S(t_kpos),S(t_bus_quiet),S(t_bus_lr),S(t_reset40),S(t_tail_long),S(t_inf_frac),S(t_pitch_snap),S(t_breath_small),S(t_tract_nan),S(t_drive_blocks),S(mixed_inits)};

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

/* Nyquist square at +-0.5: the strongest negative lag-1 correlation, so a
   positive reflection coefficient reaches the K_LIMIT clamp. */
static void fill_alt(float *dst) {
  int j;
  for (j = 0; j < SIG_N; j++) dst[j] = (j % 2) == 0 ? 0.5f : -0.5f;
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
  fill_alt(g_sig[SIG_ALT]);
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
