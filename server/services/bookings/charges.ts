/**
 * bookings/charges.ts — every Stripe call a booking makes, and the payments row that records it (kind 'booking_payment').
 *
 * Public card v3.1 "hold at request": the buyer's card is HELD when they send the request (Checkout, PaymentIntent
 * capture_method "manual", the all-in total — the deposit.ts pattern), CAPTURED when she accepts, and the hold is
 * CANCELLED (released) on a decline, an expiry or a withdrawal. Refunds follow the cancellation rules (clocks.ts
 * cancelQuote). Her money goes out through the ONE release path of the session PR (#868: session/releaseGate.ts →
 * payments/bookingRelease.ts); this file supplies the card-fee netting that gate applies (nettingForRelease).
 *
 *   payments.status   pending (Checkout open) → authorized (hold placed) → funded (captured) → settled (sent to her, #868)
 *                     · canceled (hold released) · expired · refunded · disputed · charged_back
 *   amounts           deal_value_cents = her price · commission_cents = the service fee · brand_total_cents = the total
 *
 * MONEY MOVES ONLY ON A TAP OR A RULE THE BUYER AGREED TO: capture = her Accept; refunds = her Cancel, the buyer's Cancel
 * under the published window, or a person at Nomila.
 * Nothing here is reachable from Mila (bookingsTapOnly.test.ts). Every Stripe write carries an idempotency key.
 */
import type Stripe from "stripe";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { athletePayoutAdjustments, bookingReports, bookings, offers, payments } from "../../../shared/schema";
import type { Booking, Payment } from "../../../shared/schema";
import { getStripe } from "../../lib/stripe";
import { createLogger } from "../../logger";
import { BOOKINGS } from "./config";
import { athleteRefundCost, estimateProcessingCents } from "./money";
import { coded, athleteFirstName, buyerPageUrl, formatWhen, usd } from "./common";
import { groupLine, notices } from "./notices";
import { LIVE_STATUSES, recordBookingEvent, transition, TransitionError, type BookingActor } from "./stateMachine";
import { respondByFor, firstPossibleStart } from "./clocks";
import { stageBookingDisputeEvidence } from "./disputeEvidence";

const logger = createLogger("bookings/charges");
const MIN = 60_000;

const idOf = (x: string | { id: string } | null | undefined): string | null => (typeof x === "string" ? x : x?.id ?? null);

export async function paymentFor(bookingId: string): Promise<Payment | null> {
  const [p] = await db.select().from(payments).where(and(eq(payments.booking_id, bookingId), eq(payments.kind, "booking_payment"))).limit(1);
  return p ?? null;
}

// ─── The hold (at request) ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The words above the card field and on Checkout's button (v3.2 "Hold copy, word for word"). An open group session
 * (0153) has no "accept": her publishing it was her yes, so the spot is charged as soon as the hold goes through.
 */
export function holdCopy(first: string, totalCents: number, audience: string = "one"): string {
  if (audience === "open_group") {
    return `We'll place a temporary hold of ${usd(totalCents)} on your card and charge it as soon as your spot is confirmed. If the session is full by then, the hold is released. Your bank may show it as pending.`;
  }
  return `We'll place a temporary hold of ${usd(totalCents)} on your card. You're only charged if ${first} accepts within ${BOOKINGS.respondHours} hours. If not, the hold is released. Your bank may show it as pending.`;
}

/**
 * Open (or reuse) the card-hold Checkout for an unverified booking whose buyer has confirmed every code. One payment
 * row per booking (uq_payments_booking); one open session per payment.
 */
