/*
 * Bro.Kodr DSP core — BROBEATS synthesised drum kit. See drum-synth.h, which
 * explains why this is the first module without a JS bit-parity gate.
 *
 * The generators are transcribed from dsp/core/drum-synth.js expression by
 * expression, including association order, because even without a bit-identity
 * gate a transcription that reassociates is a transcription whose divergence
 * from the reference cannot be explained, and an unexplained divergence is
 * indistinguishable from a bug.
 *
 * Two places where the JS's arithmetic is not the obvious C, both load-bearing:
 *
 *   - THE HAT'S PHASES ARE FLOAT, NOT DOUBLE. renderHat holds them in a
 *     Float32Array, so every phase increment is rounded to float32 before the
 *     next one is added. In double they would drift apart from the reference
 *     immediately, and the six partials would beat differently. Same rule as
 *     bk_pink_noise.b and bk_pitch_tracker.buf (utils.h): hold state in float
 *     wherever the JS held a Float32Array. Every other accumulator here is a
 *     plain JS number and stays double.
 *
 *   - THE NOISE IS int32 ARITHMETIC. makeNoise's xorshift runs through JS
 *     bitwise operators, which are int32 with wraparound and one *logical*
 *     shift. It is computed here in uint32 (same bit patterns, no
 *     implementation-defined overflow) and reinterpreted as signed only at the
 *     division, and that reinterpretation is spelled out rather than cast,
 *     because casting a uint32 above INT_MAX to int32_t is implementation
 *     defined in C99 and this is not a place to rely on a compiler being
 *     reasonable.
 *
 * One documented divergence, on an input the JS handles incoherently: a NaN
 * `decay` or `noise_decay` makes the JS's frame count NaN, which then slips
 * past its own `frames <= 0` guard (NaN <= 0 is false) and returns a zero-
 * length buffer with frames: NaN — an object no caller can use. Here a
 * non-finite frame count is 0 frames, which is the same `null` the JS returns
 * for an unknown kind. The host clamps these params long before this, so this
 * is a difference in how two unreachable states are spelled.
 */

#include "brokodr/dsp/drum-synth.h"

#include <math.h>
#include <stddef.h>
#include <string.h>

/* ------------------------------------------------------------------ tables */

static const char *const KIND_NAMES[BK_DRUM_KIND_COUNT] = {"kick", "snare", "hat",
                                                           "clap", "tom",   "rim"};

const bk_drum_layout_entry bk_drum_default_layout[BK_DRUM_LAYOUT_COUNT] = {
    {0, BK_DRUM_KICK, "Kick", 0, 0, {{0, 0}}},
    {1, BK_DRUM_SNARE, "Snare", 0, 0, {{0, 0}}},
    {2, BK_DRUM_HAT, "Hat Cl", 1, 1, {{BK_DS_DECAY, 45}}},
    {3, BK_DRUM_HAT, "Hat Op", 1, 1, {{BK_DS_DECAY, 320}}},
    {4,
     BK_DRUM_KICK,
     "Sub",
     0,
     4,
     {{BK_DS_TUNE, 41}, {BK_DS_DECAY, 700}, {BK_DS_DROP, 18}, {BK_DS_CLICK, 0.05}}},
    {5, BK_DRUM_CLAP, "Clap", 0, 0, {{0, 0}}},
    {6, BK_DRUM_RIM, "Rim", 0, 0, {{0, 0}}},
    {7, BK_DRUM_SNARE, "Snare 2", 0, 3, {{BK_DS_TUNE, 240}, {BK_DS_DECAY, 110}, {BK_DS_SNAP, 0.85}}},
    {8, BK_DRUM_TOM, "Tom Lo", 0, 1, {{BK_DS_TUNE, 110}}},
    {9, BK_DRUM_TOM, "Tom Mid", 0, 1, {{BK_DS_TUNE, 165}}},
    {10, BK_DRUM_TOM, "Tom Hi", 0, 1, {{BK_DS_TUNE, 230}}},
    {11, BK_DRUM_HAT, "Ride", 0, 3, {{BK_DS_TUNE, 5200}, {BK_DS_DECAY, 900}, {BK_DS_TONE, 0.8}}},
    {12, BK_DRUM_KICK, "Kick 2", 0, 3, {{BK_DS_TUNE, 64}, {BK_DS_DECAY, 240}, {BK_DS_DRIVE, 0.6}}},
    {13, BK_DRUM_CLAP, "Snap", 0, 2, {{BK_DS_SPREAD, 8}, {BK_DS_DECAY, 90}}},
    {14, BK_DRUM_RIM, "Click", 0, 3, {{BK_DS_TUNE, 3200}, {BK_DS_DECAY, 18}, {BK_DS_TONE, 0.2}}},
    {15, BK_DRUM_HAT, "Shaker", 0, 3, {{BK_DS_TUNE, 6400}, {BK_DS_DECAY, 90}, {BK_DS_TONE, 0.1}}}};

