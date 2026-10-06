/* Bro.Kodr — port of dsp/effects/spectral.js; contract in spectral.h. */
#include "brokodr/dsp/spectral.h"
#include <math.h>
#include <string.h>

static double js_round(double x) {
  const double r = floor(x);
  const double y = (x - r >= 0.5) ? r + 1.0 : r;
  return y == 0.0 && x < 0.0 ? -0.0 : y;
}
/* ToInt32, as `x | 0`: NaN/inf give 0, the rest wrap modulo 2^32. */
static int to_int32(double x) {
  double t;
  if (!isfinite(x)) return 0;
  t = fmod(trunc(x), 4294967296.0);
  if (t < 0.0) t += 4294967296.0;
  return t >= 2147483648.0 ? (int)(t - 4294967296.0) : (int)t;
}

/* --- VocoderChannel ----------------------------------------------------- */
static void pv_clear(bk_pv_channel *c) {
  memset(c->in_fifo, 0, sizeof(float) * (size_t)c->n);
  memset(c->out_fifo, 0, sizeof(float) * (size_t)c->n);
  memset(c->out_accum, 0, sizeof(float) * 2u * (size_t)c->n);
  memset(c->last_phase, 0, sizeof(float) * (size_t)(c->half + 1));
  memset(c->sum_phase, 0, sizeof(float) * (size_t)(c->half + 1));
  c->rw = c->n - c->hop;
}
/* n == 0 is the JS init(undefined): zero-length buffers, one-bin arrays. */
static void pv_init(bk_pv_channel *c, int n) {
  const size_t bins = sizeof(float) * (size_t)((n >> 1) + 1);
  c->n = n;
  c->half = n >> 1;
  c->hop = n >> 2;
  /* Every Float32Array is freshly allocated by the JS init. */
  memset(c->re, 0, sizeof(float) * (size_t)n);
  memset(c->im, 0, sizeof(float) * (size_t)n);
  memset(c->ana_magn, 0, bins);
  memset(c->ana_freq, 0, bins);
  memset(c->syn_magn, 0, bins);
  memset(c->syn_freq, 0, bins);
  memset(c->excite, 0, bins);
  memset(c->env_shift, 0, bins);
  if (n > 0) {
    bk_fft_init(&c->fft, n, c->cos_t, c->sin_t, c->rev);
    bk_hann_window(c->window, n);
    bk_cepstral_envelope_init(&c->cep, n, c->cos_t, c->sin_t, c->rev, c->cep_re, c->cep_im,
                              c->cep_env);
    c->freq_per_bin = c->sr / n;
    c->expct = (BK_TWO_PI * c->hop) / n;
  } else {
    c->cep_env[0] = 0.0f;
    c->freq_per_bin = c->expct = NAN;
  }
  pv_clear(c);
}

