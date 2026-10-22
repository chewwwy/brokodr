/**
 * Bro.Kodr — AudioWorklet backend (the one that ships and runs).
 *
 * Responsibilities, and nothing else:
 *   - own the AudioContext / MediaStream / AudioWorkletNode lifecycle
 *   - enumerate and select hardware devices, and negotiate sample rate + buffer size
 *   - allocate the shared transport buffers and hand them to the worklet
 *   - write control commands into the lock-free ring
 *   - read meters, scope and recording data back out
 *
 * It contains no DSP. Every sample of processing happens in `public/dsp/*`, which has no
 * idea this file exists.
 *
 * ## Latency, stated honestly
 * Chromium's audio path on Windows is WASAPI in shared mode. Round-trip is roughly
 * 15-35ms depending on the driver and the buffer we manage to negotiate. That is good
 * enough for monitoring while you speak, and it is NOT the 3-8ms an ASIO host gets.
 * Reaching that requires the native backend (see native-backend.ts). `latencyHint` is a
 * hint — Chromium is free to ignore it — so `info().blockFrames` and the measured
 * input/output latency are reported from what we actually got, never from what we asked
 * for.
 *
 * ## Transport
 * Preferred path is SharedArrayBuffer + Atomics, which needs cross-origin isolation
 * (COOP/COEP headers — set in the dev server and the production Hono server). When
 * isolation is unavailable we fall back to batched postMessage: same opcodes, same
 * engine, higher jitter and a ~33ms meter update. The app stays fully functional; the
 * status bar shows which transport is live.
 */

import {
  type AddSlotSpec,
  type AudioDeviceInfo,
  type DeviceList,
  type EngineBackend,
  type EngineInfo,
  type EngineMeters,
  type EngineStatus,
  type FileField,
  type IoField,
  OP,
  PAD_COUNT,
  PAD_FIELD,
  type PadKey,
  padKeyIndex,
  type DrumKey,
  drumKeyIndex,
  LOOP_FIELD,
  LOOP_METER_BASE,
  LOOP_METER_STRIDE,
  LOOP_TRACKS,
  TRANSPORT_METER_BASE,
  type LoopKey,
  loopKeyIndex,
  type LooperKey,
  looperKeyIndex,
  type ClockKey,
  clockKeyIndex,
  VOICE_CAL,
  VOICE_CAPTURE_STRIDE,
  VOICE_CLASS_COUNT,
  VOICE_METER_BASE,
  VOICE_METER_STRIDE,
  type VoiceCapture,
  type VoiceKey,
  voiceKeyIndex,
  type ScopeFrame,
  type StartOptions,
} from "./backend";
import { paramIndex, paramNames } from "./param-schema";

const CMD_SLOTS = 1024;
const CMD_STRIDE = 6;
// Must match `meterScratch` in dsp/worklet-processor.js — it sizes the shared block the
// worklet copies its scratch into, so a short array here silently truncates meters.
// 192 covers engine + per-slot + file + BROBEATS + looper/transport (68..107) +
// Smart Voice (108..126).
const METER_FIELDS = 192;
const SCOPE_SIZE = 8192; // power of two — the worklet masks against it
const MAX_SLOTS = 24;
/** Seconds of capture headroom in shared memory. Drained into JS chunks on a timer. */
const REC_HEADROOM_SEC = 2;

const WORKLET_URL = "/dsp/worklet-processor.js";

let sharedProbe: boolean | null = null;

/**
 * Probes whether a SharedArrayBuffer can actually be handed to another thread here.
 *
 * Checking `crossOriginIsolated` alone is wrong: Electron enables SAB through a feature
 * switch without setting the isolation flag, so we would needlessly fall back on the very
 * platform we target. Instead we attempt the exact serialization step that
 * `postMessage`-ing the buffer to the worklet performs. If that succeeds, the real thing
 * will too; if it throws, we use the fallback transport. Fail-safe in both directions.
 */
function canShare(): boolean {
  if (typeof SharedArrayBuffer === "undefined") return false;
  if (sharedProbe !== null) return sharedProbe;
  try {
    const probe = new SharedArrayBuffer(8);
    structuredClone(probe);
    sharedProbe = true;
  } catch {
    sharedProbe = false;
  }
  return sharedProbe;
}

/** Allocates a SharedArrayBuffer, or null when isolation is unavailable. */
function sab(bytes: number): SharedArrayBuffer | null {
  if (!canShare()) return null;
  try {
    return new SharedArrayBuffer(bytes);
  } catch {
    return null;
  }
}

/**
 * Turns the worklet's flat capture reply into rows.
 *
 * The stride travels with the message rather than being assumed, so a DSP-side change to
 * how many features a capture carries degrades into fewer/more feature axes here instead
 * of silently shearing every row. Layout is
 * `[class, ...features, attackLow, attackMid, attackHigh, strength]`.
 */
function decodeVoiceCaptures(flat: number[], stride: number): VoiceCapture[] {
  const featureCount = stride - 5;
  if (featureCount < 1) return [];
  const out: VoiceCapture[] = [];
  for (let o = 0; o + stride <= flat.length; o += stride) {
    const features = new Float32Array(featureCount);
    for (let i = 0; i < featureCount; i++) features[i] = flat[o + 1 + i] ?? 0;
    const attack = new Float32Array(3);
    for (let i = 0; i < 3; i++) attack[i] = flat[o + 1 + featureCount + i] ?? 0;
    out.push({
      cls: (flat[o] ?? -1) | 0,
      features,
      attack,
      strength: flat[o + stride - 1] ?? 0,
    });
  }
  return out;
}

export class WorkletBackend implements EngineBackend {
  readonly name = "AudioWorklet (WASAPI shared mode)";

