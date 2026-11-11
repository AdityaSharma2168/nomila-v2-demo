/**
 * routes/partnerSeriousOffer.test.ts — the Serious offer end to end against PGlite, with Stripe and email replaced at
 * their boundaries (lib/stripe, lib/notify). No test reaches a provider.
 *
 *   S1 her setting: on by default at $50; only $50/$100/$150/$250; hers only
 *   S2 the hold step: the visitor's own tap, while drafting; manual-capture Checkout of HER amount; never for press, a
 *      switched-off setting, a sent request or another card; one live hold per request
 *   S3 Stripe says it is held → authorized, the confirm email goes (naming the hold); no deal is touched
 *   S4 confirmed → the hold joins her deal ("Verified · $X held"), her 6-day clock starts; "Serious offers" come first on
 *      her board with the badge, and never on another athlete's
 *   S5 the clocks (payments sweep): no reply in 6 days → released + told; a reply stops the 6-day clock (14-day window);
 *      never confirmed → released at 72h + told
 *   S6 decline → released at once, told with the amount
 *   S7 agree → CAPTURED, credited: the first payment asks for that much less (the checkout line says so); settlement pays
 *      her the deal value in two transfers, each within its own charge; a refund of the payment refunds the hold too
 *   S8 a hold above the deal value: the excess is refunded when it is credited
 *   S9 a failed capture: the deal stands, the hold is released, the brand pays in full
 */
process.env.PUBLIC_CARD = "true";
process.env.PARTNER_INTAKE = "true";
process.env.PARTNER_TOKEN_SECRET = "test-partner-secret";
process.env.PUBLIC_BASE_URL = "https://public.example.test";
// sendTemplate only hands a notice to sendEmail when a provider is configured; sendEmail itself is mocked below.
process.env.EMAIL_PROVIDER = "gmail"; // sendEmail is mocked: nothing reaches Google
process.env.PARTNER_DRAFTS_PER_VISITOR_DAY = "1000";
process.env.PARTNER_SENDS_PER_EMAIL_WEEK = "1000";

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
const sent: Array<{ to: string; subject: string; text?: string }> = [];
jest.mock("../lib/notify", () => ({ sendEmail: jest.fn(async (m: any) => { sent.push(m); return { sent: false, skipped: true }; }) }));
jest.mock("../services/brandIntel", () => ({ getOrResearchBrand: jest.fn(async () => null) }));
jest.mock("../lib/safeFetch", () => ({ ...jest.requireActual("../lib/safeFetch"), safeFetch: jest.fn(async () => new Response("", { status: 404 })) }));
const captureFails = { on: false };
jest.mock("../lib/stripe", () => {
  let n = 0;
  const stripe = {
    checkout: { sessions: {
      create: jest.fn(async () => ({ id: `cs_${++n}`, url: `https://checkout.stripe.test/${n}` })),
      retrieve: jest.fn(async (id: string) => ({ id, status: "open", amount_total: 0, url: null, expires_at: 0 })),
      expire: jest.fn(async () => ({})),
    } },
    paymentIntents: {
      retrieve: jest.fn(async (id: string) => ({ id, payment_method: "pm_test", latest_charge: `ch_${id}` })),
      capture: jest.fn(async (id: string) => { if (captureFails.on) throw new Error("authorization expired"); return { id, status: "succeeded", latest_charge: `ch_${id}` }; }),
      cancel: jest.fn(async (id: string) => ({ id, status: "canceled" })),
      create: jest.fn(async () => ({ id: `pi_reauth_${++n}` })),
    },
    transfers: { create: jest.fn(async (a: any) => ({ id: `tr_${++n}`, ...a })), list: jest.fn(async () => ({ data: [] })), createReversal: jest.fn(async () => ({ id: `trr_${++n}` })) },
    refunds: { create: jest.fn(async (a: any) => ({ id: `re_${++n}`, amount: a.amount ?? null })) },
  };
  return { getStripe: () => stripe, isTestMode: () => true, constructWebhookEvent: jest.fn() };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { partnerApiRouter, partnerConfirmRouter } from "./partnerPublic";
import { partnerAthleteRouter } from "./partnerAthlete";
import dealsRouter from "./deals";
import paymentsRouter from "./payments";
import { connectAccounts, deals, partnerRequests, partnerSettings, payments } from "../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { setPublishedCardSource } from "../services/partner/publishedCard";
import { cardFor, fixedCardSource } from "../testUtils/publishedCardDouble";
import { getStripe } from "../lib/stripe";
import { processStripeEvent } from "../services/payments/webhook";
import { runPaymentsCron } from "../services/payments/paymentsCron";
import { settleDealPayment } from "../services/payments/settle";
import { refundDealPayment } from "../services/payments/refund";
import { relayPartnerMessage } from "../services/partner/threads";

const stripe = getStripe() as any;
const DAY = 86_400_000;
let server: Server; let base: string; let a1: string; let a2: string; let evt = 0;
const g = globalThis as any;
const as = (id: string) => { g.__TEST_ATHLETE_ID = id; };

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, redirect: "manual", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text, headers: res.headers };
}
const commercial = (over: Record<string, unknown> = {}) => ({
  kind: "content", website: "brandexample.com", brand_name: "Brand Example", idea: "Three short videos around our new line.",
  timing: { kind: "flexible" }, budget: "5k_15k", contact_name: "Jordan Lee", contact_email: `j${Math.random().toString(36).slice(2, 7)}@brandexample.com`, ...over,
});
const lastText = () => sent[sent.length - 1]?.text ?? "";

