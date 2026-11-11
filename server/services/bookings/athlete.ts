/**
 * bookings/athlete.ts — her side of a booking: the lists, the detail, and every action, each one HER tap on a confirm
 * sheet (tap-to-send). Always scoped to her athlete id; another athlete's booking is NOT_FOUND.
 *
 *   accept       captures the held card at once → confirmed. If the bank had dropped the hold: a pay link (24h) → the
 *                buyer pays → confirmed. If Stripe didn't answer: nothing was charged and nothing sent; tap again.
 *   decline      releases the hold; the buyer gets a kind note (her reason stays with her)
 *   propose      1–3 other times; the buyer picks one (the hold stays), then she accepts as usual
 *   cancel       the buyer gets everything back; she covers Stripe's actual card fee from her next payout (first is free)
 *
 * Open groups (0153) confirm each spot by themselves — unless her offer has "Approve each spot" on (0154,
 * bookings.approve_each_spot): then a spot is a request she accepts (captures) or declines like a 1:1, at the time she
 * published (no time picking, no "suggest other times"); capacity was already held for it from the pick (buyer.ts).
 *
 * The session and what follows it — Join, "Session done", "Buyer didn't show", "Report a problem", "It happened" and the
 * release of her money — are the session PR (#868: routes/bookingSession.ts, services/bookings/session/*). The detail
 * here says WHEN those doors open (actions.noShowAt, actions.sessionDone) so the app can show them; the taps go there.
 *
 * Mila can explain any of this; she can never call it (bookingsTapOnly.test.ts).
 */
