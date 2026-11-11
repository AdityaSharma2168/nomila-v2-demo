// What matters next — Home's ONE ranked list across every tab (app layout B, agreed 8 Oct 2026). Pure: no React, no
// fetch. The server gathers the candidates (GET /api/v1/me/what-matters-next, server/services/whatMattersNext.ts);
// this file holds the ranking rule and the fixed words. Nothing here generates a sentence about her: a row's title is
// a template around a stored name, title or amount.
//
// The ranking rule (design "How What matters next is ranked"):
//   1 on a clock       a booking request to accept, or anything carrying a deadline — soonest first
//   2 waiting on her   a serious offer (money held), any other deal waiting for her, "Set up payouts" when money is
//                      waiting and she has no active payout account — deals in the Opportunities board's own order
//                      (the server's `order`), so both screens list them the same way; the rest newest first
//   3 suggestion       Mila's open suggestion
//   4 news             one money line, then one card line — never above anything in 1–3
// An open mila_suggestion (Mila's own positioning suggestion, waiting on her tap) is a true reservation, never crowded
// out by deals: at most one, always the first row, with everything else sharing the remaining NEXT_MAX - 1 slots in
// its usual order.
// Five at most. "See all N" opens Opportunities, and N is the SAME number that tab shows ("N waiting on you": the
// server's `waiting`, the board's needsYou count). An older server without it: N counts groups 1–2, shown past five.
// A deal row says the ONE thing to do and why, from the deal's own next step (server/lib/opportunityNext) — never a
// bare "[Brand] is waiting on you".
// Each row only opens the screen where it is handled: nothing on Home accepts, declines or replies.

import type { NextCandidate, NextKind } from "../../shared/meSummaries";
import { respondByLabel } from "./dealWords";
import { OPPS_LABEL } from "./flags";
export type { NextCandidate, NextKind, NextTarget, WhatMattersNext } from "../../shared/meSummaries";

export const NEXT_MAX = 5;

export type NextGroup = 1 | 2 | 3 | 4;

/** A candidate's group. A deadline puts anything waiting on her into group 1; news and the suggestion never move up. */
export function groupOf(c: Pick<NextCandidate, "kind" | "dueAt">): NextGroup {
  switch (c.kind) {
    case "mila_suggestion": return 3;
    case "money_paid": case "card_views": return 4;
    default: return c.dueAt ? 1 : 2;
  }
}

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
/** Ascending with nulls last. */
const asc = (a: number | null, b: number | null) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a - b);
/** Descending (newest first) with nulls last. */
const desc = (a: number | null, b: number | null) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : b - a);

export interface RankedNext {
  /** The rows Home draws, in order: five at most. */
  shown: NextCandidate[];
  /** The "See all N" count: the opportunities waiting on her (the server's `waiting`), else everything in groups 1–2. */
  urgent: number;
  /** More waiting than Home shows: the header links to Opportunities. */
  seeAll: boolean;
}

/** `waiting`: GET /me/what-matters-next's count of opportunities waiting on her (absent from an older server). */
export function rankNext(items: ReadonlyArray<NextCandidate>, waiting?: number | null): RankedNext {
  const g = (n: NextGroup) => items.filter((c) => groupOf(c) === n);
  const clock = g(1).sort((a, b) => asc(time(a.dueAt), time(b.dueAt)) || asc(a.order, b.order));
  // The board's own order for deals (order), then newest first for the rest.
  const waitingOn = g(2).sort((a, b) => asc(a.order, b.order) || desc(time(a.at), time(b.at)));
  // Never more than one; always the first row, so 10 deals waiting can never hide it (the bug this guards against).
  const suggestion = g(3).filter((c) => c.kind === "mila_suggestion").slice(0, 1);
  const newest = (kind: NextKind) => g(4).filter((c) => c.kind === kind).sort((a, b) => desc(time(a.at), time(b.at)))[0];
  const news = [newest("money_paid"), newest("card_views")].filter((c): c is NextCandidate => !!c);
  const urgent = clock.length + waitingOn.length;
  // The suggestion's slot is reserved out of NEXT_MAX; everything else keeps its own order in the rest.
  const rest = [...clock, ...waitingOn, ...news].slice(0, NEXT_MAX - suggestion.length);
  const shown = [...suggestion, ...rest];
  if (typeof waiting === "number") {
    const dealsShown = shown.filter((c) => c.target.screen === "opportunity").length;
    return { shown, urgent: waiting, seeAll: waiting > dealsShown };
  }
  return { shown, urgent, seeAll: urgent > NEXT_MAX };
}

