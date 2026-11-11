/**
 * identity/claims.ts — the claim lifecycle (Phase A Step 3b; design §5, D-3, D-4, D-14; plan §3b).
 *
 *   proposeClaims        one session UUID per candidate-selection interaction; one `proposed` claim per candidate
 *   confirmClaim         the §3 matrix: a corroborating proof links (verified_unique_email / verified_social_ownership /
 *                        existing_auth); no corroboration ⇒ the claim stays proposed for an operator; a row with a
 *                        self-member (or a golden anchor) ⇒ rejected by the system, never a link, never a merge
 *   dismissSession       "none of these" — expires the caller's proposed claims in that session
 *   listMine             the caller's open claims grouped by session (client resume)
 *   decideClaim          the operator's confirm / reject (confirm ⇒ linked_by_operator)
 *   createAthleteForUser the new row + its self-membership (proof human_confirmation, created in this flow) in ONE transaction
 *   expireStale          the 7-day sweep
 *   proposeLegacyNameClaim  the legacy /signup name match, recorded as a proposed claim for an operator (never a link)
 *
 * The ONLY writer of identity_claims transitions besides identity/ownership.ts (which proposes the §3a-C collision claim).
 * A claim never changes an athlete row; linkUserToAthlete is still the only membership writer. No client-supplied athlete id
 * is ever authority: the athlete always comes from the claim row, and a claim is bound to the caller's user (+ session).
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../../../db";
import { athleteUsers, athletes, goldenAthletes, identityClaims, users } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { escapeLike, nameUsableForMatch } from "../../../lib/signups";
import type { Caller, ClaimProof } from "./claim";
import { publicCandidate, readIndexRecords, type CandidateResult } from "./index";
import { ClaimNotAuthorized, linkUserToAthlete, recordFollowUp, type RecordMatchInput } from "./link";
import { ensureUser, findUserByUid, providerOf, selfMembershipFor, type IdentityClient } from "./users";

const logger = createLogger("identity-claims");
export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ClaimStatus = "proposed" | "confirmed" | "rejected" | "expired" | "superseded";
export type ClaimRow = typeof identityClaims.$inferSelect;
export interface ClaimView { claimId: string; athleteId: string; status: ClaimStatus; proof: ClaimProof; proposedAt: string; candidate: ReturnType<typeof publicCandidate> | null; userConfirmedAt: string | null }

function transition(row: Pick<ClaimRow, "id" | "user_id" | "athlete_id" | "proof" | "claim_session_id">, from: string, to: ClaimStatus, decidedBy: "user" | "operator" | "system" | null, extra: Record<string, unknown> = {}) {
  logger.info({ claim: "identity_claim", claimId: row.id, userId: row.user_id, athleteId: row.athlete_id, sessionId: row.claim_session_id, from, to, decidedBy, proof: row.proof, ...extra }, "identity claim transition");
}

/** Propose one claim per candidate for a signed-in user (no membership yet). Idempotent inside the session (partial unique). */
export async function proposeClaims(i: { caller: Caller; path: RecordMatchInput["path"]; result: Pick<CandidateResult, "candidates" | "tier">; matchId: string | null }, client: IdentityClient = db): Promise<{ claimSessionId: string; claims: ClaimView[] }> {
  const user = await ensureUser({ uid: i.caller.uid, email: i.caller.email, emailVerified: i.caller.emailVerified }, client);
  const claimSessionId = randomUUID();
  const athleteIds = i.result.candidates.map((c) => c.record.athleteId);
  // a rejected claim on a pair blocks re-proposal of that pair for that user (design §5): the pair is an operator's
  const blocked = new Set(athleteIds.length ? (await client.select({ athleteId: identityClaims.athlete_id }).from(identityClaims).where(and(eq(identityClaims.user_id, user.id), inArray(identityClaims.athlete_id, athleteIds), eq(identityClaims.status, "rejected")))).map((r) => r.athleteId) : []);
  const claims: ClaimView[] = [];
  for (const c of i.result.candidates) {
    if (blocked.has(c.record.athleteId)) continue;
    const [row] = await client.insert(identityClaims).values({
      user_id: user.id, athlete_id: c.record.athleteId, match_id: i.matchId, proof: "none", status: "proposed", claim_session_id: claimSessionId,
      note: { path: i.path, tier: i.result.tier, matchScore: c.matchScore, corroborated: c.corroborated, claimability: c.record.claimability } as any,
    }).onConflictDoNothing().returning();
    if (!row) continue;
    transition(row, "—", "proposed", null, { path: i.path, tier: i.result.tier, matchScore: c.matchScore });
    claims.push({ claimId: row.id, athleteId: row.athlete_id, status: "proposed", proof: "none", proposedAt: row.proposed_at.toISOString(), candidate: publicCandidate(c), userConfirmedAt: null });
  }
  return { claimSessionId, claims };
}

