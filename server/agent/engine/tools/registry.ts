/**
 * agent/engine/tools/registry.ts — the tools Mila's turns may use, and the ONE per-call path they share. Moved from
 * agent/mcp/server.ts (5 Nov 2026); /mcp itself, and get_playbook with it, went with TrueForge (Mastra-only PR 3). The
 * mcpRegistry / mcpSkill names went too (renamed 9 Nov 2026):
 *
 *   passRegistry   the app's registry (coreTools.ts)
 *   passSkill      a skill's tools that can be called through a pass: no built-ins (the provider runs those), no
 *                  health_check
 *   visibleTools   the tools a pass may see: its skill's, flag on (enabled()), permission within the pass's scp
 *   catalogTools   every such tool whose flag is on (no athlete, no skill, no scope)
 *   callPassTool   one tool call for a VERIFIED pass: scp first, then callTool (policy → validate → prepare → queue or
 *                  run) with the athlete, run and skill FROM THE PASS; cards, approvals, evidence and a record of the
 *                  call go to the turn store (turnStore.ts; durable in dbTurnStore.ts)
 */
import type { ApprovalItem, ChatCard, Skill } from "../../../../shared/agent";
import { createLogger } from "../../../logger";
import { external } from "../../../lib/externalContent";
import { callTool } from "../../callTool";
import type { FenceClearance } from "../../../lib/privacy/deletionFence";
import { defaultRegistry } from "../../coreTools";
import { ToolRegistry, type AgentTool, type ToolContext, type TurnState } from "../../tools";
import { compactJson } from "./compact";
import type { AthletePass } from "./pass";
import { stateFingerprint, type TurnKey, type TurnStore } from "./turnStore";

const logger = createLogger("agent/engine/tools");

/** Tools that are never offered through a pass: the harness self-test, and anything the model provider runs itself. */
export const NOT_OVER_PASS: ReadonlySet<string> = new Set(["health_check"]);

/** What one pass tool call needs from the outside world (the database by default, at each caller). */
export interface PassToolDeps {
  neverTerms: (athleteId: string) => Promise<string[]>;
  queueApproval: (ctx: ToolContext, tool: AgentTool, args: Record<string, unknown>) => Promise<ApprovalItem>;
  turns: TurnStore;
  resultMaxChars: number;
  /** The account-deletion fence callTool checks (default lib/privacy/deletionFence.ts). */
  isDeleting?: (athleteId: string) => Promise<boolean>;
}

let _passRegistry: ToolRegistry | null = null;
/** The app's registry (coreTools.ts). */
export function passRegistry(): ToolRegistry {
  if (_passRegistry) return _passRegistry;
  const r = new ToolRegistry();
  for (const t of defaultRegistry().all()) r.register(t);
  return (_passRegistry = r);
}

/** The skill as a pass enforces it: its tools that can be called through a pass. */
export function passSkill(skill: Pick<Skill, "id" | "tools">, registry: ToolRegistry): Pick<Skill, "id" | "tools"> {
  const tools = skill.tools.filter((n) => !NOT_OVER_PASS.has(n) && registry.get(n)?.kind !== "builtin");
  return { id: skill.id, tools };
}

/** The tools this pass may see: its skill's, flag on, permission within scp. */
export function visibleTools(skill: Pick<Skill, "id" | "tools">, registry: ToolRegistry, pass: Pick<AthletePass, "scopes">): AgentTool[] {
  return skill.tools.flatMap((n) => {
    const t = registry.get(n);
    if (!t || t.kind === "builtin") return [];
    if (t.enabled && !t.enabled()) return [];
    if (!pass.scopes.includes(t.permission)) return [];
    return [t];
  });
}

/** The catalog: every tool that can be called over MCP and whose server flag is on. No athlete, skill or scope. */
export function catalogTools(registry: ToolRegistry): AgentTool[] {
  return registry.all().filter((t) => t.kind !== "builtin" && !NOT_OVER_PASS.has(t.name) && (t.enabled?.() ?? true));
}

/**
 * ONE tool call for a VERIFIED pass: the per-call path of the Mastra engine's in-process tools
 * (agent/engine/mastra/tools.ts). scp is checked first, then callTool (policy ->
 * validate -> prepare -> queue or run) with the athlete, run and skill FROM THE PASS; the turn store keeps cards,
 * approvals, evidence and a record of the call. Returns the model-facing text and whether it is an error.
 * `fence` is the caller's fresh deletion-fence check (deletionFence.ts clearFence); callTool checks the fence itself and
 * reuses it while fresh, so passing it only saves a read.
 */
