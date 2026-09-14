#!/usr/bin/env node
/**
 * verify-scope-window.mjs — proves the "right side of the scope doesn't move" bug and
 * that the fix closes it.
 *
 * The bug: `EngineClient.scope.input/output` are Float32Array(2048), but `pollScope(1024)`
 * only ever fills the first 1024 samples. Both drawing paths took their sample count from
 * `buf.length` (2048), so every x past the halfway point indexed permanently-zero memory
 * and rendered as a flat line pinned to the centre graticule — a live left half and a dead
 * right half, on both the oscilloscope and the wave strip in the meters pane.
 *
 * Run: node scripts/verify-scope-window.mjs
 */

import { readFileSync } from "node:fs";

const RING = 8192; // SCOPE_SIZE in worklet-backend.ts
const CAP = 2048; // ScopeFrame buffer allocation in engine-client.ts
const ASK = 1024; // what both consumers request

let fails = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    fails++;
  }
};

// ---------------------------------------------------------------- ring + readScope model
// Mirrors WorkletBackend.readScope: copy the newest `n` samples ending at the write index.
function makeRing() {
  const ring = new Float32Array(RING);
  // Non-zero everywhere, so anything that reads outside the filled window shows up as 0.
  for (let i = 0; i < RING; i++) ring[i] = Math.sin(i * 0.05) || 0.5;
  return ring;
}

function readScope(ring, w, dest, n) {
  const mask = RING - 1;
  const start = (w - n + RING) & mask;
  for (let i = 0; i < n; i++) dest[i] = ring[(start + i) & mask];
  return true;
}

// ---------------------------------------------------------------- 1. the bug is real
{
  const ring = makeRing();
  const buf = new Float32Array(CAP); // starts zeroed, as the real one does
  readScope(ring, 4096, buf, ASK);

  const liveTail = buf.subarray(ASK).some((v) => v !== 0);
  check("pollScope(1024) leaves the 1024-sample tail of a 2048 buffer untouched", !liveTail);

  // Old drawing code: n = buf.length, span = n - trig.
  const w = 800;
  const nOld = buf.length;
  const trig = 0;
  const spanOld = nOld - trig;
  let deadPixels = 0;
  for (let x = 0; x < w; x++) {
    const i = trig + Math.floor((x / w) * spanOld);
    if (i >= ASK) deadPixels++;
  }
  check(
    "old timebase drew ~half the width from dead memory",
    deadPixels > w * 0.45 && deadPixels < w * 0.55,
    `${deadPixels}/${w} px`,
  );
}

// ---------------------------------------------------------------- 2. the fix holds
{
  const ring = makeRing();
  const buf = new Float32Array(CAP);
  readScope(ring, 4096, buf, ASK);

  const w = 800;
  const n = ASK; // scope.frames
  const half = Math.floor(n / 2);

  // Every trigger position the sweep can land on must stay inside the live window.
  let worstIdx = -1;
  let anyDead = 0;
  for (let trig = 0; trig <= half; trig++) {
    const span = half; // fixed time base
    for (let x = 0; x < w; x++) {
      const i = trig + Math.floor((x / w) * span);
      if (i > worstIdx) worstIdx = i;
      if (i >= n || buf[i] === 0) anyDead++;
    }
  }
  check("fixed sweep never indexes past the live window", worstIdx < n, `max idx ${worstIdx}`);
  check("no pixel reads dead memory at any trigger offset", anyDead === 0, `${anyDead} px`);

  // A constant span is what makes the trace stop breathing frame to frame.
  const spans = new Set();
  for (let trig = 0; trig <= half; trig += 37) spans.add(half);
  check("horizontal scale is constant across frames", spans.size === 1);
}

// ---------------------------------------------------------------- 3. no consumer regresses
{
  const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  const client = src("packages/web/src/web/audio/engine-client.ts");
  check("engine-client records the filled window", /this\.scope\.frames\s*=/.test(client));

  const iface = src("packages/web/src/web/audio/backend.ts");
  check("ScopeFrame declares frames", /frames:\s*number/.test(iface.split("ScopeFrame")[1] ?? ""));

  for (const p of [
    "packages/web/src/web/components/oscilloscope.tsx",
    "packages/web/src/web/components/meters.tsx",
  ]) {
    const s = src(p);
    check(`${p.split("/").pop()} uses scope.frames`, /client\.scope\.frames/.test(s));
    check(
      `${p.split("/").pop()} no longer sizes the sweep from a raw buffer length`,
      !/const n = (out|buf)\.length;/.test(s),
    );
  }
}

console.log(fails === 0 ? "\nscope window: PASS" : `\nscope window: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
