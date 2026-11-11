/**
 * identity/claim.ts — claim proof and the decision matrix (design §4.4–4.5). Pure.
 *
 * A match tier answers "which athlete record is this probably?"; a claim proof answers "has this
 * user proven they may act as that athlete?". Public identity evidence (name, sport, team, year, a
 * typed public handle) NEVER authorizes a link, whatever the score. Stored source_class describes
 * the record's identity, not the claimant, and is never a proof.
 */

import type { MatchTier } from "./index";

export const CLAIM_PROOFS = ["existing_auth", "verified_unique_email", "verified_social_ownership", "human_confirmation", "none"] as const;
export type ClaimProof = (typeof CLAIM_PROOFS)[number];

/**
 * Proofs that may execute linkUserToAthlete. Phase A Step 3b (D-4): `verified_social_ownership` links when the other row
 * has no self-member; `human_confirmation` links only on a row created in the same flow or through an operator-decided
 * claim (D-14) — linkUserToAthlete enforces that, not the caller.
 */
export const LINKING_PROOFS: ClaimProof[] = ["existing_auth", "verified_unique_email", "verified_social_ownership", "human_confirmation"];

export const MATCH_DECISIONS = ["linked_by_auth", "linked_by_verified_email", "linked_by_ownership", "linked_by_operator", "possible_duplicate", "new"] as const;
export type MatchDecision = (typeof MATCH_DECISIONS)[number];

export interface Caller { uid: string; email: string | null; emailVerified: boolean }

export interface ProofInput {
  caller: Caller;
  /** The candidate row's auth_id (null when unclaimed). */
  candidateAuthId: string | null;
  /** The candidate row's lower(email) equals the caller's lower(email). */
  emailMatchesCandidate: boolean;
  /** How many UNCLAIMED athlete rows carry the caller's email (must be exactly one for verified_unique_email). */
  unclaimedEmailRows: number;
}

/** What the CALLER has proven about the candidate — independent of any match score. */
export function claimProofFor(i: ProofInput): ClaimProof {
  if (i.candidateAuthId && i.candidateAuthId === i.caller.uid) return "existing_auth";
  if (i.caller.emailVerified && i.caller.email && i.emailMatchesCandidate && i.unclaimedEmailRows === 1 && !i.candidateAuthId) return "verified_unique_email";
  return "none";
}

/** The 2c decision matrix (design §4.5): only a proof links; every tier on its own creates + records. */
export function decide(tier: MatchTier, proof: ClaimProof, opts: { operator?: boolean } = {}): MatchDecision {
  if (opts.operator) return "linked_by_operator";                       // 3b: an operator confirmed a proposed claim
  if (proof === "existing_auth") return "linked_by_auth";
  if (proof === "verified_unique_email") return "linked_by_verified_email";
  if (proof === "verified_social_ownership") return "linked_by_ownership";   // 3b (D-4): proven control of an account the row is built on
  if (tier === "new") return "new";
  return "possible_duplicate";                                           // human_confirmation alone never links a pre-existing row
}

export const proofMayLink = (p: ClaimProof): boolean => LINKING_PROOFS.includes(p);
