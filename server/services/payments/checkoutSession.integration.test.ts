/**
 * checkoutSession.integration.test.ts — ONE live Checkout session per payment (payments PR 2), against PGlite
 * with the Stripe seam fully mocked (an in-memory session store; no provider calls).
 *
 *  - Every pay-link visit (including concurrent tabs) reuses the one open session.
 *  - A completed session means "processing" — never a second Checkout.
 *  - A re-quote expires the old-amount session; a session about to lapse is replaced.
 *  - Sessions carry an explicit expires_at, stored on the row.
 *  - A second successful payment on a funded row is flagged for refund, never silently lost.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/stripe", () => {
  const sessions = new Map<string, any>();
  let n = 0;
  const stripe = {
    __sessions: sessions,
    checkout: {
      sessions: {
        create: jest.fn(async (params: any) => {
          const id = `cs_${++n}`;
          const amount = params.line_items.reduce((a: number, li: any) => a + li.price_data.unit_amount * li.quantity, 0);
          const s = { id, url: `https://checkout.stripe.test/${id}`, status: "open", amount_total: amount, expires_at: params.expires_at };
          sessions.set(id, s);
          return s;
        }),
        retrieve: jest.fn(async (id: string) => ({ ...sessions.get(id) })),
        expire:   jest.fn(async (id: string) => { const s = sessions.get(id); s.status = "expired"; return { ...s }; }),
      },
    },
    transfers: { create: jest.fn(async () => ({ id: "tr_test_1" })) },
    paymentIntents: { retrieve: jest.fn(async (id: string) => ({ id, latest_charge: "ch_fetched" })) },
  };
  return { getStripe: () => stripe, isTestMode: () => true, constructWebhookEvent: jest.fn() };
});

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { deals, payments } from "../../../shared/schema";
import { initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { getStripe } from "../../lib/stripe";
import { processStripeEvent } from "./webhook";
import { requestDealPayment, createDealCheckoutSession } from "./escrow";

const stripe = getStripe() as any;
let seq = 0;
const evt = (type: string, object: Record<string, unknown>): any => ({ id: `evt_cs_${++seq}`, type, data: { object } });

async function seed(amount = "100"): Promise<{ athleteId: string; dealId: string; paymentId: string }> {
  const athleteId = await seedAthlete("Checkout Athlete");
  const [deal] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Acme", amount, status: "accepted" } as any)
    .returning({ id: deals.id });
  const req = await requestDealPayment(deal.id, athleteId, "card");
  return { athleteId, dealId: deal.id, paymentId: req.paymentId };
}
const row = async (id: string) => (await db.select().from(payments).where(eq(payments.id, id)))[0];

beforeAll(() => initTestDb());
afterAll(() => closeTestDb());
beforeEach(() => { jest.clearAllMocks(); });

describe("one Checkout session per payment", () => {
  test("repeat visits reuse the open session; it carries an explicit expires_at stored on the row", async () => {
    const { paymentId } = await seed();
    const a = await createDealCheckoutSession(paymentId);
    const b = await createDealCheckoutSession(paymentId);
    expect(a).toMatchObject({ reused: false });
    expect(b).toMatchObject({ reused: true });
    expect((a as any).url).toBe((b as any).url);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);

    const params = stripe.checkout.sessions.create.mock.calls[0][0];
    const hours = (params.expires_at * 1000 - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(22.9);
    expect(hours).toBeLessThanOrEqual(23);
    expect((await row(paymentId)).checkout_expires_at?.getTime()).toBe(params.expires_at * 1000);
  });

  test("concurrent tabs never mint two sessions", async () => {
    const { paymentId } = await seed();
    const rs = await Promise.all([createDealCheckoutSession(paymentId), createDealCheckoutSession(paymentId), createDealCheckoutSession(paymentId)]);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(new Set(rs.map((r: any) => r.url)).size).toBe(1);
  });

  test("a completed session means processing — no second Checkout", async () => {
    const { paymentId } = await seed();
    const a: any = await createDealCheckoutSession(paymentId);
    stripe.__sessions.get(a.url.split("/").pop()).status = "complete";
    expect(await createDealCheckoutSession(paymentId)).toEqual({ error: "processing" });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  test("bank debit in flight (Checkout completed unpaid) → processing", async () => {
    const { paymentId, dealId } = await seed();
    await createDealCheckoutSession(paymentId);
    await processStripeEvent(evt("checkout.session.completed", {
      id: "cs_ach", metadata: { kind: "deal_payment", payment_id: paymentId, deal_id: dealId },
      payment_intent: "pi_ach_inflight", payment_status: "unpaid", customer_details: { email: "b@acme.test" },
    }));
    expect(await createDealCheckoutSession(paymentId)).toEqual({ error: "processing" });
  });

  test("a re-quote expires the old-amount session; the next visit opens one at the new amount", async () => {
    const { athleteId, dealId, paymentId } = await seed("100");
    const first: any = await createDealCheckoutSession(paymentId);
    const firstId = first.url.split("/").pop();

    await db.update(deals).set({ amount: "200" } as any).where(eq(deals.id, dealId));
    await requestDealPayment(dealId, athleteId, "card");
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith(firstId);
    expect(stripe.__sessions.get(firstId).status).toBe("expired");
    expect((await row(paymentId)).stripe_checkout_session_id).toBeNull();

    const second: any = await createDealCheckoutSession(paymentId);
    expect(second.reused).toBe(false);
    expect(stripe.__sessions.get(second.url.split("/").pop()).amount_total).toBe((await row(paymentId)).brand_total_cents);
  });

  test("re-requesting the same quote keeps the open session", async () => {
    const { athleteId, dealId, paymentId } = await seed();
    await createDealCheckoutSession(paymentId);
    await requestDealPayment(dealId, athleteId, "card");
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(await createDealCheckoutSession(paymentId)).toMatchObject({ reused: true });
  });

  test("a re-quote is refused while a completed session's payment is in flight", async () => {
    const { athleteId, dealId, paymentId } = await seed("100");
    const a: any = await createDealCheckoutSession(paymentId);
    stripe.__sessions.get(a.url.split("/").pop()).status = "complete";
    await db.update(deals).set({ amount: "300" } as any).where(eq(deals.id, dealId));
    await expect(requestDealPayment(dealId, athleteId, "card")).rejects.toMatchObject({ code: "PAYMENT_ALREADY_ACTIVE" });
  });

  test("a session about to lapse is replaced, not handed out", async () => {
    const { paymentId } = await seed();
    const a: any = await createDealCheckoutSession(paymentId);
    const id = a.url.split("/").pop();
    stripe.__sessions.get(id).expires_at = Math.floor(Date.now() / 1000) + 120; // 2 minutes left
    const b: any = await createDealCheckoutSession(paymentId);
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith(id);
    expect(b.reused).toBe(false);
    expect(b.url).not.toBe(a.url);
  });

  test("checkout.session.expired marks the stored session lapsed; the next visit mints a fresh one", async () => {
    const { paymentId, dealId } = await seed();
    const a: any = await createDealCheckoutSession(paymentId);
    const id = a.url.split("/").pop();
    stripe.__sessions.get(id).status = "expired";
    await processStripeEvent(evt("checkout.session.expired", { id, metadata: { kind: "deal_payment", payment_id: paymentId, deal_id: dealId } }));
    expect((await row(paymentId)).checkout_expires_at!.getTime()).toBeLessThanOrEqual(Date.now());
    const b: any = await createDealCheckoutSession(paymentId);
    expect(b.reused).toBe(false);
  });

  test("a paid payment never opens Checkout again", async () => {
    const { paymentId, dealId } = await seed();
    await processStripeEvent(evt("checkout.session.completed", {
      metadata: { kind: "deal_payment", payment_id: paymentId, deal_id: dealId },
      payment_intent: "pi_paid", payment_status: "paid", customer_details: { email: "b@acme.test" },
    }));
    expect(await createDealCheckoutSession(paymentId)).toEqual({ error: "already paid" });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("duplicate successful payment", () => {
  test("a second PaymentIntent succeeding on a funded row is flagged for refund, never lost or overwritten", async () => {
    const { paymentId, dealId } = await seed();
    const meta = { kind: "deal_payment", payment_id: paymentId, deal_id: dealId };
    await processStripeEvent(evt("payment_intent.succeeded", { id: "pi_one", latest_charge: "ch_one", metadata: meta }));
    await processStripeEvent(evt("checkout.session.completed", {
      metadata: meta, payment_intent: "pi_two", payment_status: "paid", customer_details: { email: "b@acme.test" },
    }));
    await processStripeEvent(evt("payment_intent.succeeded", { id: "pi_two", latest_charge: "ch_two", metadata: meta }));

    const p = await row(paymentId);
    expect(p.status).toBe("funded");
    expect(p.stripe_payment_intent_id).toBe("pi_one");
    expect(p.stripe_charge_id).toBe("ch_one");
    const dups = (p.metadata as any).duplicate_charges;
    expect(dups).toHaveLength(1);
    expect(dups[0]).toMatchObject({ payment_intent: "pi_two", charge: "ch_two", refund_status: "needs_refund" });
  });
});