static double pv_process(bk_pv_channel *c, double x, double pitch_ratio, double env_ratio,
                         int do_env, double lifter) {
  const int n = c->n, hop = c->hop, half = c->half;
  float out;
  int i, k;
  /* Degenerate: every index is NaN, so the write misses and the read is
     undefined; sanitize(undefined) is 0. */
  if (n == 0) return 0.0;
  c->in_fifo[c->rw] = (float)x;
  out = c->out_fifo[c->rw - (n - hop)];
  c->rw++;
  if (c->rw >= n) {
    float *re = c->re, *im = c->im;
    const float *w = c->window;
    double norm;
    c->rw = n - hop;
    for (i = 0; i < n; i++) {
      re[i] = (float)((double)c->in_fifo[i] * w[i]);
      im[i] = 0.0f;
    }
    bk_fft_transform(&c->fft, re, im, 0);
    for (k = 0; k <= half; k++) {
      const double r = re[k], i2 = im[k];
      const double magn = 2.0 * sqrt(r * r + i2 * i2);
      const double phase = atan2(i2, r);
      double dp = phase - c->last_phase[k], qpd, deviation;
      int q;
      c->last_phase[k] = (float)phase;
      dp -= k * c->expct;
      qpd = dp / BK_PI;
      qpd += qpd >= 0.0 ? 0.5 : -0.5;
      q = to_int32(qpd);
      qpd = q;
      if (q & 1) qpd += qpd > 0.0 ? 1.0 : -1.0;
      dp -= BK_PI * qpd;
      deviation = (4.0 * dp) / BK_TWO_PI;
      c->ana_magn[k] = (float)magn;
      c->ana_freq[k] = (float)((k + deviation) * c->freq_per_bin);
    }
    if (do_env) {
      const float *env = bk_cepstral_envelope_compute(&c->cep, c->ana_magn, lifter);
      /* inv is in (0, 1e4] or NaN, so src >= 0 or NaN and i0 >= 0. */
      const double inv = 1.0 / bk_max(env_ratio, 1e-4);
      for (k = 0; k <= half; k++)
        c->excite[k] = (float)((double)c->ana_magn[k] / ((double)env[k] + 1e-9));
      for (k = 0; k <= half; k++) {
        const double src = k * inv;
        const int i0 = to_int32(src);
        if (i0 >= half) c->env_shift[k] = env[half];
        else {
          const double f = src - i0;
          c->env_shift[k] = (float)(env[i0] + ((double)env[i0 + 1] - env[i0]) * f);
        }
      }
      for (k = 0; k <= half; k++)
        c->ana_magn[k] = (float)((double)c->excite[k] * c->env_shift[k]);
    }
    memset(c->syn_magn, 0, sizeof(float) * (size_t)(half + 1));
    memset(c->syn_freq, 0, sizeof(float) * (size_t)(half + 1));
    for (k = 0; k <= half; k++) {
      const int index = to_int32(k * pitch_ratio);
      /* A negative index is a Float32Array write that misses. */
      if (index <= half && index >= 0) {
        c->syn_magn[index] = (float)((double)c->syn_magn[index] + c->ana_magn[k]);
        c->syn_freq[index] = (float)(c->ana_freq[k] * pitch_ratio);
      }
    }
    for (k = 0; k <= half; k++) {
      const double magn = c->syn_magn[k];
      double tmp = c->syn_freq[k], phase;
      tmp -= k * c->freq_per_bin;
      tmp /= c->freq_per_bin;
      tmp = (BK_TWO_PI * tmp) / 4.0;
      tmp += k * c->expct;
      c->sum_phase[k] = (float)(c->sum_phase[k] + tmp);
      phase = c->sum_phase[k];
      re[k] = (float)(magn * cos(phase));
      im[k] = (float)(magn * sin(phase));
    }
    for (k = half + 1; k < n; k++) {
      re[k] = re[n - k];
      im[k] = -im[n - k];
    }
    bk_fft_transform(&c->fft, re, im, 1);
    norm = 2.0 / (half * 4.0);
    for (i = 0; i < n; i++)
      c->out_accum[i] = (float)(c->out_accum[i] + (double)w[i] * re[i] * norm);
    for (i = 0; i < hop; i++) c->out_fifo[i] = c->out_accum[i];
    memmove(c->out_accum, c->out_accum + hop, sizeof(float) * (size_t)n);
    memset(c->out_accum + n, 0, sizeof(float) * (size_t)hop);
    memmove(c->in_fifo, c->in_fifo + hop, sizeof(float) * (size_t)(n - hop));
  }
  return bk_sanitize(out);
}

/* --- PitchFormant ------------------------------------------------------- */
static void update_ratios(bk_pitch_formant *e) {
  const double p = bk_semitones_to_ratio(e->pitch_st + e->fine_cents / 100.0);
  const double f = bk_semitones_to_ratio(e->formant_st);
  bk_smoother_set(&e->pitch_sm, p);
  bk_smoother_set(&e->formant_sm, e->preserve ? f / p : f);
}

void bk_pitch_formant_init(bk_pitch_formant *e, double sr) {
  int c;
  e->sr = sr;
  e->fft_size = 1024;
  e->degenerate = 0;
  e->pitch_st = e->fine_cents = e->formant_st = 0.0;
  e->preserve = 1;
  e->lifter = 40.0;
  bk_smoother_init(&e->pitch_sm, sr, 40.0, 1.0);
  bk_smoother_init(&e->formant_sm, sr, 40.0, 1.0);
  e->jitter = e->shimmer = 0.0;
  e->rng = 0x9e3779b9u;
  e->jit_walk = e->shim_walk = 0.0;
  bk_smoother_init(&e->jit_sm, sr, 25.0, 1.0);
  bk_smoother_init(&e->shim_sm, sr, 25.0, 1.0);
  e->meter = 0.0;
  for (c = 0; c < 2; c++) {
    e->ch[c].sr = sr;
    pv_init(&e->ch[c], 1024);
  }
}

