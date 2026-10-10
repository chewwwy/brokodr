/* Bro.Kodr — port of dsp/effects/vocoder.js; contract in vocoder.h. */
#include "brokodr/dsp/vocoder.h"
#include <math.h>

static double js_round(double x) {
  const double r = floor(x);
  const double y = (x - r >= 0.5) ? r + 1.0 : r;
  return y == 0.0 && x < 0.0 ? -0.0 : y;
}

static double internal_random(void *user) {
  return (bk_rng_bipolar((unsigned int *)user) + 1.0) * 0.5;
}

/* `i < n` for a double n that is an integer in [4, 32] or NaN. */
static int active_bands(const bk_vocoder *e) {
  return e->band_count == e->band_count ? (int)e->band_count : 0;
}

static void rebuild(bk_vocoder *e) {
  const int n = active_bands(e);
  const double nb = e->band_count;
  const double lo = log2(bk_max(40.0, e->freq_lo));
  const double hi = log2(bk_min(e->sr * 0.45, bk_max(e->freq_lo * 2.0, e->freq_hi)));
  const double nyq = e->sr * 0.45;
  int i;
  for (i = 0; i < n; i++) {
    /* The JS `n === 1 ? 0.5 : ...` guard cannot fire: n is in [4, 32] here. */
    const double t = i / (nb - 1.0);
    const double f = bk_min(pow(2.0, lo + (hi - lo) * t), nyq);
    bk_vocoder_band *b = &e->bands[i];
    b->freq = f;
    bk_biquad_set(&b->mod_a, BK_FILTER_BANDPASS, f, e->q_factor, 0.0);
    bk_biquad_set(&b->mod_b, BK_FILTER_BANDPASS, f, e->q_factor, 0.0);
    bk_biquad_set(&b->car_a, BK_FILTER_BANDPASS, f, e->q_factor, 0.0);
    bk_biquad_set(&b->car_b, BK_FILTER_BANDPASS, f, e->q_factor, 0.0);
    b->gain = bk_db_to_gain((t - 0.5) * 2.0 * e->tone * 12.0);
    b->pan = e->stereo_spread * (i % 2 == 0 ? -1.0 : 1.0);
  }
  e->dirty = 0;
}

void bk_vocoder_init(bk_vocoder *e, double sr, int max_block) {
  int i;
  e->sr = sr;
  e->max_block = max_block;
  e->band_count = 16.0;
  e->freq_lo = 120.0;
  e->freq_hi = 7000.0;
  e->q_factor = 4.0;
  e->carrier_type = 0.0;
  e->carrier_pitch_hz = 110.0;
  e->pitch_follow = 0;
  e->depth = 1.0;
  e->tone = 0.0;
  e->sibilance = 0.3;
  e->attack_ms = 3.0;
  e->release_ms = 25.0;
  e->carrier_level = -60.0;
  e->stereo_spread = 0.0;
  e->source = 0;
  e->car_l = e->car_r = NULL;
  e->car_rms = 0.0;
  e->car_rms_a = 1.0 - exp(-1.0 / (0.1 * sr));
  for (i = 0; i < BK_VOCODER_MAX_BANDS; i++) {
    bk_vocoder_band *b = &e->bands[i];
    bk_biquad_init(&b->mod_a, sr);
    bk_biquad_init(&b->mod_b, sr);
    bk_biquad_init(&b->car_a, sr);
    bk_biquad_init(&b->car_b, sr);
    bk_env_follower_init(&b->env, sr, 3.0, 25.0, 1);
    b->freq = 100.0;
    b->gain = 1.0;
    b->pan = 0.0;
    b->level = 0.0;
  }
  bk_oscillator_init(&e->osc1, sr);
  bk_oscillator_init(&e->osc2, sr);
  bk_oscillator_init(&e->osc_sub, sr);
  bk_pitch_tracker_init(&e->tracker, sr, 60.0, 900.0);
  e->tracked_hz = 0.0;
  bk_smoother_init(&e->pitch_sm, sr, 30.0, 110.0);
  bk_smoother_init(&e->depth_sm, sr, 20.0, 1.0);
  bk_smoother_init(&e->out_sm, sr, 20.0, 1.0);
  bk_biquad_init(&e->sib_hp, sr);
  bk_env_follower_init(&e->sib_env, sr, 2.0, 30.0, 1);
  bk_env_follower_init(&e->in_env, sr, 5.0, 80.0, 1);
  e->meter = 0.0;
  bk_rng_seed(&e->rng, 0x6a09e667u);
  e->random = internal_random;
  e->random_user = &e->rng;
  e->dirty = 1;
  rebuild(e);
}

void bk_vocoder_set_random(bk_vocoder *e, bk_random_fn fn, void *user) {
  if (fn) {
    e->random = fn;
    e->random_user = user;
  } else {
    e->random = internal_random;
    e->random_user = &e->rng;
  }
}

