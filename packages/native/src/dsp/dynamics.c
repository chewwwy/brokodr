/*
 * Bro.Kodr DSP — dynamics. C port of dsp/effects/dynamics.js; see dynamics.h
 * for what is reproduced on purpose.
 */

#include "brokodr/dsp/dynamics.h"

#include <math.h>
#include <string.h>

/* Math.round, as in drive.c: the exact fraction decides, [-0.5, 0) gives -0,
   NaN stays NaN. */
static double js_round(double x) {
  const double r = floor(x);
  const double y = (x - r >= 0.5) ? r + 1.0 : r;
  return (y == 0.0 && x < 0.0) ? -0.0 : y;
}

/* `x | 0` (ToInt32), as bk_onset_to_int32 in onset.c, kept local so this
   module does not depend on the onset detector. */
static int js_to_int32(double x) {
  double t;
  unsigned int u;
  int r;
  if (!isfinite(x)) return 0;
  t = trunc(x);
  t = fmod(t, 4294967296.0);
  if (t < 0.0) t += 4294967296.0;
  u = (unsigned int)t;
  memcpy(&r, &u, sizeof(r));
  return r;
}

/* --- Compressor ----------------------------------------------------------- */

static double comp_max_la(double sample_rate) { return ceil(sample_rate * 0.01) + 8.0; }

size_t bk_compressor_storage_floats(double sample_rate) {
  return 2u * (size_t)bk_delay_line_size(comp_max_la(sample_rate));
}

static void comp_recalc(bk_compressor *c, double atk_ms, double rel_ms) {
  c->a_coef = exp(-1.0 / (bk_max(atk_ms, 0.05) * 0.001 * c->sr));
  c->r_coef = exp(-1.0 / (bk_max(rel_ms, 1.0) * 0.001 * c->sr));
}

void bk_compressor_init(bk_compressor *c, double sample_rate, float *storage) {
  const double max_la = comp_max_la(sample_rate);
  const int line = bk_delay_line_size(max_la);
  c->sr = sample_rate;
  c->threshold = -18.0;
  c->ratio = 4.0;
  c->knee = 6.0;
  c->makeup = 0.0;
  c->rms_mode = 0;
  c->lookahead_ms = 0.0;
  bk_smoother_init(&c->attack, sample_rate, 5.0, 10.0);
  bk_smoother_init(&c->release, sample_rate, 5.0, 120.0);
  bk_smoother_init(&c->mk_gain, sample_rate, 20.0, 1.0);
  c->env_db = 0.0;
  c->gain_db = 0.0;
  c->a_coef = 0.0;
  c->r_coef = 0.0;
  bk_env_follower_init(&c->rms, sample_rate, 5.0, 5.0, 1);
  bk_delay_line_init(&c->la[0], storage, max_la);
  bk_delay_line_init(&c->la[1], storage + (size_t)line, max_la);
  c->meter = 0.0;
  comp_recalc(c, 10.0, 120.0);
}

void bk_compressor_set_param(bk_compressor *c, int key, double value) {
  switch (key) {
    case BK_P_COMP_THRESHOLD:
      c->threshold = value;
      break;
    case BK_P_COMP_RATIO:
      c->ratio = bk_max(1.0, value);
      break;
    case BK_P_COMP_ATTACK:
      bk_smoother_set(&c->attack, value);
      break;
    case BK_P_COMP_RELEASE:
      bk_smoother_set(&c->release, value);
      break;
    case BK_P_COMP_KNEE:
      c->knee = bk_max(0.0, value);
      break;
    case BK_P_COMP_MAKEUP:
      c->makeup = value;
      bk_smoother_set(&c->mk_gain, bk_db_to_gain(value));
      break;
    case BK_P_COMP_DETECTOR:
      c->rms_mode = value >= 0.5 ? 1 : 0;
      break;
    case BK_P_COMP_LOOKAHEAD:
      c->lookahead_ms = bk_clamp(value, 0.0, 10.0);
      break;
    default:
      break;
  }
}

