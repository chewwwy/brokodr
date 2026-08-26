/**
 * Bro.Kodr — `.vkpreset` file format.
 *
 * Presets are stored in the database, but they also have to move between machines without
 * an account, so a single preset or a whole bank serialises to one JSON file.
 *
 * Chain documents reference effects by their registry id (`eq`, `comp`, `pitch`, …). Those
 * ids are frozen forever — renaming one silently breaks every preset ever saved.
 */

import type { ChainSnapshot } from "./engine-client";
import { DEFAULT_IO } from "./engine-client";
import { EFFECTS, withDefaults } from "./param-schema";

/** Bumped only on a breaking change to the file format. */
export const PRESET_FORMAT = 1;

export interface PresetDoc {
  name: string;
  category: string;
  description: string;
  chain: ChainSnapshot;
}

export interface PresetFile {
  format: number;
  app: "Bro.Kodr";
  presets: PresetDoc[];
}

/**
 * Repairs a chain document read from storage or a file.
 *
 * Drops slots whose effect type no longer exists, fills in params added since the preset
 * was written, and re-issues slot ids so two presets loaded in the same session can never
 * collide. Without the back-fill, loading an old preset would leave newer params at zero
 * instead of at their designed default.
 */
export function migrateChain(chain: Partial<ChainSnapshot> | null | undefined): ChainSnapshot {
  const slots = (chain?.slots ?? [])
    .filter((s) => !!s && !!EFFECTS[s.type])
    .slice(0, 24)
    .map((s, i) => ({
      id: i + 1,
      type: s.type,
      params: withDefaults(s.type, s.params ?? {}),
      mix: typeof s.mix === "number" && Number.isFinite(s.mix) ? Math.min(1, Math.max(0, s.mix)) : 1,
      bypassed: !!s.bypassed,
      collapsed: !!s.collapsed,
    }));
  return { slots, io: { ...DEFAULT_IO, ...(chain?.io ?? {}) } };
}

function isDoc(v: unknown): v is PresetDoc {
  const p = v as PresetDoc;
  return !!p && typeof p.name === "string" && !!p.chain && Array.isArray(p.chain.slots);
}

export function encodePresetFile(presets: PresetDoc[]): string {
  const file: PresetFile = { format: PRESET_FORMAT, app: "Bro.Kodr", presets };
  return JSON.stringify(file, null, 2);
}

/** Accepts a bank file, a single-preset file, or a bare chain document. */
export function decodePresetFile(text: string): { presets: PresetDoc[]; error: string | null } {
  let data: Partial<PresetFile> & { preset?: PresetDoc; slots?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    return { presets: [], error: "That file is not valid JSON." };
  }

  if (data.format && data.format > PRESET_FORMAT) {
    return { presets: [], error: `File is format v${data.format}; this build reads v${PRESET_FORMAT}.` };
  }

  let raw: unknown[] = [];
  if (Array.isArray(data.presets)) raw = data.presets;
  else if (data.preset) raw = [data.preset];
  else if (Array.isArray(data.slots)) {
    // A bare chain export — wrap it so it can still be imported.
    raw = [{ name: "Imported chain", category: "User", description: "", chain: data }];
  }

  const presets = raw.filter(isDoc).map((p) => ({
    name: String(p.name).slice(0, 80),
    category: String(p.category || "User").slice(0, 40),
    description: String(p.description || "").slice(0, 500),
    chain: migrateChain(p.chain),
  }));

  if (!presets.length) return { presets: [], error: "No presets found in that file." };
  return { presets, error: null };
}

export function presetFilename(name: string, bank = false): string {
  const safe = name.replace(/[^a-z0-9-_ ]/gi, "").trim() || "preset";
  return bank ? `${safe}-bank.vkpreset` : `${safe}.vkpreset`;
}
