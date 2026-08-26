/**
 * Bro.Kodr — engine client.
 *
 * The single object the UI talks to. It owns:
 *   - which backend is live (native when compiled, AudioWorklet otherwise)
 *   - the authoritative chain state (order, params, mix, bypass) so the UI can render and
 *     presets can be serialised without querying the audio thread
 *   - the I/O stage state
 *   - device/latency settings, persisted to localStorage
 *
 * Two deliberate rules:
 *
 * 1. **Chain state is mirrored, not queried.** The audio thread is the source of truth
 *    for *sound*; this object is the source of truth for *state*. Reading state back from
 *    the audio thread would either block it or lag the UI, so instead every mutation is
 *    applied here and forwarded. On engine restart the mirror is replayed with
 *    `setChain`, which is also exactly what preset loading does.
 *
 * 2. **Meters never go through React state.** They update at 60Hz; routing that through a
 *    store would re-render the tree 60 times a second. Components poll
 *    `client.meters` directly inside their own rAF loop and draw to canvas.
 */

import {
  createMeters,
  type AddSlotSpec,
  type DeviceList,
  type EngineBackend,
  type EngineInfo,
  type EngineMeters,
  type EngineStatus,
  FILE_FIELD,
  type FileField,
  FILE_ROUTE,
  IO_FIELD,
  type LoadedFile,
  type ScopeFrame,
  type StartOptions,
} from "./backend";
import { isNativeAvailable, NativeBackend, NATIVE_UNAVAILABLE_REASON } from "./native-backend";
import { defaultParams, EFFECTS, withDefaults } from "./param-schema";
import { WorkletBackend } from "./worklet-backend";

export interface SlotState {
  id: number;
  type: string;
  params: Record<string, number>;
  mix: number;
  bypassed: boolean;
  /** UI-only: whether the module body is expanded in the rack. */
  collapsed: boolean;
}

export interface IoState {
  inGain: number;
  outGain: number;
  mute: boolean;
  bypass: boolean;
  mono: boolean;
  swap: boolean;
  masterMix: number;
}

export interface DeviceSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  sampleRate: number;
  bufferFrames: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export interface ChainSnapshot {
  slots: SlotState[];
  io: IoState;
}

/** UI-side mirror of the file player. The audio thread owns the playhead only. */
export interface FileState {
  file: LoadedFile | null;
  loading: boolean;
  error: string | null;
  playing: boolean;
  loop: boolean;
  /** Loop in/out as a fraction of the file, 0..1. */
  loopIn: number;
  loopOut: number;
  speed: number;
  pitch: number;
  gain: number;
  /** FILE_ROUTE value: off / input / carrier / both. */
  route: number;
}

export const DEFAULT_FILE_STATE: FileState = {
  file: null,
  loading: false,
  error: null,
  playing: false,
  loop: false,
  loopIn: 0,
  loopOut: 1,
  speed: 1,
  pitch: 0,
  gain: 0,
  route: FILE_ROUTE.INPUT,
};

export interface ClientSnapshot {
  status: EngineStatus;
  error: string | null;
  info: EngineInfo | null;
  slots: SlotState[];
  io: IoState;
  devices: DeviceList;
  settings: DeviceSettings;
  backendName: string;
  nativeAvailable: boolean;
  nativeNote: string;
  activePresetId: string | null;
  dirty: boolean;
  fileState: FileState;
}

export const BUFFER_CHOICES = [128, 256, 384, 512, 768, 1024, 2048];
export const SAMPLE_RATE_CHOICES = [44100, 48000, 88200, 96000];

const SETTINGS_KEY = "brokodr.devices.v1";
const CHAIN_KEY = "brokodr.chain.v1";

export const DEFAULT_IO: IoState = {
  inGain: 0,
  outGain: 0,
  mute: false,
  bypass: false,
  mono: false,
  swap: false,
  masterMix: 1,
};

