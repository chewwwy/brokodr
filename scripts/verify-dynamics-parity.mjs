/**
 * Parity oracle for the C port of dsp/effects/dynamics.js (Compressor,
 * Limiter, Gate, TransientShaper). Phase 5a, route (c).
 *
 * Same four steps as every module before it, on scripts/lib/parity-stream.mjs:
 * native build + battery, wasm build + battery, replay through the shipping
 * dynamics.js, native vs wasm. The battery lives in packages/native/tests/
 * parity-dynamics.c and only there; each record's params ARE the script.
 *
 * No deliberate divergences and no Math.random, so no contract copy and no
 * x_* scripts. A probe copy of dynamics.js (behaviour-neutral reach probes,
 * each edit asserted to match the shipping source exactly once) is replayed
 * alongside, asserted to render every script exactly as the shipping JS, and
 * used only to prove the battery reaches every branch that matters.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildAndRun, compareToJs, compareToolchains, createChecker, fillSignal } from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

const { native, wasm } = buildAndRun({
  root,
  name: "parity-dynamics",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/biquad.c"),
    join(root, "packages/native/src/dsp/delay-line.c"),
    join(root, "packages/native/src/dsp/dynamics.c"),
    join(root, "packages/native/tests/parity-dynamics.c"),
  ],
  ok,
  state,
});

console.log(`\n   ${native.length} scripts in the battery`);

const fxDir = join(root, "packages/web/public/dsp/effects");
const cSrc = readFileSync(join(root, "packages/native/tests/parity-dynamics.c"), "utf8");
const jsSrc = readFileSync(join(fxDir, "dynamics.js"), "utf8");

const shipping = await import("../packages/web/public/dsp/effects/dynamics.js");

// ---------------------------------------------------------------------------
// the probe copy
// ---------------------------------------------------------------------------

const H = "globalThis.__BK_DYN_HIT";

/* Reach probes; behaviour-neutral (asserted below). */
const PROBES = [
  [
    "curve entry",
    "    const r = this.ratio;\n",
    `    const r = this.ratio;\n` +
      `    ${H}(w > 0 ? "knee_soft" : "knee_hard"); if (x !== x) ${H}("curve_nan");\n` +
      `    if (w > 0 && x === t + w / 2) ${H}("knee_hi_edge"); if (w > 0 && x === t - w / 2) ${H}("knee_lo_edge"); if (w === 0 && x === t) ${H}("hard_edge");\n`,
  ],
  [
    "knee region",
    "      const d = x - t + w / 2;\n",
    `      ${H}("knee_in");\n      const d = x - t + w / 2;\n`,
  ],
  [
    "above / below",
    "    if (x >= t + w / 2) return t + (x - t) / r;\n",
    `    ${H}(x >= t + w / 2 ? "curve_over" : "curve_under");\n    if (x >= t + w / 2) return t + (x - t) / r;\n`,
  ],
  [
    "comp frames",
    "    const laSamples = (this.lookaheadMs * 0.001 * this.sr) | 0;\n",
    `    const laSamples = (this.lookaheadMs * 0.001 * this.sr) | 0;\n` +
      `    if (frames === 0) ${H}("c_frames_0"); if (frames < 0) ${H}("c_frames_neg"); if (laSamples === 10 * 0.001 * this.sr) ${H}("la_max");\n`,
  ],
  [
    "detector",
    "      if (this.rmsMode) {\n",
    `      ${H}(this.rmsMode ? "det_rms" : "det_peak");\n      if (this.rmsMode) {\n`,
  ],
  [
    "comp ballistics",
    "      const c = inDb > this.envDb ? this.aCoef : this.rCoef;\n",
    `      ${H}(inDb > this.envDb ? "c_attack" : "c_release"); if (inDb === this.envDb) ${H}("c_env_edge");\n` +
      "      const c = inDb > this.envDb ? this.aCoef : this.rCoef;\n",
  ],
  [
    "lookahead path",
    "      if (laSamples > 0) {\n",
    `      ${H}(laSamples > 0 ? "la_on" : "la_off");\n      if (laSamples > 0) {\n`,
  ],
  [
    "detector edge",
    "        this.rmsMode = v >= 0.5 ? 1 : 0;\n",
    `        if (v === 0.5) ${H}("det_edge");\n        this.rmsMode = v >= 0.5 ? 1 : 0;\n`,
  ],
  [
    "unknown comp key",
    '      case "lookahead":\n        this.lookaheadMs = clamp(v, 0, 10);\n        break;\n',
    `      case "lookahead":\n        this.lookaheadMs = clamp(v, 0, 10);\n        break;\n      default:\n        ${H}("unknown_comp");\n`,
  ],
  [
    "limiter frames",
    "    const n = this.lookahead;\n",
    `    const n = this.lookahead;\n    if (frames === 0) ${H}("l_frames_0"); if (frames < 0) ${H}("l_frames_neg");\n`,
  ],
  [
    "limiter need",
    "      const need = peak > ceil ? ceil / peak : 1;\n",
    `      ${H}(peak > ceil ? "lim_over" : "lim_under"); if (peak === ceil) ${H}("lim_edge");\n      const need = peak > ceil ? ceil / peak : 1;\n`,
  ],
  [
    "limiter ballistics",
    "      const c = need < this.env || this.env === 0 ? this.aCoef : this.rCoef;\n",
    `      ${H}(this.env === 0 ? "lim_env0" : need < this.env ? "lim_attack" : "lim_release");\n` +
      "      const c = need < this.env || this.env === 0 ? this.aCoef : this.rCoef;\n",
  ],
  [
    "limiter clamp",
    "      L[i] = clamp(ol, -ceil, ceil);\n",
    `      if (Math.abs(ol) > ceil || Math.abs(or) > ceil) ${H}("lim_clamp");\n      L[i] = clamp(ol, -ceil, ceil);\n`,
  ],
  [
    "unknown limiter key",
    "      this.rCoef = Math.exp(-1 / (this.releaseMs * 0.001 * this.sr));\n    }\n",
    `      this.rCoef = Math.exp(-1 / (this.releaseMs * 0.001 * this.sr));\n    }\n    else ${H}("unknown_limiter");\n`,
  ],
  [
    "gate frames",
    "    let grMax = 0;\n",
    `    let grMax = 0;\n    if (frames === 0) ${H}("g_frames_0"); if (frames < 0) ${H}("g_frames_neg"); if (holdSamples < 0) ${H}("hold_neg");\n`,
  ],
  [
    "gate state",
    "      if (db > openDb) {\n",
    `      ${H}(db > openDb ? "g_open" : db < closeDb ? (this.holdCounter > 0 ? "g_hold" : "g_close") : "g_between");\n` +
      `      if (openDb < -180 && openDb > -180.0000001 && db === -180 && !this.open) ${H}("g_open_below");\n` +
      `      if (closeDb > -180 && closeDb < -179.9999999 && db === -180 && this.open && this.holdCounter === 0) ${H}("g_close_above");\n` +
      `      if (db === openDb) ${H}("g_open_edge"); if (db === closeDb) ${H}("g_close_edge");\n      if (db > openDb) {\n`,
  ],
  [
    "unknown gate key",
    '      case "scfreq":\n        this.scHpFreq = v;\n        break;\n',
    `      case "scfreq":\n        this.scHpFreq = v;\n        break;\n      default:\n        ${H}("unknown_gate");\n`,
  ],
  [
    "transient frames",
    "    let peakGain = 0;\n",
    `    let peakGain = 0;\n    if (frames === 0) ${H}("t_frames_0"); if (frames < 0) ${H}("t_frames_neg");\n`,
  ],
  [
    "transient region",
    "      const transient = clamp(diff / 6, 0, 1);\n",
    `      ${H}(diff > 0 ? "t_trans" : diff < 0 ? "t_sus" : diff === 0 ? "t_neutral" : "t_nan"); if (diff > 6) ${H}("t_trans_sat"); if (diff < -6) ${H}("t_sus_sat");\n` +
      "      const transient = clamp(diff / 6, 0, 1);\n",
  ],
  [
    "unknown transient key",
    "      this.slow.setAttack(Math.max(4, v * 4));\n    }\n",
    `      this.slow.setAttack(Math.max(4, v * 4));\n    }\n    else ${H}("unknown_transient");\n`,
  ],
];