export type ConfirmOutcome =
  | { outcome: "linked"; athleteId: string; status: string; proof: ClaimProof; decision: "linked_by_auth" | "linked_by_verified_email" | "linked_by_ownership" }
  | { outcome: "pending_operator"; athleteId: string }
  | { outcome: "taken"; athleteId: string; reason: "self_member_exists" | "golden_anchor" | "rejected" }
  | { outcome: "expired" }
  | { outcome: "not_found" };

async function loadOwnClaim(caller: Caller, claimId: string, claimSessionId: string | null): Promise<{ user: { id: string }; claim: ClaimRow } | null> {
  const user = await findUserByUid(caller.uid);
  if (!user) return null;
  const [claim] = await db.select().from(identityClaims).where(and(eq(identityClaims.id, claimId), eq(identityClaims.user_id, user.id))).limit(1);
  if (!claim) return null;
  // a session-bound claim must be addressed with its session; a collision claim (NULL session) without one
  if ((claim.claim_session_id ?? null) !== (claimSessionId ?? null)) return null;
  return { user, claim };
}

async function setStatus(claimId: string, to: ClaimStatus, decidedBy: "user" | "operator" | "system", notePatch: Record<string, unknown> = {}, client: IdentityClient = db): Promise<void> {
  await client.update(identityClaims).set({ status: to, decided_by: decidedBy, decided_at: new Date(), note: sql`coalesce(${identityClaims.note}, '{}'::jsonb) || ${JSON.stringify(notePatch)}::jsonb` }).where(eq(identityClaims.id, claimId));
}

/**
 * The user decided on ONE candidate of a session: every other still-proposed claim of that session is `superseded` by the
 * system (note reason user_chose_other), so the signup retry reads a decided session and creates or returns — it never
 * asks the same question again (acceptance on dev, 12 Sep 2026: after "taken" the retry re-asked about the siblings).
 */
async function supersedeSiblings(claim: Pick<ClaimRow, "id" | "user_id" | "claim_session_id">): Promise<number> {
  if (!claim.claim_session_id) return 0;
  const rows = await db.update(identityClaims).set({ status: "superseded", decided_by: "system", decided_at: new Date(), note: sql`coalesce(${identityClaims.note}, '{}'::jsonb) || ${JSON.stringify({ reason: "user_chose_other", chosenClaimId: claim.id })}::jsonb` })
    .where(and(eq(identityClaims.user_id, claim.user_id), eq(identityClaims.claim_session_id, claim.claim_session_id), eq(identityClaims.status, "proposed"), sql`${identityClaims.id} <> ${claim.id}`)).returning();
  for (const r of rows) transition(r, "proposed", "superseded", "system", { reason: "user_chose_other", chosenClaimId: claim.id });
  return rows.length;
}

