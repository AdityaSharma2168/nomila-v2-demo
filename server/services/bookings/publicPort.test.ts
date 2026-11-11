/**
 * publicPort.test.ts — Ask Mila's PublicBookingsPort, implemented by the booking service, against PGlite (real SQL) with
 * Stripe faked and the email channel mocked. Tests never reach providers.
 *
 *   A1 the port: typed by public Mila's own interface (server/mila/public/ports.ts, imported), exactly its two methods
 *   A2 listOpenSlots is read-only and narrow: one PUBLISHED slots-mode offer of THIS athlete; future, bookable, not
 *      withdrawn, not held, inside the offer's window and the asked days; [] for request mode, drafts, another athlete's
 *      offer, an unknown offer, a non-pilot athlete, or bookings off; it writes nothing
 *   A3 createPendingRequest: one unverified request with no contact, the slot held at once (a second → slot_taken), a
 *      same-origin nextUrl the visitor continues on (safeNextUrl-clean), nothing sent to anyone; request mode takes 1–3
 *      times; exactly one of slotId / times; another athlete's offer or a draft → unavailable; bad input → invalid
 *   A4 the visitor's next page: the contact step (same checks as a direct request; the price must match), then the
 *      email code; a blocked buyer gets the same answer and the request ends; the contact step only once, and only
 *      inside the 15-minute hold; until then the code steps and the status page refuse
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/stripe", () => require("../../testUtils/fakeStripeBookings").stripeModule);
jest.mock("../../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { seedBooking, seedOffer, seedSlot } from "../../testUtils/seedBookings";
import { athletes, bookingEvents, bookings, offerSlots, safetyBlocks } from "../../../shared/schema";
import { sendEmail } from "../../lib/notify";
import { createPublicBookingsPort, MAX_LIST_SLOTS } from "./publicPort";
import type { PublicBookingsPort } from "../../mila/public/ports";
import { emailHash } from "./tokens";
import publicRouter from "../../routes/bookingsPublic";

const emailMock = sendEmail as jest.Mock;
const H = 3_600_000;
const port: PublicBookingsPort = createPublicBookingsPort();
let her: string, other: string, notPilot: string;
let server: Server;
let base: string;

/** The same-origin check public Mila applies to every nextUrl a port hands back (ports.ts safeNextUrl, copied). */
const safeNextUrl = (u: unknown): string | null =>
  typeof u === "string" && /^\/(?!\/)[A-Za-z0-9\-._~/?=&%:]{0,300}$/.test(u) ? u : null;

