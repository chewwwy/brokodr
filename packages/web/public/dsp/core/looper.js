/**
 * Bro.Kodr — BROBEATS looper (backend-agnostic).
 *
 * Four loop tracks. Each one records what the engine is already producing (the master
 * bus post-effects, or the drum rack on its own), plays it back in a loop, overdubs more
 * on top, and — the part that makes it more than a pedal — owns its own `Chain`. Record
 * a bass line, then put the saturator and a filter on THAT track while your beatbox
 * stays clean.
 *
 * ## The signal path, and why loops never feed themselves
 *
 *     mic/file/drums -> master chain -> [LOOP RECORD TAP] -> + loop playback -> output
 *
 * Loop playback is summed AFTER the record tap, straight to the output stage, exactly
 * like the drum rack's DIRECT route. It is never part of what the looper records, so an
 * overdub cannot re-record the loop it is playing over — the runaway feedback that makes
 * cheap loopers unusable simply cannot happen here. The cost is that you cannot bounce
 * track 1 into track 2; that is a deliberate trade, and the honest one.
 *
 * Playback is also summed into BOTH the dry and wet taps by the engine, so the master
 * dry/wet — which belongs to the voice chain — never ducks your loops.
 *
 * ## Tempo-locked tracks are clock-slaved, not counter-driven
 *
 * A tempo-locked track does not keep its own play position. Its position is derived every
 * sample from the shared `Clock`:
 *
 *     pos = (clock.frame - anchor) mod loopFrames
 *
 * and its length is an exact integer multiple of the clock's grid. Two consequences, both
 * the reason it is written this way:
 *
 *   - Zero drift, forever. Nothing accumulates, because position is recomputed from the
 *     absolute frame counter rather than incremented.
 *   - Every tempo-locked track is phase-aligned with every other one and with the grid,
 *     even if you punched in a few milliseconds late. Four loops recorded at four
 *     different moments come back locked together.
 *
 * A free-running track (`sync = false`) keeps its own counter and its length is whatever
 * you played — for ambient washes and anything not on a grid.
 *
 * ## Quantised punches are sample-accurate
 *
 * Record/play/stop on a tempo-locked track are scheduled to an absolute frame on the
 * grid and applied INSIDE the per-sample loop, not at the top of a block. Block-boundary
 * switching would put every punch up to 2.7 ms off at 128 frames, in a random direction —
 * audible flam on a hi-hat pattern. Here the punch lands on the sample it was asked for.
 *
 * ## Declicking
 *
 * A punch in or out lands mid-waveform, which writes a step into the recording and clicks
 * on every later pass. Both edges get a ~2 ms linear ramp instead — short enough that a
 * kick transient punched in on the downbeat keeps its attack, long enough to kill the
 * step. On a punch-OUT during overdub the ramp is applied to the newly recorded layer
 * only (which the undo buffer conveniently already holds), never to the material
 * underneath it.
 *
 * ## Undo
 *
 * One undo slot for the whole looper, holding the most recent overdub as a delta, so undo
 * is a subtraction and redo is an addition. One slot rather than per-track history because
 * an undo stack of 30-second stereo layers is tens of megabytes per level for a feature
 * nobody uses past one step; Ableton's looper makes the same call. Undoing the FIRST take
 * is a special case: it just drops the loop length, and the audio is still in the buffer,
 * so redo brings it back.
 *
 * ## Memory
 *
 * Track buffers are 30 seconds of stereo each (~11.5 MB at 48k) and are allocated LAZILY
 * on the first record ARM, not in the constructor — an engine with an unused looper costs
 * nothing, which matters because the test harness builds engines in a loop. Arming rather
 * than recording is the allocation point on purpose: it happens when you click, which is
 * typically a bar ahead of the quantised downbeat, so the one unavoidable allocation lands
 * where a dropout would not be heard rather than on the beat.
 *
 * Real-time discipline: zero allocation in process(), no exceptions, no console.
 *
 * No `#private`, no `extends` — both break the React Native worklet compiler used by the
 * Android build.
 */

import { clamp, dbToGain, sanitize, Smoother } from "./utils.js";
import { Chain } from "./chain.js";

/** Loop tracks in a looper. */
export const LOOP_TRACKS = 4;

