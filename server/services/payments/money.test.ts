/**
 * money.test.ts — proves the commission-engine math against the numbers in
 * docs/plans/payments-commission-engine.md §4, and the SCT invariant that
 * Nomila nets the full commission because the brand covers Stripe's fee.
 */

import { quoteDealCharge, transferAmountCents, dealAmountToCents, isChargeableDealSize, STRIPE_FEES } from "./money";
import { PAYMENTS } from "./config";

describe("commission-engine money math", () => {
  test("commission is a flat 10% on top by default", () => {
    expect(PAYMENTS.commissionPercent).toBe(10);
    expect(quoteDealCharge(10_000, "card").commissionCents).toBe(1_000);
  });

  // The published table: deal → what the brand pays on card (±1¢, gross-up is fixed-point).
  test.each([
    [5_000,  5_695],   // $50 floor → ~$56.95
    [10_000, 11_359],  // $100      → ~$113.59
    [50_000, 56_673],  // $500      → ~$566.73
  ])("card gross-up for a $%d-cent deal ≈ %d cents", (deal, expectedBrandTotal) => {
    const q = quoteDealCharge(deal, "card");
    expect(Math.abs(q.brandTotalCents - expectedBrandTotal)).toBeLessThanOrEqual(1);
    expect(q.commissionCents).toBe(Math.round(deal * 0.1));
  });

  test("SCT invariant: brandTotal − fee === deal + commission, and we keep exactly the commission", () => {
    for (const deal of [5_000, 10_000, 50_000, 500_000]) {
      const q = quoteDealCharge(deal, "card");
      // The fee is grossed up so the platform balance lands on the target net.
      expect(q.brandTotalCents - q.processingFeeCents).toBe(q.targetNetCents);
      // Transfer the deal value to the athlete; what remains is precisely the commission.
      expect(q.targetNetCents - transferAmountCents(q)).toBe(q.commissionCents);
    }
  });

  test("bank rail hits the $5 ACH cap on large deals and is cheaper than card", () => {
    const big = quoteDealCharge(500_000, "bank");            // $5,000
    expect(big.processingFeeCents).toBe(STRIPE_FEES.achCapCents);
    expect(big.brandTotalCents).toBeLessThan(quoteDealCharge(500_000, "card").brandTotalCents);

    const small = quoteDealCharge(10_000, "bank");           // $100 → 0.8% ≈ $0.88 < cap
    expect(small.processingFeeCents).toBeLessThan(STRIPE_FEES.achCapCents);
  });

  test("dealAmountToCents converts numeric dollars at the boundary", () => {
    expect(dealAmountToCents("500")).toBe(50_000);
    expect(dealAmountToCents(499.99)).toBe(49_999);
    expect(dealAmountToCents(null)).toBeNull();
    expect(dealAmountToCents("not-a-number")).toBeNull();
  });

  test("deal-size gate enforces the floor and ceiling", () => {
    expect(isChargeableDealSize(4_999)).toBe(false);          // below $50 floor
    expect(isChargeableDealSize(5_000)).toBe(true);           // at floor
    expect(isChargeableDealSize(PAYMENTS.maxDealCents + 1)).toBe(false);
  });

  test("rejects non-positive or non-integer deal values", () => {
    expect(() => quoteDealCharge(0, "card")).toThrow();
    expect(() => quoteDealCharge(-100, "card")).toThrow();
    expect(() => quoteDealCharge(99.5, "card")).toThrow();
  });
});
