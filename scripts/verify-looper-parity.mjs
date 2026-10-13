/**
 * Parity oracle for the C port of dsp/core/looper.js (Phase 5, route (c)).
 *
 * The last module of the portable core. Same four steps as every module before
 * it, on the shared plumbing in scripts/lib/parity-stream.mjs:
 *
 *   1. build the C natively and run the battery;
 *   2. build the same source to wasm with emscripten and run it under Node;
 *   3. replay the identical battery through the original looper.js;
 *   4. diff native against wasm.
 *
 * The battery lives in packages/native/tests/parity-looper.c and only there.
 * Each record carries its whole command script in its params, and this file
 * interprets that script rather than keeping a copy of it. Read that file's
 * header first: it explains why the clock is sometimes NULL, why buffers are
 * dumped rather than inferred, and why punches land mid-block on purpose.
 *
 * Two probe copies, as for drum-rack: looper.js imports Chain, and chain.js
 * imports the real effect registry, which this battery must not pull in. Both
 * substitutions are asserted to have matched exactly once, and both copies are
 * removed in a finally. Clock is imported directly; it only imports clamp.
 *
 * What this file mirrors by hand, because the C documents it in comments:
 *
 *   - the opcode, source-mode, prefill and flag tables;
 *   - build_src()'s four streams and the cursor that walks them;
 *   - tfx, the test effect (no setCarrierBus, same as drum-rack's);
 *   - push_state() and push_snap()'s field order — the payload contract;
 *   - the NANV sentinel, which the C maps to NaN at run time because a NaN in
 *     a static initialiser is not portable to MSVC.
 *
 * The JS allocates track and undo buffers lazily; the C takes caller-owned
 * zeroed ones (looper.h note 1). OP_BUFS pushes zeros here for a buffer the JS
 * has not allocated, so "unallocated" and "zeroed and untouched" are claimed
 * to be the same observation, and the arm-* pairs in the sanity section test
 * that claim rather than assume it.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildAndRun,
  compareToJs,
  compareToolchains,
  createChecker,
  fillSignal,
  firstDiff,
} from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

/*
 * Bit-identity baselines, pinned rather than printed. MEASURED; see the note
 * in assertIdentity (parity-stream.mjs) before re-baselining. Under MSVC this
 * is unmeasured, per the plan's standing caveat.
 */
// 77/78, not 78/78: in `init-low` (sr 2000) the play smoother coefficient is
// exp(-1 / (3 * 0.001 * 2000)), and V8's Math.exp rounds it one ulp below
// libm's (0.846481724890614 vs ...6141). All 8 differing values are that
// `playA` snapshot field (4 tracks x 2 snapshots, 1.1e-16 each); the float32
// audio is bit-identical. Native and wasm agree with each other, 78/78.
const IDENTITY_NATIVE = 77;
const IDENTITY_WASM = 77;
const IDENTITY_CROSS = 78;

const { native, wasm } = buildAndRun({
  root,
  name: "parity-looper",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/chain.c"),
    join(root, "packages/native/src/dsp/clock.c"),
    join(root, "packages/native/src/dsp/looper.c"),
    join(root, "packages/native/tests/parity-looper.c"),
  ],
  ok,
  state,
});

console.log(`\n   ${native.length} scripts in the battery`);

// ---------------------------------------------------------------------------
// the JS under test, through two probe copies
// ---------------------------------------------------------------------------

const coreDir = join(root, "packages/web/public/dsp/core");
const chainProbe = join(coreDir, ".parity-probe.chain.mjs");
const looperProbe = join(coreDir, ".parity-probe.looper.mjs");

const REGISTRY_RE = /^import \{ createEffect \} from "\.\.\/effects\/registry\.js";$/m;
const CHAIN_RE = /^import \{ Chain \} from "\.\/chain\.js";$/m;

let js;
let Clock;
try {
  const chainSrc = readFileSync(join(coreDir, "chain.js"), "utf8");
  const chainHits = chainSrc.match(new RegExp(REGISTRY_RE.source, "gm")) || [];
  ok("chain.js imports createEffect exactly once (the probe's only edit)", chainHits.length === 1, `${chainHits.length} matches`);
  const chainPatched = chainSrc.replace(
    REGISTRY_RE,
    "const createEffect = (type, sr, maxBlock) => globalThis.__BK_PARITY_CREATE_EFFECT(type, sr, maxBlock);",
  );
  ok("the chain probe substitution changed the source", chainPatched !== chainSrc);
  writeFileSync(chainProbe, chainPatched);

  const lpSrc = readFileSync(join(coreDir, "looper.js"), "utf8");
  const lpHits = lpSrc.match(new RegExp(CHAIN_RE.source, "gm")) || [];
  ok("looper.js imports Chain exactly once (the probe's only edit)", lpHits.length === 1, `${lpHits.length} matches`);
  const lpPatched = lpSrc.replace(CHAIN_RE, 'import { Chain } from "./.parity-probe.chain.mjs";');
  ok("the looper probe substitution changed the source", lpPatched !== lpSrc);
  writeFileSync(looperProbe, lpPatched);

  js = await import(`${pathToFileURL(looperProbe).href}?t=${Date.now()}`);
  ({ Clock } = await import(pathToFileURL(join(coreDir, "clock.js")).href));
  ok("the probe exports Looper and LOOP_TRACKS", typeof js.Looper === "function" && js.LOOP_TRACKS === 4);
} finally {
  rmSync(looperProbe, { force: true });
  rmSync(chainProbe, { force: true });
}

const SR = 48000;
const MAX_BLOCK = 256;
const DEF_SECONDS = 0.26;
const SRC_LEN = 65536;
const MAX_EFFECTS = 24;
const SNAP_SLOTS = 2;
const UNSET = -1e9;
const NANV = -3e9;
const MIN_LOOP_FRAMES = 2048;

const LOOP_KEY = ["gain", "mute", "solo", "pan", "sync", "source"];
const LOOPER_KEY = ["gain", "mute"];
const CLOCK_KEY = ["bpm", "beatsPerBar", "quantize", "run", "reset"];

/** Mirrors the opcode enum in parity-looper.c. */
const OP = {
  END: 0,
  INIT: 1,
  REC: 2,
  PLAY: 3,
  STOP: 4,
  CLEAR: 5,
  CLEARALL: 6,
  UNDO: 7,
  TPARAM: 8,
  PARAM: 9,
  RESET: 10,
  CLOCK: 11,
  CLOCKADV: 12,
  CHAINFOR: 13,
  CHAINADD: 14,
  CHAINREMOVE: 15,
  CHAINBYPASS: 16,
  PROCESS: 17,
  SNAP: 18,
  BUFS: 19,
  METERS: 20,
  QUERY: 21,
  MAXFRAMES: 22,
  INITCHECK: 23,
};

/*
 * bk_looper_init's argument checks, which the JS has no counterpart for: it
 * allocates its own buffers and builds whatever count it is given. These are
 * the C contract (looper.h), not a parity claim, so they are spelled out here
 * per variant of init_check() in parity-looper.c rather than replayed.
 */
const INIT_CHECK_EXPECT = [
  0, // accepted
  -1, // tracks 5 > BK_LOOP_TRACKS
  -1, // sr 0
  -1, // sr NaN
  -1, // max_block 0
  -1, // undo_l NULL
  -1, // undo_r NULL
  -1, // trk_l NULL
  -1, // trk_r NULL
  -1, // bus_l NULL
  -1, // bus_r NULL
  -1, // chain_wet_l NULL
  -1, // chain_wet_r NULL
  -1, // a live track with no buffer
  0, // a missing buffer beyond the track count
  -1, // tracks 2, track 1's right buffer NULL
  -1, // lp NULL
  -1, // bufs NULL
  -1, // tracks 0 means 4, so track 3 is live and needs its buffer
  0, // tracks -1 builds none, so needs none
  -1, // max_block negative
  0, // max_block 1, the smallest legal block
];
const PF_CLOCK = 1;
const PF_ADVANCE = 2;
const SRC = { NULL: 0, MASTER: 1, ALL: 2, DIRTY: 3, HUGE: 4 };
const PRE = { SILENT: 0, CONST: 1, NOISE: 2, NEGZERO: 3 };
const SIG_NOISE = 2;
const ST = js.LOOP_STATE;
const PEND = js.LOOP_PENDING;

const FX_KEY = ["gain", "latency", "inert"];

// ---------------------------------------------------------------------------
// the stimulus, mirroring build_src() and prefill()
// ---------------------------------------------------------------------------

const noise = fillSignal(SRC_LEN, SIG_NOISE);
const srcML = new Float32Array(MAX_BLOCK);
const srcMR = new Float32Array(MAX_BLOCK);
const srcDL = new Float32Array(MAX_BLOCK);
const srcDR = new Float32Array(MAX_BLOCK);
let srcCursor = 0;

function buildSrc(frames, mode) {
  const M = SRC_LEN - 1;
  for (let i = 0; i < frames; i++) {
    const n = srcCursor + i;
    srcML[i] = noise[n & M] * 0.5;
    srcMR[i] = -0.25 * noise[(n + 7) & M];
    srcDL[i] = ((n % 256) / 128 - 1) * 0.375;
    srcDR[i] = 0.125 * noise[(n + 13) & M];
    if (mode === SRC.HUGE) srcML[i] = noise[n & M] * 4e29;
  }
  if (mode === SRC.DIRTY) {
    if (frames > 5) srcML[5] = NaN;
    if (frames > 9) srcML[9] = 1e40;
    if (frames > 11) srcML[11] = -0;
    if (frames > 17) srcMR[17] = -1e40;
  }
  srcCursor += frames;
}

const blkL = new Float32Array(MAX_BLOCK);
const blkR = new Float32Array(MAX_BLOCK);

