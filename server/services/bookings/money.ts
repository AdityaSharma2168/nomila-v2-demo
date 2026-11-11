/**
 * bookings/money.ts — the booking quote (pure, unit-tested). Bookings v2, decision 1 (v2.1, owner decision 7 Oct 2026).
 *
 * Model: she sets her price and receives 100% of it. The BUYER pays ONE "Nomila service fee" on top: Nomila's keep
 * (BOOKING_SERVICE_FEE_PERCENT of her price, 15%) PLUS the card-processing pass-through, grossed up so that after
 * Stripe's fee Nomila still keeps the full 15%. The buyer sees one all-in total before checkout
 * ("$177.96 — includes Ava's $150 + $27.96 Nomila service fee"), identical for every payment method: one service-fee
 * line, never labelled a card fee or surcharge (no separate processing line), which is what California's all-in
 * pricing rule (SB 478, Civil Code §1770(a)(29)) asks for.
 *
 * THE FORMULA (integer cents). P = her price, k = keep percent, r = processing percent, f = processing fixed cents
 * (BOOKING_PROCESSING_PERCENT / BOOKING_PROCESSING_FIXED_CENTS, default 2.9 / 30 — config, never hard-coded here).
 *   keep      K = round(P × k / 100)                          (half-up)
 *   Stripe(T)   = round(T × r / 100) + f                      (Stripe's fee on the charge, rounded to the cent)
 *   total     T = the SMALLEST whole-cent amount with  T − P − Stripe(T) ≥ K
 *               = ceil((P + K + f) / (1 − r/100)), then stepped down by a cent while Nomila still nets ≥ K
 *                 (Stripe's rounding can make the ceil one cent high)
 *   fee       F = T − P                                       (the one "Nomila service fee" line)
 * Worked example, 15% / 2.9% + 30¢: P = 15000 → K = 2250, (15000 + 2250 + 30) / 0.971 = 17796.09 → ceil 17797 →
 * step down to 17796 (Stripe round(516.08) + 30 = 546, Nomila nets 17796 − 15000 − 546 = 2250 exactly)
 * → fee $27.96, total $177.96.
 * The processing rate is an ESTIMATE of Stripe's fee (cards differ); the actual fee is read from the balance
 * transaction wherever money depends on it (refund costs). Nothing here varies by payment method.
 *
 * With Separate Charges & Transfers: charge the buyer `buyerTotalCents` to the platform balance, transfer exactly
 * `athleteReceivesCents` (= her price) to her Connect account on release, Nomila keeps the service fee minus Stripe's
 * fee. Everything is INTEGER CENTS. The deal math (payments/money.ts quoteDealCharge) is untouched.
 */
import { BOOKINGS } from "./config";

export interface BookingQuote {
  priceCents:                 number; // her price
  serviceFeePercent:          number; // Nomila's keep, % of her price
  nomilaKeepCents:            number; // K: what Nomila keeps after Stripe's (estimated) fee
  processingPassThroughCents: number; // F − K: the part of the fee that covers card processing (internal; never a buyer line)
  serviceFeeCents:            number; // F: the ONE buyer-facing "Nomila service fee"
  buyerTotalCents:            number; // all-in: what the buyer pays, whatever the payment method
  athleteReceivesCents:       number; // = priceCents, always
  estProcessingFeeCents:      number; // ESTIMATED Stripe fee on the total
  estNomilaNetCents:          number; // service fee − estimated processing (always ≥ nomilaKeepCents)
  currency:                   string;
}

export type QuoteBookingOptions = Partial<Pick<typeof BOOKINGS,
  "serviceFeePercent" | "processingPercent" | "processingFixedCents" | "minPriceCents" | "maxPriceCents" | "currency">>;

/** True when her price is a whole number of cents inside the floor and ceiling. */
export function isBookablePrice(priceCents: number, opts: QuoteBookingOptions = {}): boolean {
  const min = opts.minPriceCents ?? BOOKINGS.minPriceCents;
  const max = opts.maxPriceCents ?? BOOKINGS.maxPriceCents;
  return Number.isInteger(priceCents) && priceCents >= min && priceCents <= max;
}

