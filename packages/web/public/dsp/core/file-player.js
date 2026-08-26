/**
 * Bro.Kodr — audio file player (backend-agnostic).
 *
 * Plays a decoded audio file into the engine, either as a normal input source or as
 * the CARRIER for the talk box / vocoder — i.e. the authentic talk box rig: a guitar
 * riff drives the tube, your mouth does the talking.
 *
 * Like every file under /dsp/core this knows nothing about AudioContext, the DOM or
 * Node. It is handed plain Float32Arrays (in practice SharedArrayBuffer views decoded
 * on the UI thread) and a source sample rate, and it renders blocks. A native
 * WASAPI/ASIO backend can reuse it untouched.
 *
 * SPEED and PITCH are independent, which is the whole reason this is not just a
 * variable-rate read pointer. The signal path is two stages:
 *
 *     source --[ WSOLA time-stretch, factor alpha ]--> FIFO --[ resampler, rate r ]--> out
 *
 *   net playback rate = alpha * r      net pitch = r
 *
 * so for a wanted speed s and pitch ratio p (times the source/engine rate conversion
 * `base`), r = base * p and alpha = s / p. Setting only speed leaves pitch alone and
 * vice-versa. When alpha lands on 1 (speed == pitch, including the default 1x/0st)
 * the stretcher degenerates to a straight copy, so the common case costs nothing and
 * suffers none of WSOLA's artefacts.
 *
 * WSOLA (waveform-similarity overlap-add) rather than plain OLA because plain OLA
 * shifts grains by a fixed hop regardless of the waveform, so the overlap region
 * fights itself and a sustained note turns into a phasey warble. WSOLA slides the
 * grain within a small tolerance to the position that best correlates with the
 * natural continuation of what was already emitted, so periodic material stays in
 * phase across the splice. The correlation search is decimated (every other sample,
 * half window) — full-resolution search costs ~10x more for no audible gain.
 *
 * Real-time discipline: zero allocation in process(), no exceptions, no console.
 * Everything below is preallocated in the constructor.
 */

import { clamp, sanitize, Smoother, semitonesToRatio } from "./utils.js";

/** Grain size for the stretcher (~23 ms at 44.1k). */
const GRAIN = 1024;
/** 50% overlap: a Hann window at half-window hop sums to exactly 1 (COLA). */
const HOP = GRAIN >> 1;
/** How far a grain may slide to find a better-correlating splice, in samples. */
const TOLERANCE = 160;
/** Correlation window and decimation for the similarity search. */
const CORR = 256;
const CORR_STEP = 2;
/** Circular FIFO between the stretcher and the resampler. Must comfortably hold
 *  one grain plus a full block read at the fastest pitch. */
const FIFO = 8192;
const FIFO_MASK = FIFO - 1;

export class FilePlayer {
  constructor(sampleRate, maxBlock) {
    this.sr = sampleRate;
    this.maxBlock = maxBlock;

    /** @type {Float32Array|null} decoded source, left/mono */
    this.chL = null;
    /** @type {Float32Array|null} decoded source, right (may be the same array as chL) */
    this.chR = null;
    this.frames = 0;
    this.srcRate = sampleRate;

    // Transport.
    this.playing = false;
    // One-shot by default: a freshly loaded file that instantly loops forever is a
    // worse surprise than one that stops.
    this.loopEnabled = false;
    this.loopIn = 0;
    this.loopOut = 0;
    this.srcPos = 0; // analysis read position, in source frames (double)
    this.ended = false;

    // Rate controls.
    this.speed = 1; // playback rate multiplier
    this.pitchSemis = 0; // transposition in semitones
    this.gainSm = new Smoother(sampleRate, 6, 0); // play/stop fade — kills clicks
    this.levelDb = 0;
    this.level = 1;

    // Stretcher state.
    this.fifoL = new Float32Array(FIFO);
    this.fifoR = new Float32Array(FIFO);
    this.fifoWrite = 0; // absolute count of COMPLETE samples in the FIFO
    this.fifoRead = 0; // absolute fractional read position
    this.olaPos = 0; // absolute position of the next grain
    this.refL = new Float32Array(CORR);
    this.refR = new Float32Array(CORR);
    this.hasRef = false;

    this.window = new Float32Array(GRAIN);
    for (let i = 0; i < GRAIN; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GRAIN);
    }