// ── words ─────────────────────────────────────────────────────────────────────

/** "$1,200" · "$1,200.50" for USD; "1,200 EUR" otherwise. Integer cents in. */
export function money(cents: number | null | undefined, currency: string | null | undefined = "usd"): string {
  const c = Math.round(cents ?? 0);
  const whole = Math.floor(Math.abs(c) / 100);
  const part = Math.abs(c) % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const n = `${grouped}${part ? `.${String(part).padStart(2, "0")}` : ""}`;
  const sign = c < 0 ? "-" : "";
  return (currency ?? "usd").toLowerCase() === "usd" ? `${sign}$${n}` : `${sign}${n} ${(currency ?? "").toUpperCase()}`;
}

/** "18h left to accept" · "2 days left to accept" · "Respond today" when under an hour or past. */
export function clockLine(dueAt: string | null, now: Date, verb = "accept"): string | null {
  const t = time(dueAt);
  if (t == null) return null;
  const hours = Math.floor((t - now.getTime()) / 3_600_000);
  if (hours < 1) return "Respond today";
  if (hours < 48) return `${hours}h left to ${verb}`;
  return `${Math.floor(hours / 24)} days left to ${verb}`;
}

export interface NextRowCopy { title: string; source: string; clock: string | null }

export const NEXT_COPY = {
  heading: "What matters next",
  seeAll: (n: number) => `See all ${n}`,
  empty: "Nothing waiting on you",
  emptyLine: "New deals, bookings and money will show here.",
  emptyLink: "Plan",
} as const;

/**
 * A deal row's title: the ONE thing to do, around the stored brand name. Keyed on the next step's ACTION (an enum from the
 * deal's state), never on a brand. An action this client doesn't know reads "<brand> · <the server's own words>".
 */
const NEED_TITLE: Record<string, (brand: string) => string> = {
  confirm_signed: (b) => `Confirm ${b} is signed`,
  verify:         (b) => `Check who ${b} really is`,
  ask_for_terms:  (b) => `Ask ${b} for terms`,
  counter:        (b) => `Counter ${b}’s offer`,
  reply:          (b) => `Reply to ${b}`,
  decline:        (b) => `Decline ${b}`,
};

/** A deal row from its next step (need / why / deadline); null when an older server sent none. */
function dealRow(c: NextCandidate, now: Date, brand: string, amount: string | null): NextRowCopy | null {
  if (!c.need && !c.action) return null;
  const title = (c.action && NEED_TITLE[c.action]?.(brand)) ?? `${brand} · ${c.need}`;
  const why = c.why?.trim() || null;
  const held = c.kind === "serious_offer" && amount ? `${amount} held` : null;
  return { title, source: [held, why].filter(Boolean).join(" · ") || OPPS_LABEL, clock: respondByLabel(c.dueAt, now) };
}

/** The fixed words for one row. */
export function rowCopy(c: NextCandidate, now: Date): NextRowCopy {
  const brand = c.brandName?.trim() || "A brand";
  const amount = c.amountCents ? money(c.amountCents, c.currency) : null;
  if (c.kind === "serious_offer" || c.kind === "deal_waiting") {
    const row = dealRow(c, now, brand, amount);
    if (row) return row;
  }
  switch (c.kind) {
    case "booking_request":
      return { title: c.title ? `Booking request: ${c.title}` : "A booking request", source: "Opportunities · Bookings", clock: clockLine(c.dueAt, now) };
    case "serious_offer":
      return { title: `Serious offer from ${brand}`, source: amount ? `Opportunities · ${amount} held` : "Opportunities · Deals", clock: clockLine(c.dueAt, now, "reply") };
    case "deal_waiting":
      return { title: `${brand} is waiting on you`, source: "Opportunities · Deals", clock: clockLine(c.dueAt, now, "reply") };
    case "payout_setup":
      return { title: "Set up payouts to get paid", source: amount ? `Money · ${amount} waiting for you` : "Money", clock: null };
    case "money_paid": {
      const who = c.brandName?.trim() || c.title?.trim();
      return { title: `${amount ?? "Money"} paid${who ? ` by ${who}` : ""}`, source: "Money · Financials", clock: null };
    }
    case "card_views":
      return { title: c.title ?? "Your card had new views", source: "Your public card · this week", clock: null };
    case "mila_suggestion":
      return { title: c.title ?? "Mila suggests updating your positioning", source: "Mila · waiting for your answer", clock: null };
  }
}
