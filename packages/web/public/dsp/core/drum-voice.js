/**
 * Bro.Kodr — BROBEATS drum voice (backend-agnostic).
 *
 * One pad. Plays a buffer — synthesised by `drum-synth.js` or dropped in by the user,
 * the voice cannot tell the difference — through an ADSR, a resampler and a pan stage.
 *
 * The ADSR is the answer to "pull some long bass and short". Same 808 sample: short
 * release turns it into a tick, long release lets it boom through the next bar. That is
 * one knob doing what would otherwise be two different samples.
 *
 * Trigger modes, both needed:
 *   GATE    — note-off when the pad/key is released. Natural for playing by hand.
 *   ONESHOT — no note-off exists (a beatbox hit is an event, not a held key), so an
 *             optional `hold` time auto-releases. hold = 0 means play the sample out.
 *
 * Real-time discipline: zero allocation in process(), no exceptions, no console.
 * Every buffer is allocated in the constructor or on an explicit control command.
 *
 * No `#private`, no `extends` — both break the React Native worklet compiler used by
 * the Android build.
 */

import { clamp, dbToGain, sanitize, semitonesToRatio, Smoother } from "./utils.js";

/** Envelope stages. */
const ENV = { IDLE: 0, ATTACK: 1, DECAY: 2, SUSTAIN: 3, RELEASE: 4 };

/** Trigger modes. */
export const TRIGGER_MODE = { GATE: 0, ONESHOT: 1 };

/** Round-robin layers per pad. Four is enough to kill the machine-gun effect. */
export const MAX_LAYERS = 4;

/** Choke fade, in ms. Long enough not to click, short enough to read as instant. */
const CHOKE_MS = 4;

export class DrumVoice {
  constructor(sampleRate, maxBlock) {
    this.sr = sampleRate;
    this.maxBlock = maxBlock;

    /** @type {Array<{data: Float32Array|null, frames: number, rate: number}>} */
    this.layers = [];
    for (let i = 0; i < MAX_LAYERS; i++) this.layers.push({ data: null, frames: 0, rate: sampleRate });
    this.layerCount = 0;
    this.nextLayer = 0;

    // --- params (all set through setParam) ---
    this.attackMs = 0.5;
    this.decayMs = 400;
    this.sustain = 1;
    this.releaseMs = 60;
    this.holdMs = 0;
    this.pitch = 0;
    this.startOffset = 0;
    this.reverse = false;
    this.gain = 1;
    this.pan = 0;
    this.mode = TRIGGER_MODE.ONESHOT;
    this.velAmount = 0.7;
    this.chokeGroup = 0;
    this.muted = false;

    // --- playback state ---
    this.active = false;
    this.layer = 0;
    this.pos = 0;
    this.step = 1;
    this.velGain = 1;

    // --- envelope state ---
    this.stage = ENV.IDLE;
    this.env = 0;
    this.attackInc = 0;
    this.decayCoef = 0;
    this.releaseCoef = 0;
    this.holdLeft = 0;
    this.choking = false;
    this.chokeInc = 1 / Math.max(1, (CHOKE_MS * sampleRate) / 1000);

    // Pan is smoothed so dragging the control never zips.
    this.panL = new Smoother(sampleRate, 15, 0.7071);
    this.panR = new Smoother(sampleRate, 15, 0.7071);

    /** Peak of the last block, for the pad's level ring in the UI. */
    this.meter = 0;

    this._recalcEnv();
  }

  // ---------------------------------------------------------------- control

  /**
   * Install a sample into a round-robin layer. Structural — arrives as a control
   * command with SAB-backed views, so this is a pointer handoff, not a copy.
   */
  setBuffer(layerIndex, data, frames, srcRate) {
    const i = clamp(layerIndex | 0, 0, MAX_LAYERS - 1);
    const L = this.layers[i];
    L.data = data || null;
    L.frames = data ? frames | 0 : 0;
    L.rate = srcRate || this.sr;

    let n = 0;
    for (let k = 0; k < MAX_LAYERS; k++) if (this.layers[k].data && this.layers[k].frames > 0) n = k + 1;
    this.layerCount = n;
    if (this.nextLayer >= n) this.nextLayer = 0;
  }

