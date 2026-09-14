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
  /**
   * False when the engine came up without a microphone. Everything downstream still
   * runs — the drum rack, the chain, the recorder — there is simply no live input.
   */
  inputActive: boolean;
  /** Why there is no input, when there isn't one. Null when the mic is live. */
  inputError: string | null;
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
  /** BROBEATS: per-pad peak level, the rack bus, and which pads fired recently. */
  pads: Float32Array;
  padsFired: number;
  drumLevelL: number;
  drumLevelR: number;
  /** Looper: one entry per loop track, reused between reads. */
  loops: LoopTrackMeters[];
  /** Looper bus level, after per-track gain/pan and the bus fader. */
  loopLevelL: number;
  loopLevelR: number;
  /** Transport. `barPhase` is 0..1 through the current bar. */
  bpm: number;
  beatsPerBar: number;
  /** Quantise grid in beats; 0 is off. */
  quantize: number;
  clockRunning: boolean;
  barPhase: number;
  bar: number;
  /** Smart Voice: detector state, last decision, and calibration progress. */
  voice: VoiceMeters;
}

export interface ScopeFrame {
  input: Float32Array;
  output: Float32Array;
  /**
   * How many leading samples of `input`/`output` the last `readScope` actually filled.
   *
   * The buffers are over-allocated (2048) so a caller can ask for any window up to that
   * without reallocating; a caller asking for 1024 leaves the tail untouched. Drawing
   * code MUST use this, not `input.length`, or it renders the stale/zero tail as a dead
   * flat line across the right-hand part of the trace.
   */
  frames: number;
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
  PAD: 11,
  DRUM: 12,
  PADFX: 13,
  LOOP: 14,
  LOOPER: 15,
  CLOCK: 16,
  LOOPFX: 17,
  VOICE: 18,
  VOICECAL: 19,
} as const;

/**
 * Loop sub-fields. Numeric ids match LOOP_FIELD in worklet-processor.js. Transport
 * verbs are their own fields rather than key-table entries because they carry no
 * value — a record punch is the most latency-sensitive thing here after a pad hit.
 */
export const LOOP_FIELD = {
  REC: 0,
  PLAY: 1,
  STOP: 2,
  CLEAR: 3,
  UNDO: 4,
  PARAM: 5,
  CLEARALL: 6,
} as const;

export type LoopField = (typeof LOOP_FIELD)[keyof typeof LOOP_FIELD];

/** Per-track loop params. APPEND ONLY, matches LOOP_KEY in worklet-processor.js. */
export const LOOP_KEY = ["gain", "mute", "solo", "pan", "sync", "source"] as const;
export type LoopKey = (typeof LOOP_KEY)[number];
export function loopKeyIndex(key: LoopKey | string): number {
  return (LOOP_KEY as readonly string[]).indexOf(key);
}

/** Looper-bus params. APPEND ONLY, matches LOOPER_KEY in worklet-processor.js. */
export const LOOPER_KEY = ["gain", "mute"] as const;
export type LooperKey = (typeof LOOPER_KEY)[number];
export function looperKeyIndex(key: LooperKey | string): number {
  return (LOOPER_KEY as readonly string[]).indexOf(key);
}

/** Transport params. APPEND ONLY, matches CLOCK_KEY in worklet-processor.js. */
export const CLOCK_KEY = ["bpm", "beatsPerBar", "quantize", "run", "reset"] as const;
export type ClockKey = (typeof CLOCK_KEY)[number];
export function clockKeyIndex(key: ClockKey | string): number {
  return (CLOCK_KEY as readonly string[]).indexOf(key);
}

/** Loop track lifecycle. Matches LOOP_STATE in core/looper.js. */
export const LOOP_STATE = { EMPTY: 0, REC: 1, PLAY: 2, OVERDUB: 3, STOPPED: 4 } as const;
/** A punch waiting on the quantise grid. Matches LOOP_PENDING in core/looper.js. */
export const LOOP_PENDING = { NONE: 0, REC: 1, PLAY: 2, STOP: 3 } as const;
/** What a track records. Matches LOOP_SOURCE in core/looper.js. */
export const LOOP_SOURCE = { MASTER: 0, DRUMS: 1 } as const;

/** Loop tracks in the deck. Matches LOOP_TRACKS in core/looper.js. */
export const LOOP_TRACKS = 4;

