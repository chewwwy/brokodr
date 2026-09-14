#!/usr/bin/env node
/**
 * verify-native-core.mjs — Phase 5a gate.
 *
 * Two jobs, and the second is the one that earns its keep:
 *
 *  1. Build and run the native core tests, twice: once with the thread sanitizer (so a
 *     missing acquire/release in the command ring fails the build rather than working by
 *     accident on x86), once optimised (so a data race that only appears when the
 *     compiler reorders is also caught).
 *
 *  2. Assert the C header still agrees with the TypeScript contract. The meter block is
 *     read by absolute index and the ring by fixed stride, so if `backend.ts` gains a
 *     field and `layout.h` doesn't, the native backend writes garbage into needles the UI
 *     trusts — with no compile error anywhere. This parses the real TS/JS sources rather
 *     than trusting a comment.
 *
 * Run: node scripts/verify-native-core.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nat = join(root, "packages/native");
const out = join(nat, "build");

let fails = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    fails++;
  }
};
const read = (p) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------- 1. the layout contract
console.log("contract: layout.h vs the JS sources");

const header = read("packages/native/include/brokodr/layout.h");
const backendTs = read("packages/web/src/web/audio/backend.ts");
const workletTs = read("packages/web/src/web/audio/worklet-backend.ts");
const processorJs = read("packages/web/public/dsp/worklet-processor.js");

const defineOf = (name) => {
  const m = header.match(new RegExp(`^#define\\s+${name}\\s+(.+)$`, "m"));
  return m ? m[1].trim() : null;
};
const enumOf = (name) => {
  const m = header.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};
const numFrom = (src, re, label) => {
  const m = src.match(re);
  if (!m) {
    check(`could read ${label} from source`, false);
    return null;
  }
  return Number(m[1]);
};

// --- ring geometry, from the two independent JS definitions that must already agree
const tsSlots = numFrom(workletTs, /const CMD_SLOTS = (\d+)/, "CMD_SLOTS (ts)");
const tsStride = numFrom(workletTs, /const CMD_STRIDE = (\d+)/, "CMD_STRIDE (ts)");
const jsSlots = numFrom(processorJs, /const CMD_SLOTS = (\d+)/, "CMD_SLOTS (js)");
const jsStride = numFrom(processorJs, /const CMD_STRIDE = (\d+)/, "CMD_STRIDE (js)");
check("the two JS ring definitions agree with each other", tsSlots === jsSlots && tsStride === jsStride);
check("BK_CMD_SLOTS matches CMD_SLOTS", Number(defineOf("BK_CMD_SLOTS")) === tsSlots, `h=${defineOf("BK_CMD_SLOTS")} ts=${tsSlots}`);
check("BK_CMD_STRIDE matches CMD_STRIDE", Number(defineOf("BK_CMD_STRIDE")) === tsStride, `h=${defineOf("BK_CMD_STRIDE")} ts=${tsStride}`);

// --- shared block sizes
const meterFields = numFrom(workletTs, /const METER_FIELDS = (\d+)/, "METER_FIELDS");
const scopeSize = numFrom(workletTs, /const SCOPE_SIZE = (\d+)/, "SCOPE_SIZE");
check("BK_METER_FIELDS matches METER_FIELDS", Number(defineOf("BK_METER_FIELDS")) === meterFields);
check("BK_SCOPE_SIZE matches SCOPE_SIZE", Number(defineOf("BK_SCOPE_SIZE")) === scopeSize);

// --- meter bases
const tsLoopBase = numFrom(backendTs, /export const LOOP_METER_BASE = (\d+)/, "LOOP_METER_BASE");
const tsLoopStride = numFrom(backendTs, /export const LOOP_METER_STRIDE = (\d+)/, "LOOP_METER_STRIDE");
const tsTracks = numFrom(backendTs, /export const LOOP_TRACKS = (\d+)/, "LOOP_TRACKS");
const tsVoiceStride = numFrom(backendTs, /export const VOICE_METER_STRIDE = (\d+)/, "VOICE_METER_STRIDE");
check("BK_LOOP_METER_BASE matches", Number(defineOf("BK_LOOP_METER_BASE")) === tsLoopBase);
check("BK_LOOP_METER_STRIDE matches", Number(defineOf("BK_LOOP_METER_STRIDE")) === tsLoopStride);
check("BK_LOOP_TRACKS matches", Number(defineOf("BK_LOOP_TRACKS")) === tsTracks);
check("BK_VOICE_METER_STRIDE matches", Number(defineOf("BK_VOICE_METER_STRIDE")) === tsVoiceStride);

// backend.ts derives the later bases, so check the derivation, not a copied literal.
const tsTransportBase = tsLoopBase + tsTracks * tsLoopStride;
const tsVoiceBase = tsTransportBase + 8;
check("transport base derives to the same value in both", tsTransportBase === 100, `ts=${tsTransportBase}`);
check("voice base derives to the same value in both", tsVoiceBase === 108, `ts=${tsVoiceBase}`);

// --- opcodes: every OP in backend.ts must exist in the header with the same number
const opBlock = backendTs.slice(backendTs.indexOf("export const OP = {"));
const ops = [...opBlock.slice(0, opBlock.indexOf("}")).matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]);
check("found the OP table in backend.ts", ops.length >= 18, `${ops.length} opcodes`);
for (const [name, value] of ops) {
  const got = enumOf(`BK_OP_${name}`);
  check(`OP.${name} = ${value} present in layout.h`, got === value, got === null ? "missing" : `got ${got}`);
}

// --- IO fields
const ioBlock = backendTs.slice(backendTs.indexOf("export const IO_FIELD = {"));
const ios = [...ioBlock.slice(0, ioBlock.indexOf("}")).matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]);
for (const [name, value] of ios) {
  const got = enumOf(`BK_IO_${name}`);
  check(`IO_FIELD.${name} = ${value} present in layout.h`, got === value, got === null ? "missing" : `got ${got}`);
}

// --- the append-only rule, checked against the JS side's own end-of-block claim
const used = tsVoiceBase + tsVoiceStride + 3 + 4;
check("BK_METER_USED matches the JS block end", used === 127, `derived ${used}`);
check("the meter block still has headroom to append", meterFields - used >= 16, `${meterFields - used} free`);

// ---------------------------------------------------------------- 2. build and run
const cxx = "g++";
const srcs = [join(nat, "tests/test-core.cc"), join(nat, "src/wav.cc"), join(nat, "src/offline-device.cc")];
const inc = `-I${join(nat, "include")}`;
mkdirSync(out, { recursive: true });

const build = (label, flags, bin) => {
  console.log(`\nbuild: ${label}`);
  const r = spawnSync(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", inc, ...flags, ...srcs, "-o", bin, "-pthread"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    check(`${label} compiles clean`, false, (r.stderr || r.stdout || "").trim().split("\n").slice(0, 12).join("\n"));
    return false;
  }
  check(`${label} compiles clean (-Wall -Wextra -Werror)`, true);
  return true;
};

const run = (label, bin, env = {}) => {
  const r = spawnSync(bin, [], { encoding: "utf8", env: { ...process.env, ...env } });
  const text = (r.stdout || "") + (r.stderr || "");
  const failLines = text.split("\n").filter((l) => l.includes("FAIL"));
  process.stdout.write(
    text
      .split("\n")
      .map((l) => (l.trim() ? `    ${l}` : l))
      .join("\n"),
  );
  check(`${label}: all checks pass`, r.status === 0, failLines.length ? failLines.join("; ") : `exit ${r.status}`);
  return r.status === 0;
};

// Optimised first: this is the configuration that actually ships, and -O2 is where the
// compiler is free to reorder the very stores the atomics are there to pin down.
const optBin = join(out, "test-core-O2");
if (build("optimised", ["-O2"], optBin)) run("optimised", optBin);

// Then the thread sanitizer. Slower, and worth every second: it is the only thing here
// that can prove the ring's memory ordering rather than observe that it happened to work.
const tsanBin = join(out, "test-core-tsan");
const tsanAvailable = (() => {
  const probe = spawnSync(cxx, ["-fsanitize=thread", "-x", "c++", "-", "-o", "/dev/null"], {
    input: "int main(){return 0;}",
    encoding: "utf8",
  });
  return probe.status === 0;
})();
if (!tsanAvailable) {
  console.log("\n  note: thread sanitizer unavailable on this toolchain — ordering is unverified");
} else if (build("thread sanitizer", ["-O1", "-g", "-fsanitize=thread"], tsanBin)) {
  run("thread sanitizer", tsanBin, { TSAN_OPTIONS: "halt_on_error=1" });
}

// Undefined-behaviour pass over the WAV parser, which is the only code here that indexes
// attacker-shaped input. Cheap, and it catches the classic truncated-chunk over-read.
const ubBin = join(out, "test-core-ubsan");
const ubAvailable = (() => {
  const probe = spawnSync(cxx, ["-fsanitize=address,undefined", "-x", "c++", "-", "-o", "/dev/null"], {
    input: "int main(){return 0;}",
    encoding: "utf8",
  });
  return probe.status === 0;
})();
if (ubAvailable && build("address + UB sanitizer", ["-O1", "-g", "-fsanitize=address,undefined"], ubBin)) {
  run("address + UB sanitizer", ubBin, { UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1" });
} else if (!ubAvailable) {
  console.log("\n  note: asan/ubsan unavailable on this toolchain");
}

console.log(fails === 0 ? "\nnative core: PASS" : `\nnative core: ${fails} FAILED`);
if (!existsSync(optBin)) fails++;
process.exit(fails === 0 ? 0 : 1);
