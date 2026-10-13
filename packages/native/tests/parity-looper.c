/*
 * Parity dump for the C port of dsp/core/looper.js.
 *
 * Producer half of the oracle; scripts/verify-looper-parity.mjs is the
 * consumer. See parity-io.h for the stream format.
 *
 * The looper is the last module of the portable core and the one with the
 * most state: a per-track state machine, a scheduler that defers punches to an
 * absolute frame, two position models, a single shared undo slot, and caller-
 * owned buffers that the JS allocates lazily. The battery is a script VM in
 * the same shape as parity-drum-rack.c, and is built around five ideas:
 *
 * 1. THE CLOCK IS REAL, AND SOMETIMES ABSENT.
 *
 *    Control ops and PROCESS take a flag saying whether to pass the bk_clock
 *    or NULL, because the JS treats a null clock as "punch now, frame 0" and
 *    that is its own path through _schedule, _closeTake and _renderTrack.
 *    Stopping the clock (run = 0) while keeping a grid is how the battery
 *    gets a take of an arbitrary length closed with grid rounding: punches
 *    are immediate when the clock is not running, but _closeTake still rounds
 *    to clock.gridFrames.
 *
 * 2. THE BUFFERS ARE DUMPED, NOT INFERRED.
 *
 *    OP_BUFS pushes a track's buffer (or the undo slot) as the float32 it is
 *    stored as. Tail zeroing, both declick branches, the overdub sum and
 *    undo's single rounding are all buffer-content facts that audio only
 *    shows indirectly. For a buffer the JS has not allocated yet the consumer
 *    pushes zeros, which is exactly the claim in note 1 of looper.h: an
 *    unarmed buffer and a zeroed-and-untouched one are the same observation.
 *    `arm-never` and `arm-cleared` differ only in a REC+CLEAR pair, and the
 *    consumer asserts they render identically while buf_armed differs.
 *
 * 3. THE CHAIN EFFECT IS SYNTHETIC AND MIRRORED, as in parity-drum-rack.c.
 *
 * 4. THE DESTINATION IS PREFILLED, so the `+=` rounding is observable.
 *
 * 5. PUNCHES LAND MID-BLOCK ON PURPOSE. Grid lines are placed so that a
 *    scheduled punch fires part way through a block, and `block-256` /
 *    `block-64` render the same quantised performance at two block sizes so
 *    the consumer can assert sample-accuracy rather than infer it.
 *
 * Usage: parity-looper <out.bin>
 */

#include "brokodr/dsp/looper.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

#define SR 48000.0
#define MAX_BLOCK 256
#define DEF_SECONDS 0.26 /* 12480 frames at 48k: small enough to fill */
#define CAP_FRAMES 32768 /* largest max_frames any INIT in the battery asks for */
#define SRC_LEN 65536    /* power of two; the source stream wraps on it */
#define MAX_F64 400000
#define MAX_F32 1500000
#define MAX_EFFECTS 24
#define SNAP_SLOTS 2
#define UNSET (-1e9)
/* NaN in a static initialiser is not portable (MSVC); the VM maps this to NaN
   at run time, and the consumer does the same. */
#define NANV (-3e9)

enum {
  OP_END = 0,
  OP_INIT = 1,        /* a=sr, b=tracks, c=max_seconds. Re-inits looper AND clock. */
  OP_REC = 2,         /* a=track, b=pass clock */
  OP_PLAY = 3,        /* a=track, b=pass clock */
  OP_STOP = 4,        /* a=track, b=pass clock */
  OP_CLEAR = 5,       /* a=track */
  OP_CLEARALL = 6,
  OP_UNDO = 7,        /* a=track */
  OP_TPARAM = 8,      /* a=track, b=BK_LOOP_P_*, c=value */
  OP_PARAM = 9,       /* a=BK_LOOPER_P_*, b=value */
  OP_RESET = 10,
  OP_CLOCK = 11,      /* a=BK_CLOCK_P_*, b=value */
  OP_CLOCKADV = 12,   /* a=frames (respects running, as the engine's call does) */
  OP_CHAINFOR = 13,   /* a=track; pushes 1/0 */
  OP_CHAINADD = 14,   /* a=track, b=id, c=index, d=mix, e=bypassed; pushes 1/0 */
  OP_CHAINREMOVE = 15, /* a=track, b=id */
  OP_CHAINBYPASS = 16, /* a=track, b=id, c=on */
  OP_PROCESS = 17,    /* a=frames, b=count, c=src mode, d=prefill, e=flags */
  OP_SNAP = 18,
  OP_BUFS = 19,       /* a=track or -1 for the undo slot, b=frames (0 = max_frames) */
  OP_METERS = 20,     /* pushes the returned count, then the block */
  OP_QUERY = 21,      /* a=track */
  OP_MAXFRAMES = 22,  /* a=sr, b=seconds; pushes bk_looper_max_frames */
  OP_INITCHECK = 23   /* a=variant; pushes bk_looper_init's return on a probe */
};

/* PROCESS flags. */
#define PF_CLOCK 1   /* pass the clock (else NULL) */
#define PF_ADVANCE 2 /* bk_clock_advance(frames) after each block */
#define PF_BOTH 3

/* Source modes. Mirrored in the consumer. */
enum {
  SRC_NULL = 0,   /* the whole struct NULL */
  SRC_MASTER = 1, /* master only, drum members NULL */
  SRC_ALL = 2,    /* all four */
  SRC_DIRTY = 3,  /* all four, NaN/inf/-0 planted in master */
  SRC_HUGE = 4    /* all four, master lifted to ~4e29 */
};

enum { PRE_SILENT = 0, PRE_CONST = 1, PRE_NOISE = 2, PRE_NEGZERO = 3 };
enum { PK_GAIN = 0, PK_LATENCY = 1, PK_INERT = 2 };

static float trk_buf[BK_LOOP_TRACKS][2][CAP_FRAMES];
static float undo_buf[2][CAP_FRAMES];
static float scr_trk_l[MAX_BLOCK], scr_trk_r[MAX_BLOCK];
static float scr_bus_l[MAX_BLOCK], scr_bus_r[MAX_BLOCK];
static float scr_wet_l[MAX_BLOCK], scr_wet_r[MAX_BLOCK];
static float blk_l[MAX_BLOCK], blk_r[MAX_BLOCK];
static float src_ml[MAX_BLOCK], src_mr[MAX_BLOCK], src_dl[MAX_BLOCK], src_dr[MAX_BLOCK];
static double noise[SRC_LEN];
static double scratch[MAX_BLOCK];
static double meters[BK_LOOP_TRACKS * BK_LOOP_METER_STRIDE + 8];
static double pay64[MAX_F64];
static float pay32[MAX_F32];
static int src_cursor;

/* --- the stimulus ------------------------------------------------------- */

/*
 * Four different streams so a track recording the wrong source, or the wrong
 * channel, is visible. Every scale is an exact binary fraction, so the only
 * rounding is the one (float) narrowing both languages do.
 */
static void build_src(int frames, int mode) {
  int i;
  for (i = 0; i < frames; i++) {
    const int n = src_cursor + i;
    src_ml[i] = (float)(noise[n & (SRC_LEN - 1)] * 0.5);
    src_mr[i] = (float)(-0.25 * noise[(n + 7) & (SRC_LEN - 1)]);
    src_dl[i] = (float)((((double)(n % 256) / 128.0) - 1.0) * 0.375);
    src_dr[i] = (float)(0.125 * noise[(n + 13) & (SRC_LEN - 1)]);
    if (mode == SRC_HUGE) src_ml[i] = (float)(noise[n & (SRC_LEN - 1)] * 4e29);
  }
  if (mode == SRC_DIRTY) {
    if (frames > 5) src_ml[5] = (float)bk_test_nan();
    if (frames > 9) src_ml[9] = (float)1e40;
    if (frames > 11) src_ml[11] = -0.0f;
    if (frames > 17) src_mr[17] = (float)(-1e40);
  }
  src_cursor += frames;
}

static void prefill(int frames, int kind) {
  int i;
  if (kind == PRE_NOISE) {
    bk_fill_signal(scratch, (size_t)frames, BK_SIG_NOISE);
    for (i = 0; i < frames; i++) {
      blk_l[i] = (float)scratch[i];
      blk_r[i] = (float)(-scratch[i]);
    }
    return;
  }
  for (i = 0; i < frames; i++) {
    blk_l[i] = kind == PRE_CONST ? 0.25f : (kind == PRE_NEGZERO ? -0.0f : 0.0f);
    blk_r[i] = kind == PRE_CONST ? -0.5f : (kind == PRE_NEGZERO ? -0.0f : 0.0f);
  }
}

/* --- the test effect, identical to parity-drum-rack.c's ------------------ */

typedef struct {
  double gain;
  int latency;
  double zl, zr;
  int calls;
  int resets;
  double last_key;
  double last_value;
} tfx;

static void tfx_init(tfx *e, int id) {
  e->gain = 0.5 + 0.25 * (double)(id % 4);
  e->latency = (id % 3) * 8;
  e->zl = 0.0;
  e->zr = 0.0;
  e->calls = 0;
  e->resets = 0;
  e->last_key = -1.0;
  e->last_value = 0.0;
}

static void tfx_process(void *self, float *l, float *r, int frames) {
  tfx *e = (tfx *)self;
  int i;
  for (i = 0; i < frames; i++) {
    e->zl = e->zl * 0.5 + (double)l[i] * e->gain;
    e->zr = e->zr * 0.5 + (double)r[i] * e->gain;
    l[i] = (float)e->zl;
    r[i] = (float)e->zr;
  }
  e->calls++;
}

static void tfx_reset(void *self) {
  tfx *e = (tfx *)self;
  e->zl = 0.0;
  e->zr = 0.0;
  e->resets++;
}

static void tfx_set_param(void *self, int key, double value) {
  tfx *e = (tfx *)self;
  e->last_key = (double)key;
  e->last_value = value;
  if (key == PK_GAIN) e->gain = value;
  else if (key == PK_LATENCY) e->latency = (int)value;
}

static int tfx_latency(const void *self) { return ((const tfx *)self)->latency; }
static double tfx_meter(const void *self) { return ((const tfx *)self)->zl; }

/* No set_carrier_bus: a loop track's chain is never given one. */
static const bk_effect_vt VT = {tfx_process, tfx_reset, tfx_set_param, 0, tfx_latency, tfx_meter};

