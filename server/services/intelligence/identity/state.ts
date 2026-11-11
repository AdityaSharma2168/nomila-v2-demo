/**
 * identity/state.ts — verificationStateFor (Phase A Step 3a; design §3.8). The ONE source for "is this athlete identified":
 * the self-membership OR the auth projection OR claimed_at OR an active connection — exactly the booleans research
 * (identityResolved), the planner (hasIdentitySignal) and the index (has_user) read today. It says nothing about
 * athlete-authored facts (D-10).
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../../db";
import { athleteUsers, athletes, connectedAccounts, socialIdentities } from "../../../../shared/schema";

export interface OwnedAccount { platform: string; accountId: string; handle: string | null; verifiedAt: string | null; byUserId: string | null }
export interface VerificationState {
  athleteId: string;
  /** the active self-membership's user, or null */
  selfMember: string | null;
  /** athletes.auth_id is set (the pre-3d projection) */
  authProjection: boolean;
  claimedAt: string | null;
  /** a users.email_verified for the self member */
  verifiedEmail: boolean;
  /** active connected_verified identities (one canonical owner each, D-13) */
  ownedAccounts: OwnedAccount[];
  /** connected_verified rows held UNVERIFIED after an ownership collision (§3a-C) — never owned */
  contestedAccounts: OwnedAccount[];
  /** an active connected_accounts row exists */
  connected: boolean;
  /** research's identityResolved today: claimed_at OR auth_id (OR a self-membership) */
  identityResolved: boolean;
  /** the planner's hasIdentitySignal today: claimed OR auth OR connected (OR a self-membership) */
  hasIdentitySignal: boolean;
}

export async function verificationStatesFor(athleteIds: string[]): Promise<Map<string, VerificationState>> {
  const out = new Map<string, VerificationState>();
  if (!athleteIds.length) return out;
  const [rows, members, conns, ids] = await Promise.all([
    db.select({ id: athletes.id, auth: athletes.auth_id, claimed: athletes.claimed_at }).from(athletes).where(inArray(athletes.id, athleteIds)),
    db.select({ athleteId: athleteUsers.athlete_id, userId: athleteUsers.user_id }).from(athleteUsers).where(and(inArray(athleteUsers.athlete_id, athleteIds), eq(athleteUsers.relation, "self"), isNull(athleteUsers.revoked_at))),
    db.select({ athleteId: connectedAccounts.athlete_id, byUserId: connectedAccounts.connected_by_user_id }).from(connectedAccounts).where(and(inArray(connectedAccounts.athlete_id, athleteIds), eq(connectedAccounts.status, "active"))),
    db.select({ athleteId: socialIdentities.athlete_id, platform: socialIdentities.platform, accountId: socialIdentities.account_id, handle: socialIdentities.handle, status: socialIdentities.status, verifiedAt: socialIdentities.last_verified_at, evidence: socialIdentities.evidence }).from(socialIdentities)
      .where(and(inArray(socialIdentities.athlete_id, athleteIds), eq(socialIdentities.source_class, "connected_verified"), inArray(socialIdentities.status, ["active", "unverified"]))),
  ]);
  const selfBy = new Map(members.map((m) => [m.athleteId, m.userId]));
  const connected = new Set(conns.map((c) => c.athleteId));
  const userEmailVerified = new Map<string, boolean>();
  if (members.length) {
    const { users } = await import("../../../../shared/schema");
    const us = await db.select({ id: users.id, v: users.email_verified }).from(users).where(inArray(users.id, [...new Set(members.map((m) => m.userId))]));
    for (const u of us) userEmailVerified.set(u.id, u.v);
  }
  for (const r of rows) {
    const selfMember = selfBy.get(r.id) ?? null;
    const mine = ids.filter((x) => x.athleteId === r.id);
    const acct = (x: typeof mine[number]): OwnedAccount => ({ platform: x.platform, accountId: x.accountId, handle: x.handle, verifiedAt: x.verifiedAt?.toISOString() ?? null, byUserId: ((x.evidence as any)?.ownership_collision?.byUserId ?? conns.find((c) => c.athleteId === r.id)?.byUserId ?? null) as string | null });
    const identityResolved = !!r.claimed || !!r.auth || !!selfMember;
    out.set(r.id, {
      athleteId: r.id, selfMember, authProjection: !!r.auth, claimedAt: r.claimed?.toISOString() ?? null,
      verifiedEmail: selfMember ? userEmailVerified.get(selfMember) === true : false,
      ownedAccounts: mine.filter((x) => x.status === "active").map(acct), contestedAccounts: mine.filter((x) => x.status === "unverified").map(acct),
      connected: connected.has(r.id), identityResolved, hasIdentitySignal: identityResolved || connected.has(r.id),
    });
  }
  return out;
}

export async function verificationStateFor(athleteId: string): Promise<VerificationState | null> {
  return (await verificationStatesFor([athleteId])).get(athleteId) ?? null;
}
