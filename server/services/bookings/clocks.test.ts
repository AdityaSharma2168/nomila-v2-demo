/**
 * clocks.test.ts — the booking clocks and every refund path, in integer cents. Pure: no DB, no Stripe.
 *
 *   C1 the unverified hold (15 min), respond_by = earlier of request + 72h and start − 2h, the capture-failure pay-by
 *   C2 the card hold is always captured or released inside a card authorization (72h + 15 min < 6 days)
 *   C3 times: too soon, too far, too many, duplicates, bad input; sorted and normalised
 *   C4 no-show grace and the release clock
 *   C5 every refund path, in cents: buyer in window (her price back, fee kept), buyer late (nothing), buyer exactly at
 *      the deadline (in window), her cancel (everything back), her no-show / goodwill (everything back), buyer no-show
 *      (nothing); her first athlete-caused refund is waived, every later one is owed at Stripe's ACTUAL fee
 */
import {
  unverifiedHoldExpiresAt, respondByFor, payByFor, noShowAvailableAt, releaseDueAt, startProblem, parseProposedTimes,
  firstPossibleStart, cancelQuote, daysSince,
} from "./clocks";
import { bookingRefund, athleteRefundCost, quoteBookingCharge } from "./money";
import { BOOKINGS, holdFitsAuthorization } from "./config";

const H = 3_600_000;
const now = new Date("2026-10-08T12:00:00.000Z");
const at = (h: number) => new Date(now.getTime() + h * H);

describe("C1 request clocks", () => {
  it("the unverified hold lapses after 15 minutes", () => {
    expect(BOOKINGS.unverifiedHoldMinutes).toBe(15);
    expect(unverifiedHoldExpiresAt(now).toISOString()).toBe("2026-10-08T12:15:00.000Z");
  });
  it("respond_by is 72h after the request, unless the session starts sooner (then 2h before it)", () => {
    expect(BOOKINGS.respondHours).toBe(72);
    expect(respondByFor(now, at(24 * 10)).toISOString()).toBe(at(72).toISOString());
    expect(respondByFor(now, at(30)).toISOString()).toBe(at(28).toISOString());
    expect(respondByFor(now, null).toISOString()).toBe(at(72).toISOString());
  });
  it("the capture-failure pay link lasts 24h and never past the start", () => {
    expect(payByFor(now, at(100)).toISOString()).toBe(at(24).toISOString());
    expect(payByFor(now, at(5)).toISOString()).toBe(at(5).toISOString());
  });
});

describe("C2 the hold fits a card authorization", () => {
  it("72h + the 15-minute unverified hold ends with more than a day to spare in ~7 days", () => {
    expect(holdFitsAuthorization()).toBe(true);
    expect(holdFitsAuthorization({ respondHours: 7 * 24, unverifiedHoldMinutes: 15, cardAuthorizationDays: 7 })).toBe(false);
  });
});

describe("C3 times", () => {
  it("a start must leave her time to answer, and be no more than 60 days out", () => {
    expect(startProblem(at(2.5), now)).toBe("too_soon");
    expect(startProblem(at(3.5), now)).toBe("none");
    expect(startProblem(at(24 * 61), now)).toBe("too_far");
    expect(startProblem(new Date("nope"), now)).toBe("bad_time");
  });
  it("1–3 times, distinct, valid; normalised to ISO and sorted", () => {
    const ok = parseProposedTimes([{ start: at(50).toISOString(), tz: "America/Chicago" }, at(26).toISOString()], now);
    expect(ok).toEqual({ ok: true, times: [{ start: at(26).toISOString(), tz: null }, { start: at(50).toISOString(), tz: "America/Chicago" }] });
    expect(parseProposedTimes([], now)).toEqual({ ok: false, problem: "bad_time" });
    expect(parseProposedTimes("x", now)).toEqual({ ok: false, problem: "bad_time" });
    expect(parseProposedTimes([at(30), at(31), at(32), at(33)].map((d) => d.toISOString()), now)).toEqual({ ok: false, problem: "too_many" });
    expect(parseProposedTimes([at(30).toISOString(), at(30).toISOString()], now)).toEqual({ ok: false, problem: "duplicate" });
    expect(parseProposedTimes([at(1).toISOString()], now)).toEqual({ ok: false, problem: "too_soon" });
    expect(parseProposedTimes([{ start: 5 }], now)).toEqual({ ok: false, problem: "bad_time" });
  });
  it("the first possible start is the slot / picked time, else the earliest suggestion", () => {
    expect(firstPossibleStart({ starts_at: at(10), proposed_times: null })).toEqual(at(10));
    expect(firstPossibleStart({ starts_at: null, proposed_times: [{ start: at(40).toISOString() }, { start: at(20).toISOString() }] })).toEqual(at(20));
    expect(firstPossibleStart({ starts_at: null, proposed_times: null })).toBeNull();
  });
});

