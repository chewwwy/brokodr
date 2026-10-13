/**
 * Parity oracle for the C port of dsp/effects/character.js (Character, Glitch,
 * NoiseGen). Phase 5a, route (c).
 *
 * Same four steps as every module before it, on scripts/lib/parity-stream.mjs:
 * native build + battery, wasm build + battery, replay through the shipping
 * character.js, native vs wasm. The battery lives in packages/native/tests/
 * parity-character.c and only there; each record's params ARE the script.
 *
 * Two JS modules are loaded, both from the shipping source:
 *
 *   shipping  character.js as imported by the app; the reference for every
 *             script not named x_*.
 *   contract  character.js with the deliberate divergence of character.h
 *             applied (a NaN mode is ignored), plus behaviour-neutral reach
 *             probes. Each edit is asserted to match the shipping source
 *             exactly once.
 *
 * Scripts named x_* are compared against `contract`; every other script
 * against `shipping`. Asserted both ways: no non-x_ script touches the
 * divergence (and `contract` renders it exactly as `shipping`), and every x_
 * script does, and the shipping JS really does throw on it.
 *
 * Math.random: replaced, during process() only, by a mirror of the battery's
 * xorshift32 (OP_SEED s) or of the effect's internal generator (OP_SEED 0).
 * Draws are counted on both sides.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildAndRun, compareToJs, compareToolchains, createChecker, fillSignal } from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

const { native, wasm } = buildAndRun({
  root,
  name: "parity-character",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/biquad.c"),
    join(root, "packages/native/src/dsp/delay-line.c"),
    join(root, "packages/native/src/dsp/character.c"),
    join(root, "packages/native/tests/parity-character.c"),
  ],
  ok,
  state,
});

console.log(`\n   ${native.length} scripts in the battery`);

const fxDir = join(root, "packages/web/public/dsp/effects");
const cSrc = readFileSync(join(root, "packages/native/tests/parity-character.c"), "utf8");
const implSrc = readFileSync(join(root, "packages/native/src/dsp/character.c"), "utf8");
const hdr = readFileSync(join(root, "packages/native/include/brokodr/dsp/character.h"), "utf8");
const jsSrc = readFileSync(join(fxDir, "character.js"), "utf8");

const shipping = await import("../packages/web/public/dsp/effects/character.js");

// ---------------------------------------------------------------------------
// the contract copy
// ---------------------------------------------------------------------------

const H = "globalThis.__BK_CHAR_HIT";

/* The C contract (character.h, "Deliberate divergences"). */
const CONTRACT = [
  [
    "NaN mode ignored",
    "        this.mode = clamp(Math.round(v), 0, MODES.length - 1);\n",
    `        { const m = clamp(Math.round(v), 0, MODES.length - 1); if (m === m) this.mode = m; else ${H}("mode_nan_skipped"); }\n` +
      `        if (Math.round(v) !== Math.floor(v + 0.5) && v === v) ${H}("mode_round_trap");\n` +
      `        if (Object.is(Math.round(v), -0)) ${H}("mode_round_negzero");\n` +
      `        if (v - Math.floor(v) === 0.5) ${H}("mode_round_half");\n`,
  ],
];

