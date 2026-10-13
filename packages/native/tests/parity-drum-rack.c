/*
 * Parity dump for the C port of dsp/core/drum-rack.js.
 *
 * Producer half of the oracle; scripts/verify-drum-rack-parity.mjs is the
 * consumer. See parity-io.h for the stream format.
 *
 * The rack is the first ported module that is almost pure *composition*: it
 * owns four numbers of its own (gain, mute, solo, a flash countdown) and
 * otherwise drives sixteen bk_drum_voice and sixteen bk_chain, both already
 * ported and verified green. So the interesting failures here are not
 * arithmetic, they are wiring, and the battery is built to make wiring
 * observable:
 *
 * 1. EVERY PAD'S SAMPLE IS DIFFERENT, ON PURPOSE.
 *
 *    build_buf() salts each buffer from its own pad and layer index — a
 *    rotation of the LCG stream and an exactly-representable scale. If all
 *    sixteen pads held the same noise then a pad rendering the wrong pad's
 *    sample, or summing one pad twice, would produce plausible audio and the
 *    diff would never see it.
 *
 * 2. THE CHAIN EFFECT IS SYNTHETIC AND MIRRORED IN BOTH LANGUAGES.
 *
 *    Same reasoning as parity-chain.c, and the same shape of effect: a
 *    stateful one-pole whose gain derives from its slot id (so the order of
 *    two slots is audible), which counts its process() and reset() calls (so
 *    "did the chain run at all", and "did reset() reach a bypassed slot",
 *    are measurements rather than inferences), and which touches no libm at
 *    all. It deliberately has NO set_carrier_bus: the rack never wires a
 *    carrier bus into a pad chain, and the NULL entry says so.
 *
 * 3. THE SCRIPT REACHES INTO THE PAD CHAINS, BECAUSE THE JS DOES.
 *
 *    OP_CHAINFOR and OP_CHAINADD are the two halves of note 1 in
 *    drum-rack.h. A pad whose chain was never asked for and a pad whose chain
 *    was asked for and left empty must render identically — the `chain-never`
 *    and `chain-empty` pair is scripted so that only the CHAINFOR op differs,
 *    and the consumer asserts their audio is byte-for-byte the same. The
 *    `chain-live` / `chain-live-ref` pair goes the other way: the two scripts
 *    differ only in CHAINADD versus CHAINFOR at the same position, so every
 *    voice field in both dumps must agree while the audio must not.
 *
 * 4. THE DESTINATION IS PREFILLED, AND THE ROUNDING OF THE SUM IS THE POINT.
 *
 *    process() sums into L/R, and so does the bus. Both are `+=` on a
 *    Float32Array with a double on the right in the JS, which rounds once;
 *    the C spells that out in double rather than adding float to float, which
 *    would round twice and differ in the last place. That divergence is only
 *    reachable when the destination is NOT silent, so PROCESS prefills with a
 *    constant or with noise, and `sum-rounding` and `bus-rounding` exist to
 *    put a non-power-of-two gain in front of a non-silent destination.
 *
 * libm is in the path here exactly as it is in drum-voice.c — the pan law, the
 * envelope coefficients, the pitch ratio and dbToGain are all cos/sin/exp/pow
 * — so the consumer pins the observed bit-identity counts rather than assuming
 * they are total.
 *
 * On param keys: the JS setParam takes a string, the C takes the wire index
 * from param-keys.h, for both the rack (DRUM_KEY) and the pads (PAD_KEY). The
 * VM's key columns are those indices, and the consumer maps them back through
 * its own copies of both tables, which it also diffs against the generated
 * header and against backend.ts.
 *
 * Usage: parity-drum-rack <out.bin>
 */

#include "brokodr/dsp/drum-rack.h"

#include "parity-io.h"

#include <math.h>

#define SR 48000.0
#define MAX_BLOCK 256
#define BUF_LEN 512
#define MAX_F64 65536
#define MAX_F32 131072
#define MAX_EFFECTS 40
/* How many of a pad chain's slots the snapshot reports. The battery never puts
   more than two effects on one pad; the consumer mirrors this. */
#define SNAP_SLOTS 2

/* "not specified" in the script encoding, as in parity-chain.c: -1e9 is
   outside every legal value of index, mix and bypassed alike, and unlike NAN
   it is a constant expression a static initialiser will take everywhere. */
#define UNSET (-1e9)

enum {
  OP_END = 0,
  /* Re-init the rack at a different sample rate (a = the rate). The rack's own
     rate-derived number is flashFrames, whose max() branch is unreachable at
     48 kHz; everything else it forwards to the voices. Only ever the first op
     of a script — init is construction, so the consumer mirrors it with a
     fresh DrumRack. */
  OP_INIT = 1,
  OP_SETBUF = 2,       /* a=pad, b=layer, c=kind (<0 => NULL), d=frames, e=rate */
  OP_CLEARPAD = 3,     /* a=pad */
  OP_PADPARAM = 4,     /* a=pad, b=BK_PAD_P_*, c=value */
  OP_TRIGGER = 5,      /* a=pad, b=velocity */
  OP_RELEASE = 6,      /* a=pad */
  OP_PARAM = 7,        /* a=BK_DRUM_P_*, b=value */
  OP_RESET = 8,
  OP_PAD = 9,          /* a=pad; pushes 1/0 for "a pad came back" */
  OP_CHAINFOR = 10,    /* a=pad; pushes 1/0. Marks the chain asked-for. */
  OP_CHAINADD = 11,    /* a=pad, b=id, c=index, d=mix, e=bypassed; pushes 1/0 */
  OP_CHAINREMOVE = 12, /* a=pad, b=id */
  OP_CHAINBYPASS = 13, /* a=pad, b=id, c=on */
  OP_CHAINPARAM = 14,  /* a=pad, b=id, c=key, d=value */
  OP_PROCESS = 15,     /* a=frames, b=prefill kind */
  OP_SNAP = 16
};

/* Buffer kinds. 0..4 are bk_fill_signal's signals; 5 and 6 are built here
   because the LCG cannot produce them. Mirrored in the consumer. */
enum {
  BUF_IMPULSE = 0,
  BUF_STEP = 1,
  BUF_NOISE = 2,
  BUF_RAMP = 3,
  BUF_ZERO = 4,
  BUF_DIRTY = 5, /* NaN, +inf, -0 planted in otherwise-ordinary noise */
  BUF_TINY = 6,  /* everything under sanitize()'s 1e-18 floor */
  BUF_HUGE = 7   /* noise scaled to sanitize()'s 1e30 ceiling, but not over it */
};

/* Prefill kinds for the destination block. Mirrored in the consumer. */
enum { PRE_SILENT = 0, PRE_CONST = 1, PRE_NOISE = 2 };

/* The test effect's own param ids. The chain interprets none of them. */
enum { PK_GAIN = 0, PK_LATENCY = 1, PK_INERT = 2 };