    this.meter = 0;
    this.position = 0; // 0..1 through the file, for the UI playhead
  }

  // ---------------------------------------------------------------- control

  /**
   * Install decoded audio. Called off the audio thread only in the sense that it
   * arrives as a structural command; it allocates nothing itself — the arrays are
   * views handed in from the host.
   */
  setBuffer(chL, chR, frames, srcRate) {
    this.chL = chL;
    this.chR = chR || chL;
    this.frames = frames | 0;
    this.srcRate = srcRate > 0 ? srcRate : this.sr;
    this.loopIn = 0;
    this.loopOut = this.frames;
    this.srcPos = 0;
    this.playing = false;
    this.ended = false;
    this.gainSm.reset(0);
    this.#flush();
  }

  clearBuffer() {
    this.playing = false;
    this.chL = null;
    this.chR = null;
    this.frames = 0;
    this.srcPos = 0;
    this.position = 0;
    this.gainSm.reset(0);
    this.#flush();
  }

  get loaded() {
    return this.chL !== null && this.frames > 0;
  }

  get active() {
    return this.loaded && (this.playing || !this.gainSm.settled || this.gainSm.value > 1e-4);
  }

  setParam(id, v) {
    switch (id) {
      case "play": {
        const on = v >= 0.5;
        if (on && !this.playing) {
          if (!this.loaded) break;
          if (this.ended) {
            this.srcPos = this.#regionStart();
            this.ended = false;
          }
          this.#flush();
          this.playing = true;
        } else if (!on && this.playing) {
          this.playing = false;
        }
        break;
      }
      case "seek": {
        const a = this.#regionStart();
        const b = this.#regionEnd();
        this.srcPos = clamp(a + v * (b - a), 0, Math.max(0, this.frames - 1));
        this.ended = false;
        this.#flush();
        break;
      }
      case "loop":
        this.loopEnabled = v >= 0.5;
        break;
      case "loopin": {
        const f = clamp(v, 0, 1) * this.frames;
        this.loopIn = Math.min(f, Math.max(0, this.loopOut - 128));
        break;
      }
      case "loopout": {
        const f = clamp(v, 0, 1) * this.frames;
        this.loopOut = Math.max(f, this.loopIn + 128);
        if (this.loopOut > this.frames) this.loopOut = this.frames;
        break;
      }
      case "speed":
        this.speed = clamp(v, 0.25, 4);
        break;
      case "pitch":
        this.pitchSemis = clamp(v, -24, 24);
        break;
      case "gain":
        this.levelDb = clamp(v, -60, 12);
        this.level = this.levelDb <= -60 ? 0 : Math.pow(10, this.levelDb / 20);
        break;
    }
  }

  reset() {
    this.playing = false;
    this.gainSm.reset(0);
    this.#flush();
  }

  #regionStart() {
    return this.loopEnabled ? this.loopIn : 0;
  }

  #regionEnd() {
    return this.loopEnabled ? this.loopOut : this.frames;
  }

  #flush() {
    this.fifoL.fill(0);
    this.fifoR.fill(0);
    this.fifoWrite = 0;
    this.fifoRead = 0;
    this.olaPos = 0;
    this.hasRef = false;
  }

  // ---------------------------------------------------------------- audio

  /**
   * Wrapped source read. Inside the active region playback wraps at the loop point;
   * outside it, reads past the end return silence and the transport stops.
   */
  #srcIndex(idx) {
    const a = this.#regionStart();
    const b = this.#regionEnd();
    const len = b - a;
    if (len <= 0) return -1;
    if (idx >= b) {
      if (!this.loopEnabled) return -1;
      return a + ((idx - a) % len);
    }
    if (idx < a) return this.loopEnabled ? b - ((a - idx) % len) : idx < 0 ? -1 : idx;
    return idx;
  }

  /** Produce `count` more complete samples into the FIFO. */
  #fill(count, alpha) {
    const identity = Math.abs(alpha - 1) < 1e-3;
    let guard = 0;
    while (this.fifoWrite - Math.floor(this.fifoRead) < count && guard++ < 64) {
      if (identity) this.#copyRun();
      else this.#grain(alpha);
      if (this.ended) break;
    }
  }

  /** alpha == 1: no stretching, so just stream the source into the FIFO. */
  #copyRun() {
    const n = HOP;
    const L = this.chL;
    const R = this.chR;
    let p = Math.floor(this.srcPos);
    const w = this.fifoWrite;
    for (let i = 0; i < n; i++) {
      const idx = this.#srcIndex(p + i);
      const o = (w + i) & FIFO_MASK;
      if (idx < 0) {
        this.fifoL[o] = 0;
        this.fifoR[o] = 0;
        this.ended = true;
      } else {
        this.fifoL[o] = L[idx];
        this.fifoR[o] = R[idx];
      }
    }
    this.fifoWrite = w + n;
    this.srcPos = this.#wrapPos(p + n);
  }

  /**
   * Keep srcPos inside the active region while looping. The reads themselves already
   * wrap via #srcIndex; this keeps the reported position (and therefore the playhead)
   * honest instead of letting it run off the end of the file.
   */
  #wrapPos(pos) {
    if (!this.loopEnabled) return pos;
    const a = this.#regionStart();
    const b = this.#regionEnd();
    const len = b - a;
    if (len <= 0) return pos;
    if (pos >= b) return a + ((pos - a) % len);
    if (pos < a) return b - ((a - pos) % len);
    return pos;
  }

  /** One WSOLA grain: find the best splice within tolerance, then overlap-add it. */
  #grain(alpha) {
    const L = this.chL;
    const R = this.chR;
    const base = Math.floor(this.srcPos);

    // --- similarity search: slide the grain to line up with what we already emitted.
    let best = base;
    if (this.hasRef) {
      let bestScore = -Infinity;
      for (let k = -TOLERANCE; k <= TOLERANCE; k += CORR_STEP) {
        const start = base + k;
        if (start < 0) continue;
        let dot = 0;
        let energy = 1e-9;
        for (let i = 0; i < CORR; i += CORR_STEP) {
          const idx = this.#srcIndex(start + i);
          if (idx < 0) break;
          const s = L[idx];
          dot += s * this.refL[i];
          energy += s * s;
        }
        // Normalised correlation: without dividing out the energy the search just
        // finds the loudest spot, not the best-matching one.
        const score = dot / Math.sqrt(energy);
        if (score > bestScore) {
          bestScore = score;
          best = start;
        }
      }
    }

    // --- overlap-add. Samples ahead of the previous grain's tail are untouched, so
    //     zero them first; the region behind olaPos is already complete.
    const p = this.olaPos;
    for (let i = HOP; i < GRAIN; i++) {
      const o = (p + i) & FIFO_MASK;
      this.fifoL[o] = 0;
      this.fifoR[o] = 0;
    }
    let dead = false;
    for (let i = 0; i < GRAIN; i++) {
      const idx = this.#srcIndex(best + i);
      const o = (p + i) & FIFO_MASK;
      if (idx < 0) {
        dead = true;
        continue;
      }
      const w = this.window[i];
      this.fifoL[o] += L[idx] * w;
      this.fifoR[o] += R[idx] * w;
    }
    if (dead) this.ended = true;

    // Natural continuation of this grain — the reference the next search matches.
    for (let i = 0; i < CORR; i++) {
      const idx = this.#srcIndex(best + HOP + i);
      this.refL[i] = idx < 0 ? 0 : L[idx];
    }
    this.hasRef = true;

    this.fifoWrite = p;
    this.olaPos = p + HOP;
    this.srcPos = base + HOP * alpha;
  }

  /**
   * Render one block. Writes (does not add) into outL/outR.
   * Returns true if anything non-silent was produced.
   */
  process(outL, outR, frames) {
    const target = this.playing ? 1 : 0;
    this.gainSm.set(target);

    if (!this.loaded || (!this.playing && this.gainSm.settled && this.gainSm.value < 1e-4)) {
      for (let i = 0; i < frames; i++) {
        outL[i] = 0;
        outR[i] = 0;
      }
      this.meter = 0;
      return false;
    }

    // base folds in source-vs-engine sample-rate conversion; see the header maths.
    const base = this.srcRate / this.sr;
    const p = semitonesToRatio(this.pitchSemis);
    const r = base * p;
    const alpha = this.speed / p;

    const need = Math.ceil(frames * r) + 4;
    this.#fill(need, alpha);

    let pk = 0;
    const lvl = this.level;
    for (let i = 0; i < frames; i++) {
      const g = this.gainSm.next() * lvl;
      const rp = this.fifoRead;
      const i0 = Math.floor(rp);
      const fr = rp - i0;
      // Catmull-Rom: linear interpolation on a resampled read is audible as a dull,
      // aliased top end on anything with cymbals or pick attack.
      const a0 = this.fifoL[(i0 - 1) & FIFO_MASK];
      const a1 = this.fifoL[i0 & FIFO_MASK];
      const a2 = this.fifoL[(i0 + 1) & FIFO_MASK];
      const a3 = this.fifoL[(i0 + 2) & FIFO_MASK];
      const b0 = this.fifoR[(i0 - 1) & FIFO_MASK];
      const b1 = this.fifoR[i0 & FIFO_MASK];
      const b2 = this.fifoR[(i0 + 1) & FIFO_MASK];
      const b3 = this.fifoR[(i0 + 2) & FIFO_MASK];
      const l = cubic(a0, a1, a2, a3, fr) * g;
      const rr = cubic(b0, b1, b2, b3, fr) * g;
      outL[i] = sanitize(l);
      outR[i] = sanitize(rr);
      const al = Math.abs(l);
      if (al > pk) pk = al;
      this.fifoRead = rp + r;
      if (this.fifoRead >= this.fifoWrite) {
        // Underrun (the file ended mid-block): hold position, emit what remains.
        this.fifoRead = this.fifoWrite;
      }
    }

    this.meter = pk;
    if (this.ended && !this.loopEnabled) {
      this.playing = false;
      this.gainSm.set(0);
    }

    const a = this.#regionStart();
    const span = Math.max(1, this.frames);
    this.position = clamp(this.srcPos / span, 0, 1);
    if (a > 0 && !this.loopEnabled) this.position = clamp(this.srcPos / span, 0, 1);
    return true;
  }
}

function cubic(y0, y1, y2, y3, t) {
  const c0 = y1;
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + c0;
}

export { GRAIN, HOP };
