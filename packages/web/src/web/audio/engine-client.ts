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
  LOOP_SOURCE,
  LOOP_TRACKS,
  MAX_BPM,
  MIN_BPM,
  PAD_COUNT,
  type PadKey,
  type ScopeFrame,
  type StartOptions,
  VOICE_ATTACK_COUNT,
  type VoiceCapture,
  VOICE_CLASS_COUNT,
  VOICE_DEFAULTS,
  VOICE_FEATURE_COUNT,
  VOICE_KEY,
  type VoiceKey,
  VOICE_RANGE,
} from "./backend";
import {
  applyDefaultLayout,
  DEFAULT_PAD_PARAMS,
  emptyKit,
  exportKit as exportKitDoc,
  importKit,
  type KitDocument,
  type KitState,
  loadDrumSynth,
  type PadState,
  type PadSlotState,
  renderPad,
  synthParamsFor,
  type VoiceProfile,
} from "./kit";
import { isNativeAvailable, NativeBackend, NATIVE_UNAVAILABLE_REASON } from "./native-backend";
import { getSample, newSampleId, putSample } from "./sample-store";
import {
  trainVoiceProfile,
  untrainVoiceProfile,
  type VoiceTrainResult,
} from "./voice-train";
import { SYNTH_PARAM_DEFS } from "./pad-params";
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

/**
 * UI mirror of one loop track. Same rule as the chain: the audio thread owns the sound,
 * this owns the state, and the transport/state readouts (position, layers, length) come
 * from the meter block instead of living here.
 */
export interface LoopTrackState {
  index: number;
  name: string;
  /** dB. */
  gain: number;
  /** -1..1. */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Tempo-locked to the clock rather than free-running. */
  sync: boolean;
  /** LOOP_SOURCE value: master bus or the BROBEATS bus alone. */
  source: number;
  /** This track's own effect chain — the same slot shape a pad chain uses. */
  chain: PadSlotState[];
}

/** UI mirror of the loop deck and the transport that drives it. Session-only for now. */
export interface LoopDeckState {
  tracks: LoopTrackState[];
  /** Looper bus gain in dB. */
  gain: number;
  mute: boolean;
  bpm: number;
  beatsPerBar: number;
  /** Punch quantise grid in beats. 0 is off. */
  quantize: number;
  running: boolean;
}

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
  /** BROBEATS: the sixteen pads, their voices, their chains and the kit mixer. */
  kit: KitState;
  /** The loop deck: four tracks and the transport. Not persisted yet. */
  loops: LoopDeckState;
}

export function emptyLoopDeck(): LoopDeckState {
  return {
    tracks: Array.from({ length: LOOP_TRACKS }, (_, i) => ({
      index: i,
      name: `LOOP ${i + 1}`,
      gain: 0,
      pan: 0,
      mute: false,
      solo: false,
      sync: true,
      source: LOOP_SOURCE.MASTER,
      chain: [],
    })),
    gain: 0,
    mute: false,
    bpm: 120,
    beatsPerBar: 4,
    quantize: 4,
    running: true,
  };
}

export const BUFFER_CHOICES = [128, 256, 384, 512, 768, 1024, 2048];
export const SAMPLE_RATE_CHOICES = [44100, 48000, 88200, 96000];

