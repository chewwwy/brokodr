/*
 * Bro.Kodr DSP core — Smart Voice: beatbox classification and pad firing.
 * C port of dsp/core/beat-classify.js. See biquad.h for the porting rules;
 * they apply here unchanged.
 *
 * onset.h answers "a hit started, here is its timbre in four numbers". This
 * answers "which drum was that, and how hard" — and decides the pad. It is a
 * nearest-centroid classifier over two tables (one measured a block after the
 * onset, one at the close of the feature window), a two-stage commit, and a
 * calibration capture ring. Read the JS header for why it is a centroid table
 * and not a model; none of that reasoning changes in the port.
 *
 * WHAT MAKES THIS PORT DIFFERENT FROM THE EIGHT BEFORE IT
 *
 * Every earlier module was a function of its input block. This one is a
 * function of its input block *and* of the detector it owns, whose internals
 * it reads directly: the three fast band envelopes, the level envelope, the
 * per-block strengths, and the commit ring. So it is the first port whose
 * correctness depends on another port's *state* rather than on its return
 * value, and the battery has to drive both together — a pure classifier test
 * against synthetic feature vectors would miss every coupling that matters.
 *
 * Five things in the JS are easy to port wrongly, and all five are load
 * bearing:
 *
 *   1. `Math.max` FEEDS A LOGARITHM, AND fmax IS NOT Math.max. The velocity
 *      path is `20 * Math.log10(Math.max(1e-9, det.level.env))`. C's fmax
 *      *suppresses* NaN and returns the other operand; Math.max propagates it.
 *      With a poisoned mic block the level envelope can be NaN, and fmax would
 *      quietly report -180 dB where the JS reports NaN — a silent, plausible
 *      number in place of an obviously broken one. bk_gain_to_db is exactly
 *      this expression written with bk_max, and it is already parity-tested in
 *      parity-utils.c, so it is reused rather than reimplemented.
 *
 *      This is also the first module in the port whose output path contains a
 *      transcendental. Unlike drum-synth's, it is harmless: log10's result
 *      lands in a linear ramp and then a clamp, so an ULP of divergence stays
 *      an ULP. There is no global normalisation to amplify it and no
 *      comparator on it whose two sides differ audibly.
 *
 *   2. `pendId` IS AN Int32Array AND `onsetCount` IS NOT. The pending slot
 *      stores `pendId[slot] = id` where `id` is an unbounded JS Number, so the
 *      store truncates to int32 while the comparison `pendId[slot] !== id`
 *      does not. Past 2^31 onsets every hit's stage 2 is therefore skipped
 *      forever — the comparison can never again succeed. That is ~3 years of
 *      continuous beatboxing at the detector's 22 hits/sec ceiling, so it is
 *      not a bug anyone will hit, but it *is* behaviour, and a `long long`
 *      slot id in the C would diverge from it. The port wraps explicitly and
 *      the battery visits the wrap. Same discipline as onset.h's `positions`.
 *
 *   3. A NEGATIVE CLASS INDEXES AN ARRAY. `classify` starts its best distance
 *      at Infinity and returns -1 if no distance ever compares less — which
 *      needs every distance to be NaN. `#emit` then evaluates
 *      `this.classPad[-1]`, which in JS is `undefined`: `undefined < 0` is
 *      false, so the drop test passes, and `firePad[n] = undefined` stores 0.
 *      A JS-faithful reading of that is "fire pad 0". In C the same index is
 *      an out-of-bounds read.
 *
 *      Rather than port a memory error or paper over it, the port asserts the
 *      branch is unreachable and the battery gates the assertion. The assert
 *      is a real assert() in bk_smart_voice's emit path, so the harness — which
 *      builds without NDEBUG — aborts if the reasoning below is ever wrong.
 *      With NDEBUG the assert is gone and the fallback is the JS's own
 *      behaviour rather than the out-of-bounds load: pad 0 fires, and
 *      fire_class still carries the -1. The proof:
 *      the stage-1 vector is written under `if (total > 1e-12)`, whose false
 *      arm writes three exact zeros, so a NaN envelope yields a finite
 *      vector, not a NaN one; the stage-2 vector comes from the detector's
 *      commit ring, which onset's own battery gates as always finite; and both
 *      centroid tables can only be written by bk_smart_voice_set_centroid /
 *      _set_attack_centroid, which reject non-finite values outright. With
 *      finite features and finite centroids every distance is finite, so the
 *      first comparison always takes. Layer 3 asserts a fired class is always
 *      in range, which is what makes that argument checkable rather than
 *      merely written down.
 *
 *   4. HALF THE STATE IS float32 AND THE ROUNDING IS OBSERVABLE. The
 *      centroids, both scratch vectors, the pending velocity, strength and
 *      band store, the capture ring and the fire arrays are all
 *      Float32Arrays. The band shares are *computed* in double and then
 *      rounded on the way into `bandScratch`, and the distance then reads them
 *      back as float32 — so the rounding sits directly upstream of the
 *      stage-1 commit comparison. Velocity is likewise computed in double,
 *      rounded into `pendVel`, and it is the rounded value that reaches the
 *      rack. Every one of those arrays is `float` here for that reason.
 *      `AXIS_WEIGHT`, `margin`, `velMin`, `velDb` and the distances themselves
 *      are plain Numbers in the JS and stay `double`.
 *
 *   5. THREE SETTERS ARE ToInt32, NOT CASTS. `setCentroid`,
 *      `setAttackCentroid`, `setClassPad` and `setCapture` all coerce with
 *      `| 0` before range-checking. At arguments beyond int32 a C cast is
 *      undefined behaviour where `| 0` is a defined wrap, and the wrap can
 *      land *inside* the valid range — `setCentroid(2^32, 0, v)` writes class
 *      0 rather than being rejected. bk_onset_to_int32 is reused for all four.
 *
 * Storage. The detector's lag history is caller-owned, so Smart Voice's is
 * too: ask bk_smart_voice_hist_floats() (which is bk_onset_hist_floats) how
 * many floats to provide and hand them to init. Everything else is fixed
 * size, so this allocates nothing and can run on the audio thread.
 */

