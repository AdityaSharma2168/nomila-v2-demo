/**
 * bookings/buyer.ts — the buyer's side (account-less), used by the public page later (routes/bookingsPublic.ts).
 *
 *   1 the offer + the all-in quote             published offers of pilot athletes only; never the venue before payment
 *   2 the request                              a slot (held at once by uq_bookings_live_slot) or 1–3 suggested times + a
 *                                              note; name, email, phone, a message; "I'm 18 or older" (or the parent
 *                                              option when her offer allows minors); the price they saw must be the live one
 *   3 email code → phone code (Firebase) → ID + selfie (in person, or her offer asks) → the card hold
 *   4 the private page: the token (from the email link) AND a fresh email code (an access key) — status, thread, and the
 *     buyer's own taps: withdraw, pick one of her times, cancel (her window decides the refund). The session itself and
 *     what follows it ("It happened", "Report a problem", the call) are the session page of #868 (/s/:token).
 *
 * She never sees the buyer's email or phone. A blocked or banned buyer gets the same answer as everyone and nothing is
 * created (no enumeration). Codes are hashed, tried at most 5 times, and expire after 10 minutes.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { bookings, offerSlots, offers, publicCards, safetyBlocks } from "../../../shared/schema";
import type { Booking, Offer } from "../../../shared/schema";
import type { BuyerBookingView, BuyerCancelPreviewView, BuyerStep, PublicOfferView, QuoteView } from "../../../shared/bookingsApi";
import { guestViews, guestsOpen } from "./guests";
import { createLogger } from "../../logger";
import { BOOKINGS, bookingsEnabledFor } from "./config";
import { allInLine, isPartySize, quoteBookingCharge, quotePartyCharge } from "./money";
import { athleteFirstName, coded } from "./common";
import { notices } from "./notices";
import { sendTemplate } from "../notify/templates";
import { BOOKING_TEMPLATES } from "../notify/templates/bookings";
import { LIVE_STATUSES, recordBookingEvent, transition, TransitionError } from "./stateMachine";
import { cancelQuote, parseProposedTimes, releaseDueAt, startProblem, unverifiedHoldExpiresAt } from "./clocks";
import { cancelHold, createHoldCheckout, createPayLink, paymentFor, refundBookingPayment, syncHoldForBooking } from "./charges";
import { slotPeople, slotSpots } from "./offers";
import {
  accessKeyFor, accessKeyValid, bookingRef, buyerTokenFor, buyerTokenHash, codeMatches, emailHash, newCode, normalisePhone, phoneHash,
} from "./tokens";
import { verifiedPhoneFromFirebase } from "./phoneVerify";
import { isFanBlocked } from "../fanSafety/fanBlocks";
import { startIdentityCheck, refreshIdentityCheck } from "./identity";
import { getStripe } from "../../lib/stripe";
import { sessionUrlFor } from "./session/sessionStore";
import { publicCardEnabled } from "../publicCard/config";
import { validateHandle } from "../publicCard/handles";
import { publishedContent } from "../publicCard/publish";

const logger = createLogger("bookings/buyer");
const MIN = 60_000, HOUR = 3_600_000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/;

// ─── 1. The offer ───────────────────────────────────────────────────────────────────────────────────────────────

async function publicOfferRow(publicId: string): Promise<Offer> {
  const [o] = await db.select().from(offers).where(eq(offers.public_id, publicId)).limit(1);
  if (!o || !bookingsEnabledFor(o.athlete_id)) throw coded("NOT_FOUND");
  return o;
}

/** The all-in quote for `partySize` people at her per-person price (1:1 is party 1: the same numbers as ever). */
export function quoteOf(unitPriceCents: number, partySize = 1): QuoteView {
  const q = quotePartyCharge(unitPriceCents, partySize);
  return {
    priceCents: q.priceCents, serviceFeeCents: q.serviceFeeCents, buyerTotalCents: q.buyerTotalCents, athleteReceivesCents: q.athleteReceivesCents,
    currency: q.currency, unitPriceCents: q.unitPriceCents, partySize: q.partySize,
  };
}

/** A booking's own (snapshotted) quote: what was agreed, whatever the offer says now. */
export function bookingQuote(b: Pick<Booking, "price_cents" | "service_fee_cents" | "buyer_total_cents" | "currency" | "party_size" | "unit_price_cents">): QuoteView {
  return {
    priceCents: b.price_cents, serviceFeeCents: b.service_fee_cents, buyerTotalCents: b.buyer_total_cents, athleteReceivesCents: b.price_cents,
    currency: b.currency, unitPriceCents: unitPriceOf(b), partySize: b.party_size,
  };
}

/** Her per-person price on a booking (a pre-0153 row has no unit price: it was party 1). */
export function unitPriceOf(b: Pick<Booking, "price_cents" | "party_size" | "unit_price_cents">): number {
  return b.unit_price_cents ?? Math.round(b.price_cents / Math.max(1, b.party_size));
}

/** The people a private-group booker asked for (1..max_people); everything else is exactly one person. Null = refused. */
export function partySizeFor(o: Pick<Offer, "audience" | "max_people">, raw: unknown): number | null {
  const n = typeof raw === "string" && /^\d{1,2}$/.test(raw) ? Number(raw) : raw;
  if (n === undefined || n === null) return 1;
  if (o.audience !== "private_group") return n === 1 ? 1 : null;
  return isPartySize(n, o.max_people) ? n : null;
}

