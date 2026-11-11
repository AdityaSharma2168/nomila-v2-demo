/**
 * purgeStoredBodies.ts — remove stored mail content (bodies, subjects, sender names, and
 * non-counterparty sender addresses) from EXISTING inbox rows.
 *
 *   npx tsx server/scripts/privacy/purgeStoredBodies.ts [--athlete <uuid> | --all] [--env <path/.env>]
 *   ... --apply                  write (needs --athlete <uuid> or an explicit --all)
 *   ... --i-know-this-is-prod    required whenever DATABASE_URL looks like production OR the connected database is not
 *                                the dev database (asked of the server: current_database() must be "nomila_v2")
 *
 * WHY: "Mailbox Owns Correspondence" — the mailbox keeps the mail, Nomila keeps the deal.
 * New mail stops being stored under MAILBOX_ZERO_RETENTION; this cleans what was stored
 * before. Run it only AFTER the readers are live (MAILBOX_LIVE_READS) and the last jobs that
 * need stored bodies (the #770 opportunity backfill, any requalify) have run — design §11.
 *
 * SAFE BY CONSTRUCTION:
 *   - DRY-RUN BY DEFAULT and read-only: without --apply the DB session is opened with
 *     PGOPTIONS `-c default_transaction_read_only=on` BEFORE the pool loads, and the run aborts
 *     unless `SHOW default_transaction_read_only` answers `on`.
 *   - Counts and byte sums only — no value is ever printed or read into this process.
 *   - A thread without its derived facts (classification + conversation_state, or junk /
 *     closed) is REFUSED and listed by id; nothing on it changes. Fix those first.
 *   - Fingerprints (body_sha256) are filled from the stored body in the same transaction,
 *     before any body is removed, so the echo gate keeps working.
 *   - Instagram threads are skipped (no reliable live re-read; see lib/mailbox/retention.ts).
 *   - The same prod guard as purgeJunkSamples.
 *
 * Run by a person only: tests exercise ./purgeStoredBodiesCore on PGlite and never import this.
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { readOnlyPgOptions } from "../opps/readOnly";
import { requireProdAck, type Queryable } from "../../lib/devDatabaseGuard";
import { describeDbTarget, parsePurgeArgs, type PurgeScope } from "./purgeJunkSamplesCore";
import { countStoredBodies, purgeStoredBodies } from "./purgeStoredBodiesCore";

const USAGE =
  "usage: purgeStoredBodies.ts [--athlete <uuid> | --all] [--env path] [--apply] [--i-know-this-is-prod]";

function scopeLabel(scope: PurgeScope | null): string {
  if (!scope) return "all athletes (counts only)";
  return "athleteId" in scope ? `athlete ${scope.athleteId}` : "ALL athletes";
}

async function main(): Promise<void> {
  const parsed = parsePurgeArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`${parsed.error}\n${USAGE}`);
    process.exit(2);
  }
  const { apply, scope, allowProd, envPath } = parsed.args;

  loadEnv({ path: resolve(envPath ?? ".env") });

  const target = describeDbTarget(process.env.DATABASE_URL);
  console.log(`target: ${target.label}`);
  if (target.looksLikeProd && !allowProd) {
    console.error("refusing to run: DATABASE_URL looks like production. Re-run with --i-know-this-is-prod if it is meant to be.");
    process.exit(1);
  }

  if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { db, pool } = await import("../../db");
  // The URL guess above cannot see production behind the local proxy (…@localhost:5441/nomila): ask the database
  // itself. Anything that is not the dev database needs --i-know-this-is-prod (server/lib/devDatabaseGuard.ts).
  try { await requireProdAck(allowProd, pool as unknown as Queryable); }
  catch (err: any) { console.error(err?.message ?? err); await pool.end(); process.exit(1); }
  const { sql } = await import("drizzle-orm");
  try {
    if (!apply) {
      const ro = await db.execute(sql`SHOW default_transaction_read_only`);
      const value = String((ro as any).rows?.[0]?.default_transaction_read_only ?? "");
      if (value !== "on") {
        console.error(`refusing to run: the DB session is not read-only (default_transaction_read_only=${value || "?"})`);
        process.exit(1);
      }
    }

    const countScope: PurgeScope = scope ?? { all: true };
    const before = await countStoredBodies(db, countScope);
    console.log(`scope: ${scopeLabel(scope)}`);
    console.log(`threads holding stored content: ${before.threads} across ${before.athletes} athlete(s) (Instagram skipped: ${before.instagramThreads})`);
    console.log(`  eligible (derived facts present, or junk/closed): ${before.eligibleThreads}`);
    console.log(`  message rows to clear: ${before.messages}; fingerprints to fill first: ${before.missingFingerprint}`);
    console.log(`  bytes: ${JSON.stringify(before.bytes)}`);
    if (before.refusedThreadIds.length > 0) {
      console.log(`  REFUSED — no derived facts yet (${before.refusedThreadIds.length}); summarize / requalify these first:`);
      for (const id of before.refusedThreadIds) console.log(`    ${id}`);
    }

    if (!apply) {
      console.log("DRY-RUN — nothing written. Re-run with --apply and --athlete <uuid> or --all.");
      return;
    }

    const result = await purgeStoredBodies(db, scope!);
    const after = await countStoredBodies(db, scope!);
    console.log(
      `APPLIED — ${result.threadsPurged} thread(s) purged, ${result.messagesCleared} message row(s) cleared, ` +
      `${result.fingerprintsFilled} fingerprint(s) filled; ${result.refusedThreadIds.length} refused; ` +
      `${after.eligibleThreads} eligible thread(s) still hold content.`,
    );
    if (after.eligibleThreads > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
