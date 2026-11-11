/**
 * bookingsPublic.test.ts — the buyer's side of Bookings v2 over HTTP: Express + the real routes + PGlite, with Stripe
 * faked at the boundary, Firebase's phone check replaced at its seam (bookings/phoneVerify.ts) and the email channel
 * mocked. Tests never reach providers.
 *
 *   P1 the gate: flag off → 404; no BOOKING_HASH_SECRET → 503; a non-pilot athlete's offer or a bad token → 404
 *   P2 the offer and the quote: one all-in line, open times only, never the venue
 *   P3 the request: every field checked; the 18+ check (and the parent option only when her offer allows it); the price
 *      the buyer saw must be the live one; a slot is held at once (a second request → 409); a blocked buyer gets the
 *      same answer and nothing is created; per-IP rate limit → 429
 *   P4 the email code: hashed, 5 tries, expiry resends, 30-second resend gap; a right code returns the access key
 *   P5 owner scope: the token alone opens nothing; another booking's key never works
 *   P6 the phone code (Firebase seam) must prove the number given; a blocked phone ends the request quietly
 *   P7 ID + selfie (Stripe Identity, matching selfie) before the card, for in person
 *   P8 the card hold (manual capture) → requested; her rule "returning buyers only"; a lapsed hold → 409
 *   P9 the private page: phases; withdraw releases the hold; pick one of her times; cancel inside / after her window
 *      (price back, fee kept / nothing back, she's paid); no release path here (the session page of #868 owns it)
 *   P10 the thread: contact details held, a notice to her with no content
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/stripe", () => require("../testUtils/fakeStripeBookings").stripeModule);
jest.mock("../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));
jest.mock("../services/bookings/phoneVerify", () => ({ verifiedPhoneFromFirebase: jest.fn(async (t: string) => (t.startsWith("fb_") ? t.slice(3) : null)) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { fake } from "../testUtils/fakeStripeBookings";
import { seedBooking, seedFunded, seedOffer, seedPayoutAccount, seedSlot } from "../testUtils/seedBookings";
import { athletes, bookings, payments, safetyBlocks } from "../../shared/schema";
import { sendEmail } from "../lib/notify";
import { processStripeEvent } from "../services/payments/webhook";
import { emailHash, phoneHash, buyerTokenFor, accessKeyFor } from "../services/bookings/tokens";
import publicRouter from "./bookingsPublic";
import type { BuyerBookingView, PublicOfferView } from "../../shared/bookingsApi";

const emailMock = sendEmail as jest.Mock;
const H = 3_600_000;
let server: Server;
let base: string;
let her: string, notPilot: string;
let evtSeq = 0;
const evt = (type: string, object: unknown): any => ({ id: `evt_pub_${++evtSeq}`, type, data: { object } });
const ops = (op: string) => fake.calls.filter((c) => c.op === op);
const row = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];

async function call(method: string, path: string, body?: unknown, access?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/v1/book${path}`, {
    method,
    headers: { ...(access ? { "x-booking-access": access } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const lastCode = (to: string): string => {
  const m = emailMock.mock.calls.filter((c) => c[0].to === to).at(-1)![0];
  return /(\d{6})/.exec(m.subject)![1];
};
const at = (h: number) => new Date(Date.now() + h * H).toISOString();
let n = 0;
const requestBody = (over: Record<string, unknown> = {}) => ({
  buyer_name: "Jordan Park", buyer_email: `jordan${++n}@example.test`, buyer_phone: "+1 (512) 555-0100", buyer_timezone: "America/New_York",
  message: "How did you handle recruiting?", adult_attested: true, agree_terms: true, displayed_total_cents: 17_796, ...over,
});

/** Create a request and confirm the email: returns the token, the access key and the booking id. */
async function verifiedRequest(publicId: string, over: Record<string, unknown> = {}) {
  const body = requestBody(over);
  const r = await call("POST", `/offers/${publicId}/requests`, body);
  expect(r.status).toBe(201);
  const v = await call("POST", `/b/${r.body.token}/email/verify`, { code: lastCode(body.buyer_email as string) });
  expect(v.status).toBe(200);
  const [b] = await db.select().from(bookings).where(eq(bookings.buyer_token_hash, (await import("../services/bookings/tokens")).buyerTokenHash(r.body.token)));
  return { token: r.body.token as string, access: v.body.access as string, id: b.id, email: body.buyer_email as string, phone: "+15125550100" };
}

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Ava Example");
  notPilot = await seedAthlete("Not Pilot");
  await db.update(athletes).set({ email: "her@example.test", first_name: "Ava" } as any).where(eq(athletes.id, her));
  await seedPayoutAccount(her);
  Object.assign(process.env, {
    BOOKINGS_ENABLED: "true", BOOKINGS_PILOT_ATHLETE_IDS: her, EMAIL_PROVIDER: "gmail", BOOKING_HASH_SECRET: "test-hash-secret",
    BOOKING_PUBLIC_RATE_LIMIT: "100000", BOOKING_REQUEST_RATE_LIMIT: "100000", BOOKING_CODE_RATE_LIMIT: "100000",
  });
  const app = express();
  app.use(express.json());
  app.use("/api/v1/book", publicRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  for (const k of ["BOOKINGS_ENABLED", "BOOKINGS_PILOT_ATHLETE_IDS", "EMAIL_PROVIDER", "BOOKING_HASH_SECRET", "BOOKING_PUBLIC_RATE_LIMIT", "BOOKING_REQUEST_RATE_LIMIT", "BOOKING_CODE_RATE_LIMIT"]) delete process.env[k];
  await closeTestDb();
});
beforeEach(() => { emailMock.mockClear(); fake.reset(); });

