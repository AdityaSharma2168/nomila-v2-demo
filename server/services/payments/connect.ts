/**
 * connect.ts — athlete payout accounts (Stripe Connect).
 *
 * Athletes receive deal money via Separate Charges & Transfers, so each needs a
 * connected account with the `transfers` capability. Payout is HARD-GATED on
 * onboarding completing (payouts_enabled + transfers active) — see assertPayoutReady.
 *
 * Webhooks are the primary source: account.updated (delivered to the CONNECT webhook
 * endpoint, /api/webhooks/stripe/connect) → syncConnectAccountFromStripe. A missed
 * webhook is healed by refreshConnectAccountFromStripe (API read) on onboarding return,
 * on a status read while onboarding, and before a payout is refused.
 */

import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { athletes, connectAccounts } from "../../../shared/schema";
import type { ConnectAccount } from "../../../shared/schema";
import { getStripe } from "../../lib/stripe";
import { createLogger } from "../../logger";
import { connectRefreshUrl, connectReturnUrl } from "./urls";

const logger = createLogger("payments/connect");

/**
 * Create the athlete's Stripe connected account for receiving transfers (SCT).
 *
 * Uses controller-properties (platform-liable, express dashboard) rather than the
 * legacy `type: 'express'`. `losses.payments: 'application'` makes the platform
 * liable — required because escrow holds funds on the platform balance. Accounts v2
 * `recipient` is the intended target once confirmed available on the account
 * (plan §2.5 / §14.4); swapping is isolated to this one function.
 */
async function createConnectedAccount(
  email: string | null,
  athleteId: string,
): Promise<{ id: string; kind: "classic" | "v2_recipient" }> {
  const account = await getStripe().accounts.create({
    country: "US",
    email: email ?? undefined,
    controller: {
      losses:           { payments: "application" }, // platform is liable — required for SCT escrow
      fees:             { payer: "application" },
      stripe_dashboard: { type: "express" },
    },
    capabilities: { transfers: { requested: true } },
    metadata: { athlete_id: athleteId },
  });
  return { id: account.id, kind: "classic" };
}

/** Get the athlete's connect_accounts row, creating the Stripe account + row on first use. */
export async function getOrCreateConnectAccount(athleteId: string): Promise<ConnectAccount> {
  const [existing] = await db.select().from(connectAccounts).where(eq(connectAccounts.athlete_id, athleteId)).limit(1);
  if (existing) return existing;

  const [athlete] = await db.select({ email: athletes.email }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!athlete) throw new Error(`Athlete not found: ${athleteId}`);

  const { id: stripeAccountId, kind } = await createConnectedAccount(athlete.email, athleteId);

  // First-writer-wins on a concurrent create: insert, ignore a unique-athlete_id conflict, re-read.
  // The loser's Stripe account is orphaned (harmless) and the DB stays consistent.
  await db
    .insert(connectAccounts)
    .values({ athlete_id: athleteId, stripe_account_id: stripeAccountId, account_kind: kind })
    .onConflictDoNothing({ target: connectAccounts.athlete_id });

  const [row] = await db.select().from(connectAccounts).where(eq(connectAccounts.athlete_id, athleteId)).limit(1);
  if (!row) throw new Error("connect account row missing after insert");
  if (row.stripe_account_id !== stripeAccountId) {
    logger.warn({ athleteId, orphaned: stripeAccountId, kept: row.stripe_account_id }, "Concurrent connect-account create — keeping first writer");
  }
  return row;
}

/** Mint a hosted onboarding link (get-or-create the account first). */
export async function createOnboardingLink(athleteId: string): Promise<{ url: string; accountId: string }> {
  const acct = await getOrCreateConnectAccount(athleteId);
  const link = await getStripe().accountLinks.create({
    account:     acct.stripe_account_id,
    refresh_url: connectRefreshUrl(acct.stripe_account_id),
    return_url:  connectReturnUrl(acct.stripe_account_id),
    type:        "account_onboarding",
  });
  return { url: link.url, accountId: acct.stripe_account_id };
}

export interface ConnectSyncResult {
  athleteId:   string;
  payoutReady: boolean;
}

/**
 * Mirror Stripe capability flags onto connect_accounts. Called by the Connect webhook
 * (account.updated) AND by the API-fetch fallback below. Returns null for an account
 * we don't know.
 */
