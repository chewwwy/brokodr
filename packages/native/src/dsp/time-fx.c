/* Bro.Kodr — port of dsp/effects/time.js; contract in time-fx.h. */
#include "brokodr/dsp/time-fx.h"
#include <math.h>

static double js_round(double x) {
  const double r = floor(x);
  const double y = (x - r >= 0.5) ? r + 1.0 : r;
  return y == 0.0 && x < 0.0 ? -0.0 : y;
}

/* --- Delay -------------------------------------------------------------- */
size_t bk_delay_storage_floats(double sr) {
  return 2u * (size_t)bk_delay_line_size(ceil(sr * 4.0));
}
void bk_delay_init(bk_delay *e, double sr, float *storage) {
  const double max_samples = ceil(sr * 4.0);
  const int line = bk_delay_line_size(max_samples);
  e->sr = sr;
  bk_delay_line_init(&e->line_l, storage, max_samples);
  bk_delay_line_init(&e->line_r, storage + line, max_samples);
  bk_smoother_init(&e->time_l, sr, 120.0, 0.25);
  bk_smoother_init(&e->time_r, sr, 120.0, 0.25);
  e->feedback = 0.35;
  e->pingpong = 0;
  e->lp_freq = 6000.0;
  e->hp_freq = 180.0;
  bk_biquad_init(&e->lp_l, sr);
  bk_biquad_init(&e->lp_r, sr);
  bk_biquad_init(&e->hp_l, sr);
  bk_biquad_init(&e->hp_r, sr);
  e->fb_l = e->fb_r = 0.0;
  bk_lfo_init(&e->lfo, sr);
  bk_lfo_set_rate(&e->lfo, 0.3);
  e->mod_depth = 0.0;
  e->spread = 0.0;
  e->bpm = 120.0;
  e->sync_div = 0.0;
  e->time_ms = 250.0;
  e->crossfeed = 0.0;
  e->saturate = 0.0;
}
static void delay_apply_time(bk_delay *e) {
  double ms = e->time_ms, sec;
  if (e->sync_div > 0.0) {
    /* 1=1/1 2=1/2 3=1/4 4=1/8 5=1/16 6=1/4T 7=1/8T 8=1/8D 9=1/16D */
    const double beat = 60000.0 / e->bpm;
    const double table[10] = {0.0,        beat * 4.0, beat * 2.0, beat,        beat / 2.0,
                              beat / 4.0, beat / 1.5, beat / 3.0, beat * 0.75, beat * 0.375};
    /* sync_div is a positive integer or +inf here, so the index is 1..9. */
    ms = table[(int)bk_clamp(e->sync_div, 0.0, 9.0)];
  }
  sec = bk_clamp(ms, 1.0, 3900.0) * 0.001;
  bk_smoother_set(&e->time_l, sec);
  bk_smoother_set(&e->time_r, sec * (1.0 + e->spread * 0.5));
}
void bk_delay_set_param(bk_delay *e, int key, double v) {
  switch (key) {
    case BK_P_DELAY_TIME: e->time_ms = v; delay_apply_time(e); break;
    case BK_P_DELAY_SYNC: e->sync_div = js_round(v); delay_apply_time(e); break;
    case BK_P_DELAY_BPM: e->bpm = bk_clamp(v, 20.0, 300.0); delay_apply_time(e); break;
    case BK_P_DELAY_FEEDBACK: e->feedback = bk_clamp(v, 0.0, 1.1); break;
    case BK_P_DELAY_PINGPONG: e->pingpong = v >= 0.5 ? 1 : 0; break;
    case BK_P_DELAY_LOWPASS: e->lp_freq = v; break;
    case BK_P_DELAY_HIGHPASS: e->hp_freq = v; break;
    case BK_P_DELAY_MODDEPTH: e->mod_depth = bk_clamp(v, 0.0, 1.0); break;
    case BK_P_DELAY_MODRATE: bk_lfo_set_rate(&e->lfo, v); break;
    case BK_P_DELAY_SPREAD: e->spread = bk_clamp(v, 0.0, 1.0); delay_apply_time(e); break;
    case BK_P_DELAY_CROSSFEED: e->crossfeed = bk_clamp(v, 0.0, 1.0); break;
    case BK_P_DELAY_SATURATE: e->saturate = bk_clamp(v, 0.0, 1.0); break;
    default: break;
  }
}
void bk_delay_reset(bk_delay *e) {
  bk_delay_line_clear(&e->line_l);
  bk_delay_line_clear(&e->line_r);
  e->fb_l = e->fb_r = 0.0;
  bk_biquad_reset(&e->lp_l);
  bk_biquad_reset(&e->lp_r);
  bk_biquad_reset(&e->hp_l);
  bk_biquad_reset(&e->hp_r);
}
void bk_delay_process(bk_delay *e, float *l, float *r, int frames) {
  const double drive = 1.0 + e->saturate * 3.0;
  int i;
  bk_biquad_set(&e->lp_l, BK_FILTER_LOWPASS, e->lp_freq, 0.7071, 0.0);
  bk_biquad_set(&e->lp_r, BK_FILTER_LOWPASS, e->lp_freq, 0.7071, 0.0);
  bk_biquad_set(&e->hp_l, BK_FILTER_HIGHPASS, e->hp_freq, 0.7071, 0.0);
  bk_biquad_set(&e->hp_r, BK_FILTER_HIGHPASS, e->hp_freq, 0.7071, 0.0);
  for (i = 0; i < frames; i++) {
    const double mod = bk_lfo_next_with(&e->lfo, 0.0) * e->mod_depth * 0.002 * e->sr;
    const double dl = bk_smoother_next(&e->time_l) * e->sr + mod;
    const double dr = bk_smoother_next(&e->time_r) * e->sr - mod;
    const double in_l = l[i], in_r = r[i];
    const double wl =
        bk_delay_line_read_cubic(&e->line_l, bk_clamp(dl, 1.0, (double)(e->line_l.size - 4)));
    const double wr =
        bk_delay_line_read_cubic(&e->line_r, bk_clamp(dr, 1.0, (double)(e->line_r.size - 4)));
    double fl = bk_biquad_process(&e->hp_l, bk_biquad_process(&e->lp_l, wl));
    double fr = bk_biquad_process(&e->hp_r, bk_biquad_process(&e->lp_r, wr));
    if (e->saturate > 0.001) {
      fl = tanh(fl * drive) / drive;
      fr = tanh(fr * drive) / drive;
    }
    if (e->pingpong) {
      bk_delay_line_write(&e->line_l, bk_sanitize(in_l + in_r * 0.5 + fr * e->feedback));
      bk_delay_line_write(&e->line_r, bk_sanitize(fl * e->feedback));
    } else {
      const double xl = fl * (1.0 - e->crossfeed) + fr * e->crossfeed;
      const double xr = fr * (1.0 - e->crossfeed) + fl * e->crossfeed;
      bk_delay_line_write(&e->line_l, bk_sanitize(in_l + xl * e->feedback));
      bk_delay_line_write(&e->line_r, bk_sanitize(in_r + xr * e->feedback));
    }
    l[i] = (float)bk_sanitize(wl);
    r[i] = (float)bk_sanitize(wr);
  }
}

