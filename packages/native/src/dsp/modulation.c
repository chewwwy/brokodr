/* Bro.Kodr — port of dsp/effects/modulation.js; contract in modulation.h. */
#include "brokodr/dsp/modulation.h"
#include <math.h>

static double js_round(double x) {
  const double r = floor(x);
  const double y = (x - r >= 0.5) ? r + 1.0 : r;
  return y == 0.0 && x < 0.0 ? -0.0 : y;
}
/* Preserve the LFO default branch without casting NaN/inf to an int. */
static int lfo_shape(double x) {
  const double y = js_round(x);
  return y >= 0.0 && y <= 4.0 ? (int)y : -1;
}
static void random_init(bk_mod_random *r) {
  r->fn = NULL;
  r->user = NULL;
  bk_rng_seed(&r->rng, 0x9e3779b9u);
}
static double lfo_next(bk_lfo *l, bk_mod_random *r) {
  double draw = 0.0;
  if (l->shape == BK_LFO_SAMPLE_HOLD && l->phase + l->inc >= 1.0) {
    draw = r->fn ? r->fn(r->user) * 2.0 - 1.0 : bk_rng_bipolar(&r->rng);
  }
  return bk_lfo_next_with(l, draw);
}
#define RANDOM_API(name) \
  void bk_##name##_set_random(bk_##name *e, bk_random_fn fn, void *user) { \
    e->random.fn = fn; e->random.user = user; \
  }
RANDOM_API(flanger)
RANDOM_API(phaser)
RANDOM_API(tremolo)
#undef RANDOM_API

/* --- Chorus ------------------------------------------------------------- */
size_t bk_chorus_storage_floats(double sr) {
  return 2u * (size_t)bk_delay_line_size(ceil(sr * 0.05));
}
void bk_chorus_init(bk_chorus *e, double sr, float *storage) {
  const double max_delay = ceil(sr * 0.05);
  const int line = bk_delay_line_size(max_delay);
  int i;
  e->sr = sr;
  e->voices = 3.0;
  bk_delay_line_init(&e->lines[0], storage, max_delay);
  bk_delay_line_init(&e->lines[1], storage + line, max_delay);
  for (i = 0; i < 6; i++) {
    bk_lfo_init(&e->lfos[i], sr);
    bk_lfo_set_rate(&e->lfos[i], 0.4);
    bk_lfo_set_phase(&e->lfos[i], (double)i / 6.0);
  }
  bk_smoother_init(&e->rate_sm, sr, 30.0, 0.4);
  bk_smoother_init(&e->depth_sm, sr, 30.0, 0.003);
  bk_smoother_init(&e->delay_sm, sr, 30.0, 0.012);
  e->spread = 1.0;
  e->feedback = 0.0;
  bk_biquad_init(&e->hp[0], sr);
  bk_biquad_init(&e->hp[1], sr);
  e->fb_l = e->fb_r = 0.0;
}
void bk_chorus_set_param(bk_chorus *e, int key, double v) {
  int i;
  switch (key) {
    case BK_P_CHORUS_RATE:
      bk_smoother_set(&e->rate_sm, v);
      for (i = 0; i < 6; i++) bk_lfo_set_rate(&e->lfos[i], v * (1.0 + i * 0.07));
      break;
    case BK_P_CHORUS_DEPTH: bk_smoother_set(&e->depth_sm, v * 0.008); break;
    case BK_P_CHORUS_DELAY: bk_smoother_set(&e->delay_sm, v * 0.001); break;
    case BK_P_CHORUS_VOICES: e->voices = bk_clamp(js_round(v), 1.0, 3.0); break;
    case BK_P_CHORUS_SPREAD: e->spread = bk_clamp(v, 0.0, 1.0); break;
    case BK_P_CHORUS_FEEDBACK: e->feedback = bk_clamp(v, -0.95, 0.95); break;
    default: break;
  }
}
void bk_chorus_reset(bk_chorus *e) {
  bk_delay_line_clear(&e->lines[0]);
  bk_delay_line_clear(&e->lines[1]);
  e->fb_l = e->fb_r = 0.0;
}
void bk_chorus_process(bk_chorus *e, float *l, float *r, int frames) {
  int i, v;
  const double n = e->voices;
  bk_biquad_set(&e->hp[0], BK_FILTER_HIGHPASS, 120.0, 0.7071, 0.0);
  bk_biquad_set(&e->hp[1], BK_FILTER_HIGHPASS, 120.0, 0.7071, 0.0);
  for (i = 0; i < frames; i++) {
    const double depth = bk_smoother_next(&e->depth_sm) * e->sr;
    const double base = bk_smoother_next(&e->delay_sm) * e->sr;
    double sum_l = 0.0, sum_r = 0.0, g;
    bk_smoother_next(&e->rate_sm);
    bk_delay_line_write(&e->lines[0], (double)l[i] + e->fb_l * e->feedback);
    bk_delay_line_write(&e->lines[1], (double)r[i] + e->fb_r * e->feedback);
    for (v = 0; v < n; v++) {
      const double ml = bk_lfo_next_with(&e->lfos[v * 2], 0.0);
      const double mr = bk_lfo_next_with(&e->lfos[v * 2 + 1], 0.0);
      const double dl = base + depth * (0.5 + 0.5 * ml) + v * base * 0.35;
      const double dr = base + depth * (0.5 + 0.5 * mr) + v * base * 0.35;
      const double sl = bk_delay_line_read_cubic(&e->lines[0], dl);
      const double sr = bk_delay_line_read_cubic(&e->lines[1], dr);
      const double pan_l = v % 2 == 0 ? 1.0 : 1.0 - e->spread * 0.7;
      const double pan_r = v % 2 == 0 ? 1.0 - e->spread * 0.7 : 1.0;
      sum_l += sl * pan_l;
      sum_r += sr * pan_r;
    }
    g = 1.0 / n;
    e->fb_l = bk_sanitize(bk_biquad_process(&e->hp[0], sum_l * g));
    e->fb_r = bk_sanitize(bk_biquad_process(&e->hp[1], sum_r * g));
    l[i] = (float)bk_sanitize(sum_l * g);
    r[i] = (float)bk_sanitize(sum_r * g);
  }
}

