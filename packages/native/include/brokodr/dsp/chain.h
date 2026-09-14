/*
 * Bro.Kodr DSP core — effect chain. C port of chain.js.
 *
 * An ordered list of effect slots with per-slot dry/wet and bypass, plus the
 * render loop that walks them. The same object serves the 22-module master
 * rack, a single drum pad, and a single loop track, which is why it is a type
 * and not three copies of some slot handling.
 *
 * This module is different in kind from the three before it. utils, biquad and
 * delay-line are arithmetic: same numbers in, same numbers out. chain.js is a
 * *host* — its job is ordering, dry/wet crossfade, bypass, latency accounting
 * and meter marshalling, and it does almost no arithmetic of its own. So the
 * port has to solve a problem the earlier ones did not: what an "effect" is,
 * given that none of the 22 effect modules are ported yet.
 *
 * Answer: an effect is a void* plus a vtable (bk_effect_vt). The chain never
 * knows what it is driving. That is not a C flourish — it mirrors what the JS
 * already does via duck typing (`typeof fx.setCarrierBus === "function"`), it
 * lets the chain be ported and verified now rather than after 3,285 lines of
 * effects, and it is how the real host will register the ported effects later.
 *
 * Porting rules as established in biquad.h: pure C99, no C++ runtime, double
 * state and coefficients, float only where the JS itself uses a Float32Array,
 * zero allocation on the audio path, caller-owned structs. The slot array is a
 * fixed inline array, so a bk_chain is one allocation the caller makes and the
 * audio path makes none.
 *
 * Faithfulness notes — quirks reproduced on purpose, each one load-bearing:
 *
 *  - A meter reading of NaN reads back as 0. The JS is `effect.meter || 0`,
 *    and NaN is falsy, so a broken effect's NaN meter is silently swallowed
 *    into a plausible 0 rather than shown. See bk_chain_read_slot_meters.
 *  - recalcLatency() runs on a *missed* setParam when the key is the quality
 *    key, because the JS checks the key outside the `if (s)` guard.
 *  - move() clamps its destination against the length *after* the removal, so
 *    the last reachable index is n-1, and it does not recalculate latency
 *    (correct: latency is order-independent).
 *  - A settled, fully-wet slot copies wet over dry and never advances its
 *    smoother, because the JS's fast path does not call mix.next().
 */

#ifndef BROKODR_DSP_CHAIN_H
#define BROKODR_DSP_CHAIN_H

#include "brokodr/dsp/utils.h"

/* MAX_SLOTS in chain.js. Hard ceiling on one chain; the master rack and the
   pads share it. A bk_chain may be configured lower but never higher, so the
   inline slot array below is always big enough. */
#define BK_CHAIN_MAX_SLOTS 24

/* Sentinels for the optional fields of bk_slot_spec, standing in for the JS's
   `spec.index === undefined` / `spec.mix !== undefined` tests. */
#define BK_CHAIN_APPEND (-2147483647 - 1) /* INT_MIN, without pulling in limits.h */
#define BK_CHAIN_KEEP (-1)                /* "not specified" for bypassed */

/*
 * The param key the chain itself reacts to.
 *
 * chain.js compares against the string "quality" because oversampling quality
 * changes the latency a module reports. The hot path here is numeric — which is
 * what Slot.paramNames in the JS exists to enable — so the host maps names to
 * indices once, off the audio thread, and this is the reserved index for that
 * one key. Any other key is passed straight through to the effect.
 */
#define BK_PARAM_QUALITY 0

/*
 * What the chain needs of an effect, and nothing more.
 *
 * Optional entries may be NULL and are then simply not called, which is the
 * direct equivalent of the JS's `typeof fx.setCarrierBus === "function"`:
 *
 *   process          required. Renders 100% wet, in place, over `frames`.
 *   reset            required. Drops state; called on bypass and on panic.
 *   set_param        optional. Numeric key, as above.
 *   set_carrier_bus  optional. Effects driven by an external signal (talk box,
 *                    vocoder) get the chain's carrier bus once, at add time,
 *                    so the render loop does no lookup.
 *   latency_samples  optional; treated as 0 when absent.
 *   meter            optional; treated as 0 when absent.
 *
 * Effects always render fully wet. Dry/wet lives in the chain so the modules
 * stay simple — no effect has an internal mix parameter and none should grow
 * one.
 */
