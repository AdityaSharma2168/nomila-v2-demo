/**
 * whatMattersNext.ts — the candidates for Home's "What matters next" (app layout B, 8 Oct 2026), gathered across every
 * tab. Read-only, owner-scoped, computed on read; nothing is cached or written.
 *
 * The SERVER gathers; the CLIENT ranks and words (client/lib/whatMattersNext.ts holds the one ranking rule and the copy),
 * so this returns structured candidates — a kind, the clocks, a brand or a title from her own records, an amount, and
 * where the row opens. Nothing here accepts, declines or answers anything; each candidate only names a screen.
 *
 *   booking_request   a verified buyer waiting on her answer (dark until BOOKINGS_ENABLED; dueAt = respond-by)
 *   serious_offer     an opportunity whose deal carries a held seriousness deposit (the brand's refundable hold)
 *   deal_waiting      any other opportunity whose move is hers — the board's needsYou, in its order, with the card's next
 *                     step (need / why / deadline), so Home and Opportunities say the same thing in the same order
 *   payout_setup      money is waiting for her and she has no active payout account
 *   money_paid        the newest payout in the last 30 days
 *   mila_suggestion   Mila's open suggestion to change her strategy (a research refresh), until she answers it
 * Card views are not gathered: there is no public card yet (they join here when it ships).
 *
 * Each source is read on its own; one that fails is logged and left out, so Home never blanks because of one.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { deals, payments } from "../../shared/schema";
import { createLogger } from "../logger";
import { readOpportunityBoard, type BoardItem } from "./opportunityBoard";
import { readFinancialSummary, HOLD_STATUSES } from "./moneySummary";
import { readBookingsSummary } from "./bookings/summary";
import type { NextCandidate, WhatMattersNext } from "../../shared/meSummaries";
import { homeCandidate } from "../agent/researchRefresh/proposal";
import { dbStore } from "../agent/research/dbStore";

const logger = createLogger("services/whatMattersNext");

export type { NextCandidate, NextKind, NextTarget, WhatMattersNext } from "../../shared/meSummaries";

/** How many of each source travel; the client shows five at most. */
const PER_SOURCE = 20;
const PAID_NEWS_DAYS = 30;

const base = (o: Partial<NextCandidate> & Pick<NextCandidate, "key" | "kind" | "target">): NextCandidate => ({
  dueAt: null, at: null, order: null, title: null, brandName: null, logoUrl: null, amountCents: null, currency: null, ...o,
});

async function settle<T>(label: string, athleteId: string, p: Promise<T>, empty: T): Promise<T> {
  try { return await p; } catch (err: any) {
    logger.warn({ athleteId, source: label, error: err?.message }, "what matters next: a source failed; left out");
    return empty;
  }
}

/**
 * Opportunities waiting on her — the board's needsYou list, in the board's ONE order (`order` = its place), each with the
 * card's next step (what to do, why, any deadline). A held deposit is first-class as a serious offer, waiting on her or
 * not. One card per brand, as the board draws it. `waiting` is the board's count, so Home and Opportunities agree.
 */