import { and, asc, count, desc, eq, inArray, min, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import { athletePayoutAdjustments, bookingEvents, bookings, offers, payments } from "../../../shared/schema";
import type { Booking, Payment } from "../../../shared/schema";
import type {
  BookingActionsView, BookingDetailView, BookingListItemView, BookingPayoutView, BookingPayoutsView, BookingPhase,
  BookingTimelineEntry, BookingsSummaryView, CancelPreviewView, ProposedTimeView,
} from "../../../shared/bookingsApi";
import { getConnectStatus } from "../payments/connect";
import { BOOKINGS } from "./config";
import { estimateProcessingCents } from "./money";
import { buyerLabel, coded, usd } from "./common";
import { notices } from "./notices";
import { recordBookingEvent, transition, TransitionError, type BookingStatus } from "./stateMachine";
import { cancelQuote, noShowAvailableAt, parseProposedTimes, payByFor } from "./clocks";
import {
  cancelHold, captureHold, createPayLink, firstCancelStillFree, paymentFor, recordAthleteRefundCost, refundBookingPayment, slotSpotsTaken,
} from "./charges";
import { nomilaLine, unansweredCounts } from "./relay";
import { athletePausedByNomila } from "./offers";
import { unitPriceOf } from "./buyer";
import { guestNames } from "./guests";
import { isFanBlocked } from "../fanSafety/fanBlocks";

const MIN = 60_000;

export async function getOwnedBooking(athleteId: string, bookingId: string): Promise<Booking> {
  const [b] = await db.select().from(bookings).where(and(eq(bookings.id, bookingId), eq(bookings.athlete_id, athleteId))).limit(1);
  if (!b || b.status === "unverified") throw coded("NOT_FOUND");   // a request she can't see yet does not exist for her
  return b;
}

const times = (v: unknown): ProposedTimeView[] => (Array.isArray(v) ? (v as ProposedTimeView[]) : []);

/** She answers this booking (accept / decline): a 1:1 or private group, or an open-group spot she approves (0154). */
export const answerable = (b: Pick<Booking, "audience" | "approve_each_spot">): boolean => b.audience !== "open_group" || b.approve_each_spot;
/** Bookings she answers, as SQL: everything but an open group that confirms itself. */
const ANSWERABLE = sql`(${bookings.audience} <> 'open_group' OR ${bookings.approve_each_spot})`;

export function phaseOf(b: Booking, p: Payment | null, now: Date): BookingPhase {
  switch (b.status as BookingStatus) {
    case "requested": return times(b.athlete_proposed_times).length ? "waiting_buyer" : "request";
    case "accepted": return p?.status === "authorized" ? "request" : "waiting_payment";
    case "confirmed":
      if (b.starts_at && now < b.starts_at) return "booked";
      if (b.ends_at && now < b.ends_at) return "happening";
      return "finished";
    case "in_review": return "finished";
    case "issue_reported": case "disputed": return "on_hold";
    case "released": return "paid";
    case "declined": return "declined";
    case "withdrawn": return "withdrawn";
    case "expired": return "expired";
    case "canceled": return "canceled";
    case "refunded": return "refunded";
    default: return "expired";
  }
}

function checksOf(b: Booking) {
  return {
    email: !!b.email_verified_at, phone: !!b.phone_verified_at, idChecked: b.identity_status === "verified",
    adult: b.buyer_adult_attested, parent: b.minor_attendee && b.parent_present_attested,
  };
}

function listItem(b: Booking, p: Payment | null, now: Date, unread: number): BookingListItemView {
  return {
    id: b.id, status: b.status as BookingListItemView["status"], phase: phaseOf(b, p, now),
    buyerLabel: buyerLabel(b.buyer_name), title: b.title, format: b.format as BookingListItemView["format"],
    locationMode: b.location_mode as BookingListItemView["locationMode"],
    startsAt: b.starts_at?.toISOString() ?? null, endsAt: b.ends_at?.toISOString() ?? null,
    proposedTimes: times(b.proposed_times), respondBy: b.respond_by?.toISOString() ?? null,
    receiveCents: b.price_cents, checks: checksOf(b), createdAt: b.created_at.toISOString(), unreadMessages: unread,
    audience: b.audience as BookingListItemView["audience"], partySize: b.party_size, unitPriceCents: unitPriceOf(b), slotId: b.slot_id ?? null,
  };
}

async function paymentsByBooking(ids: string[]): Promise<Map<string, Payment>> {
  if (!ids.length) return new Map();
  const rows = await db.select().from(payments).where(and(inArray(payments.booking_id, ids), eq(payments.kind, "booking_payment")));
  return new Map(rows.map((p) => [p.booking_id!, p]));
}

export type BookingListView = "requests" | "upcoming" | "past";
const UPCOMING: BookingStatus[] = ["accepted", "confirmed", "in_review", "issue_reported", "disputed"];
const PAST: BookingStatus[] = ["released", "declined", "withdrawn", "expired", "canceled", "refunded"];

export async function listBookings(athleteId: string, view: BookingListView, now = new Date()): Promise<BookingListItemView[]> {
  // An open group never asks her (0153): a fan's spot mid-capture is not a request for her to answer — unless she
  // approves each spot (0154).
  const rows = view === "requests"
    ? await db.select().from(bookings).where(and(eq(bookings.athlete_id, athleteId), inArray(bookings.status, ["requested", "accepted"]), ANSWERABLE)).orderBy(asc(bookings.respond_by))
    : view === "upcoming"
      ? await db.select().from(bookings).where(and(eq(bookings.athlete_id, athleteId), inArray(bookings.status, UPCOMING))).orderBy(asc(bookings.starts_at))
      : await db.select().from(bookings).where(and(eq(bookings.athlete_id, athleteId), inArray(bookings.status, PAST))).orderBy(desc(bookings.updated_at)).limit(50);
  const pays = await paymentsByBooking(rows.map((r) => r.id));
  const unread = await unansweredCounts(rows.map((r) => r.id), "athlete");
  const items = rows.map((b) => listItem(b, pays.get(b.id) ?? null, now, unread.get(b.id) ?? 0));
  // An accept whose capture is being retried is still a request; a pay-link wait is upcoming.
  if (view === "requests") return items.filter((i) => i.phase === "request" || i.phase === "waiting_buyer");
  if (view === "upcoming") return items.filter((i) => i.phase !== "request");
  return items;
}

function actionsOf(b: Booking, p: Payment | null, now: Date, fanBlocked = false): BookingActionsView {
  const s = b.status as BookingStatus;
  const retryAccept = s === "accepted" && p?.status === "authorized";
  const started = !!b.starts_at && now >= b.starts_at;
  const noShowAt = b.starts_at ? noShowAvailableAt(b.starts_at) : null;
  const inSession = s === "confirmed" || s === "in_review";
  const answers = answerable(b);   // an open group confirms each spot by itself, unless she approves each one (0154)
  return {
    accept: answers && (s === "requested" || retryAccept),
    decline: answers && s === "requested",
    propose: answers && b.audience !== "open_group" && s === "requested",   // an open group's time is the one she set
    cancel: s === "confirmed" && !started,
    noShow: inSession && !b.no_show_by && !!noShowAt && now >= noShowAt,
    noShowAt: inSession && !b.no_show_by && noShowAt ? noShowAt.toISOString() : null,
    sessionDone: inSession && started && !b.athlete_done_at,
    message: ["requested", "accepted", "confirmed", "in_review", "issue_reported", "disputed", "released"].includes(s),
    block: !fanBlocked && !b.buyer_redacted_at,
  };
}

/** Card fees netted from the payout of each payment (athlete_payout_adjustments recovered against it). */
async function feesRecoveredBy(paymentIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!paymentIds.length) return out;
  const rows = await db.select({ p: athletePayoutAdjustments.recovered_payment_id, c: athletePayoutAdjustments.amount_cents }).from(athletePayoutAdjustments)
    .where(and(inArray(athletePayoutAdjustments.recovered_payment_id, paymentIds), eq(athletePayoutAdjustments.status, "recovered")));
  for (const r of rows) out.set(r.p!, (out.get(r.p!) ?? 0) + r.c);
  return out;
}