describe("P1 the gate", () => {
  it("flag off → 404; no hash secret → 503; non-pilot offer and bad tokens → 404", async () => {
    const o = await seedOffer(her);
    process.env.BOOKINGS_ENABLED = "false";
    expect((await call("GET", `/offers/${o.public_id}`)).status).toBe(404);
    process.env.BOOKINGS_ENABLED = "true";
    delete process.env.BOOKING_HASH_SECRET;
    expect((await call("GET", `/offers/${o.public_id}`)).status).toBe(503);
    process.env.BOOKING_HASH_SECRET = "test-hash-secret";
    const theirs = await seedOffer(notPilot);
    expect((await call("GET", `/offers/${theirs.public_id}`)).status).toBe(404);
    expect((await call("POST", `/offers/${theirs.public_id}/requests`, requestBody())).status).toBe(404);
    expect((await call("GET", `/b/${"x".repeat(43)}`)).status).toBe(404);
    expect((await call("POST", `/b/short/email/verify`, { code: "123456" })).status).toBe(404);
  });
});

describe("P2 the offer and the quote", () => {
  it("one all-in line, open times only, never the venue", async () => {
    const o = await seedOffer(her, { scheduling_mode: "slots", location_mode: "in_person", format: "clinic", require_id_verification: true, video_mode: null, venue: "Lakeside Courts, 200 Park Rd", venue_confirmed_at: new Date() });
    const open = await seedSlot(o, 30);
    const taken = await seedSlot(o, 60);
    await seedBooking(o, { status: "requested", slot_id: taken, startsInHours: 60 });
    const r = await call("GET", `/offers/${o.public_id}`);
    const view: PublicOfferView = r.body.offer;
    expect(view).toMatchObject({ athleteFirstName: "Ava", available: true, idCheckRequired: true, freeCancelHours: 24 });
    expect(view.allInLine).toBe("$177.96 — includes Ava's $150 + $27.96 Nomila service fee");
    expect(view.slots.map((s) => s.id)).toEqual([open]);
    expect(JSON.stringify(r.body)).not.toContain("Lakeside");
    expect((await call("GET", `/offers/${o.public_id}/quote`)).body).toMatchObject({ quote: { buyerTotalCents: 17_796, serviceFeeCents: 2_796 } });
    const draft = await seedOffer(her, { status: "draft" });
    expect((await call("GET", `/offers/${draft.public_id}`)).body.offer).toMatchObject({ available: false, slots: [] });
  });
});