void bk_vocoder_set_carrier_bus(bk_vocoder *e, const float *l, const float *r) {
  e->car_l = l;
  e->car_r = r;
}

void bk_vocoder_set_param(bk_vocoder *e, int key, double v) {
  int i;
  switch (key) {
    case BK_P_VOCODER_BANDS:
      e->band_count = bk_clamp(js_round(v), 4.0, BK_VOCODER_MAX_BANDS);
      e->dirty = 1;
      break;
    case BK_P_VOCODER_FREQLO:
      e->freq_lo = v;
      e->dirty = 1;
      break;
    case BK_P_VOCODER_FREQHI:
      e->freq_hi = v;
      e->dirty = 1;
      break;
    case BK_P_VOCODER_Q:
      e->q_factor = bk_max(0.5, v);
      e->dirty = 1;
      break;
    case BK_P_VOCODER_CARRIER: e->carrier_type = bk_clamp(js_round(v), 0.0, 4.0); break;
    case BK_P_VOCODER_PITCH:
      e->carrier_pitch_hz = bk_clamp(v, 20.0, 2000.0);
      if (!e->pitch_follow) bk_smoother_set(&e->pitch_sm, e->carrier_pitch_hz);
      break;
    case BK_P_VOCODER_FOLLOW: e->pitch_follow = v >= 0.5 ? 1 : 0; break;
    case BK_P_VOCODER_DEPTH:
      e->depth = bk_clamp(v, 0.0, 1.0);
      bk_smoother_set(&e->depth_sm, e->depth);
      break;
    case BK_P_VOCODER_TONE:
      e->tone = bk_clamp(v, -1.0, 1.0);
      e->dirty = 1;
      break;
    case BK_P_VOCODER_SIBILANCE: e->sibilance = bk_clamp(v, 0.0, 1.0); break;
    case BK_P_VOCODER_ATTACK:
      e->attack_ms = bk_max(0.2, v);
      for (i = 0; i < BK_VOCODER_MAX_BANDS; i++) bk_env_follower_set_attack(&e->bands[i].env, e->attack_ms);
      break;
    case BK_P_VOCODER_RELEASE:
      e->release_ms = bk_max(2.0, v);
      for (i = 0; i < BK_VOCODER_MAX_BANDS; i++) bk_env_follower_set_release(&e->bands[i].env, e->release_ms);
      break;
    case BK_P_VOCODER_CARRIERLEVEL: e->carrier_level = v; break;
    case BK_P_VOCODER_OUTPUT: bk_smoother_set(&e->out_sm, bk_db_to_gain(v)); break;
    case BK_P_VOCODER_SPREAD:
      e->stereo_spread = bk_clamp(v, 0.0, 1.0);
      e->dirty = 1;
      break;
    case BK_P_VOCODER_SOURCE: e->source = v >= 0.5 ? 1 : 0; break;
    default: break;
  }
}

void bk_vocoder_reset(bk_vocoder *e) {
  int i;
  for (i = 0; i < BK_VOCODER_MAX_BANDS; i++) {
    bk_vocoder_band *b = &e->bands[i];
    bk_biquad_reset(&b->mod_a);
    bk_biquad_reset(&b->mod_b);
    bk_biquad_reset(&b->car_a);
    bk_biquad_reset(&b->car_b);
    bk_env_follower_reset(&b->env);
    b->level = 0.0;
  }
  bk_biquad_reset(&e->sib_hp);
  bk_env_follower_reset(&e->sib_env);
  bk_env_follower_reset(&e->in_env);
  e->car_rms = 0.0;
}

/* The switch on carrierType: an integer in [0, 4] (possibly -0) or NaN, and
   anything but 1-4 is the default saw. */
static double synth_carrier(bk_vocoder *e, double f0) {
  const double t = e->carrier_type;
  if (t == 1.0) {
    bk_oscillator_set_freq(&e->osc1, f0);
    e->osc1.pw = 0.3;
    return bk_oscillator_pulse(&e->osc1);
  }
  if (t == 2.0) {
    double s1, s2;
    bk_oscillator_set_freq(&e->osc1, f0);
    bk_oscillator_set_freq(&e->osc2, f0 * 1.005);
    s1 = bk_oscillator_saw(&e->osc1);
    s2 = bk_oscillator_saw(&e->osc2);
    return (s1 + s2) * 0.5;
  }
  if (t == 3.0) return e->random(e->random_user) * 2.0 - 1.0;
  if (t == 4.0) {
    double s1, s2;
    bk_oscillator_set_freq(&e->osc1, f0);
    bk_oscillator_set_freq(&e->osc_sub, f0 * 0.5);
    s1 = bk_oscillator_saw(&e->osc1) * 0.6;
    s2 = bk_oscillator_pulse(&e->osc_sub) * 0.4;
    return s1 + s2;
  }
  bk_oscillator_set_freq(&e->osc1, f0);
  return bk_oscillator_saw(&e->osc1);
}