async function opportunityCandidates(athleteId: string, now: Date, dbx: any): Promise<{ items: NextCandidate[]; waiting: number }> {
  const board = await readOpportunityBoard(athleteId, now, dbx);
  const seen = new Set<string>();
  const items: BoardItem[] = [];
  for (const it of [...board.needsYou, ...board.whatMatters, ...board.needsTermsBatch, ...board.goingQuiet, ...board.inMotion, ...board.explore]) {
    if (seen.has(it.opportunity_id)) continue;
    seen.add(it.opportunity_id);
    items.push(it);
  }
  const allDealIds = [...new Set(items.flatMap((i) => i.deal_ids))];
  const held = new Map<string, number>();   // deal id → hold cents
  if (allDealIds.length) {
    const heldDeals = await dbx.select({ id: deals.id }).from(deals)
      .where(and(eq(deals.athlete_id, athleteId), inArray(deals.id, allDealIds), eq(deals.deposit_status, "held")));
    const ids = heldDeals.map((d: { id: string }) => d.id);
    if (ids.length) {
      const holds = await dbx.select({ deal_id: payments.deal_id, cents: payments.brand_total_cents }).from(payments)
        .where(and(eq(payments.athlete_id, athleteId), eq(payments.kind, "deposit"), inArray(payments.deal_id, ids), inArray(payments.status, [...HOLD_STATUSES])));
      for (const id of ids) held.set(id, 0);
      for (const h of holds) if (h.deal_id) held.set(h.deal_id, h.cents ?? 0);
    }
  }
  const place = new Map(board.needsYou.map((it, i) => [it.opportunity_id, i]));
  const out: NextCandidate[] = [];
  for (const it of items) {
    const heldDeal = it.deal_ids.find((d) => held.has(d)) ?? null;
    const waiting = place.has(it.opportunity_id);
    if (!heldDeal && !waiting) continue;
    out.push(base({
      key: `opp:${it.opportunity_id}`,
      kind: heldDeal ? "serious_offer" : "deal_waiting",
      at: it.her_move_since ?? it.last_activity_at,
      dueAt: it.next?.due ?? null,
      order: place.get(it.opportunity_id) ?? null,
      brandName: it.brand.name,
      logoUrl: it.brand.logo_none ? null : it.brand.research_confirmed ? it.brand.logo_url ?? it.brand.safe_logo_url : it.brand.safe_logo_url,
      amountCents: heldDeal ? held.get(heldDeal) || null : null,
      currency: heldDeal ? "usd" : null,
      action: it.next?.action ?? null,
      need: it.next?.label ?? null,
      why: it.next?.why ?? null,
      target: { screen: "opportunity", opportunityId: it.opportunity_id, dealId: heldDeal ?? it.lead_deal_id },
    }));
    if (out.length >= PER_SOURCE) break;
  }
  return { items: out, waiting: board.counts.needsYou };
}

async function moneyCandidates(athleteId: string, now: Date, dbx: any): Promise<NextCandidate[]> {
  const f = await readFinancialSummary(athleteId, now, dbx);
  const out: NextCandidate[] = [];
  if (f.comingCents > 0 && f.account.state !== "active") {
    out.push(base({ key: "payout_setup", kind: "payout_setup", amountCents: f.comingCents, currency: f.currency, target: { screen: "financials" } }));
  }
  const since = now.getTime() - PAID_NEWS_DAYS * 86_400_000;
  const paid = f.payouts.paid.find((p) => p.at && Date.parse(p.at) >= since);
  if (paid) {
    out.push(base({ key: `paid:${paid.id}`, kind: "money_paid", at: paid.at, brandName: paid.source === "deal" ? paid.label || null : null, title: paid.source === "booking" ? paid.label || null : null, amountCents: paid.amountCents, currency: paid.currency, target: { screen: "financials" } }));
  }
  return out;
}

async function bookingCandidates(athleteId: string, dbx: any): Promise<NextCandidate[]> {
  const b = await readBookingsSummary(athleteId, dbx);
  return b.requests.slice(0, PER_SOURCE).map((r) => base({
    key: `booking:${r.id}`, kind: "booking_request", dueAt: r.respondBy, at: r.createdAt, title: r.title,
    amountCents: r.priceCents, currency: r.currency, target: { screen: "booking", id: r.id },
  }));
}

export async function readWhatMattersNext(athleteId: string, now: Date = new Date(), dbx: any = db): Promise<WhatMattersNext> {
  const [bookingsOut, opps, money, suggestion] = await Promise.all([
    settle("bookings", athleteId, bookingCandidates(athleteId, dbx), []),
    settle("opportunities", athleteId, opportunityCandidates(athleteId, now, dbx), { items: [], waiting: 0 }),
    settle("money", athleteId, moneyCandidates(athleteId, now, dbx), []),
    settle("suggestion", athleteId, homeCandidate(dbStore, athleteId).then((c) => (c ? [c] : [])), [] as NextCandidate[]),
  ]);
  return { version: "what-matters-next/0.1", items: [...bookingsOut, ...opps.items, ...money, ...suggestion], waiting: opps.waiting };
}
