/**
 * Parity oracle for the C port of dsp/core/fft.js (Phase 5, route (c)).
 *
 * Same four steps as the other verify-*-parity scripts, on the shared plumbing
 * in scripts/lib/parity-stream.mjs:
 *
 *   1. build the C natively and run the battery;
 *   2. build the same source to wasm with emscripten and run it under Node;
 *   3. replay the identical battery through the original fft.js;
 *   4. diff native against wasm.
 *
 * The battery lives in packages/native/tests/parity-fft.c and only there. Every
 * case parameter travels in the dump, so this file reads the sweep back out
 * rather than keeping a second copy of the case table that could drift.
 *
 * Everything in fft.js is exported, so unlike the delay-line runner this one
 * needs no export probe — it imports the shipping file directly.
 *
 * Beyond diffing, this script checks a handful of properties that a diff alone
 * cannot: that an impulse really does transform to a flat spectrum, that DC
 * really is the sum of the input, that forward-then-inverse reconstructs, that
 * the Hann window really is the periodic one with correct COLA at hop N/4, and
 * that the cepstral envelope really is smoother than the spectrum it came from.
 * A port that is bit-identical to a JS file which is itself wrong would pass
 * every diff here and fail all of those.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOL,
  buildAndRun,
  compareToJs,
  compareToolchains,
  createChecker,
  describe,
  fillSignal,
  maxAbs,
  maxRel,
} from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

const { native, wasm } = buildAndRun({
  root,
  name: "parity-fft",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/fft.c"),
    join(root, "packages/native/tests/parity-fft.c"),
  ],
  ok,
  state,
});

console.log(`\n   ${native.length} records in the battery`);

const js = await import("../packages/web/public/dsp/core/fft.js");

// ---------------------------------------------------------------------------
// mirrors of the two things the C battery decides for itself
// ---------------------------------------------------------------------------

/** Mirror of the magnitude spectrum the battery feeds CepstralEnvelope. */
function magnitudes(bins, signal, scale) {
  const sig = fillSignal(bins, signal);
  const mag = new Float32Array(bins);
  for (let i = 0; i < bins; i++) mag[i] = Math.abs(sig[i]) * scale;
  return mag;
}

/** re/im loaded exactly as the battery loads them: float32 stores of the stimulus. */
function loadComplex(size, sigRe, sigIm) {
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const a = fillSignal(size, sigRe);
  const b = fillSignal(size, sigIm);
  for (let i = 0; i < size; i++) {
    re[i] = a[i];
    im[i] = b[i];
  }
  return { re, im };
}

const pair = (re, im) => {
  const out = new Float32Array(re.length * 2);
  out.set(re, 0);
  out.set(im, re.length);
  return out;
};

// ---------------------------------------------------------------------------
// references
// ---------------------------------------------------------------------------

