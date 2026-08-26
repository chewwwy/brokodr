/**
 * Bro.Kodr — modulation effects: chorus, flanger, phaser, tremolo, ring mod, frequency shifter.
 */

import { Effect } from "./base.js";
import { Biquad, FilterType } from "../core/biquad.js";
import { DelayLine } from "../core/delay-line.js";
import { Smoother, LFO, Oscillator, dbToGain, clamp, sanitize, TWO_PI } from "../core/utils.js";

/**
 * Chorus — 3 voices per channel with staggered LFO phases and Hermite-interpolated
 * fractional delay. Voices are spread across the stereo field and detuned slightly
 * relative to each other rather than sharing one LFO, which is what gives it depth
 * instead of a single obvious wobble.
 */
export class Chorus extends Effect {
  static id = "chorus";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    const maxDelay = Math.ceil(sampleRate * 0.05);
    this.voices = 3;
    this.lines = [new DelayLine(maxDelay), new DelayLine(maxDelay)];
    this.lfos = [];
    for (let i = 0; i < 6; i++) {
      const l = new LFO(sampleRate);
      l.setRate(0.4);
      l.setPhase(i / 6);
      this.lfos.push(l);
    }
    this.rateSm = new Smoother(sampleRate, 30, 0.4);
    this.depthSm = new Smoother(sampleRate, 30, 0.003);
    this.delaySm = new Smoother(sampleRate, 30, 0.012);
    this.spread = 1;
    this.feedback = 0;
    this.hpL = new Biquad(sampleRate);
    this.hpR = new Biquad(sampleRate);
    this.fbL = 0;
    this.fbR = 0;
  }

  setParam(id, v) {
    switch (id) {
      case "rate":
        this.rateSm.set(v);
        for (let i = 0; i < 6; i++) this.lfos[i].setRate(v * (1 + i * 0.07));
        break;
      case "depth":
        this.depthSm.set(v * 0.008);
        break;
      case "delay":
        this.delaySm.set(v * 0.001);
        break;
      case "voices":
        this.voices = clamp(Math.round(v), 1, 3);
        break;
      case "spread":
        this.spread = clamp(v, 0, 1);
        break;
      case "feedback":
        this.feedback = clamp(v, -0.95, 0.95);
        break;
    }
  }

  reset() {
    for (const l of this.lines) l.clear();
    this.fbL = 0;
    this.fbR = 0;
  }

  process(L, R, frames) {
    this.hpL.set(FilterType.HIGHPASS, 120, 0.7071);
    this.hpR.set(FilterType.HIGHPASS, 120, 0.7071);
    const n = this.voices;
    for (let i = 0; i < frames; i++) {
      const depth = this.depthSm.next() * this.sr;
      const base = this.delaySm.next() * this.sr;
      this.rateSm.next();

      this.lines[0].write(L[i] + this.fbL * this.feedback);
      this.lines[1].write(R[i] + this.fbR * this.feedback);

      let sumL = 0;
      let sumR = 0;
      for (let v = 0; v < n; v++) {
        const ml = this.lfos[v * 2].next();
        const mr = this.lfos[v * 2 + 1].next();
        const dl = base + depth * (0.5 + 0.5 * ml) + v * base * 0.35;
        const dr = base + depth * (0.5 + 0.5 * mr) + v * base * 0.35;
        const sl = this.lines[0].readCubic(dl);
        const sr = this.lines[1].readCubic(dr);
        // Alternate voices lean opposite sides for width.
        const panL = v % 2 === 0 ? 1 : 1 - this.spread * 0.7;
        const panR = v % 2 === 0 ? 1 - this.spread * 0.7 : 1;
        sumL += sl * panL;
        sumR += sr * panR;
      }
      const g = 1 / n;
      this.fbL = sanitize(this.hpL.process(sumL * g));
      this.fbR = sanitize(this.hpR.process(sumR * g));
      L[i] = sanitize(sumL * g);
      R[i] = sanitize(sumR * g);
    }
  }
}

/**
 * Flanger — single short modulated delay with feedback and optional inversion.
 * Through-zero-ish range (0.1–10ms) with the classic metallic comb sweep.
 */