export async function createHoldCheckout(bookingId: string): Promise<{ url: string; reused: boolean } | { alreadyHeld: true }> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!b) throw coded("NOT_FOUND");
  if (b.status !== "unverified") throw coded("WRONG_STATE", { status: b.status });
  if (!b.email_verified_at || (b.location_mode === "in_person" && !b.phone_verified_at)) throw coded("VERIFY_FIRST");
  if (b.identity_required && b.identity_status !== "verified") throw coded("IDENTITY_FIRST");

  const stripe = getStripe();
  let p = await paymentFor(b.id);
  if (p && ["authorized"].includes(p.status)) return { alreadyHeld: true };
  if (p && p.status === "pending" && p.stripe_checkout_session_id) {
    const s = await stripe.checkout.sessions.retrieve(p.stripe_checkout_session_id);
    if (s.status === "complete") { await syncHoldFromSession(s); return { alreadyHeld: true }; }
    if (s.status === "open" && s.url && (s.expires_at ?? 0) * 1000 - Date.now() > 5 * MIN) return { url: s.url, reused: true };
    if (s.status === "open") await stripe.checkout.sessions.expire(s.id).catch(() => undefined);
  }
  if (!p) {
    const [row] = await db.insert(payments).values({
      booking_id: b.id, athlete_id: b.athlete_id, kind: "booking_payment", status: "pending", rail: "card",
      deal_value_cents: b.price_cents, commission_cents: b.service_fee_cents,
      processing_fee_cents: estimateProcessingCents(b.buyer_total_cents, BOOKINGS.processingPercent, BOOKINGS.processingFixedCents),
      brand_total_cents: b.buyer_total_cents, currency: b.currency,
    }).onConflictDoNothing().returning();
    p = row ?? (await paymentFor(b.id));
    if (!p) throw coded("PAYMENT_ROW_MISSING");
  } else if (p.status !== "pending") {
    await db.update(payments).set({ status: "pending", stripe_checkout_session_id: null, checkout_expires_at: null, updated_at: new Date() })
      .where(eq(payments.id, p.id));
  }

  const { first } = await athleteFirstName(b.athlete_id);
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(30, BOOKINGS.holdCheckoutMinutes) * 60;
  const meta = { kind: "booking_payment", stage: "hold", payment_id: p.id, booking_id: b.id };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    expires_at: expiresAt,
    payment_method_types: ["card"],                       // holds are card-only (Apple Pay / Google Pay ride on card)
    line_items: [{
      price_data: {
        currency: b.currency,
        product_data: {
          name: `${b.title}${groupLine(b)} with ${first} · ${formatWhen(firstPossibleStart(b), b.buyer_timezone)}`,
          description: `Includes ${usd(b.service_fee_cents)} Nomila service fee`,   // ONE fee line, never a card fee
        },
        unit_amount: b.buyer_total_cents,
      },
      quantity: 1,
    }],
    // A HOLD — captured only on her Accept. A plain statement line ("NOMILA* BOOKING") so the charge is recognisable,
    // and Stripe's own receipt to the confirmed email once it's charged: both cut "I don't know this charge" disputes.
    payment_intent_data: {
      capture_method: "manual", metadata: meta, statement_descriptor_suffix: "BOOKING",
      ...(b.email_verified_at && b.buyer_email ? { receipt_email: b.buyer_email } : {}),
    },
    metadata: meta,
    custom_text: { submit: { message: holdCopy(first, b.buyer_total_cents, b.audience) } },
    success_url: buyerPageUrl(b.id, "?hold=done") ?? "https://nomila.co",
    cancel_url:  buyerPageUrl(b.id, "?hold=canceled") ?? "https://nomila.co",
  }, { idempotencyKey: `bkhold_${p.id}_${expiresAt}` });

  await db.update(payments).set({ stripe_checkout_session_id: session.id, checkout_expires_at: new Date(expiresAt * 1000), updated_at: new Date() })
    .where(eq(payments.id, p.id));
  if (!session.url) throw coded("CHECKOUT_UNAVAILABLE");
  return { url: session.url, reused: false };
}

/** The buyer came back from Checkout before the webhook: read the session from Stripe and apply it (idempotent). */
export async function syncHoldForBooking(bookingId: string): Promise<boolean> {
  const p = await paymentFor(bookingId);
  if (!p?.stripe_checkout_session_id) return false;
  if (p.status === "authorized") return true;
  const s = await getStripe().checkout.sessions.retrieve(p.stripe_checkout_session_id);
  if (s.status !== "complete") return false;
  return syncHoldFromSession(s);
}

