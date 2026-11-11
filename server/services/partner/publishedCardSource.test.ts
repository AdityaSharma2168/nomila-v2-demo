/**
 * publishedCardSource.test.ts — the real seam: a card published through the snapshot service is what the Partner door
 * sees (first name, version, the Partner door, each chapter's published words), and nothing else; an unpublished,
 * unknown or old (redirected) handle, or PUBLIC_CARD off, is no card. End to end: the public /fit route on a really
 * published card answers, and a card whose Partner door is off answers 404.
 */
process.env.PUBLIC_CARD = "true";
process.env.PARTNER_INTAKE = "true";
process.env.PARTNER_FIT_PER_VISITOR_DAY = "100";
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/safeFetch", () => ({ ...jest.requireActual("../../lib/safeFetch"), safeFetch: jest.fn(async () => new Response("", { status: 404 })) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { publicCards } from "../../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { ensureCard, publishSnapshot } from "../publicCard/publish";
import { setHandle } from "../publicCard/handles";
import { ALL_SWITCHES_ON, fixtureCard } from "../../testUtils/publicCardFixtures";
import { tilesFor } from "../publicCard/types";
import { publishedCard, setPublishedCardSource } from "./publishedCard";
import { publicCardReaderSource } from "./publishedCardSource";
import { partnerApiRouter } from "../../routes/partnerPublic";

let a: string; let b: string; let server: Server; let base: string;

async function publish(athleteId: string, handle: string, first: string, partner = true) {
  await ensureCard(athleteId);
  await db.update(publicCards).set({ ...ALL_SWITCHES_ON, door_partner: partner }).where(eq(publicCards.athlete_id, athleteId));
  await db.transaction((tx) => setHandle(tx as any, athleteId, handle));
  const f = fixtureCard(first, "Example");
  if (!partner) {
    // Partner switched off: the door, its chapter button and the tiles as the publish resolver would have them.
    f.content.doors.partner = false;
    for (const c of f.content.chapters) if (c.button?.door === "partner") c.button = { door: "ask_mila", label: `Ask Mila about ${first}` };
    const { tiles: _t, ...rest } = f.content;
    f.content.tiles = tilesFor(rest as any);
  }
  await publishSnapshot(athleteId, f);
}

beforeAll(async () => {
  await initTestDb();
  a = await seedAthlete("Seam One");
  b = await seedAthlete("Seam Two");
  await publish(a, "seam-one", "Rowan");
  await publish(b, "seam-two", "Sasha", false);
  setPublishedCardSource(publicCardReaderSource);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/public/cards", partnerApiRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { server?.close(); setPublishedCardSource(null); await closeTestDb(); });

it("a published card: her first name, the version, the Partner door, and the published words only", async () => {
  const f = await publishedCard("seam-one");
  expect(f).toMatchObject({ athleteId: a, handle: "seam-one", firstName: "Rowan", version: expect.any(Number), partnerOpen: true });
  expect(f!.chapters.map((c) => c.id)).toEqual(["highlights", "partnerships"]);   // the image-only media chapter carries no words
  expect(f!.chapters[0].text).toMatch(/Open-water swimmer who trains before sunrise\./);
  expect(f!.chapters[0].text).toMatch(/Instagram followers/);
  expect(JSON.stringify(f)).not.toMatch(/athletes\/fixture|sources|said:assertion/);
  expect((await publishedCard("seam-two"))!.partnerOpen).toBe(false);
});

it("unknown, malformed or flag-off is no card", async () => {
  expect(await publishedCard("no-such-card")).toBeNull();
  expect(await publishedCard("../etc")).toBeNull();
  process.env.PUBLIC_CARD = "false";
  try { expect(await publishedCard("seam-one")).toBeNull(); } finally { process.env.PUBLIC_CARD = "true"; }
});

it("the public route works on a really published card; a closed Partner door is 404", async () => {
  const ok = await fetch(`${base}/api/v1/public/cards/seam-one/partner/fit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ website: "brandexample.com" }) });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ domain: "brandexample.com", askAbout: true, fit: null });
  const closed = await fetch(`${base}/api/v1/public/cards/seam-two/partner/fit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ website: "brandexample.com" }) });
  expect(closed.status).toBe(404);
});
