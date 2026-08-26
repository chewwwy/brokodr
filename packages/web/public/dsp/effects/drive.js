/**
 * Bro.Kodr — drive stages: distortion, saturation, bit crusher.
 *
 * Distortion and saturation run their nonlinearity at 4x oversampled rate. Without
 * that, any hard-edged transfer curve folds aliases back into the audible band and
 * the result sounds like cheap digital fizz instead of a driven amplifier. This is
 * the single most important quality decision in the whole drive section.
 */

import { Effect } from "./base.js";
import { Smoother, dbToGain, clamp, sanitize, DCBlocker, PinkNoise } from "../core/utils.js";
import { Biquad, FilterType } from "../core/biquad.js";
import { Oversampler4x } from "../core/delay-line.js";

/** Transfer curves. All normalised so unity input stays near unity output. */
const SHAPERS = [
  // 0 — soft tube: asymmetric, even harmonics, gentle compression
  (x) => {
    const a = x >= 0 ? 1.2 : 0.85;
    const y = Math.tanh(x * a);
    return y * 0.92;
  },
  // 1 — hard clip
  (x) => clamp(x, -0.85, 0.85) * 1.12,
  // 2 — foldback: reflects instead of clipping, metallic
  (x) => {
    let y = x;
    const t = 0.8;
    while (Math.abs(y) > t) y = y > 0 ? 2 * t - y : -2 * t - y;
    return y * 1.15;
  },
  // 3 — diode/fuzz: strong even-order, gated feel
  (x) => {
    const y = x >= 0 ? 1 - Math.exp(-x * 2.2) : -(1 - Math.exp(x * 1.1)) * 0.7;
    return y * 1.1;
  },
  // 4 — sine fold: extreme, wavefolder character
  (x) => Math.sin(clamp(x, -3, 3) * 1.9) * 0.85,
  // 5 — bit-style rectify + clip: aggressive, industrial
  (x) => {
    const r = Math.abs(x) * 1.4 - 0.4;
    return clamp(x >= 0 ? r : -r * 0.8, -0.9, 0.9) * 1.1;
  },
];

class DriveBase extends Effect {
  constructor(sampleRate, maxBlock, defaultCurve) {
    super(sampleRate, maxBlock);
    this.drive = new Smoother(sampleRate, 25, 1);
    this.outSm = new Smoother(sampleRate, 25, 1);
    this.biasSm = new Smoother(sampleRate, 25, 0);
    this.curve = defaultCurve;
    this.toneFreq = 8000;
    this.toneMode = 0;
    this.os = [new Oversampler4x(sampleRate, maxBlock), new Oversampler4x(sampleRate, maxBlock)];
    this.dcL = new DCBlocker(sampleRate);
    this.dcR = new DCBlocker(sampleRate);
    this.toneL = new Biquad(sampleRate);
    this.toneR = new Biquad(sampleRate);
    this.preL = new Biquad(sampleRate);
    this.preR = new Biquad(sampleRate);
    this.preFreq = 20;
    this.oversample = 1;
    this.tmpL = new Float32Array(maxBlock);
    this.tmpR = new Float32Array(maxBlock);
    this.driveVal = 1;
    this.biasVal = 0;
    this.shaper = (x) => this.#shape(x);
  }

  #shape(x) {
    const d = this.driveVal;
    const b = this.biasVal;
    return SHAPERS[this.curve](x * d + b);
  }

  setParam(id, v) {
    switch (id) {
      case "drive":
        this.drive.set(dbToGain(v));
        break;
      case "curve":
        this.curve = clamp(Math.round(v), 0, SHAPERS.length - 1);
        break;
      case "tone":
        this.toneFreq = v;
        break;
      case "tonemode":
        this.toneMode = Math.round(v);
        break;
      case "bias":
        this.biasSm.set(v);
        break;
      case "prehp":
        this.preFreq = v;
        break;
      case "output":
        this.outSm.set(dbToGain(v));
        break;
      case "oversample":
        this.oversample = v >= 0.5 ? 1 : 0;
        break;
    }
  }

  reset() {
    for (const o of this.os) o.reset();
    this.dcL.reset();
    this.dcR.reset();
    this.toneL.reset();
    this.toneR.reset();
    this.preL.reset();
    this.preR.reset();
  }

  process(L, R, frames) {
    // Block-rate parameter snapshot: the shaper closure reads these.
    this.driveVal = this.drive.next();
    this.biasVal = this.biasSm.next();
    for (let i = 1; i < frames; i++) {
      this.drive.next();
      this.biasSm.next();
    }

    this.preL.set(FilterType.HIGHPASS, this.preFreq, 0.7071);
    this.preR.set(FilterType.HIGHPASS, this.preFreq, 0.7071);
    for (let i = 0; i < frames; i++) {
      this.tmpL[i] = this.preL.process(L[i]);
      this.tmpR[i] = this.preR.process(R[i]);
    }

    if (this.oversample) {
      this.os[0].process(this.tmpL, frames, this.shaper, L);
      this.os[1].process(this.tmpR, frames, this.shaper, R);
    } else {
      for (let i = 0; i < frames; i++) {
        L[i] = this.shaper(this.tmpL[i]);
        R[i] = this.shaper(this.tmpR[i]);
      }
    }

    const type = this.toneMode === 1 ? FilterType.HIGHPASS : FilterType.LOWPASS;
    this.toneL.set(type, this.toneFreq, 0.7071);
    this.toneR.set(type, this.toneFreq, 0.7071);

    let peak = 0;
    for (let i = 0; i < frames; i++) {
      const g = this.outSm.next();
      let l = this.toneL.process(this.dcL.process(L[i])) * g;
      let r = this.toneR.process(this.dcR.process(R[i])) * g;
      L[i] = sanitize(l);
      R[i] = sanitize(r);
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
    }
    this.meter = peak;
  }
}

