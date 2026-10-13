/**
 * Reader for the BKPARITY stream the DSP parity producers write, plus the diff
 * helpers and the tolerance table every verify-*-parity.mjs script shares.
 *
 * See packages/native/tests/parity-io.h for the format. Version 3 is the
 * generic record stream; version 2 is the biquad-specific layout that predates
 * it and is read by scripts/verify-biquad-parity.mjs directly.
 *
 * Tolerances are stated as absolute sample error and the bar is -120 dBFS
 * (1e-6). That is roughly 20 bits down — far below the noise floor of any
 * converter the app will ever meet, and well below the 24-bit floor of the
 * UMC1820. Coefficients and single-evaluation readings are held much tighter
 * because nothing accumulates in them.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

export const TOL = {
  coef: 1e-12, // relative; no accumulation, so this is pure libm spread
  scalar: 1e-12, // relative; a single evaluation of one function
  sampleDouble: 1e-6, // -120 dBFS
  sampleFloat: 2e-6, // float32 eps is ~1.2e-7, and an IIR walks on it
  crossToolchain: 1e-6, // native vs wasm: the one users can actually hear
};

// BK_EMSDK overrides (CI runners have none; point it anywhere empty to test that path).
export const EMSDK = process.env.BK_EMSDK || "/home/user/emsdk";
const NAME_LEN = 32;

/** Parse a version-3 BKPARITY stream into an array of records. */
export function parseStream(path) {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.subarray(0, 8).toString("latin1") !== "BKPARITY") throw new Error(`${path}: bad magic`);
  const version = dv.getUint32(8, true);
  if (version !== 3) throw new Error(`${path}: expected format version 3, got ${version}`);
  const count = dv.getUint32(12, true);
  let o = 16;
  const records = [];
  for (let r = 0; r < count; r++) {
    const name = buf.subarray(o, o + NAME_LEN).toString("latin1").replace(/\0+$/, "");
    o += NAME_LEN;
    const nParams = dv.getUint32(o, true);
    const n64 = dv.getUint32(o + 4, true);
    const n32 = dv.getUint32(o + 8, true);
    o += 16;
    const params = new Float64Array(nParams);
    for (let i = 0; i < nParams; i++, o += 8) params[i] = dv.getFloat64(o, true);
    const out64 = new Float64Array(n64);
    for (let i = 0; i < n64; i++, o += 8) out64[i] = dv.getFloat64(o, true);
    const out32 = new Float32Array(n32);
    for (let i = 0; i < n32; i++, o += 4) out32[i] = dv.getFloat32(o, true);
    o += (8 - ((n32 * 4) % 8)) % 8;
    records.push({ name, params, out64, out32 });
  }
  if (o !== buf.byteLength) throw new Error(`${path}: trailing bytes (${buf.byteLength - o})`);
  return records;
}

/** The C stimulus generator, mirrored exactly. Must stay bit-identical. */
export function fillSignal(n, signal) {
  const dst = new Float64Array(n);
  let state = 0x13572468 >>> 0;
  for (let i = 0; i < n; i++) {
    if (signal === 0) dst[i] = i === 0 ? 1 : 0;
    else if (signal === 1) dst[i] = i < Math.floor(n / 2) ? 0.5 : 0;
    else if (signal === 3) dst[i] = (i % 256) / 128 - 1;
    else if (signal === 4) dst[i] = 0;
    else {
      // Must match the C LCG bit for bit: uint32 wraparound via Math.imul.
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      dst[i] = ((state >>> 8) / 16777216) * 2 - 1;
    }
  }
  return dst;
}

export function maxAbs(a, b) {
  let m = 0;
  let at = -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    // NaN- and Infinity-aware: equal bit patterns (including NaN vs NaN, which
    // sanitize() cases produce) count as zero error, and a NaN facing a number
    // counts as total disagreement rather than silently comparing false.
    const an = Number.isNaN(a[i]);
    const bn = Number.isNaN(b[i]);
    const d = a[i] === b[i] || (an && bn) ? 0 : an || bn ? Infinity : Math.abs(a[i] - b[i]);
    if (d > m) {
      m = d;
      at = i;
    }
  }
  if (a.length !== b.length) return { m: Infinity, at: n };
  return { m, at };
}

export function maxRel(a, b) {
  let m = 0;
  const n = Math.min(a.length, b.length);
  if (a.length !== b.length) return Infinity;
  for (let i = 0; i < n; i++) {
    const an = Number.isNaN(a[i]);
    const bn = Number.isNaN(b[i]);
    if (a[i] === b[i] || (an && bn)) continue;
    if (an || bn) return Infinity;
    const scale = Math.max(Math.abs(a[i]), Math.abs(b[i]), 1e-30);
    const d = Math.abs(a[i] - b[i]) / scale;
    if (d > m) m = d;
  }
  return m;
}

