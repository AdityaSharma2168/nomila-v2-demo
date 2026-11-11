/**
 * money.ts — the commission-engine money math (pure, unit-tested).
 *
 * Model (docs/plans/payments-commission-engine.md §4): commission is a FLAT
 * percent charged ON TOP of the deal value and paid by the brand, and the brand
 * also covers Stripe's processing fee — so Nomila nets the full commission.
 *
 * With Separate Charges & Transfers: charge the brand `brandTotal`, Stripe's fee
 * comes out of it leaving ~`targetNet` on the platform balance, transfer
 * `dealValue` to the athlete, keep `commission`. Everything is INTEGER CENTS.
 */

import { PAYMENTS } from "./config";

/** Stripe's published US pricing — NOT product knobs; used to gross up the brand's total. */
export const STRIPE_FEES = {
  cardPercent:    0.029,  // 2.9%
  cardFixedCents: 30,     // + $0.30
  achPercent:     0.008,  // 0.8%
  achCapCents:    500,    // capped at $5, no fixed component
} as const;

export type Rail = "card" | "bank";

export interface DealChargeQuote {
  rail:               Rail;
  dealValueCents:     number; // what the athlete ultimately receives
  commissionCents:    number; // Nomila's flat cut
  targetNetCents:     number; // dealValue + commission — must remain on the platform balance after the fee
  processingFeeCents: number; // estimated Stripe fee the brand covers
  brandTotalCents:    number; // what the brand is charged
}

/**
 * Gross up the brand's charge so that, after Stripe's fee, exactly
 * `targetNet` (= deal value + commission) lands on the platform balance.
 * The gross-up is fixed-point, so the realized fee can differ by ±1¢ from the
 * estimate — immaterial to the commission, and reconciled from the real balance
 * transaction at settle time.
 */
export function quoteDealCharge(dealValueCents: number, rail: Rail): DealChargeQuote {
  if (!Number.isInteger(dealValueCents) || dealValueCents <= 0) {
    throw new Error(`dealValueCents must be a positive integer, got ${dealValueCents}`);
  }
  const commissionCents = Math.round((dealValueCents * PAYMENTS.commissionPercent) / 100);
  const targetNetCents  = dealValueCents + commissionCents;

  let brandTotalCents: number;
  let processingFeeCents: number;

  if (rail === "card") {
    brandTotalCents    = Math.round((targetNetCents + STRIPE_FEES.cardFixedCents) / (1 - STRIPE_FEES.cardPercent));
    processingFeeCents = brandTotalCents - targetNetCents;
  } else {
    // ACH: 0.8% capped at $5, no fixed component.
    const uncapped    = Math.round(targetNetCents / (1 - STRIPE_FEES.achPercent));
    const uncappedFee = uncapped - targetNetCents;
    if (uncappedFee <= STRIPE_FEES.achCapCents) {
      brandTotalCents    = uncapped;
      processingFeeCents = uncappedFee;
    } else {
      processingFeeCents = STRIPE_FEES.achCapCents;
      brandTotalCents    = targetNetCents + STRIPE_FEES.achCapCents;
    }
  }

  return { rail, dealValueCents, commissionCents, targetNetCents, processingFeeCents, brandTotalCents };
}

/** The amount transferred to the athlete's Connect account on release (SCT): exactly the deal value. */
export function transferAmountCents(quote: DealChargeQuote): number {
  return quote.dealValueCents;
}

/** deals.amount is legacy NUMERIC DOLLARS — convert to integer cents at the boundary. */
export function dealAmountToCents(amount: string | number | null | undefined): number | null {
  if (amount == null) return null;
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** True when a deal clears the floor and the ceiling — the only sizes we let through checkout. */
export function isChargeableDealSize(dealValueCents: number): boolean {
  return Number.isInteger(dealValueCents)
    && dealValueCents >= PAYMENTS.minDealCents
    && dealValueCents <= PAYMENTS.maxDealCents;
}
