/*
 * Bro.Kodr DSP — voice character and destruction. C port of
 * dsp/effects/character.js; see character.h for what is reproduced on purpose
 * and where the C deliberately diverges.
 */

#include "brokodr/dsp/character.h"

#include <math.h>

/* Math.round, as in drive.c: the exact fraction decides, [-0.5, 0) gives -0,
   NaN stays NaN. */
static double js_round(double x) {
  const double r = floor(x);
  const double y = (x - r >= 0.5) ? r + 1.0 : r;
  return (y == 0.0 && x < 0.0) ? -0.0 : y;
}

/* Math.sign: +-1, and the argument itself for +-0 and NaN. */
static double js_sign(double x) {
  if (x > 0.0) return 1.0;
  if (x < 0.0) return -1.0;
  return x;
}

static double internal_random(void *user) {
  return (bk_rng_bipolar((unsigned int *)user) + 1.0) * 0.5;
}

/* --- Character ------------------------------------------------------------ */

const bk_character_mode bk_character_modes[BK_CHARACTER_MODES] = {
    /* hp    lp     res: f, dB, Q     drive curve noise   crackle wobble squelch */
    {300, 3400, 1200, 6, 1.2, 3, 0, 0.0006, 0, 0, 0},        /* telephone */
    {180, 4500, 900, 4, 0.9, 4, 0, 0.004, 0.15, 0.05, 0},    /* am-radio */
    {500, 4000, 1800, 11, 2.2, 9, 1, 0.0004, 0, 0, 0},       /* megaphone */
    {400, 3000, 1500, 8, 1.6, 7, 1, 0.006, 0.05, 0, 1},      /* walkie */
    {60, 8500, 4000, -3, 0.7, 2, 0, 0.0025, 0.02, 0.5, 0},   /* cassette */
    {80, 9500, 3000, 2, 0.8, 1.6, 0, 0.002, 0.5, 0.12, 0},   /* vinyl */
    {350, 2800, 1100, 9, 2.6, 5, 2, 0.003, 0, 0, 0},         /* intercom */
    {120, 5500, 700, 3, 0.6, 3.5, 0, 0.005, 0.08, 0.8, 0},   /* lofi-tape */
};

static double wobble_max(double sample_rate) { return ceil(sample_rate * 0.02); }

size_t bk_character_storage_floats(double sample_rate) {
  return 2u * (size_t)bk_delay_line_size(wobble_max(sample_rate));
}

void bk_character_init(bk_character *c, double sample_rate, float *storage) {
  const double max_wob = wobble_max(sample_rate);
  const int line = bk_delay_line_size(max_wob);
  int k;
  c->sr = sample_rate;
  c->mode = 0;
  c->amount = 1.0;
  c->drive_trim = 0.0;
  c->noise_trim = 1.0;
  c->wobble_trim = 1.0;
  for (k = 0; k < 2; k++) {
    bk_biquad_cascade_init(&c->hp[k], sample_rate, 2);
    bk_biquad_cascade_init(&c->lp[k], sample_rate, 2);
    bk_biquad_init(&c->res[k], sample_rate);
    bk_delay_line_init(&c->wobble_line[k], storage + (size_t)k * (size_t)line, max_wob);
  }
  bk_pink_noise_init(&c->noise);
  bk_lfo_init(&c->wobble_lfo, sample_rate);
  bk_lfo_set_rate(&c->wobble_lfo, 0.7);
  bk_lfo_init(&c->flutter_lfo, sample_rate);
  bk_lfo_set_rate(&c->flutter_lfo, 6.3);
  bk_env_follower_init(&c->gate_env, sample_rate, 2.0, 60.0, 0);
  bk_smoother_init(&c->squelch_sm, sample_rate, 12.0, 1.0);
  bk_smoother_init(&c->out_sm, sample_rate, 20.0, 1.0);
  c->crackle_state = 0.0;
  bk_rng_seed(&c->rng, 0x8f1bbcdcu);
  c->random = internal_random;
  c->random_user = &c->rng;
}

