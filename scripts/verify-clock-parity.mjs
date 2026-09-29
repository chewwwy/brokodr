/**
 * Parity oracle for the C port of dsp/core/clock.js (Phase 5, route (c)).
 *
 * Same four steps as the other verify-*-parity.mjs scripts, on the shared
 * plumbing in scripts/lib/parity-stream.mjs:
 *
 *   1. build the C natively and run the battery;
 *   2. build the same source to wasm with emscripten and run it under Node;
 *   3. replay the identical battery through the original clock.js;
 *   4. diff native against wasm.
 *
 * The battery lives in packages/native/tests/parity-clock.c and only there.
 * Every case parameter travels in the dump, and the sweeps that are arrays in
 * the C (the beats list, the probe frames) travel in the payload next to their
 * results, so this file reads the battery back out rather than keeping a copy
 * of it. Two things are unavoidably mirrored here — the opcode numbers and the
 * mid-run events in the `advance` battery — and both are asserted against the
 * C source text in the sanity section, so a mirror that drifts fails loudly
 * instead of quietly testing a different thing on each side.
 *
 * clock.js imports only `clamp` from utils.js, so unlike the chain and
 * drum-rack runners this one imports the shipping module directly: there is no
 * probe copy and nothing patched. What you see diffed is the file the web
 * build loads.
 *
 * The bar for this module is bit-identity, not a tolerance. Nothing in clock.c
 * touches libm beyond floor and fmod, both of which are exactly-rounded by
 * IEEE-754 rather than by a vendor's best effort, and every reading is a
 * single evaluation with nothing to accumulate. So a tolerance pass with an
 * identity drop here is a real behavioural difference, not libm spread — which
 * is exactly why the identity baselines below are pinned at the full record
 * count.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOL,
  buildAndRun,
  compareToJs,
  compareToolchains,
  createChecker,
  describe,
  firstDiff,
  maxRel,
} from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

const { native, wasm } = buildAndRun({
  root,
  name: "parity-clock",
  include: join(root, "packages/native/include"),
  sources: [
    join(root, "packages/native/src/dsp/utils.c"),
    join(root, "packages/native/src/dsp/clock.c"),
    join(root, "packages/native/tests/parity-clock.c"),
  ],
  ok,
  state,
});

console.log(`\n   ${native.length} records in the battery`);

// ---------------------------------------------------------------------------
// the JS under test — the shipping module, unmodified
// ---------------------------------------------------------------------------

const js = await import("../packages/web/public/dsp/core/clock.js");
const cSrc = readFileSync(join(root, "packages/native/tests/parity-clock.c"), "utf8");

/**
 * Param key indices. Matches CLOCK_KEY in packages/web/src/web/audio/backend.ts
 * and BK_CLOCK_P_* in the generated param-keys.h; the sanity section asserts
 * this copy against both, so it cannot drift from either.
 */
const CLOCK_KEY = ["bpm", "beatsPerBar", "quantize", "run", "reset"];

/** Mirror of the opcode enum in parity-clock.c. Asserted against it below. */
const OP = {
  END: 0,
  INIT: 1,
  PARAM: 2,
  ADVANCE: 3,
  RESET: 4,
  SNAP: 5,
  TOGRID: 6,
  FORBEATS: 7,
  FRAME: 8,
};
const OPW = 3;

/**
 * Mirror of push_state() in parity-clock.c, and the field-order contract with
 * it: twelve numbers, the eight fields then the four derived getters, in this
 * order. A field added on one side and not the other changes the payload
 * length, which the diff reports as a total mismatch rather than a shift.
 */
const SNAP = 12;
function snapState(c, out) {
  out.push(c.sr);
  out.push(c.bpm);
  out.push(c.beatsPerBar);
  out.push(c.quantize);
  out.push(c.frame);
  out.push(c.running ? 1 : 0);
  out.push(c.framesPerBeat);
  out.push(c.gridFrames);
  out.push(c.barFrames);
  out.push(c.beat);
  out.push(c.bar);
  out.push(c.barPhase);
}

const f64 = (arr) => Float64Array.from(arr);

// ---------------------------------------------------------------------------
// references
// ---------------------------------------------------------------------------