int bk_drum_kind_from_name(const char *name) {
  int i;
  if (!name) return BK_DRUM_KIND_NONE;
  for (i = 0; i < BK_DRUM_KIND_COUNT; i++) {
    if (strcmp(name, KIND_NAMES[i]) == 0) return i;
  }
  return BK_DRUM_KIND_NONE;
}

const char *bk_drum_kind_name(int kind) {
  if (kind < 0 || kind >= BK_DRUM_KIND_COUNT) return NULL;
  return KIND_NAMES[kind];
}

void bk_drum_defaults(int kind, bk_drum_params *p) {
  if (!p) return;
  memset(p, 0, sizeof(*p));
  switch (kind) {
    case BK_DRUM_KICK:
      p->tune = 52;
      p->drop = 34;
      p->pitch_decay = 45;
      p->decay = 420;
      p->drive = 0.35;
      p->click = 0.3;
      p->level = 0;
      break;
    case BK_DRUM_SNARE:
      p->tune = 190;
      p->body = 0.5;
      p->decay = 180;
      p->noise_decay = 150;
      p->tone = 2400;
      p->snap = 0.6;
      p->level = 0;
      break;
    case BK_DRUM_HAT:
      p->tune = 8200;
      p->decay = 55;
      p->resonance = 1.6;
      p->tone = 0.6;
      p->level = -3;
      break;
    case BK_DRUM_CLAP:
      p->tune = 1400;
      p->spread = 24;
      p->decay = 200;
      p->tone = 0.55;
      p->level = -2;
      break;
    case BK_DRUM_TOM:
      p->tune = 140;
      p->drop = 12;
      p->pitch_decay = 80;
      p->decay = 320;
      p->drive = 0.2;
      p->level = -1;
      break;
    case BK_DRUM_RIM:
      p->tune = 1700;
      p->decay = 42;
      p->tone = 0.7;
      p->level = -4;
      break;
    default:
      break;
  }
}

int bk_drum_param_set(bk_drum_params *p, int key, double value) {
  if (!p) return 0;
  switch (key) {
    case BK_DS_TUNE: p->tune = value; return 1;
    case BK_DS_DROP: p->drop = value; return 1;
    case BK_DS_PITCH_DECAY: p->pitch_decay = value; return 1;
    case BK_DS_DECAY: p->decay = value; return 1;
    case BK_DS_DRIVE: p->drive = value; return 1;
    case BK_DS_CLICK: p->click = value; return 1;
    case BK_DS_LEVEL: p->level = value; return 1;
    case BK_DS_BODY: p->body = value; return 1;
    case BK_DS_NOISE_DECAY: p->noise_decay = value; return 1;
    case BK_DS_TONE: p->tone = value; return 1;
    case BK_DS_SNAP: p->snap = value; return 1;
    case BK_DS_RESONANCE: p->resonance = value; return 1;
    case BK_DS_SPREAD: p->spread = value; return 1;
    default: return 0;
  }
}

int bk_drum_layout_resolve(size_t index, bk_drum_params *p) {
  const bk_drum_layout_entry *e;
  int i;
  if (index >= (size_t)BK_DRUM_LAYOUT_COUNT || !p) return BK_DRUM_KIND_NONE;
  e = &bk_drum_default_layout[index];
  bk_drum_defaults(e->kind, p);
  for (i = 0; i < e->n_overrides; i++) bk_drum_param_set(p, e->overrides[i].key, e->overrides[i].value);
  return e->kind;
}

size_t bk_drum_render_capacity(double sr) {
  double n = ceil(sr * (double)BK_DRUM_MAX_SECONDS);
  if (!(n > 0)) return 0;
  return (size_t)n;
}

/* ----------------------------------------------------------------- helpers */

/* Exponential decay coefficient for a time constant in ms. */
static double decay_coef(double sr, double ms) { return exp(-1.0 / (sr * bk_max(ms, 0.5) * 0.001)); }

