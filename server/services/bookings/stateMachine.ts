/**
 * bookings/stateMachine.ts — the booking's status machine (Bookings v2 + public card v3.1 "hold at request").
 *
 * The booking holds the human story; its one `payments` row (kind 'booking_payment') holds the money. Every status change
 * goes through transition(): the move must be in TRANSITIONS for that actor, the UPDATE is conditional on the status the
 * caller read (a stale read never overwrites a newer state — two taps, a tap racing the sweeper, a replayed webhook), and
 * the change is appended to booking_events in the same transaction. Nothing else writes bookings.status.
 *
 *   (create) → unverified ──verify + card hold──→ requested ──her Accept (capture)──→ accepted → confirmed
 *                  │                                  │                                 │ (capture failed: pay link)
 *                  └→ withdrawn / expired             └→ declined / withdrawn / expired └→ withdrawn / expired
 *   confirmed → in_review (the session ended, or "Buyer didn't show") → released ("It happened", or end + 48h, nothing open)
 *   confirmed / in_review → issue_reported (a report) → released / refunded / in_review (a person at Nomila decides)
 *   any funded state → disputed (a chargeback) → released / refunded / in_review
 *   confirmed → canceled (buyer or her, under the refund rules) · → refunded (admin)
 *
 * Who may make each move is part of the table: she can never release her own money (only the buyer, the clock with nothing
 * open, or a person at Nomila can), and Mila is not an actor at all.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { bookings, bookingEvents } from "../../../shared/schema";
import type { Booking, NewBooking } from "../../../shared/schema";

export const BOOKING_STATUSES = [
  "unverified", "requested", "accepted", "confirmed", "in_review", "issue_reported", "disputed",
  "released", "declined", "withdrawn", "expired", "canceled", "refunded",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export type BookingActor = "buyer" | "athlete" | "system" | "stripe" | "admin";

/** from → to → the actors allowed to make that move. Anything not listed is illegal. */
export const TRANSITIONS: Readonly<Record<BookingStatus, Partial<Record<BookingStatus, readonly BookingActor[]>>>> = {
  // The buyer finishes verifying and the card hold is placed (the webhook, or the return-page re-check).
  unverified:     { requested: ["buyer", "stripe", "system"], withdrawn: ["buyer"], expired: ["system"] },
  // Her answer (her own tap), the buyer pulling out, or the respond_by sweeper.
  // confirmed by "system" ONLY for an open group session (0153, charges.ts autoConfirmOpenGroup): her publishing the
  // time is her yes, so a fan's spot is captured and confirmed without a tap. Everything else still needs her Accept.
  requested:      { accepted: ["athlete"], declined: ["athlete"], withdrawn: ["buyer"], expired: ["system", "stripe"], confirmed: ["system"] },
  // Capture succeeded at once (her tap), or the fallback pay link was paid (webhook); or nobody paid in time.
  accepted:       { confirmed: ["athlete", "stripe", "system"], withdrawn: ["buyer"], expired: ["system"] },
  confirmed: {
    in_review:      ["system", "athlete"],          // the session ended (sweeper) · "Buyer didn't show" (her tap)
    released:       ["buyer"],                      // "It happened" (only after the start)
    issue_reported: ["buyer", "athlete"],
    canceled:       ["buyer", "athlete", "system", "admin"],
    disputed:       ["stripe"],
    refunded:       ["admin"],
  },
  in_review: {
    released:       ["buyer", "system", "admin"],   // "It happened", or the clock with nothing open
    issue_reported: ["buyer", "athlete"],
    disputed:       ["stripe"],
    refunded:       ["admin"],
  },
  issue_reported: { released: ["admin"], refunded: ["admin"], in_review: ["admin"], disputed: ["stripe"] },
  disputed:       { released: ["admin", "stripe"], refunded: ["admin", "stripe"], in_review: ["stripe", "admin"] },
  released: {}, declined: {}, withdrawn: {}, expired: {}, canceled: {}, refunded: {},
};

