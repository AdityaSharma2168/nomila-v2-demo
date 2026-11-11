/**
 * pendingActions.ts — the co-pilot spine (WS3 §3.6).
 *
 * Mila PROPOSES an action; the athlete APPROVES it; only approval executes it.
 * Nothing here ever auto-sends — creating a pending action has no side effect on
 * the outside world. Approve runs the underlying action exactly once (at-most-once:
 * approve CLAIMS the row with a conditional `UPDATE … WHERE status = 'pending'` before
 * it sends, so of two concurrent approves only one gets the row and sends; the row
 * never returns to `pending`, whatever the outcome). Approve also checks `body_sha256`
 * against the stored body, so the text the athlete approved is the text that sends.
 * Dismiss cancels a proposal.
 *
 * Endpoints (mounted at /api/v1/me):
 *   POST /deals/:dealId/pending-actions   — create a proposal for a deal (no send)
 *   GET  /pending-actions                 — list this athlete's actions (?status, ?deal_id)
 *   POST /pending-actions/:id/approve      — approve → execute (send_reply → real reply path;
 *                                            agent_action → the agent harness's queued act tool, server/agent/approvals.ts)
 *                                            body: { body_sha256, reviewed? } (see shared/bodyHash.ts;
 *                                            body_sha256 is required for a send_reply;
 *                                            an ask-terms batch row also needs reviewed: true)
 *   PATCH /pending-actions/:id             — edit a pending agent_action's args (the draft) before the tap; body
 *                                            { args: {...} } merged over the stored args; never executes anything
 *   POST /pending-actions/:id/dismiss      — cancel a pending proposal
 */

import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { pendingActions, deals, inboxThreads } from "../../shared/schema";
import { requireAuth } from "../lib/auth";
import { approveSendReply } from "../services/sendReplyApproval";
import { mailboxZeroRetentionEnabled } from "../lib/mailbox/retention";
import { PENDING_TTL_DAYS, retiredPayload } from "../services/mailboxRetentionSweep";
import { createLogger } from "../logger";
import { AGENT_ACTION_KIND, ApprovalError, editAgentAction, executeAgentAction, settleRunApproval } from "../agent/approvals";
import { defaultRegistry } from "../agent/coreTools";
import { noteApprovalOutcome } from "../agent/engine/events";
import { resolveReplyThread, threadHoldingDraft } from "../lib/replyThread";

const logger = createLogger("routes/pendingActions");
const router = Router();

// v1 supports one verb. Extend this (and the schema check) as kinds are added.
const VALID_PENDING_KINDS = ["send_reply"] as const;
type PendingKind = typeof VALID_PENDING_KINDS[number];

const VALID_PENDING_STATUSES = ["pending", "approved", "dismissed", "failed"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─── POST /api/v1/me/deals/:dealId/pending-actions ────────────────────────────
// Mila proposes an action for a deal. Creates a row in `pending` — NO send.

router.post("/deals/:dealId/pending-actions", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const dealId    = req.params.dealId;

  const { kind, payload, thread_id, expires_at } = req.body as {
    kind?:       string;
    payload?:    unknown;
    thread_id?:  string;
    expires_at?: string;
  };

  if (!kind || !VALID_PENDING_KINDS.includes(kind as PendingKind)) {
    res.status(400).json({ error: `kind must be one of: ${VALID_PENDING_KINDS.join(", ")}` });
    return;
  }
  if (!isPlainObject(payload)) {
    res.status(400).json({ error: "payload must be an object" });
    return;
  }

  // Deal must belong to the caller.
  const [deal] = await db
    .select({ id: deals.id })
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
    .limit(1);
  if (!deal) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }

  // Resolve the target thread with the ONE reply-thread resolver the draft used
  // (lib/replyThread): an explicit thread_id must be hers AND this deal's; otherwise the
  // deal's thread the brand last wrote on. A draft can no longer quote one thread and
  // send on another.
  // A body that is exactly the draft written for one of this deal's threads goes out on THAT thread —
  // the one the draft quotes — even when a screen passes another thread id.
  const drafted = typeof (payload as any).body === "string" ? await threadHoldingDraft(athleteId, dealId, (payload as any).body) : null;
  if (drafted && thread_id && thread_id !== drafted) {
    logger.warn({ athleteId, dealId, requested: thread_id, drafted }, "Propose: thread_id differs from the draft's thread — sending on the draft's");
  }
  const resolved = drafted
    ? { ok: true as const, threadId: drafted }
    : await resolveReplyThread(athleteId, dealId, thread_id ?? null);
  if (!resolved.ok) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  const threadId: string | null = resolved.threadId;

  if (kind === "send_reply") {
    if (typeof (payload as any).body !== "string" || !(payload as any).body.trim()) {
      res.status(400).json({ error: "payload.body is required for a send_reply action" });
      return;
    }
    if (!threadId) {
      res.status(400).json({ error: "No thread to reply to for this deal" });
      return;
    }
  }

  let expiresAt: Date | null = null;
  if (expires_at !== undefined) {
    const d = new Date(expires_at);
    if (isNaN(d.getTime())) {
      res.status(400).json({ error: "expires_at must be an ISO timestamp" });
      return;
    }
    expiresAt = d;
  } else if (mailboxZeroRetentionEnabled()) {
    // Zero retention: a proposal holds reply text, so it is not kept forever (decision 5).
    expiresAt = new Date(Date.now() + PENDING_TTL_DAYS * 24 * 60 * 60 * 1000);
  }

  const [created] = await db
    .insert(pendingActions)
    .values({
      athlete_id: athleteId,
      deal_id:    dealId,
      thread_id:  threadId,
      kind,
      status:     "pending",
      payload:    payload as Record<string, unknown>,
      expires_at: expiresAt,
    })
    .returning();

  logger.info({ athleteId, dealId, pendingActionId: created.id, kind }, "Pending action created");
  res.status(201).json(created);
});

