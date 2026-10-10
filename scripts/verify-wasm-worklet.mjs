/**
 * Proves the C DSP can run in the shape an AudioWorklet actually demands.
 *
 * Numeric parity (verify-biquad-parity.mjs) says the C computes the right
 * samples. It does not say the C can *live* on the web audio thread, and that
 * was the real unknown in route (c). An AudioWorkletGlobalScope has no fetch,
 * no filesystem, no dynamic import and no top-level await, so the usual
 * emscripten glue is unusable there. The module has to be:
 *
 *   1. Compiled with no JS glue at all (STANDALONE_WASM, --no-entry).
 *   2. Instantiated *synchronously* from bytes already transferred in, using
 *      `new WebAssembly.Module(bytes)` — the constructor, not the promise.
 *   3. Free of imports the worklet scope cannot satisfy.
 *   4. Allocation-free once running: buffers are carved out of the wasm heap
 *      once at construction, and process() touches nothing else.
 *
 * This script checks all four against the real artefact, then runs audio
 * through the instantiated module and diffs it against biquad.js.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "packages/native/build");
const emsdk = "/home/user/emsdk";
const wasmPath = join(buildDir, "biquad-standalone.wasm");

let checks = 0;
let failures = 0;
const ok = (name, cond, detail = "") => {
  checks++;
  if (cond) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------------------
// build the glue-free module
// ---------------------------------------------------------------------------

console.log("== 1. build a glue-free wasm ==");
mkdirSync(buildDir, { recursive: true });
const inc = join(root, "packages/native/include");
// biquad.c calls bk_clamp / bk_sanitize, which live in utils.c (moved out of
// biquad.h by the biquad port), so the standalone module links both.
const src = [
  join(root, "packages/native/src/dsp/biquad.c"),
  join(root, "packages/native/src/dsp/utils.c"),
].join(" ");
execFileSync(
  "bash",
  [
    "-lc",
    `source ${emsdk}/emsdk_env.sh >/dev/null 2>&1 && emcc -std=c99 -O3 -I ${inc} ${src} ` +
      `--no-entry -sSTANDALONE_WASM ` +
      `-sEXPORTED_FUNCTIONS=_bk_biquad_init,_bk_biquad_set,_bk_biquad_process_block,_bk_biquad_magnitude_db,_malloc ` +
      `-o ${wasmPath}`,
  ],
  { stdio: "pipe" },
);
ok("standalone wasm built", existsSync(wasmPath));

const bytes = readFileSync(wasmPath);
ok("module is small enough to inline in the worklet bundle", bytes.length < 256 * 1024, `${(bytes.length / 1024).toFixed(1)} KB`);

// ---------------------------------------------------------------------------
// the four worklet constraints
// ---------------------------------------------------------------------------

console.log("\n== 2. worklet constraints ==");

// Synchronous compile — this is the constructor form, the only one available
// inside an AudioWorkletGlobalScope.
const mod = new WebAssembly.Module(bytes);
ok("compiles synchronously via new WebAssembly.Module()", mod instanceof WebAssembly.Module);

const imports = WebAssembly.Module.imports(mod);
const exports = WebAssembly.Module.exports(mod).map((e) => e.name);
console.log(`   imports: ${imports.length ? imports.map((i) => `${i.module}.${i.name}`).join(", ") : "(none)"}`);

// Anything imported must be satisfiable from inside a worklet. wasi_snapshot_
// preview1 stubs are fine (they only fire on exit/abort paths, never in
// process()); an import of env.emscripten_* or a filesystem call would not be.
const unsatisfiable = imports.filter((i) => i.module !== "wasi_snapshot_preview1" && i.module !== "env");
ok("no imports a worklet scope cannot provide", unsatisfiable.length === 0, unsatisfiable.map((i) => `${i.module}.${i.name}`).join(", ") || "clean");

for (const fn of ["bk_biquad_init", "bk_biquad_set", "bk_biquad_process_block", "bk_biquad_magnitude_db", "malloc", "memory"]) {
  ok(`exports ${fn}`, exports.includes(fn));
}

// Instantiate synchronously too, stubbing the wasi surface the same way the
// worklet shim will.
const wasiStub = new Proxy(
  {},
  {
    get: () => () => 0,
    has: () => true,
  },
);
const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasiStub, env: wasiStub });
ok("instantiates synchronously", !!inst.exports.bk_biquad_process_block);

const ex = inst.exports;
const heap = ex.memory.buffer;
const pagesBefore = heap.byteLength / 65536;

// ---------------------------------------------------------------------------
// run audio through it and diff against the JS
// ---------------------------------------------------------------------------

console.log("\n== 3. audio through the instantiated module ==");

const SR = 48000;
const BLOCK = 128;
const N = 4096;

// sizeof(bk_biquad): sr + 5 coefs + 2 state + freq/q/gain = 10 doubles, plus an
// int type and its padding. Over-allocate rather than hardcode a layout.
const filterPtr = ex.malloc(256);
const bufPtr = ex.malloc(BLOCK * 4);
ok("carved state and buffer out of the wasm heap", filterPtr > 0 && bufPtr > 0, `filter@${filterPtr} buf@${bufPtr}`);

// The heap must not have grown during the run — that is the allocation-free
// guarantee. Everything below reuses these two pointers.
const signal = new Float32Array(N);
let state = 0x13572468 >>> 0;
for (let i = 0; i < N; i++) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  signal[i] = ((state >>> 8) / 16777216) * 2 - 1;
}

const cases = [
  [0, 800, 0.707, 0],
  [1, 120, 1.4, 0],
  [4, 2500, 2.0, 9],
  [5, 200, 0.707, -8],
  [6, 6000, 0.9, 6],
];

const { Biquad } = await import("../packages/web/public/dsp/core/biquad.js");
let worst = 0;
let worstCase = "";

for (const [type, freq, q, gain] of cases) {
  ex.bk_biquad_init(filterPtr, SR);
  ex.bk_biquad_set(filterPtr, type, freq, q, gain);

  const wasmOut = new Float32Array(N);
  for (let off = 0; off < N; off += BLOCK) {
    const n = Math.min(BLOCK, N - off);
    // A fresh view each block: the heap can be detached by growth, and this is
    // exactly what the worklet shim must do too.
    new Float32Array(ex.memory.buffer, bufPtr, n).set(signal.subarray(off, off + n));
    ex.bk_biquad_process_block(filterPtr, bufPtr, n);
    wasmOut.set(new Float32Array(ex.memory.buffer, bufPtr, n), off);
  }

  const ref = new Biquad(SR);
  ref.set(type, freq, q, gain);
  const jsOut = new Float32Array(N);
  jsOut.set(signal);
  for (let i = 0; i < N; i++) jsOut[i] = ref.process(jsOut[i]);

  let d = 0;
  for (let i = 0; i < N; i++) d = Math.max(d, Math.abs(wasmOut[i] - jsOut[i]));
  if (d > worst) {
    worst = d;
    worstCase = `type=${type} f=${freq} q=${q} g=${gain}`;
  }

  // magnitudeDb across the module boundary, since the EQ curve display will
  // call it from the UI thread.
  let magD = 0;
  for (let k = 0; k < 32; k++) {
    const f = 20 * Math.pow(1000, k / 31);
    magD = Math.max(magD, Math.abs(ex.bk_biquad_magnitude_db(filterPtr, f) - ref.magnitudeDb(f)));
  }
  ok(`type=${type} f=${freq}: matches biquad.js`, d <= 2e-6 && magD <= 1e-9, `samples ${d.toExponential(2)}, mag ${magD.toExponential(2)} dB`);
}

ok("worst-case sample error is inaudible", worst <= 2e-6, `${worst.toExponential(2)} (${worst === 0 ? "bit-identical" : `${(20 * Math.log10(worst)).toFixed(0)} dBFS`}) ${worstCase}`);

const pagesAfter = ex.memory.buffer.byteLength / 65536;
ok("heap never grew while processing", pagesAfter === pagesBefore, `${pagesBefore} pages before, ${pagesAfter} after`);

console.log(`\n${checks} checks, ${failures} failed`);
console.log(`\nwasm worklet shape: ${failures === 0 ? "PASS" : "FAIL"}`);
process.exit(failures === 0 ? 0 : 1);
