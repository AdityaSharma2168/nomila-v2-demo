/**
 * urls.ts — where hosted Stripe flows (Connect onboarding, Checkout, the
 * account-less brand confirm page) send the browser back.
 *
 * Native deep-link returns (co.nomila.app://) are a polish TODO — for now these
 * land on a server-rendered status page with query params
 * (docs/plans/payments-commission-engine.md §11).
 */

import { publicBaseUrl } from "../../lib/baseUrls";

/** The public base for server-rendered brand pages (deposit / pay / confirm) — same origin as the API. */
const PUBLIC_BASE = publicBaseUrl();

// ── Connect onboarding ──
// Stripe sends the athlete back to a server page that re-reads her account from Stripe
// (the fallback for a missed Connect account.updated webhook) — server/routes/connectReturn.ts.
export function connectReturnUrl(stripeAccountId: string): string {
  return `${PUBLIC_BASE}/connect/return/${encodeURIComponent(stripeAccountId)}`;
}
export function connectRefreshUrl(stripeAccountId: string): string {
  return `${PUBLIC_BASE}/connect/refresh/${encodeURIComponent(stripeAccountId)}`;
}

// ── Brand hosted flows (account-less; served by this server, see server/index.ts) ──
export function brandCheckoutReturnUrl(dealId: string): string {
  return `${PUBLIC_BASE}/pay/${dealId}/done`;
}
/** Back to the pay link (by PAYMENT id), which reopens the payment's one open Checkout session. */
export function brandCheckoutCancelUrl(paymentId: string): string {
  return `${PUBLIC_BASE}/pay/${paymentId}?canceled=1`;
}
export function payLinkUrl(paymentId: string): string {
  return `${PUBLIC_BASE}/pay/${paymentId}`;
}
/** The brand's confirm link. `token` is the brand-only credential (brandToken.ts) — never shown to the athlete. */
export function confirmLinkUrl(paymentId: string, token: string): string {
  return `${PUBLIC_BASE}/confirm/${paymentId}?t=${encodeURIComponent(token)}`;
}
export function depositLinkUrl(dealId: string): string {
  return `${PUBLIC_BASE}/deposit/${dealId}`;
}
export function depositReturnUrl(dealId: string): string {
  return `${PUBLIC_BASE}/deposit/${dealId}/done`;
}
export function depositCancelUrl(dealId: string): string {
  return `${PUBLIC_BASE}/deposit/${dealId}?canceled=1`;
}
