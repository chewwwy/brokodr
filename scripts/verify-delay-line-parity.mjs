/**
 * Parity oracle for the C port of dsp/core/delay-line.js (Phase 5, route (c)).
 *
 * Same four steps as verify-utils-parity.mjs, on the shared plumbing in
 * scripts/lib/parity-stream.mjs:
 *
 *   1. build the C natively and run the battery;
 *   2. build the same source to wasm with emscripten and run it under Node;
 *   3. replay the identical battery through the original delay-line.js;
 *   4. diff native against wasm.
 *
 * The battery lives in packages/native/tests/parity-delay-line.c and only
 * there. Every case parameter travels in the dump, so this file reads the sweep
 * back out rather than keeping a copy of it.
 *
 * One wrinkle worth explaining. `makeLP` is module-private in delay-line.js —
 * not exported — but it is the 2nd-order lowpass the oversampler is built from,
 * and leaving it untested would leave the oversampler's own coefficients
 * unverified. Re-implementing it here would be worthless: the runner would then
 * be comparing the C against a second copy of my own arithmetic rather than
 * against the shipping code. So the runner writes a throwaway module that is
 * the original source plus one `export` line and imports that. The code under
 * test is byte-for-byte the shipping code; only its export list differs.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOL,
  buildAndRun,
  compareToJs,
  compareToolchains,
  createChecker,
  describe,
  fillSignal,
  firstDiff,
  maxAbs,
  maxRel,
} from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

const { native, wasm } = buildAndRun({
  root,
  name: "parity-delay-line",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/delay-line.c"),
    join(root, "packages/native/tests/parity-delay-line.c"),
  ],
  ok,
  state,
});

console.log(`\n   ${native.length} records in the battery`);

// ---------------------------------------------------------------------------
// the JS under test, with makeLP reachable (see the note at the top)
// ---------------------------------------------------------------------------

const coreDir = join(root, "packages/web/public/dsp/core");
const realSrc = join(coreDir, "delay-line.js");
const probe = join(coreDir, ".parity-probe.delay-line.mjs");
let js;
try {
  const src = readFileSync(realSrc, "utf8");
  writeFileSync(probe, `${src}\nexport { makeLP as __makeLP };\n`);
  js = await import(`${probe}?t=${Date.now()}`);
  ok("delay-line.js exposes makeLP for the probe", typeof js.__makeLP === "function");
} finally {
  rmSync(probe, { force: true });
}
const { clamp } = await import("../packages/web/public/dsp/core/utils.js");

// ---------------------------------------------------------------------------
// mirrors of the two things the C battery decides for itself
// ---------------------------------------------------------------------------

const SHAPE = {
  0: (x) => x,
  1: (x) => clamp(x, -1, 1),
  2: (x) => x - (x * x * x) / 3,
};

const DELAY_FIXED = 0;
const DELAY_SWEEP = 1;
const DELAY_MODULATED = 2;

/** Mirror of delay_at() in parity-delay-line.c. */
function delayAt(mode, base, i, n, size) {
  if (mode === DELAY_SWEEP) return -4 + (i / n) * (size + 8);
  if (mode === DELAY_MODULATED) {
    const ph = i % 64;
    const tri = ph < 32 ? ph / 32 : 2 - ph / 32;
    return base + (tri * 2 - 1) * 3.5;
  }
  return base;
}

// ---------------------------------------------------------------------------
// references
// ---------------------------------------------------------------------------

