/**
 * bookingsPublicCardOffers.test.ts — GET /api/v1/book/cards/:handle/offers, the Book door's LIVE offer list.
 *
 * The public page is a frozen snapshot, so a session she published after her last page publish used to be missing
 * from the Book door until she republished. The door now reads her offers live through this route:
 *
 *   L1 a session published AFTER the page publish is listed (no republish); a paused, deleted or draft one is not;
 *      a slots offer with no open times is not (nothing to book)
 *   L2 the snapshot itself is untouched (no new version is written)
 *   L3 404 unless: her card is published, its Book door is open, she is in the bookings pilot, the handle is real
 */
process.env.PUBLIC_CARD = "true";
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/stripe", () => require("../testUtils/fakeStripeBookings").stripeModule);
jest.mock("../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { seedOffer, seedPayoutAccount, seedSlot } from "../testUtils/seedBookings";
import { publicCards, publicCardSnapshots } from "../../shared/schema";
import { ensureCard, publishRemoval, publishSnapshot, unpublish } from "../services/publicCard/publish";
import { setHandle } from "../services/publicCard/handles";
import { ALL_SWITCHES_ON, fixtureCard } from "../testUtils/publicCardFixtures";
import publicRouter from "./bookingsPublic";
import type { PublicOfferView } from "../../shared/bookingsApi";

let server: Server;
let base: string;
let her: string, other: string;

async function call(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/v1/book${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function publishedCard(athleteId: string, handle: string): Promise<void> {
  await ensureCard(athleteId);
  await db.update(publicCards).set(ALL_SWITCHES_ON).where(eq(publicCards.athlete_id, athleteId));
  await db.transaction((tx) => setHandle(tx as any, athleteId, handle));
  const { content, sources, media } = fixtureCard();
  await publishSnapshot(athleteId, { content, sources, media });
}
const versionCount = async (id: string) => (await db.select().from(publicCardSnapshots).where(eq(publicCardSnapshots.athlete_id, id))).length;

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Ava Example");
  other = await seedAthlete("Not Pilot");
  await seedPayoutAccount(her);
  Object.assign(process.env, {
    BOOKINGS_ENABLED: "true", BOOKINGS_PILOT_ATHLETE_IDS: her, BOOKING_HASH_SECRET: "test-hash-secret", BOOKING_PUBLIC_RATE_LIMIT: "100000",
  });
  await publishedCard(her, "ava-live-offers");
  await publishedCard(other, "not-pilot-offers");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/book", publicRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  for (const k of ["BOOKINGS_ENABLED", "BOOKINGS_PILOT_ATHLETE_IDS", "BOOKING_HASH_SECRET", "BOOKING_PUBLIC_RATE_LIMIT"]) delete process.env[k];
  await closeTestDb();
});

describe("L1 + L2 her live offers, without a republish", () => {
  it("lists a session published after the page; leaves out paused, deleted, draft and timeless ones; writes no version", async () => {
    const before = await versionCount(her);
    const first = await seedOffer(her, { scheduling_mode: "request", title: "Film review" });
    expect((await call("/cards/ava-live-offers/offers")).body.offers.map((o: PublicOfferView) => o.publicId)).toEqual([first.public_id]);

    // She publishes a new session with open times: it shows at once.
    const added = await seedOffer(her, { scheduling_mode: "slots", title: "1:1 video call · 30 min" });
    await seedSlot(added, 72);
    await seedOffer(her, { status: "paused", paused_reason: "athlete" });
    await seedOffer(her, { status: "archived" });
    await seedOffer(her, { status: "draft" });
    await seedOffer(her, { scheduling_mode: "slots", title: "No times yet" });   // slots mode, none open: nothing to book
    const r = await call("/cards/ava-live-offers/offers");
    expect(r.status).toBe(200);
    const listed: PublicOfferView[] = r.body.offers;
    expect(listed.map((o) => o.publicId)).toEqual([first.public_id, added.public_id]);
    expect(listed[1]).toMatchObject({ title: "1:1 video call · 30 min", athleteFirstName: "Ava", available: true });
    expect(listed[1].slots).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toMatch(/venue/i);

    expect(await versionCount(her)).toBe(before);
  });
});

describe("L3 the gate", () => {
  it("404 for an unknown or malformed handle, a non-pilot athlete, Book closed on the published card, or an unpublished card", async () => {
    expect((await call("/cards/nobody-here/offers")).status).toBe(404);
    expect((await call("/cards/NOT%20A%20HANDLE!/offers")).status).toBe(404);
    await seedOffer(other, { scheduling_mode: "request" });
    expect((await call("/cards/not-pilot-offers/offers")).status).toBe(404);

    process.env.PUBLIC_CARD = "false";
    expect((await call("/cards/ava-live-offers/offers")).status).toBe(404);
    process.env.PUBLIC_CARD = "true";

    // She switches Book off: the published card's door closes, and the live list closes with it.
    await publishRemoval(her, { closeDoors: ["book"], reason: "You switched this off." });
    expect((await call("/cards/ava-live-offers/offers")).status).toBe(404);

    await unpublish(her);
    expect((await call("/cards/ava-live-offers/offers")).status).toBe(404);
  });
});
