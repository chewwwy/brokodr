/**
 * Parity oracle for the C port of dsp/core/chain.js (Phase 5, route (c)).
 *
 * Same four steps as the earlier modules, on the shared plumbing in
 * scripts/lib/parity-stream.mjs:
 *
 *   1. build the C natively and run the battery;
 *   2. build the same source to wasm with emscripten and run it under Node;
 *   3. replay the identical battery through the original chain.js;
 *   4. diff native against wasm.
 *
 * The battery lives in packages/native/tests/parity-chain.c and only there.
 * Each record carries its whole command script in its params, and this file
 * interprets that script rather than keeping a copy of it.
 *
 * Two things are unusual about this module, and both are explained at length
 * in the C battery's header. In short:
 *
 *   - an "effect" is synthetic and mirrored in both languages, because no
 *     effect module is ported yet and borrowing one would measure that
 *     effect's arithmetic instead of the chain's behaviour. The mirror is
 *     TestEffect below. It has to track parity-chain.c's tfx exactly.
 *
 *   - chain.js reaches the world through `createEffect` from the effects
 *     registry, which would drag 22 unported modules into a test about slot
 *     ordering. So, the same probe trick verify-delay-line-parity.mjs uses for
 *     makeLP: the runner writes a throwaway copy of chain.js with that one
 *     import line swapped for a hook, and imports that. The code under test is
 *     byte-for-byte the shipping code apart from where its effects come from,
 *     and the substitution is asserted rather than assumed — a regex that
 *     silently matched nothing would leave this file testing a copy of the
 *     original registry instead of the chain.
 *
 * On param keys: Chain.setParam takes a string, because engine.js hands it one;
 * bk_chain_set_param takes the int the wire carries. PARAM_KEYS is the test
 * effect's own name/index table, standing in for the per-type table
 * param-schema.ts generates and the worklet already carries as
 * slot.paramNames.
 *
 * The int is a *per-effect-type* index, so the chain cannot recognise "quality"
 * from it and no longer tries: bk_chain_set_param does not recalculate latency,
 * and the caller does. Both sides of this comparison therefore play host —
 * run_script() in the C and runScript() here each recalculate after a quality
 * key, unconditionally, which is what keeps chain.js's recalc-on-a-miss
 * behaviour reproduced rather than quietly dropped. chain.js still does it
 * internally, so the JS side must not do it twice.
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
  maxAbs,
} from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

/*
 * Bit-identity baselines, pinned rather than printed.
 *
 * chain.c does almost no arithmetic of its own — the crossfade is two
 * multiplies and an add, and everything else is bookkeeping — so unlike fft
 * there is no libm in the path and every record should be bit-identical on
 * every toolchain. That makes these baselines tight on purpose: any drop at
 * all is a real behavioural change, not libm spread. See the note in
 * assertIdentity (parity-stream.mjs) before re-baselining.
 */
const IDENTITY_NATIVE = 21;
const IDENTITY_WASM = 21;
const IDENTITY_CROSS = 21;

const { native, wasm } = buildAndRun({
  root,
  name: "parity-chain",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/chain.c"),
    join(root, "packages/native/tests/parity-chain.c"),
  ],
  ok,
  state,
});

console.log(`\n   ${native.length} scripts in the battery`);

// ---------------------------------------------------------------------------
// the JS under test, with createEffect coming from here instead of the registry
// ---------------------------------------------------------------------------

const coreDir = join(root, "packages/web/public/dsp/core");
const probe = join(coreDir, ".parity-probe.chain.mjs");
const IMPORT_RE = /^import \{ createEffect \} from "\.\.\/effects\/registry\.js";$/m;
let js;
try {
  const src = readFileSync(join(coreDir, "chain.js"), "utf8");
  const hits = src.match(new RegExp(IMPORT_RE.source, "gm")) || [];
  ok("chain.js imports createEffect exactly once (the probe's only edit)", hits.length === 1, `${hits.length} matches`);
  const patched = src.replace(
    IMPORT_RE,
    'const createEffect = (type, sr, maxBlock) => globalThis.__BK_PARITY_CREATE_EFFECT(type, sr, maxBlock);',
  );
  ok("the probe substitution changed the source", patched !== src);
  writeFileSync(probe, patched);
  js = await import(`${pathToFileURL(probe).href}?t=${Date.now()}`);
  ok("the probe exports Chain and MAX_SLOTS", typeof js.Chain === "function" && js.MAX_SLOTS === 24);
} finally {
  rmSync(probe, { force: true });
}

// ---------------------------------------------------------------------------
// the test effect, mirroring tfx in parity-chain.c
// ---------------------------------------------------------------------------

