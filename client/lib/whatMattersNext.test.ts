/**
 * whatMattersNext.test — the ONE ranking rule behind Home's "What matters next" (app layout B) and its fixed words.
 *
 *   groups    a clock first (soonest deadline first) · waiting on her, newest first · news last (one money line,
 *             then one card line) — news never ranks above 1–2; Mila's open suggestion always first
 *   cap       five at most; "See all N" only when more than five fall in groups 1–2 (N counts groups 1–2)
 *   words     templates around stored names, titles and amounts; the clock reads "18h left to accept"
 */
import type { NextCandidate } from "../../shared/meSummaries";
import { clockLine, groupOf, money, rankNext, rowCopy } from "./whatMattersNext";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const c = (key: string, kind: NextCandidate["kind"], over: Partial<NextCandidate> = {}): NextCandidate => ({
  key, kind, dueAt: null, at: null, order: null, title: null, brandName: null, logoUrl: null, amountCents: null, currency: null,
  target: { screen: "financials" }, ...over,
});
const keys = (items: NextCandidate[]) => items.map((i) => i.key);

describe("groups", () => {
  it("a deadline puts anything waiting on her on the clock; the suggestion and news never move up", () => {
    expect(groupOf(c("a", "booking_request", { dueAt: "2026-10-09T00:00:00Z" }))).toBe(1);
    expect(groupOf(c("b", "deal_waiting", { dueAt: "2026-10-09T00:00:00Z" }))).toBe(1);
    expect(groupOf(c("c", "deal_waiting"))).toBe(2);
    expect(groupOf(c("d", "serious_offer"))).toBe(2);
    expect(groupOf(c("e", "payout_setup"))).toBe(2);
    expect(groupOf(c("f", "mila_suggestion", { dueAt: "2026-10-09T00:00:00Z" }))).toBe(3);
    expect(groupOf(c("g", "money_paid", { dueAt: "2026-10-09T00:00:00Z" }))).toBe(4);
  });
});

describe("rankNext", () => {
  it("the busy day: clock first (soonest), then waiting (newest); five at most; news drops off", () => {
    const items = [
      c("paid", "money_paid", { at: "2026-10-08T11:00:00Z" }),
      c("old-deal", "deal_waiting", { at: "2026-10-01T00:00:00Z" }),
      c("offer", "serious_offer", { at: "2026-10-07T00:00:00Z" }),
      c("payout", "payout_setup", { at: null }),
      c("late-booking", "booking_request", { dueAt: "2026-10-10T00:00:00Z" }),
      c("soon-booking", "booking_request", { dueAt: "2026-10-09T06:00:00Z" }),
    ];
    const r = rankNext(items);
    expect(keys(r.shown)).toEqual(["soon-booking", "late-booking", "offer", "old-deal", "payout"]);
    expect(r.urgent).toBe(5);
    expect(r.seeAll).toBe(false);
  });

  it("the quiet day: the deal, then the money line (the newest only), then the card line", () => {
    const r = rankNext([
      c("card", "card_views", { at: "2026-10-08T00:00:00Z" }),
      c("paid-old", "money_paid", { at: "2026-10-01T00:00:00Z" }),
      c("paid-new", "money_paid", { at: "2026-10-05T00:00:00Z" }),
      c("deal", "deal_waiting", { at: "2026-10-06T00:00:00Z" }),
    ]);
    expect(keys(r.shown)).toEqual(["deal", "paid-new", "card"]);
    expect(r).toMatchObject({ urgent: 1, seeAll: false });
  });

  it("more than five on a clock or waiting: 'See all N' with N = every one of them; news waits its turn", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => c(`deal${i}`, "deal_waiting", { at: `2026-10-0${i + 1}T00:00:00Z` })),
      c("booking", "booking_request", { dueAt: "2026-10-09T00:00:00Z" }),
      c("paid", "money_paid", { at: "2026-10-08T00:00:00Z" }),
    ];
    const r = rankNext(items);
    expect(keys(r.shown)).toEqual(["booking", "deal5", "deal4", "deal3", "deal2"]);
    expect(r).toMatchObject({ urgent: 7, seeAll: true });
  });

  it("a new athlete: nothing", () => {
    expect(rankNext([])).toEqual({ shown: [], urgent: 0, seeAll: false });
  });

  it("an open Mila suggestion always has a visible slot — ten deals waiting can't push it off Home", () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => c(`deal${i}`, "deal_waiting", { order: i, at: `2026-10-0${(i % 9) + 1}T00:00:00Z` })),
      c("suggestion", "mila_suggestion"),
    ];
    const r = rankNext(items);
    expect(r.shown).toHaveLength(5);
    expect(keys(r.shown)).toContain("suggestion");
    expect(keys(r.shown)[0]).toBe("suggestion");
    // never more than one suggestion row, and the deals that do show keep the board's own order
    expect(keys(r.shown)).toEqual(["suggestion", "deal0", "deal1", "deal2", "deal3"]);
  });
});

