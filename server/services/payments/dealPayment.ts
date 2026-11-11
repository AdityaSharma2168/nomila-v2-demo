/**
 * dealPayment.ts — typed narrowing for deal-side payment code (Bookings v2, 0098).
 *
 * `payments.deal_id` became nullable when bookings arrived: a 'booking_payment' row carries booking_id and NO deal
 * (payments_subject_check enforces exactly one subject per kind). Every deal-side reader (escrow, settle, deposit,
 * confirm, cron) already filters to kind 'deposit' / 'deal_payment', and for those kinds the database guarantees a
 * deal_id. These helpers turn that guarantee into a type, and fail loudly instead of writing `deal_id = NULL`
 * if a booking payment ever reached deal code.
 */
import type { Payment } from "../../../shared/schema";

export type DealPaymentKind = "deposit" | "deal_payment";
export type DealPayment = Payment & { kind: DealPaymentKind; deal_id: string; booking_id: null };

export function isDealPayment(p: Pick<Payment, "kind" | "deal_id">): boolean {
  return (p.kind === "deposit" || p.kind === "deal_payment") && p.deal_id != null;
}

/** Narrow a full (or partial) payment row to one that belongs to a deal. Throws on a booking payment. */
export function assertDealPayment<T extends { id?: string; kind: string; deal_id: string | null }>(
  p: T,
): asserts p is T & { kind: DealPaymentKind; deal_id: string } {
  if (p.kind !== "deposit" && p.kind !== "deal_payment") {
    throw new Error(`payment ${p.id ?? "?"} is kind '${p.kind}', not a deal payment`);
  }
  if (p.deal_id == null) throw new Error(`deal payment ${p.id ?? "?"} has no deal_id`);
}

/** The deal id of a row already filtered to a deal kind (a partial select). Throws if it is missing. */
export function requireDealId(dealId: string | null, paymentId?: string): string {
  if (dealId == null) throw new Error(`payment ${paymentId ?? "?"} has no deal_id (not a deal payment)`);
  return dealId;
}
