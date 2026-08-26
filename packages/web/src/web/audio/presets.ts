/**
 * Bro.Kodr — factory presets.
 *
 * Each preset is a complete signal chain: module order, every parameter, per-module
 * dry/wet, and the I/O stage. Nothing is left implicit — `withDefaults` fills any param a
 * preset doesn't mention, so these definitions only state what actually matters for the
 * sound, and presets keep working when new params are added to a module later.
 *
 * The default chain follows the canonical order: EQ -> Compressor -> Pitch -> Distortion
 * -> Bit Crusher -> Delay -> Reverb -> Limiter. Corrective before creative, dynamics
 * before drive, time-based last, limiter always at the end so nothing downstream can
 * push past the ceiling.
 */

import type { ChainSnapshot, SlotState } from "./engine-client";
import { DEFAULT_IO } from "./engine-client";
import { withDefaults } from "./param-schema";

export interface FactoryPreset {
  id: string;
  name: string;
  category: "Utility" | "Voice" | "Robot" | "Broadcast" | "Creative" | "Music";
  description: string;
  chain: ChainSnapshot;
}

let uid = 0;

/** Build a slot with the module's defaults, overridden by `params`. */
function fx(type: string, params: Record<string, number> = {}, mix?: number, bypassed = false): SlotState {
  return {
    id: ++uid,
    type,
    params: withDefaults(type, params),
    mix: mix ?? 1,
    bypassed,
    collapsed: false,
  };
}

function chain(slots: SlotState[], io: Partial<typeof DEFAULT_IO> = {}): ChainSnapshot {
  return { slots, io: { ...DEFAULT_IO, ...io } };
}

