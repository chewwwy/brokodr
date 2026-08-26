/**
 * Bro.Kodr — spectral pitch and formant processing.
 *
 * Phase-vocoder STFT: analysis FFT -> instantaneous-frequency estimation from the
 * phase derivative -> spectral envelope separation -> bin remapping -> phase-coherent
 * resynthesis by overlap-add at hop = N/4.
 *
 * Why this design rather than a granular/delay-line pitch shifter:
 *  - it tracks the true frequency of each partial from the phase difference, so
 *    sustained voices don't warble or produce the "chorus of robots" artefact;
 *  - because we already have the magnitude spectrum, we can split the spectral
 *    ENVELOPE (formants — vocal tract, i.e. perceived identity/vowel) from the
 *    fine HARMONIC structure (pitch — vocal folds) with cepstral liftering, and
 *    move them independently. That is what makes "deep voice that still sounds
 *    human" possible, and what a naive pitch shifter fundamentally cannot do.
 *
 * Latency is inherently one analysis window (fftSize samples). The QUALITY control
 * trades latency against resolution: 512 = ~11ms/48k and tight, 4096 = ~85ms and
 * smooth. The UI reports the real figure — never hidden.
 */

import { Effect } from "./base.js";
import { FFT, hannWindow, CepstralEnvelope } from "../core/fft.js";
import { Smoother, semitonesToRatio, clamp, sanitize } from "../core/utils.js";

const TWO_PI = Math.PI * 2;

/** One mono phase-vocoder channel. Two of these make the stereo module. */
class VocoderChannel {
  constructor(sampleRate, fftSize) {
    this.sr = sampleRate;
    this.init(fftSize);
  }

  init(fftSize) {
    this.n = fftSize;
    this.half = fftSize >> 1;
    this.hop = fftSize >> 2;
    this.osamp = 4;
    this.fft = new FFT(fftSize);
    this.window = hannWindow(fftSize);
    this.cep = new CepstralEnvelope(fftSize);

    this.inFifo = new Float32Array(fftSize);
    this.outFifo = new Float32Array(fftSize);
    this.outAccum = new Float32Array(fftSize * 2);
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);

    this.lastPhase = new Float32Array(this.half + 1);
    this.sumPhase = new Float32Array(this.half + 1);
    this.anaMagn = new Float32Array(this.half + 1);
    this.anaFreq = new Float32Array(this.half + 1);
    this.synMagn = new Float32Array(this.half + 1);
    this.synFreq = new Float32Array(this.half + 1);
    this.excite = new Float32Array(this.half + 1);
    this.envShift = new Float32Array(this.half + 1);

