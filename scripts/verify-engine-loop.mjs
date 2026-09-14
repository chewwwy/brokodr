// Verification for the LOOPER WIRED INTO THE ENGINE. scripts/verify-looper.mjs proves
// the looper DSP in isolation; this proves the plumbing: that engine commands reach it,
// that the record tap carries what the performer actually hears, that loop playback
// reaches the output, that the meter block lands where the UI expects it, and that the
// wire-key tables in worklet-processor.js still mirror the ones in core/looper.js.
//
// Runs in plain Node — the engine is backend-agnostic by design.
import { readFileSync } from "node:fs";
import { Engine } from "../packages/web/public/dsp/engine.js";
import {
  LOOP_STATE,
  LOOP_PENDING,
  LOOP_SOURCE,
  LOOP_TRACKS,
  LOOP_METER_STRIDE,
  LOOP_KEY,
  LOOPER_KEY,
} from "../packages/web/public/dsp/core/looper.js";
import { QUANTIZE_CHOICES } from "../packages/web/public/dsp/core/clock.js";
import { DRUM_SYNTH_DEFAULTS, renderDrum } from "../packages/web/public/dsp/core/drum-synth.js";

const SR = 48000;
const BLOCK = 128;
const LOOP_BASE = 68;
const CLOCK_BASE = LOOP_BASE + LOOP_TRACKS * LOOP_METER_STRIDE; // 100 at four tracks
const METER_FIELDS = 128;

let failures = 0;
let checks = 0;
function ok(name, cond, detail = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`FAIL  ${name} ${detail}`);
  } else console.log(`ok    ${name} ${detail}`);
}
function peak(a, n = a.length) {
  let p = 0;
  for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
}
function finite(a, n = a.length) {
  for (let i = 0; i < n; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

/**
 * A per-frame-unique source so a recorded buffer can be compared sample-for-sample
 * against what was fed in. Bounded well under 1 so nothing clips anywhere.
 */
function srcAt(frame) {
  return 0.37 * Math.sin(frame * 0.013) + 0.11 * Math.sin(frame * 0.211 + 1);
}

/** Run `blocks` blocks of srcAt() through the engine, calling hook(blockIndex) first. */
function runBlocks(eng, blocks, hook, opts = {}) {
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const silent = opts.silent === true;
  const captureOut = opts.captureOut ? new Float32Array(blocks * BLOCK) : null;
  const captureTap = opts.captureTap ? new Float32Array(blocks * BLOCK) : null;
  let frame = opts.startFrame || 0;
  for (let b = 0; b < blocks; b++) {
    if (hook) hook(b);
    for (let i = 0; i < BLOCK; i++) {
      const v = silent ? 0 : srcAt(frame + i);
      inL[i] = v;
      inR[i] = v;
    }
    eng.process(inL, inR, outL, outR, BLOCK);
    if (captureOut) captureOut.set(outL, b * BLOCK);
    if (captureTap) captureTap.set(eng.tapL.subarray(0, BLOCK), b * BLOCK);
    frame += BLOCK;
  }
  return { outL, outR, captureOut, captureTap, frames: frame };
}

// ---------------------------------------------------------------------------
console.log("== 1. the engine owns a clock and a looper ==");
{
  const eng = new Engine(SR, BLOCK);
  ok("engine: has a clock", !!eng.clock, `bpm=${eng.clock && eng.clock.bpm}`);
  ok("engine: has a looper", !!eng.looper);
  ok("engine: looper track count", eng.looper.trackCount === LOOP_TRACKS, `${eng.looper.trackCount}`);
  ok("engine: clock sample rate", eng.clock.sr === SR);
  ok("engine: looper idle at construction", eng.looper.active === false);
  ok(
    "engine: no loop buffers allocated until armed",
    eng.looper.tracks.every((t) => t.bufL === null),
  );
  ok("engine: tap buffers sized to maxBlock", eng.tapL.length === BLOCK && eng.loopR.length === BLOCK);
  ok(
    "engine: record-source descriptor preallocated",
    eng.recSrc && "masterL" in eng.recSrc && "drumL" in eng.recSrc,
  );
}

// ---------------------------------------------------------------------------
console.log("== 2. the clock advances with the audio, one frame per frame ==");
{
  const eng = new Engine(SR, BLOCK);
  runBlocks(eng, 10);
  ok("clock: advanced by exactly the frames rendered", eng.clock.frame === 10 * BLOCK, `${eng.clock.frame}`);

  // Punches are quantised against the frame the block STARTED at, so the clock must not
  // run ahead of the audio. Verified by the fact that a punch asked for during block N
  // can land inside block N: see section 6.
  eng.applyCommand({ t: "clock", key: "run", value: 0 });
  runBlocks(eng, 5, null, { startFrame: 10 * BLOCK });
  ok("clock: stopped clock does not advance", eng.clock.frame === 10 * BLOCK);
  eng.applyCommand({ t: "clock", key: "run", value: 1 });
  runBlocks(eng, 5, null, { startFrame: 10 * BLOCK });
  ok("clock: resumes", eng.clock.frame === 15 * BLOCK, `${eng.clock.frame}`);

  eng.applyCommand({ t: "clock", key: "reset", value: 1 });
  ok("clock: reset zeroes the counter", eng.clock.frame === 0);
}

// ---------------------------------------------------------------------------
console.log("== 3. clock commands route and clamp ==");
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "clock", key: "bpm", value: 174 });
  ok("clock cmd: bpm", eng.clock.bpm === 174);
  ok("clock cmd: grid recalculated", eng.clock.gridFrames === Math.round(4 * ((SR * 60) / 174)));
  eng.applyCommand({ t: "clock", key: "bpm", value: 9999 });
  ok("clock cmd: bpm clamped high", eng.clock.bpm === 300, `${eng.clock.bpm}`);
  eng.applyCommand({ t: "clock", key: "bpm", value: -5 });
  ok("clock cmd: bpm clamped low", eng.clock.bpm === 20, `${eng.clock.bpm}`);
  eng.applyCommand({ t: "clock", key: "beatsPerBar", value: 3 });
  ok("clock cmd: beatsPerBar", eng.clock.beatsPerBar === 3);
  eng.applyCommand({ t: "clock", key: "quantize", value: 1 });
  ok("clock cmd: quantize", eng.clock.quantize === 1);
  eng.applyCommand({ t: "clock", key: "quantize", value: 0 });
  ok("clock cmd: quantize off", eng.clock.quantize === 0 && eng.clock.gridFrames === 0);
  eng.applyCommand({ t: "clock", key: "nonsense", value: 1 });
  ok("clock cmd: unknown key is a no-op", eng.clock.bpm === 20);
  ok("clock: QUANTIZE_CHOICES exported for the UI", QUANTIZE_CHOICES.length >= 8 && QUANTIZE_CHOICES[0] === 0);
}

