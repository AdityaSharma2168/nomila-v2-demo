/**
 * outlookSubscribeExisting.ts — Outlook PR 1: give Outlook connections made BEFORE OUTLOOK_PUSH a Graph
 * change-notification subscription (new connects subscribe in outlook.onConnected).
 *
 *   npx tsx server/scripts/outlookSubscribeExisting.ts [--apply] [--env <path/.env>]
 *
 * DRY-RUN by default, READ-ONLY by construction: the DB session is opened with PGOPTIONS
 * `-c default_transaction_read_only=on` before the pool module loads, it makes no Graph call, and it
 * only lists the active Outlook connections that have no outlook_subscriptions row.
 *
 * --apply requires OUTLOOK_PUSH=true and OUTLOOK_WEBHOOK_SECRET in the env, and the webhook routes
 * reachable at API_BASE_URL (Graph validates both URLs while creating). It calls ensureSubscription
 * once per listed connection, sequentially; a failure is reported and the connection stays on the poll.
 *
 * Run by a person only. Never run from code or CI.
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { readOnlyPgOptions } from "./opps/readOnly";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const apply = argv.includes("--apply");

async function main(): Promise<void> {
  loadEnv({ path: resolve(arg("--env") ?? ".env") });
  if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { db, pool } = await import("../db");
  const { and, eq, isNull, sql } = await import("drizzle-orm");
  const { connectedAccounts, outlookSubscriptions } = await import("../../shared/schema");
  const { ensureSubscription, outlookPushEnabled } = await import("../lib/integrations/outlookPush");

  try {
    if (!apply) {
      const ro = await db.execute(sql`SHOW default_transaction_read_only`);
      const value = String((ro as any).rows?.[0]?.default_transaction_read_only ?? "");
      if (value !== "on") {
        console.error(`refusing to run: the DB session is not read-only (default_transaction_read_only=${value || "?"})`);
        process.exit(1);
      }
    } else if (!outlookPushEnabled()) {
      console.error("refusing to apply: OUTLOOK_PUSH is not \"true\" in this env (ensureSubscription would no-op).");
      process.exit(2);
    }

    const rows = await db
      .select({ id: connectedAccounts.id, athleteId: connectedAccounts.athlete_id })
      .from(connectedAccounts)
      .leftJoin(outlookSubscriptions, eq(outlookSubscriptions.connected_account_id, connectedAccounts.id))
      .where(and(
        eq(connectedAccounts.platform, "outlook"),
        eq(connectedAccounts.status, "active"),
        isNull(outlookSubscriptions.id),
      ));

    console.log(`${rows.length} active Outlook connection(s) without a subscription`);
    let ok = 0, failed = 0;
    for (const r of rows) {
      if (!apply) { console.log(`  would subscribe connection ${r.id} (athlete ${r.athleteId})`); continue; }
      try {
        const sub = await ensureSubscription(r.id);
        ok++;
        console.log(`  subscribed ${r.id} → expires ${sub?.expires_at?.toISOString()}`);
      } catch (err: any) {
        failed++;
        console.log(`  FAILED ${r.id}: ${err.message}`);
      }
    }
    if (apply) console.log(`done: ${ok} subscribed, ${failed} failed`);
    else console.log("dry run: nothing written, no Graph call. Re-run with --apply to subscribe.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
