/**
 * settlement.integration.test.ts — settlement safety (payments PR 3), against PGlite with Stripe and the email
 * channel fully mocked (no provider calls).
 *
 *  (a) The brand's confirm/dispute needs the brand-only token that is emailed to the brand; the athlete's
 *      mark-delivered never receives it, and the payment id alone releases nothing.
 *  (b) The confirm page escapes the (untrusted) brand name, carries no script, and is served under a strict CSP.
 *  (c) A release that fails (payout account not ready) is recorded and retried by the sweep; an earlier transfer
 *      for the payment is adopted, never duplicated.
 *  (d) A missed Connect webhook is healed by an API read (onboarding return / status / before payout), and
 *      account.updated releases what was waiting.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true, id: "em_1" })) }));
jest.mock("../../lib/stripe", () => {
  const stripe = {
    checkout:  { sessions: { create: jest.fn(async () => ({ id: "cs_test", url: "https://checkout.stripe.test/s", status: "open" })) } },
    transfers: {
      create: jest.fn(async () => ({ id: "tr_new" })),
      list:   jest.fn(async () => ({ data: [] as any[] })),
    },
    paymentIntents: { retrieve: jest.fn(async (id: string) => ({ id, latest_charge: "ch_fetched" })) },
    accounts: { retrieve: jest.fn(async (id: string) => ({ id, payouts_enabled: false, charges_enabled: false, details_submitted: false, capabilities: {} })) },
  };
  return { getStripe: () => stripe, isTestMode: () => true, constructWebhookEvent: jest.fn() };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { connectAccounts, deals, payments } from "../../../shared/schema";
import { initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { getStripe } from "../../lib/stripe";
import { sendEmail } from "../../lib/notify";
import { requestDealPayment, handleCheckoutSessionCompleted } from "./escrow";
import { markDeliveredByAthlete, confirmDeliveryByBrand, disputeDeliveryByBrand } from "./settle";
import { getConnectStatus } from "./connect";
import { runPaymentsCron } from "./paymentsCron";
import { processStripeEvent } from "./webhook";
import confirmRouter from "../../routes/confirm";
import connectReturnRouter from "../../routes/connectReturn";

const stripe = getStripe() as any;
const emailMock = sendEmail as jest.Mock;
let seq = 0;

const readyAccount = (id: string) => ({ id, payouts_enabled: true, charges_enabled: true, details_submitted: true, capabilities: { transfers: "active" } });

async function seedFunded(opts: { ready?: boolean; brand?: string } = {}) {
  const athleteId = await seedAthlete("Settle Athlete");
  const acct = `acct_${++seq}x${Date.now()}`;
  const ready = opts.ready ?? true;
  await db.insert(connectAccounts).values({
    athlete_id: athleteId, stripe_account_id: acct, account_kind: "classic",
    details_submitted: ready, charges_enabled: ready, payouts_enabled: ready, transfers_active: ready,
  } as any);
  const [deal] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: opts.brand ?? "Acme", amount: "100", status: "accepted" } as any)
    .returning({ id: deals.id });
  const req = await requestDealPayment(deal.id, athleteId, "card");
  await handleCheckoutSessionCompleted({
    metadata: { kind: "deal_payment", payment_id: req.paymentId, deal_id: deal.id },
    payment_intent: `pi_${seq}`, payment_status: "paid", customer_details: { email: "brand@acme.test" },
  } as any);
  return { athleteId, dealId: deal.id, paymentId: req.paymentId, acct };
}

/** The token from the confirm link in the LAST email sent to the brand. */
function lastEmailedToken(): { to: string; token: string; url: string } {
  const input = emailMock.mock.calls.at(-1)![0];
  const url = /https?:\/\/\S+\/confirm\/\S+\?t=[A-Za-z0-9_%-]+/.exec(input.text)![0];
  return { to: input.to, url, token: decodeURIComponent(new URL(url).searchParams.get("t")!) };
}
const row = async (id: string) => (await db.select().from(payments).where(eq(payments.id, id)))[0];

let server: Server;
let base = "";

beforeAll(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/confirm", confirmRouter);
  app.use("/connect", connectReturnRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); await closeTestDb(); });
beforeEach(() => { jest.clearAllMocks(); });

