/**
 * sessionsSafety.integration.test.ts — Bookings v2 sessions safety (0154) against PGlite. Stripe is faked at the
 * boundary (testUtils/fakeStripeBookings), the email channel is mocked, LiveKit is never called (tokens are signed
 * locally; RoomService remove / mute are mocked like groupSessions.integration.test.ts does).
 *
 *   X1 mute / turn off camera: her tap only (401 without auth, 404 for another athlete's booking or time); the identity
 *      maps to the right room and person (1:1 booker, a private-group friend, one fan in an open group's ONE room);
 *      her own identity and unknown identities are refused; each tap is a booking event
 *   X2 blocking: a block is recorded from a booking (and from a call tile: taken out of the call too); enforced on a new
 *      request (the same answer, nothing created — by email and by phone), on a friend invite (CANT_INVITE), on the
 *      join token (blocked booker and blocked friend: not_joinable); her list and unblock
 *   X3 a block with an upcoming paid booking: the preview names it; blocking cancels it with a FULL refund (her cancel);
 *      a pending request is declined with the hold released; a session that started is left alone
 *   X4 "Approve each spot" (open groups): the spot waits for her (a request in her list), the auto-confirm and its sweep
 *      leave it alone, Accept captures and confirms it, Decline releases the hold, capacity still holds, respond_by lapses
 *   X5 attendance: no LiveKit evidence at all → attendance_unknown, and nobody is told the other didn't show; a side
 *      that tapped Join is never reported absent; real evidence still tells the waiting side; join_tapped is recorded
 *      once per identity per booking
 *   X6 joining muted: a group call's fan / friend token says startMuted, a 1:1's doesn't; the call page is told
 */
process.env.LIVEKIT_URL = "wss://safety-test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "APIsafetytest";
process.env.LIVEKIT_API_SECRET = "safety-test-secret-at-least-32-bytes-long-x";
process.env.SESSION_SECRET = "safety-session-link-secret";
process.env.PUBLIC_BASE_URL = "https://book.test";

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/stripe", () => require("../../testUtils/fakeStripeBookings").stripeModule);
jest.mock("../../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));
jest.mock("./session/roomAdmin", () => ({ removeFromRoom: jest.fn(async () => true), muteInRoom: jest.fn(async () => "muted") }));
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
import { AccessToken } from "livekit-server-sdk";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { fake } from "../../testUtils/fakeStripeBookings";
import { seedBooking, seedFunded, seedHeld, seedOffer, seedPayoutAccount, seedSlot } from "../../testUtils/seedBookings";
import { athletes, bookingEvents, bookingGuests, bookings, fanBlocks, offers, payments } from "../../../shared/schema";
import type { Booking, Offer } from "../../../shared/schema";
import { sendEmail } from "../../lib/notify";
import { quotePartyCharge } from "./money";
import { createRequest } from "./buyer";
import { createOffer, updateOffer } from "./offers";
import { acceptBooking, bookingDetail, declineBooking, listBookings } from "./athlete";
import { autoConfirmOpenGroup, createHoldCheckout, syncHoldForBooking } from "./charges";
import { runBookingsCron } from "./sweeper";
import { addGuests } from "./guests";
import { groupSessionDetail } from "./groups";
import { blockFromCall, blockPreview } from "./blocking";
import { emailHash, phoneHash } from "./tokens";
import { attendanceSummary, guestSessionUrlFor, sessionUrlFor } from "./session/sessionStore";
import { runBookingSessionSweep } from "./session/sessionSweep";
import { handleLivekitWebhook } from "./session/livekitWebhook";
import { guestIdentityFor, identityFor, roomNameFor, slotAthleteIdentityFor, slotRoomNameFor } from "./session/sessionRoom";
import { muteInRoom, removeFromRoom } from "./session/roomAdmin";
import { isFanBlocked } from "../fanSafety/fanBlocks";
import bookingsRouter from "../../routes/bookings";
import { athleteSessionRouter, buyerSessionRouter } from "../../routes/bookingSession";

const email = sendEmail as jest.Mock;
const mute = muteInRoom as jest.Mock;
const remove = removeFromRoom as jest.Mock;
const KEY = process.env.LIVEKIT_API_KEY!;
const SECRET = process.env.LIVEKIT_API_SECRET!;
const MIN = 60_000;
const row = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];
const pay = async (id: string) => (await db.select().from(payments).where(eq(payments.booking_id, id)))[0];
const ops = (op: string) => fake.calls.filter((c) => c.op === op);
const mailTo = (to: string) => email.mock.calls.filter((c) => c[0].to === to).map((c) => c[0]);
const events = async (id: string) => db.select().from(bookingEvents).where(eq(bookingEvents.booking_id, id)).orderBy(bookingEvents.at);
const linkToken = (url: string) => url.split("/s/")[1];

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
beforeEach(() => { email.mockClear(); fake.reset(); mute.mockClear(); remove.mockClear(); });

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
const privateGroup = (max = 4) => seedOffer(me, { audience: "private_group", max_people: max, scheduling_mode: "slots", title: "Team session" });