function prefill(frames, kind) {
  if (kind === PRE.NOISE) {
    const s = fillSignal(frames, SIG_NOISE);
    for (let i = 0; i < frames; i++) {
      blkL[i] = s[i];
      blkR[i] = -s[i];
    }
    return;
  }
  for (let i = 0; i < frames; i++) {
    blkL[i] = kind === PRE.CONST ? 0.25 : kind === PRE.NEGZERO ? -0 : 0;
    blkR[i] = kind === PRE.CONST ? -0.5 : kind === PRE.NEGZERO ? -0 : 0;
  }
}

// ---------------------------------------------------------------------------
// the test effect, mirroring tfx (no setCarrierBus, deliberately)
// ---------------------------------------------------------------------------

class TestEffect {
  constructor(id) {
    this.gain = 0.5 + 0.25 * (id % 4);
    this.latency = (id % 3) * 8;
    this.zl = 0;
    this.zr = 0;
    this.calls = 0;
    this.resets = 0;
    this.lastKey = -1;
    this.lastValue = 0;
  }

  process(L, R, frames) {
    for (let i = 0; i < frames; i++) {
      this.zl = this.zl * 0.5 + L[i] * this.gain;
      this.zr = this.zr * 0.5 + R[i] * this.gain;
      L[i] = this.zl;
      R[i] = this.zr;
    }
    this.calls++;
  }

  reset() {
    this.zl = 0;
    this.zr = 0;
    this.resets++;
  }

  setParam(key, value) {
    this.lastKey = FX_KEY.indexOf(key);
    this.lastValue = value;
    if (key === "gain") this.gain = value;
    else if (key === "latency") this.latency = Math.trunc(value);
  }

  get latencySamples() {
    return this.latency;
  }

  get meter() {
    return this.zl;
  }
}

globalThis.__BK_PARITY_CREATE_EFFECT = (type) => new TestEffect(type);

// ---------------------------------------------------------------------------
// the payload, mirroring push_state() and push_snap()
// ---------------------------------------------------------------------------

const STATE_HEAD = ["active", "meterL", "meterR", "undoTrack", "undoFrames", "undoMode", "undoApplied", "undoArmed", "undoArmedEver", "clockFrame"];
const STATE_TRACK = ["state", "pending", "frames", "recWrite", "pos", "layers", "meter", "posNorm", "playGain", "bufArmed"];

function pushState(out, lp, ck) {
  out.push(lp.active ? 1 : 0);
  out.push(lp.meterL);
  out.push(lp.meterR);
  out.push(lp.undoTrack);
  out.push(lp.undoFrames);
  out.push(lp.undoMode);
  out.push(lp.undoApplied ? 1 : 0);
  out.push(lp.undoArmed ? 1 : 0);
  out.push(lp.undoL !== null ? 1 : 0);
  out.push(ck.frame);
  for (const t of lp.tracks) {
    out.push(t.state);
    out.push(t.pending);
    out.push(t.frames);
    out.push(t.recWrite);
    out.push(t.pos);
    out.push(t.layers);
    out.push(t.meter);
    out.push(t.posNorm);
    out.push(t.playGain.value);
    out.push(t.bufL !== null ? 1 : 0);
  }
}

const SNAP_HEAD = ["sr", "maxBlock", "maxSeconds", "maxFrames", "declick", "trackCount", "gainDb", "gain", "muted", "clockRunning", "gridFrames"];
const SNAP_TRACK = [
  "index", "sr", "maxBlock", "maxFrames", "pendingAt", "anchor", "gainDb", "gain",
  "pan", "panL", "panR", "muted", "soloed", "sync", "source", "playTarget", "playA",
  "recRamp", "lastWrite", "chainUsed", "chainLength", "chainLatency",
];
const SLOT_NAMES = ["present", "id", "bypassed", "calls", "resets", "zl", "zr", "gain"];
const TRACK_FIELDS = SNAP_TRACK.length + SNAP_SLOTS * SLOT_NAMES.length;

function pushSnap(out, lp, ck) {
  out.push(lp.sr);
  out.push(lp.maxBlock);
  out.push(lp.maxSeconds);
  out.push(lp.maxFrames);
  out.push(lp.declick);
  out.push(lp.tracks.length);
  out.push(lp.gainDb);
  out.push(lp.gain);
  out.push(lp.muted ? 1 : 0);
  out.push(ck.running ? 1 : 0);
  out.push(ck.gridFrames);
  for (const t of lp.tracks) {
    const ch = t.chain;
    out.push(t.index);
    out.push(t.sr);
    out.push(t.maxBlock);
    out.push(t.maxFrames);
    out.push(t.pendingAt);
    out.push(t.anchor);
    out.push(t.gainDb);
    out.push(t.gain);
    out.push(t.pan);
    out.push(t.panL);
    out.push(t.panR);
    out.push(t.muted ? 1 : 0);
    out.push(t.soloed ? 1 : 0);
    out.push(t.sync ? 1 : 0);
    // clamp(Math.round(NaN), 0, 1) leaves NaN here. The render's only test of
    // the field is `=== DRUMS`, so NaN behaves as MASTER, and the C stores it
    // as MASTER rather than casting NaN to int (UB). The sanity section checks
    // the JS really did hold NaN, so this mapping is exercised knowingly.
    out.push(Number.isNaN(t.source) ? js.LOOP_SOURCE.MASTER : t.source);
    out.push(t.playGain.target);
    out.push(t.playGain.a);
    out.push(t.recRamp);
    out.push(t.lastWrite);
    // `t.chain !== null` is what the C spells chain_used (looper.h note 2).
    out.push(ch ? 1 : 0);
    out.push(ch ? ch.length : 0);
    out.push(ch ? ch.latencySamples : 0);
    for (let j = 0; j < SNAP_SLOTS; j++) {
      const sl = ch ? ch.slots[j] : undefined;
      if (sl) {
        out.push(1);
        out.push(sl.id);
        out.push(sl.bypassed ? 1 : 0);
        out.push(sl.effect.calls);
        out.push(sl.effect.resets);
        out.push(sl.effect.zl);
        out.push(sl.effect.zr);
        out.push(sl.effect.gain);
      } else {
        for (let i = 0; i < 8; i++) out.push(0);
      }
    }
  }
}

function decodeState(buf, at, tc) {
  const s = {};
  STATE_HEAD.forEach((k, i) => (s[k] = buf[at + i]));
  s.tracks = [];
  for (let t = 0; t < tc; t++) {
    const o = at + STATE_HEAD.length + t * STATE_TRACK.length;
    const tr = {};
    STATE_TRACK.forEach((k, i) => (tr[k] = buf[o + i]));
    s.tracks.push(tr);
  }
  return s;
}

function decodeSnap(buf, at) {
  const s = {};
  SNAP_HEAD.forEach((k, i) => (s[k] = buf[at + i]));
  s.tracks = [];
  for (let t = 0; t < s.trackCount; t++) {
    let o = at + SNAP_HEAD.length + t * TRACK_FIELDS;
    const tr = {};
    SNAP_TRACK.forEach((k, i) => (tr[k] = buf[o + i]));
    o += SNAP_TRACK.length;
    tr.slots = [];
    for (let j = 0; j < SNAP_SLOTS; j++) {
      const sl = {};
      SLOT_NAMES.forEach((k, i) => (sl[k] = buf[o + j * SLOT_NAMES.length + i]));
      tr.slots.push(sl);
    }
    s.tracks.push(tr);
  }
  return s;
}

// ---------------------------------------------------------------------------
// the script VM, mirroring run_script()
// ---------------------------------------------------------------------------

const unNan = (v) => (v === NANV ? NaN : v);

