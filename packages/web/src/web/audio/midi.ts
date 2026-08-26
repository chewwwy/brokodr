/**
 * Bro.Kodr — MIDI control.
 *
 * Web MIDI in, mapped onto engine parameters:
 *   - **CC -> any parameter.** Click a knob's MIDI badge, move a controller, done. The
 *     mapping stores the parameter's own min/max, and CC 0-127 maps through the same
 *     curve the knob uses, so a log-scaled frequency knob feels the same from hardware.
 *   - **Notes -> pitch.** Note-on drives the pitch shifter's semitone offset (relative to
 *     a configurable root) or the vocoder's carrier pitch, which is how you play a
 *     vocoder/talkbox part from a keyboard.
 *   - **Pitch bend -> fine tune** on the pitch module, ±2 semitones.
 *
 * Values are written straight into the engine's lock-free command ring, not through React
 * state, so a controller sweep doesn't cause a re-render per message. The UI reflects the
 * change on its next animation frame.
 *
 * Mappings persist in localStorage. Note that Web MIDI needs a user gesture and, in the
 * browser, a permission prompt; inside Electron it is granted automatically.
 */

import type { EngineClient } from "./engine-client";
import { normToValue, paramDef } from "./param-schema";

export type MidiTargetKind = "param" | "mix" | "bypass" | "io";

export interface MidiMapping {
  /** MIDI channel 0-15, or -1 for omni. */
  channel: number;
  cc: number;
  kind: MidiTargetKind;
  /** Slot id for param/mix/bypass targets. */
  slotId?: number;
  /** Effect type, kept so the mapping survives a slot being recreated by a preset load. */
  slotType?: string;
  paramKey?: string;
  /** I/O field name for io targets. */
  ioKey?: "inGain" | "outGain" | "masterMix" | "mute" | "bypass";
  /** Invert the controller direction. */
  invert: boolean;
}

export type NoteMode = "off" | "pitch" | "vocoder" | "talkbox";

export interface MidiSettings {
  enabled: boolean;
  /** Device ids to listen to. Empty = all inputs. */
  inputIds: string[];
  noteMode: NoteMode;
  /** MIDI note that means "no transposition" in pitch mode. */
  rootNote: number;
  mappings: MidiMapping[];
}

export interface MidiInputInfo {
  id: string;
  name: string;
  manufacturer: string;
  connected: boolean;
}

export interface MidiSnapshot {
  supported: boolean;
  enabled: boolean;
  error: string | null;
  inputs: MidiInputInfo[];
  settings: MidiSettings;
  /** Non-null while waiting for a controller move to complete a learn. */
  learning: Omit<MidiMapping, "cc" | "channel" | "invert"> | null;
  /** Last received message, for the activity indicator. */
  lastActivity: number;
  lastMessage: string;
}

const STORE_KEY = "brokodr.midi.v1";

const DEFAULT_SETTINGS: MidiSettings = {
  enabled: true,
  inputIds: [],
  noteMode: "off",
  rootNote: 60,
  mappings: [],
};

export class MidiController {
  private access: MIDIAccess | null = null;
  private listeners = new Set<() => void>();
  private snap: MidiSnapshot;
  private client: EngineClient;
  private heldNotes: number[] = [];