export class Flanger extends Effect {
  static id = "flanger";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    const maxDelay = Math.ceil(sampleRate * 0.03);
    this.lineL = new DelayLine(maxDelay);
    this.lineR = new DelayLine(maxDelay);
    this.lfoL = new LFO(sampleRate);
    this.lfoR = new LFO(sampleRate);
    this.lfoL.setRate(0.25);
    this.lfoR.setRate(0.25);
    this.lfoR.setPhase(0.25);
    this.depthSm = new Smoother(sampleRate, 30, 0.002);
    this.delaySm = new Smoother(sampleRate, 30, 0.001);
    this.feedback = 0.5;
    this.invert = 0;
    this.damp = new Biquad(sampleRate);
    this.dampR = new Biquad(sampleRate);
    this.dampFreq = 8000;
    this.fbL = 0;
    this.fbR = 0;
    this.stereoPhase = 0.25;
  }

  setParam(id, v) {
    switch (id) {
      case "rate":
        this.lfoL.setRate(v);
        this.lfoR.setRate(v);
        break;
      case "depth":
        this.depthSm.set(v * 0.005);
        break;
      case "delay":
        this.delaySm.set(v * 0.001);
        break;
      case "feedback":
        this.feedback = clamp(v, -0.98, 0.98);
        break;
      case "invert":
        this.invert = v >= 0.5 ? 1 : 0;
        break;
      case "damp":
        this.dampFreq = v;
        break;
      case "stereo":
        this.stereoPhase = clamp(v, 0, 0.5);
        this.lfoR.setPhase(this.lfoL.phase + this.stereoPhase);
        break;
      case "shape":
        this.lfoL.shape = Math.round(v);
        this.lfoR.shape = Math.round(v);
        break;
    }
  }

  reset() {
    this.lineL.clear();
    this.lineR.clear();
    this.fbL = 0;
    this.fbR = 0;
    this.damp.reset();
    this.dampR.reset();
  }

  process(L, R, frames) {
    this.damp.set(FilterType.LOWPASS, this.dampFreq, 0.7071);
    this.dampR.set(FilterType.LOWPASS, this.dampFreq, 0.7071);
    const sign = this.invert ? -1 : 1;
    for (let i = 0; i < frames; i++) {
      const depth = this.depthSm.next() * this.sr;
      const base = this.delaySm.next() * this.sr;
      const dl = base + depth * (0.5 + 0.5 * this.lfoL.next());
      const dr = base + depth * (0.5 + 0.5 * this.lfoR.next());

      this.lineL.write(L[i] + this.fbL * this.feedback * sign);
      this.lineR.write(R[i] + this.fbR * this.feedback * sign);

      const wl = this.lineL.readCubic(dl);
      const wr = this.lineR.readCubic(dr);
      this.fbL = sanitize(this.damp.process(wl));
      this.fbR = sanitize(this.dampR.process(wr));
      L[i] = sanitize(wl);
      R[i] = sanitize(wr);
    }
  }
}

/**
 * Phaser — cascade of up to 8 first-order-equivalent allpass sections swept by an LFO,
 * with feedback. Notches move logarithmically, which sounds musical; a linear sweep
 * would bunch all the movement at the top.
 */
