/** Bro.Kodr spectral (PitchFormant) C99 parity oracle. One opcode battery is
 * replayed through shipping JS, native C and emscripten. The jitter/shimmer
 * xorshift32 is the JS's own seeded generator, so no randomness is replaced.
 * No changes to the shipping DSP. MSVC unmeasured; identity is empirical.
 */
import { readFileSync } from "node:fs";
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
  name: "parity-spectral",
  include: join(root, "packages/native/include"),
  sources: ["utils", "fft", "spectral"]
    .map((n) => join(root, `packages/native/src/dsp/${n}.c`))
    .concat(join(root, "packages/native/tests/parity-spectral.c")),
  ok,
  state,
});
const shipping = await import("../packages/web/public/dsp/effects/spectral.js");
const KEYS = ["pitch", "fine", "formant", "preserve", "lifter", "quality", "jitter", "shimmer"];
const OP = {
  END: 0,
  INIT: 1,
  PARAM: 2,
  PROCESS: 3,
  RESET: 4,
  SNAP: 5,
  POKE: 6,
  REWIND: 7,
  GAIN: 8,
  DC: 9,
  MONO: 10,
};
const OPW = 5,
  SIG_N = 65536,
  SIG_DC = 5,
  MAX_POKES = 32;
const SIGS = [0, 1, 2, 3, 4].map((s) => Float32Array.from(fillSignal(SIG_N, s)));
const SENTINEL = new Map([
  [-3e9, NaN],
  [3e9, Infinity],
  [-4e9, -Infinity],
]);
const unsentinel = (v) => (SENTINEL.has(v) ? SENTINEL.get(v) : v);
const smootherState = (s, out) => out.push(s.value, s.target, s.a);
function blockState(e, out) {
  // latencySamples as the chain reads it (`if (fx.latencySamples)`): undefined is 0.
  out.push(e.meter, e.latencySamples || 0, e.fftSize);
  out.push(e.pitchSt, e.fineCents, e.formantSt, e.preserve, e.lifter);
  smootherState(e.pitchSm, out);
  smootherState(e.formantSm, out);
  out.push(e.jitter, e.shimmer, e.rng, e.jitWalk, e.shimWalk);
  smootherState(e.jitSm, out);
  smootherState(e.shimSm, out);
  for (const c of e.ch) out.push(c.n, c.half, c.hop, c.freqPerBin, c.expct, c.rw);
}
function snapState(e, out, o32) {
  blockState(e, out);
  for (const c of e.ch) {
    for (const a of [
      c.fft.cos,
      c.fft.sin,
      c.fft.rev,
      c.window,
      c.inFifo,
      c.outFifo,
      c.outAccum,
      c.re,
      c.im,
      c.lastPhase,
      c.sumPhase,
      c.anaMagn,
      c.anaFreq,
      c.synMagn,
      c.synFreq,
      c.excite,
      c.envShift,
      c.cep.re,
      c.cep.im,
      c.cep.env,
    ])
      for (const v of a) o32.push(v);
  }
}
function replay(mod, ops) {
  const out = [];
  const o32 = [];
  let e;
  const init = (sr) => {
    e = new mod.PitchFormant(sr, 128);
    // vtable: no carrier bus, a latency, a meter.
    out.push(1, 0, 0);
  };
  init(48000);
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
    else if (op === OP.INIT) init(b);
    else if (op === OP.PARAM) e.setParam(KEYS[a] ?? `unknown:${a}`, b);
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
        cursor = (cursor + Math.max(bs, 0)) % SIG_N;
        for (const [ch, at, v] of pokes) if (at < bs) (ch ? vR : vL)[at] = v;
        pokes = [];
        e.process(vL, vR, bs);
        blockState(e, out);
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
        cursor = (cursor + Math.max(bs, 0)) % SIG_N;
        for (const [, at, v] of pokes) if (at < bs) vL[at] = v;
        pokes = [];
        e.process(vL, vL, bs);
        blockState(e, out);
        for (let j = 0; j < bs; j++) o32.push(vL[j]);
      }
    } else if (op === OP.RESET) e.reset();
    else if (op === OP.SNAP) snapState(e, out, o32);
    else if (op === OP.POKE) {
      if (pokes.length < MAX_POKES) pokes.push([a | 0, b | 0, c]);
    } else if (op === OP.REWIND) cursor = 0;
    else if (op === OP.GAIN) gain = a;
    else if (op === OP.DC) dc = a;
  }
  snapState(e, out, o32);
  return { out64: Float64Array.from(out), out32: Float32Array.from(o32) };
}

const refs = new Map(native.map((r) => [r.name, replay(shipping, r.params)]));
const reference = (r) => refs.get(r.name);
// Empirical glibc/emscripten/V8 pins measured 2026-10-06, MSVC unmeasured:
// every record, out64 and out32, signed zeros included, on all three comparisons.
const IDENTITY_NATIVE = 47,
  IDENTITY_WASM = 47,
  IDENTITY_CROSS = 47;
