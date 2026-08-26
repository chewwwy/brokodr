/**
 * Bro.Kodr — engine core (backend-agnostic).
 *
 * This is the piece a native (WASAPI/ASIO) backend would call instead of the
 * AudioWorklet. It has NO dependency on AudioWorklet, AudioContext, DOM or Node —
 * it is a pure processor:
 *
 *     const engine = new Engine(sampleRate, maxBlock);
 *     engine.applyCommand(cmd);            // control changes, off the audio thread's queue
 *     engine.process(inL, inR, outL, outR, frames);
 *
 * Design constraints, all deliberate:
 *  - Zero allocation in process(). Every buffer is allocated in the constructor or on
 *    an explicit control command, never in the audio callback.
 *  - No exceptions thrown on the audio path. A broken effect is skipped, not fatal.
 *  - Chain order is an array of slots; reordering is a control command that swaps
 *    references, so audio never stops and no filter state is destroyed.
 *  - Dry/wet and bypass are handled HERE, generically, so effects always render 100%
 *    wet and stay simple.
 *  - Metering (peak/RMS with peak-hold) and the record taps live here so the same
 *    numbers are available regardless of backend.
 */

import { createEffect } from "./effects/registry.js";
import { dbToGain, clamp, sanitize, gainToDb } from "./core/utils.js";
import { Smoother } from "./core/utils.js";
import { FilePlayer } from "./core/file-player.js";

const MAX_SLOTS = 24;

/**
 * Where the file player's output goes.
 *  OFF     — silent.
 *  INPUT   — the file is a normal source: it sums into the chain input alongside the
 *            mic (mute the mic to hear the file alone), so every effect AND the
 *            recorder see it.
 *  CARRIER — the file feeds the carrier bus instead: talk box / vocoder use it as the
 *            driver signal that the voice shapes. That is the real talk box rig.
 *  BOTH    — drives the carrier and is audible through the chain.
 */
const FILE_ROUTE = { OFF: 0, INPUT: 1, CARRIER: 2, BOTH: 3 };

class Slot {
  constructor(id, type, effect, sampleRate) {
    this.id = id;
    this.type = type;
    this.effect = effect;
    this.paramNames = null;
    this.bypassed = false;
    this.mix = new Smoother(sampleRate, 25, 1);
    this.mixTarget = 1;
  }
}

export class Engine {
  constructor(sampleRate, maxBlock) {
    this.sr = sampleRate;
    this.maxBlock = maxBlock;

    /** @type {Slot[]} ordered processing chain */
    this.slots = [];

    // Scratch buffers — allocated once.
    this.wetL = new Float32Array(maxBlock);
    this.wetR = new Float32Array(maxBlock);
    this.dryL = new Float32Array(maxBlock);
    this.dryR = new Float32Array(maxBlock);
    this.chainInL = new Float32Array(maxBlock);
    this.chainInR = new Float32Array(maxBlock);

    // File player + carrier bus. The bus is a second signal path that effects can opt
    // into (talk box, vocoder) via setCarrierBus(); it is filled before the chain runs
    // so an effect always reads carrier samples that belong to the current block.
    this.player = new FilePlayer(sampleRate, maxBlock);
    this.carrierL = new Float32Array(maxBlock);
    this.carrierR = new Float32Array(maxBlock);
    this.fileRoute = FILE_ROUTE.INPUT;

    // I/O gain stages.
    this.inGain = new Smoother(sampleRate, 20, 1);
    this.outGain = new Smoother(sampleRate, 20, 1);
    this.masterMix = new Smoother(sampleRate, 25, 1);
    this.inMuted = false;
    this.masterBypass = false;
    this.monoInput = false;
    this.inputSwap = false;

    // Metering state.
    this.meterInL = 0;
    this.meterInR = 0;
    this.meterOutL = 0;
    this.meterOutR = 0;
    this.rmsInL = 0;
    this.rmsInR = 0;
    this.rmsOutL = 0;
    this.rmsOutR = 0;
    this.clipIn = 0;
    this.clipOut = 0;
    this.peakHoldIn = 0;
    this.peakHoldOut = 0;

    // Per-slot meter readouts, polled by the UI.
    this.slotMeters = new Float32Array(MAX_SLOTS);

    this.blockCount = 0;
    this.cpuLoad = 0;
    this.latencySamples = 0;
  }

  // ---------------------------------------------------------------- control

