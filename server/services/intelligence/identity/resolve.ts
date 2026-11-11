/**
 * identity/resolve.ts — "search the Athlete Index first" for the creation paths (design §5.1, §6; Phase A Step 3b §5).
 *
 *   existing_auth          → return the existing row
 *   verified_unique_email  → link (+ a claim confirmed by the system, 3b)
 *   auto_match | candidate → 3b: propose claims and ask ("Is this you?") — action "confirm"; the caller answers 409
 *   claimSessionId given   → 3b: read what the user decided in that session (never what the client says)
 *   otherwise              → create the new row and RECORD the candidates (possible_duplicate | new)
 *
 * No provider call anywhere. The caller performs the insert (its own column set) — through createAthleteForUser when the
 * claim flag is on — and then calls finalizeResolution so the match row carries the created athlete id.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../db";
import { athleteUsers, athletes, identityClaims } from "../../../../shared/schema";
import { claimProofFor, decide, type Caller, type ClaimProof, type MatchDecision } from "./claim";
import { proposeClaims, sessionState, type ClaimView } from "./claims";
import { getIdentityPolicy } from "./config";
import { findCandidates, type CandidateQuery, type CandidateResult } from "./index";
import { linkUserToAthlete, recordMatch, type RecordMatchInput } from "./link";

export interface ResolveInput {
  path: RecordMatchInput["path"];
  caller: Caller;
  provider: string;
  query: CandidateQuery;   // the email is taken from the caller, never from the query
  /** 3b: the retry after "Is this you?" — which session's decisions to read; never authority by itself. */
  claimSessionId?: string | null;
  /**
   * Sign-ups closed (SIGNUPS_OPEN off): only an existing account or a claim PROOF (a unique verified e-mail) may resolve.
   * No session is read and no candidate is proposed or returned; anything else comes back `create`, which the caller refuses.
   */
  linkOnly?: boolean;
}

export interface Resolution {
  action: "existing" | "linked" | "create" | "confirm" | "session_unknown";
  athleteId: string | null;
  status: string | null;
  tier: CandidateResult["tier"];
  proof: ClaimProof;
  decision: MatchDecision;
  result: CandidateResult;
  matchId: string | null;
  input: ResolveInput;
  /** action "confirm": the session and the proposed claims to show. action "create" after a session: carried for the note. */
  claimSessionId?: string | null;
  claims?: ClaimView[];
}

