/**
 * services/sendReplyApproval.ts — THE approve path of a pending send_reply (a reply to a brand): the one governed send.
 *
 * Moved out of routes/pendingActions.ts (POST /pending-actions/:id/approve) unchanged, so that the athlete's spoken
 * "send it" in a voice call (voice/oneMila/confirm.ts confirm_by_voice, ordinary replies only) goes through exactly the
 * same checks and the same at-most-once claim as her tap. The route still owns the request: it reads the row, refuses
 * a handled or expired one, routes an agent_action to approvals.ts, then calls this for a send_reply.
 *
 * In order, as before:
 *   body hash      REQUIRED: the hash of the body she approved must equal the stored body's (400 / 409)
 *   ask-terms      a batch row also needs `reviewed: true` (409)
 *   kind           only send_reply (400)
 *   Draft replies  a reply Mila drafted goes out only while the capability is still on (tapRefusal): turned off since,
 *                  the row is declined and nothing sends (409); a failed check refuses without declining (503)
 *   claim          pending → approved, conditionally (still pending AND the stored body still hashes to the approved
 *                  one), before anything leaves (409 when another approve won, BODY_MISMATCH when the body changed)
 *   send           sendThreadReply on the claimed row's thread; a throw still ends the row
 *   settle         sent: executed_at + result { sent: true } (+ mode "voice" for a spoken confirm), zero retention,
 *                  D4 agree-on-accept; failed: status failed with the error
 *
 * `mode` is the only addition: "voice" marks the receipt (result.mode), so the record says the athlete confirmed out
 * loud in a call, and the call's transcript turn is the proof. The tap path's result is unchanged ({ sent: true }).
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { pendingActions } from "../../shared/schema";
import { bodySha256 } from "../../shared/bodyHash";
import { mailboxZeroRetentionEnabled } from "../lib/mailbox/retention";
import { retiredPayload } from "./mailboxRetentionSweep";
import { sendThreadReply, type ThreadReplyResult } from "./threadReply";
import { tapRefusal } from "../agent/welcome/toolGate";
import { agreeOnAcceptSend, sentReplyIntent } from "../skills/dealAgree";
import { createLogger } from "../logger";

const logger = createLogger("services/sendReplyApproval");

/** How askTerms.ts marks the proposals it composes in bulk (payload.source). */
export const ASK_TERMS_SOURCE = "ask_terms_batch";

export type PendingRow = typeof pendingActions.$inferSelect;

/** What the approve answers: the HTTP status and the JSON body, exactly as the route sends them. */
export interface ApproveOutcome { status: number; body: Record<string, unknown> }

export interface ApproveInput {
  /** The hash of the body the athlete approved (the app's, or the server's own for a spoken confirm). */
  bodySha256: unknown;
  /** An ask-terms batch row: the athlete opened and read this message. */
  reviewed?: unknown;
  /** Who approved: her tap (default) or her spoken "send it" in a voice call (ordinary replies only). */
  mode?: "tap" | "voice";
  /** mode "voice": what the server relied on (voice/oneMila/confirm.ts), kept on the receipt. */
  voice?: { call: string; turnId: string; transcriptMessageId: string; readBackTurnId: string };
}

/**
 * Approve one pending send_reply row `pa` (already read for this athlete, pending and unexpired) and send it, once.
 * Never throws for an expected refusal or a failed send: the outcome carries the status and body.
 */