/* Soft saturation — the same tanh-ish curve the drive modules use, kept cheap.
   The `amount <= 0` early-out is not an optimisation: it is what makes drive 0
   exactly transparent instead of dividing by tanh(1). */
static double soft_clip(double x, double amount) {
  double k;
  if (amount <= 0) return x;
  k = 1.0 + amount * 9.0;
  return tanh(x * k) / tanh(k);
}

/* White noise with a fast xorshift — deterministic per render, so kits are
   repeatable. See the header note on int32 arithmetic. */
typedef struct {
  unsigned int s;
} ds_noise;

static void noise_init(ds_noise *n, int seed) {
  /* `seed | 0 || 22222` — a seed of zero would lock the shift register. */
  n->s = seed ? (unsigned int)seed : 22222u;
}

static double noise_next(ds_noise *n) {
  unsigned int s = n->s;
  double v;
  s ^= s << 13;
  s ^= s >> 17; /* JS >>> — logical, on the same bit pattern */
  s ^= s << 5;
  n->s = s;
  /* Reinterpret as int32 without an implementation-defined conversion. */
  v = (s & 0x80000000u) ? ((double)s - 4294967296.0) : (double)s;
  return (v / 2147483648.0) * 0.5;
}

/* One-pole state-variable filter, used inline so the generators stay
   self-contained and do not drag Biquad's per-sample coefficient machinery
   into an offline loop. Bandpass takes the band output, highpass the high one
   with its damping fixed at 0.8 — the JS has two closures, which is one struct
   with two readouts. */
typedef struct {
  double f;
  double damp;
  double low;
  double band;
} ds_svf;

static void svf_init(ds_svf *s, double sr, double freq, double damp) {
  s->f = 2.0 * sin((BK_PI * bk_clamp(freq, 20, sr * 0.45)) / sr);
  s->damp = damp;
  s->low = 0;
  s->band = 0;
}

static void bp_init(ds_svf *s, double sr, double freq, double q) {
  svf_init(s, sr, freq, 1.0 / bk_max(q, 0.5));
}

static void hp_init(ds_svf *s, double sr, double freq) { svf_init(s, sr, freq, 0.8); }

static double bp_run(ds_svf *s, double x) {
  double high;
  s->low += s->f * s->band;
  high = x - s->low - s->damp * s->band;
  s->band += s->f * high;
  return s->band;
}

static double hp_run(ds_svf *s, double x) {
  double high;
  s->low += s->f * s->band;
  high = x - s->low - s->damp * s->band;
  s->band += s->f * high;
  return high;
}

/* `Math.min(out.length, Math.ceil(sr * Math.min(seconds, MAX_SECONDS)))`, with
   a non-finite result reported as zero frames (see the header note). */
static size_t frame_count(double sr, double seconds, size_t out_len) {
  double want = ceil(sr * bk_min(seconds, (double)BK_DRUM_MAX_SECONDS));
  if (!(want > 0)) return 0;
  if (want >= (double)out_len) return out_len;
  return (size_t)want;
}

/* -------------------------------------------------------------- generators */

static size_t render_kick(double sr, const bk_drum_params *p, float *out, size_t out_len) {
  size_t n = frame_count(sr, (p->decay * 3.0) / 1000.0 + 0.05, out_len);
  double amp_c = decay_coef(sr, p->decay);
  double pitch_c = decay_coef(sr, p->pitch_decay);
  double base = bk_clamp(p->tune, 20, 200);
  /* The drop is expressed in semitones so it behaves musically when the tune
     changes. */
  double top = base * pow(2.0, bk_clamp(p->drop, 0, 48) / 12.0);
  ds_svf hp;
  double amp = 1, pitch_env = 1, phase = 0;
  double click_n = ceil(sr * 0.003);
  size_t i;

  hp_init(&hp, sr, 18);
  for (i = 0; i < n; i++) {
    double f = base + (top - base) * pitch_env;
    double x;
    phase += (BK_TWO_PI * f) / sr;
    if (phase > BK_TWO_PI) phase -= BK_TWO_PI;

    x = sin(phase) * amp;
    /* A short burst of the fundamental's transient so it cuts on small
       speakers. */
    if ((double)i < click_n) x += (1.0 - (double)i / click_n) * p->click * ((i % 2) ? -1.0 : 1.0) * 0.5;
    x = soft_clip(x, p->drive);

    out[i] = (float)bk_sanitize(hp_run(&hp, x));
    amp *= amp_c;
    pitch_env *= pitch_c;
  }
  return n;
}