    this.freqPerBin = this.sr / fftSize;
    this.expct = (TWO_PI * this.hop) / fftSize;
    this.rw = 0; // read/write cursor within the hop
    this.latency = fftSize;
    this.clear();
  }

  clear() {
    this.inFifo.fill(0);
    this.outFifo.fill(0);
    this.outAccum.fill(0);
    this.lastPhase.fill(0);
    this.sumPhase.fill(0);
    this.rw = this.n - this.hop;
  }

  /**
   * @param x input sample
   * @param pitchRatio frequency multiplier for the harmonic structure
   * @param envRatio multiplier applied to the spectral envelope BEFORE remapping
   *                 (pass envRatio = formantRatio / pitchRatio to preserve formants)
   * @param doEnvelope skip cepstral work entirely when no formant processing is needed
   * @param lifter cepstral lifter length (spectral envelope smoothness)
   */
  process(x, pitchRatio, envRatio, doEnvelope, lifter) {
    const n = this.n;
    const hop = this.hop;
    const half = this.half;

    this.inFifo[this.rw] = x;
    const out = this.outFifo[this.rw - (n - hop)];
    this.rw++;

    if (this.rw >= n) {
      this.rw = n - hop;

      const re = this.re;
      const im = this.im;
      const w = this.window;

      for (let i = 0; i < n; i++) {
        re[i] = this.inFifo[i] * w[i];
        im[i] = 0;
      }

      this.fft.transform(re, im, false);

      // ---- analysis: magnitude + true frequency per bin -------------------
      const anaMagn = this.anaMagn;
      const anaFreq = this.anaFreq;
      for (let k = 0; k <= half; k++) {
        const r = re[k];
        const i2 = im[k];
        const magn = 2 * Math.sqrt(r * r + i2 * i2);
        const phase = Math.atan2(i2, r);

        let dp = phase - this.lastPhase[k];
        this.lastPhase[k] = phase;
        dp -= k * this.expct;

        // wrap to [-pi, pi]
        let qpd = dp / Math.PI;
        qpd += qpd >= 0 ? 0.5 : -0.5;
        qpd |= 0;
        if (qpd & 1) qpd += qpd > 0 ? 1 : -1;
        dp -= Math.PI * qpd;

        const deviation = (this.osamp * dp) / TWO_PI;
        anaMagn[k] = magn;
        anaFreq[k] = (k + deviation) * this.freqPerBin;
      }

      // ---- spectral envelope: separate formants from harmonics -------------
      if (doEnvelope) {
        const env = this.cep.compute(anaMagn, lifter);
        const excite = this.excite;
        for (let k = 0; k <= half; k++) {
          excite[k] = anaMagn[k] / (env[k] + 1e-9);
        }
        // Warp the envelope: new envelope at bin k = old envelope at k / ratio.
        const shifted = this.envShift;
        const inv = 1 / Math.max(envRatio, 1e-4);
        for (let k = 0; k <= half; k++) {
          const src = k * inv;
          const i0 = src | 0;
          if (i0 >= half) {
            shifted[k] = env[half];
          } else {
            const f = src - i0;
            shifted[k] = env[i0] + (env[i0 + 1] - env[i0]) * f;
          }
        }
        for (let k = 0; k <= half; k++) {
          anaMagn[k] = excite[k] * shifted[k];
        }
      }

      // ---- pitch shift: remap bins ---------------------------------------
      const synMagn = this.synMagn;
      const synFreq = this.synFreq;
      synMagn.fill(0);
      synFreq.fill(0);
      for (let k = 0; k <= half; k++) {
        const index = (k * pitchRatio) | 0;
        if (index <= half) {
          synMagn[index] += anaMagn[k];
          synFreq[index] = anaFreq[k] * pitchRatio;
        }
      }

      // ---- synthesis ------------------------------------------------------
      for (let k = 0; k <= half; k++) {
        const magn = synMagn[k];
        let tmp = synFreq[k];
        tmp -= k * this.freqPerBin;
        tmp /= this.freqPerBin;
        tmp = (TWO_PI * tmp) / this.osamp;
        tmp += k * this.expct;
        this.sumPhase[k] += tmp;
        const phase = this.sumPhase[k];
        re[k] = magn * Math.cos(phase);
        im[k] = magn * Math.sin(phase);
      }
      for (let k = half + 1; k < n; k++) {
        re[k] = re[n - k];
        im[k] = -im[n - k];
      }

      this.fft.transform(re, im, true);

      const norm = 2 / (half * this.osamp);
      for (let i = 0; i < n; i++) {
        this.outAccum[i] += w[i] * re[i] * norm;
      }
      for (let i = 0; i < hop; i++) this.outFifo[i] = this.outAccum[i];
      // shift accumulator
      this.outAccum.copyWithin(0, hop, n + hop);
      this.outAccum.fill(0, n, n + hop);
      // move input fifo down by hop
      this.inFifo.copyWithin(0, hop, n);
    }

    return sanitize(out);
  }
}

export class PitchFormant extends Effect {
  static id = "pitch";

  constructor(sampleRate, maxBlock) {
    super(sampleRate, maxBlock);
    this.fftSize = 1024;
    this.pitchSt = 0;
    this.fineCents = 0;
    this.formantSt = 0;
    this.preserve = 1;
    this.lifter = 40;
    this.pitchSm = new Smoother(sampleRate, 40, 1);
    this.formantSm = new Smoother(sampleRate, 40, 1);
    // --- roughness: jitter (cycle-to-cycle pitch instability) and shimmer (amplitude
    // instability). Together these are what separate a young voice from an old one far
    // more than pitch does: an aged larynx loses periodicity, it does not simply drop in
    // pitch. Both are random walks updated once per block and one-pole smoothed, so they
    // wander like a real voice instead of buzzing like an LFO.
    this.jitter = 0;
    this.shimmer = 0;
    this.rng = 0x9e3779b9 | 0;
    this.jitWalk = 0;
    this.shimWalk = 0;
    this.jitSm = new Smoother(sampleRate, 25, 1);
    this.shimSm = new Smoother(sampleRate, 25, 1);
    this.ch = [new VocoderChannel(sampleRate, this.fftSize), new VocoderChannel(sampleRate, this.fftSize)];
    this.latencySamples = this.fftSize;
  }