// ---------------------------------------------------------------------------
console.log("== 4. loop transport commands route to the looper ==");
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "clock", key: "quantize", value: 0 }); // punch immediately
  eng.applyCommand({ t: "loop", op: "rec", index: 1 });
  ok("loop cmd: rec arms the addressed track", eng.looper.track(1).state === LOOP_STATE.REC);
  ok("loop cmd: other tracks untouched", eng.looper.track(0).state === LOOP_STATE.EMPTY);
  ok("loop cmd: arming allocated the buffer", eng.looper.track(1).bufL !== null);

  runBlocks(eng, 40, null, {}); // ~107 ms, past MIN_LOOP_FRAMES
  eng.applyCommand({ t: "loop", op: "rec", index: 1 });
  runBlocks(eng, 2, null, { startFrame: 40 * BLOCK });
  ok("loop cmd: second rec closes the take into PLAY", eng.looper.track(1).state === LOOP_STATE.PLAY);

  eng.applyCommand({ t: "loop", op: "stop", index: 1 });
  runBlocks(eng, 4, null, { startFrame: 42 * BLOCK });
  ok("loop cmd: stop", eng.looper.track(1).state === LOOP_STATE.STOPPED);
  eng.applyCommand({ t: "loop", op: "play", index: 1 });
  runBlocks(eng, 2, null, { startFrame: 46 * BLOCK });
  ok("loop cmd: play", eng.looper.track(1).state === LOOP_STATE.PLAY);

  const len = eng.looper.track(1).frames;
  eng.applyCommand({ t: "loop", op: "clear", index: 1 });
  ok("loop cmd: clear empties the track", eng.looper.track(1).state === LOOP_STATE.EMPTY && len > 0);

  eng.applyCommand({ t: "loop", op: "rec", index: 3 });
  runBlocks(eng, 40, null, { startFrame: 48 * BLOCK });
  eng.applyCommand({ t: "loop", op: "clearall", index: 0 });
  ok(
    "loop cmd: clearall empties every track",
    eng.looper.tracks.every((t) => t.state === LOOP_STATE.EMPTY),
  );
  eng.applyCommand({ t: "loop", op: "rec", index: 99 });
  ok("loop cmd: bad index is a no-op", eng.looper.active === false);
  eng.applyCommand({ t: "loop", op: "nonsense", index: 0 });
  ok("loop cmd: unknown verb is a no-op", eng.looper.track(0).state === LOOP_STATE.EMPTY);
}

// ---------------------------------------------------------------------------
console.log("== 5. loop parameter commands route ==");
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "loopparam", index: 2, key: "gain", value: -6 });
  ok("loopparam: gain", Math.abs(eng.looper.track(2).gainDb + 6) < 1e-9);
  eng.applyCommand({ t: "loopparam", index: 2, key: "mute", value: 1 });
  ok("loopparam: mute", eng.looper.track(2).muted === true);
  eng.applyCommand({ t: "loopparam", index: 2, key: "solo", value: 1 });
  ok("loopparam: solo", eng.looper.track(2).soloed === true);
  eng.applyCommand({ t: "loopparam", index: 2, key: "pan", value: -1 });
  ok("loopparam: pan (balance law, unity on the live side)", eng.looper.track(2).panL === 1 && eng.looper.track(2).panR === 0);
  eng.applyCommand({ t: "loopparam", index: 2, key: "sync", value: 0 });
  ok("loopparam: sync off", eng.looper.track(2).sync === false);
  eng.applyCommand({ t: "loopparam", index: 2, key: "source", value: LOOP_SOURCE.DRUMS });
  ok("loopparam: source", eng.looper.track(2).source === LOOP_SOURCE.DRUMS);
  eng.applyCommand({ t: "loopparam", index: 42, key: "gain", value: -12 });
  ok("loopparam: bad index is a no-op", Math.abs(eng.looper.track(2).gainDb + 6) < 1e-9);

  eng.applyCommand({ t: "looperparam", key: "gain", value: -3 });
  ok("looperparam: gain", Math.abs(eng.looper.gainDb + 3) < 1e-9);
  eng.applyCommand({ t: "looperparam", key: "mute", value: 1 });
  ok("looperparam: mute", eng.looper.muted === true);
  eng.applyCommand({ t: "looperparam", key: "nonsense", value: 1 });
  ok("looperparam: unknown key is a no-op", eng.looper.muted === true);
}

