/**
 * inboxCronSync.ts — Periodic polling fallback for all inbox providers.
 *
 * Push/webhook delivery is the primary mechanism per provider. This runs on a
 * schedule to catch anything dropped. Each provider's syncRecent() deduplicates
 * via detectDeal (thread_id, external_message_id) so re-processing is safe.
 *
 * Loops every provider registered in INBOX — no per-platform code here.
 *
 * Returns a per-platform summary so the Cloud Scheduler endpoint can report what a tick
 * actually did instead of "started". A run that touched nothing and a run that failed on
 * every connection used to look identical from outside.
 *
 * Outlook with OUTLOOK_PUSH on: Graph change notifications run the same syncRecent within seconds,
 * so this poll becomes a DAILY backstop per Outlook connection — it skips a connection whose push
 * subscription is healthy and whose delta ran in the last 23 h (outlookPush.pushCoveredConnectionIds).
 * With the flag off nothing is skipped and the 6h poll is exactly as before.
 *
 * Callers must hold LOCK_INBOX_SYNC (server/lib/pgAdvisoryLock.ts) — this is not safe to
 * run concurrently with itself across Cloud Run instances.
 */

import { db } from "../db";
import { connectedAccounts } from "../../shared/schema";
import { and, eq } from "drizzle-orm";
import { INBOX } from "../lib/integrations/registry";
import { pushCoveredConnectionIds } from "../lib/integrations/outlookPush";
import { createLogger } from "../logger";

const logger = createLogger("skills/inboxCronSync");

export interface InboxCronPlatformResult {
  platform:    string;
  connections: number;
  detected:    number;
  skipped:     number;
  /** Connections whose syncRecent threw. The tick continues past them. */
  failed:      number;
  /** Outlook connections skipped because push covers them (OUTLOOK_PUSH); always 0 with the flag off. */
  deferred:    number;
}

export interface InboxCronSyncResult {
  platforms:   InboxCronPlatformResult[];
  connections: number;
  detected:    number;
  skipped:     number;
  failed:      number;
  /** True when the wall-clock budget stopped the run early; the next tick resumes. */
  budgetHit:   boolean;
}

export async function runInboxCronSync(opts: { budgetMs?: number } = {}): Promise<InboxCronSyncResult> {
  const { budgetMs } = opts;
  const started = Date.now();
  const overBudget = () => budgetMs != null && Date.now() - started > budgetMs;

  const platforms: InboxCronPlatformResult[] = [];
  let budgetHit = false;

  for (const [platform, provider] of Object.entries(INBOX)) {
    const connections = await db
      .select({ id: connectedAccounts.id, athlete_id: connectedAccounts.athlete_id })
      .from(connectedAccounts)
      .where(and(
        eq(connectedAccounts.platform, platform),
        eq(connectedAccounts.status,   "active"),
      ));

    logger.info({ platform, count: connections.length }, "Inbox cron sync starting");

    const tally: InboxCronPlatformResult = {
      platform, connections: connections.length, detected: 0, skipped: 0, failed: 0, deferred: 0,
    };

    // Empty (and no query) unless OUTLOOK_PUSH is on.
    const pushCovered = platform === "outlook" ? await pushCoveredConnectionIds() : new Set<string>();

    for (const conn of connections) {
      // Stop cleanly at the budget rather than being killed mid-connection by the
      // request timeout. Every provider's syncRecent is idempotent (detectDeal dedupes
      // on thread_id + external_message_id), so the next tick picks up where this left off.
      if (overBudget()) {
        budgetHit = true;
        logger.warn({ platform, budgetMs }, "Inbox cron sync: wall-clock budget hit — next tick resumes");
        break;
      }
      if (pushCovered.has(conn.id)) {
        tally.deferred++;
        continue;
      }
      try {
        const r = await provider.syncRecent(conn.id, conn.athlete_id);
        tally.detected += r.detected;
        tally.skipped  += r.skipped;
        logger.debug({ platform, connectionId: conn.id, ...r }, "Inbox cron: connection synced");
      } catch (err: any) {
        tally.failed++;
        logger.warn({ platform, connectionId: conn.id, error: err.message }, "Inbox cron: connection sync failed");
      }
    }

    platforms.push(tally);
    logger.info({ ...tally }, "Inbox cron sync complete");
    if (budgetHit) break;
  }

  return {
    platforms,
    connections: platforms.reduce((n, p) => n + p.connections, 0),
    detected:    platforms.reduce((n, p) => n + p.detected,    0),
    skipped:     platforms.reduce((n, p) => n + p.skipped,     0),
    failed:      platforms.reduce((n, p) => n + p.failed,      0),
    budgetHit,
  };
}
