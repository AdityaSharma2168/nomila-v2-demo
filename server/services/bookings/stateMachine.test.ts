/**
 * stateMachine.test.ts — every booking transition, against PGlite (real SQL, the real schema).
 *
 *   T1 the table: every (from, to, actor) the table lists moves the row and appends ONE status event naming the actor,
 *      from and to; every other (from, to, actor) combination is refused before the row is touched
 *   T2 terminal states have no way out; she (athlete) can never release her own money; Mila is not an actor
 *   T3 a stale read never overwrites a newer state (two taps; a tap racing the sweeper)
 *   T4 tenancy: another athlete's booking is NOT_FOUND, never STALE (no hint it exists)
 *   T5 the patch is written in the same UPDATE; `status` in a patch is ignored
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { bookings, bookingEvents, offers } from "../../../shared/schema";
import {
  BOOKING_STATUSES, TRANSITIONS, TERMINAL_STATUSES, LIVE_STATUSES, FUNDED_STATUSES,
  canTransition, transition, recordBookingEvent, TransitionError, isBookingStatus,
  type BookingActor, type BookingStatus,
} from "./stateMachine";

const ACTORS: BookingActor[] = ["buyer", "athlete", "system", "stripe", "admin"];
let athleteId: string, otherAthleteId: string, offerId: string;
let seq = 0;

async function seedBooking(status: BookingStatus, owner = athleteId): Promise<string> {
  const [b] = await db.insert(bookings).values({
    athlete_id: owner, offer_id: offerId, status, format: "video_call", title: "Call", duration_minutes: 30,
    location_mode: "virtual", policy_key: "athlete_window_v1", free_cancel_hours: 24,
    price_cents: 15_000, service_fee_cents: 2_796, buyer_total_cents: 17_796,
    buyer_name: "Jordan Park", buyer_email: "buyer@example.test", buyer_email_hash: "h", buyer_token_hash: `tok_${++seq}`,
  }).returning({ id: bookings.id });
  return b.id;
}
const statusOf = async (id: string) => (await db.select({ s: bookings.status }).from(bookings).where(eq(bookings.id, id)))[0].s;
const eventsOf = (id: string) => db.select().from(bookingEvents).where(eq(bookingEvents.booking_id, id));

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Machine Athlete");
  otherAthleteId = await seedAthlete("Other Athlete");
  const [o] = await db.insert(offers).values({
    athlete_id: athleteId, public_id: "pub_machine", format: "video_call", title: "Call", price_cents: 15_000,
    duration_minutes: 30, location_mode: "virtual",
  }).returning({ id: offers.id });
  offerId = o.id;
});
afterAll(async () => { await closeTestDb(); });

const legal: Array<[BookingStatus, BookingStatus, BookingActor]> = [];
const illegal: Array<[BookingStatus, BookingStatus, BookingActor]> = [];
for (const from of BOOKING_STATUSES) for (const to of BOOKING_STATUSES) for (const actor of ACTORS) {
  (TRANSITIONS[from][to]?.includes(actor) ? legal : illegal).push([from, to, actor]);
}

describe("T1 the table", () => {
  it("lists the designed moves (a sanity count, so an accidental widening shows up in review)", () => {
    expect(legal.length).toBe(44);   // 0153: requested → confirmed by "system" (an open group spot confirms itself)
    expect(legal.length + illegal.length).toBe(BOOKING_STATUSES.length ** 2 * ACTORS.length);
  });

  it.each(legal)("%s → %s by %s moves the row and logs one event", async (from, to, actor) => {
    const id = await seedBooking(from);
    const row = await transition({ bookingId: id, from, to, actor, data: { why: "test" } });
    expect(row.status).toBe(to);
    const evs = await eventsOf(id);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: "status", actor, from_status: from, to_status: to, data: { why: "test" } });
  });

  it("refuses every other combination before touching the row", async () => {
    const id = await seedBooking("requested");
    for (const [from, to, actor] of illegal) {
      expect(canTransition(from, to, actor)).toBe(false);
      await expect(transition({ bookingId: id, from, to, actor })).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    }
    expect(await statusOf(id)).toBe("requested");
    expect(await eventsOf(id)).toHaveLength(0);
  });
});

describe("T2 the rules the table encodes", () => {
  it("terminal states have no way out", () => {
    for (const t of TERMINAL_STATUSES) expect(Object.keys(TRANSITIONS[t])).toEqual([]);
    for (const s of BOOKING_STATUSES) expect(TERMINAL_STATUSES.includes(s) !== LIVE_STATUSES.includes(s)).toBe(true);
    expect(FUNDED_STATUSES.every((s) => LIVE_STATUSES.includes(s))).toBe(true);
  });
  it("she can never release her own money; only the buyer, the clock or a person at Nomila can", () => {
    for (const from of BOOKING_STATUSES) expect(canTransition(from, "released", "athlete")).toBe(false);
    expect(canTransition("in_review", "released", "buyer")).toBe(true);
    expect(canTransition("in_review", "released", "system")).toBe(true);
    expect(canTransition("issue_reported", "released", "system")).toBe(false);   // an open report freezes the clock
  });
  it("accept and decline are hers alone; withdraw is the buyer's alone", () => {
    for (const a of ACTORS) {
      expect(canTransition("requested", "accepted", a)).toBe(a === "athlete");
      expect(canTransition("requested", "declined", a)).toBe(a === "athlete");
      expect(canTransition("requested", "withdrawn", a)).toBe(a === "buyer");
    }
  });
  it("Mila is not an actor", () => {
    for (const from of BOOKING_STATUSES) for (const to of BOOKING_STATUSES) {
      expect(canTransition(from, to, "mila" as BookingActor)).toBe(false);
    }
    expect(isBookingStatus("requested")).toBe(true);
    expect(isBookingStatus("paid")).toBe(false);
  });
});

describe("T3 stale reads", () => {
  it("two taps: the second sees STALE_STATE with where the row is now", async () => {
    const id = await seedBooking("requested");
    await transition({ bookingId: id, from: "requested", to: "accepted", actor: "athlete" });
    const err = await transition({ bookingId: id, from: "requested", to: "declined", actor: "athlete" }).catch((e) => e);
    expect(err).toBeInstanceOf(TransitionError);
    expect(err).toMatchObject({ code: "STALE_STATE", current: "accepted" });
    expect(await statusOf(id)).toBe("accepted");
    expect(await eventsOf(id)).toHaveLength(1);
  });
  it("a tap racing the sweeper: whichever lands first wins, the other is refused", async () => {
    const id = await seedBooking("requested");
    const results = await Promise.allSettled([
      transition({ bookingId: id, from: "requested", to: "expired", actor: "system" }),
      transition({ bookingId: id, from: "requested", to: "accepted", actor: "athlete" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await eventsOf(id))).toHaveLength(1);
  });
  it("accepts a list of from-states and logs the real one", async () => {
    const id = await seedBooking("in_review");
    await transition({ bookingId: id, from: ["confirmed", "in_review"], to: "issue_reported", actor: "buyer" });
    expect((await eventsOf(id))[0]).toMatchObject({ from_status: "in_review", to_status: "issue_reported" });
  });
  it("an unknown booking is NOT_FOUND", async () => {
    await expect(transition({ bookingId: "00000000-0000-0000-0000-000000000000", from: "requested", to: "declined", actor: "athlete" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("T4 tenancy", () => {
  it("another athlete's booking is NOT_FOUND and untouched", async () => {
    const id = await seedBooking("requested", otherAthleteId);
    await expect(transition({ bookingId: id, from: "requested", to: "declined", actor: "athlete", athleteId }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await statusOf(id)).toBe("requested");
    const mine = await transition({ bookingId: id, from: "requested", to: "declined", actor: "athlete", athleteId: otherAthleteId });
    expect(mine.status).toBe("declined");
  });
});

describe("T5 the patch", () => {
  it("is written with the move; a status in the patch is ignored", async () => {
    const id = await seedBooking("requested");
    const at = new Date("2026-11-01T10:00:00Z");
    const row = await transition({
      bookingId: id, from: "requested", to: "accepted", actor: "athlete",
      patch: { accepted_at: at, status: "released" } as any,
    });
    expect(row.status).toBe("accepted");
    expect(row.accepted_at?.toISOString()).toBe(at.toISOString());
  });
  it("non-status events append without moving the row", async () => {
    const id = await seedBooking("confirmed");
    await recordBookingEvent(id, "no_show", "athlete", { by: "buyer" });
    const evs = await db.select().from(bookingEvents).where(and(eq(bookingEvents.booking_id, id), eq(bookingEvents.kind, "no_show")));
    expect(evs).toHaveLength(1);
    expect(await statusOf(id)).toBe("confirmed");
  });
});