describe("(a) brand-only confirm token", () => {
  test("mark-delivered emails the brand a token link and returns NO link or token to the athlete", async () => {
    const { athleteId, dealId, paymentId } = await seedFunded();
    const r = await markDeliveredByAthlete(dealId, athleteId);
    expect(r).toEqual({ settled: false, brandNotified: true, windowEndsAt: expect.any(String) });
    expect(JSON.stringify(r)).not.toMatch(/confirm|t=/);

    const { to, token } = lastEmailedToken();
    expect(to).toBe("brand@acme.test");
    expect(token.length).toBeGreaterThanOrEqual(40);
    const p = await row(paymentId);
    expect(p.brand_confirm_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.brand_confirm_token_hash).not.toContain(token); // only the hash is stored
  });

  test("the payment id alone (what the athlete knows) cannot confirm or dispute; the brand token releases", async () => {
    const { athleteId, dealId, paymentId } = await seedFunded();
    await markDeliveredByAthlete(dealId, athleteId);
    const { token } = lastEmailedToken();

    expect(await confirmDeliveryByBrand(paymentId, undefined)).toMatchObject({ ok: false, message: "not found" });
    expect(await confirmDeliveryByBrand(paymentId, paymentId)).toMatchObject({ ok: false });
    expect(await disputeDeliveryByBrand(paymentId, "guess")).toEqual({ ok: false });
    expect((await row(paymentId)).brand_confirmed_at).toBeNull();
    expect(stripe.transfers.create).not.toHaveBeenCalled();

    expect(await confirmDeliveryByBrand(paymentId, token)).toEqual({ ok: true, settled: true, message: "released" });
    expect(stripe.transfers.create).toHaveBeenCalledTimes(1);
    expect((await row(paymentId)).status).toBe("settled");
  });

  test("re-marking delivered re-sends a NEW link; the old token stops working", async () => {
    const { athleteId, dealId, paymentId } = await seedFunded();
    await markDeliveredByAthlete(dealId, athleteId);
    const first = lastEmailedToken().token;
    await markDeliveredByAthlete(dealId, athleteId);
    const second = lastEmailedToken().token;
    expect(second).not.toBe(first);
    expect(await disputeDeliveryByBrand(paymentId, first)).toEqual({ ok: false });
    expect(await disputeDeliveryByBrand(paymentId, second)).toEqual({ ok: true });
    expect((await row(paymentId)).status).toBe("disputed");
  });
});

