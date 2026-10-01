/**
 * Parity oracle for the C port of dsp/core/file-player.js (Phase 5, route (c)).
 *
 * Same four steps as every module before it, on the shared plumbing in
 * scripts/lib/parity-stream.mjs:
 *
 *   1. build the C natively and run the battery;
 *   2. build the same source to wasm with emscripten and run it under Node;
 *   3. replay the identical battery through the shipping file-player.js;
 *   4. diff native against wasm.
 *
 * The battery lives in packages/native/tests/parity-file-player.c and only
 * there. Every record is one opcode script, carried whole in its params; this
 * file interprets the script rather than keeping a copy of it. Read that
 * file's header first: it lists what the battery is built to reach.
 *
 * The parity reference is the shipping module, imported unmodified. A second,
 * instrumented probe copy is used for one thing only: proving that the battery
 * reaches every branch on that list. Each instrumentation edit is asserted to
 * have matched exactly once, and the probe is removed in a finally.
 *
 * What this file mirrors by hand, because the C documents it in comments:
 *
 *   - the opcode table and the op row width;
 *   - block_state() and snap_state()'s field order — the payload contract;
 *   - the stimulus: bk_fill_signal narrowed to float, the right channel
 *     halved and negated, -1 for NULL and -2 for an alias;
 *   - the NaN / +inf / -inf sentinels, which the C maps at run time because a
 *     NaN or an infinity in a static initialiser is not portable to MSVC.
 *
 * All of them are asserted against the C source in the sanity section.
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

const { native, wasm } = buildAndRun({
  root,
  name: "parity-file-player",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/file-player.c"),
    join(root, "packages/native/tests/parity-file-player.c"),
  ],
  ok,
  state,
});

console.log(`\n   ${native.length} scripts in the battery`);

const coreDir = join(root, "packages/web/public/dsp/core");
const cSrc = readFileSync(join(root, "packages/native/tests/parity-file-player.c"), "utf8");
const hdr = readFileSync(join(root, "packages/native/include/brokodr/dsp/file-player.h"), "utf8");
const jsSrc = readFileSync(join(coreDir, "file-player.js"), "utf8");

// ---------------------------------------------------------------------------
// the JS under test: the shipping module, and an instrumented probe copy
// ---------------------------------------------------------------------------

const shipping = await import("../packages/web/public/dsp/core/file-player.js");

/*
 * Instrumentation for the reach checks. Each entry is [label, find, replace];
 * `find` must occur exactly once in the shipping source. HIT() only counts —
 * it never changes a value — and the probe's own output is diffed against the
 * shipping module's below, so an edit that did change behaviour fails.
 */
