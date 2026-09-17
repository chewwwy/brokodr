/*
 * Bro.Kodr DSP core — onset detection. C port of dsp/core/onset.js.
 * See biquad.h for the porting rules; they apply here unchanged.
 *
 * This is the first module ported that is a *detector* rather than a
 * generator, and that changes what the port has to be careful about. There is
 * no audio output to compare — the observable is a list of frame positions, a
 * strength per hit, and four features per hit. A single sample of divergence
 * either side of a threshold does not move a number slightly; it adds or drops
 * a whole hit and renumbers everything after it. That makes the port's
 * integer and branch semantics the entire ball game, and the float
 * arithmetic almost incidental.
 *
 * Three things in the JS are easy to port wrongly, and all three are load
 * bearing:
 *
 *   1. THE LAG HISTORY IS A Float32Array. `histLow/histMid/histHigh` hold each
 *      band's envelope from LAG_MS ago, and in the JS they are float32. So the
 *      C holds `float` too. A `double` history would be *more* accurate and
 *      would therefore diverge — which under route (c) is a bug, not an
 *      improvement (the same rule as delay-line.h's buffer). The ratio these
 *      feed is compared against a sensitivity threshold, so the rounding is
 *      directly upstream of a branch that decides whether a hit exists.
 *
 *   2. THREE LENGTHS COME FROM `| 0`, NOT FROM A CAST. `lagLen`, `gapFrames`
 *      and `windowFrames` are each computed as `(ms * 0.001 * sr) | 0`, which
 *      is ES ToInt32: truncate toward zero, then take the result modulo 2^32
 *      and reinterpret as signed. For ordinary sample rates that is plain
 *      truncation, which is why a `(int)` cast looks right. It is not: at a
 *      large enough sample rate the product exceeds INT_MAX, where a C cast is
 *      undefined behaviour and ToInt32 is a defined wrap — and the wrap can
 *      land on a *negative* gapFrames, which makes `sinceHit > gapFrames`
 *      always true and disables the refractory period entirely. bk_onset_to_int32
 *      implements ToInt32 exactly, and the battery visits the wrap.
 *
 *   3. `positions` IS AN Int32Array. Frame counters are JS Numbers — exact
 *      integers to 2^53 — but storing one into `positions` truncates it to
 *      int32 with wraparound. The C keeps its counters in `long long` (an
 *      exact superset of the reachable JS range) and wraps explicitly on the
 *      way into `positions`, so a 13-hour offline pass reports the same
 *      wrapped position in both builds.
 *
 * Storage. The lag history is the one sample-rate-dependent buffer, so it is
 * caller-owned exactly like a delay line's: ask bk_onset_hist_floats() how many
 * floats to provide, hand them to bk_onset_init, and put them in the arena.
 * Everything else in the struct is fixed size, so the detector allocates
 * nothing and can run on the audio thread.
 */

#ifndef BROKODR_DSP_ONSET_H
#define BROKODR_DSP_ONSET_H

#include <stddef.h>

#include "brokodr/dsp/biquad.h"
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Numbers per onset in the feature buffer: low, mid, high, zcr. Mirrors
   FEATURE_COUNT in the JS, which is exported and therefore part of the
   contract. */
#define BK_ONSET_FEATURE_COUNT 4

/* Most onsets one bk_onset_process call will report. A block is a few ms; this
   is generous. Mirrors MAX_HITS_PER_BLOCK. */
#define BK_ONSET_MAX_HITS 8

/* Slots in the commit ring. See bk_onset_read_committed for why it exists. */
#define BK_ONSET_COMMIT_RING 16

/* How far back each band's envelope is compared against, in ms. The single
   most consequential constant in the module — see the JS header for why 8 is
   the answer. Module-private there; exposed here because the battery has to
   compute the expected history length. */
#define BK_ONSET_LAG_MS 8

/*
 * The six parameters, in the order the JS object lists them. Unlike the
 * realtime effect modules these never travel the command ring — onset params
 * are set at construction or from the slicing UI — so there is no generated
 * param-keys.h entry for them and this enum is the whole correspondence.
 */
enum bk_onset_param {
  BK_ONSET_SENSITIVITY = 0,
  BK_ONSET_FLOOR_DB = 1,
  BK_ONSET_MIN_GAP_MS = 2,
  BK_ONSET_FEATURE_MS = 3,
  BK_ONSET_LOW_CROSS_HZ = 4,
  BK_ONSET_HIGH_CROSS_HZ = 5,
  BK_ONSET_PARAM_COUNT = 6
};

/* Writes ONSET_DEFAULTS into `out`, which must hold BK_ONSET_PARAM_COUNT
   doubles, indexed by bk_onset_param. */
void bk_onset_defaults(double *out);

/* ES ToInt32, exported because the battery asserts it directly against the
   JS's `| 0` rather than only through its three call sites. */
int bk_onset_to_int32(double x);

/* The lag history length the JS constructor would have allocated per band:
   max(1, ToInt32(LAG_MS * 0.001 * sr)). */
int bk_onset_lag_len(double sample_rate);

/* Floats bk_onset_init needs handed to it: three bands' worth of the above. */
int bk_onset_hist_floats(double sample_rate);

