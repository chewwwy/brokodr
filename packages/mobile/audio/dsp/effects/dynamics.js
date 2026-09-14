'worklet';
/**
 * Bro.Kodr — dynamics: compressor, limiter, gate, transient shaper.
 *
 * All detectors run in the log (dB) domain with a soft-knee quadratic interpolation,
 * which is the behaviour engineers expect from a professional compressor and avoids
 * the harsh corner of a naive linear-domain threshold.
 */

import { Smoother, EnvelopeFollower, dbToGain, gainToDb, clamp, sanitize } from "../core/utils.js";
import { Biquad, FilterType } from "../core/biquad.js";
import { DelayLine } from "../core/delay-line.js";

/**
 * Feed-forward stereo compressor, linked detection (max of channels) so stereo
 * image doesn't wander. Peak/RMS switchable, auto-makeup optional.
 */
export class Compressor {
  static id = "comp";

  constructor(sampleRate, maxBlock) {
    // Base class inlined for the mobile copy: Babel's _inherits helper reassigns
    // _setPrototypeOf, which is read-only once this class is compiled into a
    // worklet class factory. Effect only set these three fields.
    this.sr = sampleRate;
    this.maxBlock = maxBlock;
    this.meter = 0;
    this.threshold = -18;
    this.ratio = 4;
    this.knee = 6;
    this.makeup = 0;
    this.rmsMode = 0;
    this.lookaheadMs = 0;

    this.attack = new Smoother(sampleRate, 5, 10);
    this.release = new Smoother(sampleRate, 5, 120);
    this.mkGain = new Smoother(sampleRate, 20, 1);

    this.envDb = 0;
    this.gainDb = 0;
    this.aCoef = 0;
    this.rCoef = 0;
    this.rms = new EnvelopeFollower(sampleRate, 5, 5, true);

    const maxLA = Math.ceil(sampleRate * 0.01) + 8;
    this.laL = new DelayLine(maxLA);
    this.laR = new DelayLine(maxLA);

    this._recalc(10, 120);
  }

  _recalc(atkMs, relMs) {
    this.aCoef = Math.exp(-1 / (Math.max(atkMs, 0.05) * 0.001 * this.sr));
    this.rCoef = Math.exp(-1 / (Math.max(relMs, 1) * 0.001 * this.sr));
  }

  setParam(id, v) {
    switch (id) {
      case "threshold":
        this.threshold = v;
        break;
      case "ratio":
        this.ratio = Math.max(1, v);
        break;
      case "attack":
        this.attack.set(v);
        break;
      case "release":
        this.release.set(v);
        break;
      case "knee":
        this.knee = Math.max(0, v);
        break;
      case "makeup":
        this.makeup = v;
        this.mkGain.set(dbToGain(v));
        break;
      case "detector":
        this.rmsMode = v >= 0.5 ? 1 : 0;
        break;
      case "lookahead":
        this.lookaheadMs = clamp(v, 0, 10);
        break;
    }
  }

  reset() {
    this.envDb = -120;
    this.gainDb = 0;
    this.laL.clear();
    this.laR.clear();
    this.rms.reset();
  }

  /** Static gain-computer curve with soft knee, returns output dB for input dB. */
  _curve(x) {
    const t = this.threshold;
    const w = this.knee;
    const r = this.ratio;
    if (w > 0 && x > t - w / 2 && x < t + w / 2) {
      const d = x - t + w / 2;
      return x + ((1 / r - 1) * d * d) / (2 * w);
    }
    if (x >= t + w / 2) return t + (x - t) / r;
    return x;
  }

  process(L, R, frames) {
    this._recalc(this.attack.next(), this.release.next());
    const laSamples = (this.lookaheadMs * 0.001 * this.sr) | 0;
    let maxGr = 0;

    for (let i = 0; i < frames; i++) {
      const l = L[i];
      const r = R[i];

      let det;
      if (this.rmsMode) {
        det = this.rms.process((Math.abs(l) + Math.abs(r)) * 0.5);
      } else {
        det = Math.max(Math.abs(l), Math.abs(r));
      }
      const inDb = gainToDb(det);

      // Envelope in dB with attack/release ballistics.
      const c = inDb > this.envDb ? this.aCoef : this.rCoef;
      this.envDb = inDb + (this.envDb - inDb) * c;

      const target = this._curve(this.envDb) - this.envDb;
      this.gainDb = target;
      const g = dbToGain(this.gainDb);
      if (-this.gainDb > maxGr) maxGr = -this.gainDb;

      const mk = this.mkGain.next();

      if (laSamples > 0) {
        this.laL.write(l);
        this.laR.write(r);
        L[i] = this.laL.read(laSamples) * g * mk;
        R[i] = this.laR.read(laSamples) * g * mk;
      } else {
        L[i] = l * g * mk;
        R[i] = r * g * mk;
      }
    }
    this.meter = maxGr;
  }
}