export async function publicOffer(publicId: string, now = new Date()): Promise<PublicOfferView> {
  const o = await publicOfferRow(publicId);
  const { first } = await athleteFirstName(o.athlete_id);
  const slots = o.scheduling_mode === "slots"
    ? await db.select().from(offerSlots).where(and(eq(offerSlots.offer_id, o.id), isNull(offerSlots.withdrawn_at))).orderBy(offerSlots.starts_at)
    : [];
  const held = await slotPeople(slots.map((s) => s.id));
  const future = slots.filter((s) => startProblem(s.starts_at, now) === "none");
  const spots = (id: string) => slotSpots(o, held.get(id) ?? 0);
  const open = future.filter((s) => !spots(s.id).full);
  const available = o.status === "published" && (o.scheduling_mode === "request" || open.length > 0);
  const group = o.audience === "open_group";
  const at = (s: typeof slots[number]) => ({ id: s.id, startsAt: s.starts_at.toISOString(), endsAt: s.ends_at.toISOString() });
  return {
    publicId: o.public_id, athleteFirstName: first, format: o.format as PublicOfferView["format"], title: o.title,
    description: o.description, durationMinutes: o.duration_minutes, locationMode: o.location_mode as PublicOfferView["locationMode"],
    schedulingMode: o.scheduling_mode as PublicOfferView["schedulingMode"], freeCancelHours: o.free_cancel_hours,
    allowMinorAttendees: o.allow_minor_attendees, idCheckRequired: o.location_mode === "in_person" || o.require_id_verification,
    audience: o.audience as PublicOfferView["audience"], maxPeople: o.max_people,
    quote: quoteOf(o.price_cents), allInLine: allInLine(quoteBookingCharge(o.price_cents), first),
    slots: available ? open.map((s) => (group ? { ...at(s), spotsLeft: spots(s.id).left, capacity: spots(s.id).capacity } : at(s))) : [],
    fullSlots: group && o.status === "published" ? future.filter((s) => spots(s.id).full).map(at) : [],
    maxProposedTimes: BOOKINGS.maxProposedTimes, available, supportEmail: BOOKINGS.supportEmail,
  };
}

/**
 * Her bookable offers for the Book door of her public page (/p/:handle/book), read LIVE: a session she publishes (or
 * pauses, or deletes) shows there at once, without her republishing the page. The page itself stays a frozen
 * snapshot; this lists, by her handle, the same public data GET /offers/:publicId already serves.
 *
 * Only while the Book door is open on her PUBLISHED card (her Book switch, frozen at her publish and pulled at once
 * when she turns it off, publish.ts publishRemoval) and she is in the bookings pilot. Anything else is NOT_FOUND, the
 * same answer as an unknown handle, so a miss says nothing.
 */
export async function publicOffersForHandle(rawHandle: unknown, now = new Date()): Promise<PublicOfferView[]> {
  if (!publicCardEnabled()) throw coded("NOT_FOUND");
  const v = validateHandle(rawHandle);
  if (!v.ok) throw coded("NOT_FOUND");
  const [card] = await db.select({ athleteId: publicCards.athlete_id }).from(publicCards)
    .where(and(eq(publicCards.handle, v.handle), eq(publicCards.status, "published"))).limit(1);
  if (!card || !bookingsEnabledFor(card.athleteId)) throw coded("NOT_FOUND");
  const content = await publishedContent(card.athleteId);
  if (!content?.doors?.book) throw coded("NOT_FOUND");
  const rows = await db.select({ publicId: offers.public_id }).from(offers)
    .where(and(eq(offers.athlete_id, card.athleteId), eq(offers.status, "published"))).orderBy(asc(offers.created_at));
  const views = await Promise.all(rows.map((r) => publicOffer(r.publicId, now)));
  return views.filter((o) => o.available);
}

// ─── 2. The request ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RequestInput {
  slot_id?: unknown; proposed_times?: unknown; proposed_note?: unknown; message?: unknown;
  buyer_name?: unknown; buyer_email?: unknown; buyer_phone?: unknown; buyer_timezone?: unknown;
  adult_attested?: unknown; parent_booking?: unknown; child_first_name?: unknown; agree_terms?: unknown;
  displayed_total_cents?: unknown;
  /** Private group (0153): how many people, the booker included (1..the offer's max_people). Default 1. */
  party_size?: unknown;
}

export interface CreatedRequest { token: string; ref: string; status: "unverified"; nextStep: BuyerStep; holdExpiresAt: string; maskedEmail: string }

function maskEmail(e: string): string {
  const [user, domain] = e.split("@");
  return `${user.slice(0, 1)}•••@${domain}`;
}

/** A platform ban (safety_blocks) or HER block of this person (fan_blocks, 0154). Callers answer as they would anyone. */
async function blocked(athleteId: string, kind: "email" | "phone", hash: string): Promise<boolean> {
  if (await isFanBlocked(athleteId, kind === "email" ? { emailHash: hash } : { emailHash: "", phoneHash: hash })) return true;
  const [r] = await db.select({ id: safetyBlocks.id }).from(safetyBlocks).where(and(
    eq(safetyBlocks.kind, kind), eq(safetyBlocks.value_hash, hash), isNull(safetyBlocks.lifted_at),
    or(eq(safetyBlocks.scope, "platform"), and(eq(safetyBlocks.scope, "athlete"), eq(safetyBlocks.athlete_id, athleteId))),
  )).limit(1);
  return !!r;
}

