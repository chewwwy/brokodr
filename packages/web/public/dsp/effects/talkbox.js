/**
 * Bro.Kodr — talk box.
 *
 * A talk box is NOT a vocoder, and this module is deliberately a different machine
 * from `vocoder.js`. In the real hardware (Heil/Rocktron/Framptone) an amplified
 * instrument is fed into a compression driver, up a plastic tube, into the player's
 * mouth. The player mouths words without phonating: the vocal tract acts as a
 * time-varying acoustic filter on the instrument, and the voice itself makes no
 * sound. The consonants and vowels you hear are pure resonance, which is why a talk
 * box sounds wetter and more "human" than a channel vocoder's filterbank.
 *
 * Modelled here as source-filter separation by LINEAR PREDICTION:
 *
 *   mic (your mouthing)  -> pre-emphasis -> Hamming window -> autocorrelation
 *                        -> Levinson-Durbin -> reflection coefficients k[1..p]
 *                                                     |
 *   internal carrier (the "instrument") -> all-pole LATTICE filter -> de-emphasis
 *
 * The all-pole tract filter is realised in lattice/ladder form rather than direct
 * form on purpose: a lattice built from reflection coefficients is guaranteed stable
 * as long as every |k| < 1, so the coefficients can be clamped and interpolated
 * per-sample between analysis frames without any risk of the filter blowing up.
 * A direct-form all-pole filter driven by frame-to-frame interpolated coefficients
 * can and does explode, which would be a speaker-destroying bug in a live monitor.
 *
 * TRACT SIZE resamples the analysis frame before the LPC fit. Resampling the frame
 * by a factor scales the whole spectral envelope, so it shifts the formants together
 * the way a longer or shorter vocal tract does — not a per-band EQ tilt.
 *
 * TRACT Q scales the reflection coefficients toward zero. Because |k| only shrinks,
 * stability is preserved while the poles move off the unit circle: the vowels get
 * broader and softer, which is the difference between a small hard plastic tube and
 * a big soft mouth.
 *
 * SQUELCH gates the whole thing on the mic envelope. A talk box driver runs
 * continuously in real life and hisses between words; here the carrier is muted when
 * you stop mouthing, so it does not drone.
 *
 * BREATH mixes a high-passed slice of the dry mic back in. A real talk box loses
 * /s/, /f/ and /t/ entirely (no phonation, no carrier energy up there), and players
 * work around it by leaning into the vocal mic. This is that leak, on a knob.
 */

import { Effect } from "./base.js";
import { Biquad, FilterType } from "../core/biquad.js";
import { Oversampler4x } from "../core/delay-line.js";
import {
  Smoother,
  EnvelopeFollower,
  Oscillator,
  PitchTracker,
  DCBlocker,
  dbToGain,
  clamp,
  sanitize,
} from "../core/utils.js";

const MAX_ORDER = 40;
/** Pre-emphasis coefficient. Flattens the -6dB/oct voice tilt so the LPC fit spends
 *  its poles on formants instead of on the spectral slope. Undone on output. */
const PREEMPH = 0.95;
/** Reflection coefficients are hard-clamped inside the unit circle. */
const K_LIMIT = 0.985;
/**
 * Per-carrier RMS normalisation.
 *
 * The Levinson-Durbin residual gain is the excitation level that would reproduce the
 * input loudness ASSUMING a unit-variance excitation. The carriers here are not unit
 * variance (a saw is 1/sqrt(3), a square is 1), so without this table the output level
 * would jump every time you changed driver, and the residual gain would be a lie.
 * Dividing by each carrier's own RMS makes the gain term mean what the maths says it
 * means, so loudness tracks the mic and driver changes are level-matched.
 * Indexed by carrierType: saw, square, pulse, dual saw, sub+saw, noise.
 */
const CARRIER_RMS = [0.5774, 1.0, 0.8285, 0.8062, 0.7365, 0.5196];
/**
 * Global excitation trim. The synthesis filter is 1/A(z) with no gain normalisation,
 * and the de-emphasis stage adds low-end weight, so the loop needs one honest scalar
 * to land at unity. Measured against a synthetic two-formant vowel, not guessed —
 * see the loudness-tracking assertion in scripts/verify-dsp.mjs.
 */
