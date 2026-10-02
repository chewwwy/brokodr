/*
 * Bro.Kodr DSP effect — 6-band parametric EQ.
 * C port of dsp/effects/eq.js. See biquad.h for the porting rules.
 *
 * The first of the 22 rack effects. Topology, per channel:
 *
 *     HP cascade (1-4 stages) -> low shelf -> 3 peaks -> high shelf -> LP cascade (1-4)
 *
 * Coefficients are recomputed once per block from smoothed values, so the 18
 * param smoothers run at the CONTROL rate, sr / max(1, max_block || 128), and
 * advance once per process() call. Only the output gain is smoothed per sample,
 * through a second smoother (20 ms at the audio rate) whose target is set from
 * the block-rate one. Both channels share coefficients but not state.
 *
 * Quirks reproduced on purpose, each one load-bearing for parity:
 *
 *   - THE ON/OFF TESTS READ THE RAW PARAM, NOT THE SMOOTHED ONE. hp is off when
 *     hpFreq <= 21, lp is off when lpFreq >= 19900, decided from what was last
 *     set, while the coefficients come from the gliding value. So dragging hp
 *     down to 20 Hz switches it off at once, mid-glide.
 *   - The slope smoothers exist and take targets but are never advanced; the
 *     stage count is 1 + Math.round(clamp(slope, 0, 3)) of the raw param, with
 *     JS rounding (2.5 -> 3, 0.49999999999999994 -> 0), never floor(x + 0.5).
 *   - A NaN slope makes the JS cascade's active count NaN, and `i < NaN` runs
 *     no stages: a NaN slope is a bypassed filter. Mirrored as 0 stages.
 *   - The cascades are always set with all 4 stages' Butterworth staggering,
 *     whatever the active count, because the JS staggers by stages.length.
 *   - The curve (160 points, 20 Hz - 20 kHz, log-spaced) is re-rendered only
 *     on the block after a set_param or construction, from channel 0, plus the
 *     raw output param. reset() does not mark it dirty.
 *
 * The vt is bk_eq_vt; the EQ reports no latency and no meter (the JS meter is
 * a constant 0, which the chain reads identically from a NULL entry).
 *
 * Real-time discipline: no allocation, caller-owned struct. libm: exp at init
 * and on set_time (smoothers), and per block cos/sin/pow/sqrt only when a
 * smoothed value has moved (bk_biquad_set is idempotent), pow once per block
 * for the output gain, and cos/sin/sqrt/log10/pow for the curve after a param
 * change. glibc and emscripten agree here, which is empirical; MSVC is
 * unmeasured.
 */

#ifndef BROKODR_DSP_EQ_H
#define BROKODR_DSP_EQ_H

#include "brokodr/dsp/biquad.h"
#include "brokodr/dsp/chain.h"
#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* CURVE_POINTS in eq.js. */
#define BK_EQ_CURVE_POINTS 160
/* The cascades' fixed stage count, BiquadCascade(sampleRate, 4). */
#define BK_EQ_CASCADE_STAGES 4

typedef struct {
  bk_biquad_cascade hp;
  bk_biquad ls, b1, b2, b3, hs;
  bk_biquad_cascade lp;
} bk_eq_channel;

typedef struct {
  double sr;
  int max_block;
  double control_rate;

  /* Raw params, indexed by BK_P_EQ_*. */
  double p[BK_P_EQ_COUNT];
  /* One control-rate smoother per param, same index. */
  bk_smoother sm[BK_P_EQ_COUNT];
  bk_smoother out_gain;

  bk_eq_channel ch[2];

  /* The curve display, dB. Float, as the JS Float32Array is. */
  float visual[BK_EQ_CURVE_POINTS];
  int visual_dirty;
} bk_eq;

/* max_block: 0 means 128 and anything below 1 means 1, as
   Math.max(1, maxBlock || 128). It only sets the control rate. */
void bk_eq_init(bk_eq *e, double sample_rate, int max_block);

/* `key` is one of BK_P_EQ_*; anything else is ignored. */
void bk_eq_set_param(bk_eq *e, int key, double value);
void bk_eq_reset(bk_eq *e);

/* In place, 100% wet. Runs the per-block coefficient update even when
   frames <= 0, exactly as the JS does. */
void bk_eq_process(bk_eq *e, float *l, float *r, int frames);

/* The curve, BK_EQ_CURVE_POINTS floats. */
const float *bk_eq_visual(const bk_eq *e);

extern const bk_effect_vt bk_eq_vt;

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_EQ_H */