async function sendEmailCode(b: Pick<Booking, "id" | "buyer_email">, template: typeof BOOKING_TEMPLATES.emailCode | typeof BOOKING_TEMPLATES.accessCode): Promise<void> {
  const { code, hash } = newCode(b.id);
  await db.update(bookings).set({ otp_channel: "email", otp_hash: hash, otp_attempts: 0, otp_expires_at: new Date(Date.now() + BOOKINGS.otpMinutes * MIN), updated_at: new Date() })
    .where(eq(bookings.id, b.id));
  await sendTemplate(b.buyer_email, template, { code, minutes: BOOKINGS.otpMinutes, support: BOOKINGS.supportEmail });
}

type Problems = Array<{ field: string; problem: string }>;

interface Contact {
  name: string; email: string; phone: string; message: string; tz: string; parent: boolean; child: string;
}

/** Name, email, phone, message, time zone, 18+ (or the parent option when her offer allows minors), the terms. */
function parseContact(input: RequestInput, allowMinors: boolean, phoneRequired: boolean, bad: (f: string, p: string) => void): Contact {
  const name = typeof input.buyer_name === "string" ? input.buyer_name.trim().slice(0, 80) : "";
  if (name.length < 2) bad("buyer_name", "required");
  const email = typeof input.buyer_email === "string" ? input.buyer_email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) bad("buyer_email", "check your email address");
  // A mobile number is needed only to meet in person (owner, 22 Oct): for a video call the email code and the card hold
  // identify the buyer. A number given anyway is still checked.
  const phone = typeof input.buyer_phone === "string" ? normalisePhone(input.buyer_phone) : "";
  if ((phoneRequired || phone) && !/^\+?\d{10,15}$/.test(phone)) bad("buyer_phone", "a mobile number");
  const message = typeof input.message === "string" ? input.message.trim().slice(0, BOOKINGS.buyerMessageMaxChars) : "";
  const tz = typeof input.buyer_timezone === "string" && input.buyer_timezone.length <= 64 ? input.buyer_timezone : "";
  if (!tz) bad("buyer_timezone", "required");
  if (input.adult_attested !== true) bad("adult_attested", "you must be 18 or older (or a parent booking for your child)");
  if (input.agree_terms !== true) bad("agree_terms", "agree to the booking terms and cancellation rules");
  const parent = input.parent_booking === true;
  const child = typeof input.child_first_name === "string" ? input.child_first_name.trim().slice(0, 40) : "";
  if (parent && !allowMinors) bad("parent_booking", "this offer is for adults only");
  if (parent && !child) bad("child_first_name", "required");
  return { name, email, phone, message, tz, parent, child };
}

interface When { slotId: string | null; startsAt: Date | null; proposed: Array<{ start: string; tz: string | null }> | null; note: string }

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** One of her open slots (slots mode) or 1–3 suggested times (request mode), and the short note. */
async function parseWhen(o: Offer, slotId: unknown, times: unknown, noteRaw: unknown, now: Date, bad: (f: string, p: string) => void): Promise<When> {
  const w: When = { slotId: null, startsAt: null, proposed: null, note: "" };
  if (o.scheduling_mode === "slots") {
    const [s] = typeof slotId === "string" && UUID.test(slotId)
      ? await db.select().from(offerSlots).where(and(eq(offerSlots.id, slotId), eq(offerSlots.offer_id, o.id), isNull(offerSlots.withdrawn_at))).limit(1)
      : [];
    if (!s) bad("slot_id", "pick one of the times");
    else if (startProblem(s.starts_at, now) !== "none") bad("slot_id", "that time can't be booked any more");
    else { w.slotId = s.id; w.startsAt = s.starts_at; }
  } else {
    const p = parseProposedTimes(times, now);
    if (!p.ok) bad("proposed_times", p.problem); else w.proposed = p.times;
  }
  w.note = typeof noteRaw === "string" ? noteRaw.trim().slice(0, BOOKINGS.proposedNoteMaxChars) : "";
  return w;
}

/** A request from Ask Mila carries no contact yet: these stand in until the visitor's contact step (attachContact). */
const PENDING_HASH = "pending:";
export const needsContact = (b: Pick<Booking, "buyer_email_hash">): boolean => b.buyer_email_hash.startsWith(PENDING_HASH);

/**
 * Insert ONE unverified request. One / private_group: the slot is held at once by uq_bookings_live_slot (SLOT_TAKEN).
 * Open group: the slot's row is locked, then its live spots (the sum of live party sizes) are counted, so two fans can
 * never both take the last spot (SLOT_FULL); the same email can't hold two spots in one time (ALREADY_BOOKED).
 */
