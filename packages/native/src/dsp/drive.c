/*
 * Bro.Kodr DSP — drive stages. C port of dsp/effects/drive.js; see drive.h
 * for what is reproduced on purpose and where the C deliberately diverges.
 */

#include "brokodr/dsp/drive.h"

#include <math.h>

/* Math.round over the whole line: the exact fraction decides (floor(x + 0.5)
   is wrong at 0.49999999999999994), and [-0.5, 0) gives -0, which the
   exact-fraction form alone would make +0. NaN stays NaN, -0 stays -0. */
static double js_round(double x) {
  const double r = floor(x);
  const double y = (x - r >= 0.5) ? r + 1.0 : r;
  return (y == 0.0 && x < 0.0) ? -0.0 : y;
}

/* --- transfer curves ------------------------------------------------------ */

static double fold(double x) {
  const double t = 0.8;
  double y = x;
  if (fabs(y) <= BK_DRIVE_FOLD_LIMIT) {
    while (fabs(y) > t) y = y > 0 ? 2.0 * t - y : -2.0 * t - y;
  } else {
    /* Closed form of the same triangle (period 4t); see drive.h. */
    double p = fmod(y + t, 4.0 * t);
    if (p < 0.0) p += 4.0 * t;
    y = p < 2.0 * t ? p - t : 3.0 * t - p;
  }
  return y * 1.15;
}

double bk_drive_shape(int curve, double x) {
  switch (curve) {
    case 0: { /* soft tube */
      const double a = x >= 0 ? 1.2 : 0.85;
      return tanh(x * a) * 0.92;
    }
    case 1: /* hard clip */
      return bk_clamp(x, -0.85, 0.85) * 1.12;
    case 2: /* foldback */
      return fold(x);
    case 3: { /* diode / fuzz */
      const double y = x >= 0 ? 1.0 - exp(-x * 2.2) : -(1.0 - exp(x * 1.1)) * 0.7;
      return y * 1.1;
    }
    case 4: /* sine fold */
      return sin(bk_clamp(x, -3.0, 3.0) * 1.9) * 0.85;
    default: { /* 5: rectify + clip */
      const double r = fabs(x) * 1.4 - 0.4;
      return bk_clamp(x >= 0 ? r : -r * 0.8, -0.9, 0.9) * 1.1;
    }
  }
}

static double shaper(double x, void *user) {
  const bk_drive *d = (const bk_drive *)user;
  return bk_drive_shape(d->curve, x * d->drive_val + d->bias_val);
}

/* --- Distortion / Saturation --------------------------------------------- */

void bk_drive_init(bk_drive *d, double sample_rate, int max_block, int default_curve, float *scratch) {
  const int mb = max_block < 1 ? 1 : max_block;
  d->sr = sample_rate;
  d->max_block = mb;
  bk_smoother_init(&d->drive, sample_rate, 25.0, 1.0);
  bk_smoother_init(&d->out_sm, sample_rate, 25.0, 1.0);
  bk_smoother_init(&d->bias_sm, sample_rate, 25.0, 0.0);
  d->curve = default_curve;
  d->tone_freq = 8000.0;
  d->tone_mode = 0.0;
  d->tmp_l = scratch;
  d->tmp_r = scratch + mb;
  bk_oversampler4x_init(&d->os[0], scratch + 2 * (size_t)mb, sample_rate, mb);
  bk_oversampler4x_init(&d->os[1], scratch + 6 * (size_t)mb, sample_rate, mb);
  bk_dc_blocker_init(&d->dc_l, sample_rate, 20.0);
  bk_dc_blocker_init(&d->dc_r, sample_rate, 20.0);
  bk_biquad_init(&d->tone_l, sample_rate);
  bk_biquad_init(&d->tone_r, sample_rate);
  bk_biquad_init(&d->pre_l, sample_rate);
  bk_biquad_init(&d->pre_r, sample_rate);
  d->pre_freq = 20.0;
  d->oversample = 1;
  {
    int i;
    for (i = 0; i < 2 * mb; i++) scratch[i] = 0.0f;
  }
  d->drive_val = 1.0;
  d->bias_val = 0.0;
  d->meter = 0.0;
}

void bk_dist_init(bk_drive *d, double sample_rate, int max_block, float *scratch) {
  bk_drive_init(d, sample_rate, max_block, 1, scratch);
}

void bk_sat_init(bk_drive *d, double sample_rate, int max_block, float *scratch) {
  bk_drive_init(d, sample_rate, max_block, 0, scratch);
}

