/**
 * Parity oracle for the C port of dsp/core/drum-rack.js (Phase 5, route (c)).
 *
 * Same four steps as every module before it, on the shared plumbing in
 * scripts/lib/parity-stream.mjs:
 *
 *   1. build the C natively and run the battery;
 *   2. build the same source to wasm with emscripten and run it under Node;
 *   3. replay the identical battery through the original drum-rack.js;
 *   4. diff native against wasm.
 *
 * The battery lives in packages/native/tests/parity-drum-rack.c and only
 * there. Each record carries its whole command script in its params, and this
 * file interprets that script rather than keeping a copy of it. Read that
 * file's header first: it explains why every pad's sample is salted
 * differently, why the test effect is synthetic, why the script reaches into
 * the pad chains, and why the destination block is prefilled.
 *
 * This is the first module whose JS needs TWO probe copies rather than one.
 * drum-rack.js imports Chain, and chain.js imports createEffect from the
 * effects registry — a registry full of real effects this battery must not
 * pull in. So chain.js is copied with its import rewritten to this file's
 * factory, and drum-rack.js is copied with its `./chain.js` import pointed at
 * that copy. Both copies live beside the originals so every other relative
 * import still resolves, both substitutions are asserted to have matched
 * exactly once, and both are removed in a finally.
 *
 * Four things this file has to mirror by hand, because the C documents them in
 * comments and there is no shared source of truth to import:
 *
 *   - the opcode, buffer-kind and prefill-kind tables (OP / BUF / PRE below);
 *   - build_buf()'s salt, its two hand-made buffers, and its persistent
 *     per-pad storage. That storage matters: the C hands the rack a borrowed
 *     pointer into pad_buf[p][l], so a later SETBUF landing on the same
 *     masked slot rewrites a buffer the rack is still reading. Allocating a
 *     fresh array per SETBUF here would NOT reproduce that, so this file
 *     keeps the same sixteen-by-four table and writes into it;
 *   - tfx, the test effect, down to the fields the snapshot reports and the
 *     absence of setCarrierBus — the C's vtable has NULL there because the
 *     rack never wires a carrier bus into a pad chain, and an effect with the
 *     method here would take chain.js's other branch;
 *   - push_state() and push_snap()'s field order, which is the payload
 *     contract. A field inserted on one side and not the other shows up as a
 *     parity failure on every record, which is the intended failure mode.
 *
 * On param keys: DrumRack.setParam and setPadParam take strings, because the
 * worklet hands them strings; the C takes the wire indices the command ring
 * carries. The script's key columns are those indices, and DRUM_KEY / PAD_KEY
 * turn them back into names, so a reordering on either side reads as a parity
 * failure rather than as a silently wrong knob. Both tables are checked
 * against both of their real sources — the generated param-keys.h and
 * backend.ts — in the sanity section, so this file's copies cannot drift.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAndRun,
  compareToJs,
  compareToolchains,
  createChecker,
  fillSignal,
} from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

/*
 * Bit-identity baselines, pinned rather than printed.
 *
 * libm is in this module's path the same way it is in drum-voice's, and for
 * the same reasons: sixteen DrumVoice underneath mean cos/sin for the pan law,
 * exp for the two envelope coefficients and pow for the pitch ratio, and the
 * rack's own gain is dbToGain, which is another pow. All of them are
 * control-rate, and all of them scale every sample that follows, so a
 * last-place disagreement between V8's and glibc's libm lands in the audio and
 * a record stops being bit-identical without being wrong.
 *
 * The numbers below are MEASURED, and they are asserted so that a silent drop
 * is a failure. See the note in assertIdentity (parity-stream.mjs) before
 * re-baselining.
 *
 * What the two non-identical records actually are, because it took a wrong
 * turn to find out and the next module will hit it again:
 *
 *   pad-params and soak are the only two cases that set `pan` to a value
 *   whose pan-law angle is not a special one, and they are exactly the two
 *   that drift. One double each (soak's repeats across four snapshots): the
 *   pad's pan_l.value. The angle itself is bit-identical on all three sides
 *   (3ff197c987c952c4 for pan 0.4), and sin() of it agrees on all three. It
 *   is cos() that does not:
 *
 *     glibc (cc)        cos -> 3fdd0e2e2b44de01
 *     musl  (emcc/wasm) cos -> 3fdd0e2e2b44de02
 *     V8    (Math.cos)      -> 3fdd0e2e2b44de02
 *
 *   So wasm and the JS agree bit-for-bit — both are fdlibm-derived — and
 *   glibc is the outlier by one ULP. That is why WASM is 45 and the other two
 *   are 43: the drift is glibc's, not the port's. It never reaches the audio,
 *   because the float32 path is bit-identical in all 45 cases; one ULP of a
 *   pan coefficient disappears in the narrowing.
 *
 *   The wrong turn, worth not repeating: a bare cos() on a literal argument
 *   reports the same bits under cc and emcc, which looks like agreement and
 *   is not. LLVM constant-folds it with the HOST's libm, so both builds print
 *   glibc's answer. Make the argument volatile before believing such a test.
 *
 * Under MSVC this is unmeasured, per the plan's standing caveat.
 */
const IDENTITY_NATIVE = 49; // 51 cases; pad-params and soak drift on glibc's cos
const IDENTITY_WASM = 51; // musl's cos matches V8's, so wasm is exact
const IDENTITY_CROSS = 49;