/* --- the script VM ------------------------------------------------------ */

typedef struct {
  double *p64;
  unsigned int n64;
  float *p32;
  unsigned int n32;
} sink;

static void push64(sink *s, double v) {
  if (s->n64 < MAX_F64) s->p64[s->n64++] = v;
}

static void push32(sink *s, float v) {
  if (s->n32 < MAX_F32) s->p32[s->n32++] = v;
}

/* After every op. An op that quietly did nothing moves this. */
static void push_state(sink *s, const bk_looper *lp, const bk_clock *ck) {
  int i;
  push64(s, bk_looper_active(lp) ? 1.0 : 0.0);
  push64(s, lp->meter_l);
  push64(s, lp->meter_r);
  push64(s, (double)lp->undo_track);
  push64(s, (double)lp->undo_frames);
  push64(s, (double)lp->undo_mode);
  push64(s, lp->undo_applied ? 1.0 : 0.0);
  push64(s, lp->undo_armed ? 1.0 : 0.0);
  /* `this.undoL !== null` in the JS. Note 1 of looper.h. */
  push64(s, lp->undo_armed_ever ? 1.0 : 0.0);
  push64(s, ck->frame);
  for (i = 0; i < lp->track_count; i++) {
    const bk_loop_track *t = &lp->tracks[i];
    push64(s, (double)t->state);
    push64(s, (double)t->pending);
    push64(s, (double)t->frames);
    push64(s, (double)t->rec_write);
    push64(s, (double)t->pos);
    push64(s, (double)t->layers);
    push64(s, t->meter);
    push64(s, t->pos_norm);
    push64(s, t->play_gain.value);
    /* `t.bufL !== null` in the JS. */
    push64(s, t->buf_armed ? 1.0 : 0.0);
  }
}

static void push_snap(sink *s, const bk_looper *lp, const bk_clock *ck) {
  int i, j, k;

  push64(s, lp->sr);
  push64(s, (double)lp->max_block);
  push64(s, lp->max_seconds);
  push64(s, (double)lp->max_frames);
  push64(s, (double)lp->declick);
  push64(s, (double)lp->track_count);
  push64(s, lp->gain_db);
  push64(s, lp->gain);
  push64(s, lp->muted ? 1.0 : 0.0);
  push64(s, ck->running ? 1.0 : 0.0);
  push64(s, ck->grid_frames);

  for (i = 0; i < lp->track_count; i++) {
    const bk_loop_track *t = &lp->tracks[i];
    const bk_chain *ch = &t->chain;
    push64(s, (double)t->index);
    push64(s, t->sr);
    push64(s, (double)t->max_block);
    push64(s, (double)t->max_frames);
    push64(s, t->pending_at);
    push64(s, t->anchor);
    push64(s, t->gain_db);
    push64(s, t->gain);
    push64(s, t->pan);
    push64(s, t->pan_l);
    push64(s, t->pan_r);
    push64(s, t->muted ? 1.0 : 0.0);
    push64(s, t->soloed ? 1.0 : 0.0);
    push64(s, t->sync ? 1.0 : 0.0);
    push64(s, (double)t->source);
    push64(s, t->play_gain.target);
    push64(s, t->play_gain.a);
    push64(s, (double)t->rec_ramp);
    push64(s, (double)t->last_write);
    /* `t.chain !== null`. Note 2 of looper.h is measured here. */
    push64(s, t->chain_used ? 1.0 : 0.0);
    push64(s, (double)bk_chain_length(ch));
    push64(s, (double)ch->latency_samples);
    for (j = 0; j < SNAP_SLOTS; j++) {
      if (j < ch->n_slots) {
        const bk_slot *sl = &ch->slots[j];
        const tfx *e = (const tfx *)sl->effect;
        push64(s, 1.0);
        push64(s, (double)sl->id);
        push64(s, (double)sl->bypassed);
        push64(s, (double)e->calls);
        push64(s, (double)e->resets);
        push64(s, e->zl);
        push64(s, e->zr);
        push64(s, e->gain);
      } else {
        for (k = 0; k < 8; k++) push64(s, 0.0);
      }
    }
  }
}

static bk_looper lp;
static bk_clock ck;
static tfx pool[MAX_EFFECTS];
static bk_looper probe;

/*
 * The C-only half of init: the argument checks the JS has no counterpart for
 * (it allocates its own buffers and builds whatever count it is given). Run on
 * a separate probe struct so the script's looper is untouched; the consumer
 * holds the expected return per variant in a table of its own, and every
 * variant is one argument away from an accepted call, so each check is
 * measured on its own.
 */
static int init_check(int variant) {
  bk_looper_buffers b;
  bk_looper *target = &probe;
  int i, tracks = BK_LOOP_TRACKS, max_block = MAX_BLOCK;
  double sr = SR;
  for (i = 0; i < BK_LOOP_TRACKS; i++) {
    b.track_l[i] = trk_buf[i][0];
    b.track_r[i] = trk_buf[i][1];
  }
  b.undo_l = undo_buf[0];
  b.undo_r = undo_buf[1];
  b.trk_l = scr_trk_l;
  b.trk_r = scr_trk_r;
  b.bus_l = scr_bus_l;
  b.bus_r = scr_bus_r;
  b.chain_wet_l = scr_wet_l;
  b.chain_wet_r = scr_wet_r;
  switch (variant) {
    case 0: break;                                   /* accepted */
    case 1: tracks = BK_LOOP_TRACKS + 1; break;      /* more than the struct holds */
    case 2: sr = 0.0; break;
    case 3: sr = NAN; break;
    case 4: max_block = 0; break;
    case 5: b.undo_l = NULL; break;
    case 6: b.undo_r = NULL; break;
    case 7: b.trk_l = NULL; break;
    case 8: b.trk_r = NULL; break;
    case 9: b.bus_l = NULL; break;
    case 10: b.bus_r = NULL; break;
    case 11: b.chain_wet_l = NULL; break;
    case 12: b.chain_wet_r = NULL; break;
    case 13: b.track_l[3] = NULL; break;             /* a live track, no buffer */
    case 14: tracks = 2; b.track_l[3] = NULL; break; /* beyond the count: fine */
    case 15: tracks = 2; b.track_r[1] = NULL; break;
    case 16: target = NULL; break;
    case 17: return bk_looper_init(&probe, sr, max_block, tracks, DEF_SECONDS, NULL);
    case 18: tracks = 0; b.track_r[3] = NULL; break; /* 0 means 4, so track 3 is live */
    case 19:                                          /* -1 builds none: needs none */
      tracks = -1;
      for (i = 0; i < BK_LOOP_TRACKS; i++) b.track_l[i] = b.track_r[i] = NULL;
      break;
    case 20: tracks = BK_LOOP_TRACKS; max_block = -5; break;
    case 21: max_block = 1; break;                   /* the smallest block: accepted */
    default: return -99;
  }
  return bk_looper_init(target, sr, max_block, tracks, DEF_SECONDS, &b);
}

static void do_init(double sr, int tracks, double secs) {
  bk_looper_buffers b;
  int i, mf;

  mf = bk_looper_max_frames(sr, secs);
  if (mf > CAP_FRAMES) {
    fprintf(stderr, "battery bug: max_frames %d exceeds CAP_FRAMES\n", mf);
    exit(3);
  }
  /* The contract is zeroed buffers at init; the JS's are fresh arrays. */
  memset(trk_buf, 0, sizeof(trk_buf));
  memset(undo_buf, 0, sizeof(undo_buf));
  for (i = 0; i < BK_LOOP_TRACKS; i++) {
    b.track_l[i] = trk_buf[i][0];
    b.track_r[i] = trk_buf[i][1];
  }
  b.undo_l = undo_buf[0];
  b.undo_r = undo_buf[1];
  b.trk_l = scr_trk_l;
  b.trk_r = scr_trk_r;
  b.bus_l = scr_bus_l;
  b.bus_r = scr_bus_r;
  b.chain_wet_l = scr_wet_l;
  b.chain_wet_r = scr_wet_r;
  if (bk_looper_init(&lp, sr, MAX_BLOCK, tracks, secs, &b) != 0) {
    fprintf(stderr, "battery bug: bk_looper_init refused (%g, %d, %g)\n", sr, tracks, secs);
    exit(3);
  }
  bk_clock_init(&ck, sr);
}