async function draft(handle = "avery", over: Record<string, unknown> = {}) {
  const d = await call("POST", `/api/v1/public/cards/${handle}/partner/requests`, commercial(over));
  expect(d.status).toBe(201);
  return d.json as { id: string; draftToken: string; seriousOffer: { available: boolean; amountCents: number | null } };
}

/** The visitor adds the hold and Stripe confirms it (checkout.session.completed). */
async function hold(handle: string, d: { id: string; draftToken: string }) {
  const h = await call("POST", `/api/v1/public/cards/${handle}/partner/requests/${d.id}/hold`, { draft_token: d.draftToken });
  expect(h.status).toBe(200);
  const args = stripe.checkout.sessions.create.mock.calls.at(-1)[0];
  const pi = `pi_hold_${d.id.slice(0, 8)}`;
  await processStripeEvent({ id: `evt_${++evt}`, type: "checkout.session.completed", data: { object: {
    id: "cs_x", metadata: args.metadata, payment_intent: pi, customer: "cus_test", customer_details: { email: "brand@x.example" },
  } } } as any);
  return { args, pi };
}

async function confirmFromEmail() {
  const token = /\/partner\/confirm\/([A-Za-z0-9_-]+)/.exec(lastText())![1];
  const c = await call("POST", `/partner/confirm/${token}`);
  expect(c.status).toBe(303);
}
const holdRow = async (requestId: string) => (await db.select().from(payments).where(eq(payments.partner_request_id, requestId)))[0];
const reqRow = async (id: string) => (await db.select().from(partnerRequests).where(eq(partnerRequests.id, id)))[0];

/** Draft → hold → confirmed: a request on her board with a live hold. */
async function heldOnBoard(handle = "avery", over: Record<string, unknown> = {}) {
  const d = await draft(handle, over);
  const { pi } = await hold(handle, d);
  await confirmFromEmail();
  return { requestId: d.id, pi, request: await reqRow(d.id) };
}