async function payoutOf(b: Booking, p: Payment | null): Promise<BookingPayoutView> {
  const feeTaken = p ? (await feesRecoveredBy([p.id])).get(p.id) ?? 0 : 0;
  let state: BookingPayoutView["state"] = "none";
  if (p?.status === "settled") state = "paid";
  else if (b.status === "issue_reported" || b.status === "disputed") state = "on_hold";
  else if (p?.status === "refunded" || b.status === "refunded") state = "refunded";
  else if (p?.status === "funded") state = "held";
  return {
    receiveCents: b.price_cents, state, releaseDueAt: b.release_due_at?.toISOString() ?? null,
    paidAt: b.released_at?.toISOString() ?? null, cardFeeCents: state === "paid" ? feeTaken : 0,
  };
}

async function timelineOf(bookingId: string): Promise<BookingTimelineEntry[]> {
  const evs = await db.select().from(bookingEvents).where(eq(bookingEvents.booking_id, bookingId)).orderBy(asc(bookingEvents.at));
  const by = (a: string): BookingTimelineEntry["by"] => (a === "athlete" ? "you" : a === "buyer" ? "buyer" : "nomila");
  const out: BookingTimelineEntry[] = [];
  for (const e of evs) {
    const at = e.at.toISOString();
    if (e.kind === "status") {
      const map: Partial<Record<string, BookingTimelineEntry["kind"]>> = {
        requested: "requested", accepted: "accepted", confirmed: "paid", declined: "declined", withdrawn: "withdrawn",
        expired: "expired", canceled: "canceled", refunded: "refunded", released: "paid_out", issue_reported: "reported", disputed: "reported",
      };
      const k = map[e.to_status ?? ""];
      if (k) out.push({ at, kind: k, by: by(e.actor) });
    } else if (e.kind === "no_show") out.push({ at, kind: "no_show", by: by(e.actor) });
    else if (e.kind === "note" && (e.data as any)?.proposed) out.push({ at, kind: "proposed", by: by(e.actor) });
    else if (e.kind === "note" && (e.data as any)?.picked) out.push({ at, kind: "picked", by: by(e.actor) });
    else if (e.kind === "note" && (e.data as any)?.session_done) out.push({ at, kind: "session_done", by: by(e.actor) });
    else if (e.kind === "payment" && (e.data as any)?.released) out.push({ at, kind: "paid_out", by: "nomila" });
  }
  return out;
}