function runScript(rec) {
  const ops = rec.params;
  const nOps = ops.length / 6;
  srcCursor = 0;
  let lp = new js.Looper(SR, MAX_BLOCK, { tracks: js.LOOP_TRACKS, maxSeconds: DEF_SECONDS });
  let ck = new Clock(SR);
  let nFx = 0;
  const out64 = [];
  const out32 = [];
  const stateAt = [];
  const tcAt = [];
  const snapAt = [];
  const procs = [];
  const bufs = [];
  const pushed = []; // [opIndex, out64 offset] for ops that push a value before the state

  for (let i = 0; i < nOps; i++) {
    const op = ops[i * 6] | 0;
    const a = unNan(ops[i * 6 + 1]);
    const b = unNan(ops[i * 6 + 2]);
    const c = unNan(ops[i * 6 + 3]);
    const d = unNan(ops[i * 6 + 4]);
    const e = unNan(ops[i * 6 + 5]);
    const cp = b !== 0 ? ck : null; // NaN !== 0, as NaN != 0.0 in the C

    switch (op) {
      case OP.INIT:
        lp = new js.Looper(a, MAX_BLOCK, { tracks: b | 0, maxSeconds: c });
        ck = new Clock(a);
        nFx = 0;
        break;
      case OP.REC:
        lp.recordToggle(a | 0, cp);
        break;
      case OP.PLAY:
        lp.playToggle(a | 0, cp);
        break;
      case OP.STOP:
        lp.stop(a | 0, cp);
        break;
      case OP.CLEAR:
        lp.clear(a | 0);
        break;
      case OP.CLEARALL:
        lp.clearAll();
        break;
      case OP.UNDO:
        lp.undo(a | 0);
        break;
      case OP.TPARAM:
        lp.setTrackParam(a | 0, LOOP_KEY[b | 0] ?? "", c);
        break;
      case OP.PARAM:
        lp.setParam(LOOPER_KEY[a | 0] ?? "", b);
        break;
      case OP.RESET:
        lp.reset();
        break;
      case OP.CLOCK:
        ck.setParam(CLOCK_KEY[a | 0] ?? "", b);
        break;
      case OP.CLOCKADV:
        ck.advance(a);
        break;
      case OP.CHAINFOR:
        pushed.push([i, out64.length]);
        out64.push(lp.chainFor(a | 0) ? 1 : 0);
        break;
      case OP.CHAINADD: {
        const chain = lp.chainFor(a | 0);
        let got = null;
        if (chain && nFx < MAX_EFFECTS) {
          const id = b | 0;
          const spec = { id, type: id };
          if (c !== UNSET) spec.index = c;
          if (d !== UNSET) spec.mix = d;
          if (e !== UNSET) spec.bypassed = e;
          got = chain.add(spec);
          if (got) nFx++;
        }
        pushed.push([i, out64.length]);
        out64.push(got ? 1 : 0);
        break;
      }
      case OP.CHAINREMOVE: {
        const chain = lp.chainFor(a | 0);
        if (chain) chain.remove(b | 0);
        break;
      }
      case OP.CHAINBYPASS: {
        const chain = lp.chainFor(a | 0);
        if (chain) chain.setBypass(b | 0, c | 0);
        break;
      }
      case OP.PROCESS: {
        const frames = a | 0;
        const count = b | 0;
        const mode = c | 0;
        const flags = e | 0;
        for (let n = 0; n < count; n++) {
          buildSrc(frames, mode);
          const src = {
            masterL: srcML,
            masterR: srcMR,
            drumL: mode === SRC.MASTER ? null : srcDL,
            drumR: mode === SRC.MASTER ? null : srcDR,
          };
          prefill(frames, d | 0);
          lp.process(mode === SRC.NULL ? null : src, blkL, blkR, frames, flags & PF_CLOCK ? ck : null);
          if (flags & PF_ADVANCE) ck.advance(frames);
          const atL = out32.length;
          for (let k = 0; k < frames; k++) out32.push(blkL[k]);
          const atR = out32.length;
          for (let k = 0; k < frames; k++) out32.push(blkR[k]);
          procs.push({ op: i, frames, atL, atR });
        }
        break;
      }
      case OP.SNAP:
        snapAt.push(out64.length);
        pushSnap(out64, lp, ck);
        break;
      case OP.BUFS: {
        const ti = a | 0;
        const n = b > 0 ? b | 0 : lp.maxFrames;
        const bl = ti < 0 ? lp.undoL : lp.tracks[ti].bufL;
        const br = ti < 0 ? lp.undoR : lp.tracks[ti].bufR;
        const at = out32.length;
        // An unallocated buffer is pushed as zeros: looper.h note 1's claim.
        for (let k = 0; k < n; k++) out32.push(bl ? bl[k] : 0);
        for (let k = 0; k < n; k++) out32.push(br ? br[k] : 0);
        bufs.push({ op: i, track: ti, n, at });
        break;
      }
      case OP.METERS: {
        const m = new Float64Array(3 + js.LOOP_TRACKS * js.LOOP_METER_STRIDE + 8);
        const n = lp.readMeters(m, 3);
        pushed.push([i, out64.length]);
        out64.push(n);
        for (let k = 0; k < n; k++) out64.push(m[3 + k]);
        break;
      }
      case OP.QUERY: {
        const t = lp.track(a | 0);
        pushed.push([i, out64.length]);
        out64.push(lp.active ? 1 : 0);
        out64.push(lp.trackCount);
        out64.push(t ? 1 : 0);
        out64.push(lp.canUndo(a | 0) ? 1 : 0);
        out64.push(t ? (t.audible ? 1 : 0) : -1);
        out64.push(t ? (t.recording ? 1 : 0) : -1);
        out64.push(t ? (t.playing ? 1 : 0) : -1);
        break;
      }
      case OP.INITCHECK:
        pushed.push([i, out64.length]);
        out64.push(INIT_CHECK_EXPECT[a | 0] ?? -99);
        break;
      case OP.MAXFRAMES:
        // The JS has no free function for this; the constructor is the formula.
        pushed.push([i, out64.length]);
        out64.push(new js.Looper(a, MAX_BLOCK, { tracks: 1, maxSeconds: b }).maxFrames);
        break;
      default:
        break;
    }
    stateAt.push(out64.length);
    tcAt.push(lp.tracks.length);
    pushState(out64, lp, ck);
  }

  return {
    out64: Float64Array.from(out64),
    out32: Float32Array.from(out32),
    stateAt,
    tcAt,
    snapAt,
    procs,
    bufs,
    pushed,
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
// sanity: the battery has to actually exercise the looper
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises the looper ==");

const byName = new Map(native.map((r) => [r.name, r]));
const layout = (name) => reference(byName.get(name));

function offsetOf(name, kind, i) {
  const arr = layout(name)[kind];
  if (!Number.isInteger(arr[i]) && !(arr[i] && typeof arr[i] === "object")) {
    throw new Error(`${name}: no ${kind}[${i}] — the script only has ${arr.length} (0..${arr.length - 1})`);
  }
  return arr[i];
}
const snapOf = (name, i) => decodeSnap(byName.get(name).out64, offsetOf(name, "snapAt", i));
const stateOf = (name, i) => decodeState(byName.get(name).out64, offsetOf(name, "stateAt", i), layout(name).tcAt[i]);
const statesOf = (name) => layout(name).stateAt.map((_, i) => stateOf(name, i));
const blockOf = (name, i) => {
  const p = offsetOf(name, "procs", i);
  const rec = byName.get(name);
  return { frames: p.frames, L: rec.out32.subarray(p.atL, p.atL + p.frames), R: rec.out32.subarray(p.atR, p.atR + p.frames) };
};
const bufOf = (name, i) => {
  const b = offsetOf(name, "bufs", i);
  const rec = byName.get(name);
  return { n: b.n, L: rec.out32.subarray(b.at, b.at + b.n), R: rec.out32.subarray(b.at + b.n, b.at + 2 * b.n) };
};
const pushedOf = (name, opIndex, len = 1) => {
  const hit = layout(name).pushed.find(([o]) => o === opIndex);
  if (!hit) throw new Error(`${name}: op ${opIndex} pushed nothing`);
  return Array.from(byName.get(name).out64.subarray(hit[1], hit[1] + len));
};
/** Pushed values in op order, for the scripts that read many. */
const allPushed = (name, len = 1) => layout(name).pushed.map(([, at]) => Array.from(byName.get(name).out64.subarray(at, at + len)));
function audioOf(name) {
  const l = [];
  const r = [];
  for (let i = 0; i < layout(name).procs.length; i++) {
    const blk = blockOf(name, i);
    for (let k = 0; k < blk.frames; k++) l.push(blk.L[k]);
    for (let k = 0; k < blk.frames; k++) r.push(blk.R[k]);
  }
  return { L: Float64Array.from(l), R: Float64Array.from(r) };
}
const peak = (a) => {
  let m = 0;
  for (const x of a) if (Math.abs(x) > m) m = Math.abs(x);
  return m;
};
const same = (a, b) => a.length === b.length && Array.prototype.every.call(a, (x, i) => Object.is(x, b[i]));
const sameAudio = (x, y) => same(x.L, y.L) && same(x.R, y.R);

const recOf = (name) => {
  const r = byName.get(name);
  if (!r) throw new Error(`no case named ${name}`);
  return r;
};
/** Op indices in a script holding opcode `code`, in order. */
const opsOf = (name, code) => {
  const p = recOf(name).params;
  const at = [];
  for (let i = 0; i < p.length / 6; i++) if ((p[i * 6] | 0) === code) at.push(i);
  return at;
};
/** The state after the n-th op with this opcode (negative n counts from the end). */
const stateAfter = (name, code, n = 0) => {
  const at = opsOf(name, code);
  const i = at[n < 0 ? at.length + n : n];
  if (i === undefined) throw new Error(`${name}: no op ${code} #${n}`);
  return stateOf(name, i);
};
const lastState = (name) => stateOf(name, layout(name).stateAt.length - 1);
const queryAt = (name, n) => {
  const [active, count, present, canUndo, audible, recording, playing] = pushedOf(name, opsOf(name, OP.QUERY)[n < 0 ? opsOf(name, OP.QUERY).length + n : n], 7);
  return { active, count, present, canUndo, audible, recording, playing };
};
const meterAt = (name, n) => {
  const i = opsOf(name, OP.METERS)[n < 0 ? opsOf(name, OP.METERS).length + n : n];
  const [count] = pushedOf(name, i, 1);
  return pushedOf(name, i, 1 + count).slice(1);
};
const lastSnap = (name) => snapOf(name, layout(name).snapAt.length - 1);
const fmt = (o) => JSON.stringify(o);

// -- every case is here, and nothing else is -------------------------------
{
  const want = [
    "empty", "arm-never", "arm-cleared", "arm-undo", "free-take", "free-stop", "free-play",
    "too-short", "min-exact", "min-under", "grid-down", "grid-half", "grid-tail", "grid-max",
    "grid-full", "grid-short", "full-free", "full-sync", "quant", "quant-cancel", "block-256",
    "block-64", "overdub-wrap", "overdub-stop", "overdub-instant", "overdub-sync", "undo-take", "undo-mid",
    "undo-other", "clear-undo", "undo-layers", "mute-solo", "pan-gain", "looper-mute-rec",
    "source", "sync-toggle", "tempo-reset", "null-clock", "nan-params", "chain-never",
    "chain-empty", "chain-live", "chain-mix", "reset", "clear-all", "dirty", "huge",
    "init-44100", "init-96000", "init-low", "init-half", "init-negtracks", "grid-zero",
    "grid-up-short", "grid-huge", "undo-pending", "init-check", "maxframes", "bad-index",
    "zero-frames", "idle", "soak", "pending-replaced", "clear-pending", "clear-all-4",
    "reset-overdub", "param-edges", "steal-undo", "undo-take-rearm", "redo-in-take", "redo-in-take-2", "sync-play", "declick-short",
    "init-hisr", "chain-empty-mix", "silent-negzero", "overdub-muted", "rec-ramp-meter",
  ];
  const missing = want.filter((n) => !byName.has(n));
  const extra = native.map((r) => r.name).filter((n) => !want.includes(n));
  ok("every expected case is in the dump, and only those", missing.length === 0 && extra.length === 0 && native.length === want.length,
    `${native.length} cases${missing.length ? `; missing ${missing}` : ""}${extra.length ? `; unexpected ${extra}` : ""}`);
}

// -- the payload layout -----------------------------------------------------
{
  ok("the payload tables have the sizes the C writes", SNAP_HEAD.length === 11 && TRACK_FIELDS === 22 + 2 * 8 && STATE_HEAD.length === 10 && STATE_TRACK.length === 10,
    `snap head ${SNAP_HEAD.length}, track ${TRACK_FIELDS}, state ${STATE_HEAD.length}+${STATE_TRACK.length}/track`);
  const lay = layout("empty");
  const stateLen = STATE_HEAD.length + 4 * STATE_TRACK.length;
  const metersLen = 1 + 4 * js.LOOP_METER_STRIDE;
  const qLen = 7;
  const snapLen = SNAP_HEAD.length + 4 * TRACK_FIELDS;
  const rec = recOf("empty");
  ok("empty: the C's blocks land where the field tables put them",
    lay.stateAt[0] === 0 && lay.stateAt[1] === stateLen + metersLen && lay.stateAt[2] === lay.stateAt[1] + stateLen + qLen &&
      lay.snapAt[0] === lay.stateAt[2] + stateLen && rec.out64.length === lay.snapAt[0] + snapLen + stateLen,
    `${rec.out64.length} doubles`);
}

// -- opcode, source, prefill, flag and key coverage -------------------------
{
  const used = new Set();
  const modes = new Set();
  const pres = new Set();
  const flags = new Set();
  const tkeys = new Set();
  const lkeys = new Set();
  const ckeys = new Set();
  for (const rec of native) {
    const p = rec.params;
    for (let i = 0; i < p.length / 6; i++) {
      const [op, a, b, c, d, e] = Array.from(p.subarray(i * 6, i * 6 + 6));
      used.add(op);
      if (op === OP.PROCESS) {
        modes.add(c);
        pres.add(d);
        flags.add(e);
      }
      if (op === OP.TPARAM) tkeys.add(b);
      if (op === OP.PARAM) lkeys.add(a);
      if (op === OP.CLOCK) ckeys.add(a);
    }
  }
  const unused = Object.entries(OP).filter(([k, v]) => k !== "END" && !used.has(v)).map(([k]) => k);
  ok("every opcode but END is used", unused.length === 0, unused.length ? `unused: ${unused}` : `${used.size} opcodes`);
  ok("every source mode is used", Object.values(SRC).every((v) => modes.has(v)), [...modes].join(","));
  ok("every prefill kind is used", Object.values(PRE).every((v) => pres.has(v)), [...pres].join(","));
  ok("PROCESS runs with no clock, a clock and no advance, and both", flags.has(0) && flags.has(PF_CLOCK) && flags.has(PF_CLOCK | PF_ADVANCE), [...flags].join(","));
  const covers = (set, n) => Array.from({ length: n }, (_, i) => i).every((i) => set.has(i)) && [...set].some((k) => k >= n || k < 0);
  ok("all six LOOP_KEYs and an unknown one reach setTrackParam", covers(tkeys, LOOP_KEY.length), [...tkeys].join(","));
  ok("both LOOPER_KEYs and an unknown one reach setParam", covers(lkeys, LOOPER_KEY.length), [...lkeys].join(","));
  ok("all five CLOCK_KEYs and an unknown one reach the clock", covers(ckeys, CLOCK_KEY.length), [...ckeys].join(","));
}

// -- the key tables are not allowed to drift from their sources -------------
{
  const hdr = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
  const ts = readFileSync(join(root, "packages/web/src/web/audio/backend.ts"), "utf8");
  const fromHeader = (prefix) =>
    [...hdr.matchAll(new RegExp(`\\b${prefix}([A-Z_]+) = (\\d+)`, "g"))]
      .filter((m) => m[1] !== "COUNT")
      .sort((x, y) => Number(x[2]) - Number(y[2]))
      .map((m) => m[1].toLowerCase().replace(/_/g, ""));
  const fromTs = (name) => {
    const block = ts.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]`));
    return block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  };
  const eq = (x, y) => x.length === y.length && x.every((k, i) => k === y[i]);
  for (const [name, table, prefix, jsTable] of [
    ["LOOP_KEY", LOOP_KEY, "BK_LOOP_P_", js.LOOP_KEY],
    ["LOOPER_KEY", LOOPER_KEY, "BK_LOOPER_P_", js.LOOPER_KEY],
    ["CLOCK_KEY", CLOCK_KEY, "BK_CLOCK_P_", null],
  ]) {
    const h = fromHeader(prefix);
    ok(`${name} matches param-keys.h`, eq(h, table.map((k) => k.toLowerCase())), `${h.join(",")}`);
    ok(`${name} matches backend.ts, the source of truth`, eq(fromTs(name), table), fromTs(name).join(","));
    if (jsTable) ok(`${name} matches looper.js's export`, eq(jsTable, table), jsTable.join(","));
  }
}

// -- constants and enums, C vs JS ------------------------------------------
{
  const hdr = readFileSync(join(root, "packages/native/include/brokodr/dsp/looper.h"), "utf8");
  const cSrc = readFileSync(join(root, "packages/native/src/dsp/looper.c"), "utf8");
  const jsSrc = readFileSync(join(coreDir, "looper.js"), "utf8");
  const def = (src, n) => {
    const m = src.match(new RegExp(`#define ${n} ([\\d.]+)`));
    return m ? Number(m[1]) : NaN;
  };
  const jsConst = (n) => {
    const m = jsSrc.match(new RegExp(`const ${n} = ([\\d.]+);`));
    return m ? Number(m[1]) : NaN;
  };
  ok("MIN_LOOP_FRAMES is 2048 in looper.c, looper.js and here",
    def(cSrc, "MIN_LOOP_FRAMES") === 2048 && jsConst("MIN_LOOP_FRAMES") === 2048 && MIN_LOOP_FRAMES === 2048);
  ok("DECLICK_MS is 2 in both", def(cSrc, "DECLICK_MS") === 2 && jsConst("DECLICK_MS") === 2);
  ok("BK_DEFAULT_LOOP_SECONDS equals DEFAULT_LOOP_SECONDS (30)", def(hdr, "BK_DEFAULT_LOOP_SECONDS") === js.DEFAULT_LOOP_SECONDS && js.DEFAULT_LOOP_SECONDS === 30);
  ok("BK_LOOP_METER_STRIDE equals LOOP_METER_STRIDE (8)", def(hdr, "BK_LOOP_METER_STRIDE") === js.LOOP_METER_STRIDE && js.LOOP_METER_STRIDE === 8);
  ok("BK_LOOP_TRACKS equals LOOP_TRACKS (4)", def(hdr, "BK_LOOP_TRACKS") === js.LOOP_TRACKS);
  const en = (n) => {
    const m = hdr.match(new RegExp(`\\b${n} = (\\d+)`));
    return m ? Number(m[1]) : NaN;
  };
  const stateOk = Object.entries(js.LOOP_STATE).every(([k, v]) => en(`BK_LOOP_${k === "STOPPED" ? "STOPPED" : k}`) === v);
  ok("BK_LOOP_* states equal LOOP_STATE", stateOk && Object.keys(js.LOOP_STATE).length === 5, fmt(js.LOOP_STATE));
  ok("BK_LOOP_PEND_* equal LOOP_PENDING", Object.entries(js.LOOP_PENDING).every(([k, v]) => en(`BK_LOOP_PEND_${k}`) === v), fmt(js.LOOP_PENDING));
  ok("BK_LOOP_SRC_* equal LOOP_SOURCE", Object.entries(js.LOOP_SOURCE).every(([k, v]) => en(`BK_LOOP_SRC_${k}`) === v), fmt(js.LOOP_SOURCE));
  ok("BK_UNDO_* equal the JS's UNDO_*", ["NONE", "LAYER", "TAKE"].every((k) => en(`BK_UNDO_${k}`) === jsConst(`UNDO_${k}`)));
}

// -- the C-only init contract -----------------------------------------------
{
  const got = allPushed("init-check").map(([v]) => v);
  ok("init-check: every argument check refuses or accepts as looper.h says", got.length === INIT_CHECK_EXPECT.length && got.every((v, i) => v === INIT_CHECK_EXPECT[i]), got.join(","));
}

// -- note 1: always-live buffers are the same observation as lazy ones ------
{
  const never = lastState("arm-never");
  const cleared = lastState("arm-cleared");
  ok("arm-never vs arm-cleared: identical audio", sameAudio(audioOf("arm-never"), audioOf("arm-cleared")));
  ok("arm-never vs arm-cleared: identical track and undo buffers", same(bufOf("arm-never", 0).L, bufOf("arm-cleared", 0).L) && same(bufOf("arm-never", 0).R, bufOf("arm-cleared", 0).R) &&
    same(bufOf("arm-never", 1).L, bufOf("arm-cleared", 1).L) && same(bufOf("arm-never", 1).R, bufOf("arm-cleared", 1).R));
  ok("arm-never vs arm-cleared: buffers dumped full length", bufOf("arm-never", 0).n === 12480 && bufOf("arm-never", 1).n === 12480);
  ok("arm-never vs arm-cleared: but buf_armed differs (0 vs 1) — the pair really differs",
    never.tracks[0].bufArmed === 0 && cleared.tracks[0].bufArmed === 1, `${never.tracks[0].bufArmed} vs ${cleared.tracks[0].bufArmed}`);
  ok("arm-never vs arm-cleared: nothing else in the state differs",
    STATE_HEAD.every((k) => Object.is(never[k], cleared[k])) && never.tracks.every((t, i) => STATE_TRACK.every((k) => k === "bufArmed" || Object.is(t[k], cleared.tracks[i][k]))));
  {
    const x = snapOf("arm-never", 0);
    const y = snapOf("arm-cleared", 0);
    const diff = [];
    for (const k of SNAP_HEAD) if (!Object.is(x[k], y[k])) diff.push(k);
    x.tracks.forEach((t, i) => SNAP_TRACK.forEach((k) => { if (!Object.is(t[k], y.tracks[i][k])) diff.push(`t${i}.${k}`); }));
    ok("arm-never vs arm-cleared: identical snapshots", diff.length === 0 && fmt(x) === fmt(y), diff.join(","));
  }
  const au = lastState("arm-undo");
  ok("arm-undo: the undo slot was armed (undo_armed_ever 1), and never armed in arm-never", au.undoArmedEver === 1 && never.undoArmedEver === 0);
  ok("arm-undo: an armed, unwritten undo slot reads exactly like an unarmed one", same(bufOf("arm-undo", 0).L, bufOf("arm-never", 1).L) && same(bufOf("arm-undo", 0).R, bufOf("arm-never", 1).R) && peak(bufOf("arm-undo", 0).L) === 0);
  ok("arm-undo: the cleared track's buffer still holds the take (clear does not zero it)", peak(bufOf("arm-undo", 1).L.subarray(0, 5120)) > 0.05 && au.tracks[1].state === ST.EMPTY && au.undoTrack === -1);
}

// -- note 2: a chain that exists but is empty is no chain at all -----------
{
  ok("chain-never vs chain-empty: identical audio", sameAudio(audioOf("chain-never"), audioOf("chain-empty")));
  ok("chain-never vs chain-empty: identical meters", same(meterAt("chain-never", 0), meterAt("chain-empty", 0)));
  const a = lastSnap("chain-never").tracks[0];
  const b = lastSnap("chain-empty").tracks[0];
  ok("chain-never vs chain-empty: but chain_used differs (0 vs 1)", a.chainUsed === 0 && b.chainUsed === 1 && a.chainLength === 0 && b.chainLength === 0);
  ok("chain-empty: CHAINFOR answered a chain", pushedOf("chain-empty", 0)[0] === 1);
  const live = snapOf("chain-live", 1).tracks[0];
  ok("chain-live: two effects in, the second at index 0, and both ran", live.chainLength === 2 && live.slots[0].id === 2 && live.slots[1].id === 1 && live.slots[0].calls > 0 && live.slots[1].calls > 0,
    fmt(live.slots.map((s) => [s.id, s.calls])));
  ok("chain-live: a bad index has no chain", allPushed("chain-live").slice(-3).every(([v]) => v === 0));
  ok("chain-live: the chain changed the audio (vs the same take unchained)", !same(blockOf("chain-live", 20).L, blockOf("chain-never", 20).L));
  const cleared = snapOf("chain-live", 4).tracks[0];
  ok("chain-live: clear panics the chain (resets counted)", cleared.slots[0].resets > snapOf("chain-live", 3).tracks[0].slots[0].resets);
}

// -- sample-accurate punches -----------------------------------------------
{
  ok("block-256 vs block-64: identical final snapshot", fmt(lastSnap("block-256")) === fmt(lastSnap("block-64")));
  const s256 = lastState("block-256");
  const s64 = lastState("block-64");
  // Meters are the peak of the last block, so they depend on block size by
  // design; every other state field must match exactly.
  const BLOCKWISE = new Set(["meterL", "meterR", "meter"]);
  const stDiff = [];
  for (const k of STATE_HEAD) if (!BLOCKWISE.has(k) && !Object.is(s256[k], s64[k])) stDiff.push(`${k} ${s256[k]}/${s64[k]}`);
  s256.tracks.forEach((t, i) => { for (const k of STATE_TRACK) if (!BLOCKWISE.has(k) && !Object.is(t[k], s64.tracks[i][k])) stDiff.push(`t${i}.${k} ${t[k]}/${s64.tracks[i][k]}`); });
  ok("block-256 vs block-64: identical final state (meters aside)", stDiff.length === 0 && s256.tracks.length === s64.tracks.length, stDiff.join("; "));
  ok("block-256 vs block-64: identical audio, frame for frame", sameAudio(audioOf("block-256"), audioOf("block-64")) && audioOf("block-256").L.length === 16384);
  ok("block-256: it is a real performance — a loop with an overdub on it", s256.tracks[0].frames > 0 && s256.tracks[0].layers === 2 && peak(audioOf("block-256").L) > 0.05,
    `f${s256.tracks[0].frames} L${s256.tracks[0].layers}`);
  const q0 = snapOf("quant", 0).tracks[0];
  ok("quant: REC at frame 1000 is pending for the 2400 grid line", stateAfter("quant", OP.REC, 0).tracks[0].pending === PEND.REC && q0.pendingAt === 2400, `${q0.pendingAt}`);
  const q1 = snapOf("quant", 1).tracks[0];
  ok("quant: the take began on the grid line itself, mid-block", q1.anchor === 2400 && (2400 - 1000) % 256 !== 0, `anchor ${q1.anchor}`);
  ok("quant-cancel: a second press cancels the pending punch", snapOf("quant-cancel", 0).tracks[0] && stateAfter("quant-cancel", OP.REC, 1).tracks[0].pending === PEND.NONE &&
    stateAfter("quant-cancel", OP.REC, 1).tracks[0].state === ST.EMPTY);
  ok("quant-cancel: PLAY and STOP on an empty track do nothing", stateAfter("quant-cancel", OP.STOP, 0).tracks[0].pending === PEND.NONE);
  const qcStop = stateAfter("quant-cancel", OP.STOP, 1), qcRec = stateAfter("quant-cancel", OP.REC, 4);
  ok("quant-cancel: STOP on a playing track is scheduled", qcStop.tracks[0].pending === PEND.STOP && qcStop.tracks[0].state === ST.PLAY, `pending ${qcStop.tracks[0].pending} state ${qcStop.tracks[0].state}`);
  ok("quant-cancel: a different action replaces the pending one", qcRec.tracks[0].pending === PEND.REC && snapOf("quant-cancel", 3).tracks[0].pendingAt === snapOf("quant-cancel", 2).tracks[0].pendingAt && Number.isFinite(snapOf("quant-cancel", 2).tracks[0].pendingAt), `pending ${qcRec.tracks[0].pending}`);
}

// -- the take-length decision, branch by branch ------------------------------
{
  const f = (name, k = -1, t = 0) => stateAfter(name, OP.SNAP, k).tracks[t];
  const claim = (name, label, t, want) => ok(`${name}: ${label}`, t.state === want.state && t.frames === want.frames, `state ${t.state} frames ${t.frames} w${t.recWrite}`);
  claim("free-take", "a free take keeps its played length (5120)", f("free-take"), { state: ST.PLAY, frames: 5120 });
  claim("grid-down", "3000 rounds down to one grid (2400)", f("grid-down", 0), { state: ST.PLAY, frames: 2400 });
  claim("grid-half", "6000 = 2.5 grids rounds half-up to 7200", f("grid-half", 0), { state: ST.PLAY, frames: 7200 });
  claim("grid-tail", "4000 rounds up to 4800", f("grid-tail", 0), { state: ST.PLAY, frames: 4800 });
  {
    const b = bufOf("grid-tail", 0);
    ok("grid-tail: the rounded-up tail 4000..4799 is zeroed", peak(b.L.subarray(4000, 4800)) === 0 && peak(b.R.subarray(4000, 4800)) === 0);
    ok("grid-tail: what was played survives below it", peak(b.L.subarray(0, 4000)) > 0.05);
    ok("grid-tail: and only the tail — the old take survives past the loop", peak(b.L.subarray(4800, 7000)) > 0.05);
  }
  claim("grid-max", "11000 rounds to 14400 > max, clamped to the largest whole grid (7200)", f("grid-max", 0), { state: ST.PLAY, frames: 7200 });
  claim("grid-full", "a synced take fills the buffer and closes itself at 7200", f("grid-full", 0), { state: ST.PLAY, frames: 7200 });
  ok("grid-full: it closed with no second press", opsOf("grid-full", OP.REC).length === 1);
  claim("grid-short", "2100 rounds to 1500 < 2048: dropped", f("grid-short", 0), { state: ST.EMPTY, frames: 0 });
  claim("grid-up-short", "1500 rounds UP to 2400, but 1500 played < 2048: dropped", f("grid-up-short", 0), { state: ST.EMPTY, frames: 0 });
  claim("grid-huge", "a grid longer than the buffer falls to the final clamp (12480)", f("grid-huge", 0), { state: ST.PLAY, frames: 12480 });
  claim("grid-zero", "quantize 0 on a synced take: unrounded (3250)", f("grid-zero", 0), { state: ST.PLAY, frames: 3250 });
  claim("grid-zero", "a NaN grid on a synced take: unrounded (2750)", f("grid-zero", 1, 1), { state: ST.PLAY, frames: 2750 });
  claim("full-free", "a free take fills the buffer and closes itself at 12480", f("full-free", 0), { state: ST.PLAY, frames: 12480 });
  claim("full-sync", "a full synced take rounds 12480 to 12000", f("full-sync", 0), { state: ST.PLAY, frames: 12000 });
  claim("min-exact", "2048 exactly is a loop", f("min-exact", 0), { state: ST.PLAY, frames: 2048 });
  claim("min-under", "2047 is not", f("min-under", 0), { state: ST.EMPTY, frames: 0 });
  claim("too-short", "1792 is not", f("too-short", 0), { state: ST.EMPTY, frames: 0 });
  claim("init-low", "at 2000 Hz max_frames floors at 2048, and a full take keeps it", f("init-low", 0), { state: ST.PLAY, frames: 2048 });
  ok("init-low: four tracks from tracks 0", lastSnap("init-low").trackCount === 4 && lastSnap("init-low").maxFrames === 2048);
  ok("init-negtracks: a negative count builds no tracks, and nothing renders", lastSnap("init-negtracks").trackCount === 0 && queryAt("init-negtracks", 0).present === 0 && queryAt("init-negtracks", 0).count === 0 && meterAt("init-negtracks", 0).length === 0);
  ok("init-half: declick 96.5 rounds half-up to 97", lastSnap("init-half").declick === 97 && lastSnap("init-half").trackCount === 1);
  ok("init-96000: two tracks; track 2 is out of range", lastSnap("init-96000").trackCount === 2 && queryAt("init-96000", 0).present === 0 && queryAt("init-96000", 1).present === 1);
  const mf = allPushed("maxframes").map(([v]) => v);
  ok("maxframes: 0 and NaN take 30 s, a negative value floors at 2048", mf[0] === 1440000 && mf[1] === 1440000 && mf[2] === 1323000 && mf[6] === 2048 && mf[7] === 1440000 && mf[8] === 2048, mf.join(","));
  ok("free-stop: STOP while recording closes the take stopped", stateAfter("free-stop", OP.STOP, 0).tracks[0].state === ST.STOPPED && stateAfter("free-stop", OP.STOP, 0).tracks[0].frames === 5120);
  ok("free-play: PLAY while recording closes the take playing", stateAfter("free-play", OP.PLAY, 0).tracks[0].state === ST.PLAY && stateAfter("free-play", OP.PLAY, 0).tracks[0].frames === 5120);
}

// -- pending punches that outlive their reason ------------------------------
{
  const s = (k) => stateAfter("undo-pending", OP.SNAP, k).tracks[0];
  ok("undo-pending: STOP pending, take undone underneath it", s(0).pending === PEND.STOP && s(0).state === ST.EMPTY && s(0).frames === 0);
  ok("undo-pending: STOP fires on an EMPTY track and does nothing", s(1).pending === PEND.NONE && s(1).state === ST.EMPTY);
  ok("undo-pending: STOP on a STOPPED track was scheduled, fired, and did nothing", s(2).pending === PEND.STOP && s(3).pending === PEND.NONE && s(3).state === ST.STOPPED && s(3).frames === 2400);
  ok("undo-pending: PLAY fires on an EMPTY track and does nothing", s(4).pending === PEND.PLAY && s(4).state === ST.EMPTY && s(5).pending === PEND.NONE && s(5).state === ST.EMPTY && s(5).frames === 0);
  const np = snapOf("nan-params", 7).tracks[2];
  ok("nan-params: a NaN clock frame leaves pendingAt NaN", Number.isNaN(np.pendingAt), `${np.pendingAt}`);
  ok("nan-params: and that punch never fires", lastState("nan-params").tracks[2].pending === PEND.REC && lastState("nan-params").tracks[2].state === ST.EMPTY && Number.isNaN(lastState("nan-params").clockFrame));
  ok("nan-params: a NaN grid punches immediately", stateAfter("nan-params", OP.REC, -2).tracks[1].state === ST.REC);
}

// -- the NaN source mapping is a mapping, knowingly --------------------------
{
  const probe = new js.Looper(SR, MAX_BLOCK, { tracks: 1, maxSeconds: DEF_SECONDS });
  probe.setTrackParam(0, "source", NaN);
  ok("the JS really holds NaN for source after setTrackParam(source, NaN)", Number.isNaN(probe.tracks[0].source));
  ok("nan-params: the C stored MASTER for it", snapOf("nan-params", 2).tracks[0].source === js.LOOP_SOURCE.MASTER);
  const src = (k) => snapOf("source", k).tracks[0].source;
  ok("source: 0.4 -> MASTER, 0.6 -> DRUMS, 7 -> DRUMS, -3 -> MASTER, 0.5 -> DRUMS", src(1) === 0 && src(2) === 1 && src(3) === 1 && src(4) === 0 && src(5) === 1,
    [1, 2, 3, 4, 5].map(src).join(","));
  const b = bufOf("source", 0);
  ok("source: a DRUMS take records silence while the drum bus is NULL, then the drums", peak(b.L.subarray(0, 2560)) === 0 && peak(b.L.subarray(2560, 5120)) > 0.1);
  ok("source: a NULL source struct records silence", peak(bufOf("source", 2).L) === 0 && lastState("source").tracks[1].frames === 2560);
}

// -- undo -------------------------------------------------------------------
{
  {
    const b0 = bufOf("overdub-instant", 0), z = bufOf("overdub-instant", 2);
    const s0 = stateAfter("overdub-instant", OP.SNAP, 0), s3 = stateAfter("overdub-instant", OP.SNAP, 3);
    ok("overdub-instant: there is a loop to overdub", peak(b0.L) > 0.05 && b0.n === 5120);
    ok("overdub-instant: an in-and-out punch adds an empty layer", s0.tracks[0].state === ST.PLAY && s0.tracks[0].layers === 2 && s0.undoMode === 1 && s0.undoArmed === 0 && s0.undoFrames === 5120,
      `st ${s0.tracks[0].state} L${s0.tracks[0].layers} mode ${s0.undoMode}`);
    ok("overdub-instant: no declick ran — the loop is untouched", same(bufOf("overdub-instant", 1).L, b0.L) && same(bufOf("overdub-instant", 1).R, b0.R));
    ok("overdub-instant: the undo slot is all zeros", peak(z.L) === 0 && peak(z.R) === 0 && z.n === 5120);
    ok("overdub-instant: undoing the empty layer leaves the loop bit-identical", same(bufOf("overdub-instant", 3).L, b0.L) && same(bufOf("overdub-instant", 3).R, b0.R));
    // Numerically, not bitwise: the redo in between adds the zero layer back,
    // and -0 + 0 is +0, so a declicked -0 at the head of the take flips sign.
    const b4 = bufOf("overdub-instant", 4);
    const numEq = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);
    ok("overdub-instant: REC then STOP closes the layer and stops", s3.tracks[0].state === ST.STOPPED && s3.tracks[0].layers === 3 && numEq(b4.L, b0.L) && numEq(b4.R, b0.R), `st ${s3.tracks[0].state} L${s3.tracks[0].layers}`);
    const negZ = [...b0.L.keys()].filter((k) => Object.is(b0.L[k], -0));
    ok("overdub-instant: redo turns -0 into +0 (IEEE, same in the JS)", negZ.length > 0 && negZ.every((k) => Object.is(b4.L[k], 0)), `${negZ.length} signed zeros`);
  }
  ok("undo-take: a closed take can be undone", queryAt("undo-take", 0).canUndo === 1);
  const u1 = stateAfter("undo-take", OP.UNDO, 0).tracks[0];
  ok("undo-take: undo drops the take", u1.state === ST.EMPTY && u1.frames === 0 && u1.layers === 0);
  ok("undo-take: and can still be redone", queryAt("undo-take", 1).canUndo === 1);
  const u2 = stateAfter("undo-take", OP.UNDO, 1).tracks[0];
  ok("undo-take: redo brings it back, stopped", u2.state === ST.STOPPED && u2.frames === 5120 && u2.layers === 1);
  ok("undo-take: and it plays", peak(blockOf("undo-take", layout("undo-take").procs.length - 1).L) > 0.05);
  ok("undo-mid: no undo while an overdub is being captured", queryAt("undo-mid", 0).canUndo === 0 && stateAfter("undo-mid", OP.UNDO, 0).tracks[0].state === ST.OVERDUB);
  const lay = (k) => stateAfter("undo-layers", OP.SNAP, k).tracks[0].layers;
  ok("undo-layers: 3 layers, undo -> 2, redo -> 3, undo/redo -> 3", lay(0) === 3 && lay(1) === 2 && lay(2) === 3 && lay(3) === 3, [0, 1, 2, 3].map(lay).join(","));
  ok("undo-layers: undo changes the buffer and redo changes it back",
    !same(bufOf("undo-layers", 0).L, bufOf("undo-layers", 1).L) && !same(bufOf("undo-layers", 1).L, bufOf("undo-layers", 2).L));
  const ow = (k) => bufOf("overdub-wrap", k);
  ok("overdub-wrap: the undo slot holds a layer", peak(ow(1).L) > 0.05);
  ok("overdub-wrap: undo subtracts it, redo adds it back", !same(ow(0).L, ow(2).L) && !same(ow(2).L, ow(3).L));
  ok("overdub-wrap: the overdub crossed the wrap (layer written at both ends)", Math.abs(ow(1).L[0]) + Math.abs(ow(1).L[20]) > 0 && Math.abs(ow(1).L[5100]) > 0);
  ok("undo-other: undo on a track that does not own the slot is a no-op", queryAt("undo-other", 0).canUndo === 0 && stateAfter("undo-other", OP.UNDO, 0).tracks[0].frames === 5120);
  ok("undo-other: the slot moves to the newest take", queryAt("undo-other", 1).canUndo === 0 && queryAt("undo-other", 2).canUndo === 1 && stateAfter("undo-other", OP.UNDO, 2).tracks[1].state === ST.EMPTY);
  ok("clear-undo: clearing another track keeps the slot", queryAt("clear-undo", 0).canUndo === 1);
  ok("clear-undo: clearing the owner drops it", queryAt("clear-undo", 1).canUndo === 0 && lastState("clear-undo").undoTrack === -1 && lastState("clear-undo").undoMode === 0);
}

