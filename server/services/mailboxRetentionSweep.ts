/**
 * mailboxRetentionSweep.ts — reply text Nomila composed is kept only while it is useful
 * (approved decisions 5–6, "Mailbox Owns Correspondence" §7). MAILBOX_ZERO_RETENTION only.
 *
 * pending_actions (send_reply). The body is needed while the action is PENDING: approve
 * re-hashes payload.body against what the athlete reviewed (#771). After that:
 *   - sent (approved + executed)  → body removed now (at approve), body_sha256 + the sent
 *                                   Message-ID kept: proof of what was approved and sent,
 *                                   checkable against the mailbox's Sent copy.
 *   - dismissed                   → body removed now (at dismiss), body_sha256 kept.
 *   - failed                      → body kept 7 days (a retry recomposes from it), then removed.
 *   - pending                     → expires 14 days after it was proposed (or at its own
 *                                   expires_at): moved to dismissed with result.expired = true,
 *                                   body removed. (The status check has no 'expired' value;
 *                                   approve already refuses an expired row.)
 * inbox_threads.latest_draft → deleted 30 days after the last edit (saved_at, else
 *   generated_at, else the thread's last activity), or as soon as the thread's opportunity
 *   is closed. Only Nomila's copy: a native Gmail draft the athlete mirrored is hers, in her
 *   mailbox, and is left alone.
 *
 * Runs daily inside the existing archive-stale-cron (no new scheduler). Every step is one
 * UPDATE that computes body_sha256 in SQL before dropping the key — no reply text is read
 * into this process. Never touches a row whose send is still settling (approved, not executed).
 */

import { sql, type SQL } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { bodySha256 } from "../../shared/bodyHash";
import { mailboxZeroRetentionEnabled } from "../lib/mailbox/retention";
import { createLogger } from "../logger";

const logger = createLogger("services/mailboxRetentionSweep");

export const PENDING_TTL_DAYS = 14;
export const FAILED_KEEP_DAYS = 7;
export const DRAFT_TTL_DAYS   = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * payload minus its body, plus body_sha256 computed IN SQL from that body (SHA-256 over its
 * UTF-8 bytes, lowercase hex — the same function as shared/bodyHash.ts). A body_sha256 already
 * on the payload is kept.
 */
const STRIPPED_PAYLOAD: SQL = sql`(payload - 'body') || jsonb_build_object(
  'body_sha256', coalesce(payload ->> 'body_sha256', encode(sha256(convert_to(payload ->> 'body', 'UTF8')), 'hex')),
  'body_removed_at', now()::text
)`;

/**
 * The payload an approve / dismiss writes back under zero retention: no body; its hash and
 * (when the provider gave one) the sent message's id. Computed in JS from the body the
 * route already holds.
 */
export function retiredPayload(
  payload: Record<string, unknown> | null | undefined,
  opts: { sentMessageId?: string | null } = {},
): Record<string, unknown> {
  const p = { ...(payload ?? {}) };
  const body = typeof p.body === "string" ? p.body : null;
  delete p.body;
  return {
    ...p,
    ...(body != null && typeof p.body_sha256 !== "string" ? { body_sha256: bodySha256(body) } : {}),
    ...(opts.sentMessageId ? { sent_message_id: opts.sentMessageId } : {}),
    body_removed_at: new Date().toISOString(),
  };
}

export interface RetentionSweepResult {
  ran:              boolean;
  expiredPending:   number;
  strippedFailed:   number;
  strippedSettled:  number;
  draftsDeleted:    number;
}

function count(res: unknown): number {
  return Number((res as any)?.rowCount ?? (res as any)?.affectedRows ?? 0);
}

/** One daily pass. A no-op (ran: false) unless MAILBOX_ZERO_RETENTION is in effect. */
export async function sweepMailboxRetention(
  opts: { now?: Date; dbx?: any; force?: boolean } = {},
): Promise<RetentionSweepResult> {
  const none = { ran: false, expiredPending: 0, strippedFailed: 0, strippedSettled: 0, draftsDeleted: 0 };
  if (!opts.force && !mailboxZeroRetentionEnabled()) return none;
  const dbx = opts.dbx ?? defaultDb;
  const now = opts.now ?? new Date();
  const pendingCutoff = new Date(now.getTime() - PENDING_TTL_DAYS * DAY_MS).toISOString();
  const failedCutoff  = new Date(now.getTime() - FAILED_KEEP_DAYS * DAY_MS).toISOString();
  const draftCutoff   = new Date(now.getTime() - DRAFT_TTL_DAYS * DAY_MS).toISOString();
  const nowIso = now.toISOString();

  // 1. Stale pending proposals expire.
  const expired = await dbx.execute(sql`
    update pending_actions
       set status = 'dismissed',
           dismissed_at = ${nowIso}::timestamptz,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object('expired', true),
           payload = case when payload ? 'body' then ${STRIPPED_PAYLOAD} else payload end
     where status = 'pending'
       and (expires_at < ${nowIso}::timestamptz
            or (expires_at is null and created_at < ${pendingCutoff}::timestamptz))
  `);

  // 2. Failed sends keep their text 7 days for a retry, then lose it.
  const failed = await dbx.execute(sql`
    update pending_actions
       set payload = ${STRIPPED_PAYLOAD}
     where status = 'failed'
       and payload ? 'body'
       and coalesce(executed_at, approved_at, created_at) < ${failedCutoff}::timestamptz
  `);

  // 3. Backstop for sent / dismissed rows that still carry a body (written before the flag,
  //    or a write-back that failed). An approved row whose send has not settled is skipped.
  const settled = await dbx.execute(sql`
    update pending_actions
       set payload = ${STRIPPED_PAYLOAD}
     where payload ? 'body'
       and ((status = 'approved' and executed_at is not null) or status = 'dismissed')
  `);

  // 4. Drafts: 30 days without an edit, or the thread's opportunity is closed.
  const drafts = await dbx.execute(sql`
    update inbox_threads t
       set latest_draft = null
     where t.latest_draft is not null
       and (
         coalesce(
           case when (t.latest_draft ->> 'saved_at') ~ '^\\d{4}-\\d{2}-\\d{2}T' then (t.latest_draft ->> 'saved_at')::timestamptz end,
           case when (t.latest_draft ->> 'generated_at') ~ '^\\d{4}-\\d{2}-\\d{2}T' then (t.latest_draft ->> 'generated_at')::timestamptz end,
           t.last_message_at,
           t.created_at
         ) < ${draftCutoff}::timestamptz
         or exists (
           select 1 from deals d join opportunities o on o.id = d.opportunity_id
            where d.id = t.deal_id and o.status = 'closed'
         )
       )
  `);

  const result = {
    ran: true,
    expiredPending:  count(expired),
    strippedFailed:  count(failed),
    strippedSettled: count(settled),
    draftsDeleted:   count(drafts),
  };
  logger.info(result, "Mailbox retention sweep");
  return result;
}
