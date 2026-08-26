/**
 * Bro.Kodr — engine backend contract.
 *
 * The whole point of this file: the UI never talks to an AudioContext. It talks to an
 * `EngineBackend`. Two implementations exist —
 *
 *   WorkletBackend  (worklet-backend.ts)  ships and runs today. AudioContext +
 *                   AudioWorklet + SharedArrayBuffer, ~15-35ms round trip via WASAPI.
 *   NativeBackend   (native-backend.ts)   the same interface over a compiled WASAPI/ASIO
 *                   host. Interface + IPC protocol are defined; the native module is not
 *                   compiled in this build (see the file header for why and how).
 *
 * Both drive the identical DSP: `public/dsp/engine.js` and every effect module are pure
 * math over Float32Array with an explicitly passed sample rate. Nothing in the DSP layer
 * imports a host API, which is what makes swapping the backend a ~200 line adapter
 * instead of a rewrite.
 */

export type EngineStatus = "idle" | "starting" | "running" | "suspended" | "error";

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  kind: "input" | "output";
  /** True for the entry the OS currently considers default. */
  isDefault: boolean;
  groupId?: string;
}

export interface DeviceList {
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
  /** False until getUserMedia has been granted once — labels are blank before that. */
  labelsAvailable: boolean;
}

export interface StartOptions {
  inputDeviceId?: string;
  outputDeviceId?: string;
  /** Requested sample rate. The OS may refuse and pick its own; check `actual`. */
  sampleRate?: number;
  /** Requested buffer size in frames. Chromium maps this onto its own latency hint. */
  bufferFrames?: number;
  /** Disable the browser's DSP so we're the only thing touching the signal. */
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export interface EngineInfo {
  sampleRate: number;
  /** Frames per DSP block (render quantum for the worklet backend). */
  blockFrames: number;
  /** Backend-reported input latency in seconds, if the platform exposes it. */
  inputLatency: number;
  outputLatency: number;
  /** DSP-introduced latency (lookahead + STFT), in samples. */
  engineLatency: number;
  /** True when SharedArrayBuffer is usable — required for the lock-free transport. */
  sharedMemory: boolean;
  backend: string;
}

/** Snapshot decoded from the shared meter block. Reused between reads — do not retain. */
export interface EngineMeters {
  peakInL: number;
  peakInR: number;
  peakOutL: number;
  peakOutR: number;
  rmsInL: number;
  rmsInR: number;
  rmsOutL: number;
  rmsOutR: number;
  clipIn: boolean;
  clipOut: boolean;
  /** 0..1 fraction of the audio callback budget in use. */
  cpu: number;
  latencySamples: number;
  slotCount: number;
  recording: boolean;
  recordedFrames: number;
  recordOverflow: boolean;
  /** Per-slot meter value, indexed by chain position. Semantics per module. */
  slots: Float32Array;
  /** File transport: playhead 0..1, transport state and peak level of the player. */
  filePosition: number;
  filePlaying: boolean;
  fileLevel: number;
}

export interface ScopeFrame {
  input: Float32Array;
  output: Float32Array;
}

/** I/O stage fields. Numeric ids match IO_FIELD in worklet-processor.js. */
export const IO_FIELD = {
  IN_GAIN: 0,
  OUT_GAIN: 1,
  MUTE: 2,
  BYPASS: 3,
  MONO: 4,
  SWAP: 5,
  MASTER_MIX: 6,
} as const;

export type IoField = (typeof IO_FIELD)[keyof typeof IO_FIELD];

/** Command opcodes for the lock-free ring. Must match OP in worklet-processor.js. */
export const OP = {
  PARAM: 1,
  MIX: 2,
  BYPASS: 3,
  MOVE: 4,
  IO: 5,
  CLIPRESET: 6,
  RESET: 7,
  PANIC: 8,
  FILE: 10,
} as const;

/** File-transport fields. Numeric ids match FILE_FIELD in worklet-processor.js. */
export const FILE_FIELD = {
  PLAY: 0,
  SEEK: 1,
  LOOP: 2,
  LOOP_IN: 3,
  LOOP_OUT: 4,
  SPEED: 5,
  PITCH: 6,
  GAIN: 7,
  ROUTE: 8,
} as const;

export type FileField = (typeof FILE_FIELD)[keyof typeof FILE_FIELD];

/** Where a loaded file is routed. Matches FILE_ROUTE in engine.js. */
export const FILE_ROUTE = { OFF: 0, INPUT: 1, CARRIER: 2, BOTH: 3 } as const;

export interface LoadedFile {
  name: string;
  frames: number;
  sampleRate: number;
  duration: number;
  /** Mono peak envelope for the waveform display, built once at load time. */
  peaks: Float32Array;
}

export interface AddSlotSpec {
  id: number;
  type: string;
  params: Record<string, number>;
  mix: number;
  bypassed: boolean;
  /** Insert position; appended when omitted. */
  index?: number;
}

export interface EngineBackend {
  readonly name: string;