void bk_compressor_reset(bk_compressor *c) {
  c->env_db = -120.0;
  c->gain_db = 0.0;
  bk_delay_line_clear(&c->la[0]);
  bk_delay_line_clear(&c->la[1]);
  bk_env_follower_reset(&c->rms);
}

/* Static gain-computer curve with soft knee: output dB for input dB. */
static double comp_curve(const bk_compressor *c, double x) {
  const double t = c->threshold;
  const double w = c->knee;
  const double r = c->ratio;
  if (w > 0.0 && x > t - w / 2.0 && x < t + w / 2.0) {
    const double d = x - t + w / 2.0;
    return x + ((1.0 / r - 1.0) * d * d) / (2.0 * w);
  }
  if (x >= t + w / 2.0) return t + (x - t) / r;
  return x;
}

void bk_compressor_process(bk_compressor *c, float *l, float *r, int frames) {
  int i, la;
  double max_gr = 0.0;
  {
    const double atk = bk_smoother_next(&c->attack);
    const double rel = bk_smoother_next(&c->release);
    comp_recalc(c, atk, rel);
  }
  la = js_to_int32(c->lookahead_ms * 0.001 * c->sr);

  for (i = 0; i < frames; i++) {
    const double xl = (double)l[i];
    const double xr = (double)r[i];
    double det, in_db, k, g, mk;

    if (c->rms_mode) {
      det = bk_env_follower_process(&c->rms, (fabs(xl) + fabs(xr)) * 0.5);
    } else {
      det = bk_max(fabs(xl), fabs(xr));
    }
    in_db = bk_gain_to_db(det);

    k = in_db > c->env_db ? c->a_coef : c->r_coef;
    c->env_db = in_db + (c->env_db - in_db) * k;

    c->gain_db = comp_curve(c, c->env_db) - c->env_db;
    g = bk_db_to_gain(c->gain_db);
    if (-c->gain_db > max_gr) max_gr = -c->gain_db;

    mk = bk_smoother_next(&c->mk_gain);

    if (la > 0) {
      bk_delay_line_write(&c->la[0], xl);
      bk_delay_line_write(&c->la[1], xr);
      l[i] = (float)(bk_delay_line_read(&c->la[0], (double)la) * g * mk);
      r[i] = (float)(bk_delay_line_read(&c->la[1], (double)la) * g * mk);
    } else {
      l[i] = (float)(xl * g * mk);
      r[i] = (float)(xr * g * mk);
    }
  }
  c->meter = max_gr;
}

double bk_compressor_meter(const bk_compressor *c) { return c->meter; }

static void comp_vt_process(void *self, float *l, float *r, int frames) {
  bk_compressor_process((bk_compressor *)self, l, r, frames);
}
static void comp_vt_reset(void *self) { bk_compressor_reset((bk_compressor *)self); }
static void comp_vt_set_param(void *self, int key, double value) {
  bk_compressor_set_param((bk_compressor *)self, key, value);
}
static double comp_vt_meter(const void *self) { return bk_compressor_meter((const bk_compressor *)self); }

const bk_effect_vt bk_compressor_vt = {comp_vt_process, comp_vt_reset, comp_vt_set_param, NULL, NULL, comp_vt_meter};

/* --- Limiter -------------------------------------------------------------- */

static int limiter_lookahead(double sample_rate) { return (int)bk_max(8.0, js_round(sample_rate * 0.0015)); }

size_t bk_limiter_storage_floats(double sample_rate) {
  const int n = limiter_lookahead(sample_rate);
  return 2u * (size_t)bk_delay_line_size((double)n + 8.0) + (size_t)n;
}