static void run_script(const double *ops, int n_ops, sink *s) {
  int n_fx = 0;
  int i, k;

  src_cursor = 0;
  do_init(SR, BK_LOOP_TRACKS, DEF_SECONDS);

  for (i = 0; i < n_ops; i++) {
    const double *o = ops + (size_t)i * 6;
    const int op = (int)o[0];
    const double a = o[1] == NANV ? NAN : o[1];
    const double b = o[2] == NANV ? NAN : o[2];
    const double c = o[3] == NANV ? NAN : o[3];
    const double d = o[4] == NANV ? NAN : o[4];
    const double e = o[5] == NANV ? NAN : o[5];
    bk_clock *cp = b != 0.0 ? &ck : NULL;

    switch (op) {
      case OP_INIT:
        do_init(a, (int)b, c);
        n_fx = 0;
        break;
      case OP_REC:
        bk_looper_record_toggle(&lp, (int)a, cp);
        break;
      case OP_PLAY:
        bk_looper_play_toggle(&lp, (int)a, cp);
        break;
      case OP_STOP:
        bk_looper_stop(&lp, (int)a, cp);
        break;
      case OP_CLEAR:
        bk_looper_clear(&lp, (int)a);
        break;
      case OP_CLEARALL:
        bk_looper_clear_all(&lp);
        break;
      case OP_UNDO:
        bk_looper_undo(&lp, (int)a);
        break;
      case OP_TPARAM:
        bk_looper_set_track_param(&lp, (int)a, (int)b, c);
        break;
      case OP_PARAM:
        bk_looper_set_param(&lp, (int)a, b);
        break;
      case OP_RESET:
        bk_looper_reset(&lp);
        break;
      case OP_CLOCK:
        bk_clock_set_param(&ck, (int)a, b);
        break;
      case OP_CLOCKADV:
        bk_clock_advance(&ck, a);
        break;
      case OP_CHAINFOR:
        push64(s, bk_looper_chain_for(&lp, (int)a) ? 1.0 : 0.0);
        break;
      case OP_CHAINADD: {
        bk_chain *ch = bk_looper_chain_for(&lp, (int)a);
        bk_slot *got = NULL;
        if (ch && n_fx < MAX_EFFECTS) {
          bk_slot_spec spec;
          const int id = (int)b;
          tfx_init(&pool[n_fx], id);
          spec.id = id;
          spec.type = id;
          spec.index = (c == UNSET) ? BK_CHAIN_APPEND : (int)c;
          spec.mix = (d == UNSET) ? NAN : d;
          spec.bypassed = (e == UNSET) ? BK_CHAIN_KEEP : (int)e;
          spec.effect = &pool[n_fx];
          spec.vt = &VT;
          got = bk_chain_add(ch, &spec);
          if (got) n_fx++;
        }
        push64(s, got ? 1.0 : 0.0);
        break;
      }
      case OP_CHAINREMOVE: {
        bk_chain *ch = bk_looper_chain_for(&lp, (int)a);
        if (ch) bk_chain_remove(ch, (int)b);
        break;
      }
      case OP_CHAINBYPASS: {
        bk_chain *ch = bk_looper_chain_for(&lp, (int)a);
        if (ch) bk_chain_set_bypass(ch, (int)b, (int)c);
        break;
      }
      case OP_PROCESS: {
        const int frames = (int)a;
        const int count = (int)b;
        const int mode = (int)c;
        const int flags = (int)e;
        int n;
        if (frames > MAX_BLOCK) {
          fprintf(stderr, "battery bug: PROCESS of %d frames exceeds MAX_BLOCK\n", frames);
          exit(3);
        }
        for (n = 0; n < count; n++) {
          bk_loop_src src;
          build_src(frames, mode);
          src.master_l = src_ml;
          src.master_r = src_mr;
          src.drum_l = mode == SRC_MASTER ? NULL : src_dl;
          src.drum_r = mode == SRC_MASTER ? NULL : src_dr;
          prefill(frames, (int)d);
          bk_looper_process(&lp, mode == SRC_NULL ? NULL : &src, blk_l, blk_r, (size_t)frames,
                            (flags & PF_CLOCK) ? &ck : NULL);
          if (flags & PF_ADVANCE) bk_clock_advance(&ck, (double)frames);
          for (k = 0; k < frames; k++) push32(s, blk_l[k]);
          for (k = 0; k < frames; k++) push32(s, blk_r[k]);
        }
        break;
      }
      case OP_SNAP:
        push_snap(s, &lp, &ck);
        break;
      case OP_BUFS: {
        const int ti = (int)a;
        const int n = b > 0.0 ? (int)b : lp.max_frames;
        const float *bl = ti < 0 ? lp.undo_l : lp.tracks[ti].buf_l;
        const float *br = ti < 0 ? lp.undo_r : lp.tracks[ti].buf_r;
        for (k = 0; k < n; k++) push32(s, bl[k]);
        for (k = 0; k < n; k++) push32(s, br[k]);
        break;
      }
      case OP_METERS: {
        const int n = bk_looper_read_meters(&lp, meters, 3);
        push64(s, (double)n);
        for (k = 0; k < n; k++) push64(s, meters[3 + k]);
        break;
      }
      case OP_QUERY: {
        const bk_loop_track *t = bk_looper_track(&lp, (int)a);
        push64(s, bk_looper_active(&lp) ? 1.0 : 0.0);
        push64(s, (double)bk_looper_track_count(&lp));
        push64(s, t ? 1.0 : 0.0);
        push64(s, bk_looper_can_undo(&lp, (int)a) ? 1.0 : 0.0);
        push64(s, t ? (bk_loop_track_audible(t) ? 1.0 : 0.0) : -1.0);
        push64(s, t ? (bk_loop_track_recording(t) ? 1.0 : 0.0) : -1.0);
        push64(s, t ? (bk_loop_track_playing(t) ? 1.0 : 0.0) : -1.0);
        break;
      }
      case OP_MAXFRAMES:
        push64(s, (double)bk_looper_max_frames(a, b));
        break;
      case OP_INITCHECK:
        push64(s, (double)init_check((int)a));
        break;
      default:
        break;
    }
    push_state(s, &lp, &ck);
  }
}

/* --- the battery -------------------------------------------------------- */

/* Same compile-time row-width guard as parity-drum-rack.c. */
#define ROWS_OK(x) ((int)sizeof(char[1 - 2 * !!(sizeof(x) % (6 * sizeof(double)))]) - 1)
#define OPS(x) (x), (int)(sizeof(x) / sizeof(double) / 6) + ROWS_OK(x)

#define K_GAIN BK_LOOP_P_GAIN
#define K_MUTE BK_LOOP_P_MUTE
#define K_SOLO BK_LOOP_P_SOLO
#define K_PAN BK_LOOP_P_PAN
#define K_SYNC BK_LOOP_P_SYNC
#define K_SOURCE BK_LOOP_P_SOURCE

/* 300 bpm, quarter-beat grid: 9600 frames a beat, a 2400-frame grid. */
#define FAST_GRID                                   \
  OP_CLOCK, BK_CLOCK_P_BPM, 300, 0, 0, 0,           \
  OP_CLOCK, BK_CLOCK_P_QUANTIZE, 0.25, 0, 0, 0
#define CLOCK_STOP OP_CLOCK, BK_CLOCK_P_RUN, 0, 0, 0, 0
#define CLOCK_RUN OP_CLOCK, BK_CLOCK_P_RUN, 1, 0, 0, 0
#define FREE(t) OP_TPARAM, t, K_SYNC, 0, 0, 0
#define PROC(fr, n, src, pre) OP_PROCESS, fr, n, src, pre, PF_BOTH
#define REC(t) OP_REC, t, 1, 0, 0, 0
#define PLAY(t) OP_PLAY, t, 1, 0, 0, 0
#define STOP(t) OP_STOP, t, 1, 0, 0, 0
#define SNAP OP_SNAP, 0, 0, 0, 0, 0
#define METERS OP_METERS, 0, 0, 0, 0, 0
#define QUERY(t) OP_QUERY, t, 0, 0, 0, 0
#define BUFS(t, n) OP_BUFS, t, n, 0, 0, 0
/* A free-running take of exactly 5120 frames on track t, closed into PLAY. */
#define FREE_TAKE(t) FREE(t), REC(t), PROC(256, 20, SRC_ALL, PRE_SILENT), REC(t)

static const double S_EMPTY[] = {
  PROC(128, 1, SRC_ALL, PRE_CONST),
  METERS,
  QUERY(0),
  SNAP
};

/* The pair for note 1: identical except that arm-cleared allocates track 0's
   buffer (in the JS) with a REC and drops the take before a frame is written. */
static const double S_ARM_NEVER[] = {
  PROC(256, 4, SRC_ALL, PRE_CONST),
  SNAP, METERS, BUFS(0, 0), BUFS(-1, 0)
};
static const double S_ARM_CLEARED[] = {
  OP_REC, 0, 0, 0, 0, 0,
  OP_CLEAR, 0, 0, 0, 0, 0,
  PROC(256, 4, SRC_ALL, PRE_CONST),
  SNAP, METERS, BUFS(0, 0), BUFS(-1, 0)
};
/* And the undo slot's half: armed by an overdub that never wrote a frame. */
static const double S_ARM_UNDO[] = {
  FREE_TAKE(1),
  REC(1), REC(1),
  OP_CLEAR, 1, 0, 0, 0, 0,
  PROC(256, 4, SRC_ALL, PRE_CONST),
  SNAP, BUFS(-1, 0), BUFS(1, 0)
};

static const double S_FREE_TAKE[] = {
  FREE(0), REC(0), QUERY(0),
  PROC(256, 20, SRC_ALL, PRE_SILENT),
  METERS, REC(0), METERS,
  PROC(256, 30, SRC_ALL, PRE_CONST),
  METERS, SNAP, BUFS(0, 5120)
};
static const double S_FREE_STOP[] = {
  FREE(0), REC(0),
  PROC(256, 20, SRC_ALL, PRE_SILENT),
  STOP(0), QUERY(0),
  PROC(256, 12, SRC_ALL, PRE_CONST),
  QUERY(0), METERS, SNAP, BUFS(0, 5120),
  PLAY(0), PROC(256, 4, SRC_ALL, PRE_SILENT), PLAY(0),
  PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP
};
static const double S_FREE_PLAY[] = {
  FREE(0), REC(0),
  PROC(256, 20, SRC_MASTER, PRE_SILENT),
  PLAY(0),
  PROC(256, 24, SRC_ALL, PRE_SILENT),
  SNAP, BUFS(0, 5120)
};
static const double S_TOO_SHORT[] = {
  FREE(0), REC(0),
  PROC(256, 7, SRC_ALL, PRE_SILENT), /* 1792 frames, under MIN_LOOP_FRAMES */
  REC(0), SNAP, QUERY(0),
  PROC(256, 2, SRC_ALL, PRE_SILENT)
};
/* 2048 exactly: the boundary is `<`, so this is a loop. */
static const double S_MIN_EXACT[] = {
  FREE(0), REC(0),
  PROC(256, 8, SRC_ALL, PRE_SILENT),
  REC(0), SNAP,
  PROC(256, 10, SRC_ALL, PRE_SILENT)
};
static const double S_MIN_UNDER[] = {
  FREE(0), REC(0),
  PROC(256, 7, SRC_ALL, PRE_SILENT),
  PROC(255, 1, SRC_ALL, PRE_SILENT),
  REC(0), SNAP
};