beforeAll(async () => {
  await initTestDb();
  a1 = await seedAthlete("Avery Example");
  a2 = await seedAthlete("Blair Example");
  await db.insert(connectAccounts).values({ athlete_id: a1, stripe_account_id: "acct_a1", account_kind: "classic", details_submitted: true, charges_enabled: true, payouts_enabled: true, transfers_active: true } as any);
  setPublishedCardSource(fixedCardSource([cardFor(a1, "avery"), cardFor(a2, "blair", { firstName: "Blair" })]));
  const app = express();
  app.use(express.json());
  app.use("/api/v1/public/cards", partnerApiRouter);
  app.use("/partner", partnerConfirmRouter);
  app.use("/api/v1/me", partnerAthleteRouter);
  app.use("/api/v1/me", dealsRouter);
  app.use("/api/v1/me", paymentsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { server?.close(); setPublishedCardSource(null); await closeTestDb(); });
beforeEach(() => { sent.length = 0; jest.clearAllMocks(); captureFails.on = false; });

describe("S1 her setting", () => {
  it("on by default at $50; only the four amounts; hers only", async () => {
    as(a2);
    expect((await call("GET", "/api/v1/me/partner/settings")).json).toEqual({ serious_offer_enabled: true, serious_offer_cents: 5000, amounts: [5000, 10000, 15000, 25000] });
    expect((await call("PUT", "/api/v1/me/partner/settings", { serious_offer_cents: 7500 })).status).toBe(400);
    expect((await call("PUT", "/api/v1/me/partner/settings", { serious_offer_enabled: "yes" })).status).toBe(400);
    expect((await call("PUT", "/api/v1/me/partner/settings", { serious_offer_cents: 25000 })).json).toMatchObject({ serious_offer_enabled: true, serious_offer_cents: 25000 });
    as(a1);
    expect((await call("GET", "/api/v1/me/partner/settings")).json.serious_offer_cents).toBe(5000);
    expect(await db.select().from(partnerSettings).where(eq(partnerSettings.athlete_id, a1))).toHaveLength(0);
  });
});

describe("S2 the hold step", () => {
  it("a manual-capture Checkout of HER amount, by the visitor's tap, while drafting", async () => {
    const d = await draft("blair");                                 // Blair chose $250 in S1
    expect(d.seriousOffer).toEqual({ available: true, amountCents: 25000 });
    const r = await call("POST", `/api/v1/public/cards/blair/partner/requests/${d.id}/hold`, { draft_token: d.draftToken });
    expect(r.json).toEqual({ checkoutUrl: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//) });
    const args = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(args).toMatchObject({
      mode: "payment", payment_method_types: ["card"], customer_creation: "always",
      payment_intent_data: { capture_method: "manual", setup_future_usage: "off_session", metadata: { kind: "deposit", partner_request_id: d.id } },
      line_items: [{ price_data: { unit_amount: 25000 } }],
      success_url: `https://public.example.test/partner/hold/${d.id}/done?h=blair`,
    });
    const p = await holdRow(d.id);
    expect(p).toMatchObject({ kind: "deposit", status: "pending", brand_total_cents: 25000, deal_id: null, athlete_id: a2 });
    expect(new Date(p.expires_at!).getTime()).toBe(new Date((await reqRow(d.id)).expires_at).getTime());   // the 72h confirm window
  });

  it("never for press, a switched-off setting, a sent request, a wrong token or another card; one live hold", async () => {
    const pr = await call("POST", "/api/v1/public/cards/avery/partner/requests", { kind: "press", brand_name: "Weekly", topic: "Routines in the off-season.", format: "interview", contact_name: "S", contact_email: "s@weekly.example" });
    expect((await call("POST", `/api/v1/public/cards/avery/partner/requests/${pr.json.id}/hold`, { draft_token: pr.json.draftToken })).status).toBe(404);
    const d = await draft();
    expect((await call("POST", `/api/v1/public/cards/blair/partner/requests/${d.id}/hold`, { draft_token: d.draftToken })).status).toBe(404);
    expect((await call("POST", `/api/v1/public/cards/avery/partner/requests/${d.id}/hold`, { draft_token: "nope" })).status).toBe(404);
    await hold("avery", d);
    expect((await call("POST", `/api/v1/public/cards/avery/partner/requests/${d.id}/hold`, { draft_token: d.draftToken })).status).toBe(404);   // already sent
    const sentDraft = await draft();
    await call("POST", `/api/v1/public/cards/avery/partner/requests/${sentDraft.id}/send`, { draft_token: sentDraft.draftToken });
    expect((await call("POST", `/api/v1/public/cards/avery/partner/requests/${sentDraft.id}/hold`, { draft_token: sentDraft.draftToken })).status).toBe(404);
    as(a1);
    await call("PUT", "/api/v1/me/partner/settings", { serious_offer_enabled: false });
    const off = await draft();
    expect(off.seriousOffer).toEqual({ available: false, amountCents: null });
    expect((await call("POST", `/api/v1/public/cards/avery/partner/requests/${off.id}/hold`, { draft_token: off.draftToken })).status).toBe(404);
    await call("PUT", "/api/v1/me/partner/settings", { serious_offer_enabled: true });
  });
});

describe("S3 held", () => {
  it("authorized, the confirm email names the hold; no deal yet", async () => {
    const d = await draft();
    sent.length = 0;
    await hold("avery", d);
    expect(await holdRow(d.id)).toMatchObject({ status: "authorized", deal_id: null, stripe_payment_intent_id: `pi_hold_${d.id.slice(0, 8)}` });
    expect((await reqRow(d.id)).status).toBe("awaiting_email");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Confirm your request to Avery");
    expect(sent[0].text).toMatch(/temporary hold of \$50 stays a hold/);
    expect(sent[0].text).not.toMatch(/\bbrief\b/i);
  });
});

describe("S4 on her board", () => {
  it("the hold joins her deal, the 6-day clock starts, and Serious offers come first with the badge", async () => {
    const { requestId, request } = await heldOnBoard();
    const p = await holdRow(requestId);
    expect(p.deal_id).toBe(request.deal_id);
    expect(new Date(p.expires_at!).getTime() - Date.now()).toBeGreaterThan(6 * DAY - 60_000);
    expect(new Date(p.expires_at!).getTime() - Date.now()).toBeLessThanOrEqual(6 * DAY);
    expect((await db.select().from(deals).where(eq(deals.id, request.deal_id!)))[0].deposit_status).toBe("held");
    as(a1);
    const board = (await call("GET", "/api/v1/me/opportunities")).json;
    const item = board.seriousOffers.find((i: any) => i.deal_ids.includes(request.deal_id));
    expect(item.partner_request.serious_offer).toMatchObject({ amount_cents: 5000, state: "held", badge: "Verified · $50 held", line: "6 days left to reply before the hold is released", replied: false });
    expect(board.order.indexOf(item.opportunity_id)).toBeLessThan(board.order.length);
    expect(board.order.slice(0, board.seriousOffers.length)).toEqual(board.seriousOffers.map((i: any) => i.opportunity_id));
    for (const sec of ["whatMatters", "needsTermsBatch", "inMotion", "explore", "toVerify"]) expect(board[sec].some((i: any) => i.deal_ids.includes(request.deal_id))).toBe(false);
    as(a2);
    const other = (await call("GET", "/api/v1/me/opportunities")).json;
    expect([...other.seriousOffers, ...other.whatMatters, ...other.explore].some((i: any) => i.deal_ids.includes(request.deal_id))).toBe(false);
    // her request view carries the badge too
    as(a1);
    expect((await call("GET", `/api/v1/me/partner-requests/${requestId}`)).json.request.serious_offer).toMatchObject({ state: "held" });
  });
});

describe("S5 the clocks", () => {
  it("no reply in 6 days → released and the brand told; a reply stops the 6-day clock", async () => {
    const quiet = await heldOnBoard();
    const replied = await heldOnBoard();
    await relayPartnerMessage(await reqRow(replied.requestId), "athlete", "Thanks, let's talk.");
    sent.length = 0;
    const r = await runPaymentsCron(new Date(Date.now() + 6 * DAY + 3_600_000));
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await holdRow(quiet.requestId)).status).toBe("expired");
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(quiet.pi);
    expect(sent.find((s) => s.to === quiet.request.contact_email && /released/.test(s.subject))?.text).toMatch(/didn't reply within 6 days/);
    const kept = await holdRow(replied.requestId);
    // ~day 6: re-authorized off-session on the saved card for the same amount, so it can cover the 14-day window
    expect(kept.status).toBe("reauthorized");
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 5000, capture_method: "manual", off_session: true, metadata: expect.objectContaining({ partner_request_id: replied.requestId }) }), expect.anything());
    expect(new Date(kept.expires_at!).getTime() - new Date(kept.created_at!).getTime()).toBe(14 * DAY);
    as(a1);
    const board = (await call("GET", "/api/v1/me/opportunities")).json;
    expect(board.seriousOffers.find((i: any) => i.deal_ids.includes(replied.request.deal_id)).partner_request.serious_offer.line).toBe("Replied · the hold counts toward the first payment if you agree");
    sent.length = 0;
    await runPaymentsCron(new Date(new Date(kept.created_at!).getTime() + 14 * DAY + 3_600_000));
    expect((await holdRow(replied.requestId)).status).toBe("expired");
    expect(sent.find((s) => s.to === replied.request.contact_email && /released/.test(s.subject))?.text).toMatch(/No deal was agreed/);
  });

  it("never confirmed → released at 72h, told, and nothing reached her", async () => {
    const d = await draft();
    await hold("avery", d);
    sent.length = 0;
    await runPaymentsCron(new Date(Date.now() + 73 * 3_600_000));
    expect((await holdRow(d.id)).status).toBe("expired");
    const to = (await reqRow(d.id)).contact_email;
    expect(sent.find((s) => s.to === to && /released/.test(s.subject))?.text).toMatch(/not confirmed within 72 hours/);
    expect((await reqRow(d.id)).deal_id).toBeNull();
  });
});

