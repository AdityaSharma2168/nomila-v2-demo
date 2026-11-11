// use-me-memory — Me on the agent memory (react-query over lib/meMemoryApi).
//
//   useMeScouting(enabled)           GET /me/scouting       Me (AGENT_V3): the Scouting report, or no_memory
//   useMeFacts(enabled)              GET /me/facts          What Nomila knows (AGENT_V3)
//   useFactDetail(id)                GET /me/facts/:id      one fact's sheet
//   useFactAction()                  correct · hide · restore · dispute · confirm, then both reads refresh
//   usePageMetrics(enabled)          GET /me/public-card/metrics   her page's metrics rail (last 30 days)
//   useAtmosphere(screen, slots)     POST /me/atmosphere/pick      atmosphere for slots that are not about her; while
//                                    the picker is off (404) or fails, every slot is the category default
//
// A read that fails never blanks Me: the screen falls back (the old Me for scouting; zeros are never invented).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { meMemoryApi, type AtmosphereImage, type AtmosphereSlot } from "../lib/meMemoryApi";

export const SCOUTING_KEY = ["me", "scouting"] as const;
export const FACTS_KEY = ["me", "facts"] as const;
export const PAGE_METRICS_KEY = ["me", "public-card", "metrics"] as const;

export function useMeScouting(enabled = true) {
  return useQuery({ queryKey: SCOUTING_KEY, queryFn: meMemoryApi.getScouting, enabled, staleTime: 60_000, retry: false });
}

export function useMeFacts(enabled = true) {
  return useQuery({ queryKey: FACTS_KEY, queryFn: meMemoryApi.getFacts, enabled, staleTime: 30_000, retry: false });
}

export function useFactDetail(id: string | null) {
  return useQuery({ queryKey: [...FACTS_KEY, "one", id], queryFn: () => meMemoryApi.getFact(id!), enabled: !!id, retry: false });
}

export type FactAction =
  | { kind: "correct"; id: string; claim: string }
  | { kind: "hide"; id: string }
  | { kind: "restore"; id: string }
  | { kind: "dispute"; id: string }
  | { kind: "confirm"; id: string };

export function useFactAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: FactAction): Promise<unknown> => {
      switch (a.kind) {
        case "correct": return meMemoryApi.correctFact(a.id, a.claim);
        case "hide": return meMemoryApi.hideFact(a.id);
        case "restore": return meMemoryApi.restoreFact(a.id);
        case "dispute": return meMemoryApi.disputeFact(a.id);
        case "confirm": return meMemoryApi.confirmFact(a.id);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: FACTS_KEY });
      qc.invalidateQueries({ queryKey: SCOUTING_KEY });
    },
  });
}

export function usePageMetrics(enabled = true) {
  return useQuery({ queryKey: PAGE_METRICS_KEY, queryFn: meMemoryApi.getPageMetrics, enabled, staleTime: 60_000, retry: false });
}

/**
 * Atmosphere for a screen's slots, keyed by slot key. Missing key (loading, the picker off, an error, or a "default"
 * answer) → the caller draws the category default. Never her photo.
 */
export function useAtmosphere(screen: string, slots: AtmosphereSlot[], enabled = true): Record<string, Extract<AtmosphereImage, { kind: "image" }>> {
  const q = useQuery({
    queryKey: ["me", "atmosphere", screen, slots.map((s) => s.key).join("|")],
    queryFn: () => meMemoryApi.pickAtmosphere(screen, slots),
    enabled: enabled && slots.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const out: Record<string, Extract<AtmosphereImage, { kind: "image" }>> = {};
  for (const img of q.data?.images ?? []) if (img.kind === "image") out[img.key] = img;
  return out;
}