/** A booking whose buyer hashes are the real keyed hashes of its email / phone (so a block matches the next request). */
async function liveBooking(o: Offer, over: Partial<typeof bookings.$inferInsert> & { startsInHours?: number } = {}): Promise<Booking> {
  const party = (over.party_size as number | undefined) ?? 1;
  const q = quotePartyCharge(o.price_cents, party);
  const mail = (over.buyer_email as string | undefined) ?? `fan${++n}@example.test`;
  const phone = (over.buyer_phone as string | undefined) ?? `+1512555${String(1000 + ++n).slice(-4)}`;
  const b = await seedBooking(o, {
    status: "confirmed", audience: o.audience, party_size: party, unit_price_cents: o.price_cents,
    price_cents: q.priceCents, service_fee_cents: q.serviceFeeCents, buyer_total_cents: q.buyerTotalCents,
    meeting_mode: "livekit", startsInHours: 0.05, buyer_name: `Fan${n} Person`, buyer_email: mail, buyer_email_hash: emailHash(mail),
    buyer_phone: phone, buyer_phone_hash: phoneHash(phone), ...over,
  });
  await seedFunded(b);
  return b;
}

function request(o: Offer, over: Record<string, unknown> = {}) {
  return createRequest(o.public_id, {
    buyer_name: "Jordan Park", buyer_email: `req${++n}@example.test`, buyer_timezone: "America/New_York",
    adult_attested: true, agree_terms: true, displayed_total_cents: quotePartyCharge(o.price_cents, 1).buyerTotalCents, ...over,
  });
}
const bookingOf = async (token: string): Promise<Booking | undefined> => {
  const { buyerTokenHash } = await import("./tokens");
  return (await db.select().from(bookings).where(eq(bookings.buyer_token_hash, buyerTokenHash(token))))[0];
};
async function holdPlaced(b: Booking): Promise<void> {
  await db.update(bookings).set({ email_verified_at: new Date() }).where(eq(bookings.id, b.id));
  const r = await createHoldCheckout(b.id);
  expect(r).toHaveProperty("url");
  fake.completeHold([...fake.sessions.keys()].at(-1)!);
  await syncHoldForBooking(b.id);
}

let ev = 0;
async function webhook(event: string, room: string, identity: string) {
  const body = JSON.stringify({ event, id: `EVS_${++ev}`, createdAt: String(Math.floor(Date.now() / 1000)), room: { name: room, sid: "RM" }, participant: { identity, sid: "PA" } });
  const at = new AccessToken(KEY, SECRET);
  at.sha256 = createHash("sha256").update(body).digest("base64");
  return handleLivekitWebhook(body, await at.toJwt());
}

