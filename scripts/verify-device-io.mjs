#!/usr/bin/env node
/**
 * verify-device-io.mjs — Phase 5b gate: the portable half of the real-time driver.
 *
 * Builds packages/native/tests/test-device-io.cc (pcm.h conversions + the duplex pump the
 * WASAPI driver feeds) and runs it:
 *   - optimised, -Wall -Wextra -Werror, with the glibc malloc counter on push/render;
 *   - under address + UB sanitizers;
 *   - cross-built with mingw-w64 and run under Wine, when both are installed — the same
 *     headers compiled by the toolchain family that builds the Windows driver.
 * Then cross-builds tools/brokodr-probe.exe (the WASAPI driver + the whole engine) and, when a
 * PulseAudio server is reachable for Wine (BK_PULSE_RUNTIME, default /tmp/xdg-bk), smoke-runs
 * it: a render-only shared stream must be clean, and a duplex stream at 480 frames must open,
 * clock and see its input start. Wine's capture timing is not Windows'; nothing stricter is
 * claimed from it. Exclusive mode and real hardware are verified only with the probe on the
 * user's machine.
 *
 * Run: node scripts/verify-device-io.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nat = process.env.BK_NATIVE_DIR || join(root, "packages/native");
const out = join(root, "packages/native/build/device-io");
mkdirSync(out, { recursive: true });

let fails = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    fails++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return cond;
};
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const src = join(nat, "tests/test-device-io.cc");
const inc = `-I${join(nat, "include")}`;
const warn = ["-std=c++17", "-Wall", "-Wextra", "-Werror"];

const build = (label, cxx, args) => {
  console.log(`\nbuild: ${label}`);
  const r = spawnSync(cxx, args, { encoding: "utf8" });
  return check(
    `${label} compiles clean (-Wall -Wextra -Werror)`,
    r.status === 0,
    (r.stderr || r.stdout || "").trim().split("\n").slice(0, 12).join("\n"),
  );
};
const run = (label, cmd, args = [], env = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, timeout: 300000 });
  const text = (r.stdout || "") + (r.stderr || "");
  const failLines = text.split("\n").filter((l) => l.includes("FAIL"));
  process.stdout.write(
    text
      .split("\n")
      .map((l) => (l.trim() ? `    ${l}` : l))
      .join("\n"),
  );
  check(`${label}: all checks pass`, r.status === 0 && /device io: PASS/.test(text),
    failLines.length ? failLines.join("; ") : `exit ${r.status}${r.signal ? ` (${r.signal})` : ""}`);
};

const opt = join(out, "test-device-io-O2");
if (build("optimised", "g++", [...warn, "-O2", inc, src, "-o", opt])) run("optimised", opt);

const san = join(out, "test-device-io-asan");
if (build("address + UB sanitizer", "g++", [...warn, "-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all", inc, src, "-o", san]))
  run("address + UB sanitizer", san, [], { UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1" });

const mingw = "x86_64-w64-mingw32-g++-posix";
if (!has(mingw)) {
  console.log(`\n  note: ${mingw} not installed — Windows cross-checks skipped`);
} else {
  const exe = join(out, "test-device-io.exe");
  if (build("mingw-w64", mingw, [...warn, "-O2", "-static", inc, src, "-o", exe])) {
    if (has("wine")) {
      run("mingw-w64 under wine", "wine", [exe], {
        WINEDEBUG: "-all",
        WINEPREFIX: process.env.WINEPREFIX || "/home/user/.wine-bk",
      });
    } else console.log("  note: wine not installed — mingw build not run");
  }
  // brokodr-probe.exe: every DSP translation unit, the driver, the probe.
  const pdir = join(out, "probe");
  mkdirSync(pdir, { recursive: true });
  const objs = [];
  let built = true;
  console.log("\nbuild: brokodr-probe.exe (mingw-w64)");
  const dsp = readdirSync(join(nat, "src/dsp")).filter((f) => f.endsWith(".c"));
  const units = [
    ...dsp.map((f) => ["x86_64-w64-mingw32-gcc-posix", ["-std=c99"], join(nat, "src/dsp", f)]),
    ...["src/wasapi-device.cc", "src/offline-device.cc", "src/wav.cc", "tools/brokodr-probe.cc"].map((f) => [
      mingw, ["-std=c++17"], join(nat, f),
    ]),
  ];
  for (const [cc, std, file] of units) {
    const o = join(pdir, basename(file).replace(/\.(c|cc)$/, ".o"));
    const r = spawnSync(cc, [...std, "-O2", "-Wall", "-Wextra", "-Werror", inc, "-c", file, "-o", o], { encoding: "utf8" });
    if (r.status !== 0) {
      built = check(`${basename(file)} compiles clean`, false, (r.stderr || "").trim().split("\n").slice(0, 8).join("\n"));
      break;
    }
    objs.push(o);
  }
  const exeProbe = join(pdir, "brokodr-probe.exe");
  if (built) {
    const r = spawnSync(mingw, ["-static", "-o", exeProbe, ...objs, "-lole32", "-lavrt", "-luuid", "-loleaut32", "-lksuser"], {
      encoding: "utf8",
    });
    built = check(`all ${units.length} units compile clean (-Werror) and link`, r.status === 0, (r.stderr || "").trim().slice(0, 600));
  }
  const pulse = process.env.BK_PULSE_RUNTIME || "/tmp/xdg-bk";
  if (built && has("wine") && existsSync(join(pulse, "pulse/native"))) {
    console.log(`\nsmoke: brokodr-probe under wine against PulseAudio (${pulse})`);
    const env = { ...process.env, XDG_RUNTIME_DIR: pulse, WINEDEBUG: "-all", WINEPREFIX: process.env.WINEPREFIX || "/home/user/.wine-bk" };
    const probe = (args) => {
      const r = spawnSync("wine", [exeProbe, ...args], { encoding: "utf8", env, timeout: 120000 });
      return { rc: r.status, text: (r.stdout || "") + (r.stderr || "") };
    };
    const field = (text, name) => (text.match(new RegExp(`^\\s+${name}\\s+(.*)$`, "m")) || [])[1] || "";
    const list = probe(["--list"]);
    const outs = (list.text.match(/^\s+\[\s*\d+\] out /gm) || []).length;
    const ins = (list.text.match(/^\s+\[\s*\d+\] in /gm) || []).length;
    check("probe --list enumerates input and output endpoints", list.rc === 0 && outs > 0 && ins > 0, `${ins} in, ${outs} out, rc ${list.rc}`);
    const ro = probe(["--in", "none", "--mode", "shared", "--frames", "128", "--seconds", "2"]);
    check("render-only shared @128: opens, clean", ro.rc === 0 && /verdict\s+clean/.test(ro.text),
      `${field(ro.text, "mode")}; ${field(ro.text, "underruns")} underruns; ${field(ro.text, "verdict")}`);
    const ex = probe(["--in", "none", "--mode", "exclusive", "--frames", "128", "--seconds", "1"]);
    check("exclusive refused by the endpoint -> falls back to shared, reason stated",
      ex.rc === 0 && /REFUSED/.test(ex.text) && /fell back to shared: \S/.test(ex.text), field(ex.text, "mode"));
    const dx = probe(["--mode", "shared", "--frames", "480", "--seconds", "4", "--fx", "eq,comp,delay"]);
    const cb = Number(field(dx.text, "callbacks").split(" ")[0] || 0);
    check("duplex shared @480 with effects: opens, clocks, input starts",
      dx.rc === 0 && cb > 300 && /input start\s+started/.test(dx.text),
      `${cb} callbacks; input ${field(dx.text, "input start")}; ${field(dx.text, "verdict")}`);
    const bad = probe(["--fx", "bogus", "--mode", "shared", "--seconds", "1"]);
    check("a bad effect name is refused before opening", /FAIL engine: unknown effect 'bogus'/.test(bad.text) && bad.rc !== 0);
  } else if (built) {
    console.log(`  note: no wine or no PulseAudio at ${pulse} — probe built, not run`);
  }
}

console.log(fails === 0 ? "\ndevice io: PASS" : `\ndevice io: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