  /**
   * Apply one control command. Called from the audio thread's command drain
   * (before processing a block), so allocation here is acceptable only for
   * structural commands — which is why param changes are a separate, allocation-free path.
   */
  applyCommand(cmd) {
    switch (cmd.t) {
      case "add": {
        if (this.slots.length >= MAX_SLOTS) return;
        const fx = createEffect(cmd.type, this.sr, this.maxBlock);
        if (!fx) return;
        const slot = new Slot(cmd.id, cmd.type, fx, this.sr);
        // Numeric param addressing table: the UI sends param changes as an index into
        // this array so the hot path stays a plain Float64 ring buffer (no strings).
        slot.paramNames = cmd.paramNames || null;
        if (cmd.params) {
          for (const k in cmd.params) fx.setParam(k, cmd.params[k]);
        }
        if (cmd.mix !== undefined) {
          slot.mixTarget = cmd.mix;
          slot.mix.reset(cmd.mix);
        }
        if (cmd.bypassed !== undefined) slot.bypassed = !!cmd.bypassed;
        // Effects that can be driven by an external carrier opt in here. Handing over
        // the bus references once at add time keeps process() free of any lookup.
        if (typeof fx.setCarrierBus === "function") fx.setCarrierBus(this.carrierL, this.carrierR);
        const at = cmd.index === undefined ? this.slots.length : clamp(cmd.index, 0, this.slots.length);
        this.slots.splice(at, 0, slot);
        this.recalcLatency();
        break;
      }
      case "remove": {
        const i = this.slots.findIndex((s) => s.id === cmd.id);
        if (i >= 0) this.slots.splice(i, 1);
        this.recalcLatency();
        break;
      }
      case "move": {
        const i = this.slots.findIndex((s) => s.id === cmd.id);
        if (i < 0) return;
        const [s] = this.slots.splice(i, 1);
        this.slots.splice(clamp(cmd.index, 0, this.slots.length), 0, s);
        break;
      }
      case "param": {
        const s = this.#find(cmd.id);
        if (s) s.effect.setParam(cmd.key, cmd.value);
        if (cmd.key === "quality") this.recalcLatency();
        break;
      }
      case "mix": {
        const s = this.#find(cmd.id);
        if (s) {
          s.mixTarget = clamp(cmd.value, 0, 1);
          s.mix.set(s.mixTarget);
        }
        break;
      }
      case "bypass": {
        const s = this.#find(cmd.id);
        if (s) {
          s.bypassed = !!cmd.value;
          if (s.bypassed) s.effect.reset();
        }
        break;
      }
      case "reset": {
        const s = this.#find(cmd.id);
        if (s) s.effect.reset();
        break;
      }
      case "clear": {
        this.slots.length = 0;
        this.recalcLatency();
        break;
      }
      case "io": {
        if (cmd.inGain !== undefined) this.inGain.set(dbToGain(cmd.inGain));
        if (cmd.outGain !== undefined) this.outGain.set(dbToGain(cmd.outGain));
        if (cmd.mute !== undefined) this.inMuted = !!cmd.mute;
        if (cmd.bypass !== undefined) this.masterBypass = !!cmd.bypass;
        if (cmd.mono !== undefined) this.monoInput = !!cmd.mono;
        if (cmd.swap !== undefined) this.inputSwap = !!cmd.swap;
        if (cmd.masterMix !== undefined) this.masterMix.set(clamp(cmd.masterMix, 0, 1));
        break;
      }
      case "fileload": {
        // Structural: the decoded audio arrives as SAB-backed views, so this is a
        // pointer handoff, not a copy, no matter how long the file is.
        this.player.setBuffer(cmd.chL, cmd.chR, cmd.frames, cmd.rate);
        break;
      }
      case "fileclear": {
        this.player.clearBuffer();
        break;
      }
      case "file": {
        this.player.setParam(cmd.key, cmd.value);
        break;
      }
      case "fileroute": {
        this.fileRoute = clamp(Math.round(cmd.value), 0, 3);
        break;
      }
      case "clipreset": {
        this.clipIn = 0;
        this.clipOut = 0;
        this.peakHoldIn = 0;
        this.peakHoldOut = 0;
        break;
      }
      case "panic": {
        for (const s of this.slots) s.effect.reset();
        break;
      }
    }
  }

