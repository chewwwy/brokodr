/**
 * Bro.Kodr — native (WASAPI exclusive / ASIO) backend.
 *
 * ## Status: interface only. NOT compiled in this build. Read this before filing a bug.
 *
 * `WorkletBackend` runs the engine inside Chromium's audio thread, which on Windows means
 * WASAPI in *shared* mode: ~15-35ms round trip. Getting to the 3-8ms an ASIO host
 * achieves requires owning the device from native code, which means a compiled N-API
 * addon and MSVC. This build ships from a Linux container with no MSVC toolchain, so the
 * addon is deliberately not built — shipping a stub that silently degrades would be worse
 * than being explicit.
 *
 * What is real here:
 *   - the DSP is already portable. `public/dsp/engine.js` and every effect are pure math
 *     over Float32Array with an explicitly-passed sample rate. No AudioWorklet, no
 *     AudioContext, no DOM, no Node. Porting means compiling the same algorithms, not
 *     redesigning them.
 *   - this class defines the exact contract and IPC protocol the addon must satisfy. It
 *     implements `EngineBackend`, so `engine-client.ts` and the entire UI need zero
 *     changes when it becomes available.
 *
 * ## Integration path
 * 1. `packages/native/` — an N-API addon (node-addon-api + cmake-js) exposing:
 *      listDevices()                        -> DeviceInfo[]
 *      open(deviceIn, deviceOut, rate, bufferFrames, mode) -> { rate, buffer, latency }
 *      close()
 *      pushCommand(opcode, id, key, value)  -> writes the same lock-free ring
 *      readMeters(Float32Array)             -> the same meter layout (see backend.ts;
 *                                              it has grown past 120 fields with
 *                                              BROBEATS, the looper and Smart Voice)
 *    backed by WASAPI exclusive mode, and ASIO via the Steinberg SDK (licence required,
 *    which is why it is a separate opt-in target).
 * 2. Port the DSP. Two supported routes:
 *      a. Compile `dsp/` to WASM (emscripten) and run it on the native audio thread.
 *         Fastest route; the algorithms are already allocation-free and block-based.
 *      b. Transliterate to C++ — the modules are written in a deliberately C-like style
 *         (typed arrays, no closures in hot loops, explicit state objects) for this.
 * 3. Bridge over Electron IPC: `window.brokodrNative.*`, contextBridge-exposed from
 *    `packages/desktop/electron/preload.ts`. Meters are polled; commands are fire and
 *    forget. Audio buffers never cross the IPC boundary — the addon owns the callback.
 * 4. `EngineClient` already probes `isNativeAvailable()` and prefers native when true,
 *    so no UI wiring is needed.
 *
 * Until then this class exists so the seam is real and tested, not hypothetical: the app
 * asks for it, gets `available === false`, and falls back with a message that says why.
 */

import {
  type AddSlotSpec,
  type DeviceList,
  type EngineBackend,
  type EngineInfo,
  type EngineMeters,
  type EngineStatus,
  type DrumKey,
  type IoField,
  type PadKey,
  type LoopKey,
  type LooperKey,
  type ClockKey,
  type VoiceCapture,
  type VoiceKey,
  type ScopeFrame,
  type StartOptions,
} from "./backend";

/** Shape the Electron preload must expose for the native path to light up. */
export interface NativeBridge {
  version: string;
  /** Driver models the addon was compiled with. */
  drivers: ("wasapi-shared" | "wasapi-exclusive" | "asio")[];
  listDevices(): Promise<DeviceList>;
  open(opts: {
    inputDeviceId?: string;
    outputDeviceId?: string;
    sampleRate: number;
    bufferFrames: number;
    driver: string;
  }): Promise<{ sampleRate: number; bufferFrames: number; inputLatency: number; outputLatency: number }>;
  close(): Promise<void>;
  command(op: number, id: number, key: number, value: number): void;
  structural(list: unknown[]): void;
  meters(): Float32Array;
  scope(frames: number): { input: Float32Array; output: Float32Array };
  recording(state: { recording: boolean; paused: boolean; reset: boolean }): void;
  take(): { wet: Float32Array; dry: Float32Array } | null;
}

declare global {
  interface Window {
    brokodrNative?: NativeBridge;
  }
}

export function nativeBridge(): NativeBridge | null {
  return typeof window !== "undefined" ? window.brokodrNative ?? null : null;
}

export function isNativeAvailable(): boolean {
  return nativeBridge() !== null;
}

export const NATIVE_UNAVAILABLE_REASON =
  "Native WASAPI/ASIO backend is not compiled in this build. The engine is running on the AudioWorklet backend " +
  "(WASAPI shared mode, ~15-35 ms round trip). See src/web/audio/native-backend.ts for the integration path.";

export class NativeBackend implements EngineBackend {
  readonly name = "Native WASAPI/ASIO";

  readonly capabilities = {
    selectableSampleRate: true,
    exactBufferSize: true,
    lowLatencyExclusive: true,
    outputDeviceSelection: true,
  };

  private bridge = nativeBridge();
  private state: EngineStatus = "idle";
  private engineInfo: EngineInfo | null = null;

  /** False in this build. Guard every call site with it. */
  get available(): boolean {
    return this.bridge !== null;
  }

  private require(): NativeBridge {
    if (!this.bridge) throw new Error(NATIVE_UNAVAILABLE_REASON);
    return this.bridge;
  }

  status(): EngineStatus {
    return this.state;
  }

  info(): EngineInfo | null {
    return this.engineInfo;
  }