export class Phaser extends Effect {
  static id = "phaser";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    this.stages = 4;
    this.apL = [];
    this.apR = [];
    for (let i = 0; i < 8; i++) {
      this.apL.push(new Biquad(sampleRate));
      this.apR.push(new Biquad(sampleRate));
    }
    this.lfo = new LFO(sampleRate);
    this.lfo.setRate(0.3);
    this.lfoR = new LFO(sampleRate);
    this.lfoR.setRate(0.3);
    this.lfoR.setPhase(0.25);
    this.centerSm = new Smoother(sampleRate, 30, 800);
    this.depthSm = new Smoother(sampleRate, 30, 0.7);
    this.feedback = 0.3;
    this.q = 0.7;
    this.fbL = 0;
    this.fbR = 0;
    this.stereo = 0.25;
  }

  setParam(id, v) {
    switch (id) {
      case "rate":
        this.lfo.setRate(v);
        this.lfoR.setRate(v);
        break;
      case "depth":
        this.depthSm.set(clamp(v, 0, 1));
        break;
      case "center":
        this.centerSm.set(v);
        break;
      case "stages":
        this.stages = clamp(Math.round(v), 1, 8);
        break;
      case "feedback":
        this.feedback = clamp(v, -0.95, 0.95);
        break;
      case "q":
        this.q = Math.max(0.2, v);
        break;
      case "stereo":
        this.stereo = clamp(v, 0, 0.5);
        this.lfoR.setPhase(this.lfo.phase + this.stereo);
        break;
      case "shape":
        this.lfo.shape = Math.round(v);
        this.lfoR.shape = Math.round(v);
        break;
    }
  }

  reset() {
    for (const a of this.apL) a.reset();
    for (const a of this.apR) a.reset();
    this.fbL = 0;
    this.fbR = 0;
  }

  process(L, R, frames) {
    const n = this.stages;
    // Coefficients update at block rate — 2.7ms granularity is inaudible for a sweep
    // and saves 8 coefficient recalcs per sample.
    const center = this.centerSm.next();
    const depth = this.depthSm.next();
    for (let i = 1; i < frames; i++) {
      this.centerSm.next();
      this.depthSm.next();
    }
    const ml = this.lfo.next();
    const mr = this.lfoR.next();
    for (let i = 1; i < frames; i++) {
      this.lfo.next();
      this.lfoR.next();
    }
    const octaves = depth * 3;
    const fl = clamp(center * Math.pow(2, ml * octaves), 40, this.sr * 0.45);
    const fr = clamp(center * Math.pow(2, mr * octaves), 40, this.sr * 0.45);
    for (let s = 0; s < n; s++) {
      const spread = Math.pow(1.4, s);
      this.apL[s].set(FilterType.ALLPASS, clamp(fl * spread, 40, this.sr * 0.45), this.q);
      this.apR[s].set(FilterType.ALLPASS, clamp(fr * spread, 40, this.sr * 0.45), this.q);
    }

    for (let i = 0; i < frames; i++) {
      let l = L[i] + this.fbL * this.feedback;
      let r = R[i] + this.fbR * this.feedback;
      for (let s = 0; s < n; s++) {
        l = this.apL[s].process(l);
        r = this.apR[s].process(r);
      }
      this.fbL = sanitize(l);
      this.fbR = sanitize(r);
      L[i] = sanitize(l);
      R[i] = sanitize(r);
    }
  }
}

/** Tremolo / auto-pan / gate-style amplitude LFO with tempo sync support. */
export class Tremolo extends Effect {
  static id = "tremolo";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    this.lfo = new LFO(sampleRate);
    this.lfo.setRate(5);
    this.depthSm = new Smoother(sampleRate, 20, 0.5);
    this.stereoMode = 0; // 0 = tremolo, 1 = autopan
    this.phaseOffset = 0.5;
    this.lfoR = new LFO(sampleRate);
    this.lfoR.setRate(5);
    this.lfoR.setPhase(0.5);
    this.smoothness = 1;
  }

  setParam(id, v) {
    switch (id) {
      case "rate":
        this.lfo.setRate(v);
        this.lfoR.setRate(v);
        break;
      case "depth":
        this.depthSm.set(clamp(v, 0, 1));
        break;
      case "shape":
        this.lfo.shape = Math.round(v);
        this.lfoR.shape = Math.round(v);
        break;
      case "mode":
        this.stereoMode = Math.round(v);
        break;
      case "phase":
        this.phaseOffset = clamp(v, 0, 1);
        this.lfoR.setPhase(this.lfo.phase + this.phaseOffset);
        break;
    }
  }

  process(L, R, frames) {
    for (let i = 0; i < frames; i++) {
      const d = this.depthSm.next();
      const a = this.lfo.next();
      const b = this.lfoR.next();
      if (this.stereoMode === 1) {
        const gl = 1 - d * (0.5 + 0.5 * a);
        const gr = 1 - d * (0.5 - 0.5 * a);
        L[i] *= gl;
        R[i] *= gr;
      } else {
        L[i] *= 1 - d * (0.5 + 0.5 * a);
        R[i] *= 1 - d * (0.5 + 0.5 * b);
      }
    }
  }
}

/**
 * Ring modulator — multiplies the signal by an oscillator. Classic Dalek/alien voice.
 * Includes a dry-carrier-suppression option (true four-quadrant multiply vs. AM).
 */