/** States that hold a slot (uq_bookings_live_slot, 0102) — the request is alive. */
export const LIVE_STATUSES: readonly BookingStatus[] = ["unverified", "requested", "accepted", "confirmed", "in_review", "issue_reported", "disputed"];
/** States with no way out. */
export const TERMINAL_STATUSES: readonly BookingStatus[] = ["released", "declined", "withdrawn", "expired", "canceled", "refunded"];
/** States in which the buyer's money has been captured and is held by Nomila. */
export const FUNDED_STATUSES: readonly BookingStatus[] = ["confirmed", "in_review", "issue_reported", "disputed"];

export function isBookingStatus(s: unknown): s is BookingStatus {
  return typeof s === "string" && (BOOKING_STATUSES as readonly string[]).includes(s);
}

export function canTransition(from: BookingStatus, to: BookingStatus, actor: BookingActor): boolean {
  return TRANSITIONS[from]?.[to]?.includes(actor) ?? false;
}

export type TransitionErrorCode = "ILLEGAL_TRANSITION" | "STALE_STATE" | "NOT_FOUND";

export class TransitionError extends Error {
  constructor(public code: TransitionErrorCode, public current?: BookingStatus) {
    super(code);
    this.name = "TransitionError";
  }
}

export interface TransitionInput {
  bookingId: string;
  /** The status (or statuses) the caller read. The UPDATE only applies while the row is still in one of them. */
  from:      BookingStatus | readonly BookingStatus[];
  to:        BookingStatus;
  actor:     BookingActor;
  /** Tenancy: when set, the booking must belong to this athlete (else NOT_FOUND, never a hint it exists). */
  athleteId?: string;
  /** Other columns written in the same UPDATE (clocks, outcome, the picked time …). Never `status`. */
  patch?:    Partial<NewBooking>;
  /** Extra data for the booking_events row. Never buyer contact details. */
  data?:     Record<string, unknown>;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Move a booking from `from` to `to` as `actor`, atomically, with its event. Throws TransitionError:
 *   ILLEGAL_TRANSITION  the table does not allow it for this actor (checked before touching the row)
 *   NOT_FOUND           no such booking (or not this athlete's)
 *   STALE_STATE         the row is no longer in `from` (someone else moved it first); `current` says where it is
 */
export async function transition(input: TransitionInput, tx?: Tx): Promise<Booking> {
  const froms = (Array.isArray(input.from) ? input.from : [input.from]) as BookingStatus[];
  if (froms.length === 0 || !froms.every((f) => canTransition(f, input.to, input.actor))) {
    throw new TransitionError("ILLEGAL_TRANSITION");
  }
  const run = async (t: Tx): Promise<Booking> => {
    const { status: _ignored, ...patch } = (input.patch ?? {}) as Partial<NewBooking> & { status?: unknown };
    // Lock the row, read where it really is, then move it only from there (the conditional UPDATE is the backstop).
    const [cur] = await t.select({ status: bookings.status, athlete: bookings.athlete_id }).from(bookings)
      .where(eq(bookings.id, input.bookingId)).for("update").limit(1);
    if (!cur || (input.athleteId && cur.athlete !== input.athleteId)) throw new TransitionError("NOT_FOUND");
    const from = cur.status as BookingStatus;
    if (!froms.includes(from)) throw new TransitionError("STALE_STATE", from);
    const [row] = await t.update(bookings)
      .set({ ...patch, status: input.to, updated_at: new Date() })
      .where(and(eq(bookings.id, input.bookingId), eq(bookings.status, from)))
      .returning();
    if (!row) throw new TransitionError("STALE_STATE", from);
    await t.insert(bookingEvents).values({
      booking_id: row.id, kind: "status", actor: input.actor,
      from_status: from, to_status: input.to, data: input.data ?? null,
    });
    return row;
  };
  return tx ? run(tx) : db.transaction(run);
}

/** Append a non-status event (payment notes, no-show marks, safety, messages). Never buyer contact details. */
export async function recordBookingEvent(
  bookingId: string,
  kind: "attendance" | "no_show" | "message" | "safety" | "payment" | "note",
  actor: BookingActor | "livekit",
  data?: Record<string, unknown>,
  tx?: Tx,
): Promise<void> {
  await (tx ?? db).insert(bookingEvents).values({ booking_id: bookingId, kind, actor, data: data ?? null });
}
