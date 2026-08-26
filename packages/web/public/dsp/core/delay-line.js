/**
 * Bro.Kodr DSP core — delay lines and oversampling.
 */

import { sanitize, clamp } from "./utils.js";

/**
 * Fractional delay line with linear or cubic (Hermite) interpolation.
 * Cubic is used for modulated delays (chorus/flanger) where linear interpolation
 * produces audible high-frequency loss that pumps with the LFO.
 */
export class DelayLine {
  constructor(maxSamples) {
    this.size = Math.max(4, Math.ceil(maxSamples) + 4);
    this.buf = new Float32Array(this.size);
    this.w = 0;
  }

  clear() {
    this.buf.fill(0);
    this.w = 0;
  }

  write(x) {
    this.buf[this.w] = sanitize(x);
    this.w = (this.w + 1) % this.size;
  }

  /** Linear-interpolated read, delay in samples. */
  read(delaySamples) {
    const d = clamp(delaySamples, 0, this.size - 3);
    const r = this.w - 1 - d;
    const i0 = Math.floor(r);
    const frac = r - i0;
    const a = this.buf[((i0 % this.size) + this.size) % this.size];
    const b = this.buf[((((i0 + 1) % this.size) + this.size) % this.size)];
    return a + (b - a) * frac;
  }

  /** 4-point Hermite read — clean under heavy modulation. */
  readCubic(delaySamples) {
    const d = clamp(delaySamples, 1, this.size - 4);
    const r = this.w - 1 - d;
    const i1 = Math.floor(r);
    const frac = r - i1;
    const s = this.size;
    const x0 = this.buf[(((i1 - 1) % s) + s) % s];
    const x1 = this.buf[((i1 % s) + s) % s];
    const x2 = this.buf[(((i1 + 1) % s) + s) % s];
    const x3 = this.buf[(((i1 + 2) % s) + s) % s];
    const c0 = x1;
    const c1 = 0.5 * (x2 - x0);
    const c2 = x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3;
    const c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
    return ((c3 * frac + c2) * frac + c1) * frac + c0;
  }
}

/** Simple all-pass diffuser used inside the reverb topology. */
export class Allpass {
  constructor(maxSamples) {
    this.line = new DelayLine(maxSamples);
    this.delay = maxSamples * 0.5;
    this.g = 0.5;
  }

  process(x) {
    const d = this.line.read(this.delay);
    const v = x + -this.g * d;
    this.line.write(v);
    return d + this.g * v;
  }

  clear() {
    this.line.clear();
  }
}

/**
 * 4x oversampler for nonlinear stages.
 *
 * Zero-stuffed upsample -> 3-stage cascaded Butterworth lowpass at the original
 * Nyquist -> nonlinearity at 4x -> same filter -> decimate. This is what keeps
 * hard clipping and fold-back distortion from spraying aliases back down into the
 * audible band, which is the single biggest audible difference between a cheap
 * waveshaper and a professional one.
 */
export class Oversampler4x {
  constructor(sampleRate, blockSize) {
    this.factor = 4;
    this.sr = sampleRate;
    this.osr = sampleRate * 4;
    this.up = new Float32Array(blockSize * 4);
    // Butterworth cascade coefficients computed for cutoff = 0.5 * original nyquist ratio.
    this.upFilters = [makeLP(this.osr, sampleRate * 0.47), makeLP(this.osr, sampleRate * 0.47), makeLP(this.osr, sampleRate * 0.47)];
    this.downFilters = [makeLP(this.osr, sampleRate * 0.47), makeLP(this.osr, sampleRate * 0.47), makeLP(this.osr, sampleRate * 0.47)];
  }

  /**
   * @param input Float32Array block
   * @param frames number of frames
   * @param shaper (x)=>y nonlinearity applied at 4x rate
   * @param output Float32Array block (may alias input)
   */
  process(input, frames, shaper, output) {
    const up = this.up;
    const uf = this.upFilters;
    const df = this.downFilters;
    let k = 0;
    for (let i = 0; i < frames; i++) {
      // zero-stuff with gain compensation for the 4x insertion
      up[k++] = input[i] * 4;
      up[k++] = 0;
      up[k++] = 0;
      up[k++] = 0;
    }
    const n = frames * 4;
    for (let i = 0; i < n; i++) {
      let v = up[i];
      v = uf[0].process(v);
      v = uf[1].process(v);
      v = uf[2].process(v);
      v = shaper(v);
      v = df[0].process(v);
      v = df[1].process(v);
      v = df[2].process(v);
      up[i] = v;
    }
    for (let i = 0; i < frames; i++) output[i] = up[i * 4];
  }

  reset() {
    for (const f of this.upFilters) f.reset();
    for (const f of this.downFilters) f.reset();
  }
}

/** Minimal 2nd-order lowpass, standalone so the oversampler has no external deps. */
function makeLP(sr, cutoff) {
  const w0 = (2 * Math.PI * Math.min(cutoff, sr * 0.49)) / sr;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * 0.7071);
  const b0 = (1 - cw) * 0.5;
  const b1 = 1 - cw;
  const b2 = (1 - cw) * 0.5;
  const a0 = 1 + alpha;
  const a1 = -2 * cw;
  const a2 = 1 - alpha;
  const inv = 1 / a0;
  return {
    b0: b0 * inv,
    b1: b1 * inv,
    b2: b2 * inv,
    a1: a1 * inv,
    a2: a2 * inv,
    z1: 0,
    z2: 0,
    process(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = sanitize(this.b1 * x - this.a1 * y + this.z2);
      this.z2 = sanitize(this.b2 * x - this.a2 * y);
      return y;
    },
    reset() {
      this.z1 = 0;
      this.z2 = 0;
    },
  };
}