/**
 * Lookahead brickwall limiter. True-peak-ish: detects on the delayed signal with a
 * 1.5ms lookahead window, holds the maximum over the window, and applies a smoothed
 * gain so it clamps without the pumping of an instant-attack compressor.
 */
export class Limiter {
  static id = "limiter";

  constructor(sampleRate, maxBlock) {
    // Base class inlined for the mobile copy: Babel's _inherits helper reassigns
    // _setPrototypeOf, which is read-only once this class is compiled into a
    // worklet class factory. Effect only set these three fields.
    this.sr = sampleRate;
    this.maxBlock = maxBlock;
    this.meter = 0;
    this.ceilingDb = -0.3;
    this.releaseMs = 80;
    this.gainDb = 0;

    this.lookahead = Math.max(8, Math.round(sampleRate * 0.0015));
    this.dl = new DelayLine(this.lookahead + 8);
    this.dr = new DelayLine(this.lookahead + 8);

    // Sliding-maximum ring for the lookahead window.
    this.win = new Float32Array(this.lookahead);
    this.wi = 0;

    this.env = 0;
    this.rCoef = Math.exp(-1 / (0.08 * sampleRate));
    this.aCoef = Math.exp(-1 / (0.0005 * sampleRate));
  }

  setParam(id, v) {
    if (id === "ceiling") this.ceilingDb = v;
    else if (id === "release") {
      this.releaseMs = Math.max(5, v);
      this.rCoef = Math.exp(-1 / (this.releaseMs * 0.001 * this.sr));
    }
  }

  reset() {
    this.dl.clear();
    this.dr.clear();
    this.win.fill(0);
    this.env = 0;
    this.gainDb = 0;
  }

  process(L, R, frames) {
    const ceil = dbToGain(this.ceilingDb);
    let maxGr = 0;
    const n = this.lookahead;

    for (let i = 0; i < frames; i++) {
      const l = L[i];
      const r = R[i];
      this.dl.write(l);
      this.dr.write(r);

      this.win[this.wi] = Math.max(Math.abs(l), Math.abs(r));
      this.wi = (this.wi + 1) % n;

      let peak = 0;
      for (let k = 0; k < n; k++) if (this.win[k] > peak) peak = this.win[k];

      const need = peak > ceil ? ceil / peak : 1;
      const c = need < this.env || this.env === 0 ? this.aCoef : this.rCoef;
      this.env = need + (this.env - need) * c;
      const g = Math.min(1, this.env);
      const grDb = -gainToDb(g);
      if (grDb > maxGr) maxGr = grDb;

      let ol = this.dl.read(n) * g;
      let or = this.dr.read(n) * g;
      // Final hard safety clamp — the limiter is the last line of defence.
      L[i] = clamp(ol, -ceil, ceil);
      R[i] = clamp(or, -ceil, ceil);
    }
    this.meter = maxGr;
  }
}

/** Noise gate with hysteresis, hold and range — plus a sidechain highpass so LF rumble doesn't hold it open. */
export class Gate {
  static id = "gate";

  constructor(sampleRate, maxBlock) {
    // Base class inlined for the mobile copy: Babel's _inherits helper reassigns
    // _setPrototypeOf, which is read-only once this class is compiled into a
    // worklet class factory. Effect only set these three fields.
    this.sr = sampleRate;
    this.maxBlock = maxBlock;
    this.meter = 0;
    this.thresholdDb = -45;
    this.rangeDb = -60;
    this.holdMs = 40;
    this.hysteresisDb = 4;
    this.scHpFreq = 80;

    this.env = new EnvelopeFollower(sampleRate, 1, 30, false);
    this.hpL = new Biquad(sampleRate);
    this.hpR = new Biquad(sampleRate);
    this.gainSm = new Smoother(sampleRate, 8, 0);
    this.open = false;
    this.holdCounter = 0;
    this.attackMs = 1;
    this.releaseMs = 120;
  }