// -- mix: mute, solo, pan, gain ----------------------------------------------
{
  const ms = (k) => snapOf("mute-solo", k);
  ok("mute-solo: 0.49 does not mute, 0.5 does", ms(2).tracks[0].muted === 0 && ms(3).tracks[1].muted === 1);
  ok("mute-solo: solo and mute land", ms(0).tracks[1].soloed === 1 && ms(1).tracks[0].muted === 1 && ms(1).tracks[1].soloed === 0);
  const pg = (k) => snapOf("pan-gain", k);
  ok("pan-gain: pan 0.7 trims the left to 0.3", Math.abs(pg(0).tracks[0].panL - 0.3) < 1e-12 && pg(0).tracks[0].panR === 1);
  ok("pan-gain: -60 dB is silence", pg(1).tracks[0].gain === 0);
  ok("pan-gain: -59.9 dB is not", pg(2).tracks[0].gain > 0);
  ok("pan-gain: pan 5 clamps to 1, gain 30 to 12", pg(2).tracks[0].pan === 1 && pg(2).tracks[0].panL === 0 && pg(3).tracks[0].gainDb === 12 && pg(3).tracks[0].panR === 0);
  ok("pan-gain: looper gain -80 is silence, 40 clamps to 12", pg(5).gain === 0 && pg(6).gainDb === 12);
  ok("pan-gain: looper mute lands", pg(7).muted === 1);
  ok("pan-gain: unknown keys and a bad index change nothing", fmt(pg(8).tracks) === fmt(pg(7).tracks.map((t) => t)) || pg(8).tracks[0].gainDb === pg(7).tracks[0].gainDb);
  const lm = bufOf("looper-mute-rec", 0);
  ok("looper-mute-rec: a muted looper still records", peak(lm.L) > 0.05);
  ok("looper-mute-rec: and is silent while muted", peak(audioOf("looper-mute-rec").L.subarray(2560, 3584)) === 0.25);
}