/** The user says "that's me" on one candidate (design §5 / plan §3). Never a merge; never a takeover without corroboration. */
export async function confirmClaim(i: { caller: Caller; claimId: string; claimSessionId: string | null }): Promise<ConfirmOutcome> {
  const own = await loadOwnClaim(i.caller, i.claimId, i.claimSessionId);
  if (!own) return { outcome: "not_found" };
  const { user, claim } = own;
  if (claim.status === "confirmed") { const [a] = await db.select({ status: athletes.status }).from(athletes).where(eq(athletes.id, claim.athlete_id)); return { outcome: "linked", athleteId: claim.athlete_id, status: a?.status ?? "claimed", proof: claim.proof as ClaimProof, decision: decisionFor(claim.proof as ClaimProof) }; }
  if (claim.status === "rejected") return { outcome: "taken", athleteId: claim.athlete_id, reason: "rejected" };
  if (claim.status !== "proposed") return { outcome: "expired" };
  if (claim.proposed_at.getTime() + CLAIM_TTL_MS < Date.now()) { await setStatus(claim.id, "expired", "system", { reason: "ttl" }); transition(claim, "proposed", "expired", "system", { reason: "ttl" }); return { outcome: "expired" }; }

  const [row] = await db.select({ id: athletes.id, auth_id: athletes.auth_id, email: athletes.email, status: athletes.status }).from(athletes).where(eq(athletes.id, claim.athlete_id)).limit(1);
  if (!row) { await setStatus(claim.id, "rejected", "system", { reason: "athlete_missing" }); return { outcome: "taken", athleteId: claim.athlete_id, reason: "rejected" }; }
  const [anchor] = await db.select({ id: goldenAthletes.athlete_id }).from(goldenAthletes).where(and(eq(goldenAthletes.athlete_id, row.id), sql`coalesce(${goldenAthletes.active}, true)`)).limit(1);
  if (anchor) { await setStatus(claim.id, "rejected", "system", { reason: "golden_anchor" }); transition(claim, "proposed", "rejected", "system", { reason: "golden_anchor" }); await supersedeSiblings(claim); return { outcome: "taken", athleteId: row.id, reason: "golden_anchor" }; }

  const self = await selfMembershipFor(row.id);
  if (self && self.userId !== user.id) {
    // someone else's profile: a duplicate pair for 3c, never a link (D-3)
    const mine = (await db.select({ athleteId: athleteUsers.athlete_id }).from(athleteUsers).where(and(eq(athleteUsers.user_id, user.id), isNull(athleteUsers.revoked_at)))).map((m) => m.athleteId);
    await setStatus(claim.id, "rejected", "system", { reason: "self_member_exists", pair: [row.id, ...mine] });
    transition(claim, "proposed", "rejected", "system", { reason: "self_member_exists", pair: [row.id, ...mine] });
    await supersedeSiblings(claim);
    return { outcome: "taken", athleteId: row.id, reason: "self_member_exists" };
  }

  // corroboration (D-14): what the CALLER has proven about THIS row
  let proof: ClaimProof = "none"; let ownershipClaimId: string | null = null;
  if (self && self.userId === user.id) proof = "existing_auth";
  else if (row.auth_id && row.auth_id === i.caller.uid) proof = "existing_auth";
  else {
    const emailLower = i.caller.email?.trim().toLowerCase() || null;
    if (i.caller.emailVerified && emailLower && (row.email ?? "").trim().toLowerCase() === emailLower) {
      const unclaimed = await db.select({ id: athletes.id }).from(athletes).where(and(sql`lower(${athletes.email}) = ${emailLower}`, isNull(athletes.auth_id))).limit(3);
      if (unclaimed.length === 1 && unclaimed[0].id === row.id) proof = "verified_unique_email";
    }
    if (proof === "none") {
      const [own] = await db.select({ id: identityClaims.id }).from(identityClaims).where(and(eq(identityClaims.user_id, user.id), eq(identityClaims.athlete_id, row.id), eq(identityClaims.proof, "verified_social_ownership"), eq(identityClaims.status, "proposed"))).limit(1);
      if (own) { proof = "verified_social_ownership"; ownershipClaimId = own.id; }
    }
  }
  if (proof === "none") {
    await db.update(identityClaims).set({ note: sql`coalesce(${identityClaims.note}, '{}'::jsonb) || ${JSON.stringify({ userConfirmedAt: new Date().toISOString() })}::jsonb` }).where(eq(identityClaims.id, claim.id));
    transition(claim, "proposed", "proposed", "user", { pending: "operator" });
    await supersedeSiblings(claim);
    return { outcome: "pending_operator", athleteId: row.id };
  }
  let linked: Awaited<ReturnType<typeof linkUserToAthlete>>;
  try { linked = await linkUserToAthlete(row.id, i.caller.uid, providerOf(i.caller.uid), proof, new Date(), { email: i.caller.email, emailVerified: i.caller.emailVerified, claimId: claim.id }); }
  catch (err) {
    if (!(err instanceof ClaimNotAuthorized)) throw err;
    // a concurrent confirm won the 3a guard (one self per athlete): the row is taken now — a pair for 3c, never a merge
    await setStatus(claim.id, "rejected", "system", { reason: "self_member_exists", pair: [row.id] });
    transition(claim, "proposed", "rejected", "system", { reason: "self_member_exists", race: true });
    await supersedeSiblings(claim);
    return { outcome: "taken", athleteId: row.id, reason: "self_member_exists" };
  }
  await setStatus(claim.id, "confirmed", proof === "existing_auth" ? "system" : "user", { linkedProof: proof });
  if (ownershipClaimId && ownershipClaimId !== claim.id) await setStatus(ownershipClaimId, "confirmed", "user", { linkedThrough: claim.id });
  const decision = decisionFor(proof);
  if (claim.match_id) await recordFollowUp(claim.match_id, { proof, decision, chosenAthleteId: row.id }).catch((err: any) => logger.warn({ claimId: claim.id, error: err.message }, "follow-up match record failed"));
  transition(claim, "proposed", "confirmed", proof === "existing_auth" ? "system" : "user", { linkedProof: proof, decision });
  await supersedeSiblings(claim);
  return { outcome: "linked", athleteId: row.id, status: linked.status, proof, decision };
}