compareToJs({ name: "native", dump: native, reference, ok, expectIdentical: IDENTITY_NATIVE });
if (wasm) {
  compareToJs({ name: "wasm", dump: wasm, reference, ok, expectIdentical: IDENTITY_WASM });
  compareToolchains({ native, wasm, ok, expectIdentical: IDENTITY_CROSS });
}
const same = (a, b) => a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
for (const [label, dump, other, pin] of [
  ["native/JS", native, reference, IDENTITY_NATIVE],
  ...(wasm
    ? [
        ["wasm/JS", wasm, reference, IDENTITY_WASM],
        ["native/wasm", native, (_, i) => wasm[i], IDENTITY_CROSS],
      ]
    : []),
]) {
  const exact = dump.filter((r, i) => {
    const a = other(r, i);
    return same(a.out64, r.out64) && same(a.out32, r.out32);
  }).length;
  ok(`${label}: signed-zero identity pinned`, exact === pin, `${exact}/${dump.length}; pin ${pin}`);
  if (process.env.LIST_DRIFT)
    console.log(
      label +
        " drift: " +
        dump
          .filter((r, i) => {
            const a = other(r, i);
            return !same(a.out64, r.out64) || !same(a.out32, r.out32);
          })
          .map((r) => r.name)
          .join(" "),
    );
}
const cSrc = readFileSync(join(root, "packages/native/tests/parity-spectral.c"), "utf8");
for (const [key, val] of Object.entries(OP)) {
  const m = cSrc.match(new RegExp(`OP_${key}\\s*=\\s*(\\d+)`));
  ok(`opcode ${key} mirrors C`, m !== null && Number(m[1]) === val);
}
for (const [key, val] of [
  ["OPW", OPW],
  ["SIG_N", SIG_N],
  ["SIG_DC", SIG_DC],
  ["MAX_POKES", MAX_POKES],
]) {
  const m = cSrc.match(new RegExp(`#define ${key} (\\d+)`));
  ok(`${key} mirrors C`, m !== null && Number(m[1]) === val);
}
ok(
  "C payload overflow stops rather than truncating",
  /payload overflow[\s\S]{0,40}exit\(3\)/.test(cSrc),
);
ok(
  "C struct canary checked after init and every block",
  cSrc.includes("write past the bk_pitch_formant struct") &&
    (cSrc.match(/check_canary\(\);/g) || []).length === 3,
);
ok(
  "C input stimulus matches JS mirror",
  cSrc.includes("g_l[j] = (float)(g_gain * sig_at(sl, at));") &&
    cSrc.includes("g_r[j] = (float)(g_gain * (-0.5 * sig_at(sr, at)));"),
);
ok(
  "negative blocks do not rewind the stimulus cursor",
  cSrc.includes("g_cursor = (g_cursor + (bs > 0 ? bs : 0)) % SIG_N;"),
);
const N_SCRIPTS = 47;
ok(
  `all ${N_SCRIPTS} scripts emitted`,
  native.length === N_SCRIPTS && (cSrc.match(/\bS\(pf_\w+\)/g) || []).length === N_SCRIPTS,
);
// Independent hand counts; don't derive them from snapState(). Per block: 37
// scalars. Per snapshot and channel: 11 n-length and 9 (n/2+1)-length arrays,
// where a NaN quality leaves n = 0 with one-element bin arrays.
const STATE64 = 37;
for (const rec of native) {
  let n = 1024,
    n64 = 3,
    n32 = 0;
  const snapshot = () => {
    n64 += STATE64;
    n32 += 2 * (11 * n + 9 * ((n >> 1) + 1));
  };
  for (let i = 0; i + OPW <= rec.params.length; i += OPW) {
    const [op, a, b] = rec.params.slice(i, i + 3);
    if (op === OP.END) break;
    if (op === OP.INIT) {
      n = 1024;
      n64 += 3;
    } else if (op === OP.PARAM && a === 5) {
      const v = unsentinel(b);
      n = Number.isNaN(v) ? 0 : 512 << Math.min(3, Math.max(0, Math.round(v)));
    } else if (op === OP.SNAP) snapshot();
    else if (op === OP.PROCESS || op === OP.MONO) {
      for (let k = 0; k < a; k++) {
        n64 += STATE64;
        n32 += Math.max(0, b) * (op === OP.MONO ? 1 : 2);
      }
    }
  }
  snapshot();
  ok(
    `${rec.name}: independent state/audio payload lengths`,
    rec.out64.length === n64 && rec.out32.length === n32,
    `${rec.out64.length}/${n64}, ${rec.out32.length}/${n32}`,
  );
}
const schema = await import("../packages/web/src/web/audio/param-schema.ts");
const h = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
const fromH = [...h.matchAll(/BK_P_PITCH_([A-Z0-9_]+) = (\d+)/g)]
  .filter((m) => m[1] !== "COUNT")
  .sort((a, b) => Number(a[2]) - Number(b[2]))
  .map((m) => m[1].toLowerCase());
ok("pitch: keys match C header", fromH.join() === KEYS.join());
ok(
  "pitch: keys match schema",
  schema.EFFECTS.pitch.params.map((p) => p.key).join() === KEYS.join(),
);
ok("pitch: shipping class id", shipping.PitchFormant.id === "pitch");
ok(
  "pitch: quality key constant",
  /#define BK_P_PITCH_QUALITY_KEY 5\b/.test(h) && KEYS[5] === "quality",
);
console.log(
  `\n${state.checks} checks, ${state.failures} failed\nspectral parity: ${state.failures === 0 ? "PASS" : "FAIL"}`,
);
process.exit(state.failures === 0 ? 0 : 1);