export async function syncConnectAccountFromStripe(account: Stripe.Account): Promise<ConnectSyncResult | null> {
  const transfersActive = account.capabilities?.transfers === "active";
  const requirementsDue = account.requirements?.currently_due ?? [];

  const res = await db
    .update(connectAccounts)
    .set({
      details_submitted: !!account.details_submitted,
      charges_enabled:   !!account.charges_enabled,
      payouts_enabled:   !!account.payouts_enabled,
      transfers_active:  transfersActive,
      requirements_due:  requirementsDue,
      updated_at:        new Date(),
    })
    .where(eq(connectAccounts.stripe_account_id, account.id))
    .returning({ athleteId: connectAccounts.athlete_id });

  if (res.length === 0) {
    // Webhook outran our insert (rare). Safe to ignore — the create flow inserts the row,
    // and the next account.updated or a status fetch (refreshConnectAccountFromStripe) reconciles.
    logger.warn({ stripeAccountId: account.id }, "account.updated for an unknown connect account — ignoring");
    return null;
  }
  const payoutReady = !!account.payouts_enabled && transfersActive;
  logger.info({ stripeAccountId: account.id, payouts_enabled: !!account.payouts_enabled, transfersActive }, "Connect account synced");
  return { athleteId: res[0].athleteId, payoutReady };
}

/**
 * Fallback for a missed Connect webhook: read the account from Stripe and sync it.
 * Used on onboarding return, on a status read while not yet onboarded, and before a
 * payout is refused.
 */
export async function refreshConnectAccountFromStripe(stripeAccountId: string): Promise<ConnectSyncResult | null> {
  const account = await getStripe().accounts.retrieve(stripeAccountId);
  return syncConnectAccountFromStripe(account);
}

/** A status read refreshes from Stripe at most this often while the athlete is still onboarding. */
const STATUS_REFRESH_MIN_INTERVAL_MS = 30_000;

export interface ConnectStatus {
  hasAccount:       boolean;
  onboarded:        boolean; // payouts_enabled && transfers active — the payout gate
  payoutsEnabled:   boolean;
  chargesEnabled:   boolean;
  transfersActive:  boolean;
  detailsSubmitted: boolean;
  requirementsDue:  string[];
}

/** Read the athlete's payout status (drives the onboarding banner). Not yet onboarded → re-check with Stripe (throttled). */
export async function getConnectStatus(athleteId: string): Promise<ConnectStatus> {
  let [row] = await db.select().from(connectAccounts).where(eq(connectAccounts.athlete_id, athleteId)).limit(1);
  if (!row) {
    return {
      hasAccount: false, onboarded: false, payoutsEnabled: false, chargesEnabled: false,
      transfersActive: false, detailsSubmitted: false, requirementsDue: [],
    };
  }
  const stale = !row.updated_at || Date.now() - row.updated_at.getTime() > STATUS_REFRESH_MIN_INTERVAL_MS;
  if (!(row.payouts_enabled && row.transfers_active) && stale) {
    try {
      await refreshConnectAccountFromStripe(row.stripe_account_id);
      [row] = await db.select().from(connectAccounts).where(eq(connectAccounts.athlete_id, athleteId)).limit(1);
    } catch (err: any) {
      logger.warn({ athleteId, error: err.message }, "Connect status refresh from Stripe failed — serving stored status");
    }
  }
  return {
    hasAccount:       true,
    onboarded:        row.payouts_enabled && row.transfers_active,
    payoutsEnabled:   row.payouts_enabled,
    chargesEnabled:   row.charges_enabled,
    transfersActive:  row.transfers_active,
    detailsSubmitted: row.details_submitted,
    requirementsDue:  (row.requirements_due as string[] | null) ?? [],
  };
}

/**
 * The hard gate (plan §2.3): an athlete cannot be paid out until onboarding completes.
 * If the stored flags say no, re-read the account from Stripe once before refusing — a
 * missed Connect webhook must not block a payout forever.
 */
export async function assertPayoutReady(athleteId: string): Promise<ConnectAccount> {
  const ready = (r: ConnectAccount | undefined): boolean => !!r && r.payouts_enabled && r.transfers_active;
  let [row] = await db.select().from(connectAccounts).where(eq(connectAccounts.athlete_id, athleteId)).limit(1);
  if (row && !ready(row)) {
    try {
      await refreshConnectAccountFromStripe(row.stripe_account_id);
      [row] = await db.select().from(connectAccounts).where(eq(connectAccounts.athlete_id, athleteId)).limit(1);
    } catch (err: any) {
      logger.warn({ athleteId, error: err.message }, "payout gate: Stripe status refresh failed");
    }
  }
  if (!row || !ready(row)) {
    const err = new Error("CONNECT_REQUIRED") as Error & { code?: string };
    err.code = "CONNECT_REQUIRED";
    throw err;
  }
  return row;
}