typedef struct {
  double sr;

  double sensitivity;
  double floor_db;
  double min_gap_ms;
  double feature_ms;
  double low_cross_hz;
  double high_cross_hz;

  /* Band split. Low and high are second-order; the mid is a band-pass rather
     than a subtraction, so no phase-cancelling notch can appear at the
     crossovers. */
  bk_biquad low_filter;
  bk_biquad mid_filter;
  bk_biquad high_filter;

  /* One fast envelope per band, plus the full-band level used only as the
     noise gate. */
  bk_env_follower fast_low;
  bk_env_follower fast_mid;
  bk_env_follower fast_high;
  bk_env_follower level;

  /* Caller-owned, float32 to match the JS Float32Arrays. All three point into
     the single block handed to bk_onset_init. */
  float *hist_low;
  float *hist_mid;
  float *hist_high;
  int lag_len;
  int lag_pos;

  /* Feature-window accumulators. Doubles, because the JS holds them in
     Numbers and the window can be long enough for the count to matter. */
  double acc_low;
  double acc_mid;
  double acc_high;
  double acc_zc;
  double acc_frames;
  int last_sign;

  /* Frame counters. `long long` rather than double: every reachable value is
     an exact integer in both, and int64 covers more of them than a double's
     53 bits does. last_hit_frame starts at -1e9, which is why it is signed and
     not a count. */
  long long frames;
  long long last_hit_frame;

  int window_left;
  int pending_feature;
  int pending_index;

  /* Block-local output. Valid until the next bk_onset_process call. */
  int count;
  int positions[BK_ONSET_MAX_HITS];
  float strengths[BK_ONSET_MAX_HITS];
  float features[BK_ONSET_MAX_HITS * BK_ONSET_FEATURE_COUNT];

  long long commit_count;
  float commit_ring[BK_ONSET_COMMIT_RING * BK_ONSET_FEATURE_COUNT];
} bk_onset;

/*
 * `opts` is either NULL or BK_ONSET_PARAM_COUNT doubles indexed by
 * bk_onset_param. The JS takes a sparse object and applies only the keys
 * present; here, **a non-finite entry means "absent"**. That is not a
 * convention invented for the port — bk_onset_set_param already ignores any
 * non-finite value, exactly as the JS does, so passing NaN for a parameter is
 * indistinguishable from omitting the key.
 *
 * `hist_storage` must be at least bk_onset_hist_floats(sample_rate) floats and
 * outlive the detector. It is zeroed here.
 *
 * A zero or NaN sample_rate becomes 48000, mirroring `sampleRate || 48000`.
 */
void bk_onset_init(bk_onset *d, double sample_rate, const double *opts, float *hist_storage);

/* Clamps and applies one parameter, then recomputes the crossover filters.
   Non-finite values and out-of-range keys are ignored, and an ignored key does
   NOT trigger a filter recompute — the JS returns before its refresh, and the
   recompute is observable through the biquads' idempotence cache. */
void bk_onset_set_param(bk_onset *d, int key, double value);

void bk_onset_reset(bk_onset *d);

/*
 * Processes one mono block and returns the number of onsets found in it, also
 * left in `count`. `block` is read, never written — the live path taps the
 * signal without being in its way. `block` is float, matching the
 * Float32Array the JS reads and the format the device layer delivers.
 *
 * After the call, the hits' absolute frame positions are in `positions` (int32
 * with wraparound, see the header note), their strengths in `strengths`, and
 * their features in `features`, FEATURE_COUNT per hit, hit-major. A hit is
 * reported at the moment it is detected, but its features are only complete
 * feature_ms later, so `pending_feature` says whether the most recent hit is
 * still being measured and its features are partial.
 */
int bk_onset_process(bk_onset *d, const float *block, size_t n);

/*
 * Copies committed measurement number `n` (0-based, in hit order) into `out`,
 * which must hold BK_ONSET_FEATURE_COUNT floats. Returns 0 if that measurement
 * has been overwritten or has not happened yet.
 *
 * The ring exists because a hit's features finish several blocks after it is
 * reported, by which time `features` has been re-indexed from zero for a newer
 * block. A caller that wants finished features (the offline slicer, and any
 * classifier that can wait a frame) watches `commit_count` climb and drains the
 * ring; a caller that wants the hit the instant it happens (live pad
 * triggering) ignores the ring and eats the partial features. Both are served
 * without either delaying the other.
 */
int bk_onset_read_committed(const bk_onset *d, long long n, float *out);

/* --- offline convenience ------------------------------------------------ */

/*
 * Caller-owned output for bk_onset_detect. The JS pushes onto growable arrays;
 * C cannot, so the caller provides the arrays and their common capacity.
 *
 * `count` is the number of hits the detector *found*, which may exceed
 * `capacity`; only the first `capacity` are written. A truncated pass is
 * therefore detectable (count > capacity) rather than silent, and the features
 * of the hits past capacity are dropped, which is the same thing the JS drain
 * does when it runs out of hits to attribute a commit to.
 */
typedef struct {
  int *positions;   /* capacity ints */
  float *strengths; /* capacity floats */
  float *features;  /* capacity * BK_ONSET_FEATURE_COUNT floats */
  int capacity;
  int count;
} bk_onset_result;

/*
 * Runs a whole mono buffer through a detector in blocks and reports every onset
 * it found. This is what BROBEATS slicing calls, and it lives beside the
 * detector rather than in the UI so there is exactly one answer in the codebase
 * to "where are the hits" — the slice points drawn on the waveform are the same
 * positions the live detector would have fired at.
 *
 * `scratch` is the detector's lag history, bk_onset_hist_floats(sample_rate)
 * floats. `block` is a caller-owned staging buffer of `block_size` floats: the
 * JS allocates one per call, and this is that buffer. `block_size` <= 0 becomes
 * 128, mirroring the JS default argument.
 *
 * Offline we want *finished* features rather than the partial ones available
 * the instant a hit is reported, so positions are collected as they come and
 * measurements are drained from the commit ring as they complete a few blocks
 * later. The two are matched by order: the Nth commit belongs to the Nth hit.
 * Returns res->count.
 */
int bk_onset_detect(const float *mono, size_t n, double sample_rate, const double *opts,
                    int block_size, float *scratch, float *block, bk_onset_result *res);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_ONSET_H */
