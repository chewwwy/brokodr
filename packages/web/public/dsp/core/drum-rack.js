/**
 * Bro.Kodr — BROBEATS drum rack (backend-agnostic).
 *
 * Sixteen `DrumVoice` pads summed into one stereo bus, with choke groups and an
 * optional per-pad effect chain.
 *
 * The per-pad chain is the point of having extracted `Chain` out of the engine: putting
 * the bitcrusher on the snare only is the same code path as the master rack, so it
 * behaves identically and cannot drift.
 *
 * Per-pad chains are allocated LAZILY. Sixteen chains' worth of scratch buffers
 * allocated up front would be wasted on the common case where nobody has put an effect
 * on a pad, and allocation only happens on a control command, never in the render.
 *
 * Real-time discipline: zero allocation in process(), no exceptions, no console.
 *
 * No `#private`, no `extends` — both break the React Native worklet compiler used by
 * the Android build.
 */

import { clamp, dbToGain, sanitize } from "./utils.js";
import { DrumVoice } from "./drum-voice.js";
import { Chain } from "./chain.js";

export const PAD_COUNT = 16;

export class DrumRack {
  constructor(sampleRate, maxBlock) {
    this.sr = sampleRate;
    this.maxBlock = maxBlock;

    /** @type {DrumVoice[]} */
    this.pads = [];
    /** @type {Array<Chain|null>} lazily created per-pad effect chains */
    this.padChains = [];
    for (let i = 0; i < PAD_COUNT; i++) {
      this.pads.push(new DrumVoice(sampleRate, maxBlock));
      this.padChains.push(null);
    }

    // Scratch for rendering one pad in isolation, needed only when that pad has its own
    // chain. One buffer pair is enough because pads are rendered one at a time.
    this.padL = new Float32Array(maxBlock);
    this.padR = new Float32Array(maxBlock);

    // The rack's own bus. Pads sum here, THEN rack gain and metering are applied, THEN
    // the result is added to the caller's buffer. Applying gain straight to the output
    // would scale whatever the host had already put there and meter it as ours.
    this.busL = new Float32Array(maxBlock);
    this.busR = new Float32Array(maxBlock);

    this.gain = 1;
    this.muted = false;
    /** Pad index soloed, or -1. Soloing is a performance control, not a mix state. */
    this.solo = -1;

    this.meterL = 0;
    this.meterR = 0;
    /** Per-pad peak for the UI's pad lighting. */
    this.padMeters = new Float32Array(PAD_COUNT);

    /**
     * Per-pad "just fired" flash, in FRAMES remaining. It is a countdown rather than a
     * flag the UI clears, because the UI polls at ~30fps while this runs at ~375: a
     * one-block flag set by a 20ms hat would simply be missed between two frames.
     * Held long enough (~90ms) that any poll inside the window sees the hit.
     *
     * Counted in frames, not blocks: `maxBlock` is only the allocation ceiling and the
     * host usually hands us far smaller blocks (128 against a 512 ceiling), so a
     * block-denominated countdown expired ~4x too early and the grid never lit.
     */
    this.triggerFlags = new Int32Array(PAD_COUNT);
    this.flashFrames = Math.max(maxBlock, Math.round((90 * sampleRate) / 1000));
  }

  // ---------------------------------------------------------------- control

  pad(i) {
    const n = i | 0;
    return n >= 0 && n < PAD_COUNT ? this.pads[n] : null;
  }

  /**
   * Fire a pad. Handles choke groups: any other sounding pad in the same non-zero
   * group is cut, which is how a closed hat kills an open hat on real kits.
   */
  trigger(index, velocity) {
    const v = this.pad(index);
    if (!v) return;

    const grp = v.chokeGroup;
    if (grp > 0) {
      for (let i = 0; i < PAD_COUNT; i++) {
        if (i !== index && this.pads[i].chokeGroup === grp && this.pads[i].active) {
          this.pads[i].choke();
        }
      }
    }
    v.trigger(velocity);
    this.triggerFlags[index | 0] = this.flashFrames;
  }

  release(index) {
    const v = this.pad(index);
    if (v) v.release();
  }

  setPadParam(index, key, value) {
    const v = this.pad(index);
    if (v) v.setParam(key, value);
  }

