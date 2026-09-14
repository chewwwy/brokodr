/*
 * Bro.Kodr DSP core — effect chain. C port of chain.js.
 *
 * Read chain.h first: it explains why an effect here is a void* plus a vtable,
 * and lists the JS quirks this file reproduces rather than fixes.
 */

#include "brokodr/dsp/chain.h"

#include <math.h>

int bk_chain_init(bk_chain *c, double sample_rate, int max_block, int max_slots, float *wet_l,
                  float *wet_r) {
  int i;

  if (!c || !wet_l || !wet_r || max_block <= 0) return -1;
  if (max_slots > BK_CHAIN_MAX_SLOTS) return -1;

  c->sr = sample_rate;
  c->max_block = max_block;
  /* JS: `o.maxSlots || MAX_SLOTS` — 0 falls through to the default, it does
     not mean a chain that can hold nothing. */
  c->max_slots = max_slots > 0 ? max_slots : BK_CHAIN_MAX_SLOTS;

  c->n_slots = 0;
  for (i = 0; i < BK_CHAIN_MAX_SLOTS; i++) {
    c->slots[i].id = 0;
    c->slots[i].type = 0;
    c->slots[i].effect = 0;
    c->slots[i].vt = 0;
    c->slots[i].bypassed = 0;
    c->slots[i].mix_target = 1.0;
    bk_smoother_init(&c->slots[i].mix, sample_rate, 25.0, 1.0);
  }

  c->wet_l = wet_l;
  c->wet_r = wet_r;
  c->carrier_l = 0;
  c->carrier_r = 0;
  c->latency_samples = 0;
  return 0;
}

void bk_chain_set_carrier_bus(bk_chain *c, const float *l, const float *r) {
  c->carrier_l = l;
  c->carrier_r = r;
}

/* --- control ------------------------------------------------------------ */

int bk_chain_index_of(const bk_chain *c, int id) {
  int i;
  for (i = 0; i < c->n_slots; i++) {
    if (c->slots[i].id == id) return i;
  }
  return -1;
}

bk_slot *bk_chain_find(bk_chain *c, int id) {
  const int i = bk_chain_index_of(c, id);
  return i >= 0 ? &c->slots[i] : 0;
}

int bk_chain_length(const bk_chain *c) {
  return c->n_slots;
}

bk_slot *bk_chain_add(bk_chain *c, const bk_slot_spec *spec) {
  bk_slot *slot;
  int at, i;

  if (c->n_slots >= c->max_slots) return 0;
  /* The JS's `if (!fx) return null` — an effect the registry could not build.
     Here the caller builds it, so a null effect or vtable is the same case. */
  if (!spec || !spec->effect || !spec->vt || !spec->vt->process || !spec->vt->reset) return 0;

  /* Insertion point. JS: `spec.index === undefined ? length : clamp(index, 0, length)`,
     clamped against the length *before* the insert, so appending at `length` is
     the far end. */
  if (spec->index == BK_CHAIN_APPEND) {
    at = c->n_slots;
  } else {
    at = (int)bk_clamp((double)spec->index, 0.0, (double)c->n_slots);
  }

  /* splice(at, 0, slot) — shift the tail up one. This is the structural change
     the JS comments call out as allocation: it arrives as a control command off
     the audio thread's queue, never from inside a render. */
  for (i = c->n_slots; i > at; i--) c->slots[i] = c->slots[i - 1];
  slot = &c->slots[at];

  slot->id = spec->id;
  slot->type = spec->type;
  slot->effect = spec->effect;
  slot->vt = spec->vt;
  slot->bypassed = 0;
  slot->mix_target = 1.0;
  bk_smoother_init(&slot->mix, c->sr, 25.0, 1.0);

  /* `if (spec.mix !== undefined)` — reset, not glide, so a freshly added slot
     starts at its mix instead of sweeping up to it from 1. */
  if (!isnan(spec->mix)) {
    slot->mix_target = spec->mix;
    bk_smoother_reset(&slot->mix, spec->mix);
  }
  if (spec->bypassed != BK_CHAIN_KEEP) slot->bypassed = spec->bypassed ? 1 : 0;

  /* `if (this.carrierL && typeof fx.setCarrierBus === "function")` — both
     halves matter: no bus, or an effect that does not take one, and nothing
     happens. Note the JS tests only carrierL, so a chain given a left bus and
     no right one still calls through with a null right. Faithful. */
  if (c->carrier_l && slot->vt->set_carrier_bus) {
    slot->vt->set_carrier_bus(slot->effect, c->carrier_l, c->carrier_r);
  }

  c->n_slots++;
  bk_chain_recalc_latency(c);
  return slot;
}

void bk_chain_remove(bk_chain *c, int id) {
  const int i = bk_chain_index_of(c, id);
  int k;
  if (i >= 0) {
    for (k = i; k < c->n_slots - 1; k++) c->slots[k] = c->slots[k + 1];
    c->n_slots--;
  }
  /* Unconditional, as in the JS: recalc runs even when nothing was removed. */
  bk_chain_recalc_latency(c);
}