describe("S6 decline", () => {
  it("released at once and the brand told with the amount", async () => {
    const { requestId, pi, request } = await heldOnBoard();
    sent.length = 0;
    as(a1);
    expect((await call("POST", `/api/v1/me/partner-requests/${requestId}/decline`)).json).toEqual({ ok: true, outcome: "declined", releasedCents: 5000 });
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(pi);
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect((await holdRow(requestId)).status).toBe("released");
    expect((await db.select().from(deals).where(eq(deals.id, request.deal_id!)))[0]).toMatchObject({ status: "rejected", deposit_status: "released" });
    expect(sent[0].text).toMatch(/Declined: your hold of \$50 was released/);
    // her decision is hers only
    as(a2);
    expect((await call("POST", `/api/v1/me/partner-requests/${requestId}/agree`)).status).toBe(404);
  });
});

describe("S7 agree → captured → credited → settled → refundable", () => {
  it("the first payment asks for the hold less; she is paid the deal value from both charges; a refund covers both", async () => {
    const { requestId, pi, request } = await heldOnBoard();
    const dealId = request.deal_id!;
    sent.length = 0;
    as(a1);
    expect((await call("POST", `/api/v1/me/partner-requests/${requestId}/agree`)).json).toEqual({ ok: true, outcome: "agreed", creditedCents: 5000 });
    expect(stripe.paymentIntents.capture).toHaveBeenCalledWith(pi, {}, { idempotencyKey: expect.stringMatching(/^serious_capture_/) });
    const h = await holdRow(requestId);
    expect(h).toMatchObject({ status: "funded", stripe_charge_id: `ch_${pi}` });
    expect((await db.select().from(deals).where(eq(deals.id, dealId)))[0]).toMatchObject({ status: "accepted", deposit_status: "credited" });
    expect(sent[0].text).toMatch(/charged \$50, the hold you placed\. It counts toward your first payment/);

    // her first payment request on the agreed $1,000 deal
    await db.update(deals).set({ amount: "1000" }).where(eq(deals.id, dealId));
    const pr = await call("POST", `/api/v1/me/deals/${dealId}/request-payment`, {});
    expect(pr.status).toBe(200);
    expect(pr.json.quote.creditCents).toBe(5000);
    const [dp] = await db.select().from(payments).where(and(eq(payments.deal_id, dealId), eq(payments.kind, "deal_payment")));
    expect(dp).toMatchObject({ credit_cents: 5000, credit_payment_id: h.id, deal_value_cents: 100000 });
    expect(dp.brand_total_cents).toBe(pr.json.quote.brandTotalCents);
    expect(dp.brand_total_cents! + 5000).toBe(100000 + dp.commission_cents! + dp.processing_fee_cents!);
    // the brand's checkout says so
    const pay = await (await import("../services/payments/escrow")).createDealCheckoutSession(dp.id);
    expect("url" in pay).toBe(true);
    const lines = stripe.checkout.sessions.create.mock.calls.at(-1)[0].line_items;
    expect(lines[0].price_data).toMatchObject({ unit_amount: 95000, product_data: { name: expect.stringMatching(/less your \$50\.00 hold, already paid/) } });
    expect(lines.reduce((n: number, l: any) => n + l.price_data.unit_amount, 0)).toBe(dp.brand_total_cents);
    // a second request (re-quote) keeps the same credit, never a second one
    expect((await call("POST", `/api/v1/me/deals/${dealId}/request-payment`, {})).json.quote.creditCents).toBe(5000);

    // funded + released: two transfers, each within its own charge, summing to the deal value
    await db.update(payments).set({ status: "funded", stripe_payment_intent_id: "pi_deal", stripe_charge_id: "ch_deal" }).where(eq(payments.id, dp.id));
    expect(await settleDealPayment(dp.id)).toBe(true);
    const transfers = stripe.transfers.create.mock.calls.map((c: any[]) => c[0]);
    expect(transfers).toEqual([
      expect.objectContaining({ amount: 95000, source_transaction: "ch_deal", destination: "acct_a1" }),
      expect.objectContaining({ amount: 5000, source_transaction: `ch_${pi}`, destination: "acct_a1", metadata: expect.objectContaining({ kind: "deal_settlement_credit" }) }),
    ]);
    expect(await holdRow(requestId)).toMatchObject({ status: "settled" });

    // an admin refund of the payment refunds the hold too (both transfers reversed first)
    await refundDealPayment({ paymentId: dp.id, actor: "admin", reason: "test" });
    expect(stripe.transfers.createReversal).toHaveBeenCalledTimes(2);
    expect(stripe.transfers.createReversal.mock.calls[0][1]).toMatchObject({ amount: 95000 });
    expect(stripe.refunds.create.mock.calls.map((c: any[]) => c[0].payment_intent)).toEqual(["pi_deal", pi]);
    expect(await holdRow(requestId)).toMatchObject({ status: "refunded" });
  });
});

