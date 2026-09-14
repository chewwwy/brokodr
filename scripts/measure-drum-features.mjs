// One-off measurement: what feature vector does each factory drum produce?
//
// The factory centroids in core/beat-classify.js have to come from somewhere. Rather
// than guessing four plausible-looking vectors, they are measured from the kit's own
// one-shots with the same detector the live path uses — so the shipped profile at least
// agrees with the sounds the pads make. A mouth is not an 808, which is why calibration
// exists; this is the starting point calibration moves away from.
import { renderDrum, DEFAULT_KIT_LAYOUT } from "../packages/web/public/dsp/core/drum-synth.js";
import { detectOnsets, FEATURE_COUNT } from "../packages/web/public/dsp/core/onset.js";

const SR = 48000;
const FEATURE_MS = Number(process.argv[2] || 22);

const rows = [];
for (const entry of DEFAULT_KIT_LAYOUT) {
  const r = renderDrum(entry.kind, SR, entry.params);
  if (!r) continue;
  // A hit needs silence in front of it or the detector starts mid-transient.
  const pad = (0.05 * SR) | 0;
  const mono = new Float32Array(pad + r.frames + SR * 0.2);
  mono.set(r.data, pad);
  const { positions, features } = detectOnsets(mono, SR, { featureMs: FEATURE_MS });
  if (!positions.length) {
    rows.push({ name: entry.name, kind: entry.kind, f: null });
    continue;
  }
  rows.push({ name: entry.name, kind: entry.kind, f: features[0], at: positions[0] - pad });
}

const fmt = (n) => (n === undefined ? "  -  " : n.toFixed(3));
console.log(`featureMs=${FEATURE_MS}`);
console.log("pad        kind   onset±   low    mid    high   zcr");
for (const r of rows) {
  if (!r.f) {
    console.log(`${r.name.padEnd(10)} ${r.kind.padEnd(6)} NOT DETECTED`);
    continue;
  }
  const ms = ((r.at / SR) * 1000).toFixed(2);
  console.log(
    `${r.name.padEnd(10)} ${r.kind.padEnd(6)} ${ms.padStart(6)}  ${r.f.map(fmt).join("  ")}`,
  );
}

// Per-kind mean, which is what a factory centroid actually is.
const byKind = new Map();
for (const r of rows) {
  if (!r.f) continue;
  if (!byKind.has(r.kind)) byKind.set(r.kind, []);
  byKind.get(r.kind).push(r.f);
}
console.log("\nper-kind mean:");
for (const [kind, list] of byKind) {
  const m = new Array(FEATURE_COUNT).fill(0);
  for (const f of list) for (let i = 0; i < FEATURE_COUNT; i++) m[i] += f[i] / list.length;
  console.log(`${kind.padEnd(6)} n=${list.length}  ${m.map(fmt).join("  ")}`);
}