// ─── X1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("X1 mute and turn off camera", () => {
  it("1:1: her tap only; the booker's identity in the booking's room; recorded on the booking", async () => {
    const b = await liveBooking(await seedOffer(me));
    const path = `/api/v1/me/bookings/${b.id}/session/mute`;
    const body = { identity: identityFor(b.id, "buyer"), track: "microphone" };
    expect((await call("POST", path, { body })).status).toBe(401);
    const other = await seedAthlete("Other Athlete");
    expect((await call("POST", path, { athlete: other, body })).status).toBe(404);
    expect(mute).not.toHaveBeenCalled();

    const r = await call("POST", path, { athlete: me, body });
    expect(r).toEqual({ status: 200, body: { outcome: "muted" } });
    expect(mute).toHaveBeenCalledWith(roomNameFor(b.id), identityFor(b.id, "buyer"), "microphone");
    const cam = await call("POST", path, { athlete: me, body: { ...body, track: "camera" } });
    expect(cam.status).toBe(200);
    expect(mute).toHaveBeenLastCalledWith(roomNameFor(b.id), identityFor(b.id, "buyer"), "camera");
    const safety = (await events(b.id)).filter((e) => e.kind === "safety").map((e) => e.data);
    expect(safety).toEqual([
      { moderation: "mute_mic", who: "buyer", outcome: "muted" },
      { moderation: "camera_off", who: "buyer", outcome: "muted" },
    ]);
    expect((await events(b.id)).find((e) => e.kind === "safety")!.actor).toBe("athlete");
  });

  it("refuses her own identity, an unknown identity and an unknown track", async () => {
    const b = await liveBooking(await seedOffer(me));
    const path = `/api/v1/me/bookings/${b.id}/session/mute`;
    expect((await call("POST", path, { athlete: me, body: { identity: identityFor(b.id, "athlete"), track: "microphone" } })).status).toBe(404);
    expect((await call("POST", path, { athlete: me, body: { identity: "b_nobody", track: "microphone" } })).status).toBe(404);
    expect((await call("POST", path, { athlete: me, body: { identity: identityFor(b.id, "buyer"), track: "screen" } })).status).toBe(400);
    expect(mute).not.toHaveBeenCalled();
  });

  it("private group: a friend's identity; open group: one fan in the time's ONE room, via the booking or the time", async () => {
    const pg = await liveBooking(await privateGroup(3), { party_size: 3 });
    await addGuests(pg, { email: "friend@example.test", name: "Gia" });
    const [g] = await db.select().from(bookingGuests).where(eq(bookingGuests.booking_id, pg.id));
    expect((await call("POST", `/api/v1/me/bookings/${pg.id}/session/mute`, { athlete: me, body: { identity: guestIdentityFor(g.id), track: "microphone" } })).status).toBe(200);
    expect(mute).toHaveBeenLastCalledWith(roomNameFor(pg.id), guestIdentityFor(g.id), "microphone");
    expect((await events(pg.id)).filter((e) => e.kind === "safety").map((e) => e.data)).toContainEqual({ moderation: "mute_mic", who: `guest:${g.id}`, outcome: "muted" });

    const o = await openGroup(4);
    const s = await seedSlot(o, 0.05);
    const a = await liveBooking(o, { slot_id: s });
    const b = await liveBooking(o, { slot_id: s });
    expect((await call("POST", `/api/v1/me/bookings/groups/${s}/session/mute`, { athlete: me, body: { identity: identityFor(b.id, "buyer"), track: "camera" } })).status).toBe(200);
    expect(mute).toHaveBeenLastCalledWith(slotRoomNameFor(s), identityFor(b.id, "buyer"), "camera");
    expect((await events(b.id)).filter((e) => e.kind === "safety")).toHaveLength(1);
    expect((await events(a.id)).filter((e) => e.kind === "safety")).toHaveLength(0);
    // from one fan's booking, any fan of the time can be muted (one room); her own slot identity can't
    expect((await call("POST", `/api/v1/me/bookings/${a.id}/session/mute`, { athlete: me, body: { identity: identityFor(b.id, "buyer"), track: "microphone" } })).status).toBe(200);
    expect((await call("POST", `/api/v1/me/bookings/groups/${s}/session/mute`, { athlete: me, body: { identity: slotAthleteIdentityFor(s), track: "microphone" } })).status).toBe(400);
    const other = await seedAthlete("Other Group Athlete");
    expect((await call("POST", `/api/v1/me/bookings/groups/${s}/session/mute`, { athlete: other, body: { identity: identityFor(b.id, "buyer"), track: "microphone" } })).status).toBe(404);
  });
});

