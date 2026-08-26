/**
 * Bro.Kodr — time-based effects: delay and reverb.
 */

import { Effect } from "./base.js";
import { Biquad, FilterType } from "../core/biquad.js";
import { DelayLine, Allpass } from "../core/delay-line.js";
import { Smoother, LFO, dbToGain, clamp, sanitize } from "../core/utils.js";

/**
 * Stereo delay with filtered feedback, ping-pong routing, modulation and tempo sync.
 *
 * The feedback loop contains a highpass and a lowpass, so repeats progressively lose
 * extremes like tape/BBD rather than accumulating mud and hiss. Modulation in the loop
 * stops long feedback from ringing into a static metallic tone.
 */
export class Delay extends Effect {
  static id = "delay";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    const maxSec = 4;
    this.lineL = new DelayLine(Math.ceil(sampleRate * maxSec));
    this.lineR = new DelayLine(Math.ceil(sampleRate * maxSec));
    this.timeL = new Smoother(sampleRate, 120, 0.25);
    this.timeR = new Smoother(sampleRate, 120, 0.25);
    this.feedback = 0.35;
    this.pingpong = 0;
    this.lpFreq = 6000;
    this.hpFreq = 180;
    this.lpL = new Biquad(sampleRate);
    this.lpR = new Biquad(sampleRate);
    this.hpL = new Biquad(sampleRate);
    this.hpR = new Biquad(sampleRate);
    this.fbL = 0;
    this.fbR = 0;
    this.lfo = new LFO(sampleRate);
    this.lfo.setRate(0.3);
    this.modDepth = 0;
    this.spread = 0;
    this.bpm = 120;
    this.syncDiv = 0; // 0 = free
    this.timeMs = 250;
    this.crossfeed = 0;
    this.saturate = 0;
  }

  #applyTime() {
    let ms = this.timeMs;
    if (this.syncDiv > 0) {
      // 1=1/1 2=1/2 3=1/4 4=1/8 5=1/16 6=1/4T 7=1/8T 8=1/8D 9=1/16D
      const beat = 60000 / this.bpm;
      const table = [0, beat * 4, beat * 2, beat, beat / 2, beat / 4, beat / 1.5, beat / 3, beat * 0.75, beat * 0.375];
      ms = table[clamp(this.syncDiv, 0, 9)];
    }
    const sec = clamp(ms, 1, 3900) * 0.001;
    this.timeL.set(sec);
    this.timeR.set(sec * (1 + this.spread * 0.5));
  }

  setParam(id, v) {
    switch (id) {
      case "time":
        this.timeMs = v;
        this.#applyTime();
        break;
      case "sync":
        this.syncDiv = Math.round(v);
        this.#applyTime();
        break;
      case "bpm":
        this.bpm = clamp(v, 20, 300);
        this.#applyTime();
        break;
      case "feedback":
        this.feedback = clamp(v, 0, 1.1);
        break;
      case "pingpong":
        this.pingpong = v >= 0.5 ? 1 : 0;
        break;
      case "lowpass":
        this.lpFreq = v;
        break;
      case "highpass":
        this.hpFreq = v;
        break;
      case "moddepth":
        this.modDepth = clamp(v, 0, 1);
        break;
      case "modrate":
        this.lfo.setRate(v);
        break;
      case "spread":
        this.spread = clamp(v, 0, 1);
        this.#applyTime();
        break;
      case "crossfeed":
        this.crossfeed = clamp(v, 0, 1);
        break;
      case "saturate":
        this.saturate = clamp(v, 0, 1);
        break;
    }
  }

  reset() {
    this.lineL.clear();
    this.lineR.clear();
    this.fbL = 0;
    this.fbR = 0;
    this.lpL.reset();
    this.lpR.reset();
    this.hpL.reset();
    this.hpR.reset();
  }

  process(L, R, frames) {
    this.lpL.set(FilterType.LOWPASS, this.lpFreq, 0.7071);
    this.lpR.set(FilterType.LOWPASS, this.lpFreq, 0.7071);
    this.hpL.set(FilterType.HIGHPASS, this.hpFreq, 0.7071);
    this.hpR.set(FilterType.HIGHPASS, this.hpFreq, 0.7071);
    const drive = 1 + this.saturate * 3;

    for (let i = 0; i < frames; i++) {
      const mod = this.lfo.next() * this.modDepth * 0.002 * this.sr;
      const dl = this.timeL.next() * this.sr + mod;
      const dr = this.timeR.next() * this.sr - mod;

      const inL = L[i];
      const inR = R[i];

      let wl = this.lineL.readCubic(clamp(dl, 1, this.lineL.size - 4));
      let wr = this.lineR.readCubic(clamp(dr, 1, this.lineR.size - 4));

      // Filter + optional tape-style soft saturation inside the loop.
      let fl = this.hpL.process(this.lpL.process(wl));
      let fr = this.hpR.process(this.lpR.process(wr));
      if (this.saturate > 0.001) {
        fl = Math.tanh(fl * drive) / drive;
        fr = Math.tanh(fr * drive) / drive;
      }

      if (this.pingpong) {
        this.lineL.write(sanitize(inL + inR * 0.5 + fr * this.feedback));
        this.lineR.write(sanitize(fl * this.feedback));
      } else {
        const xL = fl * (1 - this.crossfeed) + fr * this.crossfeed;
        const xR = fr * (1 - this.crossfeed) + fl * this.crossfeed;
        this.lineL.write(sanitize(inL + xL * this.feedback));
        this.lineR.write(sanitize(inR + xR * this.feedback));
      }

      L[i] = sanitize(wl);
      R[i] = sanitize(wr);
    }
  }
}