/* Reach probes; behaviour-neutral. */
const PROBES = [
  [
    "mode",
    "    const m = MODES[this.mode];\n    const a = this.amount;\n",
    `    const m = MODES[this.mode];\n    const a = this.amount;\n    ${H}("mode_" + (this.mode === 0 ? 0 : this.mode)); ${H}("curve_" + m.curve); if (a !== a) ${H}("amount_nan");\n`,
  ],
  [
    "wobble gate",
    "    const wobDepth = m.wobble * a * this.wobbleTrim * 0.0012 * this.sr;\n",
    `    const wobDepth = m.wobble * a * this.wobbleTrim * 0.0012 * this.sr;\n` +
      `    ${H}(wobDepth > 0.001 ? "wob_on" : wobDepth <= 0.001 ? "wob_off" : "wob_nan"); if (wobDepth === 0.001) ${H}("wob_edge");\n` +
      `    if (frames === 0) ${H}("h_frames_0"); if (frames < 0) ${H}("h_frames_neg");\n`,
  ],
  [
    "wobble clamp",
    "          x = this.wobbleLine[c].readCubic(clamp(wobDepth + wob + 8, 2, this.wobbleLine[c].size - 4));\n",
    `          if (wobDepth + wob + 8 > this.wobbleLine[c].size - 4) ${H}("wob_clamp_hi");\n` +
      "          x = this.wobbleLine[c].readCubic(clamp(wobDepth + wob + 8, 2, this.wobbleLine[c].size - 4));\n",
  ],
  [
    "noise floor",
    "      if (noiseLvl > 0) art += this.noise.next() * noiseLvl * 20;\n",
    `      if (noiseLvl > 0) ${H}("noise_floor");\n      if (noiseLvl > 0) art += this.noise.next() * noiseLvl * 20;\n`,
  ],
  [
    "crackle",
    "      if (crackleP > 0 && Math.random() < crackleP) this.crackleState = (Math.random() * 2 - 1) * 0.4 * a;\n",
    `      if (crackleP > 0 && Math.random() < crackleP) { ${H}("crackle"); this.crackleState = (Math.random() * 2 - 1) * 0.4 * a; }\n`,
  ],
  [
    "rectifier sign",
    "        else if (m.curve === 2) x = (Math.abs(d) * 1.2 - 0.3) * Math.sign(d);\n",
    `        if (m.curve === 2 && d === 0) ${H}(Object.is(d, -0) ? "rect_negzero" : "rect_zero");\n        else if (m.curve === 1 && Math.abs(d) > 0.8) ${H}("clip");\n` +
      "        if (m.curve === 1) x = clamp(d, -0.8, 0.8) * 1.2;\n        else if (m.curve === 2) x = (Math.abs(d) * 1.2 - 0.3) * Math.sign(d);\n",
  ],
  [
    "squelch",
    "        this.squelchSm.set(gainToDb(lvl) > -42 ? 1 : 0);\n",
    `        { const q = gainToDb(lvl); ${H}(q > -42 ? "sq_open" : "sq_shut"); if (q === -42) ${H}("sq_edge"); }\n        this.squelchSm.set(gainToDb(lvl) > -42 ? 1 : 0);\n`,
  ],
  [
    "unknown character key",
    '      case "output":\n        this.outSm.set(dbToGain(v));\n        break;\n',
    `      case "output":\n        this.outSm.set(dbToGain(v));\n        break;\n      default:\n        ${H}("unknown_character");\n`,
  ],
  [
    "slice length",
    "    this.sliceLen = Math.max(64, Math.round(beatSamples / this.division));\n",
    `    this.sliceLen = Math.max(64, Math.round(beatSamples / this.division));\n` +
      `    if (this.sliceLen !== this.sliceLen) ${H}("slice_nan"); if (this.sliceLen > this.bufSize) ${H}("slice_long"); if (this.sliceLen === 64) ${H}("slice_min");\n` +
      `    if (frames === 0) ${H}("g_frames_0"); if (frames < 0) ${H}("g_frames_neg");\n`,
  ],
  [
    "freeze hold",
    "      if (!this.freeze || !this.active) {\n",
    `      if (this.freeze && this.active) ${H}("freeze_hold");\n      if (!this.freeze || !this.active) {\n`,
  ],
  [
    "slice end",
    "          if (++this.repeatCount >= this.repeats) {\n            this.active = false;\n          } else {\n            this.readPos = 0;\n",
    `          if (++this.repeatCount >= this.repeats) {\n            ${H}("slice_end");\n            this.active = false;\n          } else {\n            ${H}("slice_repeat");\n            this.readPos = 0;\n`,
  ],
  [
    "slice trigger",
    "          this.sliceStart = (this.w - this.sliceLen + this.bufSize) % this.bufSize;\n",
    `          this.sliceStart = (this.w - this.sliceLen + this.bufSize) % this.bufSize;\n          ${H}(this.freeze ? "trigger_freeze" : "trigger_random"); if (this.sliceStart < 0) ${H}("slice_start_neg");\n`,
  ],
  [
    "slice read",
    "        const idx2 = (idx + 1) % this.bufSize;\n",
    `        const idx2 = (idx + 1) % this.bufSize;\n` +
      `        ${H}(rev ? "read_rev" : "read_fwd"); if (idx < 0) ${H}("idx_neg"); if (!(idx >= 0 && idx < this.bufSize)) ${H}("idx_oob"); if (idx !== idx) ${H}("idx_nan");\n` +
      `        if (!(idx2 >= 0 && idx2 < this.bufSize)) ${H}("idx2_oob"); if (Object.is(idx, -0)) ${H}("idx_negzero"); if (idx === this.bufSize - 1) ${H}("idx_last"); if (p !== Math.floor(p)) ${H}("read_frac");\n`,
  ],
  [
    "crossfade",
    "        const env = Math.min(fadeIn, fadeOut);\n",
    `        const env = Math.min(fadeIn, fadeOut);\n        if (env !== env) ${H}("env_nan"); if (env < 1 && env >= 0) ${H}("env_fade"); if (remain < 0) ${H}("remain_neg");\n`,
  ],
  [
    "read wrap",
    "        if (this.readPos * this.pitchRatio >= this.sliceLen) this.readPos = 0;\n",
    `        if (this.readPos * this.pitchRatio >= this.sliceLen) ${H}("read_wrap");\n        if (this.readPos * this.pitchRatio >= this.sliceLen) this.readPos = 0;\n`,
  ],
  [
    "unknown glitch key",
    '      case "freeze":\n        this.freeze = v >= 0.5 ? 1 : 0;\n        break;\n',
    `      case "freeze":\n        this.freeze = v >= 0.5 ? 1 : 0;\n        break;\n      default:\n        ${H}("unknown_glitch");\n`,
  ],
  [
    "noise type",
    "      if (this.type === 0) n = Math.random() * 2 - 1;\n",
    `      ${H}(this.type === 0 ? "type_white" : this.type === 1 ? "type_pink" : this.type !== this.type ? "type_nan" : "type_brown"); if (Object.is(this.type, -0)) ${H}("type_negzero");\n` +
      "      if (this.type === 0) n = Math.random() * 2 - 1;\n",
  ],
  [
    "brown rails",
    "        this.brown = clamp(this.brown + (Math.random() * 2 - 1) * 0.02, -1, 1);\n",
    `        { const b = this.brown + (Math.random() * 2 - 1) * 0.02; if (b > 1) ${H}("brown_hi"); if (b < -1) ${H}("brown_lo"); this.brown = clamp(b, -1, 1); }\n`,
  ],
  [
    "follow",
    "      if (this.follow > 0.001) {\n",
    `      ${H}(this.follow > 0.001 ? "follow_on" : "follow_off"); if (this.follow === 0.001) ${H}("follow_edge");\n      if (this.follow > 0.001) {\n`,
  ],
  [
    "level floor",
    "        this.levelSm.set(dbToGain(v) * (v <= -60 ? 0 : 1));\n",
    `        if (v <= -60) ${H}("level_floor"); if (v === -60) ${H}("level_edge");\n        this.levelSm.set(dbToGain(v) * (v <= -60 ? 0 : 1));\n`,
  ],
  [
    "unknown noise key",
    '      case "tone":\n        this.lpFreq = v;\n        break;\n',
    `      case "tone":\n        this.lpFreq = v;\n        break;\n      default:\n        ${H}("unknown_noise");\n`,
  ],
];

