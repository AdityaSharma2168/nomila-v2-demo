/**
 * purgeExpiredFinancialRecords.ts — delete financial_record rows (financial_ledger_records, payment_events) older
 * than the retention period.
 *
 *   npx tsx server/scripts/privacy/purgeExpiredFinancialRecords.ts [--env <path/.env>]   dry run: counts only
 *   ... --apply                  delete
 *   ... --i-know-this-is-prod    required whenever DATABASE_URL looks like production OR the connected database is not
 *                                the dev database (asked of the server: current_database() must be "nomila_v2")
 *
 * The period is FINANCIAL_RECORD_RETENTION_DAYS — TBD pending counsel/accountant confirmation. While it is unset
 * this script REFUSES to run. Run by a person only (no cron); tests exercise ./purgeExpiredFinancialRecordsCore.
 * The dry run opens the DB session read-only before the pool loads.
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { readOnlyPgOptions } from "../opps/readOnly";
import { requireProdAck, type Queryable } from "../../lib/devDatabaseGuard";
import { describeDbTarget } from "./purgeJunkSamplesCore";
import { financialRecordRetentionDays } from "../../lib/privacy/financialRecords";
import { purgeExpiredFinancialRecords } from "./purgeExpiredFinancialRecordsCore";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const allowProd = args.includes("--i-know-this-is-prod");
  const envIdx = args.indexOf("--env");
  loadEnv({ path: resolve(envIdx >= 0 ? args[envIdx + 1] : ".env") });

  const days = financialRecordRetentionDays();
  if (days == null) {
    console.error("refusing to run: FINANCIAL_RECORD_RETENTION_DAYS is not set (the financial_record period is TBD pending counsel/accountant confirmation).");
    process.exit(1);
  }

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
  try {
    const r = await purgeExpiredFinancialRecords(db, { retentionDays: days, apply });
    console.log(`retention: ${days} day(s); cutoff ${r.cutoff}`);
    console.log(`${apply ? "DELETED" : "would delete"}: ${r.ledger_records} financial_ledger_records, ${r.payment_events} payment_events`);
    if (!apply) console.log("DRY-RUN — nothing written. Re-run with --apply to delete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
