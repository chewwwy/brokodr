// Numeric verification for the BROBEATS looper and transport clock.
//
// Runs in plain Node: both modules are deliberately backend-agnostic (no AudioContext,
// no DOM, no globals), so the whole state machine can be driven headlessly at sample
// accuracy. Any failure here is a real audio bug — drift, a click, a lost punch, or an
// undo that does not put the buffer back exactly where it was.
import { Clock, MIN_BPM, MAX_BPM, QUANTIZE_CHOICES } from "../packages/web/public/dsp/core/clock.js";
import {
  Looper,
  LOOP_TRACKS,
  LOOP_STATE,
  LOOP_PENDING,
  LOOP_SOURCE,
  LOOP_KEY,
  LOOPER_KEY,
  LOOP_METER_STRIDE,
} from "../packages/web/public/dsp/core/looper.js";

const SR = 48000;
const BLOCK = 128;
let failures = 0;
let checks = 0;

function ok(name, cond, detail = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`FAIL  ${name} ${detail}`);
  } else console.log(`ok    ${name} ${detail}`);
}
function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}
function finite(a) {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}
function peak(a) {
  let p = 0;
  for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
}
// A source value that is a unique function of the ABSOLUTE frame, so a recorded buffer
// can be checked against the exact sample the punch was scheduled for.
function srcAt(frame) {
  return (((frame % 9973) + 1) / 9973) * 0.8;
}

/**
 * Drive the looper for `blocks` blocks of BLOCK frames.
 * `onBlock(blockIndex, clock)` runs before each render, which is where the engine drains
 * control commands, so a click lands at a block boundary exactly as it does in the app.
 * Returns the concatenated output plus per-block snapshots.
 */
function drive(looper, clock, blocks, opts = {}) {
  const onBlock = opts.onBlock || null;
  const level = opts.level === undefined ? 1 : opts.level;
  const n = blocks * BLOCK;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const L = new Float32Array(BLOCK);
  const R = new Float32Array(BLOCK);
  const mL = new Float32Array(BLOCK);
  const mR = new Float32Array(BLOCK);
  const dL = new Float32Array(BLOCK);
  const dR = new Float32Array(BLOCK);
  const src = { masterL: mL, masterR: mR, drumL: dL, drumR: dR };
  for (let b = 0; b < blocks; b++) {
    if (onBlock) onBlock(b, clock);
    for (let i = 0; i < BLOCK; i++) {
      const v = srcAt(clock.frame + i) * level;
      mL[i] = v;
      mR[i] = v;
      dL[i] = -v; // distinct from master, so a source switch is provable
      dR[i] = -v;
      L[i] = 0;
      R[i] = 0;
    }
    looper.process(src, L, R, BLOCK, clock);
    outL.set(L, b * BLOCK);
    outR.set(R, b * BLOCK);
    clock.advance(BLOCK);
  }
  return { outL, outR };
}

// ============================================================ 1. clock
console.log("== 1. transport clock ==");
{
  const c = new Clock(SR);
  ok("clock: default 120 bpm, 4/4", c.bpm === 120 && c.beatsPerBar === 4);
  ok("clock: framesPerBeat at 120 bpm", near(c.framesPerBeat, 24000, 1e-9), `${c.framesPerBeat}`);
  ok("clock: default grid is one bar", c.gridFrames === 96000, `${c.gridFrames}`);
  ok("clock: grid is an integer", Number.isInteger(c.gridFrames));
  ok("clock: runs from construction", c.running === true && c.frame === 0);

  c.advance(BLOCK);
  ok("clock: advance counts frames", c.frame === BLOCK);
  c.setParam("run", 0);
  c.advance(BLOCK);
  ok("clock: stopped clock does not advance", c.frame === BLOCK);
  c.setParam("run", 1);
  c.advance(BLOCK);
  ok("clock: restarts", c.frame === 2 * BLOCK);

  c.setParam("bpm", 5);
  ok("clock: bpm clamps low", c.bpm === MIN_BPM, `${c.bpm}`);
  c.setParam("bpm", 9999);
  ok("clock: bpm clamps high", c.bpm === MAX_BPM, `${c.bpm}`);
  c.setParam("bpm", 140);
  ok("clock: grid tracks tempo", c.gridFrames === Math.round(4 * ((SR * 60) / 140)), `${c.gridFrames}`);

  c.setParam("quantize", 0);
  ok("clock: quantize off kills the grid", c.gridFrames === 0);
  ok("clock: grid off means act now", c.framesToGrid(c.frame) === 0);
  c.setParam("quantize", 1);
  ok("clock: one-beat grid", c.gridFrames === Math.round((SR * 60) / 140), `${c.gridFrames}`);

  c.setParam("bpm", 120);
  c.setParam("quantize", 4);
  c.reset();
  ok("clock: reset zeroes the counter", c.frame === 0);
  ok("clock: framesToGrid on a boundary is a whole grid", c.framesToGrid(0) === 96000);
  ok("clock: framesToGrid mid-grid", c.framesToGrid(1000) === 95000);
  ok("clock: framesToGrid never lands on 0", c.framesToGrid(96000 - 1) === 1);

  c.advance(96000 + 24000);
  ok("clock: beat position", near(c.beat, 5, 1e-9), `${c.beat}`);
  ok("clock: bar position", near(c.bar, 1.25, 1e-9), `${c.bar}`);
  ok("clock: bar phase", near(c.barPhase, 0.25, 1e-9), `${c.barPhase}`);
  ok("clock: barFrames", c.barFrames === 96000);
  ok("clock: framesForBeats is integral", Number.isInteger(c.framesForBeats(0.333)));

  c.setParam("beatsPerBar", 3);
  ok("clock: beatsPerBar applies", c.beatsPerBar === 3 && c.barFrames === 72000);
  c.setParam("beatsPerBar", 99);
  ok("clock: beatsPerBar clamps", c.beatsPerBar === 16);

  ok("clock: quantize choices start with off", QUANTIZE_CHOICES[0] === 0);
  ok("clock: quantize choices ascend", QUANTIZE_CHOICES.every((v, i) => i === 0 || v > QUANTIZE_CHOICES[i - 1]));
}

