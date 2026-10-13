/**
 * Parity oracle for the C port of dsp/effects/drive.js (Distortion,
 * Saturation, BitCrusher). Phase 5a, route (c).
 *
 * Same four steps as every module before it, on scripts/lib/parity-stream.mjs:
 * native build + battery, wasm build + battery, replay through the shipping
 * drive.js, native vs wasm. The battery lives in packages/native/tests/
 * parity-drive.c and only there; each record's params ARE the script.
 *
 * Three JS modules are loaded, all from the shipping source:
 *
 *   shipping  drive.js as imported by the app.
 *   ref       drive.js plus ONE appended line exporting SHAPERS, so OP_SHAPE
 *             can call a transfer curve directly. Nothing else changes; the
 *             sanity section checks ref and shipping render the same audio.
 *   contract  drive.js with the deliberate divergences of drive.h applied
 *             (NaN curve ignored, max_block < 1 taken as 1, frames > max_block
 *             chunked, foldback past 4096 in closed form), plus reach probes.
 *             Each edit is asserted to match the shipping source exactly once.
 *
 * Scripts named x_* are compared against `contract`; every other script
 * against `ref`. Asserted both ways: no non-x_ script touches a divergence
 * (and `contract` renders it exactly as `ref`), and every x_ script does
 * touch one, and the shipping JS really does misbehave on it (throws, or
 * renders something else, or — the foldback — would never terminate).
 *
 * Math.random: the crusher's dither draws are replaced, during process() only,
 * by a mirror of the battery's xorshift32 (OP_SEED s) or of the crusher's
 * internal generator (OP_SEED 0). Draws are counted on both sides.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildAndRun, compareToJs, compareToolchains, createChecker, fillSignal } from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

const { native, wasm } = buildAndRun({
  root,
  name: "parity-drive",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/biquad.c"),
    join(root, "packages/native/src/dsp/delay-line.c"),
    join(root, "packages/native/src/dsp/drive.c"),
    join(root, "packages/native/tests/parity-drive.c"),
  ],
  ok,
  state,
});

console.log(`\n   ${native.length} scripts in the battery`);

const fxDir = join(root, "packages/web/public/dsp/effects");
const cSrc = readFileSync(join(root, "packages/native/tests/parity-drive.c"), "utf8");
const hdr = readFileSync(join(root, "packages/native/include/brokodr/dsp/drive.h"), "utf8");
const jsSrc = readFileSync(join(fxDir, "drive.js"), "utf8");

const shipping = await import("../packages/web/public/dsp/effects/drive.js");

// ---------------------------------------------------------------------------
// ref and contract copies
// ---------------------------------------------------------------------------

const EXPOSE = "\nexport const __SHAPERS = SHAPERS;\n";
const H = "globalThis.__BK_DRIVE_HIT";

/* The C contract (drive.h, "Deliberate divergences"). */
const CONTRACT = [
  [
    "max_block below 1 is 1",
    "  constructor(sampleRate, maxBlock, defaultCurve) {\n    super(sampleRate, maxBlock);\n",
    `  constructor(sampleRate, maxBlockIn, defaultCurve) {\n    const maxBlock = maxBlockIn < 1 ? 1 : maxBlockIn;\n    if (maxBlock !== maxBlockIn) ${H}("mb_clamped");\n    super(sampleRate, maxBlock);\n`,
  ],
  [
    "NaN curve ignored",
    "        this.curve = clamp(Math.round(v), 0, SHAPERS.length - 1);\n",
    `        { const c = clamp(Math.round(v), 0, SHAPERS.length - 1); if (c === c) this.curve = c; else ${H}("curve_nan_skipped"); }\n` +
      `        if (Math.round(v) !== Math.floor(v + 0.5) && v === v) ${H}("curve_round_trap");\n` +
      `        if (Object.is(Math.round(v), -0)) ${H}("curve_round_negzero");\n` +
      `        if (v - Math.floor(v) === 0.5) ${H}("curve_round_half");\n`,
  ],
  [
    "foldback closed form past 4096",
    "    while (Math.abs(y) > t) y = y > 0 ? 2 * t - y : -2 * t - y;\n",
    `    if (Math.abs(y) <= 4096) {\n` +
      `      if (y > t) ${H}("fold_loop_pos"); if (y < -t) ${H}("fold_loop_neg"); if (Math.abs(y) > 1000) ${H}("fold_loop_long");\n` +
      `      while (Math.abs(y) > t) y = y > 0 ? 2 * t - y : -2 * t - y;\n` +
      `    } else {\n` +
      `      ${H}(y === y ? "fold_huge" : "fold_nan");\n` +
      `      let p = (y + t) % (4 * t);\n      if (p < 0) p += 4 * t;\n      y = p < 2 * t ? p - t : 3 * t - p;\n    }\n`,
  ],
  [
    "frames > max_block chunked",
    "  process(L, R, frames) {\n    // Block-rate parameter snapshot: the shaper closure reads these.\n",
    `  process(L, R, frames) {\n    let peak = 0;\n    let off = 0;\n    if (frames > this.maxBlock) ${H}("chunked");\n` +
      `    do {\n      const n = frames < this.maxBlock ? frames : this.maxBlock;\n` +
      `      this.#block(off ? L.subarray(off) : L, off ? R.subarray(off) : R, n);\n` +
      `      if (this.meter > peak) peak = this.meter;\n      if (n <= 0) break;\n      off += n;\n      frames -= n;\n` +
      `    } while (frames > 0);\n    this.meter = peak;\n  }\n\n` +
      `  #block(L, R, frames) {\n    if (frames === 0) ${H}("frames_0"); if (frames < 0) ${H}("frames_neg");\n`,
  ],
];

