'worklet';
/**
 * Bro.Kodr DSP core — biquad filters.
 *
 * RBJ audio-EQ-cookbook coefficients, transposed-direct-form-II implementation
 * (better numerical behaviour at low frequencies than DF-I with float32 state).
 * Coefficients are recomputed only when a parameter actually changes; the caller
 * feeds smoothed parameter values so sweeps stay click-free.
 */

import { sanitize, clamp } from "./utils.js";

export const FilterType = {
  LOWPASS: 0,
  HIGHPASS: 1,
  BANDPASS: 2,
  NOTCH: 3,
  PEAK: 4,
  LOWSHELF: 5,
  HIGHSHELF: 6,
  ALLPASS: 7,
};

export class Biquad {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.z1 = 0;
    this.z2 = 0;
    this.type = -1;
    this.freq = -1;
    this.q = -1;
    this.gainDb = -1;
  }

  reset() {
    this.z1 = 0;
    this.z2 = 0;
  }

  /** Idempotent: returns immediately if nothing changed. */
  set(type, freq, q, gainDb = 0) {
    if (type === this.type && freq === this.freq && q === this.q && gainDb === this.gainDb) return;
    this.type = type;
    this.freq = freq;
    this.q = q;
    this.gainDb = gainDb;
    this._compute(type, freq, q, gainDb);
  }

  _compute(type, freq, q, gainDb) {
    const nyq = this.sr * 0.5;
    const f = clamp(freq, 10, nyq * 0.995);
    q = Math.max(q, 0.02);
    const w0 = (2 * Math.PI * f) / this.sr;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;

    switch (type) {
      case FilterType.LOWPASS:
        b0 = (1 - cw) * 0.5;
        b1 = 1 - cw;
        b2 = (1 - cw) * 0.5;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case FilterType.HIGHPASS:
        b0 = (1 + cw) * 0.5;
        b1 = -(1 + cw);
        b2 = (1 + cw) * 0.5;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case FilterType.BANDPASS:
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case FilterType.NOTCH:
        b0 = 1;
        b1 = -2 * cw;
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case FilterType.PEAK:
        b0 = 1 + alpha * A;
        b1 = -2 * cw;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cw;
        a2 = 1 - alpha / A;
        break;
      case FilterType.LOWSHELF: {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cw + s);
        b1 = 2 * A * (A - 1 - (A + 1) * cw);
        b2 = A * (A + 1 - (A - 1) * cw - s);
        a0 = A + 1 + (A - 1) * cw + s;
        a1 = -2 * (A - 1 + (A + 1) * cw);
        a2 = A + 1 + (A - 1) * cw - s;
        break;
      }
      case FilterType.HIGHSHELF: {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cw + s);
        b1 = -2 * A * (A - 1 + (A + 1) * cw);
        b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s;
        a1 = 2 * (A - 1 - (A + 1) * cw);
        a2 = A + 1 - (A - 1) * cw - s;
        break;
      }
      case FilterType.ALLPASS:
        b0 = 1 - alpha;
        b1 = -2 * cw;
        b2 = 1 + alpha;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      default:
        b0 = 1;
        b1 = 0;
        b2 = 0;
        a0 = 1;
        a1 = 0;
        a2 = 0;
    }

    const inv = 1 / a0;
    this.b0 = b0 * inv;
    this.b1 = b1 * inv;
    this.b2 = b2 * inv;
    this.a1 = a1 * inv;
    this.a2 = a2 * inv;
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = sanitize(this.b1 * x - this.a1 * y + this.z2);
    this.z2 = sanitize(this.b2 * x - this.a2 * y);
    return y;
  }

  /** Magnitude response in dB at a given frequency — drives the EQ curve display. */
  magnitudeDb(f) {
    const w = (2 * Math.PI * f) / this.sr;
    const cw = Math.cos(w);
    const c2w = Math.cos(2 * w);
    const sw = Math.sin(w);
    const s2w = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * cw + this.b2 * c2w;
    const ni = -(this.b1 * sw + this.b2 * s2w);
    const dr = 1 + this.a1 * cw + this.a2 * c2w;
    const di = -(this.a1 * sw + this.a2 * s2w);
    const num = Math.sqrt(nr * nr + ni * ni);
    const den = Math.sqrt(dr * dr + di * di) + 1e-20;
    return 20 * Math.log10(num / den + 1e-20);
  }
}

/**
 * Cascaded identical biquads — used for steep filter slopes (12/24/36/48 dB/oct)
 * with per-stage Butterworth Q staggering so the composite response stays flat.
 */
export class BiquadCascade {
  constructor(sampleRate, stages) {
    this.stages = [];
    for (let i = 0; i < stages; i++) this.stages.push(new Biquad(sampleRate));
  }

  set(type, freq, q, gainDb = 0) {
    const n = this.stages.length;
    for (let i = 0; i < n; i++) {
      // Butterworth Q staggering for an N-stage cascade.
      const qk = n === 1 ? q : q / (2 * Math.cos((Math.PI * (2 * i + 1)) / (4 * n)));
      this.stages[i].set(type, freq, qk, gainDb / n);
    }
  }

  setActive(n) {
    this.active = Math.min(n, this.stages.length);
  }

  process(x) {
    const n = this.active === undefined ? this.stages.length : this.active;
    for (let i = 0; i < n; i++) x = this.stages[i].process(x);
    return x;
  }

  reset() {
    for (const s of this.stages) s.reset();
  }

  magnitudeDb(f) {
    const n = this.active === undefined ? this.stages.length : this.active;
    let db = 0;
    for (let i = 0; i < n; i++) db += this.stages[i].magnitudeDb(f);
    return db;
  }
}

/** State-variable filter — better for fast modulation (LFO-swept filters) than recomputing biquads. */
export class SVF {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.ic1 = 0;
    this.ic2 = 0;
    this.g = 0;
    this.k = 1;
    this.a1 = 0;
    this.a2 = 0;
    this.a3 = 0;
  }

  set(freq, q) {
    const f = clamp(freq, 10, this.sr * 0.49);
    this.g = Math.tan((Math.PI * f) / this.sr);
    this.k = 1 / Math.max(q, 0.05);
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }

  /** Returns [lp, bp, hp] via out param free approach: caller picks with mode. */
  process(x, mode) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = sanitize(2 * v1 - this.ic1);
    this.ic2 = sanitize(2 * v2 - this.ic2);
    if (mode === 0) return v2; // lowpass
    if (mode === 1) return v1; // bandpass
    return x - this.k * v1 - v2; // highpass
  }

  reset() {
    this.ic1 = 0;
    this.ic2 = 0;
  }
}
