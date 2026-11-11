/**
 * All deals + All bookings search (DEALS_SEARCH, retired 2 Nov 2026: always on): plain-word matching over brand and
 * agency names, type, status, ask and amounts; Active / Done / Closed with counts; type chips; filed mail under Closed →
 * "Not a deal"; Maybe only with DEALS_MAYBE; her rows only; bookings never carry buyer contact details. PGlite.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
jest.mock("./bookings/config", () => ({ ...jest.requireActual("./bookings/config"), bookingsEnabledFor: () => true }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { bookings, deals, inboxBrands, inboxMessages, inboxThreads, offers, opportunities } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { matches } from "../lib/searchText";
import { searchDeals, searchLimit } from "./opportunitySearch";
import { searchBookings } from "./bookings/search";
import dealsRouter from "../routes/deals";
import bookingsRouter from "../routes/bookings";

const NOW = new Date("2026-10-13T12:00:00Z");
let her = "";
let other = "";

async function seedDeal(name: string, o: { who?: string; status?: "open" | "closed"; reason?: string; category?: string; agency?: string; ask?: string; amount?: number; maybe?: boolean; mediaKind?: string; at?: string }) {
  const who = o.who ?? her;
  const at = new Date(o.at ?? "2026-10-05T12:00:00Z");
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: `${name.toLowerCase()}-${who.slice(0, 4)}` } as any).returning({ id: inboxBrands.id });
  const [op] = await db.insert(opportunities).values({ athlete_id: who, brand_id: b.id, status: o.status ?? "open", opened_at: at, last_activity_at: at,
    ...(o.status === "closed" ? { close_reason: o.reason ?? "declined", closed_at: at } : {}) } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({ athlete_id: who, brand_name: name, status: "detected", opportunity_id: op.id, ...(o.amount ? { amount_cash: String(o.amount) } : {}) } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: who, deal_id: d.id, brand_id: b.id, subject: "x", status: "deal_detected", message_count: 1,
    classification: { qualification: o.amount ? "workable" : "needs_terms", channel: o.agency ? "agency" : "direct", qualification_reason: "", category: o.category ?? "PAID",
      ...(o.agency ? { agency_name: o.agency } : {}), ...(o.amount ? { comp_kind: "cash", work_kind: "social_post" } : {}), ...(o.mediaKind ? { media_kind: o.mediaKind } : {}), ...(o.maybe ? { maybe: true } : {}) },
    conversation_state: { key_details: { ask: o.ask ?? null, awaiting_response_from: "athlete", offer_struct: o.amount ? { amount: o.amount, unit: "total", deliverable_counts: { reels: 2 } } : null } },
  } as any).returning({ id: inboxThreads.id });
  await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, op.id));
  await db.insert(inboxMessages).values({ athlete_id: who, thread_id: t.id, direction: "inbound", received_at: at } as any);
  return op.id;
}

let server: Server;
let base: string;

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete();
  other = await seedAthlete("Someone Else");
  (globalThis as any).__TEST_ATHLETE_ID = her;
  await seedDeal("Trailrunner Co", { amount: 1200, ask: "2 Reels about trail shoes", agency: "Bright Talent" });
  await seedDeal("Quiet Brand", { ask: "a gifting box" });
  await seedDeal("Newsdesk", { category: "MEDIA", mediaKind: "interview", ask: "a 20-minute interview" });
  await seedDeal("Signedco", { status: "closed", reason: "won", amount: 3000 });
  await seedDeal("Spammy", { status: "closed", reason: "not_relevant" });
  await seedDeal("Passedco", { status: "closed", reason: "declined" });
  await seedDeal("Maybeco", { maybe: true });
  await seedDeal("Trailrunner Co", { who: other, amount: 99 });

  const [off] = await db.insert(offers).values({ athlete_id: her, public_id: "p1", format: "clinic", title: "Group clinic", price_cents: 48000, duration_minutes: 90, location_mode: "virtual", video_mode: "livekit" } as any).returning({ id: offers.id });
  const bk = (name: string, status: string, starts: string, extra: Record<string, unknown> = {}) => db.insert(bookings).values({
    athlete_id: her, offer_id: off.id, status, format: "clinic", title: "Group clinic", duration_minutes: 90, location_mode: "virtual", policy_key: "k",
    free_cancel_hours: 24, price_cents: 48000, service_fee_cents: 7000, buyer_total_cents: 55000, buyer_name: name, buyer_email: `${name.split(" ")[0].toLowerCase()}@example.com`,
    buyer_email_hash: `h-${name}`, buyer_token_hash: `t-${name}-${status}`, starts_at: new Date(starts), ...extra,
  } as any);
  await bk("Jordan Park", "requested", "2026-10-18T16:00:00Z");
  await bk("Alex Morgan", "released", "2026-09-21T18:30:00Z");
  await bk("Sam Lee", "canceled", "2026-09-10T18:30:00Z");
  await bk("Riverside Parent", "confirmed", "2026-10-26T10:00:00Z", { buyer_kind: "brand", buyer_org_name: "Riverside FC" });
  await bk("Hold Only", "unverified", "2026-10-20T10:00:00Z");

  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", dealsRouter);
  app.use("/api/v1/me", bookingsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
});
afterAll(async () => { server.close(); await closeTestDb(); delete process.env.DEALS_MAYBE; });

describe("matches", () => {
  it("every word, any case, amounts with or without $ and commas", () => {
    expect(matches("trail REEL", "Trailrunner Co · 2 Reels")).toBe(true);
    expect(matches("1200", "$1,200 for 2 Reels")).toBe(true);
    expect(matches("$1,200", "$1,200 for 2 Reels")).toBe(true);
    expect(matches("trail gym", "Trailrunner Co")).toBe(false);
    expect(matches("", "anything")).toBe(true);
  });
});

describe("searchDeals", () => {
  it("tabs and counts: Active / Done / Closed; filed mail under Closed → Not a deal; Maybe hidden; her deals only", async () => {
    const r = await searchDeals(her, {}, NOW);
    expect(r.tabs).toEqual({ active: 3, done: 1, closed: 2 });
    expect(r.rows.map((x) => x.brand.name).sort()).toEqual(["Newsdesk", "Quiet Brand", "Trailrunner Co"]);
    const closed = await searchDeals(her, { tab: "closed" }, NOW);
    expect(closed.not_a_deal).toBe(1);
    expect(closed.rows.find((x) => x.brand.name === "Spammy")).toMatchObject({ closed_group: "not_a_deal", status_label: "Not a deal" });
    expect((await searchDeals(her, { tab: "done" }, NOW)).rows[0]).toMatchObject({ brand: { name: "Signedco" }, status_label: "Done" });
  });

  it("matches agency, ask, amount and type; type chips narrow; Maybe shows with DEALS_MAYBE", async () => {
    expect((await searchDeals(her, { q: "bright talent" }, NOW)).rows.map((x) => x.brand.name)).toEqual(["Trailrunner Co"]);
    expect((await searchDeals(her, { q: "trail shoes" }, NOW)).rows.map((x) => x.brand.name)).toEqual(["Trailrunner Co"]);
    expect((await searchDeals(her, { q: "$1,200" }, NOW)).rows.map((x) => x.brand.name)).toEqual(["Trailrunner Co"]);
    expect((await searchDeals(her, { q: "press" }, NOW)).rows.map((x) => x.brand.name)).toEqual(["Newsdesk"]);
    expect((await searchDeals(her, { q: "not a deal" }, NOW)).tabs.closed).toBe(1);
    const r = await searchDeals(her, { type: "press" }, NOW);
    expect(r.types.map((t) => [t.type, t.count])).toEqual(expect.arrayContaining([["press", 1], ["paid_content", 1], ["paid_no_fee", 1]]));
    expect(r.rows.map((x) => x.brand.name)).toEqual(["Newsdesk"]);
    const row = (await searchDeals(her, { q: "trailrunner" }, NOW)).rows[0];
    expect(row.money).toContain("$1,200 for 2 Reels");
    expect(row.dealType).toBe("paid_content");
    process.env.DEALS_MAYBE = "true";
    expect((await searchDeals(her, {}, NOW)).rows.map((x) => x.brand.name)).toContain("Maybeco");
    delete process.env.DEALS_MAYBE;
  });

  it("returns at most `limit` rows (default 50, never above 200); the total and tab counts stay whole", async () => {
    const one = await searchDeals(her, { limit: "1" }, NOW);
    expect(one.rows).toHaveLength(1);
    expect(one.total).toBe(3);
    expect(one.tabs.active).toBe(3);
    expect((await searchDeals(her, { limit: "abc" }, NOW)).rows).toHaveLength(3);
    expect(searchLimit(undefined)).toBe(50);
    expect(searchLimit("100000")).toBe(200);
    expect(searchLimit("-3")).toBe(50);
    expect(searchLimit("0")).toBe(50);
  });
});

describe("searchBookings", () => {
  it("buyer as she sees them, never contact; tabs; an unverified hold is not hers yet; date, title and status match", async () => {
    const r = await searchBookings(her, {});
    expect(r.tabs).toEqual({ active: 2, done: 1, closed: 1 });
    expect(r.rows.map((x) => x.buyer)).toEqual(["Jordan P.", "Riverside FC"]);
    expect(JSON.stringify(r)).not.toMatch(/@example\.com|Park\b/);
    expect((await searchBookings(her, { q: "oct 26" })).rows.map((x) => x.buyer)).toEqual(["Riverside FC"]);
    expect((await searchBookings(her, { q: "alex", tab: "done" })).rows[0]).toMatchObject({ buyer: "Alex M.", status_label: "Paid out" });
    expect((await searchBookings(her, { q: "canceled", tab: "closed" })).rows).toHaveLength(1);
    expect((await searchBookings(other, {})).rows).toEqual([]);
    const one = await searchBookings(her, { limit: "1" });
    expect(one.rows.map((x) => x.buyer)).toEqual(["Jordan P."]);
    expect(one.total).toBe(2);
  });
});

describe("routes", () => {
  const get = async (path: string) => { const res = await fetch(`${base}${path}`); return { status: res.status, body: res.status === 200 ? await res.json() : null }; };
  it("both answer, /deals/search is not captured as a deal id", async () => {
    const d = await get("/deals/search?q=trail&tab=active");
    expect(d.status).toBe(200);
    expect(d.body.rows.map((x: any) => x.brand.name)).toEqual(["Trailrunner Co"]);
    const b = await get("/bookings/search?q=jordan");
    expect(b.status).toBe(200);
    expect(b.body.rows.map((x: any) => x.buyer)).toEqual(["Jordan P."]);
    expect((await get("/deals/search?limit=1")).body.rows).toHaveLength(1);
  });
});