/* Reach probes; behaviour-neutral. */
const PROBES = [
  ["shape", "    return SHAPERS[this.curve](x * d + b);\n", `    ${H}("curve_" + this.curve); if (b !== 0) ${H}("bias_live");\n    return SHAPERS[this.curve](x * d + b);\n`],
  ["oversample", "    if (this.oversample) {\n", `    ${H}(this.oversample ? "os_on" : "os_off");\n    if (this.oversample) {\n`],
  [
    "tonemode",
    "    const type = this.toneMode === 1 ? FilterType.HIGHPASS : FilterType.LOWPASS;\n",
    `    const type = this.toneMode === 1 ? FilterType.HIGHPASS : FilterType.LOWPASS;\n    ${H}(type === FilterType.HIGHPASS ? "tone_hp" : "tone_lp"); if (this.toneMode !== this.toneMode) ${H}("tonemode_nan"); if (Object.is(this.toneMode, -0)) ${H}("tonemode_negzero"); if (this.toneMode === 2) ${H}("tonemode_2");\n`,
  ],
  [
    "meter",
    "      if (a > peak) peak = a;\n",
    `      if (a !== a) ${H}("meter_nan_frame"); if (a === Infinity) ${H}("meter_inf_frame"); if (l !== l || r !== r || Math.abs(l) === Infinity) ${H}("sanitized");\n      if (a > peak) peak = a;\n`,
  ],
  [
    "unknown drive key",
    '      case "oversample":\n        this.oversample = v >= 0.5 ? 1 : 0;\n        break;\n',
    `      case "oversample":\n        this.oversample = v >= 0.5 ? 1 : 0;\n        if (v !== v) ${H}("os_nan");\n        break;\n      default:\n        ${H}("unknown_drive");\n`,
  ],
  [
    "unknown crush key",
    '      case "smooth":\n        this.antiAlias = clamp(v, 0, 1);\n        break;\n',
    `      case "smooth":\n        this.antiAlias = clamp(v, 0, 1);\n        break;\n      default:\n        ${H}("unknown_crush");\n`,
  ],
  [
    "anti-alias",
    "      this.lpL.set(FilterType.LOWPASS, Math.min(f, this.rateHz * 0.5), 0.7071);\n",
    `      ${H}(f < this.rateHz * 0.5 ? "aa_by_smooth" : f > this.rateHz * 0.5 ? "aa_by_rate" : "aa_tie");\n      this.lpL.set(FilterType.LOWPASS, Math.min(f, this.rateHz * 0.5), 0.7071);\n`,
  ],
  [
    "hold",
    "        this.phase -= Math.floor(this.phase);\n",
    `        ${H}("crush_hold");\n        this.phase -= Math.floor(this.phase);\n`,
  ],
  ["dither", "          l += (Math.random() + Math.random() - 1) * ditherScale;\n", `          ${H}("dither");\n          l += (Math.random() + Math.random() - 1) * ditherScale;\n`],
  [
    "crush round",
    "        this.holdL = Math.round(l * levels) * inv;\n",
    `        for (const q of [l * levels, r * levels]) { if (q - Math.floor(q) === 0.5) ${H}("crush_round_half"); if (Object.is(Math.round(q), -0)) ${H}("crush_round_negzero"); if (Math.round(q) !== Math.floor(q + 0.5) && q === q) ${H}("crush_round_trap"); }\n        this.holdL = Math.round(l * levels) * inv;\n`,
  ],
];

let currentHits = new Map();
globalThis.__BK_DRIVE_HIT = (k) => currentHits.set(k, (currentHits.get(k) ?? 0) + 1);