let currentHits = new Map();
globalThis.__BK_CHAR_HIT = (k) => currentHits.set(k, (currentHits.get(k) ?? 0) + 1);

const contractPath = join(fxDir, ".parity-contract.character.mjs");
let contract;
try {
  let src = jsSrc;
  for (const [label, find, repl] of [...CONTRACT, ...PROBES]) {
    const n = src.split(find).length - 1;
    ok(`edit "${label}" matches the shipping source exactly once`, n === 1, `${n} matches`);
    src = src.replace(find, repl);
  }
  writeFileSync(contractPath, src);
  contract = await import(`${pathToFileURL(contractPath).href}?t=${Date.now()}`);
} finally {
  rmSync(contractPath, { force: true });
}

// ---------------------------------------------------------------------------
// mirrors of the C battery
// ---------------------------------------------------------------------------

const OP = { END: 0, INIT: 1, PARAM: 2, PROCESS: 3, RESET: 4, SNAP: 5, POKE: 6, REWIND: 7, SEED: 8, MONO: 10 };
const OPW = 5;
const CHAR_BLOCK = 12;
const GLITCH_BLOCK = 11;
const NOISE_BLOCK = 9;
const CHAR_SNAP = 148;
const GLITCH_SNAP = 18;
const NOISE_SNAP = 41;
const SIG_N = 65536;
const MAX_POKES = 32;
const MAX_P64 = 2000000;
const MAX_P32 = 4000000;
const SENTINEL = new Map([
  [-3e9, NaN],
  [3e9, Infinity],
  [-4e9, -Infinity],
]);
const unsentinel = (v) => (SENTINEL.has(v) ? SENTINEL.get(v) : v);

/** BK_P_CHARACTER_*, BK_P_GLITCH_*, BK_P_NOISE_* order. */
const CHAR_KEYS = ["mode", "amount", "drive", "noise", "wobble", "output"];
const GLITCH_KEYS = ["probability", "bpm", "division", "repeats", "reverse", "pitch", "freeze"];
const NOISE_KEYS = ["level", "type", "follow", "tone"];
const KEYS = [CHAR_KEYS, GLITCH_KEYS, NOISE_KEYS];
/* bk_rng_seed values in character.c, by type. */
const INTERNAL_SEEDS = [0x8f1bbcdc, 0xca62c1d6, 0x5a827999];

const SIGS = [0, 1, 2, 3, 4].map((s) => Float32Array.from(fillSignal(SIG_N, s)));

