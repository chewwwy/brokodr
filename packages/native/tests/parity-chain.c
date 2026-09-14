/*
 * Parity dump for the C port of dsp/core/chain.js.
 *
 * Producer half of the oracle; scripts/verify-chain-parity.mjs is the consumer.
 * See parity-io.h for the stream format.
 *
 * This module is not arithmetic, and the battery is shaped by that.
 *
 * utils, biquad, delay-line and fft are functions: feed numbers in, diff the
 * numbers out. chain.js is a *host*. What it can get wrong is ordering, which
 * slot got the command, whether a bypassed module still burns its state,
 * whether latency was recalculated, whether a crossfade advanced. None of that
 * is visible in a single output buffer, and none of it is reachable by calling
 * one function once. So two things are different here:
 *
 * 1. THE EFFECT IS SYNTHETIC, AND MIRRORED IN BOTH LANGUAGES.
 *
 *    None of the 22 effect modules are ported yet, and deliberately so — they
 *    are late in the port order. Borrowing one would also make this battery
 *    measure that effect's arithmetic rather than the chain's behaviour, and a
 *    failure would not say which was at fault. Instead there is a test effect
 *    below, defined here and mirrored line for line in the JS runner. It is
 *    built to make chain behaviour observable rather than to sound like
 *    anything:
 *
 *      - it is STATEFUL (a one-pole), so reset()/panic()/bypass are visible,
 *        and so a bypassed-but-still-rendered slot would show up;
 *      - its gain differs per slot id, so the chain is NON-COMMUTATIVE and a
 *        wrong order is audible rather than silently equivalent;
 *      - it COUNTS its process() and reset() calls, so "was this called at
 *        all" is a measurement and not an inference;
 *      - it can report a NaN meter and a -0 meter, because those are the
 *        readSlotMeters quirks that need pinning;
 *      - one variant omits setCarrierBus/latencySamples/meter entirely, which
 *        is what exercises the chain's optional-member handling — the JS's
 *        duck typing against this port's NULL vtable slots.
 *
 *    It uses no libm at all: a multiply, an add, and a float32 store. If the
 *    test effect called tanh() then libm spread inside the *stimulus* to the
 *    chain would be indistinguishable from a chain divergence, which is the
 *    same trap parity-io.h avoids for the input signal.
 *
 * 2. THE BATTERY IS A COMMAND SCRIPT, NOT A PARAMETER SWEEP.
 *
 *    Each record is a little program — add, move, bypass, render, snapshot —
 *    encoded as 5-double opcodes and carried in the record's params. The JS
 *    runner reads the program out of the stream and replays it, so the battery
 *    still lives in the C and only in the C. Nothing to keep in sync.
 *
 *    Every op appends the chain's (length, latencySamples) to the f64 payload,
 *    so an op that quietly did nothing moves the dump. SNAP appends everything
 *    observable: per-slot id/type/bypass/mix/target, each effect's gain,
 *    latency, call count, reset count and filter state, the meter block as
 *    readSlotMeters writes it, and indexOf/find over a fixed probe set
 *    including ids that are not there. PROCESS appends the rendered block.
 *
 * On param keys. Chain.setParam takes a *string* key ("quality") because that
 * is what engine.js hands it; bk_chain_set_param takes a canonical int,
 * because the audio thread should not be comparing strings. The host does that
 * mapping either way — the worklet already keeps the table, as slot.paramNames
 * — so the VM's key column is an index here and the equivalent name in the JS
 * runner. That mapping is part of the contract being tested, and the runner
 * asserts it lines up rather than assuming it.
 *
 * Known deliberate divergence, not exercised because it has no value to
 * compare: bk_chain_set_param skips a NULL set_param, where the JS would throw
 * a TypeError on an effect with no setParam. C being defensive where JS is
 * fatal is not a parity failure, and a throw is not a number.
 *
 * Usage: parity-chain <out.bin>
 */

#include "brokodr/dsp/chain.h"

#include "parity-io.h"

#include <math.h>

#define SR 48000.0
#define MAX_BLOCK 256
#define SIG_LEN 8192
#define MAX_F64 32768
#define MAX_F32 131072
#define MAX_EFFECTS 32
#define N_PROBE 12