describe("P3 the request", () => {
  it("checks every field, the 18+ rule and the parent option", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request" });
    const bad = await call("POST", `/offers/${o.public_id}/requests`, { displayed_total_cents: 17_796 });
    expect(bad.status).toBe(400);
    // A mobile number is needed only to meet in person (22 Oct): a video request without one is fine.
    expect(bad.body.detail.map((d: any) => d.field).sort()).toEqual(["adult_attested", "agree_terms", "buyer_email", "buyer_name", "buyer_timezone", "proposed_times"]);
    const noPhone = await call("POST", `/offers/${o.public_id}/requests`, requestBody({ buyer_phone: undefined, proposed_times: [at(49)] }));
    expect(noPhone.status).toBe(201);
    expect((await call("POST", `/offers/${o.public_id}/requests`, requestBody({ buyer_phone: "12", proposed_times: [at(48)] }))).body.detail.map((d: any) => d.field)).toEqual(["buyer_phone"]);
    const inPerson = await seedOffer(her, { scheduling_mode: "request", location_mode: "in_person", format: "clinic", require_id_verification: true, video_mode: null, venue: "Main field", venue_confirmed_at: new Date() });
    const ipBad = await call("POST", `/offers/${inPerson.public_id}/requests`, requestBody({ buyer_phone: undefined, proposed_times: [at(47)] }));
    expect(ipBad.body.detail.map((d: any) => d.field)).toContain("buyer_phone");
    const noAdult = await call("POST", `/offers/${o.public_id}/requests`, requestBody({ adult_attested: false, proposed_times: [at(50)] }));
    expect(noAdult.body.detail.map((d: any) => d.field)).toEqual(["adult_attested"]);
    const parent = await call("POST", `/offers/${o.public_id}/requests`, requestBody({ parent_booking: true, child_first_name: "Kid", proposed_times: [at(50)] }));
    expect(parent.body.detail.map((d: any) => d.field)).toEqual(["parent_booking"]);
    const tooMany = await call("POST", `/offers/${o.public_id}/requests`, requestBody({ proposed_times: [at(50), at(51), at(52), at(53)] }));
    expect(tooMany.body.detail).toEqual([{ field: "proposed_times", problem: "too_many" }]);
    const minors = await seedOffer(her, { scheduling_mode: "request", allow_minor_attendees: true });
    const okParent = await call("POST", `/offers/${minors.public_id}/requests`, requestBody({ parent_booking: true, child_first_name: "Mason", proposed_times: [at(50)] }));
    expect(okParent.status).toBe(201);
    const [b] = await db.select().from(bookings).where(eq(bookings.offer_id, minors.id));
    expect(b).toMatchObject({ minor_attendee: true, parent_present_attested: true, minor_first_name: "Mason", status: "unverified", buyer_adult_attested: true });
  });

  it("the price they saw must be the live one", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request" });
    const r = await call("POST", `/offers/${o.public_id}/requests`, requestBody({ displayed_total_cents: 17_000, proposed_times: [at(50)] }));
    expect(r).toMatchObject({ status: 409, body: { code: "PRICE_CHANGED", detail: { buyerTotalCents: 17_796 } } });
  });

  it("a slot is held at once: a second request for it → 409; the email code goes out, nothing to her yet", async () => {
    const o = await seedOffer(her, { scheduling_mode: "slots" });
    const slot = await seedSlot(o, 40);
    const first = requestBody({ slot_id: slot });
    const r = await call("POST", `/offers/${o.public_id}/requests`, first);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "unverified", nextStep: "email", maskedEmail: expect.stringMatching(/^j•••@example\.test$/), ref: expect.stringMatching(/^NB-/) });
    expect(new Date(r.body.holdExpiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(emailMock.mock.calls.map((c) => c[0].to)).toEqual([first.buyer_email]);
    expect(emailMock.mock.calls[0][0].subject).toMatch(/^Your Nomila code: \d{6}$/);
    expect((await call("POST", `/offers/${o.public_id}/requests`, requestBody({ slot_id: slot }))).body.code).toBe("SLOT_TAKEN");
  });

  it("a blocked buyer gets the same answer and nothing is created or sent", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request" });
    const body = requestBody({ proposed_times: [at(50)] });
    await db.insert(safetyBlocks).values({ scope: "athlete", athlete_id: her, kind: "email", value_hash: emailHash(body.buyer_email as string), created_by: "athlete" });
    const r = await call("POST", `/offers/${o.public_id}/requests`, body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "unverified", nextStep: "email" });
    expect(await db.select().from(bookings).where(eq(bookings.offer_id, o.id))).toHaveLength(0);
    expect(emailMock).not.toHaveBeenCalled();
    expect((await call("POST", `/b/${r.body.token}/email/verify`, { code: "000000" })).status).toBe(404);
  });

  it("is rate-limited per IP", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request" });
    process.env.BOOKING_REQUEST_RATE_LIMIT = "1";
    const r = await call("POST", `/offers/${o.public_id}/requests`, requestBody({ proposed_times: [at(50)] }));
    expect(r).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    process.env.BOOKING_REQUEST_RATE_LIMIT = "100000";
  });
});