#ifndef BROKODR_DSP_BEAT_CLASSIFY_H
#define BROKODR_DSP_BEAT_CLASSIFY_H

#include <stddef.h>

#include "brokodr/dsp/onset.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Classes Smart Voice can fire, in wire order. APPEND ONLY — the index is
   persisted. Mirrors VOICE_CLASS_NAMES / CLASS_COUNT. */
#define BK_VOICE_CLASS_COUNT 4

enum bk_voice_class {
  BK_VOICE_KICK = 0,
  BK_VOICE_SNARE = 1,
  BK_VOICE_HAT = 2,
  BK_VOICE_CLAP = 3
};

/* FAST commits on the band-only decision when it is confident; ACCURATE never
   does. Mirrors VOICE_MODE. */
enum bk_voice_mode { BK_VOICE_FAST = 0, BK_VOICE_ACCURATE = 1 };

/* Whole blocks after the onset block that stage 1 waits before reading the
   band envelopes. Must be at least 1 — see the JS STAGE1_DELAY_BLOCKS note,
   where 0 is the bug it describes and not a low-latency option. Exposed
   because the battery has to know when a read is due. */
#define BK_VOICE_STAGE1_DELAY_BLOCKS 1

/* Hits awaiting their stage-2 features. Matches the detector's commit ring
   exactly, which is what lets a pending hit be looked up by onset number. */
#define BK_VOICE_PEND_SLOTS 16

/* Most hits one block can fire. The detector caps at BK_ONSET_MAX_HITS per
   block, so this cannot overflow. */
#define BK_VOICE_FIRE_MAX 8

/* Calibration capture ring: slots, and the layout of one slot,
   `[class, f0..f3, attackLow, attackMid, attackHigh, strength]`. */
#define BK_VOICE_CAP_SLOTS 64
#define BK_VOICE_CAP_STRIDE (BK_ONSET_FEATURE_COUNT + 5)
#define BK_VOICE_CAP_ATTACK_OFFSET (BK_ONSET_FEATURE_COUNT + 1)

/* Values bk_smart_voice_read_meters writes. Append only. */
#define BK_VOICE_METER_STRIDE 12

/*
 * The ten parameters, in the order VOICE_KEY lists them. VOICE_KEY is APPEND
 * ONLY in the JS because the index is what the command ring stores, so this
 * enum is append only for the same reason and for the same wire. It is exactly
 * VOICE_KEY: ten entries, no more.
 */
enum bk_voice_param {
  BK_VOICE_ENABLED = 0,
  BK_VOICE_SENSITIVITY = 1,
  BK_VOICE_FLOOR_DB = 2,
  BK_VOICE_MIN_GAP_MS = 3,
  BK_VOICE_FEATURE_MS = 4,
  BK_VOICE_MODE = 5,
  BK_VOICE_MARGIN = 6,
  BK_VOICE_VEL_MIN = 7,
  BK_VOICE_VEL_DB = 8,
  BK_VOICE_MONITOR = 9,
  BK_VOICE_PARAM_COUNT = 10
};

