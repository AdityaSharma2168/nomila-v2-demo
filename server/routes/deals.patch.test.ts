/**
 * deals PATCH routes — validation (A14) + JSONB lost-update safety (A15).
 * Real Express router against PGlite; auth + kimi mocked.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/kimi", () => ({ kimiStream: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import dealsRouter from "./deals";
import { deals, athletes } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

let server: Server;
let base: string;
let athleteId: string;

function asUser(id: string) { (globalThis as any).__TEST_ATHLETE_ID = id; }

async function seedDeal(aid: string): Promise<string> {
  const [d] = await db.insert(deals).values({ athlete_id: aid, brand_name: "Acme", status: "detected", source: "inbox_scan" }).returning({ id: deals.id });
  return d.id;
}

async function patchDeal(id: string, body: unknown) {
  const res = await fetch(`${base}/deals/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

async function patchPrefs(body: unknown) {
  const res = await fetch(`${base}/preferences`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  asUser(athleteId);
  const app = express();
  app.use(express.json());
  app.use("/", dealsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

describe("PATCH /deals/:id — validation (A14)", () => {
  it("404s on a non-UUID id instead of throwing a 500", async () => {
    expect((await patchDeal("not-a-uuid", { status: "pending" })).status).toBe(404);
  });

  it("400s on an invalid status", async () => {
    const id = await seedDeal(athleteId);
    expect((await patchDeal(id, { status: "bogus" })).status).toBe(400);
  });

  it("caps notes length and keeps only the last 50 history entries", async () => {
    const id = await seedDeal(athleteId);
    const huge = "x".repeat(5000);
    await patchDeal(id, { status: "negotiating", notes: huge });
    const [d] = await db.select({ ns: deals.negotiation_state }).from(deals).where(eq(deals.id, id)).limit(1);
    const history = (d.ns as any).history as any[];
    expect(history[0].notes.length).toBe(2000); // capped
  });
});

describe("PATCH /deals/:id — JSONB lost-update safety (A15)", () => {
  it("two sequential note PATCHes both land in history", async () => {
    const id = await seedDeal(athleteId);
    await patchDeal(id, { status: "negotiating", notes: "first" });
    await patchDeal(id, { status: "negotiating", notes: "second" });
    const [d] = await db.select({ ns: deals.negotiation_state }).from(deals).where(eq(deals.id, id)).limit(1);
    const history = (d.ns as any).history as any[];
    expect(history.map((h) => h.notes)).toEqual(["first", "second"]);
  });
});

describe("PATCH /preferences — JSONB merge preserves sibling keys (A15)", () => {
  it("keeps minimum_rate when reply_signature is saved in a later request", async () => {
    await patchPrefs({ minimum_rate: 5000 });
    await patchPrefs({ reply_signature: { sign_off: "Best", name: "Alex" } });
    const [a] = await db.select({ dp: athletes.deal_preferences }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    const dp = a.dp as any;
    expect(dp.minimum_rate).toBe(5000);
    expect(dp.reply_signature).toEqual({ sign_off: "Best", name: "Alex" });
  });
});

describe("POST /deals/:id/draft — input validation (A14)", () => {
  it("404s on a non-UUID id", async () => {
    const res = await fetch(`${base}/deals/nope/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reply_intent: "accept" }) });
    expect(res.status).toBe(404);
  });

  it("400s when selected_terms is not an array of strings", async () => {
    const id = await seedDeal(athleteId);
    const res = await fetch(`${base}/deals/${id}/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reply_intent: "negotiate", selected_terms: "rate" }) });
    expect(res.status).toBe(400);
  });
});
