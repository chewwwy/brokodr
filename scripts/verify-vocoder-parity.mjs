/** Bro.Kodr Vocoder C99 parity oracle. One opcode battery is replayed through
 * shipping JS, native C and emscripten. No changes to the shipping DSP.
 * Math.random: replaced, during process() only, by a mirror of the battery's
 * xorshift (SEED a > 0, and the default after every INIT) or of the effect's
 * internal generator (SEED 0), and counted. MSVC unmeasured; identity is
 * empirical.
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
  name: "parity-vocoder",
  include: join(root, "packages/native/include"),
  sources: ["utils", "biquad", "vocoder"]
    .map((n) => join(root, `packages/native/src/dsp/${n}.c`))
    .concat(join(root, "packages/native/tests/parity-vocoder.c")),
  ok,
  state,
});
const shipping = await import("../packages/web/public/dsp/effects/vocoder.js");
const KEYS = [
  "bands",
  "carrier",
  "pitch",
  "follow",
  "freqlo",
  "freqhi",
  "q",
  "depth",
  "tone",
  "sibilance",
  "attack",
  "release",
  "carrierlevel",
  "spread",
  "output",
  "source",
];
const Vocoder = shipping.Vocoder;
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
  BUS: 11,
  SEED: 12,
};
const OPW = 5,
  SIG_N = 65536,
  SIG_DC = 5,
  SIG_VOICE = 6,
  BUS_OFFSET = 7777,
  MAX_POKES = 32,
  MAX_BANDS = 32,
  TEST_SEED = 0x2545f491,
  INTERNAL_SEED = 0x6a09e667;
// Gated two-period buzz, one correctly rounded operation per statement as in C.
const voice = new Float32Array(SIG_N);
for (let j = 0; j < SIG_N; j++) {
  const p1 = (j % 53) / 53 - 0.5;
  const p2 = (j % 37) / 37 - 0.5;
  const v1 = p1 * 0.6;
  const v2 = p2 * 0.2;
  const v = v1 + v2;
  voice[j] = j % 6000 < 4000 ? v : 0;
}
const SIGS = [0, 1, 2, 3, 4].map((s) => Float32Array.from(fillSignal(SIG_N, s)));
SIGS[SIG_VOICE] = voice;
const SENTINEL = new Map([
  [-3e9, NaN],
  [3e9, Infinity],
  [-4e9, -Infinity],
]);
const unsentinel = (v) => (SENTINEL.has(v) ? SENTINEL.get(v) : v);
const xorshift = (x) => {
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  return (x ^ (x << 5)) >>> 0;
};
function makeRng() {
  const g = { mode: "test", seed: TEST_SEED, internal: INTERNAL_SEED, draws: 0 };
  g.random = () => {
    g.draws++;
    if (g.mode === "test") {
      g.seed = xorshift(g.seed);
      return g.seed / 4294967296;
    }
    g.internal = xorshift(g.internal);
    return (((g.internal >>> 8) / 16777216) * 2 - 1 + 1) * 0.5;
  };
  return g;
}
const smootherState = (s, out) => out.push(s.value, s.target, s.a);
const biquadState = (f, out) =>
  out.push(f.b0, f.b1, f.b2, f.a1, f.a2, f.z1, f.z2, f.type, f.freq, f.q, f.gainDb);
const envState = (e, out) => out.push(e.env, e.ca, e.cr, e.rms ? 1 : 0);
const oscState = (o, out) => out.push(o.phase, o.inc, o.pw);
function blockState(e, rng, out) {
  const t = e.tracker;
  out.push(e.meter);
  out.push(e.sr, e.maxBlock, e.bandCount, e.freqLo);
  out.push(e.freqHi, e.qFactor, e.carrierType, e.carrierPitchHz);
  out.push(e.pitchFollow, e.depth, e.tone, e.sibilance);
  out.push(e.attackMs, e.releaseMs, e.carrierLevel, e.stereoSpread);
  out.push(e.source, e.carRms, e.carRmsA, e.trackedHz);
  out.push(e.dirty ? 1 : 0, e.carBusL !== null ? 1 : 0, rng.draws);
  oscState(e.osc1, out);
  oscState(e.osc2, out);
  oscState(e.oscSub, out);
  out.push(t.decim, t.dsr, t.minLag, t.maxLag, t.size, t.w, t.decimCount, t.acc, t.freq, t.confidence);
  for (const s of [e.pitchSm, e.depthSm, e.outSm]) smootherState(s, out);
  biquadState(e.sibHp, out);
  envState(e.sibEnv, out);
  envState(e.inEnv, out);
  for (const b of e.bands) {
    out.push(b.modA.z1, b.modA.z2, b.modB.z1, b.modB.z2);
    out.push(b.carA.z1, b.carA.z2, b.carB.z1, b.carB.z2);
    out.push(b.env.env, b.level);
  }
}
function snapState(e, rng, out, o32) {
  blockState(e, rng, out);
  for (const b of e.bands) {
    for (const f of [b.modA, b.modB, b.carA, b.carB]) biquadState(f, out);
    envState(b.env, out);
    out.push(b.freq, b.gain, b.pan);
  }
  for (const v of e.tracker.buf) o32.push(v);
  const vis = e.visual;
  out.push(vis.length);
  for (const v of vis) o32.push(v);
}
function replay(ops) {
  const out = [];
  const o32 = [];
  const rng = makeRng();
  let e;
  let bus = false;
  let busL = 0,
    busR = 0,
    busGain = 1;
  const init = (sr, mb) => {
    e = new Vocoder(sr, mb);
    bus = false;
    rng.mode = "test";
    rng.seed = TEST_SEED;
    rng.internal = INTERNAL_SEED;
    // vtable: a carrier bus hook, no latency, a meter.
    out.push(0, 1, 0);
  };
  const saved = Math.random;
  const run = (L, R, n) => {
    Math.random = rng.random;
    try {
      e.process(L, R, n);
    } finally {
      Math.random = saved;
    }
  };
  init(48000, 128);
  let cursor = 0;
  let gain = 1;
  let dc = 0;
  let pokes = [];
  const sig = (s, at) => (s === SIG_DC ? dc : SIGS[s][at]);
  const L = new Float32Array(4096);
  const R = new Float32Array(4096);
  const CL = new Float32Array(4096);
  const CR = new Float32Array(4096);
  const fillBus = (bs) => {
    for (let j = 0; j < bs; j++) {
      const at = (cursor + j + BUS_OFFSET) % SIG_N;
      CL[j] = busGain * sig(busL, at);
      CR[j] = busGain * sig(busR, at);
    }
  };
  for (let i = 0; i + OPW <= ops.length; i += OPW) {
    const op = ops[i] | 0;
    const a = unsentinel(ops[i + 1]);
    const b = unsentinel(ops[i + 2]);
    const c = unsentinel(ops[i + 3]);
    const d = unsentinel(ops[i + 4]);
    if (op === OP.END) break;
    else if (op === OP.INIT) init(a, b | 0);
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
        if (bus) fillBus(bs);
        cursor = (cursor + Math.max(bs, 0)) % SIG_N;
        for (const [ch, at, v] of pokes) if (at < bs) (ch ? vR : vL)[at] = v;
        pokes = [];
        run(vL, vR, bs);
        blockState(e, rng, out);
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
        if (bus) fillBus(bs);
        cursor = (cursor + Math.max(bs, 0)) % SIG_N;
        for (const [, at, v] of pokes) if (at < bs) vL[at] = v;
        pokes = [];
        run(vL, vL, bs);
        blockState(e, rng, out);
        for (let j = 0; j < bs; j++) o32.push(vL[j]);
      }
    } else if (op === OP.RESET) e.reset();
    else if (op === OP.SNAP) snapState(e, rng, out, o32);
    else if (op === OP.POKE) {
      if (pokes.length < MAX_POKES) pokes.push([a | 0, b | 0, c]);
    } else if (op === OP.REWIND) cursor = 0;
    else if (op === OP.GAIN) gain = a;
    else if (op === OP.DC) dc = a;
    else if (op === OP.BUS) {
      bus = true;
      busL = a | 0;
      busR = b | 0;
      busGain = c;
      e.setCarrierBus(CL, CR);
    } else if (op === OP.SEED) {
      if (a > 0) {
        rng.mode = "test";
        rng.seed = a >>> 0;
      } else rng.mode = "internal";
    }
  }
  snapState(e, rng, out, o32);
  return { out64: Float64Array.from(out), out32: Float32Array.from(o32) };
}

const STATE64 = 71 + MAX_BANDS * 10;
const SNAP64 = STATE64 + MAX_BANDS * 51 + 1;
/** Debug aid: name the block-state field an out64 index lands on. */
function where64(rec, k) {
  let at = 3;
  let n = 0;
  const inBlock = (base, what) => {
    const f = k - base;
    if (f < 0 || f >= STATE64) return null;
    return f < 71 ? `${what} field ${f}` : `${what} band ${Math.floor((f - 71) / 10)} slot ${(f - 71) % 10}`;
  };
  for (let i = 0; i + OPW <= rec.params.length; i += OPW) {
    const [op, a] = rec.params.slice(i, i + 2);
    if (op === OP.END) break;
    if (op === OP.INIT) {
      if (k < at + 3) return "vt flags";
      at += 3;
    } else if (op === OP.SNAP) {
      const hit = inBlock(at, "snap");
      if (hit) return hit;
      if (k < at + SNAP64) return `snap settings +${k - at - STATE64}`;
      at += SNAP64;
    } else if (op === OP.PROCESS || op === OP.MONO) {
      for (let j = 0; j < a; j++, n++) {
        const hit = inBlock(at, `block ${n}`);
        if (hit) return hit;
        at += STATE64;
      }
    }
  }
  return inBlock(at, "final snap") ?? `final snap settings +${k - at - STATE64}`;
}
const refs = new Map(native.map((r) => [r.name, replay(r.params)]));
const reference = (r) => refs.get(r.name);
// Empirical glibc/emscripten/V8 pins measured 2026-10-06 (vocoder), MSVC
// unmeasured: every record, out64 and out32, signed zeros included.
//  - native/JS: only v_range_ulp and v_rates_ulp drift, by construction. The
//    first difference in each is a band's modA.z1 in block 0, and the band
//    coefficients were re-evaluated outside the battery: the band centre
//    frequencies (log2, pow) agree bit for bit, and so do w0, but glibc and V8
//    are one ulp apart on sin(w0) for band 9 at freqlo 40 (and 20, and -inf,
//    which clamp to it) and on cos(w0) for bands 11 and 15 at 3000-4000 Hz,
//    band 13 at 96 kHz and band 14 at 4500.3 Hz. Other scripts avoid those
//    settings (v_range uses freqlo 130 under the 0.45 sr cap and 700 rather
//    than 1000, which split at bands 9/11 and 1/14), and v_combo uses a 1.5 ms
//    attack because 1 ms at 48 kHz is exp(-1/48), the known one-ulp exp split.
//  - wasm also drifts on v_rates (44.1 kHz) and mixed_inits (8 kHz), each first
//    at a band's modA.z1: emscripten's libm differs from both glibc and V8
//    there. Attributed by elimination, not re-evaluated.
const IDENTITY_NATIVE = 42,
  IDENTITY_WASM = 40,
  IDENTITY_CROSS = 40;
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
  if (process.env.LIST_DRIFT === "2")
    dump.forEach((r, i) => {
      const a = other(r, i);
      const k = r.out64.findIndex((v, j) => !Object.is(v, a.out64[j]));
      if (k >= 0)
        console.log(
          `  ${r.name} out64[${k}] (${where64(r, k)}) of ${r.out64.length}: ${r.out64[k]} vs ${a.out64[k]}`,
        );
      const k32 = r.out32.findIndex((v, j) => !Object.is(v, a.out32[j]));
      if (k32 >= 0) console.log(`  ${r.name} out32[${k32}] of ${r.out32.length}: ${r.out32[k32]} vs ${a.out32[k32]}`);
    });
}
const cSrc = readFileSync(join(root, "packages/native/tests/parity-vocoder.c"), "utf8");
const implSrc = readFileSync(join(root, "packages/native/src/dsp/vocoder.c"), "utf8");
for (const [key, val] of Object.entries(OP)) {
  const m = cSrc.match(new RegExp(`OP_${key}\\s*=\\s*(\\d+)`));
  ok(`opcode ${key} mirrors C`, m !== null && Number(m[1]) === val);
}
for (const [key, val] of [
  ["OPW", OPW],
  ["SIG_N", SIG_N],
  ["SIG_DC", SIG_DC],
  ["SIG_VOICE", SIG_VOICE],
  ["BUS_OFFSET", BUS_OFFSET],
  ["MAX_POKES", MAX_POKES],
]) {
  const m = cSrc.match(new RegExp(`#define ${key} (\\d+)`));
  ok(`${key} mirrors C`, m !== null && Number(m[1]) === val);
}
for (const [n, v] of [
  ["NAN_", -3e9],
  ["INF_", 3e9],
  ["NINF_", -4e9],
]) {
  const m = cSrc.match(new RegExp(`#define ${n} \\((-?[\\de]+)\\)`));
  ok(`sentinel ${n} mirrors C`, m !== null && Number(m[1]) === v);
}
const hSrc = readFileSync(join(root, "packages/native/include/brokodr/dsp/vocoder.h"), "utf8");
ok("MAX_BANDS mirrors C", new RegExp(`#define BK_VOCODER_MAX_BANDS ${MAX_BANDS}\\b`).test(hSrc));
ok("MAX_BANDS mirrors the JS", /const MAX_BANDS = 32;/.test(readFileSync(join(root, "packages/web/public/dsp/effects/vocoder.js"), "utf8")));
ok(
  "C payload overflow stops rather than truncating",
  /payload overflow[\s\S]{0,40}exit\(3\)/.test(cSrc),
);
ok(
  "C struct canary checked after init and every block",
  cSrc.includes("write past the effect struct") && (cSrc.match(/check_canary\(\);/g) || []).length === 3,
);
ok(
  "C input stimulus matches JS mirror",
  cSrc.includes("g_l[j] = (float)(g_gain * sig_at(sl, at));") &&
    cSrc.includes("g_r[j] = (float)(g_gain * (-0.5 * sig_at(sr, at)));") &&
    cSrc.includes("const int at = (g_cursor + j + BUS_OFFSET) % SIG_N;") &&
    cSrc.includes("g_cl[j] = (float)(g_bus_gain * sig_at(g_bus_l, at));") &&
    cSrc.includes("g_cr[j] = (float)(g_bus_gain * sig_at(g_bus_r, at));"),
);
ok(
  "C voice stimulus matches JS mirror",
  cSrc.includes("const double p1 = (double)(j % 53) / 53.0 - 0.5;") &&
    cSrc.includes("const double p2 = (double)(j % 37) / 37.0 - 0.5;") &&
    cSrc.includes("const double v1 = p1 * 0.6;") &&
    cSrc.includes("const double v2 = p2 * 0.2;") &&
    cSrc.includes("dst[j] = (float)((j % 6000) < 4000 ? v : 0.0);") &&
    cSrc.includes("fill_voice(g_sig[SIG_VOICE]);"),
);
ok(
  "bus is filled before the cursor advances, in both block ops",
  (cSrc.match(/if \(g_bus\) fill_bus\(bs\);\n\s*g_cursor = \(g_cursor \+ \(bs > 0 \? bs : 0\)\) % SIG_N;/g) || [])
    .length === 2,
);
ok(
  "negative blocks do not rewind the stimulus cursor",
  cSrc.includes("g_cursor = (g_cursor + (bs > 0 ? bs : 0)) % SIG_N;"),
);
ok(
  "the Math.random mirror matches the C",
  /unsigned int x = \*seed;\s*x \^= x << 13;\s*x \^= x >> 17;\s*x \^= x << 5;\s*\*seed = x;\s*g_draws \+= 1\.0;\s*return \(double\)x \/ 4294967296\.0;/.test(
    cSrc,
  ) &&
    new RegExp(`g_seed = 0x${TEST_SEED.toString(16)}u;`).test(cSrc.match(/static void init_fx[\s\S]*?\n\}/)[0]) &&
    (cSrc.match(/g_seed = 0x/g) || []).length === 1,
);
ok(
  "the internal generator is (bk_rng_bipolar + 1) * 0.5, seeded as mirrored",
  implSrc.includes("return (bk_rng_bipolar((unsigned int *)user) + 1.0) * 0.5;") &&
    new RegExp(`bk_rng_seed\\(&e->rng, 0x${INTERNAL_SEED.toString(16)}u\\);`).test(implSrc),
);
{
  const utilsC = readFileSync(join(root, "packages/native/src/dsp/utils.c"), "utf8");
  ok(
    "the internal-generator mirror matches bk_rng_bipolar",
    /x \^= x << 13;\s*x \^= x >> 17;\s*x \^= x << 5;\s*\*state = x;\s*return \(\(double\)\(x >> 8\) \/ 16777216\.0\) \* 2\.0 - 1\.0;/.test(
      utilsC,
    ) && /\*state = seed \? seed : 0x1u;/.test(utilsC),
  );
}
ok(
  "SEED 0 counts the internal generator it delegates to",
  /bk_vocoder_set_random\(g_fx, NULL, NULL\);\s*g_internal_fn = g_fx->random;\s*g_fx->random = counted_internal;/.test(cSrc),
);
const N_SCRIPTS = 44;
ok(
  `all ${N_SCRIPTS} scripts emitted`,
  native.length === N_SCRIPTS && (cSrc.match(/\bS\((?:v|mixed)_\w+\)/g) || []).length === N_SCRIPTS,
);
// Independent hand counts from the JS constructor formulas, not from the
// objects: 71 scalars + 10 per band per block; a snapshot adds 51 settings per
// band, the visual count, the tracker buffer and the active bands' ladder.
const trackerSize = (sr) => 2 * Math.floor(sr / Math.max(1, Math.floor(sr / 12000)) / 60);
const bandsOf = (v) => {
  const r = Math.round(v);
  return Number.isNaN(r) ? 0 : Math.min(32, Math.max(4, r));
};
for (const rec of native) {
  let sr = 48000,
    nb = 16,
    n64 = 3,
    n32 = 0;
  const snapshot = () => {
    n64 += SNAP64;
    n32 += trackerSize(sr) + nb;
  };
  for (let i = 0; i + OPW <= rec.params.length; i += OPW) {
    const [op, a, b] = rec.params.slice(i, i + 3);
    if (op === OP.END) break;
    if (op === OP.INIT) {
      sr = a;
      nb = 16;
      n64 += 3;
    } else if (op === OP.PARAM && a === 0) nb = bandsOf(unsentinel(b));
    else if (op === OP.SNAP) snapshot();
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
{
  // Draw counts, read from the C dump: the final snapshot's draws field.
  const finalDraws = (name) => {
    const r = native.find((x) => x.name === name);
    return r.out64[r.out64.length - SNAP64 + 23];
  };
  ok("v_default: one sibilance draw per frame", finalDraws("v_default") === 7680 + 3840, `${finalDraws("v_default")}`);
  ok("v_seed: noise carrier draws twice per frame, internal draws counted", finalDraws("v_seed") === 3 * 12 * 128 * 2, `${finalDraws("v_seed")}`);
}
const schema = await import("../packages/web/src/web/audio/param-schema.ts");
const h = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
const fromH = [...h.matchAll(/BK_P_VOCODER_([A-Z0-9_]+) = (\d+)/g)]
  .filter((m) => m[1] !== "COUNT")
  .sort((a, b) => Number(a[2]) - Number(b[2]))
  .map((m) => m[1].toLowerCase());
ok("vocoder: keys match C header", fromH.join() === KEYS.join(), fromH.join());
ok("vocoder: keys match schema", schema.EFFECTS.vocoder.params.map((p) => p.key).join() === KEYS.join());
ok("vocoder: shipping class id", Vocoder.id === "vocoder");
ok("vocoder: no quality key", /#define BK_P_VOCODER_QUALITY_KEY BK_PARAM_NONE/.test(h));
// Payload sanity: the battery is not vacuous (audible, nonzero output).
let nonzero = 0;
for (const r of native) for (const v of r.out32) if (v !== 0 && Number.isFinite(v)) nonzero++;
ok("battery output is substantially nonzero", nonzero > 5e5, `${nonzero} nonzero finite floats`);
console.log(
  `\n${state.checks} checks, ${state.failures} failed\nvocoder parity: ${state.failures === 0 ? "PASS" : "FAIL"}`,
);
process.exit(state.failures === 0 ? 0 : 1);
