/**
 * Parity oracle for the C port of dsp/effects/eq.js (Phase 5a, route (c)).
 *
 * Same four steps as every module before it, on scripts/lib/parity-stream.mjs:
 * native build + battery, wasm build + battery, replay through the shipping
 * eq.js, native vs wasm. The battery lives in packages/native/tests/parity-eq.c
 * and only there; each record's params ARE the script, interpreted here.
 *
 * Mirrored by hand and asserted against the C source in the sanity section:
 * the opcode table, the op row width, block_state()/snap_state() field order,
 * the stimulus (65536-sample period, right channel halved and negated) and the
 * NaN / +inf / -inf sentinels.
 *
 * One mapping is a decision, not a mirror: the JS cascade's `active` is
 * `undefined` before the first block (C: -1) and NaN after a NaN slope (C: 0,
 * because `i < NaN` runs no stages). The readings map the JS values onto the
 * C's encoding; the audio itself is compared untouched.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAndRun, compareToJs, compareToolchains, createChecker, fillSignal } from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

const { native, wasm } = buildAndRun({
  root,
  name: "parity-eq",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/biquad.c"),
    join(root, "packages/native/src/dsp/eq.c"),
    join(root, "packages/native/tests/parity-eq.c"),
  ],
  ok,
  state,
});

console.log(`\n   ${native.length} scripts in the battery`);

const fxDir = join(root, "packages/web/public/dsp/effects");
const cSrc = readFileSync(join(root, "packages/native/tests/parity-eq.c"), "utf8");
const hdr = readFileSync(join(root, "packages/native/include/brokodr/dsp/eq.h"), "utf8");
const jsSrc = readFileSync(join(fxDir, "eq.js"), "utf8");

const shipping = await import("../packages/web/public/dsp/effects/eq.js");

// ---------------------------------------------------------------------------
// instrumented probe copy, for reach checks only
// ---------------------------------------------------------------------------

const H = "globalThis.__BK_EQ_HIT";
const PROBES = [
  [
    "hp_switch",
    "      c.hp.setActive(this.p.hpFreq <= 21 ? 0 : hpStages);\n",
    `      c.hp.setActive(this.p.hpFreq <= 21 ? 0 : hpStages);\n      if (this.p.hpFreq <= 21 && hpFreq > 21) ${H}("hp_off_mid_glide");\n      if (this.p.hpFreq > 21 && hpFreq <= 21) ${H}("hp_on_mid_glide");\n      if (this.p.hpFreq === 21) ${H}("hp_exactly_21");\n      if (hpStages !== hpStages) ${H}("hp_slope_nan");\n`,
  ],
  [
    "lp_switch",
    "      c.lp.setActive(this.p.lpFreq >= 19900 ? 0 : lpStages);\n",
    `      c.lp.setActive(this.p.lpFreq >= 19900 ? 0 : lpStages);\n      if (this.p.lpFreq >= 19900 && lpFreq < 19900) ${H}("lp_off_mid_glide");\n      if (this.p.lpFreq < 19900 && lpFreq >= 19900) ${H}("lp_on_mid_glide");\n      if (this.p.lpFreq === 19900) ${H}("lp_exactly_19900");\n      if (lpStages !== lpStages) ${H}("lp_slope_nan");\n      ${H}("hp_stages_" + c.hp.active); ${H}("lp_stages_" + c.lp.active);\n`,
  ],
  [
    "slope_round",
    "    const hpStages = 1 + Math.round(clamp(this.p.hpSlope, 0, 3));\n",
    `    const hpStages = 1 + Math.round(clamp(this.p.hpSlope, 0, 3));\n    { const v = clamp(this.p.hpSlope, 0, 3); if (Math.round(v) !== Math.floor(v + 0.5)) ${H}("round_trap"); if (v - Math.floor(v) === 0.5) ${H}("round_half"); }\n`,
  ],
  ["render", "  #renderCurve() {\n", `  #renderCurve() {\n    ${H}("render");\n`],
  ["unknown", "    if (!(id in this.p)) return;\n", `    if (!(id in this.p)) { ${H}("unknown_key"); return; }\n`],
];

const hits = new Map();
globalThis.__BK_EQ_HIT = (k) => hits.set(k, (hits.get(k) ?? 0) + 1);

const probePath = join(fxDir, ".parity-probe.eq.mjs");
let probe;
try {
  let src = jsSrc;
  for (const [label, find, repl] of PROBES) {
    const n = src.split(find).length - 1;
    ok(`probe edit "${label}" matches the shipping source exactly once`, n === 1, `${n} matches`);
    src = src.replace(find, repl);
  }
  writeFileSync(probePath, src);
  probe = await import(`${probePath}?t=${Date.now()}`);
} finally {
  rmSync(probePath, { force: true });
}

// ---------------------------------------------------------------------------
// mirrors of the C battery
// ---------------------------------------------------------------------------

const OP = { END: 0, INIT: 1, PARAM: 2, PROCESS: 3, RESET: 4, SNAP: 5, POKE: 6, REWIND: 7 };
const OPW = 5;
const BLOCK_W = 23;
const SNAP_W = 373;
const SIG_N = 65536;
const CURVE = 160;
const STAGES = 4;
const SENTINEL = new Map([
  [-3e9, NaN],
  [3e9, Infinity],
  [-4e9, -Infinity],
]);
const unsentinel = (v) => (SENTINEL.has(v) ? SENTINEL.get(v) : v);

/** BK_P_EQ_* order; asserted against param-keys.h and the param schema. */
const KEYS = [
  "hpFreq", "hpSlope", "lsFreq", "lsGain", "b1Freq", "b1Gain", "b1Q", "b2Freq", "b2Gain", "b2Q",
  "b3Freq", "b3Gain", "b3Q", "hsFreq", "hsGain", "lpFreq", "lpSlope", "output",
];

