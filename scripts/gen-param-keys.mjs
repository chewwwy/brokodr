/**
 * Bro.Kodr — generate the C param-key header from param-schema.ts.
 *
 * param-schema.ts is the single source of truth for parameter order, because
 * the index of a param inside its effect's `params` array *is* the numeric key
 * on the command ring. Every ported effect's set_param switch has to agree
 * with that ordering exactly, and there is no way to notice a disagreement at
 * runtime — a reordered param silently drives the wrong knob.
 *
 * So the header is generated rather than written. Run it two ways:
 *
 *   bun scripts/gen-param-keys.mjs          write the header
 *   bun scripts/gen-param-keys.mjs --check  fail if the committed header is stale
 *
 * Bun is used because it imports the .ts directly: the generator reads the real
 * exported objects instead of parsing TypeScript with a regex, so it cannot
 * disagree with what the app actually loads.
 *
 * Emitted per effect type: an enum of BK_P_<TYPE>_<KEY> = index, a count, and
 * BK_P_<TYPE>_QUALITY_KEY for the types that have a `quality` param (-1 when
 * they do not). That last one is what a host passes along to decide whether to
 * call bk_chain_recalc_latency after a param change — see chain.h on why the
 * chain itself cannot answer that from a numeric key.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = join(root, "packages/web/src/web/audio/param-schema.ts");
const BACKEND = join(root, "packages/web/src/web/audio/backend.ts");
const WORKLET = join(root, "packages/web/public/dsp/worklet-processor.js");
const OUT = join(root, "packages/native/include/brokodr/dsp/param-keys.h");
const REL_SCHEMA = "packages/web/src/web/audio/param-schema.ts";
const REL_BACKEND = "packages/web/src/web/audio/backend.ts";
const REL_WORKLET = "packages/web/public/dsp/worklet-processor.js";

if (typeof Bun === "undefined") {
  console.error("run this with bun, not node — it imports param-schema.ts directly");
  process.exit(2);
}

const { EFFECTS } = await import(SCHEMA);
const { PAD_KEY, DRUM_KEY, LOOP_KEY, LOOPER_KEY, CLOCK_KEY } = await import(BACKEND);

/*
 * The drum pads do not live in EFFECTS. A pad is not a chain slot: its params
 * are a flat, append-only wire list (PAD_KEY), and the rack's own are another
 * (DRUM_KEY). They are generated here for the same reason the effect keys are —
 * the index IS the wire key, and drum-voice.c switches on it.
 *
 * Both lists exist twice in the tree: typed in backend.ts for the UI, and
 * duplicated as plain arrays in worklet-processor.js for the audio thread,
 * which cannot import from src/. backend.ts is treated as authoritative and
 * the worklet's copy is checked against it by text, because a divergence there
 * silently drives the wrong knob and nothing at runtime would notice.
 */
const workletSrc = readFileSync(WORKLET, "utf8");

