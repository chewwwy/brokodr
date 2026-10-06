/*
 * Bro.Kodr DSP — dynamics. C port of dsp/effects/dynamics.js.
 *
 * Four effects, four structs:
 *
 *   bk_compressor        Compressor ("comp"): feed-forward, linked stereo
 *                        detection (peak = max of |l|, |r|; RMS = a 5 ms
 *                        follower on their mean), dB-domain attack/release
 *                        ballistics, soft-knee quadratic gain computer,
 *                        smoothed makeup, optional 0-10 ms lookahead.
 *   bk_limiter           Limiter ("limiter"): 1.5 ms (at least 8 samples)
 *                        lookahead, sliding maximum over that window, smoothed
 *                        gain, then a hard clamp to the ceiling.
 *   bk_gate              Gate ("gate"): sidechain highpass, peak follower,
 *                        open/close thresholds with hysteresis, hold, range.
 *   bk_transient_shaper  Transient shaper ("transient"): fast vs slow
 *                        follower difference in dB, split into attack and
 *                        sustain gains.
 *
 * Porting rules as in biquad.h. Float where the JS holds a Float32Array: the
 * lookahead delay lines and the limiter's sliding-maximum window. Everything
 * else is double.
 *
 * Faithfulness notes — JS behaviour reproduced on purpose:
 *
 *   - `| 0` is ToInt32, wrap included: the compressor's lookahead in samples
 *     and the gate's hold in samples. The gate's hold is not clamped, so a
 *     huge or negative hold wraps (or goes negative and never holds) exactly
 *     as in the JS. NaN gives 0.
 *   - Math.max / Math.min propagate NaN (bk_max / bk_min), and the JS
 *     comparisons are kept as written, so NaN parameters and samples flow
 *     through as they do in the JS rather than being filtered. A NaN sample
 *     makes the compressor's envelope NaN for good (NaN > x is false, so the
 *     release coefficient is used, and NaN + ... is NaN); the limiter's window
 *     skips a NaN entry (`win[k] > peak` is false), and so on.
 *   - The compressor's attack / release are Smoothers stepped ONCE PER BLOCK
 *     (their next() is called by process(), not per sample), with the 5 ms
 *     per-sample time constant the JS gives them. The makeup smoother is
 *     stepped per sample.
 *   - The gate runs hpL on l[i] and then hpR on r[i] (C argument evaluation
 *     order is unspecified, so they are evaluated into temporaries first).
 *   - Output order, which matters when l and r alias (a mono caller): the
 *     compressor and limiter read both input samples before writing; the gate
 *     and the transient shaper write l[i] and then read r[i], so aliased, the
 *     right channel takes the gain a second time — faithfully.
 *   - reset() is the JS's: the compressor's sets the envelope to -120 dB and
 *     clears the lookahead lines and the RMS follower, but leaves the
 *     attack/release/makeup smoothers alone; the limiter's clears the lines,
 *     the window, the envelope, but NOT the window index; the gate's resets
 *     its gain smoother to 0 (closed); the shaper's resets its gain smoother
 *     to 1. Note the compressor's envelope STARTS at 0 dB, not -120.
 *   - meter: the compressor, limiter and gate report the block's maximum gain
 *     reduction in dB (0 when none); the shaper reports the block's maximum
 *     |gain| in dB. All four start at 0 and are written at the end of every
 *     process(), frames <= 0 included.
 *   - None of the four sizes anything by max_block, so frames > max_block
 *     needs no chunking, and negative frames process nothing (the per-block
 *     work — compressor coefficient recalc, gate highpass set — still runs).
 *
 * Deliberate divergences: none.
 *
 * Preconditions: sample_rate > 0, and the storage given at init is at least
 * bk_compressor_storage_floats / bk_limiter_storage_floats(sample_rate)
 * floats and outlives the effect.
 */

#ifndef BROKODR_DSP_DYNAMICS_H
#define BROKODR_DSP_DYNAMICS_H

#include <stddef.h>

#include "brokodr/dsp/biquad.h"
#include "brokodr/dsp/chain.h"
#include "brokodr/dsp/delay-line.h"
#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  double sr;
  double threshold;
  double ratio;
  double knee;
  double makeup;
  int rms_mode;
  double lookahead_ms;

  bk_smoother attack;  /* ms, stepped once per block */
  bk_smoother release; /* ms, stepped once per block */
  bk_smoother mk_gain;

  double env_db;
  double gain_db;
  double a_coef, r_coef;
  bk_env_follower rms;
  bk_delay_line la[2];
  double meter;
} bk_compressor;

/* Two lookahead lines of ceil(sample_rate * 0.01) + 8 samples. */
size_t bk_compressor_storage_floats(double sample_rate);
void bk_compressor_init(bk_compressor *c, double sample_rate, float *storage);
/* key is BK_P_COMP_*; unknown keys are ignored. */
void bk_compressor_set_param(bk_compressor *c, int key, double value);
void bk_compressor_reset(bk_compressor *c);
void bk_compressor_process(bk_compressor *c, float *l, float *r, int frames);
double bk_compressor_meter(const bk_compressor *c);

/* process, reset, set_param, meter. */
extern const bk_effect_vt bk_compressor_vt;

typedef struct {
  double sr;
  double ceiling_db;
  double release_ms;
  double gain_db;
  int lookahead;
  bk_delay_line d[2];
  float *win; /* caller-owned, lookahead long */
  int wi;
  double env;
  double r_coef, a_coef;
  double meter;
} bk_limiter;

/* Two delay lines of lookahead + 8 samples plus the lookahead-long window,
   lookahead = max(8, Math.round(sample_rate * 0.0015)). */
size_t bk_limiter_storage_floats(double sample_rate);
void bk_limiter_init(bk_limiter *m, double sample_rate, float *storage);
void bk_limiter_set_param(bk_limiter *m, int key, double value);
void bk_limiter_reset(bk_limiter *m);
void bk_limiter_process(bk_limiter *m, float *l, float *r, int frames);
double bk_limiter_meter(const bk_limiter *m);

extern const bk_effect_vt bk_limiter_vt;

typedef struct {
  double sr;
  double threshold_db;
  double range_db;
  double hold_ms;
  double hysteresis_db;
  double sc_hp_freq;
  bk_env_follower env;
  bk_biquad hp[2];
  bk_smoother gain_sm;
  int open;
  int hold_counter;
  double attack_ms;
  double release_ms;
  double meter;
} bk_gate;

void bk_gate_init(bk_gate *g, double sample_rate);
void bk_gate_set_param(bk_gate *g, int key, double value);
void bk_gate_reset(bk_gate *g);
void bk_gate_process(bk_gate *g, float *l, float *r, int frames);
double bk_gate_meter(const bk_gate *g);

extern const bk_effect_vt bk_gate_vt;

typedef struct {
  double sr;
  double attack_amt;
  double sustain_amt;
  bk_env_follower fast;
  bk_env_follower slow;
  bk_smoother gain_sm;
  double meter;
} bk_transient_shaper;

void bk_transient_shaper_init(bk_transient_shaper *t, double sample_rate);
void bk_transient_shaper_set_param(bk_transient_shaper *t, int key, double value);
void bk_transient_shaper_reset(bk_transient_shaper *t);
void bk_transient_shaper_process(bk_transient_shaper *t, float *l, float *r, int frames);
double bk_transient_shaper_meter(const bk_transient_shaper *t);

extern const bk_effect_vt bk_transient_shaper_vt;

#ifdef __cplusplus
}
#endif

#endif
