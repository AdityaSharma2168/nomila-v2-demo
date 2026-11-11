/**
 * evals/agent/mila-v2/flows.ts — the OFFLINE runner: a scenario's scripted model turn played through the REAL Mila
 * build on Mastra, with no provider, no network and no database of ours (the suites mock server/db, or give it PGlite).
 *
 * What is real, assembled the way agent/engine/mastra/turn.ts assembles a turn:
 *   agent      the Mastra Agent with Mila's own definition (runtime.ts milaAgentDefinition: Mila's instructions in Mastra's
 *              words, Mila's playbooks as agent skills scoped to the turn's surface), on an in-memory Mastra store
 *   tools      the app's registry (coreTools.ts createDefaultRegistry) over in-memory stores, the skill's visible tools
 *              (mcp/server.ts visibleTools, flags and scopes), per-athlete enablement (welcome/toolGate.ts allowedTools),
 *              each call through the one per-call path (engine/mastra/tools.ts → mcp/server.ts callPassTool → callTool:
 *              the signed pass, policy, never-terms, tap-to-send / confirm-first queueing, schema, prepare, execute)
 *   cards      what each call made (the tools' own card builders), as chat v2's display gets them
 *   input      the same turn input the live runner sends (scenarios.ts userTurn, in Mastra's words)
 *
 * What is not: the model (testUtils/mastraScripted: each step is scripted tool calls or text), the approvals table
 * (queued items are kept in memory), and the deal / booking / document / read sources (in memory, from the scenario).
 *
 * flows.json holds, per scenario: the hidden `world`, what is `expect`ed (checks.ts), the `right` scripted turn and
 * the `wrong` ones, each naming exactly the checks it must fail.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalItem, ChatCard } from "../../../shared/agent";
import type { ToolRegistry } from "../../../server/agent/tools";
import { scriptedModel, testRuntime, type ScriptedStep } from "../../../server/testUtils/mastraScripted";
import type { CheckName, FlowExpect, FlowWorld, Outcome, PlayedCall, PlayedTurn } from "./checks";
import { userTurn, type Scenario } from "./scenarios";

export interface WrongTurn {
  why: string;
  steps: ScriptedStep[];
  /** Exactly the checks this turn must fail. */
  fails: CheckName[];
  /** What the build must have done with this turn's calls (the guard held although the model went wrong). */
  guard?: Record<string, Outcome>;
}
export interface Flow {
  /** Why it can't all be graded here, for a scenario whose checks are live-only. */
  live_only?: string;
  world?: FlowWorld & {
    /** Saved facts recall_facts reaches. */
    facts?: Array<{ claim: string; topic?: string }>;
    /** Deals the deal tools read (agent/deals/memorySource.ts MemoryDeal). */
    deals?: unknown[];
    /** Brands and documents the documents tools read (agent/documents/memorySource.ts MemoryDocsFixture). */
    documents?: unknown;
    /** Turn-on suite: a Turn-on card for this capability was shown a minute ago. */
    recentOffer?: string;
    /** Turn-on suite: they declined this capability in words. */
    declined?: string;
    /** Turn-on suite: they have a Gmail account connected (what a per-account capability such as draft replies rests on). */
    mailbox?: boolean;
  };
  expect: FlowExpect;
  right: ScriptedStep[];
  wrong: WrongTurn[];
}
const FILE = JSON.parse(readFileSync(join(__dirname, "flows.json"), "utf8")) as { flows: Record<string, Flow>; live_only: Record<string, string> };
export const FLOWS = FILE.flows;
/** The golden scenarios graded only live, and why. */
export const LIVE_ONLY = FILE.live_only;

export const PASS_KEY = "flow-evals-pass-key-0123456789-0123456789";
export const ATHLETE = "f10e0a11-0000-4000-8000-0000000000f1";
const THREAD = "f10e0a11-0000-4000-8000-0000000000f2";
const RUN = "f10e0a11-0000-4000-8000-0000000000f3";

