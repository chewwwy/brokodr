/**
 * Bro.Kodr — channel vocoder.
 *
 * Classic analogue-style architecture, not an FFT cross-synthesis shortcut:
 *
 *   modulator (your voice) -> N bandpass filters -> envelope followers
 *   carrier (internal synth) -> the SAME N bandpass filters -> VCA per band
 *   sum of bands * matching envelope -> output
 *
 * The bandpass bank is log-spaced across the chosen range with 2-pole filters per
 * band (cascaded to 4-pole for tighter bands at high band counts). Envelope
 * followers have independent attack/release: fast attack keeps consonants
 * intelligible, slower release stops the classic "gargling" on sibilants.
 *
 * Carrier options: PolyBLEP saw, pulse (with PWM), dual-saw detuned, and noise —
 * plus PITCH FOLLOW, where an autocorrelation tracker locks the carrier to the
 * singer's own pitch, giving a harmonised robot rather than a monotone one.
 * An unvoiced/sibilance path mixes noise into high bands so "s" and "t" survive.
 */

import { Effect } from "./base.js";
import { Biquad, FilterType } from "../core/biquad.js";
import {
  Smoother,
  EnvelopeFollower,
  Oscillator,
  PitchTracker,
  dbToGain,
  clamp,
  sanitize,
} from "../core/utils.js";

const MAX_BANDS = 32;