export const FACTORY_PRESETS: FactoryPreset[] = [
  {
    id: "init",
    name: "Init — Full Chain",
    category: "Utility",
    description:
      "The canonical chain with every module neutral. Start here and dial in: nothing is colouring the signal yet.",
    chain: chain([
      fx("eq"),
      fx("comp", { threshold: -18, ratio: 2.5, attack: 12, release: 140, makeup: 2 }),
      fx("pitch", { pitch: 0 }),
      fx("dist", { drive: 0, output: 0 }, 0),
      fx("crush", { bits: 16, rate: 24000 }, 0),
      fx("delay", { time: 320, feedback: 0.25 }, 0),
      fx("reverb", { decay: 0.7 }, 0),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "clean-vocal",
    name: "Clean Vocal",
    category: "Voice",
    description:
      "Transparent channel strip: rumble filter, a small presence lift, gentle 2.5:1 levelling and a safety limiter.",
    chain: chain([
      fx("gate", { threshold: -52, range: -18, hold: 60, scfreq: 100 }),
      fx("eq", {
        hpFreq: 85,
        hpSlope: 1,
        lsFreq: 180,
        lsGain: -1.5,
        b1Freq: 350,
        b1Gain: -2,
        b1Q: 1.1,
        b2Freq: 3000,
        b2Gain: 2.5,
        b2Q: 0.8,
        hsFreq: 9000,
        hsGain: 2,
      }),
      fx("comp", { threshold: -20, ratio: 2.5, attack: 15, release: 160, knee: 8, makeup: 3, lookahead: 2 }),
      fx("transient", { attack: 1.5, sustain: -1 }),
      fx("limiter", { ceiling: -0.8, release: 100 }),
    ]),
  },
  {
    id: "podcast",
    name: "Podcast Voice",
    category: "Broadcast",
    description:
      "Dense, close, always-audible. Hard gate, aggressive levelling, tape-style saturation for glue, limiter at -1 dB.",
    chain: chain([
      fx("gate", { threshold: -46, range: -30, attack: 2, release: 180, hold: 80, scfreq: 110 }),
      fx("eq", { hpFreq: 100, hpSlope: 1, b1Freq: 250, b1Gain: -2.5, b1Q: 1.4, b2Freq: 2400, b2Gain: 3, hsFreq: 10000, hsGain: 1.5 }),
      fx("comp", { threshold: -26, ratio: 4, attack: 8, release: 120, knee: 10, makeup: 6 }),
      fx("sat", { drive: 5, curve: 1, tone: 12000, output: -1 }, 0.35),
      fx("comp", { threshold: -14, ratio: 2, attack: 30, release: 300, knee: 12, makeup: 2 }),
      fx("limiter", { ceiling: -1 }),
    ]),
  },
  {
    id: "deep-voice",
    name: "Deep Voice",
    category: "Voice",
    description:
      "Down 5 semitones with formants preserved, so it reads as a genuinely larger person rather than a slowed tape.",
    chain: chain([
      fx("eq", { hpFreq: 60, hpSlope: 1, b1Freq: 400, b1Gain: -2, b1Q: 1.2 }),
      fx("comp", { threshold: -20, ratio: 3, attack: 10, release: 150, makeup: 3 }),
      fx("pitch", { pitch: -5, formant: -2, preserve: 1, quality: 2 }),
      fx("eq", { lsFreq: 140, lsGain: 3, b2Freq: 2200, b2Gain: 1.5, hsFreq: 8000, hsGain: -2 }),
      fx("sat", { drive: 4, curve: 1, output: -1 }, 0.3),
      fx("limiter", { ceiling: -0.8 }),
    ]),
  },
  {
    id: "monster",
    name: "Monster",
    category: "Creative",
    description: "An octave down with the vocal tract stretched wider, sub-harmonic weight and a low growl of drive.",
    chain: chain([
      fx("eq", { hpFreq: 45, b1Freq: 500, b1Gain: -3, b1Q: 1 }),
      fx("comp", { threshold: -24, ratio: 4, attack: 5, release: 120, makeup: 4 }),
      fx("pitch", { pitch: -12, formant: -5, preserve: 1, quality: 2, lifter: 60 }),
      fx("dist", { drive: 14, curve: 1, tone: 4500, output: -8 }, 0.45),
      fx("eq", { lsFreq: 120, lsGain: 5, lpFreq: 9000, lpSlope: 1 }),
      fx("reverb", { size: 1.6, decay: 0.82, damping: 0.55, predelay: 20 }, 0.22),
      fx("limiter", { ceiling: -0.8 }),
    ]),
  },
  {
    id: "chipmunk",
    name: "Chipmunk",
    category: "Creative",
    description: "Up 7 semitones with formants shifted along too — deliberately cartoonish rather than natural.",
    chain: chain([
      fx("eq", { hpFreq: 140, hpSlope: 1 }),
      fx("comp", { threshold: -20, ratio: 3, attack: 8, release: 120, makeup: 2 }),
      fx("pitch", { pitch: 7, formant: 3, preserve: 0, quality: 1 }),
      fx("eq", { b3Freq: 5500, b3Gain: -3, b3Q: 0.9, lpFreq: 14000 }),
      fx("limiter", { ceiling: -0.8 }),
    ]),
  },
  {
    id: "alien",
    name: "Alien",
    category: "Robot",
    description:
      "Frequency shifter detunes every partial inharmonically, then a fast chorus and formant shift push it off-species.",
    chain: chain([
      fx("eq", { hpFreq: 120, hpSlope: 1 }),
      fx("comp", { threshold: -20, ratio: 3, attack: 6, release: 110, makeup: 3 }),
      fx("pitch", { pitch: 2, formant: 5, preserve: 1, quality: 1 }),
      fx("freqshift", { freq: 42, feedback: 0.2 }, 0.55),
      fx("chorus", { rate: 2.2, depth: 0.7, delay: 8, voices: 3, feedback: 0.2 }, 0.45),
      fx("ringmod", { freq: 320, shape: 0, mode: 1, sweeprate: 0.4, sweepdepth: 0.3 }, 0.25),
      fx("delay", { time: 180, feedback: 0.32, lowpass: 4500, pingpong: 1 }, 0.2),
      fx("reverb", { size: 1.4, decay: 0.8, modulation: 0.6 }, 0.25),
      fx("limiter", { ceiling: -0.8 }),
    ]),
  },
  {
    id: "robot",
    name: "Robot",
    category: "Robot",
    description:
      "Ring modulation at 55 Hz plus heavy bit reduction. Pitch is flattened by the modulator, which is what sells the machine.",
    chain: chain([
      fx("eq", { hpFreq: 180, hpSlope: 1, lpFreq: 7000, lpSlope: 1 }),
      fx("comp", { threshold: -22, ratio: 6, attack: 3, release: 90, makeup: 5 }),
      fx("ringmod", { freq: 55, shape: 0, mode: 0 }, 0.85),
      fx("crush", { bits: 6, rate: 9000, dither: 0.1, smooth: 0.3, output: -2 }, 0.7),
      fx("eq", { b2Freq: 1600, b2Gain: 4, b2Q: 1.6, hsFreq: 6000, hsGain: -3 }),
      fx("delay", { time: 120, feedback: 0.25, lowpass: 3500 }, 0.18),
      fx("limiter", { ceiling: -1 }),
    ]),
  },
  {
    id: "vocoder-classic",
    name: "Vocoder — Classic",
    category: "Robot",
    description:
      "20-band channel vocoder on a supersaw carrier at 110 Hz, with the sibilance path open so consonants stay intelligible.",
    chain: chain([
      fx("gate", { threshold: -48, range: -40, attack: 1, release: 60 }),
      fx("eq", { hpFreq: 110, hpSlope: 1, b2Freq: 2600, b2Gain: 3 }),
      fx("comp", { threshold: -24, ratio: 4, attack: 4, release: 90, makeup: 5 }),
      fx("vocoder", {
        bands: 20,
        carrier: 3,
        pitch: 110,
        follow: 0,
        freqlo: 150,
        freqhi: 7000,
        q: 7,
        depth: 1,
        sibilance: 0.45,
        attack: 2,
        release: 20,
        spread: 0.35,
        output: 3,
      }),
      fx("eq", { hpFreq: 100, b3Freq: 4000, b3Gain: 2 }),
      fx("reverb", { size: 1.1, decay: 0.7, predelay: 10 }, 0.18),
      fx("limiter", { ceiling: -0.8 }),
    ]),
  },
  {
    id: "vocoder-follow",
    name: "Vocoder — Pitch Follow",
    category: "Robot",
    description:
      "The carrier tracks your own pitch, so the vocoder sings your melody instead of a fixed drone. Sing, don't speak.",
    chain: chain([
      fx("gate", { threshold: -46, range: -40 }),
      fx("comp", { threshold: -22, ratio: 4, attack: 4, release: 90, makeup: 4 }),
      fx("vocoder", {
        bands: 24,
        carrier: 0,
        follow: 1,
        freqlo: 130,
        freqhi: 8000,
        q: 8,
        depth: 1,
        sibilance: 0.5,
        attack: 1.5,
        release: 18,
        spread: 0.5,
        output: 2,
      }),
      fx("chorus", { rate: 0.35, depth: 0.35, delay: 14, voices: 3 }, 0.3),
      fx("delay", { time: 250, sync: 4, bpm: 120, feedback: 0.3, lowpass: 5000, pingpong: 1 }, 0.22),
      fx("reverb", { size: 1.3, decay: 0.78 }, 0.22),
      fx("limiter", { ceiling: -0.8 }),
    ]),
  },
  {
    id: "talkbox-lead",
    name: "Talk Box — Lead",
    category: "Robot",
    description:
      "The Frampton/Bon Jovi tube sound. Mouth the words silently into the mic — do not sing. The driver follows your pitch, so hum the melody and shape it with your mouth.",
    chain: chain([
      fx("gate", { threshold: -50, range: -35, attack: 1, release: 80 }),
      fx("eq", { hpFreq: 90, hpSlope: 1, b3Freq: 2800, b3Gain: 2.5 }),
      fx("comp", { threshold: -22, ratio: 4, attack: 5, release: 100, makeup: 4 }),
      fx("talkbox", {
        carrier: 3,
        follow: 1,
        pitch: 110,
        glide: 35,
        order: 24,
        tract: 1,
        tractq: 0.92,
        brightness: 0.25,
        breath: 0.28,
        squelch: -50,
        drive: 0.35,
        output: 1,
      }),
      fx("eq", { hpFreq: 120, b4Freq: 3200, b4Gain: 2 }),
      fx("delay", { time: 280, feedback: 0.22, lowpass: 5200 }, 0.16),
      fx("reverb", { size: 1.1, decay: 0.65, predelay: 12 }, 0.2),
      fx("limiter", { ceiling: -0.8 }),
    ]),
  },
  {
    id: "talkbox-robot",
    name: "Talk Box — Fixed Note",
    category: "Robot",
    description:
      "Driver locked to a fixed note with a short tract and high resonance — a harder, more synthetic tube than the lead patch. Mouth words over the drone.",
    chain: chain([
      fx("gate", { threshold: -48, range: -40 }),
      fx("comp", { threshold: -24, ratio: 5, attack: 3, release: 80, makeup: 5 }),
      fx("talkbox", {
        carrier: 1,
        follow: 0,
        pitch: 98,
        order: 28,
        tract: 0.82,
        tractq: 1,
        brightness: 0.35,
        breath: 0.45,
        squelch: -54,
        drive: 0.5,
        output: 0,
      }),
      fx("chorus", { rate: 0.3, depth: 0.3, delay: 12, voices: 2 }, 0.22),
      fx("eq", { hpFreq: 130 }),
      fx("reverb", { size: 0.9, decay: 0.55 }, 0.16),
      fx("limiter", { ceiling: -0.8 }),
    ]),
  },
  {
    id: "cyber-voice",
    name: "Cyber Voice",
    category: "Robot",
    description:
      "Detuned doubling, a metallic phaser and tempo-locked ping-pong delay. Sci-fi announcer without losing the words.",
    chain: chain([
      fx("eq", { hpFreq: 130, hpSlope: 1, b2Freq: 2000, b2Gain: 3, b2Q: 1.2 }),
      fx("comp", { threshold: -22, ratio: 4, attack: 6, release: 110, makeup: 4 }),
      fx("pitch", { pitch: -2, formant: 2, preserve: 1, quality: 1 }),
      fx("chorus", { rate: 0.8, depth: 0.55, delay: 9, voices: 3, feedback: 0.25, spread: 1 }, 0.4),
      fx("phaser", { rate: 0.22, depth: 0.85, center: 1100, stages: 6, feedback: 0.45, q: 1.1 }, 0.4),
      fx("sat", { drive: 7, curve: 4, tone: 9000, output: -2 }, 0.35),
      fx("delay", { sync: 5, bpm: 128, feedback: 0.4, lowpass: 4000, pingpong: 1, spread: 0.3 }, 0.28),
      fx("reverb", { size: 1.5, decay: 0.84, damping: 0.5, modulation: 0.35 }, 0.24),
      fx("limiter", { ceiling: -0.8 }),
    ]),
  },
  {
    id: "telephone",
    name: "Telephone",
    category: "Broadcast",
    description: "300 Hz-3.4 kHz band, resonant mid peak and mild clipping — the actual G.711 voice band.",
    chain: chain([
      fx("comp", { threshold: -20, ratio: 4, attack: 5, release: 100, makeup: 4 }),
      fx("character", { mode: 0, amount: 1, drive: 2, noise: 1 }),
      fx("crush", { bits: 8, rate: 8000, dither: 0.15, smooth: 0.6 }, 0.5),
      fx("limiter", { ceiling: -1 }),
    ]),
  },
  {
    id: "am-radio",
    name: "AM Radio",
    category: "Broadcast",
    description: "Narrow band, carrier hiss and heavy levelling, as if it arrived through a valve receiver.",
    chain: chain([
      fx("comp", { threshold: -26, ratio: 6, attack: 4, release: 90, makeup: 7 }),
      fx("character", { mode: 1, amount: 1, drive: 3, noise: 1.3, wobble: 1.2 }),
      fx("eq", { b2Freq: 1800, b2Gain: 3, b2Q: 2 }),
      fx("limiter", { ceiling: -1 }),
    ]),
  },
  {
    id: "megaphone",
    name: "Megaphone",
    category: "Broadcast",
    description: "Horn resonance, hard mid-band drive and a short slap delay for the outdoor reflection.",
    chain: chain([
      fx("comp", { threshold: -24, ratio: 8, attack: 2, release: 80, makeup: 6 }),
      fx("character", { mode: 2, amount: 1, drive: 4 }),
      fx("dist", { drive: 16, curve: 3, tone: 4000, output: -9 }, 0.55),
      fx("delay", { time: 85, feedback: 0.18, lowpass: 3000 }, 0.2),
      fx("reverb", { size: 2.2, decay: 0.7, damping: 0.7, predelay: 35, highpass: 300 }, 0.14),
      fx("limiter", { ceiling: -1 }),
    ]),
  },
  {
    id: "walkie",
    name: "Walkie-Talkie",
    category: "Broadcast",
    description: "Squelched, compressed, noisy short-range radio. The gate tail is part of the effect.",
    chain: chain([
      fx("gate", { threshold: -40, range: -50, attack: 0.5, release: 40, hold: 20 }),
      fx("comp", { threshold: -28, ratio: 10, attack: 1, release: 70, makeup: 8 }),
      fx("character", { mode: 3, amount: 1, drive: 3, noise: 1.4 }),
      fx("crush", { bits: 7, rate: 8000, smooth: 0.4 }, 0.4),
      fx("limiter", { ceiling: -1 }),
    ]),
  },
  {
    id: "lofi-tape",
    name: "Lo-Fi Tape",
    category: "Creative",
    description: "Wow and flutter, rolled-off top, hiss bed and soft saturation. Warm and slightly unstable.",
    chain: chain([
      fx("eq", { hpFreq: 70, lsFreq: 160, lsGain: 2 }),
      fx("comp", { threshold: -20, ratio: 2.5, attack: 20, release: 200, makeup: 2 }),
      fx("character", { mode: 7, amount: 0.85, drive: 2, wobble: 1.4, noise: 0.9 }),
      fx("sat", { drive: 8, curve: 1, tone: 6000, output: -3 }, 0.5),
      fx("noise", { level: -62, type: 1, follow: 0.3, tone: 9000 }, 1),
      fx("delay", { time: 260, feedback: 0.22, lowpass: 3500, moddepth: 0.35, modrate: 0.28 }, 0.16),
      fx("reverb", { size: 1.1, decay: 0.66, damping: 0.6 }, 0.16),
      fx("limiter", { ceiling: -1 }),
    ]),
  },
  {
    id: "vinyl",
    name: "Vinyl",
    category: "Creative",
    description: "Crackle, surface noise and a narrow band with the classic RIAA-ish tilt.",
    chain: chain([
      fx("comp", { threshold: -18, ratio: 2.5, attack: 18, release: 180, makeup: 2 }),
      fx("character", { mode: 5, amount: 0.9, noise: 1.2, wobble: 0.8 }),
      fx("eq", { hpFreq: 90, b3Freq: 6000, b3Gain: -2.5, lpFreq: 11000, lpSlope: 1 }),
      fx("limiter", { ceiling: -1 }),
    ]),
  },
  {
    id: "distorted-vocal",
    name: "Distorted Vocal",
    category: "Music",
    description:
      "Parallel diode-clip drive under the clean signal, so it grows teeth without losing the intelligibility of the words.",
    chain: chain([
      fx("eq", { hpFreq: 110, hpSlope: 1, b1Freq: 320, b1Gain: -3, b1Q: 1.3 }),
      fx("comp", { threshold: -22, ratio: 4, attack: 6, release: 110, makeup: 4 }),
      fx("dist", { drive: 22, curve: 4, tone: 5500, bias: 0.08, prehp: 120, output: -12 }, 0.5),
      fx("eq", { b2Freq: 2600, b2Gain: 3, b2Q: 1.1, hsFreq: 9000, hsGain: -2 }),
      fx("delay", { sync: 4, bpm: 140, feedback: 0.28, lowpass: 4000, saturate: 0.4 }, 0.2),
      fx("reverb", { size: 1.2, decay: 0.74, damping: 0.45 }, 0.18),
      fx("limiter", { ceiling: -0.6 }),
    ]),
  },
  {
    id: "edm-vocal",
    name: "EDM Vocal",
    category: "Music",
    description:
      "Bright, wide and forward: presence lift, doubling chorus, 1/8 ping-pong and a long plate sitting behind it.",
    chain: chain([
      fx("gate", { threshold: -50, range: -20 }),
      fx("eq", { hpFreq: 120, hpSlope: 1, b1Freq: 300, b1Gain: -2, b2Freq: 3200, b2Gain: 3.5, hsFreq: 10000, hsGain: 3 }),
      fx("comp", { threshold: -24, ratio: 4, attack: 5, release: 100, knee: 8, makeup: 5, lookahead: 2 }),
      fx("transient", { attack: 2, sustain: -1.5 }),
      fx("sat", { drive: 6, curve: 1, tone: 14000, output: -1 }, 0.3),
      fx("chorus", { rate: 0.45, depth: 0.3, delay: 16, voices: 2, spread: 1 }, 0.25),
      fx("delay", { sync: 4, bpm: 128, feedback: 0.35, lowpass: 6000, pingpong: 1, spread: 0.4 }, 0.24),
      fx("reverb", { size: 1.8, decay: 0.86, damping: 0.35, predelay: 25, width: 1 }, 0.26),
      fx("limiter", { ceiling: -0.4, release: 60 }),
    ]),
  },
  {
    id: "techno-vocal",
    name: "Techno Vocal",
    category: "Music",
    description:
      "Tempo-locked stutter, resonant sweep and dub delay. Set the BPM in the Glitch and Delay modules to match your track.",
    chain: chain([
      fx("eq", { hpFreq: 180, hpSlope: 1, lpFreq: 9000 }),
      fx("comp", { threshold: -26, ratio: 6, attack: 3, release: 80, makeup: 6 }),
      fx("glitch", { probability: 0.4, bpm: 128, division: 4, repeats: 3, reverse: 0.25, pitch: 1 }, 0.7),
      fx("phaser", { rate: 0.12, depth: 0.9, center: 900, stages: 6, feedback: 0.5 }, 0.35),
      fx("crush", { bits: 10, rate: 16000, smooth: 0.4 }, 0.3),
      fx("delay", { sync: 5, bpm: 128, feedback: 0.55, lowpass: 3500, pingpong: 1, saturate: 0.35 }, 0.3),
      fx("reverb", { size: 1.6, decay: 0.8, damping: 0.5, highpass: 300 }, 0.2),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "glitch-stutter",
    name: "Glitch Stutter",
    category: "Creative",
    description: "Buffer slicing with reverse and re-pitch, plus a frequency shifter for digital artefacts.",
    chain: chain([
      fx("comp", { threshold: -22, ratio: 4, attack: 5, release: 100, makeup: 4 }),
      fx("glitch", { probability: 0.65, bpm: 120, division: 6, repeats: 4, reverse: 0.5, pitch: 1.5 }, 0.85),
      fx("freqshift", { freq: 90, feedback: 0.3 }, 0.3),
      fx("crush", { bits: 5, rate: 7000, dither: 0.2 }, 0.35),
      fx("tremolo", { rate: 12, depth: 0.6, shape: 3, mode: 0 }, 0.4),
      fx("delay", { sync: 5, bpm: 120, feedback: 0.45, lowpass: 5000, pingpong: 1 }, 0.25),
      fx("limiter", { ceiling: -0.8 }),
    ]),
  },
  {
    id: "whisper-air",
    name: "Whisper / Air",
    category: "Voice",
    description:
      "Intimate and breathy: heavy upward levelling, a big air shelf, a noise bed keyed to your level, and a short ambience.",
    chain: chain([
      fx("eq", { hpFreq: 95, hpSlope: 1, b1Freq: 280, b1Gain: -3, b1Q: 1.1 }),
      fx("comp", { threshold: -34, ratio: 6, attack: 12, release: 220, knee: 12, makeup: 12 }),
      fx("eq", { b3Freq: 6500, b3Gain: 3, b3Q: 0.7, hsFreq: 11000, hsGain: 4.5 }),
      fx("noise", { level: -58, type: 1, follow: 0.8, tone: 12000 }),
      fx("chorus", { rate: 0.25, depth: 0.2, delay: 18, voices: 2 }, 0.18),
      fx("reverb", { size: 0.8, decay: 0.6, damping: 0.5, predelay: 8, highpass: 220 }, 0.2),
      fx("limiter", { ceiling: -1 }),
    ]),
  },
  {
    id: "stadium",
    name: "Stadium Announcer",
    category: "Broadcast",
    description: "Big horn colour and a long, dark reverb with pre-delay — a voice arriving from the far stand.",
    chain: chain([
      fx("comp", { threshold: -26, ratio: 6, attack: 3, release: 90, makeup: 7 }),
      fx("character", { mode: 6, amount: 0.8, drive: 2 }),
      fx("eq", { b2Freq: 1400, b2Gain: 4, b2Q: 1.4, lpFreq: 7000, lpSlope: 1 }),
      fx("delay", { time: 190, feedback: 0.3, lowpass: 2800 }, 0.24),
      fx("reverb", { size: 2.8, decay: 0.92, damping: 0.65, predelay: 60, highpass: 250, diffusion: 0.75 }, 0.32),
      fx("limiter", { ceiling: -1 }),
    ]),
  },
];

export function factoryPreset(id: string): FactoryPreset | undefined {
  return FACTORY_PRESETS.find((p) => p.id === id);
}

export const PRESET_CATEGORIES = ["Utility", "Voice", "Robot", "Broadcast", "Creative", "Music"] as const;
