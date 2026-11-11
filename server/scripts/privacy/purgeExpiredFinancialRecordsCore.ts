/**
 * purgeExpiredFinancialRecordsCore — delete financial_record rows older than the retention period.
 *
 *   financial_ledger_records  by deidentified_at
 *   payment_events            by received_at (every webhook row, hers or not: the category is per table)
 *
 * The period comes from financialRecordRetentionDays() (FINANCIAL_RECORD_RETENTION_DAYS, TBD pending
 * counsel/accountant confirmation). When it is unset this REFUSES: no period decided means nothing is old enough.
 * No imports from server/db: the CLI decides the session; tests hand in a PGlite drizzle instance.
 */

import { sql } from "drizzle-orm";
import { rowsOf, type Executor } from "../../services/privacy/athleteScope";

export class RetentionPeriodUnset extends Error {
  constructor() { super("FINANCIAL_RECORD_RETENTION_DAYS is not set — the financial_record retention period is TBD pending counsel/accountant confirmation; refusing to purge anything."); }
}

export interface FinancialPurgeCounts { ledger_records: number; payment_events: number; cutoff: string }

export async function purgeExpiredFinancialRecords(
  exec: Executor,
  opts: { retentionDays: number | null; apply: boolean; now?: Date },
): Promise<FinancialPurgeCounts> {
  if (opts.retentionDays == null) throw new RetentionPeriodUnset();
  if (!Number.isInteger(opts.retentionDays) || opts.retentionDays <= 0) throw new Error(`invalid retention period: ${opts.retentionDays}`);
  const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.retentionDays * 86_400_000).toISOString();

  const count = async (q: ReturnType<typeof sql>) => Number(rowsOf<{ n: number }>(await exec.execute(q))[0]?.n ?? 0);
  if (!opts.apply) {
    return {
      cutoff,
      ledger_records: await count(sql`SELECT count(*)::int AS n FROM financial_ledger_records WHERE deidentified_at < ${cutoff}::timestamptz`),
      payment_events: await count(sql`SELECT count(*)::int AS n FROM payment_events WHERE received_at < ${cutoff}::timestamptz`),
    };
  }
  return {
    cutoff,
    ledger_records: await count(sql`WITH d AS (DELETE FROM financial_ledger_records WHERE deidentified_at < ${cutoff}::timestamptz RETURNING 1) SELECT count(*)::int AS n FROM d`),
    payment_events: await count(sql`WITH d AS (DELETE FROM payment_events WHERE received_at < ${cutoff}::timestamptz RETURNING 1) SELECT count(*)::int AS n FROM d`),
  };
}
