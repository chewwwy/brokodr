/**
 * Bro.Kodr — voice character and destruction modules.
 *
 * CHARACTER is the "instant transformation" module: a curated combination of
 * bandwidth restriction, resonance, drive, noise and artefacts that reproduces the
 * recognisable media colourations (telephone, AM radio, megaphone, walkie-talkie,
 * cassette, vinyl, intercom). Each mode is a real filter/nonlinearity configuration,
 * not a preset name on a generic filter.
 */

import { Effect } from "./base.js";
import { Biquad, BiquadCascade, FilterType } from "../core/biquad.js";
import { DelayLine } from "../core/delay-line.js";
import {
  Smoother,
  EnvelopeFollower,
  LFO,
  PinkNoise,
  dbToGain,
  gainToDb,
  clamp,
  sanitize,
} from "../core/utils.js";

/**
 * Mode table. Each entry describes a real signal configuration:
 *  hp/lp    — passband edges (Hz)
 *  res      — resonant peak (freq, dB, Q) that gives the mode its vowel-like colour
 *  drive    — pre-gain into a tanh/clip stage
 *  curve    — 0 tanh, 1 hard clip, 2 rectify
 *  noise    — broadband noise floor level
 *  crackle  — impulse crackle density (vinyl/AM)
 *  wobble   — pitch/time wobble depth (cassette)
 *  squelch  — noise gate + carrier squelch behaviour (walkie-talkie)
 */
const MODES = [
  { name: "telephone", hp: 300, lp: 3400, res: [1200, 6, 1.2], drive: 3, curve: 0, noise: 0.0006, crackle: 0, wobble: 0, squelch: 0 },
  { name: "am-radio", hp: 180, lp: 4500, res: [900, 4, 0.9], drive: 4, curve: 0, noise: 0.004, crackle: 0.15, wobble: 0.05, squelch: 0 },
  { name: "megaphone", hp: 500, lp: 4000, res: [1800, 11, 2.2], drive: 9, curve: 1, noise: 0.0004, crackle: 0, wobble: 0, squelch: 0 },
  { name: "walkie", hp: 400, lp: 3000, res: [1500, 8, 1.6], drive: 7, curve: 1, noise: 0.006, crackle: 0.05, wobble: 0, squelch: 1 },
  { name: "cassette", hp: 60, lp: 8500, res: [4000, -3, 0.7], drive: 2, curve: 0, noise: 0.0025, crackle: 0.02, wobble: 0.5, squelch: 0 },
  { name: "vinyl", hp: 80, lp: 9500, res: [3000, 2, 0.8], drive: 1.6, curve: 0, noise: 0.002, crackle: 0.5, wobble: 0.12, squelch: 0 },
  { name: "intercom", hp: 350, lp: 2800, res: [1100, 9, 2.6], drive: 5, curve: 2, noise: 0.003, crackle: 0, wobble: 0, squelch: 0 },
  { name: "lofi-tape", hp: 120, lp: 5500, res: [700, 3, 0.6], drive: 3.5, curve: 0, noise: 0.005, crackle: 0.08, wobble: 0.8, squelch: 0 },
];

export class Character extends Effect {
  static id = "character";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    this.mode = 0;
    this.amount = 1;
    this.driveTrim = 0;
    this.noiseTrim = 1;
    this.wobbleTrim = 1;

