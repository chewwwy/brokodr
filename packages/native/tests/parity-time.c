/* Bro.Kodr time effects (Delay, Reverb) parity producer; replayed by verify-time-parity.mjs. */
#include "brokodr/dsp/time-fx.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

enum {
  OP_END = 0,
  OP_INIT = 1,    /* a = type (0 delay, 1 reverb), b = sample rate */
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
#define MAX_P64 4000000
#define MAX_P32 8000000
#define MAX_STORE 1000000

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

/* Effect structs and their caller-owned storage. Canaries after the struct
   and right after the last storage float catch writes past either. */
#define CANARY 64
static struct { bk_delay e; float canary[CANARY]; } g_dbox;
static struct { bk_reverb e; float canary[CANARY]; } g_rbox;
static float g_store[MAX_STORE + CANARY];
static size_t g_used;
static int g_type;
static void *g_fx;
static const bk_effect_vt *g_vt;
static void check_canary(void) {
  int k;
  for (k = 0; k < CANARY; k++) {
    if (g_dbox.canary[k] != 1234.5f || g_rbox.canary[k] != 1234.5f ||
        g_store[g_used + (size_t)k] != 1234.5f) {
      fprintf(stderr, "write past the effect struct or storage at %d\n", k);
      exit(5);
    }
  }
}

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
  push64(s->value); push64(s->target); push64(s->a);
}
static void biquad_state(const bk_biquad *f) {
  push64(f->b0); push64(f->b1); push64(f->b2); push64(f->a1); push64(f->a2);
  push64(f->z1); push64(f->z2);
  push64((double)f->type); push64(f->freq); push64(f->q); push64(f->gain_db);
}
static void lfo_state(const bk_lfo *l) {
  push64(l->phase); push64(l->inc); push64((double)l->shape);
  push64(l->rand); push64(l->last_quad);
}
static void line_state(const bk_delay_line *d) {
  push64((double)d->size); push64((double)d->w);
}
static void line_buf(const bk_delay_line *d) {
  int j;
  for (j = 0; j < d->size; j++) push32(d->buf[j]);
}

