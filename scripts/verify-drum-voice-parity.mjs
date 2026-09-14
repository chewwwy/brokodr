/**
 * Parity oracle for the C port of dsp/core/drum-voice.js (Phase 5, route (c)).
 *
 * Same four steps as every module before it, on the shared plumbing in
 * scripts/lib/parity-stream.mjs:
 *
 *   1. build the C natively and run the battery;
 *   2. build the same source to wasm with emscripten and run it under Node;
 *   3. replay the identical battery through the original drum-voice.js;
 *   4. diff native against wasm.
 *
 * The battery lives in packages/native/tests/parity-drum-voice.c and only
 * there. Each record carries its whole command script in its params, and this
 * file interprets that script rather than keeping a copy of it. Read that
 * file's header first: it explains why the stimulus is a *sample* here, why
 * the destination block is prefilled, and why libm is unavoidably in the path.
 *
 * Three things this file has to mirror by hand, because the C documents them
 * in comments and there is no shared source of truth to import:
 *
 *   - the opcode, buffer-kind and prefill-kind tables (OP / BUF / PRE below);
 *   - build_buf()'s two hand-made buffers, the dirty one and the sub-floor
 *     one, down to which index carries the NaN;
 *   - push_state() and push_snap()'s field order, which is the payload
 *     contract. A field inserted on one side and not the other shows up as a
 *     parity failure on every record, which is the intended failure mode.
 *
 * On param keys: DrumVoice.setParam takes a string ("attack"), because the
 * worklet hands it one; bk_drum_voice_set_param takes the wire index the
 * command ring carries. The script's key column is that index and PAD_KEY
 * turns it back into the name, so a reordering on either side reads as a
 * parity failure rather than as a silently wrong knob. PAD_KEY itself is
 * checked against both of its real sources — the generated param-keys.h and
 * backend.ts — in the sanity section, so this file's copy cannot drift either.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAndRun,
  compareToJs,
  compareToolchains,
  createChecker,
  fillSignal,
  maxAbs,
} from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

/*
 * Bit-identity baselines, pinned rather than printed.
 *
 * Unlike chain.c, this module cannot keep libm out of its path: the pan law is
 * cos/sin, the two envelope coefficients are exp, and the pitch ratio is pow.
 * All three are control-rate, but they scale every sample that follows, so a
 * last-bit difference between V8's and glibc's exp lands in the audio and a
 * record stops being bit-identical without being wrong.
 *
 * The counts below are therefore *measured*, not aspirational, and they are
 * asserted so that a silent drop is a failure. Unlike every module ported
 * before this one, they are not 100%, and the four records that miss have all
 * been chased down to a one-ulp libm disagreement rather than to the port:
 *
 *   - `release-oneshot` (decay 5 ms) drifts from the JS on both toolchains.
 *     decayCoef is exp(-5/240): glibc and emscripten both return
 *     0x3fef57194ce34a49, V8's Math.exp returns ...4a, and the envelope and
 *     the meter carry that last bit into the audio. The two C builds agree
 *     with each other, which is the part that matters for shipping.
 *   - `block-1x256`, `block-2x128`, `block-8x32` (pan 0.4) are the opposite
 *     way round: panL is cos(1.0995574287564276), where glibc returns
 *     0x3fdd0e2e2b44de01 and emscripten's musl and V8 both return ...02. So
 *     these three drift native-vs-wasm and native-vs-JS, and are identical
 *     wasm-vs-JS.
 *
 * Both were confirmed by evaluating the bare libm call under cc, emcc and
 * node, not inferred. This is standing caveat (2) of the plan made concrete:
 * bit-identity is an empirical per-module measurement, and libm is allowed to
 * differ in the last place.
 *
 * See the note in assertIdentity (parity-stream.mjs) before re-baselining.
 */
const IDENTITY_NATIVE = 39; // 43 cases, less release-oneshot (exp) and the three pan-0.4 ones (cos)
const IDENTITY_WASM = 42; // less release-oneshot (exp) only
const IDENTITY_CROSS = 40; // less the three pan-0.4 cases (cos)

const { native, wasm } = buildAndRun({
  root,
  name: "parity-drum-voice",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/drum-voice.c"),
    join(root, "packages/native/tests/parity-drum-voice.c"),
  ],
  ok,
  state,
});

console.log(`\n   ${native.length} scripts in the battery`);

// ---------------------------------------------------------------------------
// the JS under test
// ---------------------------------------------------------------------------

// No probe copy is needed here (unlike chain.js and delay-line.js): the voice's
// only import is utils.js, which is itself ported and verified, so the shipping
// source runs as-is.
const js = await import("../packages/web/public/dsp/core/drum-voice.js");
ok("drum-voice.js exports DrumVoice and MAX_LAYERS", typeof js.DrumVoice === "function" && js.MAX_LAYERS === 4);

const SR = 48000;
const MAX_BLOCK = 256;
const MAX_LAYERS = 4;
const SNAP_FIELDS = 30 + MAX_LAYERS * 3; // must match push_snap() in parity-drum-voice.c
const ENV = { IDLE: 0, ATTACK: 1, DECAY: 2, SUSTAIN: 3, RELEASE: 4 };

/** Canonical wire index -> the string key DrumVoice.setParam expects. */
const PAD_KEY = [
  "attack", "decay", "sustain", "release", "hold",
  "pitch", "start", "reverse", "gain", "pan",
  "mode", "velAmount", "choke", "mute",
];

/** Mirrors the opcode enum in parity-drum-voice.c. */
const OP = {
  END: 0,
  SETBUF: 1,
  CLEARBUFS: 2,
  PARAM: 3,
  TRIGGER: 4,
  RELEASE: 5,
  CHOKE: 6,
  RESET: 7,
  PROCESS: 8,
  SNAP: 9,
  // Re-init at a different sample rate, which on this side means a fresh
  // DrumVoice: every rate-derived coefficient is computed at construction or
  // on a param change, so 48 kHz alone leaves all of them measured at one
  // value. Only ever the first op of a script.
  INIT: 10,
};

