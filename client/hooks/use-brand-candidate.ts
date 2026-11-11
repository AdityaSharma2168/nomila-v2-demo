// "Confirm this is [brand]" — the client half of the brand-candidate contract (owner, 7 Oct 2026; server on
// feat/brand-imagery-pipeline):
//   GET  /api/v1/me/brands/:brandId/candidate   → { name, domain, logo } | null
//   POST /api/v1/me/brands/:brandId/confirm     { domain }
//   POST /api/v1/me/brands/:brandId/not_this    { domain }
// No candidate (null, or the route not deployed yet → 404) hides the tap. The candidate carries a DOMAIN, so a
// confirmation is evidence the research gate can check (#778), never a bare "yes".
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import { OPPORTUNITY_BOARD_KEY } from "./use-opportunity-board";

export interface BrandCandidate { name: string; domain: string; logo: string | null }

export function brandCandidateKey(brandId: number) {
  return `/api/v1/me/brands/${brandId}/candidate`;
}

/**
 * The candidate in the server's answer. The server (services/brandConfirmation.getBrandCandidate) answers a VIEW —
 * `{ status: "candidate", candidate: { name, domain, logoUrl, basis } }` — while this hook was written against a flat
 * `{ name, domain, logo }`; reading only the flat shape meant every real answer looked like "no candidate", so "Confirm
 * this is [brand]" never showed and her confirmation (the domain evidence the logo pipeline waits on) never happened.
 * Both shapes are read; anything without a domain is no candidate. Pure.
 */
export function candidateFromResponse(body: unknown): BrandCandidate | null {
  const o = body && typeof body === "object" ? (body as Record<string, any>) : null;
  if (!o) return null;
  const c = o.candidate && typeof o.candidate === "object" ? o.candidate : o.status === undefined ? o : null;
  if (!c || typeof c.domain !== "string" || !c.domain.trim()) return null;
  const name = typeof c.name === "string" && c.name.trim() ? c.name : typeof o.name === "string" ? o.name : c.domain;
  const logo = typeof c.logoUrl === "string" ? c.logoUrl : typeof c.logo === "string" ? c.logo : null;
  return { name, domain: c.domain.trim(), logo };
}

export function useBrandCandidate(brandId: number | null, enabled: boolean) {
  return useQuery<BrandCandidate | null>({
    queryKey: [brandId != null ? brandCandidateKey(brandId) : "brand-candidate:none"],
    enabled: enabled && brandId != null,
    queryFn: async () => {
      try {
        const res = await apiRequest("GET", brandCandidateKey(brandId!));
        return candidateFromResponse(await res.json());
      } catch {
        return null; // no candidate, or the route isn't live yet: the tap stays hidden
      }
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export function useBrandDecision(brandId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: { decision: "confirm" | "not_this"; domain: string }) => {
      await apiRequest("POST", `/api/v1/me/brands/${brandId}/${p.decision}`, { domain: p.domain });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [brandCandidateKey(brandId)] });
      qc.invalidateQueries({ queryKey: [OPPORTUNITY_BOARD_KEY] });
    },
  });
}