/** Seconds of recording per track. */
export const DEFAULT_LOOP_SECONDS = 30;

/**
 * Track state. APPEND ONLY — the value goes over the meter block.
 *  EMPTY   — nothing recorded.
 *  REC     — recording the first take; the loop length is not decided yet.
 *  PLAY    — looping.
 *  OVERDUB — looping and summing new material in.
 *  STOPPED — has audio, silent.
 */
export const LOOP_STATE = { EMPTY: 0, REC: 1, PLAY: 2, OVERDUB: 3, STOPPED: 4 };

/** A punch waiting for the next grid line. APPEND ONLY. */
export const LOOP_PENDING = { NONE: 0, REC: 1, PLAY: 2, STOP: 3 };

/**
 * What a track records. APPEND ONLY.
 *  MASTER — the master bus post-effects: everything you hear except loop playback.
 *  DRUMS  — the BROBEATS bus alone, so a kit loop is unaffected by the vocal chain.
 */
export const LOOP_SOURCE = { MASTER: 0, DRUMS: 1 };

/**
 * Per-track parameter names, indexed by wire key. APPEND ONLY — never reorder or delete,
 * the index is what the command ring and saved state store.
 */
export const LOOP_KEY = ["gain", "mute", "solo", "pan", "sync", "source"];

/** Looper-wide parameter names. APPEND ONLY, same reason. */
export const LOOPER_KEY = ["gain", "mute"];

/** Meter values per loop track. Keep in step with `readMeters` and the UI decoder. */
export const LOOP_METER_STRIDE = 8;

/** Shortest loop worth keeping, in frames (~50 ms) — below this it was a mis-click. */
const MIN_LOOP_FRAMES = 2048;

/** Declick ramp length in frames at 48k (~2 ms). Scaled by sample rate. */
const DECLICK_MS = 2;

/** Undo slot contents. */
const UNDO_NONE = 0;
/** The slot holds an overdub delta: undo subtracts it. */
const UNDO_LAYER = 1;
/** The slot holds "the first take", which undo drops by zeroing the length. */
const UNDO_TAKE = 2;

export class LoopTrack {
  constructor(index, sampleRate, maxBlock, maxFrames) {
    this.index = index;
    this.sr = sampleRate;
    this.maxBlock = maxBlock;
    this.maxFrames = maxFrames;

    /** @type {Float32Array|null} allocated on first arm, never freed after */
    this.bufL = null;
    /** @type {Float32Array|null} */
    this.bufR = null;

    /** Loop length in frames. 0 while empty. */
    this.frames = 0;
    this.state = LOOP_STATE.EMPTY;
    this.pending = LOOP_PENDING.NONE;
    /** Absolute clock frame the pending punch fires on. */
    this.pendingAt = 0;

    /** Free-running play position. Unused when `sync` is true. */
    this.pos = 0;
    /** Frames written so far during the first take. */
    this.recWrite = 0;
    /** Absolute clock frame that loop position 0 sits on (tempo-locked tracks). */
    this.anchor = 0;
    /** Overdub passes committed, including the first take. */
    this.layers = 0;

    this.gainDb = 0;
    this.gain = 1;
    this.pan = 0;
    this.panL = 1;
    this.panR = 1;
    this.muted = false;
    this.soloed = false;
    this.sync = true;
    this.source = LOOP_SOURCE.MASTER;

    /** Play/stop/mute fade. A one-pole over a few ms — clicks on every edge otherwise. */
    this.playGain = new Smoother(sampleRate, 3, 0);
    /** Linear declick ramp counter for a record punch-in. */
    this.recRamp = 0;
    /** Last frame index written, for the punch-out declick. */
    this.lastWrite = -1;

    /** @type {Chain|null} lazily created per-track effect chain */
    this.chain = null;

    this.meter = 0;
    /** 0..1 through the loop, for the UI playhead. */
    this.posNorm = 0;
  }

  get recording() {
    return this.state === LOOP_STATE.REC || this.state === LOOP_STATE.OVERDUB;
  }

  get playing() {
    return this.state === LOOP_STATE.PLAY || this.state === LOOP_STATE.OVERDUB;
  }

  /** True while the track still needs rendering — includes a stop fade in progress. */
  get audible() {
    return this.playing || !this.playGain.settled || this.playGain.value > 1e-4;
  }
}

