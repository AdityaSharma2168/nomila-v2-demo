import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";

// ─── Pitches (GET /api/v1/athletes/:id/pitches) ────────────────────────────────
// A "pitch" is a brand-specific Nomi Card — one per (athlete, brand). Status is DERIVED
// server-side (see server/services/pitches.ts): ready → sent → opened, plus a `stale`
// flag when the public card changed after the pitch was built. Powers the Studio hub +
// the Pitches list. Status vocabulary is locked (see components/pitch/pitchStatus.ts).

export type PitchStatus = "tailoring" | "ready" | "sent" | "opened" | "failed";

export interface Pitch {
  brandId: number;
  brandName: string;
  brandLogo: string | null;
  brandDomain: string | null;
  category: string | null;
  status: PitchStatus;
  stale: boolean;
  opensCount: number;
  lastOpenedAt: string | null;
  sentAt: string | null;
  generatedAt: string | null;
  dealId: string | null;
  /** Hand-built deck hosted on a share — open this instead of the in-app kit. */
  hostedUrl: string | null;
  /** API-relative path to that deck's cover card image. */
  coverPath: string | null;
}

export function useMyPitches(athleteId: string | undefined) {
  const query = useQuery<{ pitches: Pitch[] }>({
    queryKey: [`/api/v1/athletes/${athleteId}/pitches`],
    enabled:  !!athleteId,
  });
  return {
    pitches:   query.data?.pitches ?? [],
    isLoading: query.isLoading,
    isError:   query.isError,
    error:     query.error as Error | null,
    refetch:   query.refetch,
  };
}

// Mutations target the create/rebuild/delete endpoints that land with the create flow
// (Phase 4) and the pausable builder (Phase 5). Each invalidates the list on success.

export function useCreatePitch(athleteId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<{ brandId: number }, Error, { brandId: number }>({
    mutationFn: (body) =>
      apiRequest("POST", `/api/v1/athletes/${athleteId}/pitches`, body).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/v1/athletes/${athleteId}/pitches`] }),
  });
}

export function useRebuildPitch(athleteId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, number>({
    mutationFn: (brandId) =>
      apiRequest("POST", `/api/v1/athletes/${athleteId}/pitches/${brandId}/rebuild`, {}).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/v1/athletes/${athleteId}/pitches`] }),
  });
}

export function useDeletePitch(athleteId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, number>({
    mutationFn: (brandId) =>
      apiRequest("DELETE", `/api/v1/athletes/${athleteId}/pitches/${brandId}`, undefined).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/v1/athletes/${athleteId}/pitches`] }),
  });
}

// ─── Pre-build insights (Studio create — Gate 2) ───────────────────────────────

export interface PitchAngle { key: "audience" | "credibility" | "whitespace"; title: string; text: string }
export interface PitchInsights {
  brand: { id: number; name: string; logo: string | null; category: string | null; tier: string | null; audience: string | null };
  campaigns: string[];
  angles: PitchAngle[];
}

// Fetched imperatively (mutation) so the create flow controls exactly when the research runs.
export function usePitchInsights(athleteId: string | undefined) {
  return useMutation<PitchInsights, Error, number>({
    mutationFn: (brandId) =>
      apiRequest("GET", `/api/v1/athletes/${athleteId}/pitch-insights?brandId=${brandId}`).then((r) => r.json()),
  });
}