// ---------------------------------------------------------------------------
console.log("== 6. the record tap is what the performer hears ==");
// The looper must record the post-chain, post-drums, post-dry/wet blend, PRE master
// fader. Anything else is either a signal the performer is not hearing, or a take with
// fader moves baked into it.
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "clock", key: "quantize", value: 0 });
  eng.applyCommand({ t: "io", outGain: -12 }); // a fader move that must NOT be recorded
  eng.applyCommand({ t: "loop", op: "rec", index: 0 });

  const REC_BLOCKS = 60;
  const { captureTap } = runBlocks(eng, REC_BLOCKS, null, { captureTap: true });
  const t = eng.looper.track(0);
  const n = t.recWrite;
  ok("tap: recorded the whole run", n === REC_BLOCKS * BLOCK, `${n} vs ${REC_BLOCKS * BLOCK}`);

  // The first ~2 ms is the record declick ramp, deliberately not a copy. Compare past it.
  const skip = eng.looper.declick + 1;
  let maxErr = 0;
  for (let i = skip; i < n; i++) maxErr = Math.max(maxErr, Math.abs(t.bufL[i] - captureTap[i]));
  ok("tap: recorded buffer is the master tap, sample for sample", maxErr < 1e-9, `maxErr=${maxErr.toExponential(2)}`);

  // ...and the master tap is the input at unity, not the faded output.
  let tapErr = 0;
  for (let i = 0; i < REC_BLOCKS * BLOCK; i++) tapErr = Math.max(tapErr, Math.abs(captureTap[i] - srcAt(i)));
  ok("tap: sits pre master fader", tapErr < 1e-6, `maxErr=${tapErr.toExponential(2)}`);
  const recPeak = peak(t.bufL, n);
  ok("tap: take is not attenuated by the -12 dB fader", recPeak > 0.3, `peak=${recPeak.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
console.log("== 7. the voice dry/wet blend is inside the take ==");
{
  // masterMix at 0 = fully dry, 1 = fully wet. The take must follow the blend the
  // performer set, because that blend is what is coming out of the speakers.
  function takeWithMix(mix) {
    const eng = new Engine(SR, BLOCK);
    eng.applyCommand({ t: "clock", key: "quantize", value: 0 });
    eng.applyCommand({ t: "add", id: 1, type: "dist", mix: 1, params: { drive: 40 } });
    eng.applyCommand({ t: "io", masterMix: mix });
    // The master mix is a 25 ms one-pole; it needs ~20 time constants before it snaps
    // exactly onto its target, and a fully dry take is only bit-exact once it has. At
    // 128-frame blocks / 48 kHz, 250 blocks is 640 ms — 25 time constants.
    runBlocks(eng, SETTLE);
    eng.applyCommand({ t: "loop", op: "rec", index: 0 });
    runBlocks(eng, 40, null, { startFrame: SETTLE * BLOCK });
    const t = eng.looper.track(0);
    return {
      slots: eng.slots.length,
      buf: t.bufL.slice(0, t.recWrite),
      declick: eng.looper.declick,
      settled: eng.masterMix.settled,
    };
  }
  const SETTLE = 250;
  const wet = takeWithMix(1);
  const dry = takeWithMix(0);
  ok("blend: effect slot installed for the test", wet.slots === 1, `slots=${wet.slots}`);
  ok("blend: the mix smoother settled before the take", dry.settled && wet.settled);

  const skip = dry.declick + 1;
  let dryErr = 0;
  for (let i = skip; i < dry.buf.length; i++) dryErr = Math.max(dryErr, Math.abs(dry.buf[i] - srcAt(SETTLE * BLOCK + i)));
  ok("blend: a fully dry blend records the untouched input", dryErr < 1e-6, `maxErr=${dryErr.toExponential(2)}`);

  let diff = 0;
  for (let i = skip; i < wet.buf.length; i++) diff = Math.max(diff, Math.abs(wet.buf[i] - dry.buf[i]));
  ok("blend: a wet blend records the processed signal instead", diff > 0.05, `maxDiff=${diff.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
console.log("== 8. loop playback reaches the output, through the master fader ==");
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "clock", key: "quantize", value: 0 });
  eng.applyCommand({ t: "loop", op: "rec", index: 0 });
  runBlocks(eng, 60);
  eng.applyCommand({ t: "loop", op: "rec", index: 0 }); // close -> PLAY
  runBlocks(eng, 4, null, { startFrame: 60 * BLOCK });

  // Now feed SILENCE: everything at the output is loop playback.
  const { captureOut } = runBlocks(eng, 20, null, { silent: true, captureOut: true, startFrame: 64 * BLOCK });
  const pk = peak(captureOut);
  ok("playback: audible at the output with a silent input", pk > 0.2, `peak=${pk.toFixed(3)}`);
  ok("playback: finite", finite(captureOut));

  // Master fader must scale loop playback — it is the final volume control.
  eng.applyCommand({ t: "io", outGain: -60 });
  const { captureOut: faded } = runBlocks(eng, 40, null, { silent: true, captureOut: true, startFrame: 84 * BLOCK });
  const pkFaded = peak(faded.subarray(faded.length - BLOCK * 4));
  ok("playback: master fader attenuates loops", pkFaded < pk * 0.05, `faded=${pkFaded.toExponential(2)}`);

  // ...but the voice dry/wet must NOT: it belongs to the voice chain.
  const eng2 = new Engine(SR, BLOCK);
  eng2.applyCommand({ t: "clock", key: "quantize", value: 0 });
  eng2.applyCommand({ t: "loop", op: "rec", index: 0 });
  runBlocks(eng2, 60);
  eng2.applyCommand({ t: "loop", op: "rec", index: 0 });
  runBlocks(eng2, 4, null, { startFrame: 60 * BLOCK });
  const { captureOut: mixUp } = runBlocks(eng2, 20, null, { silent: true, captureOut: true, startFrame: 64 * BLOCK });
  eng2.applyCommand({ t: "io", masterMix: 0 });
  runBlocks(eng2, 30, null, { silent: true, startFrame: 84 * BLOCK });
  const { captureOut: mixDown } = runBlocks(eng2, 20, null, { silent: true, captureOut: true, startFrame: 114 * BLOCK });
  ok(
    "playback: voice dry/wet does not duck loops",
    Math.abs(peak(mixDown) - peak(mixUp)) < 0.02,
    `up=${peak(mixUp).toFixed(3)} down=${peak(mixDown).toFixed(3)}`,
  );
}

