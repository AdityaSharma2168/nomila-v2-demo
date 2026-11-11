/**
 * checkIdentityCollisions.ts — Phase A Step 3a pre-flight, READ-ONLY: P1–P5 over the live rows (plan §2, evidence I1/I3b).
 *   npx tsx --require dotenv/config server/scripts/checkIdentityCollisions.ts
 * Exit 2 when a blocker (P1–P3) exists.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { accountRoles, athletes, connectedAccounts, identityClaims, socialIdentities } from "../../shared/schema";
import { planIdentityBackfill, hasBlockers } from "../services/intelligence/identity/backfill";

async function main() {
  const [ath, roles, owners, conns] = await Promise.all([
    db.select({ id: athletes.id, auth_id: athletes.auth_id, auth_provider: athletes.auth_provider, email: athletes.email, full_name: athletes.full_name, claimed_at: athletes.claimed_at, created_at: athletes.created_at }).from(athletes),
    db.select({ account_id: accountRoles.account_id, role: accountRoles.role }).from(accountRoles),
    db.select({ athlete_id: socialIdentities.athlete_id, platform: socialIdentities.platform, account_id: socialIdentities.account_id }).from(socialIdentities).where(and(eq(socialIdentities.source_class, "connected_verified"), eq(socialIdentities.status, "active"))),
    db.select({ id: connectedAccounts.id, athlete_id: connectedAccounts.athlete_id, platform: connectedAccounts.platform, platform_user_id: connectedAccounts.platform_user_id, connected_by_user_id: connectedAccounts.connected_by_user_id }).from(connectedAccounts).where(eq(connectedAccounts.status, "active")),
  ]);
  const plan = planIdentityBackfill({ athletes: ath, roles, owners, connections: conns, users: [], memberships: [] });
  const providers = ath.filter((a) => a.auth_id).reduce<Record<string, number>>((acc, a) => { const k = a.auth_provider ?? "null"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  console.log(`athletes=${ath.length} withAuth=${ath.filter((a) => a.auth_id).length} providers=${JSON.stringify(providers)} activeOwners=${owners.length} activeConnections=${conns.length}`);
  console.log(`P1 uid on >1 athlete: ${plan.blockers.P1.length}`, plan.blockers.P1);
  console.log(`P2 provider mismatches: ${plan.blockers.P2.length}`, plan.blockers.P2);
  console.log(`P3 ownership collisions: ${plan.blockers.P3.length}`, plan.blockers.P3);
  console.log(`P4 connected_accounts collisions: ${plan.reports.P4.length}`, plan.reports.P4);
  console.log(`P5 account_roles without auth_id: ${plan.reports.P5.length}`, plan.reports.P5);
  try {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(identityClaims);
    console.log(`identity_claims rows=${n}`);
  } catch { console.log("identity_claims: table not present yet (0051 not applied)"); }
  if (hasBlockers(plan)) { console.log("BLOCKERS present"); process.exitCode = 2; } else console.log("no blockers");
}

main().then(() => pool.end()).catch((err) => { console.error(err?.message ?? err); process.exit(1); });
