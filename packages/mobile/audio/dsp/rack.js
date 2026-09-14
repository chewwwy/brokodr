'worklet';
/**
 * Bro.Kodr — Android spike rack.
 *
 * This file exists ONLY to answer one question: can the real Bro.Kodr DSP classes
 * be instantiated and run inside react-native-audio-api's AudioWorkletRuntime
 * (a real native audio thread), the same way they run inside the web
 * AudioWorklet?
 *
 * The `'worklet';` directive on line 1 is the whole trick. react-native-worklets'
 * babel plugin sees a file-level worklet directive and workletizes every
 * top-level entity in the file — including class declarations, which it rewrites
 * into class factories that can be constructed on a worklet runtime. Every file
 * under audio/dsp/ carries the same one-line directive and is otherwise a
 * byte-identical copy of packages/web/public/dsp/. That is the port: one line.
 *
 * Three effects, deliberately chosen to span the cost range of the real rack:
 *   EQ    — 12 biquads/frame, cheap, pure per-sample math
 *   COMP  — envelope follower + lookahead delay line, medium
 *   PITCH — 1024-point FFT phase vocoder + cepstral envelope, expensive
 *
 * If PITCH holds at a usable block size on a mid-range Android phone, the whole
 * 22-module rack is viable. If it doesn't, we know exactly what the ceiling is.
 */

import { ParametricEQ } from "./effects/eq.js";
import { Compressor } from "./effects/dynamics.js";
import { PitchFormant } from "./effects/spectral.js";

/**
 * Builds the three effects and returns a chain runner with the same
 * responsibilities as the web engine.js: it owns stage enables and bypass, the
 * effects themselves are always 100% wet.
 */
export function createRack(sampleRate, maxBlock) {
  const eq = new ParametricEQ(sampleRate, maxBlock);
  // Audible, obviously-not-a-no-op curve: 80Hz HP, presence lift, air shelf.
  eq.setParam("hpFreq", 80);
  eq.setParam("hpSlope", 1);
  eq.setParam("b2Freq", 2400);
  eq.setParam("b2Gain", 6);
  eq.setParam("b2Q", 0.8);
  eq.setParam("hsFreq", 9000);
  eq.setParam("hsGain", 3);

  const comp = new Compressor(sampleRate, maxBlock);
  comp.setParam("threshold", -22);
  comp.setParam("ratio", 4);
  comp.setParam("attack", 8);
  comp.setParam("release", 120);
  comp.setParam("makeup", 4);

  const pitch = new PitchFormant(sampleRate, maxBlock);
  // +5 semitones with formants preserved — you can hear instantly whether the
  // phase vocoder is actually running or the buffer is passing through raw.
  pitch.setParam("pitch", 5);
  pitch.setParam("formant", 0);
  pitch.setParam("preserve", 1);

  return {
    eq,
    comp,
    pitch,
    /**
     * stages: bitmask — 1 = EQ, 2 = COMP, 4 = PITCH. 0 = clean passthrough.
     */
    process(L, R, frames, stages) {
      if (stages & 1) eq.process(L, R, frames);
      if (stages & 2) comp.process(L, R, frames);
      if (stages & 4) pitch.process(L, R, frames);
    },
    reset() {
      eq.reset();
      comp.reset();
      pitch.reset();
    },
  };
}
