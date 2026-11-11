/**
 * grant-admin.ts — grant (or revoke) the 'admin' role for an athlete by email.
 *
 * Usage:
 *   npx tsx --require dotenv/config scripts/grant-admin.ts <email>
 *   npx tsx --require dotenv/config scripts/grant-admin.ts <email> --revoke
 *
 * Updates account_roles (the source of truth requireAdmin reads) AND syncs Firebase
 * custom claims so the role appears in the caller's token on next refresh. The admin
 * dashboard admits only holders of this role.
 *
 * Requires DATABASE_URL (.env) and, for the claims sync, Google ADC / a service-account
 * key. The DB grant still applies even if the Firebase claims sync can't run.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import { athletes, accountRoles } from "../shared/schema";
import { firebaseAuth } from "../server/lib/auth";

async function main(): Promise<void> {
  const email  = process.argv[2];
  const revoke = process.argv.includes("--revoke");

  if (!email || email.startsWith("--")) {
    console.error("Usage: npx tsx --require dotenv/config scripts/grant-admin.ts <email> [--revoke]");
    process.exit(1);
  }

  const [athlete] = await db
    .select({ id: athletes.id, auth_id: athletes.auth_id, full_name: athletes.full_name })
    .from(athletes)
    .where(sql`lower(${athletes.email}) = ${email.toLowerCase()}`)
    .limit(1);

  if (!athlete) {
    console.error(`No athlete found with email ${email}`);
    process.exit(1);
  }

  if (revoke) {
    await db
      .delete(accountRoles)
      .where(and(eq(accountRoles.account_id, athlete.id), eq(accountRoles.role, "admin")));
    console.log(`Removed 'admin' role from ${athlete.full_name} (${email}).`);
  } else {
    await db
      .insert(accountRoles)
      .values({ account_id: athlete.id, role: "admin" })
      .onConflictDoNothing();
    console.log(`Granted 'admin' role to ${athlete.full_name} (${email}).`);
  }

  // Sync Firebase custom claims to the full DB role set so the token reflects it.
  const roleRows = await db
    .select({ role: accountRoles.role })
    .from(accountRoles)
    .where(eq(accountRoles.account_id, athlete.id));
  const roles = roleRows.map((r) => r.role);

  if (athlete.auth_id) {
    try {
      await firebaseAuth.setCustomUserClaims(athlete.auth_id, { roles });
      console.log(`Firebase claims updated: roles = [${roles.join(", ")}]. The user must refresh their token (sign out/in) to pick it up.`);
    } catch (err: any) {
      console.warn(`Could not set Firebase claims (the DB role still applies): ${err.message}`);
    }
  } else {
    console.warn("Athlete has never signed in (no auth_id) — DB role set; Firebase claims will sync at signup.");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