describe("P4 the email code", () => {
  it("wrong codes count down to a lockout; resend waits 30s; expiry resends; a right code returns the access key", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request" });
    const body = requestBody({ proposed_times: [at(50)] });
    const r = await call("POST", `/offers/${o.public_id}/requests`, body);
    const t = r.body.token;
    expect((await call("POST", `/b/${t}/email/send`)).body.code).toBe("WAIT");
    const wrong = await call("POST", `/b/${t}/email/verify`, { code: "000000" === lastCode(body.buyer_email as string) ? "111111" : "000000" });
    expect(wrong).toMatchObject({ status: 400, body: { code: "WRONG_CODE", detail: { triesLeft: 4 } } });
    const [b] = await db.select().from(bookings).where(eq(bookings.offer_id, o.id));
    expect(b.otp_hash).not.toContain(lastCode(body.buyer_email as string));
    await db.update(bookings).set({ otp_expires_at: new Date(Date.now() - 1_000) }).where(eq(bookings.id, b.id));
    emailMock.mockClear();
    expect((await call("POST", `/b/${t}/email/verify`, { code: "123456" })).body.code).toBe("CODE_EXPIRED");
    expect(emailMock).toHaveBeenCalledTimes(1);
    const ok = await call("POST", `/b/${t}/email/verify`, { code: lastCode(body.buyer_email as string) });
    expect(ok.body).toMatchObject({ nextStep: "card", access: expect.any(String) });
    expect((await row(b.id)).email_verified_at).toBeTruthy();
    expect((await call("POST", `/b/${t}/email/send`)).body.code).toBe("ALREADY_CONFIRMED");

    const r2 = await call("POST", `/offers/${o.public_id}/requests`, requestBody({ proposed_times: [at(52)] }));
    for (let i = 0; i < 5; i++) await call("POST", `/b/${r2.body.token}/email/verify`, { code: "999999" });
    expect((await call("POST", `/b/${r2.body.token}/email/verify`, { code: "999999" })).body.code).toBe("TOO_MANY_TRIES");
  });
});

describe("P5 owner scope", () => {
  it("the token alone opens nothing; a key for another booking never works", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request" });
    const a = await verifiedRequest(o.public_id, { proposed_times: [at(50)] });
    const b = await verifiedRequest(o.public_id, { proposed_times: [at(55)] });
    expect((await call("GET", `/b/${a.token}`)).status).toBe(401);
    expect((await call("GET", `/b/${a.token}`, undefined, "garbage")).status).toBe(401);
    expect((await call("GET", `/b/${a.token}`, undefined, b.access)).status).toBe(401);
    expect((await call("POST", `/b/${a.token}/withdraw`, {}, b.access)).status).toBe(401);
    expect((await call("GET", `/b/${a.token}`, undefined, accessKeyFor(a.id, new Date(Date.now() - 1_000)))).status).toBe(401);
    const view: BuyerBookingView = (await call("GET", `/b/${a.token}`, undefined, a.access)).body.booking;
    expect(view).toMatchObject({ status: "unverified", phase: "verifying", nextStep: "card", athleteFirstName: "Ava", sessionUrl: null });
    expect(JSON.stringify(view)).not.toContain("her@example.test");
    // a fresh access key later: the status page's email-code re-check
    await db.update(bookings).set({ otp_expires_at: null }).where(eq(bookings.id, a.id));
    expect((await call("POST", `/b/${a.token}/access/send`)).status).toBe(200);
    const again = await call("POST", `/b/${a.token}/access`, { code: lastCode(a.email) });
    expect((await call("GET", `/b/${a.token}`, undefined, again.body.access)).status).toBe(200);
  });
});