describe("S8 a hold above the deal value", () => {
  it("credits the deal value and refunds the rest", async () => {
    as(a2);
    const { requestId, pi, request } = await heldOnBoard("blair");     // $250 hold
    await call("POST", `/api/v1/me/partner-requests/${requestId}/agree`);
    await db.update(deals).set({ amount: "100" }).where(eq(deals.id, request.deal_id!));
    const pr = await call("POST", `/api/v1/me/deals/${request.deal_id}/request-payment`, {});
    expect(pr.json.quote.creditCents).toBe(10000);
    expect(stripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: pi, amount: 15000 }), { idempotencyKey: expect.stringMatching(/^serious_excess_/) });
    expect((await holdRow(requestId)).refunded_cents).toBe(15000);
    await call("POST", `/api/v1/me/deals/${request.deal_id}/request-payment`, {});
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);           // never twice
  });
});

describe("S9 a failed capture", () => {
  it("the deal stands, the hold is released, the brand pays in full", async () => {
    const { requestId, pi, request } = await heldOnBoard();
    captureFails.on = true;
    as(a1);
    expect((await call("POST", `/api/v1/me/partner-requests/${requestId}/agree`)).json).toEqual({ ok: true, outcome: "agreed", creditedCents: null });
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(pi);
    expect((await holdRow(requestId)).status).toBe("released");
    await db.update(deals).set({ amount: "500" }).where(eq(deals.id, request.deal_id!));
    expect((await call("POST", `/api/v1/me/deals/${request.deal_id}/request-payment`, {})).json.quote.creditCents).toBe(0);
  });
});