    this.hp = [new BiquadCascade(sampleRate, 2), new BiquadCascade(sampleRate, 2)];
    this.lp = [new BiquadCascade(sampleRate, 2), new BiquadCascade(sampleRate, 2)];
    this.res = [new Biquad(sampleRate), new Biquad(sampleRate)];
    this.noise = new PinkNoise();
    this.wobbleLfo = new LFO(sampleRate);
    this.wobbleLfo.setRate(0.7);
    this.flutterLfo = new LFO(sampleRate);
    this.flutterLfo.setRate(6.3);
    this.wobbleLine = [new DelayLine(Math.ceil(sampleRate * 0.02)), new DelayLine(Math.ceil(sampleRate * 0.02))];
    this.gateEnv = new EnvelopeFollower(sampleRate, 2, 60, false);
    this.squelchSm = new Smoother(sampleRate, 12, 1);
    this.outSm = new Smoother(sampleRate, 20, 1);
    this.crackleState = 0;
  }

  setParam(id, v) {
    switch (id) {
      case "mode":
        this.mode = clamp(Math.round(v), 0, MODES.length - 1);
        break;
      case "amount":
        this.amount = clamp(v, 0, 1);
        break;
      case "drive":
        this.driveTrim = v;
        break;
      case "noise":
        this.noiseTrim = clamp(v, 0, 4);
        break;
      case "wobble":
        this.wobbleTrim = clamp(v, 0, 2);
        break;
      case "output":
        this.outSm.set(dbToGain(v));
        break;
    }
  }

  reset() {
    for (let c = 0; c < 2; c++) {
      this.hp[c].reset();
      this.lp[c].reset();
      this.res[c].reset();
      this.wobbleLine[c].clear();
    }
    this.gateEnv.reset();
  }

  process(L, R, frames) {
    const m = MODES[this.mode];
    const a = this.amount;

    // Interpolate the mode's filter edges toward bypass as AMOUNT falls, so the
    // control is a genuine blend of the transformation rather than a volume fade.
    const hpF = 20 + (m.hp - 20) * a;
    const lpF = 20000 - (20000 - m.lp) * a;
    for (let c = 0; c < 2; c++) {
      this.hp[c].set(FilterType.HIGHPASS, hpF, 0.7071);
      this.lp[c].set(FilterType.LOWPASS, lpF, 0.7071);
      this.res[c].set(FilterType.PEAK, m.res[0], m.res[2], m.res[1] * a);
    }

    const drive = 1 + (m.drive - 1) * a * dbToGain(this.driveTrim);
    const noiseLvl = m.noise * a * this.noiseTrim;
    const crackleP = m.crackle * a * 0.0008;
    const wobDepth = m.wobble * a * this.wobbleTrim * 0.0012 * this.sr;

    for (let i = 0; i < frames; i++) {
      const wob = wobDepth > 0.001 ? (this.wobbleLfo.next() * 0.7 + this.flutterLfo.next() * 0.3) * wobDepth : 0;
      if (wobDepth <= 0.001) {
        this.wobbleLfo.next();
        this.flutterLfo.next();
      }

      let out = [0, 0];
      for (let c = 0; c < 2; c++) {
        const buf = c === 0 ? L : R;
        let x = buf[i];

        // wow & flutter via modulated delay
        if (wobDepth > 0.001) {
          this.wobbleLine[c].write(x);
          x = this.wobbleLine[c].readCubic(clamp(wobDepth + wob + 8, 2, this.wobbleLine[c].size - 4));
        }

        x = this.hp[c].process(x);
        x = this.res[c].process(x);

        // nonlinearity
        const d = x * drive;
        if (m.curve === 1) x = clamp(d, -0.8, 0.8) * 1.2;
        else if (m.curve === 2) x = (Math.abs(d) * 1.2 - 0.3) * Math.sign(d);
        else x = Math.tanh(d);
        x /= Math.max(1, drive * 0.5);

        x = this.lp[c].process(x);
        out[c] = x;
      }

      // Artefacts: broadband noise floor + impulsive crackle.
      let art = 0;
      if (noiseLvl > 0) art += this.noise.next() * noiseLvl * 20;
      if (crackleP > 0 && Math.random() < crackleP) this.crackleState = (Math.random() * 2 - 1) * 0.4 * a;
      this.crackleState *= 0.72;
      art += this.crackleState;

      // Walkie-talkie squelch: gate the whole thing, and let noise through only
      // when the gate is open, exactly like a real carrier-operated squelch.
      let sq = 1;
      if (m.squelch) {
        const lvl = this.gateEnv.process(Math.max(Math.abs(L[i]), Math.abs(R[i])));
        this.squelchSm.set(gainToDb(lvl) > -42 ? 1 : 0);
        sq = this.squelchSm.next();
      }

      const g = this.outSm.next();
      L[i] = sanitize((out[0] + art) * sq * g);
      R[i] = sanitize((out[1] + art) * sq * g);
    }
  }
}

/**
 * Glitch / stutter — tempo-synced buffer capture and replay.
 *
 * Continuously records into a loop buffer; when triggered (by rate divisions, or
 * randomly at the given probability) it freezes and replays a slice with optional
 * reverse, pitch, and repeat count. Crossfaded at slice boundaries to avoid clicks,
 * which is the difference between a musical stutter and a broken one.
 */
export class Glitch extends Effect {
  static id = "glitch";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    this.bufSize = Math.ceil(sampleRate * 2);
    this.bufL = new Float32Array(this.bufSize);
    this.bufR = new Float32Array(this.bufSize);
    this.w = 0;
    this.bpm = 120;
    this.division = 4; // slices per beat
    this.probability = 0.35;
    this.reverse = 0;
    this.pitchRatio = 1;
    this.repeats = 2;
    this.mixAmt = 1;
    this.xfade = Math.round(sampleRate * 0.003);

