/*
 * Bro.Kodr DSP core — delay lines and oversampling.
 * C port of dsp/core/delay-line.js. See biquad.h for the porting rules.
 *
 * One thing here is easy to get wrong and worth calling out. The JS delay
 * buffer is a Float32Array, so every write rounds to float32 and every read
 * promotes back to double before the interpolation. The C must do the same:
 * `float buf[]`, double interpolation. A `double` buffer would be *more*
 * accurate and would therefore diverge from the web build — which, under route
 * (c), is a bug, not an improvement.
 *
 * Sizing is the other difference. The JS allocates per instance; C cannot
 * allocate on the audio thread, so a delay line is given its storage by the
 * caller and the struct only holds the bookkeeping. Callers put that storage in
 * the preallocated arena.
 */

#ifndef BROKODR_DSP_DELAY_LINE_H
#define BROKODR_DSP_DELAY_LINE_H

#include <stddef.h>

#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --- DelayLine ---------------------------------------------------------- */

/* Fractional delay line with linear or cubic (Hermite) interpolation. Cubic is
   for modulated delays (chorus/flanger), where linear interpolation loses high
   frequencies in a way that pumps with the LFO. */
typedef struct {
  float *buf;  /* caller-owned, at least bk_delay_line_size(max_samples) long */
  int size;
  int w;
} bk_delay_line;

/* The size the JS constructor would have allocated:
   max(4, ceil(maxSamples) + 4). Ask for this many floats. */
int bk_delay_line_size(double max_samples);

void bk_delay_line_init(bk_delay_line *d, float *storage, double max_samples);
void bk_delay_line_clear(bk_delay_line *d);
void bk_delay_line_write(bk_delay_line *d, double x);
/* Linear-interpolated read, delay in samples. */
double bk_delay_line_read(const bk_delay_line *d, double delay_samples);
/* 4-point Hermite read — clean under heavy modulation. */
double bk_delay_line_read_cubic(const bk_delay_line *d, double delay_samples);

/* --- Allpass ------------------------------------------------------------ */

/* Simple all-pass diffuser used inside the reverb topology. */
typedef struct {
  bk_delay_line line;
  double delay;
  double g;
} bk_allpass;

void bk_allpass_init(bk_allpass *a, float *storage, double max_samples);
double bk_allpass_process(bk_allpass *a, double x);
void bk_allpass_clear(bk_allpass *a);

/* --- Oversampler4x ------------------------------------------------------ */

/* Minimal 2nd-order lowpass, standalone so the oversampler has no external
   deps — mirrors makeLP() in the JS, which is module-private there and exposed
   here only because the parity battery has to drive it directly. */
typedef struct {
  double b0, b1, b2, a1, a2;
  double z1, z2;
} bk_lp2;

void bk_lp2_init(bk_lp2 *f, double sr, double cutoff);
double bk_lp2_process(bk_lp2 *f, double x);
void bk_lp2_reset(bk_lp2 *f);

/* A nonlinearity applied at 4x rate. The JS passes a closure; C passes a
   function pointer plus an opaque argument, which is the same thing without a
   heap. */
typedef double (*bk_shaper_fn)(double x, void *user);

/*
 * 4x oversampler for nonlinear stages.
 *
 * Zero-stuffed upsample -> 3-stage cascaded Butterworth lowpass at the original
 * Nyquist -> nonlinearity at 4x -> same filter -> decimate. This is what keeps
 * hard clipping and fold-back distortion from spraying aliases back down into
 * the audible band, which is the single biggest audible difference between a
 * cheap waveshaper and a professional one.
 */
typedef struct {
  int factor;
  double sr;
  double osr;
  float *up;  /* caller-owned, at least block_size * 4 long */
  int up_len;
  bk_lp2 up_filters[3];
  bk_lp2 down_filters[3];
} bk_oversampler4x;

void bk_oversampler4x_init(bk_oversampler4x *o, float *storage, double sample_rate, int block_size);
/* `output` may alias `input`, as in the JS. */
void bk_oversampler4x_process(bk_oversampler4x *o, const float *input, size_t frames,
                              bk_shaper_fn shaper, void *user, float *output);
void bk_oversampler4x_reset(bk_oversampler4x *o);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_DELAY_LINE_H */
