/**
 * groupSessions.integration.test.ts — group sessions (0153) against PGlite, Stripe faked at the boundary
 * (testUtils/fakeStripeBookings), the email channel mocked, LiveKit never called (tokens are signed locally and checked
 * with the SDK's own verifier; RoomService removal is mocked). Tests never reach providers.
 *
 *   G1 pricing: her price is PER PERSON; a booking's charge = unit × party + ONE fee on that total; the snapshot
 *      (unit_price_cents, party_size, price_cents) never moves when the offer changes; PRICE_CHANGED guards the party
 *      total; party size is refused outside 1..max (and anything but 1 for one / open_group)
 *   G2 the offer editor: who it's for, max people, open group = set times; who it's for can't change once booked; an
 *      open group's spots can't shrink below the fullest time
 *   G3 open group capacity: spots per time, full → SLOT_FULL, two fans racing for the last spot → exactly one, the same
 *      email twice → ALREADY_BOOKED; the public view shows spots left and full times
 *   G4 the partial unique index per audience: one live booking per slot for one / private_group, many for open_group
 *   G5 auto-confirm: an open group fan's hold is captured and the booking confirmed with no tap from her ("You're in",
 *      her "joined" line); a capture Stripe didn't answer stays requested and the sweep confirms it; she can't accept
 *      or decline one
 *   G6 her one tap cancels the whole time: every paid spot refunded in full, holds released, the time withdrawn
 *   G7 private group friends: up to party_size − 1, own email refused, duplicates refused, each friend gets their OWN
 *      link, a removed friend's link stops working and they get no new join token
 *   G8 video: room per booking (1:1, private) / per slot (open), maxParticipants per audience, identities, names
 *      ("Fan" between strangers), her ONE identity for an open group's time
 *   G9 the attendance webhook maps every identity kind: her join in an open group lands on every live spot, a fan's
 *      on their own booking, a friend's as role guest; a revoked friend is ignored
 *   G10 her group view + routes: one item per time with first names and identities; removal is her tap only
 *   G11 her private-group call view: the booker's and each friend's identity + first name; Remove only while the call
 *       is open and someone can still be taken out
 *   G12 the Opportunities summary: an open group's spots fold into ONE upcoming line per time ("n of max booked")
 */
process.env.LIVEKIT_URL = "wss://group-test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "APIgrouptest";
process.env.LIVEKIT_API_SECRET = "group-test-secret-at-least-32-bytes-long-x";
process.env.SESSION_SECRET = "group-session-link-secret";
process.env.PUBLIC_BASE_URL = "https://book.test";

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/stripe", () => require("../../testUtils/fakeStripeBookings").stripeModule);
jest.mock("../../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));
jest.mock("./session/roomAdmin", () => ({ removeFromRoom: jest.fn(async () => true) }));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.header("x-test-athlete");
    if (!id) { res.status(401).json({ error: "unauthorized" }); return; }
    req.athleteId = id; next();
  },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { fake } from "../../testUtils/fakeStripeBookings";
import { seedBooking, seedFunded, seedOffer, seedPayoutAccount, seedSlot } from "../../testUtils/seedBookings";
import { athletes, bookingEvents, bookingGuests, bookings, offerSlots, offers, payments } from "../../../shared/schema";
import type { Booking, Offer } from "../../../shared/schema";
import { sendEmail } from "../../lib/notify";
import { quoteBookingCharge, quotePartyCharge } from "./money";
import { createRequest, publicOffer, buyerView } from "./buyer";
import { createOffer, updateOffer } from "./offers";
import { acceptBooking, declineBooking } from "./athlete";
import { autoConfirmOpenGroup, createHoldCheckout, syncHoldForBooking } from "./charges";
import { runBookingsCron } from "./sweeper";
import { addGuests, guestByLink, removeGuest } from "./guests";
import { cancelGroupSession, groupCancelPreview, groupSessionDetail, listGroupSessions } from "./groups";
import { getBookingForSession } from "./session/sessionStore";
import {
  guestIdentityFor, identityFor, mintJoinToken, roomNameFor, slotAthleteIdentityFor, slotRoomNameFor,
} from "./session/sessionRoom";
import { handleLivekitWebhook } from "./session/livekitWebhook";
import { removeFromRoom } from "./session/roomAdmin";
import bookingsRouter from "../../routes/bookings";
import { athleteSessionRouter, buyerSessionRouter } from "../../routes/bookingSession";

const email = sendEmail as jest.Mock;
const H = 3_600_000;
const KEY = process.env.LIVEKIT_API_KEY!;
const SECRET = process.env.LIVEKIT_API_SECRET!;
const verify = (jwt: string) => new TokenVerifier(KEY, SECRET).verify(jwt);
const row = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];
const pay = async (id: string) => (await db.select().from(payments).where(eq(payments.booking_id, id)))[0];
const ops = (op: string) => fake.calls.filter((c) => c.op === op);
const mailTo = (to: string) => email.mock.calls.filter((c) => c[0].to === to).map((c) => c[0]);

let me: string;
let server: Server;
let base: string;
let n = 0;