/** Canonical param id -> the string key Chain.setParam expects. */
const PARAM_KEYS = ["quality", "gain", "carrier", "latency", "inert"];
const PK_QUALITY = 0;

/**
 * Minimal variant: process, reset and setParam only.
 *
 * setParam stays even here, because Chain.setParam calls it unconditionally
 * and an effect without one would throw a TypeError rather than produce a
 * value to compare. bk_chain_set_param skips a NULL set_param instead; that
 * divergence is deliberate, documented, and untested for want of anything to
 * diff. Everything else optional is genuinely absent, which is what exercises
 * the chain's duck typing against the port's NULL vtable entries.
 */
class TestEffect {
  constructor(id) {
    this.gain = 0.5 + 0.25 * (id % 4);
    this.carrierAmt = 0.125 * (id % 3);
    this.latency = (id % 3) * 8;
    this.meterMode = id % 5;
    this.zl = 0;
    this.zr = 0;
    this.calls = 0;
    this.resets = 0;
    this.lastKey = -1;
    this.lastValue = 0;
    this.cl = null;
    this.cr = null;
    // Counted, not just stored: a chain that calls setCarrierBus with a null
    // bus looks exactly like one that never called it if only cl is recorded.
    this.carrierSets = 0;
  }

  process(L, R, frames) {
    for (let i = 0; i < frames; i++) {
      this.zl = this.zl * 0.5 + L[i] * this.gain;
      this.zr = this.zr * 0.5 + R[i] * this.gain;
      if (this.cl) {
        this.zl += this.cl[i] * this.carrierAmt;
        this.zr += this.cr[i] * this.carrierAmt;
      }
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
    this.lastKey = PARAM_KEYS.indexOf(key);
    this.lastValue = value;
    if (key === "quality") this.latency = Math.trunc(value);
    else if (key === "gain") this.gain = value;
    else if (key === "carrier") this.carrierAmt = value;
    else if (key === "latency") this.latency = Math.trunc(value);
  }
}

/** The full vtable's equivalent: a carrier bus, a latency report, a meter. */
class FullTestEffect extends TestEffect {
  setCarrierBus(l, r) {
    this.cl = l;
    this.cr = r;
    this.carrierSets++;
  }

  get latencySamples() {
    return this.latency;
  }

  get meter() {
    switch (this.meterMode) {
      case 1:
        return NaN; // -> 0 through `effect.meter || 0`
      case 2:
        return 0;
      case 3:
        return -0; // -> +0, same quirk
      case 4:
        return 0.25;
      default:
        return this.zl;
    }
  }
}

globalThis.__BK_PARITY_CREATE_EFFECT = (type) =>
  type >= 100 ? new TestEffect(type) : new FullTestEffect(type);

// ---------------------------------------------------------------------------
// the VM, mirroring run_script() in parity-chain.c
// ---------------------------------------------------------------------------

const SR = 48000;
const MAX_BLOCK = 256;
const SIG_LEN = 8192;
const MAX_SLOTS = 24;
const METER_BUF = MAX_SLOTS + 4;
const N_PROBE = 12;
const PROBE_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 100, 101, 102, 999];
const SLOT_FIELDS = 17; // must match snap() in parity-chain.c
const UNSET = -1e9;

const OP = {
  ADD: 1,
  REMOVE: 2,
  MOVE: 3,
  PARAM: 4,
  MIX: 5,
  BYPASS: 6,
  RESETSLOT: 7,
  CLEAR: 8,
  PANIC: 9,
  PROCESS: 10,
  CARRIER: 11,
  SNAP: 12,
};

const sigL = fillSignal(SIG_LEN, 2); // noise
const sigR = fillSignal(SIG_LEN, 3); // ramp
const carrierL = new Float32Array(MAX_BLOCK);
const carrierR = new Float32Array(MAX_BLOCK);
for (let i = 0; i < MAX_BLOCK; i++) {
  carrierL[i] = sigL[(i + 777) % SIG_LEN];
  carrierR[i] = sigR[(i + 1337) % SIG_LEN];
}

/**
 * Replay one script. Returns the two payloads plus the offsets at which the
 * per-op trace, the add results and the snapshots landed, so the checks below
 * can read the *native* dump at the same places instead of trusting the JS.
 */