async function insertUnverified(o: Offer, w: When, c: Contact | null, eHash: string | null, partySize = 1): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const token = buyerTokenFor(id);
  const quote = quotePartyCharge(o.price_cents, partySize);
  const endsAt = w.startsAt ? new Date(w.startsAt.getTime() + o.duration_minutes * MIN) : null;
  try {
    const values: typeof bookings.$inferInsert = {
      id, athlete_id: o.athlete_id, offer_id: o.id, slot_id: w.slotId, status: "unverified",
      format: o.format, title: o.title, duration_minutes: o.duration_minutes, location_mode: o.location_mode,
      policy_key: o.policy_key, free_cancel_hours: o.free_cancel_hours,
      audience: o.audience, party_size: partySize, unit_price_cents: quote.unitPriceCents,
      approve_each_spot: o.audience === "open_group" && o.approve_each_spot,
      price_cents: quote.priceCents, service_fee_cents: quote.serviceFeeCents, buyer_total_cents: quote.buyerTotalCents, currency: quote.currency,
      buyer_name: c?.name ?? "", buyer_email: c?.email ?? "", buyer_phone: c?.phone || null, buyer_email_hash: eHash ?? `${PENDING_HASH}${id}`,
      buyer_message: c?.message || null, buyer_timezone: c?.tz ?? null, buyer_adult_attested: !!c,
      minor_attendee: !!c?.parent, parent_present_attested: !!c?.parent, minor_first_name: c?.parent ? c.child : null,
      buyer_token_hash: buyerTokenHash(token),
      identity_required: o.location_mode === "in_person" || o.require_id_verification,
      proposed_times: w.proposed, proposed_note: w.note || null, starts_at: w.startsAt, ends_at: endsAt,
    };
    if (o.audience === "open_group" && w.slotId) {
      const slotId = w.slotId;
      await db.transaction(async (tx) => {
        await tx.select({ id: offerSlots.id }).from(offerSlots).where(eq(offerSlots.id, slotId)).for("update");
        const live = await tx.select({ people: bookings.party_size, hash: bookings.buyer_email_hash }).from(bookings)
          .where(and(eq(bookings.slot_id, slotId), inArray(bookings.status, [...LIVE_STATUSES])));
        if (eHash && live.some((r) => r.hash === eHash)) throw coded("ALREADY_BOOKED");
        if (live.reduce((n, r) => n + r.people, 0) + partySize > o.max_people) throw coded("SLOT_FULL");
        await tx.insert(bookings).values(values);
      });
    } else {
      await db.insert(bookings).values(values);
    }
  } catch (err: any) {
    if (err?.code === "SLOT_FULL" || err?.code === "ALREADY_BOOKED") throw err;
    if (String(err?.message ?? "").includes("uq_bookings_live_slot") || err?.code === "23505") throw coded("SLOT_TAKEN");
    throw err;
  }
  return { id, token };
}

/** Too many unverified requests from one email at once. */
async function tooMany(eHash: string): Promise<boolean> {
  const [live] = await db.select({ n: count() }).from(bookings).where(and(eq(bookings.buyer_email_hash, eHash), eq(bookings.status, "unverified")));
  return (live?.n ?? 0) >= 3;
}

/** The buyer sends a request. Throws INVALID / PRICE_CHANGED / SLOT_TAKEN / UNAVAILABLE / TOO_MANY. */
export async function createRequest(publicId: string, input: RequestInput, now = new Date()): Promise<CreatedRequest> {
  const o = await publicOfferRow(publicId);
  if (o.status !== "published") throw coded("UNAVAILABLE");
  const problems: Problems = [];
  const bad = (field: string, problem: string) => problems.push({ field, problem });
  const c = parseContact(input, o.allow_minor_attendees, o.location_mode === "in_person", bad);
  const w = await parseWhen(o, input.slot_id, input.proposed_times, input.proposed_note, now, bad);
  const party = partySizeFor(o, input.party_size);
  if (party === null) bad("party_size", `1 to ${o.audience === "private_group" ? o.max_people : 1} people`);
  if (problems.length) throw coded("INVALID", problems);

  // The total they saw must be the live one FOR THE PEOPLE THEY PICKED (her per-person price × party, + the fee).
  const quote = quoteOf(o.price_cents, party!);
  if (input.displayed_total_cents !== quote.buyerTotalCents) throw coded("PRICE_CHANGED", quote);

  const eHash = emailHash(c.email);
  const holdExpiresAt = unverifiedHoldExpiresAt(now).toISOString();
  // A blocked or banned buyer: the same answer as everyone, nothing created, nothing sent.
  if (await blocked(o.athlete_id, "email", eHash) || (c.phone && await blocked(o.athlete_id, "phone", phoneHash(c.phone)))) {
    logger.info({ offer: o.id }, "request from a blocked buyer — answered as usual, nothing created");
    return { token: randomBytes(32).toString("base64url"), ref: bookingRef(randomUUID()), status: "unverified", nextStep: "email", holdExpiresAt, maskedEmail: maskEmail(c.email) };
  }
  if (await tooMany(eHash)) throw coded("TOO_MANY");
  const { id, token } = await insertUnverified(o, w, c, eHash, party!);
  await recordBookingEvent(id, "note", "buyer", { created: true });
  await sendEmailCode({ id, buyer_email: c.email }, BOOKING_TEMPLATES.emailCode);
  return { token, ref: bookingRef(id), status: "unverified", nextStep: "email", holdExpiresAt, maskedEmail: maskEmail(c.email) };
}

// ─── 2b. From Ask Mila: the request first, the contact step next ────────────────────────────────────────────────

export interface AskMilaRequest {
  athleteId: string; offerPublicId: string; slotId: string | null; times: string[] | null; note: string | null; askMilaSessionId: string;
}

