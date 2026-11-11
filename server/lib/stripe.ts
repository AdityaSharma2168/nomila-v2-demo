/**
 * stripe.ts — the single seam between nomila and the Stripe SDK.
 *
 * Everything payments-related goes through this module so tests can
 * `jest.mock("../lib/stripe", ...)` (the house idiom: mock the internal wrapper,
 * never the vendor SDK). The client is created lazily so the server boots — and
 * non-payment tests run — without STRIPE_SECRET_KEY set.
 *
 * Money convention for all payments code: INTEGER CENTS, matching Stripe.
 *
 * NOTE: brands are account-less in the commission engine (they pay via hosted
 * guest Checkout), and athletes are payees via Stripe Connect — so there is no
 * getOrCreateCustomer here. Add one only if a persistent Customer is ever needed.
 */

import Stripe from "stripe";

let client: Stripe | null = null;

/** Lazily-initialized Stripe client. Throws only when payments code actually runs without a key. */
export function getStripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set — payments are unavailable");
    client = new Stripe(key);
  }
  return client;
}

/** True when the account is running on test keys — bootstrap scripts check this before creating objects. */
export function isTestMode(): boolean {
  return (process.env.STRIPE_SECRET_KEY?.trim() ?? "").startsWith("sk_test_");
}

/**
 * Verify a webhook delivery and return the event. `rawBody` must be the unparsed Buffer
 * (the /api/webhooks mount uses express.raw). Throws on bad signature — callers respond 400.
 *
 * Two Stripe endpoints, two signing secrets:
 *   - "platform" (STRIPE_WEBHOOK_SECRET): events on Nomila's own account — Checkout,
 *     PaymentIntents, charges, transfers, refunds, disputes.
 *   - "connect" (STRIPE_CONNECT_WEBHOOK_SECRET): events on the athletes' CONNECTED
 *     accounts — account.updated. Stripe delivers those only to a Connect-type endpoint.
 */
export function constructWebhookEvent(rawBody: Buffer, signature: string, endpoint: "platform" | "connect" = "platform"): Stripe.Event {
  const name = endpoint === "connect" ? "STRIPE_CONNECT_WEBHOOK_SECRET" : "STRIPE_WEBHOOK_SECRET";
  const secret = process.env[name]?.trim();
  if (!secret) throw new Error(`${name} is not set`);
  return getStripe().webhooks.constructEvent(rawBody, signature, secret);
}