async function call(method: string, path: string, body?: unknown, access?: string) {
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
const tokenOf = (nextUrl: string) => nextUrl.replace(/^\/b\//, "");
const pendingRows = (offerId: string) => db.select().from(bookings).where(eq(bookings.offer_id, offerId));
const contact = (over: Record<string, unknown> = {}) => ({
  buyer_name: "Jordan Park", buyer_email: "jordan.ask@example.test", buyer_phone: "+15125550100", buyer_timezone: "America/New_York",
  message: "How did you handle recruiting?", adult_attested: true, agree_terms: true, displayed_total_cents: 17_796, ...over,
});

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Ava Example");
  other = await seedAthlete("Other Athlete");
  notPilot = await seedAthlete("Not Pilot");
  await db.update(athletes).set({ email: "her@example.test", first_name: "Ava" } as any).where(eq(athletes.id, her));
  Object.assign(process.env, {
    BOOKINGS_ENABLED: "true", BOOKINGS_PILOT_ATHLETE_IDS: `${her},${other}`, EMAIL_PROVIDER: "gmail", BOOKING_HASH_SECRET: "test-hash-secret",
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
beforeEach(() => { emailMock.mockClear(); });

describe("A1 the port", () => {
  it("the adapter has exactly the port's three methods", () => {
    expect(Object.keys(port).sort()).toEqual(["bookable", "createPendingRequest", "listOpenSlots"]);
  });
  it("bookable: only with BOOKINGS_ENABLED and only for a pilot athlete", () => {
    const keep = { e: process.env.BOOKINGS_ENABLED, p: process.env.BOOKINGS_PILOT_ATHLETE_IDS };
    try {
      process.env.BOOKINGS_ENABLED = "true";
      process.env.BOOKINGS_PILOT_ATHLETE_IDS = her;
      expect(port.bookable(her)).toBe(true);
      expect(port.bookable("00000000-0000-4000-8000-000000000009")).toBe(false);
      process.env.BOOKINGS_ENABLED = "false";
      expect(port.bookable(her)).toBe(false);
    } finally {
      for (const [k, v] of [["BOOKINGS_ENABLED", keep.e], ["BOOKINGS_PILOT_ATHLETE_IDS", keep.p]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

describe("A2 listOpenSlots", () => {
  it("only open, future, bookable, unheld times of her published slots offer, inside the window and the days asked", async () => {
    const o = await seedOffer(her, { scheduling_mode: "slots" });
    const open1 = await seedSlot(o, 30);
    const open2 = await seedSlot(o, 54);
    const far = await seedSlot(o, 24 * 20);
    const tooSoon = await seedSlot(o, 1);
    const held = await seedSlot(o, 40);
    await seedBooking(o, { status: "unverified", slot_id: held, startsInHours: 40 });
    const gone = await seedSlot(o, 45);
    await db.update(offerSlots).set({ withdrawn_at: new Date() }).where(eq(offerSlots.id, gone));
    const before = (await db.select().from(bookings)).length;
    const r = await port.listOpenSlots({ athleteId: her, offerPublicId: o.public_id, from: new Date(), days: 7 });
    expect(r.map((s) => s.id)).toEqual([open1, open2]);
    expect(Object.keys(r[0]).sort()).toEqual(["endsAt", "id", "startsAt"]);
    expect((await port.listOpenSlots({ athleteId: her, offerPublicId: o.public_id, from: new Date(), days: 30 })).map((s) => s.id)).toContain(far);
    expect((await port.listOpenSlots({ athleteId: her, offerPublicId: o.public_id, from: new Date(), days: 30 })).map((s) => s.id)).not.toContain(tooSoon);
    expect((await port.listOpenSlots({ athleteId: her, offerPublicId: o.public_id, from: new Date(Date.now() + 50 * H), days: 1 })).map((s) => s.id)).toEqual([open2]);
    expect((await db.select().from(bookings)).length).toBe(before);   // read-only
  });

  it("respects the offer's own date window", async () => {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const o = await seedOffer(her, { scheduling_mode: "slots", available_until: day(new Date(Date.now() + 3 * 24 * H)) });
    const inside = await seedSlot(o, 48);
    const after = await seedSlot(o, 24 * 6);
    const ids = (await port.listOpenSlots({ athleteId: her, offerPublicId: o.public_id, from: new Date(), days: 30 })).map((s) => s.id);
    expect(ids).toContain(inside);
    expect(ids).not.toContain(after);
  });

  it("[] for request mode, a draft, another athlete's offer, an unknown offer, a non-pilot athlete, or bookings off", async () => {
    const slotsOffer = await seedOffer(her, { scheduling_mode: "slots" });
    await seedSlot(slotsOffer, 30);
    const req = await seedOffer(her, { scheduling_mode: "request" });
    const draft = await seedOffer(her, { scheduling_mode: "slots", status: "draft" });
    await seedSlot(draft, 30);
    const q = (athleteId: string, offerPublicId: string) => port.listOpenSlots({ athleteId, offerPublicId, from: new Date(), days: 7 });
    expect(await q(her, req.public_id)).toEqual([]);
    expect(await q(her, draft.public_id)).toEqual([]);
    expect(await q(other, slotsOffer.public_id)).toEqual([]);   // the handle resolved to someone else
    expect(await q(her, "nope")).toEqual([]);
    const np = await seedOffer(notPilot, { scheduling_mode: "slots" });
    await seedSlot(np, 30);
    expect(await q(notPilot, np.public_id)).toEqual([]);
    process.env.BOOKINGS_ENABLED = "false";
    expect(await q(her, slotsOffer.public_id)).toEqual([]);
    process.env.BOOKINGS_ENABLED = "true";
    expect(await q(her, slotsOffer.public_id)).toHaveLength(1);
  });

  it("caps the answer", async () => {
    const o = await seedOffer(her, { scheduling_mode: "slots", duration_minutes: 15 });
    for (let i = 0; i < MAX_LIST_SLOTS + 5; i++) await seedSlot(o, 30 + i);
    expect(await port.listOpenSlots({ athleteId: her, offerPublicId: o.public_id, from: new Date(), days: 60 })).toHaveLength(MAX_LIST_SLOTS);
  });
});

describe("A3 createPendingRequest", () => {
  it("one unverified request, the slot held at once, a same-origin nextUrl, nothing sent", async () => {
    const o = await seedOffer(her, { scheduling_mode: "slots" });
    const slot = await seedSlot(o, 30);
    const r = await port.createPendingRequest({ athleteId: her, offerPublicId: o.public_id, slotId: slot, times: null, note: "Recruiting questions", askMilaSessionId: "ask_1" });
    expect(r).toMatchObject({ ok: true, ref: expect.stringMatching(/^NB-/), nextUrl: expect.stringMatching(/^\/b\//) });
    if (!r.ok) throw new Error("expected ok");
    expect(safeNextUrl(r.nextUrl)).toBe(r.nextUrl);
    const rows = await pendingRows(o.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "unverified", slot_id: slot, buyer_name: "", buyer_email: "", email_verified_at: null, proposed_note: "Recruiting questions", buyer_total_cents: 17_796 });
    const ev = (await db.select().from(bookingEvents).where(eq(bookingEvents.booking_id, rows[0].id)))[0];
    expect(ev.data).toMatchObject({ source: "ask_mila", ask_mila_session_id: "ask_1" });
    expect(emailMock).not.toHaveBeenCalled();
    // the slot is held: a second request for it, and the list no longer offers it
    expect(await port.createPendingRequest({ athleteId: her, offerPublicId: o.public_id, slotId: slot, times: null, note: null, askMilaSessionId: "ask_2" }))
      .toEqual({ ok: false, reason: "slot_taken" });
    expect(await port.listOpenSlots({ athleteId: her, offerPublicId: o.public_id, from: new Date(), days: 7 })).toEqual([]);
  });

  it("request mode takes 1–3 times; exactly one of slotId / times; bad input is invalid", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request" });
    const t = (h: number) => new Date(Date.now() + h * H).toISOString();
    const asked = [t(50), t(74)];
    const ok = await port.createPendingRequest({ athleteId: her, offerPublicId: o.public_id, slotId: null, times: asked, note: null, askMilaSessionId: "ask_3" });
    expect(ok.ok).toBe(true);
    expect((await pendingRows(o.id))[0].proposed_times).toEqual(asked.map((start) => ({ start, tz: null })));
    const base = { athleteId: her, offerPublicId: o.public_id, note: null, askMilaSessionId: "ask_4" };
    expect(await port.createPendingRequest({ ...base, slotId: null, times: [t(50), t(51), t(52), t(53)] })).toEqual({ ok: false, reason: "invalid" });
    expect(await port.createPendingRequest({ ...base, slotId: null, times: [t(1)] })).toEqual({ ok: false, reason: "invalid" });
    expect(await port.createPendingRequest({ ...base, slotId: null, times: null })).toEqual({ ok: false, reason: "invalid" });
    expect(await port.createPendingRequest({ ...base, slotId: "x", times: [t(50)] })).toEqual({ ok: false, reason: "invalid" });
    expect(await port.createPendingRequest({ ...base, slotId: "00000000-0000-0000-0000-000000000000", times: null })).toEqual({ ok: false, reason: "invalid" });
    expect(await port.createPendingRequest({ ...base, askMilaSessionId: "", slotId: null, times: [t(50)] })).toEqual({ ok: false, reason: "invalid" });
    expect(await port.createPendingRequest({ ...base, slotId: null, times: [5 as any] })).toEqual({ ok: false, reason: "invalid" });
    expect(await pendingRows(o.id)).toHaveLength(1);
  });

  it("another athlete's offer, a draft, an unknown offer, a non-pilot athlete or bookings off → unavailable", async () => {
    const o = await seedOffer(her, { scheduling_mode: "request" });
    const draft = await seedOffer(her, { scheduling_mode: "request", status: "draft" });
    const t = new Date(Date.now() + 50 * H).toISOString();
    const req = (athleteId: string, offerPublicId: string) => port.createPendingRequest({ athleteId, offerPublicId, slotId: null, times: [t], note: null, askMilaSessionId: "ask_5" });
    expect(await req(other, o.public_id)).toEqual({ ok: false, reason: "unavailable" });
    expect(await req(her, draft.public_id)).toEqual({ ok: false, reason: "unavailable" });
    expect(await req(her, "nope")).toEqual({ ok: false, reason: "unavailable" });
    expect(await req(notPilot, o.public_id)).toEqual({ ok: false, reason: "unavailable" });
    process.env.BOOKINGS_ENABLED = "false";
    expect(await req(her, o.public_id)).toEqual({ ok: false, reason: "unavailable" });
    process.env.BOOKINGS_ENABLED = "true";
    expect(await pendingRows(o.id)).toHaveLength(0);
    expect(await pendingRows(draft.id)).toHaveLength(0);
  });
});

describe("A4 the visitor's next page: the contact step, then the codes", () => {
  async function pending() {
    const o = await seedOffer(her, { scheduling_mode: "request" });
    const r = await port.createPendingRequest({ athleteId: her, offerPublicId: o.public_id, slotId: null, times: [new Date(Date.now() + 50 * H).toISOString()], note: null, askMilaSessionId: "ask_6" });
    if (!r.ok) throw new Error("expected ok");
    return { o, token: tokenOf(r.nextUrl) };
  }

  it("until the contact step: the email code steps refuse", async () => {
    const { token } = await pending();
    expect((await call("POST", `/b/${token}/email/send`)).body.code).toBe("CONTACT_FIRST");
    expect((await call("POST", `/b/${token}/email/verify`, { code: "123456" })).body.code).toBe("NO_CODE");
    expect((await call("GET", `/b/${token}`)).status).toBe(401);
  });

  it("the same checks as a direct request; the price must match; then the email code, and only once", async () => {
    const { o, token } = await pending();
    const bad = await call("POST", `/b/${token}/contact`, { displayed_total_cents: 17_796 });
    expect(bad.status).toBe(400);
    expect(bad.body.detail.map((d: any) => d.field).sort()).toEqual(["adult_attested", "agree_terms", "buyer_email", "buyer_name", "buyer_timezone"]);
    expect((await call("POST", `/b/${token}/contact`, contact({ parent_booking: true, child_first_name: "Kid" }))).body.detail).toEqual([{ field: "parent_booking", problem: "this offer is for adults only" }]);
    expect((await call("POST", `/b/${token}/contact`, contact({ displayed_total_cents: 1 })))).toMatchObject({ status: 409, body: { code: "PRICE_CHANGED", detail: { buyerTotalCents: 17_796 } } });
    const ok = await call("POST", `/b/${token}/contact`, contact());
    expect(ok.body).toEqual({ nextStep: "email", maskedEmail: "j•••@example.test" });
    const [row] = await pendingRows(o.id);
    expect(row).toMatchObject({ buyer_name: "Jordan Park", buyer_email: "jordan.ask@example.test", buyer_adult_attested: true, buyer_email_hash: emailHash("jordan.ask@example.test") });
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(emailMock.mock.calls[0][0]).toMatchObject({ to: "jordan.ask@example.test", subject: expect.stringMatching(/^Your Nomila code: \d{6}$/) });
    const code = /(\d{6})/.exec(emailMock.mock.calls[0][0].subject)![1];
    const v = await call("POST", `/b/${token}/email/verify`, { code });
    expect(v.body).toMatchObject({ nextStep: "card", access: expect.any(String) });
    expect((await call("POST", `/b/${token}/contact`, contact()))).toMatchObject({ status: 409 });
  });

  it("only inside the 15-minute hold", async () => {
    const { o, token } = await pending();
    await db.update(bookings).set({ created_at: new Date(Date.now() - 16 * 60_000) }).where(eq(bookings.offer_id, o.id));
    expect((await call("POST", `/b/${token}/contact`, contact())).body.code).toBe("HOLD_LAPSED");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("a blocked buyer gets the same answer; the request ends and nothing is sent", async () => {
    const { o, token } = await pending();
    await db.insert(safetyBlocks).values({ scope: "platform", kind: "email", value_hash: emailHash("blocked@example.test"), created_by: "admin" });
    const r = await call("POST", `/b/${token}/contact`, contact({ buyer_email: "blocked@example.test" }));
    expect(r.body).toEqual({ nextStep: "email", maskedEmail: "b•••@example.test" });
    expect((await pendingRows(o.id))[0].status).toBe("expired");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("an unverified Ask Mila request never shows on her side", async () => {
    const { o } = await pending();
    const [row] = await pendingRows(o.id);
    const { listBookings } = await import("./athlete");
    for (const view of ["requests", "upcoming", "past"] as const) {
      expect((await listBookings(her, view)).map((b) => b.id)).not.toContain(row.id);
    }
  });
});