/** Stripe's estimated fee on a charge of `totalCents` at the configured rate, rounded to the cent. */
export function estimateProcessingCents(totalCents: number, processingPercent: number, processingFixedCents: number): number {
  return Math.round((totalCents * processingPercent) / 100) + processingFixedCents;
}

/** Quote a booking at her price. Throws outside the floor/ceiling or on an out-of-range rate. */
export function quoteBookingCharge(priceCents: number, opts: QuoteBookingOptions = {}): BookingQuote {
  if (!isBookablePrice(priceCents, opts)) {
    throw new Error(`booking price must be whole cents between the floor and ceiling, got ${priceCents}`);
  }
  const serviceFeePercent    = opts.serviceFeePercent ?? BOOKINGS.serviceFeePercent;
  const processingPercent    = opts.processingPercent ?? BOOKINGS.processingPercent;
  const processingFixedCents = opts.processingFixedCents ?? BOOKINGS.processingFixedCents;
  if (!Number.isFinite(serviceFeePercent) || serviceFeePercent < 0 || serviceFeePercent > 50) {
    throw new Error(`service fee percent out of range: ${serviceFeePercent}`);
  }
  if (!Number.isFinite(processingPercent) || processingPercent < 0 || processingPercent >= 20) {
    throw new Error(`processing percent out of range: ${processingPercent}`);
  }
  if (!Number.isInteger(processingFixedCents) || processingFixedCents < 0) {
    throw new Error(`processing fixed cents must be a whole number of cents, got ${processingFixedCents}`);
  }

  const nomilaKeepCents = Math.round((priceCents * serviceFeePercent) / 100);
  const net = (t: number) => t - priceCents - estimateProcessingCents(t, processingPercent, processingFixedCents);
  let total = Math.ceil(((priceCents + nomilaKeepCents + processingFixedCents) * 100) / (100 - processingPercent));
  while (net(total) < nomilaKeepCents) total += 1;          // float safety: never under-collect
  while (net(total - 1) >= nomilaKeepCents) total -= 1;     // the smallest total that still nets the full keep

  const serviceFeeCents       = total - priceCents;
  const estProcessingFeeCents = estimateProcessingCents(total, processingPercent, processingFixedCents);
  return {
    priceCents, serviceFeePercent, nomilaKeepCents,
    processingPassThroughCents: serviceFeeCents - nomilaKeepCents,
    serviceFeeCents, buyerTotalCents: total,
    athleteReceivesCents: priceCents, estProcessingFeeCents,
    estNomilaNetCents: serviceFeeCents - estProcessingFeeCents,
    currency: opts.currency ?? BOOKINGS.currency,
  };
}

// ─── Group sessions (0153): her price is PER PERSON ──────────────────────────────────────────────────────────────
// A booking for N people: she receives unit × N (100% of it), and the ONE Nomila service fee is computed on that whole
// amount exactly as for a 1:1 (quoteBookingCharge on the booking's total). 1:1 is just N = 1 (the same quote).

/** The most people one booking or one open session can hold (offers_max_people_check, bookings_party_size_check). */
export const MAX_GROUP_PEOPLE = 20;

export interface PartyQuote extends BookingQuote {
  unitPriceCents: number; // her per-person price
  partySize:      number; // people this booking covers
}

/** True when `n` is a whole number of people one booking can cover. */
export function isPartySize(n: unknown, max = MAX_GROUP_PEOPLE): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= Math.min(max, MAX_GROUP_PEOPLE);
}

/**
 * Quote a booking of `partySize` people at her per-person price: the per-person price must be bookable (floor/ceiling),
 * and the total is quoted like any booking (the ceiling scales with the party, the floor is per person).
 */
export function quotePartyCharge(unitPriceCents: number, partySize: number, opts: QuoteBookingOptions = {}): PartyQuote {
  if (!isBookablePrice(unitPriceCents, opts)) throw new Error(`booking price must be whole cents between the floor and ceiling, got ${unitPriceCents}`);
  if (!isPartySize(partySize)) throw new Error(`party size must be 1..${MAX_GROUP_PEOPLE}, got ${partySize}`);
  const max = opts.maxPriceCents ?? BOOKINGS.maxPriceCents;
  const q = quoteBookingCharge(unitPriceCents * partySize, { ...opts, maxPriceCents: max * partySize });
  return { ...q, unitPriceCents, partySize };
}