const refPath = join(fxDir, ".parity-ref.drive.mjs");
const contractPath = join(fxDir, ".parity-contract.drive.mjs");
let ref;
let contract;
try {
  writeFileSync(refPath, jsSrc + EXPOSE);
  ref = await import(`${pathToFileURL(refPath).href}?t=${Date.now()}`);
  let src = jsSrc;
  for (const [label, find, repl] of [...CONTRACT, ...PROBES]) {
    const n = src.split(find).length - 1;
    ok(`edit "${label}" matches the shipping source exactly once`, n === 1, `${n} matches`);
    src = src.replace(find, repl);
  }
  writeFileSync(contractPath, src + EXPOSE);
  contract = await import(`${pathToFileURL(contractPath).href}?t=${Date.now()}`);
} finally {
  rmSync(refPath, { force: true });
  rmSync(contractPath, { force: true });
}

// ---------------------------------------------------------------------------
// mirrors of the C battery
// ---------------------------------------------------------------------------

const OP = { END: 0, INIT: 1, PARAM: 2, PROCESS: 3, RESET: 4, SNAP: 5, POKE: 6, REWIND: 7, SEED: 8, SHAPE: 9, MONO: 10 };
const OPW = 5;
const DRIVE_BLOCK = 12;
const CRUSH_BLOCK = 9;
const DRIVE_SNAP = 153;
const CRUSH_SNAP = 36;
const SIG_N = 65536;
const MAX_POKES = 32;
const MAX_P64 = 2000000;
const MAX_P32 = 4000000;
const SENTINEL = new Map([
  [-3e9, NaN],
  [3e9, Infinity],
  [-4e9, -Infinity],
]);
const unsentinel = (v) => (SENTINEL.has(v) ? SENTINEL.get(v) : v);

/** BK_P_DIST_* (== BK_P_SAT_*) and BK_P_CRUSH_* order. */
const DRIVE_KEYS = ["drive", "curve", "tone", "tonemode", "bias", "prehp", "output", "oversample"];
const CRUSH_KEYS = ["bits", "rate", "dither", "drive", "output", "smooth"];

const SIGS = [0, 1, 2, 3, 4].map((s) => Float32Array.from(fillSignal(SIG_N, s)));

/* Math.random mirrors: test_random() and the crusher's internal generator
   (bk_rng_seed(0x2545f491) + (bk_rng_bipolar + 1) * 0.5). */
const xorshift = (x) => {
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  return (x ^ (x << 5)) >>> 0;
};
function makeRng() {
  const g = { mode: "test", seed: 1, internal: 0x2545f491, draws: 0 };
  g.random = () => {
    g.draws++;
    if (g.mode === "test") {
      g.seed = xorshift(g.seed);
      return g.seed / 4294967296;
    }
    g.internal = xorshift(g.internal);
    return (((g.internal >>> 8) / 16777216) * 2 - 1 + 1) * 0.5;
  };
  return g;
}

/* A decision, not a mirror: Math.round(-0.3) makes the JS curve -0, an index
   SHAPERS[-0] reads as 0. The C curve is an int and cannot hold -0, so the
   reading maps -0 to 0. The audio is compared untouched. */
const curveOf = (e) => (e.curve === 0 ? 0 : e.curve);
const smootherState = (s, out) => out.push(s.value, s.target, s.a);
const biquadState = (f, out) => out.push(f.b0, f.b1, f.b2, f.a1, f.a2, f.z1, f.z2, f.type, f.freq, f.q, f.gainDb);
const lp2State = (f, out) => out.push(f.b0, f.b1, f.b2, f.a1, f.a2, f.z1, f.z2);

function blockState(e, isCrush, rng, out) {
  if (isCrush) {
    out.push(e.driveSm.value, e.driveSm.target, e.outSm.value, e.outSm.target, e.phase, e.holdL, e.holdR);
    out.push(rng.draws, 0);
  } else {
    out.push(e.drive.value, e.drive.target, e.biasSm.value, e.biasSm.target, e.outSm.value, e.outSm.target);
    out.push(e.driveVal, e.biasVal, e.meter, curveOf(e), e.toneMode, e.oversample);
  }
}