describe("(b) the hosted confirm page", () => {
  test("escapes the brand name, has no script, strict CSP, form POST with the token releases", async () => {
    const { athleteId, dealId, paymentId } = await seedFunded({ brand: `<script>alert("x")</script><img src=x onerror=alert(1)>` });
    await markDeliveredByAthlete(dealId, athleteId);
    const { token } = lastEmailedToken();

    const page = await fetch(`${base}/confirm/${paymentId}?t=${encodeURIComponent(token)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");

    // Without the token: inactive, and nothing about the payment is shown.
    const bare = await fetch(`${base}/confirm/${paymentId}`);
    expect(bare.status).toBe(404);
    expect(await bare.text()).not.toContain("script");
    // A bare POST (athlete replaying the id) is refused.
    const forged = await fetch(`${base}/confirm/${paymentId}/confirm`, { method: "POST" });
    expect(forged.status).toBe(404);

    const ok = await fetch(`${base}/confirm/${paymentId}/confirm`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(token)}`,
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Released to the athlete");
    expect((await row(paymentId)).status).toBe("settled");
  });

  test("a malformed payment id is a plain inactive page, not a 500", async () => {
    const r = await fetch(`${base}/confirm/not-a-uuid?t=x`);
    expect(r.status).toBe(404);
  });
});

describe("(c) release retries", () => {
  test("brand confirms before the payout account is ready → recorded, then the sweep releases once it is", async () => {
    const { athleteId, dealId, paymentId, acct } = await seedFunded({ ready: false });
    await markDeliveredByAthlete(dealId, athleteId);
    const r = await confirmDeliveryByBrand(paymentId, lastEmailedToken().token);
    expect(r).toEqual({ ok: true, settled: false, message: "confirmed" });
    let p = await row(paymentId);
    expect(p.status).toBe("funded");
    expect(p.brand_confirmed_at).not.toBeNull();
    expect(p.failure_reason).toBe("settle_failed:CONNECT_REQUIRED");

    // Stripe now reports the account ready (no webhook arrived): the sweep's payout gate re-reads it.
    stripe.accounts.retrieve.mockImplementation(async (id: string) => readyAccount(id));
    const cron = await runPaymentsCron();
    expect(cron.autoReleased).toBeGreaterThanOrEqual(1);
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith(acct);
    p = await row(paymentId);
    expect(p.status).toBe("settled");
    expect(p.failure_reason).toBeNull();
    stripe.accounts.retrieve.mockReset();
    stripe.accounts.retrieve.mockImplementation(async (id: string) => ({ id, payouts_enabled: false, capabilities: {} }));
  });

  test("silent brand: released after the window; disputed rows are never released", async () => {
    const a = await seedFunded();
    await markDeliveredByAthlete(a.dealId, a.athleteId);
    await db.update(payments).set({ delivery_window_ends_at: new Date(Date.now() - 1000) }).where(eq(payments.id, a.paymentId));

    const b = await seedFunded();
    await markDeliveredByAthlete(b.dealId, b.athleteId);
    await disputeDeliveryByBrand(b.paymentId, lastEmailedToken().token);
    await db.update(payments).set({ delivery_window_ends_at: new Date(Date.now() - 1000) }).where(eq(payments.id, b.paymentId));

    await runPaymentsCron();
    expect((await row(a.paymentId)).status).toBe("settled");
    expect((await row(b.paymentId)).status).toBe("disputed");
  });

  test("a transfer from an earlier attempt is adopted, never duplicated", async () => {
    const { athleteId, dealId, paymentId } = await seedFunded();
    stripe.transfers.list.mockResolvedValueOnce({ data: [{ id: "tr_prior", metadata: { kind: "deal_settlement", payment_id: paymentId } }] });
    await markDeliveredByAthlete(dealId, athleteId);
    await confirmDeliveryByBrand(paymentId, lastEmailedToken().token);
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    const p = await row(paymentId);
    expect(p.status).toBe("settled");
    expect(p.stripe_transfer_id).toBe("tr_prior");
  });

  test("the transfer carries an idempotency key and is sourced from the charge", async () => {
    const { athleteId, dealId, paymentId } = await seedFunded();
    await markDeliveredByAthlete(dealId, athleteId);
    await confirmDeliveryByBrand(paymentId, lastEmailedToken().token);
    const [params, opts] = stripe.transfers.create.mock.calls[0];
    expect(opts).toEqual({ idempotencyKey: `settle_${paymentId}` });
    expect(params.source_transaction).toBe("ch_fetched");
  });
});

describe("(d) Connect status without the webhook", () => {
  test("status read while onboarding re-reads the account from Stripe", async () => {
    const { athleteId, acct } = await seedFunded({ ready: false });
    await db.update(connectAccounts).set({ updated_at: new Date(Date.now() - 60_000) }).where(eq(connectAccounts.stripe_account_id, acct));
    stripe.accounts.retrieve.mockImplementationOnce(async (id: string) => readyAccount(id));
    const s = await getConnectStatus(athleteId);
    expect(s.onboarded).toBe(true);
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith(acct);
  });

  test("onboarding return page refreshes from Stripe and releases what was waiting", async () => {
    const { athleteId, dealId, paymentId, acct } = await seedFunded({ ready: false });
    await markDeliveredByAthlete(dealId, athleteId);
    await confirmDeliveryByBrand(paymentId, lastEmailedToken().token); // recorded, not released
    stripe.accounts.retrieve.mockImplementation(async (id: string) => readyAccount(id));

    const r = await fetch(`${base}/connect/return/${acct}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("payout account is set up");
    expect((await row(paymentId)).status).toBe("settled");

    expect((await fetch(`${base}/connect/return/acct_unknown123`)).status).toBe(404);
    expect((await fetch(`${base}/connect/return/not-an-account`)).status).toBe(404);
    stripe.accounts.retrieve.mockReset();
    stripe.accounts.retrieve.mockImplementation(async (id: string) => ({ id, payouts_enabled: false, capabilities: {} }));
  });

  test("account.updated (Connect endpoint) that opens the payout gate releases due payments", async () => {
    const { athleteId, dealId, paymentId, acct } = await seedFunded({ ready: false });
    await markDeliveredByAthlete(dealId, athleteId);
    await confirmDeliveryByBrand(paymentId, lastEmailedToken().token);
    expect((await row(paymentId)).status).toBe("funded");

    await processStripeEvent({ id: `evt_acct_${seq}`, type: "account.updated", data: { object: readyAccount(acct) } } as any);
    expect((await row(paymentId)).status).toBe("settled");
  });
});
