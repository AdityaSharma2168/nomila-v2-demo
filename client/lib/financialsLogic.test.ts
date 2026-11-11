/**
 * financialsLogic.test — the money strip, Financials' words and the conditional Opportunities sections (app layout B).
 *
 *   strip       null until money exists; coming · paid this month; a hold alone still says something true
 *   sections    Deals always; Bookings only with a published offer; Shop only with a live pick (a draft is not one)
 *   words       where a payout stands; the payout account; a booking's when and its state; the shop line
 */
import type { FinancialSummary } from "../../shared/meSummaries";
import { accountLine, bookingState, bookingWhen, opportunitySections, paidLine, shopLine, stageLine, stripLine } from "./financialsLogic";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const base: FinancialSummary = {
  version: "financials/0.1", hasMoney: false, currency: "usd", comingCents: 0, paidMonthCents: 0, paidYearCents: 0,
  payouts: { upcoming: [], paid: [] }, holds: [], refunds: { countYear: 0, cents: 0, items: [] },
  account: { state: "none", payoutsEnabled: false, detailsSubmitted: false, requirementsDue: 0 },
};

describe("the strip", () => {
  it("absent until money exists (a new athlete, or an older server)", () => {
    expect(stripLine(base, NOW)).toBeNull();
    expect(stripLine(null, NOW)).toBeNull();
  });
  it("coming · paid this month", () => {
    expect(stripLine({ ...base, hasMoney: true, comingCents: 245_000, paidMonthCents: 120_000 }, NOW)).toBe("$2,450 coming to you · $1,200 paid in Oct");
    expect(stripLine({ ...base, hasMoney: true, comingCents: 245_000 }, NOW)).toBe("$2,450 coming to you");
  });
  it("only a hold: what is held for her", () => {
    const hold = { id: "h", source: "deal" as const, label: "B", dealId: "d", bookingId: null, amountCents: 5_000, currency: "usd", at: null };
    expect(stripLine({ ...base, hasMoney: true, holds: [hold] }, NOW)).toBe("$50 held for you");
  });
  it("the block's line", () => {
    expect(paidLine({ ...base, paidMonthCents: 120_000, paidYearCents: 490_000 }, NOW)).toBe("$1,200 paid in Oct · $4,900 this year");
    expect(paidLine(base, NOW)).toBeNull();
  });
});

describe("sections", () => {
  it("Deals always; Bookings with a published offer; Shop with a live pick", () => {
    expect(opportunitySections(null, null)).toEqual({ bookings: false, shop: false, any: false });
    expect(opportunitySections({ published: false }, [{ status: "draft", clicks7d: 9 }])).toEqual({ bookings: false, shop: false, any: false });
    expect(opportunitySections({ published: true }, [])).toEqual({ bookings: true, shop: false, any: true });
    expect(opportunitySections({ published: false }, [{ status: "live", clicks7d: 0 }])).toEqual({ bookings: false, shop: true, any: true });
  });
  it("the shop line counts live picks and their clicks only", () => {
    expect(shopLine([{ status: "live", clicks7d: 200 }, { status: "live", clicks7d: 12 }, { status: "hidden", clicks7d: 50 }])).toEqual({ live: "2 picks live", clicks: "212 clicks this week" });
    expect(shopLine([{ status: "live", clicks7d: 1 }])).toEqual({ live: "1 pick live", clicks: "1 click this week" });
  });
});

describe("words", () => {
  it("where an upcoming payout stands", () => {
    expect(stageLine("awaiting_delivery")).toBe("Upcoming · after you mark it delivered");
    expect(stageLine("awaiting_confirmation")).toBe("Upcoming · after delivery is confirmed");
    expect(stageLine("in_review")).toBe("On hold · in review");
    expect(stageLine("after_booking")).toBe("Upcoming · after the booking");
  });
  it("the payout account", () => {
    expect(accountLine(base.account)).toMatchObject({ title: "Not set up", action: "Set up payouts" });
    expect(accountLine({ ...base.account, state: "pending", requirementsDue: 1 })).toMatchObject({ title: "Finishing setup", line: "Stripe needs 1 more detail before it can pay you.", action: "Continue setup" });
    expect(accountLine({ ...base.account, state: "active" })).toMatchObject({ title: "Payouts on", action: null });
  });
  it("a booking's when and state", () => {
    expect(bookingWhen({ startsAt: "2026-10-18T16:00:00.000Z", priceCents: 12_000, currency: "usd" })).toBe("Sun 18 Oct · $120");
    expect(bookingWhen({ startsAt: null, priceCents: 12_000, currency: "usd" })).toBe("$120");
    expect(bookingState({ status: "requested" })).toEqual({ text: "Waiting for you", waiting: true });
    expect(bookingState({ status: "confirmed" })).toEqual({ text: "Accepted", waiting: false });
  });
});