const REF = {
  /** Which sizes the JS constructor accepts, and which it throws on. */
  "FFT.accept"(rec) {
    const out = new Float64Array(rec.out64.length);
    for (let k = 0; k < rec.out64.length; k += 2) {
      const size = rec.out64[k];
      out[k] = size;
      try {
        new js.FFT(size);
        out[k + 1] = 0;
      } catch {
        out[k + 1] = 1;
      }
    }
    return { out64: out };
  },

  "FFT.meta"(rec) {
    const f = new js.FFT(rec.params[0]);
    return { out64: Float64Array.of(f.size, f.half, f.levels) };
  },

  "FFT.tables"(rec) {
    const f = new js.FFT(rec.params[0]);
    const out64 = new Float64Array(f.rev.length);
    for (let i = 0; i < f.rev.length; i++) out64[i] = f.rev[i];
    return { out64, out32: pair(f.cos, f.sin) };
  },

  "FFT.transform"(rec) {
    const [size, inverse, sigRe, sigIm] = rec.params;
    const f = new js.FFT(size);
    const { re, im } = loadComplex(size, sigRe, sigIm);
    f.transform(re, im, inverse !== 0);
    return { out32: pair(re, im) };
  },

  "FFT.roundtrip"(rec) {
    const [size, signal] = rec.params;
    const f = new js.FFT(size);
    const { re, im } = loadComplex(size, signal, 4);
    f.transform(re, im, false);
    f.transform(re, im, true);
    for (let i = 0; i < size; i++) {
      re[i] = re[i] / size;
      im[i] = im[i] / size;
    }
    return { out32: pair(re, im) };
  },

  hannWindow(rec) {
    return { out32: js.hannWindow(rec.params[0]) };
  },

  CepstralEnvelope(rec) {
    const [size, lifter, signal, scale] = rec.params;
    const c = new js.CepstralEnvelope(size);
    const bins = (size >> 1) + 1;
    const env = c.compute(magnitudes(bins, signal, scale), lifter);
    return { out32: env.slice(0, bins) };
  },

  "CepstralEnvelope.reuse"(rec) {
    const [size, lifter, signal, scale, calls] = rec.params;
    const c = new js.CepstralEnvelope(size);
    const bins = (size >> 1) + 1;
    const out = new Float32Array(bins * calls);
    for (let k = 0; k < calls; k++) {
      const env = c.compute(magnitudes(bins, signal, k === 0 ? scale : scale * 0.25), lifter);
      out.set(env.subarray(0, bins), k * bins);
    }
    return { out32: out };
  },
};

