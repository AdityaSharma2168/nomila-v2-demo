/**
 * routes/whatMattersNext.test.ts + routes/financials.ts — app layout B's read-only summaries, through the real routes
 * on PGlite. No provider is reachable: Stripe is never imported by these reads and the model clients are mocked.
 *
 *   W1 auth          401 without a session on all three routes
 *   W2 tenancy       another athlete's opportunities, payments, holds, refunds and bookings never appear
 *   W3 candidates    a held deposit → serious_offer (with its hold); her move → deal_waiting carrying the board card's
 *                    next step (need / why) and the board's needsYou count as `waiting`; money owed and no active
 *                    payout account → payout_setup; a payout in the last 30 days → money_paid
 *   W4 financials    totals and lists: upcoming (stage), paid this month / year, holds, refunds, the payout account
 *   W5 bookings      dark (empty, no published section) while BOOKINGS_ENABLED is off; with it on, a published offer shows
 *                    the section and a request becomes a booking_request carrying its respond-by clock
 *   W6 empty         a new athlete: no candidates, hasMoney false, account none
 * Generic fixtures only: no athlete, sport, school or real brand.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  return { createLogger: () => l, logger: l };
});
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn(), kimiStream: jest.fn() }));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = (globalThis as any).__TEST_ATHLETE_ID;
    if (!id) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.athleteId = id; next();
  },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import whatMattersNextRouter from "./whatMattersNext";
import { readOpportunityBoard } from "../services/opportunityBoard";
import financialsRouter from "./financials";
import { bookings, connectAccounts, deals, inboxBrands, inboxMessages, inboxThreads, offers, opportunities, payments } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

jest.setTimeout(180_000);

const g = globalThis as any;
let server: Server; let base = "";
let A = ""; let B = ""; let NEW = "";
const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);

async function get(path: string, athleteId: string | null) {
  g.__TEST_ATHLETE_ID = athleteId;
  const r = await fetch(`${base}/api/v1/me${path}`);
  return { status: r.status, body: await r.json().catch(() => undefined) as any };
}

let seq = 0;
async function seedOpp(athleteId: string, name: string, o: { awaiting: "athlete" | "brand"; deposit?: boolean; lastIn: Date }) {
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: `${name.toLowerCase()}-${++seq}` } as any).returning({ id: inboxBrands.id });
  const [opp] = await db.insert(opportunities).values({ athlete_id: athleteId, brand_id: b.id, status: "open", opened_at: o.lastIn, last_activity_at: o.lastIn } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({
    athlete_id: athleteId, brand_name: name, status: "detected", source: "inbox_scan", detected_at: o.lastIn, opportunity_id: opp.id,
    deposit_status: o.deposit ? "held" : "none",
  } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, deal_id: d.id, brand_id: b.id, subject: name, status: "deal_detected", last_message_at: o.lastIn,
    classification: { qualification: "needs_terms", channel: "direct", qualification_reason: "" },
    conversation_state: { key_details: { awaiting_response_from: o.awaiting } },
  } as any).returning({ id: inboxThreads.id });
  await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, opp.id));
  await db.insert(inboxMessages).values({ thread_id: t.id, athlete_id: athleteId, direction: "inbound", received_at: o.lastIn, platform: "gmail" } as any);
  if (o.deposit) {
    await db.insert(payments).values({ deal_id: d.id, athlete_id: athleteId, kind: "deposit", status: "authorized", brand_total_cents: 5_000, created_at: daysAgo(1) } as any);
  }
  return { opportunityId: opp.id, dealId: d.id };
}

async function seedDeal(athleteId: string, name: string): Promise<string> {
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: name, status: "accepted", source: "self_reported" } as any).returning({ id: deals.id });
  return d.id;
}

async function seedPayment(athleteId: string, dealId: string, o: { status: string; cents: number; updated?: Date; refunded?: number; confirmed?: boolean }) {
  await db.insert(payments).values({
    deal_id: dealId, athlete_id: athleteId, kind: "deal_payment", status: o.status, deal_value_cents: o.cents, brand_total_cents: o.cents + 500,
    refunded_cents: o.refunded ?? null, refunded_at: o.refunded ? o.updated ?? null : null,
    athlete_confirmed_at: o.confirmed ? daysAgo(1) : null, updated_at: o.updated ?? new Date(NOW), created_at: daysAgo(40),
  } as any);
}

async function seedOfferAndRequest(athleteId: string, respondBy: Date) {
  const [offer] = await db.insert(offers).values({
    athlete_id: athleteId, public_id: `pub_${++seq}`, format: "video_call", title: "20-min video call", price_cents: 12_000,
    duration_minutes: 20, location_mode: "virtual", status: "published",
  } as any).returning({ id: offers.id });
  await db.insert(bookings).values({
    athlete_id: athleteId, offer_id: offer.id, status: "requested", format: "video_call", title: "20-min video call", duration_minutes: 20,
    location_mode: "virtual", policy_key: "athlete_window_v1", free_cancel_hours: 24, price_cents: 12_000, service_fee_cents: 2_100,
    buyer_total_cents: 14_100, buyer_name: "A buyer", buyer_email: `buyer${seq}@example.test`, buyer_email_hash: `h${seq}`,
    buyer_token_hash: `t${seq}`, respond_by: respondBy,
  } as any);
}

let aHeld: { opportunityId: string; dealId: string };
let aWaiting: { opportunityId: string; dealId: string };

beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("Athlete One");
  B = await seedAthlete("Athlete Two");
  NEW = await seedAthlete("Athlete New");

  // A: one opportunity waiting on her, one with a held deposit, one waiting on the brand (never a candidate).
  aWaiting = await seedOpp(A, "Brand Alpha", { awaiting: "athlete", lastIn: daysAgo(2) });
  aHeld = await seedOpp(A, "Brand Beta", { awaiting: "brand", deposit: true, lastIn: daysAgo(3) });
  await seedOpp(A, "Brand Gamma", { awaiting: "brand", lastIn: daysAgo(1) });
  // A's money: one funded (upcoming, awaiting delivery), one paid recently, one refunded; no payout account.
  await seedPayment(A, await seedDeal(A, "Brand Delta"), { status: "funded", cents: 180_000 });
  await seedPayment(A, await seedDeal(A, "Brand Epsilon"), { status: "settled", cents: 120_000, updated: daysAgo(1) });
  await seedPayment(A, await seedDeal(A, "Brand Zeta"), { status: "refunded", cents: 30_000, refunded: 30_500, updated: daysAgo(5) });

  // B: her own everything — a waiting opportunity, a held deposit, money, an ACTIVE payout account, a booking, a move.
  await seedOpp(B, "Brand Other", { awaiting: "athlete", deposit: true, lastIn: daysAgo(1) });
  await seedPayment(B, await seedDeal(B, "Brand Other Paid"), { status: "settled", cents: 99_900, updated: daysAgo(1) });
  await db.insert(connectAccounts).values({ athlete_id: B, stripe_account_id: "acct_b", payouts_enabled: true, transfers_active: true, details_submitted: true } as any);
  await seedOfferAndRequest(B, new Date(NOW + 18 * 3_600_000));

  const app = express(); app.use(express.json());
  app.use("/api/v1/me", financialsRouter);
  app.use("/api/v1/me", whatMattersNextRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  g.__TEST_ATHLETE_ID = undefined;
  delete process.env.BOOKINGS_ENABLED;
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
});
beforeEach(() => { delete process.env.BOOKINGS_ENABLED; });

describe("W1 auth", () => {
  it.each(["/what-matters-next", "/financials", "/bookings/summary"])("%s: 401 without a session", async (path) => {
    expect((await get(path, null)).status).toBe(401);
  });
});

describe("W3 candidates", () => {
  it("A: serious offer with its hold, her move as deal_waiting, payout setup, the recent payout; nothing waiting on the brand", async () => {
    const { status, body } = await get("/what-matters-next", A);
    expect(status).toBe(200);
    expect(body.version).toBe("what-matters-next/0.1");
    const byKind = (k: string) => body.items.filter((i: any) => i.kind === k);
    expect(byKind("serious_offer")).toEqual([expect.objectContaining({ brandName: "Brand Beta", amountCents: 5_000, target: { screen: "opportunity", opportunityId: aHeld.opportunityId, dealId: aHeld.dealId } })]);
    expect(byKind("deal_waiting")).toEqual([expect.objectContaining({ brandName: "Brand Alpha", dueAt: null, target: { screen: "opportunity", opportunityId: aWaiting.opportunityId, dealId: aWaiting.dealId } })]);
    expect(body.items.some((i: any) => i.brandName === "Brand Gamma")).toBe(false);
    // The row model is the card's: the one next step and why, from the deal's own data — never "is waiting on you".
    expect(byKind("deal_waiting")[0]).toMatchObject({ action: "ask_for_terms", need: "Ask for terms", order: 0 });
    expect(typeof byKind("deal_waiting")[0].why).toBe("string");
    // The same count the Opportunities tab shows (the board's needsYou).
    const board = await readOpportunityBoard(A, new Date());
    expect(body.waiting).toBe(board.counts.needsYou);
    expect(board.needsYou.map((i) => i.opportunity_id)).toEqual([aWaiting.opportunityId]);
    expect(byKind("payout_setup")).toEqual([expect.objectContaining({ amountCents: 180_000, target: { screen: "financials" } })]);
    expect(byKind("money_paid")).toEqual([expect.objectContaining({ brandName: "Brand Epsilon", amountCents: 120_000 })]);
    expect(byKind("booking_request")).toEqual([]);
  });

  it("an active payout account: no payout setup line", async () => {
    const { body } = await get("/what-matters-next", B);
    expect(body.items.some((i: any) => i.kind === "payout_setup")).toBe(false);
  });
});

describe("W2 tenancy", () => {
  it("A never sees B's opportunities, money, bookings or moves; B never sees A's", async () => {
    process.env.BOOKINGS_ENABLED = "true";
    const a = JSON.stringify((await get("/what-matters-next", A)).body);
    expect(a).not.toMatch(/Brand Other|b-move|video call/);
    const b = JSON.stringify((await get("/what-matters-next", B)).body);
    expect(b).not.toMatch(/Brand (Alpha|Beta|Gamma|Delta|Epsilon|Zeta)|"r1"|"r3"/);
    const fa = JSON.stringify((await get("/financials", A)).body);
    expect(fa).not.toMatch(/Brand Other/);
    const fb = (await get("/financials", B)).body;
    expect(JSON.stringify(fb)).not.toMatch(/Brand (Delta|Epsilon|Zeta|Beta)/);
    expect(fb.holds).toHaveLength(1);
    expect((await get("/bookings/summary", A)).body).toMatchObject({ published: false, requests: [] });
  });
});

describe("W4 financials", () => {
  it("A: coming, paid this month and year, upcoming stage, holds, refunds, no payout account", async () => {
    const { status, body } = await get("/financials", A);
    expect(status).toBe(200);
    expect(body).toMatchObject({ version: "financials/0.1", hasMoney: true, currency: "usd", comingCents: 180_000 });
    expect(body.paidYearCents).toBe(120_000);
    expect(body.payouts.upcoming).toEqual([expect.objectContaining({ label: "Brand Delta", amountCents: 180_000, stage: "awaiting_delivery", source: "deal" })]);
    expect(body.payouts.paid).toEqual([expect.objectContaining({ label: "Brand Epsilon", amountCents: 120_000 })]);
    expect(body.holds).toEqual([expect.objectContaining({ label: "Brand Beta", amountCents: 5_000 })]);
    expect(body.refunds).toMatchObject({ cents: 30_500, items: [expect.objectContaining({ label: "Brand Zeta", amountCents: 30_500 })] });
    expect(body.account).toEqual({ state: "none", payoutsEnabled: false, detailsSubmitted: false, requirementsDue: 0 });
  });

  it("B: the active payout account", async () => {
    expect((await get("/financials", B)).body.account).toMatchObject({ state: "active", payoutsEnabled: true });
  });
});

describe("W5 bookings", () => {
  it("dark while BOOKINGS_ENABLED is off: the empty summary, no booking candidate", async () => {
    expect((await get("/bookings/summary", B)).body).toEqual({ version: "bookings-summary/0.1", published: false, publishedOffers: 0, requests: [], upcoming: [] });
    expect((await get("/what-matters-next", B)).body.items.some((i: any) => i.kind === "booking_request")).toBe(false);
  });

  it("on: a published offer shows the section; the request is a booking_request with its clock; buyer contact never travels", async () => {
    process.env.BOOKINGS_ENABLED = "true";
    const s = (await get("/bookings/summary", B)).body;
    expect(s).toMatchObject({ published: true, publishedOffers: 1 });
    expect(s.requests).toEqual([expect.objectContaining({ title: "20-min video call", priceCents: 12_000, status: "requested" })]);
    expect(JSON.stringify(s)).not.toMatch(/example\.test|A buyer/);
    const items = (await get("/what-matters-next", B)).body.items;
    const req = items.find((i: any) => i.kind === "booking_request");
    expect(req).toMatchObject({ title: "20-min video call", amountCents: 12_000, target: { screen: "booking" } });
    expect(Date.parse(req.dueAt)).toBeGreaterThan(NOW);
    expect(JSON.stringify(items)).not.toMatch(/example\.test|A buyer/);
  });
});

describe("W6 a new athlete", () => {
  it("no candidates; no money; no payout account; no bookings section", async () => {
    process.env.BOOKINGS_ENABLED = "true";
    expect((await get("/what-matters-next", NEW)).body).toEqual({ version: "what-matters-next/0.1", items: [], waiting: 0 });
    expect((await get("/financials", NEW)).body).toMatchObject({ hasMoney: false, comingCents: 0, paidMonthCents: 0, account: { state: "none" }, holds: [], payouts: { upcoming: [], paid: [] } });
    expect((await get("/bookings/summary", NEW)).body).toMatchObject({ published: false, requests: [] });
  });
});