/* "not specified" in the script encoding: index, mix and bypassed all use it.
   -1e9 is outside every legal value of all three, and unlike NAN it is a
   constant expression a static initialiser will take on every toolchain. */
#define UNSET (-1e9)

enum {
  OP_ADD = 1,
  OP_REMOVE = 2,
  OP_MOVE = 3,
  OP_PARAM = 4,
  OP_MIX = 5,
  OP_BYPASS = 6,
  OP_RESETSLOT = 7,
  OP_CLEAR = 8,
  OP_PANIC = 9,
  OP_PROCESS = 10,
  OP_CARRIER = 11,
  OP_SNAP = 12
};

/* Param ids the VM addresses, in this test effect's own numbering — the chain
   interprets none of them (see chain.h). PK_QUALITY is the one the *harness*
   treats as quality, playing the host's role; PK_LATENCY also moves the
   reported latency but is not the quality key, which is how the battery
   manufactures a stale latency for the recalc-on-a-miss quirk to correct. */
enum { PK_QUALITY = 0, PK_GAIN = 1, PK_CARRIER = 2, PK_LATENCY = 3, PK_INERT = 4 };

static double sig_l[SIG_LEN];
static double sig_r[SIG_LEN];
static float carrier_l[MAX_BLOCK];
static float carrier_r[MAX_BLOCK];
static float wet_l[MAX_BLOCK];
static float wet_r[MAX_BLOCK];
static float blk_l[MAX_BLOCK];
static float blk_r[MAX_BLOCK];
static double pay64[MAX_F64];
static float pay32[MAX_F32];

static const int probe_ids[N_PROBE] = {1, 2, 3, 4, 5, 6, 7, 8, 100, 101, 102, 999};

/* --- the test effect, mirrored exactly in the JS runner ---------------- */

typedef struct {
  double gain;
  double carrier_amt;
  int latency;
  int meter_mode;
  double zl, zr;
  int calls;
  int resets;
  double last_key;
  double last_value;
  const float *cl;
  const float *cr;
  /* How many times the chain called setCarrierBus. A chain that calls it with
     a null bus instead of not calling it at all is indistinguishable from the
     pointers alone, so the call has to be counted, not just its effect. */
  int carrier_sets;
} tfx;

/*
 * Everything about an effect follows from its slot id, so the script encoding
 * needs no room for it. id >= 100 gets the minimal vtable.
 *
 * meter_mode is id % 5, which spreads the four interesting meter readings
 * across the ids the scripts use: 0 -> live state, 1 -> NaN, 2 -> +0,
 * 3 -> -0, 4 -> a constant.
 */
static void tfx_init(tfx *e, int id) {
  e->gain = 0.5 + 0.25 * (double)(id % 4);
  e->carrier_amt = 0.125 * (double)(id % 3);
  e->latency = (id % 3) * 8;
  e->meter_mode = id % 5;
  e->zl = 0.0;
  e->zr = 0.0;
  e->calls = 0;
  e->resets = 0;
  e->last_key = -1.0;
  e->last_value = 0.0;
  e->cl = 0;
  e->cr = 0;
  e->carrier_sets = 0;
}