  setParam(id, v) {
    switch (id) {
      case "pitch":
        this.pitchSt = v;
        this.#updateRatios();
        break;
      case "fine":
        this.fineCents = v;
        this.#updateRatios();
        break;
      case "formant":
        this.formantSt = v;
        this.#updateRatios();
        break;
      case "preserve":
        this.preserve = v >= 0.5 ? 1 : 0;
        this.#updateRatios();
        break;
      case "lifter":
        this.lifter = clamp(Math.round(v), 8, 120);
        break;
      case "jitter":
        // 0..100 % maps to +-0..4 % pitch wander. Past ~30 % it stops reading as age and
        // starts reading as a broken tape, which is exactly what the Ghost preset wants.
        this.jitter = clamp(v, 0, 100) * 0.0004;
        break;
      case "shimmer":
        // 0..100 % maps to +-0..35 % level wander.
        this.shimmer = clamp(v, 0, 100) * 0.0035;
        break;
      case "quality": {
        const sizes = [512, 1024, 2048, 4096];
        const next = sizes[clamp(Math.round(v), 0, 3)];
        if (next !== this.fftSize) {
          this.fftSize = next;
          for (const c of this.ch) c.init(next);
          this.latencySamples = next;
        }
        break;
      }
    }
  }

  #updateRatios() {
    const p = semitonesToRatio(this.pitchSt + this.fineCents / 100);
    const f = semitonesToRatio(this.formantSt);
    this.pitchSm.set(p);
    // Pre-compensate the envelope so formants land where the user asked, regardless
    // of how far the pitch moved. preserve=0 lets formants ride along with pitch.
    this.formantSm.set(this.preserve ? f / p : f);
  }

  reset() {
    for (const c of this.ch) c.clear();
  }

  process(L, R, frames) {
    // Ratios update at block rate; the STFT frame is the real quantisation anyway.
    const pitch = this.pitchSm.next();
    const envRatio = this.formantSm.next();
    for (let i = 1; i < frames; i++) {
      this.pitchSm.next();
      this.formantSm.next();
    }
    const doEnv = Math.abs(envRatio - 1) > 0.001;
    const a = this.ch[0];
    const b = this.ch[1];

    // Random walk, one step per block. xorshift32 rather than Math.random(): no
    // allocation, no hidden host call on the audio thread, and reproducible for the
    // verifier. The walk is leaky (0.86) so it drifts back to centre instead of
    // wandering off and parking at a permanent detune.
    let r = this.rng;
    r ^= r << 13; r ^= r >>> 17; r ^= r << 5; this.rng = r | 0;
    const n1 = (r & 0xffff) / 32768 - 1;
    r ^= r << 13; r ^= r >>> 17; r ^= r << 5; this.rng = r | 0;
    const n2 = (r & 0xffff) / 32768 - 1;
    this.jitWalk = this.jitWalk * 0.86 + n1 * 0.14;
    this.shimWalk = this.shimWalk * 0.86 + n2 * 0.14;
    this.jitSm.set(1 + this.jitWalk * this.jitter);
    this.shimSm.set(1 + this.shimWalk * this.shimmer);

    const jit = this.jitSm.next();
    const shim = this.shimSm.next();
    for (let i = 1; i < frames; i++) {
      this.jitSm.next();
      this.shimSm.next();
    }
    const p = pitch * jit;

    for (let i = 0; i < frames; i++) {
      L[i] = a.process(L[i], p, envRatio, doEnv, this.lifter) * shim;
      R[i] = b.process(R[i], p, envRatio, doEnv, this.lifter) * shim;
    }
    this.meter = this.latencySamples / this.sr * 1000;
  }
}
