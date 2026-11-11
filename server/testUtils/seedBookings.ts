/**
 * seedBookings — fixtures for the Bookings v2 suites: an athlete with a working payout account, an offer, a booking in
 * any state, and its payment (held or captured) mirrored in the fake Stripe. Real rows in PGlite, nothing faked in SQL.
 */
import { randomUUID } from "node:crypto";
import { db } from "./pgliteDb";
import { bookings, connectAccounts, offerSlots, offers, payments } from "../../shared/schema";
import type { Booking, Offer } from "../../shared/schema";
import { fake } from "./fakeStripeBookings";

let n = 0;
const H = 3_600_000;

export async function seedPayoutAccount(athleteId: string, ready = true): Promise<void> {
  await db.insert(connectAccounts).values({
    athlete_id: athleteId, stripe_account_id: `acct_bk${++n}`, account_kind: "classic",
    details_submitted: ready, charges_enabled: ready, payouts_enabled: ready, transfers_active: ready, updated_at: new Date(),
  } as any);
}

export async function seedOffer(athleteId: string, over: Partial<typeof offers.$inferInsert> = {}): Promise<Offer> {
  const [o] = await db.insert(offers).values({
    athlete_id: athleteId, public_id: `pub_${++n}_${randomUUID().slice(0, 6)}`, format: "video_call", title: "1:1 video call",
    price_cents: 15_000, duration_minutes: 30, location_mode: "virtual", video_mode: "livekit", status: "published",
    adult_attested_at: new Date(), ...over,
  }).returning();
  return o;
}

export async function seedSlot(offer: Offer, startsInHours: number): Promise<string> {
  const s = new Date(Date.now() + startsInHours * H);
  const [row] = await db.insert(offerSlots).values({
    offer_id: offer.id, athlete_id: offer.athlete_id, starts_at: s, ends_at: new Date(s.getTime() + offer.duration_minutes * 60_000),
  }).returning({ id: offerSlots.id });
  return row.id;
}

export interface BookingSeed extends Partial<typeof bookings.$inferInsert> { startsInHours?: number | null }

/** A booking for `offer`, verified by default; `startsInHours` sets starts/ends (null = request mode, no time yet). */
export async function seedBooking(offer: Offer, over: BookingSeed = {}): Promise<Booking> {
  const { startsInHours = 48, ...rest } = over;
  const starts = startsInHours === null ? null : new Date(Date.now() + startsInHours * H);
  const now = new Date();
  const [b] = await db.insert(bookings).values({
    id: randomUUID(), athlete_id: offer.athlete_id, offer_id: offer.id, status: "requested",
    format: offer.format, title: offer.title, duration_minutes: offer.duration_minutes, location_mode: offer.location_mode,
    policy_key: offer.policy_key, free_cancel_hours: offer.free_cancel_hours,
    price_cents: 15_000, service_fee_cents: 2_796, buyer_total_cents: 17_796,
    buyer_name: "Jordan Park", buyer_email: `buyer${++n}@example.test`, buyer_email_hash: `h${n}`, buyer_token_hash: `t${n}_${randomUUID()}`,
    buyer_timezone: "America/New_York", buyer_adult_attested: true,
    email_verified_at: now, phone_verified_at: now, buyer_phone: "+15125550100",
    starts_at: starts, ends_at: starts ? new Date(starts.getTime() + offer.duration_minutes * 60_000) : null,
    respond_by: new Date(now.getTime() + 72 * H),
    identity_required: offer.location_mode === "in_person", identity_status: offer.location_mode === "in_person" ? "verified" : null,
    ...rest,
  }).returning();
  return b;
}

/** A placed hold: an authorized payment with a PaymentIntent awaiting capture in the fake Stripe. */
export async function seedHeld(b: Booking): Promise<string> {
  const piId = `pi_seed_${++n}`;
  fake.paymentIntents.set(piId, { id: piId, amount: b.buyer_total_cents, status: "requires_capture", capture_method: "manual", metadata: { kind: "booking_payment" }, latest_charge: null });
  const [p] = await db.insert(payments).values({
    booking_id: b.id, athlete_id: b.athlete_id, kind: "booking_payment", status: "authorized", rail: "card",
    deal_value_cents: b.price_cents, commission_cents: b.service_fee_cents, brand_total_cents: b.buyer_total_cents,
    stripe_payment_intent_id: piId,
  }).returning({ id: payments.id });
  fake.paymentIntents.get(piId)!.metadata = { kind: "booking_payment", payment_id: p.id, booking_id: b.id };
  return p.id;
}

/** A captured payment (the card was charged when she accepted). */
export async function seedFunded(b: Booking): Promise<string> {
  const piId = `pi_seed_${++n}`;
  const ch = `ch_seed_${n}`;
  fake.paymentIntents.set(piId, { id: piId, amount: b.buyer_total_cents, status: "succeeded", capture_method: "manual", metadata: { kind: "booking_payment" }, latest_charge: ch });
  const [p] = await db.insert(payments).values({
    booking_id: b.id, athlete_id: b.athlete_id, kind: "booking_payment", status: "funded", rail: "card",
    deal_value_cents: b.price_cents, commission_cents: b.service_fee_cents, brand_total_cents: b.buyer_total_cents,
    stripe_payment_intent_id: piId, stripe_charge_id: ch,
  }).returning({ id: payments.id });
  return p.id;
}