/* --- Flanger ------------------------------------------------------------ */
size_t bk_flanger_storage_floats(double sr) {
  return 2u * (size_t)bk_delay_line_size(ceil(sr * 0.03));
}
void bk_flanger_init(bk_flanger *e, double sr, float *storage) {
  const double max_delay = ceil(sr * 0.03);
  const int line = bk_delay_line_size(max_delay);
  int i;
  e->sr = sr;
  bk_delay_line_init(&e->lines[0], storage, max_delay);
  bk_delay_line_init(&e->lines[1], storage + line, max_delay);
  for (i = 0; i < 2; i++) {
    bk_lfo_init(&e->lfo[i], sr);
    bk_lfo_set_rate(&e->lfo[i], 0.25);
    bk_biquad_init(&e->damp[i], sr);
  }
  bk_lfo_set_phase(&e->lfo[1], 0.25);
  bk_smoother_init(&e->depth_sm, sr, 30.0, 0.002);
  bk_smoother_init(&e->delay_sm, sr, 30.0, 0.001);
  e->feedback = 0.5;
  e->invert = 0;
  e->damp_freq = 8000.0;
  e->fb_l = e->fb_r = 0.0;
  e->stereo_phase = 0.25;
  random_init(&e->random);
}
void bk_flanger_set_param(bk_flanger *e, int key, double v) {
  switch (key) {
    case BK_P_FLANGER_RATE: bk_lfo_set_rate(&e->lfo[0], v); bk_lfo_set_rate(&e->lfo[1], v); break;
    case BK_P_FLANGER_DEPTH: bk_smoother_set(&e->depth_sm, v * 0.005); break;
    case BK_P_FLANGER_DELAY: bk_smoother_set(&e->delay_sm, v * 0.001); break;
    case BK_P_FLANGER_FEEDBACK: e->feedback = bk_clamp(v, -0.98, 0.98); break;
    case BK_P_FLANGER_INVERT: e->invert = v >= 0.5 ? 1 : 0; break;
    case BK_P_FLANGER_DAMP: e->damp_freq = v; break;
    case BK_P_FLANGER_STEREO:
      e->stereo_phase = bk_clamp(v, 0.0, 0.5);
      bk_lfo_set_phase(&e->lfo[1], e->lfo[0].phase + e->stereo_phase);
      break;
    case BK_P_FLANGER_SHAPE: e->lfo[0].shape = e->lfo[1].shape = lfo_shape(v); break;
    default: break;
  }
}
void bk_flanger_reset(bk_flanger *e) {
  bk_delay_line_clear(&e->lines[0]); bk_delay_line_clear(&e->lines[1]);
  e->fb_l = e->fb_r = 0.0;
  bk_biquad_reset(&e->damp[0]); bk_biquad_reset(&e->damp[1]);
}
void bk_flanger_process(bk_flanger *e, float *l, float *r, int frames) {
  const double sign = e->invert ? -1.0 : 1.0;
  int i;
  bk_biquad_set(&e->damp[0], BK_FILTER_LOWPASS, e->damp_freq, 0.7071, 0.0);
  bk_biquad_set(&e->damp[1], BK_FILTER_LOWPASS, e->damp_freq, 0.7071, 0.0);
  for (i = 0; i < frames; i++) {
    const double depth = bk_smoother_next(&e->depth_sm) * e->sr;
    const double base = bk_smoother_next(&e->delay_sm) * e->sr;
    const double dl = base + depth * (0.5 + 0.5 * lfo_next(&e->lfo[0], &e->random));
    const double dr = base + depth * (0.5 + 0.5 * lfo_next(&e->lfo[1], &e->random));
    double wl, wr;
    bk_delay_line_write(&e->lines[0], (double)l[i] + e->fb_l * e->feedback * sign);
    bk_delay_line_write(&e->lines[1], (double)r[i] + e->fb_r * e->feedback * sign);
    wl = bk_delay_line_read_cubic(&e->lines[0], dl);
    wr = bk_delay_line_read_cubic(&e->lines[1], dr);
    e->fb_l = bk_sanitize(bk_biquad_process(&e->damp[0], wl));
    e->fb_r = bk_sanitize(bk_biquad_process(&e->damp[1], wr));
    l[i] = (float)bk_sanitize(wl); r[i] = (float)bk_sanitize(wr);
  }
}