const SETTINGS_KEY = "brokodr.devices.v1";
const CHAIN_KEY = "brokodr.chain.v1";
const KIT_KEY = "brokodr.kit.v1";

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
  readonly scope: ScopeFrame = {
    input: new Float32Array(2048),
    output: new Float32Array(2048),
    frames: 0,
  };

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
      kit: importKit(loadKitDoc()),
      loops: emptyLoopDeck(),
    };

    const restored = loadChain();
    if (restored) {
      this.snap.slots = restored.slots;
      this.snap.io = restored.io;
      this.nextId = restored.slots.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    }
    // Pad-chain slot ids share the master chain's id space, so nothing collides when a
    // pad effect and a rack effect are both addressed by id.
    for (const p of this.snap.kit.pads) {
      for (const s of p.chain) this.nextId = Math.max(this.nextId, s.id + 1);
    }

    // Warm the generator now so the grid can show the stock kit before the engine is
    // started. Buffers only reach the audio thread once there is an engine to take them.
    void this.initKit();
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
    void this.pushKit();
    this.pushLoops();
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
      // Synth pads are rendered at the engine's rate, so a rate change re-renders them.
      void this.pushKit();
      this.pushLoops();
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

  // --------------------------------------------------------------- brobeats

  /**
   * Loads the generator and, on a first run, lays out the stock kit. Safe to call more
   * than once — a kit restored from storage is left exactly as the user left it.
   */
  private async initKit(): Promise<void> {
    const mod = await loadDrumSynth();
    if (!mod) {
      // Without the generator the pads still work; they just start empty and wait for
      // the user to drop samples in. Worth saying so rather than failing silently.
      this.updateKit({ ready: true });
      return;
    }
    const blank = this.snap.kit.pads.every((p) => p.source.kind === "empty");
    const kit = blank ? applyDefaultLayout(this.snap.kit) : this.snap.kit;
    this.snap = { ...this.snap, kit: { ...kit, ready: true } };
    saveKitDoc(exportKitDoc(this.snap.kit));
    this.emit();
    await this.restoreKitSamples();
    if (this.snap.status === "running") await this.pushKit();
  }

  /**
   * Replays the whole kit onto a fresh engine: voice params, pad chains, kit mixer, and
   * a freshly rendered one-shot for every synth pad. Sample pads whose audio only ever
   * lived in memory come back empty — the pad keeps its name so the user can see what to
   * re-drop.
   */
  private async pushKit(): Promise<void> {
    const kit = this.snap.kit;
    this.backend.setDrumParam("gain", kit.gain);
    this.backend.setDrumParam("mute", kit.mute ? 1 : 0);
    this.backend.setDrumParam("solo", kit.solo);
    this.backend.setDrumParam("route", kit.route);
    this.pushVoice();

    await loadDrumSynth();
    const sr = this.sampleRate();
    for (const pad of kit.pads) {
      for (const key in pad.params) {
        this.backend.setPadParam(pad.index, key as PadKey, pad.params[key]);
      }
      this.backend.padChainCommand(pad.index, { op: "clear" });
      for (const slot of pad.chain) {
        this.backend.padChainCommand(pad.index, {
          op: "add",
          id: slot.id,
          type: slot.type,
          params: slot.params,
          mix: slot.mix,
          bypassed: slot.bypassed,
        });
      }
      if (pad.source.kind === "synth") this.renderSynthPad(pad.index, sr);
      // Sample pads come back from the sample store rather than from memory. That is
      // what makes a restored kit audible instead of a grid of names, and it also closes
      // an older hole: a sample dropped while the engine was in standby never reached
      // the worklet, because there was no node to post it to. Now it is on disk (or in
      // IndexedDB) by then, so ENGAGE picks it up like any other.
      else if (pad.source.kind === "sample" && pad.source.sampleId) {
        await this.restorePadSample(pad.index);
      }
    }
  }

  /**
   * Writes a pad's audio to the sample store and confirms the id on the pad.
   *
   * Fire-and-forget on purpose: a drop must feel instant and must not wait on a disk or
   * an IndexedDB transaction, and the sound is already playing from memory by the time
   * this starts. If the write fails the id is cleared, so the pad honestly reads as
   * "loaded now, gone after a reload" rather than pointing at audio that isn't there.
   */
  private storeSample(
    index: number,
    id: string,
    name: string,
    data: Float32Array,
    sampleRate: number,
  ): void {
    // A copy, because the caller's buffer may be a view into a larger capture that the
    // editor goes on to mutate — the store must keep what was sent, not what it becomes.
    const snapshot = data.slice();
    void putSample(name, snapshot, sampleRate, id).then((meta) => {
      const pad = this.snap.kit.pads[index];
      if (!pad || pad.source.sampleId !== id) return; // pad moved on; nothing to confirm
      if (meta) return;
      this.updatePad(index, { source: { ...pad.source, sampleId: null } });
    });
  }

  /**
   * Pulls one pad's audio back out of the sample store and into its voice. Returns false
   * when the sample is gone — the pad then keeps its name and stays silent, which is the
   * same place a kit from before the store existed lands.
   */
  private async restorePadSample(index: number): Promise<boolean> {
    const pad = this.snap.kit.pads[index];
    const id = pad?.source.sampleId;
    if (!pad || pad.source.kind !== "sample" || !id) return false;
    const stored = await getSample(id);
    if (!stored || stored.data.length === 0) return false;
    this.backend.loadPadSample(index, 0, stored.data, stored.meta.sampleRate);
    // Straight into the snapshot rather than through updatePad: this is restoring what
    // the document already says, so it must not mark anything dirty or rewrite the kit.
    const current = this.snap.kit.pads[index];
    const pads = [...this.snap.kit.pads];
    pads[index] = {
      ...current,
      source: { ...current.source, frames: stored.data.length, sampleRate: stored.meta.sampleRate },
    };
    this.snap = { ...this.snap, kit: { ...this.snap.kit, pads } };
    return true;
  }

  /**
   * Restores every sample pad in the current kit. Run once at startup so the grid shows
   * real waveform lengths before the engine is even started.
   */
  private async restoreKitSamples(): Promise<void> {
    const ids = this.snap.kit.pads
      .filter((p) => p.source.kind === "sample" && p.source.sampleId)
      .map((p) => p.index);
    if (!ids.length) return;
    let any = false;
    for (const i of ids) any = (await this.restorePadSample(i)) || any;
    if (any) this.emit();
  }

  /** Every sample id the current kit points at — the live set for `pruneSamples()`. */
  usedSampleIds(): string[] {
    const ids = new Set<string>();
    for (const p of this.snap.kit.pads) if (p.source.sampleId) ids.add(p.source.sampleId);
    return [...ids];
  }

  /** Renders a synth pad's one-shot here and hands the finished buffer to the voice. */
  private renderSynthPad(index: number, sampleRate?: number): boolean {
    const pad = this.snap.kit.pads[index];
    if (!pad || pad.source.kind !== "synth") return false;
    const sr = sampleRate ?? this.sampleRate();
    const res = renderPad(pad.source.synth, sr, pad.source.synthParams);
    if (!res) return false;
    this.backend.loadPadSample(index, 0, res.data.subarray(0, res.frames), sr);
    const pads = [...this.snap.kit.pads];
    pads[index] = { ...pad, source: { ...pad.source, frames: res.frames, sampleRate: sr } };
    this.snap = { ...this.snap, kit: { ...this.snap.kit, pads } };
    return true;
  }

  private updateKit(patch: Partial<KitState>, persist = true) {
    const kit = { ...this.snap.kit, ...patch };
    this.snap = { ...this.snap, kit };
    if (persist) saveKitDoc(exportKitDoc(kit));
    this.emit();
  }

  /** Replaces one pad and re-emits. Every pad mutation goes through here. */
  private updatePad(index: number, patch: Partial<PadState>, persist = true) {
    const pads = [...this.snap.kit.pads];
    const pad = pads[index];
    if (!pad) return;
    pads[index] = { ...pad, ...patch };
    this.updateKit({ pads }, persist);
  }

  // --- performance

  /** Fire a pad. The hot path: the grid, the keyboard, and later Smart Voice. */
  triggerPad(index: number, velocity = 1) {
    this.backend.triggerPad(index, velocity);
  }

  releasePad(index: number) {
    this.backend.releasePad(index);
  }

  // --- voice

  setPadParam(index: number, key: PadKey, value: number) {
    const pad = this.snap.kit.pads[index];
    if (!pad || pad.params[key] === value) return;
    this.backend.setPadParam(index, key, value);
    this.updatePad(index, { params: { ...pad.params, [key]: value } });
  }

  resetPadParams(index: number) {
    const pad = this.snap.kit.pads[index];
    if (!pad) return;
    const params = { ...DEFAULT_PAD_PARAMS };
    for (const key in params) this.backend.setPadParam(index, key as PadKey, params[key]);
    this.updatePad(index, { params });
  }

  setPadName(index: number, name: string) {
    this.updatePad(index, { name });
  }

  // --- pad content

  /** Points a pad at a generator kind and renders it. */
  setPadSynth(index: number, kind: string, overrides?: Record<string, number>) {
    const pad = this.snap.kit.pads[index];
    if (!pad) return;
    this.updatePad(index, {
      source: {
        kind: "synth",
        synth: kind,
        synthParams: { ...(overrides || {}) },
        sampleName: null,
        sampleId: null,
        frames: 0,
        sampleRate: 0,
      },
    });
    this.renderSynthPad(index);
    this.emit();
  }

  /** Turns one generator knob and re-renders that pad. Cheap enough to do live. */
  setPadSynthParam(index: number, key: string, value: number) {
    const pad = this.snap.kit.pads[index];
    if (!pad || pad.source.kind !== "synth") return;
    // Clamp to the generator's declared range. The knob already does this, but an
    // imported kit or a scripted call can hand us anything, and drum-synth.js has no
    // guard of its own — an out-of-range tune renders a broken one-shot, not an error.
    const def = (SYNTH_PARAM_DEFS[pad.source.synth] || []).find((d) => d.key === key);
    const v = def ? Math.min(def.max, Math.max(def.min, value)) : value;
    const synthParams = { ...pad.source.synthParams, [key]: v };
    this.updatePad(index, { source: { ...pad.source, synthParams } });
    this.renderSynthPad(index);
    this.emit();
  }

  /** Effective generator settings for a synth pad: stock values plus its overrides. */
  padSynthParams(index: number): Record<string, number> {
    const pad = this.snap.kit.pads[index];
    if (!pad || pad.source.kind !== "synth") return {};
    return synthParamsFor(pad.source.synth, pad.source.synthParams);
  }

  /**
   * Drops a user sample onto a pad. Decoding needs a running AudioContext, so the engine
   * must be started first — the grid says so rather than swallowing the drop.
   *
   * The voice plays mono buffers, so a stereo file is summed. That is the right call for
   * a drum: the pad has its own pan, and a stereo sample would fight it.
   */
  async loadPadFile(index: number, file: File, layer = 0): Promise<string | null> {
    try {
      const ctx = this.backend.context();
      if (!ctx) return "Start the engine before loading a sample";
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const frames = buf.length;
      const mono = new Float32Array(frames);
      const chans = Math.max(1, buf.numberOfChannels);
      for (let c = 0; c < chans; c++) {
        const src = buf.getChannelData(c);
        for (let i = 0; i < frames; i++) mono[i] += src[i];
      }
      if (chans > 1) for (let i = 0; i < frames; i++) mono[i] /= chans;

      this.backend.loadPadSample(index, layer, mono, buf.sampleRate);
      const sampleId = newSampleId();
      this.updatePad(index, {
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 18),
        source: {
          kind: "sample",
          synth: "",
          synthParams: {},
          sampleName: file.name,
          sampleId,
          frames,
          sampleRate: buf.sampleRate,
        },
      });
      this.storeSample(index, sampleId, file.name, mono, buf.sampleRate);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Drops an already-decoded mono buffer onto a pad.
   *
   * This is what the sample editor sends through: by the time a slice or a trimmed take
   * reaches a pad it is PCM in memory, never a File, so routing it back through
   * `loadPadFile` would mean re-encoding a WAV only to decode it again. The two share the
   * same tail — hand the backend the buffer, then describe it on the pad — and the mono
   * sum has already happened in `sample-edit.ts`.
   *
   * Unlike `loadPadFile` this needs no AudioContext, so it works with the engine in
   * standby: the buffer is staged and plays on ENGAGE.
   */
  loadPadBuffer(index: number, mono: Float32Array, sampleRate: number, name: string, layer = 0) {
    const pad = this.snap.kit.pads[index];
    if (!pad) return;
    this.backend.loadPadSample(index, layer, mono, sampleRate);
    const sampleId = newSampleId();
    this.updatePad(index, {
      name: name.slice(0, 18),
      source: {
        kind: "sample",
        synth: "",
        synthParams: {},
        sampleName: name,
        sampleId,
        frames: mono.length,
        sampleRate,
      },
    });
    this.storeSample(index, sampleId, name, mono, sampleRate);
    this.emit();
  }

  /** Empties a pad — sample layers and its effect chain both. */
  clearPad(index: number) {
    const pad = this.snap.kit.pads[index];
    if (!pad) return;
    this.backend.clearPad(index);
    this.updatePad(index, {
      name: `Pad ${index + 1}`,
      // The audio itself is left in the sample store: the same id can be on other pads
      // and inside saved kits, so clearing a pad is not a licence to delete a sound.
      // `pruneSamples()` is the deliberate sweep for that.
      source: {
        kind: "empty",
        synth: "",
        synthParams: {},
        sampleName: null,
        sampleId: null,
        frames: 0,
        sampleRate: 0,
      },
      chain: [],
    });
  }

  // --- kit mixer

  setKitGain(db: number) {
    this.backend.setDrumParam("gain", db);
    this.updateKit({ gain: db });
  }

  setKitMute(mute: boolean) {
    this.backend.setDrumParam("mute", mute ? 1 : 0);
    this.updateKit({ mute });
  }

  /** Solo is a performance control, so it is not persisted with the kit. */
  setKitSolo(index: number) {
    const solo = this.snap.kit.solo === index ? -1 : index;
    this.backend.setDrumParam("solo", solo);
    this.updateKit({ solo }, false);
  }

  setKitRoute(route: number) {
    this.backend.setDrumParam("route", route);
    this.updateKit({ route });
  }

  setKitName(name: string) {
    this.updateKit({ name });
  }

  // --- pad effect chains

  addPadEffect(index: number, type: string, at?: number): number | null {
    const pad = this.snap.kit.pads[index];
    if (!pad || !EFFECTS[type]) return null;
    const slot: PadSlotState = {
      id: this.nextId++,
      type,
      params: defaultParams(type),
      mix: EFFECTS[type].defaultMix,
      bypassed: false,
    };
    const chain = [...pad.chain];
    const pos = at === undefined ? chain.length : Math.max(0, Math.min(at, chain.length));
    chain.splice(pos, 0, slot);
    this.backend.padChainCommand(index, {
      op: "add",
      id: slot.id,
      type,
      params: slot.params,
      mix: slot.mix,
      bypassed: false,
      index: pos,
    });
    this.updatePad(index, { chain });
    return slot.id;
  }

  removePadEffect(index: number, id: number) {
    const pad = this.snap.kit.pads[index];
    if (!pad) return;
    this.backend.padChainCommand(index, { op: "remove", id });
    this.updatePad(index, { chain: pad.chain.filter((s) => s.id !== id) });
  }

  movePadEffect(index: number, id: number, at: number) {
    const pad = this.snap.kit.pads[index];
    if (!pad) return;
    const chain = [...pad.chain];
    const from = chain.findIndex((s) => s.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(at, chain.length - 1));
    if (from === to) return;
    const [s] = chain.splice(from, 1);
    chain.splice(to, 0, s);
    this.backend.padChainCommand(index, { op: "move", id, at: to });
    this.updatePad(index, { chain });
  }

  setPadEffectParam(index: number, id: number, key: string, value: number) {
    const pad = this.snap.kit.pads[index];
    if (!pad) return;
    const i = pad.chain.findIndex((s) => s.id === id);
    if (i < 0 || pad.chain[i].params[key] === value) return;
    // Realtime params go down the ring buffer; the mirror updates after.
    this.backend.setPadChainParam(index, id, pad.chain[i].type, key, value);
    const chain = [...pad.chain];
    chain[i] = { ...chain[i], params: { ...chain[i].params, [key]: value } };
    this.updatePad(index, { chain });
  }

  setPadEffectMix(index: number, id: number, value: number) {
    const pad = this.snap.kit.pads[index];
    if (!pad) return;
    const i = pad.chain.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.backend.padChainCommand(index, { op: "mix", id, value });
    const chain = [...pad.chain];
    chain[i] = { ...chain[i], mix: value };
    this.updatePad(index, { chain });
  }

  setPadEffectBypass(index: number, id: number, bypassed: boolean) {
    const pad = this.snap.kit.pads[index];
    if (!pad) return;
    const i = pad.chain.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.backend.padChainCommand(index, { op: "bypass", id, value: bypassed ? 1 : 0 });
    const chain = [...pad.chain];
    chain[i] = { ...chain[i], bypassed };
    this.updatePad(index, { chain });
  }

  clearPadChain(index: number) {
    if (!this.snap.kit.pads[index]) return;
    this.backend.padChainCommand(index, { op: "clear" });
    this.updatePad(index, { chain: [] });
  }

  // ----------------------------------------------------------- smart voice
  //
  // The detector's state lives in the kit document (a calibration belongs to the mouth
  // *and* the sounds it was trained against), so every mutation here goes through
  // `updateKit` and autosaves with the rest of the kit.
  //
  // Live readouts — what it last heard, how confident it was, how many hits it has
  // detected — are not here. They come off the meter block as `meters.voice`, the same
  // way pad levels do: state on this side, measurement from the audio thread.

  /** Replays the profile onto a fresh engine. Called as part of `pushKit`. */
  private pushVoice() {
    const v = this.snap.kit.voice;
    for (const key of VOICE_KEY) {
      const value = v.params[key];
      if (value !== undefined) this.backend.setVoiceParam(key, value);
    }
    for (let c = 0; c < VOICE_CLASS_COUNT; c++) {
      this.backend.setVoiceClassPad(c, v.classPads[c] ?? -1);
    }
    // Factory rows are left alone rather than pushed as zeros: an untrained class must
    // keep the measured table `beat-classify.js` ships, not a centroid at the origin.
    this.backend.resetVoiceCentroids();
    for (let c = 0; c < VOICE_CLASS_COUNT; c++) {
      if (!v.trained[c]) continue;
      for (let f = 0; f < VOICE_FEATURE_COUNT; f++) {
        this.backend.setVoiceCentroid(c, f, v.centroids[c * VOICE_FEATURE_COUNT + f] ?? 0);
      }
      for (let b = 0; b < VOICE_ATTACK_COUNT; b++) {
        this.backend.setVoiceAttackCentroid(c, b, v.attack[c * VOICE_ATTACK_COUNT + b] ?? 0);
      }
    }
  }

  private updateVoice(patch: Partial<VoiceProfile>) {
    this.updateKit({ voice: { ...this.snap.kit.voice, ...patch } });
  }

  /** Master switch. Off means the detector is not even run, so it costs nothing. */
  setVoiceEnabled(on: boolean) {
    this.setVoiceParam("enabled", on ? 1 : 0);
  }

  get voiceEnabled(): boolean {
    return (this.snap.kit.voice.params.enabled ?? 0) >= 0.5;
  }

  /** One detector parameter, clamped to its published range before it reaches the ring. */
  setVoiceParam(key: VoiceKey, value: number) {
    if (!Number.isFinite(value)) return;
    const r = VOICE_RANGE[key];
    const v = Math.max(r.min, Math.min(r.max, value));
    const params = this.snap.kit.voice.params;
    if (params[key] === v) return;
    this.backend.setVoiceParam(key, v);
    this.updateVoice({ params: { ...params, [key]: v } });
  }

  /** Every detector parameter back to factory. Calibration is untouched. */
  resetVoiceParams() {
    const params: Record<string, number> = {};
    for (const key of VOICE_KEY) {
      params[key] = VOICE_DEFAULTS[key];
      this.backend.setVoiceParam(key, VOICE_DEFAULTS[key]);
    }
    this.updateVoice({ params });
  }

  /** Route a class to a pad, or -1 to make that class fire nothing. */
  setVoiceClassPad(cls: number, pad: number) {
    if (cls < 0 || cls >= VOICE_CLASS_COUNT) return;
    const p = pad >= 0 && pad < PAD_COUNT ? pad | 0 : -1;
    const classPads = [...this.snap.kit.voice.classPads];
    if (classPads[cls] === p) return;
    classPads[cls] = p;
    this.backend.setVoiceClassPad(cls, p);
    this.updateVoice({ classPads });
  }

  // --- calibration

  /**
   * Arms capture for one class: from now, every onset is stored with both its feature
   * vectors instead of only being classified. Pass -1 to stop.
   *
   * Nothing is trained until `applyVoiceCalibration` is called, so an armed detector is
   * safe to leave running and a bad take can simply be cleared.
   */
  captureVoiceClass(cls: number) {
    this.backend.setVoiceCapture(cls >= 0 && cls < VOICE_CLASS_COUNT ? cls | 0 : -1);
  }

  stopVoiceCapture() {
    this.backend.setVoiceCapture(-1);
  }

  clearVoiceCaptures() {
    this.backend.clearVoiceCaptures();
  }

  /** Drops any half-measured onset. Worth a call on device change or mode switch. */
  resetVoiceDetector() {
    this.backend.resetVoiceDetector();
  }

  /**
   * Pulls captured hits for the calibration panel. `from` is an absolute capture index —
   * pass the count you have already seen and you get only what is new. The reply says
   * where it actually starts, because the ring holds the last 64 and a slow poll can
   * miss hits.
   */
  pullVoiceCaptures(from = 0, max = 64): Promise<{ from: number; total: number; rows: VoiceCapture[] }> {
    return this.backend.getVoiceCaptures(from, max);
  }

  /**
   * Turns captured hits into this kit's centroid tables, pushes them, and saves.
   *
   * Returns the per-class outcome so the panel can say "kick: 7 of 8 used" and refuse to
   * claim a class was calibrated when it wasn't — a class with too few usable hits keeps
   * the factory row (see `voice-train.ts`).
   */
  applyVoiceCalibration(rows: VoiceCapture[]): VoiceTrainResult {
    const result = trainVoiceProfile(this.snap.kit.voice, rows);
    this.updateVoice(result.profile);
    if (this.snap.status === "running") this.pushVoice();
    return result;
  }

  /**
   * Puts a whole profile back exactly as it was — the calibration panel's undo.
   *
   * `applyVoiceCalibration` is not reversible by `resetVoiceCalibration`: reset puts a
   * class back to *factory*, which is the wrong answer for someone who had a good
   * calibration, ran a bad take over the top of it, and wants their old one. The panel
   * snapshots the profile before a pass and hands it back here.
   */
  restoreVoiceProfile(profile: VoiceProfile) {
    this.updateVoice(profile);
    if (this.snap.status === "running") this.pushVoice();
  }

  /** Forgets calibration for one class, or every class with -1. Params survive. */
  resetVoiceCalibration(cls = -1) {
    this.updateVoice(untrainVoiceProfile(this.snap.kit.voice, cls));
    if (this.snap.status === "running") this.pushVoice();
  }

  // ------------------------------------------------------------------ looper
  //
  // Recorded audio is session-only: it lives in the engine's track buffers and nowhere
  // else. Saving loops alongside a kit is a later phase, so nothing here touches
  // localStorage or the sample store. An engine restart replays the mixer and the
  // transport (`pushLoops`) and the takes are gone — which is honest, because the audio
  // that recorded them is gone too.

  private updateLoops(patch: Partial<LoopDeckState>) {
    this.snap = { ...this.snap, loops: { ...this.snap.loops, ...patch } };
    this.emit();
  }

  private updateLoopTrack(index: number, patch: Partial<LoopTrackState>) {
    const tracks = [...this.snap.loops.tracks];
    const t = tracks[index];
    if (!t) return;
    tracks[index] = { ...t, ...patch };
    this.updateLoops({ tracks });
  }

  /** Replays the deck's mixer and transport onto a fresh engine. Takes do not survive. */
  private pushLoops() {
    const d = this.snap.loops;
    this.backend.setClockParam("bpm", d.bpm);
    this.backend.setClockParam("beatsPerBar", d.beatsPerBar);
    this.backend.setClockParam("quantize", d.quantize);
    this.backend.setClockParam("run", d.running ? 1 : 0);
    this.backend.setLooperParam("gain", d.gain);
    this.backend.setLooperParam("mute", d.mute ? 1 : 0);
    for (const t of d.tracks) {
      this.backend.setLoopParam(t.index, "gain", t.gain);
      this.backend.setLoopParam(t.index, "pan", t.pan);
      this.backend.setLoopParam(t.index, "mute", t.mute ? 1 : 0);
      this.backend.setLoopParam(t.index, "solo", t.solo ? 1 : 0);
      this.backend.setLoopParam(t.index, "sync", t.sync ? 1 : 0);
      this.backend.setLoopParam(t.index, "source", t.source);
      this.backend.loopChainCommand(t.index, { op: "clear" });
      for (const s of t.chain) {
        this.backend.loopChainCommand(t.index, {
          op: "add",
          id: s.id,
          type: s.type,
          params: s.params,
          mix: s.mix,
          bypassed: s.bypassed,
        });
      }
    }
    // A restarted engine has empty buffers, so any UI state that described a take is
    // stale. The meter block reports EMPTY on the next poll and the lanes follow.
  }

  // --- transport

  /** One punch. EMPTY -> record, REC -> close the loop and play, PLAY -> overdub. */
  loopRecord(index: number) {
    this.backend.loopRecord(index);
  }

  loopPlay(index: number) {
    this.backend.loopPlay(index);
  }

  loopStop(index: number) {
    this.backend.loopStop(index);
  }

  loopClear(index: number) {
    this.backend.loopClear(index);
  }

  loopUndo(index: number) {
    this.backend.loopUndo(index);
  }

  loopClearAll() {
    this.backend.loopClearAll();
  }

  setBpm(bpm: number) {
    const v = Math.max(MIN_BPM, Math.min(MAX_BPM, bpm));
    if (!Number.isFinite(v)) return;
    this.backend.setClockParam("bpm", v);
    this.updateLoops({ bpm: v });
  }

  setBeatsPerBar(beats: number) {
    const v = Math.max(1, Math.min(16, Math.round(beats)));
    this.backend.setClockParam("beatsPerBar", v);
    this.updateLoops({ beatsPerBar: v });
  }

  /** Quantise grid in beats. 0 turns quantising off — punches land immediately. */
  setQuantize(beats: number) {
    this.backend.setClockParam("quantize", beats);
    this.updateLoops({ quantize: beats });
  }

  setTransportRun(on: boolean) {
    this.backend.setClockParam("run", on ? 1 : 0);
    this.updateLoops({ running: on });
  }

  resetTransport() {
    this.backend.setClockParam("reset", 1);
  }

  // --- deck mixer

  setLooperGain(db: number) {
    this.backend.setLooperParam("gain", db);
    this.updateLoops({ gain: db });
  }

  setLooperMute(mute: boolean) {
    this.backend.setLooperParam("mute", mute ? 1 : 0);
    this.updateLoops({ mute });
  }

  setLoopGain(index: number, db: number) {
    this.backend.setLoopParam(index, "gain", db);
    this.updateLoopTrack(index, { gain: db });
  }

  setLoopPan(index: number, pan: number) {
    const v = Math.max(-1, Math.min(1, pan));
    this.backend.setLoopParam(index, "pan", v);
    this.updateLoopTrack(index, { pan: v });
  }

  setLoopMute(index: number, mute: boolean) {
    this.backend.setLoopParam(index, "mute", mute ? 1 : 0);
    this.updateLoopTrack(index, { mute });
  }

  /** Per-track solo, not a single-selection radio: soloing two lanes plays both. */
  setLoopSolo(index: number, solo: boolean) {
    this.backend.setLoopParam(index, "solo", solo ? 1 : 0);
    this.updateLoopTrack(index, { solo });
  }

  setLoopSync(index: number, sync: boolean) {
    this.backend.setLoopParam(index, "sync", sync ? 1 : 0);
    this.updateLoopTrack(index, { sync });
  }

  setLoopSource(index: number, source: number) {
    this.backend.setLoopParam(index, "source", source);
    this.updateLoopTrack(index, { source });
  }

  setLoopName(index: number, name: string) {
    this.updateLoopTrack(index, { name });
  }

  /** Waveform for one lane, pulled on demand. Null when the lane is empty. */
  getLoopPeaks(index: number, buckets = 480): Promise<Float32Array | null> {
    return this.backend.getLoopPeaks(index, buckets);
  }

  // --- loop effect chains (same protocol as the pad chains, deliberately)

  addLoopEffect(index: number, type: string, at?: number): number | null {
    const track = this.snap.loops.tracks[index];
    if (!track || !EFFECTS[type]) return null;
    const slot: PadSlotState = {
      id: this.nextId++,
      type,
      params: defaultParams(type),
      mix: EFFECTS[type].defaultMix,
      bypassed: false,
    };
    const chain = [...track.chain];
    const pos = at === undefined ? chain.length : Math.max(0, Math.min(at, chain.length));
    chain.splice(pos, 0, slot);
    this.backend.loopChainCommand(index, {
      op: "add",
      id: slot.id,
      type,
      params: slot.params,
      mix: slot.mix,
      bypassed: false,
      index: pos,
    });
    this.updateLoopTrack(index, { chain });
    return slot.id;
  }

  removeLoopEffect(index: number, id: number) {
    const track = this.snap.loops.tracks[index];
    if (!track) return;
    this.backend.loopChainCommand(index, { op: "remove", id });
    this.updateLoopTrack(index, { chain: track.chain.filter((s) => s.id !== id) });
  }

  moveLoopEffect(index: number, id: number, at: number) {
    const track = this.snap.loops.tracks[index];
    if (!track) return;
    const chain = [...track.chain];
    const from = chain.findIndex((s) => s.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(at, chain.length - 1));
    if (from === to) return;
    const [s] = chain.splice(from, 1);
    chain.splice(to, 0, s);
    this.backend.loopChainCommand(index, { op: "move", id, at: to });
    this.updateLoopTrack(index, { chain });
  }

  setLoopEffectParam(index: number, id: number, key: string, value: number) {
    const track = this.snap.loops.tracks[index];
    if (!track) return;
    const i = track.chain.findIndex((s) => s.id === id);
    if (i < 0 || track.chain[i].params[key] === value) return;
    this.backend.setLoopChainParam(index, id, track.chain[i].type, key, value);
    const chain = [...track.chain];
    chain[i] = { ...chain[i], params: { ...chain[i].params, [key]: value } };
    this.updateLoopTrack(index, { chain });
  }

  setLoopEffectMix(index: number, id: number, value: number) {
    const track = this.snap.loops.tracks[index];
    if (!track) return;
    const i = track.chain.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.backend.loopChainCommand(index, { op: "mix", id, value });
    const chain = [...track.chain];
    chain[i] = { ...chain[i], mix: value };
    this.updateLoopTrack(index, { chain });
  }

  setLoopEffectBypass(index: number, id: number, bypassed: boolean) {
    const track = this.snap.loops.tracks[index];
    if (!track) return;
    const i = track.chain.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.backend.loopChainCommand(index, { op: "bypass", id, value: bypassed ? 1 : 0 });
    const chain = [...track.chain];
    chain[i] = { ...chain[i], bypassed };
    this.updateLoopTrack(index, { chain });
  }

  clearLoopChain(index: number) {
    if (!this.snap.loops.tracks[index]) return;
    this.backend.loopChainCommand(index, { op: "clear" });
    this.updateLoopTrack(index, { chain: [] });
  }

  // --- kit documents

  exportKit(): KitDocument {
    return exportKitDoc(this.snap.kit);
  }

  /** Replaces the whole kit, then replays it onto the engine. */
  async loadKit(doc: Partial<KitDocument>): Promise<void> {
    const kit = importKit(doc);
    for (const p of kit.pads) {
      for (const s of p.chain) this.nextId = Math.max(this.nextId, s.id + 1);
    }
    this.snap = { ...this.snap, kit: { ...kit, ready: true } };
    saveKitDoc(exportKitDoc(kit));
    this.emit();
    await this.pushKit();
    this.emit();
  }

  /** Back to the stock sixteen pads. */
  async resetKit(): Promise<void> {
    this.backend.resetDrums();
    const kit = applyDefaultLayout(emptyKit());
    this.snap = { ...this.snap, kit: { ...kit, ready: true } };
    saveKitDoc(exportKitDoc(kit));
    this.emit();
    await this.pushKit();
    this.emit();
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
    const got = this.backend.readScope(this.scope, frames);
    // Record the filled window so consumers never draw the untouched tail.
    this.scope.frames = got ? Math.min(frames, this.scope.input.length) : 0;
    return got;
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

function saveKitDoc(doc: KitDocument) {
  try {
    localStorage.setItem(KIT_KEY, JSON.stringify(doc));
  } catch {
    // ignore
  }
}

function loadKitDoc(): Partial<KitDocument> | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(KIT_KEY);
    return raw ? (JSON.parse(raw) as Partial<KitDocument>) : null;
  } catch {
    return null;
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