let currentHits = new Map();
globalThis.__BK_DYN_HIT = (k) => currentHits.set(k, (currentHits.get(k) ?? 0) + 1);

const probePath = join(fxDir, ".parity-contract.dynamics.mjs");
let probed;
try {
  let src = jsSrc;
  for (const [label, find, repl] of PROBES) {
    const n = src.split(find).length - 1;
    ok(`probe "${label}" matches the shipping source exactly once`, n === 1, `${n} matches`);
    src = src.replace(find, repl);
  }
  writeFileSync(probePath, src);
  probed = await import(`${pathToFileURL(probePath).href}?t=${Date.now()}`);
} finally {
  rmSync(probePath, { force: true });
}

// ---------------------------------------------------------------------------
// mirrors of the C battery
// ---------------------------------------------------------------------------

const OP = { END: 0, INIT: 1, PARAM: 2, PROCESS: 3, RESET: 4, SNAP: 5, POKE: 6, REWIND: 7, GAIN: 8, DC: 9, MONO: 10 };
const OPW = 5;
const COMP_BLOCK = 14;
const LIM_BLOCK = 7;
const GATE_BLOCK = 8;
const TRANS_BLOCK = 7;
const COMP_SNAP = 29;
const LIM_SNAP = 14;
const GATE_SNAP = 40;
const TRANS_SNAP = 15;
const SIG_N = 65536;
const SIG_DC = 5;
const MAX_POKES = 32;
const MAX_P64 = 2000000;
const MAX_P32 = 4000000;
const SENTINEL = new Map([
  [-3e9, NaN],
  [3e9, Infinity],
  [-4e9, -Infinity],
]);
const unsentinel = (v) => (SENTINEL.has(v) ? SENTINEL.get(v) : v);