export class Looper {
  /**
   * @param {number} sampleRate
   * @param {number} maxBlock largest block this looper will be asked to render
   * @param {object} [opts]
   * @param {number} [opts.tracks] track count, defaults to LOOP_TRACKS
   * @param {number} [opts.maxSeconds] recording seconds per track
   */
  constructor(sampleRate, maxBlock, opts) {
    const o = opts || {};
    this.sr = sampleRate;
    this.maxBlock = maxBlock;
    this.maxSeconds = o.maxSeconds || DEFAULT_LOOP_SECONDS;
    this.maxFrames = Math.max(MIN_LOOP_FRAMES, Math.round(this.maxSeconds * sampleRate));
    this.declick = Math.max(8, Math.round((DECLICK_MS * sampleRate) / 1000));

    const n = o.tracks || LOOP_TRACKS;
    /** @type {LoopTrack[]} */
    this.tracks = [];
    for (let i = 0; i < n; i++) {
      this.tracks.push(new LoopTrack(i, sampleRate, maxBlock, this.maxFrames));
    }

    // Scratch for rendering one track through its own chain. One pair is enough because
    // tracks are rendered one at a time, exactly like the drum rack's pads.
    this.trkL = new Float32Array(maxBlock);
    this.trkR = new Float32Array(maxBlock);
    // The looper's own bus: tracks sum here, then looper gain and metering, then the
    // result is added to the caller's buffer.
    this.busL = new Float32Array(maxBlock);
    this.busR = new Float32Array(maxBlock);

    this.gainDb = 0;
    this.gain = 1;
    this.muted = false;
    this.meterL = 0;
    this.meterR = 0;

    // ---- the single undo slot -------------------------------------------
    /** @type {Float32Array|null} allocated on the first overdub */
    this.undoL = null;
    /** @type {Float32Array|null} */
    this.undoR = null;
    this.undoTrack = -1;
    this.undoFrames = 0;
    this.undoMode = UNDO_NONE;
    /** True when the slot's layer is currently part of the loop (so undo removes it). */
    this.undoApplied = false;
    /** True while an overdub is being captured into the slot. */
    this.undoArmed = false;

    // Stands in for a missing source object so the render path never has to null-check
    // it per sample. A null buffer already reads as silence.
    this.nullSrc = { masterL: null, masterR: null, drumL: null, drumR: null };
  }

  // ---------------------------------------------------------------- control

  track(i) {
    const n = i | 0;
    return n >= 0 && n < this.tracks.length ? this.tracks[n] : null;
  }

  get trackCount() {
    return this.tracks.length;
  }

