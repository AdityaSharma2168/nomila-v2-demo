/**
 * dealValueStore — the database read that feeds the pure resolver.
 *
 * Kept apart from dealValue.ts on purpose: that module has no database, no clock and no
 * model, which is what lets every branch of the arithmetic be tested against a real
 * contract. This file is the only place that knows periods live in Postgres.
 *
 * Batched by design. A deal list resolves every schedule in two queries rather than two
 * per deal — the list is the hottest read in the app and an N+1 here would be felt.
 */

import { inArray, isNull, and } from "drizzle-orm";
import { db } from "../db";
import { dealPeriods, dealInstallments } from "../../shared/schema";
import { resolveDealValue, termMonths, type DealValue, type PeriodRow, type InstallmentRow } from "./dealValue";

export interface DealMoney extends DealValue {
  /** Months the schedule spans — what the score grid needs to annualise a lump sum. */
  termMonths: number | null;
}

/**
 * Resolve schedules for many deals at once. Deals with no periods are simply absent from
 * the map; a caller must treat "no entry" as "this is an ordinary single-figure deal",
 * never as "this deal is worth nothing".
 */
export async function resolveMoneyForDeals(dealIds: string[]): Promise<Map<string, DealMoney>> {
  const out = new Map<string, DealMoney>();
  const ids = [...new Set(dealIds.filter(Boolean))];
  if (!ids.length) return out;

  const periods = await db
    .select()
    .from(dealPeriods)
    .where(and(inArray(dealPeriods.deal_id, ids), isNull(dealPeriods.superseded_at)));
  if (!periods.length) return out;

  const installments = await db
    .select()
    .from(dealInstallments)
    .where(inArray(dealInstallments.period_id, periods.map((p) => p.id)));

  // period id -> (deal id, seq), so installments can be grouped by the deal they belong to.
  const periodMeta = new Map(periods.map((p) => [p.id, { dealId: p.deal_id, seq: p.seq }]));

  const byDeal = new Map<string, { periods: PeriodRow[]; installments: InstallmentRow[] }>();
  for (const p of periods) {
    const bucket = byDeal.get(p.deal_id) ?? { periods: [], installments: [] };
    bucket.periods.push({
      seq: p.seq, label: p.label,
      starts_on: p.starts_on as unknown as string | null,
      ends_on:   p.ends_on as unknown as string | null,
      cash_cents: p.cash_cents, product_cents: p.product_cents,
      product_directed_cents: p.product_directed_cents,
      guaranteed: p.guaranteed, condition: p.condition,
      superseded_at: p.superseded_at,
    });
    byDeal.set(p.deal_id, bucket);
  }
  for (const i of installments) {
    const meta = periodMeta.get(i.period_id);
    if (!meta) continue;
    const bucket = byDeal.get(meta.dealId);
    if (!bucket) continue;
    bucket.installments.push({
      period_seq: meta.seq, seq: i.seq,
      amount_cents: i.amount_cents,
      due_on: i.due_on as unknown as string | null,
      kind: i.kind,
    });
  }

  const now = new Date();
  for (const [dealId, { periods: ps, installments: is }] of byDeal) {
    out.set(dealId, { ...resolveDealValue(ps, is, now), termMonths: termMonths(ps) });
  }
  return out;
}
