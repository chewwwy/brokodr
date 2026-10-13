#!/usr/bin/env node
/**
 * Run every DSP parity battery against one native toolchain and sort the failures.
 *
 *   BK_NATIVE_TOOLCHAIN=mingw node scripts/parity-toolchain.mjs   (Wine, here)
 *   BK_NATIVE_TOOLCHAIN=msvc  node scripts/parity-toolchain.mjs   (Windows CI)
 *
 * Each battery's own checks run unchanged; this only classifies them:
 *
 *   tolerance   any failed check that is not one of the two kinds below. This is the
 *               real signal. The script exits 1 if there is one that is not listed in
 *               KNOWN for this toolchain, and also if a KNOWN entry stops failing, so
 *               the list cannot go stale in either direction.
 *   identity    a bit-identity count or pin. Those are measured on the host toolchain
 *               (glibc / emscripten / V8), so a foreign libm may legitimately miss them.
 *               They are reported as counts, not failed.
 *   skipped     the wasm half, when emscripten is not installed (the CI runner).
 *
 * The identity counts printed here are the measurement this script exists for: the
 * first numbers for how far a Windows libm sits from the one the pins were taken on.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolchain = process.env.BK_NATIVE_TOOLCHAIN || "host";

// Tolerance failures already measured and explained for a toolchain. Keyed by
// battery, matched by substring against the FAIL line.
const KNOWN = {
  mingw: {
    // mingw-w64's cos(fl(pi/2)) is 6.1230317691e-17 vs the correct 6.1232339957e-17
    // (glibc, V8): 3.3e-5 relative, 2e-21 absolute. The twiddle bar is relative on
    // purpose, to surface exactly this kind of libm difference.
    fft: ["FFT.tables(", "twiddles and bit-reversal tables"],
    // pf_pitch_huge: +1000 semitones, ratio ~1.2e25, so the phase vocoder takes sin/cos
    // of enormous arguments; mingw-w64's trig does not reduce them correctly (0.975 vs
    // -0.991 at one sample). pf_quality: ulp-level drift in internal state that follows
    // from the twiddle difference, up to 3e-5 absolute on values of magnitude ~256-24000.
    spectral: [
      "pf_quality(",
      "pf_pitch_huge(",
      "every case within tolerance",
      "float32 path",
      "native and wasm agree within tolerance",
    ],
  },
};

const isIdentity = (line) => /identi|bit-identical/i.test(line);
const isSkipped = (line) => /wasm (build|producer|toolchain)|emcc missing/.test(line);

const batteries = readdirSync(join(root, "scripts"))
  .filter((f) => /^verify-.*-parity\.mjs$/.test(f))
  .sort();

console.log(`== parity batteries on native toolchain: ${toolchain} ==\n`);
let unexpected = 0;
let stale = 0;
const rows = [];
for (const f of batteries) {
  const name = f.replace(/^verify-/, "").replace(/-parity\.mjs$/, "");
  const r = spawnSync(process.execPath, [join(root, "scripts", f)], {
    cwd: root,
    env: { ...process.env, BK_NATIVE_TOOLCHAIN: toolchain },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const fails = out.split("\n").filter((l) => l.startsWith("  FAIL "));
  const tol = fails.filter((l) => !isIdentity(l) && !isSkipped(l));
  const ident = fails.filter(isIdentity);
  const known = (KNOWN[toolchain] || {})[name] || [];
  const unexplained = tol.filter((l) => !known.some((k) => l.includes(k)));
  const unseen = known.filter((k) => !tol.some((l) => l.includes(k)));
  const crashed = r.status !== 0 && fails.length === 0;
  const idCount = (out.match(/native: bit-identity baseline — (\d+\/\d+)/) || [])[1] || "";
  unexpected += unexplained.length + (crashed ? 1 : 0);
  stale += unseen.length;
  rows.push({ name, tol: tol.length, ident: ident.length, idCount, unexplained, unseen, crashed });
  const tag = crashed ? "CRASH" : unexplained.length ? "FAIL" : unseen.length ? "STALE" : "ok";
  console.log(
    `  ${tag.padEnd(5)} ${name.padEnd(14)} tolerance ${String(tol.length).padStart(2)} (known ${known.length ? tol.length - unexplained.length : 0})` +
      `  identity misses ${String(ident.length).padStart(2)}${idCount ? `  native/JS identical ${idCount}` : ""}`,
  );
  for (const l of unexplained) console.log(`        unexplained: ${l.trim().slice(0, 220)}`);
  for (const k of unseen) console.log(`        known failure no longer seen (update KNOWN): ${k}`);
  if (crashed) {
    // The tail of a crash is usually a Node stack trace whose last lines say nothing; show
    // enough of it to read the actual error (a failed compile prints the compiler's own).
    console.log(`        exit ${r.status}${r.signal ? ` (${r.signal})` : ""}${r.error ? ` (${r.error.message})` : ""}:`);
    for (const l of out.trimEnd().split("\n").slice(-40)) console.log(`        | ${l.slice(0, 300)}`);
  }
}

const clean = rows.filter((r) => r.tol === 0 && r.ident === 0).length;
console.log(
  `\n${rows.length} batteries: ${clean} clean, ${rows.filter((r) => r.ident > 0).length} with identity misses only or as well, ` +
    `${unexpected} unexplained tolerance failure(s), ${stale} stale known entr${stale === 1 ? "y" : "ies"}`,
);
console.log(unexpected === 0 && stale === 0 ? `toolchain ${toolchain}: PASS` : `toolchain ${toolchain}: FAIL`);
process.exit(unexpected === 0 && stale === 0 ? 0 : 1);
