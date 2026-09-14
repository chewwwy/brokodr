'worklet';
/**
 * Bro.Kodr — 6-band parametric EQ.
 *
 * Topology: HP (variable slope) -> low shelf -> 3 fully parametric peaks -> high shelf
 * -> LP (variable slope). Stereo, independent state per channel, shared coefficients.
 *
 * Coefficients are recalculated once per block from smoothed parameter values rather
 * than per-sample: a block is 128 frames (2.7ms @48k) so sweeps are smooth, and we
 * avoid ~40 transcendental calls per sample.
 */

import { Biquad, BiquadCascade, FilterType } from "../core/biquad.js";
import { Smoother, clamp } from "../core/utils.js";

const CURVE_POINTS = 160;

export class ParametricEQ {
  static id = "eq";

  constructor(sampleRate, maxBlock) {
    // Base class inlined for the mobile copy: Babel's _inherits helper reassigns
    // _setPrototypeOf, which is read-only once this class is compiled into a
    // worklet class factory. Effect only set these three fields.
    this.sr = sampleRate;
    this.maxBlock = maxBlock;
    this.meter = 0;

    this.p = {
      hpFreq: 20,
      hpSlope: 0,
      lsFreq: 120,
      lsGain: 0,
      b1Freq: 300,
      b1Gain: 0,
      b1Q: 0.9,
      b2Freq: 1200,
      b2Gain: 0,
      b2Q: 0.9,
      b3Freq: 4500,
      b3Gain: 0,
      b3Q: 0.9,
      hsFreq: 8000,
      hsGain: 0,
      lpFreq: 20000,
      lpSlope: 0,
      output: 0,
    };

    // Smoothers on the audible/continuous params (gains + output). Frequencies are
    // smoothed too so dragging a band node doesn't step.
    //
    // Coefficients are recomputed once per block, not per sample, so these smoothers
    // are clocked at the *control rate* (sampleRate / block), not the audio rate.
    // Handing them the audio rate would stretch a 30ms glide out to 30ms x blockSize
    // (~4 seconds at 128 frames) and the EQ would appear to barely respond.
    this.controlRate = sampleRate / Math.max(1, maxBlock || 128);
    this.sm = {};
    for (const k of Object.keys(this.p)) this.sm[k] = new Smoother(this.controlRate, 30, this.p[k]);

    this.outGain = new Smoother(sampleRate, 20, 1);

    // Two channels x filter set.
    this.ch = [];
    for (let c = 0; c < 2; c++) {
      this.ch.push({
        hp: new BiquadCascade(sampleRate, 4),
        ls: new Biquad(sampleRate),
        b1: new Biquad(sampleRate),
        b2: new Biquad(sampleRate),
        b3: new Biquad(sampleRate),
        hs: new Biquad(sampleRate),
        lp: new BiquadCascade(sampleRate, 4),
      });
    }

    this.visual = new Float32Array(CURVE_POINTS);
    this.visualDirty = true;
  }

  setParam(id, v) {
    if (!(id in this.p)) return;
    this.p[id] = v;
    this.sm[id].set(v);
    this.visualDirty = true;
  }

  reset() {
    for (const c of this.ch) {
      c.hp.reset();
      c.ls.reset();
      c.b1.reset();
      c.b2.reset();
      c.b3.reset();
      c.hs.reset();
      c.lp.reset();
    }
    for (const k of Object.keys(this.p)) this.sm[k].reset(this.p[k]);
  }

  _updateCoeffs() {
    const s = this.sm;
    // Advance smoothers by one block (block-rate coefficient update).
    const hpFreq = s.hpFreq.next();
    const lsFreq = s.lsFreq.next();
    const lsGain = s.lsGain.next();
    const b1Freq = s.b1Freq.next();
    const b1Gain = s.b1Gain.next();
    const b1Q = s.b1Q.next();
    const b2Freq = s.b2Freq.next();
    const b2Gain = s.b2Gain.next();
    const b2Q = s.b2Q.next();
    const b3Freq = s.b3Freq.next();
    const b3Gain = s.b3Gain.next();
    const b3Q = s.b3Q.next();
    const hsFreq = s.hsFreq.next();
    const hsGain = s.hsGain.next();
    const lpFreq = s.lpFreq.next();

    const hpStages = 1 + Math.round(clamp(this.p.hpSlope, 0, 3));
    const lpStages = 1 + Math.round(clamp(this.p.lpSlope, 0, 3));

    for (const c of this.ch) {
      c.hp.setActive(this.p.hpFreq <= 21 ? 0 : hpStages);
      c.hp.set(FilterType.HIGHPASS, hpFreq, 0.7071);
      c.ls.set(FilterType.LOWSHELF, lsFreq, 0.7071, lsGain);
      c.b1.set(FilterType.PEAK, b1Freq, b1Q, b1Gain);
      c.b2.set(FilterType.PEAK, b2Freq, b2Q, b2Gain);
      c.b3.set(FilterType.PEAK, b3Freq, b3Q, b3Gain);
      c.hs.set(FilterType.HIGHSHELF, hsFreq, 0.7071, hsGain);
      c.lp.setActive(this.p.lpFreq >= 19900 ? 0 : lpStages);
      c.lp.set(FilterType.LOWPASS, lpFreq, 0.7071);
    }

    this.outGain.set(Math.pow(10, s.output.next() * 0.05));
  }

  process(L, R, frames) {
    this._updateCoeffs();
    const a = this.ch[0];
    const b = this.ch[1];
    for (let i = 0; i < frames; i++) {
      const g = this.outGain.next();
      let l = L[i];
      l = a.hp.process(l);
      l = a.ls.process(l);
      l = a.b1.process(l);
      l = a.b2.process(l);
      l = a.b3.process(l);
      l = a.hs.process(l);
      l = a.lp.process(l);
      L[i] = l * g;

      let r = R[i];
      r = b.hp.process(r);
      r = b.ls.process(r);
      r = b.b1.process(r);
      r = b.b2.process(r);
      r = b.b3.process(r);
      r = b.hs.process(r);
      r = b.lp.process(r);
      R[i] = r * g;
    }
    if (this.visualDirty) this._renderCurve();
  }

  /** Composite magnitude response, 20Hz..20kHz log-spaced, in dB — for the curve display. */
  _renderCurve() {
    const c = this.ch[0];
    const lo = Math.log10(20);
    const hi = Math.log10(20000);
    for (let i = 0; i < CURVE_POINTS; i++) {
      const f = Math.pow(10, lo + ((hi - lo) * i) / (CURVE_POINTS - 1));
      let db = 0;
      db += c.hp.magnitudeDb(f);
      db += c.ls.magnitudeDb(f);
      db += c.b1.magnitudeDb(f);
      db += c.b2.magnitudeDb(f);
      db += c.b3.magnitudeDb(f);
      db += c.hs.magnitudeDb(f);
      db += c.lp.magnitudeDb(f);
      this.visual[i] = db + this.p.output;
    }
    this.visualDirty = false;
  }
}