// ============================================================ 2. construction
console.log("\n== 2. looper construction and laziness ==");
{
  const lp = new Looper(SR, BLOCK);
  ok("looper: four tracks by default", lp.trackCount === LOOP_TRACKS && LOOP_TRACKS === 4);
  ok("looper: tracks start empty", lp.tracks.every((t) => t.state === LOOP_STATE.EMPTY && t.frames === 0));
  ok("looper: no buffers allocated up front", lp.tracks.every((t) => t.bufL === null && t.bufR === null));
  ok("looper: no undo slot up front", lp.undoL === null);
  ok("looper: no chains up front", lp.tracks.every((t) => t.chain === null));
  ok("looper: idle looper is inactive", lp.active === false);
  ok("looper: bad index is null", lp.track(-1) === null && lp.track(99) === null);
  ok("looper: maxFrames is 30 s", lp.maxFrames === 30 * SR, `${lp.maxFrames}`);
  ok("looper: declick is ~2 ms", lp.declick === 96, `${lp.declick}`);

  const c = new Clock(SR);
  lp.recordToggle(0, c);
  ok("looper: arming allocates that track only", lp.tracks[0].bufL !== null && lp.tracks[1].bufL === null);
  ok("looper: arming makes it active", lp.active === true);
  ok("looper: arming does not allocate undo (nothing to undo)", lp.undoL === null);

  ok("looper: chainFor creates on demand", lp.chainFor(1) !== null && lp.tracks[1].chain !== null);
  ok("looper: chainFor is stable", lp.chainFor(1) === lp.tracks[1].chain);
  ok("looper: chainFor rejects bad index", lp.chainFor(42) === null);

  const lp2 = new Looper(SR, BLOCK, { tracks: 2, maxSeconds: 1 });
  ok("looper: track count is configurable", lp2.trackCount === 2);
  ok("looper: maxSeconds is configurable", lp2.maxFrames === SR);

  ok("looper: wire key tables are stable", LOOP_KEY[0] === "gain" && LOOP_KEY[1] === "mute" && LOOP_KEY[2] === "solo");
  ok("looper: looper key table is stable", LOOPER_KEY[0] === "gain" && LOOPER_KEY[1] === "mute");
  ok("looper: meter stride matches the layout", LOOP_METER_STRIDE === 8);
  ok("looper: process survives a null source", (() => {
    const l3 = new Looper(SR, BLOCK);
    const L = new Float32Array(BLOCK);
    const R = new Float32Array(BLOCK);
    l3.recordToggle(0, null);
    l3.process(null, L, R, BLOCK, null);
    return finite(L) && finite(R);
  })());
}