function snapState(e, isCrush, out, o32) {
  if (isCrush) {
    out.push(e.sr, e.bits, e.rateHz, e.ditherAmt, e.phase, e.holdL, e.holdR, e.antiAlias);
    smootherState(e.driveSm, out);
    smootherState(e.outSm, out);
    biquadState(e.lpL, out);
    biquadState(e.lpR, out);
    return;
  }
  out.push(e.sr, e.maxBlock, curveOf(e), e.toneFreq, e.toneMode, e.preFreq, e.oversample, e.driveVal, e.biasVal, e.meter);
  smootherState(e.drive, out);
  smootherState(e.outSm, out);
  smootherState(e.biasSm, out);
  for (const o of e.os) {
    for (const f of o.upFilters) lp2State(f, out);
    for (const f of o.downFilters) lp2State(f, out);
  }
  out.push(e.dcL.r, e.dcL.x1, e.dcL.y1, e.dcR.r, e.dcR.x1, e.dcR.y1);
  for (const b of [e.toneL, e.toneR, e.preL, e.preR]) biquadState(b, out);
  for (const a of [e.tmpL, e.tmpR, e.os[0].up, e.os[1].up]) for (let k = 0; k < a.length; k++) o32.push(a[k]);
}

/** Replay one script through module `mod`. `hits` collects probe hits. */
function replay(mod, ops, hits = new Map()) {
  const out = [];
  const o32 = [];
  const rng = makeRng();
  let e;
  let isCrush = false;
  const init = (type, sr, mb) => {
    isCrush = type === 2;
    if (isCrush) {
      e = new mod.BitCrusher(sr, mb);
      rng.mode = "test";
      rng.seed = 1;
      rng.internal = 0x2545f491;
    } else e = type === 1 ? new mod.Saturation(sr, mb) : new mod.Distortion(sr, mb);
    // vtable: no carrier bus, no latency; a meter on dist/sat only.
    out.push(1, 1, isCrush ? 1 : 0);
  };
  const saved = Math.random;
  const savedHits = currentHits;
  currentHits = hits;
  try {
    init(0, 48000, 128);
    let cursor = 0;
    let pokes = [];
    const L = new Float32Array(4096);
    const R = new Float32Array(4096);
    for (let i = 0; i + OPW <= ops.length; i += OPW) {
      const op = ops[i] | 0;
      const a = unsentinel(ops[i + 1]);
      const b = unsentinel(ops[i + 2]);
      const c = unsentinel(ops[i + 3]);
      const d = unsentinel(ops[i + 4]);
      if (op === OP.END) break;
      else if (op === OP.INIT) init(a | 0, b, c | 0);
      else if (op === OP.PARAM) e.setParam((isCrush ? CRUSH_KEYS : DRIVE_KEYS)[a] ?? `unknown:${a}`, b);
      else if (op === OP.PROCESS) {
        const bs = b | 0;
        const sl = SIGS[c | 0];
        const sr = SIGS[d | 0];
        // A negative block size reaches process() as is, with no samples.
        const vL = L.subarray(0, Math.max(bs, 0));
        const vR = R.subarray(0, Math.max(bs, 0));
        for (let k = 0; k < (a | 0); k++) {
          for (let j = 0; j < bs; j++) {
            const at = (cursor + j) % SIG_N;
            vL[j] = sl[at];
            vR[j] = -0.5 * sr[at];
          }
          cursor = (cursor + bs) % SIG_N;
          for (const [ch, at, v] of pokes) if (at < bs) (ch ? vR : vL)[at] = v;
          pokes = [];
          Math.random = rng.random;
          try {
            e.process(vL, vR, bs);
          } finally {
            Math.random = saved;
          }
          blockState(e, isCrush, rng, out);
          for (let j = 0; j < bs; j++) o32.push(vL[j]);
          for (let j = 0; j < bs; j++) o32.push(vR[j]);
        }
      } else if (op === OP.MONO) {
        // One buffer as both l and r: the aliasing a mono caller produces.
        const bs = b | 0;
        const sl = SIGS[c | 0];
        const vL = L.subarray(0, Math.max(bs, 0));
        for (let k = 0; k < (a | 0); k++) {
          for (let j = 0; j < bs; j++) vL[j] = sl[(cursor + j) % SIG_N];
          cursor = (cursor + bs) % SIG_N;
          for (const [, at, v] of pokes) if (at < bs) vL[at] = v;
          pokes = [];
          Math.random = rng.random;
          try {
            e.process(vL, vL, bs);
          } finally {
            Math.random = saved;
          }
          blockState(e, isCrush, rng, out);
          for (let j = 0; j < bs; j++) o32.push(vL[j]);
        }
      } else if (op === OP.RESET) e.reset();
      else if (op === OP.SNAP) snapState(e, isCrush, out, o32);
      else if (op === OP.POKE) {
        if (pokes.length < MAX_POKES) pokes.push([a | 0, b | 0, c]);
      } else if (op === OP.REWIND) cursor = 0;
      else if (op === OP.SEED) {
        if (a === 0) rng.mode = "internal";
        else {
          rng.mode = "test";
          rng.seed = a >>> 0;
        }
      } else if (op === OP.SHAPE) out.push(mod.__SHAPERS[a | 0](b));
    }
    snapState(e, isCrush, out, o32);
  } finally {
    Math.random = saved;
    currentHits = savedHits;
  }
  return { out64: Float64Array.from(out), out32: Float32Array.from(o32) };
}