/**
 * A hold Checkout completed: the PaymentIntent should be `requires_capture`. Record the hold, then move the booking
 * unverified → requested (respond_by set) and send the notices. A hold that lands on a booking that is no longer
 * unverified (it lapsed or was withdrawn meanwhile) is released at once.
 */
async function syncHoldFromSession(s: Stripe.Checkout.Session): Promise<boolean> {
  const paymentId = s.metadata?.payment_id;
  const bookingId = s.metadata?.booking_id;
  const piId = idOf(s.payment_intent as any);
  if (!paymentId || !bookingId || !piId) return false;
  const pi = await getStripe().paymentIntents.retrieve(piId);
  if (pi.status !== "requires_capture") {
    logger.warn({ paymentId, piStatus: pi.status }, "hold Checkout completed but the PaymentIntent is not awaiting capture");
    return false;
  }
  await db.update(payments).set({ status: "authorized", stripe_payment_intent_id: pi.id, failure_reason: null, updated_at: new Date() })
    .where(and(eq(payments.id, paymentId), eq(payments.status, "pending")));

  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!b) return false;
  if (b.status === "requested") return true;   // a replay
  if (b.status !== "unverified") {
    logger.warn({ bookingId, status: b.status }, "hold placed on a request that is no longer open — releasing it");
    const p = await paymentFor(bookingId);
    if (p) await cancelHold(p, "late_hold");
    return false;
  }
  const now = new Date();
  try {
    const row = await transition({
      bookingId, from: "unverified", to: "requested", actor: "stripe",
      patch: { respond_by: respondByFor(now, firstPossibleStart(b)) },
      data: { hold: "placed" },
    });
    // An open group (0153) has no request for her to answer: the spot is confirmed (captured) right here — unless she
    // approves each spot (0154): then it waits for her Accept like a 1:1 request, and lapses at respond_by as one does.
    if (row.audience === "open_group" && !row.approve_each_spot) { await autoConfirmOpenGroup(row.id, now); return true; }
    await notices.requestSent(row);
    return true;
  } catch (err) {
    if (err instanceof TransitionError && err.code === "STALE_STATE" && err.current === "requested") return true;
    throw err;
  }
}

// ─── Open group sessions (0153): her publishing the time is her yes ─────────────────────────────────────────────

export type AutoConfirmResult = "confirmed" | "retry" | "lapsed" | "full" | "skipped";

/**
 * An open-group fan finished every check and the hold is placed: if their spot still fits (it was held for them from
 * the moment they picked the time, so it normally does), capture now and confirm the booking — no tap from her. A
 * capture Stripe didn't answer leaves the booking `requested` with the hold in place; the bookings sweep retries it
 * (runBookingsCron) until respond_by. A dropped hold, a full time or a time that has started ends the request and
 * releases the hold. Idempotent: anything not `requested` with an authorized hold is skipped.
 */
