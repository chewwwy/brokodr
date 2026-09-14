/*
 * Bro.Kodr DSP core — FFT, Hann window and cepstral envelope.
 * C port of dsp/core/fft.js. See biquad.h for the porting rules.
 *
 * The one thing to keep in mind while reading this: the JS holds *everything*
 * here in Float32Array — the twiddle tables, the re/im working buffers, the
 * window, the envelope. Only the arithmetic between loads and stores is double.
 * So every butterfly in the JS rounds its two results to float32 before the
 * next stage reads them, and the rounding error of a 2048-point transform is
 * baked into the output the web build produces today.
 *
 * That means the C cannot use double buffers. It would be measurably more
 * accurate and it would diverge from the web build on every single bin, which
 * under route (c) is a bug and not an improvement. `float` storage, `double`
 * butterflies, in exactly the same order as the JS.
 *
 * Storage is caller-owned, as everywhere else in this core: an FFT of size N
 * needs two float tables of N/2 (cos/sin) and a uint32 table of N, and a
 * cepstral envelope needs two float working buffers of N plus an output buffer
 * of N/2+1. Sizes come from the bk_fft_*_len helpers so the caller never has to
 * rederive them.
 */

#ifndef BROKODR_DSP_FFT_H
#define BROKODR_DSP_FFT_H

#include <stddef.h>

#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --- FFT ---------------------------------------------------------------- */

/* Iterative in-place radix-2 FFT with precomputed twiddles and a bit-reversal
   table. All the setup work happens in init; transform() touches no memory it
   was not handed, so it is safe on the audio thread. */
typedef struct {
  int size;
  int half;
  int levels;
  float *cos_t;         /* bk_fft_table_len(size) entries */
  float *sin_t;         /* bk_fft_table_len(size) entries */
  unsigned int *rev;    /* bk_fft_rev_len(size) entries */
} bk_fft;

/* Lengths of the three caller-owned tables, in elements. */
int bk_fft_table_len(int size);
int bk_fft_rev_len(int size);

/*
 * Returns 0 on success, -1 if `size` is rejected.
 *
 * The JS throws on a non-power-of-two size and this returns -1 for the same
 * inputs, with one deliberate quirk carried over: `size == 0` passes the JS
 * power-of-two test (0 & -1 == 0) and yields an FFT whose transform is a no-op.
 * Rather than "fix" that here and have the two engines disagree about what
 * FFT(0) means, C accepts it too. Negative sizes are rejected, which the JS
 * does not do explicitly — it just produces nonsense — and no caller passes.
 */
int bk_fft_init(bk_fft *f, int size, float *cos_storage, float *sin_storage,
                unsigned int *rev_storage);

/* In-place complex FFT over re[size] / im[size].
   inverse != 0 computes the UNNORMALISED inverse; the caller scales by 1/size,
   same contract as the JS. */
void bk_fft_transform(const bk_fft *f, float *re, float *im, int inverse);

/* --- Hann window -------------------------------------------------------- */

/* Periodic (not symmetric) Hann — this is the one that gives correct COLA
   behaviour for overlap-add at hop = N/4, which is what the pitch shifter runs.
   Writes `size` floats into w. */
void bk_hann_window(float *w, int size);

/* --- CepstralEnvelope --------------------------------------------------- */

/*
 * Cepstral spectral-envelope estimator.
 *
 * Envelope = IFFT of the log-magnitude spectrum, truncated to `lifter`
 * coefficients (low-time liftering), then exponentiated. Splitting the envelope
 * (formants, timbre) from the fine structure (pitch harmonics) is the whole
 * reason formant shifting can be independent of pitch shifting: divide the
 * envelope out, warp it, multiply it back.
 */
typedef struct {
  bk_fft fft;
  int n;
  float *re;   /* n entries */
  float *im;   /* n entries */
  float *env;  /* bk_cepstral_env_len(n) entries */
} bk_cepstral_envelope;

/* Length of the envelope output buffer, in elements: (n >> 1) + 1. */
int bk_cepstral_env_len(int fft_size);

/* Returns 0 on success, -1 if fft_size is rejected (see bk_fft_init). */
int bk_cepstral_envelope_init(bk_cepstral_envelope *c, int fft_size,
                              float *cos_storage, float *sin_storage,
                              unsigned int *rev_storage, float *re_storage,
                              float *im_storage, float *env_storage);

/*
 * `mag` is the magnitude spectrum, bk_cepstral_env_len(n) entries.
 * `lifter` is how many cepstral coefficients to keep — higher follows the
 * harmonics more closely. Returns c->env (linear magnitude).
 *
 * `lifter` is a double rather than an int on purpose. The JS clamps it with
 * Math.max/Math.min and then uses it as an array index, so a fractional lifter
 * produces fractional indices, every write silently misses the Float32Array,
 * and the liftering step does nothing at all. NaN does the same by failing the
 * loop condition outright. Both are reproduced here; see the comment in the
 * implementation.
 */
const float *bk_cepstral_envelope_compute(bk_cepstral_envelope *c, const float *mag,
                                          double lifter);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_FFT_H */