beforeAll(async () => {
  await initTestDb();
  me = await seedAthlete("Ava Example");
  await db.update(athletes).set({ email: "her@example.test", first_name: "Ava" } as any).where(eq(athletes.id, me));
  process.env.BOOKINGS_ENABLED = "true";
  process.env.BOOKINGS_PILOT_ATHLETE_IDS = me;
  process.env.EMAIL_PROVIDER = "gmail";
  process.env.BOOKING_HASH_SECRET = "test-hash-secret";
  await seedPayoutAccount(me);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", bookingsRouter);
  app.use("/api/v1/me", athleteSessionRouter);
  app.use(buyerSessionRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  server?.close();
  for (const k of ["BOOKINGS_ENABLED", "BOOKINGS_PILOT_ATHLETE_IDS", "EMAIL_PROVIDER", "BOOKING_HASH_SECRET"]) delete process.env[k];
  await closeTestDb();
});
beforeEach(() => { email.mockClear(); fake.reset(); (removeFromRoom as jest.Mock).mockClear(); });

async function call(method: string, path: string, opts: { athlete?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.athlete) headers["x-test-athlete"] = opts.athlete;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const openGroup = (max = 3, over: Partial<typeof offers.$inferInsert> = {}) =>
  seedOffer(me, { audience: "open_group", max_people: max, scheduling_mode: "slots", title: "Group film session", ...over });
const privateGroup = (max = 4, over: Partial<typeof offers.$inferInsert> = {}) =>
  seedOffer(me, { audience: "private_group", max_people: max, scheduling_mode: "slots", title: "Team session", ...over });

function request(o: Offer, slotId: string, over: Record<string, unknown> = {}) {
  const party = typeof over.party_size === "number" ? over.party_size : 1;
  return createRequest(o.public_id, {
    slot_id: slotId, buyer_name: `Fan${++n} Person`, buyer_email: `fan${n}@example.test`, buyer_timezone: "America/New_York",
    adult_attested: true, agree_terms: true, displayed_total_cents: quotePartyCharge(o.price_cents, party).buyerTotalCents, ...over,
  });
}
const bookingOf = async (token: string): Promise<Booking> => {
  const { buyerTokenHash } = await import("./tokens");
  return (await db.select().from(bookings).where(eq(bookings.buyer_token_hash, buyerTokenHash(token))))[0];
};

/** A fan who verified their email and placed the hold (the webhook path's re-check). Returns the booking id. */
async function holdPlaced(b: Booking): Promise<void> {
  await db.update(bookings).set({ email_verified_at: new Date() }).where(eq(bookings.id, b.id));
  const r = await createHoldCheckout(b.id);
  expect(r).toHaveProperty("url");
  fake.completeHold([...fake.sessions.keys()].at(-1)!);
  await syncHoldForBooking(b.id);
}

/** A confirmed group booking in a slot whose call window is open now (seeded straight in, with a captured payment). */
async function liveGroupBooking(o: Offer, slotId: string, over: Partial<typeof bookings.$inferInsert> & { startsInHours?: number } = {}): Promise<Booking> {
  const party = (over.party_size as number | undefined) ?? 1;
  const q = quotePartyCharge(o.price_cents, party);
  const b = await seedBooking(o, {
    status: "confirmed", slot_id: slotId, audience: o.audience, party_size: party, unit_price_cents: o.price_cents,
    price_cents: q.priceCents, service_fee_cents: q.serviceFeeCents, buyer_total_cents: q.buyerTotalCents,
    meeting_mode: "livekit", startsInHours: 0.05, buyer_name: `Fan${++n} Person`, buyer_email: `live${n}@example.test`, buyer_email_hash: `lh${n}`, ...over,
  });
  await seedFunded(b);
  return b;
}

// ─── G1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("G1 per-person pricing", () => {
  it("unit × party, ONE service fee on that total; party 1 is exactly today's quote", () => {
    expect(quotePartyCharge(15_000, 1)).toMatchObject({ ...quoteBookingCharge(15_000), unitPriceCents: 15_000, partySize: 1 });
    const q = quotePartyCharge(15_000, 3);
    expect(q).toMatchObject({ priceCents: 45_000, athleteReceivesCents: 45_000, unitPriceCents: 15_000, partySize: 3 });
    expect(q.buyerTotalCents).toBe(quoteBookingCharge(45_000, { maxPriceCents: 10_000_000 }).buyerTotalCents);
    expect(q.serviceFeeCents).toBe(q.buyerTotalCents - 45_000);
    expect(() => quotePartyCharge(15_000, 0)).toThrow();
    expect(() => quotePartyCharge(15_000, 21)).toThrow();
    expect(() => quotePartyCharge(1_000, 3)).toThrow();   // the floor is per person
    expect(quotePartyCharge(500_000, 20).priceCents).toBe(10_000_000);   // the ceiling scales with the party
  });

  it("a private-group request stores the snapshot; PRICE_CHANGED guards the party total; size is bounded", async () => {
    const o = await privateGroup(4);
    const slot = await seedSlot(o, 48);
    const one = quotePartyCharge(o.price_cents, 1).buyerTotalCents;
    await expect(request(o, slot, { party_size: 3, displayed_total_cents: one })).rejects.toMatchObject({ code: "PRICE_CHANGED", detail: { partySize: 3, priceCents: 45_000 } });
    await expect(request(o, slot, { party_size: 5 })).rejects.toMatchObject({ code: "INVALID" });
    const r = await request(o, slot, { party_size: 3 });
    const b = await bookingOf(r.token);
    const q = quotePartyCharge(15_000, 3);
    expect(b).toMatchObject({ audience: "private_group", party_size: 3, unit_price_cents: 15_000, price_cents: 45_000, service_fee_cents: q.serviceFeeCents, buyer_total_cents: q.buyerTotalCents });
    // a later price change on the offer never moves the booking
    await db.update(offers).set({ price_cents: 20_000 }).where(eq(offers.id, o.id));
    const v = await buyerView(await row(b.id));
    expect(v).toMatchObject({ audience: "private_group", partySize: 3, unitPriceCents: 15_000, quote: { priceCents: 45_000, buyerTotalCents: q.buyerTotalCents, partySize: 3 } });
  });

  it("one and open_group are one person a booking", async () => {
    const o = await seedOffer(me, { scheduling_mode: "slots" });
    const s = await seedSlot(o, 50);
    await expect(request(o, s, { party_size: 2 })).rejects.toMatchObject({ code: "INVALID" });
    const og = await openGroup(5);
    const s2 = await seedSlot(og, 52);
    await expect(request(og, s2, { party_size: 2 })).rejects.toMatchObject({ code: "INVALID" });
    const b = await bookingOf((await request(o, s)).token);
    expect(b).toMatchObject({ audience: "one", party_size: 1, unit_price_cents: 15_000, price_cents: 15_000, buyer_total_cents: 17_796 });
  });
});