const SIGS = [0, 1, 2, 3, 4].map((s) => Float32Array.from(fillSignal(SIG_N, s)));

const activeOf = (c) => (c.active === undefined ? -1 : c.active !== c.active ? 0 : c.active);

function blockState(e, out) {
  out.push(e.outGain.value, e.outGain.target, e.visualDirty ? 1 : 0);
  out.push(activeOf(e.ch[0].hp), activeOf(e.ch[0].lp));
  for (const k of KEYS) out.push(e.sm[k].value);
}

function biquadState(f, out) {
  out.push(f.b0, f.b1, f.b2, f.a1, f.a2, f.z1, f.z2, f.type, f.freq, f.q, f.gainDb);
}
function cascadeState(c, out) {
  out.push(activeOf(c), c.stages.length);
  for (const s of c.stages) biquadState(s, out);
}

function snapState(e, out, o32) {
  for (const k of KEYS) out.push(e.p[k]);
  for (const k of KEYS) out.push(e.sm[k].value, e.sm[k].target, e.sm[k].a);
  out.push(e.outGain.value, e.outGain.target, e.outGain.a);
  out.push(e.sr, e.maxBlock, e.controlRate, e.visualDirty ? 1 : 0);
  for (const ch of e.ch) {
    cascadeState(ch.hp, out);
    for (const b of [ch.ls, ch.b1, ch.b2, ch.b3, ch.hs]) biquadState(b, out);
    cascadeState(ch.lp, out);
  }
  for (let k = 0; k < CURVE; k++) o32.push(e.visual[k]);
}

