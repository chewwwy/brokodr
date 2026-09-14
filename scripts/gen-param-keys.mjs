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
const OUT = join(root, "packages/native/include/brokodr/dsp/param-keys.h");
const REL_SCHEMA = "packages/web/src/web/audio/param-schema.ts";

if (typeof Bun === "undefined") {
  console.error("run this with bun, not node — it imports param-schema.ts directly");
  process.exit(2);
}

const { EFFECTS } = await import(SCHEMA);

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
w(` * Source:    ${REL_SCHEMA}`);
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
    console.error(`param-keys.h is stale against ${REL_SCHEMA} — run: bun scripts/gen-param-keys.mjs`);
    process.exit(1);
  }
  console.log(`param-keys.h is up to date — ${types.length} effect types, ${total} params`);
} else {
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT} — ${types.length} effect types, ${total} params`);
}