/** Mirrors the buffer-kind enum. 0..4 are bk_fill_signal's signals. */
const BUF = { IMPULSE: 0, STEP: 1, NOISE: 2, RAMP: 3, ZERO: 4, DIRTY: 5, TINY: 6 };

/** Mirrors the prefill-kind enum for the destination block. */
const PRE = { SILENT: 0, CONST: 1, NOISE: 2 };

// ---------------------------------------------------------------------------
// the stimulus, mirroring build_buf() and prefill() in the C
// ---------------------------------------------------------------------------

/**
 * A layer buffer. The two hand-made kinds exist because the LCG cannot produce
 * them and the voice has two guards — `data[idx] || 0` in the linear branch
 * and sanitize() on the output — that well-behaved noise never reaches.
 */
function buildBuf(n, kind) {
  const dst = new Float32Array(n);
  if (kind === BUF.DIRTY) {
    const s = fillSignal(n, BUF.NOISE);
    for (let i = 0; i < n; i++) dst[i] = s[i];
    // Fixed indices so both sides plant them in the same place. 1e40 does not
    // fit a float32 and lands as +Infinity in a Float32Array exactly as it
    // does in a (float) cast, which is the point — the voice has to survive it.
    if (n > 3) dst[3] = NaN;
    if (n > 5) dst[5] = 1e40;
    if (n > 7) dst[7] = -0;
    if (n > 9) dst[9] = 0;
    return dst;
  }
  if (kind === BUF.TINY) {
    for (let i = 0; i < n; i++) dst[i] = (i % 2 ? 1e-20 : -1e-20) * (i + 1);
    return dst;
  }
  const s = fillSignal(n, kind);
  for (let i = 0; i < n; i++) dst[i] = s[i];
  return dst;
}

// The destination block. Persistent, like the C's statics, and prefilled before
// every PROCESS — process() sums into it, so a port that assigned instead of
// added has to be visible.
const blkL = new Float32Array(MAX_BLOCK);
const blkR = new Float32Array(MAX_BLOCK);

function prefill(frames, kind) {
  if (kind === PRE.NOISE) {
    const s = fillSignal(frames, BUF.NOISE);
    for (let i = 0; i < frames; i++) {
      blkL[i] = s[i];
      blkR[i] = -s[i];
    }
    return;
  }
  for (let i = 0; i < frames; i++) {
    blkL[i] = kind === PRE.CONST ? 0.25 : 0;
    blkR[i] = kind === PRE.CONST ? -0.5 : 0;
  }
}

// ---------------------------------------------------------------------------
// the payload, mirroring push_state() and push_snap()
// ---------------------------------------------------------------------------

/** After every op: "did this op do anything", as four numbers. */
function pushState(out, v) {
  out.push(v.active ? 1 : 0);
  out.push(v.stage);
  out.push(v.env);
  out.push(v.pos);
}

/** Everything else observable, for OP_SNAP. Order is the contract. */
function pushSnap(out, v) {
  out.push(v.layer);
  out.push(v.nextLayer);
  out.push(v.layerCount);
  out.push(v.step);
  out.push(v.velGain);
  out.push(v.meter);
  out.push(v.choking ? 1 : 0);
  out.push(v.holdLeft);
  out.push(v.panL.value);
  out.push(v.panR.value);
  out.push(v.panL.target);
  out.push(v.panR.target);
  out.push(v.attackInc);
  out.push(v.decayCoef);
  out.push(v.releaseCoef);
  out.push(v.chokeInc);
  out.push(v.attackMs);
  out.push(v.decayMs);
  out.push(v.sustain);
  out.push(v.releaseMs);
  out.push(v.holdMs);
  out.push(v.pitch);
  out.push(v.startOffset);
  out.push(v.reverse ? 1 : 0);
  out.push(v.gain);
  out.push(v.pan);
  out.push(v.mode);
  out.push(v.velAmount);
  out.push(v.chokeGroup);
  out.push(v.muted ? 1 : 0);
  for (let i = 0; i < MAX_LAYERS; i++) {
    out.push(v.layers[i].data ? 1 : 0);
    out.push(v.layers[i].frames);
    out.push(v.layers[i].rate);
  }
}

/** The same fields, read back out of a dump — the C's or this file's. */
const SNAP_NAMES = [
  "layer", "nextLayer", "layerCount", "step", "velGain", "meter", "choking", "holdLeft",
  "panLValue", "panRValue", "panLTarget", "panRTarget",
  "attackInc", "decayCoef", "releaseCoef", "chokeInc",
  "attackMs", "decayMs", "sustain", "releaseMs", "holdMs", "pitch", "startOffset", "reverse",
  "gain", "pan", "mode", "velAmount", "chokeGroup", "muted",
];

function decodeSnap(buf, at) {
  const snap = {};
  SNAP_NAMES.forEach((k, i) => {
    snap[k] = buf[at + i];
  });
  snap.layers = [];
  for (let i = 0; i < MAX_LAYERS; i++) {
    const o = at + SNAP_NAMES.length + i * 3;
    snap.layers.push({ present: buf[o], frames: buf[o + 1], rate: buf[o + 2] });
  }
  return snap;
}

// ---------------------------------------------------------------------------
// the script VM, mirroring run_script()
// ---------------------------------------------------------------------------

/**
 * Replay one script through the real DrumVoice. Returns the two payloads plus
 * the offsets at which each op's state block, each snapshot and each rendered
 * block landed, so the checks below can read the *native* dump at the same
 * places instead of trusting this replay.
 */