static float pad_buf[BK_PAD_COUNT][BK_DRUM_MAX_LAYERS][BUF_LEN];
static double scratch[BUF_LEN + 16];
static float scr_pad_l[MAX_BLOCK];
static float scr_pad_r[MAX_BLOCK];
static float scr_bus_l[MAX_BLOCK];
static float scr_bus_r[MAX_BLOCK];
static float scr_wet_l[MAX_BLOCK];
static float scr_wet_r[MAX_BLOCK];
static float blk_l[MAX_BLOCK];
static float blk_r[MAX_BLOCK];
static double pay64[MAX_F64];
static float pay32[MAX_F32];

/* --- the stimulus ------------------------------------------------------- */

/*
 * Each buffer is salted by pad*4+layer so that no two pads hold the same
 * samples. The rotation is into the LCG stream and the scale is 1 - k/32,
 * exactly representable, so neither introduces a rounding difference of its
 * own between the two languages.
 */
static int salt_off(int salt) { return salt & 15; }
static double salt_scale(int salt) { return 1.0 - 0.03125 * (double)(salt & 7); }

static void build_buf(float *dst, int n, int kind, int salt) {
  const int off = salt_off(salt);
  const double k = salt_scale(salt);
  int i;

  if (kind == BUF_TINY) {
    for (i = 0; i < n; i++) dst[i] = (float)((i % 2 ? 1e-20 : -1e-20) * (double)(i + 1) * k);
    return;
  }

  if (kind == BUF_HUGE) {
    /* Ordinary noise lifted to around 1e30, which is exactly where sanitize()
       stops passing a value through. The voice's own sanitize() lets these
       samples out intact; the rack's gain pass is the first thing that can
       push them over the edge. */
    bk_fill_signal(scratch, (size_t)(n + 16), BK_SIG_NOISE);
    for (i = 0; i < n; i++) dst[i] = (float)(scratch[i + off] * k * 1e30);
    return;
  }

  bk_fill_signal(scratch, (size_t)(n + 16), kind == BUF_DIRTY ? BK_SIG_NOISE : kind);
  for (i = 0; i < n; i++) dst[i] = (float)(scratch[i + off] * k);

  if (kind == BUF_DIRTY) {
    /* Planted at fixed indices so both sides agree exactly. 1e40 does not fit
       a float32 and becomes +inf in a (float) cast and in a Float32Array
       alike, which is the point — the rack's sanitize() has to survive it. */
    if (n > 3) dst[3] = (float)bk_test_nan();
    if (n > 5) dst[5] = (float)1e40;
    if (n > 7) dst[7] = -0.0f;
    if (n > 9) dst[9] = 0.0f;
  }
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
    blk_l[i] = kind == PRE_CONST ? 0.25f : 0.0f;
    blk_r[i] = kind == PRE_CONST ? -0.5f : 0.0f;
  }
}

/* --- the test effect, mirrored exactly in the JS runner ----------------- */

typedef struct {
  double gain;
  int latency;
  double zl, zr;
  int calls;
  int resets;
  double last_key;
  double last_value;
} tfx;

/* Everything about the effect follows from its slot id, so the script encoding
   needs no room for it, and two slots with different ids do not commute. */
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
  /* PK_INERT is stored and otherwise ignored, so a param the effect does not
     act on is still a measurable call. */
}

static int tfx_latency(const void *self) { return ((const tfx *)self)->latency; }

static double tfx_meter(const void *self) { return ((const tfx *)self)->zl; }

/* No set_carrier_bus: the rack never gives a pad chain a carrier bus, and the
   NULL is what says so. The JS mirror has no such method for the same reason,
   which is also what keeps chain.js's `typeof fx.setCarrierBus === "function"`
   guard on the path it takes here. */
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

/*
 * After every op: the rack's own state, plus the two per-pad arrays the UI
 * reads. An op that quietly did nothing moves this.
 *
 * pad_meters goes out as the float it is stored as. That is the whole test of
 * the field's type: the JS holds these in a Float32Array, so a C port that
 * kept them in double would be one rounding away on every sounding pad and
 * would show up here rather than nowhere.
 */
static void push_state(sink *s, const bk_drum_rack *rk) {
  int p;
  push64(s, bk_drum_rack_sounding(rk) ? 1.0 : 0.0);
  push64(s, rk->meter_l);
  push64(s, rk->meter_r);
  push64(s, rk->gain);
  push64(s, rk->muted ? 1.0 : 0.0);
  push64(s, (double)rk->solo);
  for (p = 0; p < BK_PAD_COUNT; p++) push64(s, (double)rk->pad_meters[p]);
  for (p = 0; p < BK_PAD_COUNT; p++) push64(s, (double)rk->trigger_flags[p]);
}

/* Everything else observable, for OP_SNAP. Order is the contract with the
   consumer; a field added on one side only fails every record, which is the
   intended failure mode. */
static void push_snap(sink *s, const bk_drum_rack *rk) {
  int p, i, j;

  push64(s, rk->sr);
  push64(s, (double)rk->max_block);
  push64(s, (double)rk->flash_frames);

  for (p = 0; p < BK_PAD_COUNT; p++) {
    const bk_drum_voice *v = &rk->pads[p];
    const bk_chain *ch = &rk->pad_chains[p];

    push64(s, v->active ? 1.0 : 0.0);
    push64(s, (double)v->stage);
    push64(s, v->env);
    push64(s, v->pos);
    push64(s, v->meter);
    push64(s, (double)v->choke_group);
    push64(s, (double)v->layer);
    push64(s, (double)v->next_layer);
    push64(s, (double)v->layer_count);
    push64(s, v->step);
    push64(s, v->vel_gain);
    push64(s, (double)v->hold_left);
    push64(s, v->choking ? 1.0 : 0.0);
    push64(s, v->muted ? 1.0 : 0.0);
    push64(s, v->gain);
    push64(s, v->pan_l.value);
    push64(s, v->pan_r.value);
    /* The layer table, so a setBuffer that landed on the wrong pad — or a
       clearPad that cleared the wrong one — is visible as structure rather
       than only as audio. */
    for (i = 0; i < BK_DRUM_MAX_LAYERS; i++) {
      push64(s, v->layers[i].data ? 1.0 : 0.0);
      push64(s, (double)v->layers[i].frames);
    }

    /* chain_used is the C's record of "the host asked for this pad's chain",
       which is exactly what `padChains[p] !== null` means in the JS. Note 1 in
       drum-rack.h claims those two are the same thing; this is where the claim
       is measured. */
    push64(s, rk->chain_used[p] ? 1.0 : 0.0);
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
        for (i = 0; i < 8; i++) push64(s, 0.0);
      }
    }
  }
}