/** Index of the first disagreement, NaN-aware. -1 when the arrays agree. */
export function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const an = Number.isNaN(a[i]);
    const bn = Number.isNaN(b[i]);
    if (a[i] === b[i] || (an && bn)) continue;
    return i;
  }
  return a.length === b.length ? -1 : n;
}

export const dbfs = (x) => `${(20 * Math.log10(x + 1e-300)).toFixed(1)} dBFS`;

/** Minimal check counter, so every parity script reports the same way. */
export function createChecker() {
  const state = { checks: 0, failures: 0 };
  const ok = (name, cond, detail = "") => {
    state.checks++;
    if (cond) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
    else {
      state.failures++;
      console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };
  return { state, ok };
}

/**
 * Build one parity producer both ways and run both, returning the two dumps.
 * The wasm half is skipped (not failed) when emscripten is absent, so the
 * suite still runs on a machine without the SDK.
 */
/**
 * How a producer died, in one line. execFileSync throws a plain Error with
 * `signal` set for a killed child and `status` set for a non-zero exit, so a
 * segfault reads as "killed by SIGSEGV" rather than as a Node stack trace.
 */
function describeChildFailure(e) {
  if (e && e.signal) return `killed by ${e.signal}`;
  if (e && typeof e.status === "number") return `exit status ${e.status}`;
  const msg = String((e && (e.stderr || e.message)) || e).trim().replace(/\s+/g, " ");
  return msg.slice(0, 200) || "unknown failure";
}

/**
 * Which toolchain builds and runs the "native" producer.
 *
 *   host  (default)  the host `cc`, run directly. This is what every battery pins.
 *   mingw            BK_NATIVE_TOOLCHAIN=mingw: cross-build a static Windows .exe with
 *                    mingw-w64 and run it under Wine. Every battery then checks a
 *                    Windows binary (mingw-w64's libm and CRT) against the JS with its
 *                    own tolerances, unchanged. That is a Windows measurement but NOT
 *                    an MSVC one; MSVC is measured on the Windows CI runner.
 *   msvc             BK_NATIVE_TOOLCHAIN=msvc: build with MSVC `cl` and run directly, on a
 *                    Windows host (the CI runner). This is the shipping toolchain.
 *
 * The mingw build writes `<name>.exe` and `<name>-mingw.bin`, so it never clobbers the
 * host artefacts. Identity pins are measured on the host toolchain, so a foreign
 * toolchain may legitimately miss them; tolerance failures are the real signal there.
 */
export function nativeToolchain(kind = process.env.BK_NATIVE_TOOLCHAIN || "host") {
  if (kind === "host") {
    return {
      label: "host cc",
      cc: "cc",
      exe: "",
      dumpTag: "native",
      build: (args, out) => execFileSync("cc", [...args, "-o", out, "-lm"], { stdio: "inherit" }),
      run: (bin, args) => execFileSync(bin, args, { stdio: "pipe" }),
    };
  }
  if (kind === "mingw") {
    const cc = process.env.BK_MINGW_CC || "x86_64-w64-mingw32-gcc";
    const env = {
      ...process.env,
      WINEDEBUG: process.env.WINEDEBUG || "-all",
      WINEPREFIX: process.env.WINEPREFIX || `${process.env.HOME}/.wine-bk`,
    };
    // Wine resolves Z: to the Unix root, and Windows accepts forward slashes.
    const winPath = (p) => (p.startsWith("/") ? `Z:${p}` : p);
    return {
      label: `mingw-w64 (${cc}) under Wine`,
      cc,
      exe: ".exe",
      dumpTag: "mingw",
      build: (args, out) => execFileSync(cc, [...args, "-static", "-o", out, "-lm"], { stdio: "inherit" }),
      run: (bin, args) => execFileSync("wine", [bin, ...args.map(winPath)], { stdio: "pipe", env }),
    };
  }
  if (kind === "msvc") {
    // On a Windows host with the MSVC environment loaded (vcvars / msvc-dev-cmd).
    // /fp:precise is MSVC's default and the one that keeps FLT_EVAL_METHOD 0 on x64;
    // it is stated so nobody "optimises" it to /fp:fast. Objects go to a per-binary
    // directory so two producers built in one checkout never share a .obj.
    return {
      label: "MSVC cl",
      cc: "cl",
      exe: ".exe",
      dumpTag: "msvc",
      build: (args, out) => {
        const inc = [];
        const srcs = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "-I") inc.push(`/I${args[++i]}`);
          else if (!args[i].startsWith("-")) srcs.push(args[i]);
        }
        const objDir = `${out}.obj/`;
        mkdirSync(objDir, { recursive: true });
        execFileSync("cl", ["/nologo", "/O2", "/std:c11", "/fp:precise", "/W3", ...inc, ...srcs, `/Fo${objDir}`, `/Fe${out}`], {
          stdio: "inherit",
        });
      },
      run: (bin, args) => execFileSync(bin, args, { stdio: "pipe" }),
    };
  }
  throw new Error(`BK_NATIVE_TOOLCHAIN: unknown toolchain "${kind}" (host | mingw | msvc)`);
}

