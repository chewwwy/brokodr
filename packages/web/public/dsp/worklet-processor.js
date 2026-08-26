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
};

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
    this.meterScratch = new Float32Array(48);
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
    if (m.t === "pcmds") {
      // Fallback transport for when SharedArrayBuffer is unavailable (no COOP/COEP).
      // Same opcodes, delivered as a batched flat array instead of the ring buffer.
      const a = m.a;
      for (let i = 0; i + 3 < a.length; i += 4) this.#applyOp(a[i], a[i + 1], a[i + 2], a[i + 3]);
      return;
    }
    if (m.t === "ping") {
      this.port.postMessage({ t: "pong", time: currentTime });
    }
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
      this.#applyOp(this.cmdData[base], this.cmdData[base + 1], this.cmdData[base + 2], this.cmdData[base + 3]);
      r++;
    }
    Atomics.store(this.cmdHeader, 1, r);
  }

  /** Decode one numeric command. Shared by the ring buffer and the postMessage fallback. */
  #applyOp(op, id, key, value) {
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
      // No mic (device gone, permission revoked, or the user is running file-only).
      // The engine still has to run: a loaded file is a valid source on its own, and
      // bailing here would silence file playback whenever the input is absent.
      this.#drainCommands();
      if (this.engine.player.loaded && this.engine.fileRoute !== 0) {
        const sl = this.silentL;
        const sr = this.silentR;
        this.engine.process(sl.subarray(0, frames), sr.subarray(0, frames), outL, outR, frames);
        this.#publishScope(sl, sr, outL, outR, frames);
        this.#publishRecording(this.engine.dryL, this.engine.dryR, outL, outR, frames);
      } else {
        outL.fill(0);
        if (outR !== outL) outR.fill(0);
      }
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