static void run_script(const double *ops, int n_ops, sink *s) {
  bk_drum_rack rk;
  tfx pool[MAX_EFFECTS];
  int n_fx = 0;
  int i;

  bk_drum_rack_init(&rk, SR, MAX_BLOCK, scr_pad_l, scr_pad_r, scr_bus_l, scr_bus_r, scr_wet_l,
                    scr_wet_r);

  for (i = 0; i < n_ops; i++) {
    const double *o = ops + (size_t)i * 6;
    const int op = (int)o[0];
    const double a = o[1];
    const double b = o[2];
    const double c = o[3];
    const double d = o[4];
    const double e = o[5];

    switch (op) {
      case OP_INIT:
        bk_drum_rack_init(&rk, a, MAX_BLOCK, scr_pad_l, scr_pad_r, scr_bus_l, scr_bus_r, scr_wet_l,
                          scr_wet_r);
        n_fx = 0;
        break;
      case OP_SETBUF: {
        const int pi = (int)a;
        const int li = (int)b;
        const int kind = (int)c;
        const int frames = (int)d;
        if (kind < 0) {
          /* A null handoff: the layer is emptied. The count goes through as
             scripted rather than as zero, which is what the host does when it
             drops a sample without zeroing the rest of the message. */
          bk_drum_rack_set_pad_buffer(&rk, pi, li, NULL, frames, e);
        } else {
          const int p = pi & (BK_PAD_COUNT - 1);
          const int l = li & (BK_DRUM_MAX_LAYERS - 1);
          build_buf(pad_buf[p][l], frames, kind, p * 4 + l);
          bk_drum_rack_set_pad_buffer(&rk, pi, li, pad_buf[p][l], frames, e);
        }
        break;
      }
      case OP_CLEARPAD:
        bk_drum_rack_clear_pad(&rk, (int)a);
        break;
      case OP_PADPARAM:
        bk_drum_rack_set_pad_param(&rk, (int)a, (int)b, c);
        break;
      case OP_TRIGGER:
        bk_drum_rack_trigger(&rk, (int)a, b);
        break;
      case OP_RELEASE:
        bk_drum_rack_release(&rk, (int)a);
        break;
      case OP_PARAM:
        bk_drum_rack_set_param(&rk, (int)a, b);
        break;
      case OP_RESET:
        bk_drum_rack_reset(&rk);
        break;
      case OP_PAD:
        push64(s, bk_drum_rack_pad(&rk, (int)a) ? 1.0 : 0.0);
        break;
      case OP_CHAINFOR:
        push64(s, bk_drum_rack_chain_for(&rk, (int)a) ? 1.0 : 0.0);
        break;
      case OP_CHAINADD: {
        bk_chain *ch = bk_drum_rack_chain_for(&rk, (int)a);
        bk_slot *got = NULL;
        if (ch && n_fx < MAX_EFFECTS) {
          bk_slot_spec spec;
          const int id = (int)b;
          tfx_init(&pool[n_fx], id);
          spec.id = id;
          spec.type = id; /* the test effect's whole config derives from the id */
          spec.index = (c == UNSET) ? BK_CHAIN_APPEND : (int)c;
          spec.mix = (d == UNSET) ? NAN : d;
          spec.bypassed = (e == UNSET) ? BK_CHAIN_KEEP : (int)e;
          spec.effect = &pool[n_fx];
          spec.vt = &VT;
          got = bk_chain_add(ch, &spec);
          /* A rejected add must not consume a pool entry, or the next add
             would land on a half-initialised effect and the divergence would
             read as a rack bug. */
          if (got) n_fx++;
        }
        push64(s, got ? 1.0 : 0.0);
        break;
      }
      case OP_CHAINREMOVE: {
        bk_chain *ch = bk_drum_rack_chain_for(&rk, (int)a);
        if (ch) bk_chain_remove(ch, (int)b);
        break;
      }
      case OP_CHAINBYPASS: {
        bk_chain *ch = bk_drum_rack_chain_for(&rk, (int)a);
        if (ch) bk_chain_set_bypass(ch, (int)b, (int)c);
        break;
      }
      case OP_CHAINPARAM: {
        bk_chain *ch = bk_drum_rack_chain_for(&rk, (int)a);
        if (ch) bk_chain_set_param(ch, (int)b, (int)c, d);
        break;
      }
      case OP_PROCESS: {
        const int frames = (int)a;
        int k;
        prefill(frames, (int)b);
        bk_drum_rack_process(&rk, blk_l, blk_r, (size_t)frames);
        for (k = 0; k < frames; k++) push32(s, blk_l[k]);
        for (k = 0; k < frames; k++) push32(s, blk_r[k]);
        break;
      }
      case OP_SNAP:
        push_snap(s, &rk);
        break;
      default:
        break;
    }
    push_state(s, &rk);
  }
}

/* --- the battery -------------------------------------------------------- */

/* Every script row is exactly six doubles wide. OPS's division is integer, so
   a row written with five or seven values in it does not fail to compile: it
   silently drops the script's last op and shifts every op after the typo into
   the wrong columns. That happened once, in S_PAD_PARAMS, and the parity diff
   could not see it — both sides mis-read the same script identically and
   agreed. So the row width is a compile-time assertion now.

   ROWS_OK is the BUILD_BUG_ON_ZERO trick: it is 0 for a well-formed script,
   and for a malformed one it asks for a char array of size -1, which no C
   compiler will accept. If it fires, the error names a negative array size
   rather than the real problem — the script named on that line has a row that
   is not six wide. */
#define ROWS_OK(x) ((int)sizeof(char[1 - 2 * !!(sizeof(x) % (6 * sizeof(double)))]) - 1)
#define OPS(x) (x), (int)(sizeof(x) / sizeof(double) / 6) + ROWS_OK(x)

/* Rack params, spelled with the generated names so a reordering of DRUM_KEY
   moves the battery too. */
#define R_GAIN BK_DRUM_P_GAIN
#define R_MUTE BK_DRUM_P_MUTE
#define R_SOLO BK_DRUM_P_SOLO
#define R_ROUTE BK_DRUM_P_ROUTE

/* Pad params, likewise. */
#define P_ATTACK BK_PAD_P_ATTACK
#define P_DECAY BK_PAD_P_DECAY
#define P_SUSTAIN BK_PAD_P_SUSTAIN
#define P_RELEASE BK_PAD_P_RELEASE
#define P_HOLD BK_PAD_P_HOLD
#define P_PITCH BK_PAD_P_PITCH
#define P_START BK_PAD_P_START
#define P_REVERSE BK_PAD_P_REVERSE
#define P_GAIN BK_PAD_P_GAIN
#define P_PAN BK_PAD_P_PAN
#define P_MODE BK_PAD_P_MODE
#define P_VEL BK_PAD_P_VEL_AMOUNT
#define P_CHOKE BK_PAD_P_CHOKE
#define P_MUTE BK_PAD_P_MUTE

/*
 * Read these as rows of {op, a, b, c, d, e}. SETBUF is
 * {OP_SETBUF, pad, layer, kind, frames, rate}; CHAINADD is
 * {OP_CHAINADD, pad, id, index, mix, bypassed} with UNSET meaning the JS's
 * `undefined`.
 */

/* Nothing loaded, nothing triggered, and every control poked at an index that
   does not exist. None of it may do anything, and the prefilled block must
   come back exactly as it went in — that is the `!sounded` early return. */