static size_t render_tom(double sr, const bk_drum_params *p, float *out, size_t out_len) {
  /* `renderKick(sr, { ...p, click: 0 }, out)` — a tom is a kick without the
     transient click, and the override wins over whatever the caller passed. */
  bk_drum_params q = *p;
  q.click = 0;
  return render_kick(sr, &q, out, out_len);
}

static size_t render_snare(double sr, const bk_drum_params *p, float *out, size_t out_len) {
  size_t n = frame_count(sr, (bk_max(p->decay, p->noise_decay) * 3.0) / 1000.0 + 0.05, out_len);
  double body_c = decay_coef(sr, p->decay);
  double noise_c = decay_coef(sr, p->noise_decay);
  ds_noise noise;
  ds_svf bp, hp;
  double f1 = bk_clamp(p->tune, 80, 600);
  double f2 = f1 * 1.47; /* the second mode of a drum head, slightly inharmonic */
  double body_amp = 1, noise_amp = 1, ph1 = 0, ph2 = 0;
  double body_mix = bk_clamp(p->body, 0, 1);
  size_t i;

  noise_init(&noise, 9187);
  bp_init(&bp, sr, p->tone, 0.9);
  hp_init(&hp, sr, 180);

  for (i = 0; i < n; i++) {
    double body, snares;
    ph1 += (BK_TWO_PI * f1) / sr;
    ph2 += (BK_TWO_PI * f2) / sr;
    if (ph1 > BK_TWO_PI) ph1 -= BK_TWO_PI;
    if (ph2 > BK_TWO_PI) ph2 -= BK_TWO_PI;

    body = (sin(ph1) * 0.7 + sin(ph2) * 0.3) * body_amp;
    snares = hp_run(&hp, bp_run(&bp, noise_next(&noise))) * noise_amp * (1.0 + p->snap * 2.0);

    out[i] = (float)bk_sanitize(soft_clip(body * body_mix + snares * (1.0 - body_mix * 0.5), 0.15));
    body_amp *= body_c;
    noise_amp *= noise_c;
  }
  return n;
}

static size_t render_hat(double sr, const bk_drum_params *p, float *out, size_t out_len) {
  /* Six inharmonic square partials is the classic metallic-hat recipe; mixing
     them under the noise is what stops it sounding like a plain noise burst.
     The comparator on sin() is also why this module has no bit-parity gate —
     see drum-synth.h. */
  static const double RATIOS[6] = {2, 3.01, 4.17, 5.43, 6.79, 8.21};
  size_t n = frame_count(sr, (p->decay * 4.0) / 1000.0 + 0.01, out_len);
  double amp_c = decay_coef(sr, p->decay);
  ds_noise noise;
  ds_svf bp, hp;
  double base_f = bk_clamp(p->tune, 1000, 14000) * 0.18;
  float ph[6]; /* Float32Array in the JS — see the header note */
  double amp = 1;
  double metal = bk_clamp(p->tone, 0, 1);
  size_t i;
  int k;

  noise_init(&noise, 4421);
  bp_init(&bp, sr, p->tune, p->resonance);
  hp_init(&hp, sr, bk_clamp(p->tune * 0.6, 200, 12000));
  for (k = 0; k < 6; k++) ph[k] = 0.0f;

  for (i = 0; i < n; i++) {
    double m = 0, x;
    for (k = 0; k < 6; k++) {
      ph[k] = (float)((double)ph[k] + (BK_TWO_PI * base_f * RATIOS[k]) / sr);
      if ((double)ph[k] > BK_TWO_PI) ph[k] = (float)((double)ph[k] - BK_TWO_PI);
      m += (sin((double)ph[k]) >= 0) ? 1.0 : -1.0;
    }
    m /= 6.0;

    x = (m * metal + noise_next(&noise) * 2.0 * (1.0 - metal)) * amp;
    out[i] = (float)bk_sanitize(hp_run(&hp, bp_run(&bp, x)) * 1.6);
    amp *= amp_c;
  }
  return n;
}