/** BK_P_COMP_*, BK_P_LIMITER_*, BK_P_GATE_*, BK_P_TRANSIENT_* order. */
const COMP_KEYS = ["threshold", "ratio", "attack", "release", "knee", "makeup", "detector", "lookahead"];
const LIM_KEYS = ["ceiling", "release"];
const GATE_KEYS = ["threshold", "range", "attack", "release", "hold", "hysteresis", "scfreq"];
const TRANS_KEYS = ["attack", "sustain", "speed"];
const KEYS = [COMP_KEYS, LIM_KEYS, GATE_KEYS, TRANS_KEYS];

const SIGS = [0, 1, 2, 3, 4].map((s) => Float32Array.from(fillSignal(SIG_N, s)));

const smootherState = (s, out) => out.push(s.value, s.target, s.a);
const biquadState = (f, out) => out.push(f.b0, f.b1, f.b2, f.a1, f.a2, f.z1, f.z2, f.type, f.freq, f.q, f.gainDb);
const envState = (e, out) => out.push(e.rms ? 1 : 0, e.env, e.ca, e.cr);
const lineState = (d, out) => out.push(d.size, d.w);

function blockState(e, type, out) {
  if (type === 1) {
    out.push(e.env, e.wi, e.gainDb, e.rCoef, e.dl.w, e.dr.w, e.meter);
  } else if (type === 2) {
    out.push(e.env.env, e.gainSm.value, e.gainSm.target, e.gainSm.a, e.open ? 1 : 0, e.holdCounter, e.hpL.z1, e.meter);
  } else if (type === 3) {
    out.push(e.fast.env, e.slow.env, e.fast.ca, e.slow.ca, e.gainSm.value, e.gainSm.target, e.meter);
  } else {
    out.push(e.attack.value, e.attack.target, e.release.value, e.release.target, e.mkGain.value, e.mkGain.target);
    out.push(e.envDb, e.gainDb, e.aCoef, e.rCoef, e.rms.env, e.laL.w, e.laR.w, e.meter);
  }
}