/* --- Phaser ------------------------------------------------------------- */
void bk_phaser_init(bk_phaser *e, double sr) {
  int c, i;
  e->sr = sr; e->stages = 4.0;
  for (c = 0; c < 2; c++) {
    for (i = 0; i < 8; i++) bk_biquad_init(&e->ap[c][i], sr);
    bk_lfo_init(&e->lfo[c], sr); bk_lfo_set_rate(&e->lfo[c], 0.3);
  }
  bk_lfo_set_phase(&e->lfo[1], 0.25);
  bk_smoother_init(&e->center_sm, sr, 30.0, 800.0);
  bk_smoother_init(&e->depth_sm, sr, 30.0, 0.7);
  e->feedback = 0.3; e->q = 0.7; e->fb_l = e->fb_r = 0.0; e->stereo = 0.25;
  random_init(&e->random);
}
void bk_phaser_set_param(bk_phaser *e, int key, double v) {
  switch (key) {
    case BK_P_PHASER_RATE: bk_lfo_set_rate(&e->lfo[0], v); bk_lfo_set_rate(&e->lfo[1], v); break;
    case BK_P_PHASER_DEPTH: bk_smoother_set(&e->depth_sm, bk_clamp(v, 0.0, 1.0)); break;
    case BK_P_PHASER_CENTER: bk_smoother_set(&e->center_sm, v); break;
    case BK_P_PHASER_STAGES: e->stages = bk_clamp(js_round(v), 1.0, 8.0); break;
    case BK_P_PHASER_FEEDBACK: e->feedback = bk_clamp(v, -0.95, 0.95); break;
    case BK_P_PHASER_Q: e->q = bk_max(0.2, v); break;
    case BK_P_PHASER_STEREO:
      e->stereo = bk_clamp(v, 0.0, 0.5);
      bk_lfo_set_phase(&e->lfo[1], e->lfo[0].phase + e->stereo); break;
    case BK_P_PHASER_SHAPE: e->lfo[0].shape = e->lfo[1].shape = lfo_shape(v); break;
    default: break;
  }
}
void bk_phaser_reset(bk_phaser *e) {
  int c, s;
  for (c = 0; c < 2; c++) for (s = 0; s < 8; s++) bk_biquad_reset(&e->ap[c][s]);
  e->fb_l = e->fb_r = 0.0;
}
void bk_phaser_process(bk_phaser *e, float *l, float *r, int frames) {
  const double n = e->stages;
  const double center = bk_smoother_next(&e->center_sm);
  const double depth = bk_smoother_next(&e->depth_sm);
  double ml, mr, octaves, fl, fr;
  int i, s;
  for (i = 1; i < frames; i++) { bk_smoother_next(&e->center_sm); bk_smoother_next(&e->depth_sm); }
  ml = lfo_next(&e->lfo[0], &e->random);
  mr = lfo_next(&e->lfo[1], &e->random);
  for (i = 1; i < frames; i++) { lfo_next(&e->lfo[0], &e->random); lfo_next(&e->lfo[1], &e->random); }
  octaves = depth * 3.0;
  fl = bk_clamp(center * pow(2.0, ml * octaves), 40.0, e->sr * 0.45);
  fr = bk_clamp(center * pow(2.0, mr * octaves), 40.0, e->sr * 0.45);
  for (s = 0; s < n; s++) {
    const double spread = pow(1.4, (double)s);
    bk_biquad_set(&e->ap[0][s], BK_FILTER_ALLPASS, bk_clamp(fl * spread, 40.0, e->sr * 0.45), e->q, 0.0);
    bk_biquad_set(&e->ap[1][s], BK_FILTER_ALLPASS, bk_clamp(fr * spread, 40.0, e->sr * 0.45), e->q, 0.0);
  }
  for (i = 0; i < frames; i++) {
    double xl = (double)l[i] + e->fb_l * e->feedback;
    double xr = (double)r[i] + e->fb_r * e->feedback;
    for (s = 0; s < n; s++) { xl = bk_biquad_process(&e->ap[0][s], xl); xr = bk_biquad_process(&e->ap[1][s], xr); }
    e->fb_l = bk_sanitize(xl); e->fb_r = bk_sanitize(xr);
    l[i] = (float)bk_sanitize(xl); r[i] = (float)bk_sanitize(xr);
  }
}

