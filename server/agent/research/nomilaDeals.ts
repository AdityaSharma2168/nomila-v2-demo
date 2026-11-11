/**
 * agent/research/nomilaDeals.ts — the Understand skill's `nomila_deals` input (understand 1.13.0): the athlete's OWN deals
 * in Nomila that she accepted, agreed or signed, read from the current deals tables (deals, deal_periods,
 * deal_deliverables, inbox_brands). Never from the retired legacy intelligence.
 *
 * Which deals: hers only (every query is scoped to the athlete, and the periods and deliverables are read only for the
 * deals that query returned), with status accepted or completed, or marked signed — never a rejected one, never one
 * still detected, pending or in negotiation. Several threads grouped as one deal (deal_group_id) count once.
 *
 * Each deal: the brand, the deal type, the deliverables (the contract's own words, with the count), the agreed fee or
 * "product only", the date, and how it is confirmed — a signed contract (her "Yes, it's signed" or a contract she saved
 * marked signed: deals.signed_at) or only an email. The fee comes from the contract's schedule (deal_periods,
 * guaranteed cash, live rows) when there is one, else the deal's recorded cash figure (labelled as such: it is the
 * offer as recorded, which can be stale). Fees are private: they reach the model only, to shape the private ranges.
 *
 * Nothing here names an athlete, sport, school or brand.
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { dealDeliverables, dealPeriods, deals, inboxBrands } from "../../../shared/schema";

/** Statuses that mean she agreed the deal. A signed deal counts whatever its status, unless rejected. */
export const AGREED_DEAL_STATUSES = ["accepted", "completed"] as const;
/** At most this many deals go in, newest first. */
export const MAX_NOMILA_DEALS = 20;

export type DealConfirmation = "signed_contract" | "email_only" | "not_signed";

export interface NomilaDeal {
  brand: string;
  dealType: string | null;
  /** "2x Reel · 9:16", the contract's own words with the count. */
  deliverables: string[];
  /** The agreed cash fee in whole currency units; null when none is recorded. */
  fee: { amount: number; currency: string; basis: "contract_schedule" | "deal_record" } | null;
  /** Product or service only, no cash: experience and proof, never a price. */
  productOnly: boolean;
  /** Paid by commission only, no guaranteed cash. */
  commissionOnly: boolean;
  /** YYYY-MM-DD: signed, else term start, else when it was found. */
  date: string | null;
  confirmedBy: DealConfirmation;
}

export interface DealRow {
  id: string;
  brand_name: string | null;
  brand: string | null;
  deal_type: string | null;
  status: string | null;
  source: string | null;
  signed_at: Date | string | null;
  term_start: string | null;
  detected_at: Date | string | null;
  created_at: Date | string | null;
  amount_cash: string | number | null;
  amount_product: string | number | null;
  commission_pct: string | number | null;
  deal_group_id: string | null;
}
export interface PeriodLite { deal_id: string; cash_cents: number | null; product_cents: number | null; currency: string | null; guaranteed: boolean }
export interface DeliverableLite { deal_id: string; format: string; quantity: number }

const pos = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const day = (v: unknown): string | null => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10) || null);

/** One deal row (with its live periods and deliverables) as the input describes it. Pure. */
export function toNomilaDeal(r: DealRow, periods: PeriodLite[], deliverables: DeliverableLite[]): NomilaDeal {
  const guaranteed = periods.filter((p) => p.guaranteed);
  const scheduleCash = guaranteed.reduce((s, p) => s + pos(p.cash_cents), 0);
  const scheduleProduct = guaranteed.reduce((s, p) => s + pos(p.product_cents), 0);
  const cash = pos(r.amount_cash);
  const fee: NomilaDeal["fee"] = scheduleCash > 0
    ? { amount: Math.round(scheduleCash / 100), currency: String(guaranteed.find((p) => pos(p.cash_cents) > 0)?.currency || "usd").toUpperCase(), basis: "contract_schedule" }
    : cash > 0 ? { amount: Math.round(cash), currency: "USD", basis: "deal_record" } : null;
  const product = scheduleProduct > 0 || pos(r.amount_product) > 0;
  return {
    brand: String(r.brand ?? r.brand_name ?? "").trim() || "a brand",
    dealType: r.deal_type ?? null,
    deliverables: deliverables.map((d) => `${Math.max(1, Number(d.quantity) || 1)}x ${String(d.format).replace(/\s+/g, " ").trim()}`).filter((s) => s.length > 3).slice(0, 8),
    fee,
    productOnly: !fee && product,
    commissionOnly: !fee && !product && pos(r.commission_pct) > 0,
    date: day(r.signed_at) ?? day(r.term_start) ?? day(r.detected_at) ?? day(r.created_at),
    confirmedBy: r.signed_at ? "signed_contract" : r.source === "inbox_scan" ? "email_only" : "not_signed",
  };
}

