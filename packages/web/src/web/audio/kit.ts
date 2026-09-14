/**
 * Bro.Kodr — BROBEATS kit state.
 *
 * The UI-side model of the drum rack: what sits on each of the sixteen pads, how its
 * voice is shaped, and what the kit-level mixer is doing. `EngineClient` owns an
 * instance of this and mirrors it to the audio thread, exactly the way it mirrors the
 * effect chain — the audio thread is the source of truth for *sound*, this is the source
 * of truth for *state*.
 *
 * One deliberate decision: **the starter kit is synthesised on the UI thread, not the
 * audio thread.** `dsp/core/drum-synth.js` renders sixteen one-shots, which allocates a
 * few megabytes and takes tens of milliseconds — doing that inside the worklet would
 * stall the audio callback and click. Rendering here and handing the finished buffers
 * over as normal sample loads means the audio thread never knows the difference between
 * a synthesised kick and one the user dragged in, which is the whole design of
 * `DrumVoice`.
 *
 * It also pays off for the UI: because the generator lives on this side, a "tune" or
 * "decay" knob on a synth pad is a real knob — turn it, re-render, re-push. No
 * audio-thread synthesis code, no second code path.
 */

import {
  DRUM_ROUTE,
  PAD_COUNT,
  VOICE_ATTACK_COUNT,
  VOICE_CLASS_COUNT,
  VOICE_DEFAULT_CLASS_PADS,
  VOICE_DEFAULTS,
  VOICE_FEATURE_COUNT,
  VOICE_KEY,
} from "./backend";

/** What is currently loaded on a pad. */
export interface PadSource {
  /** "synth" = generated here, "sample" = user audio, "empty" = nothing loaded. */
  kind: "synth" | "sample" | "empty";
  /** Generator kind for synth pads (one of DRUM_KINDS), "" otherwise. */
  synth: string;
  /** Sparse overrides on the generator's defaults. Empty means stock. */
  synthParams: Record<string, number>;
  /** File name for sample pads, null otherwise. Display only — never an identity. */
  sampleName: string | null;
  /**
   * Key into the sample store (`sample-store.ts`) for sample pads, null otherwise.
   *
   * Separate from `sampleName` deliberately: the name is what the user sees and renames,
   * the id is what the audio is filed under. Tying storage to the name would orphan a
   * sound the moment a pad was renamed, and would collide the moment two different files
   * shared a name. It also means one buffer can sit on several pads — chop a break
   * across sixteen pads and the audio is stored once, not sixteen times.
   */
  sampleId: string | null;
  /** Length of what is loaded, for the pad's waveform strip. */
  frames: number;
  sampleRate: number;
}

/** Voice parameters. Keys match PAD_KEY in backend.ts — that array is the wire format. */
export type PadParams = Record<string, number>;

export interface PadState {
  index: number;
  name: string;
  source: PadSource;
  params: PadParams;
  /** The pad's own effect chain. Same shape as the master rack's slots. */
  chain: PadSlotState[];
}

/** A slot in a pad's chain. Mirrors SlotState in engine-client.ts. */
export interface PadSlotState {
  id: number;
  type: string;
  params: Record<string, number>;
  mix: number;
  bypassed: boolean;
}

/**
 * Smart Voice, as state rather than sound: the detector's settings, where each class
 * fires, and the calibrated centroid tables if the performer has trained them.
 *
 * It lives in the kit document on purpose (see brobeats-plan.md): a calibration is a
 * profile of one mouth against one set of sounds, so it should follow the kit it was
 * trained against rather than sitting in a global preference that silently applies to
 * someone else's sounds.
 *
 * The factory tables are deliberately NOT copied here. `trained[c] === 0` means "this
 * class was never calibrated", and that row is left to whatever `beat-classify.js` ships
 * — duplicating measured numbers into TypeScript would give us two truths that drift.
 */
export interface VoiceProfile {
  /** Keys match VOICE_KEY in backend.ts — that array is the wire format. */
  params: Record<string, number>;
  /** Class -> pad index. -1 mutes that class. Length VOICE_CLASS_COUNT. */
  classPads: number[];
  /** Flat stage-2 centroids, VOICE_CLASS_COUNT x VOICE_FEATURE_COUNT. */
  centroids: number[];
  /** Flat stage-1 attack centroids, VOICE_CLASS_COUNT x VOICE_ATTACK_COUNT. */
  attack: number[];
  /** Hits each class's rows were trained from. 0 means the class is still factory. */
  trained: number[];
}