/**
 * Reverb — 8x8 Feedback Delay Network with Hadamard mixing.
 *
 * Chosen over a Schroeder comb+allpass bank because an FDN with an orthogonal mixing
 * matrix distributes energy evenly between all delay lines, producing a dense,
 * smooth, non-metallic tail with far fewer resonant modes. Damping is a one-pole
 * lowpass per line (frequency-dependent decay, like real air/absorption), plus a
 * pre-delay line and 4 input diffusion allpasses for early reflections.
 */
export class Reverb extends Effect {
  static id = "reverb";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    this.N = 8;
    // Mutually prime-ish delay lengths in ms, scaled by SIZE.
    this.baseMs = [23.7, 29.3, 37.1, 41.9, 47.3, 53.1, 59.7, 67.3];
    this.lines = [];
    this.damp = [];
    this.dampState = [];
    for (let i = 0; i < this.N; i++) {
      this.lines.push(new DelayLine(Math.ceil((this.baseMs[i] * 3.5 * sampleRate) / 1000) + 8));
      this.damp.push(0.3);
      this.dampState.push(0);
    }
    this.diffL = [
      new Allpass(Math.round(sampleRate * 0.0047)),
      new Allpass(Math.round(sampleRate * 0.0089)),
      new Allpass(Math.round(sampleRate * 0.0131)),
      new Allpass(Math.round(sampleRate * 0.0173)),
    ];
    this.diffR = [
      new Allpass(Math.round(sampleRate * 0.0051)),
      new Allpass(Math.round(sampleRate * 0.0093)),
      new Allpass(Math.round(sampleRate * 0.0137)),
      new Allpass(Math.round(sampleRate * 0.0181)),
    ];
    this.preL = new DelayLine(Math.ceil(sampleRate * 0.25) + 8);
    this.preR = new DelayLine(Math.ceil(sampleRate * 0.25) + 8);