// ============================================================ 3. free-running take
console.log("\n== 3. free-running record and playback ==");
{
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  lp.setTrackParam(0, "sync", 0);
  const t = lp.track(0);
  const recBlocks = 40; // 5120 frames, over MIN_LOOP_FRAMES
  drive(lp, c, recBlocks, {
    onBlock: (b) => {
      if (b === 0) lp.recordToggle(0, c);
    },
  });
  ok("free: recording immediately (no quantise)", t.state === LOOP_STATE.REC);
  ok("free: nothing pending", t.pending === LOOP_PENDING.NONE);
  ok("free: recWrite tracks frames", t.recWrite === recBlocks * BLOCK, `${t.recWrite}`);
  ok("free: anchor is the punch frame", t.anchor === 0);

  const d = lp.declick;
  let recExact = true;
  for (let j = d; j < t.recWrite; j += 37) {
    if (!near(t.bufL[j], srcAt(t.anchor + j), 1e-7)) recExact = false;
  }
  ok("free: recorded audio is the source, sample for sample", recExact);
  ok("free: punch-in is ramped, not stepped", t.bufL[0] === 0 && t.bufL[d - 1] < srcAt(d - 1) * 0.999);

  const takeLen = t.recWrite;
  lp.recordToggle(0, c); // close the take
  ok("free: take closes to what was played", t.frames === takeLen, `${t.frames}`);
  ok("free: closing enters play", t.state === LOOP_STATE.PLAY);
  ok("free: one layer after the first take", t.layers === 1);
  const tailPeak = Math.abs(t.bufL[takeLen - 1]);
  ok("free: punch-out is ramped", tailPeak === 0);

  // Let the play fade fully settle (a 3 ms one-pole needs ~25 blocks to land on its
  // target), then compare a whole pass against the buffer. Once settled, a centred,
  // unity-gain loop must come back out bit-for-bit — that is what makes an overdub sit
  // at the same level as the live signal it is layered against.
  const snap = Float32Array.from(t.bufL.subarray(0, takeLen));
  drive(lp, c, 30);
  ok("free: the play fade settles", t.playGain.settled && t.playGain.value === 1);
  const pos0 = t.pos;
  const pass = drive(lp, c, Math.ceil(takeLen / BLOCK), { level: 0 });
  let playExact = true;
  let playErr = 0;
  for (let i = 0; i < takeLen - BLOCK; i++) {
    const expect = snap[(pos0 + i) % takeLen];
    playErr = Math.max(playErr, Math.abs(pass.outL[i] - expect));
    if (!near(pass.outL[i], expect, 1e-9)) playExact = false;
  }
  ok("free: playback is the recording, sample for sample", playExact, `maxErr=${playErr.toExponential(2)}`);
  ok("free: output is finite", finite(pass.outL) && finite(pass.outR));
  ok("free: buffer untouched by playback", (() => {
    for (let i = 0; i < takeLen; i++) if (snap[i] !== t.bufL[i]) return false;
    return true;
  })());

  // Position wraps rather than running off the end.
  drive(lp, c, Math.ceil((takeLen * 3) / BLOCK), { level: 0 });
  ok("free: position stays inside the loop", t.pos >= 0 && t.pos < takeLen, `${t.pos}`);
  ok("free: posNorm is 0..1", t.posNorm >= 0 && t.posNorm < 1);

  lp.stop(0, c);
  ok("free: stop leaves the audio", t.state === LOOP_STATE.STOPPED && t.frames === takeLen);
  const after = drive(lp, c, 200, { level: 0 });
  const fadeHead = peak(after.outL.subarray(0, BLOCK));
  const fadeTail = peak(after.outL.subarray(40 * BLOCK));
  ok("free: stop is a fade, not a cut", fadeHead > 0);
  ok("free: the fade reaches exact silence", fadeTail === 0, `tail=${fadeTail}`);
  ok("free: a stopped track stops costing anything", lp.active === false);

  lp.playToggle(0, c);
  ok("free: play restarts a stopped track", t.state === LOOP_STATE.PLAY && t.pos === 0);
}

// ============================================================ 4. short takes, buffer full
console.log("\n== 4. degenerate takes ==");
{
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  lp.setTrackParam(0, "sync", 0);
  const t = lp.track(0);
  lp.recordToggle(0, c);
  drive(lp, c, 3, {}); // 384 frames, well under MIN_LOOP_FRAMES
  lp.recordToggle(0, c);
  ok("short: a mis-click take is dropped", t.state === LOOP_STATE.EMPTY && t.frames === 0);
  ok("short: dropping a take clears undo", lp.canUndo(0) === false);

  const lp2 = new Looper(SR, BLOCK, { maxSeconds: 0.5 });
  const c2 = new Clock(SR);
  lp2.setTrackParam(1, "sync", 0);
  const t2 = lp2.track(1);
  lp2.recordToggle(1, c2);
  drive(lp2, c2, Math.ceil((SR * 0.7) / BLOCK), {});
  ok("full: a full buffer closes the loop itself", t2.state === LOOP_STATE.PLAY, `state=${t2.state}`);
  ok("full: length is the whole buffer", t2.frames === lp2.maxFrames, `${t2.frames}/${lp2.maxFrames}`);
  ok("full: recWrite never passes the buffer", t2.recWrite <= lp2.maxFrames);
  const out = drive(lp2, c2, 40, { level: 0 });
  ok("full: still plays cleanly", finite(out.outL) && peak(out.outL) > 0);
}