describe("C4 session clocks", () => {
  it("'Buyer didn't show' opens 15 minutes after the start; release is due 48h after the end", () => {
    expect(noShowAvailableAt(now).toISOString()).toBe("2026-10-08T12:15:00.000Z");
    expect(releaseDueAt(now).toISOString()).toBe(at(48).toISOString());
    expect(daysSince(at(-24 * 80), now)).toBe(80);
  });
});

describe("C5 every refund path, in cents", () => {
  // $150 → fee $27.96 → total $177.96 (money.ts worked example)
  const q = quoteBookingCharge(15_000, { serviceFeePercent: 15, processingPercent: 2.9, processingFixedCents: 30 });
  const snap = (startsInHours: number, window = 24) => ({
    price_cents: q.priceCents, service_fee_cents: q.serviceFeeCents, buyer_total_cents: q.buyerTotalCents,
    starts_at: at(startsInHours), free_cancel_hours: window,
  });

  it("buyer cancels inside her window: her price back ($150.00), the $27.96 fee kept", () => {
    const r = cancelQuote(snap(48), "buyer", now);
    expect(r).toMatchObject({ cause: "buyer_cancel_in_window", refundCents: 15_000, keptCents: 2_796, outcome: "price_only", athleteCaused: false });
    expect(r.freeUntil).toBe(at(24).toISOString());
  });
  it("buyer cancels exactly at the deadline: still in the window", () => {
    expect(cancelQuote(snap(24), "buyer", now)).toMatchObject({ refundCents: 15_000, outcome: "price_only" });
  });
  it("buyer cancels later than her window: nothing back, she is paid", () => {
    expect(cancelQuote(snap(23), "buyer", now)).toMatchObject({ cause: "buyer_cancel_late", refundCents: 0, keptCents: 17_796, outcome: "none" });
  });
  it("her 7-day window moves the deadline", () => {
    expect(cancelQuote(snap(24 * 6, 168), "buyer", now)).toMatchObject({ refundCents: 0, outcome: "none" });
    expect(cancelQuote(snap(24 * 8, 168), "buyer", now)).toMatchObject({ refundCents: 15_000, outcome: "price_only" });
  });
  it("she cancels, at any time: the buyer gets everything back ($177.96)", () => {
    for (const h of [2, 48, 24 * 30]) {
      expect(cancelQuote(snap(h), "athlete", now)).toMatchObject({ cause: "athlete_cancel", refundCents: 17_796, keptCents: 0, outcome: "full", athleteCaused: true, freeUntil: null });
    }
  });
  it("her no-show and a goodwill refund: everything back; a buyer no-show: nothing", () => {
    const b = snap(48);
    expect(bookingRefund(b, "athlete_no_show")).toEqual({ refundCents: 17_796, outcome: "full", athleteCaused: true });
    expect(bookingRefund(b, "athlete_goodwill")).toEqual({ refundCents: 17_796, outcome: "full", athleteCaused: true });
    expect(bookingRefund(b, "buyer_no_show")).toEqual({ refundCents: 0, outcome: "none", athleteCaused: false });
  });
  it("she covers Stripe's ACTUAL fee: her first is waived, later ones owed (e.g. $5.46)", () => {
    expect(athleteRefundCost(546, false)).toEqual({ amountCents: 546, status: "waived" });
    expect(athleteRefundCost(546, true)).toEqual({ amountCents: 546, status: "owed" });
    expect(() => athleteRefundCost(-1, true)).toThrow();
  });
  it("other prices from the fee table round-trip: refund + kept = what the buyer paid", () => {
    for (const price of [2_500, 5_000, 10_000, 25_000, 100_000]) {
      const qq = quoteBookingCharge(price, { serviceFeePercent: 15, processingPercent: 2.9, processingFixedCents: 30 });
      const b = { price_cents: price, service_fee_cents: qq.serviceFeeCents, buyer_total_cents: qq.buyerTotalCents, starts_at: at(48), free_cancel_hours: 24 };
      for (const by of ["buyer", "athlete"] as const) {
        const r = cancelQuote(b, by, now);
        expect(r.refundCents + r.keptCents).toBe(qq.buyerTotalCents);
        expect(Number.isInteger(r.refundCents)).toBe(true);
      }
    }
  });
});