export async function bookingDetail(athleteId: string, bookingId: string, now = new Date()): Promise<BookingDetailView> {
  const b = await getOwnedBooking(athleteId, bookingId);
  const p = await paymentFor(b.id);
  const unread = (await unansweredCounts([b.id], "athlete")).get(b.id) ?? 0;
  const reveal = !["requested", "accepted"].includes(b.status) || !!b.accepted_at;
  const fanBlocked = await isFanBlocked(athleteId, { emailHash: b.buyer_email_hash, phoneHash: b.buyer_phone_hash });
  return {
    ...listItem(b, p, now, unread),
    buyerMessage: b.buyer_message, minorFirstName: b.minor_attendee ? b.minor_first_name : null,
    proposedNote: b.proposed_note, athleteProposedTimes: times(b.athlete_proposed_times),
    meetingMode: (b.meeting_mode as BookingDetailView["meetingMode"]) ?? null,
    meetingLink: reveal ? b.meeting_link : null, venue: reveal ? b.venue : null,
    freeCancelHours: b.free_cancel_hours, buyerTotalCents: b.buyer_total_cents,
    payBy: b.pay_by?.toISOString() ?? null, athleteDoneAt: b.athlete_done_at?.toISOString() ?? null,
    noShowBy: (b.no_show_by as BookingDetailView["noShowBy"]) ?? null,
    canceledBy: (b.canceled_by as BookingDetailView["canceledBy"]) ?? null,
    firstCancelFree: await firstCancelStillFree(athleteId),
    actions: actionsOf(b, p, now, fanBlocked), payout: await payoutOf(b, p), timeline: await timelineOf(b.id),
    guests: b.audience === "private_group" ? await guestNames(b.id) : [],
    fanBlocked,
    supportEmail: BOOKINGS.supportEmail,
  };
}

// ─── Actions (each one her tap) ─────────────────────────────────────────────────────────────────────────────────

const HTTPS = /^https:\/\/[^\s]{4,300}$/i;

/** She has another live booking overlapping [s, e). */
async function overlapsHerBooking(athleteId: string, bookingId: string, s: Date, e: Date, t: Pick<typeof db, "select"> = db, sameSlot: string | null = null): Promise<boolean> {
  const rows = await t.select({ id: bookings.id }).from(bookings).where(and(
    eq(bookings.athlete_id, athleteId), ne(bookings.id, bookingId),
    ...(sameSlot ? [sql`${bookings.slot_id} IS DISTINCT FROM ${sameSlot}::uuid`] : []),
    inArray(bookings.status, ["accepted", "confirmed", "in_review", "issue_reported", "disputed"]),
    sql`${bookings.starts_at} < ${e.toISOString()}::timestamptz AND ${bookings.ends_at} > ${s.toISOString()}::timestamptz`,
  )).limit(1);
  return rows.length > 0;
}

export type AcceptResult =
  | { result: "confirmed"; booking: BookingDetailView }
  | { result: "waiting_payment"; booking: BookingDetailView }
  | { result: "retry" };

