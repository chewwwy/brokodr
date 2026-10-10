#!/usr/bin/env node
/**
 * verify-null-driver.mjs — Phase 5a gate: the composed native engine behind the Device seam.
 *
 * Builds packages/native/tests/null-driver.cc against every native DSP module, the WAV
 * reader/writer and the offline driver, then:
 *   - writes a stereo float32 stimulus WAV and a frame-timed command schedule (master chain
 *     of four effects, a pad-chain effect, pad loads and hits, Smart Voice on, clock running,
 *     a loop recorded and played back, io gain/mute/mix changes, both drum routes);
 *   - runs it through the offline driver at 128 and 480 frames per block (the stimulus
 *     length leaves a short final block at both), optimised with the allocation counter on,
 *     and once more at 128 under address + UB sanitizers;
 *   - replays the identical schedule through the JS Engine.applyCommand in the identical
 *     block partition, with Math.random replaced by the native side's xorshift;
 *   - requires every float32 output sample to be bit-identical to the JS (sign of zero
 *     included) and compares the final readMeters block.
 *
 * The native binary itself checks that render() never allocates and that the driver path is
 * bit-identical to direct bk_engine_process calls.
 *
 * Run: node scripts/verify-null-driver.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nat = process.env.BK_NATIVE_DIR || join(root, "packages/native");
const out = join(root, "packages/native/build/null-driver");
mkdirSync(out, { recursive: true });

let fails = 0;
let checks = 0;
const ok = (name, cond, detail = "") => {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    fails++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return cond;
};

const { Engine } = await import("../packages/web/public/dsp/engine.js");
const { EFFECT_CLASSES } = await import("../packages/web/public/dsp/effects/registry.js");
const { EFFECTS } = await import("../packages/web/src/web/audio/param-schema.ts");
const backend = await import("../packages/web/src/web/audio/backend.ts");
const TYPES = Object.keys(EFFECT_CLASSES);
const T = (name) => {
  const i = TYPES.indexOf(name);
  if (i < 0) throw new Error(`no effect type ${name}`);
  return i;
};
const IO_NAME = ["inGain", "outGain", "mute", "bypass", "mono", "swap", "masterMix"];
const LOOP_OP = { 0: "rec", 1: "play", 2: "stop", 3: "clear", 4: "undo", 6: "clearall" };
const keyOf = (table, name) => {
  const i = table.indexOf(name);
  if (i < 0) throw new Error(`no key ${name}`);
  return i;
};
const fxKey = (type, name) => keyOf(EFFECTS[TYPES[type]].params.map((p) => p.key), name);

// ------------------------------------------------------------------ build

const DSP = readdirSync(join(nat, "src/dsp"))
  .filter((f) => f.endsWith(".c"))
  .sort();
const inc = `-I${join(nat, "include")}`;
const build = (label, cflags, bin) => {
  const objDir = join(out, `obj-${label}`);
  mkdirSync(objDir, { recursive: true });
  const objs = [];
  for (const f of DSP) {
    const o = join(objDir, f.replace(/\.c$/, ".o"));
    const r = spawnSync("gcc", ["-std=c99", "-Wall", "-Wextra", inc, ...cflags, "-c", join(nat, "src/dsp", f), "-o", o], {
      encoding: "utf8",
    });
    if (r.status !== 0) return ok(`${label}: ${f} compiles`, false, (r.stderr || "").split("\n").slice(0, 6).join("\n"));
    objs.push(o);
  }
  const r = spawnSync(
    "g++",
    [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", inc, ...cflags,
      join(nat, "tests/null-driver.cc"), join(nat, "src/wav.cc"), join(nat, "src/offline-device.cc"),
      ...objs, "-lm", "-o", bin,
    ],
    { encoding: "utf8" },
  );
  return ok(`${label}: builds clean (-Wall -Wextra, -Werror on the C++)`, r.status === 0, (r.stderr || "").split("\n").slice(0, 8).join("\n"));
};

console.log("build");
const optBin = join(out, "null-driver-O2");
const sanBin = join(out, "null-driver-asan");
const builtOpt = build("O2", ["-O2"], optBin);
const builtSan = build("asan-ubsan", ["-O1", "-g", "-fsanitize=address,undefined", "-fsanitize=float-cast-overflow", "-fno-sanitize-recover=all"], sanBin);

// ------------------------------------------------------------------ stimulus

const SR = 48000;
const FRAMES = 2 * SR + 77; // 96077: a short final block at 128 (77) and at 480 (77)
const xorshift = (x) => {
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  return (x ^ (x << 5)) >>> 0;
};
const inL = new Float32Array(FRAMES);
const inR = new Float32Array(FRAMES);
{
  let s = 0x1234567;
  for (let j = 0; j < FRAMES; j++) {
    s = xorshift(s);
    const nz = s / 4294967296 - 0.5;
    const k = j % 9600;
    const env = k < 2400 ? (2400 - k) / 2400 : 0;
    const tone = Math.sin((2 * Math.PI * 220 * j) / SR);
    inL[j] = (nz * 0.9 + tone * 0.4) * env + tone * 0.05;
    inR[j] = (nz * 0.5 - tone * 0.3) * env - tone * 0.04;
  }
}
const writeWav = (path, l, r, sr) => {
  const n = l.length;
  const buf = Buffer.alloc(44 + n * 8);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 8, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 8, 28);
  buf.writeUInt16LE(8, 32);
  buf.writeUInt16LE(32, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 8, 40);
  for (let j = 0; j < n; j++) {
    buf.writeFloatLE(l[j], 44 + j * 8);
    buf.writeFloatLE(r[j], 48 + j * 8);
  }
  writeFileSync(path, buf);
};
const readWav = (path) => {
  const b = readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV");
  let p = 12;
  let fmt = null;
  while (p + 8 <= b.length) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), bits: b.readUInt16LE(p + 22) };
    if (id === "data") {
      if (!fmt || fmt.format !== 3 || fmt.ch !== 2 || fmt.bits !== 32) throw new Error("expected stereo float32");
      const n = size / 8;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        l[j] = b.readFloatLE(p + 8 + j * 8);
        r[j] = b.readFloatLE(p + 12 + j * 8);
      }
      return { l, r };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
};
const inPath = join(out, "in.wav");
writeWav(inPath, inL, inR, SR);

// ------------------------------------------------------------------ schedule
// [frame, verb, a, b, c, d, e]; verbs as in null-driver.cc.
const V = { ADD: 0, FXPARAM: 1, MIX: 2, BYPASS: 3, IO: 4, PADLOAD: 5, PAD: 6, PADPARAM: 7, DRUM: 8, CLOCK: 9, LOOP: 10, LOOPPARAM: 11, VOICE: 12, PADOFF: 13 };
const MASTER = 0, PAD = 1;
const io = (n) => IO_NAME.indexOf(n);
const SCHED = [
  [0, V.ADD, MASTER, 0, T("comp"), 1, -1],
  [0, V.ADD, MASTER, 0, T("delay"), 2, -1],
  [0, V.ADD, MASTER, 0, T("reverb"), 3, -1],
  [0, V.ADD, MASTER, 0, T("chorus"), 4, 1],
  [0, V.ADD, PAD, 0, T("sat"), 10, 0],
  [0, V.PADLOAD, 0, 0, 4800, 48000, 0],
  [0, V.PADLOAD, 1, 0, 2400, 44100, 0],
  [0, V.CLOCK, keyOf(backend.CLOCK_KEY, "bpm"), 120, 0, 0, 0],
  [0, V.CLOCK, keyOf(backend.CLOCK_KEY, "quantize"), 1, 0, 0, 0], // one beat = 24000 frames
  [0, V.CLOCK, keyOf(backend.CLOCK_KEY, "run"), 1, 0, 0, 0],
  [0, V.VOICE, keyOf(backend.VOICE_KEY, "enabled"), 1, 0, 0, 0],
  [400, V.PAD, 0, 0.8, 0, 0, 0],
  [1300, V.FXPARAM, MASTER, 0, 2, fxKey(T("delay"), "feedback"), 0.6],
  [2600, V.MIX, MASTER, 0, 3, 0.4, 0],
  [3200, V.PAD, 1, 1, 0, 0, 0],
  [5000, V.IO, io("inGain"), -6, 0, 0, 0],
  [7680, V.LOOP, 0, 0, 0, 0, 0],
  [30000, V.BYPASS, MASTER, 0, 1, 1, 0],
  [36000, V.IO, io("masterMix"), 0.5, 0, 0, 0],
  [40000, V.DRUM, keyOf(backend.DRUM_KEY, "route"), 2, 0, 0, 0],
  [45000, V.PADPARAM, 0, keyOf(backend.PAD_KEY, "pitch"), 7, 0, 0],
  [45000, V.PAD, 0, 1, 0, 0, 0],
  [50000, V.LOOP, 0, 0, 0, 0, 0], // rec 24000..72000, then plays
  [52000, V.IO, io("outGain"), -3, 0, 0, 0],
  [60000, V.IO, io("mute"), 1, 0, 0, 0],
  [66000, V.IO, io("mute"), 0, 0, 0, 0],
  [70000, V.FXPARAM, PAD, 0, 10, fxKey(T("sat"), "drive"), 0.8],
  [72000, V.PAD, 0, 0.9, 0, 0, 0],
  [80000, V.LOOPPARAM, 0, keyOf(backend.LOOP_KEY, "gain"), 0.5, 0, 0],
  [85000, V.DRUM, keyOf(backend.DRUM_KEY, "route"), 1, 0, 0, 0],
  [88000, V.PADOFF, 0, 0, 0, 0, 0],
];
const schedPath = join(out, "schedule.txt");
writeFileSync(schedPath, SCHED.map((c) => c.join(" ")).join("\n") + "\n");

// ------------------------------------------------------------------ JS replay

const { LOOP_TRACKS, LOOP_METER_STRIDE } = await import("../packages/web/public/dsp/core/looper.js");
const { VOICE_METER_STRIDE, CLASS_COUNT } = await import("../packages/web/public/dsp/core/beat-classify.js");
const METER_COUNT = 68 + LOOP_TRACKS * LOOP_METER_STRIDE + 8 + VOICE_METER_STRIDE + 3 + CLASS_COUNT;

function replayJs(block) {
  const rng = { seed: 0x2545f491 };
  const saved = Math.random;
  Math.random = () => {
    rng.seed = xorshift(rng.seed);
    return rng.seed / 4294967296;
  };
  try {
    const e = new Engine(SR, block);
    const types = new Map(); // `${target}:${index}:${id}` -> type name
    const apply = (c) => {
      const [, verb, a, b, cc, d, ee] = c;
      const fx = (target, index, op, fields) => {
        if (target === MASTER) e.applyCommand({ t: op, ...fields });
        else e.applyCommand({ t: target === PAD ? "padfx" : "loopfx", op, index, ...fields });
      };
      switch (verb) {
        case V.ADD: {
          const cmd = { id: d, type: TYPES[cc] };
          types.set(`${a}:${b}:${d}`, TYPES[cc]);
          if (a === MASTER && ee >= 0) cmd.index = ee;
          fx(a, b, "add", cmd);
          break;
        }
        case V.FXPARAM:
          fx(a, b, "param", { id: cc, key: EFFECTS[types.get(`${a}:${b}:${cc}`)].params[d].key, value: ee });
          break;
        case V.MIX: fx(a, b, "mix", { id: cc, value: d }); break;
        case V.BYPASS: fx(a, b, "bypass", { id: cc, value: d }); break;
        case V.IO: e.applyCommand({ t: "io", [IO_NAME[a]]: b }); break;
        case V.PADLOAD: e.applyCommand({ t: "padload", index: a, layer: b, data: inL, frames: cc, rate: d }); break;
        case V.PAD: e.applyCommand({ t: "pad", index: a, vel: b }); break;
        case V.PADPARAM: e.applyCommand({ t: "padparam", index: a, key: backend.PAD_KEY[b], value: cc }); break;
        case V.DRUM: e.applyCommand({ t: "drum", key: backend.DRUM_KEY[a], value: b }); break;
        case V.CLOCK: e.applyCommand({ t: "clock", key: backend.CLOCK_KEY[a], value: b }); break;
        case V.LOOP: e.applyCommand({ t: "loop", op: LOOP_OP[a], index: b }); break;
        case V.LOOPPARAM: e.applyCommand({ t: "loopparam", index: a, key: backend.LOOP_KEY[b], value: cc }); break;
        case V.VOICE: e.applyCommand({ t: "voice", key: backend.VOICE_KEY[a], value: b }); break;
        case V.PADOFF: e.applyCommand({ t: "padoff", index: a }); break;
        default: throw new Error(`verb ${verb}`);
      }
    };
    const oL = new Float32Array(FRAMES);
    const oR = new Float32Array(FRAMES);
    const bl = new Float32Array(block), br = new Float32Array(block);
    const ol = new Float32Array(block), or = new Float32Array(block);
    let next = 0;
    for (let pos = 0; pos < FRAMES; pos += block) {
      const n = Math.min(block, FRAMES - pos);
      while (next < SCHED.length && SCHED[next][0] <= pos) apply(SCHED[next++]);
      bl.set(inL.subarray(pos, pos + n));
      br.set(inR.subarray(pos, pos + n));
      ol.fill(0);
      or.fill(0);
      e.process(bl.subarray(0, n), br.subarray(0, n), ol.subarray(0, n), or.subarray(0, n), n);
      oL.set(ol.subarray(0, n), pos);
      oR.set(or.subarray(0, n), pos);
    }
    const meters = new Array(METER_COUNT).fill(0);
    e.readMeters(meters);
    return { l: oL, r: oR, meters };
  } finally {
    Math.random = saved;
  }
}

// ------------------------------------------------------------------ run and compare

const u32 = new Uint32Array(1);
const f32 = new Float32Array(u32.buffer);
const bits = (x) => ((f32[0] = x), u32[0]);

function runCase(label, bin, block, extraEnv = {}) {
  console.log(`\n${label}: block ${block}`);
  const wav = join(out, `out-${label}-${block}.wav`);
  const met = join(out, `meters-${label}-${block}.bin`);
  const r = spawnSync(bin, [inPath, wav, schedPath, String(block), met], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    maxBuffer: 1 << 24,
  });
  const text = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(text.split("\n").map((l) => (l.trim() ? `    ${l}` : l)).join("\n"));
  if (!ok(`${label} @${block}: native checks pass`, r.status === 0 && text.includes("null driver: PASS"), `exit ${r.status}`)) return;

  const nat = readWav(wav);
  const js = replayJs(block);
  ok(`${label} @${block}: frame count`, nat.l.length === FRAMES && js.l.length === FRAMES);
  let diff = 0, first = -1, peak = 0, nonzero = 0;
  for (let j = 0; j < FRAMES; j++) {
    for (const [a, b] of [[nat.l[j], js.l[j]], [nat.r[j], js.r[j]]]) {
      if (bits(a) !== bits(b)) {
        diff++;
        if (first < 0) first = j;
      }
      if (a !== 0) nonzero++;
      peak = Math.max(peak, Math.abs(a));
    }
  }
  ok(`${label} @${block}: output is not trivially silent`, nonzero > FRAMES && peak > 0.05, `peak ${peak}, ${nonzero} nonzero`);
  ok(`${label} @${block}: every float32 sample bit-identical to the JS engine`, diff === 0, `${diff} differ, first at frame ${first}`);

  const mb = readFileSync(met);
  const nm = mb.length / 8;
  ok(`${label} @${block}: meter block length`, nm === METER_COUNT, `${nm}`);
  let exact = 0, worst = 0, worstAt = -1, nanMismatch = 0;
  for (let i = 0; i < Math.min(nm, METER_COUNT); i++) {
    const a = mb.readDoubleLE(i * 8);
    const b = js.meters[i];
    if (Object.is(a, b)) {
      exact++;
      continue;
    }
    if (Number.isNaN(a) || Number.isNaN(b)) {
      nanMismatch++;
      continue;
    }
    const rel = Math.abs(a - b) / Math.max(1, Math.abs(b));
    if (rel > worst) (worst = rel), (worstAt = i);
  }
  console.log(`    meters: ${exact}/${METER_COUNT} identical (Object.is), worst relative ${worst.toExponential(2)} at [${worstAt}]`);
  ok(`${label} @${block}: meters agree (NaN pattern equal, relative <= 1e-12)`, nanMismatch === 0 && worst <= 1e-12);
  // The schedule must have exercised the composition, or bit-identity proves little.
  const m = js.meters;
  ok(`${label} @${block}: master chain holds 4 slots`, m[12] === 4, `${m[12]}`);
  ok(`${label} @${block}: loop track 0 recorded 48000 frames and is playing`, m[68] === 2 && m[72] === 48000, `state ${m[68]} frames ${m[72]}`);
  ok(`${label} @${block}: clock running, drum route back to DIRECT`, m[100 + 3] === 1 && m[67] === 1);
  return { exact };
}

const results = {};
if (builtOpt) {
  results.o2_128 = runCase("O2", optBin, 128);
  results.o2_480 = runCase("O2", optBin, 480);
}
if (builtSan) {
  results.san_128 = runCase("asan-ubsan", sanBin, 128, {
    ASAN_OPTIONS: "detect_leaks=1:halt_on_error=1",
    UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
  });
}

console.log(fails === 0 ? `\n${checks} checks, 0 failed — null driver: PASS` : `\n${checks} checks, ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