/** Meter values per loop track. Matches LOOP_METER_STRIDE in core/looper.js. */
export const LOOP_METER_STRIDE = 8;
/** First meter offset of the loop block. Matches engine.js `readMeters`. */
export const LOOP_METER_BASE = 68;
/** First meter offset of the transport block, straight after the loop tracks. */
export const TRANSPORT_METER_BASE = LOOP_METER_BASE + LOOP_TRACKS * LOOP_METER_STRIDE;

// ---------------------------------------------------------------- Smart Voice

/**
 * Classes Smart Voice fires, in wire order. APPEND ONLY — the index is persisted in
 * saved profiles. Matches VOICE_CLASS_NAMES in dsp/core/beat-classify.js.
 */
export const VOICE_CLASS_NAMES = ["kick", "snare", "hat", "clap"] as const;
export const VOICE_CLASS_COUNT = 4;

/** FAST commits early when stage 1 is confident; ACCURATE never does. */
export const VOICE_MODE = { FAST: 0, ACCURATE: 1 } as const;

/**
 * Smart Voice parameter names, indexed by wire key. APPEND ONLY — matches VOICE_KEY in
 * dsp/core/beat-classify.js and the mirror table in worklet-processor.js.
 */
export const VOICE_KEY = [
  "enabled", "sensitivity", "floorDb", "minGapMs", "featureMs",
  "mode", "margin", "velMin", "velDb", "monitor",
] as const;
export type VoiceKey = (typeof VOICE_KEY)[number];
export function voiceKeyIndex(key: VoiceKey | string): number {
  return (VOICE_KEY as readonly string[]).indexOf(key);
}

/** Feature axes per class: low, mid, high, zcr. Matches FEATURE_COUNT in beat-classify.js. */
export const VOICE_FEATURE_COUNT = 4;
/** Attack axes per class — the three bands only. */
export const VOICE_ATTACK_COUNT = 3;

/**
 * Parameter defaults. Mirrors VOICE_DEFAULTS in beat-classify.js, with the two booleans
 * as 0/1 because the wire carries numbers. The mirror exists so the UI can show a value
 * before an engine is running; the DSP file remains the source of truth.
 */
export const VOICE_DEFAULTS: Record<VoiceKey, number> = {
  enabled: 0,
  sensitivity: 2.1,
  floorDb: -42,
  minGapMs: 45,
  featureMs: 8,
  mode: VOICE_MODE.FAST,
  margin: 0.62,
  velMin: 0.32,
  velDb: 26,
  monitor: 0,
};

/**
 * UI ranges, and what the client clamps to before a value reaches the ring. Wider than
 * anyone sensibly needs at both ends — the point is that a slider cannot produce a value
 * that silently disables detection, not that taste is enforced here.
 */
export const VOICE_RANGE: Record<VoiceKey, { min: number; max: number; step: number }> = {
  enabled: { min: 0, max: 1, step: 1 },
  sensitivity: { min: 1, max: 6, step: 0.05 },
  floorDb: { min: -80, max: -12, step: 1 },
  minGapMs: { min: 15, max: 250, step: 1 },
  featureMs: { min: 3, max: 30, step: 0.5 },
  mode: { min: 0, max: 1, step: 1 },
  margin: { min: 0.2, max: 0.95, step: 0.01 },
  velMin: { min: 0, max: 0.9, step: 0.01 },
  velDb: { min: 6, max: 48, step: 1 },
  monitor: { min: 0, max: 1, step: 1 },
};

/**
 * Which pad each class fires out of the box. Mirrors DEFAULT_CLASS_PADS in
 * beat-classify.js — row 1 of the default kit layout, plus the clap on pad 5.
 */
export const VOICE_DEFAULT_CLASS_PADS = [0, 1, 2, 5] as const;

/** Calibration sub-fields. Numeric ids match VOICE_CAL in worklet-processor.js. */
export const VOICE_CAL = {
  CENTROID: 0,
  ATTACK: 1,
  PAD: 2,
  CAPTURE: 3,
  CLEAR: 4,
  RESET: 5,
  DETRESET: 6,
} as const;
export type VoiceCalField = (typeof VOICE_CAL)[keyof typeof VOICE_CAL];

/** Meter values Smart Voice writes. Matches VOICE_METER_STRIDE in beat-classify.js. */
export const VOICE_METER_STRIDE = 12;
/**
 * First meter offset of the Smart Voice block: straight after the transport's eight
 * fields. The block is VOICE_METER_STRIDE readouts, then the three live attack bands,
 * then the class->pad map. Matches engine.js `readMeters`.
 */