void bk_drive_set_param(bk_drive *d, int key, double value) {
  switch (key) {
    case BK_P_DIST_DRIVE:
      bk_smoother_set(&d->drive, bk_db_to_gain(value));
      break;
    case BK_P_DIST_CURVE: {
      const double c = bk_clamp(js_round(value), 0.0, (double)(BK_DRIVE_CURVES - 1));
      if (c == c) d->curve = (int)c; /* NaN: see drive.h */
      break;
    }
    case BK_P_DIST_TONE:
      d->tone_freq = value;
      break;
    case BK_P_DIST_TONEMODE:
      d->tone_mode = js_round(value);
      break;
    case BK_P_DIST_BIAS:
      bk_smoother_set(&d->bias_sm, value);
      break;
    case BK_P_DIST_PREHP:
      d->pre_freq = value;
      break;
    case BK_P_DIST_OUTPUT:
      bk_smoother_set(&d->out_sm, bk_db_to_gain(value));
      break;
    case BK_P_DIST_OVERSAMPLE:
      d->oversample = value >= 0.5 ? 1 : 0;
      break;
    default:
      break;
  }
}

void bk_drive_reset(bk_drive *d) {
  bk_oversampler4x_reset(&d->os[0]);
  bk_oversampler4x_reset(&d->os[1]);
  bk_dc_blocker_reset(&d->dc_l);
  bk_dc_blocker_reset(&d->dc_r);
  bk_biquad_reset(&d->tone_l);
  bk_biquad_reset(&d->tone_r);
  bk_biquad_reset(&d->pre_l);
  bk_biquad_reset(&d->pre_r);
}

/* One JS process() call; frames <= max_block. Returns the block's peak. */
static double drive_block(bk_drive *d, float *l, float *r, int frames) {
  double peak = 0.0;
  int i;
  int type;

  d->drive_val = bk_smoother_next(&d->drive);
  d->bias_val = bk_smoother_next(&d->bias_sm);
  for (i = 1; i < frames; i++) {
    bk_smoother_next(&d->drive);
    bk_smoother_next(&d->bias_sm);
  }
  if (frames < 0) frames = 0;

  bk_biquad_set(&d->pre_l, BK_FILTER_HIGHPASS, d->pre_freq, 0.7071, 0.0);
  bk_biquad_set(&d->pre_r, BK_FILTER_HIGHPASS, d->pre_freq, 0.7071, 0.0);
  for (i = 0; i < frames; i++) {
    d->tmp_l[i] = (float)bk_biquad_process(&d->pre_l, (double)l[i]);
    d->tmp_r[i] = (float)bk_biquad_process(&d->pre_r, (double)r[i]);
  }

  if (d->oversample) {
    bk_oversampler4x_process(&d->os[0], d->tmp_l, (size_t)frames, shaper, d, l);
    bk_oversampler4x_process(&d->os[1], d->tmp_r, (size_t)frames, shaper, d, r);
  } else {
    for (i = 0; i < frames; i++) {
      l[i] = (float)shaper((double)d->tmp_l[i], d);
      r[i] = (float)shaper((double)d->tmp_r[i], d);
    }
  }

  type = d->tone_mode == 1.0 ? BK_FILTER_HIGHPASS : BK_FILTER_LOWPASS;
  bk_biquad_set(&d->tone_l, type, d->tone_freq, 0.7071, 0.0);
  bk_biquad_set(&d->tone_r, type, d->tone_freq, 0.7071, 0.0);

  for (i = 0; i < frames; i++) {
    const double g = bk_smoother_next(&d->out_sm);
    const double ol = bk_biquad_process(&d->tone_l, bk_dc_blocker_process(&d->dc_l, (double)l[i])) * g;
    const double or_ = bk_biquad_process(&d->tone_r, bk_dc_blocker_process(&d->dc_r, (double)r[i])) * g;
    double a;
    l[i] = (float)bk_sanitize(ol);
    r[i] = (float)bk_sanitize(or_);
    a = bk_max(fabs(ol), fabs(or_));
    if (a > peak) peak = a;
  }
  return peak;
}

void bk_drive_process(bk_drive *d, float *l, float *r, int frames) {
  double peak = 0.0;
  do {
    const int n = frames < d->max_block ? frames : d->max_block;
    const double p = drive_block(d, l, r, n);
    if (p > peak) peak = p;
    if (n <= 0) break;
    l += n;
    r += n;
    frames -= n;
  } while (frames > 0);
  d->meter = peak;
}

double bk_drive_meter(const bk_drive *d) { return d->meter; }

static void drive_vt_process(void *self, float *l, float *r, int frames) {
  bk_drive_process((bk_drive *)self, l, r, frames);
}
static void drive_vt_reset(void *self) { bk_drive_reset((bk_drive *)self); }
static void drive_vt_set_param(void *self, int key, double value) {
  bk_drive_set_param((bk_drive *)self, key, value);
}
static double drive_vt_meter(const void *self) { return bk_drive_meter((const bk_drive *)self); }

const bk_effect_vt bk_drive_vt = {drive_vt_process, drive_vt_reset, drive_vt_set_param, NULL, NULL,
                                  drive_vt_meter};

/* --- BitCrusher ------------------------------------------------------------ */

static double crush_internal_random(void *user) {
  return (bk_rng_bipolar((unsigned int *)user) + 1.0) * 0.5;
}