// ─── X2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("X2 blocking", () => {
  it("from a booking: recorded, then a new request gets the usual answer and nothing is created (email and phone)", async () => {
    const o = await seedOffer(me, { scheduling_mode: "request" });
    const b = await liveBooking(o, { buyer_email: "pest@example.test", buyer_phone: "+15125550100", startsInHours: -2 });
    const r = await call("POST", `/api/v1/me/bookings/${b.id}/block`, { athlete: me, body: { reason: "rude" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ block: { firstName: expect.any(String), source: "booking", bookingId: b.id, reason: "rude" }, canceled: 0 });
    const [blk] = await db.select().from(fanBlocks).where(eq(fanBlocks.athlete_id, me));
    expect(blk).toMatchObject({ email_hash: emailHash("pest@example.test"), phone_hash: phoneHash("+15125550100"), removed_at: null });
    expect(JSON.stringify(r.body)).not.toContain(blk.email_hash);
    expect((await bookingDetail(me, b.id)).fanBlocked).toBe(true);
    expect((await bookingDetail(me, b.id)).actions.block).toBe(false);

    const times = [{ start: new Date(Date.now() + 72 * 3_600_000).toISOString(), tz: "America/New_York" }];
    const count = async () => (await db.select().from(bookings).where(eq(bookings.offer_id, o.id))).length;
    const before = await count();
    const sent = await request(o, { buyer_email: "Pest@Example.test", proposed_times: times });
    expect(sent).toMatchObject({ status: "unverified", nextStep: "email" });   // the same answer as anyone
    expect(await count()).toBe(before);
    expect(email).not.toHaveBeenCalled();
    // a new address with the same phone number
    await request(o, { buyer_email: "pest2@example.test", buyer_phone: "+1 512 555 0100", proposed_times: times });
    expect(await count()).toBe(before);
    // someone else books as usual
    await request(o, { proposed_times: times });
    expect(await count()).toBe(before + 1);
    // idempotent: blocking again changes nothing
    expect((await call("POST", `/api/v1/me/bookings/${b.id}/block`, { athlete: me, body: {} })).status).toBe(200);
    expect(await db.select().from(fanBlocks).where(eq(fanBlocks.athlete_id, me))).toHaveLength(1);

    // her list, and unblock
    const list = await call("GET", "/api/v1/me/bookings/blocks", { athlete: me });
    expect(list.body.blocks.map((x: any) => x.id)).toEqual([blk.id]);
    const other = await seedAthlete("Not Her");
    expect((await call("DELETE", `/api/v1/me/bookings/blocks/${blk.id}`, { athlete: other })).status).toBe(404);
    const un = await call("DELETE", `/api/v1/me/bookings/blocks/${blk.id}`, { athlete: me });
    expect(un).toEqual({ status: 200, body: { blocks: [] } });
    await request(o, { buyer_email: "pest@example.test", proposed_times: times });
    expect(await count()).toBe(before + 2);
    await db.delete(fanBlocks).where(eq(fanBlocks.athlete_id, me));
  });

  it("enforced on friend invites: a blocked address can't be added (whoever types it)", async () => {
    const pest = await liveBooking(await seedOffer(me), { buyer_email: "blocked-friend@example.test", startsInHours: -3 });
    await blockFromCall(me, { bookingId: pest.id }, {});
    const pg = await liveBooking(await privateGroup(3), { party_size: 3, startsInHours: 30 });
    await expect(addGuests(pg, { email: "Blocked-Friend@example.test" })).rejects.toMatchObject({ code: "CANT_INVITE" });
    await expect(addGuests(pg, { email: "fine@example.test" })).resolves.toHaveLength(1);
    await db.delete(fanBlocks).where(eq(fanBlocks.athlete_id, me));
  });

  it("enforced on the join token: a blocked booker and a blocked friend get 'not_joinable'; from a call tile = out + blocked", async () => {
    const pg = await liveBooking(await privateGroup(3), { party_size: 3 });
    await addGuests(pg, { guests: [{ email: "g-one@example.test", name: "Gia" }, { email: "g-two@example.test", name: "Kai" }] });
    const [g1, g2] = await db.select().from(bookingGuests).where(eq(bookingGuests.booking_id, pg.id)).orderBy(bookingGuests.created_at);
    const booker = linkToken(sessionUrlFor({ id: pg.id, startsAt: pg.starts_at, endsAt: pg.ends_at }));
    const friend2 = linkToken(guestSessionUrlFor(g2.id, { startsAt: pg.starts_at, endsAt: pg.ends_at }));
    expect((await call("POST", `/s/${booker}/join`)).status).toBe(200);
    expect((await call("POST", `/s/${friend2}/join`)).status).toBe(200);

    // her tile menu "Block" on friend one: out of the call, blocked, the friend's row revoked by the removal ledger
    const r = await call("POST", `/api/v1/me/bookings/${pg.id}/block`, { athlete: me, body: { identity: guestIdentityFor(g1.id) } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ block: { source: "guest", firstName: "Gia" }, removedFromCall: true });
    expect(remove).toHaveBeenCalledWith(roomNameFor(pg.id), guestIdentityFor(g1.id));
    expect(await isFanBlocked(me, { emailHash: emailHash("g-one@example.test") })).toBe(true);
    expect((await row(pg.id)).status).toBe("confirmed");   // blocking a friend never cancels the booker's booking

    // a blocked friend's own link (invited again elsewhere is refused anyway); a blocked booker
    await db.insert(fanBlocks).values({ athlete_id: me, email_hash: g2.email_hash, source: "guest" });
    const j2 = await call("POST", `/s/${friend2}/join`);
    expect(j2).toEqual({ status: 403, body: { error: "not_joinable" } });
    await db.insert(fanBlocks).values({ athlete_id: me, email_hash: pg.buyer_email_hash, source: "booking" });
    expect(await call("POST", `/s/${booker}/join`)).toEqual({ status: 403, body: { error: "not_joinable" } });
    // her own token is never affected
    expect((await call("POST", `/api/v1/me/bookings/${pg.id}/session/token`, { athlete: me })).status).toBe(200);
    await db.delete(fanBlocks).where(eq(fanBlocks.athlete_id, me));
  });

  it("an open group's attendee: blocked from the time's call by identity (it has started: their spot stays); the group view says so", async () => {
    const o = await openGroup(4);
    const s = await seedSlot(o, -0.05);
    const a = await liveBooking(o, { slot_id: s, startsInHours: -0.05 });
    const b = await liveBooking(o, { slot_id: s, startsInHours: -0.05 });
    const r = await call("POST", `/api/v1/me/bookings/groups/${s}/block`, { athlete: me, body: { identity: identityFor(b.id, "buyer") } });
    expect(r.status).toBe(200);
    expect(remove).toHaveBeenCalledWith(slotRoomNameFor(s), identityFor(b.id, "buyer"));
    const g = await groupSessionDetail(me, s);
    expect(g.attendees.find((x) => x.bookingId === b.id)).toMatchObject({ blocked: true });
    expect(g.attendees.find((x) => x.bookingId === a.id)).toMatchObject({ blocked: false });
    expect((await call("POST", `/api/v1/me/bookings/groups/${s}/block`, { athlete: me, body: {} })).status).toBe(400);   // a time needs the identity
    await db.delete(fanBlocks).where(eq(fanBlocks.athlete_id, me));
  });
});

