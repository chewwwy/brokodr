/*
 * Bro.Kodr DSP core — transport clock.
 * C port of dsp/core/clock.js. See biquad.h for the porting rules.
 *
 * Tempo, bar length, a quantise grid, and a monotonic frame counter, shared by
 * the whole engine. The looper reads it to quantise punches and to keep every
 * tempo-locked loop phase-aligned.
 *
 * Two design points are carried over verbatim from the JS because the looper
 * depends on both and a "tidier" port would break it:
 *
 *   1. THE COUNTER IS FREE-RUNNING, NOT A START/STOP TRANSPORT. The grid has to
 *      exist before anything plays — you hit record on the downbeat of a bar
 *      that has not happened yet. bk_clock_reset() is how the user says "the
 *      downbeat is now"; it does not stop the clock.
 *
 *   2. GRID BOUNDARIES ARE INTEGER FRAMES. frames_per_beat is fractional at
 *      almost every tempo, and a fractional loop length drifts against the grid
 *      a fraction of a sample per pass. Everything the looper aligns to is
 *      derived from grid_frames, an integer.
 *
 * `frame` is a double, not an int64, and that is deliberate rather than lazy: a
 * JS Number is what the reference holds, doubles are exact to 2^53 frames
 * (~5700 years at 48k), and the looper's position maths does `frame - anchor`
 * modulo a length — which has to round exactly the way the JS does or a
 * tempo-locked loop reads one sample off. fmod on a double integer below 2^53
 * is exact, so it does.
 *
 * Real-time discipline: no allocation, plain numbers only.
 */

#ifndef BROKODR_DSP_CLOCK_H
#define BROKODR_DSP_CLOCK_H

#include <stddef.h>

#include "brokodr/dsp/param-keys.h"

#ifdef __cplusplus
extern "C" {
#endif

/* MIN_BPM / MAX_BPM in clock.js. */
#define BK_MIN_BPM 20.0
#define BK_MAX_BPM 300.0

/*
 * QUANTIZE_CHOICES in clock.js, in beats. 0 means off (punch exactly when
 * asked). APPEND ONLY — the index is what the wire protocol and saved state
 * store. The clock itself takes a free beats value rather than an index, so
 * this table is here for the host's UI and for the parity battery, and nothing
 * in clock.c reads it.
 */
#define BK_QUANTIZE_CHOICE_COUNT 8
extern const double bk_quantize_choices[BK_QUANTIZE_CHOICE_COUNT];

typedef struct {
  double sr;
  double bpm;
  /* A double, not an int, for the same reason `frame` is: the JS holds a
     Number and clamp() is a ternary that passes NaN straight through, so an
     int field would need `(int)NaN` — undefined behaviour in C, and one that
     genuinely differs between x86 and wasm. Held as the Number the reference
     holds, and every use divides in double anyway. */
  double beats_per_bar;
  /* Quantise grid in beats. 0 = off. */
  double quantize;
  /* Absolute frames since the last reset. See the header note on why double. */
  double frame;
  int running;
  double frames_per_beat;
  /* Integer, and 0 when the grid is off. Derived, never set directly. */
  double grid_frames;
} bk_clock;

void bk_clock_init(bk_clock *c, double sample_rate);

/* --- control ------------------------------------------------------------ */

/* `key` is one of BK_CLOCK_P_* from param-keys.h. An unknown key is ignored,
   which is what the JS switch does by having no default. BK_CLOCK_P_RESET
   ignores `value` entirely. */
void bk_clock_set_param(bk_clock *c, int key, double value);

/* The downbeat is now. Does not stop the clock. */
void bk_clock_reset(bk_clock *c);

/* --- audio -------------------------------------------------------------- */

/* Called once per block, AFTER the block has been rendered — the looper's
   punch scheduling is relative to the frame the block started on. */
void bk_clock_advance(bk_clock *c, double frames);

/* Frames in `beats` beats, rounded to an integer so loop lengths stay exact.
   Floored at 1. */
double bk_clock_frames_for_beats(const bk_clock *c, double beats);

/* The JS's getters. Kept as functions rather than fields because every one of
   them is derived and a cached copy would be a second source of truth. */
double bk_clock_bar_frames(const bk_clock *c);
double bk_clock_beat(const bk_clock *c);
double bk_clock_bar(const bk_clock *c);
double bk_clock_bar_phase(const bk_clock *c);

/*
 * Frames from `frame` (absolute) to the next grid boundary. Returns 0 when the
 * grid is off, meaning "act immediately". NEVER returns 0 on an active grid —
 * landing exactly on a boundary returns a whole grid, because a punch asked for
 * at the boundary has already missed it by the time the block is rendered. The
 * looper relies on that, so it is a contract and not an off-by-one.
 */
double bk_clock_frames_to_grid(const bk_clock *c, double frame);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_CLOCK_H */