/* Grid rounding: clock stopped so the punches are immediate, grid still live. */
static const double S_GRID_DOWN[] = {
  FAST_GRID, CLOCK_STOP,
  REC(0), PROC(250, 12, SRC_ALL, PRE_SILENT), /* 3000 -> 2400 */
  REC(0), SNAP, CLOCK_RUN,
  PROC(256, 20, SRC_ALL, PRE_SILENT),
  SNAP, BUFS(0, 4800)
};
static const double S_GRID_HALF[] = {
  FAST_GRID, CLOCK_STOP,
  REC(0), PROC(250, 24, SRC_ALL, PRE_SILENT), /* 6000 = 2.5 grids -> 7200 */
  REC(0), SNAP, BUFS(0, 7200), CLOCK_RUN,
  PROC(256, 10, SRC_ALL, PRE_SILENT)
};
static const double S_GRID_TAIL[] = {
  FAST_GRID, CLOCK_STOP,
  REC(0), PROC(250, 28, SRC_ALL, PRE_SILENT), /* 7000 -> 7200 */
  REC(0),
  OP_CLEAR, 0, 0, 0, 0, 0,
  REC(0), PROC(250, 16, SRC_ALL, PRE_SILENT), /* 4000 -> 4800, tail zeroed */
  REC(0), SNAP, BUFS(0, 7200), CLOCK_RUN,
  PROC(256, 24, SRC_ALL, PRE_SILENT)
};
static const double S_GRID_MAX[] = {
  OP_CLOCK, BK_CLOCK_P_BPM, 300, 0, 0, 0,
  OP_CLOCK, BK_CLOCK_P_QUANTIZE, 0.75, 0, 0, 0, /* 7200 */
  CLOCK_STOP,
  REC(0), PROC(250, 44, SRC_ALL, PRE_SILENT), /* 11000 -> 14400 > 12480 -> 7200 */
  REC(0), SNAP, BUFS(0, 0)
};
static const double S_GRID_FULL[] = {
  OP_CLOCK, BK_CLOCK_P_BPM, 300, 0, 0, 0,
  OP_CLOCK, BK_CLOCK_P_QUANTIZE, 0.75, 0, 0, 0,
  CLOCK_STOP,
  REC(0), PROC(250, 52, SRC_ALL, PRE_SILENT), /* fills at 12480, closes itself */
  SNAP, BUFS(0, 0)
};
static const double S_GRID_SHORT[] = {
  OP_CLOCK, BK_CLOCK_P_BPM, 240, 0, 0, 0,
  OP_CLOCK, BK_CLOCK_P_QUANTIZE, 0.125, 0, 0, 0, /* 1500 */
  CLOCK_STOP,
  REC(0), PROC(210, 10, SRC_ALL, PRE_SILENT), /* 2100 -> 1500 < 2048: dropped */
  REC(0), SNAP, QUERY(0)
};
static const double S_FULL_FREE[] = {
  FREE(0), REC(0),
  PROC(256, 52, SRC_ALL, PRE_CONST), /* 13312 > 12480 */
  SNAP, METERS, BUFS(0, 0)
};
static const double S_FULL_SYNC[] = {
  FAST_GRID, CLOCK_STOP,
  REC(0), PROC(256, 52, SRC_ALL, PRE_SILENT), /* 12480 -> 12000 */
  SNAP, CLOCK_RUN, PROC(256, 8, SRC_ALL, PRE_SILENT), SNAP
};

/* Quantised punches with a running clock, landing mid-block. */
static const double S_QUANT[] = {
  FAST_GRID,
  OP_CLOCKADV, 1000, 0, 0, 0, 0,
  REC(0), QUERY(0), SNAP,
  PROC(256, 10, SRC_ALL, PRE_SILENT), /* fires at 2400, sample 120 of block 5 */
  REC(0), SNAP,
  PROC(256, 12, SRC_ALL, PRE_SILENT),
  SNAP, REC(0), /* pending overdub */
  PROC(256, 12, SRC_ALL, PRE_CONST),
  REC(0), /* pending end of overdub */
  PROC(256, 12, SRC_ALL, PRE_SILENT),
  SNAP, STOP(0),
  PROC(256, 12, SRC_ALL, PRE_SILENT),
  PLAY(0),
  PROC(256, 12, SRC_ALL, PRE_SILENT),
  SNAP, METERS, BUFS(0, 0), BUFS(-1, 0)
};
static const double S_QUANT_CANCEL[] = {
  FAST_GRID,
  OP_CLOCKADV, 1000, 0, 0, 0, 0,
  REC(0), REC(0), SNAP, /* second press cancels */
  PROC(256, 10, SRC_ALL, PRE_SILENT),
  PLAY(0), STOP(0), SNAP, /* both no-ops on an empty track */
  REC(0), PROC(256, 20, SRC_ALL, PRE_SILENT),
  REC(0), PROC(256, 20, SRC_ALL, PRE_SILENT),
  /* The track is playing: STOP schedules STOP, then REC (a different
     action) replaces it rather than cancelling. PLAY on a playing track
     would map to STOP again, i.e. the same action, and cancel. */
  STOP(0), SNAP, REC(0), SNAP,
  PROC(256, 12, SRC_ALL, PRE_SILENT),
  PLAY(0), PLAY(0), SNAP,
  PROC(256, 12, SRC_ALL, PRE_SILENT), SNAP
};
/* The same quantised performance at two block sizes. */
static const double S_BLOCK_256[] = {
  FAST_GRID,
  OP_CLOCKADV, 777, 0, 0, 0, 0,
  REC(0), PROC(256, 16, SRC_ALL, PRE_SILENT),
  REC(0), PROC(256, 16, SRC_ALL, PRE_SILENT),
  REC(0), PROC(256, 16, SRC_ALL, PRE_SILENT),
  REC(0), PROC(256, 16, SRC_ALL, PRE_SILENT),
  SNAP
};
static const double S_BLOCK_64[] = {
  FAST_GRID,
  OP_CLOCKADV, 777, 0, 0, 0, 0,
  REC(0), PROC(64, 64, SRC_ALL, PRE_SILENT),
  REC(0), PROC(64, 64, SRC_ALL, PRE_SILENT),
  REC(0), PROC(64, 64, SRC_ALL, PRE_SILENT),
  REC(0), PROC(64, 64, SRC_ALL, PRE_SILENT),
  SNAP
};

/* Overdub across the wrap, ended 40 frames past it: the declick walks back
   over position 0 and has to wrap too. */
static const double S_OVERDUB_WRAP[] = {
  FREE_TAKE(0),
  REC(0), QUERY(0),
  PROC(256, 20, SRC_ALL, PRE_SILENT),
  PROC(40, 1, SRC_ALL, PRE_SILENT),
  REC(0), SNAP, BUFS(0, 5120), BUFS(-1, 5120), QUERY(0),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP, BUFS(0, 5120),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP, BUFS(0, 5120),
  PROC(256, 4, SRC_ALL, PRE_SILENT)
};
static const double S_OVERDUB_STOP[] = {
  FREE_TAKE(0),
  PROC(256, 3, SRC_ALL, PRE_SILENT),
  REC(0), PROC(256, 5, SRC_MASTER, PRE_SILENT),
  STOP(0), SNAP,
  PROC(256, 8, SRC_ALL, PRE_SILENT),
  SNAP, BUFS(0, 5120), BUFS(-1, 5120),
  REC(0), /* stopped + REC -> overdub again */
  PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP
};
/* An overdub punched in and out with no frame between: end_overdub runs with
   last_write still -1, so declick_out has nothing to fade. The empty layer is
   still a layer, and undoing it subtracts zeros. Then the same via STOP. */
static const double S_OVERDUB_INSTANT[] = {
  FREE_TAKE(0),
  PROC(256, 3, SRC_ALL, PRE_SILENT), BUFS(0, 5120),
  REC(0), REC(0), SNAP, BUFS(0, 5120), BUFS(-1, 5120),
  PROC(256, 4, SRC_ALL, PRE_SILENT),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP, BUFS(0, 5120),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP,
  REC(0), STOP(0), SNAP, BUFS(0, 5120),
  PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP
};
/* A tempo-locked overdub: position comes from the clock. */
static const double S_OVERDUB_SYNC[] = {
  FAST_GRID,
  OP_CLOCKADV, 300, 0, 0, 0, 0,
  REC(0), PROC(256, 12, SRC_ALL, PRE_SILENT),
  REC(0), PROC(256, 12, SRC_ALL, PRE_SILENT),
  REC(0), PROC(256, 30, SRC_MASTER, PRE_SILENT),
  REC(0), PROC(256, 12, SRC_ALL, PRE_SILENT),
  SNAP, BUFS(0, 0), BUFS(-1, 0),
  OP_UNDO, 0, 0, 0, 0, 0, BUFS(0, 0)
};
static const double S_UNDO_TAKE[] = {
  FREE_TAKE(0),
  PROC(256, 4, SRC_ALL, PRE_SILENT),
  QUERY(0),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP, QUERY(0),
  PROC(256, 4, SRC_ALL, PRE_SILENT),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP, QUERY(0),
  PROC(256, 2, SRC_ALL, PRE_SILENT),
  PLAY(0), PROC(256, 6, SRC_ALL, PRE_SILENT), SNAP
};
static const double S_UNDO_MID[] = {
  FREE_TAKE(0),
  REC(0), PROC(256, 4, SRC_ALL, PRE_SILENT),
  QUERY(0), OP_UNDO, 0, 0, 0, 0, 0, SNAP,
  REC(0), QUERY(0),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP, BUFS(0, 5120)
};
static const double S_UNDO_OTHER[] = {
  FREE_TAKE(0),
  OP_UNDO, 1, 0, 0, 0, 0, QUERY(1), SNAP,
  FREE_TAKE(1),
  OP_UNDO, 0, 0, 0, 0, 0, QUERY(0), QUERY(1),
  OP_UNDO, 1, 0, 0, 0, 0, SNAP,
  PROC(256, 4, SRC_ALL, PRE_SILENT)
};
static const double S_CLEAR_UNDO[] = {
  FREE_TAKE(0), FREE_TAKE(1),
  OP_CLEAR, 0, 0, 0, 0, 0, QUERY(1),
  OP_CLEAR, 1, 0, 0, 0, 0, QUERY(1), SNAP
};
static const double S_UNDO_LAYERS[] = {
  FREE_TAKE(0),
  REC(0), PROC(256, 6, SRC_ALL, PRE_SILENT), REC(0),
  REC(0), PROC(256, 9, SRC_MASTER, PRE_SILENT), REC(0),
  SNAP, BUFS(0, 5120),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP, BUFS(0, 5120),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP, BUFS(0, 5120),
  OP_UNDO, 0, 0, 0, 0, 0, OP_UNDO, 0, 0, 0, 0, 0, SNAP
};