  /** Capability flags the UI uses to enable/disable controls honestly. */
  readonly capabilities: {
    /** Can the user pick the hardware sample rate, or is it fixed by the OS? */
    selectableSampleRate: boolean;
    /** Can the buffer size be set exactly, or only hinted? */
    exactBufferSize: boolean;
    /** Exclusive-mode / ASIO style low latency available? */
    lowLatencyExclusive: boolean;
    /** Can we choose the output device from inside the app? */
    outputDeviceSelection: boolean;
  };

  status(): EngineStatus;
  info(): EngineInfo | null;

  enumerateDevices(): Promise<DeviceList>;
  /** Requests mic permission so device labels become readable. */
  requestPermission(): Promise<boolean>;

  start(opts: StartOptions): Promise<EngineInfo>;
  stop(): Promise<void>;
  /** Rebuild the audio graph with new device/latency settings, preserving the chain. */
  restart(opts: StartOptions): Promise<EngineInfo>;

  // ---- chain structure (rare, may allocate) ------------------------------
  addSlot(spec: AddSlotSpec): void;
  removeSlot(id: number): void;
  clearChain(): void;
  /** Replace the entire chain in one message — used by preset loading. */
  setChain(specs: AddSlotSpec[]): void;

  // ---- realtime control (hot path, allocation-free) ----------------------
  setParam(id: number, type: string, key: string, value: number): void;
  setMix(id: number, value: number): void;
  setBypass(id: number, bypassed: boolean): void;
  moveSlot(id: number, index: number): void;
  setIo(field: IoField, value: number): void;
  resetSlot(id: number): void;
  resetClip(): void;
  panic(): void;

  // ---- telemetry ---------------------------------------------------------
  /** Lock-free read of the latest meter block. Returns false on a torn read. */
  readMeters(out: EngineMeters): boolean;
  /** Copies the most recent `frames` samples of input/output into the given frame. */
  readScope(out: ScopeFrame, frames: number): boolean;
  /** Pulls module-specific display data (EQ curve). Async: it round-trips the port. */
  getVisual(id: number): Promise<Float32Array | null>;

  // ---- recording --------------------------------------------------------
  setRecording(recording: boolean, paused: boolean, reset: boolean): void;
  /** Interleaved stereo snapshot of the wet (and optionally dry) capture buffers. */
  readRecording(): { wet: Float32Array; dry: Float32Array } | null;
  /** Frames captured in the current take. */
  recordedFrames(): number;
  /** Max take length in frames. Infinity when the backend streams into JS chunks. */
  recordCapacity(): number;

  /** Raw output tap for the analyser/spectrum, when the backend can expose one. */
  outputNode(): AudioNode | null;
  context(): AudioContext | null;

  dispose(): void;
}

export function createMeters(maxSlots = 24): EngineMeters {
  return {
    peakInL: 0,
    peakInR: 0,
    peakOutL: 0,
    peakOutR: 0,
    rmsInL: 0,
    rmsInR: 0,
    rmsOutL: 0,
    rmsOutR: 0,
    clipIn: false,
    clipOut: false,
    cpu: 0,
    latencySamples: 0,
    slotCount: 0,
    recording: false,
    recordedFrames: 0,
    recordOverflow: false,
    slots: new Float32Array(maxSlots),
    filePosition: 0,
    filePlaying: false,
    fileLevel: 0,
  };
}
