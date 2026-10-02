/*
 * Bro.Kodr DSP effect — 6-band parametric EQ. C port of dsp/effects/eq.js.
 * See eq.h for the topology and the quirks this file reproduces on purpose.
 */

#include "brokodr/dsp/eq.h"

#include <math.h>

/* Math.round: floor(x + 0.5) is wrong at 0.49999999999999994, where the
   addition itself rounds. x - floor(x) is exact, so comparing the fraction is
   exact too. NaN stays NaN, -0 stays -0. Same helper as file-player.c. */
static double js_round(double x) {
  const double r = floor(x);
  return (x - r >= 0.5) ? r + 1.0 : r;
}

/* 1 + Math.round(clamp(slope, 0, 3)), then what the cascade does with it.
   NaN gives NaN in the JS, and a NaN active count runs no stages. */
static int slope_stages(double slope) {
  const double n = 1.0 + js_round(bk_clamp(slope, 0.0, 3.0));
  return n == n ? (int)n : 0;
}

/* The defaults of `this.p`, in BK_P_EQ_* order. */
static const double k_defaults[BK_P_EQ_COUNT] = {
    20.0,   /* hpFreq */
    0.0,    /* hpSlope */
    120.0,  /* lsFreq */
    0.0,    /* lsGain */
    300.0,  /* b1Freq */
    0.0,    /* b1Gain */
    0.9,    /* b1Q */
    1200.0, /* b2Freq */
    0.0,    /* b2Gain */
    0.9,    /* b2Q */
    4500.0, /* b3Freq */
    0.0,    /* b3Gain */
    0.9,    /* b3Q */
    8000.0, /* hsFreq */
    0.0,    /* hsGain */
    20000.0, /* lpFreq */
    0.0,    /* lpSlope */
    0.0,    /* output */
};

void bk_eq_init(bk_eq *e, double sample_rate, int max_block) {
  int k, c;
  int mb = max_block == 0 ? 128 : max_block;
  if (mb < 1) mb = 1;

  e->sr = sample_rate;
  e->max_block = max_block;
  e->control_rate = sample_rate / (double)mb;

  for (k = 0; k < BK_P_EQ_COUNT; k++) {
    e->p[k] = k_defaults[k];
    bk_smoother_init(&e->sm[k], e->control_rate, 30.0, e->p[k]);
  }
  bk_smoother_init(&e->out_gain, sample_rate, 20.0, 1.0);

  for (c = 0; c < 2; c++) {
    bk_eq_channel *ch = &e->ch[c];
    bk_biquad_cascade_init(&ch->hp, sample_rate, BK_EQ_CASCADE_STAGES);
    bk_biquad_init(&ch->ls, sample_rate);
    bk_biquad_init(&ch->b1, sample_rate);
    bk_biquad_init(&ch->b2, sample_rate);
    bk_biquad_init(&ch->b3, sample_rate);
    bk_biquad_init(&ch->hs, sample_rate);
    bk_biquad_cascade_init(&ch->lp, sample_rate, BK_EQ_CASCADE_STAGES);
  }

  for (k = 0; k < BK_EQ_CURVE_POINTS; k++) e->visual[k] = 0.0f;
  e->visual_dirty = 1;
}

void bk_eq_set_param(bk_eq *e, int key, double value) {
  if (key < 0 || key >= BK_P_EQ_COUNT) return;
  e->p[key] = value;
  bk_smoother_set(&e->sm[key], value);
  e->visual_dirty = 1;
}

void bk_eq_reset(bk_eq *e) {
  int k, c;
  for (c = 0; c < 2; c++) {
    bk_eq_channel *ch = &e->ch[c];
    bk_biquad_cascade_reset(&ch->hp);
    bk_biquad_reset(&ch->ls);
    bk_biquad_reset(&ch->b1);
    bk_biquad_reset(&ch->b2);
    bk_biquad_reset(&ch->b3);
    bk_biquad_reset(&ch->hs);
    bk_biquad_cascade_reset(&ch->lp);
  }
  for (k = 0; k < BK_P_EQ_COUNT; k++) bk_smoother_reset(&e->sm[k], e->p[k]);
}