static const double S_MUTE_SOLO[] = {
  FREE_TAKE(0),
  OP_TPARAM, 1, K_SOURCE, 1, 0, 0,
  FREE_TAKE(1),
  PROC(256, 4, SRC_ALL, PRE_SILENT),
  OP_TPARAM, 1, K_SOLO, 1, 0, 0,
  PROC(256, 6, SRC_ALL, PRE_SILENT), SNAP,
  OP_TPARAM, 0, K_MUTE, 1, 0, 0,
  OP_TPARAM, 1, K_SOLO, 0, 0, 0,
  PROC(256, 6, SRC_ALL, PRE_SILENT), SNAP,
  OP_TPARAM, 0, K_MUTE, 0.49, 0, 0,
  OP_TPARAM, 2, K_SOLO, 1, 0, 0, /* soloing an EMPTY track counts for nothing */
  PROC(256, 6, SRC_ALL, PRE_SILENT), SNAP,
  OP_TPARAM, 1, K_MUTE, 0.5, 0, 0,
  PROC(256, 6, SRC_ALL, PRE_SILENT),
  METERS, SNAP
};
static const double S_PAN_GAIN[] = {
  FREE_TAKE(0),
  OP_TPARAM, 0, K_PAN, -0.5, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST),
  OP_TPARAM, 0, K_PAN, 0.7, 0, 0,
  OP_TPARAM, 0, K_GAIN, -6, 0, 0, PROC(256, 2, SRC_ALL, PRE_NOISE), SNAP,
  OP_TPARAM, 0, K_GAIN, -60, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST), SNAP,
  OP_TPARAM, 0, K_GAIN, -59.9, 0, 0,
  OP_TPARAM, 0, K_PAN, 5, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST), SNAP,
  OP_TPARAM, 0, K_GAIN, 30, 0, 0,
  OP_TPARAM, 0, K_PAN, -5, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST), SNAP,
  OP_TPARAM, 0, K_PAN, 0, 0, 0,
  OP_PARAM, BK_LOOPER_P_GAIN, -3.5, 0, 0, 0, PROC(256, 2, SRC_ALL, PRE_NOISE), SNAP,
  OP_PARAM, BK_LOOPER_P_GAIN, -80, 0, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST), SNAP,
  OP_PARAM, BK_LOOPER_P_GAIN, 40, 0, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST), SNAP,
  OP_PARAM, BK_LOOPER_P_MUTE, 1, 0, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST), SNAP,
  OP_PARAM, BK_LOOPER_P_MUTE, 0, 0, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST),
  OP_PARAM, 77, 1, 0, 0, 0,
  OP_TPARAM, 0, 99, 1, 0, 0,
  OP_TPARAM, 9, K_GAIN, -6, 0, 0,
  OP_CLOCK, BK_CLOCK_P_BEATS_PER_BAR, 3, 0, 0, 0,
  OP_CLOCK, 9, 1, 0, 0, 0, /* an unknown transport key: a no-op */
  SNAP
};
static const double S_LOOPER_MUTE_REC[] = {
  OP_PARAM, BK_LOOPER_P_MUTE, 1, 0, 0, 0,
  FREE(0), REC(0),
  PROC(256, 10, SRC_ALL, PRE_CONST),
  REC(0), PROC(256, 4, SRC_ALL, PRE_CONST), SNAP,
  OP_PARAM, BK_LOOPER_P_MUTE, 0, 0, 0, 0,
  PROC(256, 6, SRC_ALL, PRE_CONST), SNAP, BUFS(0, 2560)
};
static const double S_SOURCE[] = {
  OP_TPARAM, 0, K_SOURCE, 1, 0, 0,
  FREE(0), REC(0),
  PROC(256, 10, SRC_MASTER, PRE_SILENT), /* drums NULL: records silence */
  PROC(256, 10, SRC_ALL, PRE_SILENT),
  REC(0), SNAP, BUFS(0, 5120),
  OP_TPARAM, 0, K_SOURCE, 0.4, 0, 0, SNAP,
  OP_TPARAM, 0, K_SOURCE, 0.6, 0, 0, SNAP,
  OP_TPARAM, 0, K_SOURCE, 7, 0, 0, SNAP,
  OP_TPARAM, 0, K_SOURCE, -3, 0, 0, SNAP,
  OP_TPARAM, 0, K_SOURCE, 0.5, 0, 0, SNAP,
  REC(0), PROC(256, 4, SRC_NULL, PRE_CONST), REC(0),
  FREE(1), REC(1), PROC(256, 10, SRC_NULL, PRE_SILENT), REC(1),
  SNAP, BUFS(0, 5120), BUFS(1, 2560)
};
static const double S_SYNC_TOGGLE[] = {
  FAST_GRID,
  FREE_TAKE(0),
  PROC(256, 7, SRC_ALL, PRE_SILENT), SNAP,
  OP_TPARAM, 0, K_SYNC, 1, 0, 0, SNAP,
  PROC(256, 7, SRC_ALL, PRE_SILENT), SNAP,
  OP_TPARAM, 0, K_SYNC, 0.2, 0, 0, SNAP,
  PROC(256, 7, SRC_ALL, PRE_SILENT),
  OP_TPARAM, 0, K_SYNC, 0, 0, 0, SNAP, /* no change: pos untouched */
  OP_TPARAM, 2, K_SYNC, 0, 0, 0,       /* empty track: pos -> 0 */
  OP_TPARAM, 2, K_SYNC, 1, 0, 0, SNAP,
  PROC(256, 3, SRC_ALL, PRE_SILENT)
};
static const double S_TEMPO_RESET[] = {
  FAST_GRID,
  OP_CLOCKADV, 5000, 0, 0, 0, 0,
  CLOCK_STOP,
  REC(0), PROC(250, 20, SRC_ALL, PRE_SILENT), /* 5000 -> 4800 */
  REC(0), CLOCK_RUN,
  PROC(256, 10, SRC_ALL, PRE_SILENT), SNAP,
  OP_CLOCK, BK_CLOCK_P_RESET, 0, 0, 0, 0, /* frame < anchor: negative rel */
  PROC(256, 10, SRC_ALL, PRE_SILENT), SNAP,
  OP_CLOCKADV, 1e12, 0, 0, 0, 0,
  PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP,
  OP_CLOCKADV, 4.5e15, 0, 0, 0, 0,
  PROC(256, 2, SRC_ALL, PRE_SILENT), SNAP,
  /* Clock passed as NULL: frame 0 every block. */
  OP_PROCESS, 256, 3, SRC_ALL, PRE_SILENT, 0,
  OP_PROCESS, 256, 1, SRC_ALL, PRE_SILENT, PF_CLOCK, SNAP
};
static const double S_NULL_CLOCK[] = {
  OP_REC, 0, 0, 0, 0, 0,
  OP_PROCESS, 256, 12, SRC_ALL, PRE_SILENT, 0,
  OP_REC, 0, 0, 0, 0, 0, SNAP,
  OP_PROCESS, 256, 14, SRC_ALL, PRE_SILENT, 0,
  OP_REC, 0, 0, 0, 0, 0,
  OP_PROCESS, 256, 6, SRC_ALL, PRE_SILENT, 0,
  OP_STOP, 0, 0, 0, 0, 0,
  OP_PROCESS, 256, 4, SRC_ALL, PRE_SILENT, 0,
  OP_PLAY, 0, 0, 0, 0, 0,
  OP_PROCESS, 256, 4, SRC_ALL, PRE_SILENT, 0,
  SNAP, BUFS(0, 3072), BUFS(-1, 3072)
};
static const double S_NAN_PARAMS[] = {
  FREE_TAKE(0),
  OP_TPARAM, 0, K_GAIN, NANV, 0, 0, SNAP,
  OP_TPARAM, 0, K_PAN, NANV, 0, 0, SNAP,
  OP_TPARAM, 0, K_SOURCE, NANV, 0, 0, SNAP,
  OP_TPARAM, 0, K_MUTE, NANV, 0, 0,
  OP_TPARAM, 0, K_SOLO, NANV, 0, 0,
  OP_TPARAM, 0, K_SYNC, NANV, 0, 0, SNAP,
  PROC(256, 3, SRC_ALL, PRE_CONST),
  OP_PARAM, BK_LOOPER_P_GAIN, NANV, 0, 0, 0,
  PROC(256, 2, SRC_ALL, PRE_CONST), SNAP,
  /* bpm NaN -> grid NaN. `NaN > 0` is false, so _schedule's quantised test
     fails and the punch is IMMEDIATE (track 1 goes straight to REC). */
  OP_TPARAM, 1, K_GAIN, 0, 0, 0,
  OP_CLOCK, BK_CLOCK_P_BPM, NANV, 0, 0, 0,
  REC(1), SNAP, PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP,
  /* A live grid but a NaN clock frame: quantised, so pendingAt = NaN +
     framesToGrid(NaN) = NaN, and `frame >= NaN` never holds. A punch that
     never fires. Track 2 is empty, so its position never reads the NaN. */
  OP_CLOCK, BK_CLOCK_P_BPM, 120, 0, 0, 0,
  OP_CLOCKADV, NANV, 0, 0, 0, 0,
  REC(2), SNAP, PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP, QUERY(2)
};

static const double S_CHAIN_NEVER[] = {
  FREE_TAKE(0), PROC(256, 8, SRC_ALL, PRE_NOISE), SNAP, METERS
};
static const double S_CHAIN_EMPTY[] = {
  OP_CHAINFOR, 0, 0, 0, 0, 0,
  FREE_TAKE(0), PROC(256, 8, SRC_ALL, PRE_NOISE), SNAP, METERS
};
static const double S_CHAIN_LIVE[] = {
  OP_CHAINADD, 0, 1, UNSET, UNSET, UNSET,
  FREE_TAKE(0), PROC(256, 4, SRC_ALL, PRE_CONST), SNAP,
  OP_CHAINADD, 0, 2, 0, 0.5, UNSET,
  PROC(256, 4, SRC_ALL, PRE_CONST), SNAP, METERS,
  OP_CHAINBYPASS, 0, 1, 1, 0, 0,
  PROC(256, 4, SRC_ALL, PRE_CONST), SNAP,
  OP_CHAINREMOVE, 0, 2, 0, 0, 0,
  PROC(256, 4, SRC_ALL, PRE_CONST), SNAP,
  OP_CLEAR, 0, 0, 0, 0, 0, SNAP,
  OP_CHAINFOR, -1, 0, 0, 0, 0,
  OP_CHAINFOR, 4, 0, 0, 0, 0,
  OP_CHAINADD, 7, 3, UNSET, UNSET, UNSET
};
/* A chained track summed with a direct one: the bus order is observable. */
static const double S_CHAIN_MIX[] = {
  FREE_TAKE(0),
  OP_CHAINADD, 1, 5, UNSET, UNSET, UNSET,
  OP_TPARAM, 1, K_SOURCE, 1, 0, 0,
  FREE_TAKE(1),
  OP_TPARAM, 1, K_GAIN, -2.5, 0, 0,
  PROC(256, 10, SRC_ALL, PRE_NOISE), SNAP, METERS,
  STOP(1), PROC(256, 10, SRC_ALL, PRE_SILENT), SNAP
};