function replay(mod, ops) {
  const out = [];
  const o32 = [];
  // The vtable readings: no carrier bus, no latency, no meter.
  out.push(1, 1, 1);
  let e = new mod.ParametricEQ(48000, 128);
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
    else if (op === OP.INIT) e = new mod.ParametricEQ(a, b | 0);
    else if (op === OP.PARAM) e.setParam(KEYS[a] ?? `unknown:${a}`, b);
    else if (op === OP.PROCESS) {
      const bs = b | 0;
      const sl = SIGS[c | 0];
      const sr = SIGS[d | 0];
      const vL = L.subarray(0, bs);
      const vR = R.subarray(0, bs);
      for (let k = 0; k < (a | 0); k++) {
        for (let j = 0; j < bs; j++) {
          const at = (cursor + j) % SIG_N;
          vL[j] = sl[at];
          vR[j] = -0.5 * sr[at];
        }
        cursor = (cursor + bs) % SIG_N;
        for (const [ch, at, v] of pokes) if (at < bs) (ch ? vR : vL)[at] = v;
        pokes = [];
        e.process(vL, vR, bs);
        blockState(e, out);
        for (let j = 0; j < bs; j++) o32.push(vL[j]);
        for (let j = 0; j < bs; j++) o32.push(vR[j]);
      }
    } else if (op === OP.RESET) e.reset();
    else if (op === OP.SNAP) snapState(e, out, o32);
    else if (op === OP.POKE) {
      if (pokes.length < 16) pokes.push([a | 0, b | 0, c]);
    } else if (op === OP.REWIND) cursor = 0;
  }
  snapState(e, out, o32);
  return { out64: Float64Array.from(out), out32: Float32Array.from(o32) };
}

const reference = (rec) => replay(shipping, rec.params);

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

/*
 * Bit-identity baselines, pinned. MEASURED 2026-10-02 on glibc / emscripten /
 * V8; MSVC unmeasured. Every record is inside tolerance (checked above).
 *   native vs JS:   4 drift (s_extremes, s_schema_min, s_schema_max, s_sweep)
 *   wasm vs JS:     5 drift (the same four plus s_step)
 *   native vs wasm: 5 drift (the same five)
 * What the compare reports: native's float32 payload (audio and curve) is
 * bit-identical to the JS on all 38 records; its drift is in the out64
 * coefficient fields only, worst 1.2e-14. Wasm's worst is 2.1e-12 (out64)
 * and 1.9e-9 (float32, s_step, -174 dBFS).
 * Native vs JS was traced: the smoothed inputs to bk_biquad_set were
 * bit-identical and a few coefficients moved by 1 ulp. A standalone probe put
 * it on glibc's cos(2*pi*f/48000), one ulp off V8's (and emscripten's) for
 * f = 0x1.9f7f9d4e75eecp+11 and 0x1.0062180390804p+12; sin, pow and sqrt
 * agreed at those inputs. Wasm vs JS was NOT traced: emscripten's libm
 * matching V8 on those two cos inputs does not explain its own five drifts.
 * Bit-identity is an empirical per-module result, not a guarantee.
 */
const IDENTITY_NATIVE = 34;
const IDENTITY_WASM = 33;
const IDENTITY_CROSS = 33;

compareToJs({ name: "native", dump: native, reference, ok, expectIdentical: IDENTITY_NATIVE });
if (wasm) {
  compareToJs({ name: "wasm", dump: wasm, reference, ok, expectIdentical: IDENTITY_WASM });
  compareToolchains({ native, wasm, ok, expectIdentical: IDENTITY_CROSS });
}

{
  const strictSame = (x, y) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
  // Object.is must not find a difference that === missed: the count of
  // strictly identical records equals the pinned bit-identity baseline.
  const strict = (label, dump, other, expect) => {
    let same = 0;
    const off = [];
    dump.forEach((rec, i) => {
      const ref = other(rec, i);
      if (strictSame(ref.out64, rec.out64) && strictSame(ref.out32, rec.out32)) same++;
      else if (off.length < 6) off.push(rec.name);
    });
    ok(`${label}: ${expect} records identical with the sign of zero (Object.is)`, same === expect, `${same}/${dump.length}${off.length ? ` — ${off.join(", ")}` : ""}`);
  };
  console.log("\n== sign of zero ==");
  strict("native vs JS", native, reference, IDENTITY_NATIVE);
  if (wasm) {
    strict("wasm vs JS", wasm, reference, IDENTITY_WASM);
    strict("native vs wasm", native, (_, i) => wasm[i], IDENTITY_CROSS);
  }
}

