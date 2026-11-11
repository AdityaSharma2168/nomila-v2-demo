/**
 * lib/maybeDeal.ts — the D5 "Maybe" marker (classification.maybe, written by skills/dealDetector behind DEALS_MAYBE):
 * a weak but plausible first email kept quietly instead of dropped. Until she opens it or the brand writes again it is
 * NOT a deal on the board, Home's "What matters next", the plan or Mila's deal list — it lives only in the Maybe
 * section (services/opportunityBoard, DEALS_MAYBE). One predicate and one SQL guard, so every reader agrees.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** DEALS_MAYBE (off) — the same switch skills/dealDetector reads (dealsMaybeEnabled), read here without importing it. */
export function maybeListEnabled(): boolean {
  return (process.env.DEALS_MAYBE ?? "").trim().toLowerCase() === "true";
}

/** The thread's classification carries the Maybe marker. */
export function isMaybeThread(classification: unknown): boolean {
  return (classification as { maybe?: unknown } | null)?.maybe === true;
}

/** SQL: this deal has no thread still marked Maybe. For readers that list deals straight from the table. */
export function notMaybeDeal(dealId: AnyPgColumn): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM inbox_threads mt WHERE mt.deal_id = ${dealId} AND mt.classification->>'maybe' = 'true')`;
}