    this.slicePos = 0;
    this.sliceLen = Math.round(sampleRate * 0.125);
    this.active = false;
    this.sliceStart = 0;
    this.repeatCount = 0;
    this.readPos = 0;
    this.counter = 0;
    this.freeze = 0;
  }

  setParam(id, v) {
    switch (id) {
      case "bpm":
        this.bpm = clamp(v, 20, 300);
        break;
      case "division":
        this.division = clamp(Math.round(v), 1, 16);
        break;
      case "probability":
        this.probability = clamp(v, 0, 1);
        break;
      case "reverse":
        this.reverse = clamp(v, 0, 1);
        break;
      case "pitch":
        this.pitchRatio = Math.pow(2, clamp(v, -24, 24) / 12);
        break;
      case "repeats":
        this.repeats = clamp(Math.round(v), 1, 16);
        break;
      case "freeze":
        this.freeze = v >= 0.5 ? 1 : 0;
        break;
    }
  }

  reset() {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.w = 0;
    this.active = false;
    this.counter = 0;
  }

  process(L, R, frames) {
    const beatSamples = (60 / this.bpm) * this.sr;
    this.sliceLen = Math.max(64, Math.round(beatSamples / this.division));

    for (let i = 0; i < frames; i++) {
      // Always keep recording unless frozen.
      if (!this.freeze || !this.active) {
        this.bufL[this.w] = L[i];
        this.bufR[this.w] = R[i];
        this.w = (this.w + 1) % this.bufSize;
      }

      // Slice clock.
      if (++this.counter >= this.sliceLen) {
        this.counter = 0;
        if (this.active) {
          if (++this.repeatCount >= this.repeats) {
            this.active = false;
          } else {
            this.readPos = 0;
          }
        } else if (this.freeze || Math.random() < this.probability) {
          this.active = true;
          this.repeatCount = 0;
          this.readPos = 0;
          this.sliceStart = (this.w - this.sliceLen + this.bufSize) % this.bufSize;
        }
      }

      if (this.active) {
        const rev = this.reverse > 0.5;
        const p = rev ? this.sliceLen - 1 - this.readPos * this.pitchRatio : this.readPos * this.pitchRatio;
        const idx = (this.sliceStart + Math.floor(p) + this.bufSize) % this.bufSize;
        const idx2 = (idx + 1) % this.bufSize;
        const frac = p - Math.floor(p);
        let sl = this.bufL[idx] + (this.bufL[idx2] - this.bufL[idx]) * frac;
        let sr = this.bufR[idx] + (this.bufR[idx2] - this.bufR[idx]) * frac;

        // Boundary crossfade.
        const fadeIn = Math.min(1, this.readPos / this.xfade);
        const remain = this.sliceLen - this.readPos;
        const fadeOut = Math.min(1, remain / this.xfade);
        const env = Math.min(fadeIn, fadeOut);

        L[i] = sanitize(sl * env);
        R[i] = sanitize(sr * env);
        this.readPos++;
        if (this.readPos * this.pitchRatio >= this.sliceLen) this.readPos = 0;
      }
    }
    this.meter = this.active ? 1 : 0;
  }
}

/** Noise generator / bed — white, pink, brown, plus a level-following mode for texture. */
export class NoiseGen extends Effect {
  static id = "noise";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    this.type = 1;
    this.levelSm = new Smoother(sampleRate, 30, 0);
    this.pink = new PinkNoise();
    this.brown = 0;
    this.follow = 0;
    this.env = new EnvelopeFollower(sampleRate, 5, 80, false);
    this.lp = [new Biquad(sampleRate), new Biquad(sampleRate)];
    this.lpFreq = 20000;
  }

  setParam(id, v) {
    switch (id) {
      case "type":
        this.type = clamp(Math.round(v), 0, 2);
        break;
      case "level":
        this.levelSm.set(dbToGain(v) * (v <= -60 ? 0 : 1));
        break;
      case "follow":
        this.follow = clamp(v, 0, 1);
        break;
      case "tone":
        this.lpFreq = v;
        break;
    }
  }

  process(L, R, frames) {
    for (const f of this.lp) f.set(FilterType.LOWPASS, this.lpFreq, 0.7071);
    for (let i = 0; i < frames; i++) {
      const lvl = this.levelSm.next();
      let n;
      if (this.type === 0) n = Math.random() * 2 - 1;
      else if (this.type === 1) n = this.pink.next();
      else {
        this.brown = clamp(this.brown + (Math.random() * 2 - 1) * 0.02, -1, 1);
        n = this.brown * 3;
      }
      let g = lvl;
      if (this.follow > 0.001) {
        const e = this.env.process(Math.max(Math.abs(L[i]), Math.abs(R[i])));
        g = lvl * (1 - this.follow + this.follow * Math.min(1, e * 4));
      }
      L[i] = sanitize(L[i] + this.lp[0].process(n) * g);
      R[i] = sanitize(R[i] + this.lp[1].process(n) * g);
    }
  }
}