export class RingMod extends Effect {
  static id = "ringmod";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    this.osc = new Oscillator(sampleRate);
    this.freqSm = new Smoother(sampleRate, 25, 200);
    this.shape = 0;
    this.amMode = 0;
    this.lfo = new LFO(sampleRate);
    this.lfo.setRate(0);
    this.sweepDepth = 0;
    this.phase = 0;
  }

  setParam(id, v) {
    switch (id) {
      case "freq":
        this.freqSm.set(v);
        break;
      case "shape":
        this.shape = Math.round(v);
        break;
      case "mode":
        this.amMode = v >= 0.5 ? 1 : 0;
        break;
      case "sweeprate":
        this.lfo.setRate(v);
        break;
      case "sweepdepth":
        this.sweepDepth = clamp(v, 0, 1);
        break;
    }
  }

  process(L, R, frames) {
    for (let i = 0; i < frames; i++) {
      let f = this.freqSm.next();
      if (this.sweepDepth > 0.001) f *= Math.pow(2, this.lfo.next() * this.sweepDepth * 2);
      this.osc.setFreq(f);
      let c;
      if (this.shape === 1) {
        c = this.osc.saw();
      } else if (this.shape === 2) {
        this.osc.pw = 0.5;
        c = this.osc.pulse();
      } else {
        this.phase += f / this.sr;
        if (this.phase >= 1) this.phase -= 1;
        c = Math.sin(TWO_PI * this.phase);
      }
      // AM keeps some of the original (offset carrier), ring mod is pure multiply.
      const m = this.amMode ? 0.5 + 0.5 * c : c;
      L[i] = sanitize(L[i] * m);
      R[i] = sanitize(R[i] * m);
    }
  }
}

/**
 * Frequency shifter (single-sideband / Bode style).
 *
 * Unlike a pitch shifter, this ADDS a constant Hz offset to every partial, breaking
 * harmonic relationships — inharmonic, metallic, unmistakably electronic. Built from
 * a Hilbert transform (two allpass chains 90 degrees apart) and a quadrature oscillator.
 */
export class FrequencyShifter extends Effect {
  static id = "freqshift";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    // Allpass coefficient pairs producing a ~90 degree phase difference across the band.
    this.coefA = [0.6923878, 0.9360654322959, 0.9882295226860, 0.9987488452737];
    this.coefB = [0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278];
    this.stateA = [this.#mkChain(this.coefA), this.#mkChain(this.coefA)];
    this.stateB = [this.#mkChain(this.coefB), this.#mkChain(this.coefB)];
    this.delayA = [0, 0];
    this.freqSm = new Smoother(sampleRate, 25, 0);
    this.phase = 0;
    this.feedback = 0;
    this.fbL = 0;
    this.fbR = 0;
  }

  #mkChain(coefs) {
    return coefs.map((c) => ({ a: c * c, x1: 0, x2: 0, y1: 0, y2: 0 }));
  }

  #allpass(chain, x) {
    for (const s of chain) {
      const y = s.a * (x + s.y2) - s.x2;
      s.x2 = s.x1;
      s.x1 = x;
      s.y2 = s.y1;
      s.y1 = y;
      x = sanitize(y);
    }
    return x;
  }

  setParam(id, v) {
    if (id === "freq") this.freqSm.set(v);
    else if (id === "feedback") this.feedback = clamp(v, 0, 0.9);
  }

  reset() {
    this.stateA = [this.#mkChain(this.coefA), this.#mkChain(this.coefA)];
    this.stateB = [this.#mkChain(this.coefB), this.#mkChain(this.coefB)];
    this.fbL = 0;
    this.fbR = 0;
  }

  process(L, R, frames) {
    for (let i = 0; i < frames; i++) {
      const f = this.freqSm.next();
      this.phase += f / this.sr;
      if (this.phase >= 1) this.phase -= 1;
      else if (this.phase < 0) this.phase += 1;
      const cos = Math.cos(TWO_PI * this.phase);
      const sin = Math.sin(TWO_PI * this.phase);

      for (let c = 0; c < 2; c++) {
        const buf = c === 0 ? L : R;
        const fb = c === 0 ? this.fbL : this.fbR;
        const x = buf[i] + fb * this.feedback;
        // chain A output is delayed one sample to align with chain B
        const a = this.#allpass(this.stateA[c], x);
        const b = this.#allpass(this.stateB[c], x);
        const aDelayed = this.delayA[c];
        this.delayA[c] = a;
        const y = aDelayed * cos - b * sin;
        const out = sanitize(y);
        if (c === 0) this.fbL = out;
        else this.fbR = out;
        buf[i] = out;
      }
    }
  }
}