/* --- Tremolo ------------------------------------------------------------ */
void bk_tremolo_init(bk_tremolo *e, double sr) {
  int i;
  e->sr = sr;
  for (i = 0; i < 2; i++) { bk_lfo_init(&e->lfo[i], sr); bk_lfo_set_rate(&e->lfo[i], 5.0); }
  bk_lfo_set_phase(&e->lfo[1], 0.5);
  bk_smoother_init(&e->depth_sm, sr, 20.0, 0.5);
  e->stereo_mode = 0.0; e->phase_offset = 0.5; e->smoothness = 1.0;
  random_init(&e->random);
}
void bk_tremolo_set_param(bk_tremolo *e, int key, double v) {
  switch (key) {
    case BK_P_TREMOLO_RATE: bk_lfo_set_rate(&e->lfo[0], v); bk_lfo_set_rate(&e->lfo[1], v); break;
    case BK_P_TREMOLO_DEPTH: bk_smoother_set(&e->depth_sm, bk_clamp(v, 0.0, 1.0)); break;
    case BK_P_TREMOLO_SHAPE: e->lfo[0].shape = e->lfo[1].shape = lfo_shape(v); break;
    case BK_P_TREMOLO_MODE: e->stereo_mode = js_round(v); break;
    case BK_P_TREMOLO_PHASE:
      e->phase_offset = bk_clamp(v, 0.0, 1.0);
      bk_lfo_set_phase(&e->lfo[1], e->lfo[0].phase + e->phase_offset); break;
    default: break;
  }
}
void bk_tremolo_reset(bk_tremolo *e) { (void)e; }
void bk_tremolo_process(bk_tremolo *e, float *l, float *r, int frames) {
  int i;
  for (i = 0; i < frames; i++) {
    const double d = bk_smoother_next(&e->depth_sm);
    const double a = lfo_next(&e->lfo[0], &e->random);
    const double b = lfo_next(&e->lfo[1], &e->random);
    if (e->stereo_mode == 1.0) {
      const double gl = 1.0 - d * (0.5 + 0.5 * a);
      const double gr = 1.0 - d * (0.5 - 0.5 * a);
      l[i] = (float)((double)l[i] * gl); r[i] = (float)((double)r[i] * gr);
    } else {
      l[i] = (float)((double)l[i] * (1.0 - d * (0.5 + 0.5 * a)));
      r[i] = (float)((double)r[i] * (1.0 - d * (0.5 + 0.5 * b)));
    }
  }
}