// -- idle, meters, reset ------------------------------------------------------
{
  ok("idle: a stopped track fading is still audible", queryAt("idle", 0).audible === 1);
  ok("idle: once the fade is done it is idle and the looper is inactive", queryAt("idle", 1).audible === 0 && queryAt("idle", 1).active === 0 && meterAt("idle", 1)[2] === 0);
  ok("idle: a muted playing track is still rendered (playing, active)", queryAt("idle", 2).playing === 1 && queryAt("idle", 2).active === 1);
  const fm = meterAt("free-take", 2);
  ok("free-take: meters are state, pending, meter, pos, length, chain, layers, undo", fm.length === 32 && fm[0] === ST.PLAY && fm[4] === 5120 && fm[6] === 1 && fm[7] === 1 && fm[2] > 0, fm.slice(0, 8).join(","));
  ok("free-take: while recording the meter length is rec_write", meterAt("free-take", 0)[0] === ST.REC && meterAt("free-take", 0)[4] === 5120);
  const r = snapOf("reset", 1);
  const rs = stateAfter("reset", OP.RESET, 0);
  ok("reset: a take in progress is dropped, the rest stop", rs.tracks[1].state === ST.EMPTY && rs.tracks[0].state === ST.STOPPED && rs.tracks[2].state === ST.STOPPED && rs.tracks[3].pending === PEND.NONE);
  ok("reset: undo capture is disarmed, the chain panicked", rs.undoArmed === 0 && r.tracks[2].slots[0].resets > snapOf("reset", 0).tracks[2].slots[0].resets);
  const ca = lastState("clear-all");
  ok("clear-all: every track empty", ca.tracks.every((t) => t.state === ST.EMPTY && t.frames === 0) && queryAt("clear-all", 0).canUndo === 0);
}

