/*
 * Bro.Kodr DSP — voice character and destruction. C port of
 * dsp/effects/character.js.
 *
 * Three effects, three structs:
 *
 *   bk_character  Character ("character"): one of eight media colourations
 *                 (telephone, AM radio, megaphone, walkie, cassette, vinyl,
 *                 intercom, lo-fi tape). Wow/flutter delay -> 2-stage HP ->
 *                 resonant peak -> nonlinearity -> 2-stage LP, plus a noise
 *                 floor, impulsive crackle and a carrier squelch.
 *   bk_glitch     Glitch / stutter ("glitch"): a 2 s ring buffer, a slice clock
 *                 at bpm / division, and slice replay with repeats, reverse,
 *                 pitch and a boundary crossfade.
 *   bk_noise_gen  Noise bed ("noise"): white, pink or brown noise through a
 *                 lowpass, optionally following the input level.
 *
 * Porting rules as in biquad.h. Float where the JS holds a Float32Array: the
 * wow/flutter delay lines, the glitch ring buffers and the pink-noise state
 * (bk_pink_noise). Everything else is double.
 *
 * Faithfulness notes — JS behaviour reproduced on purpose:
 *
 *   - Randomness. Every Math.random() is a call through a bk_random_fn
 *     ([0, 1)); NULL selects an internal xorshift outside the parity contract,
 *     and the battery installs a generator it mirrors in JS. Draw order is the
 *     JS's: Character per frame draws the noise sample (only while its noise
 *     level is > 0), then the crackle trigger (only while the crackle
 *     probability is > 0), then the crackle value (only when triggered). Glitch
 *     draws once per slice boundary while inactive and not frozen. The noise
 *     bed draws once per frame, every frame, whatever the level.
 *   - NaN parameters flow through as they do in the JS rather than being
 *     filtered. A NaN amount makes the wow test `depth > 0.001` and its
 *     complement `depth <= 0.001` both false, so the LFOs stop; a NaN bpm or
 *     division makes the slice length NaN, so the clock never fires and an
 *     active slice plays on, sanitised to silence; a NaN noise type rounds to
 *     NaN, which is neither 0 nor 1, so it is brown.
 *   - Character's `mode`, Glitch's `division` / `repeats` and the noise bed's
 *     `type` are clamp(Math.round(v)) with the JS Math.round (exact fraction,
 *     -0 for [-0.5, 0)). The noise type is held as a double so -0 is white.
 *   - Glitch indexes its Float32Arrays with `%`, which in JS keeps the sign of
 *     the dividend. The C uses fmod, and a read at an index outside
 *     [0, buffer size) gives NaN, exactly as a JS typed-array read past either
 *     end gives undefined (NaN in arithmetic). Such reads happen: the slice
 *     length is recomputed every block and can reach 3 s (bpm 20, division 1),
 *     longer than the 2 s buffer, so slice_start can be negative, and a
 *     reversed slice whose length shrinks mid-slice reads before it. -0 reads
 *     element 0, as a JS -0 key does.
 *   - Character's squelch and the noise bed's follower read the INPUT frame
 *     (both channels) before either is written; the outputs are written l then
 *     r. The noise bed reads r[i] after writing l[i], as the JS does, so with
 *     l and r aliased (a mono caller) the right channel adds noise twice —
 *     faithfully.
 *   - reset() is the JS's: Character resets its filters, delay lines and gate
 *     envelope only (not the smoothers, LFOs, noise, or crackle); Glitch
 *     clears the buffers, the write head, the active flag and the counter
 *     only; the noise bed has no reset() in the JS (Effect's is a no-op), so
 *     bk_noise_gen_reset does nothing at all.
 *   - meter: Glitch's is 1 while a slice is playing at the end of a block, else
 *     0. Character and the noise bed never set theirs (it stays 0), so their
 *     vtables have no meter.
 *   - None of the three sizes anything by max_block, so frames > max_block
 *     needs no chunking, and negative frames process nothing (the per-block
 *     filter and slice-length updates still run).
 *
 * Deliberate divergences — where the JS cannot be followed:
 *
 *   - A NaN `mode` makes the JS read MODES[NaN] (undefined), and process()
 *     then throws a TypeError on every block. Here a NaN mode is ignored and
 *     the previous mode stays. The parity battery checks the JS really does
 *     throw, and replays such scripts against that contract.
 *
 * Preconditions: sample_rate > 0, and the storage given at init is at least
 * bk_character_storage_floats / bk_glitch_storage_floats(sample_rate) floats
 * and outlives the effect. The JS has no meaningful behaviour for a rate of 0
 * or below (a zero-length buffer, `% 0` = NaN write heads).
 */