// ─── G2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("G2 the offer editor", () => {
  const base = { format: "video_call", title: "Group call", price_cents: 5_000, duration_minutes: 60, location_mode: "virtual" };
  it("who it's for and how many; an open group always uses set times", async () => {
    const one = await createOffer(me, { ...base, max_people: 8 });
    expect(one).toMatchObject({ audience: "one", max_people: 1 });
    const og = await createOffer(me, { ...base, audience: "open_group", max_people: 10 });
    expect(og).toMatchObject({ audience: "open_group", max_people: 10, scheduling_mode: "slots" });
    await expect(createOffer(me, { ...base, audience: "open_group", max_people: 10, scheduling_mode: "request" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(createOffer(me, { ...base, audience: "private_group", max_people: 21 })).rejects.toMatchObject({ code: "INVALID" });
    const pg = await createOffer(me, { ...base, audience: "private_group" });
    expect(pg.max_people).toBe(2);                         // a group switched on without a size starts at 2
    expect(await updateOffer(me, pg.id, { scheduling_mode: "request" })).toMatchObject({ scheduling_mode: "request" });
    await expect(updateOffer(me, pg.id, { audience: "open_group" })).rejects.toMatchObject({ code: "INVALID" });   // request mode stays 1:1 / private
    expect(await updateOffer(me, pg.id, { audience: "one" })).toMatchObject({ audience: "one", max_people: 1 });
  });

  it("who it's for can't change once people are booked; open spots can't shrink below the fullest time", async () => {
    const o = await openGroup(4);
    const s = await seedSlot(o, 60);
    await request(o, s); await request(o, s); await request(o, s);
    await expect(updateOffer(me, o.id, { audience: "private_group" })).rejects.toMatchObject({ code: "HAS_BOOKINGS" });
    await expect(updateOffer(me, o.id, { max_people: 2 })).rejects.toMatchObject({ code: "INVALID" });
    expect(await updateOffer(me, o.id, { max_people: 3 })).toMatchObject({ max_people: 3 });
    expect(await updateOffer(me, o.id, { max_people: 12 })).toMatchObject({ max_people: 12 });
  });
});

// ─── G3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("G3 open group capacity", () => {
  it("fills spot by spot; full is refused; the public view shows spots left and full times", async () => {
    const o = await openGroup(2);
    const s1 = await seedSlot(o, 70);
    const s2 = await seedSlot(o, 72);
    let view = await publicOffer(o.public_id);
    expect(view).toMatchObject({ audience: "open_group", maxPeople: 2, fullSlots: [] });
    expect(view.slots.find((x) => x.id === s1)).toMatchObject({ spotsLeft: 2, capacity: 2 });
    await request(o, s1);
    expect((await publicOffer(o.public_id)).slots.find((x) => x.id === s1)).toMatchObject({ spotsLeft: 1 });
    await request(o, s1);
    await expect(request(o, s1)).rejects.toMatchObject({ code: "SLOT_FULL" });
    view = await publicOffer(o.public_id);
    expect(view.slots.map((x) => x.id)).toEqual([s2]);
    expect(view.fullSlots.map((x) => x.id)).toEqual([s1]);
    expect(view.available).toBe(true);
  });

  it("two fans racing for the last spot: exactly one gets it", async () => {
    const o = await openGroup(2);
    const s = await seedSlot(o, 74);
    await request(o, s);
    const results = await Promise.allSettled([request(o, s), request(o, s)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "SLOT_FULL" } });
    const live = await db.select().from(bookings).where(eq(bookings.slot_id, s));
    expect(live).toHaveLength(2);
  });

  it("a lapsed spot reopens; the same email can't hold two spots in one time", async () => {
    const o = await openGroup(1 + 1);
    const s = await seedSlot(o, 76);
    const r = await request(o, s, { buyer_email: "twice@example.test" });
    await expect(request(o, s, { buyer_email: "twice@example.test" })).rejects.toMatchObject({ code: "ALREADY_BOOKED" });
    await request(o, s);
    await expect(request(o, s)).rejects.toMatchObject({ code: "SLOT_FULL" });
    await db.update(bookings).set({ status: "expired" }).where(eq(bookings.id, (await bookingOf(r.token)).id));
    await expect(request(o, s)).resolves.toBeTruthy();
  });
});

