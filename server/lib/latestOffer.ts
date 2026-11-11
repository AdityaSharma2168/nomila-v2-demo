/**
 * latestOffer.ts — the ONE money number a deal action anchors on: the latest offer.
 *
 * What the athlete gets: a draft answers what the brand offered LAST, and a payment request bills
 * the figure that was agreed — not the first number ever seen. `deals.amount` is written once, when
 * the deal is detected (and again only when she saves a contract), so on a negotiated deal it is
 * the opening figure: brand moves $200 → $950, and a draft anchored on $200 asked for less than was
 * already on the table.
 *
 * Precedence:
 *   1. a figure SHE confirmed (a contract she saved or a deal she entered) — deals.amount;
 *   2. the latest offer on the deal's threads — conversation_state.key_details.offer_struct.amount
 *      of the most recently active thread that states one (the summariser tracks the latest offer);
 *   3. deals.amount, the detection-time snapshot, only when nothing newer exists.
 */

import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { deals, inboxThreads } from "../../shared/schema";

export type OfferSource = "confirmed" | "thread" | "deal_row";

export interface LatestOffer {
  amount: number;
  source: OfferSource;
}

export interface OfferDealLike {
  amount: unknown;
  source?: string | null;
  raw_data?: unknown;
}

export interface OfferThreadLike {
  conversation_state?: unknown;
  last_message_at?: Date | string | null;
}

const positive = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Sources whose deals.amount is a figure she entered or confirmed herself. */
const CONFIRMED_SOURCES = new Set(["contract_upload", "self_reported", "manual"]);

function confirmedByHer(deal: OfferDealLike): boolean {
  if (deal.source && CONFIRMED_SOURCES.has(deal.source)) return true;
  const raw = (deal.raw_data ?? {}) as Record<string, any>;
  return raw?.confirmed?.by === "athlete";
}

const time = (v: Date | string | null | undefined): number => {
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

/** Pure: the latest offer from a deal and its threads, or null when none is known. */
export function pickLatestOffer(deal: OfferDealLike, threads: readonly OfferThreadLike[]): LatestOffer | null {
  const row = positive(deal.amount);
  if (row != null && confirmedByHer(deal)) return { amount: row, source: "confirmed" };

  const newestFirst = [...threads].sort((a, b) => time(b.last_message_at) - time(a.last_message_at));
  for (const t of newestFirst) {
    const cs = (t.conversation_state ?? null) as Record<string, any> | null;
    const amt = positive(cs?.key_details?.offer_struct?.amount);
    if (amt != null) return { amount: amt, source: "thread" };
  }
  return row != null ? { amount: row, source: "deal_row" } : null;
}

type Db = typeof defaultDb;

/** The latest offer for one of her deals (scoped by athlete). null = no figure known. */
export async function latestOfferForDeal(athleteId: string, dealId: string, db: Db = defaultDb): Promise<LatestOffer | null> {
  const [deal] = await db
    .select({ amount: deals.amount, source: deals.source, raw_data: deals.raw_data })
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
    .limit(1);
  if (!deal) return null;
  const threads = await db
    .select({ conversation_state: inboxThreads.conversation_state, last_message_at: inboxThreads.last_message_at })
    .from(inboxThreads)
    .where(and(eq(inboxThreads.deal_id, dealId), eq(inboxThreads.athlete_id, athleteId)));
  return pickLatestOffer(deal, threads);
}
