/**
 * routes/publicCard.test.ts — GET /api/public/cards/:handle through Express against PGlite (design-public-card-v3 §11).
 * Made-up athletes in different sports; nothing reaches a provider or the network.
 *
 *   R1 a published card → 200 with ONLY the published content (no draft, no sources, no ids), ETag + 304, noindex
 *      unless she turned search on
 *   R2 an edit she has not published never shows: the URL keeps serving the last version
 *   R3 an old handle → 301 to the new one; unknown / unpublished / malformed → the same 404
 *   R4 two athletes: each handle serves only its own snapshot
 *   R5 PUBLIC_CARD off → 404 for everything
 *   R6 the media proxy: a key in the published version → 302 to a signed URL; any other key, handle or state → 404
 */
process.env.PUBLIC_CARD = "true";
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/rateLimit", () => ({ publicCardLimiter: (_req: any, _res: any, next: any) => next() }));
// The bucket boundary: signing is local in production but must never reach GCS from a test.
jest.mock("../lib/mediaStore", () => ({ signedUrl: jest.fn(async (path: string) => `https://storage.googleapis.com/test-bucket/${path}?sig=1`) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { publicCards } from "../../shared/schema";
import type { PublicCardPage } from "../../shared/publicCard";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import publicCardRouter from "./publicCard";
import { setHandle } from "../services/publicCard/handles";
import { ensureCard, publishSnapshot, unpublish } from "../services/publicCard/publish";
import { ALL_SWITCHES_ON, fixtureCard } from "../testUtils/publicCardFixtures";

let server: Server; let base: string;
const get = async (handle: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/api/public/cards/${handle}`, { headers, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) as PublicCardPage : undefined };
};
async function athlete(name: string, first: string, last: string) {
  const id = await seedAthlete(name);
  await ensureCard(id);
  await db.update(publicCards).set(ALL_SWITCHES_ON).where(eq(publicCards.athlete_id, id));
  return { id, card: fixtureCard(first, last) };
}

beforeAll(async () => {
  await initTestDb();
  const app = express();
  app.use(publicCardRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await closeTestDb(); });
beforeEach(() => { process.env.PUBLIC_CARD = "true"; });

it("R1/R2 serves only the published snapshot, with ETag, 304 and noindex by default", async () => {
  const a = await athlete("Lio Marchetti", "Lio", "Marchetti");
  await publishSnapshot(a.id, a.card);
  // a draft decision she has not published is in the row, never in the response
  await db.update(publicCards).set({ draft: { items: { "secret:item": { state: "approved" } } } }).where(eq(publicCards.athlete_id, a.id));

  const r = await get("lio-marchetti");
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ status: "ok", handle: "lio-marchetti", version: 1, etag: expect.any(String), publishedAt: expect.any(String), indexable: false, content: a.card.content });
  const raw = JSON.stringify(r.body);
  expect(raw).not.toContain(a.id);
  expect(raw).not.toMatch(/secret:item|"sources"|"draft"|social_feature|shop_item/);
  expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(r.headers.get("cache-control")).toBe("public, max-age=60");
  const etag = r.headers.get("etag")!;
  expect((await get("lio-marchetti", { "If-None-Match": etag })).status).toBe(304);

  await db.update(publicCards).set({ indexable: true }).where(eq(publicCards.athlete_id, a.id));
  expect((await get("lio-marchetti")).headers.get("x-robots-tag")).toBeNull();
});

it("R3 old handle → 301; unknown, unpublished and malformed → the same 404", async () => {
  const a = await athlete("Wren Adebayo", "Wren", "Adebayo");
  await db.transaction((tx) => setHandle(tx as any, a.id, "wren-vaults"));
  await publishSnapshot(a.id, a.card);
  await db.transaction((tx) => setHandle(tx as any, a.id, "wren-a"));
  const moved = await get("wren-vaults");
  expect(moved.status).toBe(301);
  expect(moved.headers.get("location")).toBe("/api/public/cards/wren-a");
  expect(moved.body).toEqual({ status: "redirect", to: "wren-a" });

  const miss = { status: 404, body: { status: "not_found" } };
  expect(await get("nobody-at-all")).toMatchObject(miss);
  expect(await get("has.dot")).toMatchObject(miss);
  expect(await get("x")).toMatchObject(miss);
  await unpublish(a.id);
  expect(await get("wren-a")).toMatchObject(miss);
  expect(await get("wren-vaults")).toMatchObject(miss);
});

it("R4 each handle serves only its own athlete's snapshot", async () => {
  const a = await athlete("Ama Kowalczyk", "Ama", "Kowalczyk");
  const b = await athlete("Bo Esposito", "Bo", "Esposito");
  await publishSnapshot(a.id, a.card);
  await publishSnapshot(b.id, b.card);
  const ra = await get("ama-kowalczyk");
  const rb = await get("bo-esposito");
  expect(ra.body?.status === "ok" && ra.body.content.displayName).toBe("Ama Kowalczyk");
  expect(rb.body?.status === "ok" && rb.body.content.displayName).toBe("Bo Esposito");
  expect(JSON.stringify(ra.body)).not.toContain("Esposito");
});

it("R5 PUBLIC_CARD off → 404", async () => {
  const a = await athlete("Cy Lindgren", "Cy", "Lindgren");
  await publishSnapshot(a.id, a.card);
  process.env.PUBLIC_CARD = "false";
  expect(await get("cy-lindgren")).toMatchObject({ status: 404, body: { status: "not_found" } });
});

it("R6 media proxy: only a key of the published version is served", async () => {
  const a = await athlete("Odile Ferreira", "Odile", "Ferreira");
  await publishSnapshot(a.id, a.card);
  const key = Object.keys(a.card.media)[0];
  const ok = await fetch(`${base}/p/odile-ferreira/m/${key}`, { redirect: "manual" });
  expect(ok.status).toBe(302);
  expect(ok.headers.get("location")).toBe(`https://storage.googleapis.com/test-bucket/${a.card.media[key].path}?sig=1`);
  for (const path of [`/p/odile-ferreira/m/m00000000000000000000`, `/p/nobody-at-all/m/${key}`, `/p/odile-ferreira/m/not-a-key`]) {
    expect((await fetch(`${base}${path}`, { redirect: "manual" })).status).toBe(404);
  }
  // another athlete's key under this handle is a miss
  const b = await athlete("Gus Ilunga", "Gus", "Ilunga");
  await publishSnapshot(b.id, b.card);
  const bKey = Object.keys(b.card.media)[0];
  expect((await fetch(`${base}/p/odile-ferreira/m/${bKey}`, { redirect: "manual" })).status).toBe(404);
  await unpublish(a.id);
  expect((await fetch(`${base}/p/odile-ferreira/m/${key}`, { redirect: "manual" })).status).toBe(404);
});