const isX = (rec) => rec.name.startsWith("x_");

// Contract replay of every script, with per-script hits. This runs FIRST:
// the shipping foldback never terminates past the limit, so a non-x_ script
// that crosses it must be caught here rather than hang the ref replay.
const contractOut = new Map();
const scriptHits = new Map();
for (const rec of native) {
  const h = new Map();
  contractOut.set(rec.name, replay(contract, rec.params, h));
  scriptHits.set(rec.name, h);
}
const DIVERGENCE_HITS = ["mb_clamped", "curve_nan_skipped", "chunked", "fold_huge"];
const needsContract = (name) => DIVERGENCE_HITS.filter((k) => (scriptHits.get(name).get(k) ?? 0) > 0);

const refOut = new Map();
for (const rec of native) {
  if (isX(rec) || needsContract(rec.name).length) continue;
  refOut.set(rec.name, replay(ref, rec.params));
}
const EMPTY = { out64: new Float64Array(0), out32: new Float32Array(0) };
const reference = (rec) => (isX(rec) ? contractOut.get(rec.name) : refOut.get(rec.name) ?? EMPTY);

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

/*
 * Bit-identity baselines, pinned. MEASURED 2026-10-02 on glibc / emscripten /
 * V8; MSVC unmeasured. Every record is inside tolerance (checked above).
 *   native vs JS:   2 drift (s_reset, s_shape)
 *   wasm vs JS:     10 drift
 *   native vs wasm: 9 drift
 * c_bits_pow drifts on wasm by construction: its bits value was picked where
 * glibc's pow(2, x) and V8's Math.pow agree (and glibc's exp2 does not, to catch
 * a pow -> exp2 swap natively); musl's pow there gives a different double.
 * s_shape traced: bk_drive_shape(4, 1.6) is sin(3.04) * 0.85, and glibc's
 * sin(3.04) is one ulp off V8's (0.08620528836911158 vs 0.0862052883691116).
 * The rest are NOT traced record by record. What was measured: on 200000
 * inputs in [-4, 4], glibc and V8 disagree on exp for 20292, sin for 6740,
 * tanh for 63 — the three libm calls the shapers make — and the drifted
 * fields are double filter state downstream of a shaper. Bit-identity is an
 * empirical per-module result, not a guarantee.
 */
const IDENTITY_NATIVE = 48;
const IDENTITY_WASM = 40;
const IDENTITY_CROSS = 41;

compareToJs({ name: "native", dump: native, reference, ok, expectIdentical: IDENTITY_NATIVE });
if (wasm) {
  compareToJs({ name: "wasm", dump: wasm, reference, ok, expectIdentical: IDENTITY_WASM });
  compareToolchains({ native, wasm, ok, expectIdentical: IDENTITY_CROSS });
}

{
  const strictSame = (x, y) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
  const strict = (label, dump, other, expect) => {
    let same = 0;
    const off = [];
    dump.forEach((rec, i) => {
      const r = other(rec, i);
      if (strictSame(r.out64, rec.out64) && strictSame(r.out32, rec.out32)) same++;
      else if (off.length < 6) {
        const at64 = rec.out64.findIndex((v, k) => !Object.is(v, r.out64[k]));
        const at32 = rec.out32.findIndex((v, k) => !Object.is(v, r.out32[k]));
        const at = at64 >= 0 ? `out64[${at64}] ${rec.out64[at64]} vs ${r.out64[at64]}` : `out32[${at32}] ${rec.out32[at32]} vs ${r.out32[at32]}`;
        off.push(`${rec.name} (${at})`);
      }
    });
    ok(`${label}: ${expect} records identical with the sign of zero (Object.is)`, same === expect, `${same}/${dump.length}${off.length ? ` — ${off.join(", ")}` : ""}`);
  };
  // s_fold_edge and x_shape_huge only run fold(): fabs, compare, add, mul and
  // fmod (JS %), all correctly rounded in IEEE 754, so their identity is
  // guaranteed and required by name rather than counted. The loop/closed-form
  // edge and the wrap's p < 0 edge only move the last bits (see parity-drive.c).
  // s_diode_tiny adds exp(+-tiny), which is exactly 1 in glibc, musl and V8:
  // empirical, but it is what pins the diode's 1 - exp form and sign of zero.
  const edge = (label, dump, other) => {
    for (const [name, n] of [["s_fold_edge", 9], ["x_shape_huge", 13], ["s_diode_tiny", 6]]) {
      const i = dump.findIndex((r) => r.name === name);
      const r = i >= 0 ? other(dump[i], i) : null;
      ok(`${label}: ${name} is bit-identical`, !!r && strictSame(r.out64, dump[i].out64) && strictSame(r.out32, dump[i].out32) && dump[i].out64.length >= n, r ? `${dump[i].out64.length} values, ${strictSame(r.out64, dump[i].out64)}/${strictSame(r.out32, dump[i].out32)}` : "missing");
    }
  };
  console.log("\n== fold edge ==");
  edge("native vs JS", native, reference);
  if (wasm) {
    edge("wasm vs JS", wasm, reference);
    edge("native vs wasm", native, (_, i) => wasm[i]);
  }
  console.log("\n== sign of zero ==");
  strict("native vs JS", native, reference, IDENTITY_NATIVE);
  if (wasm) {
    strict("wasm vs JS", wasm, reference, IDENTITY_WASM);
    strict("native vs wasm", native, (_, i) => wasm[i], IDENTITY_CROSS);
  }
}