export async function autoConfirmOpenGroup(bookingId: string, now = new Date()): Promise<AutoConfirmResult> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!b || b.audience !== "open_group" || b.status !== "requested" || b.approve_each_spot) return "skipped";   // 0154: hers to accept
  const p = await paymentFor(b.id);
  if (!p || p.status !== "authorized") return "skipped";
  const [o] = await db.select({ max: offers.max_people, venue: offers.venue, video: offers.video_mode }).from(offers).where(eq(offers.id, b.offer_id)).limit(1);
  const taken = b.slot_id ? await slotSpotsTaken(b.slot_id) : b.party_size;
  const spots = Math.max(o?.max ?? 0, 1);
  const end = async (why: "full" | "started" | "lapsed"): Promise<AutoConfirmResult> => {
    try {
      const row = await transition({ bookingId: b.id, from: "requested", to: "expired", actor: "system", data: { open_group: why } });
      await cancelHold((await paymentFor(b.id)) ?? p, `open_group_${why}`, "expired");
      await notices.expired(row);
    } catch (err) { if (!(err instanceof TransitionError)) throw err; }
    return why === "lapsed" ? "lapsed" : "full";
  };
  if (taken > spots) return end("full");                       // a backstop: spots are held from the pick (buyer.ts)
  if (b.starts_at && b.starts_at <= now) return end("started");
  const r = await captureHold(p);
  if (r === "retry") return "retry";
  if (r === "hold_lapsed") return end("lapsed");
  try {
    const row = await transition({
      bookingId: b.id, from: "requested", to: "confirmed", actor: "system",
      patch: {
        accepted_at: now, confirmed_at: now,
        meeting_mode: b.location_mode === "in_person" ? "in_person" : (o?.video === "link" ? "link" : "livekit"),
        venue: b.location_mode === "in_person" ? o?.venue ?? null : null,
      },
      data: { open_group: "auto_confirmed", spots_taken: taken, spots },
    });
    await notices.groupJoined(row, taken, spots);
    return "confirmed";
  } catch (err) {
    if (err instanceof TransitionError && err.code === "STALE_STATE" && err.current === "confirmed") return "confirmed";
    throw err;
  }
}

/** People holding spots in a slot (live bookings' party sizes). */
export async function slotSpotsTaken(slotId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`coalesce(sum(${bookings.party_size}), 0)::int` }).from(bookings)
    .where(and(eq(bookings.slot_id, slotId), inArray(bookings.status, [...LIVE_STATUSES])));
  return Number(r?.n ?? 0);
}

// ─── Capture (her Accept) ───────────────────────────────────────────────────────────────────────────────────────

export type CaptureResult = "captured" | "hold_lapsed" | "retry";

/**
 * Capture the held amount. `hold_lapsed`: the bank dropped the hold (the PaymentIntent is canceled) — the caller opens
 * the pay-link fallback. `retry`: Stripe didn't answer and the hold is still there — nothing was charged; her next tap
 * captures (same idempotency key).
 */
export async function captureHold(p: Payment): Promise<CaptureResult> {
  if (p.status === "funded") return "captured";
  if (p.status !== "authorized" || !p.stripe_payment_intent_id) return "hold_lapsed";
  const stripe = getStripe();
  let pi: Stripe.PaymentIntent | null = null;
  try {
    pi = await stripe.paymentIntents.capture(p.stripe_payment_intent_id, {}, { idempotencyKey: `bkcapture_${p.id}` });
  } catch (err: any) {
    logger.warn({ paymentId: p.id, error: err.message }, "capture failed — checking the PaymentIntent");
    pi = await stripe.paymentIntents.retrieve(p.stripe_payment_intent_id).catch(() => null);
    if (!pi) return "retry";
  }
  if (pi.status === "requires_capture") return "retry";
  if (pi.status !== "succeeded") {
    await db.update(payments).set({ status: "canceled", failure_reason: `capture_failed:${pi.status}`, updated_at: new Date() }).where(eq(payments.id, p.id));
    return "hold_lapsed";
  }
  await db.update(payments).set({
    status: "funded", stripe_charge_id: idOf(pi.latest_charge as any), failure_reason: null, updated_at: new Date(),
  }).where(eq(payments.id, p.id));
  return "captured";
}

