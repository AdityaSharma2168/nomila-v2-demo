/**
 * identity/policy.ts — the Athlete Index matching policy: weights, floors, tiers (design §4.2–4.3).
 * Pure (no database). The effective policy (an ACTIVE `identity_policy` model_params row over
 * these defaults) is read in config.ts. Matching only: nothing here authorizes a claim.
 */

export interface IdentityPolicy {
  /** Trigram similarity below which a row is not a candidate at all. */
  nameFloor: number;
  weights: { name: number; sport: number; team: number; year: number; handle: number };
  /** teamMatch is scaled by the affiliation's kind: the athlete's word / a contract vs research. */
  teamKindWeight: { said: number; proof: number; found: number };
  /** teamMatch at or above this counts as corroboration. */
  teamCorroboration: number;
  /** Score-based auto_match: matchScore ≥ autoMatch AND corroborated AND runner-up gap ≥ gap. */
  autoMatch: number;
  candidate: number;
  gap: number;
  /** Class/graduation year tolerance. */
  yearTolerance: number;
  version?: string;
}

export const DEFAULT_IDENTITY_POLICY: IdentityPolicy = {
  nameFloor: 0.35,
  weights: { name: 0.55, sport: 0.15, team: 0.15, year: 0.05, handle: 0.10 },
  teamKindWeight: { said: 1.0, proof: 1.0, found: 0.7 },
  teamCorroboration: 0.6,
  autoMatch: 0.90,
  candidate: 0.60,
  gap: 0.15,
  yearTolerance: 1,
  version: "defaults",
};

/** The registry's text normalizer, duplicated for the query side (NFD → strip marks → lower → non-alphanumerics to one space → trim). */
export function normalizeIdentityText(v: unknown): string {
  return String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function normalizeHandle(h: unknown): string | null {
  const s = String(h ?? "").trim().replace(/^@/, "").toLowerCase();
  return s || null;
}