/**
 * Ask Mila's request card, tapped by the visitor (never the model): ONE unverified request that holds the time for the
 * unverified hold (15 min), with no contact yet — the visitor gives name, email, phone and the 18+ answer on the next
 * page (attachContact), which sends the email code. Nothing reaches her until every check and the card hold are done.
 * The athlete id is the one the server resolved from the handle: an offer of anyone else is "unavailable".
 */
export async function createPendingFromAsk(r: AskMilaRequest, now = new Date()): Promise<
  { ok: true; ref: string; token: string } | { ok: false; reason: "slot_taken" | "unavailable" | "invalid" }> {
  let o: Offer;
  try { o = await publicOfferRow(r.offerPublicId); } catch { return { ok: false, reason: "unavailable" }; }
  if (o.athlete_id !== r.athleteId || o.status !== "published") return { ok: false, reason: "unavailable" };
  if ((r.slotId === null) === (r.times === null)) return { ok: false, reason: "invalid" };
  if (o.scheduling_mode === "slots" ? r.slotId === null : r.times === null) return { ok: false, reason: "invalid" };
  if (typeof r.askMilaSessionId !== "string" || !r.askMilaSessionId || r.askMilaSessionId.length > 100) return { ok: false, reason: "invalid" };
  const problems: Problems = [];
  const w = await parseWhen(o, r.slotId, r.times, r.note, now, (field, problem) => problems.push({ field, problem }));
  if (problems.length) return { ok: false, reason: problems.some((p) => p.field === "slot_id" && p.problem !== "pick one of the times") ? "slot_taken" : "invalid" };
  try {
    const { id, token } = await insertUnverified(o, w, null, null);
    await recordBookingEvent(id, "note", "buyer", { created: true, source: "ask_mila", ask_mila_session_id: r.askMilaSessionId });
    return { ok: true, ref: bookingRef(id), token };
  } catch (err: any) {
    if (err?.code === "SLOT_TAKEN" || err?.code === "SLOT_FULL") return { ok: false, reason: "slot_taken" };
    throw err;
  }
}

/**
 * The contact step for a request that started in Ask Mila: the same checks as a direct request (name, email, phone,
 * 18+, the terms, the price they see), then the email code. A blocked buyer gets the same answer and the request
 * quietly ends. Throws CONTACT_DONE / HOLD_LAPSED / INVALID / PRICE_CHANGED / TOO_MANY.
 */
export async function attachContact(b: Booking, input: RequestInput, now = new Date()): Promise<{ nextStep: BuyerStep; maskedEmail: string }> {
  if (b.status !== "unverified") throw coded("WRONG_STATE", { status: b.status });
  if (!needsContact(b)) throw coded("CONTACT_DONE");
  if (now > unverifiedHoldExpiresAt(b.created_at)) throw coded("HOLD_LAPSED");
  const [o] = await db.select().from(offers).where(eq(offers.id, b.offer_id)).limit(1);
  if (!o || o.status !== "published") throw coded("UNAVAILABLE");
  const problems: Problems = [];
  const c = parseContact(input, o.allow_minor_attendees, o.location_mode === "in_person", (field, problem) => problems.push({ field, problem }));
  if (problems.length) throw coded("INVALID", problems);
  if (input.displayed_total_cents !== b.buyer_total_cents) throw coded("PRICE_CHANGED", bookingQuote(b));
  const eHash = emailHash(c.email);
  if (await blocked(b.athlete_id, "email", eHash) || (c.phone && await blocked(b.athlete_id, "phone", phoneHash(c.phone)))) {
    logger.info({ booking: b.id }, "contact from a blocked buyer — answered as usual, the request ends");
    await transition({ bookingId: b.id, from: "unverified", to: "expired", actor: "system", data: { blocked: true } }).catch(() => undefined);
    return { nextStep: "email", maskedEmail: maskEmail(c.email) };
  }
  if (await tooMany(eHash)) throw coded("TOO_MANY");
  const [row] = await db.update(bookings).set({
    buyer_name: c.name, buyer_email: c.email, buyer_phone: c.phone || null, buyer_email_hash: eHash, buyer_message: c.message || null,
    buyer_timezone: c.tz, buyer_adult_attested: true, minor_attendee: c.parent, parent_present_attested: c.parent,
    minor_first_name: c.parent ? c.child : null, updated_at: now,
  }).where(and(eq(bookings.id, b.id), eq(bookings.status, "unverified"), eq(bookings.buyer_email_hash, b.buyer_email_hash))).returning();
  if (!row) throw coded("WRONG_STATE");
  await sendEmailCode(row, BOOKING_TEMPLATES.emailCode);
  return { nextStep: "email", maskedEmail: maskEmail(c.email) };
}

// ─── 3. Codes + the hold ────────────────────────────────────────────────────────────────────────────────────────

/** The booking a private-link token opens, or NOT_FOUND. */
export async function bookingByToken(token: unknown): Promise<Booking> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) throw coded("NOT_FOUND");
  const [b] = await db.select().from(bookings).where(eq(bookings.buyer_token_hash, buyerTokenHash(token))).limit(1);
  if (!b || b.buyer_redacted_at) throw coded("NOT_FOUND");
  return b;
}