const DEFAULT_SETTINGS: DeviceSettings = {
  inputDeviceId: "default",
  outputDeviceId: "default",
  sampleRate: 48000,
  bufferFrames: 256,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export class EngineClient {
  private backend: EngineBackend;
  private worklet: WorkletBackend;
  private native: NativeBackend | null = null;

  private listeners = new Set<() => void>();
  private snap: ClientSnapshot;
  private nextId = 1;

  /** Live meter block. Mutated in place at poll rate — read it, never store it. */
  readonly meters: EngineMeters = createMeters();
  readonly scope: ScopeFrame = { input: new Float32Array(2048), output: new Float32Array(2048) };

  constructor() {
    this.worklet = new WorkletBackend();
    if (isNativeAvailable()) {
      this.native = new NativeBackend();
      this.backend = this.native.available ? this.native : this.worklet;
    } else {
      this.backend = this.worklet;
    }

    this.worklet.onStatus((status, error) => {
      this.snap = { ...this.snap, status, error, info: this.worklet.info() };
      this.emit();
    });

    this.snap = {
      status: "idle",
      error: null,
      info: null,
      slots: [],
      io: { ...DEFAULT_IO },
      devices: { inputs: [], outputs: [], labelsAvailable: false },
      settings: loadSettings(),
      backendName: this.backend.name,
      nativeAvailable: this.native?.available ?? false,
      nativeNote: NATIVE_UNAVAILABLE_REASON,
      activePresetId: null,
      dirty: false,
      fileState: { ...DEFAULT_FILE_STATE },
    };

    const restored = loadChain();
    if (restored) {
      this.snap.slots = restored.slots;
      this.snap.io = restored.io;
      this.nextId = restored.slots.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    }
  }

  // ------------------------------------------------------------ react glue

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): ClientSnapshot => this.snap;

  private emit() {
    for (const l of this.listeners) l();
  }

  private update(patch: Partial<ClientSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.emit();
  }

  private touchChain(slots: SlotState[], markDirty = true) {
    this.snap = { ...this.snap, slots, dirty: markDirty ? true : this.snap.dirty };
    saveChain({ slots, io: this.snap.io });
    this.emit();
  }

  // -------------------------------------------------------------- lifecycle

  async refreshDevices(): Promise<DeviceList> {
    const devices = await this.backend.enumerateDevices();
    this.update({ devices });
    return devices;
  }

  async requestPermission(): Promise<boolean> {
    const ok = await this.backend.requestPermission();
    if (ok) await this.refreshDevices();
    return ok;
  }

  private startOptions(): StartOptions {
    const s = this.snap.settings;
    return {
      inputDeviceId: s.inputDeviceId,
      outputDeviceId: s.outputDeviceId,
      sampleRate: s.sampleRate,
      bufferFrames: s.bufferFrames,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
    };
  }

  async start(): Promise<void> {
    const info = await this.backend.start(this.startOptions());
    // Replay the mirrored state onto the fresh engine, in one message.
    this.pushChain();
    this.pushIo();
    this.update({ info, status: this.backend.status(), error: null, backendName: this.backend.name });
    await this.refreshDevices();
  }

  async stop(): Promise<void> {
    await this.backend.stop();
    this.update({ status: "idle", info: null });
  }

  async toggle(): Promise<void> {
    if (this.snap.status === "running") await this.stop();
    else await this.start();
  }

  /** Apply new device/latency settings. Restarts the audio graph, keeps the chain. */
  async applySettings(patch: Partial<DeviceSettings>): Promise<void> {
    const settings = { ...this.snap.settings, ...patch };
    saveSettings(settings);
    this.update({ settings });
    if (this.snap.status === "running") {
      const info = await this.backend.restart(this.startOptions());
      this.pushChain();
      this.pushIo();
      this.update({ info, status: this.backend.status() });
    }
  }

  private pushChain() {
    this.backend.setChain(this.snap.slots.map(toSpec));
  }

  private pushIo() {
    const io = this.snap.io;
    this.backend.setIo(IO_FIELD.IN_GAIN, io.inGain);
    this.backend.setIo(IO_FIELD.OUT_GAIN, io.outGain);
    this.backend.setIo(IO_FIELD.MUTE, io.mute ? 1 : 0);
    this.backend.setIo(IO_FIELD.BYPASS, io.bypass ? 1 : 0);
    this.backend.setIo(IO_FIELD.MONO, io.mono ? 1 : 0);
    this.backend.setIo(IO_FIELD.SWAP, io.swap ? 1 : 0);
    this.backend.setIo(IO_FIELD.MASTER_MIX, io.masterMix);
  }

  // ------------------------------------------------------------------ chain

  addEffect(type: string, index?: number): number | null {
    if (!EFFECTS[type]) return null;
    const def = EFFECTS[type];
    const slot: SlotState = {
      id: this.nextId++,
      type,
      params: defaultParams(type),
      mix: def.defaultMix,
      bypassed: false,
      collapsed: false,
    };
    const slots = [...this.snap.slots];
    const at = index === undefined ? slots.length : Math.max(0, Math.min(index, slots.length));
    slots.splice(at, 0, slot);
    this.backend.addSlot({ ...toSpec(slot), index: at });
    this.touchChain(slots);
    return slot.id;
  }

  removeEffect(id: number) {
    const slots = this.snap.slots.filter((s) => s.id !== id);
    this.backend.removeSlot(id);
    this.touchChain(slots);
  }

  moveEffect(id: number, index: number) {
    const slots = [...this.snap.slots];
    const from = slots.findIndex((s) => s.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(index, slots.length - 1));
    if (from === to) return;
    const [s] = slots.splice(from, 1);
    slots.splice(to, 0, s);
    this.backend.moveSlot(id, to);
    this.touchChain(slots);
  }

  clearChain() {
    this.backend.clearChain();
    this.touchChain([]);
  }

  setParam(id: number, key: string, value: number) {
    const slots = this.snap.slots;
    const i = slots.findIndex((s) => s.id === id);
    if (i < 0) return;
    const slot = slots[i];
    if (slot.params[key] === value) return;
    // Forward first — the audio thread should hear the change before React re-renders.
    this.backend.setParam(id, slot.type, key, value);
    const next = [...slots];
    next[i] = { ...slot, params: { ...slot.params, [key]: value } };
    this.touchChain(next);
  }

  setMix(id: number, value: number) {
    const slots = this.snap.slots;
    const i = slots.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.backend.setMix(id, value);
    const next = [...slots];
    next[i] = { ...next[i], mix: value };
    this.touchChain(next);
  }

  setBypass(id: number, bypassed: boolean) {
    const slots = this.snap.slots;
    const i = slots.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.backend.setBypass(id, bypassed);
    const next = [...slots];
    next[i] = { ...next[i], bypassed };
    this.touchChain(next);
  }

  setCollapsed(id: number, collapsed: boolean) {
    const slots = this.snap.slots;
    const i = slots.findIndex((s) => s.id === id);
    if (i < 0) return;
    const next = [...slots];
    next[i] = { ...next[i], collapsed };
    this.touchChain(next, false);
  }

  resetSlot(id: number) {
    const slots = this.snap.slots;
    const i = slots.findIndex((s) => s.id === id);
    if (i < 0) return;
    const type = slots[i].type;
    const params = defaultParams(type);
    for (const k in params) this.backend.setParam(id, type, k, params[k]);
    this.backend.resetSlot(id);
    const next = [...slots];
    next[i] = { ...next[i], params, mix: EFFECTS[type]?.defaultMix ?? 1 };
    this.backend.setMix(id, next[i].mix);
    this.touchChain(next);
  }

  // --------------------------------------------------------------------- io

  setIo<K extends keyof IoState>(key: K, value: IoState[K]) {
    const io = { ...this.snap.io, [key]: value } as IoState;
    const num = typeof value === "boolean" ? (value ? 1 : 0) : (value as number);
    switch (key) {
      case "inGain":
        this.backend.setIo(IO_FIELD.IN_GAIN, num);
        break;
      case "outGain":
        this.backend.setIo(IO_FIELD.OUT_GAIN, num);
        break;
      case "mute":
        this.backend.setIo(IO_FIELD.MUTE, num);
        break;
      case "bypass":
        this.backend.setIo(IO_FIELD.BYPASS, num);
        break;
      case "mono":
        this.backend.setIo(IO_FIELD.MONO, num);
        break;
      case "swap":
        this.backend.setIo(IO_FIELD.SWAP, num);
        break;
      case "masterMix":
        this.backend.setIo(IO_FIELD.MASTER_MIX, num);
        break;
    }
    this.snap = { ...this.snap, io };
    saveChain({ slots: this.snap.slots, io });
    this.emit();
  }

  resetClip() {
    this.backend.resetClip();
    this.meters.clipIn = false;
    this.meters.clipOut = false;
  }

  panic() {
    this.backend.panic();
  }

  // ---------------------------------------------------------------- presets

  /** Serialise the full signal chain — every module, every parameter, plus the I/O stage. */
  exportChain(): ChainSnapshot {
    return {
      slots: this.snap.slots.map((s) => ({ ...s, params: { ...s.params } })),
      io: { ...this.snap.io },
    };
  }

  /**
   * Replace the chain wholesale. Unknown effect types are dropped and missing params fall
   * back to defaults, so a preset written by an older build still loads.
   */
  loadChain(chain: ChainSnapshot, presetId: string | null = null) {
    const slots: SlotState[] = [];
    for (const s of chain.slots) {
      if (!EFFECTS[s.type]) continue;
      slots.push({
        id: this.nextId++,
        type: s.type,
        params: withDefaults(s.type, s.params),
        mix: Number.isFinite(s.mix) ? s.mix : (EFFECTS[s.type].defaultMix ?? 1),
        bypassed: !!s.bypassed,
        collapsed: !!s.collapsed,
      });
    }
    const io = { ...DEFAULT_IO, ...chain.io };
    this.snap = { ...this.snap, slots, io, activePresetId: presetId, dirty: false };
    this.backend.setChain(slots.map(toSpec));
    this.pushIo();
    saveChain({ slots, io });
    this.emit();
  }

  markPreset(id: string | null) {
    this.update({ activePresetId: id, dirty: false });
  }

  // -------------------------------------------------------------- telemetry

  // ----------------------------------------------------------- file player

  /**
   * Loads a WAV/MP3 into the player. Decoding needs a running AudioContext, so the
   * engine must be started first — the panel says so rather than failing silently.
   */
  async loadFile(file: File) {
    return this.loadAudioBytes(await file.arrayBuffer(), file.name);
  }

  /**
   * Loads raw encoded audio bytes (WAV/MP3) under a display name, without a File object.
   *
   * This is the seam the Voice Lab uses: synthesised speech arrives as bytes from the TTS
   * route, and pushing it through the same player the audio-file panel uses means
   * generated voices get the whole rack, the talk box / vocoder carrier bus, and the
   * recorder's WAV/MP3 export for free — no second signal path to keep in sync.
   */
  async loadAudioBytes(data: ArrayBuffer, name: string) {
    this.updateFile({ loading: true, error: null });
    try {
      if (!this.backend.context()) throw new Error("Start the engine before loading a file");
      const res = await this.worklet.loadFile(data);
      if (!res) throw new Error("Decoder unavailable");
      const loaded: LoadedFile = {
        name,
        frames: res.frames,
        sampleRate: res.sampleRate,
        duration: res.frames / res.sampleRate,
        peaks: res.peaks,
      };
      this.updateFile({
        file: loaded,
        loading: false,
        error: null,
        playing: false,
        loopIn: 0,
        loopOut: 1,
      });
      // Re-assert transport state: the engine resets the player on load.
      const f = this.snap.fileState;
      this.worklet.setFile(FILE_FIELD.LOOP, f.loop ? 1 : 0);
      this.worklet.setFile(FILE_FIELD.LOOP_IN, 0);
      this.worklet.setFile(FILE_FIELD.LOOP_OUT, 1);
      this.worklet.setFile(FILE_FIELD.SPEED, f.speed);
      this.worklet.setFile(FILE_FIELD.PITCH, f.pitch);
      this.worklet.setFile(FILE_FIELD.GAIN, f.gain);
      this.worklet.setFile(FILE_FIELD.ROUTE, f.route);
    } catch (e) {
      this.updateFile({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  unloadFile() {
    this.worklet.clearFile();
    this.updateFile({ ...DEFAULT_FILE_STATE, route: this.snap.fileState.route });
  }

  private pushFile(field: FileField, value: number) {
    this.worklet.setFile(field, value);
  }

  private updateFile(patch: Partial<FileState>) {
    this.snap = { ...this.snap, fileState: { ...this.snap.fileState, ...patch } };
    this.emit();
  }

  filePlay(on: boolean) {
    this.pushFile(FILE_FIELD.PLAY, on ? 1 : 0);
    this.updateFile({ playing: on });
  }

  fileSeek(frac: number) {
    this.pushFile(FILE_FIELD.SEEK, frac);
  }

  fileLoop(on: boolean) {
    this.pushFile(FILE_FIELD.LOOP, on ? 1 : 0);
    this.updateFile({ loop: on });
  }

  fileLoopPoints(inFrac: number, outFrac: number) {
    this.pushFile(FILE_FIELD.LOOP_IN, inFrac);
    this.pushFile(FILE_FIELD.LOOP_OUT, outFrac);
    this.updateFile({ loopIn: inFrac, loopOut: outFrac });
  }

  fileSpeed(v: number) {
    this.pushFile(FILE_FIELD.SPEED, v);
    this.updateFile({ speed: v });
  }

  filePitch(v: number) {
    this.pushFile(FILE_FIELD.PITCH, v);
    this.updateFile({ pitch: v });
  }

  fileGain(v: number) {
    this.pushFile(FILE_FIELD.GAIN, v);
    this.updateFile({ gain: v });
  }

  fileRoute(v: number) {
    this.pushFile(FILE_FIELD.ROUTE, v);
    this.updateFile({ route: v });
  }

  pollMeters(): boolean {
    return this.backend.readMeters(this.meters);
  }

  pollScope(frames = 1024): boolean {
    return this.backend.readScope(this.scope, frames);
  }

  readSpectrum(out: Float32Array): boolean {
    return this.backend === this.worklet ? this.worklet.readSpectrum(out) : false;
  }

  spectrumBins(): number {
    return this.backend === this.worklet ? this.worklet.spectrumBins() : 0;
  }

  getVisual(id: number): Promise<Float32Array | null> {
    return this.backend.getVisual(id);
  }

  // -------------------------------------------------------------- recording

  setRecording(recording: boolean, paused: boolean, reset: boolean) {
    this.backend.setRecording(recording, paused, reset);
  }

  takeRecording() {
    return this.backend === this.worklet ? this.worklet.takeRecording() : null;
  }

  recordedFrames(): number {
    return this.backend.recordedFrames();
  }

  audioContext(): AudioContext | null {
    return this.backend.context();
  }

  sampleRate(): number {
    return this.snap.info?.sampleRate ?? this.snap.settings.sampleRate;
  }

  dispose() {
    this.backend.dispose();
  }
}

function toSpec(s: SlotState): AddSlotSpec {
  return { id: s.id, type: s.type, params: s.params, mix: s.mix, bypassed: s.bypassed };
}

function loadSettings(): DeviceSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<DeviceSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: DeviceSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Private mode / quota — settings just won't persist.
  }
}

function saveChain(c: ChainSnapshot) {
  try {
    localStorage.setItem(CHAIN_KEY, JSON.stringify(c));
  } catch {
    // ignore
  }
}

function loadChain(): ChainSnapshot | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CHAIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChainSnapshot;
    if (!parsed || !Array.isArray(parsed.slots)) return null;
    let id = 1;
    const slots = parsed.slots
      .filter((s) => EFFECTS[s.type])
      .map((s) => ({
        id: id++,
        type: s.type,
        params: withDefaults(s.type, s.params),
        mix: Number.isFinite(s.mix) ? s.mix : 1,
        bypassed: !!s.bypassed,
        collapsed: !!s.collapsed,
      }));
    return { slots, io: { ...DEFAULT_IO, ...parsed.io } };
  } catch {
    return null;
  }
}

let singleton: EngineClient | null = null;

export function getEngineClient(): EngineClient {
  if (!singleton) {
    singleton = new EngineClient();
    // Dev-only handle. Metering bugs in a real-time engine are near-impossible to chase
    // through the UI alone; being able to read the live meter block from the console is
    // worth the two lines. Never exposed in a production build.
    if (import.meta.env.DEV) (window as unknown as { __vk?: EngineClient }).__vk = singleton;
  }
  return singleton;
}
