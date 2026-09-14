/*
 * Parity dump for the C port of dsp/core/drum-voice.js.
 *
 * Producer half of the oracle; scripts/verify-drum-voice-parity.mjs is the
 * consumer. See parity-io.h for the stream format.
 *
 * Like chain.js, a drum voice is not a function — it is a little state machine
 * with a sample under it, and what it can get wrong is mostly *when* things
 * happen: which round-robin layer a hit took, whether the envelope left DECAY
 * for SUSTAIN or straight for IDLE, whether a hold fired one frame early,
 * whether the pan smoother advanced during a muted block. None of that is
 * visible in one output buffer, so the battery is a command script (as in
 * parity-chain.c) and every op appends the voice's observable state to the
 * payload, so an op that quietly did nothing moves the dump.
 *
 * What is different here from the chain battery:
 *
 * 1. THE SAMPLE IS THE STIMULUS, AND IT IS BUILT, NOT DRAWN.
 *
 *    Layer buffers come from bk_fill_signal (the shared integer LCG and exact
 *    constants) plus two hand-built kinds that the LCG cannot produce: one
 *    carrying a NaN, an infinity and a negative zero, and one made of values
 *    below sanitize()'s 1e-18 floor. Those two exist because the voice has two
 *    guards on the sample path — `data[idx] || 0` in the linear branch and
 *    sanitize() on the output — and a battery of well-behaved noise never
 *    reaches either.
 *
 * 2. THE VOICE IS ADDITIVE, SO THE DESTINATION IS NOT ALWAYS SILENT.
 *
 *    process() sums into L/R. A port that assigned instead of added would be
 *    invisible against a zeroed block, so PROCESS prefills the destination —
 *    with silence, with a constant, or with noise — and the prefill is part of
 *    the script.
 *
 * 3. libm IS IN THE STIMULUS PATH HERE, AND THAT IS UNAVOIDABLE.
 *
 *    parity-chain.c went out of its way to keep libm out of its test effect.
 *    This module cannot: the pan law is cos/sin, the envelope coefficients are
 *    exp, the pitch ratio is pow. All three are control-rate — evaluated on a
 *    param change or a trigger, never per sample — but they scale every sample
 *    that follows, so any spread between V8, glibc and emscripten lands in the
 *    audio. Measuring that is the point; the consumer pins the observed
 *    bit-identity count rather than assuming it.
 *
 * On param keys: the JS setParam takes a string, the C takes the wire index
 * from param-keys.h. The VM's key column is that index, and the consumer turns
 * it back into a name through PAD_KEY — so a disagreement in the ordering
 * shows up as a parity failure rather than as a silent wrong knob. The
 * consumer also diffs PAD_KEY against the generated header directly.
 *
 * Usage: parity-drum-voice <out.bin>
 */

#include "brokodr/dsp/drum-voice.h"

#include "parity-io.h"

#include <math.h>

#define SR 48000.0
#define MAX_BLOCK 256
#define BUF_LEN 1024
#define MAX_F64 32768
#define MAX_F32 131072

enum {
  OP_END = 0,
  OP_SETBUF = 1,
  OP_CLEARBUFS = 2,
  OP_PARAM = 3,
  OP_TRIGGER = 4,
  OP_RELEASE = 5,
  OP_CHOKE = 6,
  OP_RESET = 7,
  OP_PROCESS = 8,
  OP_SNAP = 9,
  /* Re-init the voice at a different sample rate (a = the rate). Every
     rate-derived coefficient — attackInc, decayCoef, releaseCoef, chokeInc and
     both pan smoothers — is computed once at construction or on a param
     change, so 48 kHz alone leaves all of them measured at exactly one value.
     Only ever the first op of a script: init is construction, not a reset, and
     the consumer mirrors it by building a fresh DrumVoice. */
  OP_INIT = 10
};

/* Buffer kinds. 0..4 are the shared bk_fill_signal signals; 5 and 6 are built
   here because the LCG cannot produce them. Mirrored in the consumer. */
enum {
  BUF_IMPULSE = 0,
  BUF_STEP = 1,
  BUF_NOISE = 2,
  BUF_RAMP = 3,
  BUF_ZERO = 4,
  BUF_DIRTY = 5, /* NaN, +inf, -0 planted in otherwise-ordinary noise */
  BUF_TINY = 6   /* everything under sanitize()'s 1e-18 floor */
};

/* Prefill kinds for the destination block. Mirrored in the consumer. */
enum { PRE_SILENT = 0, PRE_CONST = 1, PRE_NOISE = 2 };

static float layer_buf[BK_DRUM_MAX_LAYERS][BUF_LEN];
static double scratch[BUF_LEN];
static float blk_l[MAX_BLOCK];
static float blk_r[MAX_BLOCK];
static double pay64[MAX_F64];
static float pay32[MAX_F32];