void bk_character_set_random(bk_character *c, bk_random_fn fn, void *user) {
  if (fn) {
    c->random = fn;
    c->random_user = user;
  } else {
    c->random = internal_random;
    c->random_user = &c->rng;
  }
}

void bk_character_set_param(bk_character *c, int key, double value) {
  switch (key) {
    case BK_P_CHARACTER_MODE: {
      const double m = bk_clamp(js_round(value), 0.0, (double)(BK_CHARACTER_MODES - 1));
      if (m == m) c->mode = (int)m; /* NaN: see character.h */
      break;
    }
    case BK_P_CHARACTER_AMOUNT:
      c->amount = bk_clamp(value, 0.0, 1.0);
      break;
    case BK_P_CHARACTER_DRIVE:
      c->drive_trim = value;
      break;
    case BK_P_CHARACTER_NOISE:
      c->noise_trim = bk_clamp(value, 0.0, 4.0);
      break;
    case BK_P_CHARACTER_WOBBLE:
      c->wobble_trim = bk_clamp(value, 0.0, 2.0);
      break;
    case BK_P_CHARACTER_OUTPUT:
      bk_smoother_set(&c->out_sm, bk_db_to_gain(value));
      break;
    default:
      break;
  }
}

void bk_character_reset(bk_character *c) {
  int k;
  for (k = 0; k < 2; k++) {
    bk_biquad_cascade_reset(&c->hp[k]);
    bk_biquad_cascade_reset(&c->lp[k]);
    bk_biquad_reset(&c->res[k]);
    bk_delay_line_clear(&c->wobble_line[k]);
  }
  bk_env_follower_reset(&c->gate_env);
}

void bk_character_process(bk_character *c, float *l, float *r, int frames) {
  const bk_character_mode *m = &bk_character_modes[c->mode];
  const double a = c->amount;
  /* AMOUNT blends the band edges toward bypass, not just the level. */
  const double hp_f = 20.0 + (m->hp - 20.0) * a;
  const double lp_f = 20000.0 - (20000.0 - m->lp) * a;
  double drive, noise_lvl, crackle_p, wob_depth;
  int i, k;

  for (k = 0; k < 2; k++) {
    bk_biquad_cascade_set(&c->hp[k], BK_FILTER_HIGHPASS, hp_f, 0.7071, 0.0);
    bk_biquad_cascade_set(&c->lp[k], BK_FILTER_LOWPASS, lp_f, 0.7071, 0.0);
    bk_biquad_set(&c->res[k], BK_FILTER_PEAK, m->res_freq, m->res_q, m->res_db * a);
  }

  drive = 1.0 + (m->drive - 1.0) * a * bk_db_to_gain(c->drive_trim);
  noise_lvl = m->noise * a * c->noise_trim;
  crackle_p = m->crackle * a * 0.0008;
  wob_depth = m->wobble * a * c->wobble_trim * 0.0012 * c->sr;

  for (i = 0; i < frames; i++) {
    double out[2];
    double wob = 0.0;
    double art = 0.0;
    double sq = 1.0;
    double g;
    /* The LFOs advance every frame either way, wobble first. A NaN depth
       fails both tests and they stand still, as in the JS. */
    if (wob_depth > 0.001) {
      const double w1 = bk_lfo_next_with(&c->wobble_lfo, 0.0);
      const double w2 = bk_lfo_next_with(&c->flutter_lfo, 0.0);
      wob = (w1 * 0.7 + w2 * 0.3) * wob_depth;
    }
    if (wob_depth <= 0.001) {
      bk_lfo_next_with(&c->wobble_lfo, 0.0);
      bk_lfo_next_with(&c->flutter_lfo, 0.0);
    }

    for (k = 0; k < 2; k++) {
      double x = (double)(k ? r : l)[i];
      double d;
      if (wob_depth > 0.001) {
        bk_delay_line *line = &c->wobble_line[k];
        bk_delay_line_write(line, x);
        x = bk_delay_line_read_cubic(line, bk_clamp(wob_depth + wob + 8.0, 2.0, (double)(line->size - 4)));
      }
      x = bk_biquad_cascade_process(&c->hp[k], x);
      x = bk_biquad_process(&c->res[k], x);

      d = x * drive;
      if (m->curve == 1) x = bk_clamp(d, -0.8, 0.8) * 1.2;
      else if (m->curve == 2) x = (fabs(d) * 1.2 - 0.3) * js_sign(d);
      else x = tanh(d);
      x /= bk_max(1.0, drive * 0.5);

      out[k] = bk_biquad_cascade_process(&c->lp[k], x);
    }

    /* Noise floor, then crackle: the JS's draw order. */
    if (noise_lvl > 0.0) {
      const double w = c->random(c->random_user) * 2.0 - 1.0;
      art += bk_pink_noise_process(&c->noise, w) * noise_lvl * 20.0;
    }
    if (crackle_p > 0.0 && c->random(c->random_user) < crackle_p) {
      c->crackle_state = (c->random(c->random_user) * 2.0 - 1.0) * 0.4 * a;
    }
    c->crackle_state *= 0.72;
    art += c->crackle_state;

    /* Carrier squelch on the input level; noise only passes while open. */
    if (m->squelch) {
      const double lvl = bk_env_follower_process(&c->gate_env, bk_max(fabs((double)l[i]), fabs((double)r[i])));
      bk_smoother_set(&c->squelch_sm, bk_gain_to_db(lvl) > -42.0 ? 1.0 : 0.0);
      sq = bk_smoother_next(&c->squelch_sm);
    }

    g = bk_smoother_next(&c->out_sm);
    l[i] = (float)bk_sanitize((out[0] + art) * sq * g);
    r[i] = (float)bk_sanitize((out[1] + art) * sq * g);
  }
}