/** The capture-failure fallback: a normal (automatic-capture) Checkout the buyer pays by `payBy`. */
export async function createPayLink(b: Booking, p: Payment, payBy: Date): Promise<string> {
  const { first } = await athleteFirstName(b.athlete_id);
  const expiresAt = Math.floor(Math.max(Date.now() + 31 * MIN, Math.min(payBy.getTime(), Date.now() + 23 * 3_600_000)) / 1000);
  const meta = { kind: "booking_payment", stage: "pay", payment_id: p.id, booking_id: b.id };
  const session = await getStripe().checkout.sessions.create({
    mode: "payment", expires_at: expiresAt, payment_method_types: ["card"],
    line_items: [{ price_data: { currency: b.currency, product_data: {
      name: `${b.title} with ${first} · ${formatWhen(b.starts_at, b.buyer_timezone)}`,
      description: `Includes ${usd(b.service_fee_cents)} Nomila service fee`,
    }, unit_amount: b.buyer_total_cents }, quantity: 1 }],
    payment_intent_data: { metadata: meta },
    metadata: meta,
    custom_text: { submit: { message: `Cancel at least ${b.free_cancel_hours} hours before: ${first}'s price refunded; the service fee is non-refundable.` } },
    success_url: buyerPageUrl(b.id, "?paid=1") ?? "https://nomila.co",
    cancel_url:  buyerPageUrl(b.id) ?? "https://nomila.co",
  }, { idempotencyKey: `bkpay_${p.id}_${expiresAt}` });
  await db.update(payments).set({ status: "pending", stripe_checkout_session_id: session.id, checkout_expires_at: new Date(expiresAt * 1000), updated_at: new Date() })
    .where(eq(payments.id, p.id));
  if (!session.url) throw coded("CHECKOUT_UNAVAILABLE");
  return session.url;
}

// ─── Release the hold (decline / expiry / withdrawal) ───────────────────────────────────────────────────────────

/** Cancel the authorization (never captured) or close the open Checkout. Idempotent; never throws. */
export async function cancelHold(p: Payment, reason: string, terminal: "canceled" | "expired" = "canceled"): Promise<boolean> {
  if (!["pending", "authorized"].includes(p.status)) return false;
  const stripe = getStripe();
  let ok = true;
  if (p.stripe_payment_intent_id && p.status === "authorized") {
    try { await stripe.paymentIntents.cancel(p.stripe_payment_intent_id, {}, { idempotencyKey: `bkrelease_${p.id}` }); }
    catch (err: any) {
      const pi = await stripe.paymentIntents.retrieve(p.stripe_payment_intent_id).catch(() => null);
      ok = pi?.status === "canceled";
      if (!ok) logger.error({ alert: "BOOKING_HOLD_RELEASE_FAILED", paymentId: p.id, error: err.message }, "hold release failed — the sweeper retries");
    }
  }
  if (p.stripe_checkout_session_id && p.status === "pending") {
    await stripe.checkout.sessions.expire(p.stripe_checkout_session_id).catch(() => undefined);
  }
  await db.update(payments).set(ok
    ? { status: terminal, failure_reason: null, updated_at: new Date(), metadata: sql`coalesce(${payments.metadata}, '{}'::jsonb) || ${JSON.stringify({ released_reason: reason })}::jsonb` }
    : { failure_reason: "hold_release_failed", updated_at: new Date() })
    .where(eq(payments.id, p.id));
  return ok;
}

// ─── Refunds ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Refund `amountCents` of a captured booking payment. Idempotent per payment. 0 → nothing to do. */
export async function refundBookingPayment(p: Payment, amountCents: number, actor: BookingActor, reason: string | null): Promise<{ refundId: string | null }> {
  if (amountCents <= 0) return { refundId: null };
  if (p.status === "refunded") return { refundId: p.stripe_refund_id };
  if (!["funded", "disputed"].includes(p.status) || !p.stripe_payment_intent_id) throw coded("NOT_REFUNDABLE", { status: p.status });
  if (p.status === "disputed" && p.stripe_dispute_id) throw coded("CHARGEBACK_OPEN");
  try {
    const refund = await getStripe().refunds.create({
      payment_intent: p.stripe_payment_intent_id, amount: amountCents, reason: "requested_by_customer",
      metadata: { kind: "booking_refund", payment_id: p.id, booking_id: p.booking_id ?? "", requested_by: actor },
    }, { idempotencyKey: `bkrefund_${p.id}` });
    await db.update(payments).set({
      status: "refunded", stripe_refund_id: refund.id, refunded_cents: refund.amount ?? amountCents, refunded_at: new Date(),
      refund_reason: reason?.slice(0, 300) ?? null, refund_requested_by: actor === "admin" ? "admin" : actor === "athlete" ? "athlete" : "buyer",
      failure_reason: null, updated_at: new Date(),
    }).where(eq(payments.id, p.id));
    return { refundId: refund.id };
  } catch (err: any) {
    await db.update(payments).set({ failure_reason: "refund_failed", updated_at: new Date() }).where(eq(payments.id, p.id));
    logger.error({ alert: "BOOKING_REFUND_FAILED", paymentId: p.id, error: err.message }, "booking refund failed — the sweeper retries");
    throw coded("REFUND_FAILED");
  }
}