/** "$1,234.50" — US dollars only (the only currency today). */
export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return "$" + dollars.toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
}

/**
 * The one all-in line shown before checkout: "$177.96 — includes Ava's $150 + $27.96 Nomila service fee".
 * ONE fee line, the same for every payment method; never "card fee", "processing" or "surcharge".
 * `firstName` is her display first name (never hard-coded).
 */
export function allInLine(quote: BookingQuote, firstName: string): string {
  const total = (quote.buyerTotalCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return `${total} — includes ${firstName}'s ${formatUsd(quote.priceCents)} + ${formatUsd(quote.serviceFeeCents)} Nomila service fee`;
}

// ─── Refunds (owner decision, 7 Oct 2026; window per offer in v2.1) ──────────────────────────────────────────────
// Stripe does not return its processing fee on a refund. Who carries that cost depends on who caused the refund:
//   • the BUYER cancels at least her free_cancel_hours (per offer, default 24h, snapshotted onto the booking) before
//     the start → refund HER PRICE; the Nomila service fee (incl. its processing pass-through) is non-refundable
//     (disclosed before payment).
//   • the buyer cancels later than that, or doesn't show (after the no-show grace she taps "Buyer didn't show")
//     → no refund; she is paid on the normal clock.
//   • SHE cancels, doesn't show, or refunds as goodwill → FULL refund incl. the service fee; she covers Stripe's
//     ACTUAL processing fee (read from the charge's balance transaction), deducted from her next payout. Her FIRST
//     athlete-caused refund is waived (one 'waived' athlete_payout_adjustments row, enforced by a unique index).
//   • a chargeback where she was at fault → transfer reversal within 120 days (refunds/disputes PR), not here.

/** The last moment a buyer can cancel for her price back: starts_at − the booking's free_cancel_hours. */
export function freeCancelDeadline(startsAt: Date, freeCancelHours: number): Date {
  if (!Number.isInteger(freeCancelHours) || freeCancelHours <= 0) throw new Error(`bad free_cancel_hours ${freeCancelHours}`);
  return new Date(startsAt.getTime() - freeCancelHours * 3_600_000);
}

/** Which refund cause a buyer cancellation at `canceledAt` is, under the booking's snapshotted window. */
export function buyerCancelCause(startsAt: Date, canceledAt: Date, freeCancelHours: number): "buyer_cancel_in_window" | "buyer_cancel_late" {
  return canceledAt.getTime() <= freeCancelDeadline(startsAt, freeCancelHours).getTime() ? "buyer_cancel_in_window" : "buyer_cancel_late";
}

export type RefundCause =
  | "buyer_cancel_in_window" | "buyer_cancel_late" | "buyer_no_show"
  | "athlete_cancel" | "athlete_no_show" | "athlete_goodwill";

export interface BookingRefund {
  refundCents:   number;
  outcome:       "full" | "price_only" | "none";
  /** True when she covers Stripe's processing fee for this refund (unless it is her first, which is waived). */
  athleteCaused: boolean;
}

export function bookingRefund(
  b: { price_cents: number; service_fee_cents: number; buyer_total_cents: number },
  cause: RefundCause,
): BookingRefund {
  switch (cause) {
    case "buyer_cancel_in_window": return { refundCents: b.price_cents, outcome: "price_only", athleteCaused: false };
    case "buyer_cancel_late":
    case "buyer_no_show":          return { refundCents: 0, outcome: "none", athleteCaused: false };
    case "athlete_cancel":
    case "athlete_no_show":
    case "athlete_goodwill":       return { refundCents: b.buyer_total_cents, outcome: "full", athleteCaused: true };
  }
}

/**
 * What she owes for an athlete-caused refund: Stripe's ACTUAL fee on the charge (from its balance transaction; never a
 * hard-coded rate), waived if she has never had a waiver before.
 */
export function athleteRefundCost(actualStripeFeeCents: number, hasUsedFreeCancel: boolean): { amountCents: number; status: "waived" | "owed" } {
  if (!Number.isInteger(actualStripeFeeCents) || actualStripeFeeCents < 0) throw new Error(`bad Stripe fee ${actualStripeFeeCents}`);
  return { amountCents: actualStripeFeeCents, status: hasUsedFreeCancel ? "owed" : "waived" };
}