const REF = {
  init(rec) {
    const out = [];
    snapState(new js.Clock(rec.params[0]), out);
    return { out64: f64(out) };
  },

  /** The four real setters. The C advances first, so a setter that touched the
      counter shows up rather than hiding behind frame 0. */
  setter(rec) {
    const [sr, key, value] = rec.params;
    const c = new js.Clock(sr);
    c.advance(12345);
    c.setParam(CLOCK_KEY[key | 0], value);
    const out = [];
    snapState(c, out);
    out.push(c.framesToGrid(c.frame));
    out.push(c.framesToGrid(0));
    out.push(c.framesToGrid(1));
    return { out64: f64(out) };
  },

  "setParam.unknown"(rec) {
    const [key, value] = rec.params;
    const c = new js.Clock(48000);
    c.advance(999);
    // The C passes an out-of-range integer, which hits no case; the JS
    // equivalent is a string that is not a key. Both must be no-ops.
    c.setParam(CLOCK_KEY[key | 0] ?? `unknown:${key}`, value);
    const out = [];
    snapState(c, out);
    return { out64: f64(out) };
  },

  /** Rows of 3 + 2 * n_b: bpm, framesPerBeat, gridFrames, then (beats, result)
      pairs. Everything the C swept travels in the payload. */
  grid(rec) {
    const [sr, quantize, nB] = rec.params;
    const stride = 3 + 2 * nB;
    const c = new js.Clock(sr);
    c.setParam("quantize", quantize);
    const out = [];
    for (let o = 0; o + stride <= rec.out64.length; o += stride) {
      const bpm = rec.out64[o];
      c.setParam("bpm", bpm);
      out.push(bpm);
      out.push(c.framesPerBeat);
      out.push(c.gridFrames);
      for (let j = 0; j < nB; j++) {
        const beats = rec.out64[o + 3 + j * 2];
        out.push(beats);
        out.push(c.framesForBeats(beats));
      }
    }
    return { out64: f64(out) };
  },

  /** Pairs of (frame, framesToGrid(frame)); the frames travel in the payload. */
  framesToGrid(rec) {
    const [quantize, bpm] = rec.params;
    const c = new js.Clock(48000);
    c.setParam("quantize", quantize);
    c.setParam("bpm", bpm);
    const out = [];
    for (let o = 0; o + 2 <= rec.out64.length; o += 2) {
      const frame = rec.out64[o];
      out.push(frame);
      out.push(c.framesToGrid(frame));
    }
    return { out64: f64(out) };
  },

  /**
   * Mirror of the advance battery's loop, mid-run events included. The event
   * block numbers (200 stop, 250 start, 400 reset) are asserted against the C
   * source in the sanity section.
   */
  advance(rec) {
    const [block, bpm, bpb, nBlock] = rec.params;
    const c = new js.Clock(48000);
    c.setParam("bpm", bpm);
    c.setParam("beatsPerBar", bpb);
    const out = [];
    for (let t = 0; t < nBlock; t++) {
      if (t === 200) c.setParam("run", 0);
      if (t === 250) c.setParam("run", 1);
      if (t === 400) c.setParam("reset", 0);
      c.advance(block);
      out.push(c.frame);
      out.push(c.beat);
      out.push(c.bar);
      out.push(c.barPhase);
      out.push(c.framesToGrid(c.frame));
    }
    return { out64: f64(out) };
  },

  /** Rows of 4: the frame is written straight into the counter and travels in
      the payload, so the huge values need no replay of a million advances. */
  barPhase(rec) {
    const c = new js.Clock(48000);
    c.setParam("bpm", rec.params[0]);
    const out = [];
    for (let o = 0; o + 4 <= rec.out64.length; o += 4) {
      const frame = rec.out64[o];
      c.frame = frame;
      out.push(frame);
      out.push(c.beat);
      out.push(c.bar);
      out.push(c.barPhase);
    }
    return { out64: f64(out) };
  },

  /** Mirror of run_script(). The script itself is the record's params. */
  script(rec) {
    const ops = rec.params;
    let c = new js.Clock(48000);
    const out = [];
    for (let i = 0; i + OPW <= ops.length; i += OPW) {
      const op = ops[i] | 0;
      const a = ops[i + 1];
      if (op === OP.END) break;
      else if (op === OP.INIT) c = new js.Clock(a);
      else if (op === OP.PARAM) c.setParam(CLOCK_KEY[a | 0] ?? `unknown:${a}`, ops[i + 2]);
      else if (op === OP.ADVANCE) c.advance(a);
      else if (op === OP.RESET) c.reset();
      else if (op === OP.SNAP) snapState(c, out);
      else if (op === OP.TOGRID) out.push(c.framesToGrid(a));
      else if (op === OP.FORBEATS) out.push(c.framesForBeats(a));
      else if (op === OP.FRAME) c.frame = a;
    }
    snapState(c, out);
    return { out64: f64(out) };
  },
};