export class Vocoder extends Effect {
  static id = "vocoder";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);

    this.bandCount = 16;
    this.freqLo = 120;
    this.freqHi = 7000;
    this.qFactor = 4;
    this.carrierType = 0; // 0 saw 1 pulse 2 dual-saw 3 noise 4 sub+saw
    this.carrierPitchHz = 110;
    this.pitchFollow = 0;
    this.depth = 1;
    this.tone = 0;
    this.sibilance = 0.3;
    this.attackMs = 3;
    this.releaseMs = 25;
    // Raw carrier bleed, in dB. Defaults to off: an always-on carrier would drone
    // through silence between words, which is the classic broken-vocoder sound.
    this.carrierLevel = -60;
    this.stereoSpread = 0;
    // 0 = internal synth carrier, 1 = the loaded audio file as the carrier.
    this.source = 0;
    this.carBusL = null;
    this.carBusR = null;
    // Running mean-square of the file carrier, ~100ms, so an arbitrary track lands
    // at roughly the same level the synth carriers do.
    this.carRms = 0;
    this.carRmsA = 1 - Math.exp(-1 / (0.1 * sampleRate));

    this.bands = [];
    for (let i = 0; i < MAX_BANDS; i++) {
      this.bands.push({
        modA: new Biquad(sampleRate),
        modB: new Biquad(sampleRate),
        carA: new Biquad(sampleRate),
        carB: new Biquad(sampleRate),
        env: new EnvelopeFollower(sampleRate, 3, 25, true),
        freq: 100,
        gain: 1,
        pan: 0,
        // Last envelope value, published to the UI ladder via `get visual()`.
        level: 0,
      });
    }

    this.osc1 = new Oscillator(sampleRate);
    this.osc2 = new Oscillator(sampleRate);
    this.oscSub = new Oscillator(sampleRate);
    this.tracker = new PitchTracker(sampleRate);
    this.trackedHz = 0;
    this.pitchSm = new Smoother(sampleRate, 30, 110);
    this.depthSm = new Smoother(sampleRate, 20, 1);
    this.outSm = new Smoother(sampleRate, 20, 1);

    this.sibHp = new Biquad(sampleRate);
    this.sibEnv = new EnvelopeFollower(sampleRate, 2, 30, true);
    // Broadband modulator envelope — gates the carrier bleed so the synth only
    // sounds while there is actually a voice present.
    this.inEnv = new EnvelopeFollower(sampleRate, 5, 80, true);

    // Band-envelope snapshot for the UI ladder. Preallocated: the getter is called
    // from the worklet's message handler, which shares the audio thread, so it must
    // not allocate. Values are the same RMS envelopes the VCAs use — this display is
    // the actual gain per band, not a re-analysis of the output.
    this.visualBuf = new Float32Array(MAX_BANDS);

    this.dirty = true;
    this.#rebuild();
  }

  /**
   * Per-band envelope levels, active bands only, as a 0..1 display value.
   * Mapped through a -60dB floor so quiet consonants still move the ladder;
   * a linear envelope would leave the bars flat for anything but a shout.
   */
  get visual() {
    const n = this.bandCount;
    for (let i = 0; i < n; i++) {
      const e = this.bands[i].level;
      // -60dB floor, normalised. e is RMS-linear.
      const db = e > 1e-6 ? 20 * Math.log10(e) : -120;
      const v = (db + 60) / 60;
      this.visualBuf[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    return this.visualBuf.subarray(0, n);
  }

  /** Handed the shared file-carrier bus once, at add time, by the chain runner. */
  setCarrierBus(l, r) {
    this.carBusL = l;
    this.carBusR = r;
  }

  setParam(id, v) {
    switch (id) {
      case "bands":
        this.bandCount = clamp(Math.round(v), 4, MAX_BANDS);
        this.dirty = true;
        break;
      case "freqlo":
        this.freqLo = v;
        this.dirty = true;
        break;
      case "freqhi":
        this.freqHi = v;
        this.dirty = true;
        break;
      case "q":
        this.qFactor = Math.max(0.5, v);
        this.dirty = true;
        break;
      case "carrier":
        this.carrierType = clamp(Math.round(v), 0, 4);
        break;
      case "pitch":
        this.carrierPitchHz = clamp(v, 20, 2000);
        if (!this.pitchFollow) this.pitchSm.set(this.carrierPitchHz);
        break;
      case "follow":
        this.pitchFollow = v >= 0.5 ? 1 : 0;
        break;
      case "depth":
        this.depth = clamp(v, 0, 1);
        this.depthSm.set(this.depth);
        break;
      case "tone":
        this.tone = clamp(v, -1, 1);
        this.dirty = true;
        break;
      case "sibilance":
        this.sibilance = clamp(v, 0, 1);
        break;
      case "attack":
        this.attackMs = Math.max(0.2, v);
        for (const b of this.bands) b.env.setAttack(this.attackMs);
        break;
      case "release":
        this.releaseMs = Math.max(2, v);
        for (const b of this.bands) b.env.setRelease(this.releaseMs);
        break;
      case "carrierlevel":
        this.carrierLevel = v;
        break;
      case "output":
        this.outSm.set(dbToGain(v));
        break;
      case "spread":
        this.stereoSpread = clamp(v, 0, 1);
        this.dirty = true;
        break;
      case "source":
        this.source = v >= 0.5 ? 1 : 0;
        break;
    }
  }

  /** Recompute band centre frequencies, filter coefficients and tone tilt. */
  #rebuild() {
    const n = this.bandCount;
    const lo = Math.log2(Math.max(40, this.freqLo));
    const hi = Math.log2(Math.min(this.sr * 0.45, Math.max(this.freqLo * 2, this.freqHi)));
    const nyq = this.sr * 0.45;

    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const f = Math.min(Math.pow(2, lo + (hi - lo) * t), nyq);
      const b = this.bands[i];
      b.freq = f;
      b.modA.set(FilterType.BANDPASS, f, this.qFactor);
      b.modB.set(FilterType.BANDPASS, f, this.qFactor);
      b.carA.set(FilterType.BANDPASS, f, this.qFactor);
      b.carB.set(FilterType.BANDPASS, f, this.qFactor);
      // Tone tilt: positive brightens (high bands louder), negative darkens.
      const tilt = (t - 0.5) * 2 * this.tone * 12;
      b.gain = dbToGain(tilt);
      // Alternate band panning for a wide "spectral stereo" vocoder.
      b.pan = this.stereoSpread * (i % 2 === 0 ? -1 : 1);
    }
    this.dirty = false;
  }

  reset() {
    for (const b of this.bands) {
      b.modA.reset();
      b.modB.reset();
      b.carA.reset();
      b.carB.reset();
      b.env.reset();
      b.level = 0;
    }
    this.sibHp.reset();
    this.sibEnv.reset();
    this.inEnv.reset();
    this.carRms = 0;
  }

  process(L, R, frames) {
    if (this.dirty) this.#rebuild();

    // Pitch tracking runs once per block on the mono sum.
    if (this.pitchFollow) {
      for (let i = 0; i < frames; i++) this.tracker.push((L[i] + R[i]) * 0.5);
      const hz = this.tracker.analyze();
      if (hz > 0) {
        this.trackedHz = hz;
        this.pitchSm.set(hz);
      }
    } else {
      this.pitchSm.set(this.carrierPitchHz);
    }

    this.sibHp.set(FilterType.HIGHPASS, 4500, 0.7071);
    const n = this.bandCount;
    const carGain = dbToGain(this.carrierLevel);
    const invN = 1 / Math.sqrt(n);
    let envSum = 0;

    for (let i = 0; i < frames; i++) {
      const mod = (L[i] + R[i]) * 0.5;
      const depth = this.depthSm.next();
      const outG = this.outSm.next();

      // ---- carrier generation -------------------------------------------
      const f0 = this.pitchSm.next();
      let car;
      switch (this.carrierType) {
        case 1:
          this.osc1.setFreq(f0);
          this.osc1.pw = 0.3;
          car = this.osc1.pulse();
          break;
        case 2:
          this.osc1.setFreq(f0);
          this.osc2.setFreq(f0 * 1.005);
          car = (this.osc1.saw() + this.osc2.saw()) * 0.5;
          break;
        case 3:
          car = Math.random() * 2 - 1;
          break;
        case 4:
          this.osc1.setFreq(f0);
          this.oscSub.setFreq(f0 * 0.5);
          car = this.osc1.saw() * 0.6 + this.oscSub.pulse() * 0.4;
          break;
        default:
          this.osc1.setFreq(f0);
          car = this.osc1.saw();
      }

      // File carrier replaces the synth, RMS-normalised so band levels stay sane.
      if (this.source === 1 && this.carBusL) {
        const c = (this.carBusL[i] + this.carBusR[i]) * 0.5;
        this.carRms += (c * c - this.carRms) * this.carRmsA;
        const rms = Math.sqrt(this.carRms);
        car = rms > 1e-5 ? c / rms : 0;
      }

      // Unvoiced detection: strong HF energy with no clear pitch = sibilant.
      const sib = this.sibEnv.process(this.sibHp.process(mod));
      // Squelch below roughly -66dBFS so room noise doesn't hold the carrier open.
      const inLevel = this.inEnv.process(mod);
      const squelch = inLevel < 0.0005 ? 0 : Math.min(1, inLevel * 12);
      const noise = (Math.random() * 2 - 1) * sib * this.sibilance * 6;

      // ---- band loop ----------------------------------------------------
      let outL = 0;
      let outR = 0;
      for (let k = 0; k < n; k++) {
        const b = this.bands[k];
        // 4-pole modulator band (cascade of two 2-pole) for better separation
        const m = b.modB.process(b.modA.process(mod));
        const e = b.env.process(m);
        // Publish the envelope for the UI band ladder. Plain store, no allocation.
        b.level = e;

        const cIn = car + (b.freq > 3000 ? noise : 0);
        const c = b.carB.process(b.carA.process(cIn));

        const v = c * e * b.gain;
        if (this.stereoSpread > 0.001) {
          const p = b.pan;
          outL += v * (1 - Math.max(0, p));
          outR += v * (1 + Math.min(0, p));
        } else {
          outL += v;
          outR += v;
        }
        if (k === 0) envSum += e;
      }

      // Scale: envelope followers are RMS so the bank sums coherently; invN keeps
      // level roughly constant as band count changes.
      const wetL = outL * invN * 8 * depth;
      const wetR = outR * invN * 8 * depth;
      const bleed = car * carGain * 0.2 * squelch;

      L[i] = sanitize((wetL + bleed) * outG);
      R[i] = sanitize((wetR + bleed) * outG);
    }
    this.meter = this.pitchFollow ? this.trackedHz : 0;
  }
}