export interface PlayDeps {
  /** The registry the turn's tools come from (the suite builds it over in-memory stores). */
  registry: ToolRegistry;
  athleteId?: string;
  /** The skill: "chat" (CHAT_SCOPES) or "waitlist" (WAITLIST_SCOPES), as the real turn picks them. */
  skillId?: "chat" | "waitlist";
}

/** The registry over the scenario's world: in-memory store (its facts), deals and documents; nothing else reachable. */
export async function worldRegistry(world: Flow["world"], athleteId = ATHLETE) {
  const [{ createDefaultRegistry }, { createMemoryStore }, { createMemoryDealsSource }, { createMemoryDocumentsSource }] = await Promise.all([
    import("../../../server/agent/coreTools"), import("../../../server/agent/research/store"), import("../../../server/agent/deals/memorySource"),
    import("../../../server/agent/documents/memorySource"),
  ]);
  const store = createMemoryStore();
  if (world?.facts?.length) {
    await store.insertFacts(athleteId, world.facts.map((f, i) => ({
      subject: { kind: "athlete" as const, name: "the athlete" }, claim: f.claim, type: "found" as const,
      source: { url: `https://example.org/fact-${i + 1}`, title: "Made-up source" }, date: null, confidence: 0.9, runId: null, topic: f.topic ?? null,
    })));
  }
  const deals = createMemoryDealsSource((world?.deals ?? []) as never);
  const documents = world?.documents ? createMemoryDocumentsSource(world.documents as never) : undefined;
  return { registry: createDefaultRegistry({ store, deals, ...(documents ? { documents } : {}) }), store };
}

/** `$deal:<key>` in a scripted argument → that world deal's id (memorySource.ts memoryDealId). */
async function resolveSteps(steps: ScriptedStep[]): Promise<ScriptedStep[]> {
  const { memoryDealId } = await import("../../../server/agent/deals/memorySource");
  const fix = (v: unknown): unknown => typeof v === "string" && v.startsWith("$deal:") ? memoryDealId(v.slice(6))
    : Array.isArray(v) ? v.map(fix) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)])) : v;
  return steps.map((st) => ("tools" in st ? { ...st, tools: st.tools.map((t) => ({ ...t, args: fix(t.args) as Record<string, unknown> })) } : st));
}