function runScript(rec) {
  const maxSlots = rec.params[0];
  const nOps = rec.params[1];
  const ops = rec.params.subarray(2);

  const chain = new js.Chain(SR, MAX_BLOCK, { maxSlots });
  const out64 = [];
  const out32 = [];
  const trace = []; // { code, at } into out64, the (length, latency) pair
  const addAt = [];
  const snapAt = [];
  const blkL = new Float32Array(MAX_BLOCK);
  const blkR = new Float32Array(MAX_BLOCK);
  let cursor = 0;

  for (let o = 0; o < nOps; o++) {
    const code = ops[o * 5 + 0];
    const a = ops[o * 5 + 1];
    const b = ops[o * 5 + 2];
    const c = ops[o * 5 + 3];
    const d = ops[o * 5 + 4];

    switch (code) {
      case OP.ADD: {
        const id = a;
        const spec = { id, type: id };
        if (b !== UNSET) spec.index = b;
        if (c !== UNSET) spec.mix = c;
        if (d !== UNSET) spec.bypassed = d;
        const got = chain.add(spec);
        addAt.push(out64.length);
        out64.push(got ? 1 : 0);
        break;
      }
      case OP.REMOVE:
        chain.remove(a);
        break;
      case OP.MOVE:
        chain.move(a, b);
        break;
      case OP.PARAM:
        // chain.js compares the string itself and recalculates internally, so
        // the host's recalc is already covered on this side. Calling
        // recalcLatency() again here would be harmless (it is idempotent) but
        // would stop this line from testing that the JS does it at all.
        chain.setParam(a, PARAM_KEYS[b], c);
        break;
      case OP.MIX:
        chain.setMix(a, b);
        break;
      case OP.BYPASS:
        chain.setBypass(a, b);
        break;
      case OP.RESETSLOT:
        chain.resetSlot(a);
        break;
      case OP.CLEAR:
        chain.clear();
        break;
      case OP.PANIC:
        chain.panic();
        break;
      case OP.CARRIER:
        // The JS constructor is where carrierL/R normally arrive; assigning the
        // fields is what bk_chain_set_carrier_bus does and what the worklet
        // does when it rebuilds a chain's bus.
        if (a >= 0.5) {
          chain.carrierL = carrierL;
          chain.carrierR = carrierR;
        } else {
          chain.carrierL = null;
          chain.carrierR = null;
        }
        break;
      case OP.PROCESS: {
        const frames = a;
        for (let i = 0; i < frames; i++) {
          blkL[i] = sigL[(cursor + i) % SIG_LEN];
          blkR[i] = sigR[(cursor + i) % SIG_LEN];
        }
        cursor += frames;
        chain.process(blkL, blkR, frames);
        for (let i = 0; i < frames; i++) out32.push(blkL[i]);
        for (let i = 0; i < frames; i++) out32.push(blkR[i]);
        break;
      }
      case OP.SNAP:
        snapAt.push(out64.length);
        pushSnap(chain, out64);
        break;
      default:
        throw new Error(`${rec.name}: unknown opcode ${code}`);
    }

    trace.push({ code, at: out64.length });
    out64.push(chain.length, chain.latencySamples);
  }

  return {
    out64: new Float64Array(out64),
    out32: new Float32Array(out32),
    trace,
    addAt,
    snapAt,
  };
}

/** Mirror of snap() in parity-chain.c. Order is load-bearing. */
function pushSnap(chain, p) {
  p.push(chain.length, chain.latencySamples);
  for (let i = 0; i < chain.slots.length; i++) {
    const s = chain.slots[i];
    const e = s.effect;
    p.push(
      s.id,
      s.type,
      s.bypassed ? 1 : 0,
      s.mix.value,
      s.mix.target,
      s.mixTarget,
      e.gain,
      e.latency,
      e.calls,
      e.resets,
      e.zl,
      e.zr,
      e.lastKey,
      e.lastValue,
      e.cl ? 1 : 0,
      e.carrierAmt,
      e.carrierSets ?? 0,
    );
  }
  const meters = new Float64Array(METER_BUF).fill(-7);
  const n = chain.readSlotMeters(meters, 2);
  p.push(n);
  for (let i = 0; i < METER_BUF; i++) p.push(meters[i]);
  for (let i = 0; i < N_PROBE; i++) {
    p.push(chain._indexOf(PROBE_IDS[i]), chain.find(PROBE_IDS[i]) ? 1 : 0);
  }
}