static void tfx_process(void *self, float *l, float *r, int frames) {
  tfx *e = (tfx *)self;
  int i;
  for (i = 0; i < frames; i++) {
    e->zl = e->zl * 0.5 + (double)l[i] * e->gain;
    e->zr = e->zr * 0.5 + (double)r[i] * e->gain;
    if (e->cl) {
      e->zl += (double)e->cl[i] * e->carrier_amt;
      e->zr += (double)e->cr[i] * e->carrier_amt;
    }
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
  if (key == PK_QUALITY) e->latency = (int)value;
  else if (key == PK_GAIN) e->gain = value;
  else if (key == PK_CARRIER) e->carrier_amt = value;
  else if (key == PK_LATENCY) e->latency = (int)value;
  /* PK_INERT is stored and otherwise ignored, so a param the effect does not
     know about is still a measurable call. */
}

static void tfx_set_carrier_bus(void *self, const float *l, const float *r) {
  tfx *e = (tfx *)self;
  e->cl = l;
  e->cr = r;
  e->carrier_sets++;
}

static int tfx_latency(const void *self) {
  return ((const tfx *)self)->latency;
}

static double tfx_meter(const void *self) {
  const tfx *e = (const tfx *)self;
  switch (e->meter_mode) {
    case 1:
      return NAN; /* -> 0 through `effect.meter || 0` */
    case 2:
      return 0.0;
    case 3:
      return -0.0; /* -> +0, same quirk */
    case 4:
      return 0.25;
    default:
      return e->zl;
  }
}

static const bk_effect_vt VT_FULL = {tfx_process, tfx_reset,   tfx_set_param,
                                     tfx_set_carrier_bus, tfx_latency, tfx_meter};

/* No carrier bus, no latency, no meter — the optional-member paths. setParam
   stays, because the JS would throw without it (see the header note). */
static const bk_effect_vt VT_MINIMAL = {tfx_process, tfx_reset, tfx_set_param, 0, 0, 0};

/* --- the VM ------------------------------------------------------------- */

static void snap(const bk_chain *c, double *p, int *k) {
  int i;
  double meters[BK_CHAIN_MAX_SLOTS + 4];
  int n;

  p[(*k)++] = (double)bk_chain_length(c);
  p[(*k)++] = (double)c->latency_samples;

  for (i = 0; i < c->n_slots; i++) {
    const bk_slot *s = &c->slots[i];
    const tfx *e = (const tfx *)s->effect;
    p[(*k)++] = (double)s->id;
    p[(*k)++] = (double)s->type;
    p[(*k)++] = (double)s->bypassed;
    p[(*k)++] = s->mix.value;
    p[(*k)++] = s->mix.target;
    p[(*k)++] = s->mix_target;
    p[(*k)++] = e->gain;
    p[(*k)++] = (double)e->latency;
    p[(*k)++] = (double)e->calls;
    p[(*k)++] = (double)e->resets;
    p[(*k)++] = e->zl;
    p[(*k)++] = e->zr;
    p[(*k)++] = e->last_key;
    p[(*k)++] = e->last_value;
    p[(*k)++] = e->cl ? 1.0 : 0.0;
    p[(*k)++] = e->carrier_amt;
    p[(*k)++] = (double)e->carrier_sets;
  }

  /* The meter block exactly as the API writes it. Prefilled with a sentinel
     and written at a non-zero offset, so both the return count and the
     untouched neighbours are part of the comparison: an off-by-one in the
     offset handling would otherwise hide behind a zero. */
  for (i = 0; i < BK_CHAIN_MAX_SLOTS + 4; i++) meters[i] = -7.0;
  n = bk_chain_read_slot_meters(c, meters, 2);
  p[(*k)++] = (double)n;
  for (i = 0; i < BK_CHAIN_MAX_SLOTS + 4; i++) p[(*k)++] = meters[i];

  /* Lookup, including ids that are not in the chain. */
  for (i = 0; i < N_PROBE; i++) {
    p[(*k)++] = (double)bk_chain_index_of(c, probe_ids[i]);
    p[(*k)++] = bk_chain_find((bk_chain *)c, probe_ids[i]) ? 1.0 : 0.0;
  }
}

/* Run one script and emit it as a record. Returns 0 on overflow. */
static int run_script(FILE *f, const char *name, const double *ops, int n_ops, int max_slots) {
  bk_chain c;
  tfx pool[MAX_EFFECTS];
  int n_fx = 0;
  int k64 = 0;
  int k32 = 0;
  int cursor = 0;
  double params[2 + 5 * 64];
  int i, o;

  if (n_ops > 64) return 0;
  if (bk_chain_init(&c, SR, MAX_BLOCK, max_slots, wet_l, wet_r) != 0) return 0;

  for (o = 0; o < n_ops; o++) {
    const int code = (int)ops[o * 5 + 0];
    const double a = ops[o * 5 + 1];
    const double b = ops[o * 5 + 2];
    const double cc = ops[o * 5 + 3];
    const double d = ops[o * 5 + 4];

    switch (code) {
      case OP_ADD: {
        const int id = (int)a;
        bk_slot_spec spec;
        bk_slot *got;
        if (n_fx >= MAX_EFFECTS) return 0;
        tfx_init(&pool[n_fx], id);
        spec.id = id;
        spec.type = id; /* the test effect's whole config derives from the id */
        spec.index = (b == UNSET) ? BK_CHAIN_APPEND : (int)b;
        spec.mix = (cc == UNSET) ? NAN : cc;
        spec.bypassed = (d == UNSET) ? BK_CHAIN_KEEP : (int)d;
        spec.effect = &pool[n_fx];
        spec.vt = (id >= 100) ? &VT_MINIMAL : &VT_FULL;
        got = bk_chain_add(&c, &spec);
        pay64[k64++] = got ? 1.0 : 0.0;
        /* A rejected add must not consume a pool entry, or the next add would
           land on a half-initialised effect and the divergence would look like
           a chain bug. */
        if (got) n_fx++;
        break;
      }
      case OP_REMOVE:
        bk_chain_remove(&c, (int)a);
        break;
      case OP_MOVE:
        bk_chain_move(&c, (int)a, (int)b);
        break;
      case OP_PARAM:
        /* The harness stands in for the host here, and the host is what owns
           the quality decision now (see chain.h). PK_QUALITY is this test
           effect's own index for it; the real host reads the name out of the
           slot's param table. Deliberately outside any "does the slot exist"
           test, because the name is known either way — which is what keeps
           chain.js's recalc-on-a-miss behaviour intact end to end. */
        bk_chain_set_param(&c, (int)a, (int)b, cc);
        if ((int)b == PK_QUALITY) bk_chain_recalc_latency(&c);
        break;
      case OP_MIX:
        bk_chain_set_mix(&c, (int)a, b);
        break;
      case OP_BYPASS:
        bk_chain_set_bypass(&c, (int)a, (int)b);
        break;
      case OP_RESETSLOT:
        bk_chain_reset_slot(&c, (int)a);
        break;
      case OP_CLEAR:
        bk_chain_clear(&c);
        break;
      case OP_PANIC:
        bk_chain_panic(&c);
        break;
      case OP_CARRIER:
        if (a >= 0.5) bk_chain_set_carrier_bus(&c, carrier_l, carrier_r);
        else bk_chain_set_carrier_bus(&c, 0, 0);
        break;
      case OP_PROCESS: {
        const int frames = (int)a;
        if (frames > MAX_BLOCK || k32 + frames * 2 > MAX_F32) return 0;
        for (i = 0; i < frames; i++) {
          blk_l[i] = (float)sig_l[(cursor + i) % SIG_LEN];
          blk_r[i] = (float)sig_r[(cursor + i) % SIG_LEN];
        }
        cursor += frames;
        bk_chain_process(&c, blk_l, blk_r, frames);
        for (i = 0; i < frames; i++) pay32[k32++] = blk_l[i];
        for (i = 0; i < frames; i++) pay32[k32++] = blk_r[i];
        break;
      }
      case OP_SNAP:
        snap(&c, pay64, &k64);
        break;
      default:
        return 0;
    }

    /* After every op, unconditionally: an op that silently did nothing, or
       that forgot to recalculate, moves these two numbers. */
    if (k64 + 2 > MAX_F64) return 0;
    pay64[k64++] = (double)bk_chain_length(&c);
    pay64[k64++] = (double)c.latency_samples;
  }

  params[0] = (double)max_slots;
  params[1] = (double)n_ops;
  for (i = 0; i < n_ops * 5; i++) params[2 + i] = ops[i];
  bk_parity_emit(f, name, params, (unsigned int)(2 + n_ops * 5), pay64, (unsigned int)k64, pay32,
                 (unsigned int)k32);
  return 1;
}

/* --- the scripts -------------------------------------------------------- */

/* Read these as rows of {op, a, b, c, d}. ADD is {OP_ADD, id, index, mix,
   bypassed} with UNSET meaning the JS's `undefined`. */

static const double S_EMPTY[] = {
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0, /* no slots: the block must come back untouched */
  OP_SNAP,    0, 0, 0, 0,
  OP_PANIC,   0, 0, 0, 0, /* and neither of these may fall over on nothing */
  OP_CLEAR,   0, 0, 0, 0,
  OP_REMOVE,  1, 0, 0, 0,
  OP_MOVE,    1, 0, 0, 0,
  OP_MIX,     1, 0.5, 0, 0,
  OP_BYPASS,  1, 1, 0, 0,
  OP_RESETSLOT, 1, 0, 0, 0,
  OP_PARAM,   1, PK_GAIN, 0.5, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
};

static const double S_SINGLE[] = {
  OP_ADD,     5, UNSET, UNSET, UNSET, /* id 5: meter mode 0, latency 16 */
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0, /* default mix is 1 and settled: the fast path */
  OP_PROCESS, 7, 0, 0, 0,  /* odd block, to catch a frames/2 style bug */
  OP_PROCESS, 256, 0, 0, 0,
  OP_PROCESS, 1, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

static const double S_MIX_GLIDE[] = {
  OP_ADD,     5, UNSET, UNSET, UNSET,
  OP_PROCESS, 32, 0, 0, 0,
  OP_MIX,     5, 0.25, 0, 0, /* set(), so it glides — the crossfade path */
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 256, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_MIX,     5, 1, 0, 0, /* back up: still the slow path until it settles */
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_MIX,     5, 7, 0, 0, /* out of range: clamp to 1 */
  OP_SNAP,    0, 0, 0, 0,
  OP_MIX,     5, -3, 0, 0, /* clamp to 0 */
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

/*
 * The fast-path threshold, which is the sharpest quirk in the module.
 *
 * A slot added with mix 0.99995 is settled the instant it exists (add resets
 * the smoother rather than gliding), and 0.99995 >= 0.9999, so the render
 * takes the branch that copies wet over dry wholesale: a 0.99995 mix is
 * rendered as exactly 1. The sibling at 0.9998 is settled too but below the
 * bar, so it crossfades. Both halves have to port, including the one that is
 * arguably wrong.
 */
static const double S_FAST_PATH[] = {
  OP_ADD,     5, UNSET, 0.99995, UNSET,
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_CLEAR,   0, 0, 0, 0,
  OP_ADD,     5, UNSET, 0.9998, UNSET,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

/* mix 0 at add time: the output is pure dry, but the effect still renders and
   still advances its state. A chain that "optimised" a zero mix away would
   pass the audio diff and fail on the call count. */
static const double S_MIX_ZERO[] = {
  OP_ADD,     5, UNSET, 0, UNSET,
  OP_PROCESS, 64, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

/* Order. Three different gains, so the chain is non-commutative: reversing it
   has to change the audio, which the runner asserts separately. */
static const double S_ORDER[] = {
  OP_ADD,     1, UNSET, UNSET, UNSET,
  OP_ADD,     2, UNSET, UNSET, UNSET,
  OP_ADD,     3, UNSET, UNSET, UNSET,
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_MOVE,    3, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_MOVE,    3, 2, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
};

/*
 * move()'s clamp is applied after the removal, so with three slots the last
 * reachable index is 2 and asking for 99 lands at 2, not at 3. Also: move()
 * does not recalculate latency, which the per-op (length, latency) trace pins.
 */
static const double S_MOVE_EDGES[] = {
  OP_ADD,  1, UNSET, UNSET, UNSET,
  OP_ADD,  2, UNSET, UNSET, UNSET,
  OP_ADD,  3, UNSET, UNSET, UNSET,
  OP_MOVE, 1, 99, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_MOVE, 1, -5, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_MOVE, 2, 1, 0, 0, /* to where it already is */
  OP_SNAP, 0, 0, 0, 0,
  OP_MOVE, 999, 0, 0, 0, /* not there: a no-op, and not a crash */
  OP_SNAP, 0, 0, 0, 0,
};

/* Insertion index: at the head, in the middle, past the end, and negative. */
static const double S_ADD_INDEX[] = {
  OP_ADD,  1, UNSET, UNSET, UNSET,
  OP_ADD,  2, 0, UNSET, UNSET,
  OP_ADD,  3, 1, UNSET, UNSET,
  OP_ADD,  4, 99, UNSET, UNSET,
  OP_ADD,  5, -4, UNSET, UNSET,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
};

/* Bypass: the module is skipped, its state is dropped on the way out, and its
   latency leaves the chain total. Re-engaging must not dump a stale tail. */
static const double S_BYPASS[] = {
  OP_ADD,     1, UNSET, UNSET, UNSET,
  OP_ADD,     2, UNSET, UNSET, UNSET,
  OP_ADD,     5, UNSET, UNSET, UNSET,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_BYPASS,  2, 1, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_BYPASS,  2, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_BYPASS,  999, 1, 0, 0, /* not there */
  OP_SNAP,    0, 0, 0, 0,
};

/* bypassed straight from the spec, which is a different path from setBypass:
   no reset() call, and the latency total never counted it. */
static const double S_BYPASS_AT_ADD[] = {
  OP_ADD,     1, UNSET, UNSET, 1,
  OP_ADD,     5, UNSET, UNSET, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

static const double S_REMOVE[] = {
  OP_ADD,     1, UNSET, UNSET, UNSET,
  OP_ADD,     2, UNSET, UNSET, UNSET,
  OP_ADD,     3, UNSET, UNSET, UNSET,
  OP_ADD,     4, UNSET, UNSET, UNSET,
  OP_PROCESS, 64, 0, 0, 0,
  OP_REMOVE,  2, 0, 0, 0, /* from the middle */
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  /* Make the chain's latency deliberately stale first: a non-quality param
     changes what the module reports without recalculating the total. Only then
     is the missed remove's recalc visible — without this the total is already
     correct and a remove() that skipped the recalc would read the same. */
  OP_PARAM,   3, PK_LATENCY, 96, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_REMOVE,  999, 0, 0, 0, /* absent: the recalc still runs */
  OP_SNAP,    0, 0, 0, 0,
  OP_REMOVE,  1, 0, 0, 0, /* the head */
  OP_REMOVE,  4, 0, 0, 0, /* the tail */
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
};

static const double S_CLEAR_PANIC[] = {
  OP_ADD,     1, UNSET, UNSET, UNSET,
  OP_ADD,     2, UNSET, UNSET, UNSET,
  OP_ADD,     5, UNSET, UNSET, UNSET,
  OP_BYPASS,  2, 1, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_PANIC,   0, 0, 0, 0, /* resets the bypassed slot too */
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_RESETSLOT, 5, 0, 0, 0,
  OP_RESETSLOT, 999, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_CLEAR,   0, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0, /* cleared: straight through again */
  OP_ADD,     3, UNSET, UNSET, UNSET, /* and usable afterwards */
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

/*
 * Latency, and the recalc-on-a-miss quirk.
 *
 * PK_LATENCY moves what a module reports without telling the chain, so after
 * that op the chain's total is deliberately stale. The next op addresses
 * PK_QUALITY to an id that is NOT in the chain — and the JS runs
 * recalcLatency() anyway, because it tests the key outside the `if (s)` guard.
 * So a number that had no business changing changes, and the per-op trace
 * records it. Fixing that is a behaviour change and not this phase's job.
 */
static const double S_LATENCY[] = {
  OP_ADD,   1, UNSET, UNSET, UNSET, /* latency 8 */
  OP_ADD,   2, UNSET, UNSET, UNSET, /* latency 16 */
  OP_ADD,   3, UNSET, UNSET, UNSET, /* latency 0 */
  OP_SNAP,  0, 0, 0, 0,
  OP_PARAM, 1, PK_LATENCY, 24, 0, /* now stale: chain still says 24 total */
  OP_SNAP,  0, 0, 0, 0,
  OP_PARAM, 999, PK_QUALITY, 0, 0, /* a miss, and yet the total updates */
  OP_SNAP,  0, 0, 0, 0,
  OP_PARAM, 2, PK_QUALITY, 40, 0, /* a hit: sets latency and recalculates */
  OP_SNAP,  0, 0, 0, 0,
  OP_PARAM, 3, PK_INERT, 1.5, 0, /* neither: stored, no recalc */
  OP_SNAP,  0, 0, 0, 0,
  OP_PARAM, 1, PK_GAIN, 1.25, 0, /* audible, and no latency change */
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,  0, 0, 0, 0,
};

/*
 * The carrier bus is read at add time and never again, so the slot added
 * before the bus exists never gets one — and the minimal effect never gets one
 * either, because it has no setCarrierBus to call.
 */
static const double S_CARRIER[] = {
  OP_ADD,     1, UNSET, UNSET, UNSET, /* added first: no bus */
  OP_CARRIER, 1, 0, 0, 0,
  OP_ADD,     2, UNSET, UNSET, UNSET, /* added after: gets the bus */
  OP_ADD,     100, UNSET, UNSET, UNSET, /* minimal: no setter to call */
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_CARRIER, 0, 0, 0, 0, /* detaching does not reach the slots already fed */
  OP_ADD,     4, UNSET, UNSET, UNSET,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_PARAM,   2, PK_CARRIER, 0.5, 0, /* more carrier, through setParam */
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

/* The minimal vtable on its own: no latency to sum, no meter to read. */
static const double S_MINIMAL[] = {
  OP_ADD,     100, UNSET, UNSET, UNSET,
  OP_ADD,     101, UNSET, UNSET, UNSET,
  OP_ADD,     102, UNSET, UNSET, UNSET,
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_BYPASS,  101, 1, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_PANIC,   0, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

/* Every meter mode at once, so the NaN and the -0 readings are pinned against
   the neighbours that are ordinary numbers. */
static const double S_METERS[] = {
  OP_ADD,     1, UNSET, UNSET, UNSET, /* NaN */
  OP_ADD,     2, UNSET, UNSET, UNSET, /* +0 */
  OP_ADD,     3, UNSET, UNSET, UNSET, /* -0 */
  OP_ADD,     4, UNSET, UNSET, UNSET, /* 0.25 */
  OP_ADD,     5, UNSET, UNSET, UNSET, /* live state */
  OP_ADD,     100, UNSET, UNSET, UNSET, /* absent */
  OP_SNAP,    0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

/* The slot ceiling, including the JS's `maxSlots || MAX_SLOTS` reading of 0. */
static const double S_FULL[] = {
  OP_ADD,  1, UNSET, UNSET, UNSET,
  OP_ADD,  2, UNSET, UNSET, UNSET,
  OP_ADD,  3, UNSET, UNSET, UNSET,
  OP_ADD,  4, UNSET, UNSET, UNSET, /* refused: the chain is full at 3 */
  OP_ADD,  5, 0, UNSET, UNSET,     /* refused too, index notwithstanding */
  OP_SNAP, 0, 0, 0, 0,
  OP_REMOVE, 2, 0, 0, 0,
  OP_ADD,  6, UNSET, UNSET, UNSET, /* room again */
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
};

/* Block size independence. The same 128 samples arrive as 1+1+2+4+8+16+32+64
   under a mid-flight glide; the runner checks this against one 128 render. */
static const double S_BLOCKS[] = {
  OP_ADD,     5, UNSET, UNSET, UNSET,
  OP_MIX,     5, 0.3, 0, 0,
  OP_PROCESS, 1, 0, 0, 0,
  OP_PROCESS, 1, 0, 0, 0,
  OP_PROCESS, 2, 0, 0, 0,
  OP_PROCESS, 4, 0, 0, 0,
  OP_PROCESS, 8, 0, 0, 0,
  OP_PROCESS, 16, 0, 0, 0,
  OP_PROCESS, 32, 0, 0, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

static const double S_BLOCKS_REF[] = {
  OP_ADD,     5, UNSET, UNSET, UNSET,
  OP_MIX,     5, 0.3, 0, 0,
  OP_PROCESS, 128, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

/* One long mixed script: the paths above interleaved, which is where an
   ordering bug that each isolated case tolerates tends to surface. */
static const double S_INTERLEAVE[] = {
  OP_CARRIER, 1, 0, 0, 0,
  OP_ADD,     1, UNSET, 0.5, UNSET,
  OP_ADD,     2, 0, UNSET, UNSET,
  OP_ADD,     100, 1, 0.75, UNSET,
  OP_PROCESS, 17, 0, 0, 0,
  OP_MIX,     2, 0.6, 0, 0,
  OP_PROCESS, 33, 0, 0, 0,
  OP_MOVE,    2, 2, 0, 0,
  OP_PARAM,   1, PK_QUALITY, 12, 0,
  OP_PROCESS, 64, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_BYPASS,  1, 1, 0, 0,
  OP_ADD,     5, 1, UNSET, UNSET,
  OP_PROCESS, 64, 0, 0, 0,
  OP_REMOVE,  100, 0, 0, 0,
  OP_PROCESS, 128, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_PANIC,   0, 0, 0, 0,
  OP_MIX,     1, 0, 0, 0,
  OP_BYPASS,  1, 0, 0, 0,
  OP_PROCESS, 256, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
  OP_CLEAR,   0, 0, 0, 0,
  OP_PROCESS, 32, 0, 0, 0,
  OP_SNAP,    0, 0, 0, 0,
};

#define SCRIPT(arr) (arr), (int)(sizeof(arr) / sizeof(double) / 5)

int main(int argc, char **argv) {
  FILE *f;
  int i;
  int ok = 1;

  if (argc < 2) {
    fprintf(stderr, "usage: %s <out.bin>\n", argv[0]);
    return 2;
  }
  f = fopen(argv[1], "wb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 1;
  }

  bk_fill_signal(sig_l, SIG_LEN, BK_SIG_NOISE);
  bk_fill_signal(sig_r, SIG_LEN, BK_SIG_RAMP);
  /* The carrier is a third signal, offset into the noise so it correlates with
     neither input: a carrier leak shows up as a signal that is in the output
     and in nothing else. */
  for (i = 0; i < MAX_BLOCK; i++) {
    carrier_l[i] = (float)sig_l[(i + 777) % SIG_LEN];
    carrier_r[i] = (float)sig_r[(i + 1337) % SIG_LEN];
  }

  bk_parity_open(f);

  ok &= run_script(f, "empty", SCRIPT(S_EMPTY), 0);
  ok &= run_script(f, "single", SCRIPT(S_SINGLE), 0);
  ok &= run_script(f, "mix-glide", SCRIPT(S_MIX_GLIDE), 0);
  ok &= run_script(f, "fast-path", SCRIPT(S_FAST_PATH), 0);
  ok &= run_script(f, "mix-zero", SCRIPT(S_MIX_ZERO), 0);
  ok &= run_script(f, "order", SCRIPT(S_ORDER), 0);
  ok &= run_script(f, "move-edges", SCRIPT(S_MOVE_EDGES), 0);
  ok &= run_script(f, "add-index", SCRIPT(S_ADD_INDEX), 0);
  ok &= run_script(f, "bypass", SCRIPT(S_BYPASS), 0);
  ok &= run_script(f, "bypass-at-add", SCRIPT(S_BYPASS_AT_ADD), 0);
  ok &= run_script(f, "remove", SCRIPT(S_REMOVE), 0);
  ok &= run_script(f, "clear-panic", SCRIPT(S_CLEAR_PANIC), 0);
  ok &= run_script(f, "latency", SCRIPT(S_LATENCY), 0);
  ok &= run_script(f, "carrier", SCRIPT(S_CARRIER), 0);
  ok &= run_script(f, "minimal", SCRIPT(S_MINIMAL), 0);
  ok &= run_script(f, "meters", SCRIPT(S_METERS), 0);
  ok &= run_script(f, "full", SCRIPT(S_FULL), 3);
  ok &= run_script(f, "blocks", SCRIPT(S_BLOCKS), 0);
  ok &= run_script(f, "blocks-ref", SCRIPT(S_BLOCKS_REF), 0);
  ok &= run_script(f, "interleave", SCRIPT(S_INTERLEAVE), 0);

  /* The same script under a raised ceiling, so maxSlots is not silently the
     only configuration ever exercised. */
  ok &= run_script(f, "order/max24", SCRIPT(S_ORDER), 24);

  if (!ok) {
    fprintf(stderr, "a script overflowed its buffers or was rejected\n");
    fclose(f);
    return 1;
  }

  if (!bk_parity_close(f)) {
    fprintf(stderr, "cannot patch the record count\n");
    fclose(f);
    return 1;
  }
  fclose(f);
  return 0;
}