function runScript(rec) {
  const ops = rec.params;
  const nOps = ops.length / 5;
  let v = new js.DrumVoice(SR, MAX_BLOCK);
  const out64 = [];
  const out32 = [];
  const stateAt = [];
  const snapAt = [];
  const procs = [];

  for (let i = 0; i < nOps; i++) {
    const op = ops[i * 5] | 0;
    const a = ops[i * 5 + 1];
    const b = ops[i * 5 + 2];
    const c = ops[i * 5 + 3];
    const d = ops[i * 5 + 4];

    switch (op) {
      case OP.SETBUF: {
        const li = a | 0;
        const kind = b | 0;
        const frames = c | 0;
        // kind < 0 is the null handoff: the layer is emptied. The count and
        // the rate go through as scripted rather than as zeros, so a script
        // can hand over null *with* a nonzero count — the only stimulus under
        // which `frames = data ? frames : 0` is observable.
        if (kind < 0) v.setBuffer(li, null, frames, d);
        else v.setBuffer(li, buildBuf(frames, kind), frames, d);
        break;
      }
      case OP.CLEARBUFS:
        v.clearBuffers();
        break;
      case OP.PARAM:
        // An unknown wire key must fall through untranslated, exactly as the C
        // falls through its switch — hence the `?? ""` rather than a throw.
        v.setParam(PAD_KEY[a | 0] ?? "", b);
        break;
      case OP.TRIGGER:
        v.trigger(a);
        break;
      case OP.RELEASE:
        v.release();
        break;
      case OP.CHOKE:
        v.choke();
        break;
      case OP.RESET:
        v.reset();
        break;
      case OP.PROCESS: {
        const frames = a | 0;
        prefill(frames, b | 0);
        v.process(blkL, blkR, frames);
        const atL = out32.length;
        for (let k = 0; k < frames; k++) out32.push(blkL[k]);
        const atR = out32.length;
        for (let k = 0; k < frames; k++) out32.push(blkR[k]);
        procs.push({ frames, atL, atR, meterAt: out64.length });
        out64.push(v.meter);
        break;
      }
      case OP.SNAP:
        snapAt.push(out64.length);
        pushSnap(out64, v);
        break;
      case OP.INIT:
        v = new js.DrumVoice(a, MAX_BLOCK);
        break;
      default:
        break;
    }
    stateAt.push(out64.length);
    pushState(out64, v);
  }

  return {
    out64: Float64Array.from(out64),
    out32: Float32Array.from(out32),
    stateAt,
    snapAt,
    procs,
  };
}

// ---------------------------------------------------------------------------
// the diff
// ---------------------------------------------------------------------------

const replayed = new Map();
function reference(rec) {
  if (!replayed.has(rec.name)) replayed.set(rec.name, runScript(rec));
  return replayed.get(rec.name);
}

compareToJs({ name: "native", dump: native, reference, ok, expectIdentical: IDENTITY_NATIVE });
if (wasm) {
  compareToJs({ name: "wasm", dump: wasm, reference, ok, expectIdentical: IDENTITY_WASM });
  compareToolchains({ native, wasm, ok, expectIdentical: IDENTITY_CROSS });
}

// ---------------------------------------------------------------------------
// sanity: the battery has to actually exercise the voice
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises the voice ==");

const byName = new Map(native.map((r) => [r.name, r]));
const want = [
  "default", "attack-zero", "attack-long", "sustain-gate", "sustain-zero",
  "release-oneshot", "release-idle", "hold", "hold-rounds-to-zero", "hold-half",
  "reverse", "start-clamp", "pitch-up", "pitch-down", "rate-mismatch",
  "tiny-buffers", "round-robin", "layer-hole", "setbuf-null", "zero-frames",
  "clear-midnote", "sample-yanked", "choke", "choke-idle-retrigger",
  "retrigger-middecay", "velocity", "pan", "mute-and-gain", "reset",
  "dirty-sample", "zero-frame-block", "param-clamps",
  "block-1x256", "block-2x128", "block-8x32", "soak",
  "dirty-edge", "attack-tiny", "layer-clamp", "release-after-yank",
  "sample-truncated", "choke-exact-zero", "sustain-dropped",
];
const missing = want.filter((n) => !byName.has(n));
ok("every expected case is in the dump", missing.length === 0, missing.length ? `missing: ${missing}` : `${native.length} cases`);

/** Layout of one record, taken from the JS replay and read off the C's dump. */
const layout = (name) => reference(byName.get(name));
const snapOf = (name, i) => decodeSnap(byName.get(name).out64, layout(name).snapAt[i]);
const stateOf = (name, i) => {
  const at = layout(name).stateAt[i];
  const b = byName.get(name).out64;
  return { active: b[at], stage: b[at + 1], env: b[at + 2], pos: b[at + 3] };
};
const blockOf = (name, i) => {
  const p = layout(name).procs[i];
  const rec = byName.get(name);
  return {
    frames: p.frames,
    L: rec.out32.subarray(p.atL, p.atL + p.frames),
    R: rec.out32.subarray(p.atR, p.atR + p.frames),
    meter: rec.out64[p.meterAt],
  };
};
/** Every rendered frame of a record, L's then R's, in script order. */
function audioOf(name) {
  const l = [];
  const r = [];
  for (let i = 0; i < layout(name).procs.length; i++) {
    const blk = blockOf(name, i);
    for (let k = 0; k < blk.frames; k++) l.push(blk.L[k]);
    for (let k = 0; k < blk.frames; k++) r.push(blk.R[k]);
  }
  return Float64Array.from([...l, ...r]);
}
const peak = (a) => {
  let m = 0;
  for (const x of a) if (Math.abs(x) > m) m = Math.abs(x);
  return m;
};