// ─── X3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("X3 a block with an upcoming paid booking", () => {
  it("the preview names it; blocking cancels it with a full refund, declines the pending request, leaves a started one", async () => {
    const o = await seedOffer(me);
    const mail = "upcoming@example.test";
    const now = await liveBooking(o, { buyer_email: mail, startsInHours: -0.1 });            // happening now: left alone
    const later = await liveBooking(o, { buyer_email: mail, startsInHours: 96 });            // upcoming, paid
    const asked = await seedBooking(o, { status: "requested", buyer_email: mail, buyer_email_hash: emailHash(mail), startsInHours: 120 });
    await seedHeld(asked);

    const preview = await call("GET", `/api/v1/me/bookings/${now.id}/block-preview`, { athlete: me });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ role: "buyer", alreadyBlocked: false, pendingRequests: 1 });
    expect(preview.body.cancels).toEqual([{ bookingId: later.id, title: later.title, startsAt: later.starts_at!.toISOString(), refundCents: later.buyer_total_cents }]);

    const r = await call("POST", `/api/v1/me/bookings/${now.id}/block`, { athlete: me, body: {} });
    expect(r.body).toMatchObject({ canceled: 1, refundedCents: later.buyer_total_cents, requestsEnded: 1 });
    expect(await row(later.id)).toMatchObject({ status: "canceled", canceled_by: "athlete", refund_outcome: "full" });
    expect(await pay(later.id)).toMatchObject({ status: "refunded", refunded_cents: later.buyer_total_cents });
    expect(ops("refunds.create").map((c) => c.params.amount)).toEqual([later.buyer_total_cents]);
    expect((await row(asked.id)).status).toBe("declined");
    expect(ops("paymentIntents.cancel")).toHaveLength(1);
    expect((await row(now.id)).status).toBe("confirmed");
    // the fan hears only that it was cancelled, never about a block
    const toFan = mailTo(mail).map((m) => `${m.subject} ${m.text}`).join("\n");
    expect(toFan).toMatch(/cancel/i);
    expect(toFan).not.toMatch(/block/i);
    expect((await blockPreview(me, { bookingId: now.id }, {})).alreadyBlocked).toBe(true);
    await db.delete(fanBlocks).where(eq(fanBlocks.athlete_id, me));
  });
});