export interface KitState {
  name: string;
  pads: PadState[];
  /** Smart Voice settings and calibration for this kit. */
  voice: VoiceProfile;
  /** Kit output trim, dB. */
  gain: number;
  mute: boolean;
  /** Soloed pad index, or -1. */
  solo: number;
  /** DRUM_ROUTE value: off / direct / through the master chain. */
  route: number;
  /** False until the starter kit has been synthesised and pushed. */
  ready: boolean;
}

/**
 * Voice defaults. These MUST match the field defaults in `dsp/core/drum-voice.js` —
 * the mirror is only useful if it starts out agreeing with what it mirrors.
 *
 * sustain 1 + oneshot mode means "play the sample out", which is the right default for
 * a drum. The envelope is there to be reached for, not to be fought.
 */
export const DEFAULT_PAD_PARAMS: PadParams = {
  attack: 0.5,
  decay: 400,
  sustain: 1,
  release: 60,
  hold: 0,
  pitch: 0,
  start: 0,
  reverse: 0,
  gain: 0,
  pan: 0,
  mode: 1,
  velAmount: 0.7,
  choke: 0,
  mute: 0,
};

export const EMPTY_SOURCE: PadSource = {
  kind: "empty",
  synth: "",
  synthParams: {},
  sampleName: null,
  sampleId: null,
  frames: 0,
  sampleRate: 0,
};

/** An uncalibrated profile: factory settings, factory tables, default pad routing. */
export function defaultVoiceProfile(): VoiceProfile {
  const params: Record<string, number> = {};
  for (const key of VOICE_KEY) params[key] = VOICE_DEFAULTS[key];
  return {
    params,
    classPads: [...VOICE_DEFAULT_CLASS_PADS],
    centroids: new Array(VOICE_CLASS_COUNT * VOICE_FEATURE_COUNT).fill(0),
    attack: new Array(VOICE_CLASS_COUNT * VOICE_ATTACK_COUNT).fill(0),
    trained: new Array(VOICE_CLASS_COUNT).fill(0),
  };
}

/** A kit of sixteen blank pads. Real content arrives from `applyDefaultLayout`. */
export function emptyKit(): KitState {
  const pads: PadState[] = [];
  for (let i = 0; i < PAD_COUNT; i++) {
    pads.push({
      index: i,
      name: `Pad ${i + 1}`,
      source: { ...EMPTY_SOURCE },
      params: { ...DEFAULT_PAD_PARAMS },
      chain: [],
    });
  }
  return {
    name: "BROBEATS",
    pads,
    voice: defaultVoiceProfile(),
    gain: 0,
    mute: false,
    solo: -1,
    route: DRUM_ROUTE.DIRECT,
    ready: false,
  };
}

// --------------------------------------------------------------- drum synth

/** Shape of the module served from /dsp/core/drum-synth.js. */
interface DrumSynthModule {
  DRUM_KINDS: string[];
  DRUM_SYNTH_DEFAULTS: Record<string, Record<string, number>>;
  renderDrum: (
    kind: string,
    sr: number,
    params?: Record<string, number>,
  ) => { data: Float32Array; frames: number; kind: string } | null;
  DEFAULT_KIT_LAYOUT: Array<{
    pad: number;
    kind: string;
    name: string;
    params: Record<string, number>;
    choke?: number;
  }>;
}

const SYNTH_URL = "/dsp/core/drum-synth.js";

let synthPromise: Promise<DrumSynthModule | null> | null = null;
let synthMod: DrumSynthModule | null = null;
let synthError: string | null = null;

/**
 * Loads the generator. It lives in `public/dsp` because the audio thread imports it too,
 * so it is fetched as a plain ES module at runtime rather than bundled — that is also
 * what keeps the DSP tree backend-agnostic and shippable to the native host untouched.
 *
 * The URL is resolved to an absolute one before the import, and that is load-bearing in
 * dev: Vite rewrites root-relative dynamic imports through its transform pipeline, which
 * then refuses to serve anything out of `public/` ("should not be imported from source
 * code"). Its own injectQuery helper leaves absolute URLs alone, so an absolute href goes
 * straight to the static file the way the worklet's addModule() already fetches it.
 */