describe("P6 the phone code", () => {
  it("must prove the number given; a blocked phone ends the request quietly", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request" });
    const a = await verifiedRequest(o.public_id, { proposed_times: [at(50)] });
    expect((await call("POST", `/b/${a.token}/phone/verify`, { firebase_id_token: "fb_+15125550199" }, a.access)).body.code).toBe("PHONE_NOT_CONFIRMED");
    expect((await call("POST", `/b/${a.token}/phone/verify`, { firebase_id_token: "not-a-firebase-token" }, a.access)).body.code).toBe("PHONE_NOT_CONFIRMED");
    expect((await call("POST", `/b/${a.token}/phone/verify`, { firebase_id_token: "fb_+15125550100" }, a.access)).body).toEqual({ nextStep: "card" });
    expect((await row(a.id)).buyer_phone_hash).toBe(phoneHash("+15125550100"));

    const b = await verifiedRequest(o.public_id, { proposed_times: [at(56)], buyer_phone: "+15125550177" });
    await db.insert(safetyBlocks).values({ scope: "platform", kind: "phone", value_hash: phoneHash("+15125550177"), created_by: "admin" });
    expect((await call("POST", `/b/${b.token}/phone/verify`, { firebase_id_token: "fb_+15125550177" }, b.access)).body.code).toBe("PHONE_NOT_CONFIRMED");
    expect((await row(b.id)).status).toBe("expired");
  });
});

describe("P7 ID + selfie before the card (in person)", () => {
  it("Stripe Identity with a matching selfie; the webhook clears the way to the card", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request", location_mode: "in_person", format: "clinic", require_id_verification: true, video_mode: null, venue: "Courts", venue_confirmed_at: new Date() });
    const a = await verifiedRequest(o.public_id, { proposed_times: [at(50)] });
    expect((await call("POST", `/b/${a.token}/phone/verify`, { firebase_id_token: "fb_+15125550100" }, a.access)).body).toEqual({ nextStep: "identity" });
    expect((await call("POST", `/b/${a.token}/hold`, {}, a.access)).body.code).toBe("IDENTITY_FIRST");
    const s = await call("POST", `/b/${a.token}/identity`, {}, a.access);
    expect(s.body.url).toMatch(/^https:\/\/verify\.stripe\.test\//);
    const [create] = ops("identity.verificationSessions.create");
    expect(create.params).toMatchObject({ type: "document", options: { document: { require_matching_selfie: true } }, metadata: { kind: "booking_identity", booking_id: a.id } });
    const vs = [...fake.identity.values()].at(-1);
    await processStripeEvent(evt("identity.verification_session.verified", { ...vs, status: "verified" }));
    expect(await row(a.id)).toMatchObject({ identity_status: "verified" });
    expect((await call("GET", `/b/${a.token}`, undefined, a.access)).body.booking.nextStep).toBe("card");
    expect((await call("POST", `/b/${a.token}/hold`, {}, a.access)).body.url).toBeTruthy();
  });
});