// ---------------------------------------------------------------------------
console.log("== 9. a loop never records itself ==");
// The failure this guards against is catastrophic: if loop playback were inside the
// record tap, an overdub would feed back on itself and build to a scream in seconds.
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "clock", key: "quantize", value: 0 });
  eng.applyCommand({ t: "loop", op: "rec", index: 0 });
  runBlocks(eng, 60);
  eng.applyCommand({ t: "loop", op: "rec", index: 0 }); // -> PLAY
  runBlocks(eng, 10, null, { startFrame: 60 * BLOCK });

  const t = eng.looper.track(0);
  const before = t.bufL.slice(0, t.frames);
  const peakBefore = peak(before);

  // Overdub with a silent input for 40 loop passes. If the loop's own output were
  // reaching the record tap, the buffer would grow without bound.
  eng.applyCommand({ t: "loop", op: "rec", index: 0 }); // -> OVERDUB
  const passes = Math.ceil((t.frames * 40) / BLOCK);
  runBlocks(eng, passes, null, { silent: true, startFrame: 70 * BLOCK });
  ok("feedback: still overdubbing", eng.looper.track(0).state === LOOP_STATE.OVERDUB);

  let maxErr = 0;
  for (let i = 0; i < t.frames; i++) maxErr = Math.max(maxErr, Math.abs(t.bufL[i] - before[i]));
  ok("feedback: 40 silent overdub passes changed nothing", maxErr < 1e-9, `maxErr=${maxErr.toExponential(2)}`);
  ok("feedback: peak unchanged", Math.abs(peak(t.bufL, t.frames) - peakBefore) < 1e-9);

  // And with a live input, the overdub grows by the input only — not by the input plus
  // the loop it is being layered over.
  const eng2 = new Engine(SR, BLOCK);
  eng2.applyCommand({ t: "clock", key: "quantize", value: 0 });
  eng2.applyCommand({ t: "loop", op: "rec", index: 0 });
  runBlocks(eng2, 60);
  eng2.applyCommand({ t: "loop", op: "rec", index: 0 });
  runBlocks(eng2, 10, null, { startFrame: 60 * BLOCK });
  const t2 = eng2.looper.track(0);
  const base = t2.bufL.slice(0, t2.frames);
  eng2.applyCommand({ t: "loop", op: "rec", index: 0 }); // OVERDUB
  const p2 = Math.ceil((t2.frames * 12) / BLOCK);
  runBlocks(eng2, p2, null, { startFrame: 70 * BLOCK });
  const grown = peak(t2.bufL, t2.frames);
  ok(
    "feedback: a live overdub stays bounded over 12 passes",
    grown < peak(base) * 14,
    `base=${peak(base).toFixed(3)} after=${grown.toFixed(3)}`,
  );
  ok("feedback: output still finite", finite(t2.bufL));
}