const decisionFor = (proof: ClaimProof): "linked_by_auth" | "linked_by_verified_email" | "linked_by_ownership" =>
  proof === "existing_auth" ? "linked_by_auth" : proof === "verified_social_ownership" ? "linked_by_ownership" : "linked_by_verified_email";

/** "None of these": every proposed claim of the caller's user in that session expires. Another user's session id does nothing. */
export async function dismissSession(caller: Caller, claimSessionId: string): Promise<number> {
  const user = await findUserByUid(caller.uid);
  if (!user) return 0;
  const rows = await db.update(identityClaims).set({ status: "expired", decided_by: "user", decided_at: new Date() })
    .where(and(eq(identityClaims.user_id, user.id), eq(identityClaims.claim_session_id, claimSessionId), eq(identityClaims.status, "proposed"))).returning();
  for (const r of rows) transition(r, "proposed", "expired", "user", { reason: "dismissed" });
  return rows.length;
}

/** The caller's open claims grouped by session, newest session first (client resume). */
export async function listMine(caller: Caller): Promise<Array<{ claimSessionId: string | null; claims: ClaimView[] }>> {
  const user = await findUserByUid(caller.uid);
  if (!user) return [];
  const rows = await db.select().from(identityClaims).where(and(eq(identityClaims.user_id, user.id), eq(identityClaims.status, "proposed"), notLegacyNameClaim, sql`${identityClaims.proposed_at} > now() - interval '7 days'`)).orderBy(desc(identityClaims.proposed_at));
  const records = await readIndexRecords([...new Set(rows.map((r) => r.athlete_id))]);   // Map<athleteId, record>
  const groups = new Map<string | null, ClaimView[]>();
  for (const r of rows) {
    const rec = records.get(r.athlete_id) ?? null; const note = (r.note ?? {}) as Record<string, unknown>;
    const view: ClaimView = { claimId: r.id, athleteId: r.athlete_id, status: r.status as ClaimStatus, proof: r.proof as ClaimProof, proposedAt: r.proposed_at.toISOString(), userConfirmedAt: (note.userConfirmedAt as string) ?? null,
      candidate: rec ? { ...rec, matchScore: Number(note.matchScore ?? 0), corroborated: !!note.corroborated, signals: { nameSim: 0, sportMatch: null, teamMatch: null, yearMatch: null, handleExact: null } } : null };   // the proposal's score; live signals are not recomputed on resume
    groups.set(r.claim_session_id, [...(groups.get(r.claim_session_id) ?? []), view]);
  }
  return [...groups.entries()].map(([claimSessionId, claims]) => ({ claimSessionId, claims }));
}