// -- the battery covers the opcodes, the params and enough audio -------------
{
  const seen = new Set();
  const keysUsed = new Set();
  let frames = 0;
  for (const rec of native) {
    const nOps = rec.params.length / 5;
    for (let o = 0; o < nOps; o++) {
      const op = rec.params[o * 5];
      seen.add(op);
      if (op === OP.PROCESS) frames += rec.params[o * 5 + 1];
      if (op === OP.PARAM) keysUsed.add(rec.params[o * 5 + 1]);
    }
  }
  // END is the format's terminator, never scripted; everything else must run.
  const unused = Object.entries(OP)
    .filter(([k, v]) => k !== "END" && !seen.has(v))
    .map(([k]) => k);
  ok("every opcode is exercised", unused.length === 0, unused.length ? `unused: ${unused}` : `${seen.size} opcodes`);
  const unusedKeys = PAD_KEY.filter((_, i) => !keysUsed.has(i));
  ok("every pad param is exercised", unusedKeys.length === 0, unusedKeys.length ? `unused: ${unusedKeys}` : `${PAD_KEY.length} keys`);
  ok("an unknown wire key is exercised too", keysUsed.has(99));
  ok("the battery renders a meaningful amount of audio", frames > 2000, `${frames} frames`);
}

// -- this file's key table is not allowed to drift from its two sources ------
{
  const hdr = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
  const fromHeader = [...hdr.matchAll(/BK_PAD_P_([A-Z_]+) = (\d+)/g)]
    .filter((m) => m[1] !== "COUNT")
    .sort((x, y) => Number(x[2]) - Number(y[2]))
    .map((m) => m[1].toLowerCase().replace(/_/g, ""));
  const normalised = PAD_KEY.map((k) => k.toLowerCase());
  ok(
    "PAD_KEY matches the generated param-keys.h",
    fromHeader.length === normalised.length && fromHeader.every((k, i) => k === normalised[i]),
    `${fromHeader.join(",")} vs ${normalised.join(",")}`,
  );

  const ts = readFileSync(join(root, "packages/web/src/web/audio/backend.ts"), "utf8");
  const block = ts.match(/export const PAD_KEY = \[([\s\S]*?)\]/);
  const fromTs = block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  ok(
    "PAD_KEY matches backend.ts, the source of truth",
    fromTs.length === PAD_KEY.length && fromTs.every((k, i) => k === PAD_KEY[i]),
    `${fromTs.join(",")}`,
  );
}

// -- the default hit actually makes sound, and sums into what is there -------
{
  const first = blockOf("default", 0);
  ok("the default hit renders audio", peak(first.L) > 0.05 && first.meter > 0.05, `peak ${peak(first.L).toFixed(3)}, meter ${first.meter.toFixed(3)}`);
  // 512-frame sample, 5x128 frames of script: the fourth block is where pos
  // walks off the end, so it still sounds and the fifth is silent. A port that
  // broke on the boundary one frame early or late fails one of these two.
  ok(
    "the sample runs out under it and the voice frees itself",
    blockOf("default", 3).meter > 0 && blockOf("default", 4).meter === 0 && stateOf("default", 8).active === 0,
    `block3 ${blockOf("default", 3).meter.toExponential(2)}, block4 ${blockOf("default", 4).meter.toExponential(2)}`,
  );
  const end = snapOf("default", 2);
  ok("and its meter is clear afterwards", end.meter === 0 && end.layers[0].frames === 512, `meter ${end.meter.toExponential(2)}`);
  // PROCESS 1 is prefilled with the constant, so its mean must sit off zero by
  // roughly the prefill. A port that assigned rather than added loses this.
  const mean = (a) => [...a].reduce((s, x) => s + x, 0) / a.length;
  ok("process() is additive", Math.abs(mean(blockOf("default", 1).L) - mean(blockOf("default", 0).L)) > 0.2, `${mean(blockOf("default", 1).L).toFixed(3)} vs ${mean(blockOf("default", 0).L).toFixed(3)}`);
}

// -- block-size independence, checked on the C's own numbers ----------------
{
  const a = audioOf("block-1x256");
  const b = audioOf("block-2x128");
  const c = audioOf("block-8x32");
  ok("256 frames in one call and in two are the same audio", maxAbs(a, b).m === 0, `worst ${maxAbs(a, b).m.toExponential(2)}`);
  ok("256 frames in one call and in eight are the same audio", maxAbs(a, c).m === 0, `worst ${maxAbs(a, c).m.toExponential(2)}`);
  const sa = snapOf("block-1x256", 0);
  const sc = snapOf("block-8x32", 0);
  ok(
    "and they end in the same state",
    sa.panLValue === sc.panLValue && stateOf("block-1x256", 7).pos === stateOf("block-8x32", 14).pos,
    `pan ${sa.panLValue} vs ${sc.panLValue}`,
  );
  ok("the block-size cases rendered something", peak(a) > 0.01, `peak ${peak(a).toFixed(3)}`);
}

// -- the hold rounding, which is why S_HOLD_HALF exists ---------------------
{
  // Math.round is half away from zero: 0.5 frames -> 1, and the auto-release
  // fires on the first frame. rint() would round to even and give 0, where
  // `hold > 0` never passes and nothing ever releases. A port that reached for
  // rint() out of habit fails here and nowhere else.
  const half = snapOf("hold-half", 0);
  ok("a half-frame hold rounds up, not to even", half.holdLeft === 1, `holdLeft ${half.holdLeft}`);
  const afterHalf = snapOf("hold-half", 1);
  ok("and the hold fires, so the stage reaches RELEASE or IDLE", afterHalf.holdLeft <= 0 && stateOf("hold-half", 8).stage !== ENV.DECAY, `holdLeft ${afterHalf.holdLeft}, stage ${stateOf("hold-half", 8).stage}`);

  const zero = snapOf("hold-rounds-to-zero", 0);
  ok("a hold that rounds to zero frames never fires", zero.holdLeft === 0, `holdLeft ${zero.holdLeft}`);
  const stillGoing = stateOf("hold-rounds-to-zero", 6);
  ok("and the voice keeps sounding instead", stillGoing.active === 1 && stillGoing.stage === ENV.SUSTAIN, `active ${stillGoing.active}, stage ${stillGoing.stage}`);

  const held = snapOf("hold", 1);
  ok("a 2 ms hold is 96 frames and counts down across blocks", snapOf("hold", 0).holdLeft === 96 && held.holdLeft === 32, `${snapOf("hold", 0).holdLeft} -> ${held.holdLeft}`);
  ok("and the hold ends in RELEASE", snapOf("hold", 2).holdLeft === 0 && stateOf("hold", 12).stage === ENV.RELEASE, `stage ${stateOf("hold", 12).stage}`);
}

