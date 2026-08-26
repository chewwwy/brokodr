import { ORPCError } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { base } from "../__core/app";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * Preset storage.
 *
 * The chain document is validated for *shape* here but not for semantics: the engine is the
 * authority on which effect types and params exist, and it already drops unknown modules
 * and back-fills missing params on load. Rejecting a preset here because this build doesn't
 * recognise an effect id would make presets less portable, not more.
 */
const chainSchema = z.object({
  slots: z
    .array(
      z.object({
        type: z.string().min(1).max(40),
        params: z.record(z.string(), z.number()),
        mix: z.number(),
        bypassed: z.boolean().optional(),
        collapsed: z.boolean().optional(),
      }),
    )
    .max(24),
  io: z.record(z.string(), z.union([z.number(), z.boolean()])),
});

function summarize(chain: z.infer<typeof chainSchema>): string {
  return chain.slots.map((s) => s.type).join(">");
}

export const presets = {
  list: base.handler(() =>
    db.select().from(schema.presets).orderBy(desc(schema.presets.favorite), desc(schema.presets.updatedAt)),
  ),

  get: base.input(z.object({ id: z.number().int() })).handler(async ({ input }) => {
    const [row] = await db.select().from(schema.presets).where(eq(schema.presets.id, input.id));
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Preset not found" });
    return row;
  }),

  create: base
    .input(
      z.object({
        name: z.string().min(1).max(80),
        category: z.string().min(1).max(40).default("User"),
        description: z.string().max(500).default(""),
        basedOn: z.string().max(80).nullable().default(null),
        chain: chainSchema,
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db
        .insert(schema.presets)
        .values({
          name: input.name,
          category: input.category,
          description: input.description,
          basedOn: input.basedOn,
          chain: JSON.stringify(input.chain),
          summary: summarize(input.chain),
        })
        .returning();
      return row;
    }),

  update: base
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().min(1).max(80).optional(),
        category: z.string().min(1).max(40).optional(),
        description: z.string().max(500).optional(),
        favorite: z.boolean().optional(),
        chain: chainSchema.optional(),
      }),
    )
    .handler(async ({ input }) => {
      const patch: Partial<typeof schema.presets.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.category !== undefined) patch.category = input.category;
      if (input.description !== undefined) patch.description = input.description;
      if (input.favorite !== undefined) patch.favorite = input.favorite;
      if (input.chain !== undefined) {
        patch.chain = JSON.stringify(input.chain);
        patch.summary = summarize(input.chain);
      }
      const [row] = await db.update(schema.presets).set(patch).where(eq(schema.presets.id, input.id)).returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Preset not found" });
      return row;
    }),

  remove: base.input(z.object({ id: z.number().int() })).handler(async ({ input }) => {
    const [row] = await db.delete(schema.presets).where(eq(schema.presets.id, input.id)).returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Preset not found" });
    return { id: row.id };
  }),
};