void bk_limiter_init(bk_limiter *m, double sample_rate, float *storage) {
  const int n = limiter_lookahead(sample_rate);
  const int line = bk_delay_line_size((double)n + 8.0);
  int k;
  m->sr = sample_rate;
  m->ceiling_db = -0.3;
  m->release_ms = 80.0;
  m->gain_db = 0.0;
  m->lookahead = n;
  bk_delay_line_init(&m->d[0], storage, (double)n + 8.0);
  bk_delay_line_init(&m->d[1], storage + (size_t)line, (double)n + 8.0);
  m->win = storage + 2u * (size_t)line;
  for (k = 0; k < n; k++) m->win[k] = 0.0f;
  m->wi = 0;
  m->env = 0.0;
  m->r_coef = exp(-1.0 / (0.08 * sample_rate));
  m->a_coef = exp(-1.0 / (0.0005 * sample_rate));
  m->meter = 0.0;
}

void bk_limiter_set_param(bk_limiter *m, int key, double value) {
  if (key == BK_P_LIMITER_CEILING) {
    m->ceiling_db = value;
  } else if (key == BK_P_LIMITER_RELEASE) {
    m->release_ms = bk_max(5.0, value);
    m->r_coef = exp(-1.0 / (m->release_ms * 0.001 * m->sr));
  }
}

void bk_limiter_reset(bk_limiter *m) {
  int k;
  bk_delay_line_clear(&m->d[0]);
  bk_delay_line_clear(&m->d[1]);
  for (k = 0; k < m->lookahead; k++) m->win[k] = 0.0f;
  m->env = 0.0;
  m->gain_db = 0.0;
}

void bk_limiter_process(bk_limiter *m, float *l, float *r, int frames) {
  const double ceil_g = bk_db_to_gain(m->ceiling_db);
  const int n = m->lookahead;
  double max_gr = 0.0;
  int i, k;

  for (i = 0; i < frames; i++) {
    const double xl = (double)l[i];
    const double xr = (double)r[i];
    double peak = 0.0, need, c, g, gr_db, ol, orr;
    bk_delay_line_write(&m->d[0], xl);
    bk_delay_line_write(&m->d[1], xr);

    m->win[m->wi] = (float)bk_max(fabs(xl), fabs(xr));
    m->wi = (m->wi + 1) % n;

    for (k = 0; k < n; k++) {
      if ((double)m->win[k] > peak) peak = (double)m->win[k];
    }

    need = peak > ceil_g ? ceil_g / peak : 1.0;
    c = (need < m->env || m->env == 0.0) ? m->a_coef : m->r_coef;
    m->env = need + (m->env - need) * c;
    g = bk_min(1.0, m->env);
    gr_db = -bk_gain_to_db(g);
    if (gr_db > max_gr) max_gr = gr_db;

    ol = bk_delay_line_read(&m->d[0], (double)n) * g;
    orr = bk_delay_line_read(&m->d[1], (double)n) * g;
    /* Final hard safety clamp — the limiter is the last line of defence. */
    l[i] = (float)bk_clamp(ol, -ceil_g, ceil_g);
    r[i] = (float)bk_clamp(orr, -ceil_g, ceil_g);
  }
  m->meter = max_gr;
}

double bk_limiter_meter(const bk_limiter *m) { return m->meter; }

static void limiter_vt_process(void *self, float *l, float *r, int frames) {
  bk_limiter_process((bk_limiter *)self, l, r, frames);
}
static void limiter_vt_reset(void *self) { bk_limiter_reset((bk_limiter *)self); }
static void limiter_vt_set_param(void *self, int key, double value) {
  bk_limiter_set_param((bk_limiter *)self, key, value);
}
static double limiter_vt_meter(const void *self) { return bk_limiter_meter((const bk_limiter *)self); }

const bk_effect_vt bk_limiter_vt = {limiter_vt_process, limiter_vt_reset, limiter_vt_set_param, NULL, NULL,
                                    limiter_vt_meter};

/* --- Gate ----------------------------------------------------------------- */