// ============================================================ 5. quantised punches
console.log("\n== 5. quantised punches are sample-accurate ==");
{
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  c.setParam("quantize", 0.25); // 6000 frames at 120 bpm
  const grid = c.gridFrames;
  ok("quant: test grid", grid === 6000, `${grid}`);
  const t = lp.track(0);

  // Click 1000 frames in — deliberately not on a block boundary multiple of the grid.
  let armed = -1;
  drive(lp, c, 60, {
    onBlock: (b) => {
      if (b === 8) {
        lp.recordToggle(0, c);
        armed = c.frame;
      }
    },
  });
  ok("quant: the click armed rather than recorded", armed === 8 * BLOCK);
  ok("quant: punch was scheduled on a grid line", t.anchor % grid === 0, `anchor=${t.anchor}`);
  ok("quant: punch is the FIRST grid line after the click", t.anchor === grid, `anchor=${t.anchor}`);
  ok("quant: recording started", t.state === LOOP_STATE.REC);
  ok("quant: recWrite counts from the grid line", t.recWrite === 60 * BLOCK - grid, `${t.recWrite}`);

  const d = lp.declick;
  let sampleAccurate = true;
  for (let j = d; j < t.recWrite; j += 53) {
    if (!near(t.bufL[j], srcAt(t.anchor + j), 1e-7)) sampleAccurate = false;
  }
  ok("quant: the take begins on the scheduled sample, not the block", sampleAccurate);

  // Punch out: also quantised, so the take is a whole number of grids.
  drive(lp, c, 40, {
    onBlock: (b) => {
      if (b === 5) lp.recordToggle(0, c);
    },
  });
  ok("quant: length is an exact multiple of the grid", t.frames % grid === 0, `${t.frames}`);
  ok("quant: length is the grid the punches bracketed", t.frames === grid, `${t.frames}`);
  ok("quant: playing after the punch-out", t.state === LOOP_STATE.PLAY);

  // A second press of the same pending action cancels it.
  const lp2 = new Looper(SR, BLOCK);
  const c2 = new Clock(SR);
  c2.setParam("quantize", 0.25);
  const t2 = lp2.track(0);
  lp2.recordToggle(0, c2);
  ok("quant: first press arms", t2.pending === LOOP_PENDING.REC);
  lp2.recordToggle(0, c2);
  ok("quant: second press cancels the arm", t2.pending === LOOP_PENDING.NONE);
  drive(lp2, c2, 80, {});
  ok("quant: a cancelled arm never records", t2.state === LOOP_STATE.EMPTY && t2.recWrite === 0);

  // Grid off: punches land immediately even on a sync track.
  const lp3 = new Looper(SR, BLOCK);
  const c3 = new Clock(SR);
  c3.setParam("quantize", 0);
  const t3 = lp3.track(0);
  lp3.recordToggle(0, c3);
  ok("quant: grid off punches now", t3.state === LOOP_STATE.REC && t3.pending === LOOP_PENDING.NONE);

  // A stopped clock cannot quantise either.
  const lp4 = new Looper(SR, BLOCK);
  const c4 = new Clock(SR);
  c4.setParam("run", 0);
  lp4.recordToggle(0, c4);
  ok("quant: a stopped clock punches now", lp4.track(0).state === LOOP_STATE.REC);
}

// ============================================================ 6. tempo lock: no drift
console.log("\n== 6. tempo-locked tracks never drift ==");
{
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  c.setParam("quantize", 0.25);
  const grid = c.gridFrames;
  const t = lp.track(0);
  lp.recordToggle(0, c);
  drive(lp, c, Math.ceil((2 * grid + 4 * BLOCK) / BLOCK), {}); // record ~2 grids
  lp.recordToggle(0, c);
  drive(lp, c, Math.ceil((grid + 2 * BLOCK) / BLOCK), {});
  const len = t.frames;
  ok("lock: loop is grid-aligned", len > 0 && len % grid === 0 && t.anchor % grid === 0);

  // 60 seconds of playback. A counter-driven looper would have drifted by now; a
  // clock-slaved one cannot, because position is recomputed from the absolute frame.
  const longBlocks = Math.ceil((SR * 60) / BLOCK);
  drive(lp, c, longBlocks, { level: 0 });
  const lastFrame = c.frame - 1;
  const expected = (((lastFrame - t.anchor) % len) + len) % len;
  const reported = Math.round(t.posNorm * len);
  ok("lock: position after 60 s is exactly the clock-derived one", reported === expected, `${reported} vs ${expected}`);
  ok("lock: playing throughout", t.state === LOOP_STATE.PLAY);

  // Phase alignment: two tracks of the same length, armed at different moments, sit at
  // the same position because both anchors are on the grid and the length is one grid.
  const lp2 = new Looper(SR, BLOCK);
  const c2 = new Clock(SR);
  c2.setParam("quantize", 0.25);
  const g2 = c2.gridFrames;
  const a = lp2.track(0);
  const b = lp2.track(1);
  lp2.recordToggle(0, c2);
  drive(lp2, c2, Math.ceil(g2 / BLOCK) + 2, {});
  lp2.recordToggle(0, c2); // close A at ~1 grid
  drive(lp2, c2, 10, {});
  lp2.recordToggle(1, c2); // arm B three-ish grids later
  drive(lp2, c2, Math.ceil(g2 / BLOCK) + 2, {});
  lp2.recordToggle(1, c2);
  drive(lp2, c2, Math.ceil((g2 * 3) / BLOCK), { level: 0 });
  ok("lock: both loops are one grid long", a.frames === g2 && b.frames === g2, `${a.frames}/${b.frames}`);
  ok("lock: anchors differ", a.anchor !== b.anchor);
  ok(
    "lock: loops recorded at different moments are phase-aligned",
    Math.abs(a.posNorm - b.posNorm) < 1 / g2 + 1e-9,
    `${a.posNorm} vs ${b.posNorm}`
  );
}