// -- the envelope's three handovers -----------------------------------------
{
  ok("attack 0 starts at full level in DECAY", snapOf("attack-zero", 0).attackInc === 1 && stateOf("attack-zero", 3).env === 1 && stateOf("attack-zero", 3).stage === ENV.DECAY);
  const mid = stateOf("attack-long", 5);
  ok("a long attack is still climbing after a block", mid.stage === ENV.ATTACK && mid.env > 0 && mid.env < 1, `env ${mid.env.toFixed(4)}`);
  const gate = stateOf("sustain-gate", 9);
  ok("sustain > 0 lands on SUSTAIN and holds", gate.stage === ENV.SUSTAIN && Math.abs(gate.env - 0.6) < 1e-9, `env ${gate.env}`);
  ok("release() in GATE mode moves it to RELEASE", stateOf("sustain-gate", 11).stage === ENV.RELEASE);
  const releasing = stateOf("sustain-gate", 13);
  ok(
    "the release is a fade, not a cut",
    releasing.active === 1 && releasing.env < 0.6 && releasing.env > 0,
    `env ${releasing.env.toExponential(2)}`,
  );
  ok("and the voice frees itself once released", stateOf("sustain-gate", 14).active === 0 && stateOf("sustain-gate", 14).env === 0);
  const zero = stateOf("sustain-zero", 5);
  ok("sustain 0 goes straight to IDLE, not to SUSTAIN", zero.active === 0 && zero.stage === ENV.IDLE, `stage ${zero.stage}`);
  ok("release() in ONESHOT mode is ignored", stateOf("release-oneshot", 6).stage === ENV.DECAY, `stage ${stateOf("release-oneshot", 6).stage}`);
  ok("release() on an idle voice changes nothing", stateOf("release-idle", 1).active === 0 && stateOf("release-idle", 1).stage === ENV.IDLE);
}

// -- round robin, layer holes and the null handoff --------------------------
{
  const layers = [0, 1, 2, 3, 4].map((i) => snapOf("round-robin", i + 1).layer);
  ok("the round robin walks 0,1,2,3 and wraps", String(layers) === String([0, 1, 2, 3, 0]), `${layers}`);
  ok("four occupied layers make the rotation four long", snapOf("round-robin", 0).layerCount === 4);

  ok("a sample in layer 2 alone makes the rotation three long", snapOf("layer-hole", 0).layerCount === 3);
  const hit1 = snapOf("layer-hole", 1);
  ok("the first hit lands on the empty layer 0", hit1.layer === 0 && hit1.layerCount === 3);
  ok("and process() deactivates immediately on it", stateOf("layer-hole", 6).active === 0 && blockOf("layer-hole", 0).meter === 0);
  ok("the third hit finds the sample and sounds", snapOf("layer-hole", 4).layer === 2 && blockOf("layer-hole", 2).meter > 0, `layer ${snapOf("layer-hole", 4).layer}, meter ${blockOf("layer-hole", 2).meter.toExponential(2)}`);

  ok("emptying the top layer shortens the rotation", snapOf("setbuf-null", 2).layerCount === 2 && snapOf("setbuf-null", 2).layers[2].present === 0);
  ok("and pulls nextLayer back into range", snapOf("setbuf-null", 3).layerCount === 1 && snapOf("setbuf-null", 3).nextLayer === 0);

  ok("a zero-length buffer is not a buffer", snapOf("zero-frames", 0).layerCount === 0 && snapOf("zero-frames", 0).layers[0].present === 1);
  ok("so trigger() does nothing at all", stateOf("zero-frames", 2).active === 0 && blockOf("zero-frames", 0).meter === 0);
}

// -- pulling the sample out from under a sounding voice ---------------------
{
  const before = snapOf("sample-yanked", 0);
  const after = snapOf("sample-yanked", 1);
  ok("a yanked sample deactivates the voice", after.layers[0].present === 0 && stateOf("sample-yanked", 9).active === 0);
  ok("and the pan smoothers stand still on that block", before.panLValue === after.panLValue && before.panLTarget !== before.panLValue, `pan ${before.panLValue} -> ${after.panLValue}`);
  ok("the block is left as the prefill found it", blockOf("sample-yanked", 1).L.every((x) => x === 0.25), "0.25 untouched");

  ok("clearBuffers() mid-note deactivates too", snapOf("clear-midnote", 1).layerCount === 0 && stateOf("clear-midnote", 6).active === 0);
  ok("and the block after it is silence added to the prefill", blockOf("clear-midnote", 1).L.every((x) => x === 0.25) && blockOf("clear-midnote", 1).R.every((x) => x === -0.5));
  ok("a trigger after a clear cannot start anything", stateOf("clear-midnote", 10).active === 0);
}

// -- choke -------------------------------------------------------------------
{
  ok("the choke fade is 4 ms, as a per-sample decrement", Math.abs(snapOf("choke", 0).chokeInc - 1 / 192) < 1e-15, `${snapOf("choke", 0).chokeInc}`);
  ok("choke() arms the fade on a sounding voice", snapOf("choke", 0).choking === 1);
  const stillFading = stateOf("choke", 7);
  ok("and the fade spans blocks", stillFading.active === 1 && stillFading.env < 1, `env ${stillFading.env.toFixed(4)}`);
  ok("the voice is gone by the end of the fade", stateOf("choke", 11).active === 0 && snapOf("choke", 3).choking === 0);
  ok("choke() on an idle voice arms nothing", snapOf("choke-idle-retrigger", 0).choking === 0);
  ok("a retrigger clears a live choke", snapOf("choke-idle-retrigger", 2).choking === 0 && stateOf("choke-idle-retrigger", 11).active === 1);
}

