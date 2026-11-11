/**
 * paymentsTapOnly.test.ts — STANDING RULE: money moves only on a human tap. No Mila tool, agent, pending
 * action, workflow or job may reach the code that moves money.
 *
 * The payment services are imported only by the explicit REST routes (athlete: requireAuth + tenancy; admin:
 * requireAdmin), the hosted brand pages, the Stripe webhook (which records what Stripe did) and the payments
 * sweep (which only releases what both sides already confirmed or the window allowed). Any other importer — and
 * any other file calling a money-moving function or the Stripe money APIs — fails this test, so a new path to
 * money has to be added here deliberately, in review.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SERVER = join(__dirname, "..", "..");

const ALLOWED_IMPORTERS = new Set([
  "index.ts",                         // mounts the routes; dynamic-imports the sweep
  "routes/payments.ts",               // athlete: request-payment, mark-delivered, deposit release, refund (requireAuth)
  "routes/adminPayments.ts",          // admin: refund, duplicate refund, dispute resolution, reversal (requireAdmin)
  "routes/connect.ts",                // athlete: Connect onboarding (moves no money)
  "routes/connectReturn.ts",          // Stripe onboarding return page (status read + due release)
  "routes/pay.ts", "routes/confirm.ts", "routes/deposit.ts", // the brand's hosted pages
  "routes/webhooks.ts",               // Stripe webhook → records events
  "routes/partnerPublic.ts",          // the brand's own "Add hold" tap (Serious offer Checkout) + linking it on confirm
  "routes/partnerAthlete.ts",         // her Agree (capture → counts toward the first payment) / Decline (release) taps
  // Bookings v2: the ONE booking release decision (the buyer's "It happened" tap, or end + 48h with nothing open,
  // under a row lock). It imports services/payments/bookingRelease by a relative path; listed so the money call below
  // is allowed here and nowhere else.
  "services/bookings/session/releaseGate.ts",
]);

const MONEY_CALLS = /\b(refundDealPayment|refundDuplicateCharge|reverseSettlementTransfer|resolveDeliveryDispute|requestDealPayment|markDeliveredByAthlete|confirmDeliveryByBrand|settleDealPayment|releaseDuePayments|releaseDeposit|reauthorizeDeposit|createDealCheckoutSession|createDepositCheckoutSession|releaseBookingPayment|createSeriousOfferCheckout|captureSeriousOffer|releaseSeriousOffer|releaseDepositPayment|refundCreditedHold)\s*\(|\b(refunds|transfers|payouts)\s*\.\s*(create|createReversal)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const files = walk(SERVER).map((f) => ({ rel: relative(SERVER, f).split(sep).join("/"), src: readFileSync(f, "utf8") }));
// Bookings v2's money code (services/bookings/charges.ts: capture, hold release, refund, transfer) is held to the same
// rule by its own guard, bookingsTapOnly.test.ts, which lists who may reach it.
const inPaymentsService = (rel: string) => rel.startsWith("services/payments/") || rel.startsWith("services/bookings/");

describe("payments are tap-only", () => {
  it("only the explicit payment routes, the webhook and the sweep import the payment services", () => {
    const importers = files
      .filter((f) => !inPaymentsService(f.rel))
      .filter((f) => /services\/payments\//.test(f.src))
      .map((f) => f.rel)
      .sort();
    expect(importers.filter((rel) => !ALLOWED_IMPORTERS.has(rel))).toEqual([]);
  });

  it("no file outside the payment services and allowed routes calls a money-moving function or Stripe money API", () => {
    const offenders = files
      .filter((f) => !inPaymentsService(f.rel) && !ALLOWED_IMPORTERS.has(f.rel))
      .filter((f) => MONEY_CALLS.test(f.src))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("a booking release is decided only by the buyer's tap (sessionStore.markItHappened) and the session sweep", () => {
    const callers = files
      .filter((f) => /\breleaseIfAllowed\s*\(/.test(f.src) && f.rel !== "services/bookings/session/releaseGate.ts")
      .map((f) => f.rel)
      .sort();
    expect(callers).toEqual(["services/bookings/session/sessionStore.ts", "services/bookings/session/sessionSweep.ts"]);
  });

  it("the scan actually sees the payment routes (guards against a vacuous pass)", () => {
    const rels = new Set(files.map((f) => f.rel));
    for (const r of ["routes/payments.ts", "routes/adminPayments.ts", "services/payments/refund.ts"]) expect(rels.has(r)).toBe(true);
    expect(files.length).toBeGreaterThan(200);
  });
});