void bk_gate_init(bk_gate *g, double sample_rate) {
  g->sr = sample_rate;
  g->threshold_db = -45.0;
  g->range_db = -60.0;
  g->hold_ms = 40.0;
  g->hysteresis_db = 4.0;
  g->sc_hp_freq = 80.0;
  bk_env_follower_init(&g->env, sample_rate, 1.0, 30.0, 0);
  bk_biquad_init(&g->hp[0], sample_rate);
  bk_biquad_init(&g->hp[1], sample_rate);
  bk_smoother_init(&g->gain_sm, sample_rate, 8.0, 0.0);
  g->open = 0;
  g->hold_counter = 0;
  g->attack_ms = 1.0;
  g->release_ms = 120.0;
  g->meter = 0.0;
}

void bk_gate_set_param(bk_gate *g, int key, double value) {
  switch (key) {
    case BK_P_GATE_THRESHOLD:
      g->threshold_db = value;
      break;
    case BK_P_GATE_RANGE:
      g->range_db = value;
      break;
    case BK_P_GATE_ATTACK:
      g->attack_ms = value;
      bk_env_follower_set_attack(&g->env, value);
      bk_smoother_set_time(&g->gain_sm, bk_max(0.5, value));
      break;
    case BK_P_GATE_RELEASE:
      g->release_ms = value;
      bk_env_follower_set_release(&g->env, value);
      break;
    case BK_P_GATE_HOLD:
      g->hold_ms = value;
      break;
    case BK_P_GATE_HYSTERESIS:
      g->hysteresis_db = value;
      break;
    case BK_P_GATE_SCFREQ:
      g->sc_hp_freq = value;
      break;
    default:
      break;
  }
}

void bk_gate_reset(bk_gate *g) {
  bk_env_follower_reset(&g->env);
  bk_biquad_reset(&g->hp[0]);
  bk_biquad_reset(&g->hp[1]);
  bk_smoother_reset(&g->gain_sm, 0.0);
  g->open = 0;
  g->hold_counter = 0;
}

void bk_gate_process(bk_gate *g, float *l, float *r, int frames) {
  int i, hold_samples;
  double open_db, close_db, floor_g, gr_max = 0.0;
  bk_biquad_set(&g->hp[0], BK_FILTER_HIGHPASS, g->sc_hp_freq, 0.7071, 0.0);
  bk_biquad_set(&g->hp[1], BK_FILTER_HIGHPASS, g->sc_hp_freq, 0.7071, 0.0);
  hold_samples = js_to_int32(g->hold_ms * 0.001 * g->sr);
  open_db = g->threshold_db;
  close_db = g->threshold_db - g->hysteresis_db;
  floor_g = bk_db_to_gain(g->range_db);

  for (i = 0; i < frames; i++) {
    const double hl = bk_biquad_process(&g->hp[0], (double)l[i]);
    const double hr = bk_biquad_process(&g->hp[1], (double)r[i]);
    const double sc = bk_max(fabs(hl), fabs(hr));
    const double db = bk_gain_to_db(bk_env_follower_process(&g->env, sc));
    double gain, gr;

    if (db > open_db) {
      g->open = 1;
      g->hold_counter = hold_samples;
    } else if (db < close_db) {
      if (g->hold_counter > 0) g->hold_counter--;
      else g->open = 0;
    }

    bk_smoother_set(&g->gain_sm, g->open ? 1.0 : floor_g);
    gain = bk_smoother_next(&g->gain_sm);
    gr = -bk_gain_to_db(gain);
    if (gr > gr_max) gr_max = gr;
    l[i] = (float)((double)l[i] * gain);
    r[i] = (float)((double)r[i] * gain);
  }
  g->meter = gr_max;
}

double bk_gate_meter(const bk_gate *g) { return g->meter; }