// ─── G4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("G4 the slot index per audience", () => {
  it("one live booking per slot for one and private_group; many for open_group", async () => {
    for (const [o, many] of [[await seedOffer(me), false], [await privateGroup(3), false], [await openGroup(5), true]] as const) {
      const s = await seedSlot(o, 80);
      await seedBooking(o, { slot_id: s, audience: o.audience, status: "confirmed" });
      const second = seedBooking(o, { slot_id: s, audience: o.audience, status: "requested" });
      if (many) await expect(second).resolves.toBeTruthy(); else await expect(second).rejects.toThrow();
    }
  });
});

// ─── G5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("G5 an open group confirms itself", () => {
  it("hold → captured → confirmed with no tap; 'You're in' to the fan, a line to her", async () => {
    const o = await openGroup(10);
    const s = await seedSlot(o, 90);
    const b = await bookingOf((await request(o, s)).token);
    email.mockClear();
    await holdPlaced(b);
    const [create] = ops("checkout.sessions.create");
    expect(create.params.custom_text.submit.message).toMatch(/charge it as soon as your spot is confirmed/);
    expect(create.params.line_items[0].price_data.product_data.name).toMatch(/^Group film session · Group session with Ava/);
    expect(ops("paymentIntents.capture")).toHaveLength(1);
    const after = await row(b.id);
    expect(after.status).toBe("confirmed");
    expect(after.meeting_mode).toBe("livekit");
    expect(await pay(b.id)).toMatchObject({ status: "funded" });
    const fan = mailTo(b.buyer_email);
    expect(fan.map((m) => m.subject)).toEqual(["You're in: Group film session with Ava"]);
    expect(fan[0].text).toContain("You're in: 1 of 10 spots.");
    expect(fan[0].text).not.toContain("accepts");
    const her = mailTo("her@example.test");
    expect(her.map((m) => m.subject)).toEqual([`${after.buyer_name.split(" ")[0]} P. joined Group film session`]);
    expect(her[0].text).toContain("1 of 10 spots are taken");
    expect(her[0].text).not.toContain(b.buyer_email);
    // She never answers an open group: no accept / decline, and it is not in her requests.
    await expect(acceptBooking(me, b.id, {})).rejects.toMatchObject({ code: "WRONG_STATE" });
    await expect(declineBooking(me, b.id, {})).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("a capture Stripe didn't answer stays requested (hold in place); the sweep confirms it", async () => {
    const o = await openGroup(10);
    const s = await seedSlot(o, 92);
    const b = await bookingOf((await request(o, s)).token);
    fake.mode.capture = "no_answer";
    await holdPlaced(b);
    expect((await row(b.id)).status).toBe("requested");
    expect(await pay(b.id)).toMatchObject({ status: "authorized" });
    fake.mode.capture = "ok";
    const r = await runBookingsCron();
    expect(r.groupConfirmed).toBeGreaterThanOrEqual(1);
    expect((await row(b.id)).status).toBe("confirmed");
    expect(await autoConfirmOpenGroup(b.id)).toBe("skipped");   // idempotent
  });

  it("a dropped hold ends the request and frees the spot", async () => {
    const o = await openGroup(1 + 1);
    const s = await seedSlot(o, 94);
    const b = await bookingOf((await request(o, s)).token);
    fake.mode.capture = "lapsed";
    await holdPlaced(b);
    expect((await row(b.id)).status).toBe("expired");
    expect((await publicOffer(o.public_id)).slots.find((x) => x.id === s)).toMatchObject({ spotsLeft: 2 });
  });
});