const { native, wasm } = buildAndRun({
  root,
  name: "parity-drum-rack",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/chain.c"),
    join(root, "packages/native/src/dsp/drum-voice.c"),
    join(root, "packages/native/src/dsp/drum-rack.c"),
    join(root, "packages/native/tests/parity-drum-rack.c"),
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
const rackProbe = join(coreDir, ".parity-probe.drum-rack.mjs");

/** chain.js's one import of the real effect registry. */
const REGISTRY_RE = /^import \{ createEffect \} from "\.\.\/effects\/registry\.js";$/m;
/** drum-rack.js's one import of Chain, which has to come from the probe copy. */
const CHAIN_RE = /^import \{ Chain \} from "\.\/chain\.js";$/m;

let js;
try {
  const chainSrc = readFileSync(join(coreDir, "chain.js"), "utf8");
  const chainHits = chainSrc.match(new RegExp(REGISTRY_RE.source, "gm")) || [];
  ok("chain.js imports createEffect exactly once (the probe's only edit)", chainHits.length === 1, `${chainHits.length} matches`);
  const chainPatched = chainSrc.replace(
    REGISTRY_RE,
    'const createEffect = (type, sr, maxBlock) => globalThis.__BK_PARITY_CREATE_EFFECT(type, sr, maxBlock);',
  );
  ok("the chain probe substitution changed the source", chainPatched !== chainSrc);
  writeFileSync(chainProbe, chainPatched);

  const rackSrc = readFileSync(join(coreDir, "drum-rack.js"), "utf8");
  const rackHits = rackSrc.match(new RegExp(CHAIN_RE.source, "gm")) || [];
  ok("drum-rack.js imports Chain exactly once (the probe's only edit)", rackHits.length === 1, `${rackHits.length} matches`);
  const rackPatched = rackSrc.replace(CHAIN_RE, 'import { Chain } from "./.parity-probe.chain.mjs";');
  ok("the rack probe substitution changed the source", rackPatched !== rackSrc);
  writeFileSync(rackProbe, rackPatched);

  js = await import(`${rackProbe}?t=${Date.now()}`);
  ok("the probe exports DrumRack and PAD_COUNT", typeof js.DrumRack === "function" && js.PAD_COUNT === 16);
} finally {
  rmSync(rackProbe, { force: true });
  rmSync(chainProbe, { force: true });
}

const SR = 48000;
const MAX_BLOCK = 256;
const BUF_LEN = 512;
const PAD_COUNT = 16;
const MAX_LAYERS = 4;
const MAX_EFFECTS = 40; // mirrors MAX_EFFECTS, the C's effect pool size
const SNAP_SLOTS = 2; // mirrors SNAP_SLOTS: how many slots per pad the snapshot reports
const UNSET = -1e9;
const ENV = { IDLE: 0, ATTACK: 1, DECAY: 2, SUSTAIN: 3, RELEASE: 4 };

/** Canonical wire index -> the string key DrumVoice.setParam expects. */
const PAD_KEY = [
  "attack", "decay", "sustain", "release", "hold",
  "pitch", "start", "reverse", "gain", "pan",
  "mode", "velAmount", "choke", "mute",
];

/** Canonical wire index -> the string key DrumRack.setParam expects. */
const DRUM_KEY = ["gain", "mute", "solo", "route"];

/** Mirrors the opcode enum in parity-drum-rack.c. */
const OP = {
  END: 0,
  INIT: 1,
  SETBUF: 2,
  CLEARPAD: 3,
  PADPARAM: 4,
  TRIGGER: 5,
  RELEASE: 6,
  PARAM: 7,
  RESET: 8,
  PAD: 9,
  CHAINFOR: 10,
  CHAINADD: 11,
  CHAINREMOVE: 12,
  CHAINBYPASS: 13,
  CHAINPARAM: 14,
  PROCESS: 15,
  SNAP: 16,
};

/** Mirrors the buffer-kind enum. 0..4 are bk_fill_signal's signals. */
const BUF = { IMPULSE: 0, STEP: 1, NOISE: 2, RAMP: 3, ZERO: 4, DIRTY: 5, TINY: 6, HUGE: 7 };

/** Mirrors the prefill-kind enum for the destination block. */
const PRE = { SILENT: 0, CONST: 1, NOISE: 2 };

/** The test effect's own param ids, and the names this side spells them with. */
const FX_KEY = ["gain", "latency", "inert"];
const PK_GAIN = 0;
const PK_LATENCY = 1;
const PK_INERT = 2;

// ---------------------------------------------------------------------------
// the stimulus, mirroring build_buf() and prefill() in the C
// ---------------------------------------------------------------------------

/**
 * The C's pad_buf[pad][layer], and persistent for the same reason: the rack
 * borrows the pointer, so a SETBUF that lands on a slot another pad is still
 * reading has to be able to change what that pad hears. Length BUF_LEN even
 * when a script asks for fewer frames, exactly as the C's is, so the tail of a
 * previous longer fill survives underneath a shorter one.
 */
const padBuf = [];
for (let p = 0; p < PAD_COUNT; p++) {
  const layers = [];
  for (let l = 0; l < MAX_LAYERS; l++) layers.push(new Float32Array(BUF_LEN));
  padBuf.push(layers);
}

const saltOff = (salt) => salt & 15;
const saltScale = (salt) => 1 - 0.03125 * (salt & 7);

/**
 * Fill one layer buffer in place. The salt rotates into the LCG stream and
 * scales by an exactly-representable factor, so no two pads hold the same
 * samples and neither transform rounds differently between the languages.
 */
function buildBufInto(dst, n, kind, salt) {
  const off = saltOff(salt);
  const k = saltScale(salt);

  if (kind === BUF.TINY) {
    for (let i = 0; i < n; i++) dst[i] = (i % 2 ? 1e-20 : -1e-20) * (i + 1) * k;
    return;
  }

  if (kind === BUF.HUGE) {
    // Ordinary noise lifted to around 1e30, which is exactly where sanitize()
    // stops passing a value through. The voice lets these out intact; the
    // rack's gain pass is the first thing that can push them over.
    const s = fillSignal(n + 16, BUF.NOISE);
    for (let i = 0; i < n; i++) dst[i] = s[i + off] * k * 1e30;
    return;
  }

  // n + 16 so the rotation has somewhere to rotate into, and NOISE for the
  // dirty kind because the LCG cannot produce a NaN.
  const s = fillSignal(n + 16, kind === BUF.DIRTY ? BUF.NOISE : kind);
  for (let i = 0; i < n; i++) dst[i] = s[i + off] * k;

  if (kind === BUF.DIRTY) {
    // Fixed indices so both sides plant them in the same place. 1e40 does not
    // fit a float32 and lands as +Infinity in a Float32Array exactly as it
    // does in a (float) cast, which is the point — sanitize() has to survive it.
    if (n > 3) dst[3] = NaN;
    if (n > 5) dst[5] = 1e40;
    if (n > 7) dst[7] = -0;
    if (n > 9) dst[9] = 0;
  }
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
// the test effect, mirroring tfx in parity-drum-rack.c
// ---------------------------------------------------------------------------

/**
 * A stateful one-pole whose gain derives from its slot id, so the order of two
 * slots on one pad is audible; it counts its process() and reset() calls, so
 * "did the chain run at all" and "did panic reach this chain" are
 * measurements rather than inferences; and it touches no libm.
 *
 * Deliberately has NO setCarrierBus. The rack constructs its chains without a
 * carrier bus, so chain.js never reaches the `typeof fx.setCarrierBus ===
 * "function"` branch and the C's vtable has NULL in that slot. An effect with
 * the method here would take a path the port does not have.
 */
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
    // "inert" is stored above and otherwise ignored, which is the point of it.
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

/**
 * After every op: the rack's four numbers, plus the two per-pad arrays the UI
 * reads. An op that quietly did nothing moves this.
 *
 * padMeters goes out as the float it is stored as — the JS holds these in a
 * Float32Array, and a port that kept them in double would be one rounding away
 * on every sounding pad and would show up here rather than nowhere.
 */
function pushState(out, rk) {
  out.push(rk.sounding ? 1 : 0);
  out.push(rk.meterL);
  out.push(rk.meterR);
  out.push(rk.gain);
  out.push(rk.muted ? 1 : 0);
  out.push(rk.solo);
  for (let p = 0; p < PAD_COUNT; p++) out.push(rk.padMeters[p]);
  for (let p = 0; p < PAD_COUNT; p++) out.push(rk.triggerFlags[p]);
}
const STATE_FIELDS = 6 + PAD_COUNT * 2;

/** Everything else observable, for OP_SNAP. Order is the contract. */
function pushSnap(out, rk) {
  out.push(rk.sr);
  out.push(rk.maxBlock);
  out.push(rk.flashFrames);

  for (let p = 0; p < PAD_COUNT; p++) {
    const v = rk.pads[p];
    const ch = rk.padChains[p];

    out.push(v.active ? 1 : 0);
    out.push(v.stage);
    out.push(v.env);
    out.push(v.pos);
    out.push(v.meter);
    out.push(v.chokeGroup);
    out.push(v.layer);
    out.push(v.nextLayer);
    out.push(v.layerCount);
    out.push(v.step);
    out.push(v.velGain);
    out.push(v.holdLeft);
    out.push(v.choking ? 1 : 0);
    out.push(v.muted ? 1 : 0);
    out.push(v.gain);
    out.push(v.panL.value);
    out.push(v.panR.value);
    // The layer table, so a setBuffer that landed on the wrong pad — or a
    // clearPad that cleared the wrong one — is visible as structure rather
    // than only as audio.
    for (let i = 0; i < MAX_LAYERS; i++) {
      out.push(v.layers[i].data ? 1 : 0);
      out.push(v.layers[i].frames);
    }

    // `padChains[p] !== null` is what the C spells chain_used[p]. Note 1 in
    // drum-rack.h claims the two are the same thing; this is where the claim
    // is measured.
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

/** The per-pad fields of a snapshot, in order, for reading a dump back out. */
const VOICE_NAMES = [
  "active", "stage", "env", "pos", "meter", "chokeGroup",
  "layer", "nextLayer", "layerCount", "step", "velGain", "holdLeft",
  "choking", "muted", "gain", "panL", "panR",
];
const SLOT_NAMES = ["present", "id", "bypassed", "calls", "resets", "zl", "zr", "gain"];
const PAD_FIELDS = VOICE_NAMES.length + MAX_LAYERS * 2 + 3 + SNAP_SLOTS * SLOT_NAMES.length;
const SNAP_FIELDS = 3 + PAD_COUNT * PAD_FIELDS;

/** The same fields, read back out of a dump — the C's or this file's. */
function decodeSnap(buf, at) {
  const snap = { sr: buf[at], maxBlock: buf[at + 1], flashFrames: buf[at + 2], pads: [] };
  for (let p = 0; p < PAD_COUNT; p++) {
    let o = at + 3 + p * PAD_FIELDS;
    const pad = {};
    VOICE_NAMES.forEach((k, i) => {
      pad[k] = buf[o + i];
    });
    o += VOICE_NAMES.length;
    pad.layers = [];
    for (let i = 0; i < MAX_LAYERS; i++) pad.layers.push({ present: buf[o + i * 2], frames: buf[o + i * 2 + 1] });
    o += MAX_LAYERS * 2;
    pad.chainUsed = buf[o];
    pad.chainLength = buf[o + 1];
    pad.chainLatency = buf[o + 2];
    o += 3;
    pad.slots = [];
    for (let j = 0; j < SNAP_SLOTS; j++) {
      const slot = {};
      SLOT_NAMES.forEach((k, i) => {
        slot[k] = buf[o + j * SLOT_NAMES.length + i];
      });
      pad.slots.push(slot);
    }
    snap.pads.push(pad);
  }
  return snap;
}

// ---------------------------------------------------------------------------
// the script VM, mirroring run_script()
// ---------------------------------------------------------------------------

/**
 * Replay one script through the real DrumRack. Returns the two payloads plus
 * the offsets at which each op's state block, each snapshot and each rendered
 * block landed, so the checks below can read the *native* dump at the same
 * places instead of trusting this replay.
 */
function runScript(rec) {
  const ops = rec.params;
  const nOps = ops.length / 6;
  let rk = new js.DrumRack(SR, MAX_BLOCK);
  // The C's effect pool counter. Mirrored because the pool is finite: the add
  // past the end is refused there, and has to be refused identically here.
  let nFx = 0;
  const out64 = [];
  const out32 = [];
  const stateAt = [];
  const snapAt = [];
  const procs = [];

  for (let i = 0; i < nOps; i++) {
    const op = ops[i * 6] | 0;
    const a = ops[i * 6 + 1];
    const b = ops[i * 6 + 2];
    const c = ops[i * 6 + 3];
    const d = ops[i * 6 + 4];
    const e = ops[i * 6 + 5];

    switch (op) {
      case OP.INIT:
        // Re-init is construction on this side: every rate-derived number is
        // computed in a constructor or on a param change. The pool goes with
        // it — the effects added after this belong to the new rack.
        rk = new js.DrumRack(a, MAX_BLOCK);
        nFx = 0;
        break;
      case OP.SETBUF: {
        const pi = a | 0;
        const li = b | 0;
        const kind = c | 0;
        const frames = d | 0;
        if (kind < 0) {
          // A null handoff: the layer is emptied. The count goes through as
          // scripted rather than as zero, which is what the host does when it
          // drops a sample without zeroing the rest of the message.
          rk.setPadBuffer(pi, li, null, frames, e);
        } else {
          // Raw indices go to the rack; masked ones only pick the scratch
          // slot, exactly as the C does, so a bad index still writes
          // somewhere real and the two sides write to the same somewhere.
          const p = pi & (PAD_COUNT - 1);
          const l = li & (MAX_LAYERS - 1);
          buildBufInto(padBuf[p][l], frames, kind, p * 4 + l);
          rk.setPadBuffer(pi, li, padBuf[p][l], frames, e);
        }
        break;
      }
      case OP.CLEARPAD:
        rk.clearPad(a | 0);
        break;
      case OP.PADPARAM:
        // An unknown wire key must fall through untranslated, exactly as the C
        // falls through its switch — hence the `?? ""` rather than a throw.
        rk.setPadParam(a | 0, PAD_KEY[b | 0] ?? "", c);
        break;
      case OP.TRIGGER:
        rk.trigger(a | 0, b);
        break;
      case OP.RELEASE:
        rk.release(a | 0);
        break;
      case OP.PARAM:
        rk.setParam(DRUM_KEY[a | 0] ?? "", b);
        break;
      case OP.RESET:
        rk.reset();
        break;
      case OP.PAD:
        out64.push(rk.pad(a | 0) ? 1 : 0);
        break;
      case OP.CHAINFOR:
        out64.push(rk.chainFor(a | 0) ? 1 : 0);
        break;
      case OP.CHAINADD: {
        const chain = rk.chainFor(a | 0);
        let got = null;
        if (chain && nFx < MAX_EFFECTS) {
          const id = b | 0;
          // type === id: the test effect's whole config derives from the id.
          const spec = { id, type: id };
          if (c !== UNSET) spec.index = c;
          if (d !== UNSET) spec.mix = d;
          if (e !== UNSET) spec.bypassed = e;
          got = chain.add(spec);
          // A rejected add must not consume a pool entry, or the next add
          // would be refused one slot early on one side only.
          if (got) nFx++;
        }
        out64.push(got ? 1 : 0);
        break;
      }
      case OP.CHAINREMOVE: {
        const chain = rk.chainFor(a | 0);
        if (chain) chain.remove(b | 0);
        break;
      }
      case OP.CHAINBYPASS: {
        const chain = rk.chainFor(a | 0);
        if (chain) chain.setBypass(b | 0, c | 0);
        break;
      }
      case OP.CHAINPARAM: {
        const chain = rk.chainFor(a | 0);
        // No recalcLatency() afterwards on either side: none of the test
        // effect's keys is "quality", which is the only key chain.js
        // special-cases, and bk_chain_set_param forwards only by design.
        if (chain) chain.setParam(b | 0, FX_KEY[c | 0] ?? "", d);
        break;
      }
      case OP.PROCESS: {
        const frames = a | 0;
        prefill(frames, b | 0);
        rk.process(blkL, blkR, frames);
        const atL = out32.length;
        for (let k = 0; k < frames; k++) out32.push(blkL[k]);
        const atR = out32.length;
        for (let k = 0; k < frames; k++) out32.push(blkR[k]);
        procs.push({ frames, atL, atR });
        break;
      }
      case OP.SNAP:
        snapAt.push(out64.length);
        pushSnap(out64, rk);
        break;
      default:
        break;
    }
    stateAt.push(out64.length);
    pushState(out64, rk);
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
// sanity: the battery has to actually exercise the rack
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises the rack ==");

const byName = new Map(native.map((r) => [r.name, r]));
const want = [
  "empty", "default", "two-pads", "all-pads",
  "choke", "choke-self", "choke-idle", "choke-group-zero", "choke-cross",
  "solo", "solo-clamp", "solo-silent",
  "mute", "mute-ref", "mute-threshold",
  "gain", "sum-rounding", "bus-rounding", "route-noop",
  "chain-never", "chain-empty", "chain-live", "chain-live-ref",
  "chain-two", "chain-two-swapped", "chain-other-pad", "chain-both",
  "chain-bypass", "chain-remove",
  "clear-pad", "reset", "flash", "flash-muted",
  "init-44100", "init-slow", "zero-frames",
  "block-1x256", "block-2x128", "block-8x32",
  "pad-params", "dirty", "dirty-chain", "setbuf-edges", "release", "soak",
  "flash-fractional", "bad-index", "pad-15", "solo-idle-pan",
  "choke-no-sample", "bus-sanitize",
];
const missing = want.filter((n) => !byName.has(n));
ok("every expected case is in the dump", missing.length === 0, missing.length ? `missing: ${missing}` : `${native.length} cases`);

/** Layout of one record, taken from the JS replay and read off the C's dump. */
const layout = (name) => reference(byName.get(name));
/**
 * Index out of range has to throw, not read at undefined. decodeSnap(buf,
 * undefined) happily returns an object whose every field is undefined, and
 * every assertion against it then fails for a reason that has nothing to do
 * with the port — or worse, a `!== 1` style assertion passes. Asking for a
 * snapshot the script never took is a bug in this file, so say so loudly.
 */
function offsetOf(name, kind, i) {
  const arr = layout(name)[kind];
  if (!Number.isInteger(arr[i])) {
    throw new Error(`${name}: no ${kind}[${i}] — the script only has ${arr.length} (0..${arr.length - 1})`);
  }
  return arr[i];
}
const snapOf = (name, i) => decodeSnap(byName.get(name).out64, offsetOf(name, "snapAt", i));
const stateOf = (name, i) => {
  const at = offsetOf(name, "stateAt", i);
  const b = byName.get(name).out64;
  return {
    sounding: b[at],
    meterL: b[at + 1],
    meterR: b[at + 2],
    gain: b[at + 3],
    muted: b[at + 4],
    solo: b[at + 5],
    padMeters: Array.from(b.subarray(at + 6, at + 6 + PAD_COUNT)),
    flags: Array.from(b.subarray(at + 6 + PAD_COUNT, at + STATE_FIELDS)),
  };
};
const blockOf = (name, i) => {
  const p = layout(name).procs[i];
  if (!p) throw new Error(`${name}: no procs[${i}] — the script only renders ${layout(name).procs.length} block(s)`);
  const rec = byName.get(name);
  return {
    frames: p.frames,
    L: rec.out32.subarray(p.atL, p.atL + p.frames),
    R: rec.out32.subarray(p.atR, p.atR + p.frames),
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
const same = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

// -- the snapshot layout this file computes has to be the C's ---------------
{
  // Both sides derive the count from the same three constants; if they ever
  // disagree, every record fails and this says which number moved.
  ok("the snapshot is 3 rack fields plus 16 pads of 44", PAD_FIELDS === 44 && SNAP_FIELDS === 707, `${PAD_FIELDS} per pad, ${SNAP_FIELDS} total`);
  ok("the per-op state block is 6 scalars plus two 16-wide arrays", STATE_FIELDS === 38, `${STATE_FIELDS}`);
  // "empty" is one SNAP, one state block, nothing else, so its first snapshot
  // sits at 0 and its first state block right after it.
  ok("and the C's dump agrees about where the first state block lands", layout("empty").stateAt[0] === SNAP_FIELDS, `${layout("empty").stateAt[0]}`);
}

// -- the battery covers the opcodes, the params and enough audio -------------
{
  const seen = new Set();
  const rackKeys = new Set();
  const padKeys = new Set();
  let frames = 0;
  for (const rec of native) {
    const nOps = rec.params.length / 6;
    for (let o = 0; o < nOps; o++) {
      const op = rec.params[o * 6];
      seen.add(op);
      if (op === OP.PROCESS) frames += rec.params[o * 6 + 1];
      if (op === OP.PARAM) rackKeys.add(rec.params[o * 6 + 1]);
      if (op === OP.PADPARAM) padKeys.add(rec.params[o * 6 + 2]);
    }
  }
  // END is the format's terminator, never scripted; everything else must run.
  const unused = Object.entries(OP)
    .filter(([k, v]) => k !== "END" && !seen.has(v))
    .map(([k]) => k);
  ok("every opcode is exercised", unused.length === 0, unused.length ? `unused: ${unused}` : `${seen.size} opcodes`);
  const unusedRack = DRUM_KEY.filter((_, i) => !rackKeys.has(i));
  ok("every rack param is exercised, route included", unusedRack.length === 0, unusedRack.length ? `unused: ${unusedRack}` : `${DRUM_KEY.length} keys`);
  const unusedPad = PAD_KEY.filter((_, i) => !padKeys.has(i));
  ok("every pad param is exercised through the rack", unusedPad.length === 0, unusedPad.length ? `unused: ${unusedPad}` : `${PAD_KEY.length} keys`);
  ok("an unknown key is exercised on both forwarders", rackKeys.has(77) && padKeys.has(99));
  ok("the battery renders a meaningful amount of audio", frames > 6000, `${frames} frames`);
}

// -- neither key table is allowed to drift from its two sources --------------
{
  const hdr = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
  const ts = readFileSync(join(root, "packages/web/src/web/audio/backend.ts"), "utf8");

  const fromHeader = (prefix) =>
    [...hdr.matchAll(new RegExp(`${prefix}([A-Z_]+) = (\\d+)`, "g"))]
      .filter((m) => m[1] !== "COUNT")
      .sort((x, y) => Number(x[2]) - Number(y[2]))
      .map((m) => m[1].toLowerCase().replace(/_/g, ""));
  const fromTs = (nameInTs) => {
    const block = ts.match(new RegExp(`export const ${nameInTs} = \\[([\\s\\S]*?)\\]`));
    return block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  };

  for (const [label, table, prefix, tsName] of [
    ["PAD_KEY", PAD_KEY, "BK_PAD_P_", "PAD_KEY"],
    ["DRUM_KEY", DRUM_KEY, "BK_DRUM_P_", "DRUM_KEY"],
  ]) {
    const h = fromHeader(prefix);
    const normalised = table.map((k) => k.toLowerCase());
    ok(
      `${label} matches the generated param-keys.h`,
      h.length === normalised.length && h.every((k, i) => k === normalised[i]),
      `${h.join(",")} vs ${normalised.join(",")}`,
    );
    const t = fromTs(tsName);
    ok(
      `${label} matches backend.ts, the source of truth`,
      t.length === table.length && t.every((k, i) => k === table[i]),
      `${t.join(",")}`,
    );
  }
}

// -- an empty rack does nothing at all, to anything ------------------------
{
  // Every control poked at an index that does not exist, then the prefilled
  // block must come back exactly: that is the `!sounded` early return, and it
  // is the one path where the rack must not even touch L and R.
  const konst = blockOf("empty", 0);
  ok(
    "an empty rack leaves the constant-prefilled block exactly as it found it",
    konst.L.every((x) => x === 0.25) && konst.R.every((x) => x === -0.5),
    `L[0] ${konst.L[0]}, R[0] ${konst.R[0]}`,
  );
  const noisy = blockOf("empty", 1);
  const ref = fillSignal(noisy.frames, BUF.NOISE);
  const wantL = Float32Array.from(ref);
  const wantR = Float32Array.from(ref, (x) => -x);
  ok("and the noise-prefilled one too, frame for frame", same(Array.from(noisy.L), Array.from(wantL)) && same(Array.from(noisy.R), Array.from(wantR)));

  // PAD 9 is at ops 3/4/5: two bad indices then a good one.
  const b = byName.get("empty").out64;
  const pads = layout("empty").stateAt.slice(3, 6).map((at, i) => b[at - 1 - 0] ?? null);
  ok("pad(-1) and pad(16) come back empty and pad(0) does not", pads.length === 3);
  ok(
    "and every no-op left the rack at its defaults",
    (() => {
      const s = stateOf("empty", 16); // after OP_RESET, the last op before the second SNAP
      return s.sounding === 0 && s.gain === 1 && s.muted === 0 && s.solo === -1 && s.meterL === 0 && s.padMeters.every((x) => x === 0) && s.flags.every((x) => x === 0);
    })(),
  );
  const snap = snapOf("empty", 1);
  ok(
    "no chain was ever allocated by a bad index",
    snap.pads.every((p) => p.chainUsed === 0 && p.chainLength === 0),
  );
  ok("and no layer holds anything", snap.pads.every((p) => p.layers.every((l) => l.present === 0)));
}

// -- one pad, one hit, summed into the destination -------------------------
{
  const first = blockOf("default", 0);
  ok("the default hit renders audio", peak(first.L) > 0.05, `peak ${peak(first.L).toFixed(3)}`);
  const s = stateOf("default", 4); // after the first PROCESS
  ok("and the rack's meters and the pad's follow it", s.sounding === 1 && s.meterL > 0.05 && s.padMeters[0] > 0.05, `meterL ${s.meterL.toFixed(3)}, pad0 ${s.padMeters[0].toFixed(3)}`);
  ok("and only pad 0's meter moved", s.padMeters.slice(1).every((x) => x === 0));

  // 512-frame sample, 5x128 frames of script: the fourth block is where pos
  // walks off the end, so the fifth is silent and the voice has freed itself.
  ok(
    "the sample runs out under it and the rack goes quiet",
    stateOf("default", 7).sounding === 1 && stateOf("default", 8).sounding === 0,
    `block4 sounding ${stateOf("default", 8).sounding}`,
  );
  const end = snapOf("default", 2);
  ok("and the meters are clear afterwards", end.pads[0].meter === 0 && end.pads[0].layers[0].frames === 512);

  // PROCESS 1 is prefilled with the constant, so the sum has to sit off zero
  // by roughly the prefill. A port that assigned rather than added loses this.
  const konst = blockOf("default", 1);
  let mean = 0;
  for (let i = 0; i < konst.frames; i++) mean += konst.R[i];
  mean /= konst.frames;
  ok("process() sums into the destination rather than overwriting it", mean < -0.3, `mean R ${mean.toFixed(3)}`);
}

// -- two pads and sixteen pads both land on the one bus --------------------
{
  const two = stateOf("two-pads", 6);
  ok("two pads both write their own meter", two.padMeters[0] > 0.01 && two.padMeters[5] > 0.01, `pad0 ${two.padMeters[0].toFixed(3)}, pad5 ${two.padMeters[5].toFixed(3)}`);
  ok("and no other pad's", two.padMeters.filter((x) => x !== 0).length === 2);
  // Pad 0 is panned hard left and pad 5 to the right, so the two sides of the
  // bus cannot be the same — a port that summed both pads into both sides
  // identically would pass a mono check and fail this one.
  const blk = blockOf("two-pads", 0);
  ok("the two pans put different audio on the two sides", !same(Array.from(blk.L), Array.from(blk.R)), "L === R");

  // 16 SETBUFs, 16 TRIGGERs, then the gain op: state 32 is the gain, before a
  // single frame has been rendered, so every meter there is still zero. The
  // first block is op 33.
  const all = stateOf("all-pads", 33);
  ok("all sixteen pads sound at once", all.padMeters.every((x) => x > 0), `min ${Math.min(...all.padMeters).toExponential(2)}`);
  ok("and all sixteen flashes are lit", all.flags.every((x) => x > 0));
  ok("the sixteen-pad sum is loud", peak(blockOf("all-pads", 0).L) > 0.1, `peak ${peak(blockOf("all-pads", 0).L).toFixed(3)}`);
}

// -- choke, in all five of its shapes --------------------------------------
{
  // Pad 2 sounding in group 1, pad 4 in no group. Triggering pad 3 chokes 2
  // and leaves 4 alone.
  const before = snapOf("choke", 0);
  const after = snapOf("choke", 1);
  ok("the choked pad is still active — it is a fade, not a cut", before.pads[2].active === 1 && after.pads[2].active === 1 && after.pads[2].choking === 1, `choking ${after.pads[2].choking}`);
  ok("the pad that fired is not choking", after.pads[3].active === 1 && after.pads[3].choking === 0);
  ok("and a pad outside the group is untouched", after.pads[4].choking === 0 && after.pads[4].env === before.pads[4].env);
  const settled = snapOf("choke", 3);
  ok("the choke fade finishes and frees the voice", settled.pads[2].active === 0 && settled.pads[4].active === 1, `pad2 active ${settled.pads[2].active}`);

  // Retriggering a pad in its own group restarts it in place.
  const self = snapOf("choke-self", 1);
  ok("retriggering a pad does not choke that pad", self.pads[2].choking === 0 && self.pads[2].stage === ENV.ATTACK, `choking ${self.pads[2].choking}, stage ${self.pads[2].stage}`);

  // An idle pad in the group must not come out of the choke loop marked, and
  // must not inherit the flag into its own next hit. Pad 2 fires while pad 3
  // has never been touched; pad 3 takes its own hit two snapshots later.
  const idle = snapOf("choke-idle", 1);
  ok(
    "an idle pad in the group is not choked",
    idle.pads[3].active === 0 && idle.pads[3].choking === 0 && idle.pads[3].stage === ENV.IDLE && idle.pads[2].active === 1,
    `pad3 active ${idle.pads[3].active}, choking ${idle.pads[3].choking}, stage ${idle.pads[3].stage}`,
  );
  const idleHit = snapOf("choke-idle", 2);
  ok(
    "and its own hit starts clean rather than inheriting the flag",
    idleHit.pads[3].active === 1 && idleHit.pads[3].choking === 0 && idleHit.pads[3].stage === ENV.ATTACK,
    `pad3 choking ${idleHit.pads[3].choking}, stage ${idleHit.pads[3].stage}`,
  );
  ok(
    "while that hit chokes pad 2, which was sounding",
    idleHit.pads[2].active === 1 && idleHit.pads[2].choking === 1,
    `pad2 choking ${idleHit.pads[2].choking}`,
  );

  const zero = snapOf("choke-group-zero", 0);
  ok("group 0 means no group", zero.pads[2].choking === 0 && zero.pads[2].active === 1 && zero.pads[3].active === 1);

  const cross = snapOf("choke-cross", 0);
  ok("different non-zero groups do not cross-choke", cross.pads[2].choking === 0 && cross.pads[3].choking === 0 && cross.pads[2].active === 1);
}

// -- solo cuts with reset(), and its field arithmetic is not a clamp -------
{
  const before = snapOf("solo", 0);
  const armed = snapOf("solo", 1); // right after the solo param, before any process
  ok("setting solo alone does not touch the voices", armed.pads[0].active === before.pads[0].active && armed.pads[0].env === before.pads[0].env);
  const cut = snapOf("solo", 2); // after the block rendered under solo
  ok(
    "the excluded pad is reset, not choked: no fade and no tail",
    cut.pads[0].active === 0 && cut.pads[0].choking === 0 && cut.pads[0].env === 0,
    `active ${cut.pads[0].active}, choking ${cut.pads[0].choking}, env ${cut.pads[0].env}`,
  );
  ok("and the soloed pad keeps playing", cut.pads[1].active === 1);
  const unsoloed = snapOf("solo", 3);
  ok("un-soloing brings nothing back", unsoloed.pads[0].active === 0 && stateOf("solo", 13).padMeters[0] === 0);

  const solos = [0, 1, 2, 3, 4, 5, 6].map((i) => snapOf("solo-clamp", i));
  const got = layout("solo-clamp").stateAt.map((_, i) => stateOf("solo-clamp", i).solo);
  ok("solo(-5) and solo(-0.4) are both 'no solo', not a clamp to -1", got[0] === -1 && got[2] === -1, `${got[0]}, ${got[2]}`);
  ok("solo(99) clamps to the last pad", got[4] === 15, `${got[4]}`);
  ok("solo rounds half away from zero: 3.6 -> 4, 3.4 -> 3", got[6] === 4 && got[8] === 3, `${got[6]}, ${got[8]}`);
  ok("solo(0) is pad 0 and not 'no solo'", got[10] === 0, `${got[10]}`);
  ok("solo(15.5) rounds up and then clamps back to 15", got[12] === 15, `${got[12]}`);
  ok("and none of that moved a voice", solos.every((s) => s.pads.every((p) => p.active === 0)));

  // Solo on a silent pad while another sounds: every voice excluded or idle,
  // so `sounded` never gets set and the prefilled block survives untouched.
  const blk = blockOf("solo-silent", 0);
  ok(
    "soloing a silent pad takes the early return and leaves the block alone",
    blk.L.every((x) => x === 0.25) && blk.R.every((x) => x === -0.5),
    `L[0] ${blk.L[0]}`,
  );
  ok("and clears the rack meters", stateOf("solo-silent", 3).meterL === 0 && stateOf("solo-silent", 3).meterR === 0);
}

// -- mute freezes everything except the flash ------------------------------
{
  const before = snapOf("mute", 0);
  const muted = snapOf("mute", 1);
  ok(
    "a block rendered under mute advances no envelope",
    muted.pads[0].env === before.pads[0].env && muted.pads[0].pos === before.pads[0].pos && muted.pads[0].stage === before.pads[0].stage,
    `env ${muted.pads[0].env} vs ${before.pads[0].env}`,
  );
  ok(
    "and no pan smoother either — that is the field a port is most likely to leak",
    muted.pads[0].panL === before.pads[0].panL && muted.pads[0].panR === before.pads[0].panR,
    `panL ${muted.pads[0].panL} vs ${before.pads[0].panL}`,
  );
  const blk = blockOf("mute", 1);
  ok("the muted block comes back as it went in", blk.L.every((x) => x === 0.25) && blk.R.every((x) => x === -0.5));
  ok("and the rack's meters are cleared", stateOf("mute", 7).meterL === 0 && stateOf("mute", 7).padMeters[0] === 0);

  // mute-ref is this script with the mute pair and the muted block removed,
  // so the block after the mute here must equal the second block there.
  ok(
    "a note held through a mute resumes exactly where it was",
    same(Array.from(blockOf("mute", 2).L), Array.from(blockOf("mute-ref", 1).L)) && same(Array.from(blockOf("mute", 2).R), Array.from(blockOf("mute-ref", 1).R)),
    "the resumed block differs from the never-muted reference",
  );
  const resumed = snapOf("mute", 2);
  const never = snapOf("mute-ref", 1);
  ok("and so does every field of its voice", resumed.pads[0].env === never.pads[0].env && resumed.pads[0].pos === never.pads[0].pos && resumed.pads[0].panL === never.pads[0].panL);

  const t = [0, 1, 2, 3].map((i) => stateOf("mute-threshold", i * 2 + 1).muted);
  ok("mute is a threshold at 0.5 and not a boolean cast", t[0] === 0 && t[1] === 1 && t[2] === 0 && t[3] === 1, `${t}`);
}

// -- rack gain, through dbToGain and its clamp -----------------------------
{
  const g = [0, 1, 2, 3].map((i) => stateOf("gain", 3 + i * 3).gain);
  ok("-6 dB is about half", Math.abs(g[0] - 0.5011872336272722) < 1e-12, `${g[0]}`);
  ok("+99 dB clamps to +12", Math.abs(g[1] - 3.9810717055349722) < 1e-12, `${g[1]}`);
  ok("-999 dB clamps to -60", Math.abs(g[2] - 0.001) < 1e-9, `${g[2]}`);
  ok("and 0 dB is exactly 1", g[3] === 1, `${g[3]}`);
  const loud = peak(blockOf("gain", 1).L);
  const quiet = peak(blockOf("gain", 3).L);
  ok("the gain is audible in the output", quiet < loud, `${quiet.toExponential(2)} vs ${loud.toExponential(2)}`);
}

// -- the two roundings, which only exist because the destination is noisy ---
{
  for (const name of ["sum-rounding", "bus-rounding"]) {
    const a = audioOf(name);
    ok(`${name} renders into a destination that is not silent`, peak(a) > 0.05, `peak ${peak(a).toFixed(3)}`);
    // The trap needs a value that is not exactly representable after one
    // rounding; a non-power-of-two gain on noise gives that on most frames.
    // If this ever comes back all-zero the case has stopped testing anything.
    let nonzero = 0;
    for (const x of a) if (x !== 0) nonzero++;
    ok(`and ${name} has enough live frames to catch a last-bit error`, nonzero > a.length * 0.9, `${nonzero}/${a.length}`);
  }
  const bus = snapOf("bus-rounding", 0);
  ok("bus-rounding really does put both pads on the chain path", bus.pads[0].chainLength === 1 && bus.pads[1].chainLength === 1);
}

// -- route is not a rack param --------------------------------------------
{
  const base = snapOf("route-noop", 0);
  for (const [i, label] of [[1, "route(2)"], [2, "route(0)"], [3, "an unknown key"]]) {
    const after = snapOf("route-noop", i);
    ok(`${label} changes nothing`, JSON.stringify(after) === JSON.stringify(base));
  }
  const s = stateOf("route-noop", 8);
  ok("and the three real params are still where they were put", Math.abs(s.gain - 0.5011872336272722) < 1e-12 && s.muted === 1 && s.solo === 4, `gain ${s.gain}, muted ${s.muted}, solo ${s.solo}`);
}

// -- note 1 of drum-rack.h: asking for a chain and leaving it empty --------
{
  ok(
    "a chain asked for and left empty renders byte-for-byte like no chain at all",
    same(Array.from(audioOf("chain-never")), Array.from(audioOf("chain-empty"))),
    "the empty chain changed the audio",
  );
  const never = snapOf("chain-never", 0);
  const empty = snapOf("chain-empty", 0);
  ok("but the two are distinguishable in the snapshot, which is what makes the check meaningful", never.pads[0].chainUsed === 0 && empty.pads[0].chainUsed === 1);
  ok("and the empty chain is genuinely empty", empty.pads[0].chainLength === 0 && empty.pads[0].slots[0].present === 0);
}

// -- and the other half of it: a live chain changes only its own pad -------
{
  const live = snapOf("chain-live", 1);
  const ref = snapOf("chain-live-ref", 1);
  ok(
    "a live chain leaves every voice field of its own pad alone",
    VOICE_NAMES.every((k) => Object.is(live.pads[0][k], ref.pads[0][k])),
    `${VOICE_NAMES.filter((k) => !Object.is(live.pads[0][k], ref.pads[0][k]))}`,
  );
  ok("and every field of the other sounding pad", VOICE_NAMES.every((k) => Object.is(live.pads[2][k], ref.pads[2][k])));
  ok(
    "while the audio is different, because the effect ran",
    !same(Array.from(audioOf("chain-live")), Array.from(audioOf("chain-live-ref"))),
    "the live chain did not change the audio",
  );
  ok("the effect ran once per block", live.pads[0].slots[0].calls === 2, `${live.pads[0].slots[0].calls} calls`);
  // Two blocks of 128 at a default mix of 1: the slot's own state has to have
  // moved, or the effect is being handed silence.
  ok("and it has state to show for it", live.pads[0].slots[0].zl !== 0, `zl ${live.pads[0].slots[0].zl}`);
}

// -- two slots on one pad do not commute ----------------------------------
{
  ok(
    "the same two effects in the other order sound different",
    !same(Array.from(audioOf("chain-two")), Array.from(audioOf("chain-two-swapped"))),
    "the chain commuted, so slot order is not being respected",
  );
  const two = snapOf("chain-two", 1);
  const swapped = snapOf("chain-two-swapped", 1);
  ok("and the slot order is the scripted one on both sides", two.pads[0].slots[0].id === 5 && two.pads[0].slots[1].id === 6 && swapped.pads[0].slots[0].id === 6 && swapped.pads[0].slots[1].id === 5, `${two.pads[0].slots[0].id},${two.pads[0].slots[1].id} vs ${swapped.pads[0].slots[0].id},${swapped.pads[0].slots[1].id}`);
  ok("both slots ran", two.pads[0].slots[0].calls === 2 && two.pads[0].slots[1].calls === 2);
}

// -- an effect on one pad while another sounds dry ------------------------
{
  const s = snapOf("chain-other-pad", 0);
  ok("only pad 3 has a chain", s.pads[3].chainLength === 1 && s.pads[0].chainUsed === 0);
  ok("and its effect ran once for the one block", s.pads[3].slots[0].calls === 1, `${s.pads[3].slots[0].calls} calls`);
  ok("both pads are sounding, so the dry path and the wet one are both live", s.pads[0].active === 1 && s.pads[3].active === 1);
  // CHAINPARAM with PK_GAIN has to reach the effect; PK_INERT must not.
  const beforeParam = snapOf("chain-other-pad", 1);
  const afterGain = snapOf("chain-other-pad", 2);
  ok("setParam reached the effect's gain", afterGain.pads[3].slots[0].gain === 0.125 && beforeParam.pads[3].slots[0].gain !== 0.125, `${beforeParam.pads[3].slots[0].gain} -> ${afterGain.pads[3].slots[0].gain}`);
  const afterInert = snapOf("chain-other-pad", 3);
  ok(
    "and an inert key changed nothing the snapshot can see",
    JSON.stringify(afterInert.pads[3]) === JSON.stringify(afterGain.pads[3]),
  );
  ok("the chain's latency is the effect's, un-recalculated", afterGain.pads[3].chainLatency === (7 % 3) * 8, `${afterGain.pads[3].chainLatency}`);
}

// -- two live chains in one block, over one shared wet buffer in the C ------
{
  const s = snapOf("chain-both", 0);
  ok("both pads have their own live chain", s.pads[0].chainLength === 1 && s.pads[9].chainLength === 1);
  ok("both effects ran, and with different gains", s.pads[0].slots[0].calls === 1 && s.pads[9].slots[0].calls === 1 && s.pads[0].slots[0].gain !== s.pads[9].slots[0].gain, `${s.pads[0].slots[0].gain} vs ${s.pads[9].slots[0].gain}`);
  ok("and each carried its own state through the shared scratch", s.pads[0].slots[0].zl !== 0 && s.pads[9].slots[0].zl !== 0 && s.pads[0].slots[0].zl !== s.pads[9].slots[0].zl);
}

// -- bypass keeps the pad on the chain path and resets the effect ----------
{
  const live = snapOf("chain-bypass", 0);
  const bypassed = snapOf("chain-bypass", 1);
  ok("bypassing resets the effect", bypassed.pads[0].slots[0].resets === live.pads[0].slots[0].resets + 1 && bypassed.pads[0].slots[0].zl === 0, `resets ${bypassed.pads[0].slots[0].resets}, zl ${bypassed.pads[0].slots[0].zl}`);
  ok("and drops the chain's reported latency", bypassed.pads[0].chainLatency === 0 && live.pads[0].chainLatency === (5 % 3) * 8, `${live.pads[0].chainLatency} -> ${bypassed.pads[0].chainLatency}`);
  const rendered = snapOf("chain-bypass", 2);
  ok("a bypassed slot still counts towards length, so the pad keeps the chain path", rendered.pads[0].chainLength === 1);
  ok("and the bypassed effect did not run", rendered.pads[0].slots[0].calls === live.pads[0].slots[0].calls, `${rendered.pads[0].slots[0].calls} vs ${live.pads[0].slots[0].calls}`);
  const reengaged = snapOf("chain-bypass", 3);
  ok("re-engaging runs it again, from cleared state", reengaged.pads[0].slots[0].calls === live.pads[0].slots[0].calls + 1);
}

// -- removing the last slot returns the pad to the direct path ------------
{
  const s = snapOf("chain-remove", 0);
  ok("the slot is gone", s.pads[0].chainLength === 0 && s.pads[0].slots[0].present === 0 && s.pads[0].chainLatency === 0);
  ok("but the chain is still allocated, which the direct path does not care about", s.pads[0].chainUsed === 1);
  ok("and the pad still sounds", stateOf("chain-remove", 6).padMeters[0] > 0 && peak(blockOf("chain-remove", 1).L) > 0.01);
}

// -- clearPad is both halves, and a bad index is neither ------------------
{
  const before = snapOf("clear-pad", 0);
  ok("pad 0 starts with two layers and a chain", before.pads[0].layers[0].present === 1 && before.pads[0].layers[1].present === 1 && before.pads[0].chainLength === 1);
  const cleared = snapOf("clear-pad", 1);
  ok("clearPad empties every layer", cleared.pads[0].layers.every((l) => l.present === 0 && l.frames === 0) && cleared.pads[0].layerCount === 0);
  ok("and clears the chain", cleared.pads[0].chainLength === 0 && cleared.pads[0].slots[0].present === 0);
  ok("and leaves pad 4 completely alone", cleared.pads[4].layers[0].present === 1 && cleared.pads[4].chainLength === 1);
  const bad = snapOf("clear-pad", 3);
  ok("clearPad(16) and clearPad(-1) clear nothing", bad.pads[4].layers[0].present === 1 && bad.pads[4].chainLength === 1 && bad.pads[0].layers[0].present === 0);
  const retrigger = snapOf("clear-pad", 4);
  ok("and a cleared pad retriggered has nothing to play", retrigger.pads[0].active === 0, `active ${retrigger.pads[0].active}`);
}

// -- reset reaches every voice, every chain, every meter and every flash ---
{
  const before = snapOf("reset", 0);
  const after = snapOf("reset", 1);
  ok("every voice is idle", after.pads.every((p) => p.active === 0 && p.env === 0 && p.meter === 0));
  ok(
    "and every chain was panicked, which the reset counters prove",
    after.pads[0].slots[0].resets === before.pads[0].slots[0].resets + 1 && after.pads[7].slots[0].resets === before.pads[7].slots[0].resets + 1,
    `${after.pads[0].slots[0].resets}, ${after.pads[7].slots[0].resets}`,
  );
  ok("but the chains themselves survive", after.pads[0].chainLength === 1 && after.pads[7].chainLength === 1);
  const s = stateOf("reset", 10);
  ok("the meters and the flashes are cleared", s.meterL === 0 && s.meterR === 0 && s.padMeters.every((x) => x === 0) && s.flags.every((x) => x === 0));
  ok("and gain and solo are NOT — reset is not a factory reset", Math.abs(s.gain - 0.5011872336272722) < 1e-12 && s.solo === 3, `gain ${s.gain}, solo ${s.solo}`);
  const blk = blockOf("reset", 1);
  ok("the block after a reset is the prefill and nothing else", blk.L.every((x) => x === 0.25) && blk.R.every((x) => x === -0.5));
}

// -- the flash counts frames, not blocks ----------------------------------
{
  const lit = snapOf("flash", 0);
  ok("the flash lights at 90 ms of frames", lit.flashFrames === Math.round((90 * SR) / 1000), `${lit.flashFrames}`);
  const flags0 = stateOf("flash", 2).flags;
  ok("triggering a pad with no sample still lights it", flags0[0] === 4320, `${flags0[0]}`);
  ok("and a bad index lights nothing", flags0.slice(1).every((x) => x === 0));
  // 4320 frames, 256 at a time: seventeen blocks leave 4320 - 4352 < 0 ... so
  // the seventeenth is the one that takes it under. Read the three snapshots
  // rather than asserting the arithmetic twice.
  const walk = [0, 1, 2].map((i) => stateOf("flash", layout("flash").stateAt.length - 5 + i * 2).flags[0]);
  ok("it counts down by the block size and is allowed to go negative", walk[0] > walk[1] || walk[1] <= 0, `${walk}`);
  const last = stateOf("flash", layout("flash").stateAt.length - 1).flags[0];
  ok("and ends up at or below zero", last <= 0, `${last}`);
  ok("nothing was rendered the whole time, since the pad has no sample", peak(audioOf("flash")) === 0);

  const mutedStart = stateOf("flash-muted", 2).flags[0];
  const mutedEnd = stateOf("flash-muted", 5).flags[0];
  ok("the flash keeps counting under a mute", mutedEnd === mutedStart - 512, `${mutedStart} -> ${mutedEnd}`);
  ok("even though nothing rendered", peak(audioOf("flash-muted")) === 0.5, `peak ${peak(audioOf("flash-muted"))}`);
}

// -- the sample rate is not baked in --------------------------------------
{
  const s = snapOf("init-44100", 0);
  ok("re-init moves the rack's own rate", s.sr === 44100, `${s.sr}`);
  ok("and the flash with it", s.flashFrames === Math.round((90 * 44100) / 1000), `${s.flashFrames}`);
  ok("and the pads sound at the new rate", peak(audioOf("init-44100")) > 0.01);

  // 90 ms at 2 kHz is 180 frames, fewer than one 256-frame block: the only
  // stimulus that reaches the max() in the flash calculation.
  const slow = snapOf("init-slow", 0);
  ok("a rate low enough reaches the max() branch of the flash", slow.sr === 2000 && slow.flashFrames === MAX_BLOCK, `sr ${slow.sr}, flash ${slow.flashFrames}`);
  ok("and 90 ms at that rate really is the smaller of the two", Math.round((90 * 2000) / 1000) < MAX_BLOCK);
}

// -- a zero-frame block --------------------------------------------------
{
  const before = stateOf("zero-frames", 3);
  const after = stateOf("zero-frames", 5);
  ok("a zero-frame block moves no flash", after.flags[0] === before.flags[0], `${before.flags[0]} -> ${after.flags[0]}`);
  const muted = stateOf("zero-frames", 8);
  ok("and neither does a zero-frame block under mute", muted.flags[0] === before.flags[0], `${muted.flags[0]}`);
  ok("and the pad survived it", snapOf("zero-frames", 2).pads[0].active === 1);
  ok("with nothing rendered", layout("zero-frames").procs.every((p) => p.frames === 0) && byName.get("zero-frames").out32.length === 0);
}

// -- the same 256 frames in one, two and eight calls ----------------------
{
  const one = Array.from(audioOf("block-1x256"));
  const two = Array.from(audioOf("block-2x128"));
  const eight = Array.from(audioOf("block-8x32"));
  // audioOf concatenates L then R *per block*, so the three have to be
  // compared as the interleaving they are; block-1x256 is the canonical order.
  const flatten = (name) => {
    const l = [];
    const r = [];
    for (let i = 0; i < layout(name).procs.length; i++) {
      const blk = blockOf(name, i);
      for (let k = 0; k < blk.frames; k++) l.push(blk.L[k]);
      for (let k = 0; k < blk.frames; k++) r.push(blk.R[k]);
    }
    return [l, r];
  };
  const [l1, r1] = flatten("block-1x256");
  const [l2, r2] = flatten("block-2x128");
  const [l8, r8] = flatten("block-8x32");
  ok("256 frames in two calls is the same audio as in one", same(l1, l2) && same(r1, r2), "1x256 != 2x128");
  ok("and in eight", same(l1, l8) && same(r1, r8), "1x256 != 8x32");
  ok("(and the check has something to compare)", one.length === 512 && two.length === 512 && eight.length === 512 && peak(l1) > 0.01);
  const s = snapOf("block-1x256", 0);
  ok("both render paths were live for it", s.pads[0].chainLength === 0 && s.pads[1].chainLength === 1 && s.pads[0].active === 1 && s.pads[1].active === 1);
}

// -- setPadParam is a forwarder, and only that ----------------------------
{
  const s = snapOf("pad-params", 0);
  const p = s.pads[0];
  ok(
    "every pad param arrived on the pad",
    p.chokeGroup === 2 && p.muted === 1 && p.gain !== 1 && p.layerCount === 2,
    `choke ${p.chokeGroup}, muted ${p.muted}, gain ${p.gain}, layers ${p.layerCount}`,
  );
  // pan is not readable here: push_snap dumps the smoother's *value* and pan
  // only writes its target, so both sides sit at the centre until a hit
  // resets them. It is checked on the played snapshot below instead.
  ok("and pan has not moved yet, because a knob only writes the target", p.panL === p.panR, `${p.panL} vs ${p.panR}`);
  const after = snapOf("pad-params", 1);
  ok("an unknown key and two bad pad indices changed nothing", JSON.stringify(after) === JSON.stringify(s));
  // mode is the one pad param push_snap cannot show. The script sets it to
  // GATE (0) and then releases the voice, so the stage moving to RELEASE is
  // the proof the key was forwarded: in ONESHOT — the default, and what a
  // dropped key leaves behind — release() returns without touching anything.
  const played = snapOf("pad-params", 2);
  ok("and the pad plays with those params, both layers loaded", played.pads[0].layerCount === 2 && played.pads[0].active === 1);
  // The hit resets the pan smoothers to their targets, so -0.3 becomes
  // audible here: left louder than right.
  ok(
    "and pan reached it, which the hit makes visible",
    played.pads[0].panL > played.pads[0].panR,
    `panL ${played.pads[0].panL}, panR ${played.pads[0].panR}`,
  );
  ok(
    "the mode reached it, which only release() can show",
    played.pads[0].stage === ENV.RELEASE,
    `stage ${played.pads[0].stage}, active ${played.pads[0].active}`,
  );
}

// -- NaN, infinity and negative zero, through sanitize() ------------------
{
  for (const name of ["dirty", "dirty-chain"]) {
    const a = audioOf(name);
    let bad = 0;
    for (const x of a) if (!Number.isFinite(x)) bad++;
    ok(`${name} lets nothing non-finite out`, bad === 0, `${bad} non-finite frames`);
    ok(`and ${name} still renders`, peak(a) > 0, `peak ${peak(a).toExponential(2)}`);
  }
  const s = snapOf("dirty", 0);
  ok("the dirty pad and the sub-floor one both sounded", s.pads[0].active === 1 && s.pads[1].active === 1);
  ok("and the sub-floor pad's meter is under the floor, not negative", s.pads[1].meter >= 0 && s.pads[1].meter < 1e-6, `${s.pads[1].meter.toExponential(2)}`);
  const chained = snapOf("dirty-chain", 0);
  ok("the dirty sample went through a live chain at a partial mix", chained.pads[0].chainLength === 1 && chained.pads[0].slots[0].calls === 1);
  ok("and the effect's own state stayed finite", Number.isFinite(chained.pads[0].slots[0].zl), `${chained.pads[0].slots[0].zl}`);
}

// -- setPadBuffer's edges, all through the rack's forwarder ---------------
{
  const s = snapOf("setbuf-edges", 0);
  ok("a mismatched source rate still loads", s.pads[0].layers[0].present === 1 && s.pads[0].layers[0].frames === 512);
  // A zero-length buffer is not the same as no buffer: setBuffer keeps the
  // handoff (an empty Float32Array is still truthy) and records 0 frames, and
  // it is layerCount's `frames > 0` test that keeps the layer out of the
  // round-robin. A port that treated empty as null would drop `present` and
  // still pass every audible check, so both halves are asserted here.
  const zeroLen = s.pads[1].layers[0];
  ok(
    "a zero-length buffer is held but plays as no layer",
    zeroLen.present === 1 && zeroLen.frames === 0 && s.pads[1].layerCount === 0,
    `present ${zeroLen.present}, frames ${zeroLen.frames}, layerCount ${s.pads[1].layerCount}`,
  );
  ok("an unknown buffer kind is the null handoff, and empties the layer", s.pads[2].layers[0].present === 0 && s.pads[2].layers[0].frames === 0);
  ok("a zero source rate still loads", s.pads[3].layers[0].present === 1);
  const playable = s.pads.filter((p) => p.layerCount > 0);
  ok("and the two bad pad indices loaded nothing anywhere", playable.length === 2, `${playable.length} pads with a playable layer`);
  const triggered = snapOf("setbuf-edges", 1);
  ok("only the two loaded pads sound", triggered.pads[0].active === 1 && triggered.pads[3].active === 1 && triggered.pads[1].active === 0 && triggered.pads[2].active === 0);
  const yanked = snapOf("setbuf-edges", 2);
  ok("yanking the sample under a sounding pad empties the layer", yanked.pads[0].layers[0].present === 0 && yanked.pads[0].layerCount === 0);
  const afterYank = snapOf("setbuf-edges", 3);
  ok("and the pad stops rather than reading off the end", afterYank.pads[0].active === 0, `active ${afterYank.pads[0].active}`);
}

// -- release through the rack --------------------------------------------
{
  // One 128-frame block is 2.7 ms and the decay knob is at its 250 ms
  // default, so both pads are still coming down the decay curve here. GATE
  // mode is not "hold at sustain immediately" — it is "do not auto-release",
  // and the stage to expect at this point is DECAY.
  const held = snapOf("release", 0);
  ok(
    "both pads are still in decay, and neither auto-released in GATE mode",
    held.pads[0].stage === ENV.DECAY && held.pads[1].stage === ENV.DECAY,
    `${held.pads[0].stage}, ${held.pads[1].stage}`,
  );
  const released = snapOf("release", 1);
  ok("release reached pad 0 only", released.pads[0].stage === ENV.RELEASE && released.pads[1].stage === ENV.DECAY, `${released.pads[0].stage}, ${released.pads[1].stage}`);
  ok("and release on an idle pad did nothing", released.pads[5].active === 0 && released.pads[5].stage === ENV.IDLE);
  // The release coefficient is much faster than the decay one, so the two
  // envelopes separate over the next block. Comparing the two pads against
  // each other is what proves release() went to one pad and not to the rack.
  const done = snapOf("release", 2);
  ok(
    "the released pad falls away faster than the pad still decaying",
    done.pads[0].env < released.pads[0].env && done.pads[0].env < done.pads[1].env && done.pads[1].stage === ENV.DECAY,
    `pad0 ${done.pads[0].env} vs pad1 ${done.pads[1].env}`,
  );
}

// -- the soak, which only has to have kept moving ------------------------
{
  const a = audioOf("soak");
  let bad = 0;
  for (const x of a) if (!Number.isFinite(x)) bad++;
  ok("the soak stays finite throughout", bad === 0, `${bad} non-finite frames`);
  ok("and renders a lot of audio", a.length > 1600 && peak(a) > 0.05, `${a.length} frames, peak ${peak(a).toFixed(3)}`);
  const mid = snapOf("soak", 0);
  ok("the choke group fired inside it", mid.pads[0].choking === 1 || mid.pads[1].active === 1, `pad0 choking ${mid.pads[0].choking}`);
  const three = snapOf("soak", 2);
  ok("pad 8's chain lost a slot and bypassed another", three.pads[8].chainLength === 1 && three.pads[8].slots[0].id === 6 && three.pads[8].slots[0].bypassed === 1, `length ${three.pads[8].chainLength}, id ${three.pads[8].slots[0].id}, bypassed ${three.pads[8].slots[0].bypassed}`);
  ok("and pad 2 was cleared out from under its chain", three.pads[2].layers[0].present === 0 && three.pads[2].chainLength === 0);
  // The tail is: reset, trigger 0, trigger 1, one 256-frame block. Pads 0 and
  // 1 share choke group 1, so pad 1's hit chokes pad 0 — and a choke fade is
  // 4 ms, which is 192 frames, so pad 0 is finished well inside that block.
  // Pad 1 is the ramp, still going. Everything else has to be idle, which is
  // what says the reset reached the other fourteen pads.
  const end = snapOf("soak", 3);
  ok(
    "the reset near the end reached everything, and the last two triggers sounded",
    end.pads[1].active === 1 && end.pads[1].choking === 0 && end.pads[0].active === 0,
    `pad0 active ${end.pads[0].active}, pad1 active ${end.pads[1].active}`,
  );
  ok(
    "and no other pad came back from the reset",
    end.pads.filter((p, i) => i > 1 && (p.active === 1 || p.meter !== 0)).length === 0,
    `${end.pads.filter((p, i) => i > 1 && (p.active === 1 || p.meter !== 0)).length} pads still live`,
  );
}

// -- the flash at a rate that does not divide evenly ---------------------
// 90 ms at 8050 Hz is 724.5 frames. Math.round takes that to 725; a truncation
// and a half-to-even rint() both take it to 724, and every other rate in this
// battery makes the number whole, so all three agreed everywhere else.
{
  const fresh = snapOf("flash-fractional", 0);
  ok("90 ms at 8050 Hz rounds up, not down or to even", fresh.flashFrames === 725, `${fresh.flashFrames}`);
  ok("and it is over one block, so the max() cannot hide it", fresh.flashFrames > 256);
  ok("a hit lights the flash for exactly that many frames", stateOf("flash-fractional", 3).flags[0] === 725, `${stateOf("flash-fractional", 3).flags[0]}`);
  ok("and 128 frames later it is 128 shorter", stateOf("flash-fractional", 5).flags[0] === 597, `${stateOf("flash-fractional", 5).flags[0]}`);
}

// -- bad indices, read before a reset can wipe the evidence --------------
{
  for (const [i, what] of [[1, "99"], [3, "-1"], [5, "16"]]) {
    const st = stateOf("bad-index", i);
    ok(`a trigger at ${what} lights no flash anywhere`, st.flags.every((f) => f === 0), `${st.flags}`);
  }
  const after = snapOf("bad-index", 2);
  ok("and wakes no pad, least of all pad 0", after.pads.every((p) => p.active === 0), `${after.pads.filter((p) => p.active === 1).length} active`);
  ok("a release at 99 does nothing either", stateOf("bad-index", 7).sounding === 0);
  // Nothing sounded, so process() takes its early return and the prefilled
  // block has to come back exactly as it went in.
  const blk = blockOf("bad-index", 0);
  ok(
    "and the prefilled block is untouched",
    Array.from(blk.L).every((x) => x === 0.25) && Array.from(blk.R).every((x) => x === -0.5),
  );
}

// -- pad 15, the one an off-by-one at the top of the range would drop -----
{
  const armed = snapOf("pad-15", 0);
  ok("chainFor() accepts the last pad", armed.pads[15].chainUsed === 1 && armed.pads[15].chainLength === 1, `used ${armed.pads[15].chainUsed}, length ${armed.pads[15].chainLength}`);
  const hit = snapOf("pad-15", 1);
  ok("and trigger() reaches it", hit.pads[15].active === 1 && hit.pads[15].layerCount === 1);
  ok("and it renders through its chain", peak(audioOf("pad-15")) > 0, `peak ${peak(audioOf("pad-15"))}`);
  ok("and its flash is lit", stateOf("pad-15", 4).flags[15] > 0, `${stateOf("pad-15", 4).flags[15]}`);
  const wiped = snapOf("pad-15", 2);
  ok("reset() reaches the last pad too", wiped.pads[15].active === 0 && wiped.pads[15].env === 0);
  const st = stateOf("pad-15", 7);
  ok("and clears its meter and its flash", st.padMeters[15] === 0 && st.flags[15] === 0, `meter ${st.padMeters[15]}, flash ${st.flags[15]}`);
  ok("and it stays silent afterwards", snapOf("pad-15", 3).pads[15].active === 0 && stateOf("pad-15", 9).sounding === 0);
}

// -- solo, with an idle pad whose pan is mid-move -------------------------
// setPadParam('pan') writes the smoother's target only. Pad 3 is idle, and the
// rack never renders an idle pad, so its pan value never catches up: it sits at
// the 0.7071 centre with its target at hard left indefinitely. reset() parks
// the pan at its VALUE and throws the target away, so soloing has to leave an
// idle pad alone — and the next hit, which jumps the pan to its target, is what
// makes the difference visible.
{
  const before = snapOf("solo-idle-pan", 0);
  ok("two pads sounding, and the third idle with its pan target moved", before.pads[0].active === 1 && before.pads[1].active === 1 && before.pads[3].active === 0);
  ok("and the idle pad's pan value has not moved with it", Math.abs(before.pads[3].panL - Math.SQRT1_2) < 1e-3, `${before.pads[3].panL}`);

  // Solo 0 — the one solo index a `> 0` test reads as "no solo at all".
  const soloed = snapOf("solo-idle-pan", 1);
  ok("solo on pad 0 cuts pad 1", soloed.pads[1].active === 0 && soloed.pads[0].active === 1, `pad0 ${soloed.pads[0].active}, pad1 ${soloed.pads[1].active}`);
  ok("and clears the cut pad's meter", stateOf("solo-idle-pan", 12).padMeters[1] === 0, `${stateOf("solo-idle-pan", 12).padMeters[1]}`);
  ok("and the soloed pad is still metering", stateOf("solo-idle-pan", 12).padMeters[0] > 0, `${stateOf("solo-idle-pan", 12).padMeters[0]}`);

  // pan -0.9 is a = 0.1 * PI / 4, so cos(a) is ~0.9969 and sin(a) ~0.0785.
  const hit = snapOf("solo-idle-pan", 2);
  ok(
    "and the idle pad's pan target survived the solo — its first hit lands hard left",
    hit.pads[3].panL > 0.99 && hit.pads[3].panR < 0.1,
    `panL ${hit.pads[3].panL}, panR ${hit.pads[3].panR}`,
  );
  ok("which is not where a reset would have left it", Math.abs(hit.pads[3].panL - Math.SQRT1_2) > 0.25);
}

// -- an active pad with no sample under it any more -----------------------
// The only stimulus that separates "the choke loop skips the triggering pad"
// from "it does not": DrumVoice.trigger returns at its first line when there
// are no layers, so it never reaches the line that clears `choking`.
{
  const yanked = snapOf("choke-no-sample", 1);
  ok("the sample is gone but the pad is still active", yanked.pads[0].active === 1 && yanked.pads[0].layerCount === 0 && yanked.pads[0].layers[0].present === 0);
  const retriggered = snapOf("choke-no-sample", 2);
  ok("and re-triggering it does not choke its own tail", retriggered.pads[0].choking === 0, `choking ${retriggered.pads[0].choking}`);
  ok("and trigger() returned before touching the envelope", retriggered.pads[0].stage === yanked.pads[0].stage, `${retriggered.pads[0].stage} vs ${yanked.pads[0].stage}`);
  ok("and the pad goes idle on its next block rather than reading off the end", snapOf("choke-no-sample", 3).pads[0].active === 0);
}

// -- dirt that only the bus can make -------------------------------------
// Every other dirty case is cleaned by the voice before the bus ever sees it.
// BUF_HUGE is a sample the voice passes intact, at sanitize()'s 1e30 ceiling;
// +12 dB of rack gain is the first thing that takes it over.
{
  const a = audioOf("bus-sanitize");
  ok("the voice let the huge samples through", snapOf("bus-sanitize", 0).pads[0].meter > 1e29, `${snapOf("bus-sanitize", 0).pads[0].meter}`);
  ok("the bus lets nothing non-finite out", a.every((x) => Number.isFinite(x)), `${a.filter((x) => !Number.isFinite(x)).length} non-finite frames`);
  ok("and nothing over sanitize()'s ceiling", a.every((x) => Math.abs(x) <= 1e30), `peak ${peak(a)}`);
  // The gain pass zeroes the frames it rejects, so some frames must be exactly
  // zero — otherwise the ceiling was never reached and the case proves nothing.
  const zeroed = blockOf("bus-sanitize", 0);
  ok(
    "and the gain pass zeroed the frames it rejected",
    Array.from(zeroed.L).filter((x) => x === 0).length > 0,
    `${Array.from(zeroed.L).filter((x) => x === 0).length} of ${zeroed.frames} zeroed`,
  );
  ok("while still passing the ones under it", Array.from(zeroed.L).some((x) => x !== 0 && Number.isFinite(x)));
  ok("and the rack meter stayed under the ceiling", stateOf("bus-sanitize", 5).meterL <= 1e30, `${stateOf("bus-sanitize", 5).meterL}`);
}

// -- release, against a second live pad ----------------------------------
// The ops above release pad 0 and idle pad 5. Neither can show that release()
// reads its index: pad 0 is the pad a fixed-index bug would pick, and a stray
// release onto an already-released pad 0 does nothing visible. Pad 1 is still
// decaying, so a release that lands on it is unmistakable.
{
  const second = snapOf("release", 3);
  ok("release reaches pad 1 when pad 1 is the one asked for", second.pads[1].stage === ENV.RELEASE, `${second.pads[1].stage}`);
  const after = snapOf("release", 4);
  ok("and pad 1 then falls away on the release coefficient", after.pads[1].env < second.pads[1].env, `${after.pads[1].env} < ${second.pads[1].env}`);
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\ndrum-rack parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