export async function acceptBooking(athleteId: string, bookingId: string, body: { start?: unknown; backup_link?: unknown }, now = new Date()): Promise<AcceptResult> {
  let b = await getOwnedBooking(athleteId, bookingId);
  if (!answerable(b)) throw coded("WRONG_STATE", { status: b.status, audience: b.audience });   // confirmed by itself
  const spot = b.audience === "open_group";   // she approves this spot (0154): the time is the one she set
  let p = await paymentFor(b.id);
  const retrying = b.status === "accepted" && p?.status === "authorized";
  if (!retrying) {
    if (b.status !== "requested") throw coded("WRONG_STATE", { status: b.status });
    if (!p || p.status !== "authorized") throw coded("NO_HOLD");
    if (b.respond_by && now > b.respond_by) throw coded("EXPIRED");
    // The time: her slot, or one of the times the buyer suggested (or picked from hers).
    let startsAt = b.starts_at;
    if (!spot && !b.slot_id && times(b.proposed_times).length) {
      const wanted = typeof body.start === "string" ? new Date(body.start).toISOString() : null;
      const options = times(b.proposed_times).map((t) => t.start);
      const pick = wanted && options.includes(wanted) ? wanted : options.length === 1 ? options[0] : null;
      if (!pick) throw coded("PICK_A_TIME", options);
      startsAt = new Date(pick);
    }
    if (!startsAt || startsAt <= now) throw coded("TIME_PASSED");
    const endsAt = new Date(startsAt.getTime() + b.duration_minutes * MIN);
    const link = typeof body.backup_link === "string" && body.backup_link.trim() ? body.backup_link.trim() : null;
    if (link && (!HTTPS.test(link) || b.location_mode !== "virtual")) throw coded("INVALID", [{ field: "backup_link", problem: "an https link, for video calls" }]);
    const [o] = await db.select({ venue: offers.venue, video: offers.video_mode }).from(offers).where(eq(offers.id, b.offer_id)).limit(1);
    try {
      // One accept at a time per athlete (a transaction-scoped lock on her id): two taps on two requests for the same
      // hour can't both pass the overlap check. The check and the move commit together.
      const at = startsAt, until = endsAt;
      b = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`booking_accept:${athleteId}`}, 0))`);
        // An open-group spot shares its time with the other spots: the overlap is with the rest of her diary only.
        // Its place was held from the fan's pick (buyer.ts, capacity under the slot lock); this is the backstop.
        if (spot) {
          const [o] = await tx.select({ max: offers.max_people }).from(offers).where(eq(offers.id, b.offer_id)).limit(1);
          const [t] = await tx.select({ n: sql<number>`coalesce(sum(${bookings.party_size}), 0)::int` }).from(bookings)
            .where(and(eq(bookings.slot_id, b.slot_id!), inArray(bookings.status, ["accepted", "confirmed", "in_review", "issue_reported", "disputed"])));
          if (Number(t?.n ?? 0) + b.party_size > (o?.max ?? 0)) throw coded("SLOT_FULL");
        }
        if (await overlapsHerBooking(athleteId, b.id, at, until, tx, spot ? b.slot_id : null)) throw coded("TIME_TAKEN");
        return transition({
        bookingId: b.id, from: "requested", to: "accepted", actor: "athlete", athleteId,
        patch: {
          accepted_at: now, starts_at: startsAt, ends_at: endsAt,
          meeting_mode: b.location_mode === "in_person" ? "in_person" : (o?.video === "link" ? "link" : "livekit"),
          meeting_link: link, venue: b.location_mode === "in_person" ? o?.venue ?? null : null,
          proposed_times: b.slot_id ? b.proposed_times : [{ start: startsAt.toISOString(), tz: times(b.proposed_times).find((t) => t.start === startsAt!.toISOString())?.tz ?? null }],
          athlete_proposed_times: null,
        },
        }, tx);
      });
    } catch (err: any) { if (err?.code === "TIME_TAKEN" || err?.code === "SLOT_FULL") throw err; throw mapTransition(err); }
  }

  const r = await captureHold(p!);
  if (r === "retry") return { result: "retry" };
  if (r === "captured") {
    const row = await transition({ bookingId: b.id, from: "accepted", to: "confirmed", actor: "athlete", athleteId, patch: { confirmed_at: new Date() } });
    await nomilaLine(row.id, `Accepted. The card was charged ${usd(row.buyer_total_cents)}.`);
    if (spot && row.slot_id) {
      // An approved open-group spot reads like any other spot ("You're in: 3 of 10 spots").
      const [o] = await db.select({ max: offers.max_people }).from(offers).where(eq(offers.id, row.offer_id)).limit(1);
      await notices.groupJoined(row, await slotSpotsTaken(row.slot_id), Math.max(o?.max ?? 1, 1));
    } else await notices.accepted(row);
    return { result: "confirmed", booking: await bookingDetail(athleteId, b.id) };
  }
  // The hold had lapsed: a pay link, with the slot held until pay_by.
  p = (await paymentFor(b.id))!;
  const payBy = payByFor(new Date(), b.starts_at);
  const url = await createPayLink(b, p, payBy);
  const [row] = await db.update(bookings).set({ pay_by: payBy, updated_at: new Date() }).where(eq(bookings.id, b.id)).returning();
  await recordBookingEvent(b.id, "payment", "system", { hold: "lapsed", pay_link: true });
  await notices.acceptedPayLink(row, url, payBy);
  return { result: "waiting_payment", booking: await bookingDetail(athleteId, b.id) };
}

function mapTransition(err: unknown): unknown {
  if (err instanceof TransitionError) return coded(err.code === "STALE_STATE" ? "WRONG_STATE" : err.code, { status: err.current });
  return err;
}

export async function declineBooking(athleteId: string, bookingId: string, body: { reason?: unknown }): Promise<BookingDetailView> {
  const b = await getOwnedBooking(athleteId, bookingId);
  if (!answerable(b)) throw coded("WRONG_STATE", { status: b.status, audience: b.audience });
  const reason = ["time", "fit", "felt_off"].includes(body.reason as string) ? (body.reason as string) : null;
  let row: Booking;
  try { row = await transition({ bookingId: b.id, from: "requested", to: "declined", actor: "athlete", athleteId, data: { reason } }); }
  catch (err) { throw mapTransition(err); }
  const p = await paymentFor(b.id);
  if (p) await cancelHold(p, "declined");
  await notices.declined(row);
  return bookingDetail(athleteId, b.id);
}

export async function proposeTimes(athleteId: string, bookingId: string, body: { times?: unknown }, now = new Date()): Promise<BookingDetailView> {
  const b = await getOwnedBooking(athleteId, bookingId);
  if (b.status !== "requested" || b.audience === "open_group") throw coded("WRONG_STATE", { status: b.status });
  const parsed = parseProposedTimes(body.times, now);
  if (!parsed.ok) throw coded("INVALID", [{ field: "times", problem: parsed.problem }]);
  const [row] = await db.update(bookings).set({ athlete_proposed_times: parsed.times, updated_at: new Date() })
    .where(and(eq(bookings.id, b.id), eq(bookings.athlete_id, athleteId), eq(bookings.status, "requested"))).returning();
  if (!row) throw coded("WRONG_STATE");
  await recordBookingEvent(b.id, "note", "athlete", { proposed: parsed.times.length });
  await notices.timesProposed(row);
  return bookingDetail(athleteId, b.id);
}

export async function cancelPreview(athleteId: string, bookingId: string): Promise<CancelPreviewView> {
  const b = await getOwnedBooking(athleteId, bookingId);
  if (b.status !== "confirmed") throw coded("WRONG_STATE", { status: b.status });
  const q = cancelQuote(b, "athlete", new Date());
  const free = await firstCancelStillFree(athleteId);
  return {
    buyerRefundCents: q.refundCents, firstCancelFree: free,
    estCardFeeCents: free ? 0 : estimateProcessingCents(b.buyer_total_cents, BOOKINGS.processingPercent, BOOKINGS.processingFixedCents),
  };
}

/** Her cancel: the buyer gets everything back; the card fee is hers (first one free). The refund is retried if Stripe fails. */
export async function cancelByAthlete(athleteId: string, bookingId: string, body: { reason?: unknown }, now = new Date()): Promise<BookingDetailView> {
  const b = await getOwnedBooking(athleteId, bookingId);
  if (b.starts_at && now >= b.starts_at) throw coded("STARTED");
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  const q = cancelQuote(b, "athlete", now);
  let row: Booking;
  try {
    row = await transition({
      bookingId: b.id, from: "confirmed", to: "canceled", actor: "athlete", athleteId,
      patch: { canceled_at: now, canceled_by: "athlete", refund_outcome: q.outcome }, data: { refund_cents: q.refundCents },
    });
  } catch (err) { throw mapTransition(err); }
  const p = await paymentFor(b.id);
  if (p) {
    try {
      await refundBookingPayment(p, q.refundCents, "athlete", reason || "athlete cancelled");
      const fresh = (await paymentFor(b.id))!;
      await recordAthleteRefundCost(row, fresh);
    } catch { /* recorded on the payment; the sweeper retries the refund */ }
  }
  if (reason) await nomilaLine(b.id, `Cancelled by her: ${reason}`);
  await notices.canceledByAthlete(row, q.refundCents, reason);
  return bookingDetail(athleteId, b.id);
}

// ─── Summary + payouts ──────────────────────────────────────────────────────────────────────────────────────────

export async function bookingsSummary(athleteId: string, now = new Date()): Promise<BookingsSummaryView> {
  const counts = await db.select({ status: offers.status, n: count() }).from(offers).where(eq(offers.athlete_id, athleteId)).groupBy(offers.status);
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const [req] = await db.select({ n: count(), next: min(bookings.respond_by) }).from(bookings)
    .where(and(eq(bookings.athlete_id, athleteId), eq(bookings.status, "requested"), ANSWERABLE));
  const [up] = await db.select({ n: count() }).from(bookings)
    .where(and(eq(bookings.athlete_id, athleteId), inArray(bookings.status, UPCOMING)));
  const status = await getConnectStatus(athleteId);
  const published = n("published"), paused = n("paused");
  return {
    payouts: { hasAccount: status.hasAccount, ready: status.onboarded, requirementsDue: status.requirementsDue },
    offers: { published, draft: n("draft"), paused },
    pausedByNomila: await athletePausedByNomila(athleteId),
    requests: req?.n ?? 0, nextRespondBy: req?.next ? new Date(req.next as any).toISOString() : null,
    upcoming: up?.n ?? 0,
    showSection: published + paused > 0 || (req?.n ?? 0) + (up?.n ?? 0) > 0,
    limits: {
      minPriceCents: BOOKINGS.minPriceCents, maxPriceCents: BOOKINGS.maxPriceCents, durationOptions: BOOKINGS.durationMinOptions,
      freeCancelHoursOptions: BOOKINGS.freeCancelHoursOptions, freeCancelHoursDefault: BOOKINGS.freeCancelHoursDefault,
      maxProposedTimes: BOOKINGS.maxProposedTimes,
    },
    respondHours: BOOKINGS.respondHours,
    supportEmail: BOOKINGS.supportEmail,
  };
}

/** Booking money for the Financials screen: what's coming, what was paid, and any card fees she covered. */
export async function bookingPayouts(athleteId: string): Promise<BookingPayoutsView> {
  const rows = await db.select({ b: bookings, p: payments }).from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.booking_id))
    .where(and(eq(payments.athlete_id, athleteId), eq(payments.kind, "booking_payment"), inArray(payments.status, ["funded", "settled", "disputed", "refunded"])))
    .orderBy(desc(bookings.updated_at));
  const items: BookingPayoutsView["items"] = [];
  let coming = 0, paid = 0;
  const recovered = await feesRecoveredBy(rows.map((r) => r.p.id));
  for (const { b, p } of rows) {
    const fee = recovered.get(p.id) ?? 0;
    let state: BookingPayoutsView["items"][number]["state"];
    if (p.status === "refunded") continue;   // nothing reaches her (a refund she or the buyer caused); shown on the booking
    if (p.status === "settled") state = "paid";
    else if (b.status === "issue_reported" || b.status === "disputed" || p.status === "disputed") state = "on_hold";
    else state = "held";
    const amount = state === "paid" ? b.price_cents - fee : b.price_cents;
    if (state === "paid") paid += amount; else coming += amount;
    items.push({
      bookingId: b.id, title: b.title, buyerLabel: buyerLabel(b.buyer_name), state, amountCents: amount, cardFeeCents: state === "paid" ? fee : 0,
      dueAt: state === "paid" ? b.released_at?.toISOString() ?? null : b.release_due_at?.toISOString() ?? null,
    });
  }
  const fees = await db.select({ a: athletePayoutAdjustments, title: bookings.title }).from(athletePayoutAdjustments)
    .innerJoin(bookings, eq(bookings.id, athletePayoutAdjustments.booking_id))
    .where(eq(athletePayoutAdjustments.athlete_id, athleteId)).orderBy(desc(athletePayoutAdjustments.created_at));
  const status = await getConnectStatus(athleteId);
  return {
    payouts: { hasAccount: status.hasAccount, ready: status.onboarded, requirementsDue: status.requirementsDue },
    comingCents: coming, paidCents: paid, items,
    cardFees: fees.map(({ a, title }) => ({ bookingId: a.booking_id, title, amountCents: a.amount_cents, status: a.status as "owed", at: a.created_at.toISOString() })),
  };
}