static const double S_EMPTY[] = {
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_CONST, 0, 0, 0,
  OP_PROCESS, 64, PRE_NOISE, 0, 0, 0,
  OP_PAD, -1, 0, 0, 0, 0,
  OP_PAD, 16, 0, 0, 0, 0,
  OP_PAD, 0, 0, 0, 0, 0,
  OP_CHAINFOR, -1, 0, 0, 0, 0,
  OP_CHAINFOR, 16, 0, 0, 0, 0,
  OP_CLEARPAD, 99, 0, 0, 0, 0,
  OP_TRIGGER, 99, 1, 0, 0, 0,
  OP_RELEASE, 99, 0, 0, 0, 0,
  OP_PADPARAM, 99, P_GAIN, -6, 0, 0,
  OP_CHAINADD, 99, 5, UNSET, UNSET, UNSET,
  OP_CHAINREMOVE, 99, 5, 0, 0, 0,
  OP_CHAINBYPASS, 99, 5, 1, 0, 0,
  OP_CHAINPARAM, 99, 5, PK_GAIN, 0.5, 0,
  OP_RESET, 0, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_CONST, 0, 0, 0
};

/* One pad, one hit, played out, into every kind of destination. */
static const double S_DEFAULT[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Two pads on the bus at once, with different samples and different pans, so
   a pad summed into the wrong side of the bus is audible. */
static const double S_TWO_PADS[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 5, 0, BUF_RAMP, 512, SR,
  OP_PADPARAM, 0, P_PAN, -0.75, 0, 0,
  OP_PADPARAM, 5, P_PAN, 0.5, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 5, 0.8, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* All sixteen at once: the full sum, and every pad_meter written in one pass.
   Velocities differ per pad so the pads are not interchangeable. */
static const double S_ALL_PADS[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 256, SR,
  OP_SETBUF, 1, 0, BUF_NOISE, 256, SR,
  OP_SETBUF, 2, 0, BUF_RAMP, 256, SR,
  OP_SETBUF, 3, 0, BUF_RAMP, 256, SR,
  OP_SETBUF, 4, 0, BUF_STEP, 256, SR,
  OP_SETBUF, 5, 0, BUF_STEP, 256, SR,
  OP_SETBUF, 6, 0, BUF_NOISE, 256, SR,
  OP_SETBUF, 7, 0, BUF_NOISE, 256, SR,
  OP_SETBUF, 8, 0, BUF_RAMP, 256, SR,
  OP_SETBUF, 9, 0, BUF_RAMP, 256, SR,
  OP_SETBUF, 10, 0, BUF_NOISE, 256, SR,
  OP_SETBUF, 11, 0, BUF_NOISE, 256, SR,
  OP_SETBUF, 12, 0, BUF_STEP, 256, SR,
  OP_SETBUF, 13, 0, BUF_STEP, 256, SR,
  OP_SETBUF, 14, 0, BUF_RAMP, 256, SR,
  OP_SETBUF, 15, 0, BUF_NOISE, 256, SR,
  OP_TRIGGER, 0, 1.0, 0, 0, 0,
  OP_TRIGGER, 1, 0.9, 0, 0, 0,
  OP_TRIGGER, 2, 0.8, 0, 0, 0,
  OP_TRIGGER, 3, 0.7, 0, 0, 0,
  OP_TRIGGER, 4, 0.6, 0, 0, 0,
  OP_TRIGGER, 5, 0.5, 0, 0, 0,
  OP_TRIGGER, 6, 0.4, 0, 0, 0,
  OP_TRIGGER, 7, 0.3, 0, 0, 0,
  OP_TRIGGER, 8, 1.0, 0, 0, 0,
  OP_TRIGGER, 9, 0.9, 0, 0, 0,
  OP_TRIGGER, 10, 0.8, 0, 0, 0,
  OP_TRIGGER, 11, 0.7, 0, 0, 0,
  OP_TRIGGER, 12, 0.6, 0, 0, 0,
  OP_TRIGGER, 13, 0.5, 0, 0, 0,
  OP_TRIGGER, 14, 0.4, 0, 0, 0,
  OP_TRIGGER, 15, 0.3, 0, 0, 0,
  OP_PARAM, R_GAIN, -12, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* A closed hat killing an open one. Pad 2 is choked — faded, not cut — while
   pad 3 starts clean, and pad 4 shares neither group and must be untouched. */
static const double S_CHOKE[] = {
  OP_SETBUF, 2, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 3, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 4, 0, BUF_NOISE, 512, SR,
  OP_PADPARAM, 2, P_CHOKE, 1, 0, 0,
  OP_PADPARAM, 3, P_CHOKE, 1, 0, 0,
  OP_PADPARAM, 2, P_DECAY, 800, 0, 0,
  OP_PADPARAM, 3, P_DECAY, 800, 0, 0,
  OP_PADPARAM, 4, P_DECAY, 800, 0, 0,
  OP_TRIGGER, 2, 1, 0, 0, 0,
  OP_TRIGGER, 4, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_TRIGGER, 3, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Retriggering a pad in a group does NOT choke that pad itself: trigger()
   restarts the envelope in place, which is a different and audibly softer
   thing than a choke fade. */
static const double S_CHOKE_SELF[] = {
  OP_SETBUF, 2, 0, BUF_NOISE, 512, SR,
  OP_PADPARAM, 2, P_CHOKE, 3, 0, 0,
  OP_PADPARAM, 2, P_DECAY, 800, 0, 0,
  OP_TRIGGER, 2, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_TRIGGER, 2, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* A pad in the group that is not sounding is not choked either — the guard is
   on `active`, and choke() on an idle voice must leave it idle rather than
   set the choking flag for its next hit to inherit.

   The first version of this case triggered pad 3 before pad 2, which left pad
   3 sounding when pad 2 fired: that is S_CHOKE over again, and the idle guard
   was never reached. Pad 3 stays untouched until after the choke loop has run
   past it, and then takes its own hit, which has to start clean. */
static const double S_CHOKE_IDLE[] = {
  OP_SETBUF, 2, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 3, 0, BUF_NOISE, 512, SR,
  OP_PADPARAM, 2, P_CHOKE, 1, 0, 0,
  OP_PADPARAM, 3, P_CHOKE, 1, 0, 0,
  OP_PADPARAM, 2, P_DECAY, 800, 0, 0,
  OP_PADPARAM, 3, P_DECAY, 800, 0, 0,
  OP_TRIGGER, 2, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_TRIGGER, 3, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Group 0 is "no group", not "group number zero": two pads left at the default
   must not choke each other however hard they are hit. */
static const double S_CHOKE_GROUP_ZERO[] = {
  OP_SETBUF, 2, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 3, 0, BUF_NOISE, 512, SR,
  OP_PADPARAM, 2, P_DECAY, 800, 0, 0,
  OP_PADPARAM, 3, P_DECAY, 800, 0, 0,
  OP_TRIGGER, 2, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_TRIGGER, 3, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Different non-zero groups do not choke each other. */
static const double S_CHOKE_CROSS[] = {
  OP_SETBUF, 2, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 3, 0, BUF_NOISE, 512, SR,
  OP_PADPARAM, 2, P_CHOKE, 1, 0, 0,
  OP_PADPARAM, 3, P_CHOKE, 2, 0, 0,
  OP_PADPARAM, 2, P_DECAY, 800, 0, 0,
  OP_PADPARAM, 3, P_DECAY, 800, 0, 0,
  OP_TRIGGER, 2, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_TRIGGER, 3, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Solo cuts the others outright, with reset() and not choke(): no fade, and
   nothing to hear on the next block either. Un-soloing must not bring a tail
   back. */
static const double S_SOLO[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 1, 0, BUF_NOISE, 512, SR,
  OP_PADPARAM, 0, P_DECAY, 800, 0, 0,
  OP_PADPARAM, 1, P_DECAY, 800, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 1, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_SOLO, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_SOLO, -1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* The solo field's arithmetic: anything negative is "no solo" rather than a
   clamp to -1, and the rest is Math.round then clamp to the grid. */
static const double S_SOLO_CLAMP[] = {
  OP_PARAM, R_SOLO, -5, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_SOLO, -0.4, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_SOLO, 99, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_SOLO, 3.6, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_SOLO, 3.4, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_SOLO, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_SOLO, 15.5, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Solo on a pad that is not sounding, while another pad is: every voice is
   excluded or idle, `sounded` stays false, and the early return leaves the
   prefilled block alone. */
static const double S_SOLO_SILENT[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PARAM, R_SOLO, 7, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/*
 * Mute freezes the rack: no voice runs, so no envelope advances and no pan
 * smoother moves, and a note held through a mute comes back exactly where it
 * was. The flash keeps counting down, because it is a "this pad fired" light
 * and not a "this pad is audible" one.
 *
 * Scripted against S_MUTE_REF, which is this script with the mute pair and the
 * muted block removed: block 2 here must equal block 1 there.
 */
static const double S_MUTE[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_PADPARAM, 0, P_PAN, 0.6, 0, 0,
  OP_PADPARAM, 0, P_DECAY, 800, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_MUTE, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_MUTE, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

static const double S_MUTE_REF[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_PADPARAM, 0, P_PAN, 0.6, 0, 0,
  OP_PADPARAM, 0, P_DECAY, 800, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* mute is a threshold at 0.5, not a boolean cast. */
static const double S_MUTE_THRESHOLD[] = {
  OP_PARAM, R_MUTE, 0.49, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_MUTE, 0.5, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_MUTE, -3, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_MUTE, 7, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Rack gain in dB, through dbToGain and its clamp. */
static const double S_GAIN[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0, 0,
  OP_PARAM, R_GAIN, -6, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0, 0,
  OP_PARAM, R_GAIN, 99, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0, 0,
  OP_PARAM, R_GAIN, -999, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0, 0,
  OP_PARAM, R_GAIN, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0, 0
};

/*
 * The rounding of the final sum into the caller's buffer.
 *
 * The JS is `L[i] += l` on a Float32Array with a double `l`: the stored float
 * widens, the sum is exact in double, and the result is rounded once. A C port
 * that wrote `l[i] += (float)sl` would round twice and differ in the last
 * place on values near a float boundary. A non-power-of-two gain in front of a
 * noisy destination is what makes that reachable — with a silent destination,
 * or a gain of 1 and an exactly-representable prefill, the two roundings agree
 * and the bug hides.
 */
static const double S_SUM_ROUNDING[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_PARAM, R_GAIN, -3.1, 0, 0, 0,
  OP_TRIGGER, 0, 0.73, 0, 0, 0,
  OP_PROCESS, 256, PRE_NOISE, 0, 0, 0,
  OP_PROCESS, 256, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/*
 * The same trap one stage earlier, on the rack bus: `busL[i] += padL[i]` is
 * float-to-float in the JS and therefore one rounding of two exactly-known
 * floats, which C reproduces only by widening both. Two pads, both on the
 * chain path, so both go through that sum.
 */
static const double S_BUS_ROUNDING[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 1, 0, BUF_NOISE, 512, SR,
  OP_CHAINADD, 0, 5, UNSET, UNSET, UNSET,
  OP_CHAINADD, 1, 6, UNSET, UNSET, UNSET,
  OP_TRIGGER, 0, 0.91, 0, 0, 0,
  OP_TRIGGER, 1, 0.83, 0, 0, 0,
  OP_PROCESS, 256, PRE_NOISE, 0, 0, 0,
  OP_PROCESS, 256, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* "route" is on the wire but is not a rack param: engine.js owns it. Sending
   it, and an index past the end of the table, must change nothing. */
static const double S_ROUTE_NOOP[] = {
  OP_PARAM, R_GAIN, -6, 0, 0, 0,
  OP_PARAM, R_MUTE, 1, 0, 0, 0,
  OP_PARAM, R_SOLO, 4, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_ROUTE, 2, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_ROUTE, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, 77, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/*
 * The pair that measures note 1 of drum-rack.h: a pad whose chain was never
 * asked for, and the same pad with the chain asked for and left empty. The two
 * scripts differ in exactly one op, and their audio must be byte-identical.
 */
static const double S_CHAIN_NEVER[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

static const double S_CHAIN_EMPTY[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_CHAINFOR, 0, 0, 0, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/*
 * The other pair: `chain-live` puts one effect on pad 0, `chain-live-ref`
 * asks for the chain and leaves it empty. CHAINADD and CHAINFOR both push one
 * value at the same offset, so the two dumps line up field for field — every
 * voice field and every pad meter must agree while the audio must not, which
 * is the claim that a per-pad chain changes the pad's audio and nothing else.
 */
static const double S_CHAIN_LIVE[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 2, 0, BUF_RAMP, 512, SR,
  OP_CHAINADD, 0, 5, UNSET, UNSET, UNSET,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 2, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

static const double S_CHAIN_LIVE_REF[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 2, 0, BUF_RAMP, 512, SR,
  OP_CHAINFOR, 0, 0, 0, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 2, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Two slots on one pad, and the same two in the other order. The effect gains
   derive from the ids, so the chain does not commute and the two cases must
   differ. */
static const double S_CHAIN_TWO[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_CHAINADD, 0, 5, UNSET, UNSET, UNSET,
  OP_CHAINADD, 0, 6, UNSET, UNSET, UNSET,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

static const double S_CHAIN_TWO_SWAPPED[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_CHAINADD, 0, 6, UNSET, UNSET, UNSET,
  OP_CHAINADD, 0, 5, UNSET, UNSET, UNSET,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* An effect on pad 3 while pads 0 and 3 both sound: the effect runs once per
   block, and only pad 3 goes through it. */
static const double S_CHAIN_OTHER_PAD[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 3, 0, BUF_NOISE, 512, SR,
  OP_CHAINADD, 3, 7, UNSET, 0.6, UNSET,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 3, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_CHAINPARAM, 3, 7, PK_GAIN, 0.125, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_CHAINPARAM, 3, 7, PK_INERT, 4, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Two pads each with their own live chain in one block — the case that proves
   sharing one wet scratch pair across all sixteen chains is safe, because the
   JS gives every chain its own and the two must still agree. */
static const double S_CHAIN_BOTH[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 9, 0, BUF_RAMP, 512, SR,
  OP_CHAINADD, 0, 5, UNSET, UNSET, UNSET,
  OP_CHAINADD, 9, 8, UNSET, UNSET, UNSET,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 9, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* A bypassed slot still counts towards the chain's length, so the pad keeps
   taking the chain path — and bypassing resets the effect. */
static const double S_CHAIN_BYPASS[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_CHAINADD, 0, 5, UNSET, UNSET, UNSET,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_CHAINBYPASS, 0, 5, 1, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_CHAINBYPASS, 0, 5, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Removing the last slot puts the pad back on the direct path. */
static const double S_CHAIN_REMOVE[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_CHAINADD, 0, 5, UNSET, UNSET, UNSET,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_CHAINREMOVE, 0, 5, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* clearPad() is both halves: the layers AND the chain. A bad index clears
   neither. */
static const double S_CLEAR_PAD[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 0, 1, BUF_RAMP, 256, SR,
  OP_SETBUF, 4, 0, BUF_NOISE, 512, SR,
  OP_CHAINADD, 0, 5, UNSET, UNSET, UNSET,
  OP_CHAINADD, 4, 6, UNSET, UNSET, UNSET,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 4, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_CLEARPAD, 0, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_CLEARPAD, 16, 0, 0, 0, 0,
  OP_CLEARPAD, -1, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* reset() resets every voice, panics every chain, and clears the meters and
   the flashes. The effects' reset counters are how "panic reached this chain"
   stops being an inference. */
static const double S_RESET[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 7, 0, BUF_NOISE, 512, SR,
  OP_CHAINADD, 0, 5, UNSET, UNSET, UNSET,
  OP_CHAINADD, 7, 6, UNSET, UNSET, UNSET,
  OP_PARAM, R_GAIN, -6, 0, 0, 0,
  OP_PARAM, R_SOLO, 3, 0, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 7, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_RESET, 0, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/*
 * The flash countdown, in frames and not in blocks. 4320 frames at 48 kHz, so
 * seventeen 256-frame blocks leave it just short of zero and the eighteenth
 * takes it negative — which it is allowed to do.
 *
 * The pad has no sample: trigger() lights the flash regardless, because it is
 * a "this pad fired" light. A bad index lights nothing.
 */
static const double S_FLASH[] = {
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 99, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* The flash keeps counting down under a mute — freezing it would leave the
   grid lit from before the mute. */
static const double S_FLASH_MUTED[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PARAM, R_MUTE, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 256, PRE_CONST, 0, 0, 0,
  OP_PROCESS, 256, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Re-init at 44.1 kHz. Every coefficient under the pads moves with the rate,
   and so does the flash. */
static const double S_INIT_44100[] = {
  OP_INIT, 44100, 0, 0, 0, 0,
  OP_SETBUF, 0, 0, BUF_NOISE, 512, 44100,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* A rate low enough that 90 ms is fewer frames than one block, which is the
   only stimulus that reaches the max() in the flash calculation. */
static const double S_INIT_SLOW[] = {
  OP_INIT, 2000, 0, 0, 0, 0,
  OP_SETBUF, 0, 0, BUF_NOISE, 512, 2000,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* A zero-frame block: every loop has to survive it, and the flash must not
   move. */
static const double S_ZERO_FRAMES[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_CHAINADD, 0, 5, UNSET, UNSET, UNSET,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 0, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_MUTE, 1, 0, 0, 0,
  OP_PROCESS, 0, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* 256 frames, in one call, in two and in eight. Two pads, one of them on the
   chain path, so both render paths are checked for block independence. */
static const double S_BLOCK_1[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 1, 0, BUF_RAMP, 512, SR,
  OP_CHAINADD, 1, 5, UNSET, UNSET, UNSET,
  OP_PADPARAM, 0, P_DECAY, 400, 0, 0,
  OP_PADPARAM, 1, P_DECAY, 400, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 1, 1, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

static const double S_BLOCK_2[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 1, 0, BUF_RAMP, 512, SR,
  OP_CHAINADD, 1, 5, UNSET, UNSET, UNSET,
  OP_PADPARAM, 0, P_DECAY, 400, 0, 0,
  OP_PADPARAM, 1, P_DECAY, 400, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 1, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

static const double S_BLOCK_8[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 1, 0, BUF_RAMP, 512, SR,
  OP_CHAINADD, 1, 5, UNSET, UNSET, UNSET,
  OP_PADPARAM, 0, P_DECAY, 400, 0, 0,
  OP_PADPARAM, 1, P_DECAY, 400, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 1, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Every pad param through the rack's forwarder, plus an unknown key and a bad
   pad index, so setPadParam is measured as a forwarder rather than assumed. */
static const double S_PAD_PARAMS[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 0, 1, BUF_RAMP, 256, SR,
  OP_PADPARAM, 0, P_ATTACK, 3, 0, 0,
  OP_PADPARAM, 0, P_DECAY, 250, 0, 0,
  OP_PADPARAM, 0, P_SUSTAIN, 0.4, 0, 0,
  OP_PADPARAM, 0, P_RELEASE, 40, 0, 0,
  OP_PADPARAM, 0, P_HOLD, 2, 0, 0,
  OP_PADPARAM, 0, P_PITCH, 3, 0, 0,
  OP_PADPARAM, 0, P_START, 0.1, 0, 0,
  OP_PADPARAM, 0, P_REVERSE, 1, 0, 0,
  OP_PADPARAM, 0, P_GAIN, -4, 0, 0,
  OP_PADPARAM, 0, P_PAN, -0.3, 0, 0,
  /* GATE, which is 0: mode is the one pad param the snapshot cannot show, so
     the only way to prove it was forwarded is to release the voice further
     down and watch the stage move. Setting it to 1 would set it to the value
     it already had, and a port that dropped the key entirely would pass. */
  OP_PADPARAM, 0, P_MODE, 0, 0, 0,
  OP_PADPARAM, 0, P_VEL, 0.7, 0, 0,
  OP_PADPARAM, 0, P_CHOKE, 2, 0, 0,
  OP_PADPARAM, 0, P_MUTE, 1, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PADPARAM, 0, 99, 1, 0, 0,
  OP_PADPARAM, -1, P_GAIN, -30, 0, 0,
  OP_PADPARAM, 16, P_GAIN, -30, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PADPARAM, 0, P_MUTE, 0, 0, 0,
  OP_TRIGGER, 0, 0.6, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_RELEASE, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* A sample with a NaN, an infinity and a negative zero in it, run into a
   noisy destination at +12 dB: the rack's sanitize() is the only thing
   between that and the output. */
static const double S_DIRTY[] = {
  OP_SETBUF, 0, 0, BUF_DIRTY, 256, SR,
  OP_SETBUF, 1, 0, BUF_TINY, 256, SR,
  OP_PARAM, R_GAIN, 12, 0, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 1, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* The same, but with the dirty sample on a pad that has a chain, so the
   infinities go through the chain's crossfade as well as the bus. */
static const double S_DIRTY_CHAIN[] = {
  OP_SETBUF, 0, 0, BUF_DIRTY, 256, SR,
  OP_CHAINADD, 0, 5, UNSET, 0.5, UNSET,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* An empty layer handed over with a nonzero frame count, a zero-length buffer,
   and a mismatched source rate — all three through the rack's forwarder. */
static const double S_SETBUF_EDGES[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, 44100,
  OP_SETBUF, 1, 0, BUF_NOISE, 0, SR,
  OP_SETBUF, 2, 0, -1, 256, SR,
  OP_SETBUF, 3, 0, BUF_NOISE, 512, 0,
  OP_SETBUF, -1, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 16, 0, BUF_NOISE, 512, SR,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 1, 1, 0, 0, 0,
  OP_TRIGGER, 2, 1, 0, 0, 0,
  OP_TRIGGER, 3, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_SETBUF, 0, 0, -1, 0, SR,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* GATE mode through the rack: release() has to reach the right pad, and a
   release on an idle pad has to do nothing. */
static const double S_RELEASE[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 1, 0, BUF_NOISE, 512, SR,
  /* GATE is 0 and ONESHOT is 1, and ONESHOT is the default. This case was
     written with 1 in it, which set both pads to the mode they were already
     in — the mode where release() is documented to do nothing. The case
     proved release() reached the pad by watching it do nothing at all. */
  OP_PADPARAM, 0, P_MODE, 0, 0, 0,
  OP_PADPARAM, 1, P_MODE, 0, 0, 0,
  OP_PADPARAM, 0, P_SUSTAIN, 0.7, 0, 0,
  OP_PADPARAM, 1, P_SUSTAIN, 0.7, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 1, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_RELEASE, 0, 0, 0, 0, 0,
  OP_RELEASE, 5, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  /* And now pad 1, which is the op that proves release() reaches the pad it
     was handed rather than a fixed one. Releasing pad 0 cannot show that —
     pad 0 is the fixed one a bug would pick — and the release of idle pad 5
     above cannot either, because a release that went to pad 0 instead would
     find pad 0 already released and do nothing visible. Pad 1 is still in its
     decay, so a release that lands on it is unmistakable. */
  OP_RELEASE, 1, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* A long mixed run: everything moving at once, across odd block sizes, so
   state that only goes wrong after a while has somewhere to go wrong. */
static const double S_SOAK[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 1, 0, BUF_RAMP, 384, SR,
  OP_SETBUF, 2, 0, BUF_STEP, 256, 44100,
  OP_SETBUF, 3, 1, BUF_NOISE, 512, SR,
  OP_SETBUF, 8, 0, BUF_DIRTY, 256, SR,
  OP_PADPARAM, 0, P_CHOKE, 1, 0, 0,
  OP_PADPARAM, 1, P_CHOKE, 1, 0, 0,
  OP_PADPARAM, 2, P_PAN, 0.4, 0, 0,
  OP_PADPARAM, 3, P_PITCH, -5, 0, 0,
  OP_PADPARAM, 8, P_DECAY, 600, 0, 0,
  OP_CHAINADD, 2, 5, UNSET, UNSET, UNSET,
  OP_CHAINADD, 8, 6, UNSET, 0.4, UNSET,
  OP_CHAINADD, 8, 7, 0, UNSET, UNSET,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 2, 0.5, 0, 0, 0,
  OP_TRIGGER, 8, 0.9, 0, 0, 0,
  OP_PROCESS, 96, PRE_NOISE, 0, 0, 0,
  OP_PARAM, R_GAIN, -2.5, 0, 0, 0,
  OP_TRIGGER, 1, 0.75, 0, 0, 0,
  OP_PROCESS, 33, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_SOLO, 8, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_PARAM, R_SOLO, -1, 0, 0, 0,
  OP_TRIGGER, 3, 1, 0, 0, 0,
  OP_PROCESS, 7, PRE_NOISE, 0, 0, 0,
  OP_PARAM, R_MUTE, 1, 0, 0, 0,
  OP_PROCESS, 64, PRE_CONST, 0, 0, 0,
  OP_PARAM, R_MUTE, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_CHAINBYPASS, 8, 6, 1, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_CHAINREMOVE, 8, 7, 0, 0, 0,
  OP_TRIGGER, 8, 0.4, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0, 0,
  OP_CLEARPAD, 2, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_RESET, 0, 0, 0, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 1, 1, 0, 0, 0,
  OP_PROCESS, 256, PRE_NOISE, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/*
 * The cases below all exist because a deliberate mutation of drum-rack.c
 * survived the battery without them. Each one names the hole it closes.
 */

/* 90 ms at 8050 Hz is 724.5 frames, and 724.5 is the only kind of number that
   can tell Math.round apart from a truncation and from a half-to-even rint().
   Every other rate this battery inits at — 48000, 44100, 2000 — makes
   90 * sr / 1000 a whole number, and all three roundings agree on those, so
   js_round() was free to be wrong. 725 is also comfortably over MAX_BLOCK, so
   the max() in the flash calculation cannot mask the difference either. */
static const double S_FLASH_FRACTIONAL[] = {
  OP_INIT, 8050, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_SETBUF, 0, 0, BUF_NOISE, 512, 8050,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* Bad indices read immediately. S_EMPTY pokes the same ones, but its only
   snapshot after them comes after a reset() has wiped the evidence — a bad
   index that lit a flash, or that fell through onto pad 0, went unseen there.
   Pad 0 is loaded and left idle on purpose: it is the pad a clamped index
   would land on. */
static const double S_BAD_INDEX[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_TRIGGER, 99, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_TRIGGER, -1, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_TRIGGER, 16, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_RELEASE, 99, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/* The last pad. Nothing else in the battery asks pad 15 for a chain or watches
   it through a reset, so an off-by-one at the top of the range — in pad(), in
   chainFor(), or in reset()'s loop — had nowhere to show itself. */
static const double S_PAD_15[] = {
  OP_SETBUF, 15, 0, BUF_NOISE, 512, SR,
  OP_CHAINADD, 15, 5, UNSET, UNSET, UNSET,
  OP_PADPARAM, 15, P_DECAY, 800, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_TRIGGER, 15, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_RESET, 0, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/*
 * Solo, with an idle pad whose pan smoother is mid-move.
 *
 * setPadParam('pan') moves the smoother's TARGET and nothing else; the value
 * only catches up while the pad renders, and the rack never renders an idle
 * pad. So pad 3 sits with value != target indefinitely, and reset() — which
 * parks the pan at its value and throws the target away — is destructive on
 * it. That is why the solo cut has to check `active` first, and the proof is
 * the next hit: a trigger from silence jumps the pan straight to its target,
 * so pad 3's pan after its first hit says whether solo reset it or not.
 *
 * Pad 1 is here to be genuinely cut, and the solo index is 0 — the one index
 * a `solo > 0` test would wave through as "no solo at all". S_SOLO_CLAMP sets
 * solo to 0 but never renders a block under it.
 */
static const double S_SOLO_IDLE_PAN[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 1, 0, BUF_NOISE, 512, SR,
  OP_SETBUF, 3, 0, BUF_NOISE, 512, SR,
  OP_PADPARAM, 0, P_DECAY, 800, 0, 0,
  OP_PADPARAM, 1, P_DECAY, 800, 0, 0,
  OP_PADPARAM, 3, P_DECAY, 800, 0, 0,
  OP_PADPARAM, 3, P_PAN, -0.9, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_TRIGGER, 1, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_SOLO, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PARAM, R_SOLO, -1, 0, 0, 0,
  OP_TRIGGER, 3, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/*
 * A pad that is active with no sample left under it.
 *
 * setBuffer(0, null) drops layerCount to zero without clearing `active`, and
 * DrumVoice.trigger then returns at its first line. That early return is the
 * only thing that makes the choke loop's `i != index` guard observable:
 * choke() sets `choking`, trigger() normally clears it on the way out, and
 * here trigger never gets that far. A pad that chokes its own tail is left
 * marked as choking; a pad that skips itself is untouched.
 *
 * The snapshot has to come before the next process(), because a voice whose
 * sample was pulled out goes idle on its next block and takes `choking` with
 * it.
 */
static const double S_CHOKE_NO_SAMPLE[] = {
  OP_SETBUF, 0, 0, BUF_NOISE, 512, SR,
  OP_PADPARAM, 0, P_CHOKE, 1, 0, 0,
  OP_PADPARAM, 0, P_DECAY, 800, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_SETBUF, 0, 0, -1, 0, SR,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

/*
 * Dirt that only exists on the bus.
 *
 * The voice sanitises its own output, so every kind of dirt planted in a
 * sample — BUF_DIRTY's NaN and inf, BUF_TINY's denormals — is already gone by
 * the time it reaches the bus, and dropping sanitize() from the gain pass
 * changed nothing measurable. BUF_HUGE is a sample the voice passes intact, at
 * around sanitize()'s 1e30 ceiling; +12 dB of rack gain is then the first
 * thing that takes it over, so the gain pass has to be the one that catches
 * it. Attack 0 so the envelope is at full on the first frame rather than
 * ramping up through the interesting range.
 */
static const double S_BUS_SANITIZE[] = {
  OP_SETBUF, 0, 0, BUF_HUGE, 512, SR,
  OP_PADPARAM, 0, P_ATTACK, 0, 0, 0,
  OP_PADPARAM, 0, P_DECAY, 8000, 0, 0,
  OP_PARAM, R_GAIN, 12, 0, 0, 0,
  OP_TRIGGER, 0, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0, 0
};

typedef struct {
  const char *name;
  const double *ops;
  int n_ops;
} scase;

static const scase CASES[] = {
  {"empty", OPS(S_EMPTY)},
  {"default", OPS(S_DEFAULT)},
  {"two-pads", OPS(S_TWO_PADS)},
  {"all-pads", OPS(S_ALL_PADS)},
  {"choke", OPS(S_CHOKE)},
  {"choke-self", OPS(S_CHOKE_SELF)},
  {"choke-idle", OPS(S_CHOKE_IDLE)},
  {"choke-group-zero", OPS(S_CHOKE_GROUP_ZERO)},
  {"choke-cross", OPS(S_CHOKE_CROSS)},
  {"solo", OPS(S_SOLO)},
  {"solo-clamp", OPS(S_SOLO_CLAMP)},
  {"solo-silent", OPS(S_SOLO_SILENT)},
  {"mute", OPS(S_MUTE)},
  {"mute-ref", OPS(S_MUTE_REF)},
  {"mute-threshold", OPS(S_MUTE_THRESHOLD)},
  {"gain", OPS(S_GAIN)},
  {"sum-rounding", OPS(S_SUM_ROUNDING)},
  {"bus-rounding", OPS(S_BUS_ROUNDING)},
  {"route-noop", OPS(S_ROUTE_NOOP)},
  {"chain-never", OPS(S_CHAIN_NEVER)},
  {"chain-empty", OPS(S_CHAIN_EMPTY)},
  {"chain-live", OPS(S_CHAIN_LIVE)},
  {"chain-live-ref", OPS(S_CHAIN_LIVE_REF)},
  {"chain-two", OPS(S_CHAIN_TWO)},
  {"chain-two-swapped", OPS(S_CHAIN_TWO_SWAPPED)},
  {"chain-other-pad", OPS(S_CHAIN_OTHER_PAD)},
  {"chain-both", OPS(S_CHAIN_BOTH)},
  {"chain-bypass", OPS(S_CHAIN_BYPASS)},
  {"chain-remove", OPS(S_CHAIN_REMOVE)},
  {"clear-pad", OPS(S_CLEAR_PAD)},
  {"reset", OPS(S_RESET)},
  {"flash", OPS(S_FLASH)},
  {"flash-muted", OPS(S_FLASH_MUTED)},
  {"init-44100", OPS(S_INIT_44100)},
  {"init-slow", OPS(S_INIT_SLOW)},
  {"zero-frames", OPS(S_ZERO_FRAMES)},
  {"block-1x256", OPS(S_BLOCK_1)},
  {"block-2x128", OPS(S_BLOCK_2)},
  {"block-8x32", OPS(S_BLOCK_8)},
  {"pad-params", OPS(S_PAD_PARAMS)},
  {"dirty", OPS(S_DIRTY)},
  {"dirty-chain", OPS(S_DIRTY_CHAIN)},
  {"setbuf-edges", OPS(S_SETBUF_EDGES)},
  {"release", OPS(S_RELEASE)},
  {"soak", OPS(S_SOAK)},
  {"flash-fractional", OPS(S_FLASH_FRACTIONAL)},
  {"bad-index", OPS(S_BAD_INDEX)},
  {"pad-15", OPS(S_PAD_15)},
  {"solo-idle-pan", OPS(S_SOLO_IDLE_PAN)},
  {"choke-no-sample", OPS(S_CHOKE_NO_SAMPLE)},
  {"bus-sanitize", OPS(S_BUS_SANITIZE)}
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
  bk_parity_open(f);

  for (ci = 0; ci < sizeof(CASES) / sizeof(CASES[0]); ci++) {
    sink s;
    s.p64 = pay64;
    s.n64 = 0;
    s.p32 = pay32;
    s.n32 = 0;
    run_script(CASES[ci].ops, CASES[ci].n_ops, &s);
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