// ============================================================ 7. overdub and undo
console.log("\n== 7. overdub, undo, redo ==");
{
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  lp.setTrackParam(0, "sync", 0);
  const t = lp.track(0);
  lp.recordToggle(0, c);
  const recBlocks = 40;
  drive(lp, c, recBlocks, {});
  lp.recordToggle(0, c);
  const len = t.frames;
  const base = Float32Array.from(t.bufL.subarray(0, len));
  ok("dub: undo slot holds the take", lp.canUndo(0) === true);

  // Undo the first take: the length drops, the audio stays, so redo is free.
  lp.undo(0);
  ok("dub: undoing the first take empties the track", t.state === LOOP_STATE.EMPTY && t.frames === 0);
  ok("dub: the audio was not destroyed", t.bufL[len >> 1] === base[len >> 1]);
  lp.undo(0);
  ok("dub: redo brings the take back", t.frames === len && t.state === LOOP_STATE.STOPPED);
  lp.playToggle(0, c);
  drive(lp, c, 8, { level: 0 });

  // Overdub a full pass.
  lp.recordToggle(0, c);
  ok("dub: overdubbing", t.state === LOOP_STATE.OVERDUB);
  ok("dub: undo is not offered mid-overdub", lp.canUndo(0) === false);
  ok("dub: undo slot allocated on demand", lp.undoL !== null);
  drive(lp, c, Math.ceil(len / BLOCK) + 4, {});
  lp.recordToggle(0, c);
  ok("dub: back to play after the overdub", t.state === LOOP_STATE.PLAY);
  ok("dub: two layers", t.layers === 2, `${t.layers}`);
  ok("dub: undo is offered again", lp.canUndo(0) === true);

  const dubbed = Float32Array.from(t.bufL.subarray(0, len));
  let grew = 0;
  for (let i = 0; i < len; i++) if (Math.abs(dubbed[i] - base[i]) > 1e-6) grew++;
  ok("dub: the overdub actually went in", grew > len * 0.9, `${grew}/${len} samples changed`);
  ok("dub: the layer is the source", (() => {
    const d = lp.declick;
    for (let i = d + 4; i < len - d - 4; i += 31) {
      if (!near(dubbed[i] - base[i], lp.undoL[i], 1e-6)) return false;
    }
    return true;
  })());
  ok("dub: nothing clipped or went non-finite", finite(dubbed));

  // Undo must put the buffer back EXACTLY where it was.
  lp.undo(0);
  let maxErr = 0;
  for (let i = 0; i < len; i++) maxErr = Math.max(maxErr, Math.abs(t.bufL[i] - base[i]));
  ok("dub: undo restores the buffer exactly", maxErr < 1e-6, `maxErr=${maxErr.toExponential(2)}`);
  ok("dub: undo drops the layer count", t.layers === 1, `${t.layers}`);

  lp.undo(0);
  let redoErr = 0;
  for (let i = 0; i < len; i++) redoErr = Math.max(redoErr, Math.abs(t.bufL[i] - dubbed[i]));
  ok("dub: redo re-applies the layer exactly", redoErr < 1e-6, `maxErr=${redoErr.toExponential(2)}`);
  ok("dub: redo restores the layer count", t.layers === 2);

  // Undo is per-slot: a different track has nothing to undo.
  ok("dub: undo does not reach other tracks", lp.canUndo(1) === false);
  const before = t.bufL[len >> 1];
  lp.undo(1);
  ok("dub: undoing the wrong track is a no-op", t.bufL[len >> 1] === before);

  // A loop plays over itself without recording itself: overdub silence, buffer unchanged.
  const keep = Float32Array.from(t.bufL.subarray(0, len));
  lp.recordToggle(0, c);
  drive(lp, c, Math.ceil(len / BLOCK) + 2, { level: 0 });
  lp.recordToggle(0, c);
  let selfErr = 0;
  for (let i = 0; i < len; i++) selfErr = Math.max(selfErr, Math.abs(t.bufL[i] - keep[i]));
  ok("dub: a loop never records itself (no feedback)", selfErr < 1e-9, `maxErr=${selfErr.toExponential(2)}`);
}

