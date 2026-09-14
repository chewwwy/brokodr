/*
 * Bro.Kodr DSP core — math utilities. C port of dsp/core/utils.js.
 *
 * Route (c): C is canonical, compiled twice — natively for the desktop host and
 * to wasm via emscripten for the web build. See biquad.h for the porting rules;
 * they apply here unchanged. The short version:
 *
 *   - pure C99, no allocation, caller-owned fixed-size structs;
 *   - state and coefficients are `double`, because a JS Number is a double;
 *   - EXCEPT where the JS itself holds state in a Float32Array, in which case
 *     the C must hold `float` too or it will diverge far more than libm does.
 *     Two structs here are in that category and say so at their definition:
 *     bk_pink_noise (utils.js `this.b = new Float32Array(7)`) and
 *     bk_pitch_tracker (`this.buf = new Float32Array(...)`).
 *
 * Randomness is factored out rather than ported. Math.random() has no C
 * equivalent and nothing about it is worth reproducing, so every object that
 * consumed it takes the random sample as an argument instead:
 *
 *     bk_lfo_next_with(l, rnd)   <- deterministic, parity-testable
 *     bk_lfo_next(l)            <- wraps the above with bk_rng
 *
 * The parity battery drives the *_with forms. The convenience wrappers exist so
 * the native host isn't forced to carry its own RNG, and are explicitly outside
 * the parity contract: a sample-and-hold LFO and a noise generator are not
 * expected to match across builds, and the app does not depend on them doing so.
 */

#ifndef BROKODR_DSP_UTILS_H
#define BROKODR_DSP_UTILS_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* utils.js exports TWO_PI = Math.PI * 2. Spelled out as a literal so every
   toolchain uses identical bits (MSVC does not define M_PI by default). */
#define BK_PI 3.14159265358979323846
#define BK_TWO_PI 6.28318530717958647692

/* --- scalar helpers ----------------------------------------------------- */

double bk_clamp(double x, double lo, double hi);
/* Math.max / Math.min semantics, NaN propagation included. Not decoration: the
   obvious `a > b ? a : b` swallows NaN and silently returns the other operand,
   which is how a port ends up reporting -180 dB for an unset gain instead of
   NaN. Every Math.max/Math.min in the JS goes through these. */
double bk_max(double a, double b);
double bk_min(double a, double b);
double bk_db_to_gain(double db);
double bk_gain_to_db(double g);
double bk_lerp(double a, double b, double t);
/* Denormal / NaN guard. Cheap enough to run per-sample on feedback paths. */
double bk_sanitize(double x);
double bk_semitones_to_ratio(double st);
double bk_poly_blep(double t, double dt);

/* --- Smoother ----------------------------------------------------------- */

/* One-pole parameter smoother, time constant in ms. Every user-facing parameter
   goes through one of these so knob moves never click. */
typedef struct {
  double sr;
  double value;
  double target;
  double a;
} bk_smoother;

void bk_smoother_init(bk_smoother *s, double sample_rate, double ms, double initial);
void bk_smoother_set_time(bk_smoother *s, double ms);
void bk_smoother_set(bk_smoother *s, double target);
/* Jump immediately — engine reset / preset load, never during playback. */
void bk_smoother_reset(bk_smoother *s, double v);
double bk_smoother_next(bk_smoother *s);
/* Mirrors the `settled` getter: exact equality, and that is intentional. */
int bk_smoother_settled(const bk_smoother *s);

/* --- EnvelopeFollower --------------------------------------------------- */

typedef struct {
  double sr;
  int rms;
  double env;
  double ca, cr;
} bk_env_follower;

void bk_env_follower_init(bk_env_follower *e, double sample_rate, double attack_ms,
                          double release_ms, int rms);
void bk_env_follower_set_attack(bk_env_follower *e, double ms);
void bk_env_follower_set_release(bk_env_follower *e, double ms);
double bk_env_follower_process(bk_env_follower *e, double x);
void bk_env_follower_reset(bk_env_follower *e);

