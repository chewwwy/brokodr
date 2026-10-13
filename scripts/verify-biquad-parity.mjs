/**
 * Parity oracle for the C biquad port (Phase 5, route (c)).
 *
 * This is the spike that decides whether "C is canonical for both targets" is
 * actually viable, on the smallest module that can prove it. It does four
 * things, in increasing order of how much they'd hurt to get wrong:
 *
 *   1. Builds packages/native/src/dsp/biquad.c natively and runs a battery of
 *      filter configurations, dumping every coefficient and output sample.
 *   2. Builds the same source to wasm with emscripten and runs the identical
 *      battery under Node, dumping the same stream.
 *   3. Replays the battery through the original dsp/core/biquad.js and diffs
 *      both dumps against it, sample for sample.
 *   4. Diffs native against wasm, which is the check that actually matters for
 *      shipping: the desktop and the web build must agree with each other, not
 *      merely each agree with the JS to within some slack.
 *
 * The battery lives in the C producer. The JS reads the parameters back out of
 * the binary stream instead of keeping its own copy, so there is no case table
 * to keep in sync and no way for the two sides to silently drift.
 *
 * Tolerances are stated as absolute sample error, and the bar is -120 dBFS
 * (1e-6). That is roughly 20 bits down, far below the noise floor of any
 * converter the app will ever meet, and well below the 24-bit floor of the
 * UMC1820. Coefficients and magnitude readings are held much tighter because
 * nothing accumulates in them.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeToolchain } from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "packages/native/build");
const emsdk = process.env.BK_EMSDK || "/home/user/emsdk";

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

const TOL = {
  coef: 1e-12, // relative; no accumulation, so this is pure libm spread
  magDb: 1e-9, // dB; likewise a single evaluation
  sampleDouble: 1e-6, // -120 dBFS
  sampleFloat: 2e-6, // float32 eps is ~1.2e-7, and the IIR walks on it
  crossToolchain: 1e-6, // native vs wasm: the one users can actually hear
};

// ---------------------------------------------------------------------------
// 1. build
// ---------------------------------------------------------------------------

mkdirSync(buildDir, { recursive: true });
const inc = join(root, "packages/native/include");
// utils.c carries bk_sanitize/bk_clamp/bk_max, which biquad.c uses via
// brokodr/dsp/utils.h — there is exactly one definition of each in the tree.
const srcs = [
  join(root, "packages/native/src/dsp/utils.c"),
  join(root, "packages/native/src/dsp/biquad.c"),
  join(root, "packages/native/tests/parity-biquad.c"),
];

// BK_NATIVE_TOOLCHAIN=mingw builds a Windows .exe and runs it under Wine (see
// nativeToolchain in lib/parity-stream.mjs); the host build is the default.
const tc = nativeToolchain();
const nativeBin = join(buildDir, `parity-biquad${tc.exe}`);
const wasmJs = join(buildDir, "parity-biquad.js");
const nativeDump = join(buildDir, tc.exe ? `parity-${tc.dumpTag}.bin` : "parity-native.bin");
const wasmDump = join(buildDir, "parity-wasm.bin");

console.log(`== 1. build (native toolchain: ${tc.label}) ==`);
tc.build(["-std=c99", "-O2", "-I", inc, ...srcs], nativeBin);
ok(`native build (${tc.cc} -O2)`, existsSync(nativeBin));

// Emscripten needs NODERAWFS to let the wasm build write the dump straight to
// disk, so both producers are byte-comparable artefacts rather than one being
// piped through a virtual filesystem.
let haveEmcc = existsSync(join(emsdk, "emsdk_env.sh"));
if (haveEmcc) {
  try {
    execFileSync(
      "bash",
      [
        "-lc",
        `source ${emsdk}/emsdk_env.sh >/dev/null 2>&1 && emcc -std=c99 -O2 -I ${inc} ${srcs.join(" ")} ` +
          `-sNODERAWFS=1 -sENVIRONMENT=node -sEXIT_RUNTIME=1 -o ${wasmJs}`,
      ],
      { stdio: "pipe" },
    );
  } catch (e) {
    haveEmcc = false;
    console.log(`  note: emcc build failed — ${String(e.stderr || e).slice(0, 400)}`);
  }
}
ok("wasm build (emcc -O2)", haveEmcc && existsSync(wasmJs));

// ---------------------------------------------------------------------------
// 2. run both producers
// ---------------------------------------------------------------------------

console.log("\n== 2. run producers ==");
rmSync(nativeDump, { force: true });
rmSync(wasmDump, { force: true });
tc.run(nativeBin, [nativeDump]);
ok("native producer wrote a dump", existsSync(nativeDump));

if (haveEmcc) {
  // Note: the output extension matters. Emscripten MODULARIZEs .mjs output and
  // default-exports a factory, so main() never runs and you get a silent exit 0
  // with no dump. Plain .js emits a script that runs main on load.
  try {
    execFileSync("node", [wasmJs, wasmDump], { stdio: "pipe" });
  } catch (e) {
    console.log(`  note: wasm producer failed — ${String(e.stderr || e).slice(0, 400)}`);
  }
  if (!existsSync(wasmDump)) haveEmcc = false;
  ok("wasm producer wrote a dump", existsSync(wasmDump));
}

// ---------------------------------------------------------------------------
// 3. stream reader
// ---------------------------------------------------------------------------

const MAG_POINTS = 64;

function parse(path) {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.subarray(0, 8).toString("latin1") !== "BKPARITY") throw new Error(`${path}: bad magic`);
  const version = dv.getUint32(8, true);
  if (version !== 2) throw new Error(`${path}: unexpected format version ${version}`);
  const count = dv.getUint32(12, true);
  let o = 16;
  const cases = [];
  for (let c = 0; c < count; c++) {
    const kind = dv.getUint32(o, true);
    const signal = dv.getUint32(o + 4, true);
    const n = dv.getUint32(o + 8, true);
    o += 16;
    const rd = () => {
      const v = dv.getFloat64(o, true);
      o += 8;
      return v;
    };
    const type = rd(), freq = rd(), q = rd(), gainDb = rd(), stages = rd(), active = rd(), mode = rd();
    const coef = [rd(), rd(), rd(), rd(), rd()];
    const outD = new Float64Array(n);
    for (let i = 0; i < n; i++) outD[i] = rd();
    const outF = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      outF[i] = dv.getFloat32(o, true);
      o += 4;
    }
    const magFreq = new Float64Array(MAG_POINTS);
    for (let i = 0; i < MAG_POINTS; i++) magFreq[i] = rd();
    const magDb = new Float64Array(MAG_POINTS);
    for (let i = 0; i < MAG_POINTS; i++) magDb[i] = rd();
    cases.push({ kind, signal, n, type, freq, q, gainDb, stages, active, mode, coef, outD, outF, magFreq, magDb });
  }
  if (o !== buf.byteLength) throw new Error(`${path}: trailing bytes (${buf.byteLength - o})`);
  return cases;
}

const native = parse(nativeDump);
const wasm = haveEmcc ? parse(wasmDump) : null;
console.log(`\n   ${native.length} cases in the battery`);

// ---------------------------------------------------------------------------
// 4. the JS reference — same stimulus generator, mirrored exactly
// ---------------------------------------------------------------------------

const { Biquad, BiquadCascade, SVF } = await import("../packages/web/public/dsp/core/biquad.js");

function fillSignal(n, signal) {
  const dst = new Float64Array(n);
  let state = 0x13572468 >>> 0;
  for (let i = 0; i < n; i++) {
    if (signal === 0) dst[i] = i === 0 ? 1 : 0;
    else if (signal === 1) dst[i] = i < Math.floor(n / 2) ? 0.5 : 0;
    else {
      // Must match the C LCG bit for bit: uint32 wraparound via Math.imul.
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      dst[i] = ((state >>> 8) / 16777216) * 2 - 1;
    }
  }
  return dst;
}

function jsReference(c) {
  const sig = fillSignal(c.n, c.signal);
  const SR = 48000;
  let coef, outD, outF, magDb;

  const makeBiquad = () => {
    const f = new Biquad(SR);
    f.set(c.type, c.freq, c.q, c.gainDb);
    return f;
  };
  const makeCascade = () => {
    const f = new BiquadCascade(SR, c.stages);
    f.set(c.type, c.freq, c.q, c.gainDb);
    if (c.active >= 0) f.setActive(c.active);
    return f;
  };
  const makeSvf = () => {
    const f = new SVF(SR);
    f.set(c.freq, c.q);
    return f;
  };

  if (c.kind === 1) {
    const f = makeBiquad();
    coef = [f.b0, f.b1, f.b2, f.a1, f.a2];
    outD = new Float64Array(c.n);
    for (let i = 0; i < c.n; i++) outD[i] = f.process(sig[i]);
    magDb = new Float64Array(MAG_POINTS);
    for (let i = 0; i < MAG_POINTS; i++) magDb[i] = f.magnitudeDb(c.magFreq[i]);
    const g = makeBiquad();
    outF = new Float32Array(c.n);
    for (let i = 0; i < c.n; i++) outF[i] = sig[i];
    for (let i = 0; i < c.n; i++) outF[i] = g.process(outF[i]);
  } else if (c.kind === 2) {
    const f = makeCascade();
    coef = [f.stages[0].b0, f.stages[0].b1, f.stages[0].b2, f.stages[0].a1, f.stages[0].a2];
    outD = new Float64Array(c.n);
    for (let i = 0; i < c.n; i++) outD[i] = f.process(sig[i]);
    magDb = new Float64Array(MAG_POINTS);
    for (let i = 0; i < MAG_POINTS; i++) magDb[i] = f.magnitudeDb(c.magFreq[i]);
    const g = makeCascade();
    outF = new Float32Array(c.n);
    for (let i = 0; i < c.n; i++) outF[i] = sig[i];
    for (let i = 0; i < c.n; i++) outF[i] = g.process(outF[i]);
  } else {
    const f = makeSvf();
    coef = [f.g, f.k, f.a1, f.a2, f.a3];
    outD = new Float64Array(c.n);
    for (let i = 0; i < c.n; i++) outD[i] = f.process(sig[i], c.mode);
    magDb = new Float64Array(MAG_POINTS); // SVF has no magnitudeDb; C writes zeros
    const g = makeSvf();
    outF = new Float32Array(c.n);
    for (let i = 0; i < c.n; i++) outF[i] = sig[i];
    for (let i = 0; i < c.n; i++) outF[i] = g.process(outF[i], c.mode);
  }
  return { coef, outD, outF, magDb };
}

const maxAbs = (a, b) => {
  let m = 0;
  let at = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) {
      m = d;
      at = i;
    }
  }
  return { m, at };
};
const maxRel = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const scale = Math.max(Math.abs(a[i]), Math.abs(b[i]), 1e-30);
    const d = Math.abs(a[i] - b[i]) / scale;
    if (d > m) m = d;
  }
  return m;
};

const label = (c) =>
  c.kind === 1
    ? `biquad t=${c.type} f=${c.freq} q=${c.q} g=${c.gainDb} sig=${c.signal}`
    : c.kind === 2
      ? `cascade t=${c.type} st=${c.stages} act=${c.active} f=${c.freq} q=${c.q}`
      : `svf mode=${c.mode} f=${c.freq} q=${c.q} sig=${c.signal}`;

// ---------------------------------------------------------------------------
// 5. compare
// ---------------------------------------------------------------------------

function compare(name, dump) {
  console.log(`\n== ${name} vs biquad.js ==`);
  const worst = { coef: 0, magDb: 0, outD: 0, outF: 0 };
  const offenders = { coef: "", magDb: "", outD: "", outF: "" };
  let bad = 0;

  for (const c of dump) {
    const ref = jsReference(c);
    const dCoef = maxRel(ref.coef, c.coef);
    const dMag = maxAbs(ref.magDb, c.magDb).m;
    const dOutD = maxAbs(ref.outD, c.outD).m;
    const dOutF = maxAbs(ref.outF, c.outF).m;

    if (dCoef > worst.coef) (worst.coef = dCoef), (offenders.coef = label(c));
    if (dMag > worst.magDb) (worst.magDb = dMag), (offenders.magDb = label(c));
    if (dOutD > worst.outD) (worst.outD = dOutD), (offenders.outD = label(c));
    if (dOutF > worst.outF) (worst.outF = dOutF), (offenders.outF = label(c));

    if (dCoef > TOL.coef || dMag > TOL.magDb || dOutD > TOL.sampleDouble || dOutF > TOL.sampleFloat) {
      bad++;
      if (bad <= 8) {
        console.log(
          `  FAIL ${label(c)} coef=${dCoef.toExponential(2)} mag=${dMag.toExponential(2)} ` +
            `outD=${dOutD.toExponential(2)} outF=${dOutF.toExponential(2)}`,
        );
      }
    }
  }

  ok(`${name}: every case within tolerance`, bad === 0, `${dump.length - bad}/${dump.length} cases clean`);
  ok(`${name}: coefficients`, worst.coef <= TOL.coef, `worst rel ${worst.coef.toExponential(2)} (${offenders.coef})`);
  ok(`${name}: magnitude response`, worst.magDb <= TOL.magDb, `worst ${worst.magDb.toExponential(2)} dB`);
  ok(
    `${name}: double path`,
    worst.outD <= TOL.sampleDouble,
    `worst ${worst.outD.toExponential(2)} (${(20 * Math.log10(worst.outD + 1e-300)).toFixed(1)} dBFS) (${offenders.outD})`,
  );
  ok(
    `${name}: float32 block path`,
    worst.outF <= TOL.sampleFloat,
    `worst ${worst.outF.toExponential(2)} (${(20 * Math.log10(worst.outF + 1e-300)).toFixed(1)} dBFS)`,
  );
  return worst;
}

const wNative = compare("native", native);
if (wasm) compare("wasm", wasm);

// ---------------------------------------------------------------------------
// 6. native vs wasm — the check that decides whether route (c) ships
// ---------------------------------------------------------------------------

if (wasm) {
  console.log("\n== native vs wasm (same C, two toolchains) ==");
  ok("case counts match", native.length === wasm.length, `${native.length} vs ${wasm.length}`);
  let worstD = 0;
  let worstF = 0;
  let worstCoef = 0;
  let identical = 0;
  for (let i = 0; i < Math.min(native.length, wasm.length); i++) {
    const a = native[i];
    const b = wasm[i];
    const dD = maxAbs(a.outD, b.outD).m;
    const dF = maxAbs(a.outF, b.outF).m;
    const dC = maxRel(a.coef, b.coef);
    if (dD === 0 && dF === 0 && dC === 0) identical++;
    if (dD > worstD) worstD = dD;
    if (dF > worstF) worstF = dF;
    if (dC > worstCoef) worstCoef = dC;
  }
  ok(
    "native and wasm agree within tolerance",
    worstD <= TOL.crossToolchain && worstF <= TOL.crossToolchain,
    `worst double ${worstD.toExponential(2)}, float ${worstF.toExponential(2)}, coef ${worstCoef.toExponential(2)}`,
  );
  console.log(`   ${identical}/${native.length} cases are bit-identical across toolchains`);
}

// ---------------------------------------------------------------------------
// 7. guard: the dump must not be trivially empty or constant
// ---------------------------------------------------------------------------

console.log("\n== 3. sanity: the battery actually exercises the filters ==");
{
  let nonTrivial = 0;
  let widest = 0;
  for (const c of native) {
    let p = 0;
    for (let i = 0; i < c.n; i++) p = Math.max(p, Math.abs(c.outD[i]));
    if (p > 1e-6) nonTrivial++;
    widest = Math.max(widest, p);
  }
  ok("most cases produce real signal", nonTrivial > native.length * 0.8, `${nonTrivial}/${native.length} above -120 dBFS`);
  ok("nothing blew up", widest < 1e3, `widest peak ${widest.toFixed(3)}`);
  const types = new Set(native.filter((c) => c.kind === 1).map((c) => c.type));
  ok("all 8 filter types plus the default branch covered", types.size === 9, `${types.size} distinct type values`);
}

console.log(`\n${checks} checks, ${failures} failed`);
console.log(`\nbiquad parity: ${failures === 0 ? "PASS" : "FAIL"}`);
if (!haveEmcc) console.log("note: wasm half skipped — emscripten unavailable");
process.exit(failures === 0 ? 0 : 1);
