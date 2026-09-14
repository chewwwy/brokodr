/*
 * Bro.Kodr DSP core — biquad filters. C port of dsp/core/biquad.js.
 *
 * This is route (c): C is canonical, compiled twice — natively for the desktop
 * host, and to wasm via emscripten for the web build. The JavaScript original
 * stays in the tree as the parity reference (and as the runtime fallback) until
 * the wasm path has real hours on it.
 *
 * Porting rules this file follows, and every later DSP module must follow too:
 *
 *   1. Pure C99. No C++, no libstdc++, nothing that needs a runtime. The same
 *      translation unit has to satisfy cc, MSVC and emcc without #ifdef soup.
 *
 *   2. State and coefficients are `double`, not `float`. This is not a taste
 *      call. A JS `Number` is an IEEE-754 double, so every intermediate in
 *      biquad.js is computed at double precision; the only float32 rounding is
 *      at the Float32Array boundary. Holding the recursion in `float` would
 *      diverge from the JS by far more than libm ever will, and would degrade
 *      the filters at low frequencies where the transposed-DF-II state is
 *      already the delicate part.
 *
 *   3. Audio buffers crossing the boundary stay `float` (32-bit), matching
 *      Float32Array and the WASAPI/worklet formats, so the block functions read
 *      float, compute double, write float — exactly as the JS does.
 *
 *   4. No allocation. Every struct is caller-owned and fixed size, so it can
 *      live in a preallocated arena on the audio thread.
 *
 * Divergence from the JS is expected but bounded, and comes from one place
 * only: cos/sin/pow/sqrt/tan are not bit-identical between V8, emscripten and
 * MSVC. scripts/verify-biquad-parity.mjs measures that divergence rather than
 * assuming it.
 */

#ifndef BROKODR_DSP_BIQUAD_H
#define BROKODR_DSP_BIQUAD_H

#include <stddef.h>

/* bk_sanitize / bk_clamp live here. They were declared in this header while
   biquad was the only ported module; now that utils.js has a port of its own
   they come from it, so there is exactly one definition in the tree. */
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Mirrors FilterType in biquad.js. Values are part of the wire contract. */
enum bk_filter_type {
  BK_FILTER_LOWPASS = 0,
  BK_FILTER_HIGHPASS = 1,
  BK_FILTER_BANDPASS = 2,
  BK_FILTER_NOTCH = 3,
  BK_FILTER_PEAK = 4,
  BK_FILTER_LOWSHELF = 5,
  BK_FILTER_HIGHSHELF = 6,
  BK_FILTER_ALLPASS = 7
};

/* Largest cascade the desktop build asks for: 48 dB/oct == 8 stages. */
#define BK_BIQUAD_MAX_STAGES 8

typedef struct {
  double sr;
  double b0, b1, b2, a1, a2;
  double z1, z2;
  /* Last-set parameters, for the idempotence check. Initialised to -1 like the
     JS, so the first set() always computes even if asked for type 0. */
  int type;
  double freq, q, gain_db;
} bk_biquad;

typedef struct {
  bk_biquad stages[BK_BIQUAD_MAX_STAGES];
  int count;
  /* -1 means "all stages", matching `active === undefined` in the JS. */
  int active;
} bk_biquad_cascade;

typedef struct {
  double sr;
  double ic1, ic2;
  double g, k, a1, a2, a3;
} bk_svf;

/* --- Biquad ------------------------------------------------------------- */

void bk_biquad_init(bk_biquad *f, double sample_rate);
void bk_biquad_reset(bk_biquad *f);

/* Idempotent: returns immediately when nothing changed, so a smoothed
   parameter that has settled costs one comparison instead of a cos/sin/pow. */
void bk_biquad_set(bk_biquad *f, int type, double freq, double q, double gain_db);

/* One sample, double in / double out. The parity reference for the JS
   `process(x)`. */
double bk_biquad_process(bk_biquad *f, double x);

/* In-place block over a float buffer — the real audio path. */
void bk_biquad_process_block(bk_biquad *f, float *buf, size_t n);

/* Magnitude response in dB, drives the EQ curve display. */
double bk_biquad_magnitude_db(const bk_biquad *f, double freq);

/* --- Cascade ------------------------------------------------------------ */

void bk_biquad_cascade_init(bk_biquad_cascade *c, double sample_rate, int stages);
void bk_biquad_cascade_set(bk_biquad_cascade *c, int type, double freq, double q, double gain_db);
void bk_biquad_cascade_set_active(bk_biquad_cascade *c, int n);
double bk_biquad_cascade_process(bk_biquad_cascade *c, double x);
void bk_biquad_cascade_process_block(bk_biquad_cascade *c, float *buf, size_t n);
void bk_biquad_cascade_reset(bk_biquad_cascade *c);
double bk_biquad_cascade_magnitude_db(const bk_biquad_cascade *c, double freq);

/* --- State-variable filter --------------------------------------------- */

enum bk_svf_mode { BK_SVF_LOWPASS = 0, BK_SVF_BANDPASS = 1, BK_SVF_HIGHPASS = 2 };

void bk_svf_init(bk_svf *s, double sample_rate);
void bk_svf_set(bk_svf *s, double freq, double q);
double bk_svf_process(bk_svf *s, double x, int mode);
void bk_svf_process_block(bk_svf *s, float *buf, size_t n, int mode);
void bk_svf_reset(bk_svf *s);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_BIQUAD_H */
