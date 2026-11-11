/**
 * money.test.ts — the Bookings v2 quote (v2.1): she receives 100% of her price; the buyer pays ONE "Nomila service fee"
 * = 15% of her price PLUS the card-processing pass-through, grossed up so Nomila still keeps the full 15% after Stripe's
 * fee; the all-in total is one number for every payment method; the platform hold stays inside Stripe's limit; the
 * cancellation window is hers, per offer. Pure: no Stripe call.
 */
import {
  quoteBookingCharge, isBookablePrice, allInLine, formatUsd, bookingRefund, athleteRefundCost,
  estimateProcessingCents, freeCancelDeadline, buyerCancelCause,
} from "./money";
import { BOOKINGS, STRIPE_HOLD_LIMIT_DAYS, bookingHoldDays, bookingsEnabledFor, isAllowedFreeCancelHours } from "./config";

describe("quoteBookingCharge (v2.1: 15% keep + processing pass-through, one fee line)", () => {
  test("the owner's worked example: $150 → service fee $27.96, total $177.96, she receives $150, Nomila keeps $22.50", () => {
    const q = quoteBookingCharge(15_000, { serviceFeePercent: 15, processingPercent: 2.9, processingFixedCents: 30 });
    expect(q.nomilaKeepCents).toBe(2_250);                 // 15% of her price
    expect(q.buyerTotalCents).toBe(17_796);                // (15000 + 2250 + 30) / 0.971 = 17796.09 → smallest total that nets 2250
    expect(q.serviceFeeCents).toBe(2_796);                 // the one "Nomila service fee" line
    expect(q.athleteReceivesCents).toBe(15_000);
    expect(q.estProcessingFeeCents).toBe(546);             // round(17796 × 2.9%) = 516, + 30
    expect(q.processingPassThroughCents).toBe(546);
    expect(q.estNomilaNetCents).toBe(2_250);               // exactly the keep, after Stripe's fee
  });

  test("defaults come from config: 15% keep, 2.9% + 30¢ processing", () => {
    expect(BOOKINGS.serviceFeePercent).toBe(15);
    expect(BOOKINGS.processingPercent).toBe(2.9);
    expect(BOOKINGS.processingFixedCents).toBe(30);
    expect(quoteBookingCharge(15_000).buyerTotalCents).toBe(17_796);
  });

  test.each([
    [2_500,   492,    2_992],
    [5_000,   953,    5_953],
    [10_000,  1_874,  11_874],
    [25_000,  4_640,  29_640],
    [100_000, 18_465, 118_465],
  ])("worked example %d¢ → fee %d¢, total %d¢", (price, fee, total) => {
    const q = quoteBookingCharge(price);
    expect(q.serviceFeeCents).toBe(fee);
    expect(q.buyerTotalCents).toBe(total);
  });

  test.each([2_500, 2_501, 4_999, 15_000, 33_333, 77_777, 500_000])("invariants at %d¢", (price) => {
    const q = quoteBookingCharge(price);
    expect(q.athleteReceivesCents).toBe(price);                                   // 100% of her price
    expect(q.buyerTotalCents).toBe(q.priceCents + q.serviceFeeCents);             // one all-in total
    expect(q.serviceFeeCents).toBe(q.nomilaKeepCents + q.processingPassThroughCents);
    expect(q.nomilaKeepCents).toBe(Math.round(price * 0.15));
    expect(q.estNomilaNetCents).toBe(q.serviceFeeCents - q.estProcessingFeeCents);
    expect(q.estNomilaNetCents).toBeGreaterThanOrEqual(q.nomilaKeepCents);       // Nomila keeps the full 15% after Stripe
    // … and the total is the SMALLEST that does: one cent less would leave Nomila short.
    const lower = q.buyerTotalCents - 1;
    expect(lower - price - estimateProcessingCents(lower, 2.9, 30)).toBeLessThan(q.nomilaKeepCents);
    for (const v of Object.values(q)) if (typeof v === "number" && v !== q.serviceFeePercent) expect(Number.isInteger(v)).toBe(true);
  });

  test("the processing rate is config, not hard-coded: a different rate changes the gross-up, not the keep", () => {
    const q = quoteBookingCharge(15_000, { processingPercent: 3.5, processingFixedCents: 30 });
    expect(q.nomilaKeepCents).toBe(2_250);
    expect(q.estNomilaNetCents).toBeGreaterThanOrEqual(2_250);
    expect(q.buyerTotalCents).toBeGreaterThan(17_796);
    const none = quoteBookingCharge(15_000, { processingPercent: 0, processingFixedCents: 0 });
    expect(none.serviceFeeCents).toBe(2_250);                                     // no processing → fee is the keep
  });

  test("the total does not depend on the payment method (a service fee, not a card surcharge)", () => {
    // The quote takes no rail/method argument — there is nothing to vary by method.
    expect(quoteBookingCharge.length).toBe(1);
    expect(quoteBookingCharge(15_000)).toEqual(quoteBookingCharge(15_000));
  });

  test("a fractional keep percent rounds to whole cents", () => {
    expect(quoteBookingCharge(9_999, { serviceFeePercent: 12.5 }).nomilaKeepCents).toBe(1_250);
  });

  test("floor, ceiling and rate guards", () => {
    expect(isBookablePrice(2_499)).toBe(false);
    expect(isBookablePrice(2_500)).toBe(true);
    expect(isBookablePrice(500_001)).toBe(false);
    expect(isBookablePrice(10_000.5)).toBe(false);
    expect(() => quoteBookingCharge(100)).toThrow();
    expect(() => quoteBookingCharge(0)).toThrow();
    expect(() => quoteBookingCharge(2_500, { serviceFeePercent: 60 })).toThrow(/out of range/);
    expect(() => quoteBookingCharge(2_500, { processingPercent: 25 })).toThrow(/processing percent/);
    expect(() => quoteBookingCharge(2_500, { processingFixedCents: 0.5 })).toThrow(/whole number/);
  });
});