  async enumerateDevices(): Promise<DeviceList> {
    if (!this.bridge) return { inputs: [], outputs: [], labelsAvailable: false };
    return this.bridge.listDevices();
  }

  async requestPermission(): Promise<boolean> {
    // Native capture does not go through the browser permission model.
    return this.available;
  }

  async start(opts: StartOptions): Promise<EngineInfo> {
    const b = this.require();
    this.state = "starting";
    const r = await b.open({
      inputDeviceId: opts.inputDeviceId,
      outputDeviceId: opts.outputDeviceId,
      sampleRate: opts.sampleRate ?? 48000,
      bufferFrames: opts.bufferFrames ?? 128,
      driver: b.drivers.includes("asio") ? "asio" : "wasapi-exclusive",
    });
    this.engineInfo = {
      sampleRate: r.sampleRate,
      blockFrames: r.bufferFrames,
      inputLatency: r.inputLatency,
      outputLatency: r.outputLatency,
      engineLatency: 0,
      sharedMemory: true,
      // The native host opens a duplex device: if start() resolved, capture is live.
      inputActive: true,
      inputError: null,
      backend: this.name,
    };
    this.state = "running";
    return this.engineInfo;
  }

  async stop(): Promise<void> {
    if (this.bridge) await this.bridge.close();
    this.state = "idle";
    this.engineInfo = null;
  }

  async restart(opts: StartOptions): Promise<EngineInfo> {
    await this.stop();
    return this.start(opts);
  }

  addSlot(spec: AddSlotSpec): void {
    this.bridge?.structural([{ t: "add", ...spec }]);
  }

  removeSlot(id: number): void {
    this.bridge?.structural([{ t: "remove", id }]);
  }

  clearChain(): void {
    this.bridge?.structural([{ t: "clear" }]);
  }

  setChain(specs: AddSlotSpec[]): void {
    this.bridge?.structural([{ t: "clear" }, ...specs.map((s) => ({ t: "add", ...s }))]);
  }

  setParam(): void {
    // Implemented by the addon's lock-free ring; see the header.
  }

  setMix(): void {}
  setBypass(): void {}
  moveSlot(): void {}
  setIo(_field: IoField, _value: number): void {}
  resetSlot(): void {}
  resetClip(): void {}
  panic(): void {}

  // BROBEATS. Inert here for the same reason everything else is: this backend is the
  // seam for the native WASAPI/ASIO host, and the host owns the engine once it exists.
  triggerPad(_index: number, _velocity: number): void {}
  releasePad(_index: number): void {}
  setPadParam(_index: number, _key: PadKey, _value: number): void {}
  setDrumParam(_key: DrumKey, _value: number): void {}
  loadPadSample(_index: number, _layer: number, _data: Float32Array, _rate: number): void {}
  clearPad(_index: number): void {}
  resetDrums(): void {}
  padChainCommand(_index: number, _cmd: Record<string, unknown>): void {}
  setPadChainParam(_index: number, _slotId: number, _type: string, _key: string, _value: number): void {}

  // Looper. Inert for the same reason.
  loopRecord(_index: number): void {}
  loopPlay(_index: number): void {}
  loopStop(_index: number): void {}
  loopClear(_index: number): void {}
  loopUndo(_index: number): void {}
  loopClearAll(): void {}
  setLoopParam(_index: number, _key: LoopKey, _value: number): void {}
  setLooperParam(_key: LooperKey, _value: number): void {}
  setClockParam(_key: ClockKey, _value: number): void {}
  loopChainCommand(_index: number, _cmd: Record<string, unknown>): void {}
  setLoopChainParam(_index: number, _slotId: number, _type: string, _key: string, _value: number): void {}
  async getLoopPeaks(_index: number, _buckets: number): Promise<Float32Array | null> {
    return null;
  }

  // Smart Voice. Inert for the same reason: the classifier lives in the engine, and the
  // native host will own the engine. The opcodes it needs are already defined (OP.VOICE,
  // OP.VOICECAL), so wiring them is a pushCommand call each once the addon exists.
  setVoiceParam(_key: VoiceKey, _value: number): void {}
  setVoiceCentroid(_cls: number, _feature: number, _value: number): void {}
  setVoiceAttackCentroid(_cls: number, _band: number, _value: number): void {}
  setVoiceClassPad(_cls: number, _pad: number): void {}
  setVoiceCapture(_cls: number): void {}
  clearVoiceCaptures(): void {}
  resetVoiceCentroids(): void {}
  resetVoiceDetector(): void {}
  async getVoiceCaptures(
    _from: number,
    _max: number,
  ): Promise<{ from: number; total: number; rows: VoiceCapture[] }> {
    return { from: 0, total: 0, rows: [] };
  }

  readMeters(_out: EngineMeters): boolean {
    return false;
  }

  readScope(_out: ScopeFrame, _frames: number): boolean {
    return false;
  }

  async getVisual(): Promise<Float32Array | null> {
    return null;
  }

  setRecording(recording: boolean, paused: boolean, reset: boolean): void {
    this.bridge?.recording({ recording, paused, reset });
  }

  readRecording(): { wet: Float32Array; dry: Float32Array } | null {
    return this.bridge?.take() ?? null;
  }

  recordedFrames(): number {
    return 0;
  }

  recordCapacity(): number {
    return Number.POSITIVE_INFINITY;
  }

  outputNode(): AudioNode | null {
    return null;
  }

  context(): AudioContext | null {
    return null;
  }

  dispose(): void {
    void this.stop();
  }
}