static void character_vt_process(void *self, float *l, float *r, int frames) {
  bk_character_process((bk_character *)self, l, r, frames);
}
static void character_vt_reset(void *self) { bk_character_reset((bk_character *)self); }
static void character_vt_set_param(void *self, int key, double value) {
  bk_character_set_param((bk_character *)self, key, value);
}

const bk_effect_vt bk_character_vt = {character_vt_process, character_vt_reset, character_vt_set_param, NULL, NULL,
                                      NULL};

/* --- Glitch --------------------------------------------------------------- */

size_t bk_glitch_storage_floats(double sample_rate) { return 2u * (size_t)ceil(sample_rate * 2.0); }

void bk_glitch_init(bk_glitch *g, double sample_rate, float *storage) {
  int k;
  g->sr = sample_rate;
  g->buf_size = (int)ceil(sample_rate * 2.0);
  g->buf_l = storage;
  g->buf_r = storage + g->buf_size;
  for (k = 0; k < 2 * g->buf_size; k++) storage[k] = 0.0f;
  g->w = 0;
  g->bpm = 120.0;
  g->division = 4.0;
  g->probability = 0.35;
  g->reverse = 0.0;
  g->pitch_ratio = 1.0;
  g->repeats = 2.0;
  g->xfade = js_round(sample_rate * 0.003);
  g->slice_len = js_round(sample_rate * 0.125);
  g->active = 0;
  g->slice_start = 0.0;
  g->repeat_count = 0.0;
  g->read_pos = 0.0;
  g->counter = 0.0;
  g->freeze = 0;
  g->meter = 0.0;
  bk_rng_seed(&g->rng, 0xca62c1d6u);
  g->random = internal_random;
  g->random_user = &g->rng;
}

void bk_glitch_set_random(bk_glitch *g, bk_random_fn fn, void *user) {
  if (fn) {
    g->random = fn;
    g->random_user = user;
  } else {
    g->random = internal_random;
    g->random_user = &g->rng;
  }
}

void bk_glitch_set_param(bk_glitch *g, int key, double value) {
  switch (key) {
    case BK_P_GLITCH_BPM:
      g->bpm = bk_clamp(value, 20.0, 300.0);
      break;
    case BK_P_GLITCH_DIVISION:
      g->division = bk_clamp(js_round(value), 1.0, 16.0);
      break;
    case BK_P_GLITCH_PROBABILITY:
      g->probability = bk_clamp(value, 0.0, 1.0);
      break;
    case BK_P_GLITCH_REVERSE:
      g->reverse = bk_clamp(value, 0.0, 1.0);
      break;
    case BK_P_GLITCH_PITCH:
      g->pitch_ratio = pow(2.0, bk_clamp(value, -24.0, 24.0) / 12.0);
      break;
    case BK_P_GLITCH_REPEATS:
      g->repeats = bk_clamp(js_round(value), 1.0, 16.0);
      break;
    case BK_P_GLITCH_FREEZE:
      g->freeze = value >= 0.5 ? 1 : 0;
      break;
    default:
      break;
  }
}