function nextStepOf(b: Booking, held: boolean): BuyerStep {
  if (needsContact(b)) return "contact";
  if (!b.email_verified_at) return "email";
  if (!b.phone_verified_at && b.location_mode === "in_person") return "phone";
  if (b.identity_required && b.identity_status !== "verified") return "identity";
  if (!held && b.status === "unverified") return "card";
  return "done";
}

/** Resend the email code (verification, or a fresh access code later). 30 seconds apart. */
export async function resendEmailCode(b: Booking, purpose: "verify" | "access"): Promise<{ sent: true; resendAfterSeconds: number }> {
  if (needsContact(b)) throw coded("CONTACT_FIRST");
  if (purpose === "verify" && b.email_verified_at) throw coded("ALREADY_CONFIRMED");
  if (purpose === "access" && !b.email_verified_at) throw coded("VERIFY_FIRST");
  const sentAt = b.otp_expires_at ? b.otp_expires_at.getTime() - BOOKINGS.otpMinutes * MIN : 0;
  if (Date.now() - sentAt < BOOKINGS.otpResendSeconds * 1_000) throw coded("WAIT", { seconds: BOOKINGS.otpResendSeconds });
  await sendEmailCode(b, purpose === "verify" ? BOOKING_TEMPLATES.emailCode : BOOKING_TEMPLATES.accessCode);
  return { sent: true, resendAfterSeconds: BOOKINGS.otpResendSeconds };
}

/** Check an email code. A right code confirms the email (first time) and returns an access key. */
export async function checkEmailCode(b: Booking, code: unknown): Promise<{ access: string; accessExpiresAt: string; nextStep: BuyerStep }> {
  if (!b.otp_hash || b.otp_channel !== "email") throw coded("NO_CODE");
  if (b.otp_attempts >= BOOKINGS.otpMaxAttempts) throw coded("TOO_MANY_TRIES");
  if (!b.otp_expires_at || b.otp_expires_at.getTime() < Date.now()) {
    await sendEmailCode(b, b.email_verified_at ? BOOKING_TEMPLATES.accessCode : BOOKING_TEMPLATES.emailCode);
    throw coded("CODE_EXPIRED");
  }
  if (!codeMatches(b.id, code, b.otp_hash)) {
    const [r] = await db.update(bookings).set({ otp_attempts: sql`${bookings.otp_attempts} + 1` }).where(eq(bookings.id, b.id)).returning({ n: bookings.otp_attempts });
    throw coded("WRONG_CODE", { triesLeft: Math.max(0, BOOKINGS.otpMaxAttempts - (r?.n ?? BOOKINGS.otpMaxAttempts)) });
  }
  const [row] = await db.update(bookings).set({
    otp_hash: null, otp_channel: null, otp_expires_at: null, otp_attempts: 0,
    email_verified_at: b.email_verified_at ?? new Date(), updated_at: new Date(),
  }).where(eq(bookings.id, b.id)).returning();
  const exp = new Date(Date.now() + BOOKINGS.buyerAccessHours * HOUR);
  return { access: accessKeyFor(b.id, exp), accessExpiresAt: exp.toISOString(), nextStep: nextStepOf(row, false) };
}

export function requireAccess(b: Booking, key: unknown): void {
  if (!accessKeyValid(b.id, key)) throw coded("ACCESS_REQUIRED");
}

/** The phone code: the Firebase token must prove the number they gave. */
export async function confirmPhone(b: Booking, idToken: unknown): Promise<{ nextStep: BuyerStep }> {
  if (b.status !== "unverified") throw coded("WRONG_STATE");
  if (!b.email_verified_at) throw coded("VERIFY_FIRST");
  if (b.phone_verified_at) return { nextStep: nextStepOf(b, false) };
  const proven = await verifiedPhoneFromFirebase(idToken);
  if (!proven || normalisePhone(proven) !== normalisePhone(b.buyer_phone ?? "")) throw coded("PHONE_NOT_CONFIRMED");
  const pHash = phoneHash(proven);
  if (await blocked(b.athlete_id, "phone", pHash)) {
    await transition({ bookingId: b.id, from: "unverified", to: "expired", actor: "system", data: { blocked: true } }).catch(() => undefined);
    throw coded("PHONE_NOT_CONFIRMED");
  }
  const [row] = await db.update(bookings).set({ phone_verified_at: new Date(), buyer_phone_hash: pHash, updated_at: new Date() }).where(eq(bookings.id, b.id)).returning();
  return { nextStep: nextStepOf(row, false) };
}

export async function startIdentity(b: Booking): Promise<{ url: string }> {
  if (b.status !== "unverified") throw coded("WRONG_STATE");
  if (!b.email_verified_at || (b.location_mode === "in_person" && !b.phone_verified_at)) throw coded("VERIFY_FIRST");
  return startIdentityCheck(b);
}

export async function refreshIdentity(b: Booking): Promise<{ status: string | null; nextStep: BuyerStep }> {
  const st = await refreshIdentityCheck(b);
  const [row] = await db.select().from(bookings).where(eq(bookings.id, b.id));
  return { status: st, nextStep: nextStepOf(row, false) };
}

/** Her rule "returning buyers only": someone she has had a released booking with before. */
async function isReturningBuyer(b: Booking): Promise<boolean> {
  const [r] = await db.select({ id: bookings.id }).from(bookings).where(and(
    eq(bookings.athlete_id, b.athlete_id), eq(bookings.buyer_email_hash, b.buyer_email_hash), eq(bookings.status, "released"))).limit(1);
  return !!r;
}