const xorshift = (x) => {
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  return (x ^ (x << 5)) >>> 0;
};
function makeRng() {
  const g = { mode: "test", seed: 1, internal: 0, draws: 0 };
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

/* A decision, not a mirror: Math.round(-0.3) makes the JS mode -0, and
   MODES[-0] reads as MODES[0]. The C mode is an int and cannot hold -0, so
   the reading maps -0 to 0. The audio is compared untouched. */
const modeOf = (e) => (e.mode === 0 ? 0 : e.mode);
const smootherState = (s, out) => out.push(s.value, s.target, s.a);
const biquadState = (f, out) => out.push(f.b0, f.b1, f.b2, f.a1, f.a2, f.z1, f.z2, f.type, f.freq, f.q, f.gainDb);
const lfoState = (o, out) => out.push(o.phase, o.inc, o.shape, o.rand, o.lastQuad);
const envState = (e, out) => out.push(e.rms ? 1 : 0, e.env, e.ca, e.cr);
const pinkState = (p, out) => {
  for (let k = 0; k < 7; k++) out.push(p.b[k]);
};

function blockState(e, type, rng, out) {
  if (type === 1) {
    out.push(e.w, e.sliceLen, e.active ? 1 : 0, e.sliceStart, e.repeatCount, e.readPos, e.counter, e.freeze, e.division);
    out.push(rng.draws, e.meter);
  } else if (type === 2) {
    out.push(e.levelSm.value, e.levelSm.target, e.brown, e.env.env, e.type, e.follow, e.lpFreq, rng.draws, 0);
  } else {
    out.push(e.squelchSm.value, e.squelchSm.target, e.outSm.value, e.outSm.target, e.crackleState, e.gateEnv.env);
    out.push(e.wobbleLfo.phase, e.flutterLfo.phase, e.wobbleLine[0].w, modeOf(e), rng.draws, 0);
  }
}

function snapState(e, type, out, o32) {
  if (type === 1) {
    out.push(e.sr, e.bufSize, e.w, e.bpm, e.division, e.probability, e.reverse, e.pitchRatio, e.repeats, e.xfade);
    out.push(e.sliceLen, e.active ? 1 : 0, e.sliceStart, e.repeatCount, e.readPos, e.counter, e.freeze, e.meter);
    for (const a of [e.bufL, e.bufR]) for (let k = 0; k < a.length; k++) o32.push(a[k]);
  } else if (type === 2) {
    out.push(e.sr, e.type, e.brown, e.follow, e.lpFreq);
    smootherState(e.levelSm, out);
    pinkState(e.pink, out);
    envState(e.env, out);
    biquadState(e.lp[0], out);
    biquadState(e.lp[1], out);
  } else {
    out.push(e.sr, modeOf(e), e.amount, e.driveTrim, e.noiseTrim, e.wobbleTrim, e.crackleState);
    for (let k = 0; k < 2; k++) {
      for (const s of e.hp[k].stages) biquadState(s, out);
      for (const s of e.lp[k].stages) biquadState(s, out);
      biquadState(e.res[k], out);
    }
    pinkState(e.noise, out);
    lfoState(e.wobbleLfo, out);
    lfoState(e.flutterLfo, out);
    for (const d of e.wobbleLine) out.push(d.size, d.w);
    envState(e.gateEnv, out);
    smootherState(e.squelchSm, out);
    smootherState(e.outSm, out);
    for (const d of e.wobbleLine) for (let k = 0; k < d.buf.length; k++) o32.push(d.buf[k]);
  }
}

/** Replay one script through module `mod`. `hits` collects probe hits. */
function replay(mod, ops, hits = new Map()) {
  const out = [];
  const o32 = [];
  const rng = makeRng();
  let e;
  let type = 0;
  const init = (t, sr) => {
    type = t;
    e = t === 1 ? new mod.Glitch(sr, 128) : t === 2 ? new mod.NoiseGen(sr, 128) : new mod.Character(sr, 128);
    rng.mode = "test";
    rng.seed = 1;
    rng.internal = INTERNAL_SEEDS[t];
    // vtable: no carrier bus, no latency; a meter on glitch only.
    out.push(1, 1, t === 1 ? 0 : 1);
  };
  const saved = Math.random;
  const savedHits = currentHits;
  currentHits = hits;
  try {
    init(0, 48000);
    let cursor = 0;
    let pokes = [];
    const L = new Float32Array(4096);
    const R = new Float32Array(4096);
    for (let i = 0; i + OPW <= ops.length; i += OPW) {
      const op = ops[i] | 0;
      const a = unsentinel(ops[i + 1]);
      const b = unsentinel(ops[i + 2]);
      const c = unsentinel(ops[i + 3]);
      const d = unsentinel(ops[i + 4]);
      if (op === OP.END) break;
      else if (op === OP.INIT) {
        init(a | 0, b);
        // c != 0: the C keeps init()'s default generator (no set_random call).
        if (c !== 0) rng.mode = "internal";
      }
      else if (op === OP.PARAM) e.setParam(KEYS[type][a] ?? `unknown:${a}`, b);
      else if (op === OP.PROCESS) {
        const bs = b | 0;
        const sl = SIGS[c | 0];
        const sr = SIGS[d | 0];
        // A negative block size reaches process() as is, with no samples.
        const vL = L.subarray(0, Math.max(bs, 0));
        const vR = R.subarray(0, Math.max(bs, 0));
        for (let k = 0; k < (a | 0); k++) {
          for (let j = 0; j < bs; j++) {
            const at = (cursor + j) % SIG_N;
            vL[j] = sl[at];
            vR[j] = -0.5 * sr[at];
          }
          cursor = (cursor + bs) % SIG_N;
          for (const [ch, at, v] of pokes) if (at < bs) (ch ? vR : vL)[at] = v;
          pokes = [];
          Math.random = rng.random;
          try {
            e.process(vL, vR, bs);
          } finally {
            Math.random = saved;
          }
          blockState(e, type, rng, out);
          for (let j = 0; j < bs; j++) o32.push(vL[j]);
          for (let j = 0; j < bs; j++) o32.push(vR[j]);
        }
      } else if (op === OP.MONO) {
        // One buffer as both l and r: the aliasing a mono caller produces.
        const bs = b | 0;
        const sl = SIGS[c | 0];
        const vL = L.subarray(0, Math.max(bs, 0));
        for (let k = 0; k < (a | 0); k++) {
          for (let j = 0; j < bs; j++) vL[j] = sl[(cursor + j) % SIG_N];
          cursor = (cursor + bs) % SIG_N;
          for (const [, at, v] of pokes) if (at < bs) vL[at] = v;
          pokes = [];
          Math.random = rng.random;
          try {
            e.process(vL, vL, bs);
          } finally {
            Math.random = saved;
          }
          blockState(e, type, rng, out);
          for (let j = 0; j < bs; j++) o32.push(vL[j]);
        }
      } else if (op === OP.RESET) e.reset();
      else if (op === OP.SNAP) snapState(e, type, out, o32);
      else if (op === OP.POKE) {
        if (pokes.length < MAX_POKES) pokes.push([a | 0, b | 0, c]);
      } else if (op === OP.REWIND) cursor = 0;
      else if (op === OP.SEED) {
        if (a === 0) rng.mode = "internal";
        else {
          rng.mode = "test";
          rng.seed = a >>> 0;
        }
      }
    }
    snapState(e, type, out, o32);
  } finally {
    Math.random = saved;
    currentHits = savedHits;
  }
  return { out64: Float64Array.from(out), out32: Float32Array.from(o32) };
}

const isX = (rec) => rec.name.startsWith("x_");

const contractOut = new Map();
const scriptHits = new Map();
for (const rec of native) {
  const h = new Map();
  contractOut.set(rec.name, replay(contract, rec.params, h));
  scriptHits.set(rec.name, h);
}
const DIVERGENCE_HITS = ["mode_nan_skipped"];
const needsContract = (name) => DIVERGENCE_HITS.filter((k) => (scriptHits.get(name).get(k) ?? 0) > 0);

const refOut = new Map();
for (const rec of native) {
  if (isX(rec) || needsContract(rec.name).length) continue;
  refOut.set(rec.name, replay(shipping, rec.params));
}
const EMPTY = { out64: new Float64Array(0), out32: new Float32Array(0) };
const reference = (rec) => (isX(rec) ? contractOut.get(rec.name) : refOut.get(rec.name) ?? EMPTY);

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

/*
 * Bit-identity baselines, pinned. MEASURED 2026-10-02 on glibc / emscripten /
 * V8; MSVC unmeasured. Every record is inside tolerance (checked above). Every
 * glitch (g_*) and noise (n_*) record is bit-identical on all three; all drift
 * is in character (h_*, x_mode_nan):
 *   native vs JS:   12 of 62 drift (h_modes h_modes_hot h_wobble h_crackle
 *                   h_internal h_init_internal h_reset h_blocks h_rates h_poke
 *                   h_wob_clamp x_mode_nan)
 *   wasm vs JS:     17 of 62 drift (h_default h_modes h_mode_round h_amount
 *                   h_drive h_noise_trim h_wobble h_wob_edge h_output h_crackle
 *                   h_internal h_init_internal h_reset h_rates h_wob_clamp
 *                   h_unknown x_mode_nan)
 *   native vs wasm: 20 of 62 drift (the union)
 * Attributed, NOT traced per record, to libm: over 200,000 uniform inputs in
 * [-3, 3), glibc tanh differs from V8 Math.tanh on 79 and emscripten's on
 * 25,765; emscripten pow(10, x) differs from V8 on 123, glibc on 0. Treat the
 * counts as empirical. Rerun with LIST_DRIFT=1 to print the lists.
 */
const IDENTITY_NATIVE = 50;
const IDENTITY_WASM = 45;
const IDENTITY_CROSS = 42;
// name -> which comparisons must be bit-identical. h_wob_edge is cassette (tanh curve), and
// emscripten's tanh is not V8's (see above), so only native vs JS is required for it; the gate
// mutants it exists for move the output by far more than tolerance anyway.
const REQUIRE_IDENTICAL = { h_wob_edge: ["native"], h_squelch_edge: ["native", "wasm", "native/wasm"], g_neg_index: ["native", "wasm", "native/wasm"], g_reset_full: ["native", "wasm", "native/wasm"], g_frac_rate: ["native", "wasm", "native/wasm"], g_trig_edge: ["native", "wasm", "native/wasm"], h_crackle_edge: ["native"], h_crackle_reset: ["native"] };

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
  const drifting = (dump, other) => dump.filter((rec, i) => { const r = other(rec, i); return !(strictSame(r.out64, rec.out64) && strictSame(r.out32, rec.out32)); }).map((r) => r.name);
  if (process.env.LIST_DRIFT) {
    console.log("DRIFT native/JS:", drifting(native, reference).join(" "));
    if (wasm) console.log("DRIFT wasm/JS:", drifting(wasm, reference).join(" "));
    if (wasm) console.log("DRIFT native/wasm:", drifting(native, (_, i) => wasm[i]).join(" "));
  }
  // Edge records whose whole point is a last-bit comparison must be bit-identical by name.
  for (const [n, want] of Object.entries(REQUIRE_IDENTICAL)) {
    const pairs = [["native", native, reference]];
    if (wasm) pairs.push(["wasm", wasm, reference], ["native/wasm", native, (_, i) => wasm[i]]);
    for (const [label, dump, other] of pairs) if (want.includes(label)) ok(`${n} bit-identical (${label})`, !drifting(dump, other).includes(n));
  }
  console.log("\n== sign of zero ==");
  strict("native vs JS", native, reference, IDENTITY_NATIVE);
  if (wasm) {
    strict("wasm vs JS", wasm, reference, IDENTITY_WASM);
    strict("native vs wasm", native, (_, i) => wasm[i], IDENTITY_CROSS);
  }
}

