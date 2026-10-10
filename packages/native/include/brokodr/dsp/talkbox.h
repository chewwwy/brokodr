/* Bro.Kodr — C99 port of effects/talkbox.js (TalkBox, effect 19 of 22).
 * LPC source-filter talk box: pre-emphasised Hamming-window autocorrelation,
 * Levinson-Durbin reflection coefficients, an all-pole lattice driven by an
 * internal synth or the chain's file-carrier bus, de-emphasis, breath leak,
 * 4x oversampled drive and an output tilt. See biquad.h for porting rules:
 * double scalars and analysis scratch (the JS Float64Arrays), float where the
 * JS holds a Float32Array (history, window, mono block, oversampler).
 *
 * Storage: bk_talkbox_storage_floats(sr, max_block) caller-owned floats,
 * outliving the effect. process() requires frames <= max_block and, when the
 * carrier bus is used, bus arrays at least `frames` long.
 *
 * JS behaviour reproduced on purpose:
 *  - carrier/order/tract and the other raw params keep NaN. A NaN carrier
 *    selects the default saw, but its RMS lookup is `CARRIER_RMS[NaN]`, i.e.
 *    undefined, so the synth excitation is NaN. A NaN order skips the
 *    autocorrelation and the Levinson loop, yet still applies the noise floor
 *    to the stale acf[0], so acf[0] compounds across hops; activeOrder is 0.
 *    A NaN tract reads `buf[NaN]` (undefined), i.e. a NaN frame and the
 *    silence path.
 *  - activeOrder starts at the default order 22 with all-zero coefficients.
 *  - the oscillators keep running on the file carrier; the drive stage is
 *    skipped at drive <= 0.001; tracking runs per block whenever follow is on.
 *  - reset leaves the oscillators, noise state, pitch tracker, tracked pitch,
 *    pitch/output/breath smoothers, the analysis scratch (acf, frame, lpc) and
 *    the mono block alone, exactly as the JS does.
 *  - the trailing `!isFinite(b[0])` reset guard is kept although b[0] is always
 *    a sanitize() result.
 * The deterministic noise carrier is the JS xorshift32 on int32 state.
 */
#ifndef BROKODR_DSP_TALKBOX_H
#define BROKODR_DSP_TALKBOX_H
#include <stddef.h>
#include "brokodr/dsp/biquad.h"
#include "brokodr/dsp/chain.h"
#include "brokodr/dsp/delay-line.h"
#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"
#ifdef __cplusplus
extern "C" {
#endif

#define BK_TALKBOX_MAX_ORDER 40
#define BK_TALKBOX_MAX_FRAME 2048

typedef struct {
  double sr;
  int max_block;
  /* raw params */
  double carrier_type, pitch_hz, glide_ms, order, tract_size, tract_q;
  double brightness, breath, squelch_db, drive_amt, out_db;
  int follow, source;
  const float *car_l, *car_r;
  double car_rms, car_rms_a;
  /* analysis geometry */
  int frame_len, hop, hist_len;
  float *hist;
  int hist_w, hop_count;
  float window[BK_TALKBOX_MAX_FRAME];
  double frame[BK_TALKBOX_MAX_FRAME];
  double acf[BK_TALKBOX_MAX_ORDER + 1], lpc[BK_TALKBOX_MAX_ORDER + 1];
  double lpc_tmp[BK_TALKBOX_MAX_ORDER + 1];
  double k_target[BK_TALKBOX_MAX_ORDER], k_now[BK_TALKBOX_MAX_ORDER];
  double b[BK_TALKBOX_MAX_ORDER + 1];
  int active_order;
  double gain_target;
  /* carrier */
  bk_oscillator osc1, osc2, osc_sub;
  unsigned int noise_state; /* the JS int32 bits */
  bk_pitch_tracker tracker;
  double tracked_hz;
  bk_smoother pitch_sm;
  /* input analysis / output shaping */
  bk_env_follower in_env;
  bk_smoother gate_sm, gain_sm, out_sm, breath_sm;
  bk_biquad breath_hp, tilt_low, tilt_high;
  bk_dc_blocker dc;
  double de_z;
  bk_oversampler4x os;
  float *mono;
  double drive_gain;
  double meter;
} bk_talkbox;

size_t bk_talkbox_storage_floats(double sample_rate, int max_block);
void bk_talkbox_init(bk_talkbox *e, double sample_rate, int max_block, float *storage);
void bk_talkbox_set_param(bk_talkbox *e, int key, double value);
void bk_talkbox_set_carrier_bus(bk_talkbox *e, const float *l, const float *r);
void bk_talkbox_reset(bk_talkbox *e);
void bk_talkbox_process(bk_talkbox *e, float *l, float *r, int frames);
extern const bk_effect_vt bk_talkbox_vt;

#ifdef __cplusplus
}
#endif
#endif