const H = "globalThis.__BK_FP_HIT";
const PROBES = [
  ["copy_run", "  #copyRun() {\n", `  #copyRun() {\n    ${H}("copy_run");\n`],
  ["grain", "  #grain(alpha) {\n", `  #grain(alpha) {\n    ${H}("grain");\n`],
  ["grain_search", "    if (this.hasRef) {\n", `    if (this.hasRef) {\n      ${H}("grain_search");\n`],
  ["search_skip_negative", "        if (start < 0) continue;\n", `        if (start < 0) { ${H}("search_skip_negative"); continue; }\n`],
  ["search_break_end", "          if (idx < 0) break;\n", `          if (idx < 0) { ${H}("search_break_end"); break; }\n`],
  ["wrap_forward", "      return a + ((idx - a) % len);\n", `      ${H}("wrap_forward");\n      return a + ((idx - a) % len);\n`],
  [
    "wrap_back",
    "      return back === 0 ? a : b - back;\n",
    `      ${H}(back === 0 ? "wrap_back_zero" : "wrap_back");\n      return back === 0 ? a : b - back;\n`,
  ],
  [
    "copy_end",
    "        this.fifoR[o] = 0;\n        this.ended = true;\n",
    `        this.fifoR[o] = 0;\n        this.ended = true;\n        ${H}("copy_end");\n`,
  ],
  ["grain_dead", "    if (dead) this.ended = true;\n", `    if (dead) { this.ended = true; ${H}("grain_dead"); }\n`],
  [
    "replay_after_end",
    "            this.srcPos = this.#regionStart();\n",
    `            this.srcPos = this.#regionStart();\n            ${H}("replay_after_end");\n`,
  ],
  [
    "underrun",
    "        this.fifoRead = this.fifoWrite;\n      }\n",
    `        this.fifoRead = this.fifoWrite;\n        ${H}("underrun");\n      }\n`,
  ],
  [
    "auto_stop",
    "      this.playing = false;\n      this.gainSm.set(0);\n",
    `      this.playing = false;\n      this.gainSm.set(0);\n      ${H}("auto_stop");\n`,
  ],
  [
    "read_index",
    "      const rp = this.fifoRead;\n",
    `      const rp = this.fifoRead;\n      if (rp !== rp) ${H}("read_nan");\n      if (rp >= 2147483648) ${H}("read_ge_2^31");\n      if (rp >= 4294967296) ${H}("read_ge_2^32");\n      if (rp - 1 < -2147483648) ${H}("read_lt_-2^31");\n      if (Math.floor(rp) === 0) ${H}("read_i0_zero");\n`,
  ],
  [
    "fill_path",
    "    const identity = Math.abs(alpha - 1) < 1e-3;\n",
    `    const identity = Math.abs(alpha - 1) < 1e-3;\n    if (identity && alpha !== 1) ${H}("identity_off_one");\n    if (!identity && Math.abs(alpha - 1) < 2e-3) ${H}("grain_near_one");\n    if (alpha !== alpha) ${H}("alpha_nan");\n`,
  ],
  [
    "loopin_frac",
    "        const f = Math.round(clamp(v, 0, 1) * this.frames);\n        this.loopIn",
    `        const f = Math.round(clamp(v, 0, 1) * this.frames);\n        if (f !== clamp(v, 0, 1) * this.frames && f === f) ${H}("loopin_fractional");\n        this.loopIn`,
  ],
  [
    "loopout_frac",
    "        const f = Math.round(clamp(v, 0, 1) * this.frames);\n        this.loopOut",
    `        const f = Math.round(clamp(v, 0, 1) * this.frames);\n        if (f !== clamp(v, 0, 1) * this.frames && f === f) ${H}("loopout_fractional");\n        this.loopOut`,
  ],
  [
    "wrap_pos",
    "    if (pos >= b) return a + ((pos - a) % len);\n    if (pos < a) return b - ((a - pos) % len);\n",
    `    if (pos >= b) { ${H}("wrap_pos_forward"); return a + ((pos - a) % len); }\n    if (pos < a) { ${H}("wrap_pos_back"); return b - ((a - pos) % len); }\n`,
  ],
];

const hits = new Map();
globalThis.__BK_FP_HIT = (k) => hits.set(k, (hits.get(k) ?? 0) + 1);

const probePath = join(coreDir, ".parity-probe.file-player.mjs");
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

/** Mirrors the opcode enum in parity-file-player.c. */
const OP = { END: 0, INIT: 1, BUF: 2, CLEAR: 3, PARAM: 4, PROCESS: 5, RESET: 6, SNAP: 7, COUNTERS: 8, SCALE: 9 };
const OPW = 5;
const BLOCK_W = 12;
const SNAP_W = 26;
const GRAIN = 1024;
const FIFO = 8192;
const CORR = 256;
const SENTINEL = new Map([
  [-3e9, NaN],
  [3e9, Infinity],
  [-4e9, -Infinity],
]);
const unsentinel = (v) => (SENTINEL.has(v) ? SENTINEL.get(v) : v);

/** Matches FILE_KEY in worklet-processor.js and BK_FILE_P_* in param-keys.h. */
const FILE_KEY = ["play", "seek", "loop", "loopin", "loopout", "speed", "pitch", "gain"];

function stimulus(n, sig) {
  const s = fillSignal(n, sig);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = s[i];
  return out;
}

function blockState(p, ret, out) {
  out.push(ret ? 1 : 0);
  out.push(p.meter);
  out.push(p.position);
  out.push(p.srcPos);
  out.push(p.fifoWrite);
  out.push(p.fifoRead);
  out.push(p.olaPos);
  out.push(p.ended ? 1 : 0);
  out.push(p.playing ? 1 : 0);
  out.push(p.gainSm.value);
  out.push(p.gainSm.target);
  out.push(p.active ? 1 : 0);
}