void bk_vocoder_process(bk_vocoder *e, float *l, float *r, int frames) {
  int i, k, n;
  double car_gain, inv_n;
  if (e->dirty) rebuild(e);

  if (e->pitch_follow) {
    double hz;
    for (i = 0; i < frames; i++) bk_pitch_tracker_push(&e->tracker, ((double)l[i] + (double)r[i]) * 0.5);
    hz = bk_pitch_tracker_analyze(&e->tracker);
    if (hz > 0.0) {
      e->tracked_hz = hz;
      bk_smoother_set(&e->pitch_sm, hz);
    }
  } else {
    bk_smoother_set(&e->pitch_sm, e->carrier_pitch_hz);
  }

  bk_biquad_set(&e->sib_hp, BK_FILTER_HIGHPASS, 4500.0, 0.7071, 0.0);
  n = active_bands(e);
  car_gain = bk_db_to_gain(e->carrier_level);
  inv_n = 1.0 / sqrt(e->band_count);

  for (i = 0; i < frames; i++) {
    const double mod = ((double)l[i] + (double)r[i]) * 0.5;
    const double depth = bk_smoother_next(&e->depth_sm);
    const double out_g = bk_smoother_next(&e->out_sm);
    const double f0 = bk_smoother_next(&e->pitch_sm);
    double car = synth_carrier(e, f0);
    double sib, in_level, squelch, noise, out_l = 0.0, out_r = 0.0, wet_l, wet_r, bleed;

    if (e->source == 1 && e->car_l) {
      const double c = ((double)e->car_l[i] + (double)e->car_r[i]) * 0.5;
      double rms;
      e->car_rms += (c * c - e->car_rms) * e->car_rms_a;
      rms = sqrt(e->car_rms);
      car = rms > 1e-5 ? c / rms : 0.0;
    }

    sib = bk_env_follower_process(&e->sib_env, bk_biquad_process(&e->sib_hp, mod));
    in_level = bk_env_follower_process(&e->in_env, mod);
    squelch = in_level < 0.0005 ? 0.0 : bk_min(1.0, in_level * 12.0);
    noise = (e->random(e->random_user) * 2.0 - 1.0) * sib * e->sibilance * 6.0;

    for (k = 0; k < n; k++) {
      bk_vocoder_band *b = &e->bands[k];
      const double m = bk_biquad_process(&b->mod_b, bk_biquad_process(&b->mod_a, mod));
      const double ev = bk_env_follower_process(&b->env, m);
      double c_in, c, v;
      b->level = ev;
      /* car + 0 turns a -0 carrier into +0, as the JS does. */
      c_in = car + (b->freq > 3000.0 ? noise : 0.0);
      c = bk_biquad_process(&b->car_b, bk_biquad_process(&b->car_a, c_in));
      v = c * ev * b->gain;
      if (e->stereo_spread > 0.001) {
        const double p = b->pan;
        out_l += v * (1.0 - bk_max(0.0, p));
        out_r += v * (1.0 + bk_min(0.0, p));
      } else {
        out_l += v;
        out_r += v;
      }
    }

    wet_l = out_l * inv_n * 8.0 * depth;
    wet_r = out_r * inv_n * 8.0 * depth;
    bleed = car * car_gain * 0.2 * squelch;
    l[i] = (float)bk_sanitize((wet_l + bleed) * out_g);
    r[i] = (float)bk_sanitize((wet_r + bleed) * out_g);
  }
  e->meter = e->pitch_follow ? e->tracked_hz : 0.0;
}

int bk_vocoder_visual(const bk_vocoder *e, float *out) {
  const int n = active_bands(e);
  int i;
  for (i = 0; i < n; i++) {
    const double lv = e->bands[i].level;
    const double db = lv > 1e-6 ? 20.0 * log10(lv) : -120.0;
    const double v = (db + 60.0) / 60.0;
    out[i] = (float)(v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v);
  }
  return n;
}

static void vt_process(void *s, float *l, float *r, int n) { bk_vocoder_process((bk_vocoder *)s, l, r, n); }
static void vt_reset(void *s) { bk_vocoder_reset((bk_vocoder *)s); }
static void vt_param(void *s, int k, double v) { bk_vocoder_set_param((bk_vocoder *)s, k, v); }
static void vt_bus(void *s, const float *l, const float *r) {
  bk_vocoder_set_carrier_bus((bk_vocoder *)s, l, r);
}
static double vt_meter(const void *s) { return ((const bk_vocoder *)s)->meter; }
const bk_effect_vt bk_vocoder_vt = {vt_process, vt_reset, vt_param, vt_bus, NULL, vt_meter};
