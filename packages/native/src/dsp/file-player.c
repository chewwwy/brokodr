/*
 * Bro.Kodr DSP core — audio file player. C port of dsp/core/file-player.js.
 * Read file-player.h first: it carries the signal path and the three things
 * the port must hold exactly (float stores, ToInt32 masking, borrowed source).
 */

#include "brokodr/dsp/file-player.h"

#include <math.h>

/* --- JS semantics the obvious C gets wrong ------------------------------ */

/* Math.round. Not floor(x + 0.5): that rounds 0.49999999999999994 up, because
   the addition itself rounds. x - floor(x) is exact for every double this
   module sees, so comparing the fraction is exact too. NaN stays NaN, -0 stays
   -0 (Math.round(-0) is -0). */
static double js_round(double x) {
  const double r = floor(x);
  return (x - r >= 0.5) ? r + 1.0 : r;
}

/* Math.min / Math.max with BOTH of their non-obvious rules: NaN propagates,
   and -0 is less than +0. bk_min/bk_max in utils.c have the first and not the
   second; that is harmless at every call site they serve, but here a loop
   point of -0 (clamp passes -0 through) reaches src_pos and the playhead, and
   the parity battery compares bits. Local rather than a change to utils.c,
   which would put twelve green batteries back in play for one module. */
static double js_min(double a, double b) {
  if (a != a || b != b) return a + b; /* NaN */
  if (a == b) return signbit(a) ? a : b;
  return a < b ? a : b;
}

static double js_max(double a, double b) {
  if (a != a || b != b) return a + b;
  if (a == b) return signbit(a) ? b : a;
  return a > b ? a : b;
}

/* `x & FIFO_MASK` in the JS: ToInt32(x), then AND. The counters are integer
   valued and far below 2^31 in any real session, so the fast path is a plain
   cast; the slow path is the spec's modulo-2^32 for the rest, and NaN/inf map
   to 0 exactly as ToInt32 does. A bare (int) cast of NaN is undefined
   behaviour and differs between x86 and wasm. */
