/**
 * agentActions.ts — the receipt log (WS5 §5B).
 *
 * An APPEND-ONLY, reversible audit trail of every action Nomila took ON THE
 * ATHLETE'S BEHALF. The Week renders "Set aside by Nomila" (each line Undo/Wrong?)
 * from this feed, and the co-pilot trail reads it. Distinct from pending_actions
 * (which PROPOSES and never sends without approval) — this table RECORDS actions
 * already taken or scheduled (an auto-decline sits behind a 24h `held_until` hold),
 * for accountability after the fact.
 *
 * Append-only invariant: a row is never deleted and its identity/payload never
 * mutates. The only post-insert writes are the reversal stamps — `undone_at` (Undo
 * flipped a filing back) and `result` (executor output once a held action runs).
 *
 * Endpoints (mounted at /api/v1/me):
 *   GET  /agent-actions              — the receipt feed (?action, ?deal_id, ?since)
 *   POST /agent-actions/:id/undo     — reverse a reversible filing (thread status back)
 *   POST /agent-actions/:id/wrong    — flag it wrong → eval-fixture sink (Phase-2 seed)
 *
 * The append helper `writeAgentAction(...)` is the single writer other server code
 * calls when it takes an auto-action (filing, auto-decline, reclassify, mute).
 */

import { Router, type Request, type Response } from "express";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { agentActions, deals, inboxThreads, opportunities, type AgentAction } from "../../shared/schema";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
// The single writer + action allowlist now live in lib so skills can append receipts
// too (dealDetector's auto-demote). Re-exported here for backward compatibility.
import { writeAgentAction, VALID_AGENT_ACTIONS, type AgentActionKind } from "../lib/agentActions";
import { undoProfileWrite } from "../mila/onboarding";
import { undoConfirmSigned } from "../skills/dealSigning";
import { reconcilePublishedCard } from "../services/publicCard/reconcile";
import { undoSplit } from "../skills/dealSplit";
export { writeAgentAction, VALID_AGENT_ACTIONS, type AgentActionKind };

const logger = createLogger("routes/agentActions");
const router = Router();

/** inbox_threads_status_check and deals_status_check (shared/schema.ts). */
const THREAD_STATUSES = new Set(["unread", "read", "starred", "archived", "deal_detected"]);
const DEAL_STATUSES = new Set(["detected", "pending", "negotiating", "accepted", "completed", "rejected"]);

// ─── Eval-fixture sink (SEAM) ─────────────────────────────────────────────────
// `Wrong?` on a receipt line feeds the Phase-2 learning pipeline. Full fixture
// capture (write the thread + Mila's decision + the correction to an eval store)
// is deferred; this is the marked seam. For now it logs the signal so nothing is
// silently dropped. Swap the body for the real fixture writer when Phase-2 lands.
async function recordEvalFixture(action: AgentAction, note: string | null): Promise<void> {
  logger.warn(
    { agentActionId: action.id, athleteId: action.athlete_id, action: action.action, threadId: action.thread_id, dealId: action.deal_id, note },
    "EVAL FIXTURE (stub sink): agent action flagged wrong — capture for Phase-2 learning",
  );
  // TODO(WS5 Phase-2): persist { thread, decision, correction } to the eval store.
}

// ─── GET /api/v1/me/agent-actions ─────────────────────────────────────────────
// The receipt feed, newest-first. Filter by ?action, ?deal_id, ?since (ISO).

