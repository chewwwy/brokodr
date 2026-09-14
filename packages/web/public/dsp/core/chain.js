/**
 * Bro.Kodr — reusable effect chain (backend-agnostic).
 *
 * An ordered list of effect slots with per-slot dry/wet and bypass, and the render
 * loop that walks them. This was lifted verbatim out of `engine.js`, where it was the
 * master chain and nothing else could use it.
 *
 * It exists as its own class because the same logic is needed in three places now:
 *
 *   1. The master chain — the 22-module rack the user builds. `Engine` owns one.
 *   2. Per drum pad — putting the bitcrusher on the snare only.
 *   3. Per loop track — sculpting a recorded loop without touching the live voice.
 *
 * Duplicating slot handling three times would guarantee the three copies drift, and
 * dry/wet is exactly the kind of subtle thing that drifts silently. So: one class.
 *
 * Design constraints carried over unchanged from the engine:
 *  - Zero allocation in process(). Scratch is allocated in the constructor; structural
 *    changes (add/remove) allocate, but those arrive as control commands off the audio
 *    thread's queue, never inside the render.
 *  - No exceptions on the audio path. A broken effect is skipped, not fatal.
 *  - Reordering swaps references, so audio never stops and no filter state is destroyed.
 *  - Effects always render 100% wet. Dry/wet lives HERE so modules stay simple — no
 *    effect has an internal `mix` param and none should ever grow one.
 *
 * Note on style: this file deliberately avoids `#private` fields and `extends`. Both
 * break the React Native worklet compiler used by the Android build, and the mobile
 * DSP copies had to be hand-patched to remove them. New core files don't repeat that.
 */

import { createEffect } from "../effects/registry.js";
import { clamp, Smoother } from "./utils.js";

/** Hard ceiling on slots in one chain. Master rack and pads share the limit. */
export const MAX_SLOTS = 24;

/**
 * One position in the chain: an effect instance plus the generic wrapping the chain
 * applies to it (dry/wet, bypass) and the numeric param addressing table.
 */
export class Slot {
  constructor(id, type, effect, sampleRate) {
    this.id = id;
    this.type = type;
    this.effect = effect;
    /**
     * Numeric param addressing table. The UI sends param changes as an index into this
     * array so the hot path stays a plain Float64 ring buffer with no strings on it.
     */
    this.paramNames = null;
    this.bypassed = false;
    this.mix = new Smoother(sampleRate, 25, 1);
    this.mixTarget = 1;
  }
}

export class Chain {
  /**
   * @param {number} sampleRate
   * @param {number} maxBlock  largest block this chain will ever be asked to render
   * @param {object} [opts]
   * @param {number} [opts.maxSlots]  slot ceiling, defaults to MAX_SLOTS
   * @param {Float32Array} [opts.carrierL] carrier bus handed to effects that opt in
   * @param {Float32Array} [opts.carrierR]
   */
  constructor(sampleRate, maxBlock, opts) {
    const o = opts || {};
    this.sr = sampleRate;
    this.maxBlock = maxBlock;
    this.maxSlots = o.maxSlots || MAX_SLOTS;

    /** @type {Slot[]} ordered processing chain */
    this.slots = [];

    // Per-slot scratch. Allocated once; process() never grows it.
    this.wetL = new Float32Array(maxBlock);
    this.wetR = new Float32Array(maxBlock);

    // Optional carrier bus. Effects that can be driven by an external signal (talk box,
    // vocoder) are handed these references once at add time, so process() does no lookup.
    this.carrierL = o.carrierL || null;
    this.carrierR = o.carrierR || null;

    this.latencySamples = 0;
  }

  get length() {
    return this.slots.length;
  }

  // ---------------------------------------------------------------- control