  setParam(id, v) {
    switch (id) {
      case "threshold":
        this.thresholdDb = v;
        break;
      case "range":
        this.rangeDb = v;
        break;
      case "attack":
        this.attackMs = v;
        this.env.setAttack(v);
        this.gainSm.setTime(Math.max(0.5, v));
        break;
      case "release":
        this.releaseMs = v;
        this.env.setRelease(v);
        break;
      case "hold":
        this.holdMs = v;
        break;
      case "hysteresis":
        this.hysteresisDb = v;
        break;
      case "scfreq":
        this.scHpFreq = v;
        break;
    }
  }

  reset() {
    this.env.reset();
    this.hpL.reset();
    this.hpR.reset();
    this.gainSm.reset(0);
    this.open = false;
    this.holdCounter = 0;
  }

  process(L, R, frames) {
    this.hpL.set(FilterType.HIGHPASS, this.scHpFreq, 0.7071);
    this.hpR.set(FilterType.HIGHPASS, this.scHpFreq, 0.7071);
    const holdSamples = (this.holdMs * 0.001 * this.sr) | 0;
    const openDb = this.thresholdDb;
    const closeDb = this.thresholdDb - this.hysteresisDb;
    const floor = dbToGain(this.rangeDb);
    let grMax = 0;

    for (let i = 0; i < frames; i++) {
      const sc = Math.max(Math.abs(this.hpL.process(L[i])), Math.abs(this.hpR.process(R[i])));
      const db = gainToDb(this.env.process(sc));

      if (db > openDb) {
        this.open = true;
        this.holdCounter = holdSamples;
      } else if (db < closeDb) {
        if (this.holdCounter > 0) this.holdCounter--;
        else this.open = false;
      }

      this.gainSm.set(this.open ? 1 : floor);
      const g = this.gainSm.next();
      const gr = -gainToDb(g);
      if (gr > grMax) grMax = gr;
      L[i] *= g;
      R[i] *= g;
    }
    this.meter = grMax;
  }
}

/**
 * Transient shaper. Two envelope followers with different attack times; their
 * difference isolates the transient (fast rises) from the body (sustain), letting
 * you boost or soften attack and sustain independently — level-independent, unlike
 * a compressor.
 */
export class TransientShaper {
  static id = "transient";

  constructor(sampleRate, maxBlock) {
    // Base class inlined for the mobile copy: Babel's _inherits helper reassigns
    // _setPrototypeOf, which is read-only once this class is compiled into a
    // worklet class factory. Effect only set these three fields.
    this.sr = sampleRate;
    this.maxBlock = maxBlock;
    this.meter = 0;
    this.attackAmt = 0;
    this.sustainAmt = 0;
    this.fast = new EnvelopeFollower(sampleRate, 0.5, 25, false);
    this.slow = new EnvelopeFollower(sampleRate, 12, 200, false);
    this.gainSm = new Smoother(sampleRate, 2, 1);
  }

  setParam(id, v) {
    if (id === "attack") this.attackAmt = v;
    else if (id === "sustain") this.sustainAmt = v;
    else if (id === "speed") {
      this.fast.setAttack(Math.max(0.2, v * 0.3));
      this.slow.setAttack(Math.max(4, v * 4));
    }
  }

  reset() {
    this.fast.reset();
    this.slow.reset();
    this.gainSm.reset(1);
  }

  process(L, R, frames) {
    let peakGain = 0;
    for (let i = 0; i < frames; i++) {
      const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      const f = this.fast.process(x);
      const s = this.slow.process(x);
      const diff = gainToDb(f + 1e-9) - gainToDb(s + 1e-9);
      // diff > 0 -> transient region, diff < 0 -> decay region
      const transient = clamp(diff / 6, 0, 1);
      const sustain = clamp(-diff / 6, 0, 1);
      const db = this.attackAmt * transient + this.sustainAmt * sustain;
      this.gainSm.set(dbToGain(db));
      const g = this.gainSm.next();
      if (Math.abs(db) > peakGain) peakGain = Math.abs(db);
      L[i] = sanitize(L[i] * g);
      R[i] = sanitize(R[i] * g);
    }
    this.meter = peakGain;
  }
}