// -- velocity, pan, mute, gain, reset ---------------------------------------
{
  ok("velAmount 0 ignores velocity", snapOf("velocity", 0).velGain === 1);
  ok("velAmount 1 hands it the whole range", Math.abs(snapOf("velocity", 1).velGain - 0.0625) < 1e-15, `${snapOf("velocity", 1).velGain}`);
  ok("velocity above 1 clamps", Math.abs(snapOf("velocity", 2).velGain - 1) < 1e-15, `${snapOf("velocity", 2).velGain}`);
  ok("velocity below 0 clamps", Math.abs(snapOf("velocity", 3).velGain - 0.3) < 1e-15, `${snapOf("velocity", 3).velGain}`);

  const hardLeft = snapOf("pan", 1);
  ok("a hit from silence starts AT its pan position", hardLeft.panLValue === hardLeft.panLTarget && hardLeft.panLValue > 0.99, `${hardLeft.panLValue}`);
  const gliding = snapOf("pan", 3);
  ok("a knob moved mid-note glides instead", gliding.panLValue !== gliding.panLTarget && gliding.panLValue > 0 && gliding.panLTarget < 1e-9, `${gliding.panLValue} -> ${gliding.panLTarget}`);
  ok("pan 0 is the centre of the law", Math.abs(snapOf("pan", 4).pan) === 0 && Math.abs(snapOf("pan", 4).panLTarget - Math.SQRT1_2) < 1e-15, `${snapOf("pan", 4).panLTarget}`);
  // -7 and +7 each get their own snapshot in the script, so the low clamp is
  // observable rather than being overwritten by the high one.
  const low = snapOf("pan", 5);
  ok("pan clamps to -1, hard left", low.pan === -1 && low.panLTarget === 1 && low.panRTarget === 0, `pan ${low.pan}, L ${low.panLTarget}, R ${low.panRTarget}`);
  const high = snapOf("pan", 6);
  ok("and to +1, hard right", high.pan === 1 && high.panRTarget === 1 && high.panLTarget < 1e-15, `pan ${high.pan}, L ${high.panLTarget}, R ${high.panRTarget}`);

  ok("a muted block is silent", blockOf("mute-and-gain", 1).L.every((x) => x === 0.25) && blockOf("mute-and-gain", 1).meter === 0);
  const muted = snapOf("mute-and-gain", 0);
  ok("but the pan smoother keeps moving under the mute", muted.muted === 1 && muted.panLValue < 1 && muted.panLValue > 0, `pan ${muted.panLValue.toFixed(6)}`);
  ok("unmuting brings the audio straight back", blockOf("mute-and-gain", 2).meter > 0, `meter ${blockOf("mute-and-gain", 2).meter.toExponential(2)}`);
  ok("gain is dB, and clamps at +12", Math.abs(snapOf("mute-and-gain", 2).gain - Math.pow(10, 12 / 20)) < 1e-12, `${snapOf("mute-and-gain", 2).gain}`);
  ok("and at -60", Math.abs(snapOf("mute-and-gain", 3).gain - Math.pow(10, -60 / 20)) < 1e-12, `${snapOf("mute-and-gain", 3).gain}`);

  const mid = snapOf("reset", 0);
  const parked = snapOf("reset", 1);
  ok("reset() parks the pan where it sits, not where it was heading", parked.panLValue === mid.panLValue && parked.panLTarget === mid.panLValue && mid.panLValue !== mid.panLTarget, `${mid.panLValue} (target was ${mid.panLTarget})`);
  ok("reset() clears the voice", parked.meter === 0 && stateOf("reset", 9).active === 0 && stateOf("reset", 9).pos === 0);
  ok("and the next hit starts at its pan target again", snapOf("reset", 3).panLValue === snapOf("reset", 3).panLTarget);
}

// -- pitch, rate and the resampler edges ------------------------------------
{
  ok("+7 semitones is a step of 2^(7/12)", Math.abs(snapOf("pitch-up", 0).step - Math.pow(2, 7 / 12)) < 1e-12, `${snapOf("pitch-up", 0).step}`);
  ok("pitch clamps at -36", Math.abs(snapOf("pitch-down", 0).step - Math.pow(2, -3)) < 1e-12, `${snapOf("pitch-down", 0).step}`);
  ok("a 44.1k sample on a 48k engine steps at the rate ratio", Math.abs(snapOf("rate-mismatch", 1).step - 44100 / 48000) < 1e-12, `${snapOf("rate-mismatch", 1).step}`);
  ok("and srcRate 0 falls back to the engine rate", snapOf("rate-mismatch", 0).layers[1].rate === SR, `${snapOf("rate-mismatch", 0).layers[1].rate}`);

  ok("reverse walks the position backwards", stateOf("reverse", 7).pos < stateOf("reverse", 6).pos, `${stateOf("reverse", 6).pos} -> ${stateOf("reverse", 7).pos}`);
  ok("and the reverse hit starts near the end", snapOf("reverse", 0).startOffset === 0.5 && stateOf("reverse", 5).pos > 100, `pos ${stateOf("reverse", 5).pos}`);
  ok("start clamps to 0.99", snapOf("start-clamp", 0).startOffset === 0.99);
  ok("a hit two frames from the end runs out at once", blockOf("start-clamp", 0).frames === 32 && stateOf("start-clamp", 6).active === 0);

  for (let i = 0; i < 4; i++) {
    const b = blockOf("tiny-buffers", i);
    ok(`a ${i + 1}-frame buffer renders without going wild`, b.L.every((x) => Number.isFinite(x)) && Math.abs(b.meter) <= 1, `meter ${b.meter.toExponential(2)}`);
  }
}