/**
 * She caused this refund (she cancelled, didn't show, or refunded as goodwill): she covers Stripe's ACTUAL fee on the
 * charge (from its balance transaction, never a hard-coded rate), deducted from her next payout — unless it is her
 * first, which is on Nomila ('waived', one per athlete ever). Idempotent per booking.
 */
export async function recordAthleteRefundCost(b: Pick<Booking, "id" | "athlete_id" | "currency">, p: Payment): Promise<{ amountCents: number; status: "waived" | "owed" } | null> {
  let feeCents = 0;
  let btId: string | null = null;
  const chargeId = p.stripe_charge_id;
  if (chargeId) {
    try {
      const ch = await getStripe().charges.retrieve(chargeId, { expand: ["balance_transaction"] });
      const bt = ch.balance_transaction as Stripe.BalanceTransaction | string | null;
      if (bt && typeof bt === "object") { feeCents = bt.fee; btId = bt.id; }
    } catch (err: any) {
      logger.warn({ paymentId: p.id, error: err.message }, "could not read the charge's actual fee — recording 0 for an admin to correct");
    }
  }
  const [waived] = await db.select({ id: athletePayoutAdjustments.id }).from(athletePayoutAdjustments)
    .where(and(eq(athletePayoutAdjustments.athlete_id, b.athlete_id), eq(athletePayoutAdjustments.status, "waived"))).limit(1);
  const cost = athleteRefundCost(feeCents, !!waived);
  const insert = (status: "waived" | "owed") => db.insert(athletePayoutAdjustments).values({
    athlete_id: b.athlete_id, booking_id: b.id, amount_cents: cost.amountCents, currency: b.currency, status,
    stripe_balance_transaction_id: btId,
  }).onConflictDoNothing({ target: [athletePayoutAdjustments.booking_id, athletePayoutAdjustments.kind] }).returning({ id: athletePayoutAdjustments.id });
  try { await insert(cost.status); return cost; }
  catch { await insert("owed"); return { amountCents: cost.amountCents, status: "owed" }; }   // a concurrent first waiver won
}

/** True when she has never had a cancellation waived (her first one is free). */
export async function firstCancelStillFree(athleteId: string): Promise<boolean> {
  const [w] = await db.select({ id: athletePayoutAdjustments.id }).from(athletePayoutAdjustments)
    .where(and(eq(athletePayoutAdjustments.athlete_id, athleteId), eq(athletePayoutAdjustments.status, "waived"))).limit(1);
  return !w;
}

// ─── Her money: what a release nets (B5) ────────────────────────────────────────────────────────────────────────
//
// Releasing a booking's money is ONE path, owned by the session PR (#868): services/bookings/session/releaseGate.ts
// decides whether (the buyer's "It happened", or end + 48h with nothing open; never attendance, never her own tap) and
// services/payments/bookingRelease.ts moves it. This file adds only the netting the gate applies: a card fee she owes
// for a refund she caused comes off her next payout (never below 0), and those rows are then marked recovered.

export async function hasOpenReport(bookingId: string): Promise<boolean> {
  const [r] = await db.select({ id: bookingReports.id }).from(bookingReports)
    .where(and(eq(bookingReports.booking_id, bookingId), inArray(bookingReports.status, ["open", "in_review"]))).limit(1);
  return !!r;
}

