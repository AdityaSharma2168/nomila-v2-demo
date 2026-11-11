/**
 * agent/engine/mastra/tools.ts — our registry tools as Mastra tools (createTool), called IN-PROCESS.
 *
 * Why not Mastra's MCP client to our own /mcp (the POC's default): it needs @mastra/mcp, whose peer zod ^4.2 breaks a
 * plain `npm ci` and which pins @modelcontextprotocol 2.2.0 (four advisories, fixed only by an override), plus a
 * loopback HTTP hop with the caller secret and a catalog probe our /mcp had to learn. In-process is the same per-call
 * path with none of that: callPassTool (engine/tools/registry.ts) is the ONE function both engines run for a tool call.
 *
 * Per call, in order (fail closed at each step):
 *   1. the athlete pass from the call's requestContext (set by guards.ts contextFromPass from the signed pass only;
 *      never from the model's arguments) is VERIFIED again: signature, expiry, a known skill
 *   2. account-deletion fence: a fenced athlete's call is refused (and refused when the check itself fails)
 *   3. callPassTool: scp, then callTool (policy → validate → prepare → queue or run), cards/approvals/evidence and the
 *      call record into the turn store — exactly what /mcp did for TrueForge (both gone, Mastra-only PR 3)
 * The model sees the same text /mcp returned (compacted; ok results fenced as outside text). A tool error is returned
 * as `{ status: "error", … }` text, never thrown, so the model can recover; only a refused pass or fence throws.
 *
 * Display (display.ts): the cards a call made are kept per tool call id for the turn (`callCards`, the tools are built
 * per turn), and turn.ts hands them once to display.ts displayChunk on chat v2's copy of that call's result chunk; they
 * are the same cards the turn store keeps. The tools carry NO Mastra `transform`: Mastra would save its output (every
 * card DTO) in the thread's tool parts, a second copy the model never reads.
 */
import type { ToolsInput } from "@mastra/core/agent";
import type { ChatCard } from "../../../../shared/agent";
import { createLogger } from "../../../logger";
import { clearFence, isAthleteDeleting } from "../../../lib/privacy/deletionFence";
import { queueApproval as dbQueueApproval } from "../../approvals";
import { actionCard } from "../../cards";
import { AGENT } from "../../config";
import { neverTermsFor } from "../../memory";
import { dbTurnStore } from "../tools/dbTurnStore";
import { verifyAthletePass } from "../tools/pass";
import { callPassTool, passSkill, type PassToolDeps } from "../tools/registry";
import { loadJob } from "../../jobs";
import type { AgentTool, ToolRegistry } from "../../tools";
import { PASS_CONTEXT_KEY } from "../config";

const logger = createLogger("agent/engine/mastra/tools");

export interface MastraToolDeps extends Partial<PassToolDeps> {
  passKey?: string | null;
  isDeleting?: (athleteId: string) => Promise<boolean>;
  /** The turn's cards by tool call id, for chat v2's display (turn.ts; mastraTools shares one map across the turn's tools). */
  callCards?: Map<string, ChatCard[]>;
}

export class ToolRefusedError extends Error {
  constructor(readonly code: "pass_refused" | "athlete_deleting" | "unknown_skill", message: string) { super(message); this.name = "ToolRefusedError"; }
}

type CallContext = { requestContext?: { get(k: string): unknown }; agent?: { toolCallId?: string } } | undefined;

/** One registry tool as a Mastra tool. */
export async function mastraTool(t: AgentTool, registry: ToolRegistry, deps: MastraToolDeps = {}) {
  const { createTool } = await import("@mastra/core/tools");
  const resolved: PassToolDeps = {
    neverTerms: deps.neverTerms ?? neverTermsFor,
    queueApproval: deps.queueApproval ?? dbQueueApproval,
    turns: deps.turns ?? dbTurnStore,
    resultMaxChars: deps.resultMaxChars ?? AGENT.TOOL_RESULT_MAX_CHARS,
  };
  const fenced = deps.isDeleting ?? isAthleteDeleting;
  const callCards = deps.callCards ?? new Map<string, ChatCard[]>();
  return createTool({
    id: t.name,
    description: t.description,
    inputSchema: t.args as never,
    execute: async (input: unknown, context: CallContext) => {
      let pass;
      try { pass = verifyAthletePass(context?.requestContext?.get(PASS_CONTEXT_KEY) as string | undefined, deps.passKey); }
      catch (err: any) {
        logger.warn({ tool: t.name, code: err?.code ?? "invalid" }, "mastra tool: athlete pass refused");
        throw new ToolRefusedError("pass_refused", "athlete pass refused");
      }
      let skill;
      try { skill = passSkill(loadJob(pass.skillId), registry); }
      catch { throw new ToolRefusedError("unknown_skill", "athlete pass names an unknown skill"); }
      // Checked here so a fenced call is a refusal the engine sees; the clearance is handed to callTool, which checks
      // the fence on every call itself and reuses this fresh result instead of reading again.
      const fence = await clearFence(pass.athleteId, fenced);
      if (!fence) {
        logger.warn({ athleteId: pass.athleteId, tool: t.name }, "mastra tool: refused (account being deleted)");
        throw new ToolRefusedError("athlete_deleting", "account being deleted");
      }
      const r = await callPassTool(pass, skill, registry, t.name, (input ?? {}) as Record<string, unknown>, { ...resolved, isDeleting: fenced }, fence);
      const made = [...(r.approval ? [actionCard(r.approval)] : []), ...(r.cards ?? [])];
      const callId = context?.agent?.toolCallId;
      if (callId && made.length) callCards.set(callId, made);
      return r.text;
    },
  } as never);
}

/** Hand over (once) the cards one call made: what display.ts displayChunk puts on that call's result chunk. */
export function takeCallCards(callCards: Map<string, ChatCard[]>, toolCallId: string): ChatCard[] {
  const cards = callCards.get(toolCallId) ?? [];
  callCards.delete(toolCallId);
  return cards;
}

/** The visible tools as Mastra tools, keyed by their own names (one card map for the turn's calls). */
export async function mastraTools(tools: AgentTool[], registry: ToolRegistry, deps: MastraToolDeps = {}): Promise<ToolsInput> {
  const out: ToolsInput = {};
  const shared: MastraToolDeps = { ...deps, callCards: deps.callCards ?? new Map<string, ChatCard[]>() };
  for (const t of tools) out[t.name] = await mastraTool(t, registry, shared);
  return out;
}