/* Per-block scalars: everything but the delay buffers. */
static void block_state(void) {
  int k;
  push64(g_vt->meter(g_fx));
  if (g_type == 0) {
    const bk_delay *e = &g_dbox.e;
    push64(e->sr); push64(e->feedback); push64((double)e->pingpong);
    push64(e->lp_freq); push64(e->hp_freq); push64(e->fb_l); push64(e->fb_r);
    push64(e->mod_depth); push64(e->spread); push64(e->bpm); push64(e->sync_div);
    push64(e->time_ms); push64(e->crossfeed); push64(e->saturate);
    smoother_state(&e->time_l); smoother_state(&e->time_r);
    lfo_state(&e->lfo);
    biquad_state(&e->lp_l); biquad_state(&e->lp_r);
    biquad_state(&e->hp_l); biquad_state(&e->hp_r);
    line_state(&e->line_l); line_state(&e->line_r);
  } else {
    const bk_reverb *e = &g_rbox.e;
    push64(e->sr); push64(e->width); push64(e->hp_freq); push64(e->mod_depth);
    push64(e->diffusion);
    smoother_state(&e->size_sm); smoother_state(&e->decay_sm);
    smoother_state(&e->damp_sm); smoother_state(&e->predelay_sm);
    biquad_state(&e->hp_l); biquad_state(&e->hp_r);
    for (k = 0; k < BK_REVERB_LINES; k++) lfo_state(&e->lfos[k]);
    for (k = 0; k < BK_REVERB_LINES; k++) push64(e->damp_state[k]);
    for (k = 0; k < BK_REVERB_LINES; k++) push64((double)e->tmp[k]);
    for (k = 0; k < 4; k++) {
      push64(e->diff_l[k].delay); push64(e->diff_l[k].g); line_state(&e->diff_l[k].line);
    }
    for (k = 0; k < 4; k++) {
      push64(e->diff_r[k].delay); push64(e->diff_r[k].g); line_state(&e->diff_r[k].line);
    }
    for (k = 0; k < BK_REVERB_LINES; k++) line_state(&e->lines[k]);
    line_state(&e->pre_l); line_state(&e->pre_r);
  }
}
/* Full snapshot: the scalars plus every delay buffer. */
static void snap_state(void) {
  int k;
  block_state();
  if (g_type == 0) {
    line_buf(&g_dbox.e.line_l); line_buf(&g_dbox.e.line_r);
  } else {
    const bk_reverb *e = &g_rbox.e;
    for (k = 0; k < BK_REVERB_LINES; k++) line_buf(&e->lines[k]);
    for (k = 0; k < 4; k++) line_buf(&e->diff_l[k].line);
    for (k = 0; k < 4; k++) line_buf(&e->diff_r[k].line);
    line_buf(&e->pre_l); line_buf(&e->pre_r);
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
  size_t k;
  g_type = type;
  for (k = 0; k < CANARY; k++) g_dbox.canary[k] = g_rbox.canary[k] = 1234.5f;
  /* Fresh storage, poisoned so an unwritten float read shows as NaN. */
  g_used = type == 0 ? bk_delay_storage_floats(sr) : bk_reverb_storage_floats(sr);
  if (g_used > MAX_STORE) {
    fprintf(stderr, "storage %lu exceeds the arena\n", (unsigned long)g_used);
    exit(4);
  }
  for (k = 0; k < g_used; k++) g_store[k] = NAN;
  for (k = 0; k < CANARY; k++) g_store[g_used + k] = 1234.5f;
  if (type == 0) {
    bk_delay_init(&g_dbox.e, sr, g_store);
    g_fx = &g_dbox.e;
    g_vt = &bk_delay_vt;
  } else {
    bk_reverb_init(&g_rbox.e, sr, g_store);
    g_fx = &g_rbox.e;
    g_vt = &bk_reverb_vt;
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
        (void)c;
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

/* Opcodes travel in record.params: the JS oracle replays the same scripts. */
#define NOISE BK_SIG_NOISE
#define RAMP BK_SIG_RAMP
#define STEP BK_SIG_STEP
#define IMP BK_SIG_IMPULSE
#define ZERO BK_SIG_ZERO
#define DC SIG_DC
#define O(op,a,b,c,d) (double)(op),(double)(a),(double)(b),(double)(c),(double)(d)
#define INIT(t,sr) O(OP_INIT,t,sr,0,0)
#define SET(k,v) O(OP_PARAM,k,v,0,0)
#define PROC(n,bs,l,r) O(OP_PROCESS,n,bs,l,r)
#define SNAP O(OP_SNAP,0,0,0,0)
#define RESET O(OP_RESET,0,0,0,0)
#define POKE(ch,at,v) O(OP_POKE,ch,at,v,0)
#define GAIN(v) O(OP_GAIN,v,0,0,0)
#define MONO(n,bs,s) O(OP_MONO,n,bs,s,0)
#define LEVEL(v) O(OP_DC,v,0,0,0)
#define REWIND O(OP_REWIND,0,0,0,0)
#define END O(OP_END,0,0,0,0)
/* LONG passes 7680 samples (mixed stimulus); TAIL 3840 of silence. */
#define LONG PROC(40,128,NOISE,RAMP),PROC(10,128,STEP,IMP),PROC(10,128,ZERO,NOISE)
#define SHORT PROC(12,128,NOISE,RAMP)
#define TAIL PROC(30,128,ZERO,ZERO)
/* Delay keys: 0 time 1 sync 2 bpm 3 feedback 4 pingpong 5 lowpass 6 highpass
   7 moddepth 8 modrate 9 spread 10 crossfeed 11 saturate. Most delay scripts
   run at 8 kHz so 250 ms echoes return inside a script. */
#define D8 INIT(0,8000)
static const double d_default[] = {INIT(0,48000),SNAP,LONG,PROC(100,128,ZERO,ZERO),SNAP,END};
static const double d_ctor_filters[] = {D8,SNAP,PROC(1,0,ZERO,ZERO),SNAP,SET(5,1000),SET(6,50),PROC(1,-2,ZERO,ZERO),SNAP,END};
static const double d_time[] = {D8,SET(0,20),SHORT,SET(0,1),SHORT,SET(0,0.5),SHORT,SET(0,3900),SHORT,SET(0,5000),SHORT,SET(0,100),SHORT,SET(0,-5),SHORT,SET(0,37.3),LONG,TAIL,SNAP,END};
static const double d_time_nan[] = {D8,SET(0,NAN_),SHORT,SET(0,30),SHORT,SNAP,END};
static const double d_time_inf[] = {D8,SET(0,INF_),SHORT,SET(0,NINF_),SHORT,SNAP,END};
static const double d_sync[] = {D8,SET(0,40),SET(1,1),SHORT,SET(1,2),SHORT,SET(1,3),SHORT,SET(1,4),SHORT,SET(1,5),SHORT,SET(1,6),SHORT,SET(1,7),SHORT,SET(1,8),SHORT,SET(1,9),SHORT,SET(1,0.4),SHORT,SET(1,0.5),SHORT,SET(1,9.6),SHORT,SET(1,12),SHORT,SET(1,-1),SHORT,SET(1,2.5),SHORT,SET(1,-0.5),SHORT,SET(1,-0.4),SHORT,SNAP,END};
static const double d_sync_nan[] = {D8,SET(0,30),SET(1,3),SHORT,SET(1,NAN_),SHORT,SET(1,INF_),SHORT,SET(1,NINF_),SHORT,SNAP,END};
static const double d_bpm[] = {D8,SET(1,5),SET(2,20),SHORT,SET(2,300),SHORT,SET(2,10),SHORT,SET(2,400),SHORT,SET(2,97.5),SHORT,SET(2,NAN_),SHORT,SET(2,140),SHORT,SNAP,END};
static const double d_bpm_free[] = {D8,SET(0,15),SET(2,90),SHORT,SET(1,0),SET(2,200),SHORT,SNAP,END};
static const double d_feedback[] = {D8,SET(0,10),SET(3,0),SHORT,SET(3,0.5),SHORT,SET(3,1.1),LONG,SET(3,1.5),SHORT,SET(3,-1),SHORT,SET(3,NAN_),SHORT,SET(3,0.9),SHORT,SNAP,END};
static const double d_blowup[] = {D8,GAIN(1e29),LEVEL(1),SET(0,1),SET(3,1.1),SET(6,1),SET(5,4000),PROC(120,128,DC,DC),SNAP,GAIN(1),PROC(10,128,NOISE,NOISE),SNAP,END};
static const double d_pingpong[] = {D8,SET(0,12),SET(3,0.7),SET(4,0),SHORT,SET(4,0.49999999999999994),SHORT,SET(4,0.5),LONG,SET(4,1),SHORT,SET(4,NAN_),SHORT,SET(4,1),SET(10,0.5),SHORT,SNAP,END};
static const double d_filters[] = {D8,SET(0,8),SET(3,0.8),SET(5,200),SHORT,SET(5,20000),SHORT,SET(5,3999),SHORT,SET(5,NAN_),SHORT,SET(5,6000),SHORT,SET(5,0),SHORT,SET(5,-5),SHORT,SET(5,6000),SET(6,20),SHORT,SET(6,3000),SHORT,SET(6,NAN_),SHORT,SET(6,INF_),SHORT,SET(6,180),SHORT,SNAP,END};
static const double d_mod[] = {D8,SET(0,15),SET(3,0.5),SET(7,0.5),SET(8,5),LONG,SET(7,1),SHORT,SET(7,2),SHORT,SET(7,-1),SHORT,SET(7,NAN_),SHORT,SET(7,1),SET(8,0),SHORT,SET(8,-3),SHORT,SET(8,NAN_),SHORT,SET(8,40),SHORT,SNAP,END};
static const double d_mod_inf[] = {D8,SET(7,1),SET(8,INF_),SHORT,SNAP,END};
static const double d_spread[] = {D8,SET(0,20),SET(9,0.5),SHORT,SET(9,1),SHORT,SET(9,2),SHORT,SET(9,NAN_),SHORT,SET(9,0.25),LONG,SNAP,END};
static const double d_crossfeed[] = {D8,SET(0,9),SET(3,0.8),SET(10,0.3),LONG,SET(10,1),SHORT,SET(10,NAN_),SHORT,SET(10,-1),SHORT,SNAP,END};
static const double d_saturate[] = {D8,SET(0,7),SET(3,0.9),GAIN(4),SET(11,0.001),SHORT,SET(11,0.0010000000000000002),SHORT,SET(11,0.5),SHORT,SET(11,1),LONG,SET(11,NAN_),SHORT,SET(11,2),SHORT,SNAP,END};
static const double d_combo[] = {D8,SET(0,30),SET(1,6),SET(2,133),SET(3,1.05),SET(4,1),SET(7,0.7),SET(8,1.3),SET(9,0.6),SET(11,0.4),SET(5,2500),SET(6,300),LONG,TAIL,SNAP,END};
static const double d_time_max[] = {INIT(0,48000),SET(0,3900),SET(9,1),SET(7,1),PROC(300,128,NOISE,RAMP),SNAP,END};
static const double d_tiny_sr[] = {INIT(0,1),SHORT,SET(0,3900),SHORT,SNAP,SET(0,1),SHORT,SNAP,INIT(0,0.3),SET(3,1),SHORT,SNAP,END};
static const double d_reset[] = {D8,SET(0,20),LONG,SNAP,RESET,SNAP,LONG,RESET,SNAP,END};
static const double d_alias[] = {D8,SET(0,15),SET(3,0.6),MONO(40,128,NOISE),SET(4,1),MONO(20,128,NOISE),MONO(4,128,ZERO),SNAP,END};
static const double d_blocks[] = {D8,SET(0,3),PROC(2,0,NOISE,RAMP),PROC(1,-3,ZERO,ZERO),PROC(300,1,NOISE,RAMP),PROC(50,7,STEP,NOISE),PROC(1,4096,NOISE,RAMP),SNAP,END};
static const double d_rates[] = {INIT(0,4500.3),SET(0,20),LONG,SNAP,INIT(0,44100),SET(0,40),LONG,INIT(0,96000),SET(0,30),LONG,SNAP,END};
static const double d_unknown[] = {D8,SET(-1,5),SET(12,5),SET(99,5),SHORT,SNAP,END};
static const double d_poke[] = {D8,SET(0,5),SET(3,0.9),PROC(9,128,NOISE,RAMP),POKE(0,3,NAN_),POKE(1,20,INF_),PROC(1,128,NOISE,RAMP),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),POKE(1,34,1.0000001e30),PROC(12,128,NOISE,RAMP),SNAP,RESET,LONG,SNAP,END};
static const double d_gain[] = {D8,SET(0,3),SET(3,1),GAIN(1e-20),LONG,GAIN(1000),LONG,SNAP,END};
static const double d_dc[] = {D8,LEVEL(0.5),SET(0,4),SET(3,0.95),PROC(60,128,DC,DC),SNAP,END};
/* Reverb keys: 0 decay 1 size 2 damping 3 predelay 4 width 5 highpass
   6 modulation 7 diffusion. */
#define R16 INIT(1,16000)
static const double r_default[] = {INIT(1,48000),SNAP,LONG,TAIL,SNAP,END};
static const double r_size[] = {R16,SET(1,0.2),SHORT,SET(1,3),SHORT,SET(1,0.1),SHORT,SET(1,5),SHORT,SET(1,1.5),SHORT,SET(1,NAN_),SHORT,SET(1,0.7),SHORT,SNAP,END};
static const double r_decay[] = {R16,SET(0,0),SHORT,SET(0,0.995),LONG,SET(0,1),SHORT,SET(0,-1),SHORT,SET(0,0.5),SHORT,SET(0,NAN_),SHORT,SET(0,0.9),SHORT,SNAP,END};
static const double r_damping[] = {R16,SET(2,0),SHORT,SET(2,0.99),SHORT,SET(2,2),SHORT,SET(2,NAN_),SHORT,SET(2,0.6),SHORT,SNAP,END};
static const double r_predelay[] = {R16,SET(3,0),SHORT,SET(3,200),SHORT,SET(3,300),SHORT,SET(3,-5),SHORT,SET(3,50),SHORT,SET(3,NAN_),SHORT,SET(3,10),SHORT,SNAP,END};
static const double r_width[] = {R16,SET(4,0),SHORT,SET(4,0.5),SHORT,SET(4,2),SHORT,SET(4,NAN_),SHORT,SET(4,-0.5),SHORT,SET(4,0.3),SHORT,SNAP,END};
static const double r_highpass[] = {R16,SET(5,20),SHORT,SET(5,2000),SHORT,SET(5,NAN_),SHORT,SET(5,0),SHORT,SET(5,INF_),SHORT,SET(5,300),SHORT,SNAP,END};
static const double r_modulation[] = {R16,SET(6,0),SHORT,SET(6,0.001),SHORT,SET(6,0.0010000000000000002),SHORT,SET(6,1),SHORT,SET(6,2),SHORT,SET(6,NAN_),SHORT,SET(6,-0.5),SHORT,SET(6,0.4),SHORT,SNAP,END};
static const double r_diffusion[] = {R16,SNAP,SET(7,0),SHORT,SET(7,0.9),SHORT,SET(7,1),SHORT,SET(7,0.3),SHORT,SET(7,NAN_),SHORT,SET(7,-1),SHORT,SET(7,0.6),SHORT,SNAP,END};
static const double r_combo[] = {R16,SET(0,0.97),SET(1,2.4),SET(2,0.2),SET(3,35),SET(4,0.8),SET(5,90),SET(6,0.7),SET(7,0.75),LONG,TAIL,SNAP,END};
static const double r_lfo_wrap[] = {INIT(1,1000),SET(6,1),SET(0,0.99),PROC(100,128,NOISE,RAMP),SNAP,END};
static const double r_blowup[] = {R16,GAIN(1e29),LEVEL(1),SET(0,0.995),SET(2,0),SET(5,1),PROC(40,128,DC,DC),SNAP,GAIN(1),PROC(10,128,NOISE,NOISE),SNAP,END};
static const double r_reset[] = {R16,LONG,SNAP,RESET,SNAP,LONG,RESET,SNAP,END};
static const double r_alias[] = {R16,SET(4,0.4),MONO(40,128,NOISE),MONO(4,128,ZERO),SNAP,END};
static const double r_blocks[] = {R16,PROC(2,0,NOISE,RAMP),PROC(1,-3,ZERO,ZERO),PROC(300,1,NOISE,RAMP),PROC(50,7,STEP,NOISE),PROC(1,4096,NOISE,RAMP),SNAP,END};
static const double r_rates[] = {INIT(1,4500.3),LONG,SNAP,INIT(1,44100),LONG,INIT(1,96000),SHORT,SNAP,INIT(1,100),SET(1,3),LONG,SNAP,SET(1,0.2),LONG,SNAP,END};
static const double r_unknown[] = {R16,SET(-1,5),SET(8,5),SET(99,5),SHORT,SNAP,END};
static const double r_poke[] = {R16,PROC(9,128,NOISE,RAMP),POKE(0,3,NAN_),POKE(1,20,INF_),PROC(1,128,NOISE,RAMP),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),PROC(12,128,NOISE,RAMP),SNAP,RESET,LONG,SNAP,END};
static const double r_gain[] = {R16,GAIN(1e-20),LONG,GAIN(1000),LONG,SNAP,END};
static const double r_dc[] = {R16,LEVEL(0.5),PROC(60,128,DC,DC),SNAP,END};
static const double mixed_types[] = {D8,SET(0,10),SHORT,INIT(1,8000),SHORT,SNAP,INIT(0,16000),SHORT,SNAP,END};
#define S(n) {#n,n,sizeof(n)/sizeof(n[0])}
typedef struct { const char *name; const double *ops; size_t n; } script;
static const script scripts[] = {S(d_default),S(d_ctor_filters),S(d_time),S(d_time_nan),S(d_time_inf),S(d_sync),S(d_sync_nan),S(d_bpm),S(d_bpm_free),S(d_feedback),S(d_blowup),S(d_pingpong),S(d_filters),S(d_mod),S(d_mod_inf),S(d_spread),S(d_crossfeed),S(d_saturate),S(d_combo),S(d_time_max),S(d_tiny_sr),S(d_reset),S(d_alias),S(d_blocks),S(d_rates),S(d_unknown),S(d_poke),S(d_gain),S(d_dc),S(r_default),S(r_size),S(r_decay),S(r_damping),S(r_predelay),S(r_width),S(r_highpass),S(r_modulation),S(r_diffusion),S(r_combo),S(r_lfo_wrap),S(r_blowup),S(r_reset),S(r_alias),S(r_blocks),S(r_rates),S(r_unknown),S(r_poke),S(r_gain),S(r_dc),S(mixed_types)};

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