// ─── G6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("G6 her one tap cancels the whole time", () => {
  it("every paid spot refunded in full, the mid-checkout hold released, the time withdrawn", async () => {
    const o = await openGroup(5);
    const s = await seedSlot(o, 100);
    const paid: Booking[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await bookingOf((await request(o, s)).token);
      await holdPlaced(b);
      paid.push(await row(b.id));
    }
    const pending = await bookingOf((await request(o, s)).token);
    expect(paid.every((b) => b.status === "confirmed")).toBe(true);

    const preview = await groupCancelPreview(me, s);
    expect(preview).toMatchObject({ bookings: 3, people: 3, pending: 1, buyerRefundCents: paid.reduce((t, b) => t + b.buyer_total_cents, 0) });
    fake.reset();
    const r = await cancelGroupSession(me, s, { reason: "Injured, so sorry" });
    expect(r).toMatchObject({ canceled: 3, released: 1, refundedCents: preview.buyerRefundCents });
    for (const b of paid) {
      expect(await row(b.id)).toMatchObject({ status: "canceled", canceled_by: "athlete", refund_outcome: "full" });
      expect(await pay(b.id)).toMatchObject({ status: "refunded", refunded_cents: b.buyer_total_cents });
    }
    expect(ops("refunds.create").map((c) => c.params.amount).sort()).toEqual(paid.map((b) => b.buyer_total_cents).sort());
    expect((await row(pending.id)).status).toBe("expired");
    const [slot] = await db.select().from(offerSlots).where(eq(offerSlots.id, s));
    expect(slot.withdrawn_at).not.toBeNull();
    await expect(request(o, s)).rejects.toMatchObject({ code: "INVALID" });   // nobody books a withdrawn time
    expect(r.group.phase).toBe("canceled");
  });

  it("a fan cancelling only frees their own spot", async () => {
    const o = await openGroup(2);
    const s = await seedSlot(o, 102);
    const a = await bookingOf((await request(o, s)).token); await holdPlaced(a);
    const b = await bookingOf((await request(o, s)).token); await holdPlaced(b);
    await expect(request(o, s)).rejects.toMatchObject({ code: "SLOT_FULL" });
    const { cancelByBuyer } = await import("./buyer");
    await cancelByBuyer(await row(a.id));
    expect((await row(a.id)).status).toBe("canceled");
    expect((await row(b.id)).status).toBe("confirmed");
    await expect(request(o, s)).resolves.toBeTruthy();
  });
});

// ─── G7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("G7 a private group's friends", () => {
  it("up to party_size − 1, each with their own link; removing one ends their link", async () => {
    const o = await privateGroup(4);
    const s = await seedSlot(o, 0.05);
    const b = await liveGroupBooking(o, s, { party_size: 3, buyer_email: "booker@example.test", buyer_name: "Riley Booker" });
    await expect(addGuests(b, { email: "booker@example.test" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(addGuests(b, { email: "not-an-email" })).rejects.toMatchObject({ code: "INVALID" });
    email.mockClear();
    let list = await addGuests(b, { email: "Sam@Example.test", name: "Sam Smith" });
    await expect(addGuests(b, { email: "sam@example.test" })).rejects.toMatchObject({ code: "ALREADY_INVITED" });
    list = await addGuests(b, { email: "kai@example.test" });
    await expect(addGuests(b, { email: "third@example.test" })).rejects.toMatchObject({ code: "GUESTS_FULL" });
    expect(list.map((g) => [g.name, g.email])).toEqual([["Sam", "sam@example.test"], [null, "kai@example.test"]]);

    const invites = email.mock.calls.map((c) => c[0]);
    expect(invites.map((m) => m.to)).toEqual(["sam@example.test", "kai@example.test"]);
    expect(invites[0].subject).toBe("Riley invited you to Team session with Ava");
    expect(invites[0].text).not.toContain("booker@example.test");
    const links = invites.map((m) => /https:\/\/book\.test\/s\/(\S+)/.exec(m.text)![1]);
    expect(new Set(links).size).toBe(2);
    const sam = await guestByLink(links[0]);
    expect(sam).toMatchObject({ bookingId: b.id, guest: { email: "sam@example.test" } });

    // the friend's own call page: same session, no money taps; join gives THEIR identity
    const state = await call("GET", `/s/${links[0]}/state`);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ you: { role: "guest" }, booking: { audience: "private_group", groupSize: 3 }, after: { canSayItHappened: false, canReport: false } });
    expect(JSON.stringify(state.body)).not.toContain("booker@example.test");
    expect((await call("POST", `/s/${links[0]}/happened`)).status).toBe(403);
    const join = await call("POST", `/s/${links[0]}/join`);
    expect(join.status).toBe(200);
    const claims = await verify(join.body.token);
    expect(claims.sub).toBe(guestIdentityFor(sam!.guest.id));
    expect(claims.name).toBe("Sam");
    expect(claims.video?.room).toBe(roomNameFor(b.id));
    expect(claims.roomConfig?.maxParticipants).toBe(4);   // the party of 3 + her

    // removed: the link is dead, they're taken out of the call, and the place is free again
    list = await removeGuest(b, sam!.guest.id);
    expect(list.map((g) => g.email)).toEqual(["kai@example.test"]);
    expect(await guestByLink(links[0])).toBeNull();
    expect((await call("GET", `/s/${links[0]}/state`)).status).toBe(404);
    expect(removeFromRoom).toHaveBeenCalledWith(roomNameFor(b.id), guestIdentityFor(sam!.guest.id));
    await expect(addGuests(b, { email: "third@example.test" })).resolves.toHaveLength(2);
  });

  it("her cancel preview counts PEOPLE (party sizes), not bookings", async () => {
    const o = await openGroup(4);
    const s = await seedSlot(o, 110);
    await liveGroupBooking(o, s, { startsInHours: 110 });
    await liveGroupBooking(o, s, { startsInHours: 110 });
    expect(await groupCancelPreview(me, s)).toMatchObject({ bookings: 2, people: 2, pending: 0 });
  });

  it("friends can be added only once the booking is paid, and never to a 1:1 or open group", async () => {
    const o = await privateGroup(3);
    const b = await seedBooking(o, { status: "requested", audience: "private_group", party_size: 2, unit_price_cents: 7_500, price_cents: 15_000 });
    await expect(addGuests(b, { email: "x@example.test" })).rejects.toMatchObject({ code: "WRONG_STATE" });
    const one = await seedBooking(await seedOffer(me), { status: "confirmed" });
    await expect(addGuests(one, { email: "x@example.test" })).rejects.toMatchObject({ code: "WRONG_STATE" });
  });
});