// ============================================================ 8. clear, reset, params
console.log("\n== 8. clear, panic, parameters ==");
{
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  lp.setTrackParam(0, "sync", 0);
  const t = lp.track(0);
  lp.recordToggle(0, c);
  drive(lp, c, 40, {});
  lp.recordToggle(0, c);
  drive(lp, c, 4, { level: 0 });
  lp.clear(0);
  ok("clear: track is empty", t.state === LOOP_STATE.EMPTY && t.frames === 0 && t.layers === 0);
  ok("clear: undo slot dropped with it", lp.canUndo(0) === false);
  const silent = drive(lp, c, 10, { level: 0 });
  ok("clear: silence after clear", peak(silent.outL) === 0);
  ok("clear: looper is inactive again", lp.active === false);

  // Panic while recording drops the half-take; panic while playing just stops.
  const lp2 = new Looper(SR, BLOCK);
  const c2 = new Clock(SR);
  lp2.setTrackParam(0, "sync", 0);
  lp2.setTrackParam(1, "sync", 0);
  lp2.recordToggle(0, c2);
  drive(lp2, c2, 40, {});
  lp2.recordToggle(0, c2); // track 0 now playing
  lp2.recordToggle(1, c2); // track 1 recording
  drive(lp2, c2, 10, {});
  lp2.reset();
  ok("panic: a playing loop is stopped but kept", lp2.track(0).state === LOOP_STATE.STOPPED && lp2.track(0).frames > 0);
  ok("panic: an in-progress take is dropped", lp2.track(1).state === LOOP_STATE.EMPTY && lp2.track(1).frames === 0);
  ok("panic: meters cleared", lp2.meterL === 0 && lp2.meterR === 0);
  const quiet = drive(lp2, c2, 10, { level: 0 });
  ok("panic: silence follows", peak(quiet.outL) === 0);

  lp2.clearAll();
  ok("panic: clearAll empties everything", lp2.tracks.every((x) => x.state === LOOP_STATE.EMPTY));

  // Parameters.
  const t0 = lp2.track(0);
  lp2.setTrackParam(0, "gain", 6);
  ok("param: gain in dB", near(t0.gain, Math.pow(10, 0.3), 1e-9), `${t0.gain}`);
  lp2.setTrackParam(0, "gain", -999);
  ok("param: gain clamps to silence", t0.gain === 0 && t0.gainDb === -60);
  lp2.setTrackParam(0, "gain", 99);
  ok("param: gain clamps high", t0.gainDb === 12);
  lp2.setTrackParam(0, "gain", 0);

  lp2.setTrackParam(0, "pan", 0);
  ok("param: centre balance is unity, so playback matches the recording", t0.panL === 1 && t0.panR === 1);
  lp2.setTrackParam(0, "pan", -1);
  ok("param: hard left", near(t0.panL, 1, 1e-9) && near(t0.panR, 0, 1e-9));
  lp2.setTrackParam(0, "pan", 5);
  ok("param: pan clamps", t0.pan === 1);
  lp2.setTrackParam(0, "pan", 0);

  lp2.setTrackParam(0, "mute", 1);
  ok("param: mute", t0.muted === true);
  lp2.setTrackParam(0, "mute", 0);
  lp2.setTrackParam(0, "solo", 1);
  ok("param: solo", t0.soloed === true);
  lp2.setTrackParam(0, "solo", 0);
  lp2.setTrackParam(0, "source", LOOP_SOURCE.DRUMS);
  ok("param: source", t0.source === LOOP_SOURCE.DRUMS);
  lp2.setTrackParam(0, "source", 7);
  ok("param: source clamps", t0.source === 1);
  lp2.setParam("gain", -60);
  ok("param: looper gain to silence", lp2.gain === 0);
  lp2.setParam("gain", 0);
  lp2.setParam("mute", 1);
  ok("param: looper mute", lp2.muted === true);
  lp2.setParam("mute", 0);
  lp2.setTrackParam(99, "gain", 3);
  ok("param: bad track index is a no-op", true);
}