void bk_crush_init(bk_crush *c, double sample_rate) {
  c->sr = sample_rate;
  c->bits = 16.0;
  c->rate_hz = sample_rate;
  c->dither_amt = 0.0;
  bk_smoother_init(&c->drive_sm, sample_rate, 25.0, 1.0);
  bk_smoother_init(&c->out_sm, sample_rate, 25.0, 1.0);
  c->phase = 0.0;
  c->hold_l = 0.0;
  c->hold_r = 0.0;
  c->anti_alias = 0.0;
  bk_biquad_init(&c->lp_l, sample_rate);
  bk_biquad_init(&c->lp_r, sample_rate);
  bk_rng_seed(&c->rng, 0x2545f491u);
  c->random = crush_internal_random;
  c->random_user = &c->rng;
}

void bk_crush_set_random(bk_crush *c, bk_random_fn fn, void *user) {
  if (fn) {
    c->random = fn;
    c->random_user = user;
  } else {
    c->random = crush_internal_random;
    c->random_user = &c->rng;
  }
}

void bk_crush_set_param(bk_crush *c, int key, double value) {
  switch (key) {
    case BK_P_CRUSH_BITS:
      c->bits = bk_clamp(value, 1.0, 24.0);
      break;
    case BK_P_CRUSH_RATE:
      c->rate_hz = bk_clamp(value, 200.0, c->sr);
      break;
    case BK_P_CRUSH_DITHER:
      c->dither_amt = bk_clamp(value, 0.0, 1.0);
      break;
    case BK_P_CRUSH_DRIVE:
      bk_smoother_set(&c->drive_sm, bk_db_to_gain(value));
      break;
    case BK_P_CRUSH_OUTPUT:
      bk_smoother_set(&c->out_sm, bk_db_to_gain(value));
      break;
    case BK_P_CRUSH_SMOOTH:
      c->anti_alias = bk_clamp(value, 0.0, 1.0);
      break;
    default:
      break;
  }
}

void bk_crush_reset(bk_crush *c) {
  c->phase = 0.0;
  c->hold_l = 0.0;
  c->hold_r = 0.0;
  bk_biquad_reset(&c->lp_l);
  bk_biquad_reset(&c->lp_r);
}

void bk_crush_process(bk_crush *c, float *l, float *r, int frames) {
  const double step = c->rate_hz / c->sr;
  const double levels = pow(2.0, c->bits) - 1.0;
  const double inv = 1.0 / levels;
  const double dither_scale = (c->dither_amt * inv) / 2.0;
  int i;

  if (c->anti_alias > 0.001) {
    const double f = 200.0 + (1.0 - c->anti_alias) * (c->sr * 0.45 - 200.0);
    bk_biquad_set(&c->lp_l, BK_FILTER_LOWPASS, bk_min(f, c->rate_hz * 0.5), 0.7071, 0.0);
    bk_biquad_set(&c->lp_r, BK_FILTER_LOWPASS, bk_min(f, c->rate_hz * 0.5), 0.7071, 0.0);
  }

  for (i = 0; i < frames; i++) {
    const double dv = bk_smoother_next(&c->drive_sm);
    const double o = bk_smoother_next(&c->out_sm);
    double ol, or_;
    c->phase += step;
    if (c->phase >= 1.0) {
      double sl, sr;
      c->phase -= floor(c->phase);
      sl = bk_clamp((double)l[i] * dv, -1.0, 1.0);
      sr = bk_clamp((double)r[i] * dv, -1.0, 1.0);
      if (dither_scale > 0.0) {
        /* TPDF: two uniforms per channel, drawn in JS evaluation order. */
        const double a = c->random(c->random_user);
        const double b = c->random(c->random_user);
        double e, f;
        sl += (a + b - 1.0) * dither_scale;
        e = c->random(c->random_user);
        f = c->random(c->random_user);
        sr += (e + f - 1.0) * dither_scale;
      }
      c->hold_l = js_round(sl * levels) * inv;
      c->hold_r = js_round(sr * levels) * inv;
    }
    ol = c->hold_l * o;
    or_ = c->hold_r * o;
    if (c->anti_alias > 0.001) {
      ol = bk_biquad_process(&c->lp_l, ol);
      or_ = bk_biquad_process(&c->lp_r, or_);
    }
    l[i] = (float)bk_sanitize(ol);
    r[i] = (float)bk_sanitize(or_);
  }
}

static void crush_vt_process(void *self, float *l, float *r, int frames) {
  bk_crush_process((bk_crush *)self, l, r, frames);
}
static void crush_vt_reset(void *self) { bk_crush_reset((bk_crush *)self); }
static void crush_vt_set_param(void *self, int key, double value) {
  bk_crush_set_param((bk_crush *)self, key, value);
}

const bk_effect_vt bk_crush_vt = {crush_vt_process, crush_vt_reset, crush_vt_set_param, NULL, NULL, NULL};