/** Aggressive distortion — hard clip default, full curve selection. */
export class Distortion extends DriveBase {
  static id = "dist";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock, 1);
  }
}

/** Saturation — tube curve default, gentler drive range, for glue and warmth. */
export class Saturation extends DriveBase {
  static id = "sat";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock, 0);
  }
}

/**
 * Bit crusher — independent bit-depth quantisation and sample-rate decimation.
 *
 * Quantisation uses mid-tread rounding with optional TPDF dither (dither actually
 * matters here: without it, low-level material at 4-6 bits turns into correlated
 * distortion rather than noise). Decimation is true zero-order-hold sample & hold,
 * deliberately un-filtered — the aliasing IS the effect.
 */
export class BitCrusher extends Effect {
  static id = "crush";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    this.bits = 16;
    this.rateHz = sampleRate;
    this.ditherAmt = 0;
    this.driveSm = new Smoother(sampleRate, 25, 1);
    this.outSm = new Smoother(sampleRate, 25, 1);
    this.phase = 0;
    this.holdL = 0;
    this.holdR = 0;
    this.noise = new PinkNoise();
    this.antiAlias = 0;
    this.lpL = new Biquad(sampleRate);
    this.lpR = new Biquad(sampleRate);
  }

  setParam(id, v) {
    switch (id) {
      case "bits":
        this.bits = clamp(v, 1, 24);
        break;
      case "rate":
        this.rateHz = clamp(v, 200, this.sr);
        break;
      case "dither":
        this.ditherAmt = clamp(v, 0, 1);
        break;
      case "drive":
        this.driveSm.set(dbToGain(v));
        break;
      case "output":
        this.outSm.set(dbToGain(v));
        break;
      case "smooth":
        this.antiAlias = clamp(v, 0, 1);
        break;
    }
  }

  reset() {
    this.phase = 0;
    this.holdL = 0;
    this.holdR = 0;
    this.lpL.reset();
    this.lpR.reset();
  }

  process(L, R, frames) {
    const step = this.rateHz / this.sr;
    const levels = Math.pow(2, this.bits) - 1;
    const inv = 1 / levels;
    const ditherScale = (this.ditherAmt * inv) / 2;

    if (this.antiAlias > 0.001) {
      const f = 200 + (1 - this.antiAlias) * (this.sr * 0.45 - 200);
      this.lpL.set(FilterType.LOWPASS, Math.min(f, this.rateHz * 0.5), 0.7071);
      this.lpR.set(FilterType.LOWPASS, Math.min(f, this.rateHz * 0.5), 0.7071);
    }

    for (let i = 0; i < frames; i++) {
      const d = this.driveSm.next();
      const o = this.outSm.next();
      this.phase += step;
      if (this.phase >= 1) {
        this.phase -= Math.floor(this.phase);
        let l = clamp(L[i] * d, -1, 1);
        let r = clamp(R[i] * d, -1, 1);
        if (ditherScale > 0) {
          // TPDF dither = sum of two independent uniform sources.
          l += (Math.random() + Math.random() - 1) * ditherScale;
          r += (Math.random() + Math.random() - 1) * ditherScale;
        }
        this.holdL = Math.round(l * levels) * inv;
        this.holdR = Math.round(r * levels) * inv;
      }
      let ol = this.holdL * o;
      let or = this.holdR * o;
      if (this.antiAlias > 0.001) {
        ol = this.lpL.process(ol);
        or = this.lpR.process(or);
      }
      L[i] = sanitize(ol);
      R[i] = sanitize(or);
    }
  }
}