export function buildAndRun({ root, name, sources, include, ok, state, emccFlags = [] }) {
  const buildDir = `${root}/packages/native/build`;
  mkdirSync(buildDir, { recursive: true });
  const tc = nativeToolchain();
  const nativeBin = `${buildDir}/${name}${tc.exe}`;
  const wasmJs = `${buildDir}/${name}.js`;
  const nativeDump = `${buildDir}/${name}-${tc.dumpTag}.bin`;
  const wasmDump = `${buildDir}/${name}-wasm.bin`;

  console.log(`== build (native toolchain: ${tc.label}) ==`);
  tc.build(["-std=c99", "-O2", "-Wall", "-Wextra", "-I", include, ...sources], nativeBin);
  ok(`native build (${tc.cc} -O2 -Wall -Wextra)`, existsSync(nativeBin));

  let haveEmcc = existsSync(`${EMSDK}/emsdk_env.sh`);
  if (haveEmcc) {
    try {
      // NODERAWFS lets the wasm build write its dump straight to disk, so both
      // producers leave byte-comparable artefacts rather than one going through
      // a virtual filesystem. The output extension matters: emscripten
      // MODULARIZEs .mjs output and default-exports a factory, so main() never
      // runs and you get a silent exit 0 with no dump. Plain .js runs main.
      execFileSync(
        "bash",
        [
          "-lc",
          `source ${EMSDK}/emsdk_env.sh >/dev/null 2>&1 && emcc -std=c99 -O2 -I ${include} ${sources.join(" ")} ` +
            `-sNODERAWFS=1 -sENVIRONMENT=node -sEXIT_RUNTIME=1 ${emccFlags.join(" ")} -o ${wasmJs}`,
        ],
        { stdio: "pipe" },
      );
    } catch (e) {
      haveEmcc = false;
      console.log(`  note: emcc build failed — ${String(e.stderr || e).slice(0, 400)}`);
    }
  }
  ok("wasm build (emcc -O2)", haveEmcc && existsSync(wasmJs));

  console.log("\n== run producers ==");
  rmSync(nativeDump, { force: true });
  rmSync(wasmDump, { force: true });
  // A producer that crashes is a parity failure like any other, and has to be
  // reported as one. Letting execFileSync throw here buried the result in a
  // Node stack trace, which made a genuine fault (a bad FFT level count walking
  // off the end of its buffers) look to a mutation run like nothing happened.
  let nativeErr = null;
  try {
    tc.run(nativeBin, [nativeDump]);
  } catch (e) {
    nativeErr = describeChildFailure(e);
  }
  ok("native producer wrote a dump", !nativeErr && existsSync(nativeDump), nativeErr || "");

  if (haveEmcc) {
    let wasmErr = null;
    try {
      execFileSync("node", [wasmJs, wasmDump], { stdio: "pipe" });
    } catch (e) {
      wasmErr = describeChildFailure(e);
      console.log(`  note: wasm producer failed — ${wasmErr}`);
    }
    if (!existsSync(wasmDump)) haveEmcc = false;
    ok("wasm producer wrote a dump", existsSync(wasmDump), wasmErr || "");
  }

  // Without a native dump there is nothing to diff, so stop here with the
  // count so far rather than throwing on a half-written file.
  if (nativeErr || !existsSync(nativeDump)) {
    console.log(
      `\nABORT: the native producer did not complete (${nativeErr || "no dump written"}); ` +
        "nothing to compare.",
    );
    if (state) console.log(`\n${state.checks} checks, ${state.failures} failed — FAIL`);
    process.exit(1);
  }

  return {
    native: parseStream(nativeDump),
    wasm: haveEmcc ? parseStream(wasmDump) : null,
    haveEmcc,
  };
}

/**
 * Diff a dump against the JS reference. `reference(record)` returns
 * { out64, out32 } computed by the original JavaScript.
 */