// ---------------------------------------------------------------------------
console.log("== 10. the DRUMS record source takes the rack bus, not the master ==");
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "clock", key: "quantize", value: 0 });
  eng.applyCommand({ t: "loopparam", index: 0, key: "source", value: LOOP_SOURCE.DRUMS });
  eng.applyCommand({ t: "loop", op: "rec", index: 0 });
  // Live input present the whole time, but no pad ever fires: the take must be silent.
  runBlocks(eng, 60);
  const t = eng.looper.track(0);
  ok("drum source: silent rack records silence", peak(t.bufL, t.recWrite) < 1e-7, `peak=${peak(t.bufL, t.recWrite)}`);

  // Fire a pad and the take gets audio. A pad with no buffer is silent by design
  // (DrumVoice.trigger returns early at layerCount 0), so load a synthesised kick first
  // — exactly what the starter kit does on load.
  const kick = renderDrum("kick", SR, DRUM_SYNTH_DEFAULTS.kick);
  eng.applyCommand({ t: "padload", index: 0, layer: 0, data: kick.data, frames: kick.frames, rate: SR });
  eng.applyCommand({ t: "padparam", index: 0, key: "gain", value: 0 });
  const mark = t.recWrite;
  eng.applyCommand({ t: "pad", index: 0, vel: 1 });
  runBlocks(eng, 40, null, { startFrame: 60 * BLOCK });
  const after = peak(t.bufL.subarray(mark, t.recWrite));
  ok("drum source: a pad hit lands in the take", after > 1e-4, `peak=${after.toExponential(2)}`);

  // Stale-buffer guard: the rack's bus keeps the last block it rendered, so once the
  // kit goes quiet the engine must hand the looper null rather than that stale block.
  const eng2 = new Engine(SR, BLOCK);
  eng2.applyCommand({ t: "clock", key: "quantize", value: 0 });
  eng2.applyCommand({ t: "padload", index: 0, layer: 0, data: kick.data, frames: kick.frames, rate: SR });
  eng2.applyCommand({ t: "pad", index: 0, vel: 1 });
  runBlocks(eng2, 4);
  const staleBlock = peak(eng2.drumL);
  // A pad plays to the end of its buffer, so "finished ringing" is the buffer length,
  // not a guessed block count — the synthesised kick is ~1.3 s.
  const ringBlocks = Math.ceil(kick.frames / BLOCK) + 8;
  runBlocks(eng2, ringBlocks, null, { startFrame: 4 * BLOCK });
  ok("drum source: rack went idle", eng2.drums.sounding === false, `stale block peak=${staleBlock.toFixed(3)}`);
  eng2.applyCommand({ t: "loopparam", index: 1, key: "source", value: LOOP_SOURCE.DRUMS });
  eng2.applyCommand({ t: "loop", op: "rec", index: 1 });
  runBlocks(eng2, 60, null, { startFrame: (4 + ringBlocks) * BLOCK });
  const t2 = eng2.looper.track(1);
  ok(
    "drum source: an idle rack records silence, not its last block",
    peak(t2.bufL, t2.recWrite) < 1e-7,
    `peak=${peak(t2.bufL, t2.recWrite).toExponential(2)}`,
  );
}

// ---------------------------------------------------------------------------
console.log("== 11. quantised punches land on the grid, not on the block boundary ==");
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "clock", key: "bpm", value: 120 });
  eng.applyCommand({ t: "clock", key: "quantize", value: 1 }); // one beat = 24000 frames
  const grid = eng.clock.gridFrames;
  ok("punch: grid is one beat at 120 bpm", grid === 24000, `${grid}`);

  // Ask for a punch a few hundred frames after the downbeat: it must fire at the NEXT
  // beat, which is mid-block, not at the start of a block.
  runBlocks(eng, 3); // frame 384
  eng.applyCommand({ t: "loop", op: "rec", index: 0 });
  ok("punch: pending", eng.looper.track(0).pending === LOOP_PENDING.REC);
  ok("punch: scheduled on the grid line", eng.looper.track(0).pendingAt === grid, `${eng.looper.track(0).pendingAt}`);
  ok("punch: grid line is NOT block aligned", grid % BLOCK !== 0);

  const blocks = Math.ceil((grid + BLOCK * 4) / BLOCK);
  runBlocks(eng, blocks, null, { startFrame: 3 * BLOCK });
  const t = eng.looper.track(0);
  ok("punch: recording after the grid line", t.state === LOOP_STATE.REC);
  // The first recorded frame must be the master tap at exactly `grid`, ramped by the
  // declick. Check a sample past the ramp instead: buf[k] === srcAt(grid + k).
  const k = eng.looper.declick + 8;
  ok(
    "punch: take starts at the grid frame, sample accurate",
    Math.abs(t.bufL[k] - srcAt(grid + k)) < 1e-6,
    `buf=${t.bufL[k].toFixed(6)} src=${srcAt(grid + k).toFixed(6)}`,
  );
}

// ---------------------------------------------------------------------------
console.log("== 12. per-track effect chains ==");
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "clock", key: "quantize", value: 0 });
  eng.applyCommand({ t: "loop", op: "rec", index: 0 });
  const LOOP_BLOCKS = 60; // 7680 frames — a whole number of blocks, on purpose
  runBlocks(eng, LOOP_BLOCKS);
  eng.applyCommand({ t: "loop", op: "rec", index: 0 }); // sets the length, drops into PLAY

  // Every capture window is exactly ONE full loop pass, and every window starts at
  // playhead 0. Comparing two windows taken at different loop phases would compare
  // different parts of the recording, which is not a test of anything.
  let at = LOOP_BLOCKS;
  const pass = (capture) => {
    const r = runBlocks(eng, LOOP_BLOCKS, null, { silent: true, captureOut: capture, startFrame: at * BLOCK });
    at += LOOP_BLOCKS;
    return r.captureOut;
  };
  // The FIRST pass out of the rec punch carries the record-exit declick fade, so it is
  // not representative of steady-state playback. Throw it away; pass two onward are
  // bit-identical to each other.
  pass(false);
  const plain = pass(true);

  eng.applyCommand({ t: "loopfx", index: 0, op: "add", id: 7, type: "dist", mix: 1, params: { drive: 40 } });
  const chain = eng.looper.track(0).chain;
  ok("loopfx: chain created lazily on first add", !!chain && chain.length === 1);
  pass(false); // one pass for the slot's mix smoother to settle
  const driven = pass(true);
  let fxDiff = 0;
  for (let i = 0; i < plain.length; i++) fxDiff = Math.max(fxDiff, Math.abs(driven[i] - plain[i]));
  ok("loopfx: the effect changes that track's output", fxDiff > 0.02, `maxDiff=${fxDiff.toFixed(3)}`);

  eng.applyCommand({ t: "loopfx", index: 0, op: "bypass", id: 7, value: true });
  pass(false);
  const back = pass(true);
  let backDiff = 0;
  for (let i = 0; i < plain.length; i++) backDiff = Math.max(backDiff, Math.abs(back[i] - plain[i]));
  ok("loopfx: bypass reaches the slot", backDiff < 1e-6, `maxDiff=${backDiff.toExponential(2)}`);

  eng.applyCommand({ t: "loopfx", index: 0, op: "remove", id: 7 });
  ok("loopfx: remove", eng.looper.track(0).chain.length === 0);
  eng.applyCommand({ t: "loopfx", index: 0, op: "add", id: 8, type: "dist", mix: 1 });
  eng.applyCommand({ t: "loopfx", index: 0, op: "clear" });
  ok("loopfx: clear", eng.looper.track(0).chain.length === 0);
  eng.applyCommand({ t: "loopfx", index: 77, op: "add", id: 9, type: "dist" });
  ok("loopfx: bad index is a no-op", eng.looper.track(0).chain.length === 0);
  ok("loopfx: other tracks have no chain", eng.looper.track(1).chain === null);
}

