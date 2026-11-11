/**
 * bookings/guests.ts — the friends a PRIVATE-group booker brings (0153).
 *
 *   who can invite   the booker, from their private booking page (/b/:token, with the access key), once the booking is
 *                    paid (confirmed) and until the session ends; up to party_size − 1 friends (the booker is one of
 *                    the party). Removing a friend frees the place for someone else.
 *   what a guest gets an email with THEIR OWN call link (/s/:token, purpose "guest", signed for the booking_guests row;
 *                    nothing stored). The page shows the athlete and the session, never the booker's details beyond
 *                    their first name in the call. Guests never pay and have no money taps ("It happened", reports).
 *   removing         revoked_at: the link stops working at once, and if they are in the call they are taken out.
 *
 * Guests' emails are only ever used to send that one link (and the "opens in 10 minutes" reminder). Never shown to her.
 */
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { bookingGuests, bookings } from "../../../shared/schema";
import type { Booking, BookingGuest } from "../../../shared/schema";
import type { GuestView } from "../../../shared/bookingsApi";
import { createLogger } from "../../logger";
import { sendTemplate } from "../notify/templates";
import { BOOKING_TEMPLATES } from "../notify/templates/bookings";
import { BOOKINGS } from "./config";
import { athleteFirstName, coded, formatWhen } from "./common";
import { emailHash, normaliseEmail } from "./tokens";
import { recordBookingEvent } from "./stateMachine";
import { verifySessionLink } from "./session/sessionLink";
import { guestSessionUrlFor, markRemovedFromCall } from "./session/sessionStore";
import { guestIdentityFor, roomFor } from "./session/sessionRoom";
import { removeFromRoom } from "./session/roomAdmin";
import { isFanBlocked } from "../fanSafety/fanBlocks";

const logger = createLogger("bookings/guests");
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A private-group booker can invite (and remove) friends once the booking is paid, until the session ends. */
export function guestsOpen(b: Pick<Booking, "audience" | "party_size" | "status" | "ends_at">, now = new Date()): boolean {
  return b.audience === "private_group" && b.party_size > 1 && b.status === "confirmed" && (!b.ends_at || now < b.ends_at);
}

export async function liveGuests(bookingId: string): Promise<BookingGuest[]> {
  return db.select().from(bookingGuests)
    .where(and(eq(bookingGuests.booking_id, bookingId), isNull(bookingGuests.revoked_at))).orderBy(asc(bookingGuests.created_at));
}

/** The booker's own list (they typed these addresses). */
export async function guestViews(bookingId: string): Promise<GuestView[]> {
  return (await liveGuests(bookingId)).map((g) => ({ id: g.id, name: g.name, email: g.email, invitedAt: g.invited_at?.toISOString() ?? null }));
}

/** Her side: first names only. */
export async function guestNames(bookingId: string): Promise<Array<{ name: string | null }>> {
  return (await liveGuests(bookingId)).map((g) => ({ name: g.name }));
}

function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0]?.slice(0, 40) ?? "";
}

/** The friend's invite: the session, the athlete's first name, the booker's first name and THEIR OWN call link. */
async function sendInvite(b: Booking, g: BookingGuest, now = new Date()): Promise<boolean> {
  const { first } = await athleteFirstName(b.athlete_id);
  let link: string;
  try { link = guestSessionUrlFor(g.id, { startsAt: b.starts_at, endsAt: b.ends_at }, now); }
  catch (err: any) { logger.warn({ error: err?.message }, "no guest link (session link secret missing)"); return false; }
  const r = await sendTemplate(g.email, BOOKING_TEMPLATES.guestInvite, {
    support: BOOKINGS.supportEmail, first, inviter: firstWord(b.buyer_name) || "A friend", title: b.title,
    when: formatWhen(b.starts_at, b.buyer_timezone), people: b.party_size, link,
  }).catch(() => null);
  await db.update(bookingGuests).set({ invited_at: now }).where(eq(bookingGuests.id, g.id));
  return !!r;
}

export interface GuestInput { email?: unknown; name?: unknown }