function snapState(p, full, out, o32) {
  out.push(p.sr);
  out.push(p.maxBlock);
  out.push(p.frames);
  out.push(p.srcRate);
  out.push(p.playing ? 1 : 0);
  out.push(p.loopEnabled ? 1 : 0);
  out.push(p.loopIn);
  out.push(p.loopOut);
  out.push(p.srcPos);
  out.push(p.ended ? 1 : 0);
  out.push(p.speed);
  out.push(p.pitchSemis);
  out.push(p.gainSm.value);
  out.push(p.gainSm.target);
  out.push(p.gainSm.a);
  out.push(p.levelDb);
  out.push(p.level);
  out.push(p.fifoWrite);
  out.push(p.fifoRead);
  out.push(p.olaPos);
  out.push(p.hasRef ? 1 : 0);
  out.push(p.meter);
  out.push(p.position);
  out.push(p.loaded ? 1 : 0);
  out.push(p.active ? 1 : 0);
  out.push(p.chR === p.chL ? 1 : 0);
  if (full) {
    for (let i = 0; i < FIFO; i++) o32.push(p.fifoL[i]);
    for (let i = 0; i < FIFO; i++) o32.push(p.fifoR[i]);
    for (let i = 0; i < CORR; i++) o32.push(p.refL[i]);
  }
}

/** Mirror of run_script(). The script itself is the record's params. */
function replay(mod, ops) {
  let p = new mod.FilePlayer(48000, 128);
  const out = [];
  const o32 = [];
  for (let k = 0; k < GRAIN; k++) o32.push(p.window[k]);
  const outL = new Float32Array(2048);
  const outR = new Float32Array(2048);

  for (let i = 0; i + OPW <= ops.length; i += OPW) {
    const op = ops[i] | 0;
    const a = unsentinel(ops[i + 1]);
    const b = unsentinel(ops[i + 2]);
    const c = unsentinel(ops[i + 3]);
    const d = unsentinel(ops[i + 4]);
    if (op === OP.END) break;
    else if (op === OP.INIT) p = new mod.FilePlayer(a, b | 0);
    else if (op === OP.BUF) {
      const n = c | 0;
      const L = stimulus(n, a | 0);
      let R = null;
      if (b >= 0) {
        R = stimulus(n, b | 0);
        for (let k = 0; k < n; k++) R[k] = -0.5 * R[k];
      } else if (b === -2) {
        R = L;
      }
      p.setBuffer(L, R, n, d);
    } else if (op === OP.CLEAR) p.clearBuffer();
    else if (op === OP.PARAM) p.setParam(FILE_KEY[a] ?? `unknown:${a}`, b);
    else if (op === OP.PROCESS) {
      const blocks = a | 0;
      const bs = b | 0;
      const vL = outL.subarray(0, bs);
      const vR = outR.subarray(0, bs);
      for (let k = 0; k < blocks; k++) {
        const ret = p.process(vL, vR, bs);
        blockState(p, ret, out);
        for (let j = 0; j < bs; j++) o32.push(vL[j]);
        for (let j = 0; j < bs; j++) o32.push(vR[j]);
      }
    } else if (op === OP.RESET) p.reset();
    else if (op === OP.SNAP) snapState(p, a === 1, out, o32);
    else if (op === OP.COUNTERS) {
      p.fifoWrite = a;
      p.fifoRead = b;
      p.olaPos = c;
    } else if (op === OP.SCALE) {
      const f = Math.fround(a);
      const hi = Math.min(c | 0, p.frames);
      for (let k = b | 0; k < hi; k++) {
        p.chL[k] = p.chL[k] * f;
        if (p.chR !== p.chL) p.chR[k] = p.chR[k] * f;
      }
    }
  }
  snapState(p, true, out, o32);
  return { out64: Float64Array.from(out), out32: Float32Array.from(o32) };
}

const reference = (rec) => replay(shipping, rec.params);

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

/*
 * Bit-identity baselines, pinned. MEASURED; see assertIdentity in
 * parity-stream.mjs before re-baselining. Under MSVC this is unmeasured.
 */
const IDENTITY_NATIVE = 65;
const IDENTITY_WASM = 65;
const IDENTITY_CROSS = 65;

compareToJs({ name: "native", dump: native, reference, ok, expectIdentical: IDENTITY_NATIVE });
if (wasm) {
  compareToJs({ name: "wasm", dump: wasm, reference, ok, expectIdentical: IDENTITY_WASM });
  compareToolchains({ native, wasm, ok, expectIdentical: IDENTITY_CROSS });
}