/*
 * Two keys set_param also accepts, forwarded to the detector untouched, with
 * no Smart Voice state of their own.
 *
 * They are deliberately NOT in bk_voice_param. In the JS, setParam takes a
 * string and VOICE_KEY is only the wire's index->string table — so these two
 * are reachable by name but unreachable over the wire, and nothing in the
 * engine or the UI ever sends them. Giving them wire indices 10 and 11 would
 * spend the next two append slots on keys the wire cannot produce, and the
 * eleventh real VOICE_KEY entry would then collide with one of them. Out of
 * band instead, far enough above the wire range that no plausible append
 * reaches them, which keeps the defensive passthrough callable at zero cost
 * to the wire.
 */
enum bk_voice_param_forward {
  BK_VOICE_LOW_CROSS_HZ = 256,
  BK_VOICE_HIGH_CROSS_HZ = 257
};

/* Writes VOICE_DEFAULTS into `out`, which must hold BK_VOICE_PARAM_COUNT
   doubles, indexed by bk_voice_param. The crossovers are absent for the same
   reason they are absent from VOICE_DEFAULTS: the JS constructor passes the
   detector ONSET_DEFAULTS' own values for them, so there is nothing to carry. */
void bk_smart_voice_defaults(double *out);

/* The factory profile. `out` holds BK_VOICE_CLASS_COUNT *
   BK_ONSET_FEATURE_COUNT floats. The attack table's zcr slot is written 0:
   it keeps the 4-wide stride so one distance function serves both tables and
   stage 1 is a plain `axes = 3` call. */
void bk_smart_voice_factory_centroids(float *out);
void bk_smart_voice_factory_attack(float *out);

/* Which pad each class fires by default — DEFAULT_CLASS_PADS. `out` holds
   BK_VOICE_CLASS_COUNT ints. */
void bk_smart_voice_default_class_pads(int *out);

/* Floats init needs handed to it, for the detector's lag history. */
int bk_smart_voice_hist_floats(double sample_rate);

typedef struct {
  double sr;

  int enabled;
  int mode;
  double margin;
  double vel_min;
  double vel_db;
  int monitor;
  double floor_db;

  bk_onset det;

  /* Both tables flat, so a single wire command can set one number of one
     class. float32 to match the JS Float32Arrays — see hazard 4. */
  float centroids[BK_VOICE_CLASS_COUNT * BK_ONSET_FEATURE_COUNT];
  float attack[BK_VOICE_CLASS_COUNT * BK_ONSET_FEATURE_COUNT];

  /* Which pad each class fires; -1 mutes that class without losing its
     centroid. */
  int class_pad[BK_VOICE_CLASS_COUNT];

  /* Hits decided this block, drained by the caller. */
  int fire_count;
  int fire_pad[BK_VOICE_FIRE_MAX];
  float fire_vel[BK_VOICE_FIRE_MAX];
  int fire_class[BK_VOICE_FIRE_MAX];
  int fire_stage[BK_VOICE_FIRE_MAX];
  float fire_conf[BK_VOICE_FIRE_MAX];

  /* Hits waiting for stage 2, indexed by onset number modulo PEND_SLOTS.
     `pend_id` is `int` and not `long long` on purpose — see hazard 2. */
  int pend_id[BK_VOICE_PEND_SLOTS];
  int pend_class[BK_VOICE_PEND_SLOTS];
  float pend_vel[BK_VOICE_PEND_SLOTS];
  float pend_strength[BK_VOICE_PEND_SLOTS];
  int pend_fired[BK_VOICE_PEND_SLOTS];
  int pend_wait[BK_VOICE_PEND_SLOTS];
  int pend_read[BK_VOICE_PEND_SLOTS];
  float pend_band[BK_VOICE_PEND_SLOTS * 3];

  /* Onset numbering. These are the unbounded counters; only the slot store
     truncates. */
  long long onset_count;
  long long drained;

  /* Calibration capture ring. Written on stage 2 only — a half-measured hit
     would poison the centroid it trains. */
  int capture_class;
  long long capture_count;
  float captures[BK_VOICE_CAP_SLOTS * BK_VOICE_CAP_STRIDE];

  /* Scratch, fixed size: the stage-1 band vector and the stage-2 feature
     read. float32, and the rounding is observable — see hazard 4. */
  float band_scratch[BK_ONSET_FEATURE_COUNT];
  float feat_scratch[BK_ONSET_FEATURE_COUNT];

  /* Live readouts for the UI. */
  long long hit_count;
  int last_class;
  double last_conf;
  double last_vel;
  int last_stage;
  double last_strength;
  long long corrections;
  double level;
  float last_band[3];

  /* classify()'s second and third results, carried in the struct rather than
     returned, so no result object is allocated per hit on the audio thread.
     Plain Numbers in the JS, so `double` here. */
  double scratch_ratio;
  double scratch_conf;
} bk_smart_voice;