  clearBuffers() {
    for (let i = 0; i < MAX_LAYERS; i++) {
      this.layers[i].data = null;
      this.layers[i].frames = 0;
    }
    this.layerCount = 0;
    this.nextLayer = 0;
    this.active = false;
    this.stage = ENV.IDLE;
    this.env = 0;
  }

  setParam(key, value) {
    switch (key) {
      case "attack":
        this.attackMs = clamp(value, 0, 2000);
        this._recalcEnv();
        break;
      case "decay":
        this.decayMs = clamp(value, 1, 8000);
        this._recalcEnv();
        break;
      case "sustain":
        this.sustain = clamp(value, 0, 1);
        break;
      case "release":
        this.releaseMs = clamp(value, 1, 8000);
        this._recalcEnv();
        break;
      case "hold":
        this.holdMs = clamp(value, 0, 8000);
        break;
      case "pitch":
        this.pitch = clamp(value, -36, 36);
        break;
      case "start":
        this.startOffset = clamp(value, 0, 0.99);
        break;
      case "reverse":
        this.reverse = value >= 0.5;
        break;
      case "gain":
        this.gain = dbToGain(clamp(value, -60, 12));
        break;
      case "pan": {
        // Constant-power law, so panning a kick off-centre does not make it quieter.
        const p = clamp(value, -1, 1);
        this.pan = p;
        const a = ((p + 1) * Math.PI) / 4;
        this.panL.set(Math.cos(a));
        this.panR.set(Math.sin(a));
        break;
      }
      case "mode":
        this.mode = value >= 0.5 ? TRIGGER_MODE.ONESHOT : TRIGGER_MODE.GATE;
        break;
      case "velAmount":
        this.velAmount = clamp(value, 0, 1);
        break;
      case "choke":
        this.chokeGroup = Math.round(clamp(value, 0, 8));
        break;
      case "mute":
        this.muted = value >= 0.5;
        break;
    }
  }

  _recalcEnv() {
    const sr = this.sr;
    this.attackInc = this.attackMs <= 0 ? 1 : 1 / Math.max(1, (this.attackMs * sr) / 1000);
    // Exponential decay/release, expressed as a per-sample coefficient. The 5x factor
    // makes the stated time read as "time to effectively silent" rather than one tau,
    // which is what a musician expects a decay knob to mean.
    this.decayCoef = Math.exp(-5 / Math.max(1, (this.decayMs * sr) / 1000));
    this.releaseCoef = Math.exp(-5 / Math.max(1, (this.releaseMs * sr) / 1000));
  }

  /**
   * Note-on. `velocity` is 0..1. Restarts the voice from the top — retriggering a pad
   * mid-decay is normal and must not click, so the envelope restarts from its current
   * value rather than from zero when it is still sounding.
   */
  trigger(velocity) {
    if (this.layerCount === 0) return;

    this.layer = this.nextLayer;
    this.nextLayer = (this.nextLayer + 1) % this.layerCount;

    const L = this.layers[this.layer];
    const ratio = semitonesToRatio(this.pitch) * (L.rate / this.sr);
    this.step = ratio;

    const startFrame = this.startOffset * (L.frames - 1);
    this.pos = this.reverse ? L.frames - 1 - startFrame : startFrame;

    // A hit that starts from silence starts AT its pan position — smoothing only exists
    // to stop a knob move zipping mid-note. Without this, panning a pad hard left and
    // hitting it immediately still leaks ~15ms of the old position into the right.
    if (!this.active) {
      this.panL.reset(this.panL.target);
      this.panR.reset(this.panR.target);
    }

    const v = clamp(velocity === undefined ? 1 : velocity, 0, 1);
    // velAmount 0 = every hit full level; 1 = velocity fully in charge.
    this.velGain = 1 - this.velAmount + this.velAmount * v * v;

    this.stage = ENV.ATTACK;
    if (this.attackMs <= 0) {
      this.env = 1;
      this.stage = ENV.DECAY;
    }
    this.holdLeft = this.holdMs > 0 ? Math.round((this.holdMs * this.sr) / 1000) : -1;
    this.choking = false;
    this.active = true;
  }

  /** Note-off. Only meaningful in GATE mode; ONESHOT uses `hold` instead. */
  release() {
    if (!this.active) return;
    if (this.mode === TRIGGER_MODE.GATE && this.stage !== ENV.IDLE) this.stage = ENV.RELEASE;
  }

  /** Cut this voice for a choke group (closed hat killing an open hat). */
  choke() {
    if (this.active) this.choking = true;
  }

