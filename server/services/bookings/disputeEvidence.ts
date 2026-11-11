/**
 * bookings/disputeEvidence.ts — when a fan's bank opens a chargeback on a booking, the evidence Nomila already holds is
 * staged on the Stripe dispute at once (owner, 22 Oct: prevention + evidence, no dispute console).
 *
 * What goes in, all from our own records: what was bought and when, the cancellation and refund terms the buyer agreed
 * to, "It happened" if the buyer confirmed it, LiveKit attendance (join/leave times, evidence only — it never moved
 * money), and how many relayed messages there were (counts, never the text). It is STAGED (submit: false): a person
 * reviews it in the Stripe dashboard and submits it; nothing here answers the bank on its own. Best-effort and never
 * throws: a failed staging is logged and the support alert still goes out.
 *
 * Fees (owner, 22 Oct): Nomila absorbs routine dispute fees; recovery from the athlete only when the athlete was at
 * fault, by the same rule as refunds (first one free) — handled with the refund/transfer-reversal work, not here.
 */
import { asc, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../../db";
import { bookingEvents, bookingMessages, bookings } from "../../../shared/schema";
import type { Booking } from "../../../shared/schema";
import { getStripe } from "../../lib/stripe";
import { createLogger } from "../../logger";
import { athleteFirstName, usd } from "./common";

const logger = createLogger("bookings/disputeEvidence");

export interface StagedEvidence {
  product_description: string;
  customer_name: string;
  customer_email_address: string;
  service_date: string;
  cancellation_policy_disclosure: string;
  refund_policy_disclosure: string;
  access_activity_log?: string;
  uncategorized_text: string;
}

/** The evidence for one booking, from our own rows (pure over the inputs, so it's unit-tested). */
export function evidenceFor(
  b: Pick<Booking, "title" | "duration_minutes" | "location_mode" | "starts_at" | "buyer_name" | "buyer_email" | "free_cancel_hours" | "buyer_total_cents" | "service_fee_cents" | "price_cents" | "created_at" | "confirmed_at">,
  first: string,
  facts: { buyerConfirmed: Date | null; attendance: Array<{ at: string; who: string; what: string }>; messages: { fromBuyer: number; fromAthlete: number } },
): StagedEvidence {
  const day = b.starts_at ? b.starts_at.toISOString().slice(0, 10) : "";
  const lines = [
    `Booked on Nomila: ${b.title} (${b.duration_minutes} min, ${b.location_mode === "in_person" ? "in person" : "video call"}) with ${first}.`,
    `Requested ${b.created_at.toISOString()}; accepted and charged ${b.confirmed_at?.toISOString() ?? "n/a"}. Total ${usd(b.buyer_total_cents)} (athlete's price ${usd(b.price_cents)} + ${usd(b.service_fee_cents)} Nomila service fee), shown all-in before payment.`,
    facts.buyerConfirmed ? `The buyer confirmed the session happened ("It happened") at ${facts.buyerConfirmed.toISOString()}.` : "The buyer did not confirm or report a problem before release.",
    facts.attendance.length ? `Video call attendance (LiveKit server log): ${facts.attendance.length} entries, see access log.` : "",
    `Relayed messages on Nomila: ${facts.messages.fromBuyer} from the buyer, ${facts.messages.fromAthlete} from the athlete.`,
  ].filter(Boolean);
  return {
    product_description: `${b.title}: a ${b.duration_minutes}-minute ${b.location_mode === "in_person" ? "in-person session" : "video call"} with ${first}, booked through Nomila.`,
    customer_name: b.buyer_name,
    customer_email_address: b.buyer_email,
    service_date: day,
    cancellation_policy_disclosure: `Shown before payment and accepted by the buyer: cancel at least ${b.free_cancel_hours} hours before the start for the athlete's price back; the Nomila service fee is non-refundable; later cancellations aren't refunded.`,
    refund_policy_disclosure: "Refunds follow the cancellation terms above. If the athlete cancels or doesn't show, the buyer gets a full refund. Problems can be reported from the booking page before the payout.",
    ...(facts.attendance.length ? { access_activity_log: facts.attendance.map((a) => `${a.at} ${a.who} ${a.what}`).join("\n").slice(0, 20_000) } : {}),
    uncategorized_text: lines.join("\n"),
  };
}

/** Gather our records for the booking and stage them on the Stripe dispute (submit: false). Never throws. */
export async function stageBookingDisputeEvidence(bookingId: string, disputeId: string): Promise<boolean> {
  try {
    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
    if (!b || b.buyer_redacted_at) return false;
    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.booking_id, bookingId)).orderBy(asc(bookingEvents.at));
    const attendance = events.filter((e) => e.kind === "attendance").map((e) => ({
      at: String((e.data as any)?.occurredAt ?? e.at.toISOString()),
      who: String((e.data as any)?.role ?? (e.data as any)?.participant ?? "participant"),
      what: String((e.data as any)?.event ?? (e.data as any)?.type ?? "event"),
    }));
    const counts = await db.select({ sender: bookingMessages.sender, n: sql<number>`count(*)::int` }).from(bookingMessages)
      .where(eq(bookingMessages.booking_id, bookingId)).groupBy(bookingMessages.sender);
    const n = (s: string) => counts.find((c) => c.sender === s)?.n ?? 0;
    const { first } = await athleteFirstName(b.athlete_id);
    const evidence = evidenceFor(b, first, { buyerConfirmed: b.buyer_confirmed_at ?? null, attendance, messages: { fromBuyer: n("buyer"), fromAthlete: n("athlete") } });
    const stripe = getStripe() as unknown as { disputes?: { update: (id: string, p: Stripe.DisputeUpdateParams) => Promise<unknown> } };
    if (!stripe.disputes?.update) return false;
    await stripe.disputes.update(disputeId, { evidence, submit: false, metadata: { kind: "booking_payment", booking_id: bookingId } });
    logger.info({ bookingId, disputeId, attendance: attendance.length }, "dispute evidence staged for review");
    return true;
  } catch (err: any) {
    logger.warn({ bookingId, disputeId, error: err?.message }, "dispute evidence could not be staged — add it in the Stripe dashboard");
    return false;
  }
}
