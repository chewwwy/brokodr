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
 *      readMeters(Float32Array)             -> same 48-field layout
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
  type IoField,
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