static void update_coeffs(bk_eq *e) {
  bk_smoother *s = e->sm;
  const double hp_freq = bk_smoother_next(&s[BK_P_EQ_HP_FREQ]);
  const double ls_freq = bk_smoother_next(&s[BK_P_EQ_LS_FREQ]);
  const double ls_gain = bk_smoother_next(&s[BK_P_EQ_LS_GAIN]);
  const double b1_freq = bk_smoother_next(&s[BK_P_EQ_B1_FREQ]);
  const double b1_gain = bk_smoother_next(&s[BK_P_EQ_B1_GAIN]);
  const double b1_q = bk_smoother_next(&s[BK_P_EQ_B1_Q]);
  const double b2_freq = bk_smoother_next(&s[BK_P_EQ_B2_FREQ]);
  const double b2_gain = bk_smoother_next(&s[BK_P_EQ_B2_GAIN]);
  const double b2_q = bk_smoother_next(&s[BK_P_EQ_B2_Q]);
  const double b3_freq = bk_smoother_next(&s[BK_P_EQ_B3_FREQ]);
  const double b3_gain = bk_smoother_next(&s[BK_P_EQ_B3_GAIN]);
  const double b3_q = bk_smoother_next(&s[BK_P_EQ_B3_Q]);
  const double hs_freq = bk_smoother_next(&s[BK_P_EQ_HS_FREQ]);
  const double hs_gain = bk_smoother_next(&s[BK_P_EQ_HS_GAIN]);
  const double lp_freq = bk_smoother_next(&s[BK_P_EQ_LP_FREQ]);

  const int hp_stages = slope_stages(e->p[BK_P_EQ_HP_SLOPE]);
  const int lp_stages = slope_stages(e->p[BK_P_EQ_LP_SLOPE]);
  int c;

  for (c = 0; c < 2; c++) {
    bk_eq_channel *ch = &e->ch[c];
    bk_biquad_cascade_set_active(&ch->hp, e->p[BK_P_EQ_HP_FREQ] <= 21.0 ? 0 : hp_stages);
    bk_biquad_cascade_set(&ch->hp, BK_FILTER_HIGHPASS, hp_freq, 0.7071, 0.0);
    bk_biquad_set(&ch->ls, BK_FILTER_LOWSHELF, ls_freq, 0.7071, ls_gain);
    bk_biquad_set(&ch->b1, BK_FILTER_PEAK, b1_freq, b1_q, b1_gain);
    bk_biquad_set(&ch->b2, BK_FILTER_PEAK, b2_freq, b2_q, b2_gain);
    bk_biquad_set(&ch->b3, BK_FILTER_PEAK, b3_freq, b3_q, b3_gain);
    bk_biquad_set(&ch->hs, BK_FILTER_HIGHSHELF, hs_freq, 0.7071, hs_gain);
    bk_biquad_cascade_set_active(&ch->lp, e->p[BK_P_EQ_LP_FREQ] >= 19900.0 ? 0 : lp_stages);
    bk_biquad_cascade_set(&ch->lp, BK_FILTER_LOWPASS, lp_freq, 0.7071, 0.0);
  }

  bk_smoother_set(&e->out_gain, pow(10.0, bk_smoother_next(&s[BK_P_EQ_OUTPUT]) * 0.05));
}

/* Composite magnitude response of channel 0, plus the raw output param. */
static void render_curve(bk_eq *e) {
  const bk_eq_channel *c = &e->ch[0];
  const double lo = log10(20.0);
  const double hi = log10(20000.0);
  int i;
  for (i = 0; i < BK_EQ_CURVE_POINTS; i++) {
    const double f = pow(10.0, lo + ((hi - lo) * (double)i) / (double)(BK_EQ_CURVE_POINTS - 1));
    double db = 0.0;
    db += bk_biquad_cascade_magnitude_db(&c->hp, f);
    db += bk_biquad_magnitude_db(&c->ls, f);
    db += bk_biquad_magnitude_db(&c->b1, f);
    db += bk_biquad_magnitude_db(&c->b2, f);
    db += bk_biquad_magnitude_db(&c->b3, f);
    db += bk_biquad_magnitude_db(&c->hs, f);
    db += bk_biquad_cascade_magnitude_db(&c->lp, f);
    e->visual[i] = (float)(db + e->p[BK_P_EQ_OUTPUT]);
  }
  e->visual_dirty = 0;
}

void bk_eq_process(bk_eq *e, float *l, float *r, int frames) {
  bk_eq_channel *a = &e->ch[0];
  bk_eq_channel *b = &e->ch[1];
  int i;

  update_coeffs(e);
  for (i = 0; i < frames; i++) {
    const double g = bk_smoother_next(&e->out_gain);
    double x = (double)l[i];
    x = bk_biquad_cascade_process(&a->hp, x);
    x = bk_biquad_process(&a->ls, x);
    x = bk_biquad_process(&a->b1, x);
    x = bk_biquad_process(&a->b2, x);
    x = bk_biquad_process(&a->b3, x);
    x = bk_biquad_process(&a->hs, x);
    x = bk_biquad_cascade_process(&a->lp, x);
    l[i] = (float)(x * g);

    x = (double)r[i];
    x = bk_biquad_cascade_process(&b->hp, x);
    x = bk_biquad_process(&b->ls, x);
    x = bk_biquad_process(&b->b1, x);
    x = bk_biquad_process(&b->b2, x);
    x = bk_biquad_process(&b->b3, x);
    x = bk_biquad_process(&b->hs, x);
    x = bk_biquad_cascade_process(&b->lp, x);
    r[i] = (float)(x * g);
  }
  if (e->visual_dirty) render_curve(e);
}

const float *bk_eq_visual(const bk_eq *e) { return e->visual; }

/* --- vtable --------------------------------------------------------------- */

static void vt_process(void *self, float *l, float *r, int frames) {
  bk_eq_process((bk_eq *)self, l, r, frames);
}
static void vt_reset(void *self) { bk_eq_reset((bk_eq *)self); }
static void vt_set_param(void *self, int key, double value) {
  bk_eq_set_param((bk_eq *)self, key, value);
}

const bk_effect_vt bk_eq_vt = {vt_process, vt_reset, vt_set_param, NULL, NULL, NULL};
