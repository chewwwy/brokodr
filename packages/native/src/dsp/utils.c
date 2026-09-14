/*
 * Bro.Kodr DSP core — math utilities. C port of dsp/core/utils.js.
 * See utils.h for the porting rules. Kept line-for-line comparable with the JS
 * so a reviewer can diff them by eye.
 */

#include "brokodr/dsp/utils.h"

#include <math.h>

/* --- scalar helpers ----------------------------------------------------- */

double bk_clamp(double x, double lo, double hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

double bk_max(double a, double b) {
  /* Math.max(NaN, x) and Math.max(x, NaN) are both NaN. */
  if (a != a || b != b) return (double)(0.0 / 0.0);
  return a > b ? a : b;
}

double bk_min(double a, double b) {
  if (a != a || b != b) return (double)(0.0 / 0.0);
  return a < b ? a : b;
}

double bk_db_to_gain(double db) {
  return pow(10.0, db * 0.05);
}

double bk_gain_to_db(double g) {
  return 20.0 * log10(bk_max(g, 1e-9));
}

double bk_lerp(double a, double b, double t) {
  return a + (b - a) * t;
}

/* utils.js:
 *   sanitize(x) => x >= -1e30 && x <= 1e30 ? (Math.abs(x) < 1e-18 ? 0 : x) : 0
 * The comparison form matters: NaN fails both bounds, so NaN maps to 0 exactly
 * as it does in the JS. Writing this as fabs(x) > 1e30 would let NaN through. */
double bk_sanitize(double x) {
  if (x >= -1e30 && x <= 1e30) return fabs(x) < 1e-18 ? 0.0 : x;
  return 0.0;
}

double bk_semitones_to_ratio(double st) {
  return pow(2.0, st / 12.0);
}

double bk_poly_blep(double t, double dt) {
  if (dt <= 0.0) return 0.0;
  if (t < dt) {
    const double x = t / dt - 1.0;
    return -x * x;
  }
  if (t > 1.0 - dt) {
    const double x = (t - 1.0) / dt + 1.0;
    return x * x;
  }
  return 0.0;
}

/* --- Smoother ----------------------------------------------------------- */

void bk_smoother_set_time(bk_smoother *s, double ms) {
  s->a = exp(-1.0 / (bk_max(ms, 0.01) * 0.001 * s->sr));
}

void bk_smoother_init(bk_smoother *s, double sample_rate, double ms, double initial) {
  s->sr = sample_rate;
  s->value = initial;
  s->target = initial;
  bk_smoother_set_time(s, ms);
}

void bk_smoother_set(bk_smoother *s, double target) {
  s->target = target;
}

void bk_smoother_reset(bk_smoother *s, double v) {
  s->value = v;
  s->target = v;
}

double bk_smoother_next(bk_smoother *s) {
  s->value = s->target + (s->value - s->target) * s->a;
  if (fabs(s->value - s->target) < 1e-9) s->value = s->target;
  return s->value;
}

int bk_smoother_settled(const bk_smoother *s) {
  return s->value == s->target;
}

/* --- EnvelopeFollower --------------------------------------------------- */

void bk_env_follower_set_attack(bk_env_follower *e, double ms) {
  e->ca = exp(-1.0 / (bk_max(ms, 0.01) * 0.001 * e->sr));
}

void bk_env_follower_set_release(bk_env_follower *e, double ms) {
  e->cr = exp(-1.0 / (bk_max(ms, 0.01) * 0.001 * e->sr));
}

void bk_env_follower_init(bk_env_follower *e, double sample_rate, double attack_ms,
                          double release_ms, int rms) {
  e->sr = sample_rate;
  e->rms = rms ? 1 : 0;
  e->env = 0.0;
  bk_env_follower_set_attack(e, attack_ms);
  bk_env_follower_set_release(e, release_ms);
}

double bk_env_follower_process(bk_env_follower *e, double x) {
  const double d = e->rms ? x * x : fabs(x);
  const double c = d > e->env ? e->ca : e->cr;
  e->env = d + (e->env - d) * c;
  return e->rms ? sqrt(e->env) : e->env;
}

void bk_env_follower_reset(bk_env_follower *e) {
  e->env = 0.0;
}

/* --- LFO ---------------------------------------------------------------- */

void bk_lfo_init(bk_lfo *l, double sample_rate) {
  l->sr = sample_rate;
  l->phase = 0.0;
  l->inc = 0.0;
  l->shape = BK_LFO_SINE;
  l->rand = 0.0;
  l->last_quad = 0.0;
  bk_rng_seed(&l->rng, 0x9e3779b9u);
}

void bk_lfo_set_rate(bk_lfo *l, double hz) {
  l->inc = hz / l->sr;
}

void bk_lfo_set_phase(bk_lfo *l, double p) {
  l->phase = p - floor(p);
}

double bk_lfo_next_with(bk_lfo *l, double rnd) {
  const double p = l->phase;
  l->phase += l->inc;
  if (l->phase >= 1.0) {
    l->phase -= 1.0;
    if (l->shape == BK_LFO_SAMPLE_HOLD) l->rand = rnd;
  }
  switch (l->shape) {
    case BK_LFO_TRI:
      return 4.0 * fabs(p - 0.5) - 1.0;
    case BK_LFO_SAW:
      return 2.0 * p - 1.0;
    case BK_LFO_SQUARE:
      return p < 0.5 ? 1.0 : -1.0;
    case BK_LFO_SAMPLE_HOLD:
      return l->rand;
    default:
      return sin(BK_TWO_PI * p);
  }
}

double bk_lfo_next(bk_lfo *l) {
  return bk_lfo_next_with(l, bk_rng_bipolar(&l->rng));
}

/* --- DCBlocker ---------------------------------------------------------- */

void bk_dc_blocker_init(bk_dc_blocker *d, double sample_rate, double hz) {
  d->r = 1.0 - (BK_TWO_PI * hz) / sample_rate;
  d->x1 = 0.0;
  d->y1 = 0.0;
}

double bk_dc_blocker_process(bk_dc_blocker *d, double x) {
  const double y = x - d->x1 + d->r * d->y1;
  d->x1 = x;
  d->y1 = bk_sanitize(y);
  return d->y1;
}

void bk_dc_blocker_reset(bk_dc_blocker *d) {
  d->x1 = 0.0;
  d->y1 = 0.0;
}

/* --- PitchTracker ------------------------------------------------------- */

void bk_pitch_tracker_init(bk_pitch_tracker *p, double sample_rate, double min_hz, double max_hz) {
  int i;
  const double dec = bk_max(1.0, floor(sample_rate / 12000.0));
  p->sr = sample_rate;
  p->decim = (int)dec;
  p->dsr = sample_rate / (double)p->decim;
  p->min_lag = (int)floor(p->dsr / max_hz);
  p->max_lag = (int)floor(p->dsr / min_hz);
  p->size = p->max_lag * 2;
  /* The JS sizes its Float32Array from maxLag; C cannot allocate on the audio
     thread, so the buffer is fixed and the lag range is clamped to fit. Any
     clamp here is a real behavioural difference, so the bound is set well above
     what the app asks for (48 kHz / 60 Hz needs 400 of 2048). */
  if (p->size > BK_PITCH_MAX_BUF) {
    p->size = BK_PITCH_MAX_BUF;
    p->max_lag = p->size / 2;
    if (p->min_lag > p->max_lag) p->min_lag = p->max_lag;
  }
  for (i = 0; i < BK_PITCH_MAX_BUF; i++) p->buf[i] = 0.0f;
  p->w = 0;
  p->decim_count = 0;
  p->acc = 0.0;
  p->freq = 0.0;
  p->confidence = 0.0;
}

void bk_pitch_tracker_push(bk_pitch_tracker *p, double x) {
  p->acc += x;
  if (++p->decim_count < p->decim) return;
  p->buf[p->w] = (float)(p->acc / (double)p->decim);
  p->w = (p->w + 1) % p->size;
  p->acc = 0.0;
  p->decim_count = 0;
}

double bk_pitch_tracker_analyze(bk_pitch_tracker *p) {
  const int n = p->size;
  const float *b = p->buf;
  const int w = p->w;
  const int half = p->max_lag;
  double energy = 0.0;
  double best = 0.0;
  int best_lag = 0;
  int i, lag;

  for (i = 0; i < n; i++) energy += (double)b[i] * (double)b[i];
  if (energy < 1e-6) {
    p->confidence = 0.0;
    return 0.0;
  }
  for (lag = p->min_lag; lag < p->max_lag; lag++) {
    double sum = 0.0;
    double norm = 0.0;
    double r;
    for (i = 0; i < half; i++) {
      /* w + n - half - lag + i is never negative: n - half == half > lag. */
      const double a = (double)b[(w + n - half + i) % n];
      const double c = (double)b[(w + n - half - lag + i) % n];
      sum += a * c;
      norm += c * c;
    }
    r = sum / sqrt(norm * energy + 1e-12);
    if (r > best) {
      best = r;
      best_lag = lag;
    }
  }
  p->confidence = best;
  if (best < 0.3 || best_lag == 0) {
    p->freq = 0.0;
    return 0.0;
  }
  p->freq = p->dsr / (double)best_lag;
  return p->freq;
}

/* --- Oscillator --------------------------------------------------------- */

void bk_oscillator_init(bk_oscillator *o, double sample_rate) {
  o->sr = sample_rate;
  o->phase = 0.0;
  o->inc = 0.0;
  o->pw = 0.5;
}

void bk_oscillator_set_freq(bk_oscillator *o, double hz) {
  o->inc = bk_max(0.0, hz) / o->sr;
}

double bk_oscillator_saw(bk_oscillator *o) {
  const double p = o->phase;
  double v;
  o->phase += o->inc;
  if (o->phase >= 1.0) o->phase -= 1.0;
  v = 2.0 * p - 1.0;
  v -= bk_poly_blep(p, o->inc);
  return v;
}

double bk_oscillator_pulse(bk_oscillator *o) {
  const double p = o->phase;
  double v, p2;
  o->phase += o->inc;
  if (o->phase >= 1.0) o->phase -= 1.0;
  v = p < o->pw ? 1.0 : -1.0;
  v += bk_poly_blep(p, o->inc);
  p2 = p - o->pw;
  if (p2 < 0.0) p2 += 1.0;
  v -= bk_poly_blep(p2, o->inc);
  return v;
}

/* --- PinkNoise ---------------------------------------------------------- */

void bk_pink_noise_init(bk_pink_noise *p) {
  int i;
  for (i = 0; i < 7; i++) p->b[i] = 0.0f;
  bk_rng_seed(&p->rng, 0x6d2b79f5u);
}

double bk_pink_noise_process(bk_pink_noise *p, double w) {
  /* Every store truncates to float32 because the JS state is a Float32Array;
     the reads promote back to double. Holding this in double changes the
     filter's low-frequency tail audibly, so the casts are load-bearing. */
  float *b = p->b;
  double out;
  b[0] = (float)(0.99886 * (double)b[0] + w * 0.0555179);
  b[1] = (float)(0.99332 * (double)b[1] + w * 0.0750759);
  b[2] = (float)(0.969 * (double)b[2] + w * 0.153852);
  b[3] = (float)(0.8665 * (double)b[3] + w * 0.3104856);
  b[4] = (float)(0.55 * (double)b[4] + w * 0.5329522);
  b[5] = (float)(-0.7616 * (double)b[5] - w * 0.016898);
  /* b[6] is read here at its previous value, then updated — as in the JS. */
  out = (double)b[0] + (double)b[1] + (double)b[2] + (double)b[3] + (double)b[4] +
        (double)b[5] + (double)b[6] + w * 0.5362;
  b[6] = (float)(w * 0.115926);
  return out * 0.11;
}

double bk_pink_noise_next(bk_pink_noise *p) {
  return bk_pink_noise_process(p, bk_rng_bipolar(&p->rng));
}

/* --- RNG (outside the parity contract) ---------------------------------- */

void bk_rng_seed(unsigned int *state, unsigned int seed) {
  *state = seed ? seed : 0x1u;
}

double bk_rng_bipolar(unsigned int *state) {
  unsigned int x = *state;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  *state = x;
  return ((double)(x >> 8) / 16777216.0) * 2.0 - 1.0;
}