// ---------------------------------------------------------------------------
// the divergences
// ---------------------------------------------------------------------------

console.log("\n== deliberate divergences: only x_* scripts need the contract ==");
{
  const strictSame = (x, y) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
  const offenders = native.filter((r) => !isX(r) && needsContract(r.name).length).map((r) => `${r.name}: ${needsContract(r.name).join("+")}`);
  ok("no non-x_ script touches a divergence", offenders.length === 0, offenders.join(", "));
  let same = 0;
  let total = 0;
  for (const rec of native) {
    if (isX(rec) || !refOut.has(rec.name)) continue;
    total++;
    const a = refOut.get(rec.name);
    const b = contractOut.get(rec.name);
    if (strictSame(a.out64, b.out64) && strictSame(a.out32, b.out32)) same++;
  }
  ok("the contract (+ probes) renders every non-x_ script exactly as the shipping JS", same === total && total > 0, `${same}/${total}`);
  {
    // ref is shipping + one export line; it must render what shipping does.
    let s2 = 0;
    let t2 = 0;
    for (const rec of native) {
      if (isX(rec) || !refOut.has(rec.name)) continue;
      let hasShape = false;
      for (let i = 0; i < rec.params.length; i += OPW) if ((rec.params[i] | 0) === OP.SHAPE) hasShape = true;
      if (hasShape) continue;
      t2++;
      const a = replay(shipping, rec.params);
      const b = refOut.get(rec.name);
      if (strictSame(a.out64, b.out64) && strictSame(a.out32, b.out32)) s2++;
    }
    ok("ref (shipping + SHAPERS export) renders what the shipping module does", s2 === t2 && t2 > 0, `${s2}/${t2}`);
  }

  const xs = native.filter(isX);
  for (const rec of xs) ok(`${rec.name} touches a divergence`, needsContract(rec.name).length > 0, needsContract(rec.name).join("+"));
  const run = (name) => {
    const rec = native.find((r) => r.name === name);
    try {
      return { res: replay(ref, rec.params) };
    } catch (err) {
      return { err };
    }
  };
  {
    const r = run("x_curve_nan");
    ok("the shipping JS throws a TypeError on a NaN curve", r.err instanceof TypeError, r.err ? String(r.err).slice(0, 80) : "no throw");
  }
  {
    const r = run("x_maxblock");
    ok("the shipping JS throws a RangeError on a negative max block", r.err instanceof RangeError, r.err ? String(r.err).slice(0, 80) : "no throw");
  }
  {
    const r = run("x_chunk");
    const c = contractOut.get("x_chunk");
    const differs = r.res && !(strictSame(r.res.out64, c.out64) && strictSame(r.res.out32, c.out32));
    ok("the shipping JS renders frames > max_block differently (no chunking)", !!differs, r.err ? `threw ${r.err}` : "");
  }
  for (const n of ["x_fold_huge", "x_shape_huge"]) {
    ok(`${n} feeds the foldback past the limit (the shipping loop would not terminate on inf)`, (scriptHits.get(n).get("fold_huge") ?? 0) > 0);
  }
  {
    // The closed form really is the loop's triangle: agree with the loop
    // wherever the loop is cheap enough to run (up to 1e5), within rounding.
    const loop = (x) => {
      let y = x;
      while (Math.abs(y) > 0.8) y = y > 0 ? 1.6 - y : -1.6 - y;
      return y;
    };
    const closed = (y) => {
      let p = (y + 0.8) % 3.2;
      if (p < 0) p += 3.2;
      return p < 1.6 ? p - 0.8 : 2.4 - p;
    };
    let worst = 0;
    // The loop's subtractions accumulate rounding (|x| / 3.2 steps), so the
    // two agree to within that, not bit for bit; drive.h says so.
    for (let k = 0; k < 4000; k++) {
      const x = (k % 2 ? -1 : 1) * (4096 + k * 23.71);
      worst = Math.max(worst, Math.abs(loop(x) - closed(x)));
    }
    ok("closed-form foldback matches the loop past 4096 to -120 dB", worst < 1e-6, `worst ${worst.toExponential(2)} up to |x| = 1e5`);
  }
}

