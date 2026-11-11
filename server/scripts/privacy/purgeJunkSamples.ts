/**
 * purgeJunkSamples.ts — remove stored message content (sample_from / sample_subject /
 * sample_body) from existing `agent_actions` file receipts.
 *
 *   npx tsx server/scripts/privacy/purgeJunkSamples.ts [--athlete <uuid> | --all] [--env <path/.env>]
 *   ... --apply                  write (needs --athlete <uuid> or an explicit --all)
 *   ... --i-know-this-is-prod    required whenever DATABASE_URL looks like production OR the connected database is not
 *                                the dev database (asked of the server: current_database() must be "nomila_v2")
 *
 * WHY: logAutoHandledJunk used to keep the filed message's sender, subject and the opening
 * of its body on the receipt as a "training sample". Google's Limited Use policy forbids
 * keeping Gmail content as a corpus, and no screen ever showed those fields. New receipts
 * no longer carry them (server/skills/dealDetector.ts); this cleans the rows already written.
 *
 * DRY-RUN BY DEFAULT, and read-only by construction: without --apply the DB session is
 * opened with PGOPTIONS `-c default_transaction_read_only=on` BEFORE the pool module loads,
 * and the run aborts unless `SHOW default_transaction_read_only` answers `on`.
 *
 * Prints COUNTS ONLY, never a value: the core counts in SQL and strips keys with the jsonb
 * `-` operator, so no message content is ever read into this process.
 *
 * Run by a person only: tests exercise ./purgeJunkSamplesCore on PGlite and never import this.
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { readOnlyPgOptions } from "../opps/readOnly";
import { requireProdAck, type Queryable } from "../../lib/devDatabaseGuard";
import { countJunkSamples, describeDbTarget, parsePurgeArgs, purgeJunkSamples, type PurgeScope } from "./purgeJunkSamplesCore";

const USAGE =
  "usage: purgeJunkSamples.ts [--athlete <uuid> | --all] [--env path] [--apply] [--i-know-this-is-prod]";

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

  // Dry run: read-only BEFORE anything loads server/db (node-postgres reads PGOPTIONS per connection).
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
    const before = await countJunkSamples(db, countScope);
    console.log(`scope: ${scopeLabel(scope)}`);
    console.log(`receipts holding message content: ${before.receipts} across ${before.athletes} athlete(s)`);
    console.log(`  by key: ${JSON.stringify(before.byKey)}`);

    if (!apply) {
      console.log("DRY-RUN — nothing written. Re-run with --apply and --athlete <uuid> or --all.");
      return;
    }

    const updated = await purgeJunkSamples(db, scope!);
    const after = await countJunkSamples(db, scope!);
    console.log(`APPLIED — ${updated} receipt(s) stripped; ${after.receipts} still hold message content.`);
    if (after.receipts > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