const SETTERS = ["setParam.bpm", "setParam.beatsPerBar", "setParam.quantize", "setParam.run"];

function reference(rec) {
  const fn = SETTERS.includes(rec.name) ? REF.setter : REF[rec.name];
  if (!fn) throw new Error(`no JS reference for record "${rec.name}"`);
  return fn(rec);
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

const NAMES = new Set([...SETTERS, ...Object.keys(REF).filter((k) => k !== "setter")]);
ok(
  "every record has a JS reference",
  native.every((r) => NAMES.has(r.name)),
  [...new Set(native.map((r) => r.name))].join(", "),
);

/*
 * Every reading in this module is a single evaluation of arithmetic on a frame
 * counter — a grid length, a beat position, a distance to a boundary. None of
 * it accumulates, so the -120 dBFS sample bar the audio modules use is the
 * wrong bar here: it would pass a gridFrames that was a whole frame out at
 * 8 kHz. These get the relative bar instead, which is what the delay-line
 * runner does for its sizing cases and for the same reason.
 */
function relativeChecks(dump, label) {
  console.log(`\n== ${label} vs clock.js, at the relative bar (${TOL.scalar.toExponential(0)}) ==`);
  let worst = 0;
  let offender = "";
  let bad = 0;
  for (const rec of dump) {
    const ref = reference(rec).out64;
    const d = maxRel(ref, rec.out64);
    if (d > worst) (worst = d), (offender = describe(rec));
    if (d > TOL.scalar) {
      bad++;
      if (bad <= 8) {
        console.log(
          `  FAIL ${describe(rec)} rel=${d.toExponential(2)} first diff at index ${firstDiff(ref, rec.out64)}`,
        );
      }
    }
  }
  ok(`${label}: every reading agrees relatively`, bad === 0, `worst rel ${worst.toExponential(2)}${offender ? ` (${offender})` : ""}`);
}

relativeChecks(native, "native");

// Bit-identity baselines, pinned at the full record count. See the note at the
// top: there is no libm in this module beyond floor and fmod, so anything less
// than total identity is a real difference and not toolchain spread.
const IDENTITY = native.length;

compareToJs({ name: "native", dump: native, reference, ok, expectIdentical: IDENTITY });

if (wasm) {
  relativeChecks(wasm, "wasm");
  compareToJs({ name: "wasm", dump: wasm, reference, ok, expectIdentical: IDENTITY });
  compareToolchains({ native, wasm, ok, expectIdentical: IDENTITY });
}

// ---------------------------------------------------------------------------
// sanity: the battery has to actually exercise the code
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises clock.js ==");
{
  const names = new Set(native.map((r) => r.name));
  const missing = [...NAMES].filter((n) => !names.has(n));
  ok("every battery appears in the dump", missing.length === 0, missing.length ? `missing: ${missing}` : `${names.size} distinct`);

  // -- the two mirrors in this file, checked against the C source ------------
  for (const [name, value] of Object.entries(OP)) {
    const m = cSrc.match(new RegExp(`OP_${name}\\s*=\\s*(\\d+)`));
    ok(`OP_${name} mirrors the C`, m !== null && Number(m[1]) === value, m ? `${m[1]} vs ${value}` : "not found in parity-clock.c");
  }
  {
    const m = cSrc.match(/#define OPW (\d+)/);
    ok("the op row width mirrors the C", m !== null && Number(m[1]) === OPW, m ? `${m[1]} vs ${OPW}` : "not found");
  }
  {
    const m = cSrc.match(/#define BK_CLOCK_SNAP (\d+)/);
    ok("the snapshot width mirrors the C", m !== null && Number(m[1]) === SNAP, m ? `${m[1]} vs ${SNAP}` : "not found");
  }
  {
    // The three mid-run events in the advance battery. If the C moves one and
    // this file does not, both sides still "pass" while testing different
    // runs — so pin the block numbers, not just their existence.
    const events = [...cSrc.matchAll(/if \(t == (\d+)\) bk_clock_set_param\(&c, (BK_CLOCK_P_\w+), ([\d.]+)\)/g)].map(
      (m) => `${m[1]}:${m[2]}:${Number(m[3])}`,
    );
    const expect = ["200:BK_CLOCK_P_RUN:0", "250:BK_CLOCK_P_RUN:1", "400:BK_CLOCK_P_RESET:0"];
    ok(
      "the advance battery's mid-run events mirror the C",
      events.length === expect.length && events.every((e, i) => e === expect[i]),
      events.join(", "),
    );
  }

  // -- the key table is not allowed to drift from its two sources ------------
  {
    const hdr = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
    const ts = readFileSync(join(root, "packages/web/src/web/audio/backend.ts"), "utf8");
    const fromHeader = [...hdr.matchAll(/BK_CLOCK_P_([A-Z_]+) = (\d+)/g)]
      .filter((m) => m[1] !== "COUNT")
      .sort((x, y) => Number(x[2]) - Number(y[2]))
      .map((m) => m[1].toLowerCase().replace(/_/g, ""));
    const normalised = CLOCK_KEY.map((k) => k.toLowerCase());
    ok(
      "CLOCK_KEY matches the generated param-keys.h",
      fromHeader.length === normalised.length && fromHeader.every((k, i) => k === normalised[i]),
      `${fromHeader.join(",")} vs ${normalised.join(",")}`,
    );
    const block = ts.match(/export const CLOCK_KEY = \[([\s\S]*?)\]/);
    const fromTs = block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    ok(
      "CLOCK_KEY matches backend.ts, the source of truth",
      fromTs.length === CLOCK_KEY.length && fromTs.every((k, i) => k === CLOCK_KEY[i]),
      fromTs.join(","),
    );
  }

  // -- MIN_BPM / MAX_BPM and the quantise table, C vs JS --------------------
  {
    const minB = cSrc.includes("BK_CLOCK_P_BPM") ? null : null; // (the header holds these)
    const hdr = readFileSync(join(root, "packages/native/include/brokodr/dsp/clock.h"), "utf8");
    const def = (n) => {
      const m = hdr.match(new RegExp(`#define ${n} ([\\d.]+)`));
      return m ? Number(m[1]) : NaN;
    };
    ok("BK_MIN_BPM equals MIN_BPM", def("BK_MIN_BPM") === js.MIN_BPM, `${def("BK_MIN_BPM")} vs ${js.MIN_BPM}`);
    ok("BK_MAX_BPM equals MAX_BPM", def("BK_MAX_BPM") === js.MAX_BPM, `${def("BK_MAX_BPM")} vs ${js.MAX_BPM}`);
    void minB;
    const cSrcClock = readFileSync(join(root, "packages/native/src/dsp/clock.c"), "utf8");
    const table = cSrcClock.match(/bk_quantize_choices\[BK_QUANTIZE_CHOICE_COUNT\] = \{([\s\S]*?)\}/);
    const vals = table ? [...table[1].matchAll(/-?[\d.]+/g)].map((m) => Number(m[0])) : [];
    ok(
      "bk_quantize_choices equals QUANTIZE_CHOICES",
      vals.length === js.QUANTIZE_CHOICES.length && vals.every((v, i) => v === js.QUANTIZE_CHOICES[i]),
      `${vals.join(",")} vs ${js.QUANTIZE_CHOICES.join(",")}`,
    );
  }

  // -- the battery reaches the branches that matter -------------------------
  const setters = native.filter((r) => SETTERS.includes(r.name));
  const keysHit = new Set(setters.map((r) => r.params[1]));
  const unused = CLOCK_KEY.filter((_, i) => !keysHit.has(i) && i !== 4);
  ok("every real setter key is swept", unused.length === 0, unused.length ? `unused: ${unused}` : `${keysHit.size} keys`);
  ok(
    "the reset key is exercised (in the scripts, where it means anything)",
    native.some((r) => r.name === "script" && [...r.params].some((v, i) => i % OPW === 1 && r.params[i - 1] === OP.PARAM && v === 4)),
  );
  ok("an unknown key is exercised", native.some((r) => r.name === "setParam.unknown"));

  // Non-finite inputs must actually be in the sweep: they are the class where
  // a "tidier" clamp silently disagrees, and where an int field would have
  // been undefined behaviour.
  const nonFinite = setters.filter((r) => !Number.isFinite(r.params[2]));
  ok("NaN and both infinities reach the setters", nonFinite.length >= 3, `${nonFinite.length} cases`);
  const nanQuantize = setters.filter((r) => r.params[1] === 2 && Number.isNaN(r.params[2]));
  ok("a NaN quantize is swept", nanQuantize.length > 0, `${nanQuantize.length} cases`);

  // The clamps must be crossed at both ends, or the clamp could be missing.
  const bpms = setters.filter((r) => r.params[1] === 0).map((r) => r.params[2]);
  ok(
    "the bpm sweep crosses both clamps",
    bpms.some((v) => v < js.MIN_BPM) && bpms.some((v) => v > js.MAX_BPM),
    `${Math.min(...bpms.filter(Number.isFinite))} .. ${Math.max(...bpms.filter(Number.isFinite))}`,
  );
  const quants = setters.filter((r) => r.params[1] === 2).map((r) => r.params[2]);
  ok(
    "the quantize sweep straddles the 0 test and the 0.0625 floor",
    quants.some((v) => v <= 0) && quants.some((v) => v > 0 && v < 0.0625) && quants.some((v) => v > 64),
    `${quants.length} values`,
  );

  // framesToGrid's contract, read off the dump rather than re-derived: on an
  // active grid it never returns 0, and it returns exactly the grid when the
  // frame sits on a boundary. This is the check the looper's punch timing
  // rests on, so it is asserted here and not left to the diff.
  {
    let probes = 0;
    let zeros = 0;
    let offGrid = 0;
    let onBoundary = 0;
    // Negative frames are a different regime and the reason is fmod, not a bug:
    // `-1 % 100` is -1 in both JS and C, so the answer is g - (-1) = g + 1, a
    // whole grid PLUS the distance back to the boundary. The looper never asks
    // for a negative frame (the counter starts at 0 and only advances), but the
    // sign rule is pinned because a port reaching for an integer modulo, or for
    // a floored modulo, would land somewhere else. So the "never more than a
    // whole grid" contract is asserted over the frames the looper can actually
    // produce, and the negative side gets its own check below.
    let negProbes = 0;
    let negWrong = 0;
    for (const rec of native.filter((r) => r.name === "framesToGrid")) {
      const [quantize, bpm] = rec.params;
      const c = new js.Clock(48000);
      c.setParam("quantize", quantize);
      c.setParam("bpm", bpm);
      const g = c.gridFrames;
      for (let o = 0; o + 2 <= rec.out64.length; o += 2) {
        const frame = rec.out64[o];
        const got = rec.out64[o + 1];
        if (g <= 0) {
          if (got !== 0) offGrid++;
          continue;
        }
        if (!Number.isFinite(frame)) continue;
        if (frame < 0) {
          negProbes++;
          if (got !== g - (frame % g)) negWrong++;
          continue;
        }
        probes++;
        if (got === 0) zeros++;
        if (got > g) offGrid++;
        if (Number.isInteger(frame / g)) {
          onBoundary++;
          if (got !== g) offGrid++;
        }
      }
    }
    ok("an off grid always answers 0", true, "checked below with the rest");
    ok("framesToGrid never returns 0 on an active grid", zeros === 0, `${probes} probes`);
    ok("framesToGrid never returns more than a whole grid", offGrid === 0, `${probes} probes`);
    ok("frames sitting exactly on a boundary are in the sweep", onBoundary > 0, `${onBoundary} probes`);
    ok("negative frames follow fmod's sign rule, not a floored modulo", negProbes > 0 && negWrong === 0, `${negProbes} probes, ${negWrong} wrong`);
  }

  // The grid battery's whole point is Math.round on the .5 boundary. Prove the
  // sweep actually lands there, or the round is untested.
  {
    let halves = 0;
    let floored = 0;
    let beatFloored = 0;
    for (const rec of native.filter((r) => r.name === "grid")) {
      const [sr, quantize, nB] = rec.params;
      const stride = 3 + 2 * nB;
      for (let o = 0; o + stride <= rec.out64.length; o += stride) {
        const fpb = rec.out64[o + 1];
        const grid = rec.out64[o + 2];
        const exact = quantize * fpb;
        if (quantize > 0 && Math.abs(exact - Math.floor(exact) - 0.5) < 1e-9) halves++;
        if (quantize > 0 && grid === 1 && exact < 1) floored++;
        // framesForBeats reaches the same floor from the other direction, and at
        // every sample rate: beats 0 and the negative beats in the sweep round
        // to 0 or below and must come back as 1.
        for (let b = 0; b < nB; b++) {
          const beats = rec.out64[o + 3 + 2 * b];
          const got = rec.out64[o + 4 + 2 * b];
          if (beats * fpb < 0.5 && got === 1) beatFloored++;
        }
      }
      void sr;
    }
    // The constructor computes its grid on its own line rather than through
    // recalc_grid, so it needs its own .5 landing or that line's rounding is
    // untested. Only a rate whose fraction is .25 or .75 produces one.
    let initHalves = 0;
    for (const rec of native.filter((r) => r.name === "init")) {
      const sr = rec.params[0];
      const exact = 4 * ((sr * 60) / 120);
      if (Math.abs(exact - Math.floor(exact) - 0.5) < 1e-9) initHalves++;
    }
    ok("the init sweep lands exactly on .5 too, for the constructor's own grid line", initHalves > 0, `${initHalves} rates`);
    ok("the grid sweep lands exactly on .5, where Math.round and round() disagree", halves > 0, `${halves} rows`);
    ok("and it reaches the max(1, ...) floor on the grid", floored > 0, `${floored} rows`);
    ok("and the same floor on framesForBeats", beatFloored > 0, `${beatFloored} rows`);
  }

  // The advance battery has to have actually stopped and restarted the clock,
  // or the `running` branch is untested.
  {
    const held = native.filter((r) => r.name === "advance").filter((rec) => {
      // frame column, stride 5: blocks 200..249 are the stopped window
      const at = (t) => rec.out64[t * 5];
      return at(210) === at(240) && at(240) < at(260);
    });
    const runs = native.filter((r) => r.name === "advance");
    ok("advance() is a no-op while stopped, in every advance case", held.length === runs.length && runs.length > 0, `${held.length}/${runs.length}`);
    const reset = runs.filter((rec) => rec.out64[400 * 5] < rec.out64[399 * 5]);
    ok("and the mid-run reset moved the counter back", reset.length === runs.length, `${reset.length}/${runs.length}`);
  }

  // Scripts have to be non-trivial and every opcode has to run at least once,
  // or a mirrored op could be wrong in both files and never show.
  {
    const scripts = native.filter((r) => r.name === "script");
    const seen = new Set();
    for (const rec of scripts) {
      for (let i = 0; i + OPW <= rec.params.length; i += OPW) {
        const op = rec.params[i] | 0;
        seen.add(op);
        if (op === OP.END) break;
      }
    }
    const unrun = Object.entries(OP).filter(([n, v]) => n !== "END" && !seen.has(v)).map(([n]) => n);
    ok("every opcode is exercised by some script", unrun.length === 0, unrun.length ? `never run: ${unrun}` : `${seen.size} opcodes`);
    ok("the scripts produce state to compare", scripts.every((r) => r.out64.length >= SNAP), `${scripts.length} scripts`);
  }

  // Nothing should have produced an unexpected NaN outside the cases that
  // deliberately feed one in.
  {
    let nans = 0;
    let nanNames = new Set();
    // barPhase and framesToGrid deliberately probe non-finite frames from the
    // payload rather than the params, and the scripts feed non-finite values as
    // opcode operands, so all three are allowed to carry NaN.
    const probesNonFinite = new Set(["barPhase", "framesToGrid", "script"]);
    const allowNaN = (rec) => {
      if ([...rec.params].some((v) => Number.isNaN(v))) return true;
      if (probesNonFinite.has(rec.name)) return true;
      // A sample rate of 0 (a device that lies about its rate — a real branch,
      // which is why it is in the sweep) makes frames_per_beat 0, and beat/bar/
      // barPhase are then 0/0. That is arithmetic, not a port bug, so it is
      // explained — but only for the degenerate rate, so a NaN at 48k in the
      // same battery still fails.
      if (rec.name === "init" && !(rec.params[0] > 0)) return true;
      return false;
    };
    for (const rec of native) {
      if (allowNaN(rec)) continue;
      for (const v of rec.out64) {
        if (Number.isNaN(v)) {
          nans++;
          nanNames.add(rec.name);
        }
      }
    }
    const unexpected = [...nanNames];
    ok("no unexplained NaN in the dump", unexpected.length === 0, unexpected.length ? `${nans} NaNs in ${unexpected}` : `${nans} accounted for`);
  }
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\nclock parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
process.exit(state.failures === 0 ? 0 : 1);