function snapState(e, type, out, o32) {
  const bufs = (arrs) => {
    for (const a of arrs) for (let k = 0; k < a.length; k++) o32.push(a[k]);
  };
  if (type === 1) {
    out.push(e.sr, e.ceilingDb, e.releaseMs, e.gainDb, e.lookahead, e.wi, e.env, e.rCoef, e.aCoef, e.meter);
    lineState(e.dl, out);
    lineState(e.dr, out);
    bufs([e.dl.buf, e.dr.buf, e.win]);
  } else if (type === 2) {
    out.push(e.sr, e.thresholdDb, e.rangeDb, e.holdMs, e.hysteresisDb, e.scHpFreq, e.open ? 1 : 0, e.holdCounter);
    out.push(e.attackMs, e.releaseMs, e.meter);
    envState(e.env, out);
    biquadState(e.hpL, out);
    biquadState(e.hpR, out);
    smootherState(e.gainSm, out);
  } else if (type === 3) {
    out.push(e.sr, e.attackAmt, e.sustainAmt, e.meter);
    envState(e.fast, out);
    envState(e.slow, out);
    smootherState(e.gainSm, out);
  } else {
    out.push(e.sr, e.threshold, e.ratio, e.knee, e.makeup, e.rmsMode, e.lookaheadMs, e.envDb, e.gainDb, e.aCoef, e.rCoef, e.meter);
    smootherState(e.attack, out);
    smootherState(e.release, out);
    smootherState(e.mkGain, out);
    envState(e.rms, out);
    lineState(e.laL, out);
    lineState(e.laR, out);
    bufs([e.laL.buf, e.laR.buf]);
  }
}

/** Replay one script through module `mod`. `hits` collects probe hits. */
function replay(mod, ops, hits = new Map()) {
  const out = [];
  const o32 = [];
  let e;
  let type = 0;
  const init = (t, sr) => {
    type = t;
    e =
      t === 1 ? new mod.Limiter(sr, 128) : t === 2 ? new mod.Gate(sr, 128) : t === 3 ? new mod.TransientShaper(sr, 128) : new mod.Compressor(sr, 128);
    // vtable: no carrier bus, no latency, a meter.
    out.push(1, 1, 0);
  };
  const savedHits = currentHits;
  currentHits = hits;
  try {
    init(0, 48000);
    let cursor = 0;
    let gain = 1;
    let dc = 0;
    let pokes = [];
    const sig = (s, at) => (s === SIG_DC ? dc : SIGS[s][at]);
    const L = new Float32Array(4096);
    const R = new Float32Array(4096);
    for (let i = 0; i + OPW <= ops.length; i += OPW) {
      const op = ops[i] | 0;
      const a = unsentinel(ops[i + 1]);
      const b = unsentinel(ops[i + 2]);
      const c = unsentinel(ops[i + 3]);
      const d = unsentinel(ops[i + 4]);
      if (op === OP.END) break;
      else if (op === OP.INIT) init(a | 0, b);
      else if (op === OP.PARAM) e.setParam(KEYS[type][a] ?? `unknown:${a}`, b);
      else if (op === OP.PROCESS) {
        const bs = b | 0;
        const sl = c | 0;
        const sr = d | 0;
        // A negative block size reaches process() as is, with no samples.
        const vL = L.subarray(0, Math.max(bs, 0));
        const vR = R.subarray(0, Math.max(bs, 0));
        for (let k = 0; k < (a | 0); k++) {
          for (let j = 0; j < bs; j++) {
            const at = (cursor + j) % SIG_N;
            vL[j] = gain * sig(sl, at);
            vR[j] = gain * (-0.5 * sig(sr, at));
          }
          cursor = (cursor + bs) % SIG_N;
          for (const [ch, at, v] of pokes) if (at < bs) (ch ? vR : vL)[at] = v;
          pokes = [];
          e.process(vL, vR, bs);
          blockState(e, type, out);
          for (let j = 0; j < bs; j++) o32.push(vL[j]);
          for (let j = 0; j < bs; j++) o32.push(vR[j]);
        }
      } else if (op === OP.MONO) {
        // One buffer as both l and r: the aliasing a mono caller produces.
        const bs = b | 0;
        const sl = c | 0;
        const vL = L.subarray(0, Math.max(bs, 0));
        for (let k = 0; k < (a | 0); k++) {
          for (let j = 0; j < bs; j++) vL[j] = gain * sig(sl, (cursor + j) % SIG_N);
          cursor = (cursor + bs) % SIG_N;
          for (const [, at, v] of pokes) if (at < bs) vL[at] = v;
          pokes = [];
          e.process(vL, vL, bs);
          blockState(e, type, out);
          for (let j = 0; j < bs; j++) o32.push(vL[j]);
        }
      } else if (op === OP.RESET) e.reset();
      else if (op === OP.SNAP) snapState(e, type, out, o32);
      else if (op === OP.POKE) {
        if (pokes.length < MAX_POKES) pokes.push([a | 0, b | 0, c]);
      } else if (op === OP.REWIND) cursor = 0;
      else if (op === OP.GAIN) gain = a;
      else if (op === OP.DC) dc = a;
    }
    snapState(e, type, out, o32);
  } finally {
    currentHits = savedHits;
  }
  return { out64: Float64Array.from(out), out32: Float32Array.from(o32) };
}