export async function resolveIdentity(i: ResolveInput): Promise<Resolution> {
  const policy = await getIdentityPolicy();
  // 1. existing auth linkage is authoritative
  const [existing] = await db.select({ id: athletes.id, status: athletes.status }).from(athletes).where(eq(athletes.auth_id, i.caller.uid)).limit(1);
  // SECURITY: an email reaches ANY match (candidate search, the unique-email link) only when the provider VERIFIED it
  // (email_verified === true on the server-verified ID token). An unverified address is anyone's to type in: it may
  // still create a new athlete, but it must never surface, propose or attach an existing one.
  const verifiedEmail = i.caller.emailVerified === true ? (i.caller.email ?? null) : null;
  const query: CandidateQuery = { ...i.query, email: verifiedEmail };
  const result = await findCandidates(query, { policy, limit: 5 });
  if (existing) {
    return { action: "existing", athleteId: existing.id, status: existing.status, tier: result.tier, proof: "existing_auth", decision: "linked_by_auth", result, matchId: null, input: i };
  }
  // 2. a UNIQUE, provider-VERIFIED email may link
  const emailLower = verifiedEmail?.trim().toLowerCase() || null;
  const unclaimed = emailLower ? await db.select({ id: athletes.id, status: athletes.status }).from(athletes).where(and(sql`lower(${athletes.email}) = ${emailLower}`, isNull(athletes.auth_id))).limit(3) : [];
  const target = unclaimed.length === 1 ? unclaimed[0] : null;
  const proof = target ? claimProofFor({ caller: i.caller, candidateAuthId: null, emailMatchesCandidate: true, unclaimedEmailRows: unclaimed.length }) : "none";
  if (proof === "verified_unique_email" && target) {
    const matchId = await recordMatch({ path: i.path, query: i.query, result, proof, decision: "linked_by_verified_email", chosenAthleteId: target.id });
    const link = await linkUserToAthlete(target.id, i.caller.uid, i.provider, proof, new Date(), { email: i.caller.email, emailVerified: i.caller.emailVerified });
    // 3b: the link is a claim confirmed by the system; the membership records it
    const [claim] = await db.insert(identityClaims).values({ user_id: link.userId, athlete_id: target.id, match_id: matchId, proof, status: "confirmed", decided_by: "system", decided_at: new Date(), claim_session_id: i.claimSessionId ?? null, note: { path: i.path, tier: result.tier } as any }).returning({ id: identityClaims.id });
    await db.update(athleteUsers).set({ claim_id: claim.id }).where(eq(athleteUsers.id, link.membershipId));
    return { action: "linked", athleteId: target.id, status: link.status, tier: result.tier, proof, decision: "linked_by_verified_email", result, matchId, input: i };
  }
  if (i.linkOnly) return { action: "create", athleteId: null, status: null, tier: result.tier, proof: "none", decision: decide(result.tier, "none"), result, matchId: null, input: i };
  // 3b. a retry with a session: read the user's decisions
  if (i.claimSessionId) {
    const st = await sessionState(i.caller, i.claimSessionId);
    if (!st.known) return { action: "session_unknown", athleteId: null, status: null, tier: result.tier, proof: "none", decision: decide(result.tier, "none"), result, matchId: null, input: i, claimSessionId: i.claimSessionId };
    if (st.confirmedAthleteId) {
      const [row] = await db.select({ status: athletes.status }).from(athletes).where(eq(athletes.id, st.confirmedAthleteId)).limit(1);
      return { action: "existing", athleteId: st.confirmedAthleteId, status: row?.status ?? null, tier: result.tier, proof: "existing_auth", decision: "linked_by_auth", result, matchId: null, input: i, claimSessionId: i.claimSessionId };
    }
    if (st.undecided.length) {
      // the same question again (the client resumed): no new session, no new rows
      const { listMine } = await import("./claims");
      const mine = (await listMine(i.caller)).find((g) => g.claimSessionId === i.claimSessionId);
      return { action: "confirm", athleteId: null, status: null, tier: result.tier, proof: "none", decision: "possible_duplicate", result, matchId: null, input: i, claimSessionId: i.claimSessionId, claims: mine?.claims ?? [] };
    }
    // every claim decided (pending an operator, rejected, expired): she continues on a NEW row
    return { action: "create", athleteId: null, status: null, tier: result.tier, proof: "none", decision: decide(result.tier, "none"), result, matchId: null, input: i, claimSessionId: i.claimSessionId };
  }
  // 3. public evidence: 3b asks first when there is something to ask about
  if ((result.tier === "auto_match" || result.tier === "candidate") && result.candidates.length) {
    const matchId = await recordMatch({ path: i.path, query: i.query, result, proof: "none", decision: "possible_duplicate", chosenAthleteId: result.best?.record.athleteId ?? null });
    const proposed = await proposeClaims({ caller: i.caller, path: i.path, result, matchId });
    if (proposed.claims.length) return { action: "confirm", athleteId: null, status: null, tier: result.tier, proof: "none", decision: "possible_duplicate", result, matchId, input: i, claimSessionId: proposed.claimSessionId, claims: proposed.claims };
    // every candidate was a blocked pair (rejected before): nothing to ask — create and record
    return { action: "create", athleteId: null, status: null, tier: result.tier, proof: "none", decision: "possible_duplicate", result, matchId, input: i };
  }
  const decision = decide(result.tier, "none");
  return { action: "create", athleteId: null, status: null, tier: result.tier, proof: "none", decision, result, matchId: null, input: i };
}

/** After the caller inserted the new row: record the decision with the created athlete id. */
export async function finalizeResolution(r: Resolution, createdAthleteId: string): Promise<string> {
  return recordMatch({ path: r.input.path, query: r.input.query, result: r.result, proof: r.proof, decision: r.decision, createdAthleteId, chosenAthleteId: r.result.best?.record.athleteId ?? null });
}