/*
 * The shared comparison counts -0 and +0 as equal (it is ===). This module
 * carries a sign of zero on purpose — Math.min(-0, +0) is -0 and a -0 loop
 * start reaches src_pos and the playhead — so here every record is also
 * compared with Object.is, element by element: -0 !== +0, NaN === NaN.
 */
{
  const strictSame = (x, y) => {
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
    return true;
  };
  const strict = (label, dump, other) => {
    let same = 0;
    const off = [];
    dump.forEach((rec, i) => {
      const ref = other(rec, i);
      if (strictSame(ref.out64, rec.out64) && strictSame(ref.out32, rec.out32)) same++;
      else if (off.length < 6) off.push(rec.name);
    });
    ok(`${label}: every record identical with the sign of zero (Object.is)`, same === dump.length, `${same}/${dump.length}${off.length ? ` — ${off.join(", ")}` : ""}`);
  };
  console.log("\n== sign of zero ==");
  strict("native vs JS", native, reference);
  if (wasm) {
    strict("wasm vs JS", wasm, reference);
    strict("native vs wasm", native, (_, i) => wasm[i]);
  }
}

// ---------------------------------------------------------------------------
// sanity: the battery has to actually exercise the code
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises file-player.js ==");
{
  // -- mirrors, checked against the C source --------------------------------
  for (const [name, value] of Object.entries(OP)) {
    const m = cSrc.match(new RegExp(`OP_${name}\\s*=\\s*(\\d+)`));
    ok(`OP_${name} mirrors the C`, m !== null && Number(m[1]) === value, m ? `${m[1]} vs ${value}` : "not found");
  }
  const def = (src, n) => {
    const m = src.match(new RegExp(`#define ${n} \\(?(-?[\\d.e]+)\\)?`));
    return m ? Number(m[1]) : NaN;
  };
  ok("the op row width mirrors the C", def(cSrc, "OPW") === OPW, `${def(cSrc, "OPW")}`);
  ok("the block-state width mirrors the C", def(cSrc, "BK_FP_BLOCK") === BLOCK_W, `${def(cSrc, "BK_FP_BLOCK")}`);
  ok("the snapshot width mirrors the C", def(cSrc, "BK_FP_SNAP") === SNAP_W, `${def(cSrc, "BK_FP_SNAP")}`);
  {
    const bs = cSrc.match(/static void block_state\([\s\S]*?\n\}/)[0];
    const ss = cSrc.match(/static void snap_state\([\s\S]*?if \(full\)/)[0];
    const nB = (bs.match(/push64\(/g) || []).length;
    const nS = (ss.match(/push64\(/g) || []).length;
    ok("block_state pushes BK_FP_BLOCK fields", nB === BLOCK_W, `${nB}`);
    ok("snap_state pushes BK_FP_SNAP fields", nS === SNAP_W, `${nS}`);
  }
  {
    const want = [
      ["NAN_", -3e9],
      ["INF_", 3e9],
      ["NINF_", -4e9],
    ];
    for (const [n, v] of want) ok(`sentinel ${n} mirrors the C`, def(cSrc, n) === v, `${def(cSrc, n)}`);
    const un = cSrc.match(/static double unsentinel[\s\S]*?\n\}/)[0];
    ok(
      "unsentinel() maps the same three values",
      un.includes("v == -3e9) return (double)NAN") &&
        un.includes("v == 3e9) return (double)INFINITY") &&
        un.includes("v == -4e9) return -(double)INFINITY"),
    );
    ok(
      "the stimulus mirror matches the C (right channel halved and negated, -2 aliases)",
      cSrc.includes("g_src_r[k] = -0.5f * g_src_r[k];") && cSrc.includes("} else if (b == -2) {\n          r = g_src_l;"),
    );
  }

  // -- module constants, header vs JS ---------------------------------------
  {
    const jsConst = (n) => {
      const m = jsSrc.match(new RegExp(`^const ${n} = (\\d+);`, "m"));
      return m ? Number(m[1]) : NaN;
    };
    ok("BK_FP_GRAIN equals GRAIN", def(hdr, "BK_FP_GRAIN") === shipping.GRAIN && GRAIN === shipping.GRAIN);
    ok("BK_FP_HOP is GRAIN >> 1, as HOP", /#define BK_FP_HOP \(BK_FP_GRAIN >> 1\)/.test(hdr) && shipping.HOP === GRAIN >> 1);
    for (const n of ["TOLERANCE", "CORR", "CORR_STEP", "FIFO"]) {
      ok(`BK_FP_${n} equals ${n}`, def(hdr, `BK_FP_${n}`) === jsConst(n), `${def(hdr, `BK_FP_${n}`)} vs ${jsConst(n)}`);
    }
    ok("FIFO and CORR mirrors equal the JS", jsConst("FIFO") === FIFO && jsConst("CORR") === CORR);
  }

  // -- the key table is not allowed to drift --------------------------------
  {
    const keys = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
    const fromHeader = [...keys.matchAll(/BK_FILE_P_([A-Z_]+) = (\d+)/g)]
      .filter((m) => m[1] !== "COUNT")
      .sort((x, y) => Number(x[2]) - Number(y[2]))
      .map((m) => m[1].toLowerCase().replace(/_/g, ""));
    ok(
      "FILE_KEY matches the generated param-keys.h",
      fromHeader.length === FILE_KEY.length && fromHeader.every((k, i) => k === FILE_KEY[i]),
      fromHeader.join(","),
    );
    const worklet = readFileSync(join(root, "packages/web/public/dsp/worklet-processor.js"), "utf8");
    const m = worklet.match(/const FILE_KEY = \[([^\]]*)\]/);
    const fromWorklet = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    ok(
      "FILE_KEY matches the worklet's, which is what the app dispatches",
      fromWorklet.length === FILE_KEY.length && fromWorklet.every((k, i) => k === FILE_KEY[i]),
      fromWorklet.join(","),
    );
    const cases = [...jsSrc.matchAll(/case "([a-z]+)":/g)].map((x) => x[1]);
    ok("every FILE_KEY is a case in setParam", FILE_KEY.every((k) => cases.includes(k)), cases.join(","));
  }

  // -- the probe is behaviour-neutral, and the battery reaches every branch --
  {
    let same = 0;
    for (const rec of native) {
      const a = reference(rec);
      const b = replay(probe, rec.params);
      const eq = (x, y) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]) || (v !== v && y[i] !== y[i]));
      if (eq(a.out64, b.out64) && eq(a.out32, b.out32)) same++;
    }
    ok("the instrumented probe renders exactly what the shipping module does", same === native.length, `${same}/${native.length}`);

    const must = [
      "copy_run",
      "grain",
      "grain_search",
      "search_skip_negative",
      "search_break_end",
      "wrap_forward",
      "wrap_back",
      "wrap_back_zero",
      "copy_end",
      "grain_dead",
      "replay_after_end",
      "underrun",
      "auto_stop",
      "read_nan",
      "read_ge_2^31",
      "read_ge_2^32",
      "read_lt_-2^31",
      "read_i0_zero",
      "identity_off_one",
      "grain_near_one",
      "alpha_nan",
      "loopin_fractional",
      "loopout_fractional",
      "wrap_pos_forward",
      "wrap_pos_back",
    ];
    for (const k of must) ok(`reached: ${k}`, (hits.get(k) ?? 0) > 0, `${hits.get(k) ?? 0} hits`);
  }

  // -- outcomes the scripts exist to show, read from the dump -----------------
  {
    const byName = new Map(native.map((r) => [r.name, r]));
    ok("every script in the C appears in the dump", (cSrc.match(/\bS\(s_\w+\)/g) || []).length === native.length);
    // The fractional-loop scripts must produce no NaN and no run of silence:
    // the bug this port found made the wrapped part of the read undefined.
    for (const n of ["s_loop_frac", "s_loop_frac_grain"]) {
      const r = byName.get(n);
      let nan = 0;
      for (const v of r.out32) if (v !== v) nan++;
      ok(`${n}: no NaN anywhere in the payload`, nan === 0, `${nan}`);
    }
    // A NaN pitch must make silence (sanitize), not NaN, at the output.
    {
      const r = byName.get("s_nan_pitch");
      let nan = 0;
      for (const v of r.out32) if (v !== v) nan++;
      ok("s_nan_pitch: the output is sanitised (NaN reaches the FIFO index, not the speaker)", nan === 0, `${nan}`);
    }
  }
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\nfile-player parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