const EXC_TRIM = 1.0;

/** Linear-interpolated read from a circular buffer at a fractional position. */
function readLerp(buf, len, pos) {
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  const a = buf[((i0 % len) + len) % len];
  const b = buf[(((i0 + 1) % len) + len) % len];
  return a + (b - a) * frac;
}

export class TalkBox extends Effect {
  static id = "talkbox";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);

    // ---- params (raw, as set from the UI) ----
    this.carrierType = 0; // 0 saw 1 square 2 pulse 3 dual-saw 4 sub+saw 5 noise
    this.pitchHz = 110;
    this.follow = 1;
    this.glideMs = 40;
    this.order = 22;
    this.tractSize = 1;
    this.tractQ = 0.9;
    this.brightness = 0.2;
    this.breath = 0.3;
    this.squelchDb = -52;
    this.driveAmt = 0.25;
    this.outDb = 0;
    // 0 = internal synth carrier, 1 = the loaded audio file (the real talk box rig:
    // a guitar amp driving the tube, your mouth shaping it).
    this.source = 0;
    // Carrier bus refs are handed over once, at add time, by the chain runner.
    this.carBusL = null;
    this.carBusR = null;
    // Running mean-square of the file carrier, ~100ms time constant.
    this.carRms = 0;
    this.carRmsA = 1 - Math.exp(-1 / (0.1 * sampleRate));

    // ---- analysis geometry ----
    // ~25ms window: long enough for a stable formant fit at order 40, short enough
    // that a fast consonant is not smeared across two frames.
    this.frameLen = Math.max(256, Math.min(2048, Math.round(sampleRate * 0.025)));
    // ~6ms hop. The analysis cost is amortised over the hop, so this is the main
    // CPU/response tradeoff in the module.
    this.hop = Math.max(64, Math.round(sampleRate * 0.006));
    // History has to hold frameLen source samples stretched by the largest tract
    // ratio (2x) plus one block of new audio.
    this.histLen = this.frameLen * 2 + maxBlock + 8;
    this.hist = new Float32Array(this.histLen);
    this.histW = 0;
    this.hopCount = 0;

    this.window = new Float32Array(this.frameLen);
    for (let i = 0; i < this.frameLen; i++) {
      this.window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (this.frameLen - 1));
    }

    // All analysis scratch is preallocated — process() must never allocate.
    this.frame = new Float64Array(this.frameLen);
    this.acf = new Float64Array(MAX_ORDER + 1);
    this.lpc = new Float64Array(MAX_ORDER + 1);
    this.lpcTmp = new Float64Array(MAX_ORDER + 1);
    this.kTarget = new Float64Array(MAX_ORDER);
    this.kNow = new Float64Array(MAX_ORDER);
    /** Lattice backward states b_i[n-1]. Needs order+1 slots. */
    this.b = new Float64Array(MAX_ORDER + 1);
    this.activeOrder = this.order;
    this.gainTarget = 0;

    // ---- carrier ----
    this.osc1 = new Oscillator(sampleRate);
    this.osc2 = new Oscillator(sampleRate);
    this.oscSub = new Oscillator(sampleRate);
    this.noiseState = 12345;
    this.tracker = new PitchTracker(sampleRate, 60, 700);
    this.trackedHz = 110;
    this.pitchSm = new Smoother(sampleRate, this.glideMs, 110);

    // ---- input analysis / output shaping ----
    this.inEnv = new EnvelopeFollower(sampleRate, 3, 90, true);
    this.gateSm = new Smoother(sampleRate, 12, 0);
    this.gainSm = new Smoother(sampleRate, 8, 0);
    this.outSm = new Smoother(sampleRate, 20, 1);
    this.breathSm = new Smoother(sampleRate, 20, 0.3);
    this.breathHp = new Biquad(sampleRate);
    this.tiltLow = new Biquad(sampleRate);
    this.tiltHigh = new Biquad(sampleRate);
    this.dc = new DCBlocker(sampleRate, 25);
    this.deZ = 0;

    // Nonlinear stage runs 4x oversampled like every other drive stage in the rack.
    this.os = new Oversampler4x(sampleRate, maxBlock);
    this.mono = new Float32Array(maxBlock);
    this.shaper = (x) => {
      const d = 1 + this.driveGain * 9;
      return Math.tanh(x * d) / Math.tanh(d > 1 ? d : 1.0001);
    };
    this.driveGain = 0.25;

    this.#updateFilters();
  }

  /** Handed the shared file-carrier bus once, at add time, by the chain runner. */
  setCarrierBus(l, r) {
    this.carBusL = l;
    this.carBusR = r;
  }

  setParam(id, v) {
    switch (id) {
      case "carrier":
        this.carrierType = clamp(Math.round(v), 0, 5);
        break;
      case "pitch":
        this.pitchHz = clamp(v, 20, 2000);
        if (!this.follow) this.pitchSm.set(this.pitchHz);
        break;
      case "follow":
        this.follow = v >= 0.5 ? 1 : 0;
        break;
      case "glide":
        this.glideMs = clamp(v, 0, 400);
        this.pitchSm.setTime(Math.max(0.5, this.glideMs));
        break;
      case "order":
        // Even orders only: formants come in pole pairs.
        this.order = clamp(Math.round(v / 2) * 2, 8, MAX_ORDER);
        break;
      case "tract":
        this.tractSize = clamp(v, 0.5, 2);
        break;
      case "tractq":
        this.tractQ = clamp(v, 0, 1);
        break;
      case "brightness":
        this.brightness = clamp(v, -1, 1);
        this.#updateFilters();
        break;
      case "breath":
        this.breath = clamp(v, 0, 1);
        this.breathSm.set(this.breath);
        break;
      case "squelch":
        this.squelchDb = clamp(v, -90, -10);
        break;
      case "drive":
        this.driveAmt = clamp(v, 0, 1);
        break;
      case "output":
        this.outDb = v;
        this.outSm.set(dbToGain(v));
        break;
      case "source":
        this.source = v >= 0.5 ? 1 : 0;
        break;
      default:
        break;
    }
  }

  #updateFilters() {
    const tilt = this.brightness * 9;
    this.breathHp.set(FilterType.HIGHPASS, 3800, 0.7);
    this.tiltHigh.set(FilterType.HIGHSHELF, 2200, 0.7, tilt);
    this.tiltLow.set(FilterType.LOWSHELF, 320, 0.7, -tilt * 0.5);
  }

  /**
   * Fit an all-pole vocal tract model to the most recent frameLen samples of input.
   * Called once per hop, never per sample.
   */
  #analyse() {
    const N = this.frameLen;
    const hist = this.hist;
    const H = this.histLen;
    const win = this.window;
    const frame = this.frame;

    // Resample the analysis frame to move the formants: reading the history at step
    // `r` plays it back r times faster, which scales the whole envelope by r. A
    // longer tract (bigger tractSize) means lower formants, hence r = 1/tractSize.
    const r = clamp(1 / Math.max(0.5, this.tractSize), 0.5, 2);
    const span = Math.min(H - 4, Math.ceil(N * r) + 2);
    // Oldest source sample of the window, as a read offset behind the write head.
    const start = this.histW - span;

    let energy = 0;
    // One sample of run-up so the pre-emphasis difference at i=0 is real audio and
    // not an implicit zero (which would inject a click into the fit).
    let prev = readLerp(hist, H, start - r);
    for (let i = 0; i < N; i++) {
      const x = readLerp(hist, H, start + i * r);
      // Pre-emphasis is applied on the resampled stream, inside the window.
      const w = (x - PREEMPH * prev) * win[i];
      prev = x;
      frame[i] = w;
      energy += w * w;
    }

    if (!(energy > 1e-12)) {
      // Silence: flatten the tract and mute the excitation rather than fitting noise.
      this.gainTarget = 0;
      for (let i = 0; i < MAX_ORDER; i++) this.kTarget[i] = 0;
      return;
    }

    const p = Math.min(this.order, MAX_ORDER, N - 2);
    const acf = this.acf;
    for (let m = 0; m <= p; m++) {
      let s = 0;
      for (let n = m; n < N; n++) s += frame[n] * frame[n - m];
      acf[m] = s;
    }
    // White-noise floor + tiny lag window: keeps Levinson-Durbin well conditioned on
    // near-periodic input, which is exactly what a sustained vowel is.
    acf[0] = acf[0] * 1.0001 + 1e-9;

    // ---- Levinson-Durbin ----
    // Convention: A(z) = 1 + sum a_j z^-j, so k_m carries its own minus sign and the
    // lattice recursion below uses (f - k*b) / (b + k*f).
    const a = this.lpc;
    const tmp = this.lpcTmp;
    const k = this.kTarget;
    // Tract Q shrinks every reflection coefficient toward zero: poles move inward off
    // the unit circle, vowels broaden, and |k| < 1 still holds so the lattice stays stable.
    const qScale = 0.6 + 0.4 * this.tractQ;
    let err = acf[0];
    let fitted = 0;
    a[0] = 1;
    for (let m = 1; m <= p; m++) {
      let acc = acf[m];
      for (let j = 1; j < m; j++) acc += a[j] * acf[m - j];
      const km = -acc / err;
      if (!Number.isFinite(km) || Math.abs(km) >= 1) break;
      for (let j = 1; j < m; j++) tmp[j] = a[j] + km * a[m - j];
      for (let j = 1; j < m; j++) a[j] = tmp[j];
      a[m] = km;
      k[m - 1] = clamp(km * qScale, -K_LIMIT, K_LIMIT);
      err *= 1 - km * km;
      fitted = m;
      if (!(err > 1e-20)) break;
    }
    for (let i = fitted; i < MAX_ORDER; i++) k[i] = 0;
    this.activeOrder = fitted;

    // Excitation gain = RMS of the prediction residual. Drive the tract filter with
    // this and the synthesised output lands at roughly the loudness of the input,
    // so the talk box tracks how hard you are mouthing.
    const g = Math.sqrt(Math.max(err, 0) / N);
    this.gainTarget = Number.isFinite(g) ? Math.min(g, 4) : 0;
  }

  #carrier(hz) {
    switch (this.carrierType) {
      case 1:
        this.osc1.setFreq(hz);
        this.osc1.pw = 0.5;
        return this.osc1.pulse();
      case 2:
        this.osc1.setFreq(hz);
        this.osc1.pw = 0.22;
        return this.osc1.pulse();
      case 3:
        this.osc1.setFreq(hz);
        this.osc2.setFreq(hz * 1.006);
        return 0.6 * (this.osc1.saw() + this.osc2.saw());
      case 4:
        this.osc1.setFreq(hz);
        this.oscSub.setFreq(hz * 0.5);
        this.oscSub.pw = 0.5;
        return 0.7 * this.osc1.saw() + 0.6 * this.oscSub.pulse();
      case 5: {
        // xorshift noise — deterministic, no Math.random() on the audio thread.
        let s = this.noiseState;
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        this.noiseState = s | 0;
        return (this.noiseState / 2147483648) * 0.9;
      }
      default:
        this.osc1.setFreq(hz);
        return this.osc1.saw();
    }
  }

  process(L, R, frames) {
    const hist = this.hist;
    const H = this.histLen;
    const mono = this.mono;
    const b = this.b;
    const kNow = this.kNow;
    const kT = this.kTarget;
    const thresh = dbToGain(this.squelchDb);
    // Coefficient interpolation: ~4ms glide between analysis frames. Fast enough to
    // keep consonants crisp, slow enough that nothing zippers.
    const kA = 1 - Math.exp(-1 / (0.004 * this.sr));
    this.driveGain = this.driveAmt;
    const breathAmt = this.breathSm;
    let act = 0;

    for (let i = 0; i < frames; i++) {
      const x = (L[i] + R[i]) * 0.5;

      // --- input history + analysis scheduling ---
      hist[this.histW] = x;
      this.histW = (this.histW + 1) % H;
      this.tracker.push(x);
      if (++this.hopCount >= this.hop) {
        this.hopCount = 0;
        this.#analyse();
      }

      const env = this.inEnv.process(x);
      // Hysteresis-free soft gate: 6dB of range above threshold opens fully.
      const openT = env > thresh ? Math.min(1, (env - thresh) / (thresh * 1.5 + 1e-9)) : 0;
      this.gateSm.set(openT);
      const gate = this.gateSm.next();

      // --- carrier pitch ---
      let hz = this.pitchHz;
      if (this.follow) {
        if (this.trackedHz > 0) hz = this.trackedHz;
      }
      this.pitchSm.set(clamp(hz, 20, this.sr * 0.25));
      const pitch = this.pitchSm.next();

      // --- excitation ---
      this.gainSm.set(this.gainTarget);
      const g = this.gainSm.next();
      // File carrier: the tube is fed by the loaded track instead of the synth. Its
      // RMS is unknown, so it is normalised by a slow running RMS rather than a
      // per-waveform constant, keeping the residual-gain maths meaningful.
      let src;
      if (this.source === 1 && this.carBusL) {
        const c = (this.carBusL[i] + this.carBusR[i]) * 0.5;
        this.carRms += (c * c - this.carRms) * this.carRmsA;
        const rms = Math.sqrt(this.carRms);
        src = rms > 1e-5 ? c / rms : 0;
        // Keep the synth phase advancing so switching back is not a phase jump.
        this.#carrier(pitch);
      } else {
        src = this.#carrier(pitch) / CARRIER_RMS[this.carrierType];
      }
      const exc = src * g * gate * EXC_TRIM;

      // --- all-pole lattice: the vocal tract ---
      const ord = this.activeOrder;
      let f = exc;
      for (let s = ord; s >= 1; s--) {
        const kk = (kNow[s - 1] += (kT[s - 1] - kNow[s - 1]) * kA);
        const bp = b[s - 1];
        f = f - kk * bp;
        b[s] = bp + kk * f;
      }
      f = sanitize(f);
      b[0] = f;

      // De-emphasis undoes the analysis pre-emphasis so the output keeps the natural
      // spectral tilt instead of sounding like a buzzsaw.
      const de = f + PREEMPH * this.deZ;
      this.deZ = sanitize(de);
      let y = this.dc.process(de);

      // --- sibilance leak from the dry mic ---
      const bAmt = breathAmt.next();
      if (bAmt > 0.0001) y += this.breathHp.process(x) * bAmt * 0.8;
      else this.breathHp.process(x);

      mono[i] = sanitize(y);
      if (gate > act) act = gate;
    }

    if (this.driveAmt > 0.001) this.os.process(mono, frames, this.shaper, mono);

    for (let i = 0; i < frames; i++) {
      let y = this.tiltLow.process(this.tiltHigh.process(mono[i]));
      y = sanitize(y) * this.outSm.next();
      L[i] = y;
      R[i] = y;
    }

    // Pitch tracking runs once per block, not per sample.
    if (this.follow) {
      const t = this.tracker.analyze();
      if (t > 0) this.trackedHz = t;
    }

    this.meter = act;

    // Cheap divergence guard. The lattice cannot go unstable with |k| < 1, but a
    // denormal storm or a NaN arriving from upstream would still poison the state.
    if (!Number.isFinite(b[0])) this.reset();
  }

  reset() {
    this.b.fill(0);
    this.kNow.fill(0);
    this.kTarget.fill(0);
    this.hist.fill(0);
    this.histW = 0;
    this.hopCount = 0;
    this.activeOrder = 0;
    this.gainTarget = 0;
    this.deZ = 0;
    this.dc.reset();
    this.breathHp.reset();
    this.tiltHigh.reset();
    this.tiltLow.reset();
    this.os.reset();
    this.inEnv.reset();
    this.gateSm.reset(0);
    this.gainSm.reset(0);
    this.carRms = 0;
    this.meter = 0;
  }
}