void bk_chain_move(bk_chain *c, int id, int index) {
  const int i = bk_chain_index_of(c, id);
  bk_slot moved;
  int at, k;

  if (i < 0) return;

  /* The JS splices the slot out first and only then clamps the destination, so
     the clamp sees the *shortened* list and the last reachable index is n-1.
     Reordering swaps references: audio never stops and no filter state is
     destroyed, which is why the whole slot is carried across rather than
     rebuilt. And no latency recalc — latency is order-independent. */
  moved = c->slots[i];
  for (k = i; k < c->n_slots - 1; k++) c->slots[k] = c->slots[k + 1];
  c->n_slots--;

  at = (int)bk_clamp((double)index, 0.0, (double)c->n_slots);
  for (k = c->n_slots; k > at; k--) c->slots[k] = c->slots[k - 1];
  c->slots[at] = moved;
  c->n_slots++;
}

void bk_chain_set_param(bk_chain *c, int id, int key, double value) {
  bk_slot *s = bk_chain_find(c, id);
  if (s && s->vt->set_param) s->vt->set_param(s->effect, key, value);
  /* Outside the `if (s)`, exactly as the JS has it: a quality change addressed
     to a slot that is not there still recalculates the chain's latency. */
  if (key == BK_PARAM_QUALITY) bk_chain_recalc_latency(c);
}

void bk_chain_set_mix(bk_chain *c, int id, double value) {
  bk_slot *s = bk_chain_find(c, id);
  if (!s) return;
  s->mix_target = bk_clamp(value, 0.0, 1.0);
  bk_smoother_set(&s->mix, s->mix_target);
}

void bk_chain_set_bypass(bk_chain *c, int id, int value) {
  bk_slot *s = bk_chain_find(c, id);
  if (!s) return;
  s->bypassed = value ? 1 : 0;
  /* Clear state on the way out so re-engaging does not dump a stale tail. */
  if (s->bypassed) s->vt->reset(s->effect);
  bk_chain_recalc_latency(c);
}

void bk_chain_reset_slot(bk_chain *c, int id) {
  bk_slot *s = bk_chain_find(c, id);
  if (s) s->vt->reset(s->effect);
}

void bk_chain_clear(bk_chain *c) {
  /* `slots.length = 0`. The effects themselves are the caller's to free; the
     JS drops its references here and lets GC deal with it. */
  c->n_slots = 0;
  bk_chain_recalc_latency(c);
}

void bk_chain_panic(bk_chain *c) {
  int i;
  for (i = 0; i < c->n_slots; i++) c->slots[i].vt->reset(c->slots[i].effect);
}

int bk_chain_recalc_latency(bk_chain *c) {
  int n = 0;
  int i;
  for (i = 0; i < c->n_slots; i++) {
    const bk_slot *s = &c->slots[i];
    /* `if (!s.bypassed && s.effect.latencySamples)` — a falsy latency is
       skipped, which for a number means 0 and adding 0 anyway. */
    if (!s->bypassed && s->vt->latency_samples) n += s->vt->latency_samples(s->effect);
  }
  c->latency_samples = n;
  return n;
}

int bk_chain_read_slot_meters(const bk_chain *c, double *out, int offset) {
  const int n = c->n_slots < c->max_slots ? c->n_slots : c->max_slots;
  int i;
  for (i = 0; i < n; i++) {
    const bk_slot *s = &c->slots[i];
    const double m = s->vt->meter ? s->vt->meter(s->effect) : 0.0;
    /* `effect.meter || 0`. NaN is falsy in JS, so a broken effect reporting a
       NaN meter shows up as a perfectly plausible 0 rather than as a NaN
       somebody would notice. Reproduced, not fixed: the meter block is a
       parity surface, and a divergence here would show as a UI glitch that is
       nearly impossible to trace back. Worth fixing in both engines at once,
       later, as its own change. Note 0 is positive here even for a -0 reading,
       which is also what `-0 || 0` yields. */
    out[offset + i] = (m != 0.0 && !isnan(m)) ? m : 0.0;
  }
  return n;
}

/* --- audio -------------------------------------------------------------- */

void bk_chain_process(bk_chain *c, float *l, float *r, int frames) {
  float *wet_l = c->wet_l;
  float *wet_r = c->wet_r;
  int s, i;

  for (s = 0; s < c->n_slots; s++) {
    bk_slot *slot = &c->slots[s];
    if (slot->bypassed) continue;

    for (i = 0; i < frames; i++) {
      wet_l[i] = l[i];
      wet_r[i] = r[i];
    }

    slot->vt->process(slot->effect, wet_l, wet_r, frames);

    if (bk_smoother_settled(&slot->mix) && slot->mix.value >= 0.9999) {
      /* The fast path does not advance the smoother — there is no mix.next()
         in the JS branch either. A settled smoother would not move anyway, but
         the asymmetry is visible the instant the mix leaves 1, so it is
         reproduced rather than tidied. */
      for (i = 0; i < frames; i++) {
        l[i] = wet_l[i];
        r[i] = wet_r[i];
      }
    } else {
      for (i = 0; i < frames; i++) {
        const double m = bk_smoother_next(&slot->mix);
        /* Term order is the JS's: dry * (1 - m) + wet * m. Doubles in, float32
           out, because L/R and the scratch are Float32Array on both sides. */
        l[i] = (float)((double)l[i] * (1.0 - m) + (double)wet_l[i] * m);
        r[i] = (float)((double)r[i] * (1.0 - m) + (double)wet_r[i] * m);
      }
    }
  }
}
