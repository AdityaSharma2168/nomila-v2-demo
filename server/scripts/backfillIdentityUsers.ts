/**
 * backfillIdentityUsers.ts — Phase A Step 3a (plan §2): users + self-memberships + user_roles + connected_by_user_id from
 * today's athletes.auth_id projection. DRY-RUN BY DEFAULT. Refuses to apply while any P1–P3 blocker exists.
 *
 *   npx tsx --require dotenv/config server/scripts/backfillIdentityUsers.ts             pre-flight + plan, nothing written
 *   npx tsx --require dotenv/config server/scripts/backfillIdentityUsers.ts --apply     one transaction, ON CONFLICT DO NOTHING
 *   npx tsx --require dotenv/config server/scripts/backfillIdentityUsers.ts --revert    removes the backfill-tagged rows only
 */

import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { accountRoles, athleteUsers, athletes, connectedAccounts, identityClaims, socialIdentities, userRoles, users } from "../../shared/schema";
import { hasBlockers, planIdentityBackfill } from "../services/intelligence/identity/backfill";

async function loadInput() {
  const [ath, roles, owners, conns, us, mem] = await Promise.all([
    db.select({ id: athletes.id, auth_id: athletes.auth_id, auth_provider: athletes.auth_provider, email: athletes.email, full_name: athletes.full_name, claimed_at: athletes.claimed_at, created_at: athletes.created_at }).from(athletes),
    db.select({ account_id: accountRoles.account_id, role: accountRoles.role }).from(accountRoles),
    db.select({ athlete_id: socialIdentities.athlete_id, platform: socialIdentities.platform, account_id: socialIdentities.account_id }).from(socialIdentities).where(and(eq(socialIdentities.source_class, "connected_verified"), eq(socialIdentities.status, "active"))),
    db.select({ id: connectedAccounts.id, athlete_id: connectedAccounts.athlete_id, platform: connectedAccounts.platform, platform_user_id: connectedAccounts.platform_user_id, connected_by_user_id: connectedAccounts.connected_by_user_id }).from(connectedAccounts).where(eq(connectedAccounts.status, "active")),
    db.select({ id: users.id, provider: users.provider, provider_uid: users.provider_uid }).from(users),
    db.select({ athlete_id: athleteUsers.athlete_id, user_id: athleteUsers.user_id }).from(athleteUsers).where(and(eq(athleteUsers.relation, "self"), isNull(athleteUsers.revoked_at))),
  ]);
  return { athletes: ath, roles, owners, connections: conns, users: us, memberships: mem };
}

async function revert() {
  await db.transaction(async (tx) => {
    const removed = await tx.delete(athleteUsers).where(eq(athleteUsers.note, "backfill")).returning({ user_id: athleteUsers.user_id });
    const userIds = [...new Set(removed.map((r) => r.user_id))];
    if (!userIds.length) { console.log("revert: no backfill-tagged memberships"); return; }
    const stillMember = new Set((await tx.select({ user_id: athleteUsers.user_id }).from(athleteUsers).where(inArray(athleteUsers.user_id, userIds))).map((r) => r.user_id));
    const claimed = new Set((await tx.select({ user_id: identityClaims.user_id }).from(identityClaims).where(inArray(identityClaims.user_id, userIds))).map((r) => r.user_id));
    const orphans = userIds.filter((u) => !stillMember.has(u) && !claimed.has(u));
    if (orphans.length) {
      await tx.update(connectedAccounts).set({ connected_by_user_id: null }).where(inArray(connectedAccounts.connected_by_user_id, orphans));
      await tx.delete(userRoles).where(inArray(userRoles.user_id, orphans));
      await tx.delete(users).where(inArray(users.id, orphans));
    }
    console.log(`revert: memberships removed=${removed.length} users removed=${orphans.length} users kept (other memberships/claims)=${userIds.length - orphans.length}`);
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (process.argv.includes("--revert")) { await revert(); return; }
  const input = await loadInput();
  const plan = planIdentityBackfill(input);
  console.log(`athletes=${input.athletes.length} withAuth=${input.athletes.filter((a) => a.auth_id).length} existingUsers=${input.users.length} existingMemberships=${input.memberships.length}`);
  console.log(`P1 uid on >1 athlete: ${plan.blockers.P1.length}`, plan.blockers.P1);
  console.log(`P2 provider mismatches: ${plan.blockers.P2.length}`, plan.blockers.P2);
  console.log(`P3 ownership collisions: ${plan.blockers.P3.length}`, plan.blockers.P3);
  console.log(`P4 connected_accounts collisions (report): ${plan.reports.P4.length}`, plan.reports.P4);
  console.log(`P5 account_roles without auth_id (report, left in place): ${plan.reports.P5.length}`, plan.reports.P5);
  console.log(`plan: users=${plan.users.length} memberships=${plan.memberships.length} roles=${plan.roles.length} connections=${plan.connections.length} skipped=${JSON.stringify(plan.skipped)}`);
  if (hasBlockers(plan)) { console.log("BLOCKED: resolve P1–P3 before --apply"); process.exitCode = 2; return; }
  if (!apply) { console.log("dry-run: nothing written (pass --apply)"); return; }
  await db.transaction(async (tx) => {
    if (plan.users.length) await tx.insert(users).values(plan.users.map((u) => ({ provider: u.provider, provider_uid: u.providerUid, email: u.email, email_verified: false, display_name: u.displayName, created_at: u.createdAt ?? new Date() }))).onConflictDoNothing({ target: [users.provider, users.provider_uid] });
    const uids = [...new Set([...plan.memberships, ...plan.roles, ...plan.connections].map((x) => x.providerUid))];
    const idByUid = new Map((uids.length ? await tx.select({ id: users.id, uid: users.provider_uid }).from(users).where(inArray(users.provider_uid, uids)) : []).map((u) => [u.uid, u.id]));
    let m = 0;
    for (const x of plan.memberships) {
      const r = await tx.insert(athleteUsers).values({ athlete_id: x.athleteId, user_id: idByUid.get(x.providerUid)!, relation: "self", proof: "existing_auth", note: "backfill", established_at: x.establishedAt ?? new Date() }).onConflictDoNothing().returning({ id: athleteUsers.id });
      m += r.length;
    }
    if (plan.roles.length) await tx.insert(userRoles).values(plan.roles.map((r) => ({ user_id: idByUid.get(r.providerUid)!, role: r.role }))).onConflictDoNothing();
    let c = 0;
    for (const x of plan.connections) { const r = await tx.update(connectedAccounts).set({ connected_by_user_id: idByUid.get(x.providerUid)! }).where(and(eq(connectedAccounts.id, x.connectionId), isNull(connectedAccounts.connected_by_user_id))).returning({ id: connectedAccounts.id }); c += r.length; }
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
    console.log(`APPLIED: users total=${n} memberships inserted=${m} roles attempted=${plan.roles.length} connections attributed=${c}`);
  });
  void notInArray;
}

main().then(() => pool.end()).catch((err) => { console.error(err?.message ?? err); process.exit(1); });
