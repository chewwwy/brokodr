/*
 * Bro.Kodr DSP core — biquad filters. C port of dsp/core/biquad.js.
 * See biquad.h for the porting rules. Kept line-for-line comparable with the
 * JS so a reviewer can diff them by eye.
 */

#include "brokodr/dsp/biquad.h"

#include <math.h>

/* MSVC does not define M_PI without _USE_MATH_DEFINES; emcc and gcc do. Define it
   unconditionally to the same literal so every toolchain uses identical bits. */
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* bk_sanitize and bk_clamp used to be defined here. They now live in
   src/dsp/utils.c, the port of dsp/core/utils.js where the JS originals live,
   and reach this file through biquad.h -> utils.h. */

/* --- Biquad ------------------------------------------------------------- */

void bk_biquad_init(bk_biquad *f, double sample_rate) {
  f->sr = sample_rate;
  f->b0 = 1.0;
  f->b1 = 0.0;
  f->b2 = 0.0;
  f->a1 = 0.0;
  f->a2 = 0.0;
  f->z1 = 0.0;
  f->z2 = 0.0;
  f->type = -1;
  f->freq = -1.0;
  f->q = -1.0;
  f->gain_db = -1.0;
}

void bk_biquad_reset(bk_biquad *f) {
  f->z1 = 0.0;
  f->z2 = 0.0;
}

static void bk_biquad_compute(bk_biquad *f, int type, double freq, double q, double gain_db) {
  const double nyq = f->sr * 0.5;
  const double fc = bk_clamp(freq, 10.0, nyq * 0.995);
  double b0, b1, b2, a0, a1, a2, inv;
  double w0, cw, sw, alpha, A;

  /* Math.max(q, 0.02). Written as a guard rather than bk_max on purpose:
     a NaN q fails `q < 0.02` and passes through unchanged, which is exactly
     what Math.max does with NaN. Verified by the NaN cases in the battery. */
  if (q < 0.02) q = 0.02;

  w0 = (2.0 * M_PI * fc) / f->sr;
  cw = cos(w0);
  sw = sin(w0);
  alpha = sw / (2.0 * q);
  A = pow(10.0, gain_db / 40.0);

  switch (type) {
    case BK_FILTER_LOWPASS:
      b0 = (1.0 - cw) * 0.5;
      b1 = 1.0 - cw;
      b2 = (1.0 - cw) * 0.5;
      a0 = 1.0 + alpha;
      a1 = -2.0 * cw;
      a2 = 1.0 - alpha;
      break;
    case BK_FILTER_HIGHPASS:
      b0 = (1.0 + cw) * 0.5;
      b1 = -(1.0 + cw);
      b2 = (1.0 + cw) * 0.5;
      a0 = 1.0 + alpha;
      a1 = -2.0 * cw;
      a2 = 1.0 - alpha;
      break;
    case BK_FILTER_BANDPASS:
      b0 = alpha;
      b1 = 0.0;
      b2 = -alpha;
      a0 = 1.0 + alpha;
      a1 = -2.0 * cw;
      a2 = 1.0 - alpha;
      break;
    case BK_FILTER_NOTCH:
      b0 = 1.0;
      b1 = -2.0 * cw;
      b2 = 1.0;
      a0 = 1.0 + alpha;
      a1 = -2.0 * cw;
      a2 = 1.0 - alpha;
      break;
    case BK_FILTER_PEAK:
      b0 = 1.0 + alpha * A;
      b1 = -2.0 * cw;
      b2 = 1.0 - alpha * A;
      a0 = 1.0 + alpha / A;
      a1 = -2.0 * cw;
      a2 = 1.0 - alpha / A;
      break;
    case BK_FILTER_LOWSHELF: {
      const double s = 2.0 * sqrt(A) * alpha;
      b0 = A * (A + 1.0 - (A - 1.0) * cw + s);
      b1 = 2.0 * A * (A - 1.0 - (A + 1.0) * cw);
      b2 = A * (A + 1.0 - (A - 1.0) * cw - s);
      a0 = A + 1.0 + (A - 1.0) * cw + s;
      a1 = -2.0 * (A - 1.0 + (A + 1.0) * cw);
      a2 = A + 1.0 + (A - 1.0) * cw - s;
      break;
    }
    case BK_FILTER_HIGHSHELF: {
      const double s = 2.0 * sqrt(A) * alpha;
      b0 = A * (A + 1.0 + (A - 1.0) * cw + s);
      b1 = -2.0 * A * (A - 1.0 + (A + 1.0) * cw);
      b2 = A * (A + 1.0 + (A - 1.0) * cw - s);
      a0 = A + 1.0 - (A - 1.0) * cw + s;
      a1 = 2.0 * (A - 1.0 - (A + 1.0) * cw);
      a2 = A + 1.0 - (A - 1.0) * cw - s;
      break;
    }
    case BK_FILTER_ALLPASS:
      b0 = 1.0 - alpha;
      b1 = -2.0 * cw;
      b2 = 1.0 + alpha;
      a0 = 1.0 + alpha;
      a1 = -2.0 * cw;
      a2 = 1.0 - alpha;
      break;
    default:
      b0 = 1.0;
      b1 = 0.0;
      b2 = 0.0;
      a0 = 1.0;
      a1 = 0.0;
      a2 = 0.0;
      break;
  }

  inv = 1.0 / a0;
  f->b0 = b0 * inv;
  f->b1 = b1 * inv;
  f->b2 = b2 * inv;
  f->a1 = a1 * inv;
  f->a2 = a2 * inv;
}