const REF = {
  "read.nonfinite"(rec) {
    const d = new js.DelayLine(rec.params[0]);
    for (let j = 0; j < 100; j++) d.write(j * 0.01);
    const out = [];
    for (let pass = 0; pass < 2; pass++) {
      if (pass) d.clear();
      for (const ask of [NaN, Infinity, -Infinity]) out.push(d.read(ask), d.readCubic(ask));
    }
    return { out64: Float64Array.from(out) };
  },
  /** bk_delay_line_size vs the JS constructor's sizing rule. */
  size(rec) {
    const out = new Float64Array(rec.out64.length);
    for (let k = 0; k < rec.out64.length; k += 2) {
      const ask = rec.out64[k];
      out[k] = ask;
      // Exactly what `new DelayLine(ask)` computes for this.size.
      out[k + 1] = new js.DelayLine(ask).size;
    }
    return { out64: out };
  },

  DelayLine(rec) {
    const [maxSamples, cubic, base, dmode, signal, n] = rec.params;
    const sig = fillSignal(n, signal);
    const d = new js.DelayLine(maxSamples);
    const out = new Float64Array(n);
    for (let t = 0; t < n; t++) {
      d.write(sig[t]);
      const dl = delayAt(dmode, base, t, n, d.size);
      out[t] = cubic ? d.readCubic(dl) : d.read(dl);
    }
    return { out64: out, out32: d.buf.slice(0, d.size), w: d.w };
  },

  roundtrip(rec) {
    const [, maxSamples] = rec.params;
    const d = new js.DelayLine(maxSamples);
    const out = new Float64Array(rec.out64.length);
    for (let k = 0; k < rec.out64.length; k += 2) {
      const v = rec.out64[k]; // the input travels in the stream
      d.write(v);
      out[k] = v;
      out[k + 1] = d.read(0);
    }
    return { out64: out };
  },

  Allpass(rec) {
    const [maxSamples, g, delay, signal, n] = rec.params;
    const sig = fillSignal(n, signal);
    const a = new js.Allpass(maxSamples);
    a.g = g;
    const out = new Float64Array(n);
    for (let t = 0; t < n; t++) out[t] = a.process(sig[t]);
    // The C reads a.delay back out of the struct; assert the constructors agree.
    if (a.delay !== delay) throw new Error(`Allpass delay mismatch: js ${a.delay} vs c ${delay}`);
    return { out64: out };
  },

  "Allpass.clear"(rec) {
    const [maxSamples, n] = rec.params;
    const sig = fillSignal(n, 2);
    const a = new js.Allpass(maxSamples);
    const out = new Float64Array(n * 2);
    for (let t = 0; t < n; t++) out[t] = a.process(sig[t]);
    a.clear();
    for (let t = 0; t < n; t++) out[n + t] = a.process(sig[t]);
    return { out64: out };
  },

  makeLP(rec) {
    const [sr, cutoff, signal, n] = rec.params;
    const f = js.__makeLP(sr, cutoff);
    const out = new Float64Array(5 + n);
    out[0] = f.b0;
    out[1] = f.b1;
    out[2] = f.b2;
    out[3] = f.a1;
    out[4] = f.a2;
    if (n > 0) {
      const sig = fillSignal(n, signal);
      for (let t = 0; t < n; t++) out[5 + t] = f.process(sig[t]);
    }
    return { out64: out };
  },

  Oversampler4x(rec) {
    const [sr, block, shape, gain, signal, n, calls] = rec.params;
    const sig = fillSignal(n, signal);
    const os = new js.Oversampler4x(sr, block);
    const shaper = SHAPE[shape];
    const inBlock = new Float32Array(block);
    const outBlock = new Float32Array(block);
    const out = new Float32Array(n);
    for (let b = 0; b < calls; b++) {
      for (let t = 0; t < block; t++) inBlock[t] = sig[b * block + t] * gain;
      os.process(inBlock, block, shaper, outBlock);
      out.set(outBlock.subarray(0, block), b * block);
    }
    return { out32: out };
  },

  "Oversampler4x.io"(rec) {
    const [sr, block, shape] = rec.params;
    const sig = fillSignal(block, 2);
    const os = new js.Oversampler4x(sr, block);
    const shaper = SHAPE[shape];
    const buf = new Float32Array(block);
    const out = new Float32Array(block * 2);
    // in-place: the same Float32Array as input and output
    for (let t = 0; t < block; t++) buf[t] = sig[t];
    os.process(buf, block, shaper, buf);
    out.set(buf, 0);
    // then reset() and the same stimulus into a separate output
    os.reset();
    const sep = new Float32Array(block);
    for (let t = 0; t < block; t++) buf[t] = sig[t];
    os.process(buf, block, shaper, sep);
    out.set(sep, block);
    return { out32: out };
  },
};

function reference(rec) {
  const fn = REF[rec.name];
  if (!fn) throw new Error(`no JS reference for record "${rec.name}"`);
  return fn(rec);
}

// `size`, `roundtrip` and the coefficient head of `makeLP` are single
// evaluations over a range that runs out to 1e30, so they get the relative bar
// rather than the -120 dBFS sample bar, which would be meaningless up there.
const RELATIVE = new Set(["size", "roundtrip"]);
const isRelative = (rec) => RELATIVE.has(rec.name);

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