/** The card step: the hold Checkout. Throws HOLD_LAPSED once the unverified hold is over (the slot reopened). */
export async function startHold(b: Booking, now = new Date()): Promise<{ url: string } | { alreadyHeld: true }> {
  if (b.status !== "unverified") throw coded("WRONG_STATE", { status: b.status });
  const p = await paymentFor(b.id);
  const sessionOpen = p?.status === "pending" && p.checkout_expires_at && p.checkout_expires_at > now;
  if (!sessionOpen && now > unverifiedHoldExpiresAt(b.created_at)) throw coded("HOLD_LAPSED");
  const [o] = await db.select({ returning: offers.returning_buyers_only, status: offers.status }).from(offers).where(eq(offers.id, b.offer_id)).limit(1);
  if (o?.status !== "published") throw coded("UNAVAILABLE");
  // She blocked them after the request started (0154): the request quietly ends, with the same answer as any time
  // that's no longer available.
  if (await blocked(b.athlete_id, "email", b.buyer_email_hash) || (b.buyer_phone_hash && await blocked(b.athlete_id, "phone", b.buyer_phone_hash))) {
    await transition({ bookingId: b.id, from: "unverified", to: "expired", actor: "system", data: { blocked: true } }).catch(() => undefined);
    throw coded("UNAVAILABLE");
  }
  if (o.returning && !(await isReturningBuyer(b))) {
    await transition({ bookingId: b.id, from: "unverified", to: "expired", actor: "system", data: { rule: "returning_buyers_only" } }).catch(() => undefined);
    throw coded("RETURNING_ONLY");
  }
  return createHoldCheckout(b.id);
}

export async function confirmHoldReturn(b: Booking): Promise<boolean> {
  return syncHoldForBooking(b.id);
}

// ─── 4. The private page and the buyer's taps ───────────────────────────────────────────────────────────────────

export async function buyerView(b: Booking, now = new Date()): Promise<BuyerBookingView> {
  const p = await paymentFor(b.id);
  const { first } = await athleteFirstName(b.athlete_id);
  const s = b.status;
  const athleteTimes = Array.isArray(b.athlete_proposed_times) ? (b.athlete_proposed_times as BuyerBookingView["athleteProposedTimes"]) : [];
  const funded = ["confirmed", "in_review", "issue_reported", "disputed", "released"].includes(s);
  const started = !!b.starts_at && now >= b.starts_at;
  const ended = !!b.ends_at && now >= b.ends_at;
  let phase: BuyerBookingView["phase"] = "closed";
  if (s === "unverified") phase = "verifying";
  else if (s === "requested") phase = athleteTimes.length ? "pick_time" : "waiting";
  else if (s === "accepted") phase = p?.status === "authorized" ? "waiting" : "pay";
  else if (s === "confirmed") phase = ended ? "after" : "booked";
  else if (s === "in_review") phase = "after";
  else if (s === "issue_reported" || s === "disputed") phase = "on_hold";
  const quote = bookingQuote(b);
  const guests = b.audience === "private_group" ? await guestViews(b.id) : [];
  const [o] = b.audience === "open_group" ? await db.select({ max: offers.max_people }).from(offers).where(eq(offers.id, b.offer_id)).limit(1) : [];
  return {
    ref: bookingRef(b.id), status: s as BuyerBookingView["status"], phase, nextStep: nextStepOf(b, p?.status === "authorized"),
    athleteFirstName: first, title: b.title, format: b.format as BuyerBookingView["format"], locationMode: b.location_mode as BuyerBookingView["locationMode"],
    startsAt: b.starts_at?.toISOString() ?? null, endsAt: b.ends_at?.toISOString() ?? null,
    proposedTimes: Array.isArray(b.proposed_times) ? (b.proposed_times as BuyerBookingView["proposedTimes"]) : [],
    athleteProposedTimes: athleteTimes, respondBy: b.respond_by?.toISOString() ?? null, payBy: b.pay_by?.toISOString() ?? null,
    quote, freeCancelHours: b.free_cancel_hours,
    freeCancelUntil: b.starts_at ? new Date(b.starts_at.getTime() - b.free_cancel_hours * HOUR).toISOString() : null,
    venue: funded ? b.venue : null, meetingLink: funded ? b.meeting_link : null,
    holdPlaced: p?.status === "authorized", charged: !!p && ["funded", "settled", "disputed", "refunded", "charged_back"].includes(p.status),
    canceledBy: (b.canceled_by as BuyerBookingView["canceledBy"]) ?? null, refundOutcome: (b.refund_outcome as BuyerBookingView["refundOutcome"]) ?? null,
    noShowBy: (b.no_show_by as BuyerBookingView["noShowBy"]) ?? null, athleteDoneAt: b.athlete_done_at?.toISOString() ?? null,
    releaseDueAt: b.release_due_at?.toISOString() ?? null,
    sessionUrl: buyerSessionUrl(b, funded, now),
    actions: {
      withdraw: s === "unverified" || s === "requested" || (s === "accepted" && p?.status !== "funded"),
      cancel: s === "confirmed" && !started,
      pickTime: s === "requested" && athleteTimes.length > 0,
      message: !["unverified", "declined", "withdrawn", "expired", "canceled", "refunded"].includes(s),
      guests: guestsOpen(b, now),
    },
    audience: b.audience as BuyerBookingView["audience"], partySize: b.party_size, unitPriceCents: unitPriceOf(b),
    groupSpots: o?.max ?? null, approveEachSpot: b.approve_each_spot,
    guests, guestsLeft: b.audience === "private_group" ? Math.max(0, b.party_size - 1 - guests.length) : 0,
    supportEmail: BOOKINGS.supportEmail,
  };
}

