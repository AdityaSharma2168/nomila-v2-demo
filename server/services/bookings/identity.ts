/**
 * bookings/identity.ts — the ID + selfie seam (Stripe Identity). Required for every in-person booking, and for an online
 * one when her offer asks for it, BEFORE the request reaches her. Nomila and she never see the images: Stripe keeps them;
 * only the session id and the status are stored ("ID checked by Stripe" is the only claim anyone sees).
 *
 * Created on the platform account (no Customer, no connected account), type document with a matching selfie.
 */
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { bookings } from "../../../shared/schema";
import type { Booking } from "../../../shared/schema";
import { getStripe } from "../../lib/stripe";
import { createLogger } from "../../logger";
import { buyerPageUrl, coded } from "./common";

const logger = createLogger("bookings/identity");

type IdStatus = "pending" | "verified" | "requires_input" | "canceled";
const mapStatus = (s: string): IdStatus => (s === "verified" ? "verified" : s === "requires_input" ? "requires_input" : s === "canceled" ? "canceled" : "pending");

/** Start (or restart after "requires input") the check; returns Stripe's hosted URL. */
export async function startIdentityCheck(b: Booking): Promise<{ url: string }> {
  if (!b.identity_required) throw coded("NOT_REQUIRED");
  if (b.identity_status === "verified") throw coded("ALREADY_VERIFIED");
  const stripe = getStripe();
  if (b.stripe_identity_session_id && b.identity_status === "pending") {
    const s = await stripe.identity.verificationSessions.retrieve(b.stripe_identity_session_id);
    if (s.status === "requires_input" && s.url) return { url: s.url };
  }
  const s = await stripe.identity.verificationSessions.create({
    type: "document",
    options: { document: { require_matching_selfie: true } },
    metadata: { kind: "booking_identity", booking_id: b.id },
    return_url: buyerPageUrl(b.id, "?id=done") ?? undefined,
  }, { idempotencyKey: `bkid_${b.id}_${b.stripe_identity_session_id ?? "first"}` });
  await db.update(bookings).set({ stripe_identity_session_id: s.id, identity_status: "pending", updated_at: new Date() }).where(eq(bookings.id, b.id));
  if (!s.url) throw coded("IDENTITY_UNAVAILABLE");
  return { url: s.url };
}

async function apply(bookingId: string, sessionId: string, status: string): Promise<IdStatus> {
  const st = mapStatus(status);
  await db.update(bookings).set({
    identity_status: st, ...(st === "verified" ? { identity_verified_at: new Date() } : {}), updated_at: new Date(),
  }).where(eq(bookings.id, bookingId));
  logger.info({ bookingId, status: st }, "identity check status");
  return st;
}

/** The return page re-checks with Stripe (the webhook may not have arrived yet). */
export async function refreshIdentityCheck(b: Booking): Promise<IdStatus | null> {
  if (!b.stripe_identity_session_id) return null;
  const s = await getStripe().identity.verificationSessions.retrieve(b.stripe_identity_session_id);
  return apply(b.id, s.id, s.status);
}

/** Webhook: identity.verification_session.verified / .requires_input / .canceled for a booking. */
export async function handleIdentityEvent(s: Stripe.Identity.VerificationSession): Promise<void> {
  if (s.metadata?.kind !== "booking_identity" || !s.metadata.booking_id) return;
  const [b] = await db.select({ id: bookings.id, sid: bookings.stripe_identity_session_id }).from(bookings).where(eq(bookings.id, s.metadata.booking_id)).limit(1);
  if (!b || b.sid !== s.id) return;   // a superseded session
  await apply(b.id, s.id, s.status);
}