static int fifo_index(double x) {
  double t, m;
  if (x >= -2147483648.0 && x < 2147483648.0) return (int)((unsigned int)(int)x & BK_FP_FIFO_MASK);
  if (!isfinite(x)) return 0;
  t = trunc(x);
  m = fmod(t, 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return (int)((unsigned int)m & BK_FP_FIFO_MASK);
}

/* A typed-array read. Out of range or non-integer is `undefined` in the JS,
   which is NaN the moment it meets arithmetic or a Float32Array store. Every
   index this module now produces is an in-range integer (the loop points are
   whole frames), so this is a guard for NaN and degenerate regions — and it is
   also what keeps a NaN loop point from turning into an out-of-bounds read. */
static double src_at(const float *ch, int frames, double idx) {
  if (!(idx >= 0.0 && idx < (double)frames) || idx != floor(idx)) return (double)NAN;
  return (double)ch[(size_t)idx];
}

/* --- lifecycle ---------------------------------------------------------- */

static void flush(bk_file_player *p) {
  int i;
  for (i = 0; i < BK_FP_FIFO; i++) {
    p->fifo_l[i] = 0.0f;
    p->fifo_r[i] = 0.0f;
  }
  p->fifo_write = 0.0;
  p->fifo_read = 0.0;
  p->ola_pos = 0.0;
  p->has_ref = 0;
}

void bk_file_player_init(bk_file_player *p, double sample_rate, int max_block) {
  int i;
  if (!p) return;
  p->sr = sample_rate;
  p->max_block = max_block;
  p->ch_l = NULL;
  p->ch_r = NULL;
  p->frames = 0;
  p->src_rate = sample_rate;
  p->playing = 0;
  p->loop_enabled = 0;
  p->loop_in = 0.0;
  p->loop_out = 0.0;
  p->src_pos = 0.0;
  p->ended = 0;
  p->speed = 1.0;
  p->pitch_semis = 0.0;
  bk_smoother_init(&p->gain_sm, sample_rate, 6.0, 0.0);
  p->level_db = 0.0;
  p->level = 1.0;
  for (i = 0; i < BK_FP_FIFO; i++) {
    p->fifo_l[i] = 0.0f;
    p->fifo_r[i] = 0.0f;
  }
  p->fifo_write = 0.0;
  p->fifo_read = 0.0;
  p->ola_pos = 0.0;
  for (i = 0; i < BK_FP_CORR; i++) p->ref_l[i] = 0.0f;
  p->has_ref = 0;
  for (i = 0; i < BK_FP_GRAIN; i++) {
    p->window[i] = (float)(0.5 - 0.5 * cos((BK_TWO_PI * (double)i) / (double)BK_FP_GRAIN));
  }
  p->meter = 0.0;
  p->position = 0.0;
}

void bk_file_player_set_buffer(bk_file_player *p, const float *l, const float *r, int frames,
                               double src_rate) {
  p->ch_l = l;
  p->ch_r = r ? r : l;
  p->frames = frames;
  p->src_rate = src_rate > 0.0 ? src_rate : p->sr;
  p->loop_in = 0.0;
  p->loop_out = (double)p->frames;
  p->src_pos = 0.0;
  p->playing = 0;
  p->ended = 0;
  bk_smoother_reset(&p->gain_sm, 0.0);
  flush(p);
}

void bk_file_player_clear_buffer(bk_file_player *p) {
  p->playing = 0;
  p->ch_l = NULL;
  p->ch_r = NULL;
  p->frames = 0;
  p->src_pos = 0.0;
  p->position = 0.0;
  bk_smoother_reset(&p->gain_sm, 0.0);
  flush(p);
}

int bk_file_player_loaded(const bk_file_player *p) { return p->ch_l != NULL && p->frames > 0; }

int bk_file_player_active(const bk_file_player *p) {
  return bk_file_player_loaded(p) &&
         (p->playing || !bk_smoother_settled(&p->gain_sm) || p->gain_sm.value > 1e-4);
}

static double region_start(const bk_file_player *p) { return p->loop_enabled ? p->loop_in : 0.0; }

static double region_end(const bk_file_player *p) {
  return p->loop_enabled ? p->loop_out : (double)p->frames;
}

/* --- control ------------------------------------------------------------ */

void bk_file_player_set_param(bk_file_player *p, int key, double v) {
  switch (key) {
    case BK_FILE_P_PLAY: {
      const int on = v >= 0.5;
      if (on && !p->playing) {
        if (!bk_file_player_loaded(p)) break;
        if (p->ended) {
          p->src_pos = region_start(p);
          p->ended = 0;
        }
        flush(p);
        p->playing = 1;
      } else if (!on && p->playing) {
        p->playing = 0;
      }
      break;
    }
    case BK_FILE_P_SEEK: {
      const double a = region_start(p);
      const double b = region_end(p);
      p->src_pos = bk_clamp(a + v * (b - a), 0.0, js_max(0.0, (double)(p->frames - 1)));
      p->ended = 0;
      flush(p);
      break;
    }
    case BK_FILE_P_LOOP:
      p->loop_enabled = v >= 0.5;
      break;
    case BK_FILE_P_LOOP_IN: {
      const double f = js_round(bk_clamp(v, 0.0, 1.0) * (double)p->frames);
      p->loop_in = js_min(f, js_max(0.0, p->loop_out - 128.0));
      break;
    }
    case BK_FILE_P_LOOP_OUT: {
      const double f = js_round(bk_clamp(v, 0.0, 1.0) * (double)p->frames);
      p->loop_out = js_max(f, p->loop_in + 128.0);
      if (p->loop_out > (double)p->frames) p->loop_out = (double)p->frames;
      break;
    }
    case BK_FILE_P_SPEED:
      p->speed = bk_clamp(v, 0.25, 4.0);
      break;
    case BK_FILE_P_PITCH:
      p->pitch_semis = bk_clamp(v, -24.0, 24.0);
      break;
    case BK_FILE_P_GAIN:
      p->level_db = bk_clamp(v, -60.0, 12.0);
      p->level = p->level_db <= -60.0 ? 0.0 : pow(10.0, p->level_db / 20.0);
      break;
    default:
      break;
  }
}

void bk_file_player_reset(bk_file_player *p) {
  p->playing = 0;
  bk_smoother_reset(&p->gain_sm, 0.0);
  flush(p);
}

/* --- audio -------------------------------------------------------------- */

/* Wrapped source read: -1 means "past the end, not looping". */
static double src_index(const bk_file_player *p, double idx) {
  const double a = region_start(p);
  const double b = region_end(p);
  const double len = b - a;
  if (len <= 0.0) return -1.0;
  if (idx >= b) {
    if (!p->loop_enabled) return -1.0;
    return a + fmod(idx - a, len);
  }
  if (idx < a) {
    double back;
    if (!p->loop_enabled) return idx < 0.0 ? -1.0 : idx;
    back = fmod(a - idx, len);
    return back == 0.0 ? a : b - back;
  }
  return idx;
}

static double wrap_pos(const bk_file_player *p, double pos) {
  double a, b, len;
  if (!p->loop_enabled) return pos;
  a = region_start(p);
  b = region_end(p);
  len = b - a;
  if (len <= 0.0) return pos;
  if (pos >= b) return a + fmod(pos - a, len);
  if (pos < a) return b - fmod(a - pos, len);
  return pos;
}

static void copy_run(bk_file_player *p) {
  const int n = BK_FP_HOP;
  const double base = floor(p->src_pos);
  const double w = p->fifo_write;
  int i;
  for (i = 0; i < n; i++) {
    const double idx = src_index(p, base + (double)i);
    const int o = fifo_index(w + (double)i);
    if (idx < 0.0) {
      p->fifo_l[o] = 0.0f;
      p->fifo_r[o] = 0.0f;
      p->ended = 1;
    } else {
      p->fifo_l[o] = (float)src_at(p->ch_l, p->frames, idx);
      p->fifo_r[o] = (float)src_at(p->ch_r, p->frames, idx);
    }
  }
  p->fifo_write = w + (double)n;
  p->src_pos = wrap_pos(p, base + (double)n);
}

static void grain(bk_file_player *p, double alpha) {
  const double base = floor(p->src_pos);
  const double q = p->ola_pos;
  double best = base;
  int i, dead = 0;

  if (p->has_ref) {
    double best_score = -INFINITY;
    int k;
    for (k = -BK_FP_TOLERANCE; k <= BK_FP_TOLERANCE; k += BK_FP_CORR_STEP) {
      const double start = base + (double)k;
      double dot = 0.0, energy = 1e-9, score;
      if (start < 0.0) continue;
      for (i = 0; i < BK_FP_CORR; i += BK_FP_CORR_STEP) {
        const double idx = src_index(p, start + (double)i);
        double s;
        if (idx < 0.0) break;
        s = src_at(p->ch_l, p->frames, idx);
        dot += s * (double)p->ref_l[i];
        energy += s * s;
      }
      score = dot / sqrt(energy);
      if (score > best_score) {
        best_score = score;
        best = start;
      }
    }
  }

  for (i = BK_FP_HOP; i < BK_FP_GRAIN; i++) {
    const int o = fifo_index(q + (double)i);
    p->fifo_l[o] = 0.0f;
    p->fifo_r[o] = 0.0f;
  }
  for (i = 0; i < BK_FP_GRAIN; i++) {
    const double idx = src_index(p, best + (double)i);
    const int o = fifo_index(q + (double)i);
    const double w = (double)p->window[i];
    if (idx < 0.0) {
      dead = 1;
      continue;
    }
    p->fifo_l[o] = (float)((double)p->fifo_l[o] + src_at(p->ch_l, p->frames, idx) * w);
    p->fifo_r[o] = (float)((double)p->fifo_r[o] + src_at(p->ch_r, p->frames, idx) * w);
  }
  if (dead) p->ended = 1;

  for (i = 0; i < BK_FP_CORR; i++) {
    const double idx = src_index(p, best + (double)BK_FP_HOP + (double)i);
    p->ref_l[i] = idx < 0.0 ? 0.0f : (float)src_at(p->ch_l, p->frames, idx);
  }
  p->has_ref = 1;

  p->fifo_write = q;
  p->ola_pos = q + (double)BK_FP_HOP;
  p->src_pos = base + (double)BK_FP_HOP * alpha;
}

static void fill(bk_file_player *p, double count, double alpha) {
  const int identity = fabs(alpha - 1.0) < 1e-3;
  int guard = 0;
  while (p->fifo_write - floor(p->fifo_read) < count && guard++ < 64) {
    if (identity) copy_run(p);
    else grain(p, alpha);
    if (p->ended) break;
  }
}

static double cubic(double y0, double y1, double y2, double y3, double t) {
  const double c0 = y1;
  const double c1 = 0.5 * (y2 - y0);
  const double c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
  const double c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + c0;
}

int bk_file_player_process(bk_file_player *p, float *out_l, float *out_r, int frames) {
  const double target = p->playing ? 1.0 : 0.0;
  double base, ratio, r, alpha, need, pk = 0.0, lvl, span;
  int i;

  bk_smoother_set(&p->gain_sm, target);

  if (!bk_file_player_loaded(p) ||
      (!p->playing && bk_smoother_settled(&p->gain_sm) && p->gain_sm.value < 1e-4)) {
    for (i = 0; i < frames; i++) {
      out_l[i] = 0.0f;
      out_r[i] = 0.0f;
    }
    p->meter = 0.0;
    return 0;
  }

  base = p->src_rate / p->sr;
  ratio = bk_semitones_to_ratio(p->pitch_semis);
  r = base * ratio;
  alpha = p->speed / ratio;

  need = ceil((double)frames * r) + 4.0;
  fill(p, need, alpha);

  lvl = p->level;
  for (i = 0; i < frames; i++) {
    const double g = bk_smoother_next(&p->gain_sm) * lvl;
    const double rp = p->fifo_read;
    const double i0 = floor(rp);
    const double fr = rp - i0;
    const double a0 = p->fifo_l[fifo_index(i0 - 1.0)];
    const double a1 = p->fifo_l[fifo_index(i0)];
    const double a2 = p->fifo_l[fifo_index(i0 + 1.0)];
    const double a3 = p->fifo_l[fifo_index(i0 + 2.0)];
    const double b0 = p->fifo_r[fifo_index(i0 - 1.0)];
    const double b1 = p->fifo_r[fifo_index(i0)];
    const double b2 = p->fifo_r[fifo_index(i0 + 1.0)];
    const double b3 = p->fifo_r[fifo_index(i0 + 2.0)];
    const double l = cubic(a0, a1, a2, a3, fr) * g;
    const double rr = cubic(b0, b1, b2, b3, fr) * g;
    const double al = fabs(l);
    out_l[i] = (float)bk_sanitize(l);
    out_r[i] = (float)bk_sanitize(rr);
    if (al > pk) pk = al;
    p->fifo_read = rp + r;
    if (p->fifo_read >= p->fifo_write) p->fifo_read = p->fifo_write;
  }

  p->meter = pk;
  if (p->ended && !p->loop_enabled) {
    p->playing = 0;
    bk_smoother_set(&p->gain_sm, 0.0);
  }

  /* The JS recomputes the same clamp a second time when the region starts past
     0 and is not looping; the second assignment is a no-op and is not ported. */
  span = js_max(1.0, (double)p->frames);
  p->position = bk_clamp(p->src_pos / span, 0.0, 1.0);
  return 1;
}
