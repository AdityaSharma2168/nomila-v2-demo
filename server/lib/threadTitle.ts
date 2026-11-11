/**
 * threadTitle.ts — the title Nomila writes for a conversation (approved decision 2).
 *
 * Under MAILBOX_ZERO_RETENTION no subject line is stored, so anything that used to show or
 * hand on a thread's subject shows this instead: the brand (advertiser, else the brand the
 * classifier named, else the deal's brand) and the stage Nomila observed. Derived from
 * Nomila's own state only — never from mail text.
 */

import { getTableColumns, sql } from "drizzle-orm";
import { inboxThreads } from "../../shared/schema";
import { observedStageOf } from "./observedStage";
import { mailboxZeroRetentionEnabled } from "./mailbox/retention";

const STAGE_LABEL: Record<string, string> = {
  outreach:    "New outreach",
  negotiating: "Negotiating",
  agreed:      "Agreed",
  signed:      "Signing",
  declined:    "Declined",
};

const CATEGORY_LABEL: Record<string, string> = {
  PAID:       "Paid offer",
  MEDIA:      "Media request",
  EDITORIAL:  "Product review",
  GIFTING:    "Gifting",
  SCHOOL_NIL: "School NIL",
  FAN:        "Message",
  NOISE:      "Message",
};

export function derivedThreadTitle(input: {
  brandName?:         string | null;
  classification?:    unknown;
  conversationState?: unknown;
}): string {
  const c = (input.classification ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const brand = str(c.advertiser) ?? str(c.brand_name) ?? str(input.brandName) ?? null;
  const stage = observedStageOf(input.conversationState);
  const what = (stage && STAGE_LABEL[stage]) ?? CATEGORY_LABEL[String(c.category ?? "")] ?? "Conversation";
  return brand ? `${brand} · ${what}` : what;
}

/**
 * Every inbox_threads column, for a route that selects (or returns) the whole row — except
 * that under MAILBOX_ZERO_RETENTION the stored subject is not read at all (NULL in its place).
 * Flag off: exactly the full row.
 */
export function threadColumns() {
  const cols = getTableColumns(inboxThreads);
  return mailboxZeroRetentionEnabled() ? { ...cols, subject: sql<string | null>`NULL`.as("subject") } : cols;
}

/**
 * A thread row as a route sends it. With MAILBOX_ZERO_RETENTION on, the stored subject is
 * never sent (a legacy row may still hold one until the purge) — `subject` is null and
 * `title` carries the Nomila-written title. Flag off: the row exactly as before.
 */
export function presentThread<T extends { subject?: string | null; classification?: unknown; conversation_state?: unknown }>(
  row: T,
  brandName?: string | null,
): T & { title?: string } {
  if (!row || !mailboxZeroRetentionEnabled()) return row;
  return {
    ...row,
    subject: null,
    title: derivedThreadTitle({ brandName, classification: row.classification, conversationState: row.conversation_state }),
  };
}
