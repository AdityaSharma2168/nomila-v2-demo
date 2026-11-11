/**
 * partner/sweep.ts — the hourly housekeeping of the Partner door (POST /api/internal/partner-intake-cron).
 *
 *   expire     unconfirmed requests 72h after they were drafted (their Serious-offer holds share that clock in
 *              payments.expires_at, so the payments sweep releases them — no money moves here);
 *   redact     brand contact details 180 days after the deal's opportunity closed, and 7 days after an unconfirmed
 *              request expired (it never reached her; nothing needs them);
 *   prune      rate-counter windows and spent / expired email codes; the kept text of BLOCKED relay messages after 90 days
 *              (held ones wait for review; a blocked one never will be delivered).
 * Answers { skipped: true } while the flags are off.
 */
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { inboxMessages, partnerRequests, partnerVisitorCodes } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { PARTNER, partnerIntakeEnabled } from "./config";
import { pruneCounters } from "../../lib/publicRateCounters";
import { expireUnconfirmed } from "./requests";

const logger = createLogger("services/partner/sweep");
const EXPIRED_CONTACT_GRACE_MS = 7 * 86_400_000;

export interface PartnerSweepResult { skipped?: true; expired: number; redacted: number; counters: number; codes: number; blockedTexts: number }

export async function redactContacts(now: Date = new Date()): Promise<number> {
  const closedBefore = new Date(now.getTime() - PARTNER.contactRetentionMs);
  const expiredBefore = new Date(now.getTime() - EXPIRED_CONTACT_GRACE_MS);
  const rows = await db.update(partnerRequests)
    .set({ contact_name: null, contact_email: null, contact_redacted_at: now, updated_at: now })
    .where(and(isNull(partnerRequests.contact_redacted_at), or(
      and(eq(partnerRequests.status, "expired"), lt(partnerRequests.expires_at, expiredBefore)),
      inArray(partnerRequests.deal_id, sql`(SELECT d.id FROM deals d JOIN opportunities o ON o.id = d.opportunity_id
        WHERE o.status = 'closed' AND o.closed_at < ${closedBefore})`),
    )))
    .returning({ id: partnerRequests.id });
  return rows.length;
}

export async function pruneCodes(now: Date = new Date()): Promise<number> {
  const rows = await db.delete(partnerVisitorCodes)
    .where(lt(partnerVisitorCodes.expires_at, new Date(now.getTime() - 86_400_000)))
    .returning({ id: partnerVisitorCodes.id });
  return rows.length;
}

export async function pruneBlockedTexts(now: Date = new Date()): Promise<number> {
  const rows = await db.update(inboxMessages).set({ held_body: null })
    .where(and(eq(inboxMessages.platform, "nomila"), eq(inboxMessages.moderation, "blocked"), isNotNull(inboxMessages.held_body),
      lt(inboxMessages.received_at, new Date(now.getTime() - 90 * 86_400_000))))
    .returning({ id: inboxMessages.id });
  return rows.length;
}

export async function runPartnerSweep(now: Date = new Date()): Promise<PartnerSweepResult> {
  if (!partnerIntakeEnabled()) return { skipped: true, expired: 0, redacted: 0, counters: 0, codes: 0, blockedTexts: 0 };
  const expired = await expireUnconfirmed(now);
  const redacted = await redactContacts(now);
  const counters = await pruneCounters(now);
  const codes = await pruneCodes(now);
  const blockedTexts = await pruneBlockedTexts(now);
  logger.info({ expired, redacted, counters, codes, blockedTexts }, "partner intake sweep complete");
  return { expired, redacted, counters, codes, blockedTexts };
}