export const VOICE_METER_BASE = TRANSPORT_METER_BASE + 8;

/** Values per calibration capture row. Matches CAP_STRIDE in beat-classify.js. */
export const VOICE_CAPTURE_STRIDE = 9;

/** One calibration capture, decoded from a `getvoicecaps` pull. */
export interface VoiceCapture {
  /** The class the performer was asked for, not what the classifier guessed. */
  cls: number;
  /** Stage-2 features: low, mid, high, zcr. */
  features: Float32Array;
  /** Stage-1 attack bands: low, mid, high. */
  attack: Float32Array;
  strength: number;
}

/** Smart Voice, decoded from the meter block. */
export interface VoiceMeters {
  enabled: boolean;
  /** Hits detected since the detector was last reset. */
  hits: number;
  /** Last class fired, or -1 before the first hit. */
  lastClass: number;
  lastConf: number;
  lastVel: number;
  /** 1 when the last hit committed on bands alone, 2 when it waited for all features. */
  lastStage: number;
  /** Input envelope the detector sees, linear. */
  level: number;
  lastStrength: number;
  /** Class currently being captured, or -1 when not calibrating. */
  captureClass: number;
  captureCount: number;
  /** Stage-1 decisions stage 2 later disagreed with — the case for ACCURATE mode. */
  corrections: number;
  onsets: number;
  /** Attack bands of the most recent onset, for the live display. */
  band: Float32Array;
  /** Which pad each class fires; -1 means the class is muted. */
  classPads: Int32Array;
}

/** Quantise grid choices in beats. 0 is off. Matches QUANTIZE_CHOICES in core/clock.js. */
export const QUANTIZE_CHOICES = [0, 0.25, 0.5, 1, 2, 4, 8, 16] as const;

export const MIN_BPM = 20;
export const MAX_BPM = 300;

/** One loop track, decoded from the meter block. */
export interface LoopTrackMeters {
  state: number;
  pending: number;
  /** Peak level of this track's playback this block. */
  level: number;
  /** Playhead as a 0..1 fraction of the loop. */
  position: number;
  /** Loop length in frames, or frames captured so far while recording. */
  frames: number;
  chainLength: number;
  /** Overdub passes committed on top of the first take. */
  layers: number;
  canUndo: boolean;
}

/** BROBEATS pad sub-fields. Numeric ids match PAD_FIELD in worklet-processor.js. */
export const PAD_FIELD = { TRIGGER: 0, RELEASE: 1, PARAM: 2 } as const;

/**
 * BROBEATS pad parameter names, indexed by wire key. APPEND ONLY — never reorder or
 * delete. The index is what the command ring and saved kits store, exactly like the
 * effect param tables in param-schema.ts.
 */
export const PAD_KEY = [
  "attack", "decay", "sustain", "release", "hold",
  "pitch", "start", "reverse", "gain", "pan",
  "mode", "velAmount", "choke", "mute",
] as const;

export type PadKey = (typeof PAD_KEY)[number];

export function padKeyIndex(key: PadKey | string): number {
  return (PAD_KEY as readonly string[]).indexOf(key);
}

/** BROBEATS rack fields. APPEND ONLY, matches DRUM_KEY in worklet-processor.js. */
export const DRUM_KEY = ["gain", "mute", "solo", "route"] as const;
export type DrumKey = (typeof DRUM_KEY)[number];
export function drumKeyIndex(key: DrumKey | string): number {
  return (DRUM_KEY as readonly string[]).indexOf(key);
}

/** Where the kit sits in the signal path. Matches DRUM_ROUTE in engine.js. */
export const DRUM_ROUTE = { OFF: 0, DIRECT: 1, CHAIN: 2 } as const;

