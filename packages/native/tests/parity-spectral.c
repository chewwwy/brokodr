/* Bro.Kodr spectral (PitchFormant) parity producer; replayed by verify-spectral-parity.mjs. */
#include "brokodr/dsp/spectral.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

enum {
  OP_END = 0,
  OP_INIT = 1,    /* a = type (0 only: pitch), b = sample rate */
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

/* The effect is one fixed struct; a trailing canary catches a write past
   its last array. Intra-struct overruns show up as parity failures. */
#define CANARY 64
static struct { bk_pitch_formant e; float canary[CANARY]; } g_box;
static void check_canary(void) {
  int k;
  for (k = 0; k < CANARY; k++) {
    if (g_box.canary[k] != 1234.5f) {
      fprintf(stderr, "write past the bk_pitch_formant struct at %d\n", k);
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


/* Per-block scalars. A degenerate (quality NaN) instance reports its
   undefined JS fields as NaN; latency is what the chain reads (0). */
static void block_state(void) {
  const bk_pitch_formant *e = &g_box.e;
  int c;
  push64(g_vt->meter(g_fx));
  push64((double)g_vt->latency_samples(g_fx));
  push64(e->degenerate ? NAN : (double)e->fft_size);
  push64(e->pitch_st); push64(e->fine_cents); push64(e->formant_st);
  push64((double)e->preserve); push64(e->lifter);
  smoother_state(&e->pitch_sm); smoother_state(&e->formant_sm);
  push64(e->jitter); push64(e->shimmer);
  push64(e->rng >= 0x80000000u ? (double)e->rng - 4294967296.0 : (double)e->rng);
  push64(e->jit_walk); push64(e->shim_walk);
  smoother_state(&e->jit_sm); smoother_state(&e->shim_sm);
  for (c = 0; c < 2; c++) {
    const bk_pv_channel *p = &e->ch[c];
    push64(e->degenerate ? NAN : (double)p->n);
    push64((double)p->half); push64((double)p->hop);
    push64(p->freq_per_bin); push64(p->expct);
    push64(e->degenerate ? NAN : (double)p->rw);
  }
}
static void arr32(const float *a, int n) { int i; for (i = 0; i < n; i++) push32(a[i]); }
/* Full snapshot: scalars plus every float array the JS channel owns. */
static void snap_state(void) {
  const bk_pitch_formant *e = &g_box.e;
  int c, i;
  block_state();
  for (c = 0; c < 2; c++) {
    const bk_pv_channel *p = &e->ch[c];
    const int n = p->n, h = p->half + 1;
    arr32(p->cos_t, p->half); arr32(p->sin_t, p->half);
    for (i = 0; i < n; i++) push32((float)p->rev[i]);
    arr32(p->window, n);
    arr32(p->in_fifo, n); arr32(p->out_fifo, n); arr32(p->out_accum, 2 * n);
    arr32(p->re, n); arr32(p->im, n);
    arr32(p->last_phase, h); arr32(p->sum_phase, h);
    arr32(p->ana_magn, h); arr32(p->ana_freq, h);
    arr32(p->syn_magn, h); arr32(p->syn_freq, h);
    arr32(p->excite, h); arr32(p->env_shift, h);
    arr32(p->cep_re, n); arr32(p->cep_im, n); arr32(p->cep_env, h);
  }
}

static double unsentinel(double v) {
  if (v == NAN_) return (double)NAN;
  if (v == INF_) return (double)INFINITY;
  if (v == NINF_) return -(double)INFINITY;
  return v;
}


static void vt_flags(void) {
  /* What the chain will see: no carrier bus, a latency, a meter. */
  push64(g_vt->set_carrier_bus == NULL ? 1.0 : 0.0);
  push64(g_vt->latency_samples == NULL ? 1.0 : 0.0);
  push64(g_vt->meter == NULL ? 1.0 : 0.0);
}

static void init_fx(int type, double sr) {
  int k;
  g_type = type;
  for (k = 0; k < CANARY; k++) g_box.canary[k] = 1234.5f;
  bk_pitch_formant_init(&g_box.e, sr);
  g_fx = &g_box.e;
  g_vt = &bk_pitch_formant_vt;
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
#define INIT(sr) O(OP_INIT,0,sr,0,0)
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
/* 1024-point STFT: latency 1024, hop 256. LONG passes 4096 samples. */
#define LONG PROC(20,128,NOISE,RAMP),PROC(6,128,STEP,IMP),PROC(6,128,ZERO,NOISE)
#define SHORT PROC(12,128,NOISE,RAMP)
static const double pf_default[] = {INIT(48000),SNAP,LONG,SNAP,END};
static const double pf_pitch[] = {INIT(48000),SET(0,-24),SHORT,SET(0,-12),SHORT,SET(0,7),SHORT,SET(0,12),SHORT,SET(0,24),SHORT,SET(0,0.5),SHORT,SET(0,0),SHORT,SNAP,END};
static const double pf_fine[] = {INIT(48000),SET(0,3),SET(1,-100),SHORT,SET(1,50),SHORT,SET(1,100),SHORT,SET(1,0),SHORT,SNAP,END};
static const double pf_formant[] = {INIT(48000),SET(2,-12),SHORT,SET(2,5),SHORT,SET(2,12),SHORT,SET(2,0.0001),SHORT,SET(2,0),SHORT,SNAP,END};
static const double pf_formant_nopreserve[] = {INIT(48000),SET(3,0),SET(0,5),SET(2,-7),SHORT,SET(2,7),SHORT,SET(2,0),SHORT,SNAP,END};
static const double pf_preserve[] = {INIT(48000),SET(0,7),SET(3,0),SHORT,SET(3,0.49999999999999994),SHORT,SET(3,0.5),SHORT,SET(3,1),SHORT,SET(3,-1),SHORT,SNAP,END};
static const double pf_lifter[] = {INIT(48000),SET(2,4),SET(4,8),SHORT,SET(4,7.5),SHORT,SET(4,40.4),SHORT,SET(4,40.5),SHORT,SET(4,120.6),SHORT,SET(4,200),SHORT,SET(4,-5),SHORT,SET(4,2),SHORT,SET(4,0),SHORT,SNAP,END};
static const double pf_jitter[] = {INIT(48000),SET(6,0),SHORT,SET(6,50),SHORT,SET(6,100),SHORT,SET(6,200),SHORT,SET(6,-5),SHORT,SET(6,30),SHORT,SNAP,END};
static const double pf_shimmer[] = {INIT(48000),SET(7,0),SHORT,SET(7,50),SHORT,SET(7,100),SHORT,SET(7,200),SHORT,SET(7,-5),SHORT,SET(7,30),SHORT,SNAP,END};
static const double pf_quality[] = {INIT(48000),SET(0,-5),SET(5,0),SHORT,SET(5,2),SHORT,SET(5,3),SHORT,SET(5,1),SHORT,SET(5,-1),SHORT,SET(5,4),SHORT,SET(5,0.5),SHORT,SET(5,2.49),SHORT,SET(5,2.5),SHORT,SET(5,-0.4),SHORT,SET(5,1),SHORT,SNAP,END};
static const double pf_pitch_nan[] = {INIT(48000),SET(0,NAN_),LONG,SNAP,END};
static const double pf_pitch_inf[] = {INIT(48000),SET(0,INF_),LONG,SNAP,END};
static const double pf_pitch_ninf[] = {INIT(48000),SET(0,NINF_),LONG,SNAP,END};
static const double pf_pitch_huge[] = {INIT(48000),SET(0,1000),LONG,SNAP,END};
static const double pf_pitch_tiny[] = {INIT(48000),SET(0,-1000),LONG,SNAP,END};
static const double pf_pitch_wrap[] = {INIT(48000),SET(0,430),LONG,SNAP,END};
static const double pf_fine_nan[] = {INIT(48000),SET(1,NAN_),LONG,SNAP,END};
static const double pf_formant_nan[] = {INIT(48000),SET(2,NAN_),LONG,SNAP,END};
static const double pf_formant_inf[] = {INIT(48000),SET(2,INF_),LONG,SNAP,END};
static const double pf_formant_ninf[] = {INIT(48000),SET(2,NINF_),LONG,SNAP,END};
static const double pf_preserve_nan[] = {INIT(48000),SET(3,NAN_),LONG,SNAP,END};
static const double pf_lifter_nan[] = {INIT(48000),SET(2,3),SET(4,NAN_),LONG,SNAP,END};
static const double pf_jitter_nan[] = {INIT(48000),SET(6,NAN_),LONG,SNAP,END};
static const double pf_shimmer_nan[] = {INIT(48000),SET(7,NAN_),LONG,SNAP,END};
static const double pf_jitter_inf[] = {INIT(48000),SET(6,INF_),LONG,SNAP,END};
static const double pf_env_pitch[] = {INIT(48000),SET(0,5),SET(4,30),LONG,SNAP,END};
static const double pf_env_both[] = {INIT(48000),SET(0,-7),SET(2,4),SET(6,40),SET(7,40),LONG,SNAP,END};
static const double pf_size512[] = {INIT(48000),SET(5,0),SET(0,12),SET(2,-3),LONG,SNAP,END};
static const double pf_size2048[] = {INIT(48000),SET(5,2),SET(0,-12),PROC(40,128,NOISE,RAMP),SNAP,END};
static const double pf_size4096[] = {INIT(48000),SET(5,3),SET(0,4),SET(2,2),PROC(80,128,NOISE,RAMP),SNAP,END};
static const double pf_same_size[] = {INIT(48000),SHORT,SET(5,1),SET(5,1.4),SNAP,SHORT,SET(5,0),SHORT,SET(5,0.2),SNAP,END};
static const double pf_degenerate[] = {INIT(48000),SHORT,SET(5,NAN_),SNAP,SHORT,SET(5,NAN_),RESET,SNAP,SET(6,40),SET(7,40),SHORT,SET(5,1),SNAP,LONG,SNAP,END};
static const double pf_degenerate_shimnan[] = {INIT(48000),SET(5,NAN_),SET(7,NAN_),SHORT,SET(5,INF_),LONG,SNAP,END};
static const double pf_reset[] = {INIT(48000),LONG,SNAP,RESET,SNAP,LONG,RESET,SNAP,END};
static const double pf_alias[] = {INIT(48000),SET(0,3),SET(2,2),MONO(30,128,NOISE),MONO(4,128,ZERO),SNAP,END};
static const double pf_blocks[] = {INIT(48000),PROC(2,0,NOISE,RAMP),PROC(1,-3,ZERO,ZERO),PROC(300,1,NOISE,RAMP),PROC(50,7,STEP,NOISE),PROC(1,4096,NOISE,RAMP),SNAP,END};
static const double pf_rates[] = {INIT(4500.3),SET(0,5),LONG,SNAP,INIT(44100),SET(2,3),LONG,SNAP,INIT(96000),SET(0,-3),LONG,SNAP,END};
static const double pf_unknown[] = {INIT(48000),SET(-1,5),SET(8,5),SET(99,5),SHORT,SNAP,END};
static const double pf_poke[] = {INIT(48000),SET(0,2),SET(2,1),PROC(9,128,NOISE,RAMP),POKE(0,3,NAN_),POKE(1,20,INF_),PROC(1,128,NOISE,RAMP),POKE(0,30,NINF_),POKE(1,31,1e30),POKE(0,32,1e-40),POKE(0,33,-0.0),PROC(12,128,NOISE,RAMP),SNAP,RESET,LONG,SNAP,END};
static const double pf_poke_finite[] = {INIT(48000),POKE(0,5,1e30),POKE(1,6,-1e30),POKE(0,7,1e-40),LONG,SNAP,END};
static const double pf_gain[] = {INIT(48000),GAIN(1e-20),SET(0,3),LONG,GAIN(1000),LONG,SNAP,END};
static const double pf_dc[] = {INIT(48000),LEVEL(0.5),SET(2,5),PROC(30,128,DC,DC),SNAP,END};
static const double pf_rng_long[] = {INIT(48000),SET(6,100),SET(7,100),PROC(400,1,ZERO,ZERO),PROC(200,0,ZERO,ZERO),SNAP,END};
/* k * ratio overflows to +inf for k >= 4 once the smoother passes 2^1022: inf | 0 is 0. */
static const double pf_ratio_overflow[] = {INIT(48000),SET(0,12280),LONG,SNAP,END};
/* At sr 100 the pitch smoother converges to exactly 2^31 within the script (after the
   first block it is still 2147483647.99997...): k = 1 then lands on ToInt32(2^31) =
   -2^31 (a miss) and k = 2 on 2^32 -> 0. The exact case is confirmed by the
   float-cast-overflow sanitizer firing on the high-half mutant. */
static const double pf_ratio_2p31[] = {INIT(100),SET(0,372),LONG,SNAP,END};
/* A computed envelope, then quality NaN: the one-bin cep env must read 0. */
static const double pf_degenerate_env[] = {INIT(48000),SET(2,4),SHORT,SET(5,NAN_),SNAP,END};
/* Envelope ratio driven below 1e-2 (towards 2^-10), then below the 1e-4 floor. */
static const double pf_formant_floor[] = {INIT(48000),SET(3,0),SET(2,-120),PROC(100,128,NOISE,RAMP),SNAP,SET(2,-200),PROC(100,128,NOISE,RAMP),SNAP,END};
#define S(n) {#n,n,sizeof(n)/sizeof(n[0])}
typedef struct { const char *name; const double *ops; size_t n; } script;
static const script scripts[] = {S(pf_default),S(pf_pitch),S(pf_fine),S(pf_formant),S(pf_formant_nopreserve),S(pf_preserve),S(pf_lifter),S(pf_jitter),S(pf_shimmer),S(pf_quality),S(pf_pitch_nan),S(pf_pitch_inf),S(pf_pitch_ninf),S(pf_pitch_huge),S(pf_pitch_tiny),S(pf_pitch_wrap),S(pf_fine_nan),S(pf_formant_nan),S(pf_formant_inf),S(pf_formant_ninf),S(pf_preserve_nan),S(pf_lifter_nan),S(pf_jitter_nan),S(pf_shimmer_nan),S(pf_jitter_inf),S(pf_env_pitch),S(pf_env_both),S(pf_size512),S(pf_size2048),S(pf_size4096),S(pf_same_size),S(pf_degenerate),S(pf_degenerate_shimnan),S(pf_reset),S(pf_alias),S(pf_blocks),S(pf_rates),S(pf_unknown),S(pf_poke),S(pf_poke_finite),S(pf_gain),S(pf_dc),S(pf_rng_long),S(pf_ratio_overflow),S(pf_ratio_2p31),S(pf_degenerate_env),S(pf_formant_floor)};

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