    this.sizeSm = new Smoother(sampleRate, 200, 1);
    this.decaySm = new Smoother(sampleRate, 200, 0.75);
    this.dampSm = new Smoother(sampleRate, 100, 0.4);
    this.preDelaySm = new Smoother(sampleRate, 100, 0.02);
    this.widthAmt = 1;
    this.hpFreq = 120;
    this.hpL = new Biquad(sampleRate);
    this.hpR = new Biquad(sampleRate);
    this.modDepth = 0.15;
    this.lfos = [];
    for (let i = 0; i < this.N; i++) {
      const l = new LFO(sampleRate);
      l.setRate(0.11 + i * 0.037);
      l.setPhase(i / this.N);
      this.lfos.push(l);
    }
    this.tmp = new Float32Array(this.N);
    this.mix = new Float32Array(this.N);
    this.diffusion = 0.6;
  }

  setParam(id, v) {
    switch (id) {
      case "size":
        this.sizeSm.set(clamp(v, 0.2, 3));
        break;
      case "decay":
        this.decaySm.set(clamp(v, 0, 0.995));
        break;
      case "damping":
        this.dampSm.set(clamp(v, 0, 0.99));
        break;
      case "predelay":
        this.preDelaySm.set(clamp(v, 0, 200) * 0.001);
        break;
      case "width":
        this.widthAmt = clamp(v, 0, 1);
        break;
      case "highpass":
        this.hpFreq = v;
        break;
      case "modulation":
        this.modDepth = clamp(v, 0, 1);
        break;
      case "diffusion":
        this.diffusion = clamp(v, 0, 0.9);
        for (const a of this.diffL) a.g = this.diffusion;
        for (const a of this.diffR) a.g = this.diffusion;
        break;
    }
  }

  reset() {
    for (const l of this.lines) l.clear();
    for (const a of this.diffL) a.clear();
    for (const a of this.diffR) a.clear();
    this.preL.clear();
    this.preR.clear();
    this.dampState.fill(0);
    this.hpL.reset();
    this.hpR.reset();
  }

  /**
   * Normalised 8x8 Hadamard mix — lossless energy rotation between delay lines.
   * Implemented as a fast in-place butterfly (3 stages, 24 adds) instead of a
   * 64-multiply matrix product.
   */
  #hadamard(v) {
    for (let step = 1; step < 8; step <<= 1) {
      for (let i = 0; i < 8; i += step << 1) {
        for (let j = i; j < i + step; j++) {
          const a = v[j];
          const b = v[j + step];
          v[j] = a + b;
          v[j + step] = a - b;
        }
      }
    }
    const s = 1 / Math.sqrt(8);
    for (let i = 0; i < 8; i++) v[i] *= s;
  }

  process(L, R, frames) {
    this.hpL.set(FilterType.HIGHPASS, this.hpFreq, 0.7071);
    this.hpR.set(FilterType.HIGHPASS, this.hpFreq, 0.7071);
    const N = this.N;

    for (let i = 0; i < frames; i++) {
      const size = this.sizeSm.next();
      const decay = this.decaySm.next();
      const dampAmt = this.dampSm.next();
      const pre = this.preDelaySm.next() * this.sr;

      let inL = this.hpL.process(L[i]);
      let inR = this.hpR.process(R[i]);

      this.preL.write(inL);
      this.preR.write(inR);
      inL = this.preL.read(pre);
      inR = this.preR.read(pre);

      // Early reflections / input diffusion.
      let dl = inL;
      let dr = inR;
      for (let k = 0; k < 4; k++) {
        dl = this.diffL[k].process(dl);
        dr = this.diffR[k].process(dr);
      }

      // Read the network.
      const tmp = this.tmp;
      for (let k = 0; k < N; k++) {
        let d = (this.baseMs[k] * size * this.sr) / 1000;
        if (this.modDepth > 0.001) d += this.lfos[k].next() * this.modDepth * 0.0008 * this.sr;
        else this.lfos[k].next();
        let s = this.lines[k].readCubic(clamp(d, 2, this.lines[k].size - 4));
        // One-pole damping = frequency-dependent decay.
        this.dampState[k] = s + (this.dampState[k] - s) * dampAmt;
        tmp[k] = sanitize(this.dampState[k]);
      }

      // Output taps before mixing (alternating polarity for decorrelation).
      let outL = 0;
      let outR = 0;
      for (let k = 0; k < N; k++) {
        if (k % 2 === 0) outL += tmp[k];
        else outR += tmp[k];
      }
      outL *= 0.5;
      outR *= 0.5;

      // Rotate and feed back.
      this.#hadamard(tmp);
      for (let k = 0; k < N; k++) {
        const inj = k % 2 === 0 ? dl : dr;
        this.lines[k].write(sanitize(inj * 0.5 + tmp[k] * decay));
      }

      // Width: mid/side blend of the two output taps.
      const mid = (outL + outR) * 0.5;
      const side = (outL - outR) * 0.5 * this.widthAmt;
      L[i] = sanitize(mid + side);
      R[i] = sanitize(mid - side);
    }
  }
}