  /**
   * Insert an effect. `spec` mirrors the wire command: { id, type, index, params,
   * paramNames, mix, bypassed }. Returns the Slot, or null if it could not be created.
   */
  add(spec) {
    if (this.slots.length >= this.maxSlots) return null;
    const fx = createEffect(spec.type, this.sr, this.maxBlock);
    if (!fx) return null;

    const slot = new Slot(spec.id, spec.type, fx, this.sr);
    slot.paramNames = spec.paramNames || null;

    if (spec.params) {
      for (const k in spec.params) fx.setParam(k, spec.params[k]);
    }
    if (spec.mix !== undefined) {
      slot.mixTarget = spec.mix;
      slot.mix.reset(spec.mix);
    }
    if (spec.bypassed !== undefined) slot.bypassed = !!spec.bypassed;

    if (this.carrierL && typeof fx.setCarrierBus === "function") {
      fx.setCarrierBus(this.carrierL, this.carrierR);
    }

    const at = spec.index === undefined ? this.slots.length : clamp(spec.index, 0, this.slots.length);
    this.slots.splice(at, 0, slot);
    this.recalcLatency();
    return slot;
  }

  remove(id) {
    const i = this._indexOf(id);
    if (i >= 0) this.slots.splice(i, 1);
    this.recalcLatency();
  }

  move(id, index) {
    const i = this._indexOf(id);
    if (i < 0) return;
    const removed = this.slots.splice(i, 1);
    this.slots.splice(clamp(index, 0, this.slots.length), 0, removed[0]);
  }

  setParam(id, key, value) {
    const s = this.find(id);
    if (s) s.effect.setParam(key, value);
    // Oversampling quality changes the latency a module reports.
    if (key === "quality") this.recalcLatency();
  }

  setMix(id, value) {
    const s = this.find(id);
    if (!s) return;
    s.mixTarget = clamp(value, 0, 1);
    s.mix.set(s.mixTarget);
  }

  setBypass(id, value) {
    const s = this.find(id);
    if (!s) return;
    s.bypassed = !!value;
    // Clear state on the way out so re-engaging does not dump a stale tail.
    if (s.bypassed) s.effect.reset();
    this.recalcLatency();
  }

  resetSlot(id) {
    const s = this.find(id);
    if (s) s.effect.reset();
  }

  clear() {
    this.slots.length = 0;
    this.recalcLatency();
  }

  /** Reset every effect without changing the chain. */
  panic() {
    for (let i = 0; i < this.slots.length; i++) this.slots[i].effect.reset();
  }

  find(id) {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].id === id) return this.slots[i];
    }
    return null;
  }

  _indexOf(id) {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].id === id) return i;
    }
    return -1;
  }

  /** Sum of latency-introducing modules (currently only the STFT pitch shifter). */
  recalcLatency() {
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.bypassed && s.effect.latencySamples) n += s.effect.latencySamples;
    }
    this.latencySamples = n;
    return n;
  }

  /**
   * Write each slot's meter reading into `out` starting at `offset`.
   * Returns the number of values written.
   */
  readSlotMeters(out, offset) {
    const n = Math.min(this.slots.length, this.maxSlots);
    for (let i = 0; i < n; i++) out[offset + i] = this.slots[i].effect.meter || 0;
    return n;
  }

  // ---------------------------------------------------------------- audio

  /**
   * Render the chain in place over L/R. Never throws, never allocates.
   *
   * Each slot sees the running signal as its dry reference, renders 100% wet into
   * scratch, and is crossfaded back in. The fully-wet settled case skips the mix loop
   * entirely, which is the common path and saves a pass over the block.
   */
  process(L, R, frames) {
    const wetL = this.wetL;
    const wetR = this.wetR;
    const slots = this.slots;

    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s];
      if (slot.bypassed) continue;

      for (let i = 0; i < frames; i++) {
        wetL[i] = L[i];
        wetR[i] = R[i];
      }

      slot.effect.process(wetL, wetR, frames);

      if (slot.mix.settled && slot.mix.value >= 0.9999) {
        for (let i = 0; i < frames; i++) {
          L[i] = wetL[i];
          R[i] = wetR[i];
        }
      } else {
        for (let i = 0; i < frames; i++) {
          const m = slot.mix.next();
          L[i] = L[i] * (1 - m) + wetL[i] * m;
          R[i] = R[i] * (1 - m) + wetR[i] * m;
        }
      }
    }
  }
}
