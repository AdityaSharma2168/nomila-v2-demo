/**
 * refunds.integration.test.ts — refunds, chargebacks and transfer reversals (payments PR 4), against PGlite with
 * Stripe and the email channel fully mocked (no provider calls).
 *
 *  - Tap-gated refund: the athlete refunds her own HELD payment (tenancy-checked); after release only an admin
 *    can, and the transfer is reversed before the brand is refunded. Idempotent; receipts recorded + emailed.
 *  - Webhooks record what Stripe did: charge.refunded (full / partial / duplicate), charge.dispute.created /
 *    updated / closed (won, lost, with the brand's delivery dispute open), transfer.reversed.
 *  - A chargeback blocks release and refunds.
 *  - The de-identified ledger (#803) carries refunds and chargebacks.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.header("x-test-athlete");
    if (!id) { res.status(401).json({ error: "unauthorized" }); return; }
    req.athleteId = id; next();
  },
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.header("x-test-admin") !== "1") { res.status(403).json({ error: "forbidden" }); return; }
    next();
  },
}));
jest.mock("../../lib/stripe", () => {
  let n = 0;
  const stripe = {
    checkout:  { sessions: { create: jest.fn(async () => ({ id: "cs_test", url: "https://checkout.stripe.test/s", status: "open" })) } },
    transfers: {
      create:         jest.fn(async () => ({ id: `tr_${++n}` })),
      list:           jest.fn(async () => ({ data: [] })),
      createReversal: jest.fn(async (id: string) => ({ id: `trr_${id}` })),
    },
    refunds:   { create: jest.fn(async (p: any) => ({ id: `re_${++n}`, amount: 11_359, payment_intent: p.payment_intent })) },
    paymentIntents: { retrieve: jest.fn(async (id: string) => ({ id, latest_charge: `ch_${id}` })) },
    accounts: { retrieve: jest.fn(async (id: string) => ({ id, payouts_enabled: true, capabilities: { transfers: "active" } })) },
  };
  return { getStripe: () => stripe, isTestMode: () => true, constructWebhookEvent: jest.fn() };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { connectAccounts, deals, payments } from "../../../shared/schema";
import { initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { getStripe } from "../../lib/stripe";
import { sendEmail } from "../../lib/notify";
import { requestDealPayment, handleCheckoutSessionCompleted } from "./escrow";
import { markDeliveredByAthlete, confirmDeliveryByBrand, disputeDeliveryByBrand } from "./settle";
import { refundDealPayment, resolveDeliveryDispute, refundDuplicateCharge } from "./refund";
import { processStripeEvent } from "./webhook";
import { runPaymentsCron } from "./paymentsCron";
import { keepDeidentifiedFinancialRecords } from "../../lib/privacy/financialRecords";
import paymentsRouter from "../../routes/payments";
import adminPaymentsRouter from "../../routes/adminPayments";

const stripe = getStripe() as any;
const emailMock = sendEmail as jest.Mock;
let seq = 0;
const evt = (type: string, object: Record<string, unknown>): any => ({ id: `evt_rf_${++seq}`, type, data: { object } });
const brandToken = (): string => decodeURIComponent(/[?&]t=([^\s&]+)/.exec(emailMock.mock.calls.filter((c) => /confirm/.test(c[0].text)).at(-1)![0].text)![1]);

async function seedFunded() {
  const athleteId = await seedAthlete("Refund Athlete");
  await db.insert(connectAccounts).values({
    athlete_id: athleteId, stripe_account_id: `acct_r${++seq}`, account_kind: "classic",
    details_submitted: true, charges_enabled: true, payouts_enabled: true, transfers_active: true,
  } as any);
  const [deal] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Acme", amount: "100", status: "accepted" } as any)
    .returning({ id: deals.id });
  const req = await requestDealPayment(deal.id, athleteId, "card");
  const pi = `pi_r${seq}`;
  await handleCheckoutSessionCompleted({
    metadata: { kind: "deal_payment", payment_id: req.paymentId, deal_id: deal.id },
    payment_intent: pi, payment_status: "paid", customer_details: { email: "brand@acme.test" },
  } as any);
  await db.update(payments).set({ stripe_charge_id: `ch_${pi}` }).where(eq(payments.id, req.paymentId));
  return { athleteId, dealId: deal.id, paymentId: req.paymentId, pi, charge: `ch_${pi}` };
}
async function seedSettled() {
  const s = await seedFunded();
  await markDeliveredByAthlete(s.dealId, s.athleteId);
  await confirmDeliveryByBrand(s.paymentId, brandToken());
  return s;
}
const row = async (id: string) => (await db.select().from(payments).where(eq(payments.id, id)))[0];
const dealStatus = async (id: string) => (await db.select().from(deals).where(eq(deals.id, id)))[0].payment_status;

let server: Server;
let base = "";
beforeAll(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", paymentsRouter);
  app.use("/api/v1/admin/payments", adminPaymentsRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); await closeTestDb(); });
beforeEach(() => { jest.clearAllMocks(); });

describe("tap-gated refund", () => {
  test("the athlete refunds her held payment: full amount, idempotency key, receipt recorded and emailed to the brand", async () => {
    const s = await seedFunded();
    const r = await fetch(`${base}/api/v1/me/deals/${s.dealId}/refund`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-test-athlete": s.athleteId }, body: JSON.stringify({ reason: "brand cancelled" }),
    });
    expect(r.status).toBe(200);
    const { receipt } = await r.json();
    expect(receipt).toMatchObject({ status: "refunded", refundedCents: 11_359, requestedBy: "athlete", reason: "brand cancelled", transferReversalId: null });

    const [params, opts] = stripe.refunds.create.mock.calls[0];
    expect(params.payment_intent).toBe(s.pi);
    expect(opts).toEqual({ idempotencyKey: `refund_${s.paymentId}` });
    expect(stripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(await dealStatus(s.dealId)).toBe("refunded");
    expect(emailMock.mock.calls.at(-1)![0]).toMatchObject({ to: "brand@acme.test", subject: expect.stringContaining("Refund") });

    // Idempotent: a second tap returns the receipt, no second Stripe refund.
    const again = await refundDealPayment({ paymentId: s.paymentId, actor: "athlete", athleteId: s.athleteId });
    expect(again.refundId).toBe(receipt.refundId);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);

    // The receipt is readable on her payment.
    const view = await (await fetch(`${base}/api/v1/me/deals/${s.dealId}/payment`, { headers: { "x-test-athlete": s.athleteId } })).json();
    expect(view.refund).toMatchObject({ refundedCents: 11_359, status: "refunded" });
  });

  test("tenancy: another athlete can neither read nor refund her payment", async () => {
    const s = await seedFunded();
    const other = await seedAthlete("Other");
    const h = { "Content-Type": "application/json", "x-test-athlete": other };
    expect((await fetch(`${base}/api/v1/me/deals/${s.dealId}/refund`, { method: "POST", headers: h })).status).toBe(404);
    expect((await fetch(`${base}/api/v1/me/deals/${s.dealId}/payment`, { headers: h })).status).toBe(404);
    await expect(refundDealPayment({ paymentId: s.paymentId, actor: "athlete", athleteId: other })).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND" });
    await expect(refundDealPayment({ paymentId: s.paymentId, actor: "athlete" })).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect((await row(s.paymentId)).status).toBe("funded");
  });

  test("after release the athlete can't refund; an admin can — the transfer is reversed first", async () => {
    const s = await seedSettled();
    const p0 = await row(s.paymentId);
    expect(p0.status).toBe("settled");

    const r = await fetch(`${base}/api/v1/me/deals/${s.dealId}/refund`, { method: "POST", headers: { "x-test-athlete": s.athleteId } });
    expect(r.status).toBe(409);
    expect(stripe.refunds.create).not.toHaveBeenCalled();

    expect((await fetch(`${base}/api/v1/admin/payments/${s.paymentId}/refund`, { method: "POST" })).status).toBe(403);
    const a = await fetch(`${base}/api/v1/admin/payments/${s.paymentId}/refund`, { method: "POST", headers: { "x-test-admin": "1", "Content-Type": "application/json" }, body: "{}" });
    expect(a.status).toBe(200);
    const { receipt } = await a.json();
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith(p0.stripe_transfer_id, expect.objectContaining({ amount: 10_000 }), { idempotencyKey: `reverse_${s.paymentId}` });
    expect(stripe.transfers.createReversal.mock.invocationCallOrder[0]).toBeLessThan(stripe.refunds.create.mock.invocationCallOrder[0]);
    expect(receipt).toMatchObject({ status: "refunded", requestedBy: "admin", transferReversalId: `trr_${p0.stripe_transfer_id}` });
  });

  test("a failed reversal refunds nothing", async () => {
    const s = await seedSettled();
    stripe.transfers.createReversal.mockRejectedValueOnce(new Error("insufficient funds"));
    await expect(refundDealPayment({ paymentId: s.paymentId, actor: "admin" })).rejects.toThrow("insufficient funds");
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect((await row(s.paymentId)).status).toBe("settled");
  });
});

describe("chargebacks (charge.dispute.*)", () => {
  test("created → disputed: release and refund blocked; won → funded again; the sweep then releases", async () => {
    const s = await seedFunded();
    await markDeliveredByAthlete(s.dealId, s.athleteId);
    await processStripeEvent(evt("charge.dispute.created", { id: "dp_1", charge: s.charge, payment_intent: s.pi, status: "needs_response", reason: "fraudulent", amount: 11_359 }));
    let p = await row(s.paymentId);
    expect(p).toMatchObject({ status: "disputed", stripe_dispute_id: "dp_1", dispute_status: "needs_response" });
    expect(await dealStatus(s.dealId)).toBe("disputed");

    await db.update(payments).set({ delivery_window_ends_at: new Date(Date.now() - 1000) }).where(eq(payments.id, s.paymentId));
    await runPaymentsCron();
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    await expect(refundDealPayment({ paymentId: s.paymentId, actor: "athlete", athleteId: s.athleteId })).rejects.toMatchObject({ code: "CHARGEBACK_OPEN" });

    await processStripeEvent(evt("charge.dispute.updated", { id: "dp_1", status: "under_review" }));
    expect((await row(s.paymentId)).dispute_status).toBe("under_review");

    await processStripeEvent(evt("charge.dispute.closed", { id: "dp_1", status: "won" }));
    p = await row(s.paymentId);
    expect(p.status).toBe("funded");
    expect(await dealStatus(s.dealId)).toBe("delivered_pending_confirmation");
    await runPaymentsCron();
    expect((await row(s.paymentId)).status).toBe("settled");
  });

  test("lost → charged_back (terminal); after release it alerts for an admin reversal", async () => {
    const s = await seedSettled();
    await processStripeEvent(evt("charge.dispute.created", { id: "dp_2", charge: s.charge, status: "needs_response", amount: 11_359 }));
    await processStripeEvent(evt("charge.dispute.closed", { id: "dp_2", status: "lost" }));
    const p = await row(s.paymentId);
    expect(p.status).toBe("charged_back");
    expect(await dealStatus(s.dealId)).toBe("refunded");

    const r = await fetch(`${base}/api/v1/admin/payments/${s.paymentId}/reverse-transfer`, { method: "POST", headers: { "x-test-admin": "1" } });
    expect(await r.json()).toEqual({ reversalId: `trr_${p.stripe_transfer_id}` });
  });

  test("won while the brand's delivery dispute is open → stays disputed", async () => {
    const s = await seedFunded();
    await markDeliveredByAthlete(s.dealId, s.athleteId);
    await disputeDeliveryByBrand(s.paymentId, brandToken());
    await processStripeEvent(evt("charge.dispute.created", { id: "dp_3", charge: s.charge, status: "needs_response" }));
    await processStripeEvent(evt("charge.dispute.closed", { id: "dp_3", status: "won" }));
    expect((await row(s.paymentId)).status).toBe("disputed");
  });
});

describe("refund + reversal webhooks record what Stripe did", () => {
  test("charge.refunded: partial records the amount only; full (dashboard) marks refunded by stripe", async () => {
    const s = await seedFunded();
    await processStripeEvent(evt("charge.refunded", { id: s.charge, payment_intent: s.pi, amount: 11_359, amount_refunded: 1_000, refunds: { data: [{ id: "re_part" }] } }));
    let p = await row(s.paymentId);
    expect(p).toMatchObject({ status: "funded", refunded_cents: 1_000, refund_requested_by: "stripe", stripe_refund_id: "re_part" });

    await processStripeEvent(evt("charge.refunded", { id: s.charge, payment_intent: s.pi, amount: 11_359, amount_refunded: 11_359, refunds: { data: [{ id: "re_full" }] } }));
    p = await row(s.paymentId);
    expect(p).toMatchObject({ status: "refunded", refunded_cents: 11_359 });
    expect(await dealStatus(s.dealId)).toBe("refunded");
  });

  test("transfer.reversed from the dashboard is recorded", async () => {
    const s = await seedSettled();
    const p0 = await row(s.paymentId);
    await processStripeEvent(evt("transfer.reversed", { id: p0.stripe_transfer_id, amount_reversed: 10_000, reversals: { data: [{ id: "trr_dash" }] } }));
    expect((await row(s.paymentId)).stripe_transfer_reversal_id).toBe("trr_dash");
  });

  test("a flagged duplicate charge: admin refunds it; its charge.refunded marks it refunded; the payment is untouched", async () => {
    const s = await seedFunded();
    await processStripeEvent(evt("payment_intent.succeeded", { id: "pi_dup", latest_charge: "ch_dup", metadata: { kind: "deal_payment", payment_id: s.paymentId, deal_id: s.dealId } }));
    expect(((await row(s.paymentId)).metadata as any).duplicate_charges[0]).toMatchObject({ payment_intent: "pi_dup", refund_status: "needs_refund" });

    const r = await refundDuplicateCharge(s.paymentId, "pi_dup");
    expect(stripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: "pi_dup", reason: "duplicate" }), { idempotencyKey: "refund_dup_pi_dup" });
    await processStripeEvent(evt("charge.refunded", { id: "ch_dup", payment_intent: "pi_dup", amount: 11_359, amount_refunded: 11_359 }));
    const p = await row(s.paymentId);
    expect(p.status).toBe("funded");
    expect((p.metadata as any).duplicate_charges[0]).toMatchObject({ refund_status: "refunded", refund_id: r.refundId });
    await expect(refundDuplicateCharge(s.paymentId, s.pi)).rejects.toMatchObject({ code: "DUPLICATE_NOT_FOUND" });
  });
});

describe("admin resolves the brand's delivery dispute", () => {
  test("release → settled; refund → refunded", async () => {
    const a = await seedFunded();
    await markDeliveredByAthlete(a.dealId, a.athleteId);
    await disputeDeliveryByBrand(a.paymentId, brandToken());
    expect(await resolveDeliveryDispute(a.paymentId, "release")).toEqual({ status: "settled" });
    expect((await row(a.paymentId)).metadata).not.toHaveProperty("delivery_disputed_at");

    const b = await seedFunded();
    await markDeliveredByAthlete(b.dealId, b.athleteId);
    await disputeDeliveryByBrand(b.paymentId, brandToken());
    const r = await fetch(`${base}/api/v1/admin/payments/${b.paymentId}/resolve-dispute`, {
      method: "POST", headers: { "x-test-admin": "1", "Content-Type": "application/json" }, body: JSON.stringify({ outcome: "refund" }),
    });
    expect(await r.json()).toEqual({ status: "refunded" });
  });
});

describe("the de-identified ledger (#803) stays consistent", () => {
  test("a refunded payment and a charged-back payment leave ledger rows with refund / reversal / dispute ids", async () => {
    const s = await seedSettled();
    await refundDealPayment({ paymentId: s.paymentId, actor: "admin" });
    const c = await seedFunded();
    await processStripeEvent(evt("charge.dispute.created", { id: "dp_led", charge: c.charge, status: "needs_response" }));
    await processStripeEvent(evt("charge.dispute.closed", { id: "dp_led", status: "lost" }));

    for (const athleteId of [s.athleteId, c.athleteId]) await keepDeidentifiedFinancialRecords(db as any, athleteId);
    const ledger = (await db.execute(sql`SELECT status, refunded_cents, stripe_refund_id, stripe_transfer_reversal_id, stripe_dispute_id
      FROM financial_ledger_records WHERE stripe_payment_intent_id IN (${s.pi}, ${c.pi}) ORDER BY status`) as any).rows;
    expect(ledger).toEqual([
      { status: "charged_back", refunded_cents: null, stripe_refund_id: null, stripe_transfer_reversal_id: null, stripe_dispute_id: "dp_led" },
      { status: "refunded", refunded_cents: 11_359, stripe_refund_id: expect.stringMatching(/^re_/), stripe_transfer_reversal_id: expect.stringMatching(/^trr_/), stripe_dispute_id: null },
    ]);
  });
});
