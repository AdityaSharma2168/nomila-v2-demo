/**
 * bookings/summary.ts — her bookings at a glance, read-only (app layout B: the Bookings section of Opportunities and
 * the booking requests in Home's "What matters next").
 *
 * Dark with the rest of Bookings: while BOOKINGS_ENABLED is off this answers the empty summary without touching the
 * database, so the section never appears. With it on, the section appears only once she has a PUBLISHED offer.
 *
 *   requests   verified buyers waiting on her answer (status 'requested'), soonest respond-by first. An open group's
 *              spots are never here: each confirms itself (a 'requested' one is a fan mid-checkout, not hers to answer).
 *   upcoming   accepted or confirmed bookings, soonest first. An open group (0153) is ONE line per time however many
 *              fans booked it ("4 of 10 booked", opened by slotId), as her Booked list shows it.
 *
 * Buyer contact never leaves the server (bookings.ts: shown only if she chooses to share); this reads the offer's
 * snapshot (title, format, price) and the clocks only. Every query filters her athlete id.
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import { bookings, offers } from "../../../shared/schema";
import { BOOKINGS } from "./config";
import { LIVE_STATUSES } from "./stateMachine";
import type { BookingLine, BookingsSummary } from "../../../shared/meSummaries";

const LIST_CAP = 20;

export type { BookingLine, BookingsSummary } from "../../../shared/meSummaries";

export const EMPTY_BOOKINGS: BookingsSummary = { version: "bookings-summary/0.1", published: false, publishedOffers: 0, requests: [], upcoming: [] };

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function lineOf(b: any): BookingLine {
  const party = Number(b.party_size ?? 1);
  return {
    id: b.id, title: b.title, format: b.format, status: b.status, priceCents: b.price_cents, currency: b.currency,
    startsAt: iso(b.starts_at), respondBy: iso(b.respond_by), createdAt: iso(b.created_at),
    audience: b.audience ?? "one", slotId: b.slot_id ?? null, spotsTaken: party, capacity: party,
  };
}

/**
 * Fold an open group's spots into ONE line per time, at the place its first spot has in the (starts_at) order.
 * spotsTaken counts every live spot of the time, as the group screen does (a fan mid-checkout holds a spot too);
 * priceCents is what she receives from the paid ones.
 */
async function collapseOpenGroups(athleteId: string, rows: any[], dbx: any): Promise<BookingLine[]> {
  const slotIds = [...new Set(rows.filter((r) => r.audience === "open_group" && r.slot_id).map((r) => r.slot_id as string))];
  const spots = new Map<string, number>();
  const capacity = new Map<string, number>();
  if (slotIds.length) {
    const [live, caps] = await Promise.all([
      dbx.select({ slot_id: bookings.slot_id, n: sql<number>`coalesce(sum(${bookings.party_size}), 0)::int` }).from(bookings)
        .where(and(eq(bookings.athlete_id, athleteId), inArray(bookings.slot_id, slotIds), inArray(bookings.status, [...LIVE_STATUSES])))
        .groupBy(bookings.slot_id),
      dbx.selectDistinct({ slot_id: bookings.slot_id, max: offers.max_people }).from(bookings)
        .innerJoin(offers, eq(offers.id, bookings.offer_id))
        .where(and(eq(bookings.athlete_id, athleteId), inArray(bookings.slot_id, slotIds))),
    ]);
    for (const r of live) spots.set(r.slot_id, Number(r.n));
    for (const r of caps) capacity.set(r.slot_id, Number(r.max));
  }
  const out: BookingLine[] = [];
  const bySlot = new Map<string, BookingLine>();
  for (const r of rows) {
    if (r.audience !== "open_group" || !r.slot_id) { out.push(lineOf(r)); continue; }
    const paid = r.status === "confirmed";
    const seen = bySlot.get(r.slot_id);
    if (seen) {
      if (paid) { seen.priceCents += r.price_cents; seen.status = "confirmed"; }
      continue;
    }
    const line: BookingLine = {
      ...lineOf(r), priceCents: paid ? r.price_cents : 0, respondBy: null,
      spotsTaken: spots.get(r.slot_id) ?? 1, capacity: capacity.get(r.slot_id) ?? 1,
    };
    bySlot.set(r.slot_id, line);
    out.push(line);
  }
  return out;
}

export async function readBookingsSummary(athleteId: string, dbx: any = db): Promise<BookingsSummary> {
  if (!BOOKINGS.enabled) return EMPTY_BOOKINGS;
  const [counted] = await dbx.select({ n: sql<number>`count(*)::int` }).from(offers)
    .where(and(eq(offers.athlete_id, athleteId), eq(offers.status, "published")));
  const publishedOffers = Number(counted?.n ?? 0);
  const cols = {
    id: bookings.id, title: bookings.title, format: bookings.format, status: bookings.status, price_cents: bookings.price_cents,
    currency: bookings.currency, starts_at: bookings.starts_at, respond_by: bookings.respond_by, created_at: bookings.created_at,
    audience: bookings.audience, slot_id: bookings.slot_id, party_size: bookings.party_size,
  };
  const [requests, upcoming] = await Promise.all([
    dbx.select(cols).from(bookings)
      .where(and(eq(bookings.athlete_id, athleteId), eq(bookings.status, "requested"), ne(bookings.audience, "open_group")))
      .orderBy(asc(bookings.respond_by), asc(bookings.created_at)).limit(LIST_CAP),
    // Read past the cap: an open group's many spots fold into one line, and the cap is on LINES.
    dbx.select(cols).from(bookings).where(and(eq(bookings.athlete_id, athleteId), inArray(bookings.status, ["accepted", "confirmed"])))
      .orderBy(asc(bookings.starts_at), asc(bookings.created_at)).limit(LIST_CAP * 10),
  ]);
  return {
    version: "bookings-summary/0.1", published: publishedOffers > 0, publishedOffers,
    requests: requests.map(lineOf), upcoming: (await collapseOpenGroups(athleteId, upcoming, dbx)).slice(0, LIST_CAP),
  };
}
