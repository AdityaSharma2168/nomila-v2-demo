/**
 * bookings/notices.ts — who gets which email when a booking moves. Email only for now (SMS later, after A2P 10DLC).
 * Every function here is best-effort and never throws: a notice that can't go out never undoes the action. With no
 * email provider configured the shared sender logs "would send" (template name only).
 *
 * The buyer's notices go to the address they confirmed with a code. Hers go to her account email and never carry the
 * buyer's contact details. Support gets a reference, a category and the reported text — no contact details.
 */
import type { Booking } from "../../../shared/schema";
import { sendTemplate } from "../notify/templates";
import { BOOKING_TEMPLATES as T } from "../notify/templates/bookings";
import { createLogger } from "../../logger";
import { BOOKINGS } from "./config";
import { athleteFirstName, buyerLabel, buyerPageUrl, formatWhen, supportVars, usd } from "./common";
import { bookingRef } from "./tokens";
import { pushBooking } from "./push";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { offers } from "../../../shared/schema";
import { phoneZone } from "./offers";

const logger = createLogger("bookings/notices");

type B = Pick<Booking, "id" | "athlete_id" | "title" | "buyer_name" | "buyer_email" | "buyer_timezone" | "starts_at" | "buyer_total_cents" | "price_cents" | "free_cancel_hours" | "respond_by" | "release_due_at" | "venue" | "meeting_mode" | "location_mode" | "identity_status" | "email_verified_at" | "phone_verified_at" | "status">
  & Partial<Pick<Booking, "audience" | "party_size">>;

/** " · Group session, 3 people" (private group) / " · Group session" (open group) / "" (1:1): appended to the title. */
export function groupLine(b: Partial<Pick<Booking, "audience" | "party_size">>): string {
  if (b.audience === "private_group") return ` · Group session, ${b.party_size ?? 1} ${(b.party_size ?? 1) === 1 ? "person" : "people"}`;
  if (b.audience === "open_group") return " · Group session";
  return "";
}

async function base(b: B) {
  const { first, email } = await athleteFirstName(b.athlete_id);
  return {
    athleteEmail: email,
    vars: {
      ...supportVars(),
      group: groupLine(b),
      guestLine: b.audience === "private_group" && (b.party_size ?? 1) > 1
        ? `Bringing friends? Add their emails on your booking page and each gets their own link to the call (up to ${(b.party_size ?? 1) - 1}).`
        : "",
      first, title: b.title, buyer: buyerLabel(b.buyer_name),
      when: formatWhen(b.starts_at, b.buyer_timezone),
      total: usd(b.buyer_total_cents), price: usd(b.price_cents),
      freeHours: b.free_cancel_hours, respondHours: BOOKINGS.respondHours,
      respondBy: formatWhen(b.respond_by, b.buyer_timezone),
      releaseBy: formatWhen(b.release_due_at, b.buyer_timezone),
      link: buyerPageUrl(b.id) ?? "",
      ref: bookingRef(b.id),
    },
  };
}

/** Her own clock for her notices: the offer's zone (0137), else her phone's, else UTC (formatWhen's fallback). */
async function athleteZone(b: Pick<Booking, "athlete_id"> & { offer_id?: string }): Promise<string | null> {
  try {
    if (b.offer_id) {
      const [o] = await db.select({ tz: offers.time_zone }).from(offers).where(eq(offers.id, b.offer_id)).limit(1);
      if (o?.tz) return o.tz;
    }
    return await phoneZone(b.athlete_id);
  } catch { return null; }
}

async function safe(what: string, f: () => Promise<unknown>): Promise<void> {
  try { await f(); } catch (err: any) { logger.warn({ what, error: err.message }, "booking notice failed"); }
}

/** The buyer's address only once they confirmed it with a code. */
const buyerTo = (b: B) => (b.email_verified_at ? b.buyer_email : null);

