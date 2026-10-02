/*
 * Bro.Kodr DSP — drive stages. C port of dsp/effects/drive.js.
 *
 * Three effects, two structs:
 *
 *   bk_drive  Distortion ("dist", default curve 1, hard clip) and Saturation
 *             ("sat", default curve 0, soft tube). One DriveBase in the JS, one
 *             struct here; the two types differ only in the default curve, and
 *             their param lists (BK_P_DIST_*, BK_P_SAT_*) are the same order.
 *             pre-HP -> shaper (4x oversampled or not) -> DC blocker -> tone
 *             filter -> output gain. The shaper reads drive and bias ONCE per
 *             block (the first frame's smoothed value), as the JS closure does.
 *   bk_crush  BitCrusher ("crush"): sample-and-hold decimation, mid-tread
 *             quantisation, optional TPDF dither, optional anti-alias lowpass.
 *
 * Porting rules as in biquad.h. The JS holds two things in Float32Arrays, and
 * so does the C: the pre-HP output (tmpL/tmpR) and the oversampler's work
 * buffer. Everything else is double.
 *
 * Faithfulness notes — JS behaviour reproduced on purpose:
 *
 *   - `curve` is clamp(Math.round(v), 0, 5) and `tonemode` is Math.round(v),
 *     with the JS Math.round (exact fraction, and -0 for [-0.5, 0)). The tone
 *     filter is a highpass only when tonemode rounds to exactly 1; anything
 *     else, NaN included, is a lowpass.
 *   - `oversample` is v >= 0.5, so NaN means off.
 *   - Drive and bias smoothers advance once per frame but are READ once per
 *     block; the output smoother is read per frame. frames == 0 still advances
 *     drive and bias by one step, because the JS calls next() before its loop.
 *   - The meter is the block's peak |l|, |r| BEFORE sanitize, and a NaN frame
 *     never raises it (Math.max gives NaN, and NaN > peak is false).
 *   - Crusher: `bits`, `rate`, `dither`, `smooth` are clamped but not rounded
 *     (fractional bit depths are real, pow(2, bits) - 1 levels); rate is
 *     clamped to [200, sample_rate]; the anti-alias filter is only re-set and
 *     only run while smooth > 0.001, so its state freezes, not clears, when it
 *     is switched off.
 *   - l and r may be the same buffer (a mono caller): every sample is read
 *     before it is written, in the JS order, so the result matches the JS
 *     given the same aliased array.
 *
 * Deliberate divergences — where the JS cannot be followed:
 *
 *   - A NaN `curve` makes the JS index SHAPERS[NaN], and process() then throws
 *     a TypeError on every block: the effect dies. Here a NaN curve is ignored
 *     and the previous curve stays. The parity battery checks the JS really
 *     does throw, and replays such scripts without that one set.
 *   - Foldback (curve 2) is `while (|y| > 0.8) reflect`, which costs |y| / 3.2
 *     iterations and never ends for an infinite input. Up to |y| <= 4096
 *     (BK_DRIVE_FOLD_LIMIT; 40 dB of drive on a +32 dBFS sample) the C runs the
 *     same loop, step for step. Beyond that, and for inf, it uses the closed
 *     form (an fmod triangle), which is not bit-identical to the loop (the loop
 *     accumulates rounding the closed form does not) and turns inf into NaN,
 *     which the output stage sanitises to 0.
 *   - frames > max_block: the JS writes past its Float32Arrays (dropped) and
 *     reads undefined back (NaN), poisoning every filter. Here process() runs
 *     the call as consecutive chunks of at most max_block, so the audio is
 *     right; the meter is the peak over the whole call. Negative frames
 *     behave as 0, as in the JS.
 *   - max_block below 1: the JS makes empty Float32Arrays (0, then every
 *     read is undefined) or throws a RangeError (negative). Here it is 1.
 *   - Math.random() in the crusher's dither is a callback (bk_random_fn,
 *     [0, 1)). NULL means an internal xorshift, outside the parity contract;
 *     the battery installs a generator it mirrors in JS. The four draws per
 *     held sample are sequenced l, l, r, r as JS evaluation order requires.
 */

#ifndef BROKODR_DSP_DRIVE_H
#define BROKODR_DSP_DRIVE_H

#include <stddef.h>

#include "brokodr/dsp/biquad.h"
#include "brokodr/dsp/chain.h"
#include "brokodr/dsp/delay-line.h"
#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BK_DRIVE_CURVES 6
#define BK_DRIVE_FOLD_LIMIT 4096.0

/* Floats of caller-owned scratch a bk_drive needs: two max_block pre-HP
   buffers plus two 4 * max_block oversampler buffers. */
#define BK_DRIVE_SCRATCH_FLOATS(max_block) ((size_t)(max_block) * 10u)

typedef struct {
  double sr;
  int max_block;

  bk_smoother drive;
  bk_smoother out_sm;
  bk_smoother bias_sm;
  int curve;
  double tone_freq;
  double tone_mode;
  double pre_freq;
  int oversample;

  bk_oversampler4x os[2];
  bk_dc_blocker dc_l, dc_r;
  bk_biquad tone_l, tone_r;
  bk_biquad pre_l, pre_r;
  float *tmp_l, *tmp_r; /* caller-owned, max_block each */

  /* Block-rate snapshot the shaper reads. */
  double drive_val;
  double bias_val;
  double meter;
} bk_drive;

/* `scratch` must hold BK_DRIVE_SCRATCH_FLOATS(max_block) floats and outlive
   the effect. max_block below 1 is taken as 1. */
void bk_drive_init(bk_drive *d, double sample_rate, int max_block, int default_curve, float *scratch);
void bk_dist_init(bk_drive *d, double sample_rate, int max_block, float *scratch);
void bk_sat_init(bk_drive *d, double sample_rate, int max_block, float *scratch);
/* key is BK_P_DIST_* (== BK_P_SAT_*); unknown keys are ignored. */
void bk_drive_set_param(bk_drive *d, int key, double value);
void bk_drive_reset(bk_drive *d);
void bk_drive_process(bk_drive *d, float *l, float *r, int frames);
double bk_drive_meter(const bk_drive *d);
/* One transfer curve, exactly as the shaper applies it (after drive/bias). */
double bk_drive_shape(int curve, double x);

/* Distortion and Saturation share it: process, reset, set_param, meter. */
extern const bk_effect_vt bk_drive_vt;

typedef struct {
  double sr;
  double bits;
  double rate_hz;
  double dither_amt;
  bk_smoother drive_sm;
  bk_smoother out_sm;
  double phase;
  double hold_l, hold_r;
  double anti_alias;
  bk_biquad lp_l, lp_r;

  bk_random_fn random;
  void *random_user;
  unsigned int rng; /* for random == NULL only */
} bk_crush;

void bk_crush_init(bk_crush *c, double sample_rate);
/* fn == NULL restores the internal generator. */
void bk_crush_set_random(bk_crush *c, bk_random_fn fn, void *user);
void bk_crush_set_param(bk_crush *c, int key, double value);
void bk_crush_reset(bk_crush *c);
void bk_crush_process(bk_crush *c, float *l, float *r, int frames);

/* process, reset, set_param; no meter (the JS crusher's meter stays 0). */
extern const bk_effect_vt bk_crush_vt;

#ifdef __cplusplus
}
#endif

#endif