export interface ReleaseNetting {
  bookingId:     string;
  priceCents:    number;   // her price (what she was promised)
  feeCents:      number;   // card fees she owes, taken from this payout
  netCents:      number;   // what to transfer: price − fees, never below 0
  adjustmentIds: string[]; // the 'owed' rows this payout recovers
}

/**
 * What this booking's release should transfer: her price minus the card fees she owes (oldest first, each one only if
 * it fits whole). Read-only; the gate transfers `netCents` and then calls markCardFeesRecovered with the payment id.
 */
export async function nettingForRelease(bookingId: string): Promise<ReleaseNetting | null> {
  const [b] = await db.select({ athlete: bookings.athlete_id, price: bookings.price_cents }).from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!b) return null;
  const owed = await db.select().from(athletePayoutAdjustments)
    .where(and(eq(athletePayoutAdjustments.athlete_id, b.athlete), eq(athletePayoutAdjustments.status, "owed")))
    .orderBy(asc(athletePayoutAdjustments.created_at));
  let net = b.price;
  const ids: string[] = [];
  for (const a of owed) if (a.amount_cents <= net) { net -= a.amount_cents; ids.push(a.id); }
  return { bookingId, priceCents: b.price, feeCents: b.price - net, netCents: net, adjustmentIds: ids };
}

/** After the transfer succeeded: the netted card fees are recovered against that payment. Idempotent. */
export async function markCardFeesRecovered(n: ReleaseNetting, paymentId: string): Promise<void> {
  if (!n.adjustmentIds.length) return;
  await db.update(athletePayoutAdjustments).set({ status: "recovered", recovered_payment_id: paymentId, settled_at: new Date() })
    .where(and(inArray(athletePayoutAdjustments.id, n.adjustmentIds), eq(athletePayoutAdjustments.status, "owed")));
}

// ─── Webhooks (record what Stripe did) ──────────────────────────────────────────────────────────────────────────

/** checkout.session.completed for a booking: the hold was placed (stage hold), or the fallback pay link was paid. */
export async function handleBookingCheckoutCompleted(s: Stripe.Checkout.Session): Promise<void> {
  if (s.metadata?.kind !== "booking_payment") return;
  if (s.metadata.stage === "hold") { await syncHoldFromSession(s); return; }
  if (s.metadata.stage !== "pay" || s.payment_status !== "paid") return;
  const paymentId = s.metadata.payment_id, bookingId = s.metadata.booking_id;
  if (!paymentId || !bookingId) return;
  const piId = idOf(s.payment_intent as any);
  let chargeId: string | null = null;
  if (piId) { try { chargeId = idOf((await getStripe().paymentIntents.retrieve(piId)).latest_charge as any); } catch { /* backfilled at release */ } }
  const funded = await db.update(payments).set({ status: "funded", stripe_payment_intent_id: piId, stripe_charge_id: chargeId, failure_reason: null, updated_at: new Date() })
    .where(and(eq(payments.id, paymentId), inArray(payments.status, ["pending", "canceled", "expired"]))).returning({ id: payments.id });
  if (!funded.length) return;   // a replay
  try {
    const row = await transition({ bookingId, from: "accepted", to: "confirmed", actor: "stripe", patch: { confirmed_at: new Date(), pay_by: null } });
    await notices.accepted(row);
  } catch (err) {
    if (err instanceof TransitionError && err.code === "STALE_STATE") {
      // Paid after the booking lapsed. Money that arrives is never silently lost — and a refund needs a person's tap.
      logger.error({ alert: "BOOKING_PAID_AFTER_CLOSE", bookingId, paymentId, status: err.current }, "a booking was paid after it closed — refund needed");
      await notices.supportAlert({ id: bookingId }, "Paid after the booking closed", `Status ${err.current}. Refund the buyer from the admin queue.`);
      return;
    }
    throw err;
  }
}