// ---------------------------------------------------------------------------
// the divergence
// ---------------------------------------------------------------------------

console.log("\n== deliberate divergence: only x_* scripts need the contract ==");
{
  const offenders = native.filter((r) => !isX(r) && needsContract(r.name).length).map((r) => `${r.name}: ${needsContract(r.name).join("+")}`);
  ok("no non-x_ script touches the divergence", offenders.length === 0, offenders.join(", "));
  let same = 0;
  let total = 0;
  for (const rec of native) {
    if (isX(rec) || !refOut.has(rec.name)) continue;
    total++;
    const a = refOut.get(rec.name);
    const b = contractOut.get(rec.name);
    if (strictSame(a.out64, b.out64) && strictSame(a.out32, b.out32)) same++;
  }
  ok("the contract (+ probes) renders every non-x_ script exactly as the shipping JS", same === total && total > 0, `${same}/${total}`);
  const xs = native.filter(isX);
  ok("there is an x_ script", xs.length > 0);
  for (const rec of xs) ok(`${rec.name} touches the divergence`, needsContract(rec.name).length > 0, needsContract(rec.name).join("+"));
  {
    const rec = native.find((r) => r.name === "x_mode_nan");
    let err = null;
    try {
      replay(shipping, rec.params);
    } catch (e) {
      err = e;
    }
    ok("the shipping JS throws a TypeError on a NaN mode", err instanceof TypeError, err ? String(err).slice(0, 80) : "no throw");
  }
}