function workletCopy(name) {
  const m = workletSrc.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

for (const [name, authoritative] of [
  ["PAD_KEY", PAD_KEY],
  ["DRUM_KEY", DRUM_KEY],
  ["LOOP_KEY", LOOP_KEY],
  ["LOOPER_KEY", LOOPER_KEY],
  ["CLOCK_KEY", CLOCK_KEY],
]) {
  const mirror = workletCopy(name);
  if (!mirror) {
    console.error(`${REL_WORKLET}: cannot find ${name} — the generator's regex needs updating`);
    process.exit(2);
  }
  if (mirror.join(",") !== [...authoritative].join(",")) {
    console.error(
      `${name} disagrees between ${REL_BACKEND} and ${REL_WORKLET}:\n` +
        `  backend: ${[...authoritative].join(", ")}\n` +
        `  worklet: ${mirror.join(", ")}`,
    );
    process.exit(2);
  }
}

/** eq -> EQ, talkBox -> TALK_BOX, deEsser -> DE_ESSER. */
const screaming = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();

const types = Object.keys(EFFECTS).sort();
const lines = [];
const w = (s = "") => lines.push(s);

w("/*");
w(" * Bro.Kodr DSP core — parameter keys. GENERATED, DO NOT EDIT.");
w(" *");
w(` * Sources:   ${REL_SCHEMA} (chain effect params)`);
w(` *            ${REL_BACKEND} (pad, rack, looper, transport params)`);
w(" * Generator: scripts/gen-param-keys.mjs");
w(" *");
w(" * Regenerate with `bun scripts/gen-param-keys.mjs`. CI runs the same script");
w(" * with --check, so an edit to the schema that misses this header fails there");
w(" * rather than silently driving the wrong parameter at runtime.");
w(" *");
w(" * The value of each key is the param's index inside its own effect type's");
w(" * list, which is what the command ring carries. Indices are append-only:");
w(" * param-schema.ts forbids reordering because presets and the wire format");
w(" * both depend on them holding still.");
w(" */");
w();
w("#ifndef BROKODR_DSP_PARAM_KEYS_H");
w("#define BROKODR_DSP_PARAM_KEYS_H");
w();
w("/* No effect type has a param at this index; use it for \"not present\". */");
w("#define BK_PARAM_NONE (-1)");
w();

let total = 0;
for (const type of types) {
  const def = EFFECTS[type];
  const params = def.params ?? [];
  const T = screaming(type);
  total += params.length;
  w(`/* ${type} — ${def.name ?? ""} */`);
  if (params.length === 0) {
    w(`#define BK_P_${T}_COUNT 0`);
  } else {
    w("enum {");
    for (let i = 0; i < params.length; i++) {
      w(`  BK_P_${T}_${screaming(params[i].key)} = ${i},`);
    }
    w(`  BK_P_${T}_COUNT = ${params.length}`);
    w("};");
  }
  const q = params.findIndex((p) => p.key === "quality");
  w(`#define BK_P_${T}_QUALITY_KEY ${q < 0 ? "BK_PARAM_NONE" : q}`);
  w();
}

w(`/* ${types.length} effect types, ${total} params. */`);
w(`#define BK_EFFECT_TYPE_COUNT ${types.length}`);
w();

/* --- the drum rack, which is not an effect type ------------------------- */

w("/*");
w(" * BROBEATS pad params. A pad is not a chain slot and has no effect type, so");
w(" * these are one flat list shared by every pad: the value is the index on the");
w(" * command ring (OP.PAD / PAD_FIELD.PARAM), which the worklet turns into the");
w(" * string key DrumVoice.setParam takes. bk_drum_voice_set_param switches on");
w(" * the number directly — the audio thread should not compare strings.");
w(" */");
w("enum {");
for (let i = 0; i < PAD_KEY.length; i++) w(`  BK_PAD_P_${screaming(PAD_KEY[i])} = ${i},`);
w(`  BK_PAD_P_COUNT = ${PAD_KEY.length}`);
w("};");
w();
w("/* Rack-wide params, one per rack rather than per pad (OP.DRUM). */");
w("enum {");
for (let i = 0; i < DRUM_KEY.length; i++) w(`  BK_DRUM_P_${screaming(DRUM_KEY[i])} = ${i},`);
w(`  BK_DRUM_P_COUNT = ${DRUM_KEY.length}`);
w("};");
w();

/* --- the looper and the transport, also not effect types ---------------- */

w("/*");
w(" * Per-track looper params (OP.LOOP / LOOP_FIELD.PARAM). Same contract as the");
w(" * pad list: the index IS the wire key, and bk_looper_set_track_param");
w(" * switches on the number. The transport verbs — rec, play, stop, clear,");
w(" * undo, clearAll — are NOT here; they carry no value and travel as their own");
w(" * ring fields, so they are functions on bk_looper rather than params.");
w(" */");
w("enum {");
for (let i = 0; i < LOOP_KEY.length; i++) w(`  BK_LOOP_P_${screaming(LOOP_KEY[i])} = ${i},`);
w(`  BK_LOOP_P_COUNT = ${LOOP_KEY.length}`);
w("};");
w();
w("/* Looper-bus params, one per looper rather than per track (OP.LOOPER). */");
w("enum {");
for (let i = 0; i < LOOPER_KEY.length; i++) w(`  BK_LOOPER_P_${screaming(LOOPER_KEY[i])} = ${i},`);
w(`  BK_LOOPER_P_COUNT = ${LOOPER_KEY.length}`);
w("};");
w();
w("/*");
w(" * Transport params (OP.CLOCK). BK_CLOCK_P_RESET takes no value — the key");
w(" * itself is the command — and is a param rather than a function because that");
w(" * is how it arrives on the ring.");
w(" */");
w("enum {");
for (let i = 0; i < CLOCK_KEY.length; i++) w(`  BK_CLOCK_P_${screaming(CLOCK_KEY[i])} = ${i},`);
w(`  BK_CLOCK_P_COUNT = ${CLOCK_KEY.length}`);
w("};");
w();
w("#endif /* BROKODR_DSP_PARAM_KEYS_H */");

const out = lines.join("\n") + "\n";

if (process.argv.includes("--check")) {
  let have = null;
  try {
    have = readFileSync(OUT, "utf8");
  } catch {
    console.error(`param-keys.h is missing — run: bun scripts/gen-param-keys.mjs`);
    process.exit(1);
  }
  if (have !== out) {
    console.error(`param-keys.h is stale against its sources — run: bun scripts/gen-param-keys.mjs`);
    process.exit(1);
  }
  console.log(
    `param-keys.h is up to date — ${types.length} effect types, ${total} params, ` +
      `${PAD_KEY.length} pad params, ${DRUM_KEY.length} rack params, ` +
      `${LOOP_KEY.length} loop params, ${LOOPER_KEY.length} looper params, ` +
      `${CLOCK_KEY.length} clock params`,
  );
} else {
  writeFileSync(OUT, out);
  console.log(
    `wrote ${OUT} — ${types.length} effect types, ${total} params, ` +
      `${PAD_KEY.length} pad params, ${DRUM_KEY.length} rack params, ` +
      `${LOOP_KEY.length} loop params, ${LOOPER_KEY.length} looper params, ` +
      `${CLOCK_KEY.length} clock params`,
  );
}
