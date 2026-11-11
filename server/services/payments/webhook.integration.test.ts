/**
 * webhook.integration.test.ts — the Stripe webhook ledger + funding correctness, against a
 * real in-memory Postgres (PGlite) with the Stripe seam fully mocked (no provider calls).
 *
 *  - A handler failure leaves the event unprocessed, so Stripe's retry REPROCESSES it
 *    (it used to be acknowledged as a duplicate and silently lost).
 *  - A declined-then-succeeded Checkout ends `funded`, never `failed`.
 *  - The charge id is captured whatever order the funding events arrive in, and settle
 *    fetches it from Stripe when no event carried it — the transfer is always sourced.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));
jest.mock("../../lib/stripe", () => {
  const stripe = {
    checkout:  { sessions: { create: jest.fn(async () => ({ id: "cs_test", url: "https://checkout.stripe.test/s" })) } },
    transfers: { create: jest.fn(async () => ({ id: "tr_test_1" })), list: jest.fn(async () => ({ data: [] })) },
    paymentIntents: { retrieve: jest.fn(async (id: string) => ({ id, latest_charge: "ch_fetched" })) },
  };
  return { getStripe: () => stripe, isTestMode: () => true, constructWebhookEvent: jest.fn() };
});
jest.mock("./connect", () => {
  const actual = jest.requireActual("./connect");
  return { ...actual, syncConnectAccountFromStripe: jest.fn(async () => {}) };
});

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { deals, payments, paymentEvents, connectAccounts } from "../../../shared/schema";
import { initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { getStripe } from "../../lib/stripe";
import { syncConnectAccountFromStripe } from "./connect";
import { processStripeEvent } from "./webhook";
import { requestDealPayment } from "./escrow";
import { markDeliveredByAthlete, settleDealPayment } from "./settle";

const stripe = getStripe() as any;
const syncMock = syncConnectAccountFromStripe as jest.Mock;
let seq = 0;

function evt(type: string, object: Record<string, unknown>): any {
  return { id: `evt_${++seq}_${Date.now()}`, type, data: { object } };
}

async function seedPaymentRow(): Promise<{ athleteId: string; dealId: string; paymentId: string }> {
  const athleteId = await seedAthlete("Webhook Athlete");
  await db.insert(connectAccounts).values({
    athlete_id: athleteId, stripe_account_id: `acct_${athleteId}`, account_kind: "classic",
    details_submitted: true, charges_enabled: true, payouts_enabled: true, transfers_active: true,
  } as any);
  const [deal] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Acme", amount: "100", status: "accepted" } as any)
    .returning({ id: deals.id });
  const req = await requestDealPayment(deal.id, athleteId, "card");
  return { athleteId, dealId: deal.id, paymentId: req.paymentId };
}

async function row(paymentId: string) {
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentId));
  return p;
}

const meta = (paymentId: string, dealId: string) => ({ kind: "deal_payment", payment_id: paymentId, deal_id: dealId });

beforeAll(() => initTestDb());
afterAll(() => closeTestDb());
beforeEach(() => { jest.clearAllMocks(); });

describe("webhook ledger: claim only counts once the handler succeeded", () => {
  test("a handler failure is reprocessed on Stripe's retry, then deduped once processed", async () => {
    const event = evt("account.updated", { id: "acct_x" });
    syncMock.mockRejectedValueOnce(new Error("db blip"));

    await expect(processStripeEvent(event)).rejects.toThrow("db blip");
    let [e] = await db.select().from(paymentEvents).where(eq(paymentEvents.id, event.id));
    expect(e.processed_at).toBeNull();

    // Stripe redelivers the same event id → handled again (not "duplicate").
    await expect(processStripeEvent(event)).resolves.toEqual({ duplicate: false });
    expect(syncMock).toHaveBeenCalledTimes(2);
    [e] = await db.select().from(paymentEvents).where(eq(paymentEvents.id, event.id));
    expect(e.processed_at).not.toBeNull();

    // A third delivery after success is the real duplicate.
    await expect(processStripeEvent(event)).resolves.toEqual({ duplicate: true });
    expect(syncMock).toHaveBeenCalledTimes(2);
  });
});

describe("funding correctness", () => {
  test("declined-then-succeeded inside one Checkout ends funded, not failed", async () => {
    const { dealId, paymentId } = await seedPaymentRow();

    await processStripeEvent(evt("payment_intent.payment_failed", {
      id: "pi_retry", metadata: meta(paymentId, dealId), last_payment_error: { message: "card_declined" },
    }));
    expect((await row(paymentId)).status).toBe("failed");

    await processStripeEvent(evt("checkout.session.completed", {
      metadata: meta(paymentId, dealId), payment_intent: "pi_retry", payment_status: "paid",
      customer_details: { email: "brand@acme.test" },
    }));
    const p = await row(paymentId);
    expect(p.status).toBe("funded");
    expect(p.failure_reason).toBeNull();
    const [d] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(d.payment_status).toBe("funded");

    // A late failure for an earlier attempt never regresses a funded row.
    await processStripeEvent(evt("payment_intent.payment_failed", { id: "pi_retry", metadata: meta(paymentId, dealId) }));
    expect((await row(paymentId)).status).toBe("funded");
  });

  test("charge id is recorded even when payment_intent.succeeded arrives after funding", async () => {
    const { dealId, paymentId } = await seedPaymentRow();
    await processStripeEvent(evt("checkout.session.completed", {
      metadata: meta(paymentId, dealId), payment_intent: "pi_late", payment_status: "paid", customer_details: { email: "b@acme.test" },
    }));
    expect((await row(paymentId)).stripe_charge_id).toBeNull();

    await processStripeEvent(evt("payment_intent.succeeded", { id: "pi_late", latest_charge: "ch_late", metadata: meta(paymentId, dealId) }));
    const p = await row(paymentId);
    expect(p.status).toBe("funded");
    expect(p.stripe_charge_id).toBe("ch_late");
  });

  test("charge.succeeded records the charge id by PaymentIntent (charges carry no PI metadata)", async () => {
    const { dealId, paymentId } = await seedPaymentRow();
    await processStripeEvent(evt("checkout.session.completed", {
      metadata: meta(paymentId, dealId), payment_intent: "pi_chg", payment_status: "paid", customer_details: { email: "b@acme.test" },
    }));
    await processStripeEvent(evt("charge.succeeded", { id: "ch_from_charge", status: "succeeded", payment_intent: "pi_chg", metadata: {} }));
    expect((await row(paymentId)).stripe_charge_id).toBe("ch_from_charge");

    // A charge on a different PaymentIntent never overwrites it.
    await processStripeEvent(evt("payment_intent.succeeded", { id: "pi_other", latest_charge: "ch_other", metadata: meta(paymentId, dealId) }));
    expect((await row(paymentId)).stripe_charge_id).toBe("ch_from_charge");
  });

  test("payment_intent.succeeded first, checkout.session.completed second → funded once, email backfilled", async () => {
    const { dealId, paymentId } = await seedPaymentRow();
    await processStripeEvent(evt("payment_intent.succeeded", { id: "pi_first", latest_charge: "ch_first", metadata: meta(paymentId, dealId) }));
    await processStripeEvent(evt("checkout.session.completed", {
      metadata: meta(paymentId, dealId), payment_intent: "pi_first", payment_status: "paid", customer_details: { email: "late@acme.test" },
    }));
    const p = await row(paymentId);
    expect(p.status).toBe("funded");
    expect(p.stripe_charge_id).toBe("ch_first");
    expect(p.brand_email).toBe("late@acme.test");
  });

  test("bank rail: async_payment_failed marks failed; async_payment_succeeded funds", async () => {
    const { dealId, paymentId } = await seedPaymentRow();
    await processStripeEvent(evt("checkout.session.completed", {
      metadata: meta(paymentId, dealId), payment_intent: "pi_ach", payment_status: "unpaid", customer_details: { email: "b@acme.test" },
    }));
    expect((await row(paymentId)).status).toBe("pending");
    await processStripeEvent(evt("checkout.session.async_payment_failed", { metadata: meta(paymentId, dealId), payment_intent: "pi_ach" }));
    expect((await row(paymentId)).status).toBe("failed");
    await processStripeEvent(evt("checkout.session.async_payment_succeeded", {
      metadata: meta(paymentId, dealId), payment_intent: "pi_ach", payment_status: "paid", customer_details: { email: "b@acme.test" },
    }));
    expect((await row(paymentId)).status).toBe("funded");
  });

  test("settle fetches a missing charge id from Stripe and always sources the transfer from it", async () => {
    const { athleteId, dealId, paymentId } = await seedPaymentRow();
    await processStripeEvent(evt("checkout.session.completed", {
      metadata: meta(paymentId, dealId), payment_intent: "pi_settle", payment_status: "paid", customer_details: { email: "b@acme.test" },
    }));
    await markDeliveredByAthlete(dealId, athleteId);
    await db.update(payments).set({ brand_confirmed_at: new Date() }).where(eq(payments.id, paymentId));

    expect(await settleDealPayment(paymentId)).toBe(true);
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_settle");
    expect(stripe.transfers.create.mock.calls[0][0].source_transaction).toBe("ch_fetched");
    expect((await row(paymentId)).stripe_charge_id).toBe("ch_fetched");
  });
});
