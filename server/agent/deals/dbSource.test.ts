/**
 * deals/dbSource.test.ts — Mila's deal and booking sources on the app's real services, on PGlite. The reply skill is
 * replaced (no provider is reached); everything else is the real board, detail, search, dispose, pending actions and
 * bookings reads. Made-up brands and buyers.
 *
 *   B1  find: her deals only, in the board's order; closed history by brand; never another athlete's
 *   B2  get: not_found · not_yours · closed (→ include_closed reads it)
 *   B3  draft + propose: the reply skill gets the intent, HER figure and the term asks in words; the proposal is ONE inert
 *       send_reply row (body, reply_intent, source mila_chat) whose hash is the card's; waiting lists it
 *   B4  close: her "not interested" through the same dispose code as her tap — one receipt, hers; Undo restores
 *   B5  bookings: her requests, the buyer as the app shows them, never contact details
 *   B6  an Outlook deal's reply card tells the truth: off ⇒ reply in Outlook; on without Mail.Send ⇒ reconnect; on with it ⇒ Send
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));
const draftDealReply = jest.fn();
jest.mock("../../services/dealReply", () => ({ ...jest.requireActual("../../services/dealReply"), draftDealReply: (...a: unknown[]) => draftDealReply(...a) }));
jest.mock("../../services/bookings/config", () => ({ ...jest.requireActual("../../services/bookings/config"), bookingsEnabledFor: () => true }));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { agentActions, bookings, connectedAccounts, deals, inboxBrands, inboxMessages, inboxThreads, offers, opportunities, pendingActions } from "../../../shared/schema";
import { bodySha256 } from "../../../shared/bodyHash";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import agentActionsRouter from "../../routes/agentActions";
import { dbDealsSource } from "./dbSource";
import { dbBookingsSource } from "../bookings/dbSource";

let her = "";
let other = "";
const ids: Record<string, { opp: string; deal: string; thread: string }> = {};

async function seedDeal(key: string, name: string, o: { who?: string; status?: "open" | "closed"; reason?: string; amount?: number; ask?: string; at?: string } = {}) {
  const who = o.who ?? her;
  const at = new Date(o.at ?? "2026-10-05T12:00:00Z");
  const [b] = await db.insert(inboxBrands).values({ name, normalized_name: `${name.toLowerCase()}-${who.slice(0, 4)}` } as any).returning({ id: inboxBrands.id });
  const [op] = await db.insert(opportunities).values({ athlete_id: who, brand_id: b.id, status: o.status ?? "open", opened_at: at, last_activity_at: at,
    ...(o.status === "closed" ? { close_reason: o.reason ?? "declined", closed_at: at } : {}) } as any).returning({ id: opportunities.id });
  const [d] = await db.insert(deals).values({ athlete_id: who, brand_name: name, status: "detected", opportunity_id: op.id, ...(o.amount ? { amount_cash: String(o.amount) } : {}) } as any).returning({ id: deals.id });
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: who, deal_id: d.id, brand_id: b.id, subject: "x", status: "deal_detected", message_count: 1,
    classification: { qualification: o.amount ? "workable" : "needs_terms", channel: "direct", qualification_reason: "", category: "PAID", ...(o.amount ? { comp_kind: "cash", work_kind: "social_post" } : {}) },
    conversation_state: { key_details: { ask: o.ask ?? null, awaiting_response_from: "athlete", offer_struct: o.amount ? { amount: o.amount, unit: "total" } : null } },
  } as any).returning({ id: inboxThreads.id });
  await db.update(opportunities).set({ lead_thread_id: t.id } as any).where(eq(opportunities.id, op.id));
  await db.insert(inboxMessages).values({ athlete_id: who, thread_id: t.id, direction: "inbound", platform: "gmail", sender_email: "sam@brand.example", received_at: at } as any);
  ids[key] = { opp: op.id, deal: d.id, thread: t.id };
}

let server: Server;
let base: string;

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Owner");
  other = await seedAthlete("Someone Else");
  (globalThis as any).__TEST_ATHLETE_ID = her;
  await seedDeal("paid", "Northpeak Apparel", { amount: 1400, ask: "2 Reels in November" });
  await seedDeal("nofee", "Trailmark Running", { ask: "a launch-week post" });
  await seedDeal("spring", "Summit Gear", { status: "closed", reason: "won", amount: 3000, at: "2026-03-18T12:00:00Z" });
  await seedDeal("theirs", "Somebody Else Co", { who: other, amount: 99 });

  const [off] = await db.insert(offers).values({ athlete_id: her, public_id: "p1", format: "video_call", title: "30-minute call", price_cents: 6000, duration_minutes: 30, location_mode: "virtual", video_mode: "livekit" } as any).returning({ id: offers.id });
  await db.insert(bookings).values({
    athlete_id: her, offer_id: off.id, status: "requested", format: "video_call", title: "30-minute call", duration_minutes: 30, location_mode: "virtual", policy_key: "k",
    free_cancel_hours: 24, price_cents: 6000, service_fee_cents: 900, buyer_total_cents: 6900, buyer_name: "Jordan Park", buyer_email: "jordan@example.com",
    buyer_email_hash: "h-j", buyer_token_hash: "t-j", starts_at: new Date("2026-10-18T16:00:00Z"),
  } as any);

  const app = express();
  app.use(express.json());
  app.use("/", agentActionsRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
});

test("B1: find — her deals only, closed history by brand", async () => {
  const all = await dbDealsSource.find(her, { filter: "all", limit: 10 });
  const names = all.rows.map((r) => r.brand.name);
  expect(names).toEqual(expect.arrayContaining(["Northpeak Apparel", "Trailmark Running", "Summit Gear"]));
  expect(names).not.toContain("Somebody Else Co");
  const needs = await dbDealsSource.find(her, { filter: "needs_you", limit: 10 });
  expect(needs.rows.every((r) => r.whoseMove === "yours" && !r.closed)).toBe(true);
  const spring = await dbDealsSource.find(her, { filter: "closed", brand: "summit", from: "2026-03-01", to: "2026-05-31", limit: 5 });
  expect(spring.rows).toEqual([expect.objectContaining({ id: ids.spring.opp, closed: expect.objectContaining({ reason: "won" }) })]);
});

test("B2: get — not_found, not_yours, closed and include_closed", async () => {
  expect(await dbDealsSource.get(her, "00000000-0000-4000-a000-00000000dead", { includeClosed: false })).toEqual({ ok: false, error: "not_found" });
  expect(await dbDealsSource.get(her, ids.theirs.opp, { includeClosed: true })).toEqual({ ok: false, error: "not_yours" });
  expect(await dbDealsSource.get(her, ids.spring.opp, { includeClosed: false })).toEqual({ ok: false, error: "closed" });
  const hist = await dbDealsSource.get(her, ids.spring.opp, { includeClosed: true });
  expect(hist).toMatchObject({ ok: true, value: { closed: expect.objectContaining({ reason: "won" }), replyPath: { sendable: false } } });
  const live = await dbDealsSource.get(her, ids.paid.opp, { includeClosed: false });
  expect(live).toMatchObject({ ok: true, value: { id: ids.paid.opp, dealId: ids.paid.deal, threadId: ids.paid.thread, replyPath: { sendable: true, inbox: "gmail" } } });
});

test("B3: draft + propose — her figure and term words reach the reply skill; one inert proposal; waiting lists it", async () => {
  draftDealReply.mockResolvedValueOnce({ ok: true, fullText: "Hi Sam,\n\nFor two Reels I'd be at $2,000.\n\nBest", threadId: ids.paid.thread, intent: "counter", dealType: "paid_content", channel: "email", voice: "athlete" });
  const got = await dbDealsSource.get(her, ids.paid.opp, { includeClosed: false });
  if (!got.ok) throw new Error("expected the deal");
  const d = await dbDealsSource.draft(her, got.value, { intent: "counter", termAsks: [{ term: "fee", number: 2000 }, { term: "whitelisting", number: 3 }], tone: "friendly" });
  expect(draftDealReply).toHaveBeenCalledWith(expect.objectContaining({
    athleteId: her, dealId: ids.paid.deal, intent: "counter", figure: 2000, style: "friendly",
    termAsks: [{ term: "fee", ask: "a fee of $2,000" }, { term: "whitelisting", ask: "3 months of paid usage" }],
  }));
  // The card's subject follows the real send's rule: the thread's stored subject, as a reply.
  expect(d).toMatchObject({ ok: true, sendable: true, inbox: "gmail", to: "sam@brand.example", subject: "Re: x" });
  if (!d.ok) throw new Error("expected a draft");
  const p = await dbDealsSource.propose(her, got.value, { body: d.body, intent: "counter", subject: d.subject, to: d.to });
  expect(p.bodySha256).toBe(bodySha256(d.body));
  const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, p.pendingActionId));
  expect(row).toMatchObject({ athlete_id: her, deal_id: ids.paid.deal, thread_id: ids.paid.thread, kind: "send_reply", status: "pending" });
  expect(row.payload).toMatchObject({ body: d.body, reply_intent: "counter", source: "mila_chat", drafted_by: "mila" });
  const waiting = await dbDealsSource.waiting(her);
  expect(waiting).toEqual([expect.objectContaining({ id: p.pendingActionId, kind: "reply", opportunityId: ids.paid.opp, brand: "Northpeak Apparel" })]);
  expect(await dbDealsSource.waiting(other)).toEqual([]);
});

test("B4: close — her act through the dispose code, one receipt marked hers, Undo restores", async () => {
  const r = await dbDealsSource.close(her, ids.nofee.opp, "not_interested");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect((await db.select().from(deals).where(eq(deals.id, ids.nofee.deal)))[0].status).toBe("rejected");
  const receipts = await db.select().from(agentActions).where(and(eq(agentActions.deal_id, ids.nofee.deal)));
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ id: r.value.receiptId, reversible: true });
  expect(receipts[0].payload).toMatchObject({ actor: "athlete", athlete_label: "not_interested" });
  expect((await fetch(`${base}/agent-actions/${r.value.receiptId}/undo`, { method: "POST" })).status).toBe(200);
  expect((await db.select().from(deals).where(eq(deals.id, ids.nofee.deal)))[0].status).toBe("detected");
  expect(await dbDealsSource.close(her, ids.theirs.opp, "not_interested")).toEqual({ ok: false, error: "not_yours" });
});

test("B5: bookings — her requests, the buyer as the app shows them, no contact details", async () => {
  const rows = await dbBookingsSource.list(her, "requests");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ buyerLabel: "Jordan P.", phase: "request", receiveCents: 6000 });
  expect(JSON.stringify(rows)).not.toMatch(/jordan@example\.com/);
  expect(await dbBookingsSource.get(her, rows[0].id)).toMatchObject({ id: rows[0].id, buyerLabel: "Jordan P." });
  expect(await dbBookingsSource.get(other, rows[0].id)).toBeNull();
  expect(await dbBookingsSource.list(other, "requests")).toEqual([]);
});

test("B6: an Outlook reply card says what is true — reply in Outlook, reconnect, or Send", async () => {
  const saved = process.env.OUTLOOK_SEND;
  try {
    await seedDeal("outlook", "Lakeside Optics", { amount: 500 });
    const conn = await seedConnection({ athleteId: her, platform: "outlook", email: "owner@outlook.test", scopes: "openid User.Read Mail.Read" });
    await db.update(inboxMessages).set({ platform: "outlook", connected_account_id: conn, external_message_id: "AAMk-b6" } as any)
      .where(eq(inboxMessages.thread_id, ids.outlook.thread));
    const path = async () => {
      const got = await dbDealsSource.get(her, ids.outlook.opp, { includeClosed: false });
      if (!got.ok) throw new Error("expected the deal");
      return got.value.replyPath;
    };

    delete process.env.OUTLOOK_SEND;
    expect(await path()).toMatchObject({ sendable: false, inbox: "outlook", why: "replies to Outlook mail are sent from Outlook for now" });

    process.env.OUTLOOK_SEND = "true";
    expect(await path()).toMatchObject({ sendable: false, inbox: "outlook", why: expect.stringMatching(/reconnect Outlook in Settings to allow it/) });

    await db.update(connectedAccounts).set({ scopes: "openid User.Read Mail.Read Mail.Send" } as any).where(eq(connectedAccounts.id, conn));
    expect(await path()).toMatchObject({ sendable: true, inbox: "outlook", why: null });
  } finally {
    if (saved === undefined) delete process.env.OUTLOOK_SEND; else process.env.OUTLOOK_SEND = saved;
  }
});