export const notices = {
  requestSent: (b: B) => safe("requestSent", async () => {
    const { vars, athleteEmail } = await base(b);
    await sendTemplate(buyerTo(b), T.requestSent, vars);
    const idLine = b.identity_status === "verified" ? " ID checked by Stripe" : "";
    const phoneLine = b.phone_verified_at ? " Phone ✓" : "";   // a phone code only to meet in person (22 Oct)
    await sendTemplate(athleteEmail, T.athleteNewRequest, { ...vars, idLine, phoneLine });
    pushBooking(b, "new_request");
  }),
  accepted: (b: B) => safe("accepted", async () => {
    const { vars } = await base(b);
    const where = b.location_mode === "in_person"
      ? `Where: ${b.venue ?? "the place in your booking"}.`
      : "Join from your booking page; the call opens 10 minutes before. Nomila doesn't record calls.";
    await sendTemplate(buyerTo(b), T.acceptedCharged, { ...vars, where });
  }),
  /** Open group (0153): the spot is confirmed by itself once the card is charged — "You're in", and a line to her. */
  groupJoined: (b: B, taken: number, spots: number) => safe("groupJoined", async () => {
    const { vars, athleteEmail } = await base(b);
    const where = b.location_mode === "in_person"
      ? `Where: ${b.venue ?? "the place in your booking"}.`
      : "Join from your booking page; the call opens 10 minutes before. Nomila doesn't record calls.";
    await sendTemplate(buyerTo(b), T.groupJoined, { ...vars, where, people: b.party_size ?? 1, spots });
    await sendTemplate(athleteEmail, T.athleteGroupSignup, { ...vars, when: formatWhen(b.starts_at, await athleteZone(b)), taken, spots });
    pushBooking(b, "group_signup");
  }),
  acceptedPayLink: (b: B, payLink: string, payBy: Date) => safe("acceptedPayLink", async () => {
    const { vars } = await base(b);
    await sendTemplate(buyerTo(b), T.acceptedPayLink, { ...vars, payLink, payBy: formatWhen(payBy, b.buyer_timezone) });
  }),
  declined: (b: B) => safe("declined", async () => { const { vars } = await base(b); await sendTemplate(buyerTo(b), T.declined, vars); }),
  expired: (b: B) => safe("expired", async () => { const { vars } = await base(b); await sendTemplate(buyerTo(b), T.expired, vars); }),
  expiredUnpaid: (b: B) => safe("expiredUnpaid", async () => { const { vars } = await base(b); await sendTemplate(buyerTo(b), T.expiredUnpaid, vars); }),
  withdrawn: (b: B, notifyAthlete: boolean) => safe("withdrawn", async () => {
    const { vars, athleteEmail } = await base(b);
    await sendTemplate(buyerTo(b), T.withdrawn, vars);
    if (notifyAthlete) await sendTemplate(athleteEmail, T.athleteWithdrawn, vars);
  }),
  canceledByAthlete: (b: B, refundCents: number, reason: string) => safe("canceledByAthlete", async () => {
    const { vars } = await base(b);
    await sendTemplate(buyerTo(b), T.canceledByAthlete, { ...vars, refund: usd(refundCents), reason: reason || "No reason given." });
  }),
  canceledByBuyer: (b: B, refundCents: number) => safe("canceledByBuyer", async () => {
    const { vars, athleteEmail } = await base(b);
    const refundLine = refundCents > 0
      ? `You'll get ${usd(refundCents)} back in 5–10 days. The Nomila service fee isn't refundable.`
      : "It was less than the cancellation window before the start, so there's no refund.";
    await sendTemplate(buyerTo(b), T.canceledByBuyer, { ...vars, refundLine });
    const payLine = refundCents > 0 ? "They cancelled in time, so it won't pay out." : "It was too late for a refund, so you're still paid on the normal clock.";
    await sendTemplate(athleteEmail, T.athleteCanceledByBuyer, { ...vars, payLine });
    pushBooking(b, "buyer_canceled");
  }),
  timesProposed: (b: B) => safe("timesProposed", async () => { const { vars } = await base(b); await sendTemplate(buyerTo(b), T.timesProposed, vars); }),
  athletePickedTime: (b: B) => safe("athletePickedTime", async () => { const { vars, athleteEmail } = await base(b); await sendTemplate(athleteEmail, T.athletePickedTime, vars); }),
  newMessageToBuyer: (b: B) => safe("newMessageToBuyer", async () => { const { vars } = await base(b); await sendTemplate(buyerTo(b), T.newMessage, vars); }),
  newMessageToAthlete: (b: B) => safe("newMessageToAthlete", async () => {
    const { vars, athleteEmail } = await base(b);
    await sendTemplate(athleteEmail, T.athleteNewMessage, vars);
    pushBooking(b, "new_message", { messageId: String(Date.now()) });
  }),
  /** Bookings PR3: her request is about to expire (about 12 hours left): email + push, once (the sweep claims it). */
  expiringToAthlete: (b: B) => safe("expiringToAthlete", async () => {
    const { vars, athleteEmail } = await base(b);
    await sendTemplate(athleteEmail, T.athleteExpiring, { ...vars, respondBy: formatWhen(b.respond_by, await athleteZone(b)) });
    pushBooking(b, "expiring");
  }),
  /** Bookings PR3: the session is tomorrow (within 24 hours): both sides by email, her phone too. */
  tomorrow: (b: B, opts: { athlete?: boolean } = {}) => safe("tomorrow", async () => {
    const { vars, athleteEmail } = await base(b);
    await sendTemplate(buyerTo(b), T.sessionTomorrow, vars);
    if (opts.athlete === false) return;   // an open group: her copy goes out once per time (sweeper)
    await sendTemplate(athleteEmail, T.athleteSessionTomorrow, { ...vars, buyer: b.audience === "open_group" ? "your group" : vars.buyer, when: formatWhen(b.starts_at, await athleteZone(b)) });
    pushBooking(b, "tomorrow");
  }),
  offersPaused: (athleteId: string) => safe("offersPaused", async () => {
    const { email } = await athleteFirstName(athleteId);
    await sendTemplate(email, T.athleteOffersPaused, { ...supportVars() });
  }),
  supportAlert: (b: Pick<Booking, "id">, what: string, detail: string) => safe("supportAlert", async () => {
    await sendTemplate(BOOKINGS.supportEmail, T.supportAlert, { ...supportVars(), ref: bookingRef(b.id), what, detail });
  }),
};
