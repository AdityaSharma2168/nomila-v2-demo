/**
 * agent/callTool.ts — ONE tool call, under the policy: the per-call path every caller shares.
 *
 * The Mastra engine (engine/tools/registry.ts) and the tap path (approvals) call this, so a tool behaves the same
 * whoever runs it (the /mcp adapter that called it too went with TrueForge, Mastra-only PR 3):
 *
 *   arguments   must be a JSON object; nulls the strict schema allowed for optional fields are dropped
 *   fence       lib/privacy/deletionFence.ts: an athlete whose account is being deleted gets no tool call at all
 *                 (athlete_deleting). Checked HERE, so every engine and caller gets it; fails closed. The engine's own
 *                 fresh check is reused (ctx.fence, a clearance) so a call does not read the athletes row twice.
 *   policy      checkToolCall (skill_toolset, tenancy, family_privacy, then tap_to_send / money / confirm_first)
 *                 deny  → an error the model reads; nothing runs
 *   enablement  welcome/toolGate.ts: a tool an optional capability unlocks is refused (capability_off) while that
 *                 capability is not turned on for this athlete (MILA_WELCOME; transparent while it is off)
 *   validate    the tool's zod schema
 *   prepare     keys → ids, code-filled fields, call-time checks
 *                 queue → an approval item (pending_actions 'agent_action'); the model is told it waits for the tap
 *                 allow → the tool runs with the CALLER's athlete id (ToolContext), under a timeout
 *   result      toToolResult → the evidence it rests on and the code-built cards → forModel (no "_" fields)
 *
 * It records nothing itself: the outcome says what happened and the caller writes its own trace.
 *
 * This is the ONLY place a registered tool's execute runs for a model's call (the athlete's tap runs it in
 * approvals.ts executeAgentAction, behind the same fence and enablement checks). callTool.guard.test.ts fails if any
 * other code calls a tool's execute directly.
 */
import type { ApprovalItem, ChatCard, EvidenceRef, PolicyDecision, Skill } from "../../shared/agent";
import { createLogger } from "../logger";
import { withTimeout } from "../lib/withTimeout";
import { AGENT } from "./config";
import { checkToolCall } from "./policy";
import { isAthleteDeleting, isFreshClearance } from "../lib/privacy/deletionFence";
import { toolRefusal } from "./welcome/toolGate";
import { dropStrictNulls, forModel, toToolResult, type AgentTool, type ToolContext, type ToolResult } from "./tools";

const logger = createLogger("agent/callTool");

/** What the model reads when a call was queued (the old harness's words, unchanged). */
export function queuedReply(tool: AgentTool, item: ApprovalItem): Record<string, unknown> {
  const note = tool.permission === "propose" && !tool.money
    ? "NOT done yet: the athlete sees a card asking them to confirm, and it happens only if they tap. Do not say it is saved or done."
    : "Waiting for the athlete's tap. It has NOT happened yet.";
  return { status: "queued_for_approval", queued_for_approval: true, approval_id: item.id, note };
}

export type CallOutcome =
  | { outcome: "error"; reason: string; args?: Record<string, unknown>; verdict?: PolicyDecision; reply: ToolResult }
  | { outcome: "denied"; rule: NonNullable<PolicyDecision["rule"]>; reason: string; args: Record<string, unknown>; verdict: PolicyDecision; reply: ToolResult }
  | { outcome: "queued_for_approval"; rule: NonNullable<PolicyDecision["rule"]>; approval: ApprovalItem; args: Record<string, unknown>; verdict: PolicyDecision; reply: Record<string, unknown> }
  | { outcome: "ok"; result: ToolResult; args: Record<string, unknown>; verdict: PolicyDecision; cards: ChatCard[]; evidence: EvidenceRef[]; reply: ToolResult };

export interface CallToolParams {
  skill: Pick<Skill, "id" | "tools">;
  /** The registered tool of that name, or undefined (the policy refuses an unknown name). */
  tool: AgentTool | undefined;
  name: string;
  /** The model's arguments, already parsed from JSON (null when they were not JSON). */
  args: unknown;
  ctx: ToolContext;
  neverTerms: readonly string[];
  queueApproval(ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>): Promise<ApprovalItem>;
  /** The skill lists cite_facts: its evidence is what the answer cites, not everything its tools read. */
  citing: boolean;
  /** The deletion-fence read when ctx.fence is absent or stale (default deletionFence.ts isAthleteDeleting). */
  isDeleting?: (athleteId: string) => Promise<boolean>;
}

/** What the model reads when the account is being deleted. */
export const DELETING_REASON = "this account is being deleted, so no tool may run. Do not retry.";

/** Is the athlete fenced for this call? A fresh clearance from the engine stands in for the read. Fails closed. */
async function fenced(p: CallToolParams): Promise<boolean> {
  if (isFreshClearance(p.ctx.fence, p.ctx.athleteId)) return false;
  return (p.isDeleting ?? isAthleteDeleting)(p.ctx.athleteId).catch(() => true);
}

export async function callTool(p: CallToolParams): Promise<CallOutcome> {
  const { tool, name, ctx } = p;
  let args: unknown = p.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    const reason = "arguments were not a JSON object";
    return { outcome: "error", reason, reply: { status: "error", reason } };
  }
  if (tool && tool.kind !== "builtin") args = dropStrictNulls(tool.args, args);

  // Account deletion phase 1: nothing runs for a fenced athlete, read or write, whoever the caller.
  if (await fenced(p)) {
    logger.warn({ athleteId: ctx.athleteId, runId: ctx.runId, tool: name }, "agent tool refused: account being deleted");
    const reason = DELETING_REASON;
    const off: PolicyDecision = { decision: "deny", rule: "athlete_deleting", reason };
    return { outcome: "denied", rule: "athlete_deleting", reason, args: args as Record<string, unknown>, verdict: off, reply: { status: "error", reason: `not allowed: ${reason}` } };
  }

  const verdict: PolicyDecision = tool && tool.kind === "builtin"
    ? { decision: "deny", rule: "skill_toolset", reason: `${name} is run by the provider, not called` }
    : checkToolCall({ skill: p.skill, tool, name, args, neverTerms: p.neverTerms });

  if (verdict.decision === "deny") {
    return { outcome: "denied", rule: verdict.rule!, reason: verdict.reason, args: args as Record<string, unknown>, verdict, reply: { status: "error", reason: `not allowed: ${verdict.reason}` } };
  }

  // Per-athlete enablement (agent/welcome/toolGate.ts; MILA_WELCOME): a tool an optional capability unlocks runs only
  // while the athlete has that capability turned on, whatever list the model was shown. Fails closed.
  // A tool owned per use (documents_make for a pitch vs the public page) is judged on this call's own arguments.
  const refusal = await toolRefusal(ctx.athleteId, name, undefined, args).catch(() => `${name} is off for this athlete: the check failed. Do not retry.`);
  if (refusal) {
    const off: PolicyDecision = { decision: "deny", rule: "capability_off", reason: refusal };
    return { outcome: "denied", rule: "capability_off", reason: refusal, args: args as Record<string, unknown>, verdict: off, reply: { status: "error", reason: refusal } };
  }

  const parsed = tool!.args.safeParse(args);
  if (!parsed.success) {
    const reason = `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
    return { outcome: "error", reason, args: args as Record<string, unknown>, verdict, reply: { status: "error", reason } };
  }

  let data = parsed.data as Record<string, unknown>;
  if (tool!.prepare) {
    try {
      const prep = await tool!.prepare(ctx, data);
      if ("error" in prep) return { outcome: "error", reason: prep.error, args: data, verdict, reply: { status: "error", reason: prep.error } };
      data = prep.args as Record<string, unknown>;
    } catch (err: any) {
      logger.warn({ runId: ctx.runId, tool: name, error: err?.message }, "agent tool prepare failed");
      return { outcome: "error", reason: "the tool failed", args: data, verdict, reply: { status: "error", reason: "the tool failed" } };
    }
  }

  if (verdict.decision === "queue") {
    const item = await p.queueApproval(ctx, tool!, data);
    return { outcome: "queued_for_approval", rule: verdict.rule!, approval: item, args: data, verdict, reply: queuedReply(tool!, item) };
  }

  try {
    const raw = await withTimeout(tool!.execute!(ctx, data), tool!.timeoutMs ?? AGENT.TOOL_TIMEOUT_MS, name);
    const result = toToolResult(raw);
    if (result.status !== "ok") return { outcome: "error", reason: result.reason, args: data, verdict, reply: forModel(result) };
    const evidence = p.citing ? tool!.cites?.(result, ctx) ?? [] : tool!.evidence?.(result, ctx) ?? [];
    const card = tool!.card?.(result, ctx) ?? null;
    const cards = [...(card ? [card] : []), ...(tool!.cards?.(result, ctx) ?? [])];
    return { outcome: "ok", result, args: data, verdict, cards, evidence, reply: forModel(result) };
  } catch (err: any) {
    logger.warn({ runId: ctx.runId, tool: name, error: err?.message }, "agent tool failed");
    return { outcome: "error", reason: "the tool failed", args: data, verdict, reply: { status: "error", reason: "the tool failed" } };
  }
}