/** Play one scripted turn of one scenario through the real build. */
export async function playFlow(s: Scenario, steps: ScriptedStep[], world: Flow["world"], deps: PlayDeps): Promise<PlayedTurn & { offered: string[]; approvals: ApprovalItem[]; system: string }> {
  const athleteId = deps.athleteId ?? ATHLETE;
  const skillId = deps.skillId ?? "chat";
  const [{ loadJob }, { passSkill, visibleTools }, { allowedTools }, { mastraTools }, guards, { issueAthletePass }, skills, { createMemoryTurnStore }, { CHAT_SCOPES }, { WAITLIST_SCOPES, WAITLIST_SKILL_ID }, { MAX_STEPS }] = await Promise.all([
    import("../../../server/agent/jobs"), import("../../../server/agent/engine/tools/registry"),
    import("../../../server/agent/welcome/toolGate"), import("../../../server/agent/engine/mastra/tools"), import("../../../server/agent/engine/mastra/guards"),
    import("../../../server/agent/engine/tools/pass"), import("../../../server/agent/engine/mastra/skills"), import("../../../server/agent/engine/tools/turnStore"),
    import("../../../server/agent/engine/turnTypes"), import("../../../server/agent/waitlist/turn"), import("../../../server/agent/engine/mastra/turn"),
  ]);
  const scopes = skillId === "waitlist" ? [...WAITLIST_SCOPES] : [...CHAT_SCOPES];
  const skill = loadJob(skillId);
  const { registry } = deps;
  const visible = await allowedTools(athleteId, visibleTools(passSkill(skill, registry), registry, { scopes }));

  const m = scriptedModel(await resolveSteps(steps));
  const rt = await testRuntime(m.model, { mila: true });
  const turns = createMemoryTurnStore();
  const callCards = new Map<string, ChatCard[]>();
  const approvals: ApprovalItem[] = [];
  const tools = await mastraTools(visible, registry, {
    turns, passKey: PASS_KEY, isDeleting: async () => false, callCards,
    neverTerms: async () => world?.never ?? [],
    // The approvals table, in memory: the same item queueApproval builds, nothing written.
    queueApproval: async (ctx, tool, args) => {
      const item: ApprovalItem = {
        id: `approval-${approvals.length + 1}`, athleteId: ctx.athleteId, verb: tool.approval?.verb ?? ("save" as never), tool: tool.name, args,
        title: tool.approval?.title(args as never) ?? tool.name, summary: tool.approval?.summary(args as never) ?? "", status: "pending",
        runId: ctx.runId, createdAt: new Date().toISOString(), expiresAt: null,
      };
      approvals.push(item);
      return item;
    },
  });
  const pass = issueAthletePass({ athleteId, sessionId: THREAD, runId: RUN, skillId, scopes }, PASS_KEY);
  const { requestContext } = await guards.contextFromPass(pass, { athleteId, threadId: THREAD }, PASS_KEY);
  requestContext.set(skills.SKILLS_CONTEXT_KEY, { surface: skills.turnSurface({ skillId, waitlistSkillId: WAITLIST_SKILL_ID }), tools: visible.map((t) => t.name) });

  const input = userTurn(s, "mastra");
  const out: any = await rt.agent.stream(guards.turnInput(input), {
    memory: { thread: THREAD, resource: athleteId }, runId: RUN, requestContext, toolsets: { nomila: tools }, maxSteps: MAX_STEPS,
  } as never);
  const parts: string[] = [];
  let text = "";
  const calls: Array<{ id: string; name: string; args: Record<string, unknown>; result?: string }> = [];
  for await (const c of out.fullStream as AsyncIterable<{ type: string; payload?: any }>) {
    const pl = c.payload ?? {};
    if (c.type === "error") throw new Error(`the scripted turn failed: ${String(pl.error?.message ?? pl.error ?? "error")}`);
    if (c.type === "text-start" && text.trim()) { parts.push(text.trim()); text = ""; }
    if (c.type === "text-delta") text += pl.text ?? "";
    if (c.type === "tool-call") calls.push({ id: pl.toolCallId, name: pl.toolName, args: (pl.args ?? {}) as Record<string, unknown> });
    if (c.type === "tool-result" || c.type === "tool-error") {
      const call = calls.find((x) => x.id === pl.toolCallId);
      if (call) call.result = typeof pl.result === "string" ? pl.result : JSON.stringify(pl.result ?? pl.error ?? "");
    }
  }
  if (text.trim()) parts.push(text.trim());

  // What the build did with each call, in call order (callPassTool keeps one record per call it saw).
  const records = (await turns.take({ athleteId, sessionId: THREAD, runId: RUN }))?.tools ?? [];
  const offered = visible.map((t) => t.name);
  // By name, in order: a call Mastra refused before it reached our path (its own schema check) leaves no record: error.
  const byName = new Map<string, typeof records>();
  for (const rec of records) byName.set(rec.name, [...(byName.get(rec.name) ?? []), rec]);
  const played: PlayedCall[] = calls.map((c) => {
    const tool = registry.get(c.name);
    if (!offered.includes(c.name)) return { name: c.name, args: c.args, outcome: "not_offered" as Outcome, result: c.result, permission: tool?.permission };
    const rec = byName.get(c.name)?.shift();
    return { name: c.name, args: c.args, outcome: (rec?.outcome ?? "error") as Outcome, rule: rec?.rule ?? null, result: c.result, permission: tool?.permission };
  });
  const cards = calls.flatMap((c) => callCards.get(c.id) ?? []).map((k) => k.kind);
  // The system text the (scripted) model was actually sent on its first step: Mila's served instructions, as built.
  const first = (m.prompts[0] ?? []) as Array<{ role?: string; content?: unknown }>;
  const system = first.filter((x) => x.role === "system").map((x) => (typeof x.content === "string" ? x.content : JSON.stringify(x.content))).join("\n");
  return { text: parts.join("\n\n"), calls: played, cards, input, offered, approvals, system };
}