/** Add one friend (or several: `{ guests: [...] }`). Throws WRONG_STATE / INVALID / GUESTS_FULL / ALREADY_INVITED. */
export async function addGuests(b: Booking, body: { guests?: unknown } & GuestInput, now = new Date()): Promise<GuestView[]> {
  if (!guestsOpen(b, now)) throw coded("WRONG_STATE", { status: b.status });
  const list: GuestInput[] = Array.isArray(body.guests) ? body.guests.slice(0, 20) : [body];
  if (!list.length) throw coded("INVALID", [{ field: "email", problem: "required" }]);
  const own = emailHash(normaliseEmail(b.buyer_email));
  for (const raw of list) {
    const email = typeof raw?.email === "string" ? normaliseEmail(raw.email) : "";
    if (!EMAIL_RE.test(email)) throw coded("INVALID", [{ field: "email", problem: "check the email address" }]);
    const hash = emailHash(email);
    if (hash === own) throw coded("INVALID", [{ field: "email", problem: "that's your own email: you're already in" }]);
    // Someone she blocked can't come in as a friend (0154). The same neutral answer whoever typed the address.
    if (await isFanBlocked(b.athlete_id, { emailHash: hash })) throw coded("CANT_INVITE");
    const name = typeof raw?.name === "string" ? firstWord(raw.name) || null : null;
    // One place per friend; the count and the insert under a lock on the booking row, so two taps can't overfill it.
    const g = await db.transaction(async (tx) => {
      await tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.id, b.id)).for("update");
      const [n] = await tx.select({ n: count() }).from(bookingGuests).where(and(eq(bookingGuests.booking_id, b.id), isNull(bookingGuests.revoked_at)));
      if ((n?.n ?? 0) >= b.party_size - 1) throw coded("GUESTS_FULL", { max: b.party_size - 1 });
      const [dupe] = await tx.select({ id: bookingGuests.id }).from(bookingGuests)
        .where(and(eq(bookingGuests.booking_id, b.id), eq(bookingGuests.email_hash, hash), isNull(bookingGuests.revoked_at))).limit(1);
      if (dupe) throw coded("ALREADY_INVITED");
      const [row] = await tx.insert(bookingGuests).values({ booking_id: b.id, name, email, email_hash: hash }).returning();
      return row;
    });
    await recordBookingEvent(b.id, "note", "buyer", { guest_added: g.id });
    await sendInvite(b, g, now);
  }
  return guestViews(b.id);
}

/** Remove a friend: their link stops working at once, and if they are in the call they are taken out. */
export async function removeGuest(b: Booking, guestId: unknown, now = new Date()): Promise<GuestView[]> {
  if (b.audience !== "private_group") throw coded("WRONG_STATE");
  if (typeof guestId !== "string" || !UUID.test(guestId)) throw coded("NOT_FOUND");
  const [g] = await db.update(bookingGuests).set({ revoked_at: now })
    .where(and(eq(bookingGuests.id, guestId), eq(bookingGuests.booking_id, b.id), isNull(bookingGuests.revoked_at))).returning();
  if (!g) throw coded("NOT_FOUND");
  await recordBookingEvent(b.id, "note", "buyer", { guest_removed: g.id });
  await markRemovedFromCall(b.id, `guest:${g.id}`);
  await removeFromRoom(roomFor({ id: b.id, audience: "private_group", slotId: b.slot_id }), guestIdentityFor(g.id)).catch(() => false);
  return guestViews(b.id);
}

/** Send the invite again (a friend lost the email). One per guest per minute. */
export async function resendGuestInvite(b: Booking, guestId: unknown, now = new Date()): Promise<GuestView[]> {
  if (!guestsOpen(b, now)) throw coded("WRONG_STATE", { status: b.status });
  const g = (await liveGuests(b.id)).find((x) => x.id === guestId);
  if (!g) throw coded("NOT_FOUND");
  if (g.invited_at && now.getTime() - g.invited_at.getTime() < 60_000) throw coded("WAIT", { seconds: 60 });
  await sendInvite(b, g, now);
  return guestViews(b.id);
}

/**
 * The guest a presented /s/ token names (purpose "guest"), with their booking — or null for anything else, a revoked
 * guest, or a booking whose buyer data was minimised. Throws SessionLinkConfigError only with no signing secret.
 */
export async function guestByLink(token: unknown, now = new Date()): Promise<{ guest: BookingGuest; bookingId: string } | null> {
  const id = verifySessionLink(token, "guest", now);
  if (!id) return null;
  const [g] = await db.select().from(bookingGuests).where(eq(bookingGuests.id, id)).limit(1);
  if (!g || g.revoked_at) return null;
  const [b] = await db.select({ redacted: bookings.buyer_redacted_at, audience: bookings.audience }).from(bookings).where(eq(bookings.id, g.booking_id)).limit(1);
  if (!b || b.redacted || b.audience !== "private_group") return null;
  return { guest: g, bookingId: g.booking_id };
}

/** Minimise guests with the booking's buyer data (the sweeper's purge / redaction). */
export async function redactGuests(bookingId: string, now = new Date()): Promise<void> {
  await db.update(bookingGuests).set({ email: "removed@invalid", name: null, revoked_at: now })
    .where(and(eq(bookingGuests.booking_id, bookingId)));
}