const refOut = new Map();
const probeOut = new Map();
const scriptHits = new Map();
for (const rec of native) {
  refOut.set(rec.name, replay(shipping, rec.params));
  const h = new Map();
  probeOut.set(rec.name, replay(probed, rec.params, h));
  scriptHits.set(rec.name, h);
}
const reference = (rec) => refOut.get(rec.name);

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

/*
 * Bit-identity baselines, pinned. MEASURED 2026-10-06 on glibc / emscripten /
 * V8; MSVC unmeasured. Every record is inside tolerance (checked above).
 *
 * The AUDIO (out32) of all 57 records is bit-identical on all three
 * comparisons; that is pinned below by name-free count. All drift is in the
 * out64 readings that come straight out of a transcendental in double
 * precision (envDb / meters via 20*log10, smoother and ballistics
 * coefficients via exp, sidechain biquad coefficients via cos/sin):
 *   native vs JS:   36 of 57 drift
 *   wasm vs JS:     43 of 57 drift
 *   native vs wasm: 36 of 57 drift
 * Attributed, NOT traced per record, to libm: over 200,000 inputs per
 * function in the ranges these effects use, glibc differs from V8 on log10
 * 1,222 / exp 19,630 / cos 6,530 / sin 6,860 / pow(10,x) 0; emscripten on
 * log10 4,789 / exp 19,465 / cos 1,648 / sin 1,913 / pow(10,x) 66. Treat the
 * counts as empirical. Rerun with LIST_DRIFT=1 to print the lists, DIFF=name
 * for the differing fields of one record.
 */
const IDENTITY_NATIVE = 21;
const IDENTITY_WASM = 14;
const IDENTITY_CROSS = 21;
const ALL3 = ["native", "wasm", "native/wasm"];
// c_knee_edge is a last-bit comparison on the knee edges (a DC level of exactly 0 dB); it must be
// bit-identical by name. The gate edge scripts (g_open_edge, g_close_edge) are not listed: their
// edge decides `open` / `holdCounter`, which are exact integers compared within tolerance in every
// block, so a flipped decision fails the tolerance check by a whole unit; their drift is the
// sidechain biquad's cos/sin coefficients and the log10 meter.
const REQUIRE_IDENTICAL = { c_knee_edge: ALL3 };

