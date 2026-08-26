/**
 * Bro.Kodr — effect registry.
 *
 * The single place where effect ids map to constructors. Adding a new effect means
 * writing the module + one line here + one entry in the UI param schema. The chain
 * runner and the whole UI are driven off this, so nothing else needs to change —
 * that is the "modular DSP architecture" requirement made concrete.
 *
 * IMPORTANT: keep ids stable — presets store them.
 */

import { ParametricEQ } from "./eq.js";
import { Compressor, Limiter, Gate, TransientShaper } from "./dynamics.js";
import { Distortion, Saturation, BitCrusher } from "./drive.js";
import { PitchFormant } from "./spectral.js";
import { Vocoder } from "./vocoder.js";
import { TalkBox } from "./talkbox.js";
import { Chorus, Flanger, Phaser, Tremolo, RingMod, FrequencyShifter } from "./modulation.js";
import { Delay, Reverb } from "./time.js";
import { Character, Glitch, NoiseGen } from "./character.js";

export const EFFECT_CLASSES = {
  eq: ParametricEQ,
  comp: Compressor,
  limiter: Limiter,
  gate: Gate,
  transient: TransientShaper,
  dist: Distortion,
  sat: Saturation,
  crush: BitCrusher,
  pitch: PitchFormant,
  vocoder: Vocoder,
  talkbox: TalkBox,
  chorus: Chorus,
  flanger: Flanger,
  phaser: Phaser,
  tremolo: Tremolo,
  ringmod: RingMod,
  freqshift: FrequencyShifter,
  delay: Delay,
  reverb: Reverb,
  character: Character,
  glitch: Glitch,
  noise: NoiseGen,
};

export function createEffect(type, sampleRate, maxBlock) {
  const C = EFFECT_CLASSES[type];
  if (!C) return null;
  return new C(sampleRate, maxBlock);
}