// ─── X4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("X4 'Approve each spot' for open groups", () => {
  it("is an open-group setting (off by default, turned off for anything else) and shows on the offer", async () => {
    const base = { format: "video_call", title: "Group call", price_cents: 5_000, duration_minutes: 60, location_mode: "virtual" };
    const og = await createOffer(me, { ...base, audience: "open_group", max_people: 6 });
    expect(og.approve_each_spot).toBe(false);
    expect(await updateOffer(me, og.id, { approve_each_spot: true })).toMatchObject({ approve_each_spot: true });
    await expect(updateOffer(me, og.id, { approve_each_spot: "yes" })).rejects.toMatchObject({ code: "INVALID" });
    const one = await createOffer(me, { ...base, approve_each_spot: true });
    expect(one.approve_each_spot).toBe(false);
    const r = await call("GET", `/api/v1/me/bookings/offers/${og.id}`, { athlete: me });
    expect(r.body.offer).toMatchObject({ approveEachSpot: true });
  });

  it("the spot waits for her: a request in her list; Accept captures and confirms; capacity still holds", async () => {
    const o = await openGroup(2, { approve_each_spot: true });
    const s = await seedSlot(o, 90);
    const first = (await bookingOf((await request(o, { slot_id: s })).token))!;
    expect(first.approve_each_spot).toBe(true);
    await holdPlaced(first);
    expect(ops("paymentIntents.capture")).toHaveLength(0);
    expect((await row(first.id)).status).toBe("requested");
    expect(await autoConfirmOpenGroup(first.id)).toBe("skipped");
    await runBookingsCron();
    expect((await row(first.id)).status).toBe("requested");
    expect((await listBookings(me, "requests")).map((x) => x.id)).toContain(first.id);
    const d = await bookingDetail(me, first.id);
    expect(d.actions).toMatchObject({ accept: true, decline: true, propose: false });
    expect(mailTo("her@example.test").length).toBeGreaterThan(0);   // she's told there's a request

    // capacity: two people may hold spots (requested counts), the third is refused at the pick
    const second = (await bookingOf((await request(o, { slot_id: s })).token))!;
    await expect(request(o, { slot_id: s })).rejects.toMatchObject({ code: "SLOT_FULL" });

    const r = await acceptBooking(me, first.id, {});
    expect(r.result).toBe("confirmed");
    expect(ops("paymentIntents.capture")).toHaveLength(1);
    expect(await row(first.id)).toMatchObject({ status: "confirmed", meeting_mode: "livekit" });
    expect(mailTo(first.buyer_email).map((m) => m.subject)).toContain("You're in: Group film session with Ava");

    // decline releases the hold and frees the spot
    await holdPlaced(second);
    await declineBooking(me, second.id, {});
    expect((await row(second.id)).status).toBe("declined");
    await expect(request(o, { slot_id: s })).resolves.toBeTruthy();
  });

  it("an unanswered spot lapses at respond_by like a 1:1 request; off = the old auto-confirm", async () => {
    const o = await openGroup(3, { approve_each_spot: true });
    const s = await seedSlot(o, 100);
    const b = (await bookingOf((await request(o, { slot_id: s })).token))!;
    await holdPlaced(b);
    const due = (await row(b.id)).respond_by!;
    await runBookingsCron(new Date(due.getTime() + MIN));
    expect((await row(b.id)).status).toBe("expired");

    const auto = await openGroup(3);
    const s2 = await seedSlot(auto, 104);
    const c = (await bookingOf((await request(auto, { slot_id: s2 })).token))!;
    await holdPlaced(c);
    expect((await row(c.id)).status).toBe("confirmed");
  });
});

