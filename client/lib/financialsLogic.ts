// Her money and the Opportunities sections, in words (app layout B). Pure: no React, no fetch. The server serves the
// amounts (shared/meSummaries FinancialSummary, BookingsSummary) and her picks (GET /me/shop); this maps them to the
// fixed lines the money strip, Financials and the Bookings / Shop sections draw. Nothing here moves money.
//
//   stripLine(f, now)            "$2,450 coming to you · $1,200 paid in Oct" — null until money exists
//   stageLine(stage)             where an upcoming payout stands ("Upcoming · after delivery is confirmed")
//   accountLine(account)         her payout account: "Not set up" · "Finishing setup" · "Payouts on"
//   opportunitySections(...)     which sections show: Deals always; Bookings once she has a published offer; Shop once
//                                she has a live pick
//   shopLine(items)              "4 picks live · 212 clicks this week"
//   bookingWhen(b) · bookingState(b)

import type { BookingLine, BookingsSummary, FinancialSummary, UpcomingStage } from "../../shared/meSummaries";
import { money } from "./whatMattersNext";
import { OPPS_LABEL } from "./flags";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const FIN_COPY = {
  title: "Financials",
  back: OPPS_LABEL,
  coming: "Coming to you",
  payouts: "Payouts",
  holds: "Holds",
  refunds: "Refunds",
  account: "Payout account",
  setUp: "Set up payouts",
  continueSetUp: "Continue setup",
  holdLine: "Refundable · returned to the brand if you decline",
  nothing: "Nothing yet",
  nothingLine: "Payouts, holds and refunds show here once a brand pays.",
  error: "Couldn't load your money.",
  setUpError: "Couldn't open payout setup. Try again.",
} as const;

/** "$2,450 coming to you · $1,200 paid in Oct". Null until money exists (the strip is not drawn). */
export function stripLine(f: FinancialSummary | null | undefined, now: Date): string | null {
  if (!f?.hasMoney) return null;
  const parts: string[] = [];
  if (f.comingCents > 0) parts.push(`${money(f.comingCents, f.currency)} coming to you`);
  if (f.paidMonthCents > 0) parts.push(`${money(f.paidMonthCents, f.currency)} paid in ${MONTHS[now.getUTCMonth()]}`);
  if (!parts.length && f.holds.length) parts.push(`${money(f.holds.reduce((n, h) => n + h.amountCents, 0), f.currency)} held for you`);
  if (!parts.length && f.paidYearCents > 0) parts.push(`${money(f.paidYearCents, f.currency)} paid this year`);
  return parts.length ? parts.join(" · ") : FIN_COPY.title;
}

/** The line under the big number: "$1,200 paid in Oct · $4,900 this year". */
export function paidLine(f: FinancialSummary, now: Date): string | null {
  const parts: string[] = [];
  if (f.paidMonthCents > 0) parts.push(`${money(f.paidMonthCents, f.currency)} paid in ${MONTHS[now.getUTCMonth()]}`);
  if (f.paidYearCents > 0) parts.push(`${money(f.paidYearCents, f.currency)} this year`);
  return parts.length ? parts.join(" · ") : null;
}

export function stageLine(stage: UpcomingStage | undefined): string {
  switch (stage) {
    case "awaiting_delivery": return "Upcoming · after you mark it delivered";
    case "awaiting_confirmation": return "Upcoming · after delivery is confirmed";
    case "in_review": return "On hold · in review";
    case "after_booking": return "Upcoming · after the booking";
    default: return "Upcoming";
  }
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function accountLine(a: FinancialSummary["account"]): { title: string; line: string; action: string | null } {
  switch (a.state) {
    case "active": return { title: "Payouts on", line: "Stripe sends what you earn to your account.", action: null };
    case "pending": return { title: "Finishing setup", line: a.requirementsDue > 0 ? `Stripe needs ${a.requirementsDue} more ${a.requirementsDue === 1 ? "detail" : "details"} before it can pay you.` : "Stripe is checking your details.", action: FIN_COPY.continueSetUp };
    default: return { title: "Not set up", line: "Set up payouts so Nomila can pay you what you earn.", action: FIN_COPY.setUp };
  }
}

// ── Opportunities sections ────────────────────────────────────────────────────

export interface ShopPickLike { status: string; clicks7d: number }

export interface OpportunitySections { bookings: boolean; shop: boolean; any: boolean }

/** Deals always; Bookings once she has a published offer; Shop once she has a live pick. */
export function opportunitySections(bookings: Pick<BookingsSummary, "published"> | null | undefined, picks: ReadonlyArray<ShopPickLike> | null | undefined): OpportunitySections {
  const b = !!bookings?.published;
  const s = (picks ?? []).some((p) => p.status === "live");
  return { bookings: b, shop: s, any: b || s };
}

export function shopLine(picks: ReadonlyArray<ShopPickLike>): { live: string; clicks: string } {
  const live = picks.filter((p) => p.status === "live");
  const clicks = live.reduce((n, p) => n + (p.clicks7d || 0), 0);
  return { live: `${live.length} ${live.length === 1 ? "pick" : "picks"} live`, clicks: `${clicks} ${clicks === 1 ? "click" : "clicks"} this week` };
}

/** "Sat 18 Oct · $120" (UTC calendar date), or the price alone while the time is still being agreed. */
export function bookingWhen(b: Pick<BookingLine, "startsAt" | "priceCents" | "currency">): string {
  const price = money(b.priceCents, b.currency);
  if (!b.startsAt) return price;
  const d = new Date(b.startsAt);
  if (Number.isNaN(d.getTime())) return price;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${price}`;
}

export function bookingState(b: Pick<BookingLine, "status">): { text: string; waiting: boolean } {
  return b.status === "requested" ? { text: "Waiting for you", waiting: true } : { text: "Accepted", waiting: false };
}
