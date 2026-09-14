/**
 * Bro.Kodr — AudioWorklet backend.
 *
 * This is the ONLY file in /dsp that knows AudioWorklet exists. It is a thin adapter:
 * it owns the real-time thread, drains control commands, calls Engine.process(), and
 * publishes meters/scope/recording through SharedArrayBuffers. Swapping in a native
 * backend means writing an equivalent ~200-line adapter — the Engine and every effect
 * are untouched.
 *
 * Why SharedArrayBuffer instead of postMessage for the hot paths:
 *   - postMessage allocates and queues on the audio thread; at 375 blocks/sec with
 *     meters + scope data that is real GC pressure inside the audio callback.
 *   - SAB + Atomics gives a lock-free, allocation-free, wait-free handoff. The audio
 *     thread never blocks on the UI, which is exactly the isolation requirement.
 *
 * Ring buffer protocol (single producer, single consumer, no locks):
 *   Control (UI -> audio): Int32 header [writeIdx, readIdx] + Float64 command records.
 *   Meters  (audio -> UI): double-buffered Float32 block + Atomics sequence counter.
 *   Scope   (audio -> UI): power-of-two circular Float32 buffer + Atomic write index.
 *   Record  (audio -> UI): two circular Float32 buffers (pre/post) + Atomic write index.
 */

import { Engine } from "./engine.js";

const CMD_SLOTS = 1024;
const CMD_STRIDE = 6; // [type, id, key, value, aux1, aux2]

// Command opcodes — numeric so the ring buffer stays a plain Float64Array.
const OP = {
  PARAM: 1,
  MIX: 2,
  BYPASS: 3,
  MOVE: 4,
  IO: 5,
  CLIPRESET: 6,
  RESET: 7,
  PANIC: 8,
  REC_STATE: 9,
  FILE: 10,
  PAD: 11,      // BROBEATS pad: trigger, release, per-pad param
  DRUM: 12,     // BROBEATS rack: gain, mute, solo, route
  PADFX: 13,    // a param on an effect inside a pad's own chain
  LOOP: 14,     // loop track: transport verbs + per-track params
  LOOPER: 15,   // looper bus: gain, mute
  CLOCK: 16,    // transport: bpm, bar length, quantise grid, run, reset
  LOOPFX: 17,   // a param on an effect inside a loop track's own chain
  VOICE: 18,    // Smart Voice: one parameter, by wire key
  VOICECAL: 19, // Smart Voice calibration: centroids, class->pad, capture control
};

// Smart Voice parameter names, indexed by wire key. Mirrors VOICE_KEY in
// core/beat-classify.js — scripts/verify-engine-voice.mjs fails if the two drift.
// APPEND ONLY, same reason as every other key table here.
const VOICE_KEY = [
  "enabled", "sensitivity", "floorDb", "minGapMs", "featureMs",
  "mode", "margin", "velMin", "velDb", "monitor",
];

// Calibration sub-fields for OP.VOICECAL. `id` carries the class index where one
// applies, `aux1` the feature/band index, `value` the number.
const VOICE_CAL = {
  CENTROID: 0,
  ATTACK: 1,
  PAD: 2,
  CAPTURE: 3,
  CLEAR: 4,
  RESET: 5,
  DETRESET: 6,
};

// Loop sub-fields for OP.LOOP. `id` carries the track index. Transport verbs are
// separate fields rather than a key table because they take no value — a record punch
// is the single most latency-sensitive thing in the app after a pad hit.
const LOOP_FIELD = { REC: 0, PLAY: 1, STOP: 2, CLEAR: 3, UNDO: 4, PARAM: 5, CLEARALL: 6 };
// Per-track parameter names, indexed by wire key. Mirrors LOOP_KEY in core/looper.js.
// APPEND ONLY — never reorder or delete, the index is what presets and the ring store.
const LOOP_KEY = ["gain", "mute", "solo", "pan", "sync", "source"];
// Looper-bus parameter names for OP.LOOPER. APPEND ONLY, same reason.
const LOOPER_KEY = ["gain", "mute"];
// Transport parameter names for OP.CLOCK. APPEND ONLY, same reason.
const CLOCK_KEY = ["bpm", "beatsPerBar", "quantize", "run", "reset"];