export function compareToJs({ name, dump, reference, ok, tol = TOL, expectIdentical }) {
  console.log(`\n== ${name} vs the JavaScript original ==`);
  const worst = { d: 0, f: 0 };
  const offender = { d: "", f: "" };
  let bad = 0;
  let identical = 0;
  const drifted = [];

  for (const rec of dump) {
    const ref = reference(rec);
    const dD = maxAbs(ref.out64 ?? [], rec.out64).m;
    const dF = maxAbs(ref.out32 ?? [], rec.out32).m;
    if (dD === 0 && dF === 0) identical++;
    else if (drifted.length < 6) drifted.push(describe(rec));
    if (dD > worst.d) (worst.d = dD), (offender.d = describe(rec));
    if (dF > worst.f) (worst.f = dF), (offender.f = describe(rec));
    if (dD > tol.sampleDouble || dF > tol.sampleFloat) {
      bad++;
      if (bad <= 8) {
        console.log(`  FAIL ${describe(rec)} out64=${dD.toExponential(2)} out32=${dF.toExponential(2)}`);
      }
    }
  }

  ok(`${name}: every case within tolerance`, bad === 0, `${dump.length - bad}/${dump.length} cases clean`);
  ok(`${name}: double path`, worst.d <= tol.sampleDouble, `worst ${worst.d.toExponential(2)} (${dbfs(worst.d)})${offender.d ? ` (${offender.d})` : ""}`);
  ok(`${name}: float32 path`, worst.f <= tol.sampleFloat, `worst ${worst.f.toExponential(2)} (${dbfs(worst.f)})${offender.f ? ` (${offender.f})` : ""}`);
  console.log(`   ${identical}/${dump.length} cases are bit-identical to the JS`);
  assertIdentity({
    label: `${name}: bit-identity baseline`,
    identical,
    total: dump.length,
    expectIdentical,
    drifted,
    ok,
  });
  return { ...worst, identical };
}

/**
 * Bit-identity, asserted rather than merely printed.
 *
 * Why this exists: the tolerance checks above pass at -120 dBFS, which is the
 * right bar for "can a user hear it". But a port can drift by a fraction of a
 * float32 ulp and sail through that bar while being, in fact, a different
 * function — perturbing a window coefficient in the sixth decimal place is
 * invisible to a -120 dBFS check and obvious to this one. Mutation testing
 * found exactly that hole, so the observed identity count is pinned.
 *
 * A drop here is not automatically a bug: per the plan's standing caveat,
 * libm is not required to be correctly-rounded, so a different toolchain or a
 * glibc upgrade can legitimately move the count. It is always something to
 * look at and then deliberately re-baseline, which is the point.
 */
function assertIdentity({ label, identical, total, expectIdentical, drifted, ok }) {
  if (typeof expectIdentical !== "number") {
    console.log(`   note: no identity baseline pinned for this comparison (${identical}/${total})`);
    return;
  }
  const detail =
    `${identical}/${total} identical, baseline ${expectIdentical}` +
    (identical < expectIdentical && drifted.length ? ` — first drifted: ${drifted.join(", ")}` : "");
  ok(label, identical >= expectIdentical, detail);
  if (identical < expectIdentical) {
    console.log(
      "   ^ sub-tolerance drift. Either the port changed behaviour, or libm did:\n" +
        "     diff the module, and only re-baseline once you know which.",
    );
  }
}

/**
 * Diff native against wasm. This is the check that actually decides whether
 * route (c) ships: the desktop and the web build must agree with each other,
 * not merely each agree with the JS to within some slack.
 */
export function compareToolchains({ native, wasm, ok, tol = TOL, expectIdentical }) {
  console.log("\n== native vs wasm (same C, two toolchains) ==");
  ok("record counts match", native.length === wasm.length, `${native.length} vs ${wasm.length}`);
  let worstD = 0;
  let worstF = 0;
  let identical = 0;
  const drifted = [];
  const n = Math.min(native.length, wasm.length);
  for (let i = 0; i < n; i++) {
    const dD = maxAbs(native[i].out64, wasm[i].out64).m;
    const dF = maxAbs(native[i].out32, wasm[i].out32).m;
    if (dD === 0 && dF === 0) identical++;
    else if (drifted.length < 6) drifted.push(describe(native[i]));
    if (dD > worstD) worstD = dD;
    if (dF > worstF) worstF = dF;
  }
  ok(
    "native and wasm agree within tolerance",
    worstD <= tol.crossToolchain && worstF <= tol.crossToolchain,
    `worst double ${worstD.toExponential(2)}, float ${worstF.toExponential(2)}`,
  );
  console.log(`   ${identical}/${n} records are bit-identical across toolchains`);
  assertIdentity({
    label: "native/wasm bit-identity baseline",
    identical,
    total: n,
    expectIdentical,
    drifted,
    ok,
  });
}

export function describe(rec) {
  const p = [...rec.params].map((v) => (Number.isInteger(v) ? String(v) : v.toPrecision(4)));
  return `${rec.name}(${p.join(", ")})`;
}
