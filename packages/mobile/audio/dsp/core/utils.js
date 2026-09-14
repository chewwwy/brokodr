'worklet';
/**
 * Bro.Kodr DSP core — math utilities.
 *
 * BACKEND-AGNOSTIC. Nothing in /dsp/core or /dsp/effects may reference AudioWorklet,
 * AudioContext, `sampleRate` globals, DOM, or Node. Everything takes explicit sample rate
 * and operates on Float32Array blocks so the same code can be compiled to WASM or linked
 * into a native (WASAPI/ASIO) host without modification. See /dsp/README.md.
 *
 * Audio-thread rules enforced throughout:
 *   - no allocation inside process()
 *   - no exceptions, no console, no branching on NaN
 *   - all parameter changes go through one-pole smoothers to avoid zipper noise
 */

export const TWO_PI = Math.PI * 2;

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function dbToGain(db) {
  return Math.pow(10, db * 0.05);
}

export function gainToDb(g) {
  return 20 * Math.log10(Math.max(g, 1e-9));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Denormal / NaN guard. Cheap enough to run per-sample on feedback paths. */
export function sanitize(x) {
  return x >= -1e30 && x <= 1e30 ? (Math.abs(x) < 1e-18 ? 0 : x) : 0;
}

/** Semitones -> frequency ratio. */
export function semitonesToRatio(st) {
  return Math.pow(2, st / 12);
}

/**
 * One-pole parameter smoother. Time constant in ms, exact per-sample coefficient.
 * Used for every user-facing parameter so knob moves never click.
 */
export class Smoother {
  constructor(sampleRate, ms, initial = 0) {
    this.sr = sampleRate;
    this.value = initial;
    this.target = initial;
    this.setTime(ms);
  }

  setTime(ms) {
    this.a = Math.exp(-1 / (Math.max(ms, 0.01) * 0.001 * this.sr));
  }

  set(target) {
    this.target = target;
  }

  /** Jump immediately — for engine reset / preset load, never during playback. */
  reset(v) {
    this.value = v;
    this.target = v;
  }

  next() {
    this.value = this.target + (this.value - this.target) * this.a;
    if (Math.abs(this.value - this.target) < 1e-9) this.value = this.target;
    return this.value;
  }

  /** True when the smoother has settled — lets effects skip coefficient recalculation. */
  get settled() {
    return this.value === this.target;
  }
}

/**
 * Envelope follower with independent attack/release, operating on |x| (peak) or x^2 (RMS).
 * Coefficients are standard analogue-style exponential time constants.
 */
export class EnvelopeFollower {
  constructor(sampleRate, attackMs = 10, releaseMs = 100, rms = false) {
    this.sr = sampleRate;
    this.rms = rms;
    this.env = 0;
    this.setAttack(attackMs);
    this.setRelease(releaseMs);
  }

  setAttack(ms) {
    this.ca = Math.exp(-1 / (Math.max(ms, 0.01) * 0.001 * this.sr));
  }

  setRelease(ms) {
    this.cr = Math.exp(-1 / (Math.max(ms, 0.01) * 0.001 * this.sr));
  }

  process(x) {
    const d = this.rms ? x * x : Math.abs(x);
    const c = d > this.env ? this.ca : this.cr;
    this.env = d + (this.env - d) * c;
    return this.rms ? Math.sqrt(this.env) : this.env;
  }

  reset() {
    this.env = 0;
  }
}

/** Multi-shape LFO. Phase is normalised 0..1 so tempo sync is a simple increment swap. */
export class LFO {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.phase = 0;
    this.inc = 0;
    this.shape = 0; // 0 sine 1 tri 2 saw 3 square 4 s&h
    this.rand = 0;
    this.lastQuad = 0;
  }

  setRate(hz) {
    this.inc = hz / this.sr;
  }

  setPhase(p) {
    this.phase = p - Math.floor(p);
  }

  next() {
    const p = this.phase;
    this.phase += this.inc;
    if (this.phase >= 1) {
      this.phase -= 1;
      if (this.shape === 4) this.rand = Math.random() * 2 - 1;
    }
    switch (this.shape) {
      case 1:
        return 4 * Math.abs(p - 0.5) - 1;
      case 2:
        return 2 * p - 1;
      case 3:
        return p < 0.5 ? 1 : -1;
      case 4:
        return this.rand;
      default:
        return Math.sin(TWO_PI * p);
    }
  }
}