// ─── X5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("X5 no false no-show", () => {
  const gracePassed = { startsInHours: -16 / 60 };
  const graceEvent = async (id: string) => (await events(id)).filter((e) => e.kind === "attendance" && e.actor === "system" && (e.data as any)?.check === "grace_elapsed");

  it("no LiveKit evidence at all: attendance_unknown, and neither side is told the other didn't show", async () => {
    const b = await liveBooking(await seedOffer(me), gracePassed);
    await runBookingSessionSweep(new Date());
    await runBookingSessionSweep(new Date());
    const checks = await graceEvent(b.id);
    expect(checks).toHaveLength(1);
    expect(checks[0].data).toMatchObject({ result: "attendance_unknown", athleteJoined: false, buyerJoined: false });
    const subjects = email.mock.calls.map((c) => c[0].subject);
    expect(subjects.filter((x: string) => /hasn't joined/.test(x))).toEqual([]);
    expect(b.no_show_by).toBeNull();
    const v = await call("GET", `/api/v1/me/bookings/${b.id}/session`, { athlete: me });
    expect(v.body.attendance).toMatchObject({ known: false });
    const state = await call("GET", `/s/${linkToken(sessionUrlFor({ id: b.id, startsAt: b.starts_at, endsAt: b.ends_at }))}/state`);
    expect(state.body.after.attendance).toBe("unknown");
  });

  it("real evidence still tells the waiting side; a side that tapped Join is never reported absent", async () => {
    // she joined (LiveKit), the buyer did not: she's told
    const one = await liveBooking(await seedOffer(me), gracePassed);
    await webhook("participant_joined", roomNameFor(one.id), identityFor(one.id, "athlete"));
    // the buyer joined (LiveKit), her join never reached the webhook but she tapped Join: the buyer is NOT told
    const two = await liveBooking(await seedOffer(me), gracePassed);
    await webhook("participant_joined", roomNameFor(two.id), identityFor(two.id, "buyer"));
    expect((await call("POST", `/api/v1/me/bookings/${two.id}/session/token`, { athlete: me })).status).toBe(200);
    email.mockClear();
    await runBookingSessionSweep(new Date());
    expect((await graceEvent(one.id))[0].data).toMatchObject({ result: "seen", athleteJoined: true, buyerJoined: false });
    expect((await graceEvent(two.id))[0].data).toMatchObject({ result: "seen", athleteJoined: false, athleteTapped: true, buyerJoined: true });
    expect(mailTo("her@example.test").map((m) => m.subject)).toContain(`${one.buyer_name.split(" ")[0]} P. hasn't joined`);
    expect(mailTo(two.buyer_email).map((m) => m.subject)).not.toContain("Ava hasn't joined yet");
    const state = await call("GET", `/s/${linkToken(sessionUrlFor({ id: one.id, startsAt: one.starts_at, endsAt: one.ends_at }))}/state`);
    expect(state.body.after.attendance).toBe("not_seen");
  });

  it("join_tapped is recorded once per identity per booking (her open-group join on every live spot)", async () => {
    const b = await liveBooking(await seedOffer(me));
    const link = linkToken(sessionUrlFor({ id: b.id, startsAt: b.starts_at, endsAt: b.ends_at }));
    for (let i = 0; i < 3; i++) expect((await call("POST", `/s/${link}/join`)).status).toBe(200);
    await call("POST", `/api/v1/me/bookings/${b.id}/session/token`, { athlete: me });
    await call("POST", `/api/v1/me/bookings/${b.id}/session/token`, { athlete: me });
    const taps = (await events(b.id)).filter((e) => (e.data as any)?.join_tapped);
    expect(taps.map((e) => [(e.data as any).role, (e.data as any).join_tapped])).toEqual([
      ["buyer", identityFor(b.id, "buyer")], ["athlete", identityFor(b.id, "athlete")],
    ]);
    expect(await attendanceSummary(b.id)).toMatchObject({ evidence: false, buyerTapped: true, athleteTapped: true, buyerJoined: false, athleteJoined: false });

    const o = await openGroup(4);
    const s = await seedSlot(o, 0.05);
    const x = await liveBooking(o, { slot_id: s });
    const y = await liveBooking(o, { slot_id: s });
    await call("POST", `/api/v1/me/bookings/groups/${s}/session/token`, { athlete: me });
    await call("POST", `/api/v1/me/bookings/groups/${s}/session/token`, { athlete: me });
    for (const id of [x.id, y.id]) {
      const t = (await events(id)).filter((e) => (e.data as any)?.join_tapped);
      expect(t.map((e) => (e.data as any).join_tapped)).toEqual([slotAthleteIdentityFor(s)]);
    }
  });
});