static void build_buf(float *dst, int n, int kind) {
  int i;
  if (kind == BUF_DIRTY) {
    bk_fill_signal(scratch, (size_t)n, BK_SIG_NOISE);
    for (i = 0; i < n; i++) dst[i] = (float)scratch[i];
    /* Planted at fixed indices so both sides agree exactly. 1e40 does not fit
       a float32 and becomes +inf on every toolchain and in a Float32Array
       alike, which is the point — the voice has to survive it. */
    if (n > 3) dst[3] = (float)(0.0 / 0.0);
    if (n > 5) dst[5] = (float)1e40;
    if (n > 7) dst[7] = -0.0f;
    if (n > 9) dst[9] = 0.0f;
    return;
  }
  if (kind == BUF_TINY) {
    for (i = 0; i < n; i++) dst[i] = (float)((i % 2 ? 1e-20 : -1e-20) * (double)(i + 1));
    return;
  }
  bk_fill_signal(scratch, (size_t)n, kind);
  for (i = 0; i < n; i++) dst[i] = (float)scratch[i];
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

/* --- the script VM ------------------------------------------------------- */

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

/* After every op: the four fields that make "did this op do anything" a
   measurement. pos is in there because a wrong step or a wrong start offset
   can leave active/stage/env untouched for a whole block. */
static void push_state(sink *s, const bk_drum_voice *v) {
  push64(s, v->active ? 1.0 : 0.0);
  push64(s, (double)v->stage);
  push64(s, v->env);
  push64(s, v->pos);
}

/* Everything else that is observable, for OP_SNAP. Order is the contract with
   the consumer. */
static void push_snap(sink *s, const bk_drum_voice *v) {
  push64(s, (double)v->layer);
  push64(s, (double)v->next_layer);
  push64(s, (double)v->layer_count);
  push64(s, v->step);
  push64(s, v->vel_gain);
  push64(s, v->meter);
  push64(s, v->choking ? 1.0 : 0.0);
  push64(s, (double)v->hold_left);
  push64(s, v->pan_l.value);
  push64(s, v->pan_r.value);
  push64(s, v->pan_l.target);
  push64(s, v->pan_r.target);
  push64(s, v->attack_inc);
  push64(s, v->decay_coef);
  push64(s, v->release_coef);
  push64(s, v->choke_inc);
  push64(s, v->attack_ms);
  push64(s, v->decay_ms);
  push64(s, v->sustain);
  push64(s, v->release_ms);
  push64(s, v->hold_ms);
  push64(s, v->pitch);
  push64(s, v->start_offset);
  push64(s, v->reverse ? 1.0 : 0.0);
  push64(s, v->gain);
  push64(s, v->pan);
  push64(s, (double)v->mode);
  push64(s, v->vel_amount);
  push64(s, (double)v->choke_group);
  push64(s, v->muted ? 1.0 : 0.0);
  /* The layer table itself: a setBuffer that landed in the wrong slot, or a
     rate fallback that did not fire, is otherwise only visible as audio. */
  {
    int i;
    for (i = 0; i < BK_DRUM_MAX_LAYERS; i++) {
      push64(s, v->layers[i].data ? 1.0 : 0.0);
      push64(s, (double)v->layers[i].frames);
      push64(s, v->layers[i].rate);
    }
  }
}

static void run_script(const double *ops, int n_ops, sink *s) {
  bk_drum_voice v;
  int i;

  bk_drum_voice_init(&v, SR, MAX_BLOCK);

  for (i = 0; i < n_ops; i++) {
    const double *o = ops + (size_t)i * 5;
    const int op = (int)o[0];
    const double a = o[1];
    const double b = o[2];
    const double c = o[3];
    const double d = o[4];

    switch (op) {
      case OP_SETBUF: {
        const int li = (int)a;
        const int kind = (int)b;
        const int frames = (int)c;
        if (kind < 0) {
          /* A null handoff: the layer is emptied. The frame count is passed
             through rather than forced to zero, so a script can hand over NULL
             *with* a nonzero count — which is what the host does when it drops
             a sample without zeroing the rest of the message, and the only
             stimulus under which `frames = data ? frames : 0` is observable. */
          bk_drum_voice_set_buffer(&v, li, NULL, frames, d);
        } else {
          build_buf(layer_buf[li & (BK_DRUM_MAX_LAYERS - 1)], frames, kind);
          bk_drum_voice_set_buffer(&v, li, layer_buf[li & (BK_DRUM_MAX_LAYERS - 1)], frames, d);
        }
        break;
      }
      case OP_CLEARBUFS:
        bk_drum_voice_clear_buffers(&v);
        break;
      case OP_PARAM:
        bk_drum_voice_set_param(&v, (int)a, b);
        break;
      case OP_TRIGGER:
        bk_drum_voice_trigger(&v, a);
        break;
      case OP_RELEASE:
        bk_drum_voice_release(&v);
        break;
      case OP_CHOKE:
        bk_drum_voice_choke(&v);
        break;
      case OP_RESET:
        bk_drum_voice_reset(&v);
        break;
      case OP_PROCESS: {
        const int frames = (int)a;
        int k;
        prefill(frames, (int)b);
        bk_drum_voice_process(&v, blk_l, blk_r, (size_t)frames);
        for (k = 0; k < frames; k++) push32(s, blk_l[k]);
        for (k = 0; k < frames; k++) push32(s, blk_r[k]);
        push64(s, v.meter);
        break;
      }
      case OP_SNAP:
        push_snap(s, &v);
        break;
      case OP_INIT:
        bk_drum_voice_init(&v, a, MAX_BLOCK);
        break;
      default:
        break;
    }
    push_state(s, &v);
  }
}

/* --- the battery --------------------------------------------------------- */

#define OPS(x) (x), (int)(sizeof(x) / sizeof(double) / 5)

/* The pad param keys, spelled with the generated names so that a reordering of
   PAD_KEY moves this battery too. */
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

/* Defaults, one hit, played out. The baseline every other case deviates from. */
static const double S_DEFAULT[] = {
  OP_SETBUF, 0, BUF_NOISE, 512, SR,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* attack 0 is a different code path: env starts AT 1 and the stage skips
   straight to DECAY, so the first sample is full level rather than one
   increment up from zero. */
static const double S_ATTACK_ZERO[] = {
  OP_SETBUF, 0, BUF_STEP, 256, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* A long attack, so the ATTACK ramp spans blocks and the DECAY handover
   happens mid-block rather than at a boundary. */
static const double S_ATTACK_LONG[] = {
  OP_SETBUF, 0, BUF_RAMP, 1024, SR,
  OP_PARAM, P_ATTACK, 5, 0, 0,
  OP_PARAM, P_DECAY, 2000, 0, 0,
  OP_PARAM, P_SUSTAIN, 0.5, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* sustain > 0: DECAY settles onto the sustain floor, the stage becomes
   SUSTAIN, and the voice holds until a note-off. In GATE mode that note-off
   exists, so release() is what ends it.

   The 2 ms times are load-bearing. Both handovers have to happen inside this
   script or the interesting states are never in the dump, and the decay is
   asymptotic: DECAY only hands over once env - sustain < 1e-4, which from
   env 1 to sustain 0.6 takes ln(2.5e-4)/ln(exp(-5/96)) = 160 frames, and the
   release from 0.6 to below 1e-4 takes another 168. At 5 ms and 8 ms (where
   this started) that is 398 and 668 frames against the 2x128 either side of
   the note-off, so the voice was still mid-decay at the release and still
   mid-release at the end: SUSTAIN and the self-free after RELEASE were both
   untested. Four blocks of 128 also keeps the whole script inside the
   1024-frame sample, so nothing ends early on the buffer boundary instead. */
static const double S_SUSTAIN_GATE[] = {
  OP_SETBUF, 0, BUF_RAMP, 1024, SR,
  OP_PARAM, P_MODE, 0, 0, 0,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_DECAY, 2, 0, 0,
  OP_PARAM, P_SUSTAIN, 0.6, 0, 0,
  OP_PARAM, P_RELEASE, 2, 0, 0,
  OP_TRIGGER, 0.8, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_RELEASE, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* sustain 0 means the decay knob IS the length of the sound: DECAY hands over
   to IDLE, not to SUSTAIN, and the voice frees itself mid-block. */
static const double S_SUSTAIN_ZERO[] = {
  OP_SETBUF, 0, BUF_RAMP, 1024, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_DECAY, 2, 0, 0,
  OP_PARAM, P_SUSTAIN, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 256, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* release() in ONESHOT mode is ignored — a beatbox hit is an event, not a held
   key. Same script as the GATE case up to the note-off, so the two dumps
   diverge exactly where the mode is supposed to matter. */
static const double S_RELEASE_ONESHOT[] = {
  OP_SETBUF, 0, BUF_RAMP, 1024, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_DECAY, 5, 0, 0,
  OP_PARAM, P_SUSTAIN, 0.6, 0, 0,
  OP_TRIGGER, 0.8, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_RELEASE, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* release() on an idle voice is a no-op, and must not resurrect the stage. */
static const double S_RELEASE_IDLE[] = {
  OP_SETBUF, 0, BUF_IMPULSE, 64, SR,
  OP_RELEASE, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 32, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* hold: the ONESHOT auto-release, counted in frames. 2 ms at 48 kHz is 96
   frames, so the handover happens inside the second block. */
static const double S_HOLD[] = {
  OP_SETBUF, 0, BUF_RAMP, 1024, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_DECAY, 500, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_PARAM, P_RELEASE, 3, 0, 0,
  OP_PARAM, P_HOLD, 2, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* A hold of 0.01 ms rounds to zero frames, which is NOT the same as no hold:
   holdLeft becomes 0, the `hold > 0` test never fires, and the auto-release
   never happens. Pinning it because it is exactly the kind of off-by-one a
   port invents (`hold >= 0`), and because Math.round's half-away-from-zero is
   only visible on cases like this. */
static const double S_HOLD_ROUNDS_TO_ZERO[] = {
  OP_SETBUF, 0, BUF_RAMP, 512, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_PARAM, P_HOLD, 0.01, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* A hold whose frame count lands on an exact half (0.5 frames at this rate),
   where Math.round rounds up and rint() would round to even. */
static const double S_HOLD_HALF[] = {
  OP_SETBUF, 0, BUF_RAMP, 512, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  /* 1/96 ms, which is exactly 0.5 frames at 48 kHz once (ms * sr) / 1000 has
     been evaluated in double. Math.round takes that to 1 and the hold fires on
     the first frame; rint() under the default mode takes it to 0, where
     holdLeft is set but `hold > 0` never passes and the auto-release never
     happens. 1.5 frames — the obvious choice — rounds to 2 either way and
     proves nothing, which is what this case used to do. */
  OP_PARAM, P_HOLD, 0.010416666666666666, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Reverse plus a start offset: the position walks backwards from near the end
   and the voice ends by running off frame 0. */
static const double S_REVERSE[] = {
  OP_SETBUF, 0, BUF_RAMP, 300, SR,
  OP_PARAM, P_REVERSE, 1, 0, 0,
  OP_PARAM, P_START, 0.5, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* start 0.99 is the clamp ceiling, on a short buffer: the hit begins two
   frames from the end, in the linear-interpolation edge branch, and runs out
   almost immediately. */
static const double S_START_CLAMP[] = {
  OP_SETBUF, 0, BUF_NOISE, 64, SR,
  OP_PARAM, P_START, 5, 0, 0, /* clamps to 0.99 */
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Pitch: +12 halves the buffer's life, -12 doubles it, and both put a
   fractional step under the Hermite resampler. 36 is the clamp. */
static const double S_PITCH_UP[] = {
  OP_SETBUF, 0, BUF_RAMP, 512, SR,
  OP_PARAM, P_PITCH, 7, 0, 0,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

static const double S_PITCH_DOWN[] = {
  OP_SETBUF, 0, BUF_RAMP, 512, SR,
  OP_PARAM, P_PITCH, -500, 0, 0, /* clamps to -36 */
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* A 44.1 kHz sample on a 48 kHz engine: the rate ratio multiplies the pitch
   ratio, which is the other half of the step calculation. The second layer
   takes the srcRate = 0 fallback, where the JS `|| this.sr` kicks in. */
static const double S_RATE_MISMATCH[] = {
  OP_SETBUF, 0, BUF_RAMP, 512, 44100,
  OP_SETBUF, 1, BUF_NOISE, 512, 0, /* rate 0 -> falls back to the engine rate */
  OP_SNAP, 0, 0, 0, 0,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Buffers too short for the cubic branch at all: 1, 2 and 3 frames, each
   triggered and rendered. This is where a port that clamps its indices instead
   of falling back to linear reads garbage or crashes. */
static const double S_TINY_BUFFERS[] = {
  OP_SETBUF, 0, BUF_IMPULSE, 1, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 8, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_SETBUF, 0, BUF_NOISE, 2, SR,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 8, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_SETBUF, 0, BUF_NOISE, 3, SR,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 8, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_SETBUF, 0, BUF_NOISE, 4, SR,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 8, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Round robin: four layers, each a different signal, hit five times so the
   cursor wraps. The layer index is in every snapshot, so a wrong rotation is
   caught even where two layers happen to sound alike. */
static const double S_ROUND_ROBIN[] = {
  OP_SETBUF, 0, BUF_IMPULSE, 128, SR,
  OP_SETBUF, 1, BUF_STEP, 128, SR,
  OP_SETBUF, 2, BUF_RAMP, 128, SR,
  OP_SETBUF, 3, BUF_NOISE, 128, SR,
  OP_SNAP, 0, 0, 0, 0,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* A hole in the round robin. layerCount is the highest occupied layer plus
   one, so a sample in layer 2 alone makes the rotation three long and two of
   every three hits land on an empty layer — which process() discovers and
   turns into an immediate self-deactivation. Deliberate JS behaviour, ported
   as-is. */
static const double S_LAYER_HOLE[] = {
  OP_SETBUF, 2, BUF_NOISE, 128, SR,
  OP_SNAP, 0, 0, 0, 0,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 16, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 16, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 16, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Emptying a layer: the null handoff, then the count recomputed. Emptying the
   top layer shortens the rotation and has to pull nextLayer back in range. */
static const double S_SETBUF_NULL[] = {
  OP_SETBUF, 0, BUF_NOISE, 64, SR,
  OP_SETBUF, 1, BUF_RAMP, 64, SR,
  OP_SETBUF, 2, BUF_STEP, 64, SR,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_SETBUF, 2, -1, 0, 0, /* null: rotation drops to 2 */
  OP_SNAP, 0, 0, 0, 0,
  OP_SETBUF, 1, -1, 0, 0, /* null: rotation drops to 1, nextLayer must snap back */
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  /* A null handoff that still carries a frame count. The layer has to come out
     empty — frames 0, not 64 — or a later trigger() picks a length for a
     buffer that is not there and process() reads through a null pointer. */
  OP_SETBUF, 0, -1, 64, SR,
  OP_SNAP, 0, 0, 0, 0
};

/* A zero-length buffer is not a buffer: frames 0 leaves the layer empty, so
   the count stays 0 and trigger() does nothing at all. */
static const double S_ZERO_FRAMES[] = {
  OP_SETBUF, 0, BUF_NOISE, 0, SR,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 16, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* clearBuffers() mid-note. The voice is deactivated by the clear itself, and
   the block that follows must be the prefill untouched. */
static const double S_CLEAR_MIDNOTE[] = {
  OP_SETBUF, 0, BUF_RAMP, 512, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_CLEARBUFS, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 32, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Pulling the sample out from under a sounding voice — setBuffer(null) on the
   layer it is playing. process() finds a null buffer, deactivates, and leaves
   the pan smoothers standing still, which is the one place they do not
   advance. */
static const double S_SAMPLE_YANKED[] = {
  OP_SETBUF, 0, BUF_RAMP, 512, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_PARAM, P_PAN, -1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_PARAM, P_PAN, 1, 0, 0,
  OP_SETBUF, 0, -1, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Choke: the 4 ms fade, which is a fixed per-sample decrement and not the
   release curve. 4 ms is 192 frames at 48 kHz, so it spans blocks. */
static const double S_CHOKE[] = {
  OP_SETBUF, 0, BUF_RAMP, 1024, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0,
  OP_CHOKE, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 32, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* choke() on an idle voice must not arm the fade, and a retrigger must clear
   it — otherwise the next hit fades out instead of playing. */
static const double S_CHOKE_IDLE_THEN_RETRIGGER[] = {
  OP_SETBUF, 0, BUF_RAMP, 512, SR,
  OP_CHOKE, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_CHOKE, 0, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Retriggering mid-decay: the envelope restarts from where it is rather than
   from zero, which is what stops a machine-gun roll from clicking. */
static const double S_RETRIGGER_MIDDECAY[] = {
  OP_SETBUF, 0, BUF_RAMP, 1024, SR,
  OP_PARAM, P_ATTACK, 2, 0, 0,
  OP_PARAM, P_DECAY, 20, 0, 0,
  OP_PARAM, P_SUSTAIN, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 0.5, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Velocity and velAmount together: velAmount 0 ignores velocity entirely,
   velAmount 1 hands it the whole range, and the curve is v squared. The
   out-of-range velocities are there for the clamp. */
static const double S_VELOCITY[] = {
  OP_SETBUF, 0, BUF_STEP, 128, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_PARAM, P_VEL, 0, 0, 0,
  OP_TRIGGER, 0.25, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_RESET, 0, 0, 0, 0,
  OP_PARAM, P_VEL, 1, 0, 0,
  OP_TRIGGER, 0.25, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_RESET, 0, 0, 0, 0,
  OP_PARAM, P_VEL, 0.7, 0, 0,
  OP_TRIGGER, 2, 0, 0, 0, /* clamps to 1 */
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_RESET, 0, 0, 0, 0,
  OP_TRIGGER, -1, 0, 0, 0, /* clamps to 0 */
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Pan: a hit from silence starts AT its pan position (the reset-to-target
   path), while a knob moved mid-note glides. Both are in one script so a port
   that resets in the wrong place fails one of them. */
static const double S_PAN[] = {
  OP_SETBUF, 0, BUF_STEP, 1024, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_PARAM, P_PAN, -1, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_PARAM, P_PAN, 1, 0, 0, /* mid-note: this one glides */
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PARAM, P_PAN, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  /* Both clamps, each with its own snapshot. Without the snapshot in the
     middle the low clamp is invisible — nothing in the payload can tell -7
     clamped to -1 from -7 being overwritten by the +7 on the next line. */
  OP_PARAM, P_PAN, -7, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PARAM, P_PAN, 7, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Mute: the block is silent but the pan smoother keeps moving, so the voice is
   in the right place when the mute comes off. The gain param's dB mapping is
   in here too, including its clamps. */
static const double S_MUTE_AND_GAIN[] = {
  OP_SETBUF, 0, BUF_RAMP, 1024, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_PARAM, P_GAIN, -6, 0, 0,
  OP_PARAM, P_PAN, -1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_PARAM, P_MUTE, 1, 0, 0,
  OP_PARAM, P_PAN, 1, 0, 0,
  OP_PROCESS, 64, PRE_CONST, 0, 0, /* silent, but the smoother advances */
  OP_SNAP, 0, 0, 0, 0,
  OP_PARAM, P_MUTE, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PARAM, P_GAIN, 100, 0, 0, /* clamps to +12 dB */
  OP_SNAP, 0, 0, 0, 0,
  OP_PARAM, P_GAIN, -900, 0, 0, /* clamps to -60 dB */
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* reset() parks the pan where it currently sits, not where it was heading —
   reset(value), not reset(target). The glide is left half-done on purpose so
   the two differ. */
static const double S_RESET[] = {
  OP_SETBUF, 0, BUF_RAMP, 1024, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_PARAM, P_PAN, -1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_PARAM, P_PAN, 1, 0, 0,
  OP_PROCESS, 8, PRE_SILENT, 0, 0, /* mid-glide */
  OP_SNAP, 0, 0, 0, 0,
  OP_RESET, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 16, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* The two guards on the sample path: a NaN/inf/-0 buffer through both the
   cubic and the linear branch, and a buffer entirely below sanitize()'s
   1e-18 floor, which must come out as exact silence. */
static const double S_DIRTY_SAMPLE[] = {
  OP_SETBUF, 0, BUF_DIRTY, 32, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 48, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_SETBUF, 0, BUF_TINY, 32, SR,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 48, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* A zero-frame process() call. The worklet can hand one down on a glitchy
   block, and it must change nothing — not the position, not the smoothers. */
static const double S_ZERO_FRAME_BLOCK[] = {
  OP_SETBUF, 0, BUF_RAMP, 256, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_PARAM, P_PAN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 0, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 8, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Every param's clamp, in one pass, read back through the snapshot. The
   envelope ones are re-read as coefficients rather than as the raw ms, which
   is what actually reaches the audio. */
static const double S_PARAM_CLAMPS[] = {
  OP_PARAM, P_ATTACK, -5, 0, 0,
  OP_PARAM, P_DECAY, 0, 0, 0,
  OP_PARAM, P_RELEASE, -1, 0, 0,
  OP_PARAM, P_SUSTAIN, 9, 0, 0,
  OP_PARAM, P_HOLD, -3, 0, 0,
  OP_PARAM, P_PITCH, 99, 0, 0,
  OP_PARAM, P_START, -1, 0, 0,
  OP_PARAM, P_VEL, 4, 0, 0,
  OP_PARAM, P_CHOKE, 3.5, 0, 0, /* Math.round: half away from zero */
  OP_PARAM, P_MODE, 0.49, 0, 0,
  OP_PARAM, P_REVERSE, 0.5, 0, 0,
  OP_PARAM, P_MUTE, 0.51, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PARAM, P_ATTACK, 9000, 0, 0,
  OP_PARAM, P_DECAY, 99999, 0, 0,
  OP_PARAM, P_RELEASE, 99999, 0, 0,
  OP_PARAM, P_HOLD, 99999, 0, 0,
  OP_PARAM, P_CHOKE, 40, 0, 0,
  OP_PARAM, P_MODE, 0.5, 0, 0,
  OP_PARAM, P_REVERSE, 0.49, 0, 0,
  OP_PARAM, P_MUTE, 0.49, 0, 0,
  OP_PARAM, 99, 1, 0, 0, /* unknown key: ignored, changes nothing */
  OP_SNAP, 0, 0, 0, 0,
  /* Exactly 0.5 on the three boolean params. All three are `value >= 0.5`, and
     0.49/0.51 either side of the line cannot tell that from `value > 0.5`.
     mode and reverse had the exact value already; mute did not. */
  OP_PARAM, P_MUTE, 0.5, 0, 0,
  OP_PARAM, P_REVERSE, 0.5, 0, 0,
  OP_PARAM, P_MODE, 0.5, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Block-size independence: the same 256 frames in one call, in two, and in
   eight must land in the same place. Three separate cases, diffed against each
   other by the consumer rather than only against the JS. */
static const double S_BLOCK_1[] = {
  OP_SETBUF, 0, BUF_NOISE, 1024, SR,
  OP_PARAM, P_ATTACK, 1, 0, 0,
  OP_PARAM, P_DECAY, 30, 0, 0,
  OP_PARAM, P_SUSTAIN, 0.3, 0, 0,
  OP_PARAM, P_PAN, 0.4, 0, 0,
  OP_TRIGGER, 0.9, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

static const double S_BLOCK_2[] = {
  OP_SETBUF, 0, BUF_NOISE, 1024, SR,
  OP_PARAM, P_ATTACK, 1, 0, 0,
  OP_PARAM, P_DECAY, 30, 0, 0,
  OP_PARAM, P_SUSTAIN, 0.3, 0, 0,
  OP_PARAM, P_PAN, 0.4, 0, 0,
  OP_TRIGGER, 0.9, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

static const double S_BLOCK_8[] = {
  OP_SETBUF, 0, BUF_NOISE, 1024, SR,
  OP_PARAM, P_ATTACK, 1, 0, 0,
  OP_PARAM, P_DECAY, 30, 0, 0,
  OP_PARAM, P_SUSTAIN, 0.3, 0, 0,
  OP_PARAM, P_PAN, 0.4, 0, 0,
  OP_TRIGGER, 0.9, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* A long run with everything moving at once: the case that would catch a
   defect only reachable by a combination nobody scripted on purpose. */
static const double S_SOAK[] = {
  OP_SETBUF, 0, BUF_NOISE, 1024, 44100,
  OP_SETBUF, 1, BUF_RAMP, 700, SR,
  OP_SETBUF, 2, BUF_DIRTY, 256, 96000,
  OP_PARAM, P_ATTACK, 0.5, 0, 0,
  OP_PARAM, P_DECAY, 120, 0, 0,
  OP_PARAM, P_SUSTAIN, 0.25, 0, 0,
  OP_PARAM, P_RELEASE, 40, 0, 0,
  OP_PARAM, P_HOLD, 3, 0, 0,
  OP_PARAM, P_PITCH, -5.5, 0, 0,
  OP_PARAM, P_START, 0.1, 0, 0,
  OP_PARAM, P_GAIN, -3, 0, 0,
  OP_PARAM, P_PAN, -0.6, 0, 0,
  OP_PARAM, P_VEL, 0.4, 0, 0,
  OP_TRIGGER, 0.7, 0, 0, 0,
  OP_PROCESS, 64, PRE_NOISE, 0, 0,
  OP_PARAM, P_PAN, 0.8, 0, 0,
  OP_PROCESS, 64, PRE_CONST, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PARAM, P_PITCH, 12, 0, 0, /* takes effect on the NEXT trigger, not now */
  OP_PROCESS, 64, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_RELEASE, 0, 0, 0, 0,
  OP_PROCESS, 64, PRE_SILENT, 0, 0,
  OP_TRIGGER, 0.3, 0, 0, 0,
  OP_PARAM, P_REVERSE, 1, 0, 0,
  OP_PROCESS, 128, PRE_NOISE, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_CHOKE, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PARAM, P_MODE, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_RELEASE, 0, 0, 0, 0,
  OP_PROCESS, 128, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_RESET, 0, 0, 0, 0,
  OP_SETBUF, 1, -1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 128, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* --- the cases mutation testing asked for -------------------------------- *
 *
 * Everything above was written by reading the JS. The seven below were written
 * because a deliberate defect in the C survived everything above: the battery
 * never put the voice in the state where that line of code decides anything.
 * Each one names the mutant it exists to kill.
 */

/* `data[idx] || 0` in the LINEAR branch. The 32-frame dirty buffer in
   S_DIRTY_SAMPLE plants its NaN at index 3, which on a buffer that long is
   read by the *cubic* branch — and there sanitize() on the output turns the
   poisoned sample into 0 anyway, so a guarded read and an unguarded one leave
   the same audio. Four frames puts index 3 in the linear pair instead: the
   guard turns the NaN into 0 and the frame still carries data[2], where
   without it the whole frame sanitises to silence.
   Kills: "js_or_zero passes NaN". */
static const double S_DIRTY_EDGE[] = {
  OP_SETBUF, 0, BUF_DIRTY, 4, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 8, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  /* Again with a fractional step, where the NaN is the y0 of the last pair
     rather than the y1 of the one before it, and frac scales it. */
  OP_SETBUF, 0, BUF_DIRTY, 5, SR,
  OP_PARAM, P_PITCH, -5.5, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* An attack shorter than one frame. attackInc is 1 / max(1, attackMs * sr /
   1000) and the floor is what stops it blowing past 1; at attack 0 exactly the
   ternary above it returns 1.0 without ever reaching the division, so
   S_ATTACK_ZERO measures the ternary and not the floor. 0.01 ms is 0.48 frames
   at 48 kHz, where the unfloored value would be 2.08.
   Kills: "attack_inc floor dropped". */
static const double S_ATTACK_TINY[] = {
  OP_SETBUF, 0, BUF_STEP, 128, SR,
  OP_PARAM, P_ATTACK, 0.01, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 16, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* setBuffer() past the last layer. The host cannot send this today, but the
   clamp is the only thing between a wire value and a write past the layer
   table, and every other case addresses layers 0..3 where the ceiling never
   engages. Index 4 and index 99 both have to land in layer 3, and the fourth
   hit of the rotation has to play what landed there.
   Kills: "layer index clamp off by one". */
static const double S_LAYER_CLAMP[] = {
  OP_SETBUF, 4, BUF_RAMP, 64, SR,
  OP_SNAP, 0, 0, 0, 0,
  OP_SETBUF, 99, BUF_NOISE, 32, 22050,
  OP_SNAP, 0, 0, 0, 0,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 8, PRE_SILENT, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 8, PRE_SILENT, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 8, PRE_SILENT, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 8, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* release() on an inactive voice, in the one state where the guard decides
   anything. process() deactivates a voice whose sample was pulled out from
   under it *without* moving the stage to IDLE, so the voice sits at
   `active = 0, stage = DECAY`; in GATE mode a release() that skipped its
   active check would move that stage to RELEASE and arm a fade on a voice that
   is not playing. S_RELEASE_IDLE cannot see it — that voice never triggers, so
   its stage is IDLE and its mode is ONESHOT, and both the guard and its
   absence agree.
   Kills: "release of an idle voice". */
static const double S_RELEASE_AFTER_YANK[] = {
  OP_SETBUF, 0, BUF_RAMP, 512, SR,
  OP_PARAM, P_MODE, 0, 0, 0, /* GATE */
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SETBUF, 0, -1, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_RELEASE, 0, 0, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 32, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* The other half of the yank: the sample pointer stays and its length goes to
   zero, which is what a host that reuses a layer for a shorter take sends.
   That is the only way to reach process() with `data != NULL, frames == 0` on
   a sounding voice, and it is the only stimulus under which `n <= 0` and
   `n < 0` differ — with the wrong test the loop runs with n = 0, walks the
   position off a zero-length buffer and lands the stage on IDLE, which is not
   where the guard leaves it. S_ZERO_FRAMES cannot reach it: a zero-length
   layer is never counted, so trigger() never starts on one.
   Kills: "yanked sample advances the smoothers". */
static const double S_SAMPLE_TRUNCATED[] = {
  OP_SETBUF, 0, BUF_RAMP, 512, SR,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_PARAM, P_PAN, -1, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_PARAM, P_PAN, 1, 0, 0, /* left mid-glide: the smoothers must stand still */
  OP_SETBUF, 0, BUF_RAMP, 0, SR,
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 32, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* The choke fade landing exactly on zero, which needs a different sample rate.
   chokeInc is 1 / (CHOKE_MS * sr / 1000): at 48 kHz that is 1/192, which is
   not representable, so a fade from env 1 always steps past zero into the
   negative and `env <= 0` and `env < 0` cannot be told apart. At 32 kHz it is
   1/128 — exact — and the 128th frame of the fade lands on 0.0 exactly, where
   the two tests disagree by one frame: one frame of position and one step of
   the pan smoother, on a voice that is supposed to be finished.
   This is also the only case that runs the voice at anything other than
   48 kHz, so it is the only one that measures attackInc, the decay and release
   coefficients, chokeInc and both smoother coefficients at a second rate.
   Kills: "choke never reaches zero". */
static const double S_CHOKE_EXACT_ZERO[] = {
  OP_INIT, 32000, 0, 0, 0,
  OP_SETBUF, 0, BUF_RAMP, 1024, 32000,
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_SUSTAIN, 1, 0, 0,
  OP_PARAM, P_PAN, -1, 0, 0,
  OP_SNAP, 0, 0, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PARAM, P_PAN, 1, 0, 0, /* mid-glide under the fade */
  OP_CHOKE, 0, 0, 0, 0,
  OP_PROCESS, 127, PRE_SILENT, 0, 0, /* env is exactly 1/128 here */
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 8, PRE_SILENT, 0, 0, /* the next frame is the exact zero */
  OP_SNAP, 0, 0, 0, 0,
  OP_PROCESS, 8, PRE_CONST, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

/* Sustain dropped to zero under a note that is already holding. The SUSTAIN
   stage carries its own `sustain < 1e-4 -> IDLE` test, and it is not the same
   test as the DECAY handover's: a sustain that small at trigger time sends
   DECAY straight to IDLE and the stage is never entered, so the stage's own
   test is only reachable by moving the knob under a held note. Without it the
   pad holds silence forever — out of the free pool, meter ring lit.
   Kills: "sustain stage never frees itself". */
static const double S_SUSTAIN_DROPPED[] = {
  OP_SETBUF, 0, BUF_RAMP, 1024, SR,
  OP_PARAM, P_MODE, 0, 0, 0, /* GATE: nothing else can end this note */
  OP_PARAM, P_ATTACK, 0, 0, 0,
  OP_PARAM, P_DECAY, 2, 0, 0,
  OP_PARAM, P_SUSTAIN, 0.6, 0, 0,
  OP_TRIGGER, 1, 0, 0, 0,
  OP_PROCESS, 256, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0, /* holding at SUSTAIN */
  OP_PARAM, P_SUSTAIN, 0.00005, 0, 0,
  OP_PROCESS, 32, PRE_SILENT, 0, 0,
  OP_SNAP, 0, 0, 0, 0
};

typedef struct {
  const char *name;
  const double *ops;
  int n_ops;
} scase;

static const scase CASES[] = {
  {"default", OPS(S_DEFAULT)},
  {"attack-zero", OPS(S_ATTACK_ZERO)},
  {"attack-long", OPS(S_ATTACK_LONG)},
  {"sustain-gate", OPS(S_SUSTAIN_GATE)},
  {"sustain-zero", OPS(S_SUSTAIN_ZERO)},
  {"release-oneshot", OPS(S_RELEASE_ONESHOT)},
  {"release-idle", OPS(S_RELEASE_IDLE)},
  {"hold", OPS(S_HOLD)},
  {"hold-rounds-to-zero", OPS(S_HOLD_ROUNDS_TO_ZERO)},
  {"hold-half", OPS(S_HOLD_HALF)},
  {"reverse", OPS(S_REVERSE)},
  {"start-clamp", OPS(S_START_CLAMP)},
  {"pitch-up", OPS(S_PITCH_UP)},
  {"pitch-down", OPS(S_PITCH_DOWN)},
  {"rate-mismatch", OPS(S_RATE_MISMATCH)},
  {"tiny-buffers", OPS(S_TINY_BUFFERS)},
  {"round-robin", OPS(S_ROUND_ROBIN)},
  {"layer-hole", OPS(S_LAYER_HOLE)},
  {"setbuf-null", OPS(S_SETBUF_NULL)},
  {"zero-frames", OPS(S_ZERO_FRAMES)},
  {"clear-midnote", OPS(S_CLEAR_MIDNOTE)},
  {"sample-yanked", OPS(S_SAMPLE_YANKED)},
  {"choke", OPS(S_CHOKE)},
  {"choke-idle-retrigger", OPS(S_CHOKE_IDLE_THEN_RETRIGGER)},
  {"retrigger-middecay", OPS(S_RETRIGGER_MIDDECAY)},
  {"velocity", OPS(S_VELOCITY)},
  {"pan", OPS(S_PAN)},
  {"mute-and-gain", OPS(S_MUTE_AND_GAIN)},
  {"reset", OPS(S_RESET)},
  {"dirty-sample", OPS(S_DIRTY_SAMPLE)},
  {"zero-frame-block", OPS(S_ZERO_FRAME_BLOCK)},
  {"param-clamps", OPS(S_PARAM_CLAMPS)},
  {"block-1x256", OPS(S_BLOCK_1)},
  {"block-2x128", OPS(S_BLOCK_2)},
  {"block-8x32", OPS(S_BLOCK_8)},
  {"soak", OPS(S_SOAK)},
  /* The cases mutation testing asked for; see each script's comment for the
     mutant it exists to kill. */
  {"dirty-edge", OPS(S_DIRTY_EDGE)},
  {"attack-tiny", OPS(S_ATTACK_TINY)},
  {"layer-clamp", OPS(S_LAYER_CLAMP)},
  {"release-after-yank", OPS(S_RELEASE_AFTER_YANK)},
  {"sample-truncated", OPS(S_SAMPLE_TRUNCATED)},
  {"choke-exact-zero", OPS(S_CHOKE_EXACT_ZERO)},
  {"sustain-dropped", OPS(S_SUSTAIN_DROPPED)}
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
    bk_parity_emit(f, CASES[ci].name, CASES[ci].ops, (unsigned int)(CASES[ci].n_ops * 5), pay64,
                   s.n64, pay32, s.n32);
  }

  if (!bk_parity_close(f)) {
    fclose(f);
    return 1;
  }
  fclose(f);
  return 0;
}
