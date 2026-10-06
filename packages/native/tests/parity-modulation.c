/* Bro.Kodr modulation parity producer; replayed by verify-modulation-parity.mjs. */
#include "brokodr/dsp/modulation.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

enum {
  OP_END = 0,
  OP_INIT = 1,    /* a = type (chorus/flanger/phaser/tremolo/ringmod/freqshift), b = sr, c = internal RNG */
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
#define STORE_FLOATS 32768

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

static bk_chorus g_ch;
static bk_flanger g_fl;
static bk_phaser g_ph;
static bk_tremolo g_tr;
static bk_ring_mod g_rm;
static bk_frequency_shifter g_fs;
static unsigned int g_rng;
static double random_draw(void *user) {
  return (bk_rng_bipolar((unsigned int *)user) + 1.0) * 0.5;
}
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

static void line_state(const bk_delay_line *d) {
  push64((double)d->size);
  push64((double)d->w);
}

static int g_internal;
/* Snapshots expose all behavioural state, including buffer contents. LFO
 * shape is canonicalised: unknown/NaN shape uses the same sine default. */
static void lfo_state(const bk_lfo *l) {
  push64(l->phase); push64(l->inc); push64((double)l->shape);
  push64(l->rand); push64(l->last_quad);
}
static void lines_state(const bk_delay_line *d) {
  int c, j;
  for (c=0;c<2;c++) {
    line_state(&d[c]);
    for(j=0;j<d[c].size;j++) push32(d[c].buf[j]);
  }
}
static void snap_state(void) {
  int c, i;
  push64(g_vt->meter(g_fx));
  push64((double)(g_internal && g_type==1 ? g_fl.random.rng :
                 g_internal && g_type==2 ? g_ph.random.rng :
                 g_internal && g_type==3 ? g_tr.random.rng : g_rng));
  if(g_type==0) {
    const bk_chorus *e=&g_ch;
    push64(e->sr); push64(e->voices);
    for(i=0;i<6;i++) lfo_state(&e->lfos[i]);
    smoother_state(&e->rate_sm); smoother_state(&e->depth_sm); smoother_state(&e->delay_sm);
    push64(e->spread); push64(e->feedback); push64(e->fb_l); push64(e->fb_r);
    biquad_state(&e->hp[0]); biquad_state(&e->hp[1]); lines_state(e->lines);
  } else if(g_type==1) {
    const bk_flanger *e=&g_fl;
    push64(e->sr); lfo_state(&e->lfo[0]); lfo_state(&e->lfo[1]);
    smoother_state(&e->depth_sm); smoother_state(&e->delay_sm);
    push64(e->feedback); push64(e->damp_freq); push64(e->fb_l); push64(e->fb_r);
    push64(e->stereo_phase); push64((double)e->invert);
    biquad_state(&e->damp[0]); biquad_state(&e->damp[1]); lines_state(e->lines);
  } else if(g_type==2) {
    const bk_phaser *e=&g_ph;
    push64(e->sr); push64(e->stages);
    for(c=0;c<2;c++) for(i=0;i<8;i++) biquad_state(&e->ap[c][i]);
    lfo_state(&e->lfo[0]); lfo_state(&e->lfo[1]);
    smoother_state(&e->center_sm); smoother_state(&e->depth_sm);
    push64(e->feedback); push64(e->q); push64(e->fb_l); push64(e->fb_r); push64(e->stereo);
  } else if(g_type==3) {
    const bk_tremolo *e=&g_tr;
    push64(e->sr); lfo_state(&e->lfo[0]); lfo_state(&e->lfo[1]); smoother_state(&e->depth_sm);
    push64(e->stereo_mode); push64(e->phase_offset); push64(e->smoothness);
  } else if(g_type==4) {
    const bk_ring_mod *e=&g_rm;
    push64(e->sr); push64(e->osc.phase); push64(e->osc.inc); push64(e->osc.pw);
    smoother_state(&e->freq_sm); push64(e->shape); push64(e->sweep_depth); push64(e->phase);
    push64((double)e->am_mode); lfo_state(&e->lfo);
  } else {
    const bk_frequency_shifter *e=&g_fs;
    push64(e->sr);
    for(i=0;i<4;i++) push64(e->coef_a[i]);
    for(i=0;i<4;i++) push64(e->coef_b[i]);
    for(c=0;c<2;c++) for(i=0;i<4;i++) {
      const bk_hilbert_section *a=&e->state_a[c][i];
      push64(a->a); push64(a->x1); push64(a->x2); push64(a->y1); push64(a->y2);
    }
    for(c=0;c<2;c++) for(i=0;i<4;i++) {
      const bk_hilbert_section *a=&e->state_b[c][i];
      push64(a->a); push64(a->x1); push64(a->x2); push64(a->y1); push64(a->y2);
    }
    push64(e->delay_a[0]); push64(e->delay_a[1]); smoother_state(&e->freq_sm);
    push64(e->phase); push64(e->feedback); push64(e->fb_l); push64(e->fb_r);
  }
}
static void block_state(void) { snap_state(); }

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
  g_type=type; g_internal=0;
  g_need=type==0 ? bk_chorus_storage_floats(sr) : type==1 ? bk_flanger_storage_floats(sr) : 0;
  if(g_need+CANARY>STORE_FLOATS) { fprintf(stderr,"storage overflow\n"); exit(4); }
  for(k=0;k<STORE_FLOATS;k++) g_store[k]=1234.5f;
  bk_rng_seed(&g_rng,1u);
  if(type==0) { bk_chorus_init(&g_ch,sr,g_store); g_fx=&g_ch; g_vt=&bk_chorus_vt; }
  else if(type==1) { bk_flanger_init(&g_fl,sr,g_store); g_fx=&g_fl; g_vt=&bk_flanger_vt; bk_flanger_set_random(&g_fl,random_draw,&g_rng); }
  else if(type==2) { bk_phaser_init(&g_ph,sr); g_fx=&g_ph; g_vt=&bk_phaser_vt; bk_phaser_set_random(&g_ph,random_draw,&g_rng); }
  else if(type==3) { bk_tremolo_init(&g_tr,sr); g_fx=&g_tr; g_vt=&bk_tremolo_vt; bk_tremolo_set_random(&g_tr,random_draw,&g_rng); }
  else if(type==4) { bk_ring_mod_init(&g_rm,sr); g_fx=&g_rm; g_vt=&bk_ring_mod_vt; }
  else { bk_frequency_shifter_init(&g_fs,sr); g_fx=&g_fs; g_vt=&bk_frequency_shifter_vt; }
  check_canary(); vt_flags();
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
        if(c==1.0) {
          g_internal=1;
          if(g_type==1) bk_flanger_set_random(&g_fl,NULL,NULL);
          if(g_type==2) bk_phaser_set_random(&g_ph,NULL,NULL);
          if(g_type==3) bk_tremolo_set_random(&g_tr,NULL,NULL);
        }
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
#define END O(OP_END,0,0,0,0)
#define BURST PROC(4,64,NOISE,RAMP),PROC(3,64,ZERO,ZERO),PROC(2,64,STEP,IMP)
static const double ch_default[] = {INIT(0,48000),SNAP,BURST,SNAP,END};
static const double ch_rate[] = {INIT(0,48000),SNAP,SET(0,0),SNAP,BURST,SET(0,1),SNAP,BURST,SET(0,-2),SNAP,BURST,SET(0,48000),SNAP,BURST,SET(0,NAN_),SNAP,BURST,SET(0,0.7),SNAP,BURST,END};
static const double ch_depth[] = {INIT(0,48000),SNAP,SET(1,-1),SNAP,BURST,SET(1,0),SNAP,BURST,SET(1,1),SNAP,BURST,SET(1,2),SNAP,BURST,SET(1,NAN_),SNAP,BURST,SET(1,0.4),SNAP,BURST,END};
static const double ch_delay[] = {INIT(0,48000),SNAP,SET(2,-2),SNAP,BURST,SET(2,0),SNAP,BURST,SET(2,0.1),SNAP,BURST,SET(2,15),SNAP,BURST,SET(2,100),SNAP,BURST,SET(2,NAN_),SNAP,BURST,SET(2,5),SNAP,BURST,END};
static const double ch_voices[] = {INIT(0,48000),SNAP,SET(3,-1),SNAP,BURST,SET(3,1),SNAP,BURST,SET(3,1.5),SNAP,BURST,SET(3,2.5),SNAP,BURST,SET(3,4),SNAP,BURST,SET(3,NAN_),SNAP,BURST,SET(3,3),SNAP,BURST,END};
static const double ch_spread[] = {INIT(0,48000),SNAP,SET(4,-1),SNAP,BURST,SET(4,0),SNAP,BURST,SET(4,0.5),SNAP,BURST,SET(4,1),SNAP,BURST,SET(4,2),SNAP,BURST,SET(4,NAN_),SNAP,BURST,SET(4,0.25),SNAP,BURST,END};
static const double ch_feedback[] = {INIT(0,48000),SNAP,GAIN(0.1),SET(5,-2),SNAP,BURST,SET(5,-0.95),SNAP,BURST,SET(5,0),SNAP,BURST,SET(5,0.9),SNAP,BURST,SET(5,2),SNAP,BURST,SET(5,NAN_),SNAP,BURST,SET(5,0.3),SNAP,BURST,END};
static const double ch_reset[] = {INIT(0,48000),BURST,SNAP,RESET,SNAP,BURST,RESET,SNAP,END};
static const double ch_alias[] = {INIT(0,48000),MONO(8,64,NOISE),MONO(3,64,ZERO),SNAP,END};
static const double ch_blocks[] = {INIT(0,48000),PROC(2,0,NOISE,RAMP),PROC(1,-3,ZERO,ZERO),PROC(6,1,NOISE,RAMP),PROC(5,7,STEP,NOISE),PROC(1,4096,NOISE,RAMP),SNAP,END};
static const double ch_rates[] = {INIT(0,4500.3),BURST,SNAP,INIT(0,44100),BURST,SNAP,INIT(0,96000),BURST,SNAP,END};
static const double ch_unknown[] = {INIT(0,48000),SET(-1,5),SET(99,5),BURST,SNAP,END};
static const double ch_poke[] = {INIT(0,48000),POKE(0,3,NAN_),POKE(1,20,INF_),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),PROC(3,64,NOISE,RAMP),SNAP,RESET,BURST,END};
static const double fl_default[] = {INIT(1,48000),SNAP,BURST,SNAP,END};
static const double fl_rate[] = {INIT(1,48000),SNAP,SET(0,0),SNAP,BURST,SET(0,1),SNAP,BURST,SET(0,-2),SNAP,BURST,SET(0,48000),SNAP,BURST,SET(0,NAN_),SNAP,BURST,SET(0,0.7),SNAP,BURST,END};
static const double fl_depth[] = {INIT(1,48000),SNAP,SET(1,-1),SNAP,BURST,SET(1,0),SNAP,BURST,SET(1,1),SNAP,BURST,SET(1,2),SNAP,BURST,SET(1,NAN_),SNAP,BURST,SET(1,0.4),SNAP,BURST,END};
static const double fl_delay[] = {INIT(1,48000),SNAP,SET(2,-2),SNAP,BURST,SET(2,0),SNAP,BURST,SET(2,0.1),SNAP,BURST,SET(2,15),SNAP,BURST,SET(2,100),SNAP,BURST,SET(2,NAN_),SNAP,BURST,SET(2,5),SNAP,BURST,END};
static const double fl_feedback[] = {INIT(1,48000),SNAP,GAIN(0.1),SET(3,-2),SNAP,BURST,SET(3,-0.95),SNAP,BURST,SET(3,0),SNAP,BURST,SET(3,0.9),SNAP,BURST,SET(3,2),SNAP,BURST,SET(3,NAN_),SNAP,BURST,SET(3,0.3),SNAP,BURST,END};
static const double fl_invert[] = {INIT(1,48000),SNAP,SET(4,0),SNAP,BURST,SET(4,0.49999999999999994),SNAP,BURST,SET(4,0.5),SNAP,BURST,SET(4,NAN_),SNAP,BURST,SET(4,1),SNAP,BURST,END};
static const double fl_damp[] = {INIT(1,48000),SNAP,SET(5,-1),SNAP,BURST,SET(5,20),SNAP,BURST,SET(5,8000),SNAP,BURST,SET(5,40000),SNAP,BURST,SET(5,NAN_),SNAP,BURST,SET(5,1000),SNAP,BURST,END};
static const double fl_stereo[] = {INIT(1,48000),SNAP,SET(6,-1),SNAP,BURST,SET(6,0),SNAP,BURST,SET(6,0.5),SNAP,BURST,SET(6,1),SNAP,BURST,SET(6,2),SNAP,BURST,SET(6,NAN_),SNAP,BURST,SET(6,0.25),SNAP,BURST,END};
static const double fl_shape[] = {INIT(1,48000),SNAP,SET(0,24000),SET(7,0),SNAP,BURST,SET(7,1),SNAP,BURST,SET(7,2),SNAP,BURST,SET(7,3),SNAP,BURST,SET(7,4),SNAP,BURST,SET(7,4.5),SNAP,BURST,SET(7,-0.5),SNAP,BURST,SET(7,NAN_),SNAP,BURST,SET(7,INF_),SNAP,BURST,SET(7,0),SNAP,BURST,END};
static const double fl_reset[] = {INIT(1,48000),BURST,SNAP,RESET,SNAP,BURST,RESET,SNAP,END};
static const double fl_alias[] = {INIT(1,48000),MONO(8,64,NOISE),MONO(3,64,ZERO),SNAP,END};
static const double fl_blocks[] = {INIT(1,48000),PROC(2,0,NOISE,RAMP),PROC(1,-3,ZERO,ZERO),PROC(6,1,NOISE,RAMP),PROC(5,7,STEP,NOISE),PROC(1,4096,NOISE,RAMP),SNAP,END};
static const double fl_rates[] = {INIT(1,4500.3),BURST,SNAP,INIT(1,44100),BURST,SNAP,INIT(1,96000),BURST,SNAP,END};
static const double fl_unknown[] = {INIT(1,48000),SET(-1,5),SET(99,5),BURST,SNAP,END};
static const double fl_poke[] = {INIT(1,48000),POKE(0,3,NAN_),POKE(1,20,INF_),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),PROC(3,64,NOISE,RAMP),SNAP,RESET,BURST,END};
static const double ph_default[] = {INIT(2,48000),SNAP,BURST,SNAP,END};
static const double ph_rate[] = {INIT(2,48000),SNAP,SET(0,0),SNAP,BURST,SET(0,1),SNAP,BURST,SET(0,-2),SNAP,BURST,SET(0,48000),SNAP,BURST,SET(0,NAN_),SNAP,BURST,SET(0,0.7),SNAP,BURST,END};
static const double ph_depth[] = {INIT(2,48000),SNAP,SET(1,-1),SNAP,BURST,SET(1,0),SNAP,BURST,SET(1,1),SNAP,BURST,SET(1,2),SNAP,BURST,SET(1,NAN_),SNAP,BURST,SET(1,0.4),SNAP,BURST,END};
static const double ph_center[] = {INIT(2,48000),SNAP,SET(2,-1),SNAP,BURST,SET(2,40),SNAP,BURST,SET(2,800),SNAP,BURST,SET(2,40000),SNAP,BURST,SET(2,NAN_),SNAP,BURST,SET(2,1000),SNAP,BURST,END};
static const double ph_stages[] = {INIT(2,48000),SNAP,SET(3,-1),SNAP,BURST,SET(3,1),SNAP,BURST,SET(3,1.5),SNAP,BURST,SET(3,7.5),SNAP,BURST,SET(3,9),SNAP,BURST,SET(3,NAN_),SNAP,BURST,SET(3,4),SNAP,BURST,END};
static const double ph_feedback[] = {INIT(2,48000),SNAP,GAIN(0.1),SET(4,-2),SNAP,BURST,SET(4,-0.95),SNAP,BURST,SET(4,0),SNAP,BURST,SET(4,0.9),SNAP,BURST,SET(4,2),SNAP,BURST,SET(4,NAN_),SNAP,BURST,SET(4,0.3),SNAP,BURST,END};
static const double ph_q[] = {INIT(2,48000),SNAP,SET(5,-1),SNAP,BURST,SET(5,0.2),SNAP,BURST,SET(5,0.7),SNAP,BURST,SET(5,4),SNAP,BURST,SET(5,NAN_),SNAP,BURST,SET(5,1),SNAP,BURST,END};
static const double ph_stereo[] = {INIT(2,48000),SNAP,SET(6,-1),SNAP,BURST,SET(6,0),SNAP,BURST,SET(6,0.5),SNAP,BURST,SET(6,1),SNAP,BURST,SET(6,2),SNAP,BURST,SET(6,NAN_),SNAP,BURST,SET(6,0.25),SNAP,BURST,END};
static const double ph_shape[] = {INIT(2,48000),SNAP,SET(0,24000),SET(7,0),SNAP,BURST,SET(7,1),SNAP,BURST,SET(7,2),SNAP,BURST,SET(7,3),SNAP,BURST,SET(7,4),SNAP,BURST,SET(7,4.5),SNAP,BURST,SET(7,-0.5),SNAP,BURST,SET(7,NAN_),SNAP,BURST,SET(7,INF_),SNAP,BURST,SET(7,0),SNAP,BURST,END};
static const double ph_reset[] = {INIT(2,48000),BURST,SNAP,RESET,SNAP,BURST,RESET,SNAP,END};
static const double ph_alias[] = {INIT(2,48000),MONO(8,64,NOISE),MONO(3,64,ZERO),SNAP,END};
static const double ph_blocks[] = {INIT(2,48000),PROC(2,0,NOISE,RAMP),PROC(1,-3,ZERO,ZERO),PROC(6,1,NOISE,RAMP),PROC(5,7,STEP,NOISE),PROC(1,4096,NOISE,RAMP),SNAP,END};
static const double ph_rates[] = {INIT(2,4500.3),BURST,SNAP,INIT(2,44100),BURST,SNAP,INIT(2,96000),BURST,SNAP,END};
static const double ph_unknown[] = {INIT(2,48000),SET(-1,5),SET(99,5),BURST,SNAP,END};
static const double ph_poke[] = {INIT(2,48000),POKE(0,3,NAN_),POKE(1,20,INF_),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),PROC(3,64,NOISE,RAMP),SNAP,RESET,BURST,END};
static const double tr_default[] = {INIT(3,48000),SNAP,BURST,SNAP,END};
static const double tr_rate[] = {INIT(3,48000),SNAP,SET(0,0),SNAP,BURST,SET(0,1),SNAP,BURST,SET(0,-2),SNAP,BURST,SET(0,48000),SNAP,BURST,SET(0,NAN_),SNAP,BURST,SET(0,0.7),SNAP,BURST,END};
static const double tr_depth[] = {INIT(3,48000),SNAP,SET(1,-1),SNAP,BURST,SET(1,0),SNAP,BURST,SET(1,1),SNAP,BURST,SET(1,2),SNAP,BURST,SET(1,NAN_),SNAP,BURST,SET(1,0.4),SNAP,BURST,END};
static const double tr_shape[] = {INIT(3,48000),SNAP,SET(0,24000),SET(2,0),SNAP,BURST,SET(2,1),SNAP,BURST,SET(2,2),SNAP,BURST,SET(2,3),SNAP,BURST,SET(2,4),SNAP,BURST,SET(2,4.5),SNAP,BURST,SET(2,-0.5),SNAP,BURST,SET(2,NAN_),SNAP,BURST,SET(2,INF_),SNAP,BURST,SET(2,0),SNAP,BURST,END};
static const double tr_mode[] = {INIT(3,48000),SNAP,SET(3,0),SNAP,BURST,SET(3,0.49999999999999994),SNAP,BURST,SET(3,0.5),SNAP,BURST,SET(3,1),SNAP,BURST,SET(3,2),SNAP,BURST,SET(3,NAN_),SNAP,BURST,SET(3,0),SNAP,BURST,END};
static const double tr_phase[] = {INIT(3,48000),SNAP,SET(4,-1),SNAP,BURST,SET(4,0),SNAP,BURST,SET(4,0.5),SNAP,BURST,SET(4,1),SNAP,BURST,SET(4,2),SNAP,BURST,SET(4,NAN_),SNAP,BURST,SET(4,0.25),SNAP,BURST,END};
static const double tr_reset[] = {INIT(3,48000),BURST,SNAP,RESET,SNAP,BURST,RESET,SNAP,END};
static const double tr_alias[] = {INIT(3,48000),MONO(8,64,NOISE),MONO(3,64,ZERO),SNAP,END};
static const double tr_blocks[] = {INIT(3,48000),PROC(2,0,NOISE,RAMP),PROC(1,-3,ZERO,ZERO),PROC(6,1,NOISE,RAMP),PROC(5,7,STEP,NOISE),PROC(1,4096,NOISE,RAMP),SNAP,END};
static const double tr_rates[] = {INIT(3,4500.3),BURST,SNAP,INIT(3,44100),BURST,SNAP,INIT(3,96000),BURST,SNAP,END};
static const double tr_unknown[] = {INIT(3,48000),SET(-1,5),SET(99,5),BURST,SNAP,END};
static const double tr_poke[] = {INIT(3,48000),POKE(0,3,NAN_),POKE(1,20,INF_),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),PROC(3,64,NOISE,RAMP),SNAP,RESET,BURST,END};
static const double rm_default[] = {INIT(4,48000),SNAP,BURST,SNAP,END};
static const double rm_freq[] = {INIT(4,48000),SNAP,SET(0,-400),SNAP,BURST,SET(0,0),SNAP,BURST,SET(0,200),SNAP,BURST,SET(0,24000),SNAP,BURST,SET(0,NAN_),SNAP,BURST,SET(0,INF_),SNAP,BURST,SET(0,-10),SNAP,BURST,END};
static const double rm_shape[] = {INIT(4,48000),SNAP,SET(1,0),SNAP,BURST,SET(1,1),SNAP,BURST,SET(1,2),SNAP,BURST,SET(1,3),SNAP,BURST,SET(1,4),SNAP,BURST,SET(1,4.5),SNAP,BURST,SET(1,-0.5),SNAP,BURST,SET(1,NAN_),SNAP,BURST,SET(1,INF_),SNAP,BURST,SET(1,0),SNAP,BURST,END};
static const double rm_mode[] = {INIT(4,48000),SNAP,SET(2,0),SNAP,BURST,SET(2,0.49999999999999994),SNAP,BURST,SET(2,0.5),SNAP,BURST,SET(2,1),SNAP,BURST,SET(2,2),SNAP,BURST,SET(2,NAN_),SNAP,BURST,SET(2,0),SNAP,BURST,END};
static const double rm_sweeprate[] = {INIT(4,48000),SNAP,SET(3,0),SNAP,BURST,SET(3,5),SNAP,BURST,SET(3,-1),SNAP,BURST,SET(3,48000),SNAP,BURST,SET(3,NAN_),SNAP,BURST,SET(3,1),SNAP,BURST,END};
static const double rm_sweepdepth[] = {INIT(4,48000),SNAP,SET(4,0),SNAP,BURST,SET(4,0.001),SNAP,BURST,SET(4,0.0010000000000000002),SNAP,BURST,SET(4,1),SNAP,BURST,SET(4,2),SNAP,BURST,SET(4,-1),SNAP,BURST,SET(4,NAN_),SNAP,BURST,SET(4,0.3),SNAP,BURST,END};
static const double rm_reset[] = {INIT(4,48000),BURST,SNAP,RESET,SNAP,BURST,RESET,SNAP,END};
static const double rm_alias[] = {INIT(4,48000),MONO(8,64,NOISE),MONO(3,64,ZERO),SNAP,END};
static const double rm_blocks[] = {INIT(4,48000),PROC(2,0,NOISE,RAMP),PROC(1,-3,ZERO,ZERO),PROC(6,1,NOISE,RAMP),PROC(5,7,STEP,NOISE),PROC(1,4096,NOISE,RAMP),SNAP,END};
static const double rm_rates[] = {INIT(4,4500.3),BURST,SNAP,INIT(4,44100),BURST,SNAP,INIT(4,96000),BURST,SNAP,END};
static const double rm_unknown[] = {INIT(4,48000),SET(-1,5),SET(99,5),BURST,SNAP,END};
static const double rm_poke[] = {INIT(4,48000),POKE(0,3,NAN_),POKE(1,20,INF_),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),PROC(3,64,NOISE,RAMP),SNAP,RESET,BURST,END};
static const double fs_default[] = {INIT(5,48000),SNAP,BURST,SNAP,END};
static const double fs_freq[] = {INIT(5,48000),SNAP,SET(0,-400),SNAP,BURST,SET(0,0),SNAP,BURST,SET(0,200),SNAP,BURST,SET(0,24000),SNAP,BURST,SET(0,NAN_),SNAP,BURST,SET(0,INF_),SNAP,BURST,SET(0,-10),SNAP,BURST,END};
static const double fs_feedback[] = {INIT(5,48000),SNAP,GAIN(0.1),SET(1,-2),SNAP,BURST,SET(1,-0.95),SNAP,BURST,SET(1,0),SNAP,BURST,SET(1,0.9),SNAP,BURST,SET(1,2),SNAP,BURST,SET(1,NAN_),SNAP,BURST,SET(1,0.3),SNAP,BURST,END};
static const double fs_reset[] = {INIT(5,48000),BURST,SNAP,RESET,SNAP,BURST,RESET,SNAP,END};
static const double fs_alias[] = {INIT(5,48000),MONO(8,64,NOISE),MONO(3,64,ZERO),SNAP,END};
static const double fs_blocks[] = {INIT(5,48000),PROC(2,0,NOISE,RAMP),PROC(1,-3,ZERO,ZERO),PROC(6,1,NOISE,RAMP),PROC(5,7,STEP,NOISE),PROC(1,4096,NOISE,RAMP),SNAP,END};
static const double fs_rates[] = {INIT(5,4500.3),BURST,SNAP,INIT(5,44100),BURST,SNAP,INIT(5,96000),BURST,SNAP,END};
static const double fs_unknown[] = {INIT(5,48000),SET(-1,5),SET(99,5),BURST,SNAP,END};
static const double fs_poke[] = {INIT(5,48000),POKE(0,3,NAN_),POKE(1,20,INF_),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),PROC(3,64,NOISE,RAMP),SNAP,RESET,BURST,END};
static const double rm_switch[] = {INIT(4,48000),SET(4,1),SET(3,20),BURST,SET(1,1),BURST,SET(1,2),BURST,SET(1,0),BURST,SNAP,END};
static const double tr_mode_phase[] = {INIT(3,48000),SET(4,0),SET(3,1),BURST,SET(3,0),BURST,SNAP,END};
static const double rm_sweep_edge[] = {INIT(4,48000),SET(3,20),SET(4,0.001),BURST,SNAP,SET(4,0.0010000000000000002),BURST,SNAP,END};
static const double fl_internal_rng[] = {O(OP_INIT,1,48000,1,0),SET(0,24000),SET(7,4),BURST,SNAP,RESET,BURST,SNAP,END};
static const double ph_internal_rng[] = {O(OP_INIT,2,48000,1,0),SET(0,24000),SET(7,4),BURST,SNAP,RESET,BURST,SNAP,END};
static const double tr_internal_rng[] = {O(OP_INIT,3,48000,1,0),SET(0,24000),SET(2,4),BURST,SNAP,RESET,BURST,SNAP,END};
static const double fs_feedback_reset[] = {INIT(5,48000),SET(0,-300),SET(1,0.8),PROC(40,64,NOISE,RAMP),RESET,SNAP,PROC(8,64,NOISE,RAMP),SNAP,END};
#define S(n) {#n,n,sizeof(n)/sizeof(n[0])}
typedef struct { const char *name; const double *ops; size_t n; } script;
static const script scripts[] = {S(ch_default),S(ch_rate),S(ch_depth),S(ch_delay),S(ch_voices),S(ch_spread),S(ch_feedback),S(ch_reset),S(ch_alias),S(ch_blocks),S(ch_rates),S(ch_unknown),S(ch_poke),S(fl_default),S(fl_rate),S(fl_depth),S(fl_delay),S(fl_feedback),S(fl_invert),S(fl_damp),S(fl_stereo),S(fl_shape),S(fl_reset),S(fl_alias),S(fl_blocks),S(fl_rates),S(fl_unknown),S(fl_poke),S(ph_default),S(ph_rate),S(ph_depth),S(ph_center),S(ph_stages),S(ph_feedback),S(ph_q),S(ph_stereo),S(ph_shape),S(ph_reset),S(ph_alias),S(ph_blocks),S(ph_rates),S(ph_unknown),S(ph_poke),S(tr_default),S(tr_rate),S(tr_depth),S(tr_shape),S(tr_mode),S(tr_phase),S(tr_reset),S(tr_alias),S(tr_blocks),S(tr_rates),S(tr_unknown),S(tr_poke),S(rm_default),S(rm_freq),S(rm_shape),S(rm_mode),S(rm_sweeprate),S(rm_sweepdepth),S(rm_reset),S(rm_alias),S(rm_blocks),S(rm_rates),S(rm_unknown),S(rm_poke),S(fs_default),S(fs_freq),S(fs_feedback),S(fs_reset),S(fs_alias),S(fs_blocks),S(fs_rates),S(fs_unknown),S(fs_poke),S(rm_switch),S(tr_mode_phase),S(rm_sweep_edge),S(fl_internal_rng),S(ph_internal_rng),S(tr_internal_rng),S(fs_feedback_reset)};

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