/** Decode a snapshot out of either dump, so the checks read real numbers. */
function decodeSnap(buf, at) {
  let o = at;
  const length = buf[o++];
  const latency = buf[o++];
  const slots = [];
  for (let i = 0; i < length; i++) {
    const [id, type, bypassed, mixValue, mixSmootherTarget, mixTarget, gain, lat, calls, resets, zl, zr, lastKey, lastValue, hasCarrier, carrierAmt, carrierSets] =
      buf.subarray(o, o + SLOT_FIELDS);
    o += SLOT_FIELDS;
    slots.push({ id, type, bypassed, mixValue, mixSmootherTarget, mixTarget, gain, latency: lat, calls, resets, zl, zr, lastKey, lastValue, hasCarrier, carrierAmt, carrierSets });
  }
  const meterCount = buf[o++];
  const meters = Array.from(buf.subarray(o, o + METER_BUF));
  o += METER_BUF;
  const indexOf = [];
  const found = [];
  for (let i = 0; i < N_PROBE; i++) {
    indexOf.push(buf[o++]);
    found.push(buf[o++]);
  }
  return { length, latency, slots, meterCount, meters, indexOf, found, end: o };
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
// sanity: the battery has to actually exercise the chain
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises chain ==");

const byName = new Map(native.map((r) => [r.name, r]));
const want = [
  "empty", "single", "mix-glide", "fast-path", "mix-zero", "order", "move-edges",
  "add-index", "bypass", "bypass-at-add", "remove", "clear-panic", "latency",
  "carrier", "minimal", "meters", "full", "blocks", "blocks-ref", "interleave",
  "order/max24",
];
{
  const missing = want.filter((n) => !byName.has(n));
  ok("every script in the battery arrived", missing.length === 0, missing.length ? `missing: ${missing}` : `${native.length} records`);
}

/** Read a native record's snapshot #i. */
const snapOf = (name, i) => {
  const rec = byName.get(name);
  return decodeSnap(rec.out64, reference(rec).snapAt[i]);
};
/** Read a native record's per-op (length, latency) trace. */
const traceOf = (name) => {
  const rec = byName.get(name);
  return reference(rec).trace.map((t) => ({ code: t.code, length: rec.out64[t.at], latency: rec.out64[t.at + 1] }));
};
/**
 * A record's PROCESS block boundaries within its float32 payload. The producer
 * emits one block at a time as [L..., R...], so a record with several PROCESS
 * ops is *not* one long L followed by one long R — every comparison below has
 * to go through here rather than splitting the payload down the middle.
 */
function blocksOf(name) {
  const rec = byName.get(name);
  const ops = rec.params.subarray(2);
  const out = [];
  let off = 0;
  for (let o = 0; o < rec.params[1]; o++) {
    if (ops[o * 5] !== OP.PROCESS) continue;
    const frames = ops[o * 5 + 1];
    out.push({ off, frames });
    off += frames * 2;
  }
  return out;
}

/**
 * The stimulus a record's PROCESS ops consumed. `flat` is laid out exactly as
 * the record's float32 payload is, so it can be diffed against it wholesale;
 * `L`/`R` are the same audio de-interleaved into two continuous channels, for
 * comparing two records that chopped the same signal into different blocks.
 */
function stimulus(name) {
  const L = [];
  const R = [];
  const flat = [];
  let cursor = 0;
  for (const { frames } of blocksOf(name)) {
    for (let i = 0; i < frames; i++) {
      const v = Math.fround(sigL[(cursor + i) % SIG_LEN]);
      L.push(v);
      flat.push(v);
    }
    for (let i = 0; i < frames; i++) {
      const v = Math.fround(sigR[(cursor + i) % SIG_LEN]);
      R.push(v);
      flat.push(v);
    }
    cursor += frames;
  }
  return { L: new Float32Array(L), R: new Float32Array(R), flat: new Float32Array(flat) };
}

/** A record's rendered audio as two continuous channels, blocks re-joined. */
function channels(name) {
  const rec = byName.get(name);
  const L = [];
  const R = [];
  for (const { off, frames } of blocksOf(name)) {
    for (let i = 0; i < frames; i++) L.push(rec.out32[off + i]);
    for (let i = 0; i < frames; i++) R.push(rec.out32[off + frames + i]);
  }
  return { L: new Float32Array(L), R: new Float32Array(R) };
}

// An empty chain must be a wire. If process() wrote anything at all — a zeroed
// scratch copied over the block, say — this catches it, and no diff against
// the JS would, because the JS would do the same.
{
  const rec = byName.get("empty");
  const { flat } = stimulus("empty");
  ok(
    "an empty chain passes audio through untouched",
    flat.length === rec.out32.length && maxAbs(flat, rec.out32).m === 0,
    `${flat.length / 2} frames over ${blocksOf("empty").length} blocks`,
  );
  const s = snapOf("empty", 0);
  ok("an empty chain reports nothing", s.length === 0 && s.latency === 0 && s.meterCount === 0);
  ok("the meter buffer outside the written range is untouched", s.meters.every((v) => v === -7), "all sentinel");
  ok("indexOf on an empty chain is -1 everywhere", s.indexOf.every((v) => v === -1) && s.found.every((v) => v === 0));
}

// Non-commutativity. If the effects were interchangeable, every ordering check
// in this battery would be vacuous.
{
  const rec = byName.get("order");
  const blocks = blocksOf("order");
  const a = blocks[0];
  const b = blocks[1];
  const before = rec.out32.subarray(a.off, a.off + a.frames * 2);
  const after = rec.out32.subarray(b.off, b.off + b.frames * 2);
  ok(
    "reordering the chain changes the audio",
    a.frames === b.frames && maxAbs(before, after).m > 1e-3,
    `delta ${maxAbs(before, after).m.toExponential(2)} over ${a.frames} frames`,
  );
  const s0 = snapOf("order", 0);
  const s1 = snapOf("order", 1);
  ok("move() puts the slot where it was asked", s0.slots.map((x) => x.id).join() === "1,2,3" && s1.slots.map((x) => x.id).join() === "3,1,2", `${s0.slots.map((x) => x.id)} -> ${s1.slots.map((x) => x.id)}`);
}

// move()'s clamp runs after the removal, so 99 lands at n-1 and not at n.
{
  const a = snapOf("move-edges", 0);
  const b = snapOf("move-edges", 1);
  const c = snapOf("move-edges", 2);
  const d = snapOf("move-edges", 3);
  ok("move(id, 99) clamps to the last index, not past it", a.slots.map((x) => x.id).join() === "2,3,1", a.slots.map((x) => x.id).join());
  ok("move(id, -5) clamps to the head", b.slots.map((x) => x.id).join() === "1,2,3", b.slots.map((x) => x.id).join());
  ok("move() to its own index is a no-op", c.slots.map((x) => x.id).join() === "1,2,3", c.slots.map((x) => x.id).join());
  ok("move() on an absent id changes nothing", d.slots.map((x) => x.id).join() === "1,2,3", d.slots.map((x) => x.id).join());
  const t = traceOf("move-edges");
  const moves = t.filter((x) => x.code === OP.MOVE);
  ok("move() never recalculates latency", moves.every((x) => x.latency === 24), `latency ${moves.map((x) => x.latency).join()}`);
}

// The fast-path threshold, checked independently of the JS: a 0.99995 mix is
// rendered as pure wet, which is only true if the branch was taken. The
// expected wet is recomputed here from the test effect alone, so this check
// does not lean on chain.js at all.
{
  const rec = byName.get("fast-path");
  const { L, R } = stimulus("fast-path");
  const n = 64;
  const wetL = Float32Array.from(L.subarray(0, n));
  const wetR = Float32Array.from(R.subarray(0, n));
  new FullTestEffect(5).process(wetL, wetR, n);
  ok(
    "a settled mix of 0.99995 renders as exactly fully wet (the fast path)",
    maxAbs(wetL, rec.out32.subarray(0, n)).m === 0 && maxAbs(wetR, rec.out32.subarray(n, n * 2)).m === 0,
    "bit-identical to the effect's own output",
  );
  const below = rec.out32.subarray(n * 2, n * 3);
  ok(
    "a settled mix of 0.9998 does not (it crossfades)",
    maxAbs(wetL, below).m > 0,
    `delta ${maxAbs(wetL, below).m.toExponential(2)}`,
  );
}

// A zero mix is pure dry, and the effect still ran. A chain that skipped the
// render would pass the audio diff and fail here.
{
  const rec = byName.get("mix-zero");
  const { flat } = stimulus("mix-zero");
  ok(
    "a zero mix is bit-identical to the dry signal",
    flat.length === rec.out32.length && maxAbs(flat, rec.out32).m === 0,
    `${flat.length / 2} frames`,
  );
  const s = snapOf("mix-zero", 0);
  ok("a zero-mix slot still renders and still advances its state", s.slots[0].calls === 2 && s.slots[0].zl !== 0, `calls ${s.slots[0].calls}, zl ${s.slots[0].zl.toExponential(2)}`);
}

// Bypass: skipped, state dropped once on the way out, latency withdrawn.
{
  const before = snapOf("bypass", 0);
  const off = snapOf("bypass", 1);
  const after = snapOf("bypass", 2);
  const back = snapOf("bypass", 3);
  const mid = (s) => s.slots.find((x) => x.id === 2);
  ok("setBypass resets the module exactly once", mid(before).resets === 0 && mid(off).resets === 1, `${mid(before).resets} -> ${mid(off).resets}`);
  ok("a bypassed module is not rendered", mid(off).calls === mid(after).calls, `calls ${mid(after).calls}`);
  ok("a bypassed module's state stays clear", mid(after).zl === 0 && mid(after).zr === 0);
  // ids 1, 2, 5 declare (id % 3) * 8 = 8, 16, 16 samples: 40 in total, and 24
  // with id 2 bypassed out of the sum.
  ok("bypassing withdraws the module's latency", before.latency === 40 && off.latency === 24, `${before.latency} -> ${off.latency}`);
  ok("un-bypassing restores it and resumes rendering", back.latency === 40 && mid(back).calls === mid(after).calls + 1, `latency ${back.latency}, calls ${mid(back).calls}`);
}

// bypassed via the spec is a different path: no reset() call at all.
{
  const s = snapOf("bypass-at-add", 1);
  const one = s.slots.find((x) => x.id === 1);
  ok("bypassed in the spec never calls reset()", one.bypassed === 1 && one.resets === 0 && one.calls === 0, `resets ${one.resets}, calls ${one.calls}`);
  ok("and its latency was never counted", s.latency === 16, `latency ${s.latency}`);
}

// The recalc-on-a-miss quirk, which is the sharpest thing in setParam.
{
  const t = traceOf("latency");
  const params = t.filter((x) => x.code === OP.PARAM);
  ok(
    "a non-quality param leaves the chain's latency stale",
    params[0].latency === 24,
    `reported ${params[0].latency}, actually 40`,
  );
  ok(
    "setParam('quality') on an ABSENT id still recalculates (JS quirk, ported)",
    params[1].latency === 40,
    `24 -> ${params[1].latency}`,
  );
  ok("setParam('quality') on a present id sets and recalculates", params[2].latency === 64, `${params[2].latency}`);
  ok("an inert param recalculates nothing", params[3].latency === 64, `${params[3].latency}`);
  const s = snapOf("latency", 5);
  ok("the inert param still reached the effect", s.slots.find((x) => x.id === 3).lastValue === 1.5);
}

// The carrier bus is read at add time and never again.
{
  const s = snapOf("carrier", 0);
  const get = (id) => s.slots.find((x) => x.id === id);
  ok("a slot added before the bus exists never gets one", get(1).hasCarrier === 0);
  // And was not told about one either. Both halves of the JS guard have to
  // hold: `this.carrierL && typeof fx.setCarrierBus === "function"`. A chain
  // that dropped the first half would hand the effect a pair of nulls, which
  // hasCarrier alone cannot tell apart from never being called.
  ok("and was never even called about it", get(1).carrierSets === 0, `sets ${get(1).carrierSets}`);
  ok("a slot added after it does", get(2).hasCarrier === 1 && get(2).carrierSets === 1, `sets ${get(2).carrierSets}`);
  ok("an effect with no setCarrierBus is left alone", get(100).hasCarrier === 0 && get(100).carrierSets === 0);
  ok("and the carrier it gets is not multiplied by zero", get(2).carrierAmt > 0, `amt ${get(2).carrierAmt}`);
  const later = snapOf("carrier", 2);
  const fed = later.slots.find((x) => x.id === 2);
  ok("detaching the bus does not reach the slots already fed", fed.hasCarrier === 1 && fed.carrierSets === 1, `sets ${fed.carrierSets}`);
  const late = later.slots.find((x) => x.id === 4);
  ok("but a slot added afterwards does not get one", late.hasCarrier === 0 && late.carrierSets === 0, `sets ${late.carrierSets}`);
}

// The optional vtable entries, all absent at once.
{
  const s = snapOf("minimal", 0);
  ok("effects with no latencySamples contribute nothing", s.latency === 0);
  ok("effects with no meter read as 0", s.meters.slice(2, 5).every((v) => v === 0), `${s.meters.slice(2, 5)}`);
  const after = snapOf("minimal", 1);
  ok("a minimal effect still bypasses and still renders", after.slots.find((x) => x.id === 101).calls === 1 && after.slots.find((x) => x.id === 100).calls === 2, `${after.slots.map((x) => x.calls)}`);
  const panicked = snapOf("minimal", 2);
  ok("panic() reaches a bypassed minimal effect too", panicked.slots.every((x) => x.resets >= 1), `${panicked.slots.map((x) => x.resets)}`);
}

// The meter quirks. A NaN reading and a -0 reading both arrive as 0.
{
  const s = snapOf("meters", 1);
  ok("readSlotMeters writes at the offset it was given", s.meters[0] === -7 && s.meters[1] === -7, `${s.meters.slice(0, 2)}`);
  ok("and writes exactly count values", s.meterCount === 6 && s.meters[2 + 6] === -7, `count ${s.meterCount}`);
  ok("a NaN meter reads back as 0 (quirk, ported)", s.meters[2] === 0 && !Number.isNaN(s.meters[2]));
  ok("a -0 meter reads back as 0 (quirk, ported)", s.meters[4] === 0);
  ok("a constant meter reads back unchanged", s.meters[5] === 0.25);
  ok("a live meter reads back the module's state", s.meters[6] !== 0 && Number.isFinite(s.meters[6]), `${s.meters[6].toExponential(2)}`);
}

// The slot ceiling, and the `maxSlots || MAX_SLOTS` reading of 0.
{
  const rec = byName.get("full");
  const { addAt } = reference(rec);
  const results = addAt.map((at) => rec.out64[at]);
  ok("a full chain refuses further adds", results.join() === "1,1,1,0,0,1", results.join());
  const s = snapOf("full", 0);
  ok("and holds exactly maxSlots", s.length === 3, `${s.length}`);
  const after = snapOf("full", 1);
  ok("removing one makes room again", after.slots.map((x) => x.id).join() === "1,3,6", after.slots.map((x) => x.id).join());
  const wide = snapOf("order/max24", 0);
  ok("maxSlots 0 means the default 24, not a chain that holds nothing", snapOf("order", 0).length === 3 && wide.length === 3);
}

// Block size independence: 1+1+2+4+8+16+32+64 has to equal one 128.
{
  // The payloads are chopped differently, so they only line up once the blocks
  // are re-joined into continuous channels.
  const split = channels("blocks");
  const whole = channels("blocks-ref");
  ok(
    "the same audio in eight blocks equals one 128-frame render",
    split.L.length === whole.L.length && maxAbs(split.L, whole.L).m === 0 && maxAbs(split.R, whole.R).m === 0,
    `${split.L.length} frames, ${blocksOf("blocks").length} blocks vs ${blocksOf("blocks-ref").length}`,
  );
  const a = snapOf("blocks", 0);
  const b = snapOf("blocks-ref", 0);
  ok("and leaves the smoother in the same place", a.slots[0].mixValue === b.slots[0].mixValue, `${a.slots[0].mixValue} vs ${b.slots[0].mixValue}`);
}

// The glide has to actually glide, or the crossfade is untested.
{
  const a = snapOf("mix-glide", 0);
  const b = snapOf("mix-glide", 1);
  const c = snapOf("mix-glide", 2);
  ok("setMix glides rather than jumping", a.slots[0].mixValue > 0.25 && a.slots[0].mixValue < 1, `${a.slots[0].mixValue.toPrecision(6)}`);
  ok("and keeps closing on it", b.slots[0].mixValue < a.slots[0].mixValue && b.slots[0].mixValue > 0.25 && b.slots[0].mixTarget === 0.25, `${a.slots[0].mixValue.toPrecision(6)} -> ${b.slots[0].mixValue.toPrecision(6)}`);
  // A 25 ms one-pole takes ~24k frames to snap to target, far more than the
  // battery renders, so "reaches it" is the wrong assertion. Replay the
  // recurrence independently instead: advance it once per frame for exactly
  // the frames the script rendered and demand the same double back. A chain
  // that advanced the smoother per block, or twice a frame, or skipped it on
  // the crossfade path, lands somewhere else.
  {
    const rec = byName.get("mix-glide");
    const ops = rec.params.subarray(2);
    const nOps = rec.params[1];
    let mixAt = -1;
    for (let o = 0; o < nOps; o++) {
      if (ops[o * 5] === OP.MIX && ops[o * 5 + 1] === 5 && ops[o * 5 + 2] === 0.25) { mixAt = o; break; }
    }
    let snaps = 0;
    let frames = 0;
    for (let o = mixAt + 1; o < nOps; o++) {
      if (ops[o * 5] === OP.PROCESS) frames += ops[o * 5 + 1];
      if (ops[o * 5] === OP.SNAP && ++snaps === 2) break;
    }
    const coeff = Math.exp(-1 / (25 * 0.001 * 48000)); // Smoother(sr, 25 ms)
    let v = 1;
    for (let i = 0; i < frames; i++) {
      v = 0.25 + (v - 0.25) * coeff;
      if (Math.abs(v - 0.25) < 1e-9) v = 0.25;
    }
    ok(
      "the mix smoother advanced exactly once per rendered frame",
      mixAt >= 0 && frames === 320 && b.slots[0].mixValue === v,
      `${frames} frames -> ${b.slots[0].mixValue}, replayed ${v}`,
    );
  }
  ok("then glides back up", c.slots[0].mixValue > 0.25 && c.slots[0].mixValue < 1, `${c.slots[0].mixValue.toPrecision(6)}`);
  const hi = snapOf("mix-glide", 3);
  const lo = snapOf("mix-glide", 4);
  ok("setMix clamps above 1", hi.slots[0].mixTarget === 1 && hi.slots[0].mixSmootherTarget === 1);
  ok("setMix clamps below 0", lo.slots[0].mixTarget === 0 && lo.slots[0].mixSmootherTarget === 0);
}

// clear() and panic().
{
  const before = snapOf("clear-panic", 0);
  const panicked = snapOf("clear-panic", 1);
  ok("panic() resets every module, bypassed ones included", before.slots.some((x) => x.resets === 1) && panicked.slots.every((x) => x.resets === (x.id === 2 ? 2 : 1)), `${panicked.slots.map((x) => `${x.id}:${x.resets}`).join(" ")}`);
  ok("panic() clears the state it reset", panicked.slots.every((x) => x.zl === 0 && x.zr === 0));
  const cleared = snapOf("clear-panic", 3);
  ok("clear() empties the chain and zeroes its latency", cleared.length === 0 && cleared.latency === 0);
  const rebuilt = snapOf("clear-panic", 4);
  ok("and the chain is usable again afterwards", rebuilt.length === 1 && rebuilt.slots[0].calls === 1, `${rebuilt.length} slots, ${rebuilt.slots[0].calls} calls`);
}

// remove()
{
  const mid = snapOf("remove", 0);
  ok("remove() takes the right slot out", mid.slots.map((x) => x.id).join() === "1,3,4", mid.slots.map((x) => x.id).join());
  const t = traceOf("remove");
  const removes = t.filter((x) => x.code === OP.REMOVE);
  // The script leaves the total stale on purpose (a non-quality param moved
  // one module's latency without recalculating), so the missed remove's recalc
  // is the only thing that can bring the total back in line. Asserting the
  // total merely "did not change" here would pass on a chain that skipped it.
  const stale = snapOf("remove", 1);
  const recalced = snapOf("remove", 2);
  const live = recalced.slots.reduce((n, x) => n + (x.bypassed ? 0 : x.latency), 0);
  ok("the param left the total stale", stale.latency !== live, `reported ${stale.latency}, actually ${live}`);
  ok(
    "remove() on an absent id still recalculates (JS behaviour, ported)",
    removes[1].length === 3 && recalced.latency === live && recalced.latency !== stale.latency,
    `length ${removes[1].length}, latency ${stale.latency} -> ${recalced.latency}`,
  );
  const emptied = snapOf("remove", 3);
  ok("removing the head and the tail leaves the middle", emptied.slots.map((x) => x.id).join() === "3", emptied.slots.map((x) => x.id).join());
}

// add()'s insertion index.
{
  const s = snapOf("add-index", 0);
  ok("add() honours index, clamping past both ends", s.slots.map((x) => x.id).join() === "5,2,3,1,4", s.slots.map((x) => x.id).join());
}

// Nothing may run away: the chain is feedback-free, so an exploding output
// means the crossfade or the scratch handling is wrong.
{
  let widest = 0;
  let where = "";
  let allFinite = true;
  for (const rec of native) {
    for (const v of rec.out32) {
      if (!Number.isFinite(v)) { allFinite = false; where = rec.name; continue; }
      const a = Math.abs(v);
      if (a > widest) (widest = a), (where = rec.name);
    }
  }
  // The test effect is z = z*0.5 + x*gain, so its DC gain is 2*gain and the
  // gains are 0.5..1.25: a three-deep cascade at the top gain can legitimately
  // reach 2.5^3 = 15.6x. Anything past that, or any non-finite sample, means
  // the crossfade or the wet scratch is feeding back.
  ok("every rendered sample is finite", allFinite, allFinite ? "no inf, no NaN" : `non-finite in ${where}`);
  ok("nothing ran away", widest > 1 && widest < 16, `widest ${widest.toFixed(4)} (${where})`);
}

// The battery has to render something, and reach every opcode.
{
  const seen = new Set();
  let frames = 0;
  for (const rec of native) {
    const ops = rec.params.subarray(2);
    for (let o = 0; o < rec.params[1]; o++) {
      seen.add(ops[o * 5]);
      if (ops[o * 5] === OP.PROCESS) frames += ops[o * 5 + 1];
    }
  }
  const unused = Object.entries(OP).filter(([, v]) => !seen.has(v)).map(([k]) => k);
  ok("every opcode is exercised", unused.length === 0, unused.length ? `unused: ${unused}` : `${seen.size} opcodes`);
  ok("the battery renders a meaningful amount of audio", frames > 2000, `${frames} frames`);
  ok("the test effect's key table agrees with the C's", PARAM_KEYS[PK_QUALITY] === "quality" && PARAM_KEYS.length === 5);
  // The chain must not react to a key on its own — that is the whole point of
  // moving the quality decision to the host. A quality key that the host does
  // NOT follow up on has to leave the total stale, and this proves the chain
  // is not secretly recalculating behind it.
  {
    const ch = new js.Chain(SR, MAX_BLOCK, {});
    ch.add({ id: 1, type: 1, paramNames: PARAM_KEYS });
    const started = ch.latencySamples;
    ch.setParam(1, "latency", 96); // not "quality": no recalc, total goes stale
    ok("a non-quality param never recalculates on its own", ch.latencySamples === started, `${started} -> ${ch.latencySamples}`);
    ok("and the recalc it skipped was a real one", ch.recalcLatency() !== started, `now ${ch.latencySamples}`);
  }
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\nchain parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