/* --- LFO ---------------------------------------------------------------- */

enum bk_lfo_shape {
  BK_LFO_SINE = 0,
  BK_LFO_TRI = 1,
  BK_LFO_SAW = 2,
  BK_LFO_SQUARE = 3,
  BK_LFO_SAMPLE_HOLD = 4
};

typedef struct {
  double sr;
  double phase;
  double inc;
  int shape;
  double rand;
  double last_quad;
  /* xorshift state for the convenience wrapper only; see the header comment. */
  unsigned int rng;
} bk_lfo;

void bk_lfo_init(bk_lfo *l, double sample_rate);
void bk_lfo_set_rate(bk_lfo *l, double hz);
void bk_lfo_set_phase(bk_lfo *l, double p);
/* `rnd` is consumed only on wrap, and only by BK_LFO_SAMPLE_HOLD. It stands in
   for `Math.random() * 2 - 1`, so pass a value in [-1, 1). */
double bk_lfo_next_with(bk_lfo *l, double rnd);
double bk_lfo_next(bk_lfo *l);

/* --- DCBlocker ---------------------------------------------------------- */

/* 1st-order highpass at ~20 Hz. Essential after any asymmetric waveshaper:
   without it DC offset stacks through the chain and eats headroom. */
typedef struct {
  double r;
  double x1, y1;
} bk_dc_blocker;

void bk_dc_blocker_init(bk_dc_blocker *d, double sample_rate, double hz);
double bk_dc_blocker_process(bk_dc_blocker *d, double x);
void bk_dc_blocker_reset(bk_dc_blocker *d);

/* --- PitchTracker ------------------------------------------------------- */

/* Autocorrelation pitch tracker on a decimated signal. Coarse hop, never
   per-sample. `buf` is float, matching the JS Float32Array — see header note. */
#define BK_PITCH_MAX_BUF 2048

typedef struct {
  double sr;
  int decim;
  double dsr;
  int min_lag, max_lag;
  int size;
  float buf[BK_PITCH_MAX_BUF];
  int w;
  int decim_count;
  double acc;
  double freq;
  double confidence;
} bk_pitch_tracker;

void bk_pitch_tracker_init(bk_pitch_tracker *p, double sample_rate, double min_hz, double max_hz);
/* Feed every sample; decimates internally. */
void bk_pitch_tracker_push(bk_pitch_tracker *p, double x);
/* Call once per block. Returns detected Hz (0 = unvoiced). */
double bk_pitch_tracker_analyze(bk_pitch_tracker *p);

/* --- Oscillator --------------------------------------------------------- */

typedef struct {
  double sr;
  double phase;
  double inc;
  double pw;
} bk_oscillator;

void bk_oscillator_init(bk_oscillator *o, double sample_rate);
void bk_oscillator_set_freq(bk_oscillator *o, double hz);
/* PolyBLEP-corrected — no aliasing spray in the vocoder carrier. */
double bk_oscillator_saw(bk_oscillator *o);
double bk_oscillator_pulse(bk_oscillator *o);

/* --- PinkNoise ---------------------------------------------------------- */

/* Paul Kellet's economical filter. `b` is float, matching the JS
   Float32Array — see the header note; holding it in double diverges audibly. */
typedef struct {
  float b[7];
  unsigned int rng;
} bk_pink_noise;

void bk_pink_noise_init(bk_pink_noise *p);
/* `w` stands in for `Math.random() * 2 - 1`. Deterministic, parity-tested. */
double bk_pink_noise_process(bk_pink_noise *p, double w);
double bk_pink_noise_next(bk_pink_noise *p);

/* --- RNG (outside the parity contract) ---------------------------------- */

/* Seeded xorshift32, returning [-1, 1). Exists so the native host has a source
   for the *_next wrappers; nothing musical depends on it matching the web. */
void bk_rng_seed(unsigned int *state, unsigned int seed);
double bk_rng_bipolar(unsigned int *state);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_UTILS_H */