/* --- RingMod ------------------------------------------------------------ */
void bk_ring_mod_init(bk_ring_mod *e, double sr) {
  e->sr = sr; bk_oscillator_init(&e->osc, sr);
  bk_smoother_init(&e->freq_sm, sr, 25.0, 200.0);
  e->shape = 0.0; e->am_mode = 0;
  bk_lfo_init(&e->lfo, sr); bk_lfo_set_rate(&e->lfo, 0.0);
  e->sweep_depth = 0.0; e->phase = 0.0;
}
void bk_ring_mod_set_param(bk_ring_mod *e, int key, double v) {
  switch (key) {
    case BK_P_RINGMOD_FREQ: bk_smoother_set(&e->freq_sm, v); break;
    case BK_P_RINGMOD_SHAPE: e->shape = js_round(v); break;
    case BK_P_RINGMOD_MODE: e->am_mode = v >= 0.5 ? 1 : 0; break;
    case BK_P_RINGMOD_SWEEPRATE: bk_lfo_set_rate(&e->lfo, v); break;
    case BK_P_RINGMOD_SWEEPDEPTH: e->sweep_depth = bk_clamp(v, 0.0, 1.0); break;
    default: break;
  }
}
void bk_ring_mod_reset(bk_ring_mod *e) { (void)e; }
void bk_ring_mod_process(bk_ring_mod *e, float *l, float *r, int frames) {
  int i;
  for (i = 0; i < frames; i++) {
    double f = bk_smoother_next(&e->freq_sm), c, m;
    if (e->sweep_depth > 0.001) f *= pow(2.0, bk_lfo_next_with(&e->lfo, 0.0) * e->sweep_depth * 2.0);
    bk_oscillator_set_freq(&e->osc, f);
    if (e->shape == 1.0) c = bk_oscillator_saw(&e->osc);
    else if (e->shape == 2.0) { e->osc.pw = 0.5; c = bk_oscillator_pulse(&e->osc); }
    else {
      e->phase += f / e->sr;
      if (e->phase >= 1.0) e->phase -= 1.0;
      c = sin(BK_TWO_PI * e->phase);
    }
    m = e->am_mode ? 0.5 + 0.5 * c : c;
    l[i] = (float)bk_sanitize((double)l[i] * m);
    r[i] = (float)bk_sanitize((double)r[i] * m);
  }
}