/** payment_intent.canceled for a booking hold (the bank or Stripe dropped it, or we released it). */
export async function handleBookingPaymentIntentCanceled(pi: Stripe.PaymentIntent): Promise<void> {
  if (pi.metadata?.kind !== "booking_payment") return;
  const paymentId = pi.metadata.payment_id;
  if (!paymentId) return;
  const [p] = await db.update(payments).set({ status: "canceled", updated_at: new Date() })
    .where(and(eq(payments.id, paymentId), eq(payments.stripe_payment_intent_id, pi.id), eq(payments.status, "authorized")))
    .returning();
  if (!p?.booking_id) return;
  try {
    const row = await transition({ bookingId: p.booking_id, from: "requested", to: "expired", actor: "stripe", data: { hold: "dropped" } });
    await notices.expired(row);
  } catch (err) {
    if (!(err instanceof TransitionError)) throw err;   // accepted (her capture falls back to a pay link) or already closed
  }
}

async function bookingPaymentByCharge(chargeId: string | null, piId: string | null): Promise<Payment | null> {
  for (const c of [chargeId ? eq(payments.stripe_charge_id, chargeId) : null, piId ? eq(payments.stripe_payment_intent_id, piId) : null]) {
    if (!c) continue;
    const [p] = await db.select().from(payments).where(and(c, eq(payments.kind, "booking_payment"))).limit(1);
    if (p) return p;
  }
  return null;
}

/** charge.dispute.created on a booking charge: freeze release, alert support. */
export async function handleBookingDisputeCreated(d: Stripe.Dispute): Promise<void> {
  const p = await bookingPaymentByCharge(idOf(d.charge as any), idOf(d.payment_intent as any));
  if (!p?.booking_id) return;
  await db.update(payments).set({ stripe_dispute_id: d.id, dispute_status: d.status, ...(["funded", "settled"].includes(p.status) ? { status: "disputed" } : {}), updated_at: new Date() })
    .where(eq(payments.id, p.id));
  await transition({ bookingId: p.booking_id, from: ["confirmed", "in_review", "issue_reported"], to: "disputed", actor: "stripe", data: { dispute: d.id } })
    .catch((err) => { if (!(err instanceof TransitionError)) throw err; });
  logger.error({ alert: "BOOKING_CHARGEBACK", bookingId: p.booking_id, disputeId: d.id }, "chargeback on a booking — release frozen");
  // Our records (terms shown, It happened, LiveKit attendance, message counts) staged on the dispute for review.
  const staged = await stageBookingDisputeEvidence(p.booking_id, d.id);
  await notices.supportAlert({ id: p.booking_id }, "Chargeback opened",
    `Reason: ${d.reason}. ${staged ? "Evidence from Nomila's records is staged on the dispute: review and submit it" : "Add the evidence"} in the Stripe dashboard.`);
}

/** charge.dispute.closed: lost → refunded (the bank returned the money); won → back on the release clock. */
export async function handleBookingDisputeClosed(d: Stripe.Dispute): Promise<void> {
  const [p] = await db.select().from(payments).where(and(eq(payments.stripe_dispute_id, d.id), eq(payments.kind, "booking_payment"))).limit(1);
  if (!p?.booking_id) return;
  if (d.status === "lost") {
    await db.update(payments).set({ status: "charged_back", dispute_status: d.status, updated_at: new Date() }).where(eq(payments.id, p.id));
    await transition({ bookingId: p.booking_id, from: "disputed", to: "refunded", actor: "stripe", data: { dispute: d.id, outcome: "lost" } })
      .catch((err) => { if (!(err instanceof TransitionError)) throw err; });
    return;
  }
  await db.update(payments).set({ status: p.stripe_transfer_id ? "settled" : "funded", dispute_status: d.status, updated_at: new Date() })
    .where(and(eq(payments.id, p.id), eq(payments.status, "disputed")));
  await transition({ bookingId: p.booking_id, from: "disputed", to: "in_review", actor: "stripe", data: { dispute: d.id, outcome: d.status } })
    .catch((err) => { if (!(err instanceof TransitionError)) throw err; });
}