// ---------------------------------------------------------------------------
console.log("== 13. panic stops the noise but keeps the performance ==");
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "clock", key: "quantize", value: 0 });
  eng.applyCommand({ t: "loop", op: "rec", index: 0 });
  runBlocks(eng, 60);
  eng.applyCommand({ t: "loop", op: "rec", index: 0 }); // -> PLAY
  runBlocks(eng, 6, null, { startFrame: 60 * BLOCK });
  const len = eng.looper.track(0).frames;
  const content = peak(eng.looper.track(0).bufL, len);

  eng.applyCommand({ t: "loop", op: "rec", index: 1 }); // a take in progress on track 1
  runBlocks(eng, 20, null, { startFrame: 66 * BLOCK });
  eng.applyCommand({ t: "panic" });
  ok("panic: playing loop is stopped", eng.looper.track(0).state === LOOP_STATE.STOPPED);
  ok("panic: its audio survives", eng.looper.track(0).frames === len && peak(eng.looper.track(0).bufL, len) === content);
  ok("panic: the in-progress take is dropped", eng.looper.track(1).state === LOOP_STATE.EMPTY);

  runBlocks(eng, 40, null, { silent: true, startFrame: 86 * BLOCK });
  const { captureOut } = runBlocks(eng, 8, null, { silent: true, captureOut: true, startFrame: 126 * BLOCK });
  ok("panic: silent afterwards", peak(captureOut) < 1e-6, `peak=${peak(captureOut).toExponential(2)}`);
}

// ---------------------------------------------------------------------------
console.log("== 14. undo/redo through the engine ==");
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "clock", key: "quantize", value: 0 });
  eng.applyCommand({ t: "loop", op: "rec", index: 0 });
  runBlocks(eng, 60);
  eng.applyCommand({ t: "loop", op: "rec", index: 0 }); // -> PLAY
  runBlocks(eng, 6, null, { startFrame: 60 * BLOCK });
  const t = eng.looper.track(0);
  const take = t.bufL.slice(0, t.frames);

  eng.applyCommand({ t: "loop", op: "rec", index: 0 }); // OVERDUB
  const passes = Math.ceil((t.frames * 2) / BLOCK);
  runBlocks(eng, passes, null, { startFrame: 66 * BLOCK });
  eng.applyCommand({ t: "loop", op: "rec", index: 0 }); // back to PLAY
  runBlocks(eng, 2, null, { startFrame: (66 + passes) * BLOCK });
  const layered = peak(t.bufL, t.frames);
  ok("undo: the overdub added material", layered > peak(take) * 1.05, `take=${peak(take).toFixed(3)} layered=${layered.toFixed(3)}`);

  eng.applyCommand({ t: "loop", op: "undo", index: 0 });
  let maxErr = 0;
  for (let i = 0; i < t.frames; i++) maxErr = Math.max(maxErr, Math.abs(t.bufL[i] - take[i]));
  ok("undo: restores the buffer bit-for-bit", maxErr < 1e-6, `maxErr=${maxErr.toExponential(2)}`);
  eng.applyCommand({ t: "loop", op: "undo", index: 0 });
  ok("undo: redo puts the layer back", Math.abs(peak(t.bufL, t.frames) - layered) < 1e-6);
}