export function loadDrumSynth(): Promise<DrumSynthModule | null> {
  if (!synthPromise) {
    const url =
      typeof document === "undefined" ? SYNTH_URL : new URL(SYNTH_URL, document.baseURI).href;
    synthPromise = import(/* @vite-ignore */ url)
      .then((m) => {
        synthMod = m as DrumSynthModule;
        return synthMod;
      })
      .catch((e) => {
        // Swallowing this silently cost an afternoon once: the pads come up blank and
        // nothing anywhere says why. The kit degrades to "drop your own samples in",
        // but the reason is on the console.
        synthError = e instanceof Error ? e.message : String(e);
        console.warn("[brobeats] drum generator failed to load:", synthError);
        return null;
      });
  }
  return synthPromise;
}

/** Why the generator is missing, if it is. Null when all is well. */
export function drumSynthError(): string | null {
  return synthError;
}

/** The generator, if it has finished loading. Null before that — callers should cope. */
export function drumSynth(): DrumSynthModule | null {
  return synthMod;
}

/** Generator kinds, once loaded. */
export function drumKinds(): string[] {
  return synthMod ? synthMod.DRUM_KINDS : [];
}

/** Stock generator params for a kind, merged with any overrides. */
export function synthParamsFor(kind: string, overrides?: Record<string, number>): Record<string, number> {
  const base = synthMod?.DRUM_SYNTH_DEFAULTS[kind];
  if (!base) return { ...(overrides || {}) };
  return { ...base, ...(overrides || {}) };
}

/** Renders one pad's one-shot. Returns null if the generator is unavailable. */
export function renderPad(
  kind: string,
  sampleRate: number,
  overrides?: Record<string, number>,
): { data: Float32Array; frames: number } | null {
  if (!synthMod) return null;
  const res = synthMod.renderDrum(kind, sampleRate, overrides);
  return res ? { data: res.data, frames: res.frames } : null;
}

/**
 * The stock sixteen-pad layout, applied onto a kit. Only pad identity and the generator
 * settings come from the layout — anything the user has already changed about a voice is
 * left alone, so this is safe to call on an existing kit.
 */
export function applyDefaultLayout(kit: KitState): KitState {
  if (!synthMod) return kit;
  const pads = kit.pads.map((p) => ({ ...p, params: { ...p.params }, source: { ...p.source } }));
  for (const entry of synthMod.DEFAULT_KIT_LAYOUT) {
    const p = pads[entry.pad];
    if (!p) continue;
    p.name = entry.name;
    p.source = {
      kind: "synth",
      synth: entry.kind,
      synthParams: { ...entry.params },
      sampleName: null,
      sampleId: null,
      frames: 0,
      sampleRate: 0,
    };
    if (entry.choke) p.params.choke = entry.choke;
  }
  return { ...kit, pads };
}

// ------------------------------------------------------------ serialisation

/**
 * A kit document, as stored. Sample *audio* is deliberately not in here — a kit is a
 * few hundred bytes of settings, and dropped-in samples are held separately (and are
 * re-dropped or re-fetched rather than base64'd into a preset).
 */
export interface KitDocument {
  name: string;
  gain: number;
  mute: boolean;
  route: number;
  pads: Array<{
    index: number;
    name: string;
    source: PadSource;
    params: PadParams;
    chain: PadSlotState[];
  }>;
  /** Smart Voice profile. Absent in kits written before Phase 4 — that reads as factory. */
  voice?: VoiceProfile;
}

export function exportKit(kit: KitState): KitDocument {
  return {
    name: kit.name,
    gain: kit.gain,
    mute: kit.mute,
    route: kit.route,
    pads: kit.pads.map((p) => ({
      index: p.index,
      name: p.name,
      source: { ...p.source, synthParams: { ...p.source.synthParams } },
      params: { ...p.params },
      chain: p.chain.map((s) => ({ ...s, params: { ...s.params } })),
    })),
    voice: {
      params: { ...kit.voice.params },
      classPads: [...kit.voice.classPads],
      centroids: [...kit.voice.centroids],
      attack: [...kit.voice.attack],
      trained: [...kit.voice.trained],
    },
  };
}