describe("words", () => {
  it("money: dollars with grouping, cents only when there are some; other currencies by code", () => {
    expect(money(245_000)).toBe("$2,450");
    expect(money(120_050, "usd")).toBe("$1,200.50");
    expect(money(5_000, "eur")).toBe("50 EUR");
  });

  it("the clock", () => {
    expect(clockLine("2026-10-09T06:00:00.000Z", NOW)).toBe("18h left to accept");
    expect(clockLine("2026-10-12T12:00:00.000Z", NOW)).toBe("4 days left to accept");
    expect(clockLine("2026-10-08T12:20:00.000Z", NOW)).toBe("Respond today");
    expect(clockLine(null, NOW)).toBeNull();
  });

  it("each kind's row: a template around the stored name, title or amount; the source names where it lives", () => {
    expect(rowCopy(c("a", "booking_request", { title: "20-min video call", dueAt: "2026-10-09T06:00:00.000Z" }), NOW)).toEqual({ title: "Booking request: 20-min video call", source: "Opportunities · Bookings", clock: "18h left to accept" });
    expect(rowCopy(c("b", "serious_offer", { brandName: "Brand D", amountCents: 5_000 }), NOW)).toEqual({ title: "Serious offer from Brand D", source: "Opportunities · $50 held", clock: null });
    expect(rowCopy(c("c", "deal_waiting", { brandName: "Brand A" }), NOW)).toEqual({ title: "Brand A is waiting on you", source: "Opportunities · Deals", clock: null });
    expect(rowCopy(c("d", "payout_setup", { amountCents: 180_000 }), NOW)).toEqual({ title: "Set up payouts to get paid", source: "Money · $1,800 waiting for you", clock: null });
    expect(rowCopy(c("f", "money_paid", { brandName: "Brand F", amountCents: 120_000 }), NOW)).toEqual({ title: "$1,200 paid by Brand F", source: "Money · Financials", clock: null });
  });
});

describe("one row model with the Opportunities board (8 Oct 2026)", () => {
  const deal = (key: string, over: Partial<NextCandidate>) => c(key, "deal_waiting", { brandName: `Brand ${key}`, target: { screen: "opportunity", opportunityId: key, dealId: null }, ...over });

  it("a deal row says the one thing to do and why — never '[Brand] is waiting on you'", () => {
    expect(rowCopy(deal("A", { action: "confirm_signed", need: "Confirm it’s signed", why: "An e-signature email says every party has signed." }), NOW))
      .toEqual({ title: "Confirm Brand A is signed", source: "An e-signature email says every party has signed.", clock: null });
    expect(rowCopy(deal("B", { action: "ask_for_terms", need: "Ask for terms", why: "Their ask: Two posts.", dueAt: "2026-10-12" }), NOW))
      .toEqual({ title: "Ask Brand B for terms", source: "Their ask: Two posts.", clock: "Respond by Oct 12" });
    expect(rowCopy(c("S", "serious_offer", { brandName: "Brand S", amountCents: 5_000, currency: "usd", action: "reply", need: "Reply", why: "They sent the agreement." }), NOW))
      .toEqual({ title: "Reply to Brand S", source: "$50 held · They sent the agreement.", clock: null });
    // an action this client doesn't know: the server's own words
    expect(rowCopy(deal("C", { action: "something_new", need: "Do the new thing", why: "w" }), NOW).title).toBe("Brand C · Do the new thing");
  });

  it("deals keep the board's order (the server's `order`), not newest first", () => {
    const r = rankNext([
      deal("second", { order: 1, at: "2026-10-07T00:00:00Z" }),
      deal("first", { order: 0, at: "2026-09-01T00:00:00Z" }),
      c("payout", "payout_setup", { at: null }),
    ]);
    expect(keys(r.shown)).toEqual(["first", "second", "payout"]);
  });

  it("'See all N' carries the Opportunities count (the server's `waiting`): the same number on both screens", () => {
    const items = Array.from({ length: 6 }, (_, i) => deal(`d${i}`, { order: i }));
    const r = rankNext(items, 12);
    expect(r.shown).toHaveLength(5);
    expect(r.urgent).toBe(12);
    expect(r.seeAll).toBe(true);
    // everything waiting is already on Home: no link
    expect(rankNext(items.slice(0, 2), 2)).toMatchObject({ urgent: 2, seeAll: false });
    // a new athlete
    expect(rankNext([], 0)).toEqual({ shown: [], urgent: 0, seeAll: false });
  });
});