  readonly capabilities = {
    // Chromium lets us request a rate; the device may still force its own.
    selectableSampleRate: true,
    // latencyHint is advisory. We cannot set an exact WASAPI period from here.
    exactBufferSize: false,
    lowLatencyExclusive: false,
    outputDeviceSelection: typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype,
  };

  private ctx: AudioContext | null = null;
  /**
   * Live render load, 0..1, from Chromium's AudioRenderCapacity.
   *
   * `performance.now()` does not exist in AudioWorkletGlobalScope, so the worklet cannot
   * time itself; this is the only real measurement available. It has to be started
   * explicitly and delivers values through `update` events — there is no pollable
   * property, which is exactly the mistake this field exists to correct.
   */
  private renderLoad = 0;
  private capacityStop: (() => void) | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  /** Visualisation-only tap. Not in the DSP path — the engine's output is already final. */
  private analyser: AnalyserNode | null = null;
  private silentSink: GainNode | null = null;

  private state: EngineStatus = "idle";
  private engineInfo: EngineInfo | null = null;
  private lastError: string | null = null;

  private shared = false;

  // shared transport
  private cmdHeader: Int32Array | null = null;
  private cmdData: Float64Array | null = null;
  private cmdWrite = 0;
  private meterSeq: Int32Array | null = null;
  private meterData: Float32Array | null = null;
  private scopeIdx: Int32Array | null = null;
  private scopeIn: Float32Array | null = null;
  private scopeOut: Float32Array | null = null;
  private recIdx: Int32Array | null = null;
  private recDry: Float32Array | null = null;
  private recWet: Float32Array | null = null;
  private recCap = 0;

  // fallback transport
  private pendingCmds: number[] = [];
  private flushScheduled = false;
  private fbMeters = new Float32Array(METER_FIELDS);
  private fbScopeIn = new Float32Array(1024);
  private fbScopeOut = new Float32Array(1024);
  private fbScopeW = 0;
  /** Chunks received from the worklet in fallback mode, plus drained SAB chunks. */
  private recChunks: { l: Float32Array; r: Float32Array }[] = [];
  private recDrained = 0;
  private recDryChunks: { l: Float32Array; r: Float32Array }[] = [];
  private recActive = false;
  private drainTimer: number | null = null;

  private visualWaiters = new Map<number, (v: Float32Array | null) => void>();
  /** Keyed by loop track index — one outstanding waveform pull per track. */
  private loopPeakWaiters = new Map<number, (v: Float32Array | null) => void>();
  /** One outstanding calibration-capture pull. The panel polls; it never fans out. */
  private voiceCapWaiter: ((v: { from: number; total: number; rows: VoiceCapture[] }) => void) | null = null;
  private chainListener: ((order: { id: number; type: string; bypassed: boolean }[], latency: number) => void) | null =
    null;
  private statusListener: ((s: EngineStatus, err: string | null) => void) | null = null;

  // ------------------------------------------------------------- lifecycle

  status(): EngineStatus {
    return this.state;
  }

  error(): string | null {
    return this.lastError;
  }

  info(): EngineInfo | null {
    return this.engineInfo;
  }

  onStatus(fn: (s: EngineStatus, err: string | null) => void) {
    this.statusListener = fn;
  }

  onChain(fn: (order: { id: number; type: string; bypassed: boolean }[], latency: number) => void) {
    this.chainListener = fn;
  }

  private setState(s: EngineStatus, err: string | null = null) {
    this.state = s;
    this.lastError = err;
    this.statusListener?.(s, err);
  }