void bk_glitch_reset(bk_glitch *g) {
  int k;
  for (k = 0; k < g->buf_size; k++) {
    g->buf_l[k] = 0.0f;
    g->buf_r[k] = 0.0f;
  }
  g->w = 0;
  g->active = 0;
  g->counter = 0.0;
}

/* A JS typed-array read: undefined (NaN) outside [0, n). The index is always
   integral or NaN here, and -0 reads element 0. */
static double buf_at(const float *b, double idx, int n) {
  return (idx >= 0.0 && idx < (double)n) ? (double)b[(int)idx] : (double)NAN;
}

void bk_glitch_process(bk_glitch *g, float *l, float *r, int frames) {
  const double beat_samples = (60.0 / g->bpm) * g->sr;
  const double n = (double)g->buf_size;
  int i;
  g->slice_len = bk_max(64.0, js_round(beat_samples / g->division));

  for (i = 0; i < frames; i++) {
    /* Always recording, unless frozen on a playing slice. */
    if (!g->freeze || !g->active) {
      g->buf_l[g->w] = l[i];
      g->buf_r[g->w] = r[i];
      g->w = (g->w + 1) % g->buf_size;
    }

    /* Slice clock. */
    g->counter += 1.0;
    if (g->counter >= g->slice_len) {
      g->counter = 0.0;
      if (g->active) {
        g->repeat_count += 1.0;
        if (g->repeat_count >= g->repeats) g->active = 0;
        else g->read_pos = 0.0;
      } else if (g->freeze || g->random(g->random_user) < g->probability) {
        g->active = 1;
        g->repeat_count = 0.0;
        g->read_pos = 0.0;
        g->slice_start = fmod((double)g->w - g->slice_len + n, n);
      }
    }

    if (g->active) {
      const double pr = g->read_pos * g->pitch_ratio;
      const double p = g->reverse > 0.5 ? g->slice_len - 1.0 - pr : pr;
      const double fp = floor(p);
      const double idx = fmod(g->slice_start + fp + n, n);
      const double idx2 = fmod(idx + 1.0, n);
      const double frac = p - fp;
      const double l0 = buf_at(g->buf_l, idx, g->buf_size);
      const double r0 = buf_at(g->buf_r, idx, g->buf_size);
      const double sl = l0 + (buf_at(g->buf_l, idx2, g->buf_size) - l0) * frac;
      const double sr = r0 + (buf_at(g->buf_r, idx2, g->buf_size) - r0) * frac;
      /* Boundary crossfade. */
      const double fade_in = bk_min(1.0, g->read_pos / g->xfade);
      const double fade_out = bk_min(1.0, (g->slice_len - g->read_pos) / g->xfade);
      const double env = bk_min(fade_in, fade_out);
      l[i] = (float)bk_sanitize(sl * env);
      r[i] = (float)bk_sanitize(sr * env);
      g->read_pos += 1.0;
      if (g->read_pos * g->pitch_ratio >= g->slice_len) g->read_pos = 0.0;
    }
  }
  g->meter = g->active ? 1.0 : 0.0;
}

double bk_glitch_meter(const bk_glitch *g) { return g->meter; }

static void glitch_vt_process(void *self, float *l, float *r, int frames) {
  bk_glitch_process((bk_glitch *)self, l, r, frames);
}
static void glitch_vt_reset(void *self) { bk_glitch_reset((bk_glitch *)self); }
static void glitch_vt_set_param(void *self, int key, double value) {
  bk_glitch_set_param((bk_glitch *)self, key, value);
}
static double glitch_vt_meter(const void *self) { return bk_glitch_meter((const bk_glitch *)self); }