static size_t render_clap(double sr, const bk_drum_params *p, float *out, size_t out_len) {
  size_t n = frame_count(sr, (p->decay * 3.0) / 1000.0 + 0.08, out_len);
  ds_noise noise;
  ds_svf bp, hp;
  double tail_c = decay_coef(sr, p->decay);
  /* A clap is three fast slaps then a room tail — the slaps are what make it
     read as hands rather than a noise gate. */
  double gap = bk_max(1.0, floor((sr * bk_clamp(p->spread, 4, 80)) / 1000.0 + 0.5));
  double slap_c = decay_coef(sr, 12);
  double tail = 0, slap = 1, next_slap = gap;
  int slaps_left = 2;
  size_t i;

  noise_init(&noise, 31337);
  bp_init(&bp, sr, p->tune, 1.1 + p->tone);
  hp_init(&hp, sr, 500);

  for (i = 0; i < n; i++) {
    double env;
    if ((double)i == next_slap && slaps_left > 0) {
      slap = 1;
      slaps_left--;
      next_slap += gap;
    }
    if (slaps_left == 0 && tail == 0 && slap < 0.4) tail = 0.7;

    env = slap + tail;
    out[i] = (float)bk_sanitize(hp_run(&hp, bp_run(&bp, noise_next(&noise) * 2.0)) * env * 1.3);
    slap *= slap_c;
    tail *= tail_c;
  }
  return n;
}

static size_t render_rim(double sr, const bk_drum_params *p, float *out, size_t out_len) {
  size_t n = frame_count(sr, (p->decay * 5.0) / 1000.0 + 0.01, out_len);
  double amp_c = decay_coef(sr, p->decay);
  ds_noise noise;
  ds_svf bp;
  double f = bk_clamp(p->tune, 200, 6000);
  double amp = 1, phase = 0;
  double woodiness = bk_clamp(p->tone, 0, 1);
  size_t i;

  noise_init(&noise, 777);
  bp_init(&bp, sr, p->tune, 3.2);

  for (i = 0; i < n; i++) {
    double x;
    phase += (BK_TWO_PI * f) / sr;
    if (phase > BK_TWO_PI) phase -= BK_TWO_PI;
    x = sin(phase) * woodiness + noise_next(&noise) * 2.0 * (1.0 - woodiness);
    out[i] = (float)bk_sanitize(bp_run(&bp, x) * amp * 1.5);
    amp *= amp_c;
  }
  return n;
}

/* -------------------------------------------------------------- public API */

size_t bk_drum_render(int kind, double sr, const bk_drum_params *p, float *out, size_t out_len) {
  size_t frames = 0, i;
  double peak = 0, g, lv, fade_d;
  size_t fade;

  if (!p || !out || out_len == 0) return 0;

  switch (kind) {
    case BK_DRUM_KICK: frames = render_kick(sr, p, out, out_len); break;
    case BK_DRUM_SNARE: frames = render_snare(sr, p, out, out_len); break;
    case BK_DRUM_HAT: frames = render_hat(sr, p, out, out_len); break;
    case BK_DRUM_CLAP: frames = render_clap(sr, p, out, out_len); break;
    case BK_DRUM_TOM: frames = render_tom(sr, p, out, out_len); break;
    case BK_DRUM_RIM: frames = render_rim(sr, p, out, out_len); break;
    default: return 0; /* renderDrum's `return null` for an unknown kind */
  }
  if (frames == 0) return 0;

  /* Normalise to a consistent working level, then apply the kind's own trim.
     Without this, changing the decay of a kick also changes how loud it is,
     which makes the knob feel broken. */
  for (i = 0; i < frames; i++) {
    double a = fabs((double)out[i]);
    if (a > peak) peak = a;
  }
  /* `dbToGain(p.level || 0)` — JS's `||` turns NaN (and -0) into 0. */
  lv = (p->level != p->level) ? 0.0 : p->level;
  g = (peak > 1e-6 ? 0.89 / peak : 1.0) * bk_db_to_gain(lv);
  for (i = 0; i < frames; i++) out[i] = (float)bk_sanitize((double)out[i] * g);

  /* A 2 ms fade-out guarantees no click at the end regardless of where the
     decay landed. Math.round is floor(x + 0.5), which differs from C's round()
     on exact halves of negative numbers — not reachable here, but spelled out
     rather than assumed. */
  fade_d = floor(sr * 0.002 + 0.5);
  fade = (!(fade_d > 0)) ? 0 : (fade_d >= (double)frames ? frames : (size_t)fade_d);
  for (i = 0; i < fade; i++) {
    out[frames - 1 - i] = (float)((double)out[frames - 1 - i] * ((double)i / (double)fade));
  }

  return frames;
}