describe("P8 the card hold", () => {
  it("a manual-capture Checkout; on return the request reaches her", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request" });
    const a = await verifiedRequest(o.public_id, { proposed_times: [at(60)] });
    await call("POST", `/b/${a.token}/phone/verify`, { firebase_id_token: "fb_+15125550100" }, a.access);
    const h = await call("POST", `/b/${a.token}/hold`, {}, a.access);
    expect(h.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(ops("checkout.sessions.create")[0].params.payment_intent_data.capture_method).toBe("manual");
    fake.completeHold([...fake.sessions.keys()].at(-1)!);
    const r = await call("POST", `/b/${a.token}/hold/confirm`, {}, a.access);
    expect(r.body.booking).toMatchObject({ status: "requested", phase: "waiting", holdPlaced: true, charged: false });
    expect(emailMock.mock.calls.map((c) => c[0].subject)).toEqual(expect.arrayContaining(["Request sent to Ava", "New booking request: 1:1 video call"]));
  });

  it("her rule 'returning buyers only' stops a new buyer after the codes; a lapsed hold → 409", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request", returning_buyers_only: true });
    const a = await verifiedRequest(o.public_id, { proposed_times: [at(60)] });
    await call("POST", `/b/${a.token}/phone/verify`, { firebase_id_token: "fb_+15125550100" }, a.access);
    expect((await call("POST", `/b/${a.token}/hold`, {}, a.access))).toMatchObject({ status: 403, body: { code: "RETURNING_ONLY" } });
    expect((await row(a.id)).status).toBe("expired");

    const o2 = await seedOffer(her, { scheduling_mode: "request" });
    const b = await verifiedRequest(o2.public_id, { proposed_times: [at(60)] });
    await call("POST", `/b/${b.token}/phone/verify`, { firebase_id_token: "fb_+15125550100" }, b.access);
    await db.update(bookings).set({ created_at: new Date(Date.now() - 16 * 60_000) }).where(eq(bookings.id, b.id));
    expect((await call("POST", `/b/${b.token}/hold`, {}, b.access)).body.code).toBe("HOLD_LAPSED");
    expect(ops("checkout.sessions.create")).toHaveLength(0);
  });
});

/** A booking in any state, reachable by its token, with an access key (the seeded fixtures skip the code steps). */
async function seeded(over: Parameters<typeof seedBooking>[1], offerOver: Parameters<typeof seedOffer>[1] = {}) {
  const o = await seedOffer(her, offerOver);
  const b0 = await seedBooking(o, over);
  const token = buyerTokenFor(b0.id);
  await db.update(bookings).set({ buyer_token_hash: (await import("../services/bookings/tokens")).buyerTokenHash(token) }).where(eq(bookings.id, b0.id));
  return { b: await row(b0.id), token, access: accessKeyFor(b0.id, new Date(Date.now() + H)) };
}