compareToJs({ name: "native", dump: native, reference, ok, expectIdentical: IDENTITY_NATIVE });
if (wasm) {
  compareToJs({ name: "wasm", dump: wasm, reference, ok, expectIdentical: IDENTITY_WASM });
  compareToolchains({ native, wasm, ok, expectIdentical: IDENTITY_CROSS });
}

const strictSame = (x, y) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
{
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
  const drifting = (dump, other) =>
    dump
      .filter((rec, i) => {
        const r = other(rec, i);
        return !(strictSame(r.out64, rec.out64) && strictSame(r.out32, rec.out32));
      })
      .map((r) => r.name);
  if (process.env.DIFF) {
    // DIFF=name[,name]: every differing out64 index (first 12) and the out32 diff count, native vs JS.
    for (const n of process.env.DIFF.split(",")) {
      const rec = native.find((r) => r.name === n);
      const r = reference(rec);
      const d64 = [];
      rec.out64.forEach((v, k) => !Object.is(v, r.out64[k]) && d64.push(`[${k}] ${v} vs ${r.out64[k]}`));
      let d32 = 0;
      let first32 = -1;
      rec.out32.forEach((v, k) => {
        if (!Object.is(v, r.out32[k])) {
          d32++;
          if (first32 < 0) first32 = k;
        }
      });
      console.log(`DIFF ${n}: out64 ${d64.length}/${rec.out64.length} differ: ${d64.slice(0, 12).join("; ")}\n     out32 ${d32}/${rec.out32.length} differ, first at ${first32}`);
    }
  }
  const audioDrifting = (dump, other) => dump.filter((rec, i) => !strictSame(other(rec, i).out32, rec.out32)).map((r) => r.name);
  if (process.env.LIST_DRIFT) {
    console.log("AUDIO DRIFT native/JS:", audioDrifting(native, reference).join(" "));
    if (wasm) console.log("AUDIO DRIFT wasm/JS:", audioDrifting(wasm, reference).join(" "));
    if (wasm) console.log("AUDIO DRIFT native/wasm:", audioDrifting(native, (_, i) => wasm[i]).join(" "));
    console.log("DRIFT native/JS:", drifting(native, reference).join(" "));
    if (wasm) console.log("DRIFT wasm/JS:", drifting(wasm, reference).join(" "));
    if (wasm) console.log("DRIFT native/wasm:", drifting(native, (_, i) => wasm[i]).join(" "));
  }
  for (const [n, want] of Object.entries(REQUIRE_IDENTICAL)) {
    const pairs = [["native", native, reference]];
    if (wasm) pairs.push(["wasm", wasm, reference], ["native/wasm", native, (_, i) => wasm[i]]);
    for (const [label, dump, other] of pairs) if (want.includes(label)) ok(`${n} bit-identical (${label})`, !drifting(dump, other).includes(n));
  }
  {
    const n0 = audioDrifting(native, reference);
    ok("audio (out32) bit-identical in every record: native vs JS", n0.length === 0, n0.join(" "));
    if (wasm) {
      const n1 = audioDrifting(wasm, reference);
      const n2 = audioDrifting(native, (_, i) => wasm[i]);
      ok("audio (out32) bit-identical in every record: wasm vs JS", n1.length === 0, n1.join(" "));
      ok("audio (out32) bit-identical in every record: native vs wasm", n2.length === 0, n2.join(" "));
    }
  }
  console.log("\n== sign of zero ==");
  strict("native vs JS", native, reference, IDENTITY_NATIVE);
  if (wasm) {
    strict("wasm vs JS", wasm, reference, IDENTITY_WASM);
    strict("native vs wasm", native, (_, i) => wasm[i], IDENTITY_CROSS);
  }
}

console.log("\n== the probe copy is behaviour-neutral ==");
{
  let same = 0;
  for (const rec of native) {
    const a = refOut.get(rec.name);
    const b = probeOut.get(rec.name);
    if (strictSame(a.out64, b.out64) && strictSame(a.out32, b.out32)) same++;
  }
  ok("the probe copy renders every script exactly as the shipping JS", same === native.length && same > 0, `${same}/${native.length}`);
}