static void gate_vt_process(void *self, float *l, float *r, int frames) { bk_gate_process((bk_gate *)self, l, r, frames); }
static void gate_vt_reset(void *self) { bk_gate_reset((bk_gate *)self); }
static void gate_vt_set_param(void *self, int key, double value) { bk_gate_set_param((bk_gate *)self, key, value); }
static double gate_vt_meter(const void *self) { return bk_gate_meter((const bk_gate *)self); }

const bk_effect_vt bk_gate_vt = {gate_vt_process, gate_vt_reset, gate_vt_set_param, NULL, NULL, gate_vt_meter};

/* --- TransientShaper ------------------------------------------------------ */

void bk_transient_shaper_init(bk_transient_shaper *t, double sample_rate) {
  t->sr = sample_rate;
  t->attack_amt = 0.0;
  t->sustain_amt = 0.0;
  bk_env_follower_init(&t->fast, sample_rate, 0.5, 25.0, 0);
  bk_env_follower_init(&t->slow, sample_rate, 12.0, 200.0, 0);
  bk_smoother_init(&t->gain_sm, sample_rate, 2.0, 1.0);
  t->meter = 0.0;
}

void bk_transient_shaper_set_param(bk_transient_shaper *t, int key, double value) {
  if (key == BK_P_TRANSIENT_ATTACK) {
    t->attack_amt = value;
  } else if (key == BK_P_TRANSIENT_SUSTAIN) {
    t->sustain_amt = value;
  } else if (key == BK_P_TRANSIENT_SPEED) {
    bk_env_follower_set_attack(&t->fast, bk_max(0.2, value * 0.3));
    bk_env_follower_set_attack(&t->slow, bk_max(4.0, value * 4.0));
  }
}

void bk_transient_shaper_reset(bk_transient_shaper *t) {
  bk_env_follower_reset(&t->fast);
  bk_env_follower_reset(&t->slow);
  bk_smoother_reset(&t->gain_sm, 1.0);
}

void bk_transient_shaper_process(bk_transient_shaper *t, float *l, float *r, int frames) {
  double peak_gain = 0.0;
  int i;
  for (i = 0; i < frames; i++) {
    const double x = bk_max(fabs((double)l[i]), fabs((double)r[i]));
    const double f = bk_env_follower_process(&t->fast, x);
    const double s = bk_env_follower_process(&t->slow, x);
    const double diff = bk_gain_to_db(f + 1e-9) - bk_gain_to_db(s + 1e-9);
    /* diff > 0: transient region; diff < 0: decay region. */
    const double transient = bk_clamp(diff / 6.0, 0.0, 1.0);
    const double sustain = bk_clamp(-diff / 6.0, 0.0, 1.0);
    const double db = t->attack_amt * transient + t->sustain_amt * sustain;
    double g;
    bk_smoother_set(&t->gain_sm, bk_db_to_gain(db));
    g = bk_smoother_next(&t->gain_sm);
    if (fabs(db) > peak_gain) peak_gain = fabs(db);
    l[i] = (float)bk_sanitize((double)l[i] * g);
    r[i] = (float)bk_sanitize((double)r[i] * g);
  }
  t->meter = peak_gain;
}

double bk_transient_shaper_meter(const bk_transient_shaper *t) { return t->meter; }

static void transient_vt_process(void *self, float *l, float *r, int frames) {
  bk_transient_shaper_process((bk_transient_shaper *)self, l, r, frames);
}
static void transient_vt_reset(void *self) { bk_transient_shaper_reset((bk_transient_shaper *)self); }
static void transient_vt_set_param(void *self, int key, double value) {
  bk_transient_shaper_set_param((bk_transient_shaper *)self, key, value);
}
static double transient_vt_meter(const void *self) {
  return bk_transient_shaper_meter((const bk_transient_shaper *)self);
}

const bk_effect_vt bk_transient_shaper_vt = {transient_vt_process, transient_vt_reset, transient_vt_set_param, NULL,
                                             NULL, transient_vt_meter};