/*
 * `opts` is either NULL or BK_VOICE_PARAM_COUNT doubles indexed by
 * bk_voice_param. NULL means the factory profile and VOICE_DEFAULTS
 * throughout, which is what `new SmartVoice(sr)` gives.
 *
 * Note that the JS constructor does *not* route its defaults through
 * setParam: it assigns the fields directly and builds the detector with the
 * four detector defaults. So an `opts` value here is applied exactly as
 * set_param would apply it, clamps included, which is the only sane reading —
 * but it means init(opts) and init(NULL)+set_param are the same thing by
 * construction rather than by coincidence, and the battery checks that.
 *
 * `hist_storage` must be at least bk_smart_voice_hist_floats(sample_rate)
 * floats and outlive the struct.
 */
void bk_smart_voice_init(bk_smart_voice *v, double sample_rate, const double *opts,
                         float *hist_storage);

/* Keys outside bk_voice_param and non-finite values are ignored, exactly as
   the JS ignores an unknown string and a non-finite Number. */
void bk_smart_voice_set_param(bk_smart_voice *v, int key, double value);

/* One number of one class, per feature, so the wire stays a flat numeric
   ring. `cls` and `feature` are coerced ToInt32 before range-checking — see
   hazard 5. */
void bk_smart_voice_set_centroid(bk_smart_voice *v, double cls, double feature, double value);
/* Same, for the stage-1 table, where only the three band axes exist. */
void bk_smart_voice_set_attack_centroid(bk_smart_voice *v, double cls, double band, double value);
void bk_smart_voice_set_class_pad(bk_smart_voice *v, double cls, double pad);

/* Both tables back to the factory profile — they are one profile, not two. */
void bk_smart_voice_reset_centroids(bk_smart_voice *v);

/* Start capturing hits as examples of `cls`, or anything out of range to
   stop. Supervised: the class comes from the UI prompt, not the classifier. */
void bk_smart_voice_set_capture(bk_smart_voice *v, double cls);
void bk_smart_voice_clear_captures(bk_smart_voice *v);

/* Copies capture number `n` into `out` as BK_VOICE_CAP_STRIDE floats.
   Returns 0 once it has been overwritten or has not happened yet. */
int bk_smart_voice_read_capture(const bk_smart_voice *v, long long n, float *out);

void bk_smart_voice_reset_detector(bk_smart_voice *v);
void bk_smart_voice_reset(bk_smart_voice *v);

/*
 * Nearest centroid in `table` over the first `axes` features of `features`.
 * Returns the class; writes v->scratch_conf and v->scratch_ratio. Exported
 * because the battery classifies known vectors directly rather than only
 * through a block of audio.
 */
int bk_smart_voice_classify(bk_smart_voice *v, const float *features, int axes,
                            const float *table);

/* Velocity from loudness, mapped from the gate upward. */
double bk_smart_voice_velocity_from(const bk_smart_voice *v, double db);

/*
 * One mono block of mic signal. Returns how many pad hits were decided, which
 * are in fire_pad / fire_vel / fire_class for the caller to fire.
 *
 * `block` is only read. Feed it the mic *before* the effect chain, *before*
 * the mute, and without the drum bus summed in — a detector that can hear the
 * kit it is firing will retrigger itself into a runaway roll.
 */
int bk_smart_voice_process(bk_smart_voice *v, const float *block, size_t n);

/* Writes BK_VOICE_METER_STRIDE values at `offset`. Returns how many. `double`
   and `int offset` to match bk_chain_read_slot_meters: the wire's meter buffer
   is a Float32Array, but the narrowing happens where the engine copies into
   it, not here, so a meter read in the battery is not silently rounded. */
int bk_smart_voice_read_meters(const bk_smart_voice *v, double *out, int offset);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_BEAT_CLASSIFY_H */