ok(
  "every record has a JS reference",
  native.every((r) => r.name in REF),
  [...new Set(native.map((r) => r.name))].join(", "),
);

function relativeChecks(dump, label) {
  console.log(`\n== sizing and float32 round-trip: ${label} vs delay-line.js ==`);
  let worst = 0;
  let offender = "";
  let bad = 0;
  for (const rec of dump.filter(isRelative)) {
    const ref = reference(rec).out64;
    const d = maxRel(ref, rec.out64);
    if (d > worst) (worst = d), (offender = describe(rec));
    if (d > TOL.scalar) {
      bad++;
      console.log(`  FAIL ${rec.name} rel=${d.toExponential(2)} first diff at index ${firstDiff(ref, rec.out64)}`);
    }
  }
  ok(`${label}: sizing and float32 round-trip agree`, bad === 0, `worst rel ${worst.toExponential(2)}${offender ? ` (${offender})` : ""}`);
}

// The lowpass coefficients get their own tighter check, separate from the
// impulse response they drive: a coefficient that is off by 1e-9 is a bug even
// though three poles of lowpass would hide it well below -120 dBFS downstream.
function coefficientChecks(dump, label) {
  console.log(`\n== lowpass coefficients: ${label} vs makeLP ==`);
  let worst = 0;
  let offender = "";
  let bad = 0;
  for (const rec of dump.filter((r) => r.name === "makeLP")) {
    const ref = reference(rec).out64.subarray(0, 5);
    const d = maxRel(ref, rec.out64.subarray(0, 5));
    if (d > worst) (worst = d), (offender = describe(rec));
    if (d > TOL.coef) {
      bad++;
      console.log(`  FAIL ${describe(rec)} rel=${d.toExponential(2)}`);
    }
  }
  ok(`${label}: makeLP coefficients`, bad === 0, `worst rel ${worst.toExponential(2)}${offender ? ` (${offender})` : ""}`);
}

relativeChecks(native, "native");
coefficientChecks(native, "native");
// Bit-identity baselines, pinned. The tolerance checks pass at -120 dBFS,
// which a sub-ulp perturbation can slip under while still being a different
// function; mutation testing on fft.js found exactly that hole. A drop here is
// either a real change in the port or a change in libm (see the caveat in
// brobeats-plan.md) — investigate, then re-baseline deliberately.
const IDENTITY_NATIVE = 266;
const IDENTITY_WASM = 268;
const IDENTITY_CROSS = 268;

compareToJs({
  name: "native",
  dump: native.filter((r) => !isRelative(r)),
  reference,
  ok,
  expectIdentical: IDENTITY_NATIVE,
});

if (wasm) {
  relativeChecks(wasm, "wasm");
  coefficientChecks(wasm, "wasm");
  compareToJs({
    name: "wasm",
    dump: wasm.filter((r) => !isRelative(r)),
    reference,
    ok,
    expectIdentical: IDENTITY_WASM,
  });
  compareToolchains({ native, wasm, ok, expectIdentical: IDENTITY_CROSS });
}

