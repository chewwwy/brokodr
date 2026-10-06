/* Bro.Kodr — C99 port of effects/modulation.js. Caller-owned state/storage,
 * double coefficients, float delay buffers; see biquad.h for porting rules.
 * No allocation. sample_rate must be positive; storage must outlive the effect.
 * JS quirks preserved: Phaser steps smoothers/LFOs once even at frames <= 0;
 * Chorus/Phaser resets keep filter coefficients and oscillator phases;
 * Tremolo/RingMod reset is a no-op; FrequencyShifter reset leaves delayA and
 * phase intact. Aliased channel pointers follow JS assignment order.
 * NaN voices/stages are doubles (no loop iterations), NaN shapes use the
 * sine/default LFO branch. For LFO shape 4, set_random installs a [0,1)
 * callback, shared by both channels; NULL selects a seeded internal xorshift.
 * Random draws occur only at S&H wraps, not on every sample. This replaces
 * Math.random, as in character.h, and is not a claim of random JS parity.
 */
#ifndef BROKODR_DSP_MODULATION_H
#define BROKODR_DSP_MODULATION_H
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
  bk_random_fn fn;
  void *user;
  unsigned int rng;
} bk_mod_random;

typedef struct {
  double sr, voices;
  bk_delay_line lines[2];
  bk_lfo lfos[6];
  bk_smoother rate_sm, depth_sm, delay_sm;
  double spread, feedback, fb_l, fb_r;
  bk_biquad hp[2];
} bk_chorus;

typedef struct {
  double sr;
  bk_delay_line lines[2];
  bk_lfo lfo[2];
  bk_smoother depth_sm, delay_sm;
  double feedback, damp_freq, fb_l, fb_r, stereo_phase;
  int invert;
  bk_biquad damp[2];
  bk_mod_random random;
} bk_flanger;

typedef struct {
  double sr, stages;
  bk_biquad ap[2][8];
  bk_lfo lfo[2];
  bk_smoother center_sm, depth_sm;
  double feedback, q, fb_l, fb_r, stereo;
  bk_mod_random random;
} bk_phaser;

typedef struct {
  double sr;
  bk_lfo lfo[2];
  bk_smoother depth_sm;
  double stereo_mode, phase_offset, smoothness;
  bk_mod_random random;
} bk_tremolo;

typedef struct {
  double sr;
  bk_oscillator osc;
  bk_smoother freq_sm;
  double shape, sweep_depth, phase;
  int am_mode;
  bk_lfo lfo;
} bk_ring_mod;

typedef struct { double a, x1, x2, y1, y2; } bk_hilbert_section;
typedef struct {
  double sr, coef_a[4], coef_b[4];
  bk_hilbert_section state_a[2][4], state_b[2][4];
  double delay_a[2];
  bk_smoother freq_sm;
  double phase, feedback, fb_l, fb_r;
} bk_frequency_shifter;

size_t bk_chorus_storage_floats(double sample_rate);
size_t bk_flanger_storage_floats(double sample_rate);
void bk_chorus_init(bk_chorus *e, double sample_rate, float *storage);
void bk_flanger_init(bk_flanger *e, double sample_rate, float *storage);
void bk_phaser_init(bk_phaser *e, double sample_rate);
void bk_tremolo_init(bk_tremolo *e, double sample_rate);
void bk_ring_mod_init(bk_ring_mod *e, double sample_rate);
void bk_frequency_shifter_init(bk_frequency_shifter *e, double sample_rate);
#define BK_MOD_API(name) \
  void bk_##name##_set_param(bk_##name *e, int key, double value); \
  void bk_##name##_reset(bk_##name *e); \
  void bk_##name##_process(bk_##name *e, float *l, float *r, int frames); \
  extern const bk_effect_vt bk_##name##_vt
BK_MOD_API(chorus);
BK_MOD_API(flanger);
BK_MOD_API(phaser);
BK_MOD_API(tremolo);
BK_MOD_API(ring_mod);
BK_MOD_API(frequency_shifter);
#undef BK_MOD_API
void bk_flanger_set_random(bk_flanger *e, bk_random_fn fn, void *user);
void bk_phaser_set_random(bk_phaser *e, bk_random_fn fn, void *user);
void bk_tremolo_set_random(bk_tremolo *e, bk_random_fn fn, void *user);
#ifdef __cplusplus
}
#endif
#endif