/* Bro.Kodr — port of dsp/effects/talkbox.js; contract in talkbox.h. */
#include "brokodr/dsp/talkbox.h"
#include <math.h>

#define PREEMPH 0.95
#define K_LIMIT 0.985
#define EXC_TRIM 1.0
static const double carrier_rms[6] = {0.5774, 1.0, 0.8285, 0.8062, 0.7365, 0.5196};

static double js_round(double x) {
  const double r = floor(x);
  const double y = (x - r >= 0.5) ? r + 1.0 : r;
  return y == 0.0 && x < 0.0 ? -0.0 : y;
}

static int frame_len_for(double sr) {
  return (int)bk_max(256.0, bk_min(2048.0, js_round(sr * 0.025)));
}
static int hist_len_for(double sr, int max_block) { return frame_len_for(sr) * 2 + max_block + 8; }

size_t bk_talkbox_storage_floats(double sr, int max_block) {
  /* history, mono block, oversampler work buffer */
  return (size_t)hist_len_for(sr, max_block) + 5u * (size_t)max_block;
}

static void update_filters(bk_talkbox *e) {
  const double tilt = e->brightness * 9.0;
  bk_biquad_set(&e->breath_hp, BK_FILTER_HIGHPASS, 3800.0, 0.7, 0.0);
  bk_biquad_set(&e->tilt_high, BK_FILTER_HIGHSHELF, 2200.0, 0.7, tilt);
  bk_biquad_set(&e->tilt_low, BK_FILTER_LOWSHELF, 320.0, 0.7, -tilt * 0.5);
}

void bk_talkbox_init(bk_talkbox *e, double sr, int max_block, float *storage) {
  int i;
  e->sr = sr;
  e->max_block = max_block;
  e->carrier_type = 0.0;
  e->pitch_hz = 110.0;
  e->follow = 1;
  e->glide_ms = 40.0;
  e->order = 22.0;
  e->tract_size = 1.0;
  e->tract_q = 0.9;
  e->brightness = 0.2;
  e->breath = 0.3;
  e->squelch_db = -52.0;
  e->drive_amt = 0.25;
  e->out_db = 0.0;
  e->source = 0;
  e->car_l = e->car_r = NULL;
  e->car_rms = 0.0;
  e->car_rms_a = 1.0 - exp(-1.0 / (0.1 * sr));

  e->frame_len = frame_len_for(sr);
  e->hop = (int)bk_max(64.0, js_round(sr * 0.006));
  e->hist_len = hist_len_for(sr, max_block);
  e->hist = storage;
  for (i = 0; i < e->hist_len; i++) e->hist[i] = 0.0f;
  e->hist_w = 0;
  e->hop_count = 0;
  for (i = 0; i < e->frame_len; i++) {
    e->window[i] = (float)(0.54 - 0.46 * cos((2.0 * BK_PI * i) / (e->frame_len - 1)));
    e->frame[i] = 0.0;
  }
  for (i = 0; i <= BK_TALKBOX_MAX_ORDER; i++) {
    e->acf[i] = e->lpc[i] = e->lpc_tmp[i] = e->b[i] = 0.0;
  }
  for (i = 0; i < BK_TALKBOX_MAX_ORDER; i++) e->k_target[i] = e->k_now[i] = 0.0;
  e->active_order = 22;
  e->gain_target = 0.0;

  bk_oscillator_init(&e->osc1, sr);
  bk_oscillator_init(&e->osc2, sr);
  bk_oscillator_init(&e->osc_sub, sr);
  e->noise_state = 12345u;
  bk_pitch_tracker_init(&e->tracker, sr, 60.0, 700.0);
  e->tracked_hz = 110.0;
  bk_smoother_init(&e->pitch_sm, sr, e->glide_ms, 110.0);

  bk_env_follower_init(&e->in_env, sr, 3.0, 90.0, 1);
  bk_smoother_init(&e->gate_sm, sr, 12.0, 0.0);
  bk_smoother_init(&e->gain_sm, sr, 8.0, 0.0);
  bk_smoother_init(&e->out_sm, sr, 20.0, 1.0);
  bk_smoother_init(&e->breath_sm, sr, 20.0, 0.3);
  bk_biquad_init(&e->breath_hp, sr);
  bk_biquad_init(&e->tilt_low, sr);
  bk_biquad_init(&e->tilt_high, sr);
  bk_dc_blocker_init(&e->dc, sr, 25.0);
  e->de_z = 0.0;

  e->mono = storage + e->hist_len;
  for (i = 0; i < max_block; i++) e->mono[i] = 0.0f;
  bk_oversampler4x_init(&e->os, storage + e->hist_len + max_block, sr, max_block);
  e->drive_gain = 0.25;
  e->meter = 0.0;
  update_filters(e);
}

void bk_talkbox_set_carrier_bus(bk_talkbox *e, const float *l, const float *r) {
  e->car_l = l;
  e->car_r = r;
}

void bk_talkbox_set_param(bk_talkbox *e, int key, double v) {
  switch (key) {
    case BK_P_TALKBOX_CARRIER: e->carrier_type = bk_clamp(js_round(v), 0.0, 5.0); break;
    case BK_P_TALKBOX_PITCH:
      e->pitch_hz = bk_clamp(v, 20.0, 2000.0);
      if (!e->follow) bk_smoother_set(&e->pitch_sm, e->pitch_hz);
      break;
    case BK_P_TALKBOX_FOLLOW: e->follow = v >= 0.5 ? 1 : 0; break;
    case BK_P_TALKBOX_GLIDE:
      e->glide_ms = bk_clamp(v, 0.0, 400.0);
      bk_smoother_set_time(&e->pitch_sm, bk_max(0.5, e->glide_ms));
      break;
    /* Even orders only: formants come in pole pairs. */
    case BK_P_TALKBOX_ORDER:
      e->order = bk_clamp(js_round(v / 2.0) * 2.0, 8.0, BK_TALKBOX_MAX_ORDER);
      break;
    case BK_P_TALKBOX_TRACT: e->tract_size = bk_clamp(v, 0.5, 2.0); break;
    case BK_P_TALKBOX_TRACTQ: e->tract_q = bk_clamp(v, 0.0, 1.0); break;
    case BK_P_TALKBOX_BRIGHTNESS:
      e->brightness = bk_clamp(v, -1.0, 1.0);
      update_filters(e);
      break;
    case BK_P_TALKBOX_BREATH:
      e->breath = bk_clamp(v, 0.0, 1.0);
      bk_smoother_set(&e->breath_sm, e->breath);
      break;
    case BK_P_TALKBOX_SQUELCH: e->squelch_db = bk_clamp(v, -90.0, -10.0); break;
    case BK_P_TALKBOX_DRIVE: e->drive_amt = bk_clamp(v, 0.0, 1.0); break;
    case BK_P_TALKBOX_OUTPUT:
      e->out_db = v;
      bk_smoother_set(&e->out_sm, bk_db_to_gain(v));
      break;
    case BK_P_TALKBOX_SOURCE: e->source = v >= 0.5 ? 1 : 0; break;
    default: break;
  }
}

/* readLerp. A NaN position indexes `buf[NaN]` in the JS (undefined), so the
   interpolation is NaN; never cast it to int. Finite positions are bounded by
   the history geometry, well inside int range. */
static double read_lerp(const float *buf, int len, double pos) {
  double i0, frac, a, b;
  int i;
  if (pos != pos) return NAN;
  i0 = floor(pos);
  frac = pos - i0;
  i = (int)i0;
  a = buf[((i % len) + len) % len];
  b = buf[(((i + 1) % len) + len) % len];
  return a + (b - a) * frac;
}

static void analyse(bk_talkbox *e) {
  const int n = e->frame_len;
  const int h = e->hist_len;
  const double r = bk_clamp(1.0 / bk_max(0.5, e->tract_size), 0.5, 2.0);
  const double span = bk_min((double)(h - 4), ceil(n * r) + 2.0);
  const double start = (double)e->hist_w - span;
  double energy = 0.0, prev, p, q_scale, err, g;
  double *a = e->lpc, *tmp = e->lpc_tmp, *k = e->k_target, *acf = e->acf;
  int i, m, j, fitted;

  prev = read_lerp(e->hist, h, start - r);
  for (i = 0; i < n; i++) {
    const double x = read_lerp(e->hist, h, start + i * r);
    const double w = (x - PREEMPH * prev) * e->window[i];
    prev = x;
    e->frame[i] = w;
    energy += w * w;
  }
  if (!(energy > 1e-12)) {
    e->gain_target = 0.0;
    for (i = 0; i < BK_TALKBOX_MAX_ORDER; i++) k[i] = 0.0;
    return;
  }

  p = bk_min(bk_min(e->order, BK_TALKBOX_MAX_ORDER), (double)(n - 2));
  for (m = 0; m <= p; m++) {
    double s = 0.0;
    for (j = m; j < n; j++) s += e->frame[j] * e->frame[j - m];
    acf[m] = s;
  }
  /* Applied even when a NaN order skipped the loop: acf[0] is then stale. */
  acf[0] = acf[0] * 1.0001 + 1e-9;

  q_scale = 0.6 + 0.4 * e->tract_q;
  err = acf[0];
  fitted = 0;
  a[0] = 1.0;
  for (m = 1; m <= p; m++) {
    double acc = acf[m], km;
    for (j = 1; j < m; j++) acc += a[j] * acf[m - j];
    km = -acc / err;
    if (!isfinite(km) || fabs(km) >= 1.0) break;
    for (j = 1; j < m; j++) tmp[j] = a[j] + km * a[m - j];
    for (j = 1; j < m; j++) a[j] = tmp[j];
    a[m] = km;
    k[m - 1] = bk_clamp(km * q_scale, -K_LIMIT, K_LIMIT);
    err *= 1.0 - km * km;
    fitted = m;
    if (!(err > 1e-20)) break;
  }
  for (i = fitted; i < BK_TALKBOX_MAX_ORDER; i++) k[i] = 0.0;
  e->active_order = fitted;

  g = sqrt(bk_max(err, 0.0) / n);
  e->gain_target = isfinite(g) ? bk_min(g, 4.0) : 0.0;
}

/* xorshift32 on the JS int32 state; the bits are the same in uint32. */
static double noise_next(bk_talkbox *e) {
  unsigned int s = e->noise_state;
  double v;
  s ^= (s << 13) & 0xffffffffu;
  s ^= s >> 17;
  s ^= (s << 5) & 0xffffffffu;
  s &= 0xffffffffu;
  e->noise_state = s;
  v = s >= 0x80000000u ? (double)s - 4294967296.0 : (double)s;
  return (v / 2147483648.0) * 0.9;
}

static double carrier(bk_talkbox *e, double hz) {
  const double t = e->carrier_type;
  if (t == 1.0) {
    bk_oscillator_set_freq(&e->osc1, hz);
    e->osc1.pw = 0.5;
    return bk_oscillator_pulse(&e->osc1);
  }
  if (t == 2.0) {
    bk_oscillator_set_freq(&e->osc1, hz);
    e->osc1.pw = 0.22;
    return bk_oscillator_pulse(&e->osc1);
  }
  if (t == 3.0) {
    double s1, s2;
    bk_oscillator_set_freq(&e->osc1, hz);
    bk_oscillator_set_freq(&e->osc2, hz * 1.006);
    s1 = bk_oscillator_saw(&e->osc1);
    s2 = bk_oscillator_saw(&e->osc2);
    return 0.6 * (s1 + s2);
  }
  if (t == 4.0) {
    double s1, s2;
    bk_oscillator_set_freq(&e->osc1, hz);
    bk_oscillator_set_freq(&e->osc_sub, hz * 0.5);
    e->osc_sub.pw = 0.5;
    s1 = 0.7 * bk_oscillator_saw(&e->osc1);
    s2 = 0.6 * bk_oscillator_pulse(&e->osc_sub);
    return s1 + s2;
  }
  if (t == 5.0) return noise_next(e);
  bk_oscillator_set_freq(&e->osc1, hz);
  return bk_oscillator_saw(&e->osc1);
}

/* CARRIER_RMS[carrierType]: the type is an integer in [0, 5] or NaN, and
   CARRIER_RMS[NaN] is undefined, i.e. a NaN quotient. */
static double carrier_norm(const bk_talkbox *e) {
  const double t = e->carrier_type;
  return t == t ? carrier_rms[(int)t] : NAN;
}

static double shaper(double x, void *user) {
  const bk_talkbox *e = (const bk_talkbox *)user;
  const double d = 1.0 + e->drive_gain * 9.0;
  return tanh(x * d) / tanh(d > 1.0 ? d : 1.0001);
}

void bk_talkbox_process(bk_talkbox *e, float *l, float *r, int frames) {
  const int h = e->hist_len;
  const double thresh = bk_db_to_gain(e->squelch_db);
  const double ka = 1.0 - exp(-1.0 / (0.004 * e->sr));
  double act = 0.0;
  int i, s;
  e->drive_gain = e->drive_amt;

  for (i = 0; i < frames; i++) {
    const double x = ((double)l[i] + (double)r[i]) * 0.5;
    double env, open_t, gate, hz, pitch, g, src, exc, f, de, y, b_amt;
    int ord;

    e->hist[e->hist_w] = (float)x;
    e->hist_w = (e->hist_w + 1) % h;
    bk_pitch_tracker_push(&e->tracker, x);
    if (++e->hop_count >= e->hop) {
      e->hop_count = 0;
      analyse(e);
    }

    env = bk_env_follower_process(&e->in_env, x);
    open_t = env > thresh ? bk_min(1.0, (env - thresh) / (thresh * 1.5 + 1e-9)) : 0.0;
    bk_smoother_set(&e->gate_sm, open_t);
    gate = bk_smoother_next(&e->gate_sm);

    hz = e->pitch_hz;
    if (e->follow) {
      if (e->tracked_hz > 0.0) hz = e->tracked_hz;
    }
    bk_smoother_set(&e->pitch_sm, bk_clamp(hz, 20.0, e->sr * 0.25));
    pitch = bk_smoother_next(&e->pitch_sm);

    bk_smoother_set(&e->gain_sm, e->gain_target);
    g = bk_smoother_next(&e->gain_sm);
    if (e->source == 1 && e->car_l) {
      const double c = ((double)e->car_l[i] + (double)e->car_r[i]) * 0.5;
      double rms;
      e->car_rms += (c * c - e->car_rms) * e->car_rms_a;
      rms = sqrt(e->car_rms);
      src = rms > 1e-5 ? c / rms : 0.0;
      /* Keep the synth phase advancing so switching back is not a phase jump. */
      carrier(e, pitch);
    } else {
      src = carrier(e, pitch) / carrier_norm(e);
    }
    exc = src * g * gate * EXC_TRIM;

    ord = e->active_order;
    f = exc;
    for (s = ord; s >= 1; s--) {
      const double kk = (e->k_now[s - 1] += (e->k_target[s - 1] - e->k_now[s - 1]) * ka);
      const double bp = e->b[s - 1];
      f = f - kk * bp;
      e->b[s] = bp + kk * f;
    }
    f = bk_sanitize(f);
    e->b[0] = f;

    de = f + PREEMPH * e->de_z;
    e->de_z = bk_sanitize(de);
    y = bk_dc_blocker_process(&e->dc, de);

    b_amt = bk_smoother_next(&e->breath_sm);
    if (b_amt > 0.0001)
      y += bk_biquad_process(&e->breath_hp, x) * b_amt * 0.8;
    else
      bk_biquad_process(&e->breath_hp, x);

    e->mono[i] = (float)bk_sanitize(y);
    if (gate > act) act = gate;
  }

  /* frames <= 0 is a no-op in the JS loops; size_t would not be. */
  if (e->drive_amt > 0.001 && frames > 0)
    bk_oversampler4x_process(&e->os, e->mono, (size_t)frames, shaper, e, e->mono);

  for (i = 0; i < frames; i++) {
    double y = bk_biquad_process(&e->tilt_low, bk_biquad_process(&e->tilt_high, e->mono[i]));
    y = bk_sanitize(y) * bk_smoother_next(&e->out_sm);
    l[i] = (float)y;
    r[i] = (float)y;
  }

  if (e->follow) {
    const double t = bk_pitch_tracker_analyze(&e->tracker);
    if (t > 0.0) e->tracked_hz = t;
  }

  e->meter = act;

  /* Kept from the JS; b[0] is always a sanitize() result here. */
  if (!isfinite(e->b[0])) bk_talkbox_reset(e);
}

void bk_talkbox_reset(bk_talkbox *e) {
  int i;
  for (i = 0; i <= BK_TALKBOX_MAX_ORDER; i++) e->b[i] = 0.0;
  for (i = 0; i < BK_TALKBOX_MAX_ORDER; i++) e->k_now[i] = e->k_target[i] = 0.0;
  for (i = 0; i < e->hist_len; i++) e->hist[i] = 0.0f;
  e->hist_w = 0;
  e->hop_count = 0;
  e->active_order = 0;
  e->gain_target = 0.0;
  e->de_z = 0.0;
  bk_dc_blocker_reset(&e->dc);
  bk_biquad_reset(&e->breath_hp);
  bk_biquad_reset(&e->tilt_high);
  bk_biquad_reset(&e->tilt_low);
  bk_oversampler4x_reset(&e->os);
  bk_env_follower_reset(&e->in_env);
  bk_smoother_reset(&e->gate_sm, 0.0);
  bk_smoother_reset(&e->gain_sm, 0.0);
  e->car_rms = 0.0;
  e->meter = 0.0;
}

static void vt_process(void *s, float *l, float *r, int n) { bk_talkbox_process((bk_talkbox *)s, l, r, n); }
static void vt_reset(void *s) { bk_talkbox_reset((bk_talkbox *)s); }
static void vt_param(void *s, int k, double v) { bk_talkbox_set_param((bk_talkbox *)s, k, v); }
static void vt_bus(void *s, const float *l, const float *r) {
  bk_talkbox_set_carrier_bus((bk_talkbox *)s, l, r);
}
static double vt_meter(const void *s) { return ((const bk_talkbox *)s)->meter; }
const bk_effect_vt bk_talkbox_vt = {vt_process, vt_reset, vt_param, vt_bus, NULL, vt_meter};
