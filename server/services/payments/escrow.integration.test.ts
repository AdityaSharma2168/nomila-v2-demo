/**
 * escrow.integration.test.ts — drives the full deal-payment lifecycle against a real
 * in-memory Postgres (PGlite) with the Stripe seam mocked. Proves the orchestration +
 * SCT transfer amount (exactly the deal value) + the single-charge idempotency guard.
 */

// Real in-mem Postgres for server/db; a fake Stripe seam that records calls.
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));
jest.mock("../../lib/stripe", () => {
  const stripe = {
    checkout: { sessions: { create: jest.fn(async () => ({ id: "cs_test", url: "https://checkout.stripe.test/session" })) } },
    transfers: { create: jest.fn(async () => ({ id: "tr_test_1" })), list: jest.fn(async () => ({ data: [] })) },
    paymentIntents: {
      retrieve: jest.fn(async (id: string) => ({ id, payment_method: "pm_test", latest_charge: "ch_test" })),
      create:   jest.fn(async () => ({ id: "pi_reauth" })),
      cancel:   jest.fn(async (id: string) => ({ id, status: "canceled" })),
    },
  };
  return { getStripe: () => stripe, isTestMode: () => true, constructWebhookEvent: jest.fn() };
});

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { athletes, deals, payments, connectAccounts, inboxThreads } from "../../../shared/schema";
import { initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { getStripe } from "../../lib/stripe";
import { sendEmail } from "../../lib/notify";
import { requestDealPayment, createDealCheckoutSession, handleCheckoutSessionCompleted } from "./escrow";
import { markDeliveredByAthlete, confirmDeliveryByBrand, settleDealPayment } from "./settle";

const stripe = getStripe() as any;

/** The brand-only token from the confirm link in the last email to the brand. */
const brandToken = (): string => decodeURIComponent(/[?&]t=([^\s&]+)/.exec((sendEmail as jest.Mock).mock.calls.at(-1)![0].text)![1]);

async function seedPayoutReadyAthlete(): Promise<string> {
  const athleteId = await seedAthlete("Escrow Athlete");
  await db.insert(connectAccounts).values({
    athlete_id: athleteId, stripe_account_id: `acct_${athleteId}`, account_kind: "classic",
    details_submitted: true, charges_enabled: true, payouts_enabled: true, transfers_active: true,
  } as any);
  return athleteId;
}

async function seedDeal(athleteId: string, amountDollars = "100"): Promise<string> {
  const [row] = await db.insert(deals).values({
    athlete_id: athleteId, brand_name: "Acme", amount: amountDollars, status: "accepted",
  } as any).returning({ id: deals.id });
  return row.id;
}

beforeAll(() => initTestDb());
afterAll(() => closeTestDb());
beforeEach(() => { jest.clearAllMocks(); });

describe("deal-payment escrow lifecycle", () => {
  test("request → checkout → funded → delivered → dual-confirm → transfer of exactly the deal value", async () => {
    const athleteId = await seedPayoutReadyAthlete();
    const dealId = await seedDeal(athleteId, "100"); // $100 → athlete gets 10000¢

    // 1. Request payment: quote grosses up (deal + 10% + processing); row is pending.
    const req = await requestDealPayment(dealId, athleteId, "card");
    expect(req.quote.dealValueCents).toBe(10_000);
    expect(req.quote.commissionCents).toBe(1_000);
    expect(req.quote.brandTotalCents).toBe(11_359); // ~$113.59
    let [p] = await db.select().from(payments).where(eq(payments.id, req.paymentId));
    expect(p.status).toBe("pending");
    let [d] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(d.payment_status).toBe("payment_requested");

    // 2. Brand opens the pay link → Checkout session created + stored.
    const sess = await createDealCheckoutSession(req.paymentId);
    expect("url" in sess).toBe(true);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);

    // 3. checkout.session.completed (card, paid) → funded (escrow held on platform).
    await handleCheckoutSessionCompleted({
      metadata: { kind: "deal_payment", payment_id: req.paymentId, deal_id: dealId },
      payment_intent: "pi_deal_1", payment_status: "paid",
      customer_details: { email: "brand@acme.test" },
    } as any);
    [p] = await db.select().from(payments).where(eq(payments.id, req.paymentId));
    expect(p.status).toBe("funded");
    expect(p.brand_email).toBe("brand@acme.test");
    [d] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(d.payment_status).toBe("funded");

    // 4. Athlete marks delivered → confirmation window opens; the brand (only) is emailed its confirm link.
    const md = await markDeliveredByAthlete(dealId, athleteId);
    expect(md.settled).toBe(false);
    [d] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(d.payment_status).toBe("delivered_pending_confirmation");

    // 5. Brand confirms → release: transfer of EXACTLY the deal value to the athlete.
    const cd = await confirmDeliveryByBrand(req.paymentId, brandToken());
    expect(cd.settled).toBe(true);
    expect(stripe.transfers.create).toHaveBeenCalledTimes(1);
    const transferArg = stripe.transfers.create.mock.calls[0][0];
    expect(transferArg.amount).toBe(10_000);          // exactly the deal value — commission stays on platform
    expect(transferArg.destination).toBe(`acct_${athleteId}`);
    [p] = await db.select().from(payments).where(eq(payments.id, req.paymentId));
    expect(p.status).toBe("settled");
    expect(p.stripe_transfer_id).toBe("tr_test_1");
    [d] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(d.payment_status).toBe("settled");
  });

  test("single-charge idempotency: re-confirming or re-settling never transfers twice", async () => {
    const athleteId = await seedPayoutReadyAthlete();
    const dealId = await seedDeal(athleteId, "100");
    const req = await requestDealPayment(dealId, athleteId, "card");
    await handleCheckoutSessionCompleted({
      metadata: { kind: "deal_payment", payment_id: req.paymentId, deal_id: dealId },
      payment_intent: "pi_deal_2", payment_status: "paid", customer_details: { email: "b@acme.test" },
    } as any);
    await markDeliveredByAthlete(dealId, athleteId);

    await confirmDeliveryByBrand(req.paymentId, brandToken());       // releases
    await confirmDeliveryByBrand(req.paymentId, brandToken());       // idempotent no-op
    const again = await settleDealPayment(req.paymentId); // already settled
    expect(again).toBe(true);
    expect(stripe.transfers.create).toHaveBeenCalledTimes(1); // exactly one transfer, ever
  });

  test("below the $50 floor is rejected before any Stripe call", async () => {
    const athleteId = await seedPayoutReadyAthlete();
    const dealId = await seedDeal(athleteId, "40"); // $40 < $50 floor
    await expect(requestDealPayment(dealId, athleteId, "card")).rejects.toMatchObject({ code: "INVALID_DEAL_AMOUNT" });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("bills the LATEST offer on the thread, not the detection-time deals.amount; a figure she confirmed wins", async () => {
    const athleteId = await seedPayoutReadyAthlete();
    const dealId = await seedDeal(athleteId, "100");
    await db.insert(inboxThreads).values({
      athlete_id: athleteId, deal_id: dealId, subject: "Offer", last_message_at: new Date(),
      conversation_state: { key_details: { offer_struct: { amount: 300 } } },
    } as any);
    const req = await requestDealPayment(dealId, athleteId, "card");
    expect(req.quote.dealValueCents).toBe(30_000);

    // A contract she saved: deals.amount is hers and wins over any thread figure.
    const confirmedId = await seedDeal(athleteId, "120");
    await db.update(deals).set({ source: "contract_upload" } as any).where(eq(deals.id, confirmedId));
    await db.insert(inboxThreads).values({
      athlete_id: athleteId, deal_id: confirmedId, subject: "Offer", last_message_at: new Date(),
      conversation_state: { key_details: { offer_struct: { amount: 300 } } },
    } as any);
    const req2 = await requestDealPayment(confirmedId, athleteId, "card");
    expect(req2.quote.dealValueCents).toBe(12_000);
  });
});

describe("request-payment: only on an agreed deal, and says what it bills (12 Oct 2026)", () => {
  test("a deal she has not agreed is refused before anything is created", async () => {
    const athleteId = await seedPayoutReadyAthlete();
    for (const status of ["detected", "negotiating", "rejected"]) {
      const [row] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Acme", amount: "500", status } as any).returning({ id: deals.id });
      await expect(requestDealPayment(row.id, athleteId, "card")).rejects.toMatchObject({ code: "DEAL_NOT_AGREED" });
      expect(await db.select().from(payments).where(eq(payments.deal_id, row.id))).toHaveLength(0);
    }
  });

  test("returns the billed figure and its source: the latest thread offer, or the figure she confirmed", async () => {
    const athleteId = await seedPayoutReadyAthlete();
    const dealId = await seedDeal(athleteId, "200");
    await db.insert(inboxThreads).values({
      athlete_id: athleteId, deal_id: dealId, subject: "x",
      conversation_state: { key_details: { offer_struct: { amount: 950 } } }, last_message_at: new Date(),
    } as any);
    const fromThread = await requestDealPayment(dealId, athleteId, "card");
    expect(fromThread.amount).toEqual({ value: 950, source: "thread" });

    const [confirmed] = await db.insert(deals).values({
      athlete_id: athleteId, brand_name: "Acme", amount: "1200", status: "accepted", source: "contract_upload",
    } as any).returning({ id: deals.id });
    expect((await requestDealPayment(confirmed.id, athleteId, "card")).amount).toEqual({ value: 1200, source: "confirmed" });
  });
});
