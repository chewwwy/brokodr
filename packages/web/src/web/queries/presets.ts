import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";
import type { ChainSnapshot } from "../audio/engine-client";

// Data hooks live here, one file per feature — each wraps its query/mutation
// options (staleTime, select, invalidation) so components just call the hook.
// Patterns and examples: skills/app/references/web.md

export interface StoredPreset {
  id: number;
  name: string;
  category: string;
  description: string;
  chain: ChainSnapshot;
  summary: string;
  basedOn: string | null;
  favorite: boolean;
  updatedAt: Date;
}

/** Parses the stored JSON chain document once, at the query boundary. */
function decode(row: {
  id: number;
  name: string;
  category: string;
  description: string;
  chain: string;
  summary: string;
  basedOn: string | null;
  favorite: boolean;
  updatedAt: Date;
}): StoredPreset {
  let chain: ChainSnapshot = { slots: [], io: {} as ChainSnapshot["io"] };
  try {
    chain = JSON.parse(row.chain) as ChainSnapshot;
  } catch {
    // A corrupt row shouldn't take the browser down — it just loads as an empty chain.
  }
  return { ...row, chain };
}

export function usePresets() {
  return useQuery(
    orpc.presets.list.queryOptions({
      select: (rows) => rows.map(decode),
    }),
  );
}

export function useCreatePreset() {
  const qc = useQueryClient();
  return useMutation(
    orpc.presets.create.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: orpc.presets.key() }),
    }),
  );
}

export function useUpdatePreset() {
  const qc = useQueryClient();
  return useMutation(
    orpc.presets.update.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: orpc.presets.key() }),
    }),
  );
}

export function useDeletePreset() {
  const qc = useQueryClient();
  return useMutation(
    orpc.presets.remove.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: orpc.presets.key() }),
    }),
  );
}
