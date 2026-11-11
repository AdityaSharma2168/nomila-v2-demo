/**
 * paymentsCron.ts — the hourly payments sweep (x-cron-secret protected).
 *
 *  - Auto-release funded deal payments whose confirmation window elapsed with the
 *    brand silent (plan §7).
 *  - Re-authorize seriousness deposits at ~day 6 so the hold survives the window (§5).
 *  - Expire deposits whose window elapsed with no accept/decline (release the hold).
 *  - Serious offer holds (public requests): her reply stops the 6-day clock (extended to the deposit window) BEFORE the
 *    expiry step; an expired request hold is released and the brand is told, without content.
 */

import { and, eq, gt, inArray, lte } from "drizzle-orm";
import { db } from "../../db";
import { payments } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { PAYMENTS } from "./config";
import { releaseDuePayments } from "./settle";
import { reauthorizeDeposit, releaseDepositPayment } from "./deposit";
import { extendRepliedHolds } from "./seriousOffer";
import { notifyHoldReleased } from "../partner/holdNotices";

const logger = createLogger("payments/cron");
const DAY_MS = 86_400_000;

export interface PaymentsCronResult {
  autoReleased: number;
  reauthed:     number;
  expired:      number;
  skipped:      number;
}

export async function runPaymentsCron(now: Date = new Date()): Promise<PaymentsCronResult> {
  let autoReleased = 0, reauthed = 0, expired = 0, skipped = 0;

  // ── Release (§7) — retried every run until it succeeds: every funded deal_payment the
  //    athlete marked delivered where the brand confirmed OR the window elapsed with the brand
  //    silent. Covers releases that failed earlier (payout account not ready, Stripe error).
  //    Disputed rows are excluded by status. Transfers are idempotent (settle.ts).
  const rel = await releaseDuePayments(now);
  autoReleased += rel.released;
  skipped += rel.failed;

  // ── Serious offer reply clock: she replied → the hold lives to the deposit window (runs before the expiry below).
  await extendRepliedHolds(now).catch((err: any) => logger.warn({ error: err.message }, "serious offer clock extension failed"));

  // ── Deposit re-auth (§5): authorized holds older than the re-auth day, not yet re-authed,
  //    still inside the window.
  const reauthCutoff = new Date(now.getTime() - PAYMENTS.depositReauthAfterDays * DAY_MS);
  const toReauth = await db.select({ id: payments.id }).from(payments).where(and(
    eq(payments.kind, "deposit"),
    eq(payments.status, "authorized"),
    eq(payments.reauth_count, 0),
    lte(payments.created_at, reauthCutoff),
    gt(payments.expires_at, now),
  ));
  for (const row of toReauth) {
    try { if (await reauthorizeDeposit(row.id)) reauthed++; }
    catch (err: any) { skipped++; logger.warn({ paymentId: row.id, error: err.message }, "deposit re-auth failed"); }
  }

  // ── Deposit expiry (§5): window elapsed with no accept/decline → release the hold.
  //    By payment id: a Serious-offer hold on a request that was never confirmed has no deal.
  const toExpire = await db.select({ id: payments.id, requestId: payments.partner_request_id }).from(payments).where(and(
    eq(payments.kind, "deposit"),
    inArray(payments.status, ["authorized", "reauthorized"]),
    lte(payments.expires_at, now),
  ));
  for (const row of toExpire) {
    try {
      if (await releaseDepositPayment(row.id, "expired")) {
        expired++;
        if (row.requestId) await notifyHoldReleased(row.requestId, row.id).catch((err: any) => logger.warn({ paymentId: row.id, error: err.message }, "hold-released notice failed"));
      }
    }
    catch (err: any) { skipped++; logger.warn({ paymentId: row.id, error: err.message }, "deposit expiry release failed"); }
  }

  logger.info({ releaseFailed: rel.failed, autoReleased, reauthed, expired, skipped }, "payments cron complete");
  return { autoReleased, reauthed, expired, skipped };
}