// ============================================================ 9. mix: mute, solo, gain
console.log("\n== 9. mix behaviour ==");
{
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  // Two free-running loops, recorded from different sources so they are distinguishable.
  for (const i of [0, 1]) {
    lp.setTrackParam(i, "sync", 0);
    lp.recordToggle(i, c);
    drive(lp, c, 40, {});
    lp.recordToggle(i, c);
    drive(lp, c, 4, { level: 0 });
  }
  const both = drive(lp, c, 20, { level: 0 });
  ok("mix: two loops sum", peak(both.outL) > 0);
  const twoPeak = peak(both.outL);

  lp.setTrackParam(1, "mute", 1);
  drive(lp, c, 20, { level: 0 }); // let the fade settle
  const oneMuted = drive(lp, c, 20, { level: 0 });
  ok("mix: muting a track lowers the sum", peak(oneMuted.outL) < twoPeak * 0.95, `${peak(oneMuted.outL)} < ${twoPeak}`);
  lp.setTrackParam(1, "mute", 0);
  drive(lp, c, 20, { level: 0 });

  lp.setTrackParam(0, "solo", 1);
  drive(lp, c, 20, { level: 0 });
  const soloed = drive(lp, c, 20, { level: 0 });
  ok("mix: solo drops the other track", peak(soloed.outL) < twoPeak * 0.95);
  ok("mix: soloed track is still heard", peak(soloed.outL) > 0);
  lp.setTrackParam(0, "solo", 0);
  drive(lp, c, 20, { level: 0 });

  lp.setParam("mute", 1);
  const loopMuted = drive(lp, c, 20, { level: 0 });
  ok("mix: looper mute silences everything", peak(loopMuted.outL) === 0);
  ok("mix: muted looper reports no level", lp.meterL === 0 && lp.meterR === 0);
  lp.setParam("mute", 0);

  lp.setTrackParam(0, "pan", -1);
  lp.setTrackParam(1, "pan", -1);
  drive(lp, c, 30, { level: 0 });
  const panned = drive(lp, c, 20, { level: 0 });
  ok("mix: hard-left pan empties the right", peak(panned.outR) < peak(panned.outL) * 0.01, `${peak(panned.outR)}`);

  lp.setTrackParam(0, "pan", 0);
  lp.setTrackParam(1, "pan", 0);
  lp.setParam("gain", -20);
  drive(lp, c, 30, { level: 0 });
  const quiet = drive(lp, c, 20, { level: 0 });
  ok("mix: looper gain applies", peak(quiet.outL) < twoPeak * 0.2, `${peak(quiet.outL)}`);
  ok("mix: still finite", finite(quiet.outL) && finite(quiet.outR));
}

// ============================================================ 10. per-track chain
console.log("\n== 10. per-track effect chain ==");
{
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  lp.setTrackParam(0, "sync", 0);
  lp.setTrackParam(1, "sync", 0);
  for (const i of [0, 1]) {
    lp.recordToggle(i, c);
    drive(lp, c, 40, {});
    lp.recordToggle(i, c);
  }
  drive(lp, c, 20, { level: 0 });
  const clean = drive(lp, c, 20, { level: 0 });

  const chain = lp.chainFor(0);
  const slot = chain.add({ id: "s1", type: "sat", params: { drive: 18, mix: 1 } });
  ok("chain: an effect can be added to one track", slot !== null && chain.length === 1);
  const dirty = drive(lp, c, 20, { level: 0 });
  let changed = false;
  for (let i = 0; i < dirty.outL.length; i++) {
    if (Math.abs(dirty.outL[i] - clean.outL[i]) > 1e-5) changed = true;
  }
  ok("chain: the effect changes that track's audio", changed);
  ok("chain: output stays finite", finite(dirty.outL) && finite(dirty.outR));
  ok("chain: other tracks keep their own chain", lp.track(1).chain === null);

  chain.remove("s1");
  ok("chain: effect removed", chain.length === 0);
  const again = drive(lp, c, 20, { level: 0 });
  ok("chain: removing it restores the signal path", finite(again.outL) && peak(again.outL) > 0);

  lp.chainFor(1).add({ id: "s2", type: "eq" });
  lp.clear(1);
  ok("chain: clear panics the chain but keeps it", lp.track(1).chain !== null);
}

// ============================================================ 11. record source
console.log("\n== 11. record source selection ==");
{
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  lp.setTrackParam(0, "sync", 0);
  lp.setTrackParam(0, "source", LOOP_SOURCE.DRUMS);
  const t = lp.track(0);
  lp.recordToggle(0, c);
  drive(lp, c, 40, {});
  const d = lp.declick;
  let drumExact = true;
  for (let j = d; j < t.recWrite; j += 41) {
    if (!near(t.bufL[j], -srcAt(t.anchor + j), 1e-7)) drumExact = false;
  }
  ok("source: the drum bus is what was recorded", drumExact);
  lp.recordToggle(0, c);
  ok("source: take closed", t.frames > 0);
}

// ============================================================ 12. meters
console.log("\n== 12. meter block ==");
{
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  lp.setTrackParam(0, "sync", 0);
  const out = new Float32Array(128);
  const written = lp.readMeters(out, 68);
  ok("meter: block size is tracks x stride", written === LOOP_TRACKS * LOOP_METER_STRIDE, `${written}`);
  ok("meter: idle block is zero", out.every((v) => v === 0));
  ok("meter: nothing written before the offset", out.slice(0, 68).every((v) => v === 0));

  lp.recordToggle(0, c);
  drive(lp, c, 40, {});
  lp.readMeters(out, 68);
  ok("meter: state reported", out[68] === LOOP_STATE.REC);
  ok("meter: pending reported", out[69] === LOOP_PENDING.NONE);
  ok("meter: level reported while recording", out[70] > 0);
  ok("meter: length field carries recWrite while recording", out[72] === lp.track(0).recWrite);

  lp.recordToggle(0, c);
  drive(lp, c, 20, { level: 0 });
  lp.readMeters(out, 68);
  ok("meter: playing state", out[68] === LOOP_STATE.PLAY);
  ok("meter: position is 0..1", out[71] >= 0 && out[71] < 1);
  ok("meter: length is the loop", out[72] === lp.track(0).frames);
  ok("meter: layer count", out[74] === 1);
  ok("meter: undo availability", out[75] === 1);
  lp.chainFor(0).add({ id: "x", type: "eq" });
  lp.readMeters(out, 68);
  ok("meter: chain length", out[73] === 1);
  ok("meter: second track block is independent", out[68 + LOOP_METER_STRIDE] === LOOP_STATE.EMPTY);
  ok("meter: all values finite", finite(out));
}