// ---------------------------------------------------------------------------
// sanity
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises eq.js ==");
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
  ok("BK_EQ_BLOCK mirrors the C", def(cSrc, "BK_EQ_BLOCK") === BLOCK_W);
  ok("BK_EQ_SNAP mirrors the C", def(cSrc, "BK_EQ_SNAP") === SNAP_W);
  ok("BK_EQ_CURVE_POINTS equals CURVE_POINTS", def(hdr, "BK_EQ_CURVE_POINTS") === CURVE && /const CURVE_POINTS = 160;/.test(jsSrc));
  ok("BK_EQ_CASCADE_STAGES equals the JS cascades", def(hdr, "BK_EQ_CASCADE_STAGES") === STAGES && (jsSrc.match(/new BiquadCascade\(sampleRate, 4\)/g) || []).length === 2);
  {
    // Count snapshot pushes structurally: one block = 5 + 18; one snap =
    // 18 + 54 + 3 + 4 + 2 * (2 * (2 + 4 * 11) + 5 * 11).
    const snapCount = 18 + 54 + 3 + 4 + 2 * (2 * (2 + STAGES * 11) + 5 * 11);
    ok("BK_EQ_SNAP is the structural field count", snapCount === SNAP_W, `${snapCount}`);
    ok("BK_EQ_BLOCK is the structural field count", 5 + KEYS.length === BLOCK_W);
    const bs = cSrc.match(/static void block_state\([\s\S]*?\n\}/)[0];
    ok("block_state pushes 5 scalars + one per param", (bs.match(/push64\(/g) || []).length === 6);
    const bq = cSrc.match(/static void biquad_state\([\s\S]*?\n\}/)[0];
    ok("biquad_state pushes 11 fields", (bq.match(/push64\(/g) || []).length === 11);
  }
  for (const [n, v] of [["NAN_", -3e9], ["INF_", 3e9], ["NINF_", -4e9]]) ok(`sentinel ${n} mirrors the C`, def(cSrc, n) === v);
  ok(
    "the stimulus mirror matches the C",
    cSrc.includes("g_r[j] = -0.5f * g_sig[sr][at];") && cSrc.includes("g_cursor = (g_cursor + bs) % SIG_N;"),
  );
  {
    const keysH = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
    const fromHeader = [...keysH.matchAll(/BK_P_EQ_([A-Z0-9_]+) = (\d+)/g)]
      .filter((m) => m[1] !== "COUNT")
      .sort((x, y) => Number(x[2]) - Number(y[2]))
      .map((m) => m[1].toLowerCase().replace(/_/g, ""));
    ok("KEYS matches BK_P_EQ_* in param-keys.h", fromHeader.join() === KEYS.map((k) => k.toLowerCase()).join(), fromHeader.join());
    const schema = await import("../packages/web/src/web/audio/param-schema.ts");
    ok("KEYS matches the param schema", schema.EFFECTS.eq.params.map((p) => p.key).join() === KEYS.join());
    const e = new shipping.ParametricEQ(48000, 128);
    ok("KEYS matches the JS param object", Object.keys(e.p).join() === KEYS.join());
  }
  {
    let same = 0;
    const eq = (x, y) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
    for (const rec of native) {
      const a = reference(rec);
      const b = replay(probe, rec.params);
      if (eq(a.out64, b.out64) && eq(a.out32, b.out32)) same++;
    }
    ok("the instrumented probe renders exactly what the shipping module does", same === native.length, `${same}/${native.length}`);
    const must = [
      "hp_off_mid_glide", "hp_on_mid_glide", "hp_exactly_21", "hp_slope_nan",
      "lp_off_mid_glide", "lp_on_mid_glide", "lp_exactly_19900", "lp_slope_nan",
      "hp_stages_0", "hp_stages_1", "hp_stages_2", "hp_stages_3", "hp_stages_4", "hp_stages_NaN",
      "lp_stages_0", "lp_stages_1", "lp_stages_2", "lp_stages_3", "lp_stages_4", "lp_stages_NaN",
      "round_trap", "round_half", "render", "unknown_key",
    ];
    for (const k of must) ok(`reached: ${k}`, (hits.get(k) ?? 0) > 0, `${hits.get(k) ?? 0} hits`);
  }
  ok("every script in the C appears in the dump", (cSrc.match(/\bS\(s_\w+\)/g) || []).length === native.length);
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\neq parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