// ─── G8 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("G8 video rooms per audience", () => {
  it("1:1: room per booking, 2 people (unchanged)", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { status: "confirmed", meeting_mode: "livekit", startsInHours: 0.05 });
    await seedFunded(b);
    const t = await mintJoinToken((await getBookingForSession(b.id))!, "buyer", new Date());
    const c = await verify(t.token);
    expect(t.room).toBe(roomNameFor(b.id));
    expect(c.sub).toBe(identityFor(b.id, "buyer"));
    expect(c.roomConfig?.maxParticipants).toBe(2);
  });

  it("open group: ONE room per time, max_people + 1, each fan their own identity, every fan named 'Fan', her one identity", async () => {
    const o = await openGroup(6);
    const s = await seedSlot(o, 0.05);
    const a = await liveGroupBooking(o, s);
    const b = await liveGroupBooking(o, s);
    const now = new Date();
    const ta = await mintJoinToken((await getBookingForSession(a.id))!, "buyer", now);
    const tb = await mintJoinToken((await getBookingForSession(b.id))!, "buyer", now);
    expect(ta.room).toBe(slotRoomNameFor(s));
    expect(tb.room).toBe(ta.room);
    expect(ta.room).not.toContain(s);                              // no raw ids in LiveKit
    expect(ta.identity).toBe(identityFor(a.id, "buyer"));
    expect(tb.identity).toBe(identityFor(b.id, "buyer"));
    const ca = await verify(ta.token);
    expect(ca.name).toBe("Fan");
    expect(JSON.stringify(ca)).not.toContain(a.buyer_email);
    expect(ca.roomConfig?.maxParticipants).toBe(7);
    const her1 = await mintJoinToken((await getBookingForSession(a.id))!, "athlete", now);
    const her2 = await mintJoinToken((await getBookingForSession(b.id))!, "athlete", now);
    expect(her1.identity).toBe(slotAthleteIdentityFor(s));
    expect(her2.identity).toBe(her1.identity);
    expect((await verify(her1.token)).name).toBe("Ava");
  });

  it("her group join route: the time's room; another athlete's time is a 404", async () => {
    const o = await openGroup(4);
    const s = await seedSlot(o, 0.05);
    await liveGroupBooking(o, s);
    const r = await call("POST", `/api/v1/me/bookings/groups/${s}/session/token`, { athlete: me });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ room: slotRoomNameFor(s), identity: slotAthleteIdentityFor(s) });
    const other = await seedAthlete("Someone Else");
    expect((await call("POST", `/api/v1/me/bookings/groups/${s}/session/token`, { athlete: other })).status).toBe(404);
  });
});

// ─── G9 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

let ev = 0;
async function webhook(event: string, room: string, identity: string) {
  const body = JSON.stringify({ event, id: `EVG_${++ev}`, createdAt: String(Math.floor(Date.now() / 1000)), room: { name: room, sid: "RM" }, participant: { identity, sid: "PA" } });
  const at = new AccessToken(KEY, SECRET);
  at.sha256 = createHash("sha256").update(body).digest("base64");
  return handleLivekitWebhook(body, await at.toJwt());
}
const attendance = async (bookingId: string) =>
  (await db.select().from(bookingEvents).where(and(eq(bookingEvents.booking_id, bookingId), eq(bookingEvents.kind, "attendance")))).map((e) => e.data as any);

