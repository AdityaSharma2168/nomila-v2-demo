/**
 * bookings/publicPort.ts — Ask Mila's PublicBookingsPort (public card v3 §7 "Book with Mila"), implemented by the
 * booking service. Public Mila owns no booking logic: it reaches bookings only through these two calls, wired in
 * server/index.ts as createAskMilaPublicRouter({ bookings: createPublicBookingsPort(), … }).
 *
 *   listOpenSlots         READ-ONLY. The open times of ONE published offer of THIS athlete: future, bookable now (far
 *                         enough ahead for her to answer, no further than BOOKING_MAX_ADVANCE_DAYS), not withdrawn, not
 *                         held by a live request, inside the offer's own date window. Times only, nothing else about
 *                         her day. Empty for request-mode offers (buyers suggest times there) and while bookings are off.
 *   createPendingRequest  ONE unverified request, called only from the visitor's own tap (never the model). It holds the
 *                         time for the unverified hold (15 minutes) and has no contact yet: `nextUrl` is the visitor's
 *                         private booking page, whose first step is the contact form (POST /api/v1/book/b/:token/contact),
 *                         then the email code, phone code, ID check when needed, and the card hold — the same path as a
 *                         direct request. Nothing reaches her until all of that is done.
 *
 * The athlete id is always the one the server resolved from the handle; an offer that is not hers is "unavailable".
 *
 * The interface is public Mila's own (server/mila/public/ports.ts): imported, never copied, so the two cannot drift.
 */
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import { db } from "../../db";
import { offerSlots, offers } from "../../../shared/schema";
import { bookingsEnabledFor } from "./config";
import { startProblem } from "./clocks";
import { takenSlotIds } from "./offers";
import { createPendingFromAsk } from "./buyer";
import type { PublicBookingsPort } from "../../mila/public/ports";

const DAY = 86_400_000;
/** The most days one listOpenSlots call looks ahead (the booking window itself is BOOKING_MAX_ADVANCE_DAYS). */
export const MAX_LIST_DAYS = 60;
/** At most this many times in one answer (a card shows a handful; the visitor can ask for more days). */
export const MAX_LIST_SLOTS = 50;

/** The visitor's private booking page (same-origin path; the public page serves it). */
export const bookingPagePath = (token: string): string => `/b/${token}`;

export function createPublicBookingsPort(clock: () => Date = () => new Date()): PublicBookingsPort {
  return {
    bookable: (athleteId) => typeof athleteId === "string" && bookingsEnabledFor(athleteId),
    async listOpenSlots({ athleteId, offerPublicId, from, days }) {
      if (typeof athleteId !== "string" || !bookingsEnabledFor(athleteId)) return [];
      if (typeof offerPublicId !== "string" || !(from instanceof Date) || !Number.isFinite(from.getTime())) return [];
      const span = Math.min(Math.max(Math.floor(Number(days) || 0), 1), MAX_LIST_DAYS);
      const [o] = await db.select().from(offers)
        .where(and(eq(offers.public_id, offerPublicId), eq(offers.athlete_id, athleteId), eq(offers.status, "published"))).limit(1);
      if (!o || o.scheduling_mode !== "slots") return [];
      const now = clock();
      const start = from > now ? from : now;
      const rows = await db.select().from(offerSlots).where(and(
        eq(offerSlots.offer_id, o.id), eq(offerSlots.athlete_id, athleteId), isNull(offerSlots.withdrawn_at),
        gte(offerSlots.starts_at, start), lt(offerSlots.starts_at, new Date(start.getTime() + span * DAY)),
      )).orderBy(offerSlots.starts_at);
      const taken = await takenSlotIds(rows.map((r) => r.id));
      const fromDay = o.available_from ? Date.parse(o.available_from) : null;
      const untilDay = o.available_until ? Date.parse(o.available_until) + DAY : null;
      return rows
        .filter((s) => !taken.has(s.id) && startProblem(s.starts_at, now) === "none")
        .filter((s) => (fromDay === null || s.starts_at.getTime() >= fromDay) && (untilDay === null || s.starts_at.getTime() < untilDay))
        .slice(0, MAX_LIST_SLOTS)
        .map((s) => ({ id: s.id, startsAt: s.starts_at.toISOString(), endsAt: s.ends_at.toISOString() }));
    },

    async createPendingRequest(r) {
      if (!r || typeof r.athleteId !== "string" || !bookingsEnabledFor(r.athleteId)) return { ok: false, reason: "unavailable" };
      if (typeof r.offerPublicId !== "string" || r.offerPublicId.length > 64) return { ok: false, reason: "invalid" };
      if (r.slotId !== null && typeof r.slotId !== "string") return { ok: false, reason: "invalid" };
      if (r.times !== null && (!Array.isArray(r.times) || r.times.some((t) => typeof t !== "string"))) return { ok: false, reason: "invalid" };
      if (r.note !== null && typeof r.note !== "string") return { ok: false, reason: "invalid" };
      const out = await createPendingFromAsk({
        athleteId: r.athleteId, offerPublicId: r.offerPublicId, slotId: r.slotId, times: r.times, note: r.note, askMilaSessionId: r.askMilaSessionId,
      }, clock());
      return out.ok ? { ok: true, ref: out.ref, nextUrl: bookingPagePath(out.token) } : out;
    },
  };
}