// ---------------------------------------------------------------------------
console.log("== 15. the meter block lands where the UI reads it ==");
{
  const eng = new Engine(SR, BLOCK);
  const m = new Float32Array(METER_FIELDS);
  eng.readMeters(m);
  ok("meters: nothing written past the block", m.length === METER_FIELDS);
  ok(
    "meters: loop block fits inside METER_FIELDS",
    CLOCK_BASE + 8 <= METER_FIELDS,
    `needs ${CLOCK_BASE + 8}, have ${METER_FIELDS}`,
  );
  ok("meters: drum block untouched at 64..67", m[67] === eng.drumRoute);
  for (let i = 0; i < LOOP_TRACKS; i++) {
    const o = LOOP_BASE + i * LOOP_METER_STRIDE;
    ok(`meters: track ${i} starts EMPTY`, m[o] === LOOP_STATE.EMPTY && m[o + 1] === LOOP_PENDING.NONE);
  }
  ok("meters: bpm", m[CLOCK_BASE] === 120);
  ok("meters: beatsPerBar", m[CLOCK_BASE + 1] === 4);
  ok("meters: quantize", m[CLOCK_BASE + 2] === 4);
  ok("meters: running", m[CLOCK_BASE + 3] === 1);

  // Record something and read the block back mid-take.
  eng.applyCommand({ t: "clock", key: "quantize", value: 0 });
  eng.applyCommand({ t: "clock", key: "bpm", value: 90 });
  eng.applyCommand({ t: "loop", op: "rec", index: 2 });
  runBlocks(eng, 60);
  eng.readMeters(m);
  const o2 = LOOP_BASE + 2 * LOOP_METER_STRIDE;
  ok("meters: state REC", m[o2] === LOOP_STATE.REC);
  ok("meters: length reports frames written so far", m[o2 + 4] === eng.looper.track(2).recWrite, `${m[o2 + 4]}`);
  ok("meters: level moving", m[o2 + 2] > 1e-4, `${m[o2 + 2].toFixed(4)}`);
  ok("meters: position 0..1", m[o2 + 3] >= 0 && m[o2 + 3] <= 1);
  ok("meters: chain length 0", m[o2 + 5] === 0);
  ok("meters: bpm change visible", m[CLOCK_BASE] === 90);
  ok("meters: bar phase 0..1", m[CLOCK_BASE + 4] >= 0 && m[CLOCK_BASE + 4] < 1);
  ok("meters: bar count", m[CLOCK_BASE + 5] === Math.floor(eng.clock.bar));

  eng.applyCommand({ t: "loop", op: "rec", index: 2 }); // close
  runBlocks(eng, 8, null, { startFrame: 60 * BLOCK });
  eng.readMeters(m);
  ok("meters: state PLAY", m[o2] === LOOP_STATE.PLAY);
  ok("meters: length is the loop length", m[o2 + 4] === eng.looper.track(2).frames);
  ok("meters: looper bus level", m[CLOCK_BASE + 6] > 1e-4, `${m[CLOCK_BASE + 6].toFixed(4)}`);
  ok("meters: every field finite", finite(m));
}

