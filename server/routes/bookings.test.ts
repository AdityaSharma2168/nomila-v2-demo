/**
 * bookings.test.ts — her side of Bookings v2, end to end over HTTP: Express + the real routes + PGlite (real SQL) with
 * Stripe replaced by an in-memory fake at the boundary (server/testUtils/fakeStripeBookings.ts) and the email channel
 * mocked. Tests never reach providers.
 *
 *   R1 auth + the pilot gate: no session → 401; flag off or not on the pilot list → 404 for every route
 *   R2 tenancy: another athlete's offer, slot or booking is 404 on every route, and is never changed
 *   R3 offers: create (validated), read, edit, archive; publish is gated on payouts + her 18+ + (in person) the venue tick;
 *      pause / resume; a pause by Nomila only support lifts; the editor's quote line
 *   R4 slots: add (too soon / too far / overlap refused), list, withdraw; a held slot can't be withdrawn
 *   R5 lists + detail: requests / upcoming / past; no buyer contact details anywhere; unverified requests are invisible
 *   R6 accept: captures the HELD card (manual capture, idempotency key) → confirmed + emails; request mode needs one of
 *      the buyer's times; a lapsed hold → a 24h pay link; Stripe not answering → 502, nothing sent, tap again captures;
 *      a time she already booked is refused
 *   R7 decline releases the hold (cancel, never capture); propose sets 1–3 times and tells the buyer (no content)
 *   R8 cancel: the buyer gets everything back (refund = the all-in total, in cents); her first card fee is waived, the
 *      next is owed at Stripe's ACTUAL fee; preview says which; after the start it is refused
 *   R9 the after-session doors open on time (the taps and the release are the session PR's, #868)
 *   R10 the thread: clean messages are delivered with a content-free notice; contact details are held, never delivered
 *   R11 payouts: what's coming and what was paid (minus a card fee she owed)
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/stripe", () => require("../testUtils/fakeStripeBookings").stripeModule);
jest.mock("../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.header("x-test-athlete");
    if (!id) { res.status(401).json({ error: "unauthorized" }); return; }
    req.athleteId = id; next();
  },
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.header("x-test-admin") !== "1") { res.status(403).json({ error: "forbidden" }); return; }
    next();
  },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { fake } from "../testUtils/fakeStripeBookings";
import { seedBooking, seedFunded, seedHeld, seedOffer, seedPayoutAccount, seedSlot } from "../testUtils/seedBookings";
import { athletes, athletePayoutAdjustments, bookingMessages, bookings, offers, payments } from "../../shared/schema";
import { sendEmail } from "../lib/notify";
import bookingsRouter from "./bookings";
import type { BookingDetailView, OfferView } from "../../shared/bookingsApi";

const emailMock = sendEmail as jest.Mock;
const H = 3_600_000;
let server: Server;
let base: string;
let me: string, other: string, notPilot: string;

async function call(method: string, path: string, body?: unknown, as: string | null = me): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/v1/me${path}`, {
    method,
    headers: { ...(as ? { "x-test-athlete": as } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const subjects = () => emailMock.mock.calls.map((c) => c[0].subject as string);
const lastTo = (to: string) => emailMock.mock.calls.filter((c) => c[0].to === to).at(-1)?.[0];
const stripeOps = (op: string) => fake.calls.filter((c) => c.op === op);
const offerBody = (over: Record<string, unknown> = {}) => ({ format: "video_call", title: "1:1 video call", price_cents: 15_000, duration_minutes: 30, location_mode: "virtual", ...over });

beforeAll(async () => {
  await initTestDb();
  me = await seedAthlete("Ava Example");
  other = await seedAthlete("Other Athlete");
  notPilot = await seedAthlete("Not Pilot");
  await db.update(athletes).set({ email: "her@example.test", first_name: "Ava" } as any).where(eq(athletes.id, me));
  process.env.BOOKINGS_ENABLED = "true";
  process.env.BOOKINGS_PILOT_ATHLETE_IDS = `${me},${other}`;
  process.env.EMAIL_PROVIDER = "gmail";
  process.env.BOOKING_HASH_SECRET = "test-hash-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", bookingsRouter);
  // As in index.ts: app layout B's read-only GET /bookings/summary (routes/financials.ts) is mounted after this router.
  app.get("/api/v1/me/bookings/summary", (_req, res) => { res.json({ from: "financials" }); });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  delete process.env.BOOKINGS_ENABLED; delete process.env.BOOKINGS_PILOT_ATHLETE_IDS; delete process.env.EMAIL_PROVIDER; delete process.env.BOOKING_HASH_SECRET;
  await closeTestDb();
});
beforeEach(() => { emailMock.mockClear(); fake.reset(); });

describe("R1 auth + the pilot gate", () => {
  it("no session → 401", async () => {
    expect((await call("GET", "/bookings/overview", undefined, null)).status).toBe(401);
  });
  it("not on the pilot list → 404 on every route; flag off → 404", async () => {
    for (const [m, p] of [["GET", "/bookings/overview"], ["GET", "/bookings/offers"], ["POST", "/bookings/offers"], ["GET", "/bookings"], ["GET", "/bookings/payouts"]] as const) {
      expect((await call(m, p, m === "POST" ? offerBody() : undefined, notPilot)).status).toBe(404);
    }
    // the layout track's GET /bookings/summary is never shadowed, for a pilot athlete or anyone else
    expect((await call("GET", "/bookings/summary")).body).toEqual({ from: "financials" });
    expect((await call("GET", "/bookings/summary", undefined, notPilot)).body).toEqual({ from: "financials" });
    process.env.BOOKINGS_ENABLED = "false";
    expect((await call("GET", "/bookings/overview")).status).toBe(404);
    process.env.BOOKINGS_ENABLED = "true";
    expect((await call("GET", "/bookings/overview")).status).toBe(200);
  });
});

describe("R3 offers", () => {
  it("creates a validated draft and quotes the buyer total", async () => {
    const bad = await call("POST", "/bookings/offers", offerBody({ price_cents: 100, duration_minutes: 7, free_cancel_hours: 5 }));
    expect(bad.status).toBe(400);
    expect(bad.body.detail.map((d: any) => d.field).sort()).toEqual(["duration_minutes", "free_cancel_hours", "price_cents"]);
    expect((await call("POST", "/bookings/offers", { title: "x" })).status).toBe(400);
    const r = await call("POST", "/bookings/offers", offerBody({ description: "30 minutes on anything." }));
    expect(r.status).toBe(201);
    const o: OfferView = r.body.offer;
    expect(o).toMatchObject({ status: "draft", freeCancelHours: 24, videoMode: "livekit", requireIdVerification: false });
    expect(o.quote).toEqual({ priceCents: 15_000, serviceFeeCents: 2_796, buyerTotalCents: 17_796, athleteReceivesCents: 15_000, currency: "usd", unitPriceCents: 15_000, partySize: 1 });
    const q = await call("POST", "/bookings/quote", { price_cents: 15_000 });
    expect(q.body).toMatchObject({ buyerTotalCents: 17_796, serviceFeeCents: 2_796 });
    expect((await call("POST", "/bookings/quote", { price_cents: 2_000 })).status).toBe(400);
  });

  it("publish needs payouts and (in person) a venue she confirmed is not her home", async () => {
    const athlete = await seedAthlete("Publisher");
    process.env.BOOKINGS_PILOT_ATHLETE_IDS += `,${athlete}`;
    const o = (await call("POST", "/bookings/offers", offerBody(), athlete)).body.offer as OfferView;
    const noPayouts = await call("POST", `/bookings/offers/${o.id}/publish`, { adult_attested: true }, athlete);
    expect(noPayouts).toMatchObject({ status: 409, body: { code: "CONNECT_REQUIRED" } });
    await seedPayoutAccount(athlete);
    const ok = await call("POST", `/bookings/offers/${o.id}/publish`, {}, athlete);   // no age tick (owner, 22 Oct)
    expect(ok.body.offer).toMatchObject({ status: "published" });

    const ip = (await call("POST", "/bookings/offers", offerBody({ location_mode: "in_person", format: "clinic", venue: "Lakeside Courts" }), athlete)).body.offer as OfferView;
    expect(ip).toMatchObject({ requireIdVerification: true, videoMode: null, venueConfirmed: false });
    expect((await call("POST", `/bookings/offers/${ip.id}/publish`, {}, athlete)).body).toMatchObject({ code: "NOT_READY", detail: ["venue"] });
    const ticked = await call("PATCH", `/bookings/offers/${ip.id}`, { venue_confirmed: true }, athlete);
    expect(ticked.body.offer.venueConfirmed).toBe(true);
    expect((await call("POST", `/bookings/offers/${ip.id}/publish`, {}, athlete)).body.offer.status).toBe("published");
    // a new place needs a new tick
    expect((await call("PATCH", `/bookings/offers/${ip.id}`, { venue: "Another Park" }, athlete)).body.offer.venueConfirmed).toBe(false);
  });

  it("edit, pause / resume, archive; a pause by Nomila only support lifts", async () => {
    await seedPayoutAccount(me);
    const o = (await call("POST", "/bookings/offers", offerBody())).body.offer as OfferView;
    await call("POST", `/bookings/offers/${o.id}/publish`, { adult_attested: true });
    expect((await call("PATCH", `/bookings/offers/${o.id}`, { price_cents: 10_000, free_cancel_hours: 168 })).body.offer).toMatchObject({ priceCents: 10_000, freeCancelHours: 168, quote: { buyerTotalCents: 11_874 } });
    expect((await call("POST", `/bookings/offers/${o.id}/pause`)).body.offer).toMatchObject({ status: "paused", pausedReason: "athlete" });
    expect((await call("POST", `/bookings/offers/${o.id}/resume`)).body.offer.status).toBe("published");
    await db.update(offers).set({ status: "paused", paused_reason: "no_show_review" }).where(eq(offers.id, o.id));
    expect((await call("POST", `/bookings/offers/${o.id}/resume`)).body.code).toBe("PAUSED_BY_NOMILA");
    const summary = (await call("GET", "/bookings/overview")).body;
    expect(summary).toMatchObject({ pausedByNomila: true, respondHours: 72, supportEmail: "support@nomila.co" });
    expect(summary.limits).toMatchObject({ minPriceCents: 2_500, maxPriceCents: 500_000, freeCancelHoursOptions: [24, 48, 168], freeCancelHoursDefault: 24 });
    await db.update(offers).set({ status: "archived", paused_reason: null }).where(eq(offers.id, o.id));
    expect((await call("GET", `/bookings/offers/${o.id}`)).status).toBe(404);
    const d = (await call("POST", "/bookings/offers", offerBody())).body.offer as OfferView;
    expect((await call("DELETE", `/bookings/offers/${d.id}`)).status).toBe(204);
    expect((await call("GET", "/bookings/offers")).body.offers.map((x: OfferView) => x.id)).not.toContain(d.id);
  });
});

describe("R4 slots", () => {
  it("adds valid times, refuses too soon / too far / overlap, lists, withdraws; a held slot stays", async () => {
    const o = (await call("POST", "/bookings/offers", offerBody())).body.offer as OfferView;
    const t = (h: number) => new Date(Date.now() + h * H).toISOString();
    expect((await call("POST", `/bookings/offers/${o.id}/slots`, { starts: [t(1)] })).body.detail[0].problem).toBe("too_soon");
    expect((await call("POST", `/bookings/offers/${o.id}/slots`, { starts: [t(24 * 70)] })).body.detail[0].problem).toBe("too_far");
    expect((await call("POST", `/bookings/offers/${o.id}/slots`, { starts: [t(30), t(30.25)] })).body.detail[0].problem).toBe("overlap");
    const added = await call("POST", `/bookings/offers/${o.id}/slots`, { starts: [t(30), t(54)] });
    expect(added.status).toBe(201);
    expect(added.body.slots).toHaveLength(2);
    expect((await call("POST", `/bookings/offers/${o.id}/slots`, { starts: [t(30.1)] })).body.detail[0].problem).toBe("overlap");
    const [s1, s2] = added.body.slots;
    const offerRow = (await db.select().from(offers).where(eq(offers.id, o.id)))[0];
    await seedBooking(offerRow, { status: "unverified", slot_id: s1.id, startsInHours: 30 });
    expect((await call("GET", `/bookings/offers/${o.id}/slots`)).body.slots.find((s: any) => s.id === s1.id).taken).toBe(true);
    expect((await call("DELETE", `/bookings/offers/${o.id}/slots/${s1.id}`)).body.code).toBe("SLOT_TAKEN");
    expect((await call("DELETE", `/bookings/offers/${o.id}/slots/${s2.id}`)).status).toBe(204);
    expect((await call("GET", `/bookings/offers/${o.id}/slots`)).body.slots.map((s: any) => s.id)).toEqual([s1.id]);
  });
});

describe("R2 tenancy", () => {
  it("another athlete's offer, slots and booking are 404 everywhere and never change", async () => {
    const theirs = await seedOffer(other);
    const slot = await seedSlot(theirs, 40);
    const b = await seedBooking(theirs);
    await seedHeld(b);
    const probes: Array<[string, string, unknown?]> = [
      ["GET", `/bookings/offers/${theirs.id}`], ["PATCH", `/bookings/offers/${theirs.id}`, { title: "mine now" }],
      ["DELETE", `/bookings/offers/${theirs.id}`], ["POST", `/bookings/offers/${theirs.id}/publish`, { adult_attested: true }],
      ["POST", `/bookings/offers/${theirs.id}/pause`], ["GET", `/bookings/offers/${theirs.id}/slots`],
      ["POST", `/bookings/offers/${theirs.id}/slots`, { starts: [new Date(Date.now() + 50 * H).toISOString()] }],
      ["DELETE", `/bookings/offers/${theirs.id}/slots/${slot}`],
      ["GET", `/bookings/${b.id}`], ["POST", `/bookings/${b.id}/accept`, {}], ["POST", `/bookings/${b.id}/decline`, {}],
      ["POST", `/bookings/${b.id}/propose`, { times: [new Date(Date.now() + 50 * H).toISOString()] }],
      ["GET", `/bookings/${b.id}/cancel-preview`], ["POST", `/bookings/${b.id}/cancel`, {}], ["POST", `/bookings/${b.id}/no-show`],
      ["POST", `/bookings/${b.id}/session-done`], ["GET", `/bookings/${b.id}/messages`], ["POST", `/bookings/${b.id}/messages`, { body: "hi" }],
    ];
    for (const [m, p, body] of probes) {
      const r = await call(m, p, body);
      expect([m, p, r.status]).toEqual([m, p, 404]);
    }
    expect((await db.select().from(offers).where(eq(offers.id, theirs.id)))[0]).toMatchObject({ title: "1:1 video call", status: "published" });
    expect((await db.select().from(bookings).where(eq(bookings.id, b.id)))[0].status).toBe("requested");
    expect(stripeOps("paymentIntents.capture")).toHaveLength(0);
    expect((await db.select().from(bookingMessages).where(eq(bookingMessages.booking_id, b.id)))).toHaveLength(0);
    expect((await call("GET", "/bookings?view=requests")).body.bookings.map((x: any) => x.id)).not.toContain(b.id);
  });
});

describe("R5 lists + detail", () => {
  it("requests / upcoming / past; no contact details; unverified is invisible", async () => {
    const o = await seedOffer(me);
    const req = await seedBooking(o, { buyer_message: "How did you handle recruiting?" });
    await seedHeld(req);
    const hidden = await seedBooking(o, { status: "unverified" });
    const up = await seedBooking(o, { status: "confirmed", startsInHours: 30 });
    await seedFunded(up);
    const past = await seedBooking(o, { status: "declined" });
    const ids = async (view: string) => (await call("GET", `/bookings?view=${view}`)).body.bookings.map((x: any) => x.id);
    expect(await ids("requests")).toContain(req.id);
    expect(await ids("requests")).not.toContain(hidden.id);
    expect(await ids("upcoming")).toContain(up.id);
    expect(await ids("past")).toContain(past.id);
    expect((await call("GET", `/bookings/${hidden.id}`)).status).toBe(404);
    const d = await call("GET", `/bookings/${req.id}`);
    const detail: BookingDetailView = d.body.booking;
    expect(detail).toMatchObject({
      phase: "request", buyerLabel: "Jordan P.", receiveCents: 15_000, buyerMessage: "How did you handle recruiting?",
      checks: { email: true, phone: true, idChecked: false, adult: true, parent: false },
      actions: { accept: true, decline: true, propose: true, cancel: false, noShow: false, sessionDone: false, message: true },
      firstCancelFree: true, supportEmail: "support@nomila.co",
    });
    const raw = JSON.stringify(d.body);
    expect(raw).not.toContain(req.buyer_email);
    expect(raw).not.toContain("+15125550100");
    expect(raw).not.toContain("Park");
  });
});

describe("R6 accept", () => {
  it("captures the held card once → confirmed, funded, the buyer and her emailed", async () => {
    const o = await seedOffer(me);
    const slotId = await seedSlot(o, 48);
    const b = await seedBooking(o, { slot_id: slotId });
    const paymentId = await seedHeld(b);
    const r = await call("POST", `/bookings/${b.id}/accept`, { backup_link: "https://meet.example.com/abc" });
    expect(r.status).toBe(200);
    expect(r.body.result).toBe("confirmed");
    expect(r.body.booking).toMatchObject({ status: "confirmed", phase: "booked", meetingMode: "livekit", meetingLink: "https://meet.example.com/abc" });
    const captures = stripeOps("paymentIntents.capture");
    expect(captures).toHaveLength(1);
    expect(captures[0].key).toBe(`bkcapture_${paymentId}`);
    expect(stripeOps("refunds.create")).toHaveLength(0);
    const [p] = await db.select().from(payments).where(eq(payments.id, paymentId));
    expect(p).toMatchObject({ status: "funded", brand_total_cents: 17_796 });
    expect(p.stripe_charge_id).toBeTruthy();
    const mail = lastTo(b.buyer_email)!;
    expect(mail.subject).toBe("Ava accepted your request");
    expect(mail.text).toContain("Your card was charged $177.96.");
    expect(mail.text).toContain("Questions or safety concerns? support@nomila.co");
    expect((await call("POST", `/bookings/${b.id}/accept`, {})).body.code).toBe("WRONG_STATE");
    expect(stripeOps("paymentIntents.capture")).toHaveLength(1);
  });

  it("request mode: she must pick one of the buyer's times; it becomes the session time", async () => {
    const o = await seedOffer(me, { scheduling_mode: "request" });
    const t1 = new Date(Date.now() + 50 * H), t2 = new Date(Date.now() + 74 * H);
    const b = await seedBooking(o, { startsInHours: null, proposed_times: [{ start: t1.toISOString(), tz: "America/Chicago" }, { start: t2.toISOString(), tz: null }] });
    await seedHeld(b);
    expect((await call("POST", `/bookings/${b.id}/accept`, {})).body).toMatchObject({ code: "PICK_A_TIME" });
    expect((await call("POST", `/bookings/${b.id}/accept`, { start: new Date(Date.now() + 99 * H).toISOString() })).body.code).toBe("PICK_A_TIME");
    const r = await call("POST", `/bookings/${b.id}/accept`, { start: t2.toISOString() });
    expect(r.body.booking).toMatchObject({ status: "confirmed", startsAt: t2.toISOString(), endsAt: new Date(t2.getTime() + 30 * 60_000).toISOString() });
  });

  it("a lapsed hold → a 24h pay link to the buyer; paying it confirms", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { startsInHours: 96 });
    await seedHeld(b);
    fake.mode.capture = "lapsed";
    const r = await call("POST", `/bookings/${b.id}/accept`, {});
    expect(r.body).toMatchObject({ result: "waiting_payment", booking: { status: "accepted", phase: "waiting_payment" } });
    const payBy = new Date(r.body.booking.payBy).getTime();
    expect(Math.abs(payBy - (Date.now() + 24 * H))).toBeLessThan(60_000);
    const sessions = stripeOps("checkout.sessions.create");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].params.payment_intent_data.capture_method).toBeUndefined();   // a normal charge, not another hold
    expect(sessions[0].params.metadata.stage).toBe("pay");
    expect(lastTo(b.buyer_email)!.subject).toBe("Ava accepted: pay to keep your time");
    const { handleBookingCheckoutCompleted } = await import("../services/bookings/charges");
    await handleBookingCheckoutCompleted(fake.completePay([...fake.sessions.keys()].at(-1)!));
    expect((await call("GET", `/bookings/${b.id}`)).body.booking).toMatchObject({ status: "confirmed", payBy: null });
  });

  it("Stripe not answering → 502, nothing sent; her next tap captures (same idempotency key)", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { startsInHours: 120 });
    const paymentId = await seedHeld(b);
    fake.mode.capture = "no_answer";
    const r = await call("POST", `/bookings/${b.id}/accept`, {});
    expect(r).toMatchObject({ status: 502, body: { code: "CAPTURE_RETRY" } });
    expect(emailMock).not.toHaveBeenCalled();
    expect((await call("GET", `/bookings/${b.id}`)).body.booking).toMatchObject({ status: "accepted", phase: "request", actions: { accept: true } });
    fake.mode.capture = "ok";
    expect((await call("POST", `/bookings/${b.id}/accept`, {})).body.result).toBe("confirmed");
    expect(stripeOps("paymentIntents.capture").map((c) => c.key)).toEqual([`bkcapture_${paymentId}`, `bkcapture_${paymentId}`]);
  });

  it("a time she already booked is refused", async () => {
    const o = await seedOffer(me);
    const booked = await seedBooking(o, { status: "confirmed", startsInHours: 200 });
    await seedFunded(booked);
    const clash = await seedBooking(o, { startsInHours: 200.25 });
    await seedHeld(clash);
    expect((await call("POST", `/bookings/${clash.id}/accept`, {})).body.code).toBe("TIME_TAKEN");
    expect(stripeOps("paymentIntents.capture")).toHaveLength(0);
  });
});

describe("R7 decline + propose", () => {
  it("decline releases the hold — never a capture — and the buyer gets a kind note", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o);
    const paymentId = await seedHeld(b);
    const r = await call("POST", `/bookings/${b.id}/decline`, { reason: "felt_off" });
    expect(r.body.booking).toMatchObject({ status: "declined", phase: "declined" });
    expect(stripeOps("paymentIntents.cancel")).toHaveLength(1);
    expect(stripeOps("paymentIntents.capture")).toHaveLength(0);
    expect((await db.select().from(payments).where(eq(payments.id, paymentId)))[0].status).toBe("canceled");
    const mail = lastTo(b.buyer_email)!;
    expect(mail.text).toContain("The hold was released.");
    expect(mail.text).not.toContain("felt_off");
  });

  it("propose sets 1–3 times and tells the buyer; bad times are refused", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o);
    await seedHeld(b);
    expect((await call("POST", `/bookings/${b.id}/propose`, { times: [] })).status).toBe(400);
    const times = [60, 80].map((h) => new Date(Date.now() + h * H).toISOString());
    const r = await call("POST", `/bookings/${b.id}/propose`, { times });
    expect(r.body.booking).toMatchObject({ phase: "waiting_buyer", athleteProposedTimes: times.map((start) => ({ start, tz: null })) });
    expect(lastTo(b.buyer_email)!.subject).toBe("Ava suggested other times");
  });
});

describe("R8 her cancel", () => {
  it("the buyer gets everything back; her first card fee is on Nomila, the next is owed at Stripe's actual fee", async () => {
    const athlete = await seedAthlete("Canceller");
    process.env.BOOKINGS_PILOT_ATHLETE_IDS += `,${athlete}`;
    const o = await seedOffer(athlete);
    const b1 = await seedBooking(o, { status: "confirmed", startsInHours: 72 });
    const p1 = await seedFunded(b1);
    const pre = await call("GET", `/bookings/${b1.id}/cancel-preview`, undefined, athlete);
    expect(pre.body).toEqual({ buyerRefundCents: 17_796, firstCancelFree: true, estCardFeeCents: 0 });
    const r = await call("POST", `/bookings/${b1.id}/cancel`, { reason: "Called into an extra practice." }, athlete);
    expect(r.body.booking).toMatchObject({ status: "canceled", canceledBy: "athlete" });
    const refunds = stripeOps("refunds.create");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].params.amount).toBe(17_796);
    expect(refunds[0].key).toBe(`bkrefund_${p1}`);
    expect((await db.select().from(athletePayoutAdjustments).where(eq(athletePayoutAdjustments.booking_id, b1.id)))[0]).toMatchObject({ amount_cents: 546, status: "waived" });
    expect(lastTo(b1.buyer_email)!.text).toContain("You'll get all $177.96 back");

    fake.mode.feeCents = 531;
    const b2 = await seedBooking(o, { status: "confirmed", startsInHours: 100 });
    await seedFunded(b2);
    expect((await call("GET", `/bookings/${b2.id}/cancel-preview`, undefined, athlete)).body).toMatchObject({ firstCancelFree: false, estCardFeeCents: 546 });
    await call("POST", `/bookings/${b2.id}/cancel`, {}, athlete);
    expect((await db.select().from(athletePayoutAdjustments).where(eq(athletePayoutAdjustments.booking_id, b2.id)))[0]).toMatchObject({ amount_cents: 531, status: "owed" });
  });

  it("after the start she can't cancel (report instead)", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { status: "confirmed", startsInHours: -0.1 });
    await seedFunded(b);
    expect((await call("POST", `/bookings/${b.id}/cancel`, {})).body.code).toBe("STARTED");
    expect(stripeOps("refunds.create")).toHaveLength(0);
  });
});

describe("R9 the after-session doors (the taps themselves are the session PR's, #868)", () => {
  it("say when 'Buyer didn't show' opens (start + 15 min) and when 'Session done' is available", async () => {
    const o = await seedOffer(me);
    const before = await seedBooking(o, { status: "confirmed", startsInHours: 3 });
    await seedFunded(before);
    const a = (await call("GET", `/bookings/${before.id}`)).body.booking as BookingDetailView;
    expect(a.actions).toMatchObject({ noShow: false, sessionDone: false, cancel: true });
    expect(new Date(a.actions.noShowAt!).getTime()).toBe(before.starts_at!.getTime() + 15 * 60_000);
    const during = await seedBooking(o, { status: "confirmed", startsInHours: -0.3 });
    await seedFunded(during);
    const d = (await call("GET", `/bookings/${during.id}`)).body.booking as BookingDetailView;
    expect(d.actions).toMatchObject({ noShow: true, sessionDone: true, cancel: false });
    expect(d.phase).toBe("happening");
    // her side never moves money for a session: no route here transfers
    expect((await call("POST", `/bookings/${during.id}/no-show`)).status).toBe(404);
    expect(stripeOps("transfers.create")).toHaveLength(0);
  });
});

describe("R10 the thread", () => {
  it("clean messages are delivered with a content-free notice; contact details are held", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { status: "confirmed", startsInHours: 30 });
    await seedFunded(b);
    const ok = await call("POST", `/bookings/${b.id}/messages`, { body: "Looking forward to it! Bring your questions." });
    expect(ok.status).toBe(201);
    const notice = lastTo(b.buyer_email)!;
    expect(notice.subject).toBe("You have a new message from Ava");
    expect(notice.text).not.toContain("Bring your questions");
    emailMock.mockClear();
    const held = await call("POST", `/bookings/${b.id}/messages`, { body: "text me at 512 555 0100" });
    expect(held.body.messages.at(-1)).toMatchObject({ from: "you", held: true, heldReason: "contact_details" });
    expect(emailMock).not.toHaveBeenCalled();
    await db.insert(bookingMessages).values({ booking_id: b.id, sender: "buyer", body: "my number is 512-555-0199", moderation: "held", moderation_reason: "contact_details" });
    await db.insert(bookingMessages).values({ booking_id: b.id, sender: "buyer", body: "Thanks so much!", moderation: "clean", delivered_at: new Date() });
    const thread = (await call("GET", `/bookings/${b.id}/messages`)).body.messages;
    expect(thread.map((m: any) => m.body)).toEqual(["Looking forward to it! Bring your questions.", "text me at 512 555 0100", "Thanks so much!"]);
    expect((await call("POST", `/bookings/${b.id}/messages`, { body: "" })).status).toBe(400);
    expect((await call("GET", `/bookings?view=upcoming`)).body.bookings.find((x: any) => x.id === b.id).unreadMessages).toBe(1);
  });
});

describe("R11 payouts", () => {
  it("what's coming (held) and what was paid", async () => {
    const athlete = await seedAthlete("Payee");
    process.env.BOOKINGS_PILOT_ATHLETE_IDS += `,${athlete}`;
    await seedPayoutAccount(athlete);
    const o = await seedOffer(athlete);
    const held = await seedBooking(o, { status: "in_review", startsInHours: -5, release_due_at: new Date(Date.now() + 40 * H) });
    await seedFunded(held);
    const paid = await seedBooking(o, { status: "released", startsInHours: -100, released_at: new Date() });
    const pid = await seedFunded(paid);
    await db.update(payments).set({ status: "settled" }).where(eq(payments.id, pid));
    const earlier = await seedBooking(o, { status: "canceled", startsInHours: -300 });
    await db.insert(athletePayoutAdjustments).values({ athlete_id: athlete, booking_id: earlier.id, amount_cents: 531, status: "recovered", recovered_payment_id: pid });
    const r = (await call("GET", "/bookings/payouts", undefined, athlete)).body;
    expect(r).toMatchObject({ comingCents: 15_000, paidCents: 14_469, payouts: { ready: true } });
    expect(r.items.map((i: any) => [i.state, i.amountCents, i.cardFeeCents])).toEqual(expect.arrayContaining([["held", 15_000, 0], ["paid", 14_469, 531]]));
    expect(JSON.stringify(r)).not.toContain("@example.test");
  });
});
