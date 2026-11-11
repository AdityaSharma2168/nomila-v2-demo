/**
 * gmailWatchRenew.ts — Renew Gmail Pub/Sub watches before they expire.
 *
 * Gmail watches expire after 7 days. This function queries all active Gmail
 * connections and re-registers the watch for each, updating gmail_history_id.
 *
 * Called by:
 *   - POST /api/internal/gmail-watch-renew (Cloud Scheduler, every 6 days)
 *   - node-cron in index.ts (belt-and-suspenders, production only)
 */

import { db } from "../db";
import { connectedAccounts } from "../../shared/schema";
import { and, eq } from "drizzle-orm";
import { setupPushNotifications } from "./integrations/gmail";
import { createLogger } from "../logger";

const logger = createLogger("gmail-watch-renew");

export async function renewGmailWatches(): Promise<{ renewed: number; failed: number }> {
  const accounts = await db
    .select({ id: connectedAccounts.id, athlete_id: connectedAccounts.athlete_id, platform_username: connectedAccounts.platform_username })
    .from(connectedAccounts)
    .where(and(
      eq(connectedAccounts.platform, "gmail"),
      eq(connectedAccounts.status,   "active"),
    ));

  logger.info({ count: accounts.length }, "Gmail watch renewal: starting");

  let renewed = 0, failed = 0;

  for (const account of accounts) {
    // setupPushNotifications now returns whether the watch actually registered —
    // it used to swallow failures and always count "renewed" (N3).
    const ok = await setupPushNotifications(account.id).catch(() => false);
    if (ok) {
      renewed++;
      logger.info({ connectionId: account.id, email: account.platform_username }, "Gmail watch renewed");
    } else {
      failed++;
      logger.error({ event: "pipeline_failure", kind: "watch_renew", connectionId: account.id, email: account.platform_username }, "Gmail watch renewal failed");
    }
  }

  logger.info({ renewed, failed }, "Gmail watch renewal complete");
  return { renewed, failed };
}