describe("all-in display", () => {
  test("one line, total first, her price and ONE Nomila service fee — never a card fee or surcharge", () => {
    const line = allInLine(quoteBookingCharge(15_000), "Ava");
    expect(line).toBe("$177.96 — includes Ava's $150 + $27.96 Nomila service fee");
    expect(line).not.toMatch(/card|surcharge|processing/i);
  });
  test("formatUsd", () => {
    expect(formatUsd(15_000)).toBe("$150");
    expect(formatUsd(2_796)).toBe("$27.96");
    expect(formatUsd(123_456)).toBe("$1,234.56");
  });
});

describe("cancellation window (v2.1: hers, per offer, default 24h)", () => {
  test("default 24h; she may choose from the configured set", () => {
    expect(BOOKINGS.freeCancelHoursDefault).toBe(24);
    expect(BOOKINGS.freeCancelHoursOptions).toEqual([24, 48, 168]);
    expect(BOOKINGS.cancellationPolicyVersion).toBe("athlete_window_v1");
    expect(isAllowedFreeCancelHours(24)).toBe(true);
    expect(isAllowedFreeCancelHours(168)).toBe(true);
    expect(isAllowedFreeCancelHours(12)).toBe(false);
    expect(isAllowedFreeCancelHours(24.5)).toBe(false);
  });
  test("the booking's snapshotted window decides in-window vs late", () => {
    const start = new Date("2026-11-10T18:00:00Z");
    expect(freeCancelDeadline(start, 24).toISOString()).toBe("2026-11-09T18:00:00.000Z");
    expect(buyerCancelCause(start, new Date("2026-11-09T18:00:00Z"), 24)).toBe("buyer_cancel_in_window"); // exactly 24h before
    expect(buyerCancelCause(start, new Date("2026-11-09T18:00:01Z"), 24)).toBe("buyer_cancel_late");
    expect(buyerCancelCause(start, new Date("2026-11-09T18:00:01Z"), 48)).toBe("buyer_cancel_late");
    expect(buyerCancelCause(start, new Date("2026-11-08T17:00:00Z"), 48)).toBe("buyer_cancel_in_window");
    expect(() => freeCancelDeadline(start, 0)).toThrow();
  });
});