export async function approveSendReply(athleteId: string, pa: PendingRow, input: ApproveInput): Promise<ApproveOutcome> {
  const id = pa.id;
  // APPROVED BODY = SENT BODY. The client hashes the body it displayed; we re-hash the
  // stored payload.body — the exact string that would send. A mismatch means the athlete
  // approved something other than what is on the row (an edit elsewhere, a stale screen),
  // so refuse with 409 and let the client reload. The hash is REQUIRED (12 Oct 2026):
  // every app build since 6 Oct sends it, and an approve that can't say which body it
  // approved is not her tap on that body.
  const body_sha256 = input.bodySha256;
  const storedBody = String((pa.payload as any)?.body ?? "");
  if (body_sha256 === undefined || body_sha256 === null || body_sha256 === "") {
    logger.warn({ athleteId, pendingActionId: id }, "Approve refused: no body_sha256");
    return { status: 400, body: { error: "Open this message and approve it from the app before it sends.", code: "BODY_HASH_REQUIRED" } };
  } else if (typeof body_sha256 !== "string" || body_sha256.toLowerCase() !== bodySha256(storedBody)) {
    logger.warn({ athleteId, pendingActionId: id }, "Approve refused: body_sha256 does not match the stored body");
    return { status: 409, body: { error: "This message changed since you reviewed it. Reload and check it before sending.", code: "BODY_MISMATCH" } };
  }

  // EACH BATCH MESSAGE IS ITS OWN REVIEW. An ask-terms batch row goes out only when the
  // athlete opened that row, read its exact body and approved it there; the client says so
  // with `reviewed: true`. A batch approve without it (e.g. an older build's one-tap "send
  // all") is refused before anything is claimed. Narrow on purpose: other rows are unaffected.
  const isAskTermsRow = (pa.payload as any)?.source === ASK_TERMS_SOURCE;
  if (isAskTermsRow && input.reviewed !== true) {
    logger.warn({ athleteId, pendingActionId: id }, "Approve refused: ask-terms row approved without reviewed: true");
    return { status: 409, body: { error: "Open this message and approve it before it sends.", code: "NOT_REVIEWED" } };
  }

  if (pa.kind !== "send_reply") {
    // Unreachable while send_reply is the only kind; guards a future kind slipping through.
    return { status: 400, body: { error: `Unsupported pending-action kind: ${pa.kind}` } };
  }

  // A reply MILA drafted (deals_draft_reply, payload.drafted_by "mila") goes out only while Draft replies is still on,
  // as an agent card's tap re-checks its capability (approvals.ts executeAgentAction): turned off or paused since it
  // was drafted, the row is declined and nothing is sent. A failed check refuses without declining, so she can retry.
  // Her own replies and ask-terms rows are not Mila's drafts and are not gated. Transparent while MILA_WELCOME is off.
  if ((pa.payload as any)?.drafted_by === "mila") {
    let off: string | null;
    try { off = await tapRefusal(athleteId, "deals_draft_reply"); }
    catch (err: any) {
      logger.warn({ athleteId, pendingActionId: id, err: err?.message }, "Approve refused: capability check failed");
      return { status: 503, body: { error: "We couldn't check this is still turned on, so nothing was sent. Try again in a moment.", code: "check_failed" } };
    }
    if (off) {
      const [declined] = await db
        .update(pendingActions)
        .set({
          status: "dismissed",
          dismissed_at: new Date(),
          error: `capability_off: ${off}`.slice(0, 500),
          ...(mailboxZeroRetentionEnabled() ? { payload: retiredPayload(pa.payload as Record<string, unknown>) } : {}),
        })
        .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId), eq(pendingActions.status, "pending")))
        .returning();
      if (!declined) return { status: 409, body: { error: "Pending action is already being approved" } };
      logger.info({ athleteId, pendingActionId: id }, "Approve declined: Draft replies turned off since it was drafted");
      return { status: 409, body: { error: off, code: "capability_off", pending_action: declined } };
    }
  }

  const now = new Date();

  // CLAIM the row before anything leaves: pending → approved, only if it is STILL
  // pending. Two concurrent approves can both pass the read above, but only one UPDATE
  // matches `status = 'pending'`; the other gets no row back and never sends. The
  // winner holds an `approved` row whose executed_at stays null until the send settles.
  const [claimed] = await db
    .update(pendingActions)
    .set({
      status:      "approved",
      approved_at: now,
      // Record WHEN the athlete reviewed an ask-terms row. Merged in SQL (jsonb ||) so the
      // claim never rewrites the rest of the stored payload, body included.
      ...(isAskTermsRow
        ? { payload: sql`${pendingActions.payload} || jsonb_build_object('reviewed_at', ${now.toISOString()}::text)` }
        : {}),
    })
    .where(and(
      eq(pendingActions.id, id),
      eq(pendingActions.athlete_id, athleteId),
      eq(pendingActions.status, "pending"),
      // The body approved is the body claimed: an edit that landed after the read above cannot be claimed and sent.
      sql`encode(sha256(convert_to(COALESCE(${pendingActions.payload}->>'body', ''), 'UTF8')), 'hex') = ${bodySha256(storedBody)}`,
    ))
    .returning();
  if (!claimed) {
    const [now2] = await db.select({ status: pendingActions.status, payload: pendingActions.payload }).from(pendingActions)
      .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId))).limit(1);
    if (now2?.status === "pending" && bodySha256(String((now2.payload as any)?.body ?? "")) !== bodySha256(storedBody)) {
      logger.warn({ athleteId, pendingActionId: id }, "Approve refused: the body changed before the claim");
      return { status: 409, body: { error: "This message changed since you reviewed it. Reload and check it before sending.", code: "BODY_MISMATCH" } };
    }
    return { status: 409, body: { error: "Pending action is already being approved" } };
  }

  if (!claimed.thread_id) {
    // Should never happen — create enforces it — but never send blind.
    const [failed] = await db
      .update(pendingActions)
      .set({ status: "failed", executed_at: now, error: "No thread to reply to" })
      .where(eq(pendingActions.id, id))
      .returning();
    return { status: 400, body: { error: "No thread to reply to", pending_action: failed } };
  }

  const body = String((claimed.payload as any)?.body ?? "");
  // D4: what this reply does, read before the send (a successful send clears the saved draft it may match).
  const sentIntent = await sentReplyIntent(athleteId, claimed.thread_id, (claimed.payload ?? {}) as Record<string, unknown>);
  let result: ThreadReplyResult;
  try {
    result = await sendThreadReply(athleteId, claimed.thread_id, body);
  } catch (err: any) {
    // Expected failures come back as a result; an unexpected throw must still move
    // the claimed row to a terminal state instead of stranding it un-executed.
    logger.error({ err, athleteId, pendingActionId: id }, "Pending action send threw");
    result = { ok: false, status: 500, error: "Couldn't send your reply. Please try again." };
  }

  if (result.ok) {
    // Zero retention (decision 5): once sent, the text lives in the mailbox's Sent folder.
    // Keep its hash and the sent Message-ID as the audit record, drop the body.
    const [approved] = await db
      .update(pendingActions)
      .set({
        executed_at: new Date(),
        result: input.mode === "voice" ? { sent: true, mode: "voice", ...(input.voice ? { voice: input.voice } : {}) } : { sent: true },
        error: null,
        ...(mailboxZeroRetentionEnabled()
          ? { payload: retiredPayload(claimed.payload as Record<string, unknown>, { sentMessageId: result.sentMessageId ?? null }) }
          : {}),
      })
      .where(eq(pendingActions.id, id))
      .returning();
    logger.info({ athleteId, pendingActionId: id, threadId: claimed.thread_id, mode: input.mode ?? "tap" }, "Pending action approved + executed");
    // D4 (DEALS_AGREE_ON_ACCEPT): her sent "yes" moves the deal to Agreed, with an Undo receipt. Never throws.
    const agreed = await agreeOnAcceptSend({
      athleteId, dealId: claimed.deal_id, threadId: claimed.thread_id, pendingActionId: id, intent: sentIntent,
    });
    return { status: 200, body: agreed ? { ...approved, deal_agreed: true } : (approved as unknown as Record<string, unknown>) };
  }

  // Approved, but the underlying send errored → terminal 'failed' (unchanged
  // semantics). Retry = a fresh proposal, which every approving client makes per tap
  // (keeps at-most-once; the draft is cheap to recompose).
  const [failed] = await db
    .update(pendingActions)
    .set({ status: "failed", executed_at: new Date(), error: result.error })
    .where(eq(pendingActions.id, id))
    .returning();
  logger.warn({ athleteId, pendingActionId: id, status: result.status, err: result.error }, "Pending action approved but send failed");
  const payload: Record<string, unknown> = { error: result.error, pending_action: failed };
  if (result.code) payload.code = result.code;
  if (result.legacy_code) payload.legacy_code = result.legacy_code;
  if (result.inbox) payload.inbox = result.inbox;
  return { status: result.status, body: payload };
}