  /** True when anything needs rendering — lets the engine skip the looper entirely. */
  get active() {
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i];
      if (t.state === LOOP_STATE.REC || t.state === LOOP_STATE.OVERDUB) return true;
      if (t.pending !== LOOP_PENDING.NONE) return true;
      if (t.audible) return true;
    }
    return false;
  }

  /** The track's own effect chain, created on first use. Null for a bad index. */
  chainFor(index) {
    const t = this.track(index);
    if (!t) return null;
    if (!t.chain) t.chain = new Chain(this.sr, this.maxBlock);
    return t.chain;
  }

  /**
   * Allocate a track's recording buffer. Called at ARM time — a control command, off the
   * render — and only ever once per track.
   */
  _ensureBuffer(t) {
    if (t.bufL) return true;
    t.bufL = new Float32Array(t.maxFrames);
    t.bufR = new Float32Array(t.maxFrames);
    return true;
  }

  _ensureUndo() {
    if (this.undoL) return true;
    this.undoL = new Float32Array(this.maxFrames);
    this.undoR = new Float32Array(this.maxFrames);
    return true;
  }

  /**
   * Schedule an action, or run it now. A tempo-locked track with a live grid waits for
   * the next grid line; everything else punches immediately. Asking for the action that
   * is already pending cancels it, which is what every looper's second press does.
   */
  _schedule(t, action, clock) {
    if (t.pending === action) {
      t.pending = LOOP_PENDING.NONE;
      return;
    }
    const quantised = t.sync && clock && clock.running && clock.gridFrames > 0;
    if (!quantised) {
      t.pending = LOOP_PENDING.NONE;
      this._applyAction(t, action, clock, clock ? clock.frame : 0);
      return;
    }
    t.pending = action;
    t.pendingAt = clock.frame + clock.framesToGrid(clock.frame);
  }

  /**
   * The one-button record: empty -> record, recording -> close the loop and play,
   * playing -> overdub, overdubbing -> back to play, stopped -> play and overdub.
   */
  recordToggle(index, clock) {
    const t = this.track(index);
    if (!t) return;
    this._ensureBuffer(t);
    if (t.frames > 0) this._ensureUndo();
    this._schedule(t, LOOP_PENDING.REC, clock);
  }

  /** Play <-> stop. Does nothing to an empty track. */
  playToggle(index, clock) {
    const t = this.track(index);
    if (!t || t.state === LOOP_STATE.EMPTY) return;
    this._schedule(t, t.playing ? LOOP_PENDING.STOP : LOOP_PENDING.PLAY, clock);
  }

  stop(index, clock) {
    const t = this.track(index);
    if (!t || t.state === LOOP_STATE.EMPTY) return;
    this._schedule(t, LOOP_PENDING.STOP, clock);
  }

  /**
   * Drop the track's audio. Immediate and unquantised: clear is a decision, not a
   * musical event, and waiting a bar to obey it feels broken.
   */
  clear(index) {
    const t = this.track(index);
    if (!t) return;
    t.state = LOOP_STATE.EMPTY;
    t.pending = LOOP_PENDING.NONE;
    t.frames = 0;
    t.recWrite = 0;
    t.pos = 0;
    t.posNorm = 0;
    t.layers = 0;
    t.lastWrite = -1;
    t.recRamp = 0;
    t.meter = 0;
    t.playGain.reset(0);
    if (t.chain) t.chain.panic();
    if (this.undoTrack === t.index) this._dropUndo();
  }

  clearAll() {
    for (let i = 0; i < this.tracks.length; i++) this.clear(i);
  }

  /**
   * Undo/redo the most recent record or overdub. One slot for the whole looper, so this
   * only ever applies to the last thing recorded, on whichever track that was.
   */
  undo(index) {
    const t = this.track(index);
    if (!t || this.undoTrack !== t.index || this.undoMode === UNDO_NONE) return;
    if (this.undoArmed) return; // mid-overdub: nothing committed to undo yet

    if (this.undoMode === UNDO_TAKE) {
      // The first take. Undo drops the length; the audio is untouched, so redo is free.
      if (this.undoApplied) {
        t.frames = 0;
        t.state = LOOP_STATE.EMPTY;
        t.layers = 0;
        t.playGain.set(0);
        this.undoApplied = false;
      } else {
        t.frames = this.undoFrames;
        t.state = LOOP_STATE.STOPPED;
        t.layers = 1;
        this.undoApplied = true;
      }
      return;
    }

    const n = Math.min(this.undoFrames, t.frames);
    if (!this.undoL || !t.bufL || n <= 0) return;
    const uL = this.undoL;
    const uR = this.undoR;
    const bL = t.bufL;
    const bR = t.bufR;
    if (this.undoApplied) {
      for (let i = 0; i < n; i++) {
        bL[i] -= uL[i];
        bR[i] -= uR[i];
      }
      t.layers = Math.max(1, t.layers - 1);
      this.undoApplied = false;
    } else {
      for (let i = 0; i < n; i++) {
        bL[i] += uL[i];
        bR[i] += uR[i];
      }
      t.layers = t.layers + 1;
      this.undoApplied = true;
    }
  }

  /** True when `undo()` on this track would do something. */
  canUndo(index) {
    return this.undoTrack === (index | 0) && this.undoMode !== UNDO_NONE && !this.undoArmed;
  }

  _dropUndo() {
    this.undoTrack = -1;
    this.undoFrames = 0;
    this.undoMode = UNDO_NONE;
    this.undoApplied = false;
    this.undoArmed = false;
  }

  setTrackParam(index, key, value) {
    const t = this.track(index);
    if (!t) return;
    switch (key) {
      case "gain":
        t.gainDb = clamp(value, -60, 12);
        t.gain = t.gainDb <= -60 ? 0 : dbToGain(t.gainDb);
        break;
      case "mute":
        t.muted = value >= 0.5;
        break;
      case "solo":
        t.soloed = value >= 0.5;
        break;
      case "pan": {
        // A BALANCE law, not the constant-power pan the drum pads use, and deliberately
        // so. A pad is a mono voice, where constant power (0.707 a side at centre) is
        // right. A loop track is a STEREO recording of the bus, and two things follow:
        // a centred loop has to play back at exactly the level it was recorded, or an
        // overdub would not match the live signal it is layered against; and there is
        // no single position to place — L and R already hold their own material, so the
        // control can only trim the opposite side. Unity at centre, linear taper out.
        t.pan = clamp(value, -1, 1);
        t.panL = t.pan <= 0 ? 1 : 1 - t.pan;
        t.panR = t.pan >= 0 ? 1 : 1 + t.pan;
        break;
      }
      case "sync": {
        const on = value >= 0.5;
        if (on !== t.sync) {
          t.sync = on;
          // Switching a playing track between modes: hand the position over rather than
          // jumping. Free mode adopts where the clock-derived position currently is, and
          // tempo-locked mode re-anchors so position 0 stays where the counter is.
          t.pos = t.frames > 0 ? t.pos % t.frames : 0;
        }
        break;
      }
      case "source":
        t.source = clamp(Math.round(value), 0, 1);
        break;
    }
  }

  setParam(key, value) {
    switch (key) {
      case "gain":
        this.gainDb = clamp(value, -60, 12);
        this.gain = this.gainDb <= -60 ? 0 : dbToGain(this.gainDb);
        break;
      case "mute":
        this.muted = value >= 0.5;
        break;
    }
  }

  /** Stop everything and silence the chains, keeping the recorded audio. Panic. */
  reset() {
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i];
      t.pending = LOOP_PENDING.NONE;
      if (t.state === LOOP_STATE.REC) {
        // A take interrupted by a panic is not a loop; drop it rather than keeping a
        // half-recorded fragment nobody asked for.
        this.clear(i);
        continue;
      }
      if (t.state !== LOOP_STATE.EMPTY) t.state = LOOP_STATE.STOPPED;
      t.playGain.reset(0);
      t.recRamp = 0;
      t.meter = 0;
      if (t.chain) t.chain.panic();
    }
    this.undoArmed = false;
    this.meterL = 0;
    this.meterR = 0;
  }

  // ------------------------------------------------------- state transitions

  /**
   * Apply one action at an exact frame. Called either from a control command (immediate)
   * or from inside the render loop at the scheduled sample.
   */
  _applyAction(t, action, clock, frame) {
    if (action === LOOP_PENDING.REC) {
      if (t.state === LOOP_STATE.REC) this._closeTake(t, clock);
      else if (t.state === LOOP_STATE.OVERDUB) this._endOverdub(t);
      else if (t.frames > 0) this._beginOverdub(t, frame);
      else this._beginTake(t, frame);
      return;
    }
    if (action === LOOP_PENDING.PLAY) {
      if (t.state === LOOP_STATE.REC) this._closeTake(t, clock);
      else if (t.frames > 0) this._beginPlay(t, frame);
      return;
    }
    if (action === LOOP_PENDING.STOP) {
      if (t.state === LOOP_STATE.REC) this._closeTake(t, clock, true);
      else if (t.state === LOOP_STATE.OVERDUB) {
        this._endOverdub(t);
        t.state = LOOP_STATE.STOPPED;
        t.playGain.set(0);
      } else if (t.state === LOOP_STATE.PLAY) {
        t.state = LOOP_STATE.STOPPED;
        t.playGain.set(0);
      }
    }
  }

  /** Start the first take. Loop position 0 is here. */
  _beginTake(t, frame) {
    if (!t.bufL) this._ensureBuffer(t);
    t.state = LOOP_STATE.REC;
    t.recWrite = 0;
    t.pos = 0;
    t.anchor = frame;
    t.layers = 0;
    t.recRamp = 0;
    t.lastWrite = -1;
    t.playGain.reset(0);
  }

  /**
   * Close the first take: decide the loop length, then play (or stop, if that is what
   * was asked for). A tempo-locked take is rounded to the nearest whole grid unit, which
   * is what lets a human punch out roughly on the beat and still get a loop that locks.
   */
  _closeTake(t, clock, thenStop) {
    this._declickOut(t);
    let len = t.recWrite;
    const g = t.sync && clock && clock.gridFrames > 0 ? clock.gridFrames : 0;
    if (g > 0) {
      len = Math.max(g, Math.round(len / g) * g);
      if (len > t.maxFrames) len = Math.max(g, Math.floor(t.maxFrames / g) * g);
    }
    if (len < MIN_LOOP_FRAMES || t.recWrite < MIN_LOOP_FRAMES) {
      // Too short to be a loop — a stray double-click, not a performance.
      this.clear(t.index);
      return;
    }
    if (len > t.maxFrames) len = t.maxFrames;
    // Rounding UP past what was actually played leaves a tail that was never written.
    // Zero it, or the previous take's audio reappears in the gap.
    if (len > t.recWrite && t.bufL) {
      for (let i = t.recWrite; i < len; i++) {
        t.bufL[i] = 0;
        t.bufR[i] = 0;
      }
    }
    t.frames = len;
    t.layers = 1;
    t.recRamp = 0;
    // The take is the undo slot's contents now: undoing it drops the length.
    this.undoTrack = t.index;
    this.undoFrames = len;
    this.undoMode = UNDO_TAKE;
    this.undoApplied = true;
    this.undoArmed = false;
    if (thenStop) {
      t.state = LOOP_STATE.STOPPED;
      t.playGain.set(0);
      return;
    }
    t.state = LOOP_STATE.PLAY;
    t.playGain.set(1);
  }

  /** Start overdubbing onto an existing loop, capturing the new layer for undo. */
  _beginOverdub(t, frame) {
    if (!t.bufL || t.frames <= 0) return;
    this._ensureUndo();
    // Only the loop's own length is cleared, not the whole 30-second slot: at a typical
    // 2-8 second loop that is a fraction of a millisecond of memset.
    const n = Math.min(t.frames, this.maxFrames);
    if (this.undoL) {
      for (let i = 0; i < n; i++) {
        this.undoL[i] = 0;
        this.undoR[i] = 0;
      }
    }
    this.undoTrack = t.index;
    this.undoFrames = n;
    this.undoMode = UNDO_LAYER;
    this.undoApplied = true;
    this.undoArmed = true;
    t.state = LOOP_STATE.OVERDUB;
    t.recRamp = 0;
    t.lastWrite = -1;
    if (!t.sync) t.pos = t.pos % t.frames;
    t.playGain.set(1);
  }

  _endOverdub(t) {
    this._declickOut(t);
    t.state = LOOP_STATE.PLAY;
    t.layers = t.layers + 1;
    t.recRamp = 0;
    this.undoArmed = false;
    t.playGain.set(1);
  }

  _beginPlay(t, frame) {
    if (t.frames <= 0) return;
    t.state = LOOP_STATE.PLAY;
    // A free-running track has no grid to align to, so it restarts from the top; a
    // tempo-locked one keeps its anchor and comes back in phase with everything else.
    if (!t.sync) t.pos = 0;
    t.playGain.set(1);
  }

  /**
   * Fade the tail of what was just recorded, so the punch-out does not leave a step in
   * the buffer. During an overdub the ramp is applied to the new layer only — the undo
   * slot holds exactly that layer, which is what makes it possible to fade it without
   * touching the material underneath.
   */
  _declickOut(t) {
    if (!t.bufL) return;
    const d = this.declick;
    if (t.state === LOOP_STATE.REC) {
      const last = t.recWrite - 1;
      const n = Math.min(d, t.recWrite);
      for (let k = 0; k < n; k++) {
        const idx = last - k;
        if (idx < 0) break;
        const f = k / n;
        t.bufL[idx] *= f;
        t.bufR[idx] *= f;
      }
      return;
    }
    if (t.state === LOOP_STATE.OVERDUB && t.lastWrite >= 0 && t.frames > 0 && this.undoL) {
      const len = t.frames;
      const n = Math.min(d, len);
      for (let k = 0; k < n; k++) {
        let idx = t.lastWrite - k;
        while (idx < 0) idx += len;
        const f = k / n;
        // Scale the layer down to `f` by removing the part we no longer want.
        const dl = this.undoL[idx] * (1 - f);
        const dr = this.undoR[idx] * (1 - f);
        t.bufL[idx] -= dl;
        t.bufR[idx] -= dr;
        this.undoL[idx] -= dl;
        this.undoR[idx] -= dr;
      }
    }
  }

  // ---------------------------------------------------------------- meters

  /**
   * Write the looper's meter block into `out` at `offset`.
   * Layout: [bpmless header is the engine's job] then per track, stride
   * `LOOP_METER_STRIDE`: state, pending, meter, position 0..1, length frames, chain
   * length, layers, undo-available.
   */
  readMeters(out, offset) {
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i];
      const o = offset + i * LOOP_METER_STRIDE;
      out[o] = t.state;
      out[o + 1] = t.pending;
      out[o + 2] = t.meter;
      out[o + 3] = t.posNorm;
      out[o + 4] = t.state === LOOP_STATE.REC ? t.recWrite : t.frames;
      out[o + 5] = t.chain ? t.chain.length : 0;
      out[o + 6] = t.layers;
      out[o + 7] = this.canUndo(i) ? 1 : 0;
    }
    return this.tracks.length * LOOP_METER_STRIDE;
  }

  // ---------------------------------------------------------------- audio

  /**
   * Render every track ADDITIVELY into L/R.
   *
   * @param {object} src    record sources: { masterL, masterR, drumL, drumR }. A null
   *                        buffer reads as silence, which is what the drum source is
   *                        when the rack is idle.
   * @param {Float32Array} L
   * @param {Float32Array} R
   * @param {number} frames
   * @param {import("./clock.js").Clock} clock
   */
  process(src, L, R, frames, clock) {
    const clockFrame = clock ? clock.frame : 0;
    const sources = src || this.nullSrc;

    let anySolo = false;
    for (let i = 0; i < this.tracks.length; i++) {
      if (this.tracks[i].soloed && this.tracks[i].state !== LOOP_STATE.EMPTY) anySolo = true;
    }

    const busL = this.busL;
    const busR = this.busR;
    for (let i = 0; i < frames; i++) {
      busL[i] = 0;
      busR[i] = 0;
    }

    let sounded = false;
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti];
      // Skip a track that has nothing to do: empty, or stopped with its fade finished.
      // A track that is merely muted is still rendered — it costs little, and its
      // position has to keep moving or the UI playhead freezes on a loop that is still
      // very much in time and one click from being heard again.
      const idle =
        t.pending === LOOP_PENDING.NONE &&
        !t.recording &&
        !t.playing &&
        t.playGain.settled &&
        t.playGain.value <= 1e-4;
      if (idle) {
        t.meter = 0;
        t.posNorm = 0;
        continue;
      }

      // Target level for this block: silence unless it is playing, unmuted, and either
      // soloed or nothing else is.
      const wantGain = t.playing && !t.muted && (!anySolo || t.soloed) ? 1 : 0;
      t.playGain.set(wantGain);

      const chain = t.chain;
      if (chain && chain.length > 0) {
        const trkL = this.trkL;
        const trkR = this.trkR;
        for (let i = 0; i < frames; i++) {
          trkL[i] = 0;
          trkR[i] = 0;
        }
        this._renderTrack(t, sources, trkL, trkR, frames, clock, clockFrame);
        chain.process(trkL, trkR, frames);
        for (let i = 0; i < frames; i++) {
          busL[i] += trkL[i];
          busR[i] += trkR[i];
        }
      } else {
        this._renderTrack(t, sources, busL, busR, frames, clock, clockFrame);
      }
      sounded = true;
    }

    if (!sounded || this.muted) {
      this.meterL = 0;
      this.meterR = 0;
      return;
    }

    let pkL = 0;
    let pkR = 0;
    const g = this.gain;
    for (let i = 0; i < frames; i++) {
      const l = sanitize(busL[i] * g);
      const r = sanitize(busR[i] * g);
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > pkL) pkL = al;
      if (ar > pkR) pkR = ar;
      L[i] += l;
      R[i] += r;
    }
    this.meterL = pkL;
    this.meterR = pkR;
  }

  /**
   * One track, rendered additively into dst. Playback, recording, overdubbing and
   * sample-accurate punches all happen in this single pass — they have to, because a
   * punch can change the state half way through a block and everything downstream of it
   * (whether to read, where to write) depends on the new state.
   */
  _renderTrack(t, src, dstL, dstR, frames, clock, clockFrame) {
    const recL = t.source === LOOP_SOURCE.DRUMS ? src.drumL : src.masterL;
    const recR = t.source === LOOP_SOURCE.DRUMS ? src.drumR : src.masterR;
    const d = this.declick;
    // These four are re-read after a punch fires: an action applied mid-block can
    // allocate the track buffer and can arm the undo slot, and a stale copy would lose
    // the first partial block of a take (silence) or of an overdub (undo residue).
    let bufL = t.bufL;
    let bufR = t.bufR;
    let undoOn = this.undoArmed && this.undoTrack === t.index && this.undoMode === UNDO_LAYER;
    let uL = this.undoL;
    let uR = this.undoR;
    let pk = 0;
    let lastPos = -1;

    for (let i = 0; i < frames; i++) {
      const frame = clockFrame + i;

      if (t.pending !== LOOP_PENDING.NONE && frame >= t.pendingAt) {
        const action = t.pending;
        t.pending = LOOP_PENDING.NONE;
        this._applyAction(t, action, clock, frame);
        bufL = t.bufL;
        bufR = t.bufR;
        uL = this.undoL;
        uR = this.undoR;
        undoOn = this.undoArmed && this.undoTrack === t.index && this.undoMode === UNDO_LAYER;
      }

      const len = t.frames;
      const st = t.state;
      const playing = st === LOOP_STATE.PLAY || st === LOOP_STATE.OVERDUB;

      // ---- position -----------------------------------------------------
      let pos = -1;
      if (len > 0 && bufL) {
        if (t.sync) {
          let rel = frame - t.anchor;
          rel %= len;
          if (rel < 0) rel += len;
          pos = rel;
        } else {
          pos = t.pos;
          if (pos >= len) pos = 0;
        }
      }

      // ---- playback -----------------------------------------------------
      const pg = t.playGain.next();
      if (pos >= 0 && pg > 1e-5) {
        const l = bufL[pos] * pg * t.gain;
        const r = bufR[pos] * pg * t.gain;
        dstL[i] += l * t.panL;
        dstR[i] += r * t.panR;
        const a = l < 0 ? -l : l;
        if (a > pk) pk = a;
      }

      // ---- recording ----------------------------------------------------
      if (st === LOOP_STATE.REC && bufL) {
        const w = t.recWrite;
        if (w < t.maxFrames) {
          const rg = t.recRamp < d ? t.recRamp / d : 1;
          t.recRamp++;
          bufL[w] = (recL ? recL[i] : 0) * rg;
          bufR[w] = (recR ? recR[i] : 0) * rg;
          t.recWrite = w + 1;
          t.lastWrite = w;
          const a = bufL[w] < 0 ? -bufL[w] : bufL[w];
          if (a > pk) pk = a;
        } else {
          // The buffer is full. Closing the loop is the only honest option: silently
          // dropping the rest of a take, or stopping without a loop, both look broken.
          this._closeTake(t, clock);
        }
      } else if (st === LOOP_STATE.OVERDUB && pos >= 0 && bufL) {
        const rg = t.recRamp < d ? t.recRamp / d : 1;
        t.recRamp++;
        const x = (recL ? recL[i] : 0) * rg;
        const y = (recR ? recR[i] : 0) * rg;
        bufL[pos] += x;
        bufR[pos] += y;
        if (undoOn && uL) {
          uL[pos] += x;
          uR[pos] += y;
        }
        t.lastWrite = pos;
        const a = x < 0 ? -x : x;
        if (a > pk) pk = a;
      }

      // ---- free-running position advance --------------------------------
      if (!t.sync && len > 0 && pos >= 0 && (playing || pg > 1e-5)) {
        let p = pos + 1;
        if (p >= len) p = 0;
        t.pos = p;
      }
      if (pos >= 0) lastPos = pos;
    }

    t.meter = pk;
    if (t.state === LOOP_STATE.REC) {
      t.posNorm = t.maxFrames > 0 ? t.recWrite / t.maxFrames : 0;
    } else if (t.frames > 0 && lastPos >= 0) {
      t.posNorm = lastPos / t.frames;
    } else {
      t.posNorm = 0;
    }
  }
}