  async requestPermission(): Promise<boolean> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of s.getTracks()) t.stop();
      return true;
    } catch {
      return false;
    }
  }

  async enumerateDevices(): Promise<DeviceList> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return { inputs: [], outputs: [], labelsAvailable: false };
    }
    const list = await navigator.mediaDevices.enumerateDevices();
    const inputs: AudioDeviceInfo[] = [];
    const outputs: AudioDeviceInfo[] = [];
    // Blank labels mean permission has never been granted — the UI prompts for it.
    let labelled = false;
    for (const d of list) {
      if (d.label) labelled = true;
      const entry: AudioDeviceInfo = {
        deviceId: d.deviceId,
        label: d.label || (d.kind === "audioinput" ? "Input device" : "Output device"),
        kind: d.kind === "audioinput" ? "input" : "output",
        isDefault: d.deviceId === "default" || d.deviceId === "communications",
        groupId: d.groupId,
      };
      if (d.kind === "audioinput") inputs.push(entry);
      else if (d.kind === "audiooutput") outputs.push(entry);
    }
    return { inputs, outputs, labelsAvailable: labelled };
  }

  async start(opts: StartOptions): Promise<EngineInfo> {
    if (this.state === "running" || this.state === "starting") await this.stop();
    this.setState("starting");
    try {
      const info = await this.build(opts);
      this.setState("running");
      return info;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState("error", msg);
      await this.teardown();
      throw e;
    }
  }

  async restart(opts: StartOptions): Promise<EngineInfo> {
    return this.start(opts);
  }

  private async build(opts: StartOptions): Promise<EngineInfo> {
    // ---- 1. capture -------------------------------------------------------
    // Every browser "enhancement" is switched off: they are aggressive, they add
    // latency, and they fight the compressor and gate downstream.
    const audio: MediaTrackConstraints = {
      echoCancellation: opts.echoCancellation ?? false,
      noiseSuppression: opts.noiseSuppression ?? false,
      autoGainControl: opts.autoGainControl ?? false,
      channelCount: 2,
    };
    if (opts.inputDeviceId && opts.inputDeviceId !== "default") {
      audio.deviceId = { exact: opts.inputDeviceId };
    }
    if (opts.sampleRate) audio.sampleRate = opts.sampleRate;

    // A missing or refused microphone is not fatal. BROBEATS pads, preset auditioning
    // and file playback all want the engine running with no input at all, so capture
    // failure downgrades to output-only instead of refusing to start.
    let inputError: string | null = null;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (e) {
      this.stream = null;
      inputError =
        e instanceof Error
          ? e.name === "NotFoundError"
            ? "No microphone found — running output only."
            : e.name === "NotAllowedError"
              ? "Microphone access denied — running output only."
              : `${e.message} — running output only.`
          : "Microphone unavailable — running output only.";
    }

    // ---- 2. context -------------------------------------------------------
    const settings = this.stream?.getAudioTracks()[0]?.getSettings() ?? {};
    const wantRate = opts.sampleRate || settings.sampleRate || 48000;
    // latencyHint in seconds. Chromium rounds this to a device period it can honour.
    const hint = opts.bufferFrames ? opts.bufferFrames / wantRate : "interactive";
    const ctxOpts: AudioContextOptions = { latencyHint: hint };
    // Forcing a rate the device can't do throws, so only ask when the track agrees.
    if (opts.sampleRate && (!settings.sampleRate || settings.sampleRate === opts.sampleRate)) {
      ctxOpts.sampleRate = opts.sampleRate;
    }

    let ctx: AudioContext;
    try {
      ctx = new AudioContext(ctxOpts);
    } catch {
      // Fall back to the device's own rate rather than refusing to start.
      ctx = new AudioContext({ latencyHint: hint });
    }
    this.ctx = ctx;
    if (ctx.state === "suspended") await ctx.resume();

    if (opts.outputDeviceId && this.capabilities.outputDeviceSelection) {
      try {
        // @ts-expect-error setSinkId on AudioContext is Chromium-only and not in lib.dom yet.
        await ctx.setSinkId(opts.outputDeviceId === "default" ? "" : opts.outputDeviceId);
      } catch {
        // Non-fatal: keep the default sink and let the UI report it.
      }
    }

    this.startCapacityMonitor(ctx);

    // ---- 3. shared transport ---------------------------------------------
    this.allocTransport(ctx.sampleRate);

    // ---- 4. worklet -------------------------------------------------------
    await ctx.audioWorklet.addModule(WORKLET_URL);
    const node = new AudioWorkletNode(ctx, "brokodr-engine", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: {
        cmdHeader: this.cmdHeader?.buffer ?? null,
        cmdData: this.cmdData?.buffer ?? null,
        meterSeq: this.meterSeq?.buffer ?? null,
        meterData: this.meterData?.buffer ?? null,
        scopeIdx: this.scopeIdx?.buffer ?? null,
        scopeIn: this.scopeIn?.buffer ?? null,
        scopeOut: this.scopeOut?.buffer ?? null,
        recIdx: this.recIdx?.buffer ?? null,
        recDry: this.recDry?.buffer ?? null,
        recWet: this.recWet?.buffer ?? null,
      },
    });
    node.port.onmessage = (e) => this.onWorkletMessage(e.data);
    node.onprocessorerror = () => this.setState("error", "Audio engine crashed. Restart the engine.");
    this.node = node;

    // ---- 5. graph ---------------------------------------------------------
    this.source = this.stream ? ctx.createMediaStreamSource(this.stream) : null;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.6;
    this.analyser.minDecibels = -100;

    this.source?.connect(node);
    node.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.startDrainTimer();

    const track = this.stream?.getAudioTracks()[0];
    const actual = track?.getSettings() ?? {};
    this.engineInfo = {
      sampleRate: ctx.sampleRate,
      blockFrames: 128, // AudioWorklet render quantum, fixed by the spec
      inputLatency: (actual as { latency?: number }).latency ?? 0,
      outputLatency: ctx.outputLatency || ctx.baseLatency || 0,
      engineLatency: 0,
      sharedMemory: this.shared,
      inputActive: !!this.stream,
      inputError,
      backend: this.name,
    };
    return this.engineInfo;
  }

  private allocTransport(sampleRate: number) {
    this.shared = canShare();
    const cmdHeaderBuf = sab(2 * 4);
    if (cmdHeaderBuf) {
      this.cmdHeader = new Int32Array(cmdHeaderBuf);
      this.cmdData = new Float64Array(sab(CMD_SLOTS * CMD_STRIDE * 8)!);
      this.meterSeq = new Int32Array(sab(4)!);
      this.meterData = new Float32Array(sab(METER_FIELDS * 4)!);
      this.scopeIdx = new Int32Array(sab(4)!);
      this.scopeIn = new Float32Array(sab(SCOPE_SIZE * 4)!);
      this.scopeOut = new Float32Array(sab(SCOPE_SIZE * 4)!);
      this.recCap = Math.ceil(sampleRate * REC_HEADROOM_SEC);
      this.recIdx = new Int32Array(sab(2 * 4)!);
      this.recWet = new Float32Array(sab(this.recCap * 2 * 4)!);
      this.recDry = new Float32Array(sab(this.recCap * 2 * 4)!);
      this.cmdWrite = 0;
    } else {
      this.cmdHeader = null;
      this.cmdData = null;
      this.meterSeq = null;
      this.meterData = null;
      this.scopeIdx = null;
      this.scopeIn = null;
      this.scopeOut = null;
      this.recIdx = null;
      this.recWet = null;
      this.recDry = null;
      this.recCap = 0;
    }
  }

  private onWorkletMessage(m: {
    t: string;
    m?: number[];
    scopeIn?: number[];
    scopeOut?: number[];
    sw?: number;
    order?: { id: number; type: string; bypassed: boolean }[];
    latency?: number;
    id?: number;
    index?: number;
    data?: number[] | null;
    l?: ArrayBuffer;
    r?: ArrayBuffer;
    frames?: number;
    from?: number;
    total?: number;
    stride?: number;
    rows?: number[];
  }) {
    if (!m) return;
    switch (m.t) {
      case "chain":
        if (this.engineInfo && m.latency !== undefined) this.engineInfo.engineLatency = m.latency;
        if (m.order) this.chainListener?.(m.order, m.latency ?? 0);
        break;
      case "meters":
        if (m.m) this.fbMeters.set(m.m);
        if (m.scopeIn) this.fbScopeIn.set(m.scopeIn);
        if (m.scopeOut) this.fbScopeOut.set(m.scopeOut);
        if (m.sw !== undefined) this.fbScopeW = m.sw;
        break;
      case "visual": {
        const w = this.visualWaiters.get(m.id ?? -1);
        if (w) {
          this.visualWaiters.delete(m.id ?? -1);
          w(m.data ? new Float32Array(m.data) : null);
        }
        break;
      }
      case "looppeaks": {
        const i = m.index ?? -1;
        const w = this.loopPeakWaiters.get(i);
        if (w) {
          this.loopPeakWaiters.delete(i);
          w(m.data ? new Float32Array(m.data) : null);
        }
        break;
      }
      case "voicecaps": {
        const w = this.voiceCapWaiter;
        if (w) {
          this.voiceCapWaiter = null;
          w({
            from: m.from ?? 0,
            total: m.total ?? 0,
            rows: decodeVoiceCaptures(m.rows ?? [], m.stride ?? VOICE_CAPTURE_STRIDE),
          });
        }
        break;
      }
      case "recchunk":
        if (m.l && m.r) this.recChunks.push({ l: new Float32Array(m.l), r: new Float32Array(m.r) });
        break;
    }
  }

  async stop(): Promise<void> {
    await this.teardown();
    this.setState("idle");
  }

  private async teardown() {
    if (this.drainTimer !== null) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    this.capacityStop?.();
    this.capacityStop = null;
    this.renderLoad = 0;
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.analyser?.disconnect();
      this.silentSink?.disconnect();
    } catch {
      // Disconnecting an already-dead graph is not an error worth surfacing.
    }
    if (this.node) this.node.port.onmessage = null;
    this.node = null;
    this.source = null;
    this.analyser = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        // ignore
      }
      this.ctx = null;
    }
    this.engineInfo = null;
  }

  dispose(): void {
    void this.teardown();
  }

  // ------------------------------------------------------- chain structure

  addSlot(spec: AddSlotSpec): void {
    this.node?.port.postMessage({
      t: "cmds",
      list: [
        {
          t: "add",
          id: spec.id,
          type: spec.type,
          params: spec.params,
          mix: spec.mix,
          bypassed: spec.bypassed,
          index: spec.index,
          paramNames: paramNames(spec.type),
        },
      ],
    });
  }

  removeSlot(id: number): void {
    this.node?.port.postMessage({ t: "cmds", list: [{ t: "remove", id }] });
  }

  clearChain(): void {
    this.node?.port.postMessage({ t: "cmds", list: [{ t: "clear" }] });
  }

  setChain(specs: AddSlotSpec[]): void {
    // One message, one drain: the chain is replaced between two render quanta so the
    // user hears a clean switch instead of effects popping in one at a time.
    const list: unknown[] = [{ t: "clear" }];
    for (const s of specs) {
      list.push({
        t: "add",
        id: s.id,
        type: s.type,
        params: s.params,
        mix: s.mix,
        bypassed: s.bypassed,
        paramNames: paramNames(s.type),
      });
    }
    this.node?.port.postMessage({ t: "cmds", list });
  }

  // ----------------------------------------------------- realtime control

  /** Push one numeric command. Allocation-free on the shared path. */
  private push(op: number, id: number, key: number, value: number, aux1 = 0, aux2 = 0) {
    if (this.cmdHeader && this.cmdData) {
      const w = this.cmdWrite;
      const r = Atomics.load(this.cmdHeader, 1);
      // Drop rather than block if the UI somehow outruns the audio thread by 1024
      // commands. Losing one intermediate knob position is invisible; stalling is not.
      if (w - r >= CMD_SLOTS) return;
      const base = (w % CMD_SLOTS) * CMD_STRIDE;
      this.cmdData[base] = op;
      this.cmdData[base + 1] = id;
      this.cmdData[base + 2] = key;
      this.cmdData[base + 3] = value;
      this.cmdData[base + 4] = aux1;
      this.cmdData[base + 5] = aux2;
      this.cmdWrite = w + 1;
      Atomics.store(this.cmdHeader, 0, this.cmdWrite);
      return;
    }
    // Fallback: batch into one postMessage per animation frame.
    // Stride must match the ring's, because the worklet decodes both with one routine.
    this.pendingCmds.push(op, id, key, value, aux1, aux2);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      requestAnimationFrame(() => {
        this.flushScheduled = false;
        if (!this.pendingCmds.length) return;
        const a = this.pendingCmds;
        this.pendingCmds = [];
        this.node?.port.postMessage({ t: "pcmds", a });
      });
    }
  }

  setParam(id: number, type: string, key: string, value: number): void {
    const idx = paramIndex(type, key);
    if (idx < 0) return;
    this.push(OP.PARAM, id, idx, value);
  }

  setMix(id: number, value: number): void {
    this.push(OP.MIX, id, 0, value);
  }

  setBypass(id: number, bypassed: boolean): void {
    this.push(OP.BYPASS, id, 0, bypassed ? 1 : 0);
  }

  moveSlot(id: number, index: number): void {
    this.push(OP.MOVE, id, 0, index);
  }

  setIo(field: IoField, value: number): void {
    this.push(OP.IO, 0, field, value);
  }

  resetSlot(id: number): void {
    this.push(OP.RESET, id, 0, 0);
  }

  resetClip(): void {
    this.push(OP.CLIPRESET, 0, 0, 0);
  }

  panic(): void {
    this.push(OP.PANIC, 0, 0, 0);
  }

  // ---------------------------------------------------------------- BROBEATS

  triggerPad(index: number, velocity: number): void {
    this.push(OP.PAD, index, PAD_FIELD.TRIGGER, velocity);
  }

  releasePad(index: number): void {
    this.push(OP.PAD, index, PAD_FIELD.RELEASE, 0);
  }

  setPadParam(index: number, key: PadKey, value: number): void {
    const k = padKeyIndex(key);
    if (k < 0) return;
    this.push(OP.PAD, index, PAD_FIELD.PARAM, value, k);
  }

  setDrumParam(key: DrumKey, value: number): void {
    const k = drumKeyIndex(key);
    if (k < 0) return;
    this.push(OP.DRUM, 0, k, value);
  }

  loadPadSample(index: number, layer: number, data: Float32Array, sampleRate: number): void {
    // Copied into a SharedArrayBuffer when we have one so the audio thread can read it
    // without a transfer; transferred outright when we do not.
    const shared = this.sharedFloat(data.length);
    if (shared) {
      shared.set(data);
      this.node?.port.postMessage({
        t: "padload",
        index,
        layer,
        data: shared.buffer,
        frames: data.length,
        rate: sampleRate,
      });
      return;
    }
    const copy = data.slice();
    this.node?.port.postMessage(
      { t: "padload", index, layer, data: copy.buffer, frames: copy.length, rate: sampleRate },
      [copy.buffer as ArrayBuffer],
    );
  }

  clearPad(index: number): void {
    // One message: the rack's clearPad drops the sample layers and the pad's effect
    // chain together, and the worklet echoes the now-empty chain back to the UI.
    this.node?.port.postMessage({ t: "padclear", index });
  }

  resetDrums(): void {
    this.node?.port.postMessage({ t: "cmds", list: [{ t: "drumreset" }] });
  }

  padChainCommand(index: number, cmd: Record<string, unknown>): void {
    this.node?.port.postMessage({ t: "padfx", index, ...withParamNames(cmd) });
  }

  setPadChainParam(index: number, slotId: number, type: string, key: string, value: number): void {
    const idx = paramIndex(type, key);
    if (idx < 0) return;
    this.push(OP.PADFX, slotId, idx, value, index);
  }

  // ---------------------------------------------------------------- looper

  // The transport verbs carry no payload: the opcode and the track index are the whole
  // message, so a punch costs one ring slot between the pointerdown and the arm.

  loopRecord(index: number): void {
    this.push(OP.LOOP, index, LOOP_FIELD.REC, 0);
  }

  loopPlay(index: number): void {
    this.push(OP.LOOP, index, LOOP_FIELD.PLAY, 0);
  }

  loopStop(index: number): void {
    this.push(OP.LOOP, index, LOOP_FIELD.STOP, 0);
  }

  loopClear(index: number): void {
    this.push(OP.LOOP, index, LOOP_FIELD.CLEAR, 0);
  }

  loopUndo(index: number): void {
    this.push(OP.LOOP, index, LOOP_FIELD.UNDO, 0);
  }

  loopClearAll(): void {
    this.push(OP.LOOP, 0, LOOP_FIELD.CLEARALL, 0);
  }

  setLoopParam(index: number, key: LoopKey, value: number): void {
    const k = loopKeyIndex(key);
    if (k < 0) return;
    this.push(OP.LOOP, index, LOOP_FIELD.PARAM, value, k);
  }

  setLooperParam(key: LooperKey, value: number): void {
    const k = looperKeyIndex(key);
    if (k < 0) return;
    this.push(OP.LOOPER, 0, k, value);
  }

  setClockParam(key: ClockKey, value: number): void {
    const k = clockKeyIndex(key);
    if (k < 0) return;
    this.push(OP.CLOCK, 0, k, value);
  }

  loopChainCommand(index: number, cmd: Record<string, unknown>): void {
    // Structural chain edits need strings, so they go by message rather than the ring.
    this.node?.port.postMessage({ t: "loopfx", index, ...withParamNames(cmd) });
  }

  setLoopChainParam(index: number, slotId: number, type: string, key: string, value: number): void {
    const idx = paramIndex(type, key);
    if (idx < 0) return;
    this.push(OP.LOOPFX, slotId, idx, value, index);
  }

  getLoopPeaks(index: number, buckets: number): Promise<Float32Array | null> {
    if (!this.node) return Promise.resolve(null);
    return new Promise((resolve) => {
      // One waiter per track. A second pull for the same track while the first is still
      // in flight resolves the first with null rather than leaving it hanging forever.
      const prev = this.loopPeakWaiters.get(index);
      if (prev) prev(null);
      this.loopPeakWaiters.set(index, resolve);
      this.node?.port.postMessage({ t: "getlooppeaks", index, buckets });
      setTimeout(() => {
        if (this.loopPeakWaiters.get(index) === resolve) {
          this.loopPeakWaiters.delete(index);
          resolve(null);
        }
      }, 500);
    });
  }

  // ----------------------------------------------------------- Smart Voice

  // Everything here is one ring slot: Smart Voice is calibrated while audio runs, and a
  // nudged centroid or a re-armed capture must not cost a message round trip.

  setVoiceParam(key: VoiceKey, value: number): void {
    const k = voiceKeyIndex(key);
    if (k < 0) return;
    this.push(OP.VOICE, 0, k, value);
  }

  setVoiceCentroid(cls: number, feature: number, value: number): void {
    this.push(OP.VOICECAL, cls, VOICE_CAL.CENTROID, value, feature);
  }

  setVoiceAttackCentroid(cls: number, band: number, value: number): void {
    this.push(OP.VOICECAL, cls, VOICE_CAL.ATTACK, value, band);
  }

  setVoiceClassPad(cls: number, pad: number): void {
    // A negative pad mutes the class; it rides in `value` untouched.
    this.push(OP.VOICECAL, cls, VOICE_CAL.PAD, pad);
  }

  setVoiceCapture(cls: number): void {
    // The class to capture rides in `value`, matching the DSP's own -1-to-disarm rule.
    this.push(OP.VOICECAL, 0, VOICE_CAL.CAPTURE, cls);
  }

  clearVoiceCaptures(): void {
    this.push(OP.VOICECAL, 0, VOICE_CAL.CLEAR, 0);
  }

  resetVoiceCentroids(): void {
    this.push(OP.VOICECAL, 0, VOICE_CAL.RESET, 0);
  }

  resetVoiceDetector(): void {
    this.push(OP.VOICECAL, 0, VOICE_CAL.DETRESET, 0);
  }

  getVoiceCaptures(from: number, max: number): Promise<{ from: number; total: number; rows: VoiceCapture[] }> {
    const empty = { from: 0, total: 0, rows: [] as VoiceCapture[] };
    if (!this.node) return Promise.resolve(empty);
    return new Promise((resolve) => {
      // Single outstanding pull. A second one while the first is in flight resolves the
      // first empty rather than leaving the panel's await hanging.
      const prev = this.voiceCapWaiter;
      if (prev) prev(empty);
      this.voiceCapWaiter = resolve;
      this.node?.port.postMessage({ t: "getvoicecaps", from, max });
      setTimeout(() => {
        if (this.voiceCapWaiter === resolve) {
          this.voiceCapWaiter = null;
          resolve(empty);
        }
      }, 500);
    });
  }

  /** A SharedArrayBuffer-backed Float32Array, or null when SAB is unavailable. */
  private sharedFloat(length: number): Float32Array | null {
    if (typeof SharedArrayBuffer === "undefined") return null;
    try {
      return new Float32Array(new SharedArrayBuffer(length * 4));
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------- telemetry

  readMeters(out: EngineMeters): boolean {
    let src: Float32Array;
    if (this.meterSeq && this.meterData) {
      // Seqlock read: even sequence before and after, and unchanged, means the block
      // we copied was not being written while we read it.
      let attempts = 0;
      for (;;) {
        const s1 = Atomics.load(this.meterSeq, 0);
        if ((s1 & 1) === 0) {
          this.fbMeters.set(this.meterData);
          const s2 = Atomics.load(this.meterSeq, 0);
          if (s1 === s2) break;
        }
        if (++attempts > 8) return false;
      }
      src = this.fbMeters;
    } else {
      src = this.fbMeters;
    }

    out.peakInL = src[0];
    out.peakInR = src[1];
    out.peakOutL = src[2];
    out.peakOutR = src[3];
    out.rmsInL = src[4];
    out.rmsInR = src[5];
    out.rmsOutL = src[6];
    out.rmsOutR = src[7];
    out.clipIn = src[8] >= 0.5;
    out.clipOut = src[9] >= 0.5;
    out.cpu = src[10];
    out.latencySamples = src[11];
    out.slotCount = src[12] | 0;
    out.recording = src[13] >= 0.5;
    out.recordedFrames = src[14];
    out.recordOverflow = src[15] >= 0.5;
    for (let i = 0; i < MAX_SLOTS; i++) out.slots[i] = src[16 + i];
    out.filePosition = src[40];
    out.filePlaying = src[41] >= 0.5;
    out.fileLevel = src[44];
    for (let i = 0; i < PAD_COUNT; i++) out.pads[i] = src[48 + i];
    out.drumLevelL = src[64];
    out.drumLevelR = src[65];
    out.padsFired = src[66] | 0;

    // Looper: LOOP_TRACKS blocks of LOOP_METER_STRIDE, then the transport. Decoded into
    // the reused per-track objects rather than fresh ones — this runs every UI frame.
    for (let i = 0; i < LOOP_TRACKS; i++) {
      const o = LOOP_METER_BASE + i * LOOP_METER_STRIDE;
      const t = out.loops[i];
      if (!t) continue;
      t.state = src[o] | 0;
      t.pending = src[o + 1] | 0;
      t.level = src[o + 2];
      t.position = src[o + 3];
      t.frames = src[o + 4];
      t.chainLength = src[o + 5] | 0;
      t.layers = src[o + 6] | 0;
      t.canUndo = src[o + 7] >= 0.5;
    }
    const tb = TRANSPORT_METER_BASE;
    out.bpm = src[tb];
    out.beatsPerBar = src[tb + 1];
    out.quantize = src[tb + 2];
    out.clockRunning = src[tb + 3] >= 0.5;
    out.barPhase = src[tb + 4];
    out.bar = src[tb + 5] | 0;
    out.loopLevelL = src[tb + 6];
    out.loopLevelR = src[tb + 7];

    // Smart Voice: the detector's own readouts, then the live attack bands, then the
    // class -> pad map. Decoded into the meters object's existing arrays, never new ones.
    const vb = VOICE_METER_BASE;
    const v = out.voice;
    v.enabled = src[vb] >= 0.5;
    v.hits = src[vb + 1] | 0;
    v.lastClass = src[vb + 2] | 0;
    v.lastConf = src[vb + 3];
    v.lastVel = src[vb + 4];
    v.lastStage = src[vb + 5] | 0;
    v.level = src[vb + 6];
    v.lastStrength = src[vb + 7];
    v.captureClass = src[vb + 8] | 0;
    v.captureCount = src[vb + 9] | 0;
    v.corrections = src[vb + 10] | 0;
    v.onsets = src[vb + 11] | 0;
    for (let i = 0; i < 3; i++) v.band[i] = src[vb + VOICE_METER_STRIDE + i];
    for (let c = 0; c < VOICE_CLASS_COUNT; c++) v.classPads[c] = src[vb + VOICE_METER_STRIDE + 3 + c] | 0;

    // Chromium exposes a real render-capacity measurement; prefer it over our own
    // in-worklet timing when available, since it accounts for the whole graph.
    if (this.renderLoad > 0) out.cpu = this.renderLoad;
    return true;
  }

  /**
   * Subscribes to AudioRenderCapacity. Chromium-only and entirely optional: when it is
   * missing the CPU readout stays at zero rather than showing an invented number.
   */
  private startCapacityMonitor(ctx: AudioContext) {
    this.capacityStop?.();
    this.capacityStop = null;
    this.renderLoad = 0;

    const cap = (ctx as unknown as {
      renderCapacity?: {
        start: (o: { updateInterval: number }) => void;
        stop: () => void;
        addEventListener: (t: string, cb: (e: { averageLoad: number; peakLoad: number }) => void) => void;
        removeEventListener: (t: string, cb: (e: { averageLoad: number; peakLoad: number }) => void) => void;
      };
    }).renderCapacity;
    if (!cap) return;

    // Peak matters more than average for a live rig: an occasional spike over budget is
    // an audible dropout, and an average would hide it.
    const onUpdate = (e: { averageLoad: number; peakLoad: number }) => {
      this.renderLoad = Math.max(0, Math.min(1, e.peakLoad || e.averageLoad || 0));
    };
    try {
      cap.addEventListener("update", onUpdate);
      cap.start({ updateInterval: 0.15 });
      this.capacityStop = () => {
        try {
          cap.stop();
          cap.removeEventListener("update", onUpdate);
        } catch {
          // The context may already be closed — nothing to unwind.
        }
      };
    } catch {
      this.renderLoad = 0;
    }
  }

  readScope(out: ScopeFrame, frames: number): boolean {
    const n = Math.min(frames, out.input.length);
    if (this.scopeIdx && this.scopeIn && this.scopeOut) {
      const w = Atomics.load(this.scopeIdx, 0);
      const mask = SCOPE_SIZE - 1;
      const start = (w - n + SCOPE_SIZE) & mask;
      for (let i = 0; i < n; i++) {
        const idx = (start + i) & mask;
        out.input[i] = this.scopeIn[idx];
        out.output[i] = this.scopeOut[idx];
      }
      return true;
    }
    const mask = this.fbScopeIn.length - 1;
    const start = (this.fbScopeW - n + this.fbScopeIn.length) & mask;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) & mask;
      out.input[i] = this.fbScopeIn[idx];
      out.output[i] = this.fbScopeOut[idx];
    }
    return true;
  }

  /** Frequency-domain magnitudes in dB for the spectrum display. */
  readSpectrum(out: Float32Array): boolean {
    if (!this.analyser) return false;
    if (out.length !== this.analyser.frequencyBinCount) return false;
    this.analyser.getFloatFrequencyData(out as Float32Array<ArrayBuffer>);
    return true;
  }

  spectrumBins(): number {
    return this.analyser ? this.analyser.frequencyBinCount : 0;
  }

  getVisual(id: number): Promise<Float32Array | null> {
    if (!this.node) return Promise.resolve(null);
    return new Promise((resolve) => {
      // Only one outstanding request per slot; a stale one resolves null.
      const prev = this.visualWaiters.get(id);
      if (prev) prev(null);
      this.visualWaiters.set(id, resolve);
      this.node?.port.postMessage({ t: "getvisual", id });
      setTimeout(() => {
        if (this.visualWaiters.get(id) === resolve) {
          this.visualWaiters.delete(id);
          resolve(null);
        }
      }, 500);
    });
  }

  // ------------------------------------------------------------- recording

  setRecording(recording: boolean, paused: boolean, reset: boolean): void {
    if (reset) {
      this.recChunks = [];
      this.recDryChunks = [];
      this.recDrained = 0;
    }
    this.recActive = recording && !paused;
    this.node?.port.postMessage({ t: "recstate", recording, paused, reset });
  }

  /**
   * Drains new frames out of the shared circular capture buffer into JS chunks. Runs on
   * a timer well inside the buffer's headroom, which is what makes take length unbounded
   * while the shared allocation stays small.
   */
  private startDrainTimer() {
    if (this.drainTimer !== null) clearInterval(this.drainTimer);
    this.drainTimer = setInterval(() => this.drainRecording(), 250) as unknown as number;
  }

  private drainRecording() {
    if (!this.recIdx || !this.recWet || !this.recActive) return;
    const total = Atomics.load(this.recIdx, 0);
    let avail = total - this.recDrained;
    if (avail <= 0) return;
    if (avail > this.recCap) {
      // We fell behind by more than the buffer: skip to the oldest intact frame rather
      // than emit garbage, and let the UI flag it.
      this.recDrained = total - this.recCap;
      avail = this.recCap;
    }
    const l = new Float32Array(avail);
    const r = new Float32Array(avail);
    const dl = this.recDry ? new Float32Array(avail) : null;
    const dr = this.recDry ? new Float32Array(avail) : null;
    for (let i = 0; i < avail; i++) {
      const o = ((this.recDrained + i) % this.recCap) * 2;
      l[i] = this.recWet[o];
      r[i] = this.recWet[o + 1];
      if (dl && dr && this.recDry) {
        dl[i] = this.recDry[o];
        dr[i] = this.recDry[o + 1];
      }
    }
    this.recDrained = total;
    this.recChunks.push({ l, r });
    if (dl && dr) this.recDryChunks.push({ l: dl, r: dr });
  }

  /** Flush the tail, then concatenate every chunk into one contiguous take. */
  takeRecording(): { wet: { l: Float32Array; r: Float32Array }; dry: { l: Float32Array; r: Float32Array } | null } {
    this.drainRecording();
    const wet = concatChunks(this.recChunks);
    const dry = this.recDryChunks.length ? concatChunks(this.recDryChunks) : null;
    return { wet, dry };
  }

  recordedFrames(): number {
    let n = 0;
    for (const c of this.recChunks) n += c.l.length;
    return n;
  }

  readRecording(): { wet: Float32Array; dry: Float32Array } | null {
    const t = this.takeRecording();
    if (!t.wet.l.length) return null;
    return { wet: interleave(t.wet.l, t.wet.r), dry: t.dry ? interleave(t.dry.l, t.dry.r) : new Float32Array(0) };
  }

  recordCapacity(): number {
    // Unbounded in practice — limited by RAM, not by the shared buffer.
    return Number.POSITIVE_INFINITY;
  }

  // ----------------------------------------------------------- file player

  /**
   * Decodes a WAV/MP3 file and hands it to the engine.
   *
   * Decoding happens here, on the UI thread, with `decodeAudioData` — it covers both
   * formats natively and is the only decoder available without shipping one. The PCM is
   * then copied ONCE into a SharedArrayBuffer and the worklet receives a reference, so
   * a ten-minute file costs no per-block work and no transfer.
   *
   * Without shared memory the buffers are transferred instead (structured clone with
   * transfer, still zero-copy) — playback works identically, only the meters are coarser.
   */
  async loadFile(data: ArrayBuffer): Promise<{ frames: number; sampleRate: number; peaks: Float32Array } | null> {
    const ctx = this.ctx;
    if (!ctx || !this.node) return null;
    // decodeAudioData detaches its input, so decode a copy — the caller may retry.
    const buf = await ctx.decodeAudioData(data.slice(0));
    const frames = buf.length;
    const srcL = buf.getChannelData(0);
    const srcR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;

    const bytes = frames * 4;
    const sabL = sab(bytes);
    const sabR = srcR ? sab(bytes) : null;
    if (sabL) {
      new Float32Array(sabL).set(srcL);
      if (sabR && srcR) new Float32Array(sabR).set(srcR);
      this.node.port.postMessage({
        t: "fileload",
        chL: sabL,
        chR: sabR,
        frames,
        rate: buf.sampleRate,
      });
    } else {
      const l = new Float32Array(srcL);
      const r = srcR ? new Float32Array(srcR) : null;
      const transfer: ArrayBuffer[] = [l.buffer as ArrayBuffer];
      if (r) transfer.push(r.buffer as ArrayBuffer);
      this.node.port.postMessage(
        { t: "fileload", chL: l.buffer, chR: r ? r.buffer : null, frames, rate: buf.sampleRate },
        transfer,
      );
    }
    return { frames, sampleRate: buf.sampleRate, peaks: buildPeaks(srcL, srcR, 1200) };
  }

  clearFile(): void {
    this.node?.port.postMessage({ t: "fileclear" });
  }

  setFile(field: FileField, value: number): void {
    this.push(OP.FILE, 0, field, value);
  }

  outputNode(): AudioNode | null {
    return this.analyser;
  }

  context(): AudioContext | null {
    return this.ctx;
  }
}