/** The session's state for a signup retry: what the user decided, never what the client says. */
export async function sessionState(caller: Caller, claimSessionId: string): Promise<{ known: false } | { known: true; confirmedAthleteId: string | null; undecided: ClaimRow[]; pendingOperator: ClaimRow[] }> {
  const user = await findUserByUid(caller.uid);
  if (!user) return { known: false };
  const rows = await db.select().from(identityClaims).where(and(eq(identityClaims.user_id, user.id), eq(identityClaims.claim_session_id, claimSessionId)));
  if (!rows.length) return { known: false };
  const confirmed = rows.find((r) => r.status === "confirmed");
  const proposed = rows.filter((r) => r.status === "proposed" && r.proposed_at.getTime() + CLAIM_TTL_MS >= Date.now());
  return { known: true, confirmedAthleteId: confirmed?.athlete_id ?? null, undecided: proposed.filter((r) => !((r.note ?? {}) as any).userConfirmedAt), pendingOperator: proposed.filter((r) => !!((r.note ?? {}) as any).userConfirmedAt) };
}

/** Operator queue. */
export async function listClaims(status: ClaimStatus | "all", limit = 100): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select({ id: identityClaims.id, user_id: identityClaims.user_id, athlete_id: identityClaims.athlete_id, proof: identityClaims.proof, status: identityClaims.status, proposed_at: identityClaims.proposed_at, decided_at: identityClaims.decided_at, decided_by: identityClaims.decided_by, note: identityClaims.note, claim_session_id: identityClaims.claim_session_id, athlete_name: athletes.full_name,
      user_provider: users.provider, user_email: users.email, user_email_verified: users.email_verified })
    .from(identityClaims).innerJoin(athletes, eq(athletes.id, identityClaims.athlete_id)).leftJoin(users, eq(users.id, identityClaims.user_id)).where(status === "all" ? sql`true` : eq(identityClaims.status, status)).orderBy(desc(identityClaims.proposed_at)).limit(limit);
  return rows.map((r) => ({ claimId: r.id, userId: r.user_id, athleteId: r.athlete_id, athleteName: r.athlete_name, proof: r.proof, status: r.status, proposedAt: r.proposed_at, decidedAt: r.decided_at, decidedBy: r.decided_by, claimSessionId: r.claim_session_id, note: r.note,
    // who is asking, so the operator can weigh the claim: the sign-in provider and the e-mail with its verification
    user: { provider: r.user_provider ?? null, email: r.user_email ?? null, emailVerified: r.user_email_verified ?? null } }));   // no provider uid, ever
}

export type DecideOutcome = { outcome: "linked"; athleteId: string } | { outcome: "rejected" } | { outcome: "taken"; reason: "self_member_exists" } | { outcome: "not_found" } | { outcome: "not_proposed"; status: string }
  | { outcome: "manual_merge_required"; athleteId: string; heldBy: string; message: string };

/** The note path of the proposals the legacy /signup records for a name match (auth.ts proposeLegacyNameClaim). */
export const LEGACY_NAME_CLAIM_PATH = "signup_legacy_name";
/** SQL: the claim is NOT a legacy name-match proposal (those are operator-only: never shown to the user who triggered them). */
const notLegacyNameClaim = sql`coalesce(${identityClaims.note}->>'path', '') <> ${LEGACY_NAME_CLAIM_PATH}`;

const manualMergeMessage = (target: string, heldBy: string) =>
  `Not linked. This user already signs in to another athlete row (${heldBy}). Approving would only add a second ` +
  `membership: the sign-in would keep resolving to ${heldBy} (or ask the app to pick a profile), not ${target}. Merge the ` +
  `two rows by hand: FIRST re-check that ${target} still has auth_id NULL and no active self-membership (someone may have ` +
  `claimed it since this answer; if so, stop and reject this claim), then move the account's data and auth to ${target} ` +
  `and retire ${heldBy}, then reject or leave this claim. The claim stays proposed and is kept out of the 7-day expiry.`;