// ---------------------------------------------------------------------------
// sanity
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises drive.js ==");
{
  for (const [name, value] of Object.entries(OP)) {
    const m = cSrc.match(new RegExp(`OP_${name}\\s*=\\s*(\\d+)`));
    ok(`OP_${name} mirrors the C`, m !== null && Number(m[1]) === value, m ? `${m[1]} vs ${value}` : "not found");
  }
  const def = (src, n) => {
    const m = src.match(new RegExp(`#define ${n} \\(?(-?[\\d.e]+)\\)?`));
    return m ? Number(m[1]) : NaN;
  };
  ok("OPW mirrors the C", def(cSrc, "OPW") === OPW);
  ok("SIG_N mirrors the C", def(cSrc, "SIG_N") === SIG_N);
  ok("BK_DRIVE_BLOCK mirrors the C", def(cSrc, "BK_DRIVE_BLOCK") === DRIVE_BLOCK);
  ok("BK_CRUSH_BLOCK mirrors the C", def(cSrc, "BK_CRUSH_BLOCK") === CRUSH_BLOCK);
  ok("BK_DRIVE_SNAP mirrors the C", def(cSrc, "BK_DRIVE_SNAP") === DRIVE_SNAP);
  ok("BK_CRUSH_SNAP mirrors the C", def(cSrc, "BK_CRUSH_SNAP") === CRUSH_SNAP);
  ok("MAX_POKES mirrors the C", def(cSrc, "MAX_POKES") === MAX_POKES);
  ok("MAX_P64 / MAX_P32 mirror the C", def(cSrc, "MAX_P64") === MAX_P64 && def(cSrc, "MAX_P32") === MAX_P32);
  ok("BK_DRIVE_FOLD_LIMIT is the contract's 4096", def(hdr, "BK_DRIVE_FOLD_LIMIT") === 4096);
  ok("BK_DRIVE_CURVES equals SHAPERS.length", def(hdr, "BK_DRIVE_CURVES") === ref.__SHAPERS.length);
  {
    const fn = (n) => cSrc.match(new RegExp(`static void ${n}\\([\\s\\S]*?\\n\\}`))[0];
    const pushes = (s) => (s.match(/push64\(/g) || []).length;
    const bs = fn("block_state");
    const [crushPart, drivePart] = bs.split("} else {");
    ok("block_state: crusher branch pushes BK_CRUSH_BLOCK", pushes(crushPart) === CRUSH_BLOCK, `${pushes(crushPart)}`);
    ok("block_state: drive branch pushes BK_DRIVE_BLOCK", pushes(drivePart) === DRIVE_BLOCK, `${pushes(drivePart)}`);
    ok("smoother_state pushes 3", pushes(fn("smoother_state")) === 3);
    ok("biquad_state pushes 11", pushes(fn("biquad_state")) === 11);
    ok("lp2_state pushes 7", pushes(fn("lp2_state")) === 7);
    ok("BK_DRIVE_SNAP is the structural count", 10 + 3 * 3 + 2 * 6 * 7 + 6 + 4 * 11 === DRIVE_SNAP);
    ok("BK_CRUSH_SNAP is the structural count", 8 + 2 * 3 + 2 * 11 === CRUSH_SNAP);
    const ss = fn("snap_state");
    const [cs, ds] = ss.split("} else {");
    ok("snap_state: crusher pushes 8 scalars + 2 smoothers + 2 biquads", pushes(cs) === 8 && (cs.match(/smoother_state\(/g) || []).length === 2 && (cs.match(/biquad_state\(/g) || []).length === 2);
    ok("snap_state: drive pushes 16 scalars + 3 smoothers + 2 lp2 loops + 4 biquads", pushes(ds) === 16 && (ds.match(/smoother_state\(/g) || []).length === 3 && (ds.match(/lp2_state\(/g) || []).length === 2 && (ds.match(/biquad_state\(/g) || []).length === 4);
  }
  {
    const worst64 = Math.max(...native.map((r) => r.out64.length));
    const worst32 = Math.max(...native.map((r) => r.out32.length));
    ok("no record reaches the payload cap (C exits 3 at the cap)", worst64 < MAX_P64 && worst32 < MAX_P32, `${worst64} / ${worst32}`);
    ok("the C exits 3 on payload overflow", /payload overflow[\s\S]{0,40}exit\(3\)/.test(cSrc));
  }
  for (const [n, v] of [["NAN_", -3e9], ["INF_", 3e9], ["NINF_", -4e9]]) ok(`sentinel ${n} mirrors the C`, def(cSrc, n) === v);
  ok(
    "the stimulus mirror matches the C",
    cSrc.includes("g_r[j] = -0.5f * g_sig[sr][at];") && cSrc.includes("g_cursor = (g_cursor + bs) % SIG_N;"),
  );
  ok(
    "the Math.random mirror matches the C",
    /unsigned int x = \*seed;\s*x \^= x << 13;\s*x \^= x >> 17;\s*x \^= x << 5;\s*\*seed = x;\s*g_draws \+= 1\.0;\s*return \(double\)x \/ 4294967296\.0;/.test(cSrc) &&
      readFileSync(join(root, "packages/native/src/dsp/drive.c"), "utf8").includes("bk_rng_seed(&c->rng, 0x2545f491u);") &&
      /g_seed = 1u;\s*bk_crush_set_random\(&g_crush, test_random, &g_seed\);/.test(cSrc),
  );
  {
    const utilsC = readFileSync(join(root, "packages/native/src/dsp/utils.c"), "utf8");
    ok(
      "the internal-generator mirror matches bk_rng_bipolar",
      /x \^= x << 13;\s*x \^= x >> 17;\s*x \^= x << 5;\s*\*state = x;\s*return \(\(double\)\(x >> 8\) \/ 16777216\.0\) \* 2\.0 - 1\.0;/.test(utilsC) &&
        /\*state = seed \? seed : 0x1u;/.test(utilsC),
    );
  }
  {
    const keysH = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
    const fromHeader = (p) =>
      [...keysH.matchAll(new RegExp(`BK_P_${p}_([A-Z0-9_]+) = (\\d+)`, "g"))]
        .filter((m) => m[1] !== "COUNT")
        .sort((x, y) => Number(x[2]) - Number(y[2]))
        .map((m) => m[1].toLowerCase().replace(/_/g, ""));
    const schema = await import("../packages/web/src/web/audio/param-schema.ts");
    for (const [id, p, keys] of [["dist", "DIST", DRIVE_KEYS], ["sat", "SAT", DRIVE_KEYS], ["crush", "CRUSH", CRUSH_KEYS]]) {
      ok(`keys match BK_P_${p}_* in param-keys.h`, fromHeader(p).join() === keys.join(), fromHeader(p).join());
      ok(`keys match the ${id} param schema`, schema.EFFECTS[id].params.map((q) => q.key).join() === keys.join());
    }
    ok("Distortion / Saturation / BitCrusher ids", shipping.Distortion.id === "dist" && shipping.Saturation.id === "sat" && shipping.BitCrusher.id === "crush");
    for (const k of DRIVE_KEYS) ok(`setParam handles "${k}" (drive)`, jsSrc.includes(`case "${k}":`));
    for (const k of CRUSH_KEYS) ok(`setParam handles "${k}" (crush)`, jsSrc.includes(`case "${k}":`));
  }
  {
    const all = new Map();
    for (const h of scriptHits.values()) for (const [k, v] of h) all.set(k, (all.get(k) ?? 0) + v);
    const must = [
      "curve_0", "curve_1", "curve_2", "curve_3", "curve_4", "curve_5", "bias_live",
      "curve_round_trap", "curve_round_negzero", "curve_round_half", "curve_nan_skipped",
      "fold_loop_pos", "fold_loop_neg", "fold_loop_long", "fold_huge", "fold_nan",
      "os_on", "os_off", "os_nan", "tone_hp", "tone_lp", "tonemode_nan", "tonemode_negzero", "tonemode_2",
      "meter_nan_frame", "meter_inf_frame", "sanitized", "frames_0", "frames_neg", "chunked", "mb_clamped",
      "unknown_drive", "unknown_crush", "aa_by_smooth", "aa_by_rate", "crush_hold", "dither",
      "crush_round_half", "crush_round_negzero", "crush_round_trap",
    ];
    for (const k of must) ok(`reached: ${k}`, (all.get(k) ?? 0) > 0, `${all.get(k) ?? 0} hits`);
    const internal = native.find((r) => r.name === "c_dither_internal");
    ok("the internal generator is drawn from", internal && contractOut.get("c_dither_internal").out64.some((v) => v > 0));
  }
  ok("every script in the C appears in the dump", (cSrc.match(/\bS\([sxc]_\w+\)/g) || []).length === native.length);
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\ndrive parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
