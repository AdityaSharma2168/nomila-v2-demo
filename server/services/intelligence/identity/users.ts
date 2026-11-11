/**
 * identity/users.ts — the user (the authenticated person) and the membership (User ↔ Athlete). Phase A Step 3a.
 *
 * The ONLY writers of `users`, `athlete_users` and `user_roles` live in this module (ownershipGuard.test.ts). A membership
 * is written by linkUserToAthlete (a claim proof) or grandfatherMembership (a link made by a legacy path before the claim
 * lifecycle exists — proof 'existing_auth', note 'legacy_path:<stage>' | 'backfill', design D-14 / plan P-1).
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../db";
import { athleteUsers, userRoles, users } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import type { ClaimProof } from "./claim";

const logger = createLogger("identity-users");
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type IdentityClient = typeof db | Tx;

import { providerOf, type Provider } from "./provider";
export { providerOf, type Provider };

export interface EnsureUserInput { uid: string; email?: string | null; emailVerified?: boolean; displayName?: string | null }

/** Upsert on (provider, provider_uid). A verified email from the provider is recorded; an unverified one never downgrades a verified one. */
export async function ensureUser(i: EnsureUserInput, client: IdentityClient = db): Promise<{ id: string; provider: Provider; providerUid: string; email: string | null; emailVerified: boolean }> {
  const provider = providerOf(i.uid);
  const [existing] = await client.select().from(users).where(and(eq(users.provider, provider), eq(users.provider_uid, i.uid))).limit(1);
  const now = new Date();
  if (existing) {
    const patch: Partial<typeof users.$inferInsert> = { last_seen_at: now };
    if (i.email && i.email !== existing.email) patch.email = i.email;
    if (i.emailVerified === true && !existing.email_verified) patch.email_verified = true;
    if (i.displayName && !existing.display_name) patch.display_name = i.displayName;
    const [row] = await client.update(users).set(patch).where(eq(users.id, existing.id)).returning();
    return { id: row.id, provider, providerUid: row.provider_uid, email: row.email, emailVerified: row.email_verified };
  }
  const [row] = await client.insert(users).values({ provider, provider_uid: i.uid, email: i.email ?? null, email_verified: i.emailVerified === true, display_name: i.displayName ?? null, last_seen_at: now })
    .onConflictDoNothing({ target: [users.provider, users.provider_uid] }).returning();
  if (row) return { id: row.id, provider, providerUid: row.provider_uid, email: row.email, emailVerified: row.email_verified };
  const [raced] = await client.select().from(users).where(and(eq(users.provider, provider), eq(users.provider_uid, i.uid))).limit(1);   // a concurrent insert won
  return { id: raced.id, provider, providerUid: raced.provider_uid, email: raced.email, emailVerified: raced.email_verified };
}

export async function findUserByUid(uid: string, client: IdentityClient = db): Promise<{ id: string; email: string | null; emailVerified: boolean } | null> {
  const [row] = await client.select({ id: users.id, email: users.email, email_verified: users.email_verified }).from(users).where(and(eq(users.provider, providerOf(uid)), eq(users.provider_uid, uid))).limit(1);
  return row ? { id: row.id, email: row.email, emailVerified: row.email_verified } : null;
}

export interface Membership { id: string; athleteId: string; userId: string; relation: "self"; proof: ClaimProof; establishedAt: Date; note: string | null }
const toMembership = (r: typeof athleteUsers.$inferSelect): Membership => ({ id: r.id, athleteId: r.athlete_id, userId: r.user_id, relation: r.relation as "self", proof: r.proof as ClaimProof, establishedAt: r.established_at, note: r.note });

/** Active memberships of a user, oldest first (the order never decides anything: design §3.2 forbids "the first row"). */
export async function membershipsForUser(userId: string, client: IdentityClient = db): Promise<Membership[]> {
  const rows = await client.select().from(athleteUsers).where(and(eq(athleteUsers.user_id, userId), isNull(athleteUsers.revoked_at))).orderBy(athleteUsers.established_at);
  return rows.map(toMembership);
}

/** The athlete's active self-membership, if any (at most one: athlete_users_one_self_uq). */
export async function selfMembershipFor(athleteId: string, client: IdentityClient = db): Promise<Membership | null> {
  const [row] = await client.select().from(athleteUsers).where(and(eq(athleteUsers.athlete_id, athleteId), eq(athleteUsers.relation, "self"), isNull(athleteUsers.revoked_at))).limit(1);
  return row ? toMembership(row) : null;
}

/** The self user's id for an athlete, or null (no membership yet). */
export async function selfUserOf(athleteId: string, client: IdentityClient = db): Promise<string | null> {
  return (await selfMembershipFor(athleteId, client))?.userId ?? null;
}

export async function rolesForUser(userId: string, client: IdentityClient = db): Promise<string[]> {
  const rows = await client.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.user_id, userId));
  return rows.map((r) => r.role);
}