router.get("/agent-actions", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { action, deal_id, since, before, before_id } = req.query as Record<string, string>;

  const filters = [eq(agentActions.athlete_id, athleteId)];
  // Keyset cursor for "load more": everything older than the last row you were given.
  //
  // Safe to page here in a way the DEAL list is not. This feed is flat and chronological —
  // no grouping collapses across rows, no ranking is computed over the set — so a page is a
  // faithful slice. The deal list collapses cross-thread groups whose members can sit 31 days
  // apart, so slicing it renders the same deal twice; that one is bounded and alarmed instead.
  //
  // Compares (created_at, id) as a ROW, not created_at alone. Checked against production: no
  // two rows currently share a timestamp — Postgres keeps microseconds — so a plain
  // `created_at <` would work today. It is written this way because the failure it prevents is
  // invisible: one batch insert landing on the same microsecond, and a plain cursor steps over
  // every row sharing that boundary. A skipped page reports nothing; it just quietly holds
  // less than it should.
  //
  // The ORDER BY below matches this comparison exactly. A mismatch between the two is what
  // turns "load more" into repeated or missing rows.
  if (before && before_id) {
    const d = new Date(before);
    if (!isNaN(d.getTime())) {
      filters.push(sql`(${agentActions.created_at}, ${agentActions.id}) < (${d}, ${before_id})`);
    }
  }
  if (action && VALID_AGENT_ACTIONS.includes(action as AgentActionKind)) {
    filters.push(eq(agentActions.action, action));
  }
  if (deal_id) {
    filters.push(eq(agentActions.deal_id, deal_id));
  }
  if (since) {
    const d = new Date(since);
    if (!isNaN(d.getTime())) filters.push(gte(agentActions.created_at, d));
  }

  const rows = await db
    .select()
    .from(agentActions)
    .where(and(...filters))
    // Matches the cursor comparison exactly — see the keyset filter above. A mismatch here
    // is what turns "load more" into silently skipped or repeated rows.
    .orderBy(desc(agentActions.created_at), desc(agentActions.id))
    .limit(200);

  res.json(rows);
});

// ─── GET /api/v1/me/agent-actions/counts ─────────────────────────────────────
// How many of each action, for the same window — as a total, not as "how many fitted".
//
// The list above caps at 200 rows, which is right for an itemised receipt nobody wants a
// thousand lines of. What was wrong is that the client counted the rows it received and
// showed that as the total. On the Last 30 Days screen this credited Mila with 190 filings
// when she had actually made 967: the one screen whose entire job is showing what she did for
// you was under-reporting her fivefold, and looked perfectly plausible doing it.
//
// Counting in SQL is also cheaper than the truncated version it replaces — three integers
// instead of 200 rows.
//
// Excludes undone actions, matching what the receipt DISPLAYS — buildReceipt drops reversed
// rows client-side, so counting them here would put the number above the list again, just in
// the other direction. Note the list route itself does NOT filter them; the client does.
router.get("/agent-actions/counts", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { since }  = req.query as Record<string, string>;

  const filters = [eq(agentActions.athlete_id, athleteId), isNull(agentActions.undone_at)];
  if (since) {
    const d = new Date(since);
    if (!isNaN(d.getTime())) filters.push(gte(agentActions.created_at, d));
  }

  const rows = await db
    .select({ action: agentActions.action, n: sql<number>`count(*)::int` })
    .from(agentActions)
    .where(and(...filters))
    .groupBy(agentActions.action);

  const byAction: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { byAction[r.action] = r.n; total += r.n; }
  res.json({ total, byAction });
});

// ─── POST /api/v1/me/agent-actions/:id/undo ───────────────────────────────────
// Reverse a reversible filing: flip the thread's status back to payload.from_status
// and stamp `undone_at`. Append-only — the row stays (the receipt keeps showing
// "filed, then reopened"). Idempotent: a second undo 409s.