// ---------------------------------------------------------------------------
// sanity
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises character.js ==");
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
  ok("BK_CHAR_BLOCK mirrors the C", def(cSrc, "BK_CHAR_BLOCK") === CHAR_BLOCK);
  ok("BK_GLITCH_BLOCK mirrors the C", def(cSrc, "BK_GLITCH_BLOCK") === GLITCH_BLOCK);
  ok("BK_NOISE_BLOCK mirrors the C", def(cSrc, "BK_NOISE_BLOCK") === NOISE_BLOCK);
  ok("BK_CHAR_SNAP mirrors the C", def(cSrc, "BK_CHAR_SNAP") === CHAR_SNAP);
  ok("BK_GLITCH_SNAP mirrors the C", def(cSrc, "BK_GLITCH_SNAP") === GLITCH_SNAP);
  ok("BK_NOISE_SNAP mirrors the C", def(cSrc, "BK_NOISE_SNAP") === NOISE_SNAP);
  ok("MAX_POKES mirrors the C", def(cSrc, "MAX_POKES") === MAX_POKES);
  ok("MAX_P64 / MAX_P32 mirror the C", def(cSrc, "MAX_P64") === MAX_P64 && def(cSrc, "MAX_P32") === MAX_P32);
  {
    const fn = (n) => cSrc.match(new RegExp(`static void ${n}\\([\\s\\S]*?\\n\\}`))[0];
    const pushes = (s) => (s.match(/push64\(/g) || []).length;
    const count = (s, f) => (s.match(new RegExp(`${f}\\(`, "g")) || []).length;
    const [gb, rest] = fn("block_state").split("} else if (g_type == 2) {");
    const [nb, cb] = rest.split("} else {");
    ok("block_state: glitch pushes BK_GLITCH_BLOCK", pushes(gb) === GLITCH_BLOCK, `${pushes(gb)}`);
    ok("block_state: noise pushes BK_NOISE_BLOCK", pushes(nb) === NOISE_BLOCK, `${pushes(nb)}`);
    ok("block_state: character pushes BK_CHAR_BLOCK", pushes(cb) === CHAR_BLOCK, `${pushes(cb)}`);
    ok("smoother_state pushes 3", pushes(fn("smoother_state")) === 3);
    ok("biquad_state pushes 11", pushes(fn("biquad_state")) === 11);
    ok("lfo_state pushes 5", pushes(fn("lfo_state")) === 5);
    ok("env_state pushes 4", pushes(fn("env_state")) === 4);
    ok("pink_state pushes 7 (one in a 7-loop)", pushes(fn("pink_state")) === 1 && /k < 7/.test(fn("pink_state")));
    const [gs, rest2] = fn("snap_state").split("} else if (g_type == 2) {");
    const [ns, cs] = rest2.split("} else {");
    ok("snap_state: glitch pushes 18 scalars", pushes(gs) === GLITCH_SNAP, `${pushes(gs)}`);
    ok("snap_state: noise pushes 5 + smoother + pink + env + 2 biquads", pushes(ns) === 5 && count(ns, "smoother_state") === 1 && count(ns, "pink_state") === 1 && count(ns, "env_state") === 1 && count(ns, "biquad_state") === 2);
    ok("BK_NOISE_SNAP is the structural count", 5 + 3 + 7 + 4 + 2 * 11 === NOISE_SNAP);
    ok("snap_state: character pushes 7 + 2 + (biquads in 2x(2+2+1)) + pink + 2 lfo + env + 2 smoothers", pushes(cs) === 9 && count(cs, "biquad_state") === 3 && count(cs, "pink_state") === 1 && count(cs, "lfo_state") === 2 && count(cs, "env_state") === 1 && count(cs, "smoother_state") === 2);
    ok("BK_CHAR_SNAP is the structural count", 7 + 10 * 11 + 7 + 2 * 5 + 2 * 2 + 4 + 2 * 3 === CHAR_SNAP);
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
    cSrc.includes("g_r[j] = -0.5f * g_sig[sr][at];") && cSrc.includes("g_cursor = (g_cursor + bs) % SIG_N;"),
  );
  ok(
    "the Math.random mirror matches the C",
    /unsigned int x = \*seed;\s*x \^= x << 13;\s*x \^= x >> 17;\s*x \^= x << 5;\s*\*seed = x;\s*g_draws \+= 1\.0;\s*return \(double\)x \/ 4294967296\.0;/.test(cSrc) &&
      /g_seed = 1u;/.test(cSrc.match(/static void init_fx[\s\S]*?\n\}/)[0]),
  );
  {
    const seeds = [...implSrc.matchAll(/bk_rng_seed\(&(\w)->rng, 0x([0-9a-f]+)u\);/g)].map((m) => [m[1], parseInt(m[2], 16)]);
    ok(
      "the internal-generator seeds mirror character.c",
      seeds.length === 3 && seeds[0][0] === "c" && seeds[0][1] === INTERNAL_SEEDS[0] && seeds[1][0] === "g" && seeds[1][1] === INTERNAL_SEEDS[1] && seeds[2][0] === "n" && seeds[2][1] === INTERNAL_SEEDS[2],
      JSON.stringify(seeds),
    );
    ok("the internal generator is (bk_rng_bipolar + 1) * 0.5", implSrc.includes("return (bk_rng_bipolar((unsigned int *)user) + 1.0) * 0.5;"));
    const utilsC = readFileSync(join(root, "packages/native/src/dsp/utils.c"), "utf8");
    ok(
      "the internal-generator mirror matches bk_rng_bipolar",
      /x \^= x << 13;\s*x \^= x >> 17;\s*x \^= x << 5;\s*\*state = x;\s*return \(\(double\)\(x >> 8\) \/ 16777216\.0\) \* 2\.0 - 1\.0;/.test(utilsC) &&
        /\*state = seed \? seed : 0x1u;/.test(utilsC),
    );
  }
  {
    const keysH = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
    const fromHeader = (p) =>
      [...keysH.matchAll(new RegExp(`BK_P_${p}_([A-Z0-9_]+) = (\\d+)`, "g"))]
        .filter((m) => m[1] !== "COUNT")
        .sort((x, y) => Number(x[2]) - Number(y[2]))
        .map((m) => m[1].toLowerCase().replace(/_/g, ""));
    const schema = await import("../packages/web/src/web/audio/param-schema.ts");
    for (const [id, p, keys] of [["character", "CHARACTER", CHAR_KEYS], ["glitch", "GLITCH", GLITCH_KEYS], ["noise", "NOISE", NOISE_KEYS]]) {
      ok(`keys match BK_P_${p}_* in param-keys.h`, fromHeader(p).join() === keys.join(), fromHeader(p).join());
      ok(`keys match the ${id} param schema`, schema.EFFECTS[id].params.map((q) => q.key).join() === keys.join(), schema.EFFECTS[id].params.map((q) => q.key).join());
      for (const k of keys) ok(`setParam handles "${k}" (${id})`, jsSrc.includes(`case "${k}":`));
    }
    ok("Character / Glitch / NoiseGen ids", shipping.Character.id === "character" && shipping.Glitch.id === "glitch" && shipping.NoiseGen.id === "noise");
    ok("BK_CHARACTER_MODES is the JS table's length", def(hdr, "BK_CHARACTER_MODES") === 8 && (jsSrc.match(/\{ name: "/g) || []).length === 8);
  }
  {
    // The C mode table, row by row, against the JS MODES.
    const rows = [...jsSrc.matchAll(/\{ name: "([\w-]+)", hp: ([\d.]+), lp: ([\d.]+), res: \[([\d.]+), (-?[\d.]+), ([\d.]+)\], drive: ([\d.]+), curve: (\d), noise: ([\d.]+), crackle: ([\d.]+), wobble: ([\d.]+), squelch: (\d) \}/g)];
    const cRows = [...implSrc.matchAll(/\{([-\d., ]+)\},\s*\/\* ([\w-]+) \*\//g)];
    ok("8 mode rows on each side", rows.length === 8 && cRows.length === 8, `${rows.length} / ${cRows.length}`);
    rows.forEach((r, i) => {
      const js = r.slice(2, 13).map(Number);
      const c = cRows[i] ? cRows[i][1].split(",").map((s) => Number(s.trim())) : [];
      ok(`mode ${i} (${r[1]}) row matches the C`, cRows[i] && cRows[i][2] === r[1] && js.join() === c.join(), `${js.join()} vs ${c.join()}`);
    });
  }
  {
    const all = new Map();
    for (const h of scriptHits.values()) for (const [k, v] of h) all.set(k, (all.get(k) ?? 0) + v);
    const must = [
      "mode_0", "mode_1", "mode_2", "mode_3", "mode_4", "mode_5", "mode_6", "mode_7", "curve_0", "curve_1", "curve_2",
      "mode_nan_skipped", "mode_round_trap", "mode_round_negzero", "mode_round_half", "amount_nan",
      "wob_on", "wob_off", "wob_nan", "wob_edge", "wob_clamp_hi", "h_frames_0", "h_frames_neg", "noise_floor", "crackle",
      "rect_zero", "clip", "sq_open", "sq_shut", "sq_edge", "unknown_character",
      "slice_nan", "slice_long", "slice_min", "g_frames_0", "g_frames_neg", "freeze_hold", "slice_end", "slice_repeat",
      "trigger_freeze", "trigger_random", "slice_start_neg", "read_rev", "read_fwd", "idx_neg", "idx_oob", "idx_nan",
      "idx2_oob", "idx_last", "read_frac", "env_nan", "env_fade", "read_wrap", "unknown_glitch",
      "type_white", "type_pink", "type_brown", "type_nan", "type_negzero", "brown_hi", "brown_lo",
      "follow_on", "follow_off", "follow_edge", "level_floor", "level_edge", "unknown_noise",
    ];
    for (const k of must) ok(`reached: ${k}`, (all.get(k) ?? 0) > 0, `${all.get(k) ?? 0} hits`);
    // rect_negzero is unreachable, so it is asserted NEVER hit. Proof: d = x * drive, with x the
    // output of res[c] (one Biquad). y = b0*x + z1, and z1 is either the initial/reset +0 or a
    // sanitize() result, which maps |v| < 1e-18 (including -0) to +0 — so z1 is never -0. In
    // round-to-nearest, v + (+0) is never -0 (-0 + +0 = +0), and an exact
    // cancellation of two nonzero finites is +0. So x is never -0. drive = 1 + (m.drive-1)*a*g with
    // m.drive = 5 for the only curve-2 mode, a in [0,1] or NaN, g = dbToGain(..) >= 0 or NaN/+inf,
    // so drive is >= 1, +inf or NaN, never negative: d = +0 * drive is +0 or NaN. Hence d === -0
    // cannot occur, Math.sign's -0 branch in the rectifier is dead, and any -0 handling there is
    // unobservable. If this check ever fails the proof is wrong — investigate, do not delete it.
    ok("never reached: rect_negzero (proof above)", (all.get("rect_negzero") ?? 0) === 0, `${all.get("rect_negzero") ?? 0} hits`);
    for (const [name, k] of [["h_wob_edge", "wob_edge"], ["h_squelch_edge", "sq_edge"], ["g_neg_index", "idx_neg"], ["h_wob_clamp", "wob_clamp_hi"]]) {
      ok(`${name} reaches ${k}`, (scriptHits.get(name).get(k) ?? 0) > 0);
    }
    for (const n of ["h_internal", "g_internal", "n_internal"]) {
      ok(`${n} draws from the internal generator`, contractOut.get(n).out64.some((v, i) => i > 3 && v > 0));
    }
  }
  ok("every script in the C appears in the dump", (cSrc.match(/\bS\([hgnx]_\w+\)/g) || []).length === native.length);
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\ncharacter parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
