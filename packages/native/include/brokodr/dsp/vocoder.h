/* Bro.Kodr — C99 port of effects/vocoder.js (Vocoder, effect 22 of 22).
 * Channel vocoder: up to 32 log-spaced bands, each a 4-pole bandpass on the
 * modulator into an RMS envelope follower and the same 4-pole bandpass on the
 * carrier, multiplied per band. Carrier: PolyBLEP saw, pulse, dual saw, noise,
 * sub + saw, or the chain's file-carrier bus; pitch follow through the shared
 * autocorrelation tracker; a sibilance noise path into the bands above 3 kHz.
 * See biquad.h for porting rules. Every JS field is a double scalar; the only
 * JS Float32Array is the UI ladder, which bk_vocoder_visual writes into a
 * caller buffer. Fixed-size struct, no storage, no allocation.
 *
 * Randomness: the two Math.random() sites (the noise carrier and the sibilance
 * noise) call a bk_random_fn ([0, 1)); NULL selects an internal xorshift
 * outside the parity contract, and the battery installs a generator it mirrors
 * in JS. Draw order per frame: the noise carrier (carrier type 3 only, and even
 * when the file carrier then replaces it), then the sibilance noise, always.
 *
 * JS behaviour reproduced on purpose:
 *  - raw params keep NaN: a NaN band count (clamp(Math.round(NaN))) leaves no
 *    active band and makes 1/sqrt(n) NaN, so the output sanitises to 0; NaN
 *    freqlo/freqhi/q/attack/release reach the filters and followers as NaN.
 *  - the band count, frequency range, q, tone and spread rebuild lazily at the
 *    next process call; bands above the count keep their old settings.
 *  - the oscillators keep running under the file carrier; osc1.pw = 0.3 set by
 *    the pulse carrier persists; the sub oscillator keeps the default pw 0.5.
 *  - the sibilance highpass is (re)set at the top of every process call, so
 *    until the first one it keeps the Biquad constructor state.
 *  - reset leaves the smoothers, oscillators, pitch tracker and tracked pitch
 *    alone; the JS envSum accumulator is never read and the `n === 1` band
 *    position guard cannot fire (n >= 4), so neither has a counterpart.
 */
#ifndef BROKODR_DSP_VOCODER_H
#define BROKODR_DSP_VOCODER_H
#include <stddef.h>
#include "brokodr/dsp/biquad.h"
#include "brokodr/dsp/chain.h"
#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"
#ifdef __cplusplus
extern "C" {
#endif

#define BK_VOCODER_MAX_BANDS 32

typedef struct {
  bk_biquad mod_a, mod_b, car_a, car_b;
  bk_env_follower env;
  double freq, gain, pan, level;
} bk_vocoder_band;

typedef struct {
  double sr;
  int max_block;
  /* raw params; band_count and carrier_type are integers or NaN */
  double band_count, freq_lo, freq_hi, q_factor, carrier_type, carrier_pitch_hz;
  int pitch_follow;
  double depth, tone, sibilance, attack_ms, release_ms, carrier_level, stereo_spread;
  int source;
  const float *car_l, *car_r;
  double car_rms, car_rms_a;
  bk_vocoder_band bands[BK_VOCODER_MAX_BANDS];
  bk_oscillator osc1, osc2, osc_sub;
  bk_pitch_tracker tracker;
  double tracked_hz;
  bk_smoother pitch_sm, depth_sm, out_sm;
  bk_biquad sib_hp;
  bk_env_follower sib_env, in_env;
  int dirty;
  double meter;
  bk_random_fn random;
  void *random_user;
  unsigned int rng; /* for random == NULL only */
} bk_vocoder;

void bk_vocoder_init(bk_vocoder *e, double sample_rate, int max_block);
/* fn == NULL restores the internal generator. */
void bk_vocoder_set_random(bk_vocoder *e, bk_random_fn fn, void *user);
void bk_vocoder_set_param(bk_vocoder *e, int key, double value);
void bk_vocoder_set_carrier_bus(bk_vocoder *e, const float *l, const float *r);
void bk_vocoder_reset(bk_vocoder *e);
/* process() requires bus arrays at least `frames` long when the bus is used. */
void bk_vocoder_process(bk_vocoder *e, float *l, float *r, int frames);
/* The `visual` getter: writes the active bands' 0..1 ladder values into out
   (BK_VOCODER_MAX_BANDS floats) and returns how many were written. */
int bk_vocoder_visual(const bk_vocoder *e, float *out);
extern const bk_effect_vt bk_vocoder_vt;

#ifdef __cplusplus
}
#endif
#endif
