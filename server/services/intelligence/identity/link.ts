/**
 * identity/link.ts — the ONE writer of the user → athlete link, and the match telemetry.
 *
 * linkUserToAthlete writes athletes.auth_id today because that is where the link lives (ADR-015
 * documented debt); Step 3 replaces this body with a membership insert and nothing else moves.
 * It THROWS unless the claim proof is sufficient — a match tier is never a proof.
 */

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../../db";
import { athletes, athleteIndexMatches, identityClaims } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { proofMayLink, type ClaimProof, type MatchDecision } from "./claim";
import type { CandidateResult, MatchTier } from "./index";
import { ensureUser, insertSelfMembership, isUniqueViolation, SelfMembershipTaken, type IdentityClient, type InsertSelfMembershipOptions } from "./users";

const logger = createLogger("athlete-index");

export class ClaimNotAuthorized extends Error {
  constructor(public readonly proof: ClaimProof) { super(`claim not authorized: proof ${proof} cannot link a user to an athlete`); this.name = "ClaimNotAuthorized"; }
}

/**
 * Link `uid` to `athleteId`. Refuses without a linking proof. ATOMIC (review of PR #404): one conditional
 * UPDATE whose predicate protects the checked auth state — `auth_id IS NULL OR auth_id = uid` — so two
 * concurrent claims by different users cannot both observe NULL and overwrite each other; exactly one wins
 * and the loser is refused after a reload. Idempotent for the same uid (claimed_at is kept). Preserves an
 * operator's activation: status changes only from raw/enriched to claimed.
 */