static const double S_RESET[] = {
  FREE_TAKE(0),
  FREE_TAKE(2),
  OP_CHAINADD, 2, 1, UNSET, UNSET, UNSET,
  REC(2), PROC(256, 3, SRC_ALL, PRE_SILENT),
  FREE(1), REC(1), PROC(256, 3, SRC_ALL, PRE_SILENT),
  FAST_GRID, REC(3), /* pending on an EMPTY synced track */
  SNAP, QUERY(2),
  OP_RESET, 0, 0, 0, 0, 0, SNAP, QUERY(2),
  PROC(256, 3, SRC_ALL, PRE_SILENT),
  PLAY(0), PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP
};
static const double S_CLEAR_ALL[] = {
  FREE_TAKE(0), FREE_TAKE(1),
  OP_CHAINADD, 1, 1, UNSET, UNSET, UNSET,
  PROC(256, 3, SRC_ALL, PRE_SILENT),
  OP_CLEARALL, 0, 0, 0, 0, 0, SNAP, QUERY(0),
  PROC(256, 3, SRC_ALL, PRE_SILENT)
};
static const double S_DIRTY[] = {
  FREE(0), REC(0), PROC(256, 20, SRC_DIRTY, PRE_SILENT), REC(0),
  PROC(256, 4, SRC_ALL, PRE_CONST), SNAP, BUFS(0, 5120),
  REC(0), PROC(256, 4, SRC_DIRTY, PRE_SILENT), REC(0),
  PROC(256, 4, SRC_ALL, PRE_CONST), SNAP, METERS, BUFS(0, 5120)
};
static const double S_HUGE[] = {
  FREE(0), REC(0), PROC(256, 20, SRC_HUGE, PRE_SILENT), REC(0),
  OP_TPARAM, 0, K_GAIN, 12, 0, 0,
  OP_PARAM, BK_LOOPER_P_GAIN, 12, 0, 0, 0,
  PROC(256, 4, SRC_ALL, PRE_CONST), SNAP, METERS
};
static const double S_INIT_44100[] = {
  OP_INIT, 44100, 4, 0.26, 0, 0,
  FAST_GRID, CLOCK_STOP,
  REC(0), PROC(250, 18, SRC_ALL, PRE_SILENT), REC(0),
  CLOCK_RUN, PROC(256, 10, SRC_ALL, PRE_SILENT), SNAP
};
static const double S_INIT_96000[] = {
  OP_INIT, 96000, 2, 0.26, 0, 0,
  REC(2), QUERY(2), QUERY(1),
  FREE_TAKE(1), PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP, METERS
};
static const double S_INIT_LOW[] = {
  OP_INIT, 2000, 0, 0.26, 0, 0, /* tracks 0 -> 4; max_frames floors at 2048 */
  FREE(0), REC(0), PROC(256, 9, SRC_ALL, PRE_SILENT), /* fills at 2048 */
  SNAP, PROC(256, 9, SRC_ALL, PRE_SILENT), SNAP, METERS
};
static const double S_INIT_HALF[] = {
  OP_INIT, 48250, 1, 0.26, 0, 0, /* declick 96.5 -> 97 */
  FREE_TAKE(0), PROC(256, 2, SRC_ALL, PRE_SILENT), SNAP, METERS, QUERY(1)
};
static const double S_INIT_NEGTRACKS[] = {
  OP_INIT, 48000, -1, 0.26, 0, 0,
  REC(0), PROC(256, 2, SRC_ALL, PRE_CONST), SNAP, METERS, QUERY(0)
};
static const double S_MAXFRAMES[] = {
  OP_MAXFRAMES, 48000, 0, 0, 0, 0,
  OP_MAXFRAMES, 48000, 30, 0, 0, 0,
  OP_MAXFRAMES, 44100, 0, 0, 0, 0,
  OP_MAXFRAMES, 48001, 0.5, 0, 0, 0,
  OP_MAXFRAMES, 44100, 0.25, 0, 0, 0,
  OP_MAXFRAMES, 3, 0.5, 0, 0, 0,
  OP_MAXFRAMES, 96000, -1, 0, 0, 0,
  OP_MAXFRAMES, 48000, NANV, 0, 0, 0,
  OP_MAXFRAMES, 48000, 0.01, 0, 0, 0,
  OP_MAXFRAMES, 48000, 0.0426771, 0, 0, 0
};
/* Quantize 0 (and later a NaN grid) on a SYNCED take: _closeTake's grid test
   fails, so the length is exactly what was played. */
static const double S_GRID_ZERO[] = {
  OP_CLOCK, BK_CLOCK_P_QUANTIZE, 0, 0, 0, 0,
  REC(0), PROC(250, 13, SRC_ALL, PRE_SILENT), /* 3250, kept unrounded */
  REC(0), SNAP,
  OP_CLOCK, BK_CLOCK_P_QUANTIZE, 1, 0, 0, 0,
  OP_CLOCK, BK_CLOCK_P_BPM, NANV, 0, 0, 0,    /* grid NaN: immediate, unrounded */
  REC(1), PROC(250, 11, SRC_ALL, PRE_SILENT), /* 2750 */
  REC(1), SNAP, PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP
};
/* Rounded UP to a grid that is long enough, but what was played is not: the
   second half of `len < MIN || recWrite < MIN` drops it on its own. */
static const double S_GRID_UP_SHORT[] = {
  FAST_GRID, CLOCK_STOP,
  REC(0), PROC(250, 6, SRC_ALL, PRE_SILENT), /* 1500 -> 2400, but 1500 < 2048 */
  REC(0), SNAP, QUERY(0)
};
/* A grid longer than the whole buffer: the full take rounds to one grid
   (576000), the max clamp puts it back at one grid, and only the final clamp
   brings it to max_frames. */
static const double S_GRID_HUGE[] = {
  OP_CLOCK, BK_CLOCK_P_BPM, 20, 0, 0, 0,  /* quantize stays 4: 4 * 144000 */
  CLOCK_STOP,
  REC(0), PROC(256, 52, SRC_ALL, PRE_SILENT), /* fills at 12480 */
  SNAP, BUFS(0, 0), CLOCK_RUN, PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP
};
/* A pending punch on a track whose take is undone underneath it: the action
   fires on an EMPTY track (PLAY with no frames, STOP on nothing), and on a
   STOPPED one (STOP does nothing). */
static const double S_UNDO_PENDING[] = {
  FAST_GRID, CLOCK_STOP,
  REC(0), PROC(250, 12, SRC_ALL, PRE_SILENT), REC(0), /* 2400, PLAY */
  CLOCK_RUN, PROC(256, 3, SRC_ALL, PRE_SILENT),
  STOP(0), OP_UNDO, 0, 0, 0, 0, 0, SNAP,       /* pending STOP, now EMPTY */
  PROC(256, 12, SRC_ALL, PRE_SILENT), SNAP,    /* fires on EMPTY: nothing */
  OP_UNDO, 0, 0, 0, 0, 0,                      /* redo: STOPPED, 2400 */
  STOP(0), SNAP, PROC(256, 12, SRC_ALL, PRE_SILENT), SNAP, /* STOP on STOPPED */
  PLAY(0), OP_UNDO, 0, 0, 0, 0, 0, SNAP,       /* pending PLAY, now EMPTY */
  PROC(256, 12, SRC_ALL, PRE_SILENT), SNAP, QUERY(0)
};
static const double S_INIT_CHECK[] = {
  OP_INITCHECK, 0, 0, 0, 0, 0,
  OP_INITCHECK, 1, 0, 0, 0, 0,
  OP_INITCHECK, 2, 0, 0, 0, 0,
  OP_INITCHECK, 3, 0, 0, 0, 0,
  OP_INITCHECK, 4, 0, 0, 0, 0,
  OP_INITCHECK, 5, 0, 0, 0, 0,
  OP_INITCHECK, 6, 0, 0, 0, 0,
  OP_INITCHECK, 7, 0, 0, 0, 0,
  OP_INITCHECK, 8, 0, 0, 0, 0,
  OP_INITCHECK, 9, 0, 0, 0, 0,
  OP_INITCHECK, 10, 0, 0, 0, 0,
  OP_INITCHECK, 11, 0, 0, 0, 0,
  OP_INITCHECK, 12, 0, 0, 0, 0,
  OP_INITCHECK, 13, 0, 0, 0, 0,
  OP_INITCHECK, 14, 0, 0, 0, 0,
  OP_INITCHECK, 15, 0, 0, 0, 0,
  OP_INITCHECK, 16, 0, 0, 0, 0,
  OP_INITCHECK, 17, 0, 0, 0, 0,
  OP_INITCHECK, 18, 0, 0, 0, 0,
  OP_INITCHECK, 19, 0, 0, 0, 0,
  OP_INITCHECK, 20, 0, 0, 0, 0,
  OP_INITCHECK, 21, 0, 0, 0, 0
};
static const double S_BAD_INDEX[] = {
  REC(-1), REC(4), PLAY(-1), STOP(7),
  OP_CLEAR, -1, 0, 0, 0, 0,
  OP_UNDO, -1, 0, 0, 0, 0,
  OP_UNDO, 4, 0, 0, 0, 0,
  QUERY(-1), QUERY(4), QUERY(3),
  OP_TPARAM, -1, K_GAIN, -6, 0, 0,
  OP_CHAINFOR, 3, 0, 0, 0, 0,
  OP_CHAINFOR, 4, 0, 0, 0, 0,
  SNAP
};
static const double S_ZERO_FRAMES[] = {
  FREE(0), REC(0), OP_PROCESS, 0, 3, SRC_ALL, PRE_CONST, PF_BOTH, SNAP,
  PROC(256, 10, SRC_ALL, PRE_SILENT), REC(0),
  OP_PROCESS, 0, 2, SRC_ALL, PRE_CONST, PF_BOTH, SNAP, METERS
};
static const double S_IDLE[] = {
  FREE_TAKE(0),
  /* FREE_TAKE ends with the play gain at 0 (begin_take reset it, nothing has
     played since the close), so play a few blocks to fade in first. */
  PROC(256, 4, SRC_ALL, PRE_SILENT),
  STOP(0), PROC(256, 2, SRC_ALL, PRE_SILENT), QUERY(0), METERS,
  PROC(256, 40, SRC_ALL, PRE_SILENT), QUERY(0), METERS, SNAP, /* fade done: idle */
  OP_TPARAM, 0, K_MUTE, 1, 0, 0,
  PLAY(0), PROC(256, 4, SRC_ALL, PRE_SILENT), QUERY(0), METERS, SNAP
};
static const double S_SOAK[] = {
  FAST_GRID,
  OP_CLOCKADV, 1234, 0, 0, 0, 0,
  REC(0),
  FREE(1), REC(1),
  OP_CHAINADD, 2, 3, UNSET, UNSET, UNSET,
  OP_TPARAM, 2, K_SOURCE, 1, 0, 0,
  REC(2),
  PROC(192, 30, SRC_ALL, PRE_NOISE),
  REC(0), REC(1), REC(2),
  PROC(192, 30, SRC_ALL, PRE_NOISE),
  REC(0), REC(1),
  OP_TPARAM, 0, K_PAN, 0.25, 0, 0,
  OP_TPARAM, 1, K_GAIN, -4.5, 0, 0,
  PROC(192, 40, SRC_ALL, PRE_NOISE),
  REC(0), REC(1), REC(2), STOP(3),
  PROC(192, 30, SRC_ALL, PRE_NOISE),
  OP_UNDO, 1, 0, 0, 0, 0,
  OP_TPARAM, 2, K_SOLO, 1, 0, 0,
  PROC(192, 20, SRC_ALL, PRE_NOISE),
  OP_TPARAM, 2, K_SOLO, 0, 0, 0,
  OP_CLOCK, BK_CLOCK_P_BPM, 211, 0, 0, 0,
  STOP(0), PLAY(1),
  PROC(192, 30, SRC_ALL, PRE_NOISE),
  SNAP, METERS, BUFS(0, 0), BUFS(1, 0), BUFS(2, 0), BUFS(-1, 0)
};

