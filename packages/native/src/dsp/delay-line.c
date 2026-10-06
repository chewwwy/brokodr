/*
 * Bro.Kodr DSP core — delay lines and oversampling.
 * C port of dsp/core/delay-line.js. See delay-line.h for the porting rules.
 * Kept line-for-line comparable with the JS so a reviewer can diff them by eye.
 */

#include "brokodr/dsp/delay-line.h"

#include <math.h>

/* --- DelayLine ---------------------------------------------------------- */

int bk_delay_line_size(double max_samples) {
  return (int)bk_max(4.0, ceil(max_samples) + 4.0);
}

void bk_delay_line_init(bk_delay_line *d, float *storage, double max_samples) {
  d->buf = storage;
  d->size = bk_delay_line_size(max_samples);
  d->w = 0;
  bk_delay_line_clear(d);
}

void bk_delay_line_clear(bk_delay_line *d) {
  int i;
  for (i = 0; i < d->size; i++) d->buf[i] = 0.0f;
  d->w = 0;
}

void bk_delay_line_write(bk_delay_line *d, double x) {
  d->buf[d->w] = (float)bk_sanitize(x);
  d->w = (d->w + 1) % d->size;
}

double bk_delay_line_read(const bk_delay_line *d, double delay_samples) {
  const int s = d->size;
  const double dl = bk_clamp(delay_samples, 0.0, (double)(s - 3));
  const double r = (double)d->w - 1.0 - dl;
  /* JS indexes NaN as an absent property and returns NaN. Never cast it
     to int: that is undefined, and cubic's i1-1 can also overflow. */
  if (!isfinite(r)) return NAN;
  const int i0 = (int)floor(r);
  const double frac = r - (double)i0;
  /* C's % truncates toward zero exactly as JS's does, so the double-modulo
     idiom from the JS transfers unchanged. */
  const double a = (double)d->buf[((i0 % s) + s) % s];
  const double b = (double)d->buf[(((i0 + 1) % s) + s) % s];
  return a + (b - a) * frac;
}

double bk_delay_line_read_cubic(const bk_delay_line *d, double delay_samples) {
  const int s = d->size;
  const double dl = bk_clamp(delay_samples, 1.0, (double)(s - 4));
  const double r = (double)d->w - 1.0 - dl;
  if (!isfinite(r)) return NAN;
  const int i1 = (int)floor(r);
  const double frac = r - (double)i1;
  const double x0 = (double)d->buf[(((i1 - 1) % s) + s) % s];
  const double x1 = (double)d->buf[((i1 % s) + s) % s];
  const double x2 = (double)d->buf[(((i1 + 1) % s) + s) % s];
  const double x3 = (double)d->buf[(((i1 + 2) % s) + s) % s];
  const double c0 = x1;
  const double c1 = 0.5 * (x2 - x0);
  const double c2 = x0 - 2.5 * x1 + 2.0 * x2 - 0.5 * x3;
  const double c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
  return ((c3 * frac + c2) * frac + c1) * frac + c0;
}

/* --- Allpass ------------------------------------------------------------ */

void bk_allpass_init(bk_allpass *a, float *storage, double max_samples) {
  bk_delay_line_init(&a->line, storage, max_samples);
  a->delay = max_samples * 0.5;
  a->g = 0.5;
}

double bk_allpass_process(bk_allpass *a, double x) {
  const double d = bk_delay_line_read(&a->line, a->delay);
  const double v = x + -a->g * d;
  bk_delay_line_write(&a->line, v);
  return d + a->g * v;
}

void bk_allpass_clear(bk_allpass *a) {
  bk_delay_line_clear(&a->line);
}

/* --- Oversampler4x ------------------------------------------------------ */

void bk_lp2_init(bk_lp2 *f, double sr, double cutoff) {
  const double w0 = (2.0 * BK_PI * bk_min(cutoff, sr * 0.49)) / sr;
  const double cw = cos(w0);
  const double sw = sin(w0);
  const double alpha = sw / (2.0 * 0.7071);
  const double b0 = (1.0 - cw) * 0.5;
  const double b1 = 1.0 - cw;
  const double b2 = (1.0 - cw) * 0.5;
  const double a0 = 1.0 + alpha;
  const double a1 = -2.0 * cw;
  const double a2 = 1.0 - alpha;
  const double inv = 1.0 / a0;
  f->b0 = b0 * inv;
  f->b1 = b1 * inv;
  f->b2 = b2 * inv;
  f->a1 = a1 * inv;
  f->a2 = a2 * inv;
  f->z1 = 0.0;
  f->z2 = 0.0;
}

double bk_lp2_process(bk_lp2 *f, double x) {
  const double y = f->b0 * x + f->z1;
  f->z1 = bk_sanitize(f->b1 * x - f->a1 * y + f->z2);
  f->z2 = bk_sanitize(f->b2 * x - f->a2 * y);
  return y;
}

void bk_lp2_reset(bk_lp2 *f) {
  f->z1 = 0.0;
  f->z2 = 0.0;
}

void bk_oversampler4x_init(bk_oversampler4x *o, float *storage, double sample_rate, int block_size) {
  int i;
  o->factor = 4;
  o->sr = sample_rate;
  o->osr = sample_rate * 4.0;
  o->up = storage;
  o->up_len = block_size * 4;
  for (i = 0; i < o->up_len; i++) o->up[i] = 0.0f;
  /* Butterworth cascade coefficients computed for cutoff = 0.5 * original
     nyquist ratio — i.e. 0.47 * sr, evaluated at the oversampled rate. */
  for (i = 0; i < 3; i++) {
    bk_lp2_init(&o->up_filters[i], o->osr, sample_rate * 0.47);
    bk_lp2_init(&o->down_filters[i], o->osr, sample_rate * 0.47);
  }
}

void bk_oversampler4x_process(bk_oversampler4x *o, const float *input, size_t frames,
                              bk_shaper_fn shaper, void *user, float *output) {
  float *up = o->up;
  bk_lp2 *uf = o->up_filters;
  bk_lp2 *df = o->down_filters;
  size_t i;
  size_t k = 0;
  size_t n;

  for (i = 0; i < frames; i++) {
    /* zero-stuff with gain compensation for the 4x insertion */
    up[k++] = (float)((double)input[i] * 4.0);
    up[k++] = 0.0f;
    up[k++] = 0.0f;
    up[k++] = 0.0f;
  }
  n = frames * 4;
  for (i = 0; i < n; i++) {
    /* v is double through the whole chain and rounds to float32 only on the
       store back into `up`, exactly as the JS Float32Array does. */
    double v = (double)up[i];
    v = bk_lp2_process(&uf[0], v);
    v = bk_lp2_process(&uf[1], v);
    v = bk_lp2_process(&uf[2], v);
    v = shaper(v, user);
    v = bk_lp2_process(&df[0], v);
    v = bk_lp2_process(&df[1], v);
    v = bk_lp2_process(&df[2], v);
    up[i] = (float)v;
  }
  for (i = 0; i < frames; i++) output[i] = up[i * 4];
}

void bk_oversampler4x_reset(bk_oversampler4x *o) {
  int i;
  for (i = 0; i < 3; i++) {
    bk_lp2_reset(&o->up_filters[i]);
    bk_lp2_reset(&o->down_filters[i]);
  }
}