// -- the two guards on the sample path --------------------------------------
{
  const dirty = blockOf("dirty-sample", 0);
  ok("a NaN/inf/-0 buffer produces finite audio", dirty.L.every((x) => Number.isFinite(x)) && dirty.R.every((x) => Number.isFinite(x)));
  ok("and it does produce audio, rather than being silenced wholesale", dirty.meter > 0 && Number.isFinite(dirty.meter), `meter ${dirty.meter.toExponential(2)}`);
  const tiny = blockOf("dirty-sample", 1);
  ok("a buffer below sanitize()'s floor comes out as exact silence", tiny.L.every((x) => x === 0) && tiny.meter === 0);
}

// -- the degenerate block ----------------------------------------------------
{
  const afterTrigger = stateOf("zero-frame-block", 4);
  const afterZero = stateOf("zero-frame-block", 5);
  ok("a zero-frame process() changes nothing", afterTrigger.pos === afterZero.pos && afterTrigger.env === afterZero.env && afterTrigger.active === afterZero.active);
  const snap = snapOf("zero-frame-block", 0);
  ok("not even the smoothers", snap.panLValue === snap.panLTarget, `${snap.panLValue}`);
  ok("and the block that follows still renders", blockOf("zero-frame-block", 1).meter > 0);
}

// -- every clamp, read back through the snapshot ----------------------------
{
  const lo = snapOf("param-clamps", 0);
  const hi = snapOf("param-clamps", 1);
  ok("the low clamps all hold", lo.attackMs === 0 && lo.decayMs === 1 && lo.releaseMs === 1 && lo.holdMs === 0 && lo.startOffset === 0, `${lo.attackMs},${lo.decayMs},${lo.releaseMs},${lo.holdMs},${lo.startOffset}`);
  ok("sustain and velAmount clamp high", lo.sustain === 1 && lo.velAmount === 1);
  ok("pitch clamps high", lo.pitch === 36);
  ok("choke group rounds half away from zero", lo.chokeGroup === 4, `${lo.chokeGroup}`);
  ok("0.49 is GATE and 0.5 is ONESHOT", lo.mode === 0 && hi.mode === 1);
  ok("0.5 is reverse and 0.49 is not", lo.reverse === 1 && hi.reverse === 0);
  ok("0.51 is muted and 0.49 is not", lo.muted === 1 && hi.muted === 0);
  ok("the high clamps all hold", hi.attackMs === 2000 && hi.decayMs === 8000 && hi.releaseMs === 8000 && hi.holdMs === 8000 && hi.chokeGroup === 8, `${hi.attackMs},${hi.decayMs},${hi.releaseMs},${hi.holdMs},${hi.chokeGroup}`);
  ok("an unknown key changes nothing", hi.gain === lo.gain && hi.sustain === lo.sustain && hi.pitch === lo.pitch);
}

// -- the retrigger that must not click --------------------------------------
{
  const before = stateOf("retrigger-middecay", 5);
  const after = stateOf("retrigger-middecay", 7);
  ok("a retrigger mid-decay keeps the envelope where it is", after.env === before.env && before.env > 0 && before.env < 1, `env ${before.env.toFixed(6)}`);
  ok("and restarts the sample from the top", after.pos === 0 && after.stage === ENV.ATTACK);
}

// -- the soak run ------------------------------------------------------------
{
  const a = audioOf("soak");
  ok("the soak run renders finite audio throughout", [...a].every((x) => Number.isFinite(x)), `${a.length} samples`);
  ok("and it is not silence", peak(a) > 0.05, `peak ${peak(a).toFixed(3)}`);
  ok("a pitch change mid-note waits for the next trigger", Math.abs(snapOf("soak", 0).step - snapOf("soak", 1).step) > 1e-9 || snapOf("soak", 1).pitch === 12, `step ${snapOf("soak", 0).step}`);
  ok("the soak ends with the voice reset and re-hit", snapOf("soak", 3).layers[1].present === 0);
}

// ---------------------------------------------------------------------------
// the cases mutation testing asked for
//
// Each block below belongs to one script added after the first mutation run,
// and checks the specific thing that script exists to make observable. The
// parity diff already catches a wrong answer; these say what the right answer
// is, so a future edit that changes the behaviour reads as a broken promise
// rather than as a re-baselining chore.
// ---------------------------------------------------------------------------

// -- the NaN guard, in the branch that actually has one ---------------------
{
  // 4 frames, NaN at index 3. pos 2 is the only frame whose linear pair reads
  // it, and the guard turns it into 0 so data[2] still sounds; unguarded the
  // NaN propagates and sanitize() flattens the frame to silence.
  const four = blockOf("dirty-edge", 0);
  ok(
    "a NaN in the linear pair is read as zero, and the frame still sounds",
    four.L.every((x) => Number.isFinite(x)) && four.L[2] !== 0,
    `frame2 ${four.L[2]}`,
  );
  // 5 frames at 0.7248 frames/frame: here the NaN arrives as y0 and frac
  // scales the pair, so a propagating NaN cannot be hidden by a zero frac.
  const five = blockOf("dirty-edge", 1);
  ok(
    "and as y0 under a fractional step too",
    five.L.every((x) => Number.isFinite(x)) && peak(five.L) > 0,
    `peak ${peak(five.L).toExponential(2)}`,
  );
}

// -- the attack floor, which only a sub-frame attack can see ---------------
{
  // 0.01 ms is 0.48 frames at 48 kHz. Unfloored that is an increment of 2.08,
  // which the attack stage clamps back to 1 on the same frame — so the audio
  // is identical and attackInc itself is the only witness.
  const snap = snapOf("attack-tiny", 0);
  ok("a sub-frame attack floors to one frame, not to a step above 1", snap.attackInc === 1 && snap.attackMs === 0.01, `attackInc ${snap.attackInc}, attackMs ${snap.attackMs}`);
  // sustain is 1 in this script, so the frame that ends the attack also ends
  // the decay: env is already at the ceiling when DECAY first looks at it.
  const after = stateOf("attack-tiny", 5);
  ok("and the hit is at full level, through attack and decay both, inside the first block", after.env === 1 && after.stage === ENV.SUSTAIN, `env ${after.env}, stage ${after.stage}`);
}

