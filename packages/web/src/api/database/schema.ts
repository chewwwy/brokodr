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