void bk_biquad_set(bk_biquad *f, int type, double freq, double q, double gain_db) {
  /* Compared before clamping, exactly as the JS does, so the idempotence
     boundary lands in the same place. */
  if (type == f->type && freq == f->freq && q == f->q && gain_db == f->gain_db) return;
  f->type = type;
  f->freq = freq;
  f->q = q;
  f->gain_db = gain_db;
  bk_biquad_compute(f, type, freq, q, gain_db);
}

double bk_biquad_process(bk_biquad *f, double x) {
  const double y = f->b0 * x + f->z1;
  f->z1 = bk_sanitize(f->b1 * x - f->a1 * y + f->z2);
  f->z2 = bk_sanitize(f->b2 * x - f->a2 * y);
  return y;
}

void bk_biquad_process_block(bk_biquad *f, float *buf, size_t n) {
  size_t i;
  for (i = 0; i < n; i++) buf[i] = (float)bk_biquad_process(f, (double)buf[i]);
}

double bk_biquad_magnitude_db(const bk_biquad *f, double freq) {
  const double w = (2.0 * M_PI * freq) / f->sr;
  const double cw = cos(w);
  const double c2w = cos(2.0 * w);
  const double sw = sin(w);
  const double s2w = sin(2.0 * w);
  const double nr = f->b0 + f->b1 * cw + f->b2 * c2w;
  const double ni = -(f->b1 * sw + f->b2 * s2w);
  const double dr = 1.0 + f->a1 * cw + f->a2 * c2w;
  const double di = -(f->a1 * sw + f->a2 * s2w);
  const double num = sqrt(nr * nr + ni * ni);
  const double den = sqrt(dr * dr + di * di) + 1e-20;
  return 20.0 * log10(num / den + 1e-20);
}

/* --- Cascade ------------------------------------------------------------ */

void bk_biquad_cascade_init(bk_biquad_cascade *c, double sample_rate, int stages) {
  int i;
  if (stages < 0) stages = 0;
  if (stages > BK_BIQUAD_MAX_STAGES) stages = BK_BIQUAD_MAX_STAGES;
  c->count = stages;
  c->active = -1;
  for (i = 0; i < stages; i++) bk_biquad_init(&c->stages[i], sample_rate);
}

void bk_biquad_cascade_set(bk_biquad_cascade *c, int type, double freq, double q, double gain_db) {
  const int n = c->count;
  int i;
  for (i = 0; i < n; i++) {
    /* Butterworth Q staggering for an N-stage cascade. */
    const double qk = (n == 1) ? q : q / (2.0 * cos((M_PI * (2.0 * i + 1.0)) / (4.0 * n)));
    bk_biquad_set(&c->stages[i], type, freq, qk, gain_db / n);
  }
}

void bk_biquad_cascade_set_active(bk_biquad_cascade *c, int n) {
  c->active = n < c->count ? n : c->count;
}

static int bk_cascade_active(const bk_biquad_cascade *c) {
  return c->active < 0 ? c->count : c->active;
}

double bk_biquad_cascade_process(bk_biquad_cascade *c, double x) {
  const int n = bk_cascade_active(c);
  int i;
  for (i = 0; i < n; i++) x = bk_biquad_process(&c->stages[i], x);
  return x;
}

void bk_biquad_cascade_process_block(bk_biquad_cascade *c, float *buf, size_t n) {
  size_t i;
  for (i = 0; i < n; i++) buf[i] = (float)bk_biquad_cascade_process(c, (double)buf[i]);
}

void bk_biquad_cascade_reset(bk_biquad_cascade *c) {
  int i;
  for (i = 0; i < c->count; i++) bk_biquad_reset(&c->stages[i]);
}

double bk_biquad_cascade_magnitude_db(const bk_biquad_cascade *c, double freq) {
  const int n = bk_cascade_active(c);
  double db = 0.0;
  int i;
  for (i = 0; i < n; i++) db += bk_biquad_magnitude_db(&c->stages[i], freq);
  return db;
}

/* --- State-variable filter --------------------------------------------- */

void bk_svf_init(bk_svf *s, double sample_rate) {
  s->sr = sample_rate;
  s->ic1 = 0.0;
  s->ic2 = 0.0;
  s->g = 0.0;
  s->k = 1.0;
  s->a1 = 0.0;
  s->a2 = 0.0;
  s->a3 = 0.0;
}

void bk_svf_set(bk_svf *s, double freq, double q) {
  const double f = bk_clamp(freq, 10.0, s->sr * 0.49);
  s->g = tan((M_PI * f) / s->sr);
  /* bk_max, not a ternary: Math.max(NaN, 0.05) is NaN in JS, but
     (q > 0.05 ? q : 0.05) silently yields 0.05 for a NaN q. */
  s->k = 1.0 / bk_max(q, 0.05);
  s->a1 = 1.0 / (1.0 + s->g * (s->g + s->k));
  s->a2 = s->g * s->a1;
  s->a3 = s->g * s->a2;
}

double bk_svf_process(bk_svf *s, double x, int mode) {
  const double v3 = x - s->ic2;
  const double v1 = s->a1 * s->ic1 + s->a2 * v3;
  const double v2 = s->ic2 + s->a2 * s->ic1 + s->a3 * v3;
  s->ic1 = bk_sanitize(2.0 * v1 - s->ic1);
  s->ic2 = bk_sanitize(2.0 * v2 - s->ic2);
  if (mode == BK_SVF_LOWPASS) return v2;
  if (mode == BK_SVF_BANDPASS) return v1;
  return x - s->k * v1 - v2;
}

void bk_svf_process_block(bk_svf *s, float *buf, size_t n, int mode) {
  size_t i;
  for (i = 0; i < n; i++) buf[i] = (float)bk_svf_process(s, (double)buf[i], mode);
}

void bk_svf_reset(bk_svf *s) {
  s->ic1 = 0.0;
  s->ic2 = 0.0;
}