/** Another athlete row this user already holds: the auth_id projection, else an active self-membership. Null when none. */
async function otherRowHeldBy(userId: string, uid: string, targetAthleteId: string): Promise<string | null> {
  const [byAuth] = await db.select({ id: athletes.id }).from(athletes).where(and(eq(athletes.auth_id, uid), sql`${athletes.id} <> ${targetAthleteId}`)).limit(1);
  if (byAuth) return byAuth.id;
  const [byMember] = await db.select({ id: athleteUsers.athlete_id }).from(athleteUsers)
    .where(and(eq(athleteUsers.user_id, userId), isNull(athleteUsers.revoked_at), sql`${athleteUsers.athlete_id} <> ${targetAthleteId}`)).limit(1);
  return byMember?.id ?? null;
}

/** The operator's decision (D-14: operator approval may link a pre-existing row; a row with a self-member is refused, never merged). */
export async function decideClaim(i: { claimId: string; decision: "confirm" | "reject"; note?: string | null; operator: string }): Promise<DecideOutcome> {
  const [claim] = await db.select().from(identityClaims).where(eq(identityClaims.id, i.claimId)).limit(1);
  if (!claim) return { outcome: "not_found" };
  if (claim.status !== "proposed") return { outcome: "not_proposed", status: claim.status };
  if (i.decision === "reject") {
    await setStatus(claim.id, "rejected", "operator", { operatorNote: i.note ?? null, operator: i.operator });
    transition(claim, "proposed", "rejected", "operator");
    return { outcome: "rejected" };
  }
  const self = await selfMembershipFor(claim.athlete_id);
  if (self && self.userId !== claim.user_id) return { outcome: "taken", reason: "self_member_exists" };
  const [u] = await db.select({ uid: users.provider_uid, email: users.email, emailVerified: users.email_verified }).from(users).where(eq(users.id, claim.user_id)).limit(1);
  if (!u) return { outcome: "not_found" };
  // The user ALREADY holds another row (a legacy name-match proposal always does: /signup created one; an index "Is this
  // you?" claim does when she continued on a new row while it waited for an operator). Linking here would land in
  // linkUserToAthlete's projectionHeldBy branch (membership only): the auth_id projection would stay on her other row, and
  // with IDENTITY_MEMBERSHIP_READ a second self-membership makes every request ask which athlete (409 / X-Athlete-Id) —
  // the approval would not take effect cleanly. Moving the projection and retiring the other row is a data merge (roles,
  // runs, connections, content may hang off it) that is not safe to do automatically, so EVERY operator approval in that
  // state is refused and routed to a manual merge.
  const heldBy = await otherRowHeldBy(claim.user_id, u.uid, claim.athlete_id);
  if (heldBy) {
    await db.update(identityClaims).set({ note: sql`coalesce(${identityClaims.note}, '{}'::jsonb) || ${JSON.stringify({ manualMergeRequired: { heldBy, operator: i.operator, at: new Date().toISOString(), operatorNote: i.note ?? null } })}::jsonb` }).where(eq(identityClaims.id, claim.id));
    transition(claim, "proposed", "proposed", "operator", { pending: "manual_merge", heldBy });
    return { outcome: "manual_merge_required", athleteId: claim.athlete_id, heldBy, message: manualMergeMessage(claim.athlete_id, heldBy) };
  }
  // decided_by = operator FIRST: that is what lets linkUserToAthlete accept human_confirmation on a pre-existing row
  await db.update(identityClaims).set({ decided_by: "operator", decided_at: new Date(), note: sql`coalesce(${identityClaims.note}, '{}'::jsonb) || ${JSON.stringify({ operatorNote: i.note ?? null, operator: i.operator })}::jsonb` }).where(eq(identityClaims.id, claim.id));
  try {
    await linkUserToAthlete(claim.athlete_id, u.uid, providerOf(u.uid), "human_confirmation", new Date(), { claimId: claim.id, email: u.email, emailVerified: u.emailVerified });
  } catch (err) {
    await db.update(identityClaims).set({ decided_by: null, decided_at: null }).where(eq(identityClaims.id, claim.id));
    throw err;
  }
  await db.update(identityClaims).set({ status: "confirmed" }).where(eq(identityClaims.id, claim.id));
  if (claim.match_id) await recordFollowUp(claim.match_id, { proof: "human_confirmation", decision: "linked_by_operator", chosenAthleteId: claim.athlete_id }).catch(() => null);
  transition(claim, "proposed", "confirmed", "operator", { decision: "linked_by_operator" });
  return { outcome: "linked", athleteId: claim.athlete_id };
}