/**
 * Rebuilds a profile from a document, tolerating anything.
 *
 * A calibration table is the one part of a kit document a user cannot recreate by
 * looking at the screen, so this is forgiving by design: a short, long, or partly
 * non-finite table keeps the rows it can read and marks the rest untrained (factory)
 * rather than rejecting the profile and throwing away a good calibration because one
 * number was corrupt.
 */
export function importVoiceProfile(doc: Partial<VoiceProfile> | null | undefined): VoiceProfile {
  const v = defaultVoiceProfile();
  if (!doc) return v;
  if (doc.params) {
    for (const key of VOICE_KEY) {
      const raw = doc.params[key];
      if (Number.isFinite(raw)) v.params[key] = raw as number;
    }
  }
  if (Array.isArray(doc.classPads)) {
    for (let c = 0; c < VOICE_CLASS_COUNT; c++) {
      const p = doc.classPads[c];
      if (Number.isFinite(p) && (p as number) < PAD_COUNT) v.classPads[c] = Math.max(-1, (p as number) | 0);
    }
  }
  const trained = Array.isArray(doc.trained) ? doc.trained : [];
  const centroids = Array.isArray(doc.centroids) ? doc.centroids : [];
  const attack = Array.isArray(doc.attack) ? doc.attack : [];
  for (let c = 0; c < VOICE_CLASS_COUNT; c++) {
    const n = trained[c];
    if (!Number.isFinite(n) || (n as number) <= 0) continue;
    let ok = true;
    for (let f = 0; f < VOICE_FEATURE_COUNT; f++) {
      if (!Number.isFinite(centroids[c * VOICE_FEATURE_COUNT + f])) ok = false;
    }
    for (let b = 0; b < VOICE_ATTACK_COUNT; b++) {
      if (!Number.isFinite(attack[c * VOICE_ATTACK_COUNT + b])) ok = false;
    }
    if (!ok) continue;
    for (let f = 0; f < VOICE_FEATURE_COUNT; f++) {
      v.centroids[c * VOICE_FEATURE_COUNT + f] = centroids[c * VOICE_FEATURE_COUNT + f] as number;
    }
    for (let b = 0; b < VOICE_ATTACK_COUNT; b++) {
      v.attack[c * VOICE_ATTACK_COUNT + b] = attack[c * VOICE_ATTACK_COUNT + b] as number;
    }
    v.trained[c] = (n as number) | 0;
  }
  return v;
}

/**
 * Rebuilds kit state from a document. Missing fields fall back to defaults, so a kit
 * written by an older build still loads — same contract as preset loading.
 */
export function importKit(doc: Partial<KitDocument> | null | undefined): KitState {
  const kit = emptyKit();
  if (!doc) return kit;
  kit.name = typeof doc.name === "string" ? doc.name : kit.name;
  kit.gain = Number.isFinite(doc.gain) ? (doc.gain as number) : 0;
  kit.mute = !!doc.mute;
  kit.route = Number.isFinite(doc.route) ? (doc.route as number) : DRUM_ROUTE.DIRECT;
  kit.voice = importVoiceProfile(doc.voice);
  if (!Array.isArray(doc.pads)) return kit;
  for (const entry of doc.pads) {
    const i = entry?.index | 0;
    if (i < 0 || i >= PAD_COUNT) continue;
    const pad = kit.pads[i];
    if (typeof entry.name === "string") pad.name = entry.name;
    if (entry.source) {
      pad.source = {
        kind: entry.source.kind === "sample" || entry.source.kind === "synth" ? entry.source.kind : "empty",
        synth: typeof entry.source.synth === "string" ? entry.source.synth : "",
        synthParams: { ...(entry.source.synthParams || {}) },
        sampleName: entry.source.sampleName ?? null,
        sampleId: typeof entry.source.sampleId === "string" ? entry.source.sampleId : null,
        // A sample pad's audio is not in the document — it is fetched from the sample
        // store by id after the kit loads. Until that lands (or if it never does, for a
        // kit written before ids existed) the pad reads as loaded-but-silent, with its
        // name showing so the user knows what to re-drop.
        frames: 0,
        sampleRate: 0,
      };
    }
    pad.params = { ...DEFAULT_PAD_PARAMS, ...(entry.params || {}) };
    pad.chain = Array.isArray(entry.chain) ? entry.chain.map((s) => ({ ...s, params: { ...s.params } })) : [];
  }
  return kit;
}
