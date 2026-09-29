/*
 * Bro.Kodr DSP core — transport clock. C port of dsp/core/clock.js.
 * Read clock.h first: it carries why the counter is free-running, why grid
 * boundaries are integers, and why `frame` is a double.
 */

#include "brokodr/dsp/clock.h"

#include <math.h>

#include "brokodr/dsp/utils.h"

/* Math.round, which is floor(x + 0.5) and NOT C's round() — the two disagree
   on negative halves (round(-2.5) is -3, Math.round(-2.5) is -2). Same local
   helper as drum-rack.c, for the same reason.

   Worth knowing when reading the parity battery: inside THIS module the
   round()/Math.round() difference happens to be unobservable, and that is a
   property of the call sites rather than of the rounding. All three of them
   swallow a negative result — recalc_grid and frames_for_beats floor at 1, and
   the beats_per_bar setter clamps to [1, 16] — and a negative half is the only
   input the two functions disagree on. So the battery cannot catch round() here
   and does not pretend to; it catches nearbyint() instead, which is the same
   mistake made in the direction that IS reachable (nearbyint rounds positive
   halves to even, and positive halves are all over the grid sweep). The form is
   kept literal anyway: this helper gets copied into modules whose call sites do
   not clamp. */
static double js_round(double x) { return floor(x + 0.5); }

const double bk_quantize_choices[BK_QUANTIZE_CHOICE_COUNT] = {0.0,  0.25, 0.5, 1.0,
                                                              2.0,  4.0,  8.0, 16.0};

static void recalc_grid(bk_clock *c) {
  c->grid_frames = c->quantize > 0.0 ? bk_max(1.0, js_round(c->quantize * c->frames_per_beat)) : 0.0;
}

void bk_clock_init(bk_clock *c, double sample_rate) {
  if (!c) return;
  c->sr = sample_rate;
  c->bpm = 120.0;
  c->beats_per_bar = 4.0;
  c->quantize = 4.0;
  c->frame = 0.0;
  c->running = 1;
  c->frames_per_beat = (sample_rate * 60.0) / c->bpm;
  /* The constructor does NOT go through recalc_grid: it computes the grid
     unconditionally, without the `quantize > 0` test, because the default
     quantize is 4. Identical result here, but kept literal so the two paths
     stay separately auditable against the JS. */
  c->grid_frames = bk_max(1.0, js_round(c->quantize * c->frames_per_beat));
}

void bk_clock_set_param(bk_clock *c, int key, double value) {
  if (!c) return;
  switch (key) {
    case BK_CLOCK_P_BPM:
      c->bpm = bk_clamp(value, BK_MIN_BPM, BK_MAX_BPM);
      c->frames_per_beat = (c->sr * 60.0) / c->bpm;
      recalc_grid(c);
      break;
    case BK_CLOCK_P_BEATS_PER_BAR:
      c->beats_per_bar = bk_clamp(js_round(value), 1.0, 16.0);
      break;
    case BK_CLOCK_P_QUANTIZE:
      /* A free value rather than an index into bk_quantize_choices: the UI
         sends beats, so an odd grid (3 beats) is possible without touching the
         wire protocol. Note the asymmetry the JS has and this keeps — `<= 0`
         is off, but a positive value below the clamp floor is lifted to
         0.0625 rather than treated as off. */
      c->quantize = value <= 0.0 ? 0.0 : bk_clamp(value, 0.0625, 64.0);
      recalc_grid(c);
      break;
    case BK_CLOCK_P_RUN:
      c->running = value >= 0.5;
      break;
    case BK_CLOCK_P_RESET:
      bk_clock_reset(c);
      break;
    default:
      break;
  }
}

void bk_clock_reset(bk_clock *c) {
  if (c) c->frame = 0.0;
}

void bk_clock_advance(bk_clock *c, double frames) {
  if (c && c->running) c->frame += frames;
}

double bk_clock_frames_for_beats(const bk_clock *c, double beats) {
  return bk_max(1.0, js_round(beats * c->frames_per_beat));
}

double bk_clock_bar_frames(const bk_clock *c) {
  return bk_clock_frames_for_beats(c, c->beats_per_bar);
}

double bk_clock_beat(const bk_clock *c) { return c->frame / c->frames_per_beat; }

double bk_clock_bar(const bk_clock *c) { return bk_clock_beat(c) / c->beats_per_bar; }

double bk_clock_bar_phase(const bk_clock *c) {
  const double b = bk_clock_bar(c);
  return b - floor(b);
}

double bk_clock_frames_to_grid(const bk_clock *c, double frame) {
  const double g = c->grid_frames;
  double rem;
  /* `g <= 0.0` literally, NOT the NaN-safe-looking `!(g > 0.0)`: a NaN grid
     (reachable — setParam("bpm", NaN) makes frames_per_beat NaN and the grid
     with it) fails `<= 0`, so the JS falls through and answers NaN. The
     inverted form would answer 0 = "act immediately" instead, which is a
     different decision in the looper, not a tidier guard. */
  if (g <= 0.0) return 0.0;
  /* fmod, not %, and not an integer cast: `frame` can exceed any int range and
     the JS operator is a truncating remainder on doubles, which is exactly
     fmod. Both are exact for integral doubles under 2^53. */
  rem = fmod(frame, g);
  return g - rem;
}