// -- setBuffer past the last layer -----------------------------------------
{
  const four = snapOf("layer-clamp", 0);
  ok(
    "layer index 4 lands in layer 3, not past the table",
    four.layers[3].frames === 64 && four.layers[0].present === 0 && four.layerCount === 4,
    `frames ${four.layers[3].frames}, count ${four.layerCount}`,
  );
  const ninetynine = snapOf("layer-clamp", 1);
  ok("and so does 99", ninetynine.layers[3].frames === 32 && ninetynine.layers[3].rate === 22050, `frames ${ninetynine.layers[3].frames}, rate ${ninetynine.layers[3].rate}`);
  ok("the first three hits find empty layers", [0, 1, 2].every((i) => blockOf("layer-clamp", i).meter === 0));
  ok("and the fourth plays what landed in layer 3", snapOf("layer-clamp", 2).layer === 3 && blockOf("layer-clamp", 3).meter > 0, `layer ${snapOf("layer-clamp", 2).layer}, meter ${blockOf("layer-clamp", 3).meter.toExponential(2)}`);
}

// -- release() on a voice whose sample was pulled out ----------------------
{
  const yanked = stateOf("release-after-yank", 7);
  ok(
    "a yanked sample leaves the voice inactive with its stage mid-envelope",
    yanked.active === 0 && yanked.stage === ENV.SUSTAIN,
    `active ${yanked.active}, stage ${yanked.stage}`,
  );
  const afterRelease = stateOf("release-after-yank", 9);
  ok(
    "and release() declines to move it, GATE mode or not",
    afterRelease.stage === ENV.SUSTAIN && afterRelease.active === 0,
    `stage ${afterRelease.stage}`,
  );
  ok("so the block after it is the prefill, untouched", blockOf("release-after-yank", 2).L.every((x) => x === 0.25) && blockOf("release-after-yank", 2).meter === 0);
}

// -- the same layer truncated to zero frames, pointer intact ---------------
{
  const snap = snapOf("sample-truncated", 0);
  ok("a layer can hold a live pointer and no frames", snap.layers[0].present === 1 && snap.layers[0].frames === 0 && snap.layerCount === 0, `present ${snap.layers[0].present}, frames ${snap.layers[0].frames}`);
  const after = stateOf("sample-truncated", 9);
  ok(
    "process() on it deactivates without touching the envelope",
    after.active === 0 && after.stage === ENV.SUSTAIN && after.env === 1,
    `active ${after.active}, stage ${after.stage}, env ${after.env}`,
  );
  ok("and without touching the block", blockOf("sample-truncated", 1).L.every((x) => x === 0.25) && blockOf("sample-truncated", 1).meter === 0);
}

// -- the choke fade landing exactly on zero, at 32 kHz ---------------------
{
  const snap = snapOf("choke-exact-zero", 0);
  ok(
    "at 32 kHz the choke decrement is exactly 1/128",
    snap.chokeInc === 1 / 128 && snap.layers[0].rate === 32000,
    `chokeInc ${snap.chokeInc}, rate ${snap.layers[0].rate}`,
  );
  const before = stateOf("choke-exact-zero", 9);
  ok("127 frames of fade leave env at exactly 1/128", before.env === 1 / 128 && before.active === 1 && before.pos === 127, `env ${before.env}, pos ${before.pos}`);
  const after = stateOf("choke-exact-zero", 11);
  ok(
    "the 128th frame ends the voice on the zero itself, without rendering it",
    after.active === 0 && after.env === 0 && after.pos === 127,
    `env ${after.env}, pos ${after.pos}`,
  );
  // The block that ends the voice renders no frames at all, so the pan
  // smoother does not move across it — that standstill is the only witness to
  // `<= 0` rather than `< 0`, since the frame a `< 0` test would let through
  // carries env 0 and is silent either way.
  const ending = snapOf("choke-exact-zero", 2);
  ok(
    "the block that ends the voice renders nothing, so the pan stands exactly where the fade left it",
    ending.choking === 0 && ending.panLValue === snapOf("choke-exact-zero", 1).panLValue,
    `pan ${ending.panLValue}`,
  );
  // And the distinction is real rather than a smoother that simply stopped:
  // the next block sees an inactive voice and runs the smoother on purpose.
  ok(
    "the block after that finds the voice inactive and keeps the smoother going",
    snapOf("choke-exact-zero", 3).panLValue < ending.panLValue,
    `${ending.panLValue} -> ${snapOf("choke-exact-zero", 3).panLValue}`,
  );
}

// -- sustain dropped under a note that is already holding ------------------
{
  const holding = stateOf("sustain-dropped", 6);
  ok("a GATE note with sustain 0.6 holds at SUSTAIN", holding.stage === ENV.SUSTAIN && Math.abs(holding.env - 0.6) < 1e-9, `stage ${holding.stage}, env ${holding.env}`);
  const dropped = stateOf("sustain-dropped", 9);
  ok(
    "dropping sustain below 1e-4 frees the voice from the SUSTAIN stage itself",
    dropped.active === 0 && dropped.stage === ENV.IDLE && dropped.env === 0,
    `active ${dropped.active}, stage ${dropped.stage}, env ${dropped.env}`,
  );
  ok("and its meter goes with it", snapOf("sustain-dropped", 1).meter === 0);
}

// -- the two additions to older scripts ------------------------------------
{
  const half = snapOf("param-clamps", 2);
  ok("exactly 0.5 is true on all three boolean params", half.muted === 1 && half.reverse === 1 && half.mode === 1, `mute ${half.muted}, reverse ${half.reverse}, mode ${half.mode}`);
  const nulled = snapOf("setbuf-null", 6);
  ok("a null handoff carrying a frame count still empties the layer", nulled.layers[0].present === 0 && nulled.layers[0].frames === 0 && nulled.layerCount === 0, `frames ${nulled.layers[0].frames}, count ${nulled.layerCount}`);
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\ndrum-voice parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