function reference(rec) {
  const fn = REF[rec.name];
  if (!fn) throw new Error(`no JS reference for record "${rec.name}"`);
  return fn(rec);
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

ok(
  "every record has a JS reference",
  native.every((r) => r.name in REF),
  [...new Set(native.map((r) => r.name))].join(", "),
);

// The twiddle tables get the tight relative bar of their own, separately from
// the transforms they drive: a twiddle that is off by 1e-7 relative is a libm
// difference worth knowing about even though three stages of butterfly would
// bury it far below -120 dBFS downstream.
function tableChecks(dump, label) {
  console.log(`\n== twiddle tables: ${label} vs fft.js ==`);
  let worst = 0;
  let offender = "";
  let bad = 0;
  for (const rec of dump.filter((r) => r.name === "FFT.tables")) {
    const ref = reference(rec);
    const d = maxRel(ref.out32, rec.out32);
    if (d > worst) (worst = d), (offender = describe(rec));
    // float32 storage, so the bar is float32 eps rather than TOL.coef.
    if (d > 1e-6) {
      bad++;
      console.log(`  FAIL ${describe(rec)} rel=${d.toExponential(2)}`);
    }
    const perm = maxAbs(ref.out64, rec.out64).m;
    if (perm !== 0) {
      bad++;
      console.log(`  FAIL ${describe(rec)} bit-reversal table differs at ${maxAbs(ref.out64, rec.out64).at}`);
    }
  }
  ok(`${label}: twiddles and bit-reversal tables`, bad === 0, `worst rel ${worst.toExponential(2)}${offender ? ` (${offender})` : ""}`);
}

// Every record in this battery is bit-identical today, on glibc and on
// emscripten, so the baseline is the whole battery. Pinning it is what stops a
// sub-tolerance perturbation (a window coefficient nudged in the sixth decimal
// place, say) from passing the -120 dBFS checks unnoticed. If this number has
// to move, say why in the commit.
const IDENTITY_BASELINE = 221;

tableChecks(native, "native");
compareToJs({ name: "native", dump: native, reference, ok, expectIdentical: IDENTITY_BASELINE });

if (wasm) {
  tableChecks(wasm, "wasm");
  compareToJs({ name: "wasm", dump: wasm, reference, ok, expectIdentical: IDENTITY_BASELINE });
  compareToolchains({ native, wasm, ok, expectIdentical: IDENTITY_BASELINE });
}

// ---------------------------------------------------------------------------
// sanity: the battery has to actually exercise the code, and the code has to
// actually be an FFT
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises fft ==");
{
  const names = new Set(native.map((r) => r.name));
  const missing = Object.keys(REF).filter((n) => !names.has(n));
  ok(
    "every ported object appears in the battery",
    missing.length === 0,
    missing.length ? `missing: ${missing}` : `${names.size} distinct record kinds`,
  );

  // -- accept/reject ------------------------------------------------------
  {
    const rec = native.find((r) => r.name === "FFT.accept");
    const asks = [];
    for (let k = 0; k < rec.out64.length; k += 2) asks.push([rec.out64[k], rec.out64[k + 1]]);
    const accepted = asks.filter(([, rc]) => rc === 0);
    const rejected = asks.filter(([, rc]) => rc === 1);
    ok(
      "the size table covers both outcomes",
      accepted.length >= 8 && rejected.length >= 8,
      `${accepted.length} accepted, ${rejected.length} rejected of ${asks.length}`,
    );
    // Every accepted size must be a power of two or the documented zero.
    const odd = accepted.filter(([s]) => s !== 0 && !(s > 0 && (s & (s - 1)) === 0));
    ok("only powers of two (and the documented 0) are accepted", odd.length === 0, odd.map(([s]) => s).join(", ") || "none");
    ok(
      "the FFT(0) quirk is pinned by the battery",
      accepted.some(([s]) => s === 0),
      "both engines accept size 0 and transform is a no-op",
    );
    ok(
      "negative sizes are rejected by both engines",
      asks.filter(([s]) => s < 0).every(([, rc]) => rc === 1),
      `${asks.filter(([s]) => s < 0).length} negative asks`,
    );
  }

  // -- geometry -----------------------------------------------------------
  {
    const metas = native.filter((r) => r.name === "FFT.meta");
    const wrong = metas.filter((r) => {
      const size = r.params[0];
      const expectLevels = size >= 1 ? Math.log2(size) : 0;
      return r.out64[0] !== size || r.out64[1] !== size >> 1 || r.out64[2] !== expectLevels;
    });
    ok("size, half and levels are right at every size", wrong.length === 0, `${metas.length} sizes, ${wrong.length} wrong`);
    ok("the battery goes up to 2048", metas.some((r) => r.params[0] === 2048), `${metas.length} sizes`);
  }

  // -- the bit-reversal table is a permutation and its own inverse --------
  {
    const tables = native.filter((r) => r.name === "FFT.tables");
    const broken = tables.filter((r) => {
      const rev = r.out64;
      const seen = new Set();
      for (let i = 0; i < rev.length; i++) {
        if (!Number.isInteger(rev[i]) || rev[i] < 0 || rev[i] >= rev.length) return true;
        if (seen.has(rev[i])) return true;
        seen.add(rev[i]);
        if (rev[rev[i]] !== i) return true; // bit reversal is an involution
      }
      return false;
    });
    ok("bit reversal is a permutation and its own inverse", broken.length === 0, `${tables.length} tables checked`);
  }

  // -- an impulse must transform to a flat spectrum -----------------------
  {
    const impulses = native.filter(
      (r) => r.name === "FFT.transform" && r.params[2] === 0 && r.params[3] === 4 && r.params[0] >= 2,
    );
    const flat = impulses.filter((r) => {
      const size = r.params[0];
      // delta at n=0 -> every bin exactly 1 + 0i. The twiddles only ever
      // multiply zeros on this path, so "exactly" is the right word.
      for (let k = 0; k < size; k++) {
        if (r.out32[k] !== 1) return false;
        if (r.out32[size + k] !== 0) return false;
      }
      return true;
    });
    ok(
      "an impulse transforms to a flat unit spectrum",
      flat.length === impulses.length && impulses.length > 0,
      `${flat.length}/${impulses.length} cases, forward and inverse`,
    );
  }

  // -- DC is the sum of the input -----------------------------------------
  {
    const real = native.filter((r) => r.name === "FFT.transform" && r.params[3] === 4 && r.params[0] >= 2);
    let worst = 0;
    let offender = "";
    for (const r of real) {
      const [size, , sigRe] = r.params;
      const sig = fillSignal(size, sigRe);
      let sum = 0;
      for (let i = 0; i < size; i++) sum += Math.fround(sig[i]);
      const d = Math.abs(sum - r.out32[0]);
      if (d > worst) (worst = d), (offender = describe(r));
    }
    // float32 accumulation over up to 2048 points and 11 butterfly stages.
    ok("bin 0 equals the sum of the input", worst < 1e-3, `worst ${worst.toExponential(2)}${offender ? ` (${offender})` : ""}`);
  }

  // -- forward then inverse reconstructs ----------------------------------
  {
    const trips = native.filter((r) => r.name === "FFT.roundtrip");
    let worst = 0;
    let offender = "";
    for (const r of trips) {
      const [size, signal] = r.params;
      const sig = fillSignal(size, signal);
      for (let i = 0; i < size; i++) {
        const d = Math.abs(Math.fround(sig[i]) - r.out32[i]);
        if (d > worst) (worst = d), (offender = describe(r));
        const di = Math.abs(r.out32[size + i]);
        if (di > worst) (worst = di), (offender = `${describe(r)} imaginary residue`);
      }
    }
    ok(
      "forward then inverse/N reconstructs the input",
      trips.length > 0 && worst < 1e-5,
      `${trips.length} cases, worst ${worst.toExponential(2)}${offender ? ` (${offender})` : ""}`,
    );
  }

  // -- the transform is not quietly the identity --------------------------
  {
    const noisy = native.filter((r) => r.name === "FFT.transform" && r.params[2] === 2 && r.params[0] >= 16);
    const moved = noisy.filter((r) => {
      const size = r.params[0];
      const sig = fillSignal(size, 2);
      return maxAbs(sig, r.out32.subarray(0, size)).m > 1e-2;
    });
    ok("the transform actually transforms", moved.length === noisy.length && noisy.length > 0, `${moved.length}/${noisy.length} noise cases`);
  }

  // -- the Hann window is the periodic one, with correct COLA -------------
  {
    const hanns = native.filter((r) => r.name === "hannWindow");
    const zeroStart = hanns.every((r) => r.out32[0] === 0);
    ok("the window starts at zero", zeroStart, `${hanns.length} sizes`);

    const peaked = hanns.filter((r) => r.params[0] >= 2 && r.params[0] % 2 === 0);
    // Periodic Hann: w[N/2] == 1 exactly. The symmetric variant peaks between
    // samples instead, which is the classic off-by-one that quietly breaks
    // overlap-add, so pin it.
    const unity = peaked.filter((r) => Math.abs(r.out32[r.params[0] / 2] - 1) < 1e-7);
    ok("it is the periodic Hann, not the symmetric one", unity.length === peaked.length && peaked.length > 0, `${unity.length}/${peaked.length} even sizes peak at exactly N/2`);

    let worstCola = 0;
    let colaCases = 0;
    for (const r of hanns.filter((q) => q.params[0] >= 8 && q.params[0] % 4 === 0)) {
      const N = r.params[0];
      const hop = N / 4;
      colaCases++;
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let m = 0; m < 4; m++) s += r.out32[(i + m * hop) % N];
        const d = Math.abs(s - 2);
        if (d > worstCola) worstCola = d;
      }
    }
    ok(
      "it satisfies amplitude COLA at hop N/4",
      colaCases > 0 && worstCola < 1e-6,
      `${colaCases} sizes, worst deviation from 2.0 is ${worstCola.toExponential(2)}`,
    );
  }

  // -- the cepstral envelope is an envelope -------------------------------
  {
    const ceps = native.filter((r) => r.name === "CepstralEnvelope");

    // Liftering exists to smooth. For the noise spectra, the envelope's
    // log-domain total variation must be far below the spectrum's own, or
    // whatever compute() is doing, it is not enveloping.
    //
    // Only cases that actually *ask* for smoothing count here: keeping a
    // lifter's worth of coefficients only smooths while the lifter is a small
    // fraction of the half-spectrum. Asking for 32 coefficients out of 32 (the
    // size-64 case, where the clamp pins it at half-1 = 31) keeps essentially
    // the whole cepstrum and is supposed to reproduce the spectrum, and the
    // fractional lifter is a no-op by construction. Both get their own checks
    // below rather than being counted as failures to smooth.
    const tv = (a) => {
      let s = 0;
      for (let i = 1; i < a.length; i++) s += Math.abs(Math.log(a[i] + 1e-7) - Math.log(a[i - 1] + 1e-7));
      return s / (a.length - 1);
    };
    const ratio = (r) => {
      const bins = (r.params[0] >> 1) + 1;
      return tv(r.out32) / tv(magnitudes(bins, r.params[2], r.params[3]));
    };
    const smoothCases = ceps.filter(
      (r) => r.params[2] === 2 && Number.isInteger(r.params[1]) && r.params[1] >= 2 && r.params[1] * 4 <= r.params[0] >> 1,
    );
    const smoothed = smoothCases.filter((r) => ratio(r) < 0.5);
    ok(
      "the envelope is smoother than the spectrum it came from",
      smoothed.length === smoothCases.length && smoothCases.length > 0,
      `${smoothed.length}/${smoothCases.length} noise cases, worst ratio ${Math.max(...smoothCases.map(ratio)).toFixed(3)}`,
    );

    // The other side of the same coin: ask for more coefficients than exist,
    // the upper clamp pins the lifter at half-1, and nothing but the highest
    // few cepstral times is discarded — so the envelope comes back about as
    // rough as the spectrum itself rather than smoothed. The band is 25% and
    // not 5% because the clamp still zeroes three coefficients around the
    // cepstral Nyquist, which at these small sizes is a real fraction of the
    // whole (at fftSize 16 it moves the roughness by 15%).
    {
      const wide = ceps.filter((r) => r.params[2] === 2 && r.params[1] === 32 && (r.params[0] >> 1) <= 32);
      const flat = wide.filter((r) => Math.abs(ratio(r) - 1) < 0.25);
      ok(
        "a lifter past the clamp leaves the spectrum essentially unsmoothed",
        flat.length === wide.length && wide.length > 0,
        `${wide.length} cases, roughness ratios ${wide.map((r) => ratio(r).toFixed(2)).join(", ")}`,
      );
    }

    // A silent spectrum lands on the 1e-7 floor inside the log, so the
    // envelope has to come back as 1e-7 and not as 0, NaN or Infinity.
    const silent = ceps.filter((r) => r.params[2] === 4);
    const floored = silent.filter((r) => [...r.out32].every((v) => Math.abs(v - 1e-7) < 1e-9));
    ok("a silent spectrum returns the log floor, not NaN", floored.length === silent.length && silent.length > 0, `${floored.length}/${silent.length} cases`);

    // The documented quirk: a fractional or NaN lifter makes the liftering
    // loop a no-op in the JS (fractional Float32Array indices are dropped; a
    // NaN bound fails the loop condition). Both are carried over, so both must
    // land on the same output, and it must differ from real liftering.
    for (const size of [64, 256]) {
      const at = (pred) => ceps.find((r) => r.params[0] === size && r.params[2] === 2 && r.params[3] === 1 && pred(r.params[1]));
      const frac = at((l) => l === 4.5);
      const nan = at((l) => Number.isNaN(l));
      const real8 = at((l) => l === 8);
      if (frac && nan) {
        ok(
          `size ${size}: fractional and NaN lifters are the same no-op`,
          maxAbs(frac.out32, nan.out32).m === 0,
          "bit-identical",
        );
      }
      if (frac && real8) {
        ok(
          `size ${size}: the no-op lifter differs from real liftering`,
          maxAbs(frac.out32, real8.out32).m > 1e-4,
          `max diff ${maxAbs(frac.out32, real8.out32).m.toExponential(2)}`,
        );
        // And it is a no-op in the strong sense: with nothing zeroed,
        // IFFT -> FFT -> exp is the identity, so the "envelope" is the input
        // magnitude spectrum itself. That is the sharpest statement of the
        // quirk, and it holds only because the loop writes nowhere.
        const bins = (size >> 1) + 1;
        const mag = magnitudes(bins, frac.params[2], frac.params[3]);
        const d = maxRel(mag, frac.out32);
        ok(`size ${size}: the no-op lifter returns the spectrum unchanged`, d < 1e-4, `worst rel ${d.toExponential(2)}`);
      }
    }

    // The lifter clamp: 0, 1 and 2 all clamp to 2, so all three must agree
    // exactly, and 1e9 must equal the case that asks for half-1 directly.
    for (const size of [64, 256, 1024]) {
      const byLifter = (l) => ceps.find((r) => r.params[0] === size && r.params[1] === l && r.params[2] === 2 && r.params[3] === 1);
      const [l0, l1, l2] = [byLifter(0), byLifter(1), byLifter(2)];
      if (l0 && l1 && l2) {
        ok(
          `size ${size}: lifters below 2 clamp to 2`,
          maxAbs(l0.out32, l2.out32).m === 0 && maxAbs(l1.out32, l2.out32).m === 0,
          "bit-identical",
        );
      }
    }
    {
      const size = 1024;
      const huge = ceps.find((r) => r.params[0] === size && r.params[1] === 1e9 && r.params[2] === 2);
      const atClamp = ceps.find((r) => r.params[0] === size && r.params[1] === 511 && r.params[2] === 2);
      if (huge && atClamp) {
        ok("a huge lifter clamps to half-1", maxAbs(huge.out32, atClamp.out32).m === 0, "bit-identical to lifter 511 at size 1024");
      }
    }

    // Reuse: the first call on a reused object has to match the standalone
    // case with the same parameters, or compute() is leaving state behind.
    for (const rec of native.filter((r) => r.name === "CepstralEnvelope.reuse")) {
      const [size, lifter, signal, scale] = rec.params;
      const bins = (size >> 1) + 1;
      const standalone = ceps.find(
        (r) => r.params[0] === size && r.params[1] === lifter && r.params[2] === signal && r.params[3] === scale,
      );
      if (standalone) {
        ok(
          `size ${size}: a reused object's first call matches a fresh one`,
          maxAbs(rec.out32.subarray(0, bins), standalone.out32).m === 0,
          "bit-identical",
        );
      }
      ok(
        `size ${size}: the second call responds to its own input`,
        maxAbs(rec.out32.subarray(0, bins), rec.out32.subarray(bins, bins * 2)).m > 1e-4,
        "the two calls differ",
      );
    }
  }

  // -- nothing ran away ---------------------------------------------------
  {
    let widest = 0;
    let widestName = "";
    let nonFinite = 0;
    for (const rec of native) {
      for (const v of [...rec.out64, ...rec.out32]) {
        const a = Math.abs(v);
        if (!Number.isFinite(v)) nonFinite++;
        else if (a > widest) (widest = a), (widestName = describe(rec));
      }
    }
    // The widest legitimate value is the DC bin of the step signal at 2048
    // points (~512), and the bit-reversal tables run to 2047.
    ok("nothing ran away", widest < 1e4, `widest ${widest.toExponential(2)} (${widestName})`);
    ok("no NaN or Infinity anywhere in the dump", nonFinite === 0, `${nonFinite} non-finite values`);
  }
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\nfft parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