/* --- Reverb ------------------------------------------------------------- */
static const double base_ms[BK_REVERB_LINES] = {23.7, 29.3, 37.1, 41.9, 47.3, 53.1, 59.7, 67.3};
static const double diff_sec[2][4] = {{0.0047, 0.0089, 0.0131, 0.0173},
                                      {0.0051, 0.0093, 0.0137, 0.0181}};
static double line_max(int k, double sr) { return ceil((base_ms[k] * 3.5 * sr) / 1000.0) + 8.0; }
static double pre_max(double sr) { return ceil(sr * 0.25) + 8.0; }

size_t bk_reverb_storage_floats(double sr) {
  size_t n = 2u * (size_t)bk_delay_line_size(pre_max(sr));
  int k, c;
  for (k = 0; k < BK_REVERB_LINES; k++) n += (size_t)bk_delay_line_size(line_max(k, sr));
  for (c = 0; c < 2; c++)
    for (k = 0; k < 4; k++) n += (size_t)bk_delay_line_size(js_round(sr * diff_sec[c][k]));
  return n;
}
void bk_reverb_init(bk_reverb *e, double sr, float *storage) {
  int k;
  e->sr = sr;
  for (k = 0; k < BK_REVERB_LINES; k++) {
    const double m = line_max(k, sr);
    bk_delay_line_init(&e->lines[k], storage, m);
    storage += bk_delay_line_size(m);
    e->damp_state[k] = 0.0;
  }
  for (k = 0; k < 4; k++) {
    const double ml = js_round(sr * diff_sec[0][k]);
    bk_allpass_init(&e->diff_l[k], storage, ml);
    storage += bk_delay_line_size(ml);
  }
  for (k = 0; k < 4; k++) {
    const double mr = js_round(sr * diff_sec[1][k]);
    bk_allpass_init(&e->diff_r[k], storage, mr);
    storage += bk_delay_line_size(mr);
  }
  bk_delay_line_init(&e->pre_l, storage, pre_max(sr));
  storage += bk_delay_line_size(pre_max(sr));
  bk_delay_line_init(&e->pre_r, storage, pre_max(sr));
  bk_smoother_init(&e->size_sm, sr, 200.0, 1.0);
  bk_smoother_init(&e->decay_sm, sr, 200.0, 0.75);
  bk_smoother_init(&e->damp_sm, sr, 100.0, 0.4);
  bk_smoother_init(&e->predelay_sm, sr, 100.0, 0.02);
  e->width = 1.0;
  e->hp_freq = 120.0;
  bk_biquad_init(&e->hp_l, sr);
  bk_biquad_init(&e->hp_r, sr);
  e->mod_depth = 0.15;
  for (k = 0; k < BK_REVERB_LINES; k++) {
    bk_lfo_init(&e->lfos[k], sr);
    /* Two statements on purpose: clang's default -ffp-contract=on may fuse
       `0.11 + k * 0.037` into one fma within an expression, and emcc -O2 does so when
       it constant-folds this loop (0.221 instead of the JS 0.22099999999999997 at k=3).
       Contraction never crosses a statement boundary. */
    const double step = k * 0.037;
    bk_lfo_set_rate(&e->lfos[k], 0.11 + step);
    bk_lfo_set_phase(&e->lfos[k], (double)k / BK_REVERB_LINES);
    e->tmp[k] = 0.0f;
  }
  e->diffusion = 0.6;
}
void bk_reverb_set_param(bk_reverb *e, int key, double v) {
  int k;
  switch (key) {
    case BK_P_REVERB_SIZE: bk_smoother_set(&e->size_sm, bk_clamp(v, 0.2, 3.0)); break;
    case BK_P_REVERB_DECAY: bk_smoother_set(&e->decay_sm, bk_clamp(v, 0.0, 0.995)); break;
    case BK_P_REVERB_DAMPING: bk_smoother_set(&e->damp_sm, bk_clamp(v, 0.0, 0.99)); break;
    case BK_P_REVERB_PREDELAY:
      bk_smoother_set(&e->predelay_sm, bk_clamp(v, 0.0, 200.0) * 0.001);
      break;
    case BK_P_REVERB_WIDTH: e->width = bk_clamp(v, 0.0, 1.0); break;
    case BK_P_REVERB_HIGHPASS: e->hp_freq = v; break;
    case BK_P_REVERB_MODULATION: e->mod_depth = bk_clamp(v, 0.0, 1.0); break;
    case BK_P_REVERB_DIFFUSION:
      e->diffusion = bk_clamp(v, 0.0, 0.9);
      for (k = 0; k < 4; k++) e->diff_l[k].g = e->diffusion;
      for (k = 0; k < 4; k++) e->diff_r[k].g = e->diffusion;
      break;
    default: break;
  }
}
void bk_reverb_reset(bk_reverb *e) {
  int k;
  for (k = 0; k < BK_REVERB_LINES; k++) bk_delay_line_clear(&e->lines[k]);
  for (k = 0; k < 4; k++) bk_allpass_clear(&e->diff_l[k]);
  for (k = 0; k < 4; k++) bk_allpass_clear(&e->diff_r[k]);
  bk_delay_line_clear(&e->pre_l);
  bk_delay_line_clear(&e->pre_r);
  for (k = 0; k < BK_REVERB_LINES; k++) e->damp_state[k] = 0.0;
  bk_biquad_reset(&e->hp_l);
  bk_biquad_reset(&e->hp_r);
}
/* In-place butterfly on the float scratch: every store rounds to float. */
static void hadamard(float *v) {
  int step, i, j;
  const double s = 1.0 / sqrt(8.0);
  for (step = 1; step < 8; step <<= 1) {
    for (i = 0; i < 8; i += step << 1) {
      for (j = i; j < i + step; j++) {
        const double a = v[j], b = v[j + step];
        v[j] = (float)(a + b);
        v[j + step] = (float)(a - b);
      }
    }
  }
  for (i = 0; i < 8; i++) v[i] = (float)((double)v[i] * s);
}
void bk_reverb_process(bk_reverb *e, float *l, float *r, int frames) {
  int i, k;
  bk_biquad_set(&e->hp_l, BK_FILTER_HIGHPASS, e->hp_freq, 0.7071, 0.0);
  bk_biquad_set(&e->hp_r, BK_FILTER_HIGHPASS, e->hp_freq, 0.7071, 0.0);
  for (i = 0; i < frames; i++) {
    const double size = bk_smoother_next(&e->size_sm);
    const double decay = bk_smoother_next(&e->decay_sm);
    const double damp_amt = bk_smoother_next(&e->damp_sm);
    const double pre = bk_smoother_next(&e->predelay_sm) * e->sr;
    double in_l = bk_biquad_process(&e->hp_l, l[i]);
    double in_r = bk_biquad_process(&e->hp_r, r[i]);
    double dl, dr, out_l = 0.0, out_r = 0.0, mid, side;
    bk_delay_line_write(&e->pre_l, in_l);
    bk_delay_line_write(&e->pre_r, in_r);
    in_l = bk_delay_line_read(&e->pre_l, pre);
    in_r = bk_delay_line_read(&e->pre_r, pre);
    dl = in_l;
    dr = in_r;
    for (k = 0; k < 4; k++) {
      dl = bk_allpass_process(&e->diff_l[k], dl);
      dr = bk_allpass_process(&e->diff_r[k], dr);
    }
    for (k = 0; k < BK_REVERB_LINES; k++) {
      double d = (base_ms[k] * size * e->sr) / 1000.0, s;
      if (e->mod_depth > 0.001)
        d += bk_lfo_next_with(&e->lfos[k], 0.0) * e->mod_depth * 0.0008 * e->sr;
      else
        bk_lfo_next_with(&e->lfos[k], 0.0);
      s = bk_delay_line_read_cubic(&e->lines[k], bk_clamp(d, 2.0, (double)(e->lines[k].size - 4)));
      e->damp_state[k] = s + (e->damp_state[k] - s) * damp_amt;
      e->tmp[k] = (float)bk_sanitize(e->damp_state[k]);
    }
    for (k = 0; k < BK_REVERB_LINES; k++) {
      if (k % 2 == 0) out_l += e->tmp[k];
      else out_r += e->tmp[k];
    }
    out_l *= 0.5;
    out_r *= 0.5;
    hadamard(e->tmp);
    for (k = 0; k < BK_REVERB_LINES; k++) {
      const double inj = k % 2 == 0 ? dl : dr;
      bk_delay_line_write(&e->lines[k], bk_sanitize(inj * 0.5 + e->tmp[k] * decay));
    }
    mid = (out_l + out_r) * 0.5;
    side = (out_l - out_r) * 0.5 * e->width;
    l[i] = (float)bk_sanitize(mid + side);
    r[i] = (float)bk_sanitize(mid - side);
  }
}

/* Effect inherits meter=0; no carrier or latency hooks. */
static double zero_meter(const void *self) { (void)self; return 0.0; }
#define VT(name) \
  static void name##_process(void *s, float *l, float *r, int n) { \
    bk_##name##_process((bk_##name *)s, l, r, n); \
  } \
  static void name##_reset(void *s) { bk_##name##_reset((bk_##name *)s); } \
  static void name##_param(void *s, int k, double v) { bk_##name##_set_param((bk_##name *)s, k, v); } \
  const bk_effect_vt bk_##name##_vt = {name##_process, name##_reset, name##_param, NULL, NULL, zero_meter}
VT(delay);
VT(reverb);
#undef VT
