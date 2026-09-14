import { ORPCError } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { base } from "../__core/app";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * Kit storage — the BROBEATS counterpart to presets, and deliberately the same shape so
 * there is one way to think about saved documents in this app.
 *
 * As with the chain, the kit document is validated for *shape* and not for semantics.
 * The engine is the authority on which generator kinds and effect ids exist, and
 * `importKit()` already drops what it doesn't recognise and back-fills what is missing.
 * Rejecting a kit here because this build hasn't heard of a generator would make kits
 * less portable between versions, not more.
 *
 * `source.sampleId` is a reference into the client-side sample store, never audio. A kit
 * that travels to another machine therefore arrives with its settings intact and its
 * sample pads silent until those samples are imported — which is the honest outcome, and
 * the same one every DAW gives you for a missing-media project.
 */
const padSlotSchema = z.object({
  id: z.number().int(),
  type: z.string().min(1).max(40),
  params: z.record(z.string(), z.number()),
  mix: z.number(),
  bypassed: z.boolean(),
});

const padSourceSchema = z.object({
  kind: z.enum(["synth", "sample", "empty"]),
  synth: z.string().max(40),
  synthParams: z.record(z.string(), z.number()),
  sampleName: z.string().max(200).nullable(),
  sampleId: z.string().max(80).nullable(),
  frames: z.number().int().nonnegative(),
  sampleRate: z.number().nonnegative(),
});

const kitSchema = z.object({
  name: z.string().min(1).max(80),
  gain: z.number(),
  mute: z.boolean(),
  route: z.number(),
  pads: z
    .array(
      z.object({
        index: z.number().int().min(0).max(63),
        name: z.string().max(40),
        source: padSourceSchema,
        params: z.record(z.string(), z.number()),
        chain: z.array(padSlotSchema).max(24),
      }),
    )
    .max(64),
});

type KitDoc = z.infer<typeof kitSchema>;

/**
 * One line describing what is on the pads, for the browser list: the generator kind or
 * the sample name per loaded pad, empties skipped. Denormalised at write time so listing
 * kits never means parsing sixteen pads of JSON per row.
 */
function summarize(kit: KitDoc): string {
  const parts: string[] = [];
  for (const pad of kit.pads) {
    if (pad.source.kind === "synth") parts.push(pad.source.synth || pad.name);
    else if (pad.source.kind === "sample") parts.push(pad.source.sampleName || pad.name);
  }
  return parts.join(">").slice(0, 300);
}

export const kits = {
  list: base.handler(() =>
    db.select().from(schema.kits).orderBy(desc(schema.kits.favorite), desc(schema.kits.updatedAt)),
  ),

  get: base.input(z.object({ id: z.number().int() })).handler(async ({ input }) => {
    const [row] = await db.select().from(schema.kits).where(eq(schema.kits.id, input.id));
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Kit not found" });
    return row;
  }),

  create: base
    .input(
      z.object({
        name: z.string().min(1).max(80),
        category: z.string().min(1).max(40).default("User"),
        description: z.string().max(500).default(""),
        kit: kitSchema,
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db
        .insert(schema.kits)
        .values({
          name: input.name,
          category: input.category,
          description: input.description,
          kit: JSON.stringify(input.kit),
          summary: summarize(input.kit),
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
        kit: kitSchema.optional(),
      }),
    )
    .handler(async ({ input }) => {
      const patch: Partial<typeof schema.kits.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.category !== undefined) patch.category = input.category;
      if (input.description !== undefined) patch.description = input.description;
      if (input.favorite !== undefined) patch.favorite = input.favorite;
      if (input.kit !== undefined) {
        patch.kit = JSON.stringify(input.kit);
        patch.summary = summarize(input.kit);
      }
      const [row] = await db.update(schema.kits).set(patch).where(eq(schema.kits.id, input.id)).returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Kit not found" });
      return row;
    }),

  remove: base.input(z.object({ id: z.number().int() })).handler(async ({ input }) => {
    const [row] = await db.delete(schema.kits).where(eq(schema.kits.id, input.id)).returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Kit not found" });
    return { id: row.id };
  }),
};