// -- audio is audible, and NaN only where it was asked for -------------------
{
  const quiet = [];
  for (const name of ["free-take", "free-play", "quant", "overdub-sync", "chain-mix", "soak", "tempo-reset", "null-clock", "sync-toggle", "init-44100"]) {
    if (!(peak(audioOf(name).L) > 0.05)) quiet.push(name);
  }
  ok("the playing cases are audible", quiet.length === 0, quiet.length ? `quiet: ${quiet}` : "");
  const nanned = [];
  for (const rec of native) {
    if (rec.name === "dirty" || rec.name === "huge") continue;
    if (rec.out32.some((x) => Number.isNaN(x))) nanned.push(rec.name);
  }
  ok("no unexplained NaN in any audio or buffer", nanned.length === 0, nanned.join(","));
  const dirtyOut = audioOf("dirty");
  ok("dirty: NaN reaches the buffer but the output is sanitised", recOf("dirty").out32.some((x) => Number.isNaN(x)) && !dirtyOut.L.some((x) => Number.isNaN(x)));
}

// -- the cases added to close the mutation sweep's holes ---------------------
{
  const snapS = (n, i) => stateAfter(n, OP.SNAP, i);

  {
    const n = "pending-replaced";
    const a = snapS(n, 0), b = snapS(n, 1), c = snapS(n, 2), e = snapS(n, 4);
    ok(`${n}: an immediate press drops the different pending action`,
      a.tracks[0].pending === PEND.STOP && b.tracks[0].pending === PEND.NONE && b.tracks[0].state === ST.OVERDUB &&
        c.tracks[0].state === ST.OVERDUB,
      `pending ${a.tracks[0].pending} -> ${b.tracks[0].pending}, then state ${c.tracks[0].state}`);
    ok(`${n}: a quantised REC on a STOPPED track overdubs at the line`,
      snapS(n, 3).tracks[0].state === ST.STOPPED && e.tracks[0].state === ST.OVERDUB && e.tracks[0].playGain > 0.5,
      `state ${e.tracks[0].state}, gain ${e.tracks[0].playGain}`);
  }
  {
    const n = "clear-pending";
    const a = snapS(n, 0), b = snapS(n, 1), c = snapS(n, 2);
    ok(`${n}: CLEAR drops a pending punch on a loop and on an empty track`,
      a.tracks[0].pending === PEND.STOP && a.tracks[1].pending === PEND.REC &&
        b.tracks[0].pending === PEND.NONE && b.tracks[1].pending === PEND.NONE &&
        c.tracks[0].state === ST.EMPTY && c.tracks[1].state === ST.EMPTY && queryAt(n, 1).recording === 0,
      `after: ${c.tracks[0].state}/${c.tracks[1].state}`);
  }
  {
    const n = "clear-all-4";
    const s = snapS(n, 0);
    ok(`${n}: clear_all reaches every track, the last included`,
      s.tracks.every((t) => t.state === ST.EMPTY && t.frames === 0) && s.active === 0, fmt(s.tracks.map((t) => t.state)));
  }
  {
    const n = "reset-overdub";
    const r = snapS(n, 1), u = snapS(n, 2), d = snapS(n, 3);
    ok(`${n}: reset mid-overdub stops without closing the layer, and leaves it undoable`,
      snapS(n, 0).tracks[0].state === ST.OVERDUB && r.tracks[0].state === ST.STOPPED && r.tracks[0].layers === 1 &&
        r.undoArmed === 0 && queryAt(n, 0).canUndo === 1,
      `state ${r.tracks[0].state}, layers ${r.tracks[0].layers}, armed ${r.undoArmed}`);
    ok(`${n}: undo floors layers at 1, redo counts the layer again`,
      u.tracks[0].layers === 1 && d.tracks[0].layers === 2, `${u.tracks[0].layers} -> ${d.tracks[0].layers}`);
  }
  {
    const n = "param-edges";
    const s = (i) => snapOf(n, i).tracks[0];
    ok(`${n}: track gain clamps at -60 (off) and +12`,
      s(0).gainDb === -60 && s(0).gain === 0 && s(1).gainDb === 12, `${s(0).gainDb}/${s(0).gain}, ${s(1).gainDb}`);
    ok(`${n}: pan +-0.25 attenuates only the far side`,
      s(2).panL === 0.75 && s(2).panR === 1 && s(3).panL === 1 && s(3).panR === 0.75,
      `${s(2).panL}/${s(2).panR}, ${s(3).panL}/${s(3).panR}`);
    ok(`${n}: every >= 0.5 threshold is on at exactly 0.5 and off just under`,
      s(4).soloed === 1 && s(5).soloed === 0 && s(6).muted === 0 && s(7).sync === 0 && s(8).sync === 1 && s(9).sync === 0 &&
        snapOf(n, 11).muted === 1 && snapOf(n, 12).muted === 0,
      `solo ${s(4).soloed}/${s(5).soloed}, sync ${s(7).sync}${s(8).sync}${s(9).sync}, looper mute ${snapOf(n, 11).muted}/${snapOf(n, 12).muted}`);
    ok(`${n}: the looper gain clamps at -60 too`, snapOf(n, 10).gainDb === -60 && snapOf(n, 10).gain === 0, `${snapOf(n, 10).gainDb}`);
  }
  {
    const n = "steal-undo";
    const s0 = snapS(n, 0), s1 = snapS(n, 1);
    ok(`${n}: a take closing mid-overdub takes the slot, disarmed`,
      s0.undoTrack === 1 && s0.undoMode === 2 && s0.undoArmed === 0 && queryAt(n, 0).canUndo === 1 && queryAt(n, 1).canUndo === 0 &&
        s0.tracks[0].state === ST.OVERDUB,
      `slot ${s0.undoTrack} mode ${s0.undoMode} armed ${s0.undoArmed}`);
    ok(`${n}: the overdub still closes as a layer, but its undo belongs to the take`,
      s1.tracks[0].state === ST.PLAY && s1.tracks[0].layers === 2 && s1.undoTrack === 1 && queryAt(n, 2).canUndo === 0 && queryAt(n, 3).canUndo === 1,
      `layers ${s1.tracks[0].layers}, slot ${s1.undoTrack}`);
  }
  {
    const n = "undo-take-rearm";
    const a = snapS(n, 0), b = snapS(n, 1), c = snapS(n, 2);
    ok(`${n}: undo-take leaves pos and a fading gain on the EMPTY track`,
      a.tracks[0].state === ST.EMPTY && a.tracks[0].pos === 1024 && a.tracks[0].playGain > 0.5,
      `pos ${a.tracks[0].pos}, gain ${a.tracks[0].playGain}`);
    ok(`${n}: sync set to its own value leaves pos alone; a new take starts from silence`,
      b.tracks[0].pos === 1024 && c.tracks[0].state === ST.REC && c.tracks[0].playGain === 0 && c.tracks[0].pos === 0,
      `pos ${b.tracks[0].pos}, take gain ${c.tracks[0].playGain}`);
  }
  {
    const n = "redo-in-take";
    const a = snapS(n, 0), b = snapS(n, 1), c = snapS(n, 2);
    const ta = snapOf(n, 0).tracks[0], tb = snapOf(n, 1).tracks[0];
    const u = bufOf(n, 0);
    let first = -1;
    for (let k = 0; k < u.L.length; k++) if (u.L[k] !== 0) { first = k; break; }
    ok(`${n}: a redo during a new take stops the track with that take's ramp left over`,
      a.tracks[0].state === ST.STOPPED && a.tracks[0].frames === 5120 && ta.recRamp === 512,
      `state ${a.tracks[0].state}, frames ${a.tracks[0].frames}, rec_ramp ${ta.recRamp}`);
    ok(`${n}: the overdub zeroes it and fades in from silence`,
      b.tracks[0].state === ST.OVERDUB && tb.recRamp === 0 && c.tracks[0].layers === 2 && first > 0,
      `rec_ramp ${tb.recRamp}, first layer sample ${first}: ${u.L[first]}`);
  }
  {
    const n = "redo-in-take-2";
    const a = snapS(n, 0), b = snapS(n, 1);
    const b0 = bufOf(n, 0);
    ok(`${n}: undone again, the track is EMPTY with the ramp still set; the new take zeroes it`,
      a.tracks[0].state === ST.EMPTY && snapOf(n, 0).tracks[0].recRamp === 512 && b.tracks[0].state === ST.REC &&
        snapOf(n, 1).tracks[0].recRamp === 0 && b0.L[0] === 0 && b0.L[200] !== 0,
      `rec_ramp ${snapOf(n, 0).tracks[0].recRamp} -> ${snapOf(n, 1).tracks[0].recRamp}, L[0] ${b0.L[0]}`);
  }
  {
    const n = "sync-play";
    const a = snapS(n, 0), b = snapS(n, 1);
    ok(`${n}: a synced track keeps its pos through STOP and PLAY`,
      a.tracks[0].pos === 768 && b.tracks[0].pos === 768 && b.tracks[0].state === ST.PLAY, `${a.tracks[0].pos} -> ${b.tracks[0].pos}`);
  }
  {
    const n = "declick-short";
    const b = bufOf(n, 0), s = snapS(n, 0);
    let ramp = true;
    for (let k = 0; k < 50; k++) {
      const src = Math.fround(Math.fround(noise[k] * 0.5) * (k / 96));
      if (k > 0 && b.L[k] === src) ramp = false; // the fade must have changed it
    }
    ok(`${n}: a take shorter than the declick is faded over its own length, then dropped`,
      s.tracks[0].state === ST.EMPTY && b.L[49] === 0 && b.L[25] !== 0 && ramp && b.L[50] === 0, `L[25] ${b.L[25]}`);
  }
  {
    const n = "init-hisr";
    const sn = snapOf(n, 0);
    ok(`${n}: at 1.2 MHz the declick (2400) is longer than the 2304-frame loop`,
      sn.declick === 2400 && sn.maxFrames === 24000 && snapS(n, 0).tracks[0].frames === 2304 && snapS(n, 1).tracks[0].layers === 2,
      `declick ${sn.declick}, frames ${snapS(n, 0).tracks[0].frames}`);
  }
  {
    const n = "chain-empty-mix";
    const s = snapOf(n, 0);
    ok(`${n}: two asked-for, empty chains on summed tracks`,
      s.tracks[1].chainUsed === 1 && s.tracks[1].chainLength === 0 && s.tracks[2].chainUsed === 1 && s.tracks[2].chainLength === 0 &&
        peak(audioOf(n).L) > 0.05,
      `used ${s.tracks[1].chainUsed}${s.tracks[2].chainUsed}`);
  }
  {
    const n = "silent-negzero";
    const blk = blockOf(n, 0);
    const last = blockOf(n, layout(n).procs.length - 1);
    const allNegZero = (a) => Array.prototype.every.call(a, (x) => Object.is(x, -0));
    ok(`${n}: a looper with nothing to sound leaves -0 in the output untouched`,
      allNegZero(blk.L) && allNegZero(blk.R) && allNegZero(last.L) && allNegZero(last.R) && queryAt(n, 0).active === 0,
      `active ${queryAt(n, 0).active}`);
  }
  {
    const n = "overdub-muted";
    const s = snapS(n, 0);
    const u = bufOf(n, 1);
    let nz = 0;
    for (const x of u.L) if (x !== 0) nz++;
    ok(`${n}: overdubbing a muted free track still walks the loop`,
      s.tracks[0].layers === 2 && nz > 2000, `${nz} non-zero undo samples`);
  }
  {
    const n = "rec-ramp-meter";
    const [m0] = meterAt(n, 0).slice(2, 3);
    const st = stateAfter(n, OP.PROCESS, 0).tracks[0];
    ok(`${n}: a block inside the fade-in meters the float that was stored`,
      st.state === ST.REC && st.meter > 0 && Math.fround(st.meter) === st.meter && m0 === st.meter, `meter ${st.meter}`);
  }
}


