/* Bro.Kodr — C99 port of effects/time.js (Delay, Reverb). Named time-fx so the
 * header can never shadow the C library <time.h> under any include path.
 * Caller-owned state/storage, double scalars, float delay buffers and a float
 * Hadamard scratch (the JS `tmp` Float32Array); see biquad.h for porting rules.
 * No allocation. sample_rate must be positive; storage must outlive the effect.
 * JS quirks preserved:
 *  - Delay filters are set at the top of every process call, frames <= 0 too;
 *    until the first process they keep the Biquad constructor state.
 *  - Delay sync: Math.round, a NaN division fails `> 0` and selects free time;
 *    the table index is clamp(sync, 0, 9) of a positive integer or +inf.
 *  - Delay fb_l/fb_r are reset to 0 and never otherwise used.
 *  - Reverb allpasses start at g = 0.5, not the reported diffusion 0.6; only a
 *    diffusion set_param changes g.
 *  - Reverb predelay writes before it reads; the FDN reads before it writes.
 *    Every LFO advances each sample whatever the modulation threshold.
 *  - The Hadamard butterfly rounds to float after every add/subtract and after
 *    the 1/sqrt(8) normalisation, as the Float32Array does.
 *  - Reset leaves smoothers, LFOs and the Hadamard scratch alone.
 * The JS `damp` array (constant 0.3) and `mix` Float32Array are never read, so
 * they have no C counterpart.
 */
#ifndef BROKODR_DSP_TIME_FX_H
#define BROKODR_DSP_TIME_FX_H
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
  bk_delay_line line_l, line_r;
  bk_smoother time_l, time_r;
  double feedback, lp_freq, hp_freq, fb_l, fb_r;
  int pingpong;
  bk_biquad lp_l, lp_r, hp_l, hp_r;
  bk_lfo lfo;
  double mod_depth, spread, bpm, sync_div, time_ms, crossfeed, saturate;
} bk_delay;

#define BK_REVERB_LINES 8
typedef struct {
  double sr;
  bk_delay_line lines[BK_REVERB_LINES];
  double damp_state[BK_REVERB_LINES];
  bk_allpass diff_l[4], diff_r[4];
  bk_delay_line pre_l, pre_r;
  bk_smoother size_sm, decay_sm, damp_sm, predelay_sm;
  double width, hp_freq, mod_depth, diffusion;
  bk_biquad hp_l, hp_r;
  bk_lfo lfos[BK_REVERB_LINES];
  float tmp[BK_REVERB_LINES];
} bk_reverb;

size_t bk_delay_storage_floats(double sample_rate);
size_t bk_reverb_storage_floats(double sample_rate);
void bk_delay_init(bk_delay *e, double sample_rate, float *storage);
void bk_reverb_init(bk_reverb *e, double sample_rate, float *storage);
#define BK_TIME_API(name) \
  void bk_##name##_set_param(bk_##name *e, int key, double value); \
  void bk_##name##_reset(bk_##name *e); \
  void bk_##name##_process(bk_##name *e, float *l, float *r, int frames); \
  extern const bk_effect_vt bk_##name##_vt
BK_TIME_API(delay);
BK_TIME_API(reverb);
#undef BK_TIME_API
#ifdef __cplusplus
}
#endif
#endif
