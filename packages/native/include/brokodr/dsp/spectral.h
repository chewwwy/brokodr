/* Bro.Kodr — C99 port of effects/spectral.js (PitchFormant, effect 18 of 22).
 * See biquad.h for the porting rules: double arithmetic and scalar state,
 * float wherever the JS holds a Float32Array, no allocation.
 *
 * Storage: the effect is one fixed-size struct sized for the largest STFT
 * (4096), so quality changes need no allocation. The struct holds pointers into
 * itself (FFT tables, cepstral buffers): init it in place and never copy it.
 * About 0.5 MB; give it static or heap storage, not the audio thread's stack.
 *
 * JS behaviour reproduced on purpose:
 *  - smoothers and the jitter/shimmer random walk step once per block even for
 *    frames <= 0; reset clears only the two STFT channels;
 *  - the phase-vocoder `| 0` truncations are ToInt32, and a remapped bin index
 *    that wraps negative is a Float32Array write that silently misses;
 *  - lifter is a double: NaN or fractional values reach the cepstral envelope
 *    exactly as the JS hands them over (see fft.h);
 *  - quality NaN selects `sizes[NaN]`, i.e. an undefined FFT size. The JS then
 *    builds zero-length buffers, every sample returns sanitize(undefined) = 0,
 *    the meter reads NaN and the chain sees no latency. That state is kept
 *    (`degenerate`) until a finite quality selects a real size again;
 *  - a quality that selects the current size does not reinitialise;
 *  - aliased l == r runs the right channel on the left channel's output.
 * The jitter/shimmer xorshift32 is the JS's own seeded generator, so it is
 * deterministic and asserted, unlike Math.random elsewhere.
 */
#ifndef BROKODR_DSP_SPECTRAL_H
#define BROKODR_DSP_SPECTRAL_H
#include "brokodr/dsp/chain.h"
#include "brokodr/dsp/fft.h"
#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"
#ifdef __cplusplus
extern "C" {
#endif

#define BK_PV_MAX_FFT 4096
#define BK_PV_MAX_BINS (BK_PV_MAX_FFT / 2 + 1)

/* One mono phase-vocoder channel (the JS VocoderChannel). */
typedef struct {
  double sr;
  int n, half, hop; /* all 0 while degenerate */
  double freq_per_bin, expct;
  int rw;
  bk_fft fft;
  bk_cepstral_envelope cep;
  float cos_t[BK_PV_MAX_FFT / 2], sin_t[BK_PV_MAX_FFT / 2];
  unsigned int rev[BK_PV_MAX_FFT];
  float window[BK_PV_MAX_FFT];
  /* The JS cepstral envelope owns a second FFT with identical tables; it
     shares this channel's tables, which init writes with the same values. */
  float cep_re[BK_PV_MAX_FFT], cep_im[BK_PV_MAX_FFT], cep_env[BK_PV_MAX_BINS];
  float in_fifo[BK_PV_MAX_FFT], out_fifo[BK_PV_MAX_FFT];
  float out_accum[2 * BK_PV_MAX_FFT];
  float re[BK_PV_MAX_FFT], im[BK_PV_MAX_FFT];
  float last_phase[BK_PV_MAX_BINS], sum_phase[BK_PV_MAX_BINS];
  float ana_magn[BK_PV_MAX_BINS], ana_freq[BK_PV_MAX_BINS];
  float syn_magn[BK_PV_MAX_BINS], syn_freq[BK_PV_MAX_BINS];
  float excite[BK_PV_MAX_BINS], env_shift[BK_PV_MAX_BINS];
} bk_pv_channel;

typedef struct {
  double sr;
  int fft_size;   /* 512..4096; meaningless while degenerate */
  int degenerate; /* quality NaN: JS fftSize === undefined */
  double pitch_st, fine_cents, formant_st;
  int preserve;
  double lifter;
  bk_smoother pitch_sm, formant_sm;
  double jitter, shimmer;
  unsigned int rng; /* JS int32, same bits */
  double jit_walk, shim_walk;
  bk_smoother jit_sm, shim_sm;
  double meter;
  bk_pv_channel ch[2];
} bk_pitch_formant;

void bk_pitch_formant_init(bk_pitch_formant *e, double sample_rate);
void bk_pitch_formant_set_param(bk_pitch_formant *e, int key, double value);
void bk_pitch_formant_reset(bk_pitch_formant *e);
void bk_pitch_formant_process(bk_pitch_formant *e, float *l, float *r, int frames);
/* JS latencySamples as the chain reads it: 0 while degenerate. */
int bk_pitch_formant_latency(const bk_pitch_formant *e);
extern const bk_effect_vt bk_pitch_formant_vt;

#ifdef __cplusplus
}
#endif
#endif