// ---------------------------------------------------------------------------
// sanity
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises dynamics.js ==");
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
  ok("SIG_DC mirrors the C", def(cSrc, "SIG_DC") === SIG_DC && def(cSrc, "N_SIGS") === SIG_DC);
  for (const [n, v] of [["BK_COMP_BLOCK", COMP_BLOCK], ["BK_LIM_BLOCK", LIM_BLOCK], ["BK_GATE_BLOCK", GATE_BLOCK], ["BK_TRANS_BLOCK", TRANS_BLOCK], ["BK_COMP_SNAP", COMP_SNAP], ["BK_LIM_SNAP", LIM_SNAP], ["BK_GATE_SNAP", GATE_SNAP], ["BK_TRANS_SNAP", TRANS_SNAP]]) {
    ok(`${n} mirrors the C`, def(cSrc, n) === v, `${def(cSrc, n)} vs ${v}`);
  }
  ok("MAX_POKES mirrors the C", def(cSrc, "MAX_POKES") === MAX_POKES);
  ok("MAX_P64 / MAX_P32 mirror the C", def(cSrc, "MAX_P64") === MAX_P64 && def(cSrc, "MAX_P32") === MAX_P32);
  {
    const fn = (n) => cSrc.match(new RegExp(`static void ${n}\\([\\s\\S]*?\\n\\}`))[0];
    const pushes = (s) => (s.match(/push64\(/g) || []).length;
    const count = (s, f) => (s.match(new RegExp(`${f}\\(`, "g")) || []).length;
    const split4 = (s) => {
      const [a, r1] = s.split("} else if (g_type == 2) {");
      const [b, r2] = r1.split("} else if (g_type == 3) {");
      const [c, d] = r2.split("} else {");
      return [a, b, c, d];
    };
    const [lb, gb, tb, cb] = split4(fn("block_state"));
    ok("block_state: limiter pushes BK_LIM_BLOCK", pushes(lb) === LIM_BLOCK, `${pushes(lb)}`);
    ok("block_state: gate pushes BK_GATE_BLOCK", pushes(gb) === GATE_BLOCK, `${pushes(gb)}`);
    ok("block_state: transient pushes BK_TRANS_BLOCK", pushes(tb) === TRANS_BLOCK, `${pushes(tb)}`);
    ok("block_state: compressor pushes BK_COMP_BLOCK", pushes(cb) === COMP_BLOCK, `${pushes(cb)}`);
    ok("smoother_state pushes 3", pushes(fn("smoother_state")) === 3);
    ok("biquad_state pushes 11", pushes(fn("biquad_state")) === 11);
    ok("env_state pushes 4", pushes(fn("env_state")) === 4);
    ok("line_state pushes 2", pushes(fn("line_state")) === 2);
    const [ls, gs, ts, cs] = split4(fn("snap_state"));
    ok("snap_state: limiter is 10 + 2 lines", pushes(ls) === 10 && count(ls, "line_state") === 2 && 10 + 2 * 2 === LIM_SNAP);
    ok("snap_state: gate is 11 + env + 2 biquads + smoother", pushes(gs) === 11 && count(gs, "env_state") === 1 && count(gs, "biquad_state") === 2 && count(gs, "smoother_state") === 1 && 11 + 4 + 22 + 3 === GATE_SNAP);
    ok("snap_state: transient is 4 + 2 envs + smoother", pushes(ts) === 4 && count(ts, "env_state") === 2 && count(ts, "smoother_state") === 1 && 4 + 8 + 3 === TRANS_SNAP);
    ok("snap_state: compressor is 12 + 3 smoothers + env + 2 lines", pushes(cs) === 12 && count(cs, "smoother_state") === 3 && count(cs, "env_state") === 1 && count(cs, "line_state") === 2 && 12 + 9 + 4 + 4 === COMP_SNAP);
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
    cSrc.includes("g_l[j] = (float)(g_gain * sig_at(sl, at));") &&
      cSrc.includes("g_r[j] = (float)(g_gain * (-0.5 * sig_at(sr, at)));") &&
      cSrc.includes("static double sig_at(int s, int at) { return s == SIG_DC ? g_dc : (double)g_sig[s][at]; }") &&
      cSrc.includes("g_cursor = (g_cursor + bs) % SIG_N;"),
  );
  {
    const keysH = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
    const fromHeader = (p) =>
      [...keysH.matchAll(new RegExp(`BK_P_${p}_([A-Z0-9_]+) = (\\d+)`, "g"))]
        .filter((m) => m[1] !== "COUNT")
        .sort((x, y) => Number(x[2]) - Number(y[2]))
        .map((m) => m[1].toLowerCase().replace(/_/g, ""));
    const schema = await import("../packages/web/src/web/audio/param-schema.ts");
    for (const [id, p, keys] of [["comp", "COMP", COMP_KEYS], ["limiter", "LIMITER", LIM_KEYS], ["gate", "GATE", GATE_KEYS], ["transient", "TRANSIENT", TRANS_KEYS]]) {
      ok(`keys match BK_P_${p}_* in param-keys.h`, fromHeader(p).join() === keys.join(), fromHeader(p).join());
      ok(`keys match the ${id} param schema`, schema.EFFECTS[id].params.map((q) => q.key).join() === keys.join(), schema.EFFECTS[id].params.map((q) => q.key).join());
      for (const k of keys) ok(`setParam handles "${k}" (${id})`, jsSrc.includes(`case "${k}":`) || jsSrc.includes(`id === "${k}"`));
    }
    ok(
      "Compressor / Limiter / Gate / TransientShaper ids",
      shipping.Compressor.id === "comp" && shipping.Limiter.id === "limiter" && shipping.Gate.id === "gate" && shipping.TransientShaper.id === "transient",
    );
  }
  {
    const all = new Map();
    for (const h of scriptHits.values()) for (const [k, v] of h) all.set(k, (all.get(k) ?? 0) + v);
    const must = [
      "knee_soft", "knee_hard", "curve_nan", "knee_hi_edge", "knee_lo_edge", "hard_edge", "knee_in", "curve_over", "curve_under",
      "c_frames_0", "c_frames_neg", "la_max", "det_rms", "det_peak", "c_attack", "c_release", "c_env_edge", "la_on", "la_off",
      "det_edge", "unknown_comp",
      "l_frames_0", "l_frames_neg", "lim_over", "lim_under", "lim_edge", "lim_env0", "lim_attack", "lim_release", "lim_clamp",
      "unknown_limiter",
      "g_frames_0", "g_frames_neg", "hold_neg", "g_open", "g_hold", "g_close", "g_between", "g_open_edge", "g_close_edge", "g_open_below", "g_close_above",
      "unknown_gate",
      "t_frames_0", "t_frames_neg", "t_trans", "t_sus", "t_neutral", "t_nan", "t_trans_sat", "t_sus_sat", "unknown_transient",
    ];
    for (const k of must) ok(`reached: ${k}`, (all.get(k) ?? 0) > 0, `${all.get(k) ?? 0} hits`);
    for (const [name, k] of [
      ["c_knee_edge", "knee_hi_edge"], ["c_knee_edge", "knee_lo_edge"], ["c_knee_edge", "hard_edge"],
      ["g_open_edge", "g_open_edge"], ["g_close_edge", "g_close_edge"], ["g_close_edge", "g_close"], ["l_dc", "lim_edge"], ["t_silence", "t_neutral"],
      ["g_open_edge", "g_open_below"], ["g_close_edge", "g_close_above"],
    ]) {
      ok(`${name} reaches ${k}`, (scriptHits.get(name).get(k) ?? 0) > 0);
    }
    if (process.env.LIST_HITS) console.log([...all].sort().map(([k, v]) => `${k}=${v}`).join(" "));
  }
  ok("every script in the C appears in the dump", (cSrc.match(/\bS\([clgt]_\w+\)/g) || []).length === native.length);
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\ndynamics parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