void bk_pitch_formant_set_param(bk_pitch_formant *e, int key, double v) {
  switch (key) {
    case BK_P_PITCH_PITCH: e->pitch_st = v; update_ratios(e); break;
    case BK_P_PITCH_FINE: e->fine_cents = v; update_ratios(e); break;
    case BK_P_PITCH_FORMANT: e->formant_st = v; update_ratios(e); break;
    case BK_P_PITCH_PRESERVE: e->preserve = v >= 0.5 ? 1 : 0; update_ratios(e); break;
    case BK_P_PITCH_LIFTER: e->lifter = bk_clamp(js_round(v), 8.0, 120.0); break;
    case BK_P_PITCH_JITTER: e->jitter = bk_clamp(v, 0.0, 100.0) * 0.0004; break;
    case BK_P_PITCH_SHIMMER: e->shimmer = bk_clamp(v, 0.0, 100.0) * 0.0035; break;
    case BK_P_PITCH_QUALITY: {
      static const int sizes[4] = {512, 1024, 2048, 4096};
      const double q = bk_clamp(js_round(v), 0.0, 3.0);
      int c;
      if (q != q) { /* sizes[NaN] === undefined */
        if (!e->degenerate) {
          e->degenerate = 1;
          for (c = 0; c < 2; c++) pv_init(&e->ch[c], 0);
        }
      } else if (e->degenerate || sizes[(int)q] != e->fft_size) {
        e->degenerate = 0;
        e->fft_size = sizes[(int)q];
        for (c = 0; c < 2; c++) pv_init(&e->ch[c], e->fft_size);
      }
      break;
    }
    default: break;
  }
}

void bk_pitch_formant_reset(bk_pitch_formant *e) {
  pv_clear(&e->ch[0]);
  pv_clear(&e->ch[1]);
}

static double rng_step(bk_pitch_formant *e) {
  unsigned int r = e->rng;
  r ^= r << 13;
  r ^= r >> 17;
  r ^= r << 5;
  e->rng = r;
  return (double)(r & 0xffffu) / 32768.0 - 1.0;
}

void bk_pitch_formant_process(bk_pitch_formant *e, float *l, float *r, int frames) {
  const double pitch = bk_smoother_next(&e->pitch_sm);
  const double env_ratio = bk_smoother_next(&e->formant_sm);
  double n1, n2, jit, shim, p;
  int i, do_env;
  for (i = 1; i < frames; i++) {
    bk_smoother_next(&e->pitch_sm);
    bk_smoother_next(&e->formant_sm);
  }
  do_env = fabs(env_ratio - 1.0) > 0.001;
  n1 = rng_step(e);
  n2 = rng_step(e);
  e->jit_walk = e->jit_walk * 0.86 + n1 * 0.14;
  e->shim_walk = e->shim_walk * 0.86 + n2 * 0.14;
  bk_smoother_set(&e->jit_sm, 1.0 + e->jit_walk * e->jitter);
  bk_smoother_set(&e->shim_sm, 1.0 + e->shim_walk * e->shimmer);
  jit = bk_smoother_next(&e->jit_sm);
  shim = bk_smoother_next(&e->shim_sm);
  for (i = 1; i < frames; i++) {
    bk_smoother_next(&e->jit_sm);
    bk_smoother_next(&e->shim_sm);
  }
  p = pitch * jit;
  for (i = 0; i < frames; i++) {
    l[i] = (float)(pv_process(&e->ch[0], l[i], p, env_ratio, do_env, e->lifter) * shim);
    r[i] = (float)(pv_process(&e->ch[1], r[i], p, env_ratio, do_env, e->lifter) * shim);
  }
  /* latencySamples / sr * 1000; undefined / sr is NaN. */
  e->meter = e->degenerate ? NAN : (double)e->fft_size / e->sr * 1000.0;
}

int bk_pitch_formant_latency(const bk_pitch_formant *e) {
  return e->degenerate ? 0 : e->fft_size;
}

static void vt_process(void *s, float *l, float *r, int n) {
  bk_pitch_formant_process((bk_pitch_formant *)s, l, r, n);
}
static void vt_reset(void *s) { bk_pitch_formant_reset((bk_pitch_formant *)s); }
static void vt_param(void *s, int k, double v) {
  bk_pitch_formant_set_param((bk_pitch_formant *)s, k, v);
}
static int vt_latency(const void *s) {
  return bk_pitch_formant_latency((const bk_pitch_formant *)s);
}
static double vt_meter(const void *s) { return ((const bk_pitch_formant *)s)->meter; }
const bk_effect_vt bk_pitch_formant_vt = {vt_process, vt_reset, vt_param, NULL, vt_latency,
                                          vt_meter};