typedef struct {
  void (*process)(void *self, float *l, float *r, int frames);
  void (*reset)(void *self);
  void (*set_param)(void *self, int key, double value);
  void (*set_carrier_bus)(void *self, const float *l, const float *r);
  int (*latency_samples)(const void *self);
  double (*meter)(const void *self);
} bk_effect_vt;

/* One position in the chain: the effect, plus the wrapping the chain applies. */
typedef struct {
  int id;
  int type;
  void *effect;
  const bk_effect_vt *vt;
  int bypassed;
  bk_smoother mix; /* 25 ms, initial 1, exactly as the JS constructs it */
  double mix_target;
} bk_slot;

typedef struct {
  double sr;
  int max_block;
  int max_slots;

  bk_slot slots[BK_CHAIN_MAX_SLOTS];
  int n_slots;

  /* Per-slot scratch, caller-owned, max_block long. process() never grows it. */
  float *wet_l;
  float *wet_r;

  /* Optional carrier bus, handed to effects that opt in at add time. */
  const float *carrier_l;
  const float *carrier_r;

  int latency_samples;
} bk_chain;

/*
 * The wire command for an insert, mirroring chain.js's `spec`.
 *
 * index    BK_CHAIN_APPEND to append, else clamped to [0, n_slots].
 * mix      NAN to leave the default (1, fully wet), else the initial mix; the
 *          smoother is reset to it rather than gliding, as in the JS.
 * bypassed BK_CHAIN_KEEP to leave the default (not bypassed), else 0/non-zero.
 * effect   caller-constructed and caller-owned; the chain never frees it.
 */
typedef struct {
  int id;
  int type;
  int index;
  double mix;
  int bypassed;
  void *effect;
  const bk_effect_vt *vt;
} bk_slot_spec;

/*
 * Initialise. `wet_l`/`wet_r` must each be at least max_block floats and must
 * outlive the chain. max_slots <= 0 means BK_CHAIN_MAX_SLOTS, matching the JS's
 * `o.maxSlots || MAX_SLOTS` (note 0 therefore means the default, not "none").
 * Returns 0, or -1 when the arguments cannot be honoured.
 */
int bk_chain_init(bk_chain *c, double sample_rate, int max_block, int max_slots, float *wet_l,
                  float *wet_r);

/* Carrier bus. Set before adding the effects that need it, as in the JS, where
   the bus is read at add time and never again. */
void bk_chain_set_carrier_bus(bk_chain *c, const float *l, const float *r);

/* --- control: off the audio thread ------------------------------------- */

/* Insert. Returns the new slot, or NULL when the chain is full or the spec
   carries no effect — the two cases where the JS returns null. */
bk_slot *bk_chain_add(bk_chain *c, const bk_slot_spec *spec);

void bk_chain_remove(bk_chain *c, int id);
void bk_chain_move(bk_chain *c, int id, int index);
void bk_chain_set_param(bk_chain *c, int id, int key, double value);
void bk_chain_set_mix(bk_chain *c, int id, double value);
void bk_chain_set_bypass(bk_chain *c, int id, int value);
void bk_chain_reset_slot(bk_chain *c, int id);
void bk_chain_clear(bk_chain *c);

/* Reset every effect without changing the chain. Hits bypassed slots too. */
void bk_chain_panic(bk_chain *c);

bk_slot *bk_chain_find(bk_chain *c, int id);
int bk_chain_index_of(const bk_chain *c, int id);
int bk_chain_length(const bk_chain *c);

/* Sum of the latency the un-bypassed modules report. Also stored on the chain. */
int bk_chain_recalc_latency(bk_chain *c);

/* Write each slot's meter into `out` at `offset`; returns the count written. */
int bk_chain_read_slot_meters(const bk_chain *c, double *out, int offset);

/* --- audio -------------------------------------------------------------- */

/*
 * Render in place over L/R. Never allocates, never fails.
 *
 * Each slot sees the running signal as its dry reference, renders fully wet
 * into scratch, and is crossfaded back in. The settled fully-wet case skips the
 * crossfade entirely, which is the common path and saves a pass over the block.
 */
void bk_chain_process(bk_chain *c, float *l, float *r, int frames);

#endif /* BROKODR_DSP_CHAIN_H */