// Pad sub-fields for OP.PAD. `id` carries the pad index.
const PAD_FIELD = { TRIGGER: 0, RELEASE: 1, PARAM: 2 };
// Pad parameter names, indexed by wire key. APPEND ONLY — never reorder or delete, the
// index is what presets and the command ring store.
const PAD_KEY = [
  "attack", "decay", "sustain", "release", "hold",
  "pitch", "start", "reverse", "gain", "pan",
  "mode", "velAmount", "choke", "mute",
];
// Rack sub-fields for OP.DRUM. APPEND ONLY, same reason.
const DRUM_KEY = ["gain", "mute", "solo", "route"];

// File-transport sub-fields for OP.FILE.
const FILE_FIELD = {
  PLAY: 0,
  SEEK: 1,
  LOOP: 2,
  LOOP_IN: 3,
  LOOP_OUT: 4,
  SPEED: 5,
  PITCH: 6,
  GAIN: 7,
  ROUTE: 8,
};
const FILE_KEY = ["play", "seek", "loop", "loopin", "loopout", "speed", "pitch", "gain"];

// IO sub-fields for OP.IO
const IO_FIELD = {
  IN_GAIN: 0,
  OUT_GAIN: 1,
  MUTE: 2,
  BYPASS: 3,
  MONO: 4,
  SWAP: 5,
  MASTER_MIX: 6,
};

class VowkodrProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};

    this.engine = new Engine(sampleRate, 512);
    this.blockFrames = 128;

    // ---- shared memory wiring -------------------------------------------
    this.cmdHeader = o.cmdHeader ? new Int32Array(o.cmdHeader) : null;
    this.cmdData = o.cmdData ? new Float64Array(o.cmdData) : null;

    this.meterSeq = o.meterSeq ? new Int32Array(o.meterSeq) : null;
    this.meterData = o.meterData ? new Float32Array(o.meterData) : null;
    // Must match METER_FIELDS in src/web/audio/worklet-backend.ts, which sizes the
    // shared block this is copied into. 192 covers engine + slots + file + BROBEATS +
    // looper (68..107) + Smart Voice (108..126), with room for the next block to be
    // appended. It was 128, which Smart Voice filled to within one field.
    this.meterScratch = new Float32Array(192);
    // One calibration capture row, reused by the "getvoicecaps" pull so the handler
    // allocates only the reply it has to post.
    this.voiceCapRow = new Float32Array(this.engine.voiceCaptureStride);
    // Preallocated silence, used as the mic substitute when there is no live input but
    // the file player is the source. Never allocate on the audio thread.
    this.silentL = new Float32Array(512);
    this.silentR = new Float32Array(512);

    this.scopeIdx = o.scopeIdx ? new Int32Array(o.scopeIdx) : null;
    this.scopeIn = o.scopeIn ? new Float32Array(o.scopeIn) : null;
    this.scopeOut = o.scopeOut ? new Float32Array(o.scopeOut) : null;
    this.scopeMask = this.scopeIn ? this.scopeIn.length - 1 : 0;
    this.scopeWrite = 0;

    this.recIdx = o.recIdx ? new Int32Array(o.recIdx) : null;
    this.recDry = o.recDry ? new Float32Array(o.recDry) : null;
    this.recWet = o.recWet ? new Float32Array(o.recWet) : null;
    this.recCapacity = this.recWet ? this.recWet.length >> 1 : 0; // interleaved stereo
    this.recWrite = 0;
    this.recording = 0;
    this.recPaused = 0;
    this.recOverflow = 0;

    // Non-shared fallback state, used only when SharedArrayBuffer is unavailable.
    this.fbCount = 0;
    this.fbScopeIn = new Float32Array(1024);
    this.fbScopeOut = new Float32Array(1024);
    this.fbScopeW = 0;
    this.fbRecL = new Float32Array(8192);
    this.fbRecR = new Float32Array(8192);
    this.fbRecW = 0;

    // Ports for structural commands (add/remove/clear) which need strings.
    this.port.onmessage = (e) => this.#onMessage(e.data);

    // CPU load measurement — exponential average of (processing time / block period).
    this.loadAvg = 0;
    this.blockPeriodMs = (this.blockFrames / sampleRate) * 1000;

    this.port.postMessage({ t: "ready", sampleRate, maxBlock: 512 });
  }

  #onMessage(m) {
    if (!m) return;
    if (m.t === "cmds") {
      // Structural commands arrive as a batch of plain objects.
      for (const c of m.list) this.engine.applyCommand(c);
      this.#reportChain();
      return;
    }
    if (m.t === "recstate") {
      // Flush any partial fallback chunk before the state changes, so the tail of a
      // take is never lost.
      if (!this.recWet && this.fbRecW > 0 && (!m.recording || m.reset)) {
        const n = this.fbRecW;
        const l = this.fbRecL.slice(0, n);
        const r = this.fbRecR.slice(0, n);
        this.fbRecW = 0;
        this.recWrite += n;
        this.port.postMessage({ t: "recchunk", l: l.buffer, r: r.buffer, frames: n }, [l.buffer, r.buffer]);
      }
      this.recording = m.recording ? 1 : 0;
      this.recPaused = m.paused ? 1 : 0;
      if (m.reset) {
        this.recWrite = 0;
        this.recOverflow = 0;
        if (this.recIdx) Atomics.store(this.recIdx, 0, 0);
        if (this.recIdx) Atomics.store(this.recIdx, 1, 0);
      }
      return;
    }
    if (m.t === "fileload") {
      // Decoded on the UI thread (decodeAudioData handles WAV and MP3) and handed over
      // as SharedArrayBuffer views, so nothing is copied here regardless of file length.
      const chL = new Float32Array(m.chL);
      const chR = m.chR ? new Float32Array(m.chR) : chL;
      this.engine.applyCommand({ t: "fileload", chL, chR, frames: m.frames, rate: m.rate });
      this.port.postMessage({ t: "fileready", frames: m.frames, rate: m.rate });
      return;
    }
    if (m.t === "padload") {
      // Decoded on the UI thread and handed over as a SharedArrayBuffer view, exactly
      // like a backing track: dropping a 10MB one-shot on a pad copies nothing here.
      const data = new Float32Array(m.data);
      this.engine.applyCommand({
        t: "padload",
        index: m.index,
        layer: m.layer || 0,
        data,
        frames: m.frames,
        rate: m.rate,
      });
      // Echo the pad's layer count back, not just "done": a sample that arrives but does
      // not install (bad length, bad index) is otherwise a silent pad with no explanation.
      const pad = this.engine.drums.pad(m.index);
      this.port.postMessage({
        t: "padready",
        index: m.index,
        layer: m.layer || 0,
        frames: m.frames,
        layers: pad ? pad.layerCount : 0,
      });
      return;
    }
    if (m.t === "padclear") {
      // Wipes the pad's sample layers and its effect chain in one go (the rack does
      // both), then tells the UI the chain is empty now.
      this.engine.applyCommand({ t: "padclear", index: m.index });
      this.#reportPadChain(m.index);
      return;
    }
    if (m.t === "padfx") {
      // Structural pad-chain edits need strings, so they come by message, not the ring.
      this.engine.applyCommand(m);
      this.#reportPadChain(m.index);
      return;
    }
    if (m.t === "loopfx") {
      // Structural loop-chain edits need strings, so they come by message, not the ring.
      this.engine.applyCommand(m);
      this.#reportLoopChain(m.index);
      return;
    }
    if (m.t === "fileclear") {
      this.engine.applyCommand({ t: "fileclear" });
      return;
    }
    if (m.t === "getvisual") {
      // EQ curve / module-specific display data, pulled on demand (not per block).
      const slot = this.engine.slots.find((s) => s.id === m.id);
      const v = slot && slot.effect.visual ? slot.effect.visual : null;
      this.port.postMessage({ t: "visual", id: m.id, data: v ? Array.from(v) : null });
      return;
    }
    if (m.t === "getlooppeaks") {
      // The loop deck's waveform. Pulled on demand — after a take, an overdub, or an
      // undo — never per frame: the buffer is seconds long and the shape only changes
      // when the audio does. min/max per bucket, interleaved, so a bipolar waveform
      // reads as its real shape rather than a rectified blob.
      this.port.postMessage({ t: "looppeaks", index: m.index | 0, data: this.#loopPeaks(m.index | 0, m.buckets | 0) });
      return;
    }
    if (m.t === "getvoicecaps") {
      // Calibration captures, pulled by the calibration panel while it is open. A pull
      // rather than a meter field because a row is CAP_STRIDE numbers and there are up
      // to 64 of them: that has no business in a block the UI reads every frame.
      // Returns rows from `from` onward, flat, with how many and where they started —
      // the ring may have moved on, and the panel has to know which hits it missed.
      const stride = this.engine.voiceCaptureStride;
      const row = this.voiceCapRow;
      const want = Math.max(0, Math.min(64, (m.max | 0) || 64));
      const total = this.engine.voice.captureCount;
      let first = Math.max(0, m.from | 0);
      if (first < total - 64) first = total - 64;
      const rows = [];
      for (let n = first; n < total && rows.length / stride < want; n++) {
        if (!this.engine.readVoiceCapture(n, row)) continue;
        for (let i = 0; i < stride; i++) rows.push(row[i]);
      }
      this.port.postMessage({ t: "voicecaps", from: first, total, stride, rows });
      return;
    }
    if (m.t === "pcmds") {
      // Fallback transport for when SharedArrayBuffer is unavailable (no COOP/COEP).
      // Same opcodes, delivered as a batched flat array instead of the ring buffer.
      const a = m.a;
      for (let i = 0; i + 5 < a.length; i += 6) {
        this.#applyOp(a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5]);
      }
      return;
    }
    if (m.t === "ping") {
      this.port.postMessage({ t: "pong", time: currentTime });
    }
  }

  /**
   * min/max peaks for one loop track's recorded audio, interleaved [lo,hi] per bucket.
   * Returns null when the track has nothing recorded. Allocates — deliberately, this
   * runs off the render path in response to a UI pull, not per block.
   */
  #loopPeaks(index, buckets) {
    const track = this.engine.looper.track(index);
    if (!track || !track.bufL || track.frames <= 0) return null;
    const n = Math.max(1, Math.min(4096, buckets || 480));
    const frames = track.frames;
    const out = new Array(n * 2);
    const l = track.bufL;
    const r = track.bufR || track.bufL;
    for (let b = 0; b < n; b++) {
      const start = Math.floor((b * frames) / n);
      const end = Math.max(start + 1, Math.floor(((b + 1) * frames) / n));
      let lo = 0;
      let hi = 0;
      for (let i = start; i < end; i++) {
        const v = (l[i] + r[i]) * 0.5;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      out[b * 2] = lo;
      out[b * 2 + 1] = hi;
    }
    return out;
  }

  #reportPadChain(index) {
    const chain = this.engine.drums.padChains[index | 0];
    this.port.postMessage({
      t: "padchain",
      index: index | 0,
      order: chain ? chain.slots.map((s) => ({ id: s.id, type: s.type, bypassed: s.bypassed })) : [],
    });
  }

  #reportLoopChain(index) {
    const track = this.engine.looper.track(index | 0);
    const chain = track ? track.chain : null;
    this.port.postMessage({
      t: "loopchain",
      index: index | 0,
      order: chain ? chain.slots.map((s) => ({ id: s.id, type: s.type, bypassed: s.bypassed })) : [],
    });
  }

  #reportChain() {
    this.port.postMessage({
      t: "chain",
      order: this.engine.slots.map((s) => ({ id: s.id, type: s.type, bypassed: s.bypassed })),
      latency: this.engine.latencySamples,
    });
  }

  /** Drain the lock-free command ring. Allocation-free. */
  #drainCommands() {
    if (!this.cmdHeader || !this.cmdData) return;
    const w = Atomics.load(this.cmdHeader, 0);
    let r = Atomics.load(this.cmdHeader, 1);
    if (r === w) return;

    while (r !== w) {
      const base = (r % CMD_SLOTS) * CMD_STRIDE;
      this.#applyOp(
        this.cmdData[base],
        this.cmdData[base + 1],
        this.cmdData[base + 2],
        this.cmdData[base + 3],
        this.cmdData[base + 4],
        this.cmdData[base + 5],
      );
      r++;
    }
    Atomics.store(this.cmdHeader, 1, r);
  }

  /** Decode one numeric command. Shared by the ring buffer and the postMessage fallback. */
  #applyOp(op, id, key, value, aux1, aux2) {
    const e = this.engine;
    switch (op) {
      case OP.PARAM: {
        // key is an index into the slot's param name table sent at add time.
        const slot = this.#slotById(id);
        if (slot && slot.paramNames) {
          const name = slot.paramNames[key];
          if (name !== undefined) slot.effect.setParam(name, value);
          if (name === "quality") e.recalcLatency();
        }
        break;
      }
      case OP.MIX:
        e.applyCommand({ t: "mix", id, value });
        break;
      case OP.BYPASS:
        e.applyCommand({ t: "bypass", id, value: value >= 0.5 });
        break;
      case OP.MOVE:
        e.applyCommand({ t: "move", id, index: value | 0 });
        break;
      case OP.IO: {
        const f = key | 0;
        if (f === IO_FIELD.IN_GAIN) e.applyCommand({ t: "io", inGain: value });
        else if (f === IO_FIELD.OUT_GAIN) e.applyCommand({ t: "io", outGain: value });
        else if (f === IO_FIELD.MUTE) e.applyCommand({ t: "io", mute: value >= 0.5 });
        else if (f === IO_FIELD.BYPASS) e.applyCommand({ t: "io", bypass: value >= 0.5 });
        else if (f === IO_FIELD.MONO) e.applyCommand({ t: "io", mono: value >= 0.5 });
        else if (f === IO_FIELD.SWAP) e.applyCommand({ t: "io", swap: value >= 0.5 });
        else if (f === IO_FIELD.MASTER_MIX) e.applyCommand({ t: "io", masterMix: value });
        break;
      }
      case OP.CLIPRESET:
        e.applyCommand({ t: "clipreset" });
        break;
      case OP.RESET:
        e.applyCommand({ t: "reset", id });
        break;
      case OP.PANIC:
        e.applyCommand({ t: "panic" });
        break;
      case OP.PAD: {
        // id = pad index. Trigger is the hot path once Smart Voice is driving it, so it
        // costs one switch and one call — no object, no allocation.
        const f = key | 0;
        if (f === PAD_FIELD.TRIGGER) e.drums.trigger(id | 0, value);
        else if (f === PAD_FIELD.RELEASE) e.drums.release(id | 0);
        else {
          const name = PAD_KEY[aux1 | 0];
          if (name !== undefined) e.drums.setPadParam(id | 0, name, value);
        }
        break;
      }
      case OP.DRUM: {
        const name = DRUM_KEY[key | 0];
        if (name !== undefined) e.applyCommand({ t: "drum", key: name, value });
        break;
      }
      case OP.PADFX: {
        // aux1 = pad index, id = slot id inside that pad's chain, key = param index.
        const chain = e.drums.padChains[aux1 | 0];
        if (!chain) break;
        const slot = chain.find ? chain.find(id) : null;
        if (slot && slot.paramNames) {
          const name = slot.paramNames[key | 0];
          if (name !== undefined) slot.effect.setParam(name, value);
        }
        break;
      }
      case OP.LOOP: {
        // id = track index. A punch is a bare opcode with no payload, so the path from
        // the UI's pointerdown to the looper's arm is one ring slot and one call.
        const f = key | 0;
        if (f === LOOP_FIELD.REC) e.applyCommand({ t: "loop", op: "rec", index: id });
        else if (f === LOOP_FIELD.PLAY) e.applyCommand({ t: "loop", op: "play", index: id });
        else if (f === LOOP_FIELD.STOP) e.applyCommand({ t: "loop", op: "stop", index: id });
        else if (f === LOOP_FIELD.CLEAR) e.applyCommand({ t: "loop", op: "clear", index: id });
        else if (f === LOOP_FIELD.UNDO) e.applyCommand({ t: "loop", op: "undo", index: id });
        else if (f === LOOP_FIELD.CLEARALL) e.applyCommand({ t: "loop", op: "clearall", index: 0 });
        else {
          const name = LOOP_KEY[aux1 | 0];
          if (name !== undefined) e.applyCommand({ t: "loopparam", index: id, key: name, value });
        }
        break;
      }
      case OP.LOOPER: {
        const name = LOOPER_KEY[key | 0];
        if (name !== undefined) e.applyCommand({ t: "looperparam", key: name, value });
        break;
      }
      case OP.CLOCK: {
        const name = CLOCK_KEY[key | 0];
        if (name !== undefined) e.applyCommand({ t: "clock", key: name, value });
        break;
      }
      case OP.LOOPFX: {
        // aux1 = track index, id = slot id inside that track's chain, key = param index.
        const track = e.looper.track(aux1 | 0);
        const chain = track ? track.chain : null;
        if (!chain) break;
        const slot = chain.find ? chain.find(id) : null;
        if (slot && slot.paramNames) {
          const name = slot.paramNames[key | 0];
          if (name !== undefined) slot.effect.setParam(name, value);
        }
        break;
      }
      case OP.VOICE: {
        const name = VOICE_KEY[key | 0];
        if (name !== undefined) e.applyCommand({ t: "voice", key: name, value });
        break;
      }
      case OP.VOICECAL: {
        const f = key | 0;
        const cls = id | 0;
        if (f === VOICE_CAL.CENTROID) {
          e.applyCommand({ t: "voicecal", op: "centroid", cls, feature: aux1 | 0, value });
        } else if (f === VOICE_CAL.ATTACK) {
          e.applyCommand({ t: "voicecal", op: "attack", cls, band: aux1 | 0, value });
        } else if (f === VOICE_CAL.PAD) {
          // A negative value is how the UI mutes a class, so it travels as-is rather
          // than being clamped to a pad index here.
          e.applyCommand({ t: "voicecal", op: "pad", cls, pad: value | 0 });
        } else if (f === VOICE_CAL.CAPTURE) {
          // value < 0 stops capturing; the class to capture rides in `value` so one
          // field covers both, matching setCapture's own -1 convention.
          e.applyCommand({ t: "voicecal", op: "capture", cls: value | 0 });
        } else if (f === VOICE_CAL.CLEAR) {
          e.applyCommand({ t: "voicecal", op: "clear" });
        } else if (f === VOICE_CAL.RESET) {
          e.applyCommand({ t: "voicecal", op: "reset" });
        } else if (f === VOICE_CAL.DETRESET) {
          e.applyCommand({ t: "voicecal", op: "detreset" });
        }
        break;
      }
      case OP.FILE: {
        const f = key | 0;
        if (f === FILE_FIELD.ROUTE) e.applyCommand({ t: "fileroute", value });
        else {
          const name = FILE_KEY[f];
          if (name !== undefined) e.applyCommand({ t: "file", key: name, value });
        }
        break;
      }
    }
  }

  #slotById(id) {
    const slots = this.engine.slots;
    for (let i = 0; i < slots.length; i++) if (slots[i].id === id) return slots[i];
    return null;
  }

  #publishMeters() {
    const s = this.meterScratch;
    if (!this.meterSeq || !this.meterData) {
      // Fallback: no shared memory, so post a snapshot ~30x/sec instead of per block.
      this.fbCount++;
      if (this.fbCount % 12 !== 0) return;
      s.fill(0);
      this.engine.readMeters(s);
      s[10] = this.loadAvg;
      s[13] = this.recording;
      s[14] = this.recWrite;
      s[15] = this.recOverflow;
      this.port.postMessage({
        t: "meters",
        m: Array.from(s),
        scopeIn: Array.from(this.fbScopeIn),
        scopeOut: Array.from(this.fbScopeOut),
        sw: this.fbScopeW,
      });
      return;
    }
    s.fill(0);
    this.engine.readMeters(s);
    s[10] = this.loadAvg;
    s[13] = this.recording;
    s[14] = this.recWrite;
    s[15] = this.recOverflow;

    // Seqlock: odd sequence = write in progress, so the reader can detect a torn read.
    const seq = Atomics.add(this.meterSeq, 0, 1) + 1;
    this.meterData.set(s);
    Atomics.store(this.meterSeq, 0, seq + 1);
  }

  #publishScope(inL, inR, outL, outR, frames) {
    if (!this.scopeIn || !this.scopeOut) {
      // Fallback ring: 1024 mono samples of each, copied out with the meter snapshot.
      const m = this.fbScopeIn.length - 1;
      const fw = this.fbScopeW;
      for (let i = 0; i < frames; i++) {
        const idx = (fw + i) & m;
        this.fbScopeIn[idx] = (inL[i] + inR[i]) * 0.5;
        this.fbScopeOut[idx] = (outL[i] + outR[i]) * 0.5;
      }
      this.fbScopeW = (fw + frames) & m;
      return;
    }
    const mask = this.scopeMask;
    let w = this.scopeWrite;
    for (let i = 0; i < frames; i++) {
      const idx = (w + i) & mask;
      this.scopeIn[idx] = (inL[i] + inR[i]) * 0.5;
      this.scopeOut[idx] = (outL[i] + outR[i]) * 0.5;
    }
    w = (w + frames) & mask;
    this.scopeWrite = w;
    Atomics.store(this.scopeIdx, 0, w);
  }

  #publishRecording(dryL, dryR, wetL, wetR, frames) {
    if (!this.recording || this.recPaused) return;
    if (!this.recWet) {
      // Fallback: chunk the wet take and transfer it out. Dry take is unavailable in
      // this mode — the UI disables the "clean take" option when shared memory is off.
      for (let i = 0; i < frames; i++) {
        this.fbRecL[this.fbRecW] = wetL[i];
        this.fbRecR[this.fbRecW] = wetR[i];
        this.fbRecW++;
        if (this.fbRecW >= this.fbRecL.length) {
          const l = this.fbRecL;
          const r = this.fbRecR;
          this.fbRecL = new Float32Array(l.length);
          this.fbRecR = new Float32Array(r.length);
          this.fbRecW = 0;
          this.recWrite += l.length;
          this.port.postMessage({ t: "recchunk", l: l.buffer, r: r.buffer, frames: l.length }, [l.buffer, r.buffer]);
        }
      }
      return;
    }
    // Circular capture buffer + a monotonic total-frames counter. The UI drains new
    // frames into growable JS chunks on a timer, so take length is unbounded and the
    // shared buffer only needs to cover the poll interval (2 seconds of headroom).
    const cap = this.recCapacity;
    const total = this.recWrite;
    for (let i = 0; i < frames; i++) {
      const o = ((total + i) % cap) * 2;
      this.recWet[o] = wetL[i];
      this.recWet[o + 1] = wetR[i];
      if (this.recDry) {
        this.recDry[o] = dryL[i];
        this.recDry[o + 1] = dryR[i];
      }
    }
    this.recWrite = total + frames;
    Atomics.store(this.recIdx, 0, this.recWrite);
  }

  process(inputs, outputs) {
    const t0 = NOW();
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const frames = output[0].length;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];

    // Handle a disconnected or mono input gracefully — silence, not a crash.
    let inL;
    let inR;
    if (input && input.length > 0 && input[0] && input[0].length === frames) {
      inL = input[0];
      inR = input.length > 1 && input[1] ? input[1] : input[0];
    } else {
      // No mic (device gone, permission revoked, or the user is running file-only or
      // drums-only). The engine still has to run: a loaded file, a BROBEATS pad and the
      // tail of a reverb are all valid sources with no input at all, so feed it silence
      // rather than short-circuiting to zeros — that is what used to make the drum rack
      // mute on a machine with no input device.
      this.#drainCommands();
      const sl = this.silentL;
      const sr = this.silentR;
      this.engine.process(sl.subarray(0, frames), sr.subarray(0, frames), outL, outR, frames);
      this.#publishScope(sl, sr, outL, outR, frames);
      this.#publishRecording(this.engine.dryL, this.engine.dryR, outL, outR, frames);
      this.#publishMeters();
      return true;
    }

    this.#drainCommands();

    this.engine.process(inL, inR, outL, outR, frames);

    this.#publishScope(inL, inR, outL, outR, frames);
    // engine.dryL/dryR hold the post-input-gain pre-effects signal for the clean take.
    this.#publishRecording(this.engine.dryL, this.engine.dryR, outL, outR, frames);
    this.#publishMeters();

    // CPU load: fraction of the block period spent processing. `currentTime` does not
    // advance inside a render quantum, so we need a real wall clock. `performance` is
    // not guaranteed in AudioWorkletGlobalScope, hence the guarded NOW() below; when
    // it is unavailable the UI falls back to AudioContext.renderCapacity.
    if (HAS_CLOCK) {
      const inst = clampLoad((NOW() - t0) / this.blockPeriodMs);
      // A coarse (1 ms) clock quantises every block to 0 or ~1/blockPeriod, so it needs a
      // much longer average to settle; a high-res clock can track load in ~60 ms.
      const a = HI_RES_CLOCK ? 0.05 : 0.004;
      this.loadAvg = this.loadAvg * (1 - a) + inst * a;
    }

    return true;
  }
}

// Clock selection for the CPU-load estimate.
//
// AudioWorkletGlobalScope does NOT expose `performance` in Chromium (verified), and
// `AudioContext.renderCapacity` is not available in every build either, so relying on
// only those two makes the CPU meter read a permanent 0% — worse than useless on a live
// rig, where load is the one number that predicts a dropout.
//
// `Date` is a plain ECMAScript builtin and is always present. Its 1 ms resolution is far
// coarser than a 2.9 ms render quantum, so a single block measures either 0 or 1 ms — but
// truncation is unbiased, and the one-pole average below (~0.05 coefficient, hundreds of
// blocks of memory) converges on the true mean load. The readout is jittery at very low
// load and accurate where it matters.
// eslint-disable-next-line no-undef
const HI_RES_CLOCK = typeof performance !== "undefined" && typeof performance.now === "function";
// eslint-disable-next-line no-undef
const NOW = HI_RES_CLOCK ? () => performance.now() : () => Date.now();
const HAS_CLOCK = true;

function clampLoad(x) {
  return x >= 0 && x < 10 ? x : 0;
}

registerProcessor("brokodr-engine", VowkodrProcessor);