/**
 * Several threads of one underlying deal (deal_group_id) count once: the signed one first, else the newest. Rows come
 * newest first. Pure.
 */
export function oneRowPerDeal<T extends Pick<DealRow, "deal_group_id" | "signed_at">>(rows: T[]): T[] {
  const byGroup = new Map<string, T>();
  const out: T[] = [];
  for (const r of rows) {
    if (!r.deal_group_id) { out.push(r); continue; }
    const seen = byGroup.get(r.deal_group_id);
    if (!seen) { byGroup.set(r.deal_group_id, r); out.push(r); continue; }
    if (!seen.signed_at && r.signed_at) { out[out.indexOf(seen)] = r; byGroup.set(r.deal_group_id, r); }
  }
  return out;
}

/** Her agreed, accepted or signed deals in Nomila, newest first. Every read is scoped to the athlete. */
export async function loadNomilaDeals(athleteId: string, dbx: any = defaultDb): Promise<NomilaDeal[]> {
  const rows: DealRow[] = await dbx.select({
    id: deals.id, brand_name: deals.brand_name, brand: inboxBrands.name, deal_type: deals.deal_type, status: deals.status, source: deals.source,
    signed_at: deals.signed_at, term_start: deals.term_start, detected_at: deals.detected_at, created_at: deals.created_at,
    amount_cash: deals.amount_cash, amount_product: deals.amount_product, commission_pct: deals.commission_pct, deal_group_id: deals.deal_group_id,
  }).from(deals).leftJoin(inboxBrands, eq(inboxBrands.id, deals.brand_id))
    .where(and(
      eq(deals.athlete_id, athleteId),
      or(inArray(deals.status, [...AGREED_DEAL_STATUSES]), isNotNull(deals.signed_at)),
      or(isNull(deals.status), ne(deals.status, "rejected")),
    ))
    .orderBy(desc(deals.created_at))
    .limit(MAX_NOMILA_DEALS * 3);
  const kept = oneRowPerDeal(rows).slice(0, MAX_NOMILA_DEALS);
  if (!kept.length) return [];
  const ids = kept.map((r) => r.id);
  const [periods, deliverables]: [PeriodLite[], DeliverableLite[]] = await Promise.all([
    dbx.select({ deal_id: dealPeriods.deal_id, cash_cents: dealPeriods.cash_cents, product_cents: dealPeriods.product_cents, currency: dealPeriods.currency, guaranteed: dealPeriods.guaranteed })
      .from(dealPeriods).where(and(inArray(dealPeriods.deal_id, ids), isNull(dealPeriods.superseded_at))),
    dbx.select({ deal_id: dealDeliverables.deal_id, format: dealDeliverables.format, quantity: dealDeliverables.quantity })
      .from(dealDeliverables).where(and(inArray(dealDeliverables.deal_id, ids), isNull(dealDeliverables.superseded_at)))
      .orderBy(dealDeliverables.seq),
  ]);
  return kept.map((r) => toNomilaDeal(r, periods.filter((p) => p.deal_id === r.id), deliverables.filter((d) => d.deal_id === r.id)));
}

const CONFIRMED_WORDS: Record<DealConfirmation, string> = {
  signed_contract: "signed contract", email_only: "email only, not signed", not_signed: "agreed, not signed",
};
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The NOMILA DEALS block of Understand's input: one line per deal, D1… (never fact keys: a deal is not a fact). Pure. */
export function nomilaDealsBlock(list: readonly NomilaDeal[]): string[] {
  return [
    `NOMILA DEALS (the athlete's own deals in Nomila, accepted, agreed or signed; private: fees never in public text)`,
    ...(list.length ? list.map((d, n) => {
      const pay = d.fee ? `fee ${d.fee.amount} ${d.fee.currency}${d.fee.basis === "deal_record" ? " (as recorded from the offer)" : " (contract schedule)"}`
        : d.productOnly ? "product only, no fee" : d.commissionOnly ? "commission only, no guaranteed fee" : "fee not recorded";
      return `D${n + 1} | ${oneLine(d.brand)} | type ${d.dealType ?? "-"} | deliverables ${d.deliverables.length ? d.deliverables.map(oneLine).join("; ") : "not recorded"} | ${pay} | date ${d.date ?? "-"} | ${CONFIRMED_WORDS[d.confirmedBy]}`;
    }) : ["- (none yet)"]),
  ];
}