/**
 * DC blocker — 1st order highpass at ~20Hz. Essential after any asymmetric waveshaper,
 * otherwise DC offset stacks through the chain and eats headroom.
 */
export class DCBlocker {
  constructor(sampleRate, hz = 20) {
    this.r = 1 - (TWO_PI * hz) / sampleRate;
    this.x1 = 0;
    this.y1 = 0;
  }

  process(x) {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = sanitize(y);
    return this.y1;
  }

  reset() {
    this.x1 = 0;
    this.y1 = 0;
  }
}

/**
 * Autocorrelation pitch tracker on a decimated signal. Used by the vocoder's
 * pitch-follow carrier and by pitch-snap. Runs on a coarse hop, not per-sample.
 */
export class PitchTracker {
  constructor(sampleRate, minHz = 60, maxHz = 900) {
    this.sr = sampleRate;
    this.decim = Math.max(1, Math.floor(sampleRate / 12000));
    this.dsr = sampleRate / this.decim;
    this.minLag = Math.floor(this.dsr / maxHz);
    this.maxLag = Math.floor(this.dsr / minHz);
    this.size = this.maxLag * 2;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.decimCount = 0;
    this.acc = 0;
    this.freq = 0;
    this.confidence = 0;
  }

  /** Feed every sample; internally decimates. */
  push(x) {
    this.acc += x;
    if (++this.decimCount < this.decim) return;
    this.buf[this.w] = this.acc / this.decim;
    this.w = (this.w + 1) % this.size;
    this.acc = 0;
    this.decimCount = 0;
  }

  /** Call once per block. Returns detected Hz (0 = unvoiced). */
  analyze() {
    const n = this.size;
    const b = this.buf;
    const w = this.w;
    let energy = 0;
    for (let i = 0; i < n; i++) energy += b[i] * b[i];
    if (energy < 1e-6) {
      this.confidence = 0;
      return 0;
    }
    let bestLag = 0;
    let best = 0;
    const half = this.maxLag;
    for (let lag = this.minLag; lag < this.maxLag; lag++) {
      let sum = 0;
      let norm = 0;
      for (let i = 0; i < half; i++) {
        const a = b[(w + n - half + i) % n];
        const c = b[(w + n - half - lag + i) % n];
        sum += a * c;
        norm += c * c;
      }
      const r = sum / Math.sqrt(norm * energy + 1e-12);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    this.confidence = best;
    if (best < 0.3 || bestLag === 0) {
      this.freq = 0;
      return 0;
    }
    this.freq = this.dsr / bestLag;
    return this.freq;
  }
}

/** Cheap band-limited-ish oscillator bank primitive for the vocoder carrier. */
export class Oscillator {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.phase = 0;
    this.inc = 0;
    this.pw = 0.5;
  }

  setFreq(hz) {
    this.inc = Math.max(0, hz) / this.sr;
  }

  /** PolyBLEP-corrected saw — no aliasing spray in the vocoder carrier. */
  saw() {
    let p = this.phase;
    this.phase += this.inc;
    if (this.phase >= 1) this.phase -= 1;
    let v = 2 * p - 1;
    v -= polyBlep(p, this.inc);
    return v;
  }

  pulse() {
    let p = this.phase;
    this.phase += this.inc;
    if (this.phase >= 1) this.phase -= 1;
    let v = p < this.pw ? 1 : -1;
    v += polyBlep(p, this.inc);
    let p2 = p - this.pw;
    if (p2 < 0) p2 += 1;
    v -= polyBlep(p2, this.inc);
    return v;
  }
}

export function polyBlep(t, dt) {
  if (dt <= 0) return 0;
  if (t < dt) {
    const x = t / dt - 1;
    return -x * x;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt + 1;
    return x * x;
  }
  return 0;
}

/** Pink noise — Paul Kellet's economical filter. Used by lo-fi/character modules. */
export class PinkNoise {
  constructor() {
    this.b = new Float32Array(7);
  }

  next() {
    const w = Math.random() * 2 - 1;
    const b = this.b;
    b[0] = 0.99886 * b[0] + w * 0.0555179;
    b[1] = 0.99332 * b[1] + w * 0.0750759;
    b[2] = 0.969 * b[2] + w * 0.153852;
    b[3] = 0.8665 * b[3] + w * 0.3104856;
    b[4] = 0.55 * b[4] + w * 0.5329522;
    b[5] = -0.7616 * b[5] - w * 0.016898;
    const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
    b[6] = w * 0.115926;
    return out * 0.11;
  }
}