const bk_effect_vt bk_glitch_vt = {glitch_vt_process, glitch_vt_reset, glitch_vt_set_param, NULL, NULL,
                                   glitch_vt_meter};

/* --- NoiseGen ------------------------------------------------------------- */

void bk_noise_gen_init(bk_noise_gen *n, double sample_rate) {
  n->sr = sample_rate;
  n->type = 1.0;
  bk_smoother_init(&n->level_sm, sample_rate, 30.0, 0.0);
  bk_pink_noise_init(&n->pink);
  n->brown = 0.0;
  n->follow = 0.0;
  bk_env_follower_init(&n->env, sample_rate, 5.0, 80.0, 0);
  bk_biquad_init(&n->lp[0], sample_rate);
  bk_biquad_init(&n->lp[1], sample_rate);
  n->lp_freq = 20000.0;
  bk_rng_seed(&n->rng, 0x5a827999u);
  n->random = internal_random;
  n->random_user = &n->rng;
}

void bk_noise_gen_set_random(bk_noise_gen *n, bk_random_fn fn, void *user) {
  if (fn) {
    n->random = fn;
    n->random_user = user;
  } else {
    n->random = internal_random;
    n->random_user = &n->rng;
  }
}

void bk_noise_gen_set_param(bk_noise_gen *n, int key, double value) {
  switch (key) {
    case BK_P_NOISE_TYPE:
      n->type = bk_clamp(js_round(value), 0.0, 2.0);
      break;
    case BK_P_NOISE_LEVEL:
      bk_smoother_set(&n->level_sm, bk_db_to_gain(value) * (value <= -60.0 ? 0.0 : 1.0));
      break;
    case BK_P_NOISE_FOLLOW:
      n->follow = bk_clamp(value, 0.0, 1.0);
      break;
    case BK_P_NOISE_TONE:
      n->lp_freq = value;
      break;
    default:
      break;
  }
}

void bk_noise_gen_reset(bk_noise_gen *n) { (void)n; }

void bk_noise_gen_process(bk_noise_gen *n, float *l, float *r, int frames) {
  int i;
  bk_biquad_set(&n->lp[0], BK_FILTER_LOWPASS, n->lp_freq, 0.7071, 0.0);
  bk_biquad_set(&n->lp[1], BK_FILTER_LOWPASS, n->lp_freq, 0.7071, 0.0);
  for (i = 0; i < frames; i++) {
    const double lvl = bk_smoother_next(&n->level_sm);
    double x;
    double g = lvl;
    if (n->type == 0.0) {
      x = n->random(n->random_user) * 2.0 - 1.0;
    } else if (n->type == 1.0) {
      x = bk_pink_noise_process(&n->pink, n->random(n->random_user) * 2.0 - 1.0);
    } else {
      n->brown = bk_clamp(n->brown + (n->random(n->random_user) * 2.0 - 1.0) * 0.02, -1.0, 1.0);
      x = n->brown * 3.0;
    }
    if (n->follow > 0.001) {
      const double e = bk_env_follower_process(&n->env, bk_max(fabs((double)l[i]), fabs((double)r[i])));
      g = lvl * (1.0 - n->follow + n->follow * bk_min(1.0, e * 4.0));
    }
    /* l is written before r is read, as in the JS. */
    l[i] = (float)bk_sanitize((double)l[i] + bk_biquad_process(&n->lp[0], x) * g);
    r[i] = (float)bk_sanitize((double)r[i] + bk_biquad_process(&n->lp[1], x) * g);
  }
}

static void noise_vt_process(void *self, float *l, float *r, int frames) {
  bk_noise_gen_process((bk_noise_gen *)self, l, r, frames);
}
static void noise_vt_reset(void *self) { bk_noise_gen_reset((bk_noise_gen *)self); }
static void noise_vt_set_param(void *self, int key, double value) {
  bk_noise_gen_set_param((bk_noise_gen *)self, key, value);
}

const bk_effect_vt bk_noise_gen_vt = {noise_vt_process, noise_vt_reset, noise_vt_set_param, NULL, NULL, NULL};
