/**
 * conversationBranch.ts — a NEW subject inside an old conversation (docs/design/brand-page-deals.md D6).
 *
 * The In-Reply-To gate in dealDetector used to fold any new provider thread whose parent message was known into
 * the parent's thread. That is right for the dual-inbox case (the same mail seen from a second mailbox) and
 * wrong when she — or the brand — starts a new subject by replying inside an old conversation: gorjana's
 * ThetaBreakers pitch was folded into the signed endorsement that way.
 *
 * THE SIGNAL respects zero retention: no subject is stored or compared. The parent message is in the SAME
 * mailbox (connected_account_id matches) and the provider still started a NEW thread id for this reply. Gmail
 * and Outlook keep a reply in its thread unless the subject changed, so within one mailbox that is the
 * new-subject signal. A different mailbox stays the dual-inbox alias, as before.
 *
 * THE DECISION is the existing same-engagement partition (dealGrouping.partitionOrNull) over the parent
 * opportunity's deals, with the incoming message held IN MEMORY as the row's summary (subject + opening of the
 * body — the same content the classifier already reads). Doubt, a failed call, or a parent with no deal means
 * SAME (alias, today's behaviour). Only the decision is stored: `classification.branch` on the new thread
 * (separate) or `classification.branches[<chain>]` on the parent (same) — never the subject.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { connectedAccounts, deals, inboxThreads } from "../../shared/schema";
import { inArray, sql } from "drizzle-orm";
import { partitionOrNull, type GroupRow } from "./dealGrouping";
import { createLogger } from "../logger";

const logger = createLogger("skills/conversationBranch");

export type BranchDecision = "same" | "separate";

const MAX_MEMBERS = 12;

/** Same mailbox + a new provider thread id + a known parent → the reply started a new subject. Pure. */
export function isNewSubjectBranch(p: { connectionId: string | null | undefined; parentConnectionId: string | null | undefined; parentHasDeal: boolean }): boolean {
  return !!p.parentHasDeal && !!p.connectionId && !!p.parentConnectionId && p.connectionId === p.parentConnectionId;
}

/** The incoming message as a partition row: in memory only, never written. */
export function incomingSummary(subject: string | null | undefined, body: string | null | undefined): string {
  return [String(subject ?? "").trim(), String(body ?? "").replace(/\s+/g, " ").trim().slice(0, 300)].filter(Boolean).join(" — ");
}

/** Same engagement as the parent's opportunity, or a separate one? Doubt means same. Never throws. */
export async function decideBranch(p: {
  athleteId: string;
  parentDealId: string;
  subject: string | null | undefined;
  body: string | null | undefined;
  now?: Date;
}): Promise<BranchDecision> {
  try {
    const [parent] = await db.select({ id: deals.id, opportunity_id: deals.opportunity_id, brand_name: deals.brand_name })
      .from(deals).where(and(eq(deals.id, p.parentDealId), eq(deals.athlete_id, p.athleteId))).limit(1);
    if (!parent) return "same";
    const cols = { id: deals.id, brand_name: deals.brand_name, detected_at: deals.detected_at, raw_data: deals.raw_data };
    const members: GroupRow[] = parent.opportunity_id
      ? await db.select(cols).from(deals)
          .where(and(eq(deals.athlete_id, p.athleteId), eq(deals.opportunity_id, parent.opportunity_id)))
          .orderBy(desc(deals.detected_at)).limit(MAX_MEMBERS)
      : await db.select(cols).from(deals).where(eq(deals.id, parent.id));
    if (!members.length) return "same";
    const self: GroupRow = { id: "__incoming__", brand_name: parent.brand_name, detected_at: p.now ?? new Date(), raw_data: { summary: incomingSummary(p.subject, p.body) } };
    const parts = await partitionOrNull([self, ...members]);
    if (!parts) return "same";
    const mine = parts.find((g) => g.some((r) => r.id === self.id)) ?? [];
    return mine.length === 1 ? "separate" : "same";
  } catch (e: any) {
    logger.warn({ err: e?.message }, "Branch decision failed — treated as the same engagement");
    return "same";
  }
}

/** Record a SAME decision on the parent thread (merge-only), keyed by the folded chain. Never the subject. */
export async function recordSameDecision(parentThreadId: string, chainId: string, now: Date = new Date()): Promise<void> {
  const patch = { [chainId]: { decision: "same", decided_at: now.toISOString() } };
  await db.update(inboxThreads)
    .set({ classification: sql`jsonb_set(coalesce(${inboxThreads.classification}, '{}'::jsonb), '{branches}', coalesce(${inboxThreads.classification} -> 'branches', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)` })
    .where(eq(inboxThreads.id, parentThreadId));
}

/** Her own mail: From is one of her connected inboxes, or it is SENT-only. */
export async function isOwnMessage(athleteId: string, senderEmail: string | null, labelIds: string[] | undefined): Promise<boolean> {
  const labels = labelIds ?? [];
  if (labels.includes("SENT") && !labels.includes("INBOX")) return true;
  if (!senderEmail) return false;
  const [own] = await db.select({ id: connectedAccounts.id }).from(connectedAccounts)
    .where(and(
      eq(connectedAccounts.athlete_id, athleteId),
      inArray(connectedAccounts.platform, ["gmail", "outlook"]),
      sql`lower(${connectedAccounts.platform_username}) = ${senderEmail.toLowerCase()}`,
    )).limit(1);
  return !!own;
}