// ---------------------------------------------------------------------------
console.log("== 16. an idle looper is free and changes nothing ==");
{
  // Same input, one engine that has never touched the looper and one that recorded and
  // then cleared: the output must be identical, to the sample.
  const a = new Engine(SR, BLOCK);
  const b = new Engine(SR, BLOCK);
  b.applyCommand({ t: "clock", key: "quantize", value: 0 });
  b.applyCommand({ t: "loop", op: "rec", index: 0 });
  runBlocks(b, 60);
  b.applyCommand({ t: "loop", op: "clearall", index: 0 });
  runBlocks(b, 40, null, { startFrame: 60 * BLOCK });
  ok("idle: looper reports inactive", b.looper.active === false);

  const { captureOut: outA } = runBlocks(a, 30, null, { captureOut: true, startFrame: 100 * BLOCK });
  const { captureOut: outB } = runBlocks(b, 30, null, { captureOut: true, startFrame: 100 * BLOCK });
  let maxErr = 0;
  for (let i = 0; i < outA.length; i++) maxErr = Math.max(maxErr, Math.abs(outA[i] - outB[i]));
  ok("idle: output identical to an engine that never looped", maxErr < 1e-12, `maxErr=${maxErr.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
console.log("== 17. wire tables stay in lockstep with the DSP core ==");
// PAD_KEY-style tables are duplicated in worklet-processor.js (it cannot import the
// core's exports without pulling the whole module into the hot path's scope) so the two
// copies have to be checked mechanically, or a reorder silently remaps every control.
{
  const wp = readFileSync(new URL("../packages/web/public/dsp/worklet-processor.js", import.meta.url), "utf8");
  function table(name) {
    const m = wp.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
    if (!m) return null;
    return m[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);
  }
  const wpLoop = table("LOOP_KEY");
  const wpLooper = table("LOOPER_KEY");
  const wpClock = table("CLOCK_KEY");
  ok("lockstep: worklet declares LOOP_KEY", !!wpLoop);
  ok("lockstep: LOOP_KEY matches core/looper.js", JSON.stringify(wpLoop) === JSON.stringify(LOOP_KEY), `${JSON.stringify(wpLoop)}`);
  ok("lockstep: LOOPER_KEY matches core/looper.js", JSON.stringify(wpLooper) === JSON.stringify(LOOPER_KEY), `${JSON.stringify(wpLooper)}`);
  ok("lockstep: CLOCK_KEY declared", !!wpClock && wpClock[0] === "bpm", `${JSON.stringify(wpClock)}`);

  // Every CLOCK_KEY name must be a key Clock.setParam actually handles, or the UI sends
  // a control that silently does nothing.
  const clockSrc = readFileSync(new URL("../packages/web/public/dsp/core/clock.js", import.meta.url), "utf8");
  const handled = wpClock.every((k) => clockSrc.includes(`case "${k}":`));
  ok("lockstep: every CLOCK_KEY is handled by Clock.setParam", handled);

  // Opcodes are append-only and must be unique. Scope the scrape to the `const OP = {...}`
  // block — the file holds several other `NAME: n,` tables (FILE_FIELD, IO_FIELD, ...) whose
  // numbers are indices into their own namespaces and legitimately collide with opcodes.
  const opBlock = wp.match(/const OP = \{([\s\S]*?)\n\};/);
  ok("lockstep: OP table found", !!opBlock);
  const ops = [...(opBlock ? opBlock[1] : "").matchAll(/^\s*([A-Z_]+): (\d+),/gm)].map((m) => [m[1], Number(m[2])]);
  const nums = ops.map((o) => o[1]);
  ok("lockstep: opcodes unique", new Set(nums).size === nums.length, `${ops.map((o) => o.join("=")).join(" ")}`);
  const byName = Object.fromEntries(ops);
  ok("lockstep: OP.PADFX still 13", byName.PADFX === 13);
  ok("lockstep: OP.LOOP is 14", byName.LOOP === 14);
  ok("lockstep: OP.LOOPER/CLOCK/LOOPFX present", byName.LOOPER === 15 && byName.CLOCK === 16 && byName.LOOPFX === 17);

  // The worklet's meter scratch must be at least as wide as the engine writes.
  const scratch = wp.match(/meterScratch = new Float32Array\((\d+)\)/);
  ok("lockstep: meterScratch declared", !!scratch);
  ok(
    "lockstep: meterScratch covers the loop block",
    Number(scratch[1]) >= CLOCK_BASE + 8,
    `${scratch && scratch[1]} >= ${CLOCK_BASE + 8}`,
  );

  const backend = readFileSync(new URL("../packages/web/src/web/audio/worklet-backend.ts", import.meta.url), "utf8");
  const mf = backend.match(/METER_FIELDS = (\d+)/);
  ok("lockstep: backend declares METER_FIELDS", !!mf);
  ok(
    "lockstep: METER_FIELDS equals meterScratch",
    !!mf && Number(mf[1]) === Number(scratch[1]),
    `backend=${mf && mf[1]} worklet=${scratch && scratch[1]}`,
  );
}

// ---------------------------------------------------------------------------
console.log("== 18. stress: random control traffic against a live engine ==");
{
  // Everything at once — pads firing, loops punching, tempo changes, panics — checking
  // only that the engine stays finite, bounded and structurally sane. This is the test
  // that catches an ordering bug the targeted cases cannot see.
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const eng = new Engine(SR, BLOCK);
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  let worst = 0;
  let allFinite = true;
  for (let b = 0; b < 4000; b++) {
    const i = (rnd() * LOOP_TRACKS) | 0;
    const roll = rnd();
    if (roll < 0.06) eng.applyCommand({ t: "loop", op: "rec", index: i });
    else if (roll < 0.09) eng.applyCommand({ t: "loop", op: "play", index: i });
    else if (roll < 0.11) eng.applyCommand({ t: "loop", op: "stop", index: i });
    else if (roll < 0.12) eng.applyCommand({ t: "loop", op: "clear", index: i });
    else if (roll < 0.13) eng.applyCommand({ t: "loop", op: "undo", index: i });
    else if (roll < 0.15) eng.applyCommand({ t: "loopparam", index: i, key: "sync", value: rnd() < 0.5 ? 0 : 1 });
    else if (roll < 0.17) eng.applyCommand({ t: "loopparam", index: i, key: "gain", value: rnd() * 24 - 18 });
    else if (roll < 0.19) eng.applyCommand({ t: "loopparam", index: i, key: "pan", value: rnd() * 2 - 1 });
    else if (roll < 0.2) eng.applyCommand({ t: "loopparam", index: i, key: "source", value: rnd() < 0.5 ? 0 : 1 });
    else if (roll < 0.21) eng.applyCommand({ t: "clock", key: "bpm", value: 60 + rnd() * 140 });
    else if (roll < 0.22) eng.applyCommand({ t: "clock", key: "quantize", value: rnd() < 0.5 ? 0 : 1 + ((rnd() * 4) | 0) });
    else if (roll < 0.225) eng.applyCommand({ t: "clock", key: "reset", value: 1 });
    else if (roll < 0.23) eng.applyCommand({ t: "panic" });
    else if (roll < 0.28) eng.applyCommand({ t: "pad", index: (rnd() * 16) | 0, vel: rnd() });
    else if (roll < 0.29) eng.applyCommand({ t: "io", masterMix: rnd() });

    for (let k = 0; k < BLOCK; k++) {
      const v = srcAt(b * BLOCK + k) * 1.4;
      inL[k] = v;
      inR[k] = v;
    }
    eng.process(inL, inR, outL, outR, BLOCK);
    if (!finite(outL) || !finite(outR)) allFinite = false;
    worst = Math.max(worst, peak(outL), peak(outR));
  }
  ok("stress: output always finite", allFinite);
  ok("stress: output bounded by the safety clamp", worst <= 1.4 + 1e-6, `peak=${worst.toFixed(4)}`);
  ok(
    "stress: tracks left structurally consistent",
    eng.looper.tracks.every((t) => (t.frames === 0 ? t.state === LOOP_STATE.EMPTY || t.state === LOOP_STATE.REC : t.frames > 0 && t.frames <= t.maxFrames)),
  );
  const m = new Float32Array(METER_FIELDS);
  eng.readMeters(m);
  ok("stress: meter block still finite", finite(m));
  ok("stress: clock still sane", eng.clock.bpm >= 20 && eng.clock.bpm <= 300 && eng.clock.frame >= 0);
}

console.log("");
console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