function concatChunks(chunks: { l: Float32Array; r: Float32Array }[]): { l: Float32Array; r: Float32Array } {
  let n = 0;
  for (const c of chunks) n += c.l.length;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    l.set(c.l, o);
    r.set(c.r, o);
    o += c.l.length;
  }
  return { l, r };
}

/**
 * Min/max peak envelope for the waveform display. Built once per file on the UI thread —
 * drawing from the raw PCM would mean iterating megabytes on every repaint.
 */
function buildPeaks(l: Float32Array, r: Float32Array | null, buckets: number): Float32Array {
  const out = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(l.length / buckets));
  for (let b = 0; b < buckets; b++) {
    const start = b * per;
    const end = Math.min(l.length, start + per);
    let pk = 0;
    for (let i = start; i < end; i++) {
      const v = r ? Math.max(Math.abs(l[i]), Math.abs(r[i])) : Math.abs(l[i]);
      if (v > pk) pk = v;
    }
    out[b] = pk;
  }
  return out;
}

function interleave(l: Float32Array, r: Float32Array): Float32Array {
  const out = new Float32Array(l.length * 2);
  for (let i = 0; i < l.length; i++) {
    out[i * 2] = l[i];
    out[i * 2 + 1] = r[i];
  }
  return out;
}

/**
 * A pad or loop-track chain "add" needs the slot's param name table, exactly as the master
 * rack's add does: the worklet resolves OP.PADFX / OP.LOOPFX ring keys through
 * `slot.paramNames[key]`, and a slot added without one ignores every later knob move
 * (that was the case until Phase 5b: pad and loop effect params only took effect at add
 * time). Every other op passes through untouched.
 */
function withParamNames(cmd: Record<string, unknown>): Record<string, unknown> {
  if (cmd.op !== "add" || typeof cmd.type !== "string" || cmd.paramNames !== undefined) return cmd;
  return { ...cmd, paramNames: paramNames(cmd.type) };
}