/** The signed /s/ link for a paid video call (null when not funded, in person, or the link secret isn't configured). */
function buyerSessionUrl(b: Booking, funded: boolean, now: Date): string | null {
  if (!funded || b.location_mode === "in_person") return null;
  try { return sessionUrlFor({ id: b.id, startsAt: b.starts_at, endsAt: b.ends_at }, now); } catch { return null; }
}

export async function withdrawBooking(b: Booking): Promise<BuyerBookingView> {
  const p = await paymentFor(b.id);
  if (b.status === "accepted" && p?.status === "funded") throw coded("WRONG_STATE");
  let row: Booking;
  try { row = await transition({ bookingId: b.id, from: ["unverified", "requested", "accepted"], to: "withdrawn", actor: "buyer" }); }
  catch (err) { throw err instanceof TransitionError ? coded("WRONG_STATE", { status: err.current }) : err; }
  if (p) await cancelHold(p, "withdrawn");
  if (b.status !== "unverified") await notices.withdrawn(row, true);
  return buyerView(row);
}

/** The buyer picks one of her suggested times; she then accepts as usual (her tap captures). */
export async function pickTime(b: Booking, start: unknown): Promise<BuyerBookingView> {
  if (b.status !== "requested") throw coded("WRONG_STATE");
  const options = Array.isArray(b.athlete_proposed_times) ? (b.athlete_proposed_times as Array<{ start: string; tz: string | null }>) : [];
  const want = typeof start === "string" ? new Date(start) : null;
  const pick = want && Number.isFinite(want.getTime()) ? options.find((t) => t.start === want.toISOString()) : undefined;
  if (!pick) throw coded("INVALID", [{ field: "start", problem: "one of the suggested times" }]);
  const [row] = await db.update(bookings).set({
    proposed_times: [{ start: pick.start, tz: b.buyer_timezone }], athlete_proposed_times: null,
    slot_id: null, starts_at: null, ends_at: null, updated_at: new Date(),
  }).where(and(eq(bookings.id, b.id), eq(bookings.status, "requested"))).returning();
  if (!row) throw coded("WRONG_STATE");
  await recordBookingEvent(b.id, "note", "buyer", { picked: true });
  await notices.athletePickedTime(row);
  return buyerView(row);
}

export async function buyerCancelPreview(b: Booking, now = new Date()): Promise<BuyerCancelPreviewView> {
  if (b.status !== "confirmed") throw coded("WRONG_STATE");
  const q = cancelQuote(b, "buyer", now);
  return { refundCents: q.refundCents, keptCents: q.keptCents, inWindow: q.outcome === "price_only", freeUntil: q.freeUntil };
}

/** The buyer cancels: her price back inside her window (the fee is kept); later, no refund and she's paid on the clock. */
export async function cancelByBuyer(b: Booking, now = new Date()): Promise<BuyerBookingView> {
  if (b.starts_at && now >= b.starts_at) throw coded("STARTED");
  const q = cancelQuote(b, "buyer", now);
  let row: Booking;
  try {
    row = await transition({
      bookingId: b.id, from: "confirmed", to: "canceled", actor: "buyer",
      patch: { canceled_at: now, canceled_by: "buyer", refund_outcome: q.outcome, ...(q.outcome === "none" && b.ends_at ? { release_due_at: releaseDueAt(b.ends_at) } : {}) },
      data: { refund_cents: q.refundCents, cause: q.cause },
    });
  } catch (err) { throw err instanceof TransitionError ? coded("WRONG_STATE", { status: err.current }) : err; }
  const p = await paymentFor(b.id);
  if (p && q.refundCents > 0) {
    try { await refundBookingPayment(p, q.refundCents, "buyer", "buyer cancelled in the free window"); }
    catch { /* recorded; the sweeper retries */ }
  }
  await notices.canceledByBuyer(row, q.refundCents);
  return buyerView(row);
}

/** The pay link after a failed capture: the one open Checkout (reused), or a fresh one until pay_by. */
export async function buyerPayLink(b: Booking): Promise<{ url: string }> {
  const p = await paymentFor(b.id);
  if (b.status !== "accepted" || !p || p.status === "authorized" || p.status === "funded") throw coded("WRONG_STATE");
  if (!b.pay_by || b.pay_by < new Date()) throw coded("EXPIRED");
  if (p.stripe_checkout_session_id) {   // one open session per payment: reuse it while it has time left
    const open = await getStripe().checkout.sessions.retrieve(p.stripe_checkout_session_id).catch(() => null);
    if (open?.status === "open" && open.url && open.metadata?.stage === "pay" && (open.expires_at ?? 0) * 1000 - Date.now() > 5 * MIN) return { url: open.url };
  }
  return { url: await createPayLink(b, p, b.pay_by) };
}