describe("P9 the private page and the buyer's taps", () => {
  it("withdraw releases the hold and tells her", async () => {
    const { b, token, access } = await seeded({ status: "requested" });
    await (await import("../testUtils/seedBookings")).seedHeld(b);
    const r = await call("POST", `/b/${token}/withdraw`, {}, access);
    expect(r.body.booking).toMatchObject({ status: "withdrawn", phase: "closed" });
    expect(ops("paymentIntents.cancel")).toHaveLength(1);
    expect(emailMock.mock.calls.map((c) => c[0].to)).toEqual(expect.arrayContaining(["her@example.test"]));
  });

  it("pick one of her suggested times; then it's hers to accept", async () => {
    const times = [{ start: at(70), tz: null }, { start: at(90), tz: null }];
    const { b, token, access } = await seeded({ status: "requested", athlete_proposed_times: times });
    expect((await call("GET", `/b/${token}`, undefined, access)).body.booking).toMatchObject({ phase: "pick_time", actions: { pickTime: true } });
    expect((await call("POST", `/b/${token}/pick-time`, { start: at(80) }, access)).status).toBe(400);
    const r = await call("POST", `/b/${token}/pick-time`, { start: times[1].start }, access);
    expect(r.body.booking).toMatchObject({ phase: "waiting", proposedTimes: [{ start: times[1].start }], athleteProposedTimes: [] });
    expect((await row(b.id)).athlete_proposed_times).toBeNull();
    expect(emailMock.mock.calls.at(-1)![0]).toMatchObject({ to: "her@example.test", subject: "Jordan P. picked a time" });
  });

  it("cancel inside her window: her price back ($150), the fee kept; after it: nothing back, she's paid on the clock", async () => {
    const early = await seeded({ status: "confirmed", startsInHours: 48 });
    await seedFunded(early.b);
    expect((await call("GET", `/b/${early.token}/cancel-preview`, undefined, early.access)).body).toMatchObject({ refundCents: 15_000, keptCents: 2_796, inWindow: true });
    const r = await call("POST", `/b/${early.token}/cancel`, {}, early.access);
    expect(r.body.booking).toMatchObject({ status: "canceled", canceledBy: "buyer", refundOutcome: "price_only" });
    expect(ops("refunds.create")[0].params.amount).toBe(15_000);

    fake.reset();
    const late = await seeded({ status: "confirmed", startsInHours: 10 });
    await seedFunded(late.b);
    expect((await call("GET", `/b/${late.token}/cancel-preview`, undefined, late.access)).body).toMatchObject({ refundCents: 0, inWindow: false });
    const r2 = await call("POST", `/b/${late.token}/cancel`, {}, late.access);
    expect(r2.body.booking).toMatchObject({ refundOutcome: "none" });
    expect(ops("refunds.create")).toHaveLength(0);
    expect((await row(late.b.id)).release_due_at!.getTime()).toBe(late.b.ends_at!.getTime() + 48 * H);
  });

  it("the session and after it are not here (the session page of #868 owns 'It happened' and the release)", async () => {
    const happened = await seeded({ status: "confirmed", startsInHours: -1 });
    await seedFunded(happened.b);
    expect((await call("POST", `/b/${happened.token}/it-happened`, {}, happened.access)).status).toBe(404);
    expect((await call("GET", `/b/${happened.token}`, undefined, happened.access)).body.booking).toMatchObject({ phase: "after", actions: { cancel: false, withdraw: false } });
    expect(ops("transfers.create")).toHaveLength(0);
  });

  it("the venue appears only once the card is charged; a pay link is reused while open", async () => {
    const off = { location_mode: "in_person" as const, format: "clinic" as const, require_id_verification: true, video_mode: null, venue: "Lakeside Courts", venue_confirmed_at: new Date() };
    const waiting = await seeded({ status: "requested", venue: "Lakeside Courts" }, off);
    expect((await call("GET", `/b/${waiting.token}`, undefined, waiting.access)).body.booking.venue).toBeNull();
    const booked = await seeded({ status: "confirmed", venue: "Lakeside Courts" }, off);
    await seedFunded(booked.b);
    expect((await call("GET", `/b/${booked.token}`, undefined, booked.access)).body.booking).toMatchObject({ venue: "Lakeside Courts", charged: true, phase: "booked" });

    const pay = await seeded({ status: "accepted", pay_by: new Date(Date.now() + 20 * H), startsInHours: 60 });
    await db.insert(payments).values({ booking_id: pay.b.id, athlete_id: her, kind: "booking_payment", status: "pending", brand_total_cents: 17_796 });
    const p1 = await call("POST", `/b/${pay.token}/pay`, {}, pay.access);
    const p2 = await call("POST", `/b/${pay.token}/pay`, {}, pay.access);
    expect(p1.body.url).toBe(p2.body.url);
    expect(ops("checkout.sessions.create")).toHaveLength(1);
  });
});

describe("P10 the thread", () => {
  it("contact details are held; a clean message reaches her as a notice with no content", async () => {
    const { b, token, access } = await seeded({ status: "confirmed", startsInHours: 30 });
    await seedFunded(b);
    const held = await call("POST", `/b/${token}/messages`, { body: "email me at jordan@example.test" }, access);
    expect(held.body.messages.at(-1)).toMatchObject({ from: "you", held: true, heldReason: "contact_details" });
    expect(emailMock).not.toHaveBeenCalled();
    await call("POST", `/b/${token}/messages`, { body: "Can we talk about summer camps too?" }, access);
    const notice = emailMock.mock.calls.at(-1)![0];
    expect(notice).toMatchObject({ to: "her@example.test", subject: "New message from Jordan P." });
    expect(notice.text).not.toContain("summer camps");
    expect((await call("GET", `/b/${token}/messages`, undefined, access)).body.messages).toHaveLength(2);
  });
});
