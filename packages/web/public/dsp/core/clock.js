/**
 * Bro.Kodr — transport clock (backend-agnostic).
 *
 * One musical clock the whole engine shares: tempo, bar length, a quantise grid, and a
 * monotonic frame counter. The looper reads it to quantise record punches and to keep
 * every tempo-locked loop phase-aligned; BROBEATS will read the same object when
 * quantised beatbox triggering lands.
 *
 * ## Why a free-running counter and not a start/stop transport
 *
 * A looper needs a grid to exist BEFORE anything is playing — you hit record on the
 * downbeat of a bar that has not been played yet. A transport that only counts while
 * something plays has no grid at that moment, so the first punch cannot be quantised
 * and every later loop inherits that error. So the counter runs from engine start and
 * `reset()` is how the user says "the downbeat is now".
 *
 * ## Why grid boundaries are integer frames
 *
 * `framesPerBeat` is fractional at almost every tempo (48000 / (120/60) / ... lands on
 * a fraction for most BPMs). If loop lengths were fractional, a loop would drift
 * against the grid a fraction of a sample per pass, and after a few minutes of a live
 * set that is audible flam. Everything the looper aligns to is therefore derived from
 * `gridFrames`, an integer, and loop lengths are exact multiples of it. The cost is
 * that the grid can sit up to half a sample off the mathematically-true tempo — 0.01 ms
 * per bar, which nothing can hear and nothing accumulates from, because boundaries are
 * always recomputed from the absolute frame counter rather than stepped.
 *
 * Real-time discipline: no allocation, no exceptions, no console. Plain numbers only.
 *
 * No `#private`, no `extends` — both break the React Native worklet compiler used by
 * the Android build.
 */

import { clamp } from "./utils.js";

export const MIN_BPM = 20;
export const MAX_BPM = 300;

/**
 * Quantise grid choices, in beats. 0 means off (punch exactly when asked).
 * APPEND ONLY — the index is what the wire protocol and saved state store.
 */
export const QUANTIZE_CHOICES = [0, 0.25, 0.5, 1, 2, 4, 8, 16];

export class Clock {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.bpm = 120;
    this.beatsPerBar = 4;
    /** Quantise grid in beats. 0 = off. */
    this.quantize = 4;
    /** Absolute frames since the last reset. Doubles are exact to 2^53 frames. */
    this.frame = 0;
    this.running = true;
    this.framesPerBeat = (sampleRate * 60) / this.bpm;
    this.gridFrames = Math.max(1, Math.round(this.quantize * this.framesPerBeat));
  }

  // ---------------------------------------------------------------- control

  setParam(key, value) {
    switch (key) {
      case "bpm":
        this.bpm = clamp(value, MIN_BPM, MAX_BPM);
        this.framesPerBeat = (this.sr * 60) / this.bpm;
        this._recalcGrid();
        break;
      case "beatsPerBar":
        this.beatsPerBar = clamp(Math.round(value), 1, 16);
        break;
      case "quantize":
        // Free value rather than an index into QUANTIZE_CHOICES: the UI sends beats, so
        // an odd grid (3 beats) is possible without touching the wire protocol.
        this.quantize = value <= 0 ? 0 : clamp(value, 0.0625, 64);
        this._recalcGrid();
        break;
      case "run":
        this.running = value >= 0.5;
        break;
      case "reset":
        this.reset();
        break;
    }
  }

  /** The downbeat is now. Does not stop the clock. */
  reset() {
    this.frame = 0;
  }

  _recalcGrid() {
    this.gridFrames = this.quantize > 0 ? Math.max(1, Math.round(this.quantize * this.framesPerBeat)) : 0;
  }

  // ---------------------------------------------------------------- audio

  /** Called once per block, after the block has been rendered. */
  advance(frames) {
    if (this.running) this.frame += frames;
  }

  /** Frames in `beats` beats, rounded to an integer so loop lengths stay exact. */
  framesForBeats(beats) {
    return Math.max(1, Math.round(beats * this.framesPerBeat));
  }

  /** Frames in one bar. */
  get barFrames() {
    return this.framesForBeats(this.beatsPerBar);
  }

  /** Absolute beat position (fractional). */
  get beat() {
    return this.frame / this.framesPerBeat;
  }

  /** Absolute bar count (fractional). */
  get bar() {
    return this.beat / this.beatsPerBar;
  }

  /** 0..1 through the current bar. */
  get barPhase() {
    const b = this.bar;
    return b - Math.floor(b);
  }

  /**
   * Frames from `frame` (absolute) to the next grid boundary. Returns 0 when the grid
   * is off, meaning "act immediately". Never returns 0 on an active grid — landing
   * exactly on a boundary returns a whole grid, because a punch asked for at the
   * boundary has already missed it by the time the block is being rendered.
   */
  framesToGrid(frame) {
    const g = this.gridFrames;
    if (g <= 0) return 0;
    const rem = frame % g;
    return g - rem;
  }
}