  reset() {
    this.active = false;
    this.stage = ENV.IDLE;
    this.env = 0;
    this.pos = 0;
    this.choking = false;
    this.meter = 0;
    this.panL.reset(this.panL.value);
    this.panR.reset(this.panR.value);
  }

  // ---------------------------------------------------------------- audio

  /**
   * Render this voice ADDITIVELY into L/R. Additive because the rack sums sixteen of
   * these into one bus and a copy-then-sum would cost an extra pass per voice.
   *
   * Never throws, never allocates.
   */
  process(L, R, frames) {
    if (!this.active || this.muted) {
      this.meter = 0;
      // Keep the pan smoother moving so it is settled by the next hit.
      for (let i = 0; i < frames; i++) {
        this.panL.next();
        this.panR.next();
      }
      return;
    }

    const buf = this.layers[this.layer];
    const data = buf.data;
    const n = buf.frames;
    if (!data || n <= 0) {
      this.active = false;
      this.meter = 0;
      return;
    }

    const step = this.reverse ? -this.step : this.step;
    const g = this.gain * this.velGain;
    const sustain = this.sustain;
    let pos = this.pos;
    let env = this.env;
    let stage = this.stage;
    let hold = this.holdLeft;
    let peak = 0;

    for (let i = 0; i < frames; i++) {
      // --- ran off either end of the sample -------------------------------
      if (pos < 1 || pos >= n - 2) {
        // Boundary-safe: cubic interpolation needs one frame either side, so the last
        // two frames are played without it rather than reading out of bounds.
        if (pos < 0 || pos >= n) {
          stage = ENV.IDLE;
          break;
        }
      }

      // --- envelope -------------------------------------------------------
      if (this.choking) {
        env -= this.chokeInc;
        if (env <= 0) {
          env = 0;
          stage = ENV.IDLE;
          break;
        }
      } else {
        switch (stage) {
          case ENV.ATTACK:
            env += this.attackInc;
            if (env >= 1) {
              env = 1;
              stage = ENV.DECAY;
            }
            break;
          case ENV.DECAY:
            env = sustain + (env - sustain) * this.decayCoef;
            if (env - sustain < 1e-4) {
              env = sustain;
              // sustain 0 means the decay knob IS the length of the sound: the voice is
              // finished, not holding silence. Without this the pad stays "active"
              // rendering zeros until the sample runs out, which keeps it out of the
              // free pool and lights its meter ring forever.
              stage = sustain < 1e-4 ? ENV.IDLE : ENV.SUSTAIN;
            }
            break;
          case ENV.SUSTAIN:
            env = sustain;
            if (sustain < 1e-4) stage = ENV.IDLE;
            break;
          case ENV.RELEASE:
            env *= this.releaseCoef;
            if (env < 1e-4) {
              env = 0;
              stage = ENV.IDLE;
            }
            break;
        }
        // ONESHOT auto-release: the beatbox path has no note-off to wait for.
        if (hold > 0) {
          hold--;
          if (hold === 0 && stage !== ENV.RELEASE) stage = ENV.RELEASE;
        }
      }
      if (stage === ENV.IDLE) break;

      // --- 4-point cubic Hermite resample ---------------------------------
      const idx = pos | 0;
      const frac = pos - idx;
      let s;
      if (idx >= 1 && idx < n - 2) {
        const y0 = data[idx - 1];
        const y1 = data[idx];
        const y2 = data[idx + 1];
        const y3 = data[idx + 2];
        const c0 = y1;
        const c1 = 0.5 * (y2 - y0);
        const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
        const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        s = ((c3 * frac + c2) * frac + c1) * frac + c0;
      } else {
        // Linear at the edges, where cubic would read past the buffer.
        const a = data[idx] || 0;
        const b = data[idx + 1 < n ? idx + 1 : idx] || 0;
        s = a + (b - a) * frac;
      }

      const out = sanitize(s * env * g);
      const a = Math.abs(out);
      if (a > peak) peak = a;

      L[i] += out * this.panL.next();
      R[i] += out * this.panR.next();

      pos += step;
    }

    this.pos = pos;
    this.env = env;
    this.stage = stage;
    this.holdLeft = hold;
    if (stage === ENV.IDLE) {
      this.active = false;
      this.choking = false;
      this.env = 0;
    }
    this.meter = peak;
  }
}