export async function linkUserToAthlete(athleteId: string, uid: string, provider: string, proof: ClaimProof, now: Date = new Date(), extra: { email?: string | null; emailVerified?: boolean; displayName?: string | null; claimId?: string | null; note?: string | null; /** 3b: the row was created in this same flow (createAthleteForUser sets it inside its own transaction) */ createdInFlow?: boolean; /** 3b: run inside the caller's transaction instead of opening one */ tx?: IdentityClient } & InsertSelfMembershipOptions = {}): Promise<{ status: string; userId: string; membershipId: string; /** 3b: set when the auth_id projection could not move because the user's other row holds it (0049) */ projectionHeldBy?: string }> {
  if (!proofMayLink(proof)) throw new ClaimNotAuthorized(proof);
  const body = async (tx: IdentityClient): Promise<{ status: string; userId: string; membershipId: string; projectionHeldBy?: string }> => {
    // Phase A Step 3b (D-14): a human click links only a row created in this flow, or through a claim an OPERATOR decided.
    if (proof === "human_confirmation" && !extra.createdInFlow) {
      const ok = extra.claimId ? await operatorDecidedClaimFor(tx, extra.claimId, athleteId, uid) : false;
      if (!ok) throw new ClaimNotAuthorized(proof);
    }
  // Phase A Step 3a: ONE transaction — the user, the self-membership (athlete_users_one_self_uq is the atomic guard) and the
  // athletes.auth_id PROJECTION (the same conditional write as before, kept for every legacy reader until 3d).
    const user = await ensureUser({ uid, email: extra.email ?? null, emailVerified: extra.emailVerified === true, displayName: extra.displayName ?? null }, tx);
    let membership;
    try { membership = await insertSelfMembership({ athleteId, userId: user.id, proof: proof as Exclude<ClaimProof, "none">, claimId: extra.claimId ?? null, note: extra.note ?? null, establishedAt: now }, tx, { __afterPreRead: extra.__afterPreRead }); }
    catch (err) { if (err instanceof SelfMembershipTaken) throw new ClaimNotAuthorized(proof); throw err; }   // never re-bind an athlete that has a user
    let won: { status: string; auth_id: string | null } | undefined;
    try {
      // the projection write in its own SAVEPOINT: athletes_auth_id_uq (0049) allows one row per uid, and a user may hold a
      // second self-membership (an ownership link, D-2) until 3c resolves the pair — that membership is membership-only
      [won] = await (tx as typeof db).transaction(async (sp) => sp.update(athletes)
        .set({
          auth_id: uid,
          auth_provider: provider,
          claimed_at: sql`coalesce(${athletes.claimed_at}, ${now})`,
          status: sql`CASE WHEN ${athletes.status} IN ('raw','enriched') THEN 'claimed' ELSE ${athletes.status} END`,
        })
        .where(and(eq(athletes.id, athleteId), or(isNull(athletes.auth_id), eq(athletes.auth_id, uid))))
        .returning({ status: athletes.status, auth_id: athletes.auth_id }));
    } catch (err) {
      if (!isUniqueViolation(err, "athletes_auth_id_uq")) throw err;
      const [held] = await tx.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, uid)).limit(1);
      if (!held || held.id === athleteId) throw err;
      const [row] = await tx.select({ status: athletes.status }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
      if (!row) throw new Error(`athlete ${athleteId} not found`);
      logger.info({ athleteId, proof, projectionHeldBy: held.id }, "user linked to athlete (membership only: the auth_id projection stays on her other row until 3c)");
      return { status: row.status, userId: user.id, membershipId: membership.id, projectionHeldBy: held.id };
    }
    if (won) { logger.info({ athleteId, proof, status: won.status }, "user linked to athlete"); return { status: won.status, userId: user.id, membershipId: membership.id }; }
    // No row: the athlete does not exist, or the projection names another user (a pre-0051 link with no membership yet).
    const [row] = await tx.select({ auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    if (!row) throw new Error(`athlete ${athleteId} not found`);
    throw new ClaimNotAuthorized(proof);   // rolls back the membership too
  };
  if (extra.tx) return body(extra.tx);
  return db.transaction(async (tx) => body(tx));
}

/** 3b: the claim exists, names this athlete, belongs to this uid's user, and an operator decided it. */
async function operatorDecidedClaimFor(tx: IdentityClient, claimId: string, athleteId: string, uid: string): Promise<boolean> {
  const { users } = await import("../../../../shared/schema");
  const [row] = await tx.select({ athlete_id: identityClaims.athlete_id, decided_by: identityClaims.decided_by, provider_uid: users.provider_uid })
    .from(identityClaims).innerJoin(users, eq(users.id, identityClaims.user_id)).where(eq(identityClaims.id, claimId)).limit(1);
  return !!row && row.athlete_id === athleteId && row.provider_uid === uid && row.decided_by === "operator";
}

/**
 * 3b telemetry: a claim decided AFTER the proposal appends a new athlete_index_matches row carrying the proposal's query,
 * candidates, tier and policy with the new decision — telemetry is append-only, the proposal row is never rewritten.
 */
export async function recordFollowUp(matchId: string, i: { proof: ClaimProof; decision: MatchDecision; chosenAthleteId: string | null; createdAthleteId?: string | null }, client: IdentityClient = db): Promise<string | null> {
  const [m] = await client.select().from(athleteIndexMatches).where(eq(athleteIndexMatches.id, matchId)).limit(1);
  if (!m) return null;
  const [row] = await client.insert(athleteIndexMatches).values({
    path: m.path, query: m.query as any, candidates: m.candidates as any, tier: m.tier, claim_proof: i.proof, decision: i.decision,
    chosen_athlete_id: i.chosenAthleteId, created_athlete_id: i.createdAthleteId ?? null, policy_version: m.policy_version,
  }).returning({ id: athleteIndexMatches.id });
  return row.id;
}

export interface RecordMatchInput {
  path: "signup" | "microsoft" | "waitlist" | "admin" | "api" | "connect";
  query: { name: string; sport?: string | null; teamOrSchool?: string | null; classYear?: number | null; handles?: Record<string, string | null | undefined> };
  result: Pick<CandidateResult, "candidates" | "tier" | "ambiguousIdentifier" | "policyVersion">;
  proof: ClaimProof;
  decision: MatchDecision;
  chosenAthleteId?: string | null;
  createdAthleteId?: string | null;
}

/** Telemetry, not state. The query never carries the email; the row never carries the uid. */
export async function recordMatch(i: RecordMatchInput): Promise<string> {
  const candidates = i.result.candidates.slice(0, 10).map((c) => { const { emailExact: _e, ...signals } = c.signals; return { athleteId: c.record.athleteId, matchScore: c.matchScore, corroborated: c.corroborated, uniqueIdentifier: c.uniqueIdentifier, claimability: c.record.claimability, signals }; });
  const handles = Object.fromEntries(Object.entries(i.query.handles ?? {}).filter(([, v]) => !!v).map(([k, v]) => [k, String(v).replace(/^@/, "").slice(0, 64)]));
  const [row] = await db.insert(athleteIndexMatches).values({
    path: i.path, query: { name: i.query.name.slice(0, 160), sport: i.query.sport ?? null, teamOrSchool: i.query.teamOrSchool ?? null, classYear: i.query.classYear ?? null, handles, ambiguousIdentifier: i.result.ambiguousIdentifier } as any,
    candidates: candidates as any, tier: i.result.tier as MatchTier, claim_proof: i.proof, decision: i.decision,
    chosen_athlete_id: i.chosenAthleteId ?? null, created_athlete_id: i.createdAthleteId ?? null, policy_version: i.result.policyVersion,
  }).returning({ id: athleteIndexMatches.id });
  return row.id;
}
