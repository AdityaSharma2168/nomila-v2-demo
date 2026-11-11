/**
 * The opportunity order through the real routes (OPPS_RANKING, retired 2 Nov 2026; Express + PGlite; no provider is
 * reachable):
 *   · GET /opportunities serves the board;
 *   · GET /deals follows the board's order and the retired score never reaches the client;
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn(), kimiStream: jest.fn() }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import dealsRouter from "./deals";
import { listDealsTool } from "../mila/tools/listDeals";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

let server: Server;
let base: string;
let athleteId: string;
const dealOf: Record<string, string> = {};

async function seedOpp(name: string, o: { tier?: string; confirmed?: boolean; qualification: string; channel?: string; lastIn: string }) {
  const [b] = await db.insert(inboxBrands).values({
    name, normalized_name: name.toLowerCase(), brand_tier: o.tier ?? null,
    enrichment: o.confirmed ? { identity: { status: "confirmed", domain: "x.example", own_sources: ["x.example"], basis: "own_domain_source", checked_at: "" } } : null,
  } as any).returning({ id: inboxBrands.id });
  const at = new Date(o.lastIn);
  const [opp] = await db.insert(opportunities).values({ athlete_id: athleteId, brand_id: b.id, status: "open", opened_at: at, last_activity_at: at } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: name, status: "detected", source: "inbox_scan", detected_at: at, opportunity_id: opp.id } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, deal_id: d.id, brand_id: b.id, subject: name, status: "deal_detected", last_message_at: at,
    classification: { qualification: o.qualification, channel: o.channel ?? "direct", qualification_reason: "" },
    conversation_state: { key_details: { awaiting_response_from: "athlete" } },
  } as any).returning({ id: inboxThreads.id });
  await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, opp.id));
  await db.insert(inboxMessages).values({ thread_id: t.id, athlete_id: athleteId, direction: "inbound", received_at: at, platform: "gmail" } as any);
  dealOf[name] = d.id;
}

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;
  // The board puts the confirmed established brand first.
  await seedOpp("Smallco", { qualification: "below_floor", lastIn: "2026-09-28" });
  await seedOpp("Bigbrand", { tier: "established", confirmed: true, qualification: "needs_terms", channel: "agency", lastIn: "2026-09-20" });
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

// D3 order (DEALS_BOARD_V2, always on): state before the confirmed tier, so Smallco's under-minimum offer leads
// Bigbrand's no-fee ask.
it("/deals follows the board, the score is off the wire, /opportunities serves the board", async () => {
  const list = await get("/deals?view=active");
  expect(list.json.map((r: any) => r.brand_name)).toEqual(["Smallco", "Bigbrand"]);
  expect(list.json.every((r: any) => r.score === null)).toBe(true);

  const board = await get("/opportunities");
  expect(board.status).toBe(200);
  expect(board.json.whatMatters.map((x: any) => x.brand.name)).toEqual(["Smallco", "Bigbrand"]);
  expect(board.json.whatMatters[1].deal_ids).toEqual([dealOf["Bigbrand"]]);

  expect((await get("/deals/brief")).status).not.toBe(200); // retired route
});

it("Mila's list_deals (priority) reads the same board order and card line; no score", async () => {
  const r: any = await listDealsTool.execute(athleteId, {} as any);
  expect(r.deals.map((d: any) => d.brand_name)).toEqual(["Smallco", "Bigbrand"]);
  const big = r.deals.find((d: any) => d.brand_name === "Bigbrand");
  expect(big).toMatchObject({ verdict: null, score_numeric: null });
  expect(big.why).toMatch(/^Via an agency · Interested in working together · no fee yet · Waiting on you since/);
});
