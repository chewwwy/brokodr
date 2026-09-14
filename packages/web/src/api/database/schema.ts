import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Define your database schema here, then apply it with `bun run db:push`
 * (from packages/web). Re-export any generated schema from this file
 * (e.g. Better Auth's auth-schema.ts) so drizzle generates complete migrations.
 * Table patterns and conventions: skills/app/references/api.md
 */

/**
 * User presets — a complete signal chain: module order, every parameter, per-module
 * dry/wet and the I/O stage.
 *
 * `chain` is stored as a JSON string rather than normalised into tables on purpose. It is
 * an opaque document that only the engine interprets, it is always read and written whole,
 * and it must tolerate schema drift: `withDefaults()` on load fills in params added by a
 * later build. Normalising it would buy nothing and break forward compatibility.
 */
export const presets = sqliteTable(
  "presets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    category: text("category").notNull().default("User"),
    description: text("description").notNull().default(""),
    /** JSON: { slots: [{ type, params, mix, bypassed }], io: {...} } */
    chain: text("chain").notNull(),
    /** Effect type ids in order, denormalised so the browser list can show the chain. */
    summary: text("summary").notNull().default(""),
    /** Preset this one was derived from, for provenance in the UI. */
    basedOn: text("based_on"),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("presets_category_idx").on(t.category), index("presets_name_idx").on(t.name)],
);

export type PresetRow = typeof presets.$inferSelect;

/**
 * Saved BROBEATS kits — the sixteen pads, what is on each, its voice settings and its
 * own effect chain, plus the kit mixer.
 *
 * Same JSON-document pattern as `presets`, and for the same reasons: the kit is read and
 * written whole, only the engine interprets it, and `importKit()` back-fills anything a
 * later build added. Normalising sixteen pads x fourteen params into rows would buy
 * nothing and break kits written by an older version.
 *
 * What is *not* in here is audio. A kit stores a `sampleId` per pad and the bytes live
 * client-side — IndexedDB on web, real .wav files under Music/Bro.Kodr/Samples on
 * desktop (see web/audio/sample-store.ts). A one-shot is hundreds of kilobytes; base64
 * in a text column would be a third larger again, would be rewritten on every rename,
 * and would make the kit list slow to load for no gain.
 *
 * The library is additive, not a replacement for the working kit: whatever is on the
 * pads right now autosaves to localStorage on every change, and these rows are the
 * named snapshots the user chose to keep — exactly the relationship the chain has with
 * presets.
 */
export const kits = sqliteTable(
  "kits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    category: text("category").notNull().default("User"),
    description: text("description").notNull().default(""),
    /** JSON KitDocument: { name, gain, mute, route, pads: [{ index, name, source, params, chain }] } */
    kit: text("kit").notNull(),
    /** Pad contents in order, denormalised so the browser list can show the kit. */
    summary: text("summary").notNull().default(""),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("kits_category_idx").on(t.category), index("kits_name_idx").on(t.name)],
);

export type KitRow = typeof kits.$inferSelect;
