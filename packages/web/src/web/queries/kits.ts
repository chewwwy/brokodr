import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";
import { importKit, type KitDocument } from "../audio/kit";

// Data hooks live here, one file per feature — each wraps its query/mutation
// options (staleTime, select, invalidation) so components just call the hook.
// Patterns and examples: skills/app/references/web.md

export interface StoredKit {
  id: number;
  name: string;
  category: string;
  description: string;
  kit: KitDocument;
  summary: string;
  favorite: boolean;
  updatedAt: Date;
}

/**
 * Parses the stored JSON kit document once, at the query boundary, and runs it back
 * through `importKit()`/`exportKit()` so every row that reaches a component is a
 * complete document with this build's defaults filled in — a kit saved by an older
 * version loads rather than arriving with holes in it.
 */
function decode(row: {
  id: number;
  name: string;
  category: string;
  description: string;
  kit: string;
  summary: string;
  favorite: boolean;
  updatedAt: Date;
}): StoredKit {
  let doc: Partial<KitDocument> | null = null;
  try {
    doc = JSON.parse(row.kit) as Partial<KitDocument>;
  } catch {
    // A corrupt row shouldn't take the browser down — it loads as an empty kit, keeps
    // its name in the list, and can be overwritten or deleted like any other.
  }
  const state = importKit(doc);
  return {
    ...row,
    kit: {
      name: state.name,
      gain: state.gain,
      mute: state.mute,
      route: state.route,
      pads: state.pads.map((p) => ({
        index: p.index,
        name: p.name,
        source: p.source,
        params: p.params,
        chain: p.chain,
      })),
    },
  };
}

export function useKits() {
  return useQuery(
    orpc.kits.list.queryOptions({
      select: (rows) => rows.map(decode),
    }),
  );
}

export function useCreateKit() {
  const qc = useQueryClient();
  return useMutation(
    orpc.kits.create.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: orpc.kits.key() }),
    }),
  );
}

export function useUpdateKit() {
  const qc = useQueryClient();
  return useMutation(
    orpc.kits.update.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: orpc.kits.key() }),
    }),
  );
}

export function useDeleteKit() {
  const qc = useQueryClient();
  return useMutation(
    orpc.kits.remove.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: orpc.kits.key() }),
    }),
  );
}