  constructor(client: EngineClient) {
    this.client = client;
    this.snap = {
      supported: typeof navigator !== "undefined" && "requestMIDIAccess" in navigator,
      enabled: false,
      error: null,
      inputs: [],
      settings: loadSettings(),
      learning: null,
      lastActivity: 0,
      lastMessage: "",
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): MidiSnapshot => this.snap;

  private emit() {
    for (const l of this.listeners) l();
  }

  private update(patch: Partial<MidiSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.emit();
  }

  private patchSettings(patch: Partial<MidiSettings>) {
    const settings = { ...this.snap.settings, ...patch };
    saveSettings(settings);
    this.update({ settings });
  }

  async enable(): Promise<boolean> {
    if (!this.snap.supported) {
      this.update({ error: "Web MIDI is not available in this runtime." });
      return false;
    }
    try {
      // sysex not requested — we only need CC/note/bend and asking for sysex triggers a
      // scarier permission prompt.
      const access = await navigator.requestMIDIAccess({ sysex: false });
      this.access = access;
      access.onstatechange = () => this.refreshInputs();
      this.bindInputs();
      this.update({ enabled: true, error: null });
      this.refreshInputs();
      return true;
    } catch (e) {
      this.update({ enabled: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  disable() {
    if (this.access) {
      this.access.inputs.forEach((i) => {
        i.onmidimessage = null;
      });
      this.access.onstatechange = null;
    }
    this.access = null;
    this.update({ enabled: false, inputs: [] });
  }

  private bindInputs() {
    if (!this.access) return;
    this.access.inputs.forEach((input) => {
      input.onmidimessage = (e) => this.onMessage(input.id, e);
    });
  }

  private refreshInputs() {
    if (!this.access) return;
    const inputs: MidiInputInfo[] = [];
    this.access.inputs.forEach((i) => {
      inputs.push({
        id: i.id,
        name: i.name || "MIDI input",
        manufacturer: i.manufacturer || "",
        connected: i.state === "connected",
      });
    });
    this.bindInputs();
    this.update({ inputs });
  }

  // ------------------------------------------------------------------ learn

  startLearn(target: Omit<MidiMapping, "cc" | "channel" | "invert">) {
    this.update({ learning: target });
  }

  cancelLearn() {
    this.update({ learning: null });
  }

  removeMapping(index: number) {
    const mappings = this.snap.settings.mappings.filter((_, i) => i !== index);
    this.patchSettings({ mappings });
  }

  clearMappings() {
    this.patchSettings({ mappings: [] });
  }

  toggleInvert(index: number) {
    const mappings = this.snap.settings.mappings.map((m, i) => (i === index ? { ...m, invert: !m.invert } : m));
    this.patchSettings({ mappings });
  }

  setNoteMode(noteMode: NoteMode) {
    this.patchSettings({ noteMode });
  }

  setRootNote(rootNote: number) {
    this.patchSettings({ rootNote });
  }

  /** Find the mapping bound to a control, so the UI can show the CC number on the knob. */
  mappingFor(kind: MidiTargetKind, slotId: number | undefined, paramKey: string | undefined): MidiMapping | null {
    for (const m of this.snap.settings.mappings) {
      if (m.kind !== kind) continue;
      if (kind === "io") {
        if (m.ioKey === paramKey) return m;
        continue;
      }
      if (m.slotId === slotId && m.paramKey === paramKey) return m;
    }
    return null;
  }

  // ---------------------------------------------------------------- routing

  private onMessage(inputId: string, e: MIDIMessageEvent) {
    const s = this.snap.settings;
    if (s.inputIds.length && !s.inputIds.includes(inputId)) return;
    const data = e.data;
    if (!data || data.length < 2) return;

    const status = data[0];
    const type = status & 0xf0;
    const channel = status & 0x0f;
    const d1 = data[1];
    const d2 = data.length > 2 ? data[2] : 0;

    // Activity indicator is throttled to ~20Hz; MIDI can arrive far faster than that.
    const now = performance.now();
    if (now - this.snap.lastActivity > 50) {
      this.snap = { ...this.snap, lastActivity: now, lastMessage: describe(type, channel, d1, d2) };
      this.emit();
    }

    if (type === 0xb0) {
      this.onControlChange(channel, d1, d2);
      return;
    }
    if (type === 0x90 && d2 > 0) {
      this.onNoteOn(d1);
      return;
    }
    if (type === 0x80 || (type === 0x90 && d2 === 0)) {
      this.onNoteOff(d1);
      return;
    }
    if (type === 0xe0) {
      this.onPitchBend(d1 | (d2 << 7));
    }
  }

  private onControlChange(channel: number, cc: number, value: number) {
    const learning = this.snap.learning;
    if (learning) {
      const mappings = [
        // One CC controls one thing: replace any existing binding for this CC/channel.
        ...this.snap.settings.mappings.filter((m) => !(m.cc === cc && m.channel === channel)),
        { ...learning, cc, channel, invert: false },
      ];
      this.snap = { ...this.snap, learning: null };
      this.patchSettings({ mappings });
      return;
    }

    for (const m of this.snap.settings.mappings) {
      if (m.cc !== cc) continue;
      if (m.channel !== -1 && m.channel !== channel) continue;
      const norm = m.invert ? 1 - value / 127 : value / 127;
      this.applyMapping(m, norm, value);
    }
  }

  private applyMapping(m: MidiMapping, norm: number, raw: number) {
    const snap = this.client.getSnapshot();
    if (m.kind === "io") {
      switch (m.ioKey) {
        case "inGain":
          this.client.setIo("inGain", -24 + norm * 48);
          break;
        case "outGain":
          this.client.setIo("outGain", -24 + norm * 48);
          break;
        case "masterMix":
          this.client.setIo("masterMix", norm);
          break;
        case "mute":
          this.client.setIo("mute", raw >= 64);
          break;
        case "bypass":
          this.client.setIo("bypass", raw >= 64);
          break;
      }
      return;
    }

    // Resolve by slot id, falling back to the first slot of the same type — that keeps a
    // controller mapping working after a preset load rebuilds the chain with new ids.
    let slot = snap.slots.find((s) => s.id === m.slotId);
    if (!slot && m.slotType) slot = snap.slots.find((s) => s.type === m.slotType);
    if (!slot) return;

    if (m.kind === "mix") {
      this.client.setMix(slot.id, norm);
      return;
    }
    if (m.kind === "bypass") {
      this.client.setBypass(slot.id, raw >= 64);
      return;
    }
    if (m.kind === "param" && m.paramKey) {
      const def = paramDef(slot.type, m.paramKey);
      if (!def) return;
      this.client.setParam(slot.id, m.paramKey, normToValue(def, norm));
    }
  }

  private onNoteOn(note: number) {
    const s = this.snap.settings;
    if (s.noteMode === "off") return;
    this.heldNotes = [...this.heldNotes.filter((n) => n !== note), note];
    this.applyNote(note);
  }

  private onNoteOff(note: number) {
    this.heldNotes = this.heldNotes.filter((n) => n !== note);
    // Last-note priority: fall back to whatever is still held.
    const last = this.heldNotes[this.heldNotes.length - 1];
    if (last !== undefined) this.applyNote(last);
  }

  private applyNote(note: number) {
    const s = this.snap.settings;
    const snap = this.client.getSnapshot();
    if (s.noteMode === "pitch") {
      const slot = snap.slots.find((x) => x.type === "pitch");
      if (!slot) return;
      const semis = Math.max(-24, Math.min(24, note - s.rootNote));
      this.client.setParam(slot.id, "pitch", semis);
      return;
    }
    if (s.noteMode === "vocoder") {
      const slot = snap.slots.find((x) => x.type === "vocoder");
      if (!slot) return;
      // MIDI note -> Hz. A4 = note 69 = 440Hz.
      const hz = 440 * Math.pow(2, (note - 69) / 12);
      this.client.setParam(slot.id, "pitch", Math.max(40, Math.min(800, hz)));
      // Playing a note implies you want the carrier pitched, not tracking the voice.
      if (slot.params.follow >= 0.5) this.client.setParam(slot.id, "follow", 0);
      return;
    }
    if (s.noteMode === "talkbox") {
      const slot = snap.slots.find((x) => x.type === "talkbox");
      if (!slot) return;
      // Same mapping as the vocoder: the note sets the driver oscillator's pitch.
      const hz = 440 * Math.pow(2, (note - 69) / 12);
      this.client.setParam(slot.id, "pitch", Math.max(40, Math.min(800, hz)));
      // A played note means the driver is fretted, not tracking the voice.
      if (slot.params.follow >= 0.5) this.client.setParam(slot.id, "follow", 0);
    }
  }

  private onPitchBend(value14: number) {
    const snap = this.client.getSnapshot();
    const slot = snap.slots.find((x) => x.type === "pitch");
    if (!slot) return;
    const norm = (value14 - 8192) / 8192; // -1..1
    // Bend range is one semitone up/down, expressed through the fine-tune param (cents).
    this.client.setParam(slot.id, "fine", Math.max(-100, Math.min(100, norm * 100)));
  }

  dispose() {
    this.disable();
  }
}

function describe(type: number, channel: number, d1: number, d2: number): string {
  const ch = channel + 1;
  if (type === 0xb0) return `CC ${d1} = ${d2} (ch ${ch})`;
  if (type === 0x90) return `Note ${noteName(d1)} vel ${d2} (ch ${ch})`;
  if (type === 0x80) return `Note off ${noteName(d1)} (ch ${ch})`;
  if (type === 0xe0) return `Bend ${d1 | (d2 << 7)} (ch ${ch})`;
  return `0x${type.toString(16)} (ch ${ch})`;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(note: number): string {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

function loadSettings(): MidiSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<MidiSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: MidiSettings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

let singleton: MidiController | null = null;

export function getMidiController(client: EngineClient): MidiController {
  if (!singleton) singleton = new MidiController(client);
  return singleton;
}