/* --- FrequencyShifter --------------------------------------------------- */
static void mk_chain(bk_hilbert_section *s, const double *coef) {
  int i;
  for (i = 0; i < 4; i++) {
    s[i].a = coef[i] * coef[i];
    s[i].x1 = s[i].x2 = s[i].y1 = s[i].y2 = 0.0;
  }
}
static double allpass(bk_hilbert_section *s, double x) {
  int i;
  for (i = 0; i < 4; i++) {
    const double y = s[i].a * (x + s[i].y2) - s[i].x2;
    s[i].x2 = s[i].x1; s[i].x1 = x;
    s[i].y2 = s[i].y1; s[i].y1 = y;
    x = bk_sanitize(y);
  }
  return x;
}
void bk_frequency_shifter_init(bk_frequency_shifter *e, double sr) {
  static const double a[4] = {0.6923878, 0.9360654322959, 0.9882295226860, 0.9987488452737};
  static const double b[4] = {0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278};
  int i, c;
  e->sr = sr;
  for (i = 0; i < 4; i++) { e->coef_a[i] = a[i]; e->coef_b[i] = b[i]; }
  for (c = 0; c < 2; c++) { mk_chain(e->state_a[c], e->coef_a); mk_chain(e->state_b[c], e->coef_b); e->delay_a[c] = 0.0; }
  bk_smoother_init(&e->freq_sm, sr, 25.0, 0.0);
  e->phase = 0.0; e->feedback = 0.0; e->fb_l = e->fb_r = 0.0;
}
void bk_frequency_shifter_set_param(bk_frequency_shifter *e, int key, double v) {
  if (key == BK_P_FREQSHIFT_FREQ) bk_smoother_set(&e->freq_sm, v);
  else if (key == BK_P_FREQSHIFT_FEEDBACK) e->feedback = bk_clamp(v, 0.0, 0.9);
}
void bk_frequency_shifter_reset(bk_frequency_shifter *e) {
  int c;
  for (c = 0; c < 2; c++) { mk_chain(e->state_a[c], e->coef_a); mk_chain(e->state_b[c], e->coef_b); }
  e->fb_l = e->fb_r = 0.0;
}
void bk_frequency_shifter_process(bk_frequency_shifter *e, float *l, float *r, int frames) {
  int i, c;
  for (i = 0; i < frames; i++) {
    const double f = bk_smoother_next(&e->freq_sm);
    double co, si;
    e->phase += f / e->sr;
    if (e->phase >= 1.0) e->phase -= 1.0;
    else if (e->phase < 0.0) e->phase += 1.0;
    co = cos(BK_TWO_PI * e->phase); si = sin(BK_TWO_PI * e->phase);
    for (c = 0; c < 2; c++) {
      float *buf = c == 0 ? l : r;
      const double fb = c == 0 ? e->fb_l : e->fb_r;
      const double x = (double)buf[i] + fb * e->feedback;
      const double a = allpass(e->state_a[c], x);
      const double b = allpass(e->state_b[c], x);
      const double delayed = e->delay_a[c];
      double out;
      e->delay_a[c] = a;
      out = bk_sanitize(delayed * co - b * si);
      if (c == 0) e->fb_l = out; else e->fb_r = out;
      buf[i] = (float)out;
    }
  }
}

/* Effect inherits meter=0; expose that, no carrier or latency hooks. */
static double zero_meter(const void *self) { (void)self; return 0.0; }
#define VT(name) \
  static void name##_process(void *s, float *l, float *r, int n) { bk_##name##_process((bk_##name *)s, l, r, n); } \
  static void name##_reset(void *s) { bk_##name##_reset((bk_##name *)s); } \
  static void name##_param(void *s, int k, double v) { bk_##name##_set_param((bk_##name *)s, k, v); } \
  const bk_effect_vt bk_##name##_vt = {name##_process, name##_reset, name##_param, NULL, NULL, zero_meter}
VT(chorus);
VT(flanger);
VT(phaser);
VT(tremolo);
VT(ring_mod);
VT(frequency_shifter);
#undef VT