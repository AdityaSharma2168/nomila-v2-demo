/**
 * agent/approvals.ts — the approval queue for the agent, on the EXISTING pending_actions table (kind 'agent_action').
 *
 * The agent never executes an act-level or propose-level tool (a propose tool is e.g. the chat's "Want me to save
 * that?" — a fact, a correction or a preference saved only on the athlete's Save tap). When it calls one, the harness
 * QUEUES it here: a pending_actions row
 * holding the tool name, the validated arguments and what the card shows. Only the athlete's tap — POST
 * /pending-actions/:id/approve, which calls executeAgentAction — runs the tool, and it runs it at most once: the row
 * is CLAIMED (pending → approved, conditionally) before the executor is called, exactly as send_reply does.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { agentRuns, pendingActions } from "../../shared/schema";
import type { ApprovalItem, ApprovalStatus, ApprovalVerb, RunApprovalState } from "../../shared/agent";
import { createLogger } from "../logger";
import { AGENT } from "./config";
import { neverTermsFor } from "./memory";
import type { AgentTool, ToolContext, ToolRegistry } from "./tools";
import { checkToolCall } from "./policy";
import { pushWaiting } from "../services/push/events";
import { isAthleteDeleting } from "../lib/privacy/deletionFence";
import { tapRefusal } from "./welcome/toolGate";

export const AGENT_ACTION_KIND = "agent_action" as const;

const logger = createLogger("agent/approvals");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── the run's approval state (agent_runs.approval_state, 0144) ─────────────────────────────────────────────────────
// The run that queued a card keeps `status` (how its model turn ended); `approval_state` follows the cards:
// awaiting_approval (turn end, engine/mastra/turn.ts and trace.ts) → resumed (a tap claimed one; its tool is running) → after every
// tap, recomputed from all of the run's agent_action rows. Best-effort: a failed write is logged, never fails the tap.

/** A tap claimed one of the run's cards: its tool is about to run. */
export async function markRunResumed(athleteId: string, runId: string | null | undefined): Promise<void> {
  if (!runId || !UUID.test(runId)) return;
  try {
    await db.update(agentRuns).set({ approval_state: "resumed" }).where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId)));
  } catch (err: any) {
    logger.warn({ athleteId, runId, err: err?.message }, "run approval state not set (resumed)");
  }
}

/**
 * After a tap settled (approved and ran, failed, or declined): the run's state from all of its cards, first match wins —
 * a card still pending and unexpired → awaiting_approval; one approved and still running → resumed; one failed →
 * failed; one approved → completed; else (all declined or expired) → cancelled. A run with no cards is left alone.
 */
export async function settleRunApproval(athleteId: string, runId: string | null | undefined): Promise<RunApprovalState | null> {
  if (!runId || !UUID.test(runId)) return null;
  try {
    const { rows } = await db.execute<{ approval_state: RunApprovalState | null }>(sql`
      UPDATE agent_runs r SET approval_state = s.state
      FROM (
        SELECT CASE
          WHEN bool_or(pa.status = 'pending' AND (pa.expires_at IS NULL OR pa.expires_at > now())) THEN 'awaiting_approval'
          WHEN bool_or(pa.status = 'approved' AND pa.executed_at IS NULL) THEN 'resumed'
          WHEN bool_or(pa.status = 'failed') THEN 'failed'
          WHEN bool_or(pa.status = 'approved') THEN 'completed'
          ELSE 'cancelled' END AS state
        FROM pending_actions pa
        WHERE pa.athlete_id = ${athleteId} AND pa.kind = ${AGENT_ACTION_KIND} AND pa.payload->>'runId' = ${runId}
        HAVING count(*) > 0
      ) s
      WHERE r.id = ${runId} AND r.athlete_id = ${athleteId}
      RETURNING r.approval_state`);
    return rows[0]?.approval_state ?? null;
  } catch (err: any) {
    logger.warn({ athleteId, runId, err: err?.message }, "run approval state not settled");
    return null;
  }
}

interface AgentActionPayload {
  tool: string;
  args: Record<string, unknown>;
  verb: ApprovalVerb;
  title: string;
  summary: string;
  money: { amountMinor: number; currency: string } | null;
  runId: string | null;
  skillId: string;
}

type PendingRow = typeof pendingActions.$inferSelect;

export function toApprovalItem(row: PendingRow): ApprovalItem {
  const p = row.payload as AgentActionPayload;
  return {
    id: row.id,
    athleteId: row.athlete_id,
    verb: p.verb,
    tool: p.tool,
    args: p.args,
    title: p.title,
    summary: p.summary,
    ...(p.money ? { money: p.money } : {}),
    status: row.status as ApprovalStatus,
    runId: p.runId,
    createdAt: (row.created_at ?? new Date()).toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

/** Queue an act-level call for the athlete's tap. `args` are already validated against the tool's schema. */
export async function queueApproval(ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>): Promise<ApprovalItem> {
  if (!tool.approval) throw new Error(`tool ${tool.name} has no approval descriptor`);
  const payload: AgentActionPayload = {
    tool: tool.name,
    args,
    verb: tool.approval.verb,
    title: tool.approval.title(args).slice(0, 200),
    summary: tool.approval.summary(args).slice(0, 1000),
    money: tool.approval.money?.(args) ?? null,
    runId: ctx.runId,
    skillId: ctx.skillId,
  };
  const [row] = await db.insert(pendingActions).values({
    athlete_id: ctx.athleteId,
    kind: AGENT_ACTION_KIND,
    payload,
    expires_at: new Date(Date.now() + AGENT.APPROVAL_TTL_DAYS * 86_400_000),
  }).returning();
  // Her phone hears that something waits on her tap (PUSH_NOTIFICATIONS; never in the foreground, never for save_memory).
  pushWaiting(ctx.athleteId, { id: row.id, verb: payload.verb });
  return toApprovalItem(row);
}

export class ApprovalError extends Error {
  /** `code` names a refusal the client can tell apart; `item` is the row as the refusal left it (e.g. declined). */
  constructor(readonly status: number, message: string, readonly code?: "athlete_deleting" | "capability_off" | "check_failed", readonly item?: ApprovalItem) { super(message); }
}

/** What the tap needs besides the registry (tests pass fakes). Defaults: the database and the Welcome registry. */
export interface TapDeps {
  isDeleting?: (athleteId: string) => Promise<boolean>;
  tapRefusal?: (athleteId: string, tool: string, args?: unknown) => Promise<string | null>;
}

/**
 * Edit a queued agent_action's arguments BEFORE the tap — the athlete changed the draft on the card (e.g. a reply's
 * body). Nothing runs here: the row stays pending and only POST /pending-actions/:id/approve executes it. Scoped to
 * her; only a pending, unexpired row; the patch merges over the stored arguments, must still validate against the
 * tool's schema and pass the same policy check as the tap; the card's title and summary are recomputed from the
 * edited arguments.
 */
export async function editAgentAction(athleteId: string, id: string, argsPatch: Record<string, unknown>, registry: ToolRegistry): Promise<ApprovalItem> {
  const [row] = await db.select().from(pendingActions)
    .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId), eq(pendingActions.kind, AGENT_ACTION_KIND))).limit(1);
  if (!row) throw new ApprovalError(404, "Pending action not found");
  if (row.status !== "pending") throw new ApprovalError(409, `Pending action is already ${row.status}`);
  if (row.expires_at && row.expires_at.getTime() < Date.now()) throw new ApprovalError(409, "Pending action has expired");

  const p = row.payload as AgentActionPayload;
  const tool = registry.get(p.tool);
  if (!tool || !tool.approval) throw new ApprovalError(400, `Unsupported agent action: ${p.tool}`);
  const parsed = tool.args.safeParse({ ...p.args, ...argsPatch });
  if (!parsed.success) throw new ApprovalError(400, "That edit isn't valid for this action");
  const neverTerms = await neverTermsFor(athleteId).catch(() => [] as string[]);
  const verdict = checkToolCall({ skill: { id: p.skillId, tools: [tool.name] }, tool, name: tool.name, args: parsed.data, neverTerms });
  if (verdict.decision === "deny") throw new ApprovalError(400, verdict.reason);

  const args = parsed.data as Record<string, unknown>;
  const payload: AgentActionPayload = {
    ...p,
    args,
    title: tool.approval.title(args).slice(0, 200),
    summary: tool.approval.summary(args).slice(0, 1000),
    money: tool.approval.money?.(args) ?? null,
  };
  // Conditional on still pending, so an edit can't land on a row a concurrent tap has already claimed.
  const [updated] = await db.update(pendingActions).set({ payload })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId), eq(pendingActions.status, "pending")))
    .returning();
  if (!updated) throw new ApprovalError(409, "Pending action was already handled");
  return toApprovalItem(updated);
}

/**
 * Execute an approved agent_action — ONLY called from the athlete's approve tap. Scoped to her; claims the row before
 * running; records the result or the failure. The tool must still be registered, still be an act/money tool, and its
 * stored arguments must still validate. At tap time it also re-checks, before anything runs:
 *   the deletion fence   an account being deleted runs nothing (refused, the row left as it is; fails closed);
 *   the opt-in           the capability that unlocks the tool must still be on (welcome/toolGate.ts tapRefusal). Turned
 *                        off or paused since the card was queued → the row is declined (dismissed, with the reason in
 *                        `error`) and nothing runs. A check that fails refuses without declining, so she can retry.
 * This and callTool.ts are the only places a registered tool's execute runs (callTool.guard.test.ts).
 */
export async function executeAgentAction(athleteId: string, id: string, registry: ToolRegistry, deps: TapDeps = {}): Promise<ApprovalItem> {
  const [row] = await db.select().from(pendingActions)
    .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId), eq(pendingActions.kind, AGENT_ACTION_KIND))).limit(1);
  if (!row) throw new ApprovalError(404, "Pending action not found");
  if (row.status !== "pending") throw new ApprovalError(409, `Pending action is already ${row.status}`);
  if (row.expires_at && row.expires_at.getTime() < Date.now()) throw new ApprovalError(409, "Pending action has expired");

  const p = row.payload as AgentActionPayload;
  const tool = registry.get(p.tool);
  if (!tool || !tool.execute || (tool.permission !== "act" && tool.permission !== "propose" && !tool.money)) throw new ApprovalError(400, `Unsupported agent action: ${p.tool}`);
  const parsed = tool.args.safeParse(p.args);
  if (!parsed.success) throw new ApprovalError(400, "The stored action no longer validates");
  // The tap re-checks the rules that do not depend on the tap itself (tenancy, never-content).
  const neverTerms = await neverTermsFor(athleteId).catch(() => [] as string[]);
  const verdict = checkToolCall({ skill: { id: p.skillId, tools: [tool.name] }, tool, name: tool.name, args: parsed.data, neverTerms });
  if (verdict.decision === "deny") throw new ApprovalError(400, verdict.reason);

  // The fence and the opt-in, as they stand at the tap (not as they stood when the card was queued).
  if (await (deps.isDeleting ?? isAthleteDeleting)(athleteId).catch(() => true)) {
    throw new ApprovalError(403, "This account is being deleted, so nothing was done.", "athlete_deleting");
  }
  let off: string | null;
  try { off = await (deps.tapRefusal ?? tapRefusal)(athleteId, tool.name, parsed.data); }
  catch (err: any) {
    logger.warn({ athleteId, pendingActionId: id, tool: tool.name, err: err?.message }, "tap refused: capability check failed");
    throw new ApprovalError(503, "We couldn't check this is still turned on, so nothing was done. Try again in a moment.", "check_failed");
  }
  if (off) {
    const [declined] = await db.update(pendingActions).set({ status: "dismissed", dismissed_at: new Date(), error: `capability_off: ${off}`.slice(0, 500) })
      .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId), eq(pendingActions.status, "pending")))
      .returning();
    if (!declined) throw new ApprovalError(409, "Pending action was already handled");
    logger.info({ athleteId, pendingActionId: id, tool: tool.name }, "tap declined: capability turned off since it was queued");
    await settleRunApproval(athleteId, p.runId);
    throw new ApprovalError(409, off, "capability_off", toApprovalItem(declined));
  }

  const claimed = await db.update(pendingActions).set({ status: "approved", approved_at: new Date() })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId), eq(pendingActions.status, "pending")))
    .returning({ id: pendingActions.id });
  if (!claimed.length) throw new ApprovalError(409, "Pending action was already handled");
  await markRunResumed(athleteId, p.runId);

  let settled: PendingRow;
  try {
    const result = await tool.execute({ athleteId, runId: p.runId ?? "", skillId: p.skillId }, parsed.data);
    [settled] = await db.update(pendingActions).set({ result: (result ?? null) as any, executed_at: new Date() })
      .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId))).returning();
  } catch (err: any) {
    [settled] = await db.update(pendingActions).set({ status: "failed", error: String(err?.message ?? err).slice(0, 500), executed_at: new Date() })
      .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId))).returning();
  }
  await settleRunApproval(athleteId, p.runId);
  return toApprovalItem(settled);
}