describe("no-shows, verification, identity, support (v2.1 config; logic in B3/B5)", () => {
  test("no-show grace and pause threshold", () => {
    expect(BOOKINGS.noShowGraceMinutes).toBe(15);
    expect(BOOKINGS.noShowPauseThreshold).toBe(2);
  });
  test("buyer verification: email code + Firebase Phone Auth; ID required in person, optional online", () => {
    expect(BOOKINGS.buyerVerification).toEqual({ email: "email_code", phone: "firebase_phone_auth" });
    expect(BOOKINGS.identityCheck).toEqual({ in_person: "required", online: "optional_per_offer" });
  });
  test("support is email only, with the accepted response targets", () => {
    expect(BOOKINGS.supportChannel).toBe("email");
    expect(BOOKINGS.safetyAckHours).toBe(4);
    expect(BOOKINGS.disputeFirstResponseHours).toBe(24);
  });
});

describe("hold limit and flag", () => {
  test("the longest possible platform hold stays inside Stripe's limit", () => {
    // 60 days ahead + a day-long session + 48h release ≈ 63 days < 90 (the stricter, non-US figure).
    expect(bookingHoldDays()).toBeLessThan(STRIPE_HOLD_LIMIT_DAYS);
    expect(bookingHoldDays({ maxAdvanceDays: 88, releaseHours: 48 })).toBeGreaterThan(STRIPE_HOLD_LIMIT_DAYS);
  });

  test("bookings are off by default and need the pilot allowlist", () => {
    const saved = { e: process.env.BOOKINGS_ENABLED, p: process.env.BOOKINGS_PILOT_ATHLETE_IDS };
    try {
      delete process.env.BOOKINGS_ENABLED; delete process.env.BOOKINGS_PILOT_ATHLETE_IDS;
      expect(bookingsEnabledFor("a1")).toBe(false);
      process.env.BOOKINGS_ENABLED = "true";
      expect(bookingsEnabledFor("a1")).toBe(false);
      process.env.BOOKINGS_PILOT_ATHLETE_IDS = "a0, a1";
      expect(bookingsEnabledFor("a1")).toBe(true);
      expect(bookingsEnabledFor("a2")).toBe(false);
    } finally {
      if (saved.e === undefined) delete process.env.BOOKINGS_ENABLED; else process.env.BOOKINGS_ENABLED = saved.e;
      if (saved.p === undefined) delete process.env.BOOKINGS_PILOT_ATHLETE_IDS; else process.env.BOOKINGS_PILOT_ATHLETE_IDS = saved.p;
    }
  });
});

describe("refunds (owner decision 7 Oct; v2.1 fee)", () => {
  const q = quoteBookingCharge(15_000);
  const b = { price_cents: q.priceCents, service_fee_cents: q.serviceFeeCents, buyer_total_cents: q.buyerTotalCents };
  test("buyer cancels in her window: her price back, the whole service fee is kept", () => {
    expect(bookingRefund(b, "buyer_cancel_in_window")).toEqual({ refundCents: 15_000, outcome: "price_only", athleteCaused: false });
  });
  test("buyer late cancel / no-show: nothing back, she is paid on the normal clock", () => {
    expect(bookingRefund(b, "buyer_cancel_late").refundCents).toBe(0);
    expect(bookingRefund(b, "buyer_no_show").outcome).toBe("none");
  });
  test.each(["athlete_cancel", "athlete_no_show", "athlete_goodwill"] as const)("%s: full refund incl. the service fee, she covers Stripe's fee", (cause) => {
    expect(bookingRefund(b, cause)).toEqual({ refundCents: 17_796, outcome: "full", athleteCaused: true });
  });
  test("her first athlete-caused refund is waived, later ones are owed at the ACTUAL Stripe fee", () => {
    expect(athleteRefundCost(546, false)).toEqual({ amountCents: 546, status: "waived" });
    expect(athleteRefundCost(546, true)).toEqual({ amountCents: 546, status: "owed" });
    expect(() => athleteRefundCost(-1, true)).toThrow();
  });
});