/** The new row + its self-membership (proof human_confirmation — a row created in this flow cannot be anyone else's) in ONE transaction. */
export async function createAthleteForUser(i: { caller: Caller; provider: string; values: Partial<typeof athletes.$inferInsert> & { full_name: string }; path: RecordMatchInput["path"]; claimSessionId?: string | null; displayName?: string | null }): Promise<{ athleteId: string; userId: string; membershipId: string }> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx.insert(athletes).values({ ...i.values, auth_id: i.caller.uid, auth_provider: i.provider } as any).returning({ id: athletes.id });
    const link = await linkUserToAthlete(inserted.id, i.caller.uid, i.provider, "human_confirmation", new Date(), { tx, createdInFlow: true, email: i.caller.email, emailVerified: i.caller.emailVerified, displayName: i.displayName ?? i.values.full_name, note: i.claimSessionId ? `created_after_claim:${i.claimSessionId}` : `created:${i.path}` });
    logger.info({ athleteId: inserted.id, userId: link.userId, path: i.path, claimSessionId: i.claimSessionId ?? null }, "athlete created for user (claim flow)");
    return { athleteId: inserted.id, userId: link.userId, membershipId: link.membershipId };
  });
}

/** The 7-day sweep (archive-stale-cron). */
export async function expireStale(now: Date = new Date()): Promise<number> {
  const rows = await db.update(identityClaims).set({ status: "expired", decided_by: "system", decided_at: now }).where(and(eq(identityClaims.status, "proposed"), lt(identityClaims.proposed_at, new Date(now.getTime() - CLAIM_TTL_MS)),
    sql`NOT (coalesce(${identityClaims.note}, '{}'::jsonb) ? 'manualMergeRequired')`)).returning();   // a manual merge stays queued
  for (const r of rows) transition(r, "proposed", "expired", "system", { reason: "ttl" });
  if (rows.length) logger.info({ expired: rows.length }, "identity claims expired by the sweep");
  return rows.length;
}

/** The count /auth/me shows (additive). */
export async function pendingClaimCount(userId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(identityClaims).where(and(eq(identityClaims.user_id, userId), eq(identityClaims.status, "proposed"), notLegacyNameClaim));
  return r?.n ?? 0;
}

/**
 * After a legacy /signup created a NEW row: if one unclaimed raw/enriched profile plausibly has this name, record a
 * `proposed` identity claim (proof none, note.path signup_legacy_name) from the new user to it, for an operator to
 * approve or reject through decideClaim. Nothing is linked or changed on the matched row. The name is matched
 * literally (LIKE wildcards escaped) and only when it carries at least MIN_NAME_MATCH_LENGTH letters/digits.
 */
export async function proposeLegacyNameClaim(i: { userId: string; newAthleteId: string; name: string; sport: string | null }): Promise<string | null> {
  if (!nameUsableForMatch(i.name)) return null;
  const pattern = `%${escapeLike(i.name.trim())}%`;
  const [match] = await db
    .select({ id: athletes.id })
    .from(athletes)
    .where(and(
      ilike(athletes.full_name, pattern),
      i.sport ? eq(athletes.sport, i.sport) : undefined,
      isNull(athletes.auth_id),
      inArray(athletes.status, ["raw", "enriched"]),
      ne(athletes.id, i.newAthleteId),
    ))
    // best match first: an exact (case-insensitive) name, then the closest length
    .orderBy(sql`(lower(${athletes.full_name}) = lower(${i.name.trim()})) DESC`, sql`length(${athletes.full_name})`, athletes.id)
    .limit(1);
  if (!match) return null;
  const [row] = await db.insert(identityClaims).values({
    user_id: i.userId, athlete_id: match.id, proof: "none", status: "proposed", note: { path: LEGACY_NAME_CLAIM_PATH },
  }).returning({ id: identityClaims.id });
  logger.info({ userId: i.userId, athleteId: match.id, claimId: row.id }, "legacy name match recorded as a proposed claim (operator review)");
  return row.id;
}
