/**
 * gmailBackfill.ts — Initial 90-day inbox scan after Gmail connection.
 *
 * Triggered once from oauthCallback.ts (fire-and-forget) when a new Gmail
 * account is connected. Fetches up to 1000 messages from the last 90 days —
 * her inbox (all tabs) AND her sent mail — paginates with nextPageToken, and runs
 * each through the full detectDeal pipeline, OLDEST FIRST.
 *
 * Why sent and oldest-first (12 Oct 2026): her own replies were never read, so every
 * thread she had already answered outside the app read "your move". And newest-first
 * meant a thread's latest short reply ("Sounds good!") was classified alone, before the
 * pitch it answers existed as a thread, and dropped. Oldest-first, the pitch creates the
 * thread and every later message — hers included — lands on it.
 *
 * A message the classifier could not judge (retryable) or that threw is dead-lettered,
 * so the cron retries it; it used to be counted as skipped and lost for good.
 */

import { createLogger } from "../logger";
import { db } from "../db";
import { connectedAccounts, gmailDeadLetters } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { fetchBackfillMessages } from "../lib/integrations/gmail";
import { detectDeal } from "./dealDetector";

const logger = createLogger("skills/gmailBackfill");

const WINDOW_DAYS  = 90;
const MAX_MESSAGES = 1000;
/** Her sent mail read at connect, on its own cap. */
const MAX_SENT_MESSAGES = 500;

export interface BackfillResult {
  processed: number;
  detected:  number;
  skipped:   number;
  errored:   number;
}

export async function runGmailBackfill(params: {
  connectionId: string;
  athleteId:    string;
  windowDays?:  number;
}): Promise<BackfillResult> {
  const { connectionId, athleteId, windowDays = WINDOW_DAYS } = params;
  const t0 = Date.now();

  const afterUnixSeconds = Math.floor((Date.now() - windowDays * 86_400_000) / 1000);

  logger.info({ athleteId, connectionId, windowDays, afterUnixSeconds }, "Gmail backfill starting");

  // fetchBackfillMessages throws if a page fails after retries — that propagates so
  // last_fetched_at stays NULL and the cron re-runs the full backfill next time.
  // Inbox and Sent each have their own cap (a busy Sent folder never crowds brand mail out), then one list,
  // OLDEST FIRST. A Sent list that fails leaves the inbox backfill to run on its own.
  const inbox = await fetchBackfillMessages(connectionId, afterUnixSeconds, MAX_MESSAGES, { folder: "inbox" });
  const sent = await fetchBackfillMessages(connectionId, afterUnixSeconds, MAX_SENT_MESSAGES, { folder: "sent" }).catch((err: any) => {
    logger.warn({ athleteId, connectionId, error: err?.message }, "Gmail backfill: Sent list failed — inbox only");
    return [];
  });
  const seen = new Set<string>();
  const messages = [...inbox, ...sent]
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))   // a message in both lists runs once
    .sort((x, y) => (Date.parse(x.date) || 0) - (Date.parse(y.date) || 0));

  logger.info({ athleteId, connectionId, count: messages.length }, "Gmail backfill: messages fetched, running detection");

  const result: BackfillResult = { processed: 0, detected: 0, skipped: 0, errored: 0 };

  for (const message of messages) {
    result.processed++;
    try {
      const r = await detectDeal({
        athleteId,
        connectionId,
        message: {
          gmailMessageId:  message.id,
          gmailThreadId:   message.threadId,
          subject:         message.subject,
          from:            message.from,
          body:            message.body,
          date:            message.date,
          messageIdHeader: message.messageIdHeader,
          labelIds:        message.labelIds,
          inReplyToHeader: message.inReplyToHeader,
          attachmentText:  message.attachmentText,
          attachments:     message.attachments,
          calendar:        message.calendar ?? null,
        },
      });
      if (r.retryable) {
        result.errored++;
        await deadLetter(connectionId, athleteId, message.id, r.reason ?? "retryable");
      } else if (r.skipped) result.skipped++;
      else           result.detected++;
    } catch (err: any) {
      result.errored++;
      logger.error({ athleteId, messageId: message.id, error: err.message }, "Gmail backfill: detectDeal threw");
      await deadLetter(connectionId, athleteId, message.id, String(err?.message ?? "threw"));
    }
  }

  // Mark the connection as having completed its initial scan. syncRecent keys off
  // this: a NULL last_fetched_at means "backfill never finished — retry it", so a
  // backfill that threw mid-scan (and never reached here) gets re-attempted.
  //
  // A failed Sent list still closes the scan (review #991): leaving it open re-ran the whole inbox scan on every poll
  // while Sent kept failing, and only RECORDED messages stop at detectDeal's idempotency gate — every message filed
  // as noise or below threshold is never recorded, so each re-run paid the classifier again for up to MAX_MESSAGES
  // of them. Reading Sent later needs a Sent-only resume with its own marker, not a full re-scan.
  await db
    .update(connectedAccounts)
    .set({ last_fetched_at: new Date() })
    .where(eq(connectedAccounts.id, connectionId));

  const durationMs = Date.now() - t0;
  logger.info({ athleteId, connectionId, ...result, durationMs }, "Gmail backfill complete");

  return result;
}

/** Queue a message the backfill could not judge for the cron's dead-letter retry. Never throws. */
async function deadLetter(connectionId: string, athleteId: string, gmailMessageId: string, error: string): Promise<void> {
  await db.insert(gmailDeadLetters)
    .values({ connected_account_id: connectionId, athlete_id: athleteId, gmail_message_id: gmailMessageId, error: error.slice(0, 500) })
    .onConflictDoNothing()
    .catch((err: any) => logger.error({ connectionId, err: err?.message }, "Gmail backfill: dead-letter write failed"));
}