#ifndef BROKODR_DSP_CHARACTER_H
#define BROKODR_DSP_CHARACTER_H

#include <stddef.h>

#include "brokodr/dsp/biquad.h"
#include "brokodr/dsp/chain.h"
#include "brokodr/dsp/delay-line.h"
#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BK_CHARACTER_MODES 8

/* One row of the JS MODES table. */
typedef struct {
  double hp, lp;
  double res_freq, res_db, res_q;
  double drive;
  int curve; /* 0 tanh, 1 hard clip, 2 rectify */
  double noise;
  double crackle;
  double wobble;
  int squelch;
} bk_character_mode;

/* The table itself, in JS order (index == mode). */
extern const bk_character_mode bk_character_modes[BK_CHARACTER_MODES];

typedef struct {
  double sr;
  int mode;
  double amount;
  double drive_trim;
  double noise_trim;
  double wobble_trim;

  bk_biquad_cascade hp[2];
  bk_biquad_cascade lp[2];
  bk_biquad res[2];
  bk_pink_noise noise;
  bk_lfo wobble_lfo;
  bk_lfo flutter_lfo;
  bk_delay_line wobble_line[2];
  bk_env_follower gate_env;
  bk_smoother squelch_sm;
  bk_smoother out_sm;
  double crackle_state;

  bk_random_fn random;
  void *random_user;
  unsigned int rng; /* for random == NULL only */
} bk_character;

/* Floats of storage a bk_character needs: two wow/flutter delay lines of
   ceil(sample_rate * 0.02) samples each, sized as the JS DelayLine sizes. */
size_t bk_character_storage_floats(double sample_rate);
void bk_character_init(bk_character *c, double sample_rate, float *storage);
/* fn == NULL restores the internal generator. */
void bk_character_set_random(bk_character *c, bk_random_fn fn, void *user);
/* key is BK_P_CHARACTER_*; unknown keys are ignored. */
void bk_character_set_param(bk_character *c, int key, double value);
void bk_character_reset(bk_character *c);
void bk_character_process(bk_character *c, float *l, float *r, int frames);

/* process, reset, set_param; no meter. */
extern const bk_effect_vt bk_character_vt;

typedef struct {
  double sr;
  int buf_size;
  float *buf_l, *buf_r; /* caller-owned, buf_size each */
  int w;
  double bpm;
  double division;
  double probability;
  double reverse;
  double pitch_ratio;
  double repeats;
  double xfade;

  double slice_len;
  int active;
  double slice_start;
  double repeat_count;
  double read_pos;
  double counter;
  int freeze;
  double meter;

  bk_random_fn random;
  void *random_user;
  unsigned int rng; /* for random == NULL only */
} bk_glitch;

/* Floats of storage a bk_glitch needs: two ceil(2 * sample_rate) buffers. */
size_t bk_glitch_storage_floats(double sample_rate);
void bk_glitch_init(bk_glitch *g, double sample_rate, float *storage);
void bk_glitch_set_random(bk_glitch *g, bk_random_fn fn, void *user);
void bk_glitch_set_param(bk_glitch *g, int key, double value);
void bk_glitch_reset(bk_glitch *g);
void bk_glitch_process(bk_glitch *g, float *l, float *r, int frames);
double bk_glitch_meter(const bk_glitch *g);

/* process, reset, set_param, meter. */
extern const bk_effect_vt bk_glitch_vt;

typedef struct {
  double sr;
  double type; /* double, so a -0 type is white as in the JS */
  bk_smoother level_sm;
  bk_pink_noise pink;
  double brown;
  double follow;
  bk_env_follower env;
  bk_biquad lp[2];
  double lp_freq;

  bk_random_fn random;
  void *random_user;
  unsigned int rng; /* for random == NULL only */
} bk_noise_gen;

void bk_noise_gen_init(bk_noise_gen *n, double sample_rate);
void bk_noise_gen_set_random(bk_noise_gen *n, bk_random_fn fn, void *user);
void bk_noise_gen_set_param(bk_noise_gen *n, int key, double value);
/* A no-op, as the JS's is; see above. */
void bk_noise_gen_reset(bk_noise_gen *n);
void bk_noise_gen_process(bk_noise_gen *n, float *l, float *r, int frames);

/* process, reset, set_param; no meter. */
extern const bk_effect_vt bk_noise_gen_vt;

#ifdef __cplusplus
}
#endif

#endif