// ─── X6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("X6 joining muted in groups", () => {
  it("a group's fan / friend token says startMuted; a 1:1's and hers don't; the page's state says joinMuted", async () => {
    const one = await liveBooking(await seedOffer(me));
    const oneLink = linkToken(sessionUrlFor({ id: one.id, startsAt: one.starts_at, endsAt: one.ends_at }));
    expect((await call("POST", `/s/${oneLink}/join`)).body.startMuted).toBe(false);
    expect((await call("GET", `/s/${oneLink}/state`)).body.video.joinMuted).toBe(false);

    const pg = await liveBooking(await privateGroup(3), { party_size: 2 });
    await addGuests(pg, { email: "muted-friend@example.test" });
    const [g] = await db.select().from(bookingGuests).where(and(eq(bookingGuests.booking_id, pg.id)));
    const booker = linkToken(sessionUrlFor({ id: pg.id, startsAt: pg.starts_at, endsAt: pg.ends_at }));
    const friend = linkToken(guestSessionUrlFor(g.id, { startsAt: pg.starts_at, endsAt: pg.ends_at }));
    expect((await call("POST", `/s/${booker}/join`)).body.startMuted).toBe(true);
    expect((await call("POST", `/s/${friend}/join`)).body.startMuted).toBe(true);
    expect((await call("GET", `/s/${friend}/state`)).body.video.joinMuted).toBe(true);
    expect((await call("POST", `/api/v1/me/bookings/${pg.id}/session/token`, { athlete: me })).body.startMuted).toBe(false);

    const o = await openGroup(4);
    const s = await seedSlot(o, 0.05);
    const fan = await liveBooking(o, { slot_id: s });
    const fanLink = linkToken(sessionUrlFor({ id: fan.id, startsAt: fan.starts_at, endsAt: fan.ends_at }));
    expect((await call("POST", `/s/${fanLink}/join`)).body.startMuted).toBe(true);
  });
});