  #find(id) {
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i].id === id) return this.slots[i];
    return null;
  }

  /** Sum of latency-introducing modules (currently only the STFT pitch shifter). */
  recalcLatency() {
    let n = 0;
    for (const s of this.slots) {
      if (!s.bypassed && s.effect.latencySamples) n += s.effect.latencySamples;
    }
    this.latencySamples = n;
  }

  /** Snapshot of per-slot meters + engine meters for the UI. */
  readMeters(out) {
    out[0] = this.meterInL;
    out[1] = this.meterInR;
    out[2] = this.meterOutL;
    out[3] = this.meterOutR;
    out[4] = this.rmsInL;
    out[5] = this.rmsInR;
    out[6] = this.rmsOutL;
    out[7] = this.rmsOutR;
    out[8] = this.clipIn;
    out[9] = this.clipOut;
    out[10] = this.cpuLoad;
    out[11] = this.latencySamples;
    out[12] = this.slots.length;
    // 40+ is free space past the per-slot meters (16 + MAX_SLOTS = 40): file transport.
    out[40] = this.player.position;
    out[41] = this.player.playing ? 1 : 0;
    out[42] = this.player.frames;
    out[43] = this.player.loaded ? this.player.srcRate : 0;
    out[44] = this.player.meter;
    for (let i = 0; i < this.slots.length && i < MAX_SLOTS; i++) {
      out[16 + i] = this.slots[i].effect.meter || 0;
    }
  }

  // ---------------------------------------------------------------- audio

  /**
   * Process one block. inL/inR and outL/outR may be the same arrays.
   * Returns nothing; never throws.
   */
  process(inL, inR, outL, outR, frames) {
    const dryL = this.dryL;
    const dryR = this.dryR;
    const cInL = this.chainInL;
    const cInR = this.chainInR;

    // ---- input stage: gain, mute, mono fold, channel swap, metering --------
    let pkInL = 0;
    let pkInR = 0;
    let sqInL = 0;
    let sqInR = 0;
    const muted = this.inMuted;

    // ---- file player -> carrier bus ---------------------------------------
    // Rendered before the input stage so the bus is valid for every effect in this
    // block, and so INPUT routing can sum it in below at the same gain stage as the
    // mic (which is what makes the recorder capture it for free).
    const route = this.fileRoute;
    const carL = this.carrierL;
    const carR = this.carrierR;
    let fileOn = false;
    if (route !== FILE_ROUTE.OFF && this.player.loaded) {
      fileOn = this.player.process(carL, carR, frames);
    } else {
      for (let i = 0; i < frames; i++) {
        carL[i] = 0;
        carR[i] = 0;
      }
    }
    const fileToInput = fileOn && (route === FILE_ROUTE.INPUT || route === FILE_ROUTE.BOTH);

    for (let i = 0; i < frames; i++) {
      const g = this.inGain.next();
      let l = inL[i];
      let r = inR[i];
      if (this.inputSwap) {
        const t = l;
        l = r;
        r = t;
      }
      if (this.monoInput) {
        const m = (l + r) * 0.5;
        l = m;
        r = m;
      }
      l = muted ? 0 : sanitize(l * g);
      r = muted ? 0 : sanitize(r * g);
      if (fileToInput) {
        // Summed post input-gain so the file level is set by its own fader, not by the
        // mic trim, and so dryL/dryR (the clean-take tap) contain it.
        l = sanitize(l + carL[i]);
        r = sanitize(r + carR[i]);
      }

      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > pkInL) pkInL = al;
      if (ar > pkInR) pkInR = ar;
      sqInL += l * l;
      sqInR += r * r;

      cInL[i] = l;
      cInR[i] = r;
      dryL[i] = l;
      dryR[i] = r;
    }

    if (pkInL >= 0.999 || pkInR >= 0.999) this.clipIn = 1;
    this.meterInL = pkInL;
    this.meterInR = pkInR;
    this.rmsInL = Math.sqrt(sqInL / frames);
    this.rmsInR = Math.sqrt(sqInR / frames);

    // ---- effect chain ------------------------------------------------------
    if (!this.masterBypass) {
      const wetL = this.wetL;
      const wetR = this.wetR;
      const slots = this.slots;

      for (let s = 0; s < slots.length; s++) {
        const slot = slots[s];
        if (slot.bypassed) continue;

        // Copy current signal as this slot's dry reference, then render 100% wet.
        for (let i = 0; i < frames; i++) {
          wetL[i] = cInL[i];
          wetR[i] = cInR[i];
        }

        slot.effect.process(wetL, wetR, frames);

        // Generic per-slot dry/wet crossfade. Skipping the mix loop entirely when
        // fully wet and settled saves a pass over the block on the common case.
        if (slot.mix.settled && slot.mix.value >= 0.9999) {
          for (let i = 0; i < frames; i++) {
            cInL[i] = wetL[i];
            cInR[i] = wetR[i];
          }
        } else {
          for (let i = 0; i < frames; i++) {
            const m = slot.mix.next();
            cInL[i] = cInL[i] * (1 - m) + wetL[i] * m;
            cInR[i] = cInR[i] * (1 - m) + wetR[i] * m;
          }
        }
      }
    }

    // ---- output stage: master dry/wet, gain, metering, safety clamp --------
    let pkOutL = 0;
    let pkOutR = 0;
    let sqOutL = 0;
    let sqOutR = 0;

    for (let i = 0; i < frames; i++) {
      const mm = this.masterMix.next();
      const g = this.outGain.next();
      let l = (dryL[i] * (1 - mm) + cInL[i] * mm) * g;
      let r = (dryR[i] * (1 - mm) + cInR[i] * mm) * g;

      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > pkOutL) pkOutL = al;
      if (ar > pkOutR) pkOutR = ar;
      sqOutL += l * l;
      sqOutR += r * r;

      // Hard safety clamp — protects speakers/ears from a runaway feedback path.
      // Never a substitute for the limiter; purely a last resort.
      outL[i] = sanitize(clamp(l, -1.4, 1.4));
      outR[i] = sanitize(clamp(r, -1.4, 1.4));
    }

    if (pkOutL >= 0.999 || pkOutR >= 0.999) this.clipOut = 1;
    this.meterOutL = pkOutL;
    this.meterOutR = pkOutR;
    this.rmsOutL = Math.sqrt(sqOutL / frames);
    this.rmsOutR = Math.sqrt(sqOutR / frames);
    this.blockCount++;
  }
}

export { MAX_SLOTS };