// ---------------------------------------------------------------------------
// sanity: the battery has to actually exercise the code
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises delay-line ==");
{
  const names = new Set(native.map((r) => r.name));
  const missing = Object.keys(REF).filter((n) => !names.has(n));
  ok("every ported object appears in the battery", missing.length === 0, missing.length ? `missing: ${missing}` : `${names.size} distinct`);

  const lines = native.filter((r) => r.name === "DelayLine");

  // A delay line that returned its input would pass a naive diff, because the
  // JS would do the same. These check the battery actually delays.
  const delayed = lines.filter((r) => {
    const [, , base, dmode, signal, n] = r.params;
    if (dmode !== DELAY_FIXED || base < 1) return false;
    const sig = fillSignal(n, signal);
    return maxAbs(sig, r.out64).m > 1e-3;
  });
  const fixedNonZero = lines.filter((r) => r.params[3] === DELAY_FIXED && r.params[2] >= 1);
  ok(
    "a non-zero fixed delay actually shifts the signal",
    delayed.length === fixedNonZero.length && fixedNonZero.length > 0,
    `${delayed.length}/${fixedNonZero.length} cases`,
  );

  // The impulse cases pin the delay down to the exact sample: feed a single 1
  // and the 1 must come back out exactly that many samples later, not
  // that-many-ish. The expectation is the *clamped* delay, not the requested
  // one — some cases deliberately ask for 40 samples from a 12-sample line, and
  // getting the clamp back is the correct answer there.
  const impulses = lines.filter(
    (r) => r.params[4] === 0 && r.params[3] === DELAY_FIXED && Number.isInteger(r.params[2]) && r.params[2] >= 1,
  );
  const onTime = impulses.filter((r) => {
    const size = new js.DelayLine(r.params[0]).size;
    // clamp ranges straight out of DelayLine.read / readCubic
    const expect = r.params[1] ? clamp(r.params[2], 1, size - 4) : clamp(r.params[2], 0, size - 3);
    const at = [...r.out64].findIndex((v) => Math.abs(v) > 0.5);
    return at === expect;
  });
  ok("an impulse comes back at exactly the requested delay", onTime.length === impulses.length && impulses.length > 0, `${onTime.length}/${impulses.length} cases`);

  // The sweep cases run the delay past both ends of the line. If clamp() were
  // dropped the reads would go out of bounds, which in C is silence or a
  // crash and in JS is undefined -> NaN. Either way the diff catches it, but
  // assert the sweep is genuinely leaving the legal range.
  const sweeps = lines.filter((r) => r.params[3] === DELAY_SWEEP);
  const clampedBoth = sweeps.filter((r) => {
    const size = new js.DelayLine(r.params[0]).size;
    return delayAt(DELAY_SWEEP, 0, 0, r.params[5], size) < 0 && delayAt(DELAY_SWEEP, 0, r.params[5] - 1, r.params[5], size) > size - 3;
  });
  ok("the sweep crosses both clamps", clampedBoth.length === sweeps.length && sweeps.length > 0, `${clampedBoth.length}/${sweeps.length} cases`);

  // The write pointer has to have lapped the buffer on the small-size cases,
  // or the modulo wraparound was never tested at all.
  const wrapped = lines.filter((r) => r.params[0] <= 64 && r.params[5] > new js.DelayLine(r.params[0]).size);
  ok("small lines wrap the write pointer many times", wrapped.length > 0, `${wrapped.length} wrapping cases`);

  // clear() and reset() halves must match, or those two paths prove nothing.
  for (const rec of native.filter((r) => r.name === "Allpass.clear")) {
    const n = rec.params[1];
    const a = rec.out64.subarray(0, n);
    const b = rec.out64.subarray(n, n * 2);
    ok("Allpass.clear() returns it to the initial state", maxAbs(a, b).m === 0, `${n} samples, bit-identical`);
  }
  for (const rec of native.filter((r) => r.name === "Oversampler4x.io")) {
    const block = rec.params[1];
    const inPlace = rec.out32.subarray(0, block);
    const separate = rec.out32.subarray(block, block * 2);
    ok("Oversampler4x in-place output equals the separate-buffer run", maxAbs(inPlace, separate).m === 0, `${block} frames, bit-identical`);
  }

  // The oversampler's whole reason to exist is the nonlinearity, so the
  // nonlinear cases have to differ audibly from the identity case.
  const os = native.filter((r) => r.name === "Oversampler4x");
  const nonlinear = os.filter((r) => r.params[2] !== 0 && r.params[3] >= 1);
  const bent = nonlinear.filter((r) => {
    const id = os.find(
      (q) => q.params[0] === r.params[0] && q.params[1] === r.params[1] && q.params[2] === 0 && q.params[3] === r.params[3] && q.params[4] === r.params[4],
    );
    return id && maxAbs(id.out32, r.out32).m > 1e-3;
  });
  ok("the shapers actually bend the signal", bent.length === nonlinear.length && nonlinear.length > 0, `${bent.length}/${nonlinear.length} cases`);

  let widest = 0;
  let widestName = "";
  for (const rec of native.filter((r) => !isRelative(r))) {
    for (const v of [...rec.out64, ...rec.out32]) {
      const a = Math.abs(v);
      if (Number.isFinite(a) && a > widest) (widest = a), (widestName = rec.name);
    }
  }
  ok("nothing ran away", widest < 1e4, `widest ${widest.toExponential(2)} (${widestName})`);
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\ndelay-line parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
