/**
 * bookingsHours.test.ts — flexible hours on her side of Bookings v2, over HTTP (Express + the real routes + PGlite):
 *
 *   FH1 her weekly hours (offers.availability, 0155) save with the offer, come back on the view, and clear with null
 *   FH2 the hours are validated: shape, version, preset, days 0–6, 15-minute steps, end after start by midnight,
 *       no overlapping blocks in a day, at most 6 a day; nothing is saved when refused
 *   FH3 POST /offers/:id/slots/withdraw withdraws many open times at once and NEVER a booked one (one person, or an
 *       open group's time with any spot taken); another offer's / athlete's slot is untouched; 1..100 ids
 *   FH4 another athlete's offer is 404 for the batch withdraw
 *   FH5 parseAvailability on its own (normalised order)
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
  requireAdmin: (_req: any, res: any) => { res.status(403).json({ error: "forbidden" }); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { seedBooking, seedOffer, seedSlot } from "../testUtils/seedBookings";
import { offerSlots, offers } from "../../shared/schema";
import bookingsRouter from "./bookings";
import { parseAvailability } from "../services/bookings/availability";
import type { OfferView } from "../../shared/bookingsApi";

let server: Server;
let base: string;
let me: string, other: string;

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
const offerBody = (over: Record<string, unknown> = {}) => ({ format: "video_call", title: "1:1 video call", price_cents: 15_000, duration_minutes: 30, location_mode: "virtual", scheduling_mode: "slots", ...over });
const HOURS = { version: 1, preset: null, blocks: [{ day: 2, start: 1050, end: 1200 }, { day: 1, start: 1080, end: 1260 }, { day: 2, start: 420, end: 495 }] };

beforeAll(async () => {
  await initTestDb();
  me = await seedAthlete("Ava Example");
  other = await seedAthlete("Other Athlete");
  process.env.BOOKINGS_ENABLED = "true";
  process.env.BOOKINGS_PILOT_ATHLETE_IDS = `${me},${other}`;
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", bookingsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  delete process.env.BOOKINGS_ENABLED; delete process.env.BOOKINGS_PILOT_ATHLETE_IDS;
  await closeTestDb();
});

describe("FH1 her weekly hours save with the offer", () => {
  it("create with hours, read them back (sorted), change them, clear them", async () => {
    const created = await call("POST", "/bookings/offers", offerBody({ availability: HOURS }));
    expect(created.status).toBe(201);
    const o = created.body.offer as OfferView;
    expect(o.availability).toEqual({ version: 1, preset: null, blocks: [
      { day: 1, start: 1080, end: 1260 }, { day: 2, start: 420, end: 495 }, { day: 2, start: 1050, end: 1200 },
    ] });
    expect((await call("GET", `/bookings/offers/${o.id}`)).body.offer.availability.blocks).toHaveLength(3);
    const weekends = { version: 1, preset: "weekends", blocks: [{ day: 6, start: 600, end: 960 }, { day: 0, start: 600, end: 960 }] };
    expect((await call("PATCH", `/bookings/offers/${o.id}`, { availability: weekends })).body.offer.availability.preset).toBe("weekends");
    // A patch without availability leaves it alone.
    expect((await call("PATCH", `/bookings/offers/${o.id}`, { title: "Renamed" })).body.offer.availability.preset).toBe("weekends");
    expect((await call("PATCH", `/bookings/offers/${o.id}`, { availability: null })).body.offer.availability).toBeNull();
  });

  it("an offer without hours reads null", async () => {
    const o = (await call("POST", "/bookings/offers", offerBody())).body.offer as OfferView;
    expect(o.availability).toBeNull();
  });
});

describe("FH2 the hours are validated", () => {
  const cases: Array<[string, unknown]> = [
    ["not an object", [1, 2]],
    ["a string", "Mon 6-9"],
    ["wrong version", { version: 2, preset: null, blocks: [] }],
    ["unknown preset", { version: 1, preset: "always", blocks: [] }],
    ["blocks not a list", { version: 1, preset: null, blocks: {} }],
    ["day 7", { version: 1, preset: null, blocks: [{ day: 7, start: 600, end: 660 }] }],
    ["off the 15-minute grid", { version: 1, preset: null, blocks: [{ day: 1, start: 610, end: 660 }] }],
    ["end before start", { version: 1, preset: null, blocks: [{ day: 1, start: 660, end: 600 }] }],
    ["end equals start", { version: 1, preset: null, blocks: [{ day: 1, start: 660, end: 660 }] }],
    ["past midnight", { version: 1, preset: null, blocks: [{ day: 1, start: 1380, end: 1455 }] }],
    ["fractional minutes", { version: 1, preset: null, blocks: [{ day: 1, start: 600.5, end: 660 }] }],
    ["overlapping in a day", { version: 1, preset: null, blocks: [{ day: 1, start: 600, end: 720 }, { day: 1, start: 690, end: 780 }] }],
    ["seven blocks in a day", { version: 1, preset: null, blocks: Array.from({ length: 7 }, (_, i) => ({ day: 1, start: i * 60, end: i * 60 + 30 })) }],
  ];
  it.each(cases)("refuses %s, and saves nothing", async (_name, availability) => {
    const o = (await call("POST", "/bookings/offers", offerBody({ availability: HOURS }))).body.offer as OfferView;
    const r = await call("PATCH", `/bookings/offers/${o.id}`, { availability, title: "Should not save" });
    expect(r.status).toBe(400);
    expect(r.body.detail[0].field).toBe("availability");
    const row = (await db.select().from(offers).where(eq(offers.id, o.id)))[0];
    expect(row.title).toBe("1:1 video call");
    expect((row.availability as any).blocks).toHaveLength(3);
  });

  it("refuses bad hours on create too", async () => {
    expect((await call("POST", "/bookings/offers", offerBody({ availability: { version: 1, preset: null, blocks: [{ day: 1, start: 5, end: 60 }] } }))).status).toBe(400);
  });
});

describe("FH3 withdraw many open times at once", () => {
  it("withdraws the open ones, never a booked one; leaves other offers' times alone", async () => {
    const o = await seedOffer(me, { scheduling_mode: "slots" });
    const elsewhere = await seedOffer(me, { scheduling_mode: "slots" });
    const open1 = await seedSlot(o, 30), open2 = await seedSlot(o, 31), booked = await seedSlot(o, 32), requested = await seedSlot(o, 33);
    const otherOffers = await seedSlot(elsewhere, 40);
    await seedBooking(o, { status: "confirmed", slot_id: booked, startsInHours: 32 });
    await seedBooking(o, { status: "unverified", slot_id: requested, startsInHours: 33 });
    const r = await call("POST", `/bookings/offers/${o.id}/slots/withdraw`, { slot_ids: [open1, open2, booked, requested, otherOffers] });
    expect(r.status).toBe(200);
    expect(new Set(r.body.withdrawn)).toEqual(new Set([open1, open2]));
    expect(new Set(r.body.booked)).toEqual(new Set([booked, requested]));
    expect(r.body.slots.map((s: any) => s.id).sort()).toEqual([booked, requested].sort());
    const rows = await db.select().from(offerSlots);
    const gone = (id: string) => rows.find((x) => x.id === id)!.withdrawn_at !== null;
    expect([open1, open2].every(gone)).toBe(true);
    expect([booked, requested, otherOffers].some(gone)).toBe(false);
    // Again: nothing left to withdraw; the booked ones still stay.
    const again = await call("POST", `/bookings/offers/${o.id}/slots/withdraw`, { slot_ids: [open1, booked] });
    expect(again.body).toMatchObject({ withdrawn: [], booked: [booked] });
  });

  it("an open group's time with any spot taken stays", async () => {
    const o = await seedOffer(me, { scheduling_mode: "slots", audience: "open_group", max_people: 10 });
    const partly = await seedSlot(o, 50), empty = await seedSlot(o, 51);
    await seedBooking(o, { status: "confirmed", slot_id: partly, startsInHours: 50, audience: "open_group" });
    const r = await call("POST", `/bookings/offers/${o.id}/slots/withdraw`, { slot_ids: [partly, empty] });
    expect(r.body.withdrawn).toEqual([empty]);
    expect(r.body.booked).toEqual([partly]);
  });

  it("1 to 100 slot ids", async () => {
    const o = await seedOffer(me, { scheduling_mode: "slots" });
    for (const slot_ids of [undefined, [], ["not-a-uuid"], Array.from({ length: 101 }, () => "00000000-0000-4000-8000-000000000000")]) {
      const r = await call("POST", `/bookings/offers/${o.id}/slots/withdraw`, { slot_ids });
      expect(r.status).toBe(400);
      expect(r.body.detail[0].field).toBe("slot_ids");
    }
  });
});

describe("FH4 tenancy", () => {
  it("another athlete's offer is 404 and its times never change", async () => {
    const theirs = await seedOffer(other, { scheduling_mode: "slots" });
    const s = await seedSlot(theirs, 60);
    expect((await call("POST", `/bookings/offers/${theirs.id}/slots/withdraw`, { slot_ids: [s] })).status).toBe(404);
    // Naming their slot on MY offer withdraws nothing either.
    const mine = await seedOffer(me, { scheduling_mode: "slots" });
    expect((await call("POST", `/bookings/offers/${mine.id}/slots/withdraw`, { slot_ids: [s] })).body.withdrawn).toEqual([]);
    expect((await db.select().from(offerSlots).where(eq(offerSlots.id, s)))[0].withdrawn_at).toBeNull();
  });
});

describe("FH5 parseAvailability", () => {
  it("normalises the order and keeps touching blocks; null clears", () => {
    expect(parseAvailability({ version: 1, blocks: [{ day: 3, start: 480, end: 540 }, { day: 3, start: 420, end: 480 }, { day: 0, start: 0, end: 1440 }] }))
      .toEqual({ ok: true, value: { version: 1, preset: null, blocks: [{ day: 0, start: 0, end: 1440 }, { day: 3, start: 420, end: 480 }, { day: 3, start: 480, end: 540 }] } });
    expect(parseAvailability(null)).toEqual({ ok: true, value: null });
    expect(parseAvailability({ version: 1, preset: null, blocks: [{ day: 1, start: -15, end: 60 }] }).ok).toBe(false);
  });
});