// ─── GET /api/v1/me/pending-actions ──────────────────────────────────────────
// The co-pilot queue — what's awaiting the athlete's approval (and history).

router.get("/pending-actions", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { status, deal_id } = req.query as Record<string, string>;

  const filters = [eq(pendingActions.athlete_id, athleteId)];
  if (status && VALID_PENDING_STATUSES.includes(status as typeof VALID_PENDING_STATUSES[number])) {
    filters.push(eq(pendingActions.status, status));
  }
  if (deal_id) {
    filters.push(eq(pendingActions.deal_id, deal_id));
  }

  const rows = await db
    .select()
    .from(pendingActions)
    .where(and(...filters))
    .orderBy(desc(pendingActions.created_at))
    .limit(100);

  res.json(rows);
});

// ─── PATCH /api/v1/me/pending-actions/:id ─────────────────────────────────────
// Edit a pending agent_action's draft (its args) before the tap. Saves only; nothing is sent or run here.

router.patch("/pending-actions/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { args } = (req.body ?? {}) as { args?: unknown };
  if (!isPlainObject(args) || Object.keys(args).length === 0) {
    res.status(400).json({ error: "args must be a non-empty object" });
    return;
  }
  try {
    res.json(await editAgentAction(athleteId, req.params.id, args, defaultRegistry()));
  } catch (err) {
    if (err instanceof ApprovalError) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  }
});

// ─── POST /api/v1/me/pending-actions/:id/approve ─────────────────────────────
// Approve → EXECUTE the underlying action, once. This is the only path that sends.

router.post("/pending-actions/:id/approve", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const id        = req.params.id;

  const [pa] = await db
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId)))
    .limit(1);

  if (!pa) {
    res.status(404).json({ error: "Pending action not found" });
    return;
  }
  if (pa.status !== "pending") {
    res.status(409).json({ error: `Pending action is already ${pa.status}` });
    return;
  }
  if (pa.expires_at && pa.expires_at.getTime() < Date.now()) {
    res.status(409).json({ error: "Pending action has expired" });
    return;
  }

  // An agent harness action (0105): her tap runs the act-level tool the agent queued, at most once (server/agent/approvals.ts).
  if (pa.kind === AGENT_ACTION_KIND) {
    try {
      const item = await executeAgentAction(athleteId, id, defaultRegistry());
      // MILA_TF_CHAT: Mila hears what her card became at the top of the athlete's next message (agent/engine/events.ts).
      await noteApprovalOutcome(athleteId, item, item.status === "failed" ? "failed" : "approved");
      res.status(item.status === "failed" ? 502 : 200).json(item);
    } catch (err) {
      if (err instanceof ApprovalError) {
        // Turned off since it was queued: the card is declined and nothing ran; Mila hears it like any other decline.
        if (err.code === "capability_off" && err.item) await noteApprovalOutcome(athleteId, err.item, "declined");
        res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.item ? { item: err.item } : {}) });
        return;
      }
      throw err;
    }
    return;
  }

  // A send_reply: the one governed send (services/sendReplyApproval.ts, shared with a spoken "send it" for an ordinary
  // reply in a voice call): the body hash, the ask-terms review, Draft replies still on, the claim, the send.
  const { body_sha256, reviewed } = (req.body ?? {}) as { body_sha256?: unknown; reviewed?: unknown };
  const out = await approveSendReply(athleteId, pa, { bodySha256: body_sha256, reviewed, mode: "tap" });
  res.status(out.status).json(out.body);
});

// ─── POST /api/v1/me/pending-actions/:id/dismiss ─────────────────────────────
// Cancel a pending proposal. Idempotency: only a `pending` action can be dismissed.

router.post("/pending-actions/:id/dismiss", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const id        = req.params.id;

  const [pa] = await db
    .select({ id: pendingActions.id, status: pendingActions.status, payload: pendingActions.payload, kind: pendingActions.kind })
    .from(pendingActions)
    .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId)))
    .limit(1);

  if (!pa) {
    res.status(404).json({ error: "Pending action not found" });
    return;
  }
  if (pa.status !== "pending") {
    res.status(409).json({ error: `Pending action is already ${pa.status}` });
    return;
  }

  // Zero retention (decision 5): a declined proposal keeps its hash, not its text.
  const [dismissed] = await db
    .update(pendingActions)
    .set({
      status: "dismissed",
      dismissed_at: new Date(),
      ...(mailboxZeroRetentionEnabled() ? { payload: retiredPayload(pa.payload as Record<string, unknown>) } : {}),
    })
    .where(eq(pendingActions.id, id))
    .returning();

  logger.info({ athleteId, pendingActionId: id }, "Pending action dismissed");
  // MILA_TF_CHAT: a declined card of Mila's is news for her next turn (agent/engine/events.ts). Read from the payload as it
  // was before the update (zero retention may have retired it).
  if (pa.kind === AGENT_ACTION_KIND) {
    const p = (pa.payload ?? {}) as { runId?: unknown; title?: unknown };
    const runId = typeof p.runId === "string" ? p.runId : null;
    await settleRunApproval(athleteId, runId);   // the run's approval_state: cancelled once every card is declined
    await noteApprovalOutcome(athleteId, { id, runId, title: String(p.title ?? "") }, "declined");
  }
  res.json(dismissed);
});

export default router;