describe("G9 the attendance webhook maps every identity", () => {
  it("open group: her join lands on every live spot; a fan's on their own booking only", async () => {
    const o = await openGroup(5);
    const s = await seedSlot(o, 0.05);
    const a = await liveGroupBooking(o, s);
    const b = await liveGroupBooking(o, s);
    const gone = await liveGroupBooking(o, s, { status: "canceled", canceled_by: "buyer", refund_outcome: "price_only" });
    const her = await webhook("participant_joined", slotRoomNameFor(s), slotAthleteIdentityFor(s));
    expect(her).toMatchObject({ handled: true, role: "athlete", recorded: true });
    expect((her as any).bookingIds.sort()).toEqual([a.id, b.id].sort());
    expect(await attendance(gone.id)).toEqual([]);
    const fan = await webhook("participant_joined", slotRoomNameFor(s), identityFor(b.id, "buyer"));
    expect(fan).toMatchObject({ handled: true, role: "buyer", bookingIds: [b.id] });
    expect((await attendance(a.id)).map((d) => d.role)).toEqual(["athlete"]);
    expect((await attendance(b.id)).map((d) => d.role).sort()).toEqual(["athlete", "buyer"]);
    // a per-booking identity of the same fan in a per-booking room means nothing here
    expect(await webhook("participant_joined", slotRoomNameFor(s), identityFor(a.id, "athlete"))).toEqual({ handled: false, reason: "unknown_identity" });
  });

  it("private group: booker, friend (role guest + guestId), her; a removed friend is ignored", async () => {
    const o = await privateGroup(3);
    const s = await seedSlot(o, 0.05);
    const b = await liveGroupBooking(o, s, { party_size: 3 });
    await addGuests(b, { guests: [{ email: "g1@example.test", name: "Gia" }, { email: "g2@example.test" }] });
    const [g1, g2] = await db.select().from(bookingGuests).where(eq(bookingGuests.booking_id, b.id)).orderBy(bookingGuests.created_at);
    const room = roomNameFor(b.id);
    expect(await webhook("participant_joined", room, identityFor(b.id, "athlete"))).toMatchObject({ role: "athlete", bookingIds: [b.id] });
    expect(await webhook("participant_joined", room, identityFor(b.id, "buyer"))).toMatchObject({ role: "buyer" });
    expect(await webhook("participant_joined", room, guestIdentityFor(g1.id))).toMatchObject({ role: "guest", guestId: g1.id, bookingIds: [b.id] });
    await removeGuest(b, g2.id);
    expect(await webhook("participant_joined", room, guestIdentityFor(g2.id))).toEqual({ handled: false, reason: "unknown_identity" });
    const { attendanceSummary } = await import("./session/sessionStore");
    expect(await attendanceSummary(b.id)).toMatchObject({ athleteJoined: true, buyerJoined: true, guestsJoined: 1, guestsInRoom: 1, partyJoined: true });
  });
});

// ─── G10 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("G10 her group view", () => {
  it("one item per time, first names and identities, never contact details; removal is hers", async () => {
    const o = await openGroup(4, { title: "Film room" });
    const s = await seedSlot(o, 0.05);
    const a = await liveGroupBooking(o, s, { buyer_name: "Jordan Park", buyer_email: "jordan@example.test" });
    const b = await liveGroupBooking(o, s, { buyer_name: "Casey Lee", buyer_email: "casey@example.test" });
    const list = await listGroupSessions(me, "upcoming");
    const item = list.find((g) => g.slotId === s)!;
    expect(item).toMatchObject({ title: "Film room", capacity: 4, spotsTaken: 2, spotsLeft: 2, firstNames: ["Jordan", "Casey"], receiveCents: 30_000, unitPriceCents: 15_000 });

    const r = await call("GET", `/api/v1/me/bookings/groups/${s}`, { athlete: me });
    expect(r.status).toBe(200);
    expect(r.body.group.attendees.map((x: any) => [x.firstName, x.identity])).toEqual([["Jordan", identityFor(a.id, "buyer")], ["Casey", identityFor(b.id, "buyer")]]);
    expect(r.body.group.actions).toMatchObject({ join: true, cancel: true, removeParticipant: true });
    expect(JSON.stringify(r.body)).not.toMatch(/example\.test/);
    expect((await call("GET", `/api/v1/me/bookings/groups`, { athlete: me })).body.groups.some((g: any) => g.slotId === s)).toBe(true);

    const rm = await call("POST", `/api/v1/me/bookings/groups/${s}/session/remove`, { athlete: me, body: { identity: identityFor(b.id, "buyer") } });
    expect(rm).toMatchObject({ status: 200, body: { removed: true } });
    expect(removeFromRoom).toHaveBeenCalledWith(slotRoomNameFor(s), identityFor(b.id, "buyer"));
    // removed: their link gets no new token; the others are unaffected
    const { sessionUrlFor } = await import("./session/sessionStore");
    const linkOf = (id: string) => sessionUrlFor({ id, startsAt: new Date(), endsAt: new Date(Date.now() + H) }).split("/s/")[1];
    expect(await call("POST", `/s/${linkOf(b.id)}/join`)).toMatchObject({ status: 403, body: { error: "removed" } });
    expect((await call("POST", `/s/${linkOf(a.id)}/join`)).status).toBe(200);
    // her own identity is not removable; another athlete can't remove anyone
    expect((await call("POST", `/api/v1/me/bookings/groups/${s}/session/remove`, { athlete: me, body: { identity: slotAthleteIdentityFor(s) } })).status).toBe(400);
    const other = await seedAthlete("Not Her");
    expect((await call("POST", `/api/v1/me/bookings/groups/${s}/session/remove`, { athlete: other, body: { identity: identityFor(a.id, "buyer") } })).status).toBe(404);
    expect((await groupSessionDetail(me, s)).attendees).toHaveLength(2);   // removal never changes a booking
  });
});