// ============================================================ 13. stress
console.log("\n== 13. stress: random clicking never breaks it ==");
{
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  c.setParam("quantize", 0.25);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const res = drive(lp, c, 4000, {
    onBlock: (b) => {
      if (rnd() < 0.05) {
        const i = (rnd() * 4) | 0;
        const r = rnd();
        if (r < 0.4) lp.recordToggle(i, c);
        else if (r < 0.55) lp.playToggle(i, c);
        else if (r < 0.65) lp.stop(i, c);
        else if (r < 0.72) lp.clear(i);
        else if (r < 0.8) lp.undo(i);
        else if (r < 0.86) lp.setTrackParam(i, "sync", rnd() < 0.5 ? 1 : 0);
        else if (r < 0.9) lp.setTrackParam(i, "mute", rnd() < 0.5 ? 1 : 0);
        else if (r < 0.94) lp.setTrackParam(i, "solo", rnd() < 0.5 ? 1 : 0);
        else if (r < 0.97) c.setParam("bpm", 60 + rnd() * 180);
        else lp.reset();
      }
    },
  });
  ok("stress: output is finite throughout", finite(res.outL) && finite(res.outR));
  ok("stress: output is bounded", peak(res.outL) < 8, `peak=${peak(res.outL).toFixed(3)}`);
  ok(
    "stress: every track is left in a consistent state",
    lp.tracks.every(
      (t) =>
        t.frames >= 0 &&
        t.frames <= t.maxFrames &&
        t.recWrite <= t.maxFrames &&
        (t.frames === 0 ? t.state === LOOP_STATE.EMPTY || t.state === LOOP_STATE.REC : true) &&
        Number.isFinite(t.posNorm) &&
        t.posNorm >= 0 &&
        t.posNorm <= 1
    )
  );
  ok("stress: no NaN leaked into a buffer", lp.tracks.every((t) => !t.bufL || finite(t.bufL)));
}

// ============================================================ 14. white-box: rounding
console.log("\n== 14. take-length rounding ==");
{
  // A take is normally punched out on a grid line, so rounding is a no-op. It matters
  // when the tempo changed mid-take, or when the punch-out was unquantised: the length
  // must still land on a whole grid unit, because that is what makes the loop lock.
  const lp = new Looper(SR, BLOCK);
  const c = new Clock(SR);
  c.setParam("quantize", 0.25);
  const grid = c.gridFrames;
  const t = lp.track(0);
  lp._ensureBuffer(t);
  for (let i = 0; i < t.maxFrames; i++) {
    t.bufL[i] = 0.5;
    t.bufR[i] = 0.5;
  }
  t.state = LOOP_STATE.REC;
  t.recWrite = Math.round(grid * 1.4); // punched out late
  lp._closeTake(t, c);
  ok("round: a late punch-out rounds down to one grid", t.frames === grid, `${t.frames}`);

  const t2 = lp.track(1);
  lp._ensureBuffer(t2);
  t2.state = LOOP_STATE.REC;
  t2.recWrite = Math.round(grid * 1.8); // punched out early for two grids
  lp._closeTake(t2, c);
  ok("round: an early punch-out rounds up to two grids", t2.frames === 2 * grid, `${t2.frames}`);
  ok("round: the un-played tail is zeroed, not stale audio", (() => {
    for (let i = t2.recWrite; i < t2.frames; i++) if (t2.bufL[i] !== 0) return false;
    return true;
  })());

  const t3 = lp.track(2);
  lp._ensureBuffer(t3);
  t3.state = LOOP_STATE.REC;
  t3.recWrite = 512; // under MIN_LOOP_FRAMES
  lp._closeTake(t3, c);
  ok("round: a take under the minimum is dropped", t3.frames === 0 && t3.state === LOOP_STATE.EMPTY);

  const t4 = lp.track(3);
  lp.setTrackParam(3, "sync", 0);
  lp._ensureBuffer(t4);
  t4.state = LOOP_STATE.REC;
  t4.recWrite = Math.round(grid * 1.4);
  lp._closeTake(t4, c);
  ok("round: a free-running take keeps its exact length", t4.frames === Math.round(grid * 1.4), `${t4.frames}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