  setPadBuffer(index, layer, data, frames, srcRate) {
    const v = this.pad(index);
    if (v) v.setBuffer(layer, data, frames, srcRate);
  }

  clearPad(index) {
    const v = this.pad(index);
    if (v) v.clearBuffers();
    const c = this.padChains[index | 0];
    if (c) c.clear();
  }

  /**
   * The pad's own effect chain, created on first use. Returns null for a bad index.
   */
  chainFor(index) {
    const n = index | 0;
    if (n < 0 || n >= PAD_COUNT) return null;
    if (!this.padChains[n]) this.padChains[n] = new Chain(this.sr, this.maxBlock);
    return this.padChains[n];
  }

  setParam(key, value) {
    switch (key) {
      case "gain":
        this.gain = dbToGain(clamp(value, -60, 12));
        break;
      case "mute":
        this.muted = value >= 0.5;
        break;
      case "solo":
        this.solo = value < 0 ? -1 : clamp(Math.round(value), -1, PAD_COUNT - 1);
        break;
    }
  }

  /** Silence everything immediately — panic, preset load, device change. */
  reset() {
    for (let i = 0; i < PAD_COUNT; i++) {
      this.pads[i].reset();
      if (this.padChains[i]) this.padChains[i].panic();
      this.padMeters[i] = 0;
      this.triggerFlags[i] = 0;
    }
    this.meterL = 0;
    this.meterR = 0;
  }

  /** True when any pad is still sounding — lets the host skip the whole rack. */
  get sounding() {
    for (let i = 0; i < PAD_COUNT; i++) if (this.pads[i].active) return true;
    return false;
  }

  // ---------------------------------------------------------------- audio

  /**
   * Render the rack ADDITIVELY into L/R.
   *
   * Pads without their own chain go straight into the output bus. Pads with a chain are
   * rendered into scratch, run through the chain, then summed — so a per-pad effect
   * never touches the other fifteen.
   */
  process(L, R, frames) {
    if (this.muted) {
      this.meterL = 0;
      this.meterR = 0;
      for (let i = 0; i < PAD_COUNT; i++) {
        this.padMeters[i] = 0;
        if (this.triggerFlags[i] > 0) this.triggerFlags[i] -= frames;
      }
      return;
    }

    for (let i = 0; i < PAD_COUNT; i++) if (this.triggerFlags[i] > 0) this.triggerFlags[i] -= frames;

    const solo = this.solo;
    const padL = this.padL;
    const padR = this.padR;
    const busL = this.busL;
    const busR = this.busR;
    let sounded = false;

    for (let i = 0; i < frames; i++) {
      busL[i] = 0;
      busR[i] = 0;
    }

    for (let p = 0; p < PAD_COUNT; p++) {
      const voice = this.pads[p];
      if (solo >= 0 && p !== solo) {
        // Soloing cuts the others outright rather than ducking them: a soloed pad is a
        // performance move, and a tail bleeding back in on un-solo sounds like a bug.
        if (voice.active) voice.reset();
        this.padMeters[p] = 0;
        continue;
      }
      if (!voice.active) {
        this.padMeters[p] = 0;
        continue;
      }

      const chain = this.padChains[p];
      if (chain && chain.length > 0) {
        for (let i = 0; i < frames; i++) {
          padL[i] = 0;
          padR[i] = 0;
        }
        voice.process(padL, padR, frames);
        chain.process(padL, padR, frames);
        for (let i = 0; i < frames; i++) {
          busL[i] += padL[i];
          busR[i] += padR[i];
        }
      } else {
        voice.process(busL, busR, frames);
      }
      this.padMeters[p] = voice.meter;
      sounded = true;
    }

    if (!sounded) {
      this.meterL = 0;
      this.meterR = 0;
      return;
    }

    // Rack gain, sanitising and metering in one pass over the bus, then sum into the
    // caller's buffer.
    let pkL = 0;
    let pkR = 0;
    const g = this.gain;
    for (let i = 0; i < frames; i++) {
      const l = sanitize(busL[i] * g);
      const r = sanitize(busR[i] * g);
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > pkL) pkL = al;
      if (ar > pkR) pkR = ar;
      L[i] += l;
      R[i] += r;
    }
    this.meterL = pkL;
    this.meterR = pkR;
  }
}