export async function callPassTool(
  pass: AthletePass, skill: Pick<Skill, "id" | "tools">, registry: ToolRegistry, name: string, args: Record<string, unknown>, deps: PassToolDeps,
  fence?: FenceClearance,
): Promise<{ text: string; isError: boolean; cards?: ChatCard[]; approval?: ApprovalItem }> {
  const key: TurnKey = { athleteId: pass.athleteId, sessionId: pass.sessionId, runId: pass.runId };
  const citing = skill.tools.includes("cite_facts");
  const tool = registry.get(name);
  const t0 = Date.now();
  const log = (outcome: string, rule?: string | null) =>
    logger.info({ athleteId: pass.athleteId, runId: pass.runId, skillId: skill.id, jti: pass.jti, tool: name, outcome, rule: rule ?? null, ms: Date.now() - t0 }, "mcp tool call");

  // scp: refused before prepare, whatever the policy would say.
  if (tool && !pass.scopes.includes(tool.permission)) {
    log("denied", "scope");
    return { text: JSON.stringify({ status: "error", reason: `not allowed: this session may not use ${tool.permission} tools` }), isError: true };
  }

  // Per-athlete enablement is checked inside callTool (agent/welcome/toolGate.ts): capability_off, recorded below.

  const neverTerms = await deps.neverTerms(pass.athleteId).catch(() => [] as string[]);
  // The tools' shared state is the SESSION's (turnStore.ts). A call that changed it (a new F-key, a connector offered)
  // saves compare-and-set; if another call of the turn saved first, a read call is simply run again on the fresh
  // state (it changed nothing else), and any other call keeps its result and its state change is merged where it
  // does not collide.
  let out: Awaited<ReturnType<typeof callTool>>;
  for (let attempt = 1; ; attempt++) {
    const { turn, version } = await deps.turns.loadState(key);
    const before = stateFingerprint(turn);
    const ctx: ToolContext = { athleteId: pass.athleteId, runId: pass.runId, skillId: skill.id, turn, ...(fence ? { fence } : {}) };
    out = await callTool({ skill, tool, name, args, ctx, neverTerms, queueApproval: deps.queueApproval, citing, ...(deps.isDeleting ? { isDeleting: deps.isDeleting } : {}) });
    if (stateFingerprint(turn) === before || await deps.turns.saveState(key, turn, version)) break;
    if (tool?.permission === "read" && attempt < 3) continue;
    await mergeState(deps.turns, key, turn);
    break;
  }
  log(out.outcome, out.verdict?.rule);
  await deps.turns.addTool(key, {
    name, kind: tool?.kind ?? "ours", permission: tool?.permission ?? "read", outcome: out.outcome, durationMs: Date.now() - t0,
    ...(out.outcome === "denied" ? { rule: out.rule, reason: out.reason } : {}),
    ...(out.outcome === "error" ? { reason: out.reason } : {}),
    ...(out.outcome === "queued_for_approval" ? { rule: out.rule, approvalId: out.approval.id } : {}),
  }).catch((err) => logger.warn({ err: err?.message }, "tools: tool record not kept"));

  switch (out.outcome) {
    case "ok": {
      await deps.turns.addOk(key, out.cards, out.evidence);
      const json = compactJson(out.reply as Record<string, unknown>, deps.resultMaxChars);
      // A tool's ok result is outside data (memory, a page, an email): fenced (deals/tools.test.ts T2b pins it).
      // `cards` and `approval` are for the caller's display only (chat v2's cards as each call ends); the model sees `text`.
      return { text: external(json, {}, { newlines: true })!, isError: false, cards: out.cards };
    }
    case "queued_for_approval":
      await deps.turns.addApproval(key, out.approval);
      return { text: JSON.stringify(out.reply), isError: false, approval: out.approval };
    default:
      return { text: compactJson(out.reply as Record<string, unknown>, deps.resultMaxChars), isError: true };
  }
}

/**
 * A non-read call's state change, after another call of the same turn saved first: reload and add what this call added
 * where it does not collide (a new F-key whose number is still free, a connector offered). Up to three tries.
 */
async function mergeState(turns: TurnStore, key: TurnKey, mine: TurnState): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const { turn: fresh, version } = await turns.loadState(key);
    for (const [k, id] of mine.factKeys) if (!fresh.factKeys.has(k)) fresh.factKeys.set(k, id);
    for (const c of mine.offeredConnectors) if (!fresh.offeredConnectors.includes(c)) fresh.offeredConnectors.push(c);
    if (await turns.saveState(key, fresh, version)) return;
  }
  logger.warn({ athleteId: key.athleteId, runId: key.runId }, "tools: tool state not saved after three tries");
}