/* --- closing the mutation sweep's harness holes ------------------------- */

/* A quantised punch is pending, then the clock stops and a DIFFERENT action
   is pressed: it runs now, and the old pending must die with it rather than
   fire at the grid line once the clock restarts. Then a quantised REC on a
   STOPPED track: begin_overdub raises the gain at the punch sample, mid-
   block, before the next block's want_gain would. */
static const double S_PENDING_REPLACED[] = {
  FAST_GRID, CLOCK_STOP,
  REC(0), PROC(250, 12, SRC_ALL, PRE_SILENT), REC(0), /* 2400, PLAY */
  CLOCK_RUN, PROC(256, 2, SRC_ALL, PRE_SILENT),
  STOP(0), SNAP,              /* pending STOP */
  CLOCK_STOP, REC(0), SNAP,   /* immediate overdub; pending gone */
  CLOCK_RUN, PROC(256, 12, SRC_ALL, PRE_SILENT), SNAP, /* past the line */
  STOP(0), PROC(256, 12, SRC_ALL, PRE_SILENT),         /* quantised end */
  PROC(256, 20, SRC_ALL, PRE_SILENT), SNAP,            /* STOPPED, faded */
  REC(0), PROC(256, 12, SRC_ALL, PRE_SILENT), SNAP,    /* quantised overdub */
  REC(0), PROC(256, 12, SRC_ALL, PRE_SILENT), SNAP, BUFS(0, 2400)
};
/* CLEAR drops a pending punch: on a playing track (STOP must not fire on the
   now-EMPTY track) and on an empty one (REC must not start a take). */
static const double S_CLEAR_PENDING[] = {
  FAST_GRID, CLOCK_STOP,
  REC(0), PROC(250, 12, SRC_ALL, PRE_SILENT), REC(0),
  CLOCK_RUN, PROC(256, 2, SRC_ALL, PRE_SILENT),
  STOP(0), REC(1), SNAP,
  OP_CLEAR, 0, 0, 0, 0, 0,
  OP_CLEAR, 1, 0, 0, 0, 0, SNAP,
  PROC(256, 12, SRC_ALL, PRE_SILENT), SNAP, QUERY(0), QUERY(1)
};
/* Every track holds a loop, so clear_all reaching the last one is visible. */
static const double S_CLEAR_ALL_4[] = {
  FREE_TAKE(0), FREE_TAKE(1), FREE_TAKE(2), FREE_TAKE(3),
  PROC(256, 2, SRC_ALL, PRE_SILENT),
  OP_CLEARALL, 0, 0, 0, 0, 0, SNAP,
  PROC(256, 2, SRC_ALL, PRE_SILENT), QUERY(3)
};
/* A panic mid-overdub: reset stops the track and disarms the slot WITHOUT
   end_overdub, so layers is still 1 and the half-layer is undoable. Undoing
   it is the one way to reach the `max(1, layers - 1)` floor. */
static const double S_RESET_OVERDUB[] = {
  FREE_TAKE(0),
  REC(0), PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP,
  OP_RESET, 0, 0, 0, 0, 0, SNAP, QUERY(0), BUFS(-1, 5120),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP, BUFS(0, 5120),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP, BUFS(0, 5120)
};
/* Parameter boundaries: the clamps' lower edges, every >= 0.5 threshold at
   exactly 0.5 and just under, and the pan law either side of the centre. */
static const double S_PARAM_EDGES[] = {
  FREE_TAKE(0),
  OP_TPARAM, 0, K_GAIN, -61, 0, 0, SNAP,
  OP_TPARAM, 0, K_GAIN, -60.5, 0, 0,
  OP_TPARAM, 0, K_GAIN, 12.5, 0, 0, SNAP,
  OP_TPARAM, 0, K_GAIN, -3, 0, 0,
  OP_TPARAM, 0, K_PAN, 0.25, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST), SNAP,
  OP_TPARAM, 0, K_PAN, -0.25, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST), SNAP,
  OP_TPARAM, 0, K_PAN, 0, 0, 0,
  OP_TPARAM, 0, K_SOLO, 0.5, 0, 0, SNAP,
  OP_TPARAM, 0, K_SOLO, 0.45, 0, 0, SNAP,
  OP_TPARAM, 0, K_MUTE, 0.45, 0, 0, SNAP,
  OP_TPARAM, 0, K_SYNC, 0.45, 0, 0, SNAP, /* still free: no change */
  OP_TPARAM, 0, K_SYNC, 0.5, 0, 0, SNAP,  /* on */
  OP_TPARAM, 0, K_SYNC, 0.45, 0, 0, SNAP, /* off again */
  OP_PARAM, BK_LOOPER_P_GAIN, -61, 0, 0, 0, SNAP,
  OP_PARAM, BK_LOOPER_P_GAIN, 0, 0, 0, 0,
  OP_PARAM, BK_LOOPER_P_MUTE, 0.5, 0, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST), SNAP,
  OP_PARAM, BK_LOOPER_P_MUTE, 0.45, 0, 0, 0, PROC(256, 2, SRC_ALL, PRE_CONST), SNAP
};
/* Track 1 closes a take while track 0 is mid-overdub: the take steals the
   one undo slot, and must leave it disarmed (undoable at once) even though
   the other track's overdub is still running. */
static const double S_STEAL_UNDO[] = {
  FREE_TAKE(0),
  FREE(1), REC(1), PROC(256, 4, SRC_ALL, PRE_SILENT),
  REC(0), PROC(256, 10, SRC_ALL, PRE_SILENT),
  REC(1), QUERY(1), QUERY(0), SNAP,
  PROC(256, 4, SRC_ALL, PRE_SILENT),
  REC(0), SNAP, QUERY(0), QUERY(1),
  OP_UNDO, 1, 0, 0, 0, 0, SNAP,
  OP_UNDO, 0, 0, 0, 0, 0, SNAP, BUFS(0, 5120), BUFS(-1, 5120)
};
/* Undo-take leaves pos and a still-fading gain behind on an EMPTY track:
   setting sync to the value it already has must not touch pos, and a new
   take must start from silence, not from the fade. */
static const double S_UNDO_TAKE_REARM[] = {
  FREE_TAKE(0), PROC(256, 4, SRC_ALL, PRE_SILENT),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP,
  FREE(0), SNAP,
  REC(0), SNAP, PROC(256, 10, SRC_ALL, PRE_SILENT), REC(0), SNAP,
  PROC(256, 2, SRC_ALL, PRE_SILENT), SNAP
};
/* Undo a take, start a new one, then redo the old take mid-recording: the
   redo restores the length and STOPS the track, but leaves the new take's
   rec_ramp behind (undo never touches it). So the next overdub, and after a
   second undo the next take, must each zero the ramp themselves, or the punch
   starts at full gain instead of fading in. */
static const double S_REDO_IN_TAKE[] = {
  FREE_TAKE(0), PROC(256, 4, SRC_ALL, PRE_SILENT),
  OP_UNDO, 0, 0, 0, 0, 0,
  REC(0), PROC(256, 2, SRC_ALL, PRE_SILENT),
  OP_UNDO, 0, 0, 0, 0, 0, SNAP,
  REC(0), SNAP, PROC(256, 2, SRC_ALL, PRE_SILENT), REC(0), SNAP, BUFS(-1, 5120)
};
static const double S_REDO_IN_TAKE_2[] = {
  FREE_TAKE(0), PROC(256, 4, SRC_ALL, PRE_SILENT),
  OP_UNDO, 0, 0, 0, 0, 0,
  REC(0), PROC(256, 2, SRC_ALL, PRE_SILENT),
  OP_UNDO, 0, 0, 0, 0, 0,
  OP_UNDO, 0, 0, 0, 0, 0, SNAP,
  REC(0), SNAP, PROC(256, 1, SRC_ALL, PRE_SILENT), BUFS(0, 256)
};
/* A free track switched to sync keeps the position it had; PLAY from STOPPED
   then leaves it alone (only a free track restarts from the top). */
