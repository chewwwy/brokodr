/*
 * Bro.Kodr DSP core — effect registry. C port of dsp/effects/registry.js.
 *
 * The single place where an effect type maps to a constructor. registry.js is
 * a table of 22 classes and a createEffect(type, sr, maxBlock) that looks the
 * type up and calls `new`; this is the same table, split into the steps that
 * `new` hides, because under the porting rules (biquad.h) the registry may not
 * allocate:
 *
 *     size_t n  = bk_effect_size(type);                 // the struct
 *     size_t nf = bk_effect_storage_floats(type, sr, mb); // its delay lines etc.
 *     void *fx  = <caller allocates n bytes, max-aligned (malloc is)>;
 *     float *st = <caller allocates nf floats, or NULL when nf == 0>;
 *     const bk_effect_vt *vt = bk_effect_create(type, fx, st, sr, mb);
 *
 * and then hands (fx, vt) to bk_chain_add in a bk_slot_spec. The caller owns
 * both blocks and frees them after the slot is gone; the chain never frees.
 * All of this is control-thread work, exactly as `new` is in the JS.
 *
 * Types are numbers here and strings in the JS. The number is the position in
 * EFFECT_CLASSES (registry.js), which is also the order the enum below lists;
 * the STRING is still the stable id that presets store, so the table keeps the
 * names and bk_effect_type_from_name() is how a host turns a preset's type into
 * the number. APPEND ONLY, like the JS ids: the number is what a bk_slot carries
 * and what the engine compares quality keys against.
 *
 * Three things differ from the JS, deliberately:
 *
 *   1. AN UNKNOWN TYPE IS A NULL VTABLE, NOT A THROWN TypeError. createEffect
 *      looks the id up with `EFFECT_CLASSES[type]`, a plain object property
 *      read, so an inherited name ("toString", "constructor") finds
 *      Object.prototype's members and `new` either throws or builds a junk
 *      object. Only the 22 own names resolve here; everything else is -1 /
 *      NULL, which is the JS's `if (!C) return null` path, the one the chain
 *      handles. Name lookup is exact and case-sensitive, as a property read is.
 *
 *   2. RANDOMNESS IS INSTALLED, NOT GLOBAL. Eight of the effects draw from
 *      Math.random() in the JS (crush dither, the vocoder's noise carrier and
 *      sibilance, character crackle, glitch, noise, and the S&H LFO shape of
 *      flanger / phaser / tremolo). Their C ports take a bk_random_fn instead.
 *      bk_effect_set_random installs one on whichever type takes it; the JS's
 *      single global generator is the case where every effect is handed the
 *      same function and the same `user` state, which is what the engine
 *      battery does. TalkBox and PitchFormant use their own xorshift in the JS
 *      too, so they take nothing.
 *
 *   3. THE QUALITY KEY IS ANSWERED HERE. chain.js recalculates latency when a
 *      param named "quality" is set. The C chain does not interpret keys
 *      (chain.h explains why); this table knows each type's quality key from
 *      the generated param-keys.h, so the engine can make the same decision
 *      with numbers.
 */

#ifndef BROKODR_DSP_EFFECT_REGISTRY_H
#define BROKODR_DSP_EFFECT_REGISTRY_H

#include <stddef.h>

#include "brokodr/dsp/chain.h"
#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* EFFECT_CLASSES order. APPEND ONLY. */
enum bk_effect_type {
  BK_FX_EQ = 0,
  BK_FX_COMP = 1,
  BK_FX_LIMITER = 2,
  BK_FX_GATE = 3,
  BK_FX_TRANSIENT = 4,
  BK_FX_DIST = 5,
  BK_FX_SAT = 6,
  BK_FX_CRUSH = 7,
  BK_FX_PITCH = 8,
  BK_FX_VOCODER = 9,
  BK_FX_TALKBOX = 10,
  BK_FX_CHORUS = 11,
  BK_FX_FLANGER = 12,
  BK_FX_PHASER = 13,
  BK_FX_TREMOLO = 14,
  BK_FX_RINGMOD = 15,
  BK_FX_FREQSHIFT = 16,
  BK_FX_DELAY = 17,
  BK_FX_REVERB = 18,
  BK_FX_CHARACTER = 19,
  BK_FX_GLITCH = 20,
  BK_FX_NOISE = 21,
  BK_FX_COUNT = 22
};

/* The registry id ("eq", "comp", ...) for a type, or NULL for a bad one. */
const char *bk_effect_type_name(int type);
/* The type for a registry id, or -1. Exact match on the 22 own ids only. */
int bk_effect_type_from_name(const char *name);

/* Bytes of struct a type needs, or 0 for a bad type. */
size_t bk_effect_size(int type);
/* Floats of caller storage a type needs at this rate and block (0 for the
   types that keep everything inline, and for a bad type). */
size_t bk_effect_storage_floats(int type, double sample_rate, int max_block);

/*
 * Construct `type` in `mem` — the JS's `new C(sampleRate, maxBlock)`. `mem`
 * must hold bk_effect_size(type) bytes, suitably aligned; `storage` must hold
 * bk_effect_storage_floats(...) floats and may be NULL when that is 0. Returns
 * the vtable the chain drives it through, or NULL for a bad type (nothing is
 * written then). Effects that draw randomness start on their own internal
 * generator, as their own init leaves them.
 */
const bk_effect_vt *bk_effect_create(int type, void *mem, float *storage, double sample_rate,
                                     int max_block);

/* Install `fn` / `user` as the effect's Math.random. Returns 1 when the type
   takes one, 0 when it draws nothing (and is left alone). fn == NULL restores
   the effect's internal generator, as each module's own set_random does. */
int bk_effect_set_random(int type, void *mem, bk_random_fn fn, void *user);

/* The param key that changes this type's reported latency, or BK_PARAM_NONE.
   Only `pitch` has one today (BK_P_PITCH_QUALITY_KEY). */
int bk_effect_quality_key(int type);

/* How many params the type has: the length of its param-keys.h list, which is
   paramNames(type) in param-schema.ts, so a wire key k is valid when
   0 <= k < this. 0 for a bad type. The worklet's `slot.paramNames[key]`
   lookup is this bound check. */
int bk_effect_param_count(int type);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_EFFECT_REGISTRY_H */
