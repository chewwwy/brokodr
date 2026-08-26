import { useMutation, useQuery } from "@tanstack/react-query";
import { orpc } from "../lib/api";

// Data hooks live here, one file per feature.
// Patterns and examples: skills/app/references/web.md

export interface VoiceEntry {
  id: string;
  label: string;
  accent: string;
  gender: string;
  provider: string;
}

export interface ProviderEntry {
  id: "gemini" | "groq";
  label: string;
  available: boolean;
  note: string;
}

/**
 * Voice catalog and which providers this deployment can actually reach. Effectively
 * static for the life of the page — it only changes when a key is added to .env and the
 * server restarts — so it is cached hard rather than refetched.
 */
export function useTtsCatalog() {
  return useQuery(
    orpc.tts.catalog.queryOptions({
      staleTime: Infinity,
      gcTime: Infinity,
    }),
  );
}

/**
 * Synthesis is a mutation, not a query: it costs money per call and must never be
 * refired by a cache revalidation, a refocus, or a retry the user did not ask for.
 */
export function useSynthesize() {
  return useMutation(orpc.tts.synth.mutationOptions({ retry: false }));
}