static const double S_SYNC_PLAY[] = {
  FREE_TAKE(0), PROC(256, 3, SRC_ALL, PRE_SILENT),
  CLOCK_STOP,
  OP_TPARAM, 0, K_SYNC, 1, 0, 0, SNAP,
  STOP(0), PROC(256, 2, SRC_ALL, PRE_SILENT),
  PLAY(0), SNAP,
  CLOCK_RUN, PROC(256, 4, SRC_ALL, PRE_SILENT), SNAP
};
/* A take shorter than the declick is still faded before it is dropped, and
   clear does not zero audio, so the fade is in the buffer for BUFS to see. */
static const double S_DECLICK_SHORT[] = {
  FREE(0), REC(0), PROC(50, 1, SRC_ALL, PRE_SILENT), REC(0), SNAP, BUFS(0, 64)
};
/* At 1.2 MHz the declick (2400) is longer than a 2304-frame loop, so both
   declick ramps are clamped to the loop. */
static const double S_INIT_HISR[] = {
  OP_INIT, 1200000, 1, 0.02, 0, 0,
  FREE(0), REC(0), PROC(256, 9, SRC_ALL, PRE_SILENT), REC(0), SNAP, BUFS(0, 2304),
  REC(0), PROC(256, 10, SRC_ALL, PRE_SILENT), REC(0), SNAP,
  BUFS(0, 2304), BUFS(-1, 2304),
  OP_UNDO, 0, 0, 0, 0, 0, BUFS(0, 2304)
};
/* An asked-for chain that is empty (never filled, and filled then emptied)
   on a track summed onto a non-empty bus: the direct path rounds once, the
   chain path would round twice. */
static const double S_CHAIN_EMPTY_MIX[] = {
  FREE_TAKE(0),
  OP_CHAINFOR, 1, 0, 0, 0, 0,
  OP_TPARAM, 1, K_SOURCE, 1, 0, 0,
  FREE_TAKE(1),
  OP_CHAINADD, 2, 4, UNSET, UNSET, UNSET,
  OP_CHAINREMOVE, 2, 4, 0, 0, 0,
  FREE_TAKE(2),
  OP_TPARAM, 1, K_GAIN, -2.5, 0, 0,
  OP_TPARAM, 2, K_GAIN, -1.5, 0, 0,
  OP_TPARAM, 2, K_PAN, 0.3, 0, 0,
  PROC(256, 10, SRC_ALL, PRE_NOISE), SNAP, METERS
};
/* Nothing sounds: the output must be left exactly as it was, -0 included. */
static const double S_SILENT_NEGZERO[] = {
  PROC(256, 2, SRC_ALL, PRE_NEGZERO), SNAP,
  FREE_TAKE(0), OP_TPARAM, 0, K_MUTE, 1, 0, 0,
  PROC(256, 4, SRC_ALL, PRE_NEGZERO), STOP(0),
  PROC(256, 30, SRC_ALL, PRE_NEGZERO), QUERY(0), SNAP
};
/* Overdubbing a muted free track: the gain fades to 0 but OVERDUB is still
   "playing", so the position keeps moving and the layer is laid along the
   loop rather than piled onto one sample. */
static const double S_OVERDUB_MUTED[] = {
  FREE_TAKE(0),
  OP_TPARAM, 0, K_MUTE, 1, 0, 0, PROC(256, 20, SRC_ALL, PRE_SILENT),
  REC(0), PROC(256, 10, SRC_ALL, PRE_SILENT), REC(0), SNAP,
  BUFS(0, 5120), BUFS(-1, 5120)
};
/* A block that lies wholly inside the record fade-in: its peak is the
   float-rounded sample read back, and every sample is a ramp sample. */
static const double S_REC_RAMP_METER[] = {
  FREE(0), REC(0), PROC(64, 1, SRC_ALL, PRE_SILENT), METERS,
  PROC(16, 1, SRC_ALL, PRE_SILENT), METERS
};

typedef struct {
  const char *name;
  const double *ops;
  int n_ops;
} scase;

static const scase CASES[] = {
  {"empty", OPS(S_EMPTY)},
  {"arm-never", OPS(S_ARM_NEVER)},
  {"arm-cleared", OPS(S_ARM_CLEARED)},
  {"arm-undo", OPS(S_ARM_UNDO)},
  {"free-take", OPS(S_FREE_TAKE)},
  {"free-stop", OPS(S_FREE_STOP)},
  {"free-play", OPS(S_FREE_PLAY)},
  {"too-short", OPS(S_TOO_SHORT)},
  {"min-exact", OPS(S_MIN_EXACT)},
  {"min-under", OPS(S_MIN_UNDER)},
  {"grid-down", OPS(S_GRID_DOWN)},
  {"grid-half", OPS(S_GRID_HALF)},
  {"grid-tail", OPS(S_GRID_TAIL)},
  {"grid-max", OPS(S_GRID_MAX)},
  {"grid-full", OPS(S_GRID_FULL)},
  {"grid-short", OPS(S_GRID_SHORT)},
  {"full-free", OPS(S_FULL_FREE)},
  {"full-sync", OPS(S_FULL_SYNC)},
  {"quant", OPS(S_QUANT)},
  {"quant-cancel", OPS(S_QUANT_CANCEL)},
  {"block-256", OPS(S_BLOCK_256)},
  {"block-64", OPS(S_BLOCK_64)},
  {"overdub-wrap", OPS(S_OVERDUB_WRAP)},
  {"overdub-stop", OPS(S_OVERDUB_STOP)},
  {"overdub-instant", OPS(S_OVERDUB_INSTANT)},
  {"overdub-sync", OPS(S_OVERDUB_SYNC)},
  {"undo-take", OPS(S_UNDO_TAKE)},
  {"undo-mid", OPS(S_UNDO_MID)},
  {"undo-other", OPS(S_UNDO_OTHER)},
  {"clear-undo", OPS(S_CLEAR_UNDO)},
  {"undo-layers", OPS(S_UNDO_LAYERS)},
  {"mute-solo", OPS(S_MUTE_SOLO)},
  {"pan-gain", OPS(S_PAN_GAIN)},
  {"looper-mute-rec", OPS(S_LOOPER_MUTE_REC)},
  {"source", OPS(S_SOURCE)},
  {"sync-toggle", OPS(S_SYNC_TOGGLE)},
  {"tempo-reset", OPS(S_TEMPO_RESET)},
  {"null-clock", OPS(S_NULL_CLOCK)},
  {"nan-params", OPS(S_NAN_PARAMS)},
  {"chain-never", OPS(S_CHAIN_NEVER)},
  {"chain-empty", OPS(S_CHAIN_EMPTY)},
  {"chain-live", OPS(S_CHAIN_LIVE)},
  {"chain-mix", OPS(S_CHAIN_MIX)},
  {"reset", OPS(S_RESET)},
  {"clear-all", OPS(S_CLEAR_ALL)},
  {"dirty", OPS(S_DIRTY)},
  {"huge", OPS(S_HUGE)},
  {"init-44100", OPS(S_INIT_44100)},
  {"init-96000", OPS(S_INIT_96000)},
  {"init-low", OPS(S_INIT_LOW)},
  {"init-half", OPS(S_INIT_HALF)},
  {"init-negtracks", OPS(S_INIT_NEGTRACKS)},
  {"maxframes", OPS(S_MAXFRAMES)},
  {"grid-zero", OPS(S_GRID_ZERO)},
  {"grid-up-short", OPS(S_GRID_UP_SHORT)},
  {"grid-huge", OPS(S_GRID_HUGE)},
  {"undo-pending", OPS(S_UNDO_PENDING)},
  {"init-check", OPS(S_INIT_CHECK)},
  {"bad-index", OPS(S_BAD_INDEX)},
  {"zero-frames", OPS(S_ZERO_FRAMES)},
  {"idle", OPS(S_IDLE)},
  {"soak", OPS(S_SOAK)},
  {"pending-replaced", OPS(S_PENDING_REPLACED)},
  {"clear-pending", OPS(S_CLEAR_PENDING)},
  {"clear-all-4", OPS(S_CLEAR_ALL_4)},
  {"reset-overdub", OPS(S_RESET_OVERDUB)},
  {"param-edges", OPS(S_PARAM_EDGES)},
  {"steal-undo", OPS(S_STEAL_UNDO)},
  {"undo-take-rearm", OPS(S_UNDO_TAKE_REARM)},
  {"redo-in-take", OPS(S_REDO_IN_TAKE)},
  {"redo-in-take-2", OPS(S_REDO_IN_TAKE_2)},
  {"sync-play", OPS(S_SYNC_PLAY)},
  {"declick-short", OPS(S_DECLICK_SHORT)},
  {"init-hisr", OPS(S_INIT_HISR)},
  {"chain-empty-mix", OPS(S_CHAIN_EMPTY_MIX)},
  {"silent-negzero", OPS(S_SILENT_NEGZERO)},
  {"overdub-muted", OPS(S_OVERDUB_MUTED)},
  {"rec-ramp-meter", OPS(S_REC_RAMP_METER)}
};

int main(int argc, char **argv) {
  FILE *f;
  size_t ci;

  if (argc < 2) {
    fprintf(stderr, "usage: %s <out.bin>\n", argv[0]);
    return 2;
  }
  f = fopen(argv[1], "wb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }
  bk_fill_signal(noise, SRC_LEN, BK_SIG_NOISE);
  bk_parity_open(f);

  for (ci = 0; ci < sizeof(CASES) / sizeof(CASES[0]); ci++) {
    sink s;
    s.p64 = pay64;
    s.n64 = 0;
    s.p32 = pay32;
    s.n32 = 0;
    run_script(CASES[ci].ops, CASES[ci].n_ops, &s);
    if (s.n64 >= MAX_F64 || s.n32 >= MAX_F32) {
      fprintf(stderr, "battery bug: payload overflow in %s (%u, %u)\n", CASES[ci].name, s.n64,
              s.n32);
      return 3;
    }
    bk_parity_emit(f, CASES[ci].name, CASES[ci].ops, (unsigned int)(CASES[ci].n_ops * 6), pay64,
                   s.n64, pay32, s.n32);
  }

  if (!bk_parity_close(f)) {
    fclose(f);
    return 1;
  }
  fclose(f);
  return 0;
}