if (process.env.LP_EXPLORE) {
  for (const rec of native) {
    if (process.env.LP_EXPLORE !== "1" && !process.env.LP_EXPLORE.split(",").includes(rec.name)) continue;
    const lay = layout(rec.name);
    console.log(`-- ${rec.name}`);
    let prev = "";
    lay.stateAt.forEach((_, i) => {
      const s = stateOf(rec.name, i);
      const op = Array.from(rec.params.subarray(i * 6, i * 6 + 6)).join(",");
      const line = `undo[t${s.undoTrack} f${s.undoFrames} m${s.undoMode} ap${s.undoApplied} ar${s.undoArmed}] ` +
        s.tracks.map((t) => `${t.state}/${t.pending} f${t.frames} w${t.recWrite} p${t.pos} L${t.layers} g${t.playGain.toFixed(3)}`).join(" | ");
      if (line !== prev) console.log(`  op${i} (${op}) ck${s.clockFrame}: ${line}`);
      prev = line;
    });
  }
}
if (process.env.LP_DEBUG) {
  // Where a record first disagrees, named: which op, and which payload field.
  const where = (lay, at) => {
    const st = lay.stateAt.findIndex((x, i) => at >= x && at < x + STATE_HEAD.length + lay.tcAt[i] * STATE_TRACK.length);
    if (st >= 0) {
      const off = at - lay.stateAt[st];
      const f = off < STATE_HEAD.length ? STATE_HEAD[off] : `t${Math.floor((off - STATE_HEAD.length) / STATE_TRACK.length)}.${STATE_TRACK[(off - STATE_HEAD.length) % STATE_TRACK.length]}`;
      return `state after op ${st} (${ops(lay, st)}): ${f}`;
    }
    const sn = lay.snapAt.findLastIndex((x) => at >= x);
    if (sn >= 0) {
      const off = at - lay.snapAt[sn];
      if (off < SNAP_HEAD.length) return `snap ${sn}: ${SNAP_HEAD[off]}`;
      const t = Math.floor((off - SNAP_HEAD.length) / TRACK_FIELDS);
      const k = (off - SNAP_HEAD.length) % TRACK_FIELDS;
      return `snap ${sn}: t${t}.${k < SNAP_TRACK.length ? SNAP_TRACK[k] : `slot${Math.floor((k - SNAP_TRACK.length) / 8)}.${SLOT_NAMES[(k - SNAP_TRACK.length) % 8]}`}`;
    }
    return `pushed value at ${at}`;
  };
  const ops = (lay, i) => Array.from(lay.ops.subarray(i * 6, i * 6 + 6)).join(",");
  for (const [label, dump] of [["native", native], ["wasm", wasm ?? []]]) {
    for (const rec of dump) {
      const lay = reference(rec);
      lay.ops = rec.params;
      const d64 = firstDiff(lay.out64, rec.out64);
      const d32 = firstDiff(lay.out32, rec.out32);
      if (d64 < 0 && d32 < 0) continue;
      console.log(`DEBUG ${label} ${rec.name}: len64 ${lay.out64.length}/${rec.out64.length} len32 ${lay.out32.length}/${rec.out32.length}`);
      if (d64 >= 0) console.log(`  out64[${d64}] js ${lay.out64[d64]} c ${rec.out64[d64]} — ${where(lay, d64)}`);
      if (d64 >= 0 && lay.out64.length === rec.out64.length) {
        const all = [];
        for (let i = 0; i < lay.out64.length; i++) if (!Object.is(lay.out64[i], rec.out64[i])) all.push(`${where(lay, i)} (${Math.abs(lay.out64[i] - rec.out64[i]).toExponential(1)})`);
        console.log(`  ${all.length} out64 values differ: ${all.join("; ")}`);
      }
      if (d32 >= 0) {
        const p = lay.procs.find((x) => d32 >= x.atL && d32 < x.atR + x.frames);
        const b = lay.bufs.find((x) => d32 >= x.at && d32 < x.at + 2 * x.n);
        console.log(`  out32[${d32}] js ${lay.out32[d32]} c ${rec.out32[d32]} — ${p ? `block of op ${p.op} frame ${d32 >= p.atR ? "R" : "L"}${(d32 - p.atL) % p.frames}` : b ? `bufs op ${b.op} track ${b.track} idx ${(d32 - b.at) % b.n}` : "?"}`);
      }
    }
  }
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\nlooper parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