/** Pads in a BROBEATS rack. */
export const PAD_COUNT = 16;

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

  // ---- BROBEATS ----------------------------------------------------------
  /** Fire a pad. `velocity` is 0..1. The hot path for both the grid and Smart Voice. */
  triggerPad(index: number, velocity: number): void;
  /** Note-off, only meaningful for pads in gate mode. */
  releasePad(index: number): void;
  setPadParam(index: number, key: PadKey, value: number): void;
  setDrumParam(key: DrumKey, value: number): void;
  /** Hand a decoded sample to a pad layer. Transfers, never copies. */
  loadPadSample(index: number, layer: number, data: Float32Array, sampleRate: number): void;
  clearPad(index: number): void;
  /** Silence every pad at once — kit swap, panic, device change. */
  resetDrums(): void;
  /** Structural edit of one pad's own effect chain. */
  padChainCommand(index: number, cmd: Record<string, unknown>): void;
  /** Realtime param change on an effect inside a pad's chain. */
  setPadChainParam(index: number, slotId: number, type: string, key: string, value: number): void;

  // ---- looper ------------------------------------------------------------
  /**
   * Record punch on one track. EMPTY -> REC, REC -> PLAY (which sets the loop length),
   * PLAY -> OVERDUB. Quantised when the grid is on, so it may not take effect this
   * instant — watch the track's `pending` field.
   */
  loopRecord(index: number): void;
  /** Play/stop toggle. STOPPED -> PLAY, PLAY/OVERDUB -> STOPPED. */
  loopPlay(index: number): void;
  /** Stop this track, keeping its audio. */
  loopStop(index: number): void;
  /** Throw away this track's audio and put it back to EMPTY. */
  loopClear(index: number): void;
  /** Drop the most recent overdub layer. */
  loopUndo(index: number): void;
  /** Clear every track at once. */
  loopClearAll(): void;
  setLoopParam(index: number, key: LoopKey, value: number): void;
  /** Looper bus gain/mute — every track at once. */
  setLooperParam(key: LooperKey, value: number): void;
  setClockParam(key: ClockKey, value: number): void;
  /** Structural edit of one loop track's own effect chain. */
  loopChainCommand(index: number, cmd: Record<string, unknown>): void;
  /** Realtime param change on an effect inside a loop track's chain. */
  setLoopChainParam(index: number, slotId: number, type: string, key: string, value: number): void;
  /**
   * Mono peak envelope of a track's recorded audio, for the lane waveform. Async: it
   * round-trips the port, because the audio lives on the worklet side. Null when the
   * track is empty.
   */
  getLoopPeaks(index: number, buckets: number): Promise<Float32Array | null>;

  // ---- Smart Voice -------------------------------------------------------
  /** Detector/classifier parameter. `enabled` and `monitor` are 0/1; the rest are scalars. */
  setVoiceParam(key: VoiceKey, value: number): void;
  /** Move one feature axis of one class centroid — the stage-2 table. */
  setVoiceCentroid(cls: number, feature: number, value: number): void;
  /** Move one attack band of one class centroid — the stage-1 table. */
  setVoiceAttackCentroid(cls: number, band: number, value: number): void;
  /** Route a class to a pad index, or -1 to make that class fire nothing. */
  setVoiceClassPad(cls: number, pad: number): void;
  /**
   * Arm capture for one class: every onset from now is stored with its features instead
   * of only being classified. Pass -1 to disarm.
   */
  setVoiceCapture(cls: number): void;
  /** Throw away every stored capture. */
  clearVoiceCaptures(): void;
  /** Put both centroid tables back to the factory values. */
  resetVoiceCentroids(): void;
  /** Drop any half-measured onset — device change, panic, mode switch. */
  resetVoiceDetector(): void;
  /**
   * Pulls stored captures for the calibration panel. Async: the rows live on the worklet
   * side. `from` is an absolute capture index; rows already dropped from the ring are
   * skipped, so the returned array may start later than asked.
   */
  getVoiceCaptures(from: number, max: number): Promise<{ from: number; total: number; rows: VoiceCapture[] }>;

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
    pads: new Float32Array(PAD_COUNT),
    padsFired: 0,
    drumLevelL: 0,
    drumLevelR: 0,
    loops: Array.from({ length: LOOP_TRACKS }, () => ({
      state: 0,
      pending: 0,
      level: 0,
      position: 0,
      frames: 0,
      chainLength: 0,
      layers: 0,
      canUndo: false,
    })),
    loopLevelL: 0,
    loopLevelR: 0,
    bpm: 120,
    beatsPerBar: 4,
    quantize: 0,
    clockRunning: true,
    barPhase: 0,
    bar: 0,
    voice: {
      enabled: false,
      hits: 0,
      lastClass: -1,
      lastConf: 0,
      lastVel: 0,
      lastStage: 0,
      level: 0,
      lastStrength: 0,
      captureClass: -1,
      captureCount: 0,
      corrections: 0,
      onsets: 0,
      band: new Float32Array(3),
      classPads: new Int32Array(VOICE_CLASS_COUNT),
    },
  };
}