// ─── G11 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("G11 her private-group call view", () => {
  it("the booker and each friend with identity + first name; Remove only while open and someone is left", async () => {
    const o = await privateGroup(4);
    const s = await seedSlot(o, 0.05);
    const b = await liveGroupBooking(o, s, { party_size: 3, buyer_email: "riley@example.test", buyer_name: "Riley Booker" });
    const [sam] = await addGuests(b, { email: "sam@example.test", name: "Sam Smith" });
    const [, kai] = await addGuests(b, { email: "kai@example.test" });

    let v = await call("GET", `/api/v1/me/bookings/${b.id}/session`, { athlete: me });
    expect(v.status).toBe(200);
    expect(v.body.participants).toEqual([
      { identity: identityFor(b.id, "buyer"), firstName: "Riley", role: "buyer", removed: false },
      { identity: guestIdentityFor(sam.id), firstName: "Sam", role: "guest", removed: false },
      { identity: guestIdentityFor(kai.id), firstName: "Guest", role: "guest", removed: false },
    ]);
    expect(v.body.actions).toEqual({ removeParticipant: true });
    expect(JSON.stringify(v.body)).not.toMatch(/example\.test/);

    for (const identity of [identityFor(b.id, "buyer"), guestIdentityFor(sam.id), guestIdentityFor(kai.id)]) {
      expect((await call("POST", `/api/v1/me/bookings/${b.id}/session/remove`, { athlete: me, body: { identity } })).status).toBe(200);
    }
    v = await call("GET", `/api/v1/me/bookings/${b.id}/session`, { athlete: me });
    expect(v.body.participants.every((p: any) => p.removed)).toBe(true);
    expect(v.body.actions.removeParticipant).toBe(false);   // nobody left to take out
  });

  it("no Remove before the call opens; a 1:1 lists its booker; an open group's spot lists nobody (its time does)", async () => {
    const pg = await privateGroup(3);
    const later = await liveGroupBooking(pg, await seedSlot(pg, 48), { party_size: 2, startsInHours: 48 });
    const v = await call("GET", `/api/v1/me/bookings/${later.id}/session`, { athlete: me });
    expect(v.body.participants).toHaveLength(1);
    expect(v.body.actions.removeParticipant).toBe(false);

    const solo = await seedOffer(me);
    const one = await liveGroupBooking(solo, await seedSlot(solo, 0.05), { unit_price_cents: null, buyer_name: "Jo Solo" });
    const v1 = await call("GET", `/api/v1/me/bookings/${one.id}/session`, { athlete: me });
    expect(v1.body.participants).toEqual([{ identity: identityFor(one.id, "buyer"), firstName: "Jo", role: "buyer", removed: false }]);
    expect(v1.body.actions.removeParticipant).toBe(true);

    const og = await openGroup(3);
    const fan = await liveGroupBooking(og, await seedSlot(og, 0.05));
    const v2 = await call("GET", `/api/v1/me/bookings/${fan.id}/session`, { athlete: me });
    expect(v2.body).toMatchObject({ participants: [], actions: { removeParticipant: false } });
  });
});

// ─── G12 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("G12 the Opportunities summary folds an open group into one line", () => {
  it("one line per time with its spots; 1:1 and private lines carry audience + party; no open-group requests", async () => {
    const { readBookingsSummary } = await import("./summary");
    const who = await seedAthlete("Summary Athlete");
    const og = await seedOffer(who, { audience: "open_group", max_people: 10, scheduling_mode: "slots", title: "Film room" });
    const s = await seedSlot(og, 24);
    const q = quotePartyCharge(og.price_cents, 1);
    const spot = (over: Partial<typeof bookings.$inferInsert> = {}) => seedBooking(og, {
      status: "confirmed", slot_id: s, audience: "open_group", party_size: 1, unit_price_cents: og.price_cents,
      price_cents: q.priceCents, service_fee_cents: q.serviceFeeCents, buyer_total_cents: q.buyerTotalCents, startsInHours: 24,
      buyer_name: `Fan${++n} Person`, buyer_email: `sum${n}@example.test`, buyer_email_hash: `sh${n}`, ...over,
    });
    for (let i = 0; i < 3; i++) await spot();
    await spot({ status: "requested" });   // a fan mid-checkout: holds a spot, never a request for her
    const one = await seedBooking(await seedOffer(who), { status: "confirmed", startsInHours: 30 });
    const pg = await seedOffer(who, { audience: "private_group", max_people: 4, scheduling_mode: "slots", title: "Team session" });
    const team = await seedBooking(pg, { status: "confirmed", audience: "private_group", party_size: 3, unit_price_cents: 5_000, price_cents: 15_000, startsInHours: 40 });

    const sum = await readBookingsSummary(who);
    expect(sum.requests).toEqual([]);
    expect(sum.upcoming).toHaveLength(3);
    expect(sum.upcoming[0]).toMatchObject({
      title: "Film room", audience: "open_group", slotId: s, spotsTaken: 4, capacity: 10, status: "confirmed", priceCents: 3 * q.priceCents,
    });
    expect(sum.upcoming[1]).toMatchObject({ id: one.id, audience: "one", slotId: null, spotsTaken: 1, capacity: 1 });
    expect(sum.upcoming[2]).toMatchObject({ id: team.id, audience: "private_group", spotsTaken: 3, capacity: 3, priceCents: 15_000 });
  });
});