router.post("/agent-actions/:id/undo", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const id        = req.params.id;

  const [action] = await db
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.id, id), eq(agentActions.athlete_id, athleteId)))
    .limit(1);

  if (!action) {
    res.status(404).json({ error: "Agent action not found" });
    return;
  }
  if (!action.reversible) {
    res.status(409).json({ error: "Agent action is not reversible" });
    return;
  }
  if (action.undone_at) {
    res.status(409).json({ error: "Agent action already undone" });
    return;
  }

  // A profile fact Mila wrote from the athlete's words (onboarding): retract the asserted row
  // and restore the column it touched. See server/mila/onboarding.ts.
  if (action.action === "profile_write") {
    await undoProfileWrite(action);
  }

  // "This is a separate deal" (D7): undone only while it is safe; otherwise nothing changes and the receipt stays.
  if (action.action === "split_deal") {
    const ok = await undoSplit(athleteId, (action.payload ?? {}) as Record<string, any>);
    if (!ok) { res.status(409).json({ error: "This split can't be undone any more: the new deal has moved on" }); return; }
  }

  // D4 (a 'reopen' receipt with payload.kind "deal_agreed"): restored by the conditional deal-status branch below —
  // deal_from_status, only while the deal is still deal_to_status ('accepted').

  // Her "Yes, it's signed" (docs/design/brand-page-deals.md D2): clear signed and restore the deal's status. The
  // opportunity it closed as won is reopened by the opportunity branch below (payload.opportunity_id).
  if (action.action === "confirm_signed") {
    await undoConfirmSigned(athleteId, (action.payload ?? {}) as Record<string, any>);
    // Her partner leaves her published public card at once (design-public-card-v3 §10 "pulled at once").
    await reconcilePublishedCard(athleteId, "You marked a deal as not signed, so that partner came off your public card.");
  }

  // Reverse the effect: put the thread — and the deal, when her act moved it — back where they were.
  // A dispose receipt records thread_from_status and deal_from_status separately. Older receipts
  // stored the DEAL's status in from_status; writing that into inbox_threads.status broke the
  // CHECK (a 500 on her Undo) and left the deal 'rejected'. So a from_status that is not a thread
  // status is read as the deal's and restored there.
  const payload = (action.payload ?? {}) as Record<string, any>;
  const rawFrom = (payload.thread_from_status ?? payload.from_status) as string | undefined;
  const fromStatus = rawFrom && THREAD_STATUSES.has(rawFrom) ? rawFrom : undefined;
  if (action.thread_id && fromStatus) {
    await db
      .update(inboxThreads)
      .set({ status: fromStatus })
      .where(and(eq(inboxThreads.id, action.thread_id), eq(inboxThreads.athlete_id, athleteId)));
  }
  // The deal's status goes back ONLY while it is still what her act left it (a conditional update), so an Undo
  // never writes a stale status over a deal that moved on since:
  //   · new receipts say both ends (deal_from_status → deal_to_status);
  //   · an OLD not_interested receipt stored the deal's prior status in from_status; that act set 'rejected';
  //   · an OLD not_a_deal receipt also stored the deal's status in from_status, but that act never changed the
  //     deal (it archived the thread), so there is nothing to restore — writing it back would be stale.
  const legacyDealFrom = !payload.deal_from_status && rawFrom && !THREAD_STATUSES.has(rawFrom) && DEAL_STATUSES.has(rawFrom)
    && (payload.athlete_label === "not_interested" || (payload.athlete_label === "not_a_deal" && !action.thread_id))
    ? rawFrom : undefined;   // not_a_deal with no thread DID set 'rejected'
  const dealFrom = (payload.deal_from_status as string | undefined) ?? legacyDealFrom;
  const dealLeftAt = (payload.deal_to_status as string | undefined) ?? (legacyDealFrom ? "rejected" : undefined);
  if (action.deal_id && dealFrom && dealLeftAt && DEAL_STATUSES.has(dealFrom)) {
    await db
      .update(deals)
      .set({ status: dealFrom })
      .where(and(eq(deals.id, action.deal_id), eq(deals.athlete_id, athleteId), eq(deals.status, dealLeftAt)));
  }

  // An opportunity filing (sweep / backfill, Opportunities PR 2): reopen the opportunity and put
  // every thread it archived back where it was.
  const opportunityId = (action.payload as any)?.opportunity_id as string | undefined;
  if (opportunityId) {
    await db
      .update(opportunities)
      .set({ status: "open", closed_at: null, close_reason: null })
      .where(and(eq(opportunities.id, opportunityId), eq(opportunities.athlete_id, athleteId)));
    const threads = ((action.payload as any)?.threads ?? []) as { id?: string; from_status?: string }[];
    for (const t of threads) {
      if (!t?.id || !t.from_status) continue;
      await db
        .update(inboxThreads)
        .set({ status: t.from_status })
        .where(and(eq(inboxThreads.id, t.id), eq(inboxThreads.athlete_id, athleteId)));
    }
  }

  const [undone] = await db
    .update(agentActions)
    .set({ undone_at: new Date() })
    .where(eq(agentActions.id, id))
    .returning();

  logger.info({ athleteId, agentActionId: id, threadId: action.thread_id, restoredStatus: fromStatus }, "Agent action undone");
  res.json(undone);
});

// ─── POST /api/v1/me/agent-actions/:id/wrong ──────────────────────────────────
// `Wrong?` on a receipt line — Nomila mis-judged this. Writes an eval fixture
// (stub sink, see recordEvalFixture) so the correction seeds Phase-2 learning.
// Does NOT reverse the action (that's Undo) — it only records the disagreement.

router.post("/agent-actions/:id/wrong", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const id        = req.params.id;
  const { note }  = req.body as { note?: string };

  const [action] = await db
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.id, id), eq(agentActions.athlete_id, athleteId)))
    .limit(1);

  if (!action) {
    res.status(404).json({ error: "Agent action not found" });
    return;
  }

  await recordEvalFixture(action, note ?? null);
  res.json({ ok: true });
});

export default router;
