/**
 * config.ts — every product knob for the brand commission engine in one place.
 *
 * Env-overridable so the open product decisions (commission %, deal floor,
 * confirmation window) change without a code change — see
 * docs/plans/payments-commission-engine.md §14. Money is INTEGER CENTS.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export const PAYMENTS = {
  /** Nomila's flat commission, charged ON TOP and paid by the brand (§3/§4). DEFAULT 10%. */
  commissionPercent:      envInt("COMMISSION_PERCENT", 10),
  /** Deal floor — below this, fixed Stripe fees eat the margin (§4). DEFAULT $50. */
  minDealCents:           envInt("MIN_DEAL_CENTS", 5_000),
  /** Sanity ceiling on a single deal (overflow / fat-finger guard), well under int4's $21.4M. */
  maxDealCents:           envInt("MAX_DEAL_CENTS", 100_000_000),
  /** Deals at/above this surface bank/ACH as the cheaper rail (display hint; methods stay dynamic). */
  achMinCents:            envInt("ACH_MIN_CENTS", 50_000),

  /** Seriousness deposit: card auths lapse ~7 days — re-authorize the hold once, this many days in. */
  depositReauthAfterDays: envInt("DEPOSIT_REAUTH_AFTER_DAYS", 6),
  /** How long a placed deposit keeps its ranking boost before it expires and the hold is released. */
  depositWindowDays:      envInt("DEPOSIT_WINDOW_DAYS", 14),
  /** Seriousness deposit hold amount (card-only auth, never captured). OPEN product decision. */
  depositHoldCents:       envInt("DEPOSIT_HOLD_CENTS", 5_000),

  /** Delivery confirmation: auto-release to the athlete this many days after the brand goes silent (§7). */
  confirmationWindowDays: envInt("CONFIRMATION_WINDOW_DAYS", 7),
  /** Dispute-reserve knob (§14.5): delay the athlete transfer this many hours after confirmation. 0 = immediate. */
  transferDelayHours:     envInt("TRANSFER_DELAY_HOURS", 0),

  /**
   * Lifetime of a pay-link Checkout session (Stripe allows 0.5–24h). The pay link reuses the
   * one open session per payment until it lapses, then mints a fresh one.
   */
  checkoutSessionHours:   Math.min(23, Math.max(1, envInt("CHECKOUT_SESSION_HOURS", 23))),

  /** ISO currency for all charges/transfers. */
  currency:               envStr("PAYMENTS_CURRENCY", "usd"),
} as const;
