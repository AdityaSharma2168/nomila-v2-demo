/**
 * use-identity-pack — her pack, read and written (PR 17).
 *
 *   GET  /api/v1/me/studio/identity/profile     → { profile, quote }
 *   GET  /api/v1/me/studio/identity/candidates  → { candidates }
 *   PUT  /api/v1/me/studio/identity/pack        { assetIds } → { profile, refused, overCap, partialAdmitted }
 *   POST /api/v1/me/studio/identity/calibrate   → { profile, measured }   — MODEL CALLS, quoted on GET
 *
 * Behind EXPO_PUBLIC_STUDIO_IDENTITY_PACK: off, no query fires (the server 404s anyway). The wire
 * shapes are the server's (server/studio/identity/routes.ts). Ids and numbers only, never a vector.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";
import { STUDIO_IDENTITY_PACK } from "../lib/flags";
import type { IdentityProfileWire } from "../lib/identityPack";

export type { IdentityProfileWire, PackEntryWire } from "../lib/identityPack";

export interface CandidateWire {
  assetId: string;
  thumbUrl: string;
  eligible: boolean;
  refusal: string | null;
  reason: string | null;
  inPack: boolean;
}

export interface ProfileAnswer {
  profile: IdentityProfileWire;
  quote: { faceBoxUsd: number; embedUsd: number; usd: number };
}

export interface SavePackAnswer {
  profile: IdentityProfileWire;
  refused: { assetId: string; refusal: string; reason: string }[];
  overCap: string[];
  partialAdmitted: boolean;
  /** Non-blocking: the save went through, and every photo is a close-up. */
  nudge: string | null;
}

export interface CalibrateAnswer {
  profile: IdentityProfileWire;
  measured: {
    photos: number;
    faces: number;
    pairs: number;
    usd: number;
    band: { min: number; max: number; pairs: number } | null;
  };
}

export const IDENTITY_KEY = ["studio", "identity"] as const;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(new URL(path, getApiUrl()).toString(), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(await getAuthHeaders()),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `Something went wrong (${res.status})`);
  }
  return (await res.json()) as T;
}

export function useIdentityProfile(enabled = true) {
  return useQuery<ProfileAnswer>({
    queryKey: [...IDENTITY_KEY, "profile"],
    enabled: STUDIO_IDENTITY_PACK && enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: () => call<ProfileAnswer>("/api/v1/me/studio/identity/profile"),
  });
}

export function useIdentityCandidates(enabled: boolean) {
  return useQuery<{ candidates: CandidateWire[] }>({
    queryKey: [...IDENTITY_KEY, "candidates"],
    enabled: STUDIO_IDENTITY_PACK && enabled,
    staleTime: 15_000,
    retry: false,
    queryFn: () =>
      call<{ candidates: CandidateWire[] }>(
        "/api/v1/me/studio/identity/candidates",
      ),
  });
}

export function useSavePack() {
  const qc = useQueryClient();
  return useMutation<SavePackAnswer, Error, { assetIds: string[] }>({
    mutationFn: (body) =>
      call<SavePackAnswer>("/api/v1/me/studio/identity/pack", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: IDENTITY_KEY }),
  });
}

/** Spends: her go is the press. The quote rides on GET profile so the button can say the number first. */
export function useCalibratePack() {
  const qc = useQueryClient();
  return useMutation<CalibrateAnswer, Error, void>({
    mutationFn: () =>
      call<CalibrateAnswer>("/api/v1/me/studio/identity/calibrate", {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: IDENTITY_KEY }),
  });
}