export class SelfMembershipTaken extends Error {
  constructor(public readonly athleteId: string) { super(`athlete ${athleteId} already has an active self-membership`); this.name = "SelfMembershipTaken"; }
}

/** 23505 on one of the athlete_users partial uniques, whatever the driver's error shape. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string; cause?: { code?: string; constraint?: string; message?: string } } | null;
  const code = e?.code ?? e?.cause?.code;
  const msg = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
  const is23505 = code === "23505" || /duplicate key value/i.test(msg);
  if (!is23505) return false;
  if (!constraint) return true;
  return (e?.constraint ?? e?.cause?.constraint) === constraint || msg.includes(constraint);
}

export interface InsertSelfMembershipOptions { /** tests only: runs after the pre-read and before the guarded INSERT (forces the 23505 path) */ __afterPreRead?: (client: IdentityClient) => Promise<void> }

/**
 * Insert the self-membership. The partial unique index athlete_users_one_self_uq is the atomic guard: two users claiming
 * one athlete at once ⇒ exactly one row, the other throws SelfMembershipTaken. Idempotent for the same user (returns the
 * existing active row; never re-dates it).
 *
 * The INSERT runs in a nested transaction — a real SAVEPOINT when `client` is already a transaction (linkUserToAthlete), its
 * own transaction at top level — so a 23505 rolls back to the savepoint and the caller's transaction stays usable for the
 * re-read of the winner and for the projection write that follows (PostgreSQL aborts the whole transaction otherwise).
 */
export async function insertSelfMembership(i: { athleteId: string; userId: string; proof: Exclude<ClaimProof, "none">; note?: string | null; claimId?: string | null; establishedAt?: Date }, client: IdentityClient = db, opts: InsertSelfMembershipOptions = {}): Promise<Membership> {
  const existing = await selfMembershipFor(i.athleteId, client);
  if (existing) { if (existing.userId === i.userId) return existing; throw new SelfMembershipTaken(i.athleteId); }
  if (opts.__afterPreRead) await opts.__afterPreRead(client);
  try {
    const row = await (client as typeof db).transaction(async (sp) => {
      const [r] = await sp.insert(athleteUsers).values({ athlete_id: i.athleteId, user_id: i.userId, relation: "self", proof: i.proof, note: i.note ?? null, claim_id: i.claimId ?? null, established_at: i.establishedAt ?? new Date() }).returning();
      return r;
    });
    return toMembership(row);
  } catch (err) {
    if (isUniqueViolation(err, "athlete_users_one_self_uq") || isUniqueViolation(err, "athlete_users_active_uq")) {
      const now = await selfMembershipFor(i.athleteId, client);   // the concurrent winner; the savepoint rollback left `client` usable
      if (now?.userId === i.userId) return now;
      throw new SelfMembershipTaken(i.athleteId);
    }
    throw err;
  }
}

/**
 * A link made by a legacy path (signup stages, Microsoft, waitlist; flag-off code that already wrote athletes.auth_id) or by
 * the backfill: grandfathered as 'existing_auth' with a note naming the path (D-14, P-1). Never surfaces to the caller —
 * the legacy response is unchanged; a failure is logged and the idempotent backfill closes the gap later.
 */
export async function grandfatherMembership(i: { athleteId: string; uid: string; email?: string | null; displayName?: string | null; note: string; role?: string | null }, client: IdentityClient = db): Promise<Membership | null> {
  try {
    const user = await ensureUser({ uid: i.uid, email: i.email ?? null, emailVerified: false, displayName: i.displayName ?? null }, client);
    const m = await insertSelfMembership({ athleteId: i.athleteId, userId: user.id, proof: "existing_auth", note: i.note }, client);
    if (i.role) await client.insert(userRoles).values({ user_id: user.id, role: i.role }).onConflictDoNothing();
    return m;
  } catch (err: any) {
    logger.warn({ athleteId: i.athleteId, note: i.note, error: String(err?.message ?? err).slice(0, 160) }, "grandfathered membership not written");
    return null;
  }
}

/**
 * The sign-in users that belong ONLY to this athlete: her memberships, plus the user whose provider uid is her
 * athletes.auth_id. A user who also belongs to another athlete is never returned. Used by account deletion/export
 * (privacy/athleteScope.ts), which must resolve these before the memberships are deleted.
 */
export async function exclusiveUserIdsOfAthlete(athleteId: string, authId: string | null, client: { execute: (q: any) => Promise<unknown> } = db): Promise<string[]> {
  const r = await client.execute(sql`
    SELECT u.id FROM users u
    WHERE (u.id IN (SELECT user_id FROM athlete_users WHERE athlete_id = ${athleteId}::uuid)
           OR (${authId}::text IS NOT NULL AND u.provider_uid = ${authId}::text))
      AND NOT EXISTS (SELECT 1 FROM athlete_users au WHERE au.user_id = u.id AND au.athlete_id <> ${athleteId}::uuid)
  `);
  return (((r as any)?.rows ?? r) as { id: string }[]).map((u) => u.id);
}
