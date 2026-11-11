/**
 * webSearch.db.test.ts — web search on Mila's Mastra chat (P1, 5 Nov 2026), end to end on PGlite: the REAL Mastra Agent
 * loop with a scripted model, the real web_search tool and the real runSkill → callStructured path behind a fake
 * Responses transport (no provider, no network). Made-up athletes.
 *
 *   W1  a chat turn is offered web_search; one call runs ONE fast-tier OpenAI search (store:false, max_tool_calls 1,
 *       the chat/web-search skill) through runSkill: its own agent_runs row (parent_ref mastra-search:<run>:1) with its
 *       cost and web_search trace step; the model gets a fenced answer; the turn's row counts the search
 *       (web_search_calls) and keeps the model's own cost; the pages go on "How I got this"; the turn's own model call
 *       got store:false through Mastra
 *   W2  the per-turn cap (chat: 2): a third call is refused without a search, recorded as denied
 *   W3  the run cap counts the searches: an expensive search stops the turn after that step (cost_cap_run)
 *   W4  a failed search is an error result the model can recover from, never a failed turn
 *   W5  a skill that does not list web_search (the waitlist) is never offered it
 *   W6  the athlete's day cap reached: the search is refused (no call), recorded as denied
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../services/push/events", () => ({ pushWaiting: jest.fn() }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentRuns } from "../../../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { scriptedModel, testRuntime, type ScriptedStep } from "../../../testUtils/mastraScripted";
import { fakeResponses, skillOf } from "../../../testUtils/agentModel";
import type { SSEStream } from "../../../lib/sse";
import { clearJobCache } from "../../jobs";
import { costOf } from "../../models";
import { setResponsesTransport } from "../../research/llm";
import { runMastraTurn, type MastraTurnDeps } from "./turn";
import { CHAT_WEB_SEARCH_SKILL, WEB_SEARCH_DESCRIPTION, WEB_SEARCH_TOOL, WebSearchDayCap, searchParentRef, type WebSearchCall } from "./webSearch";

const KEY = "mastra-websearch-test-pass-key-0123456789-0123";
const ENV = ["NOMILA_MCP_PASS_KEY", "AGENT_SKILL_CAPS"] as const;
const saved: Record<string, string | undefined> = {};
let A = "";

function sse(): SSEStream & { tokens: string[]; doneWith: any } {
  const s: any = { tokens: [], doneWith: null, closed: false, signal: new AbortController().signal };
  s.status = () => undefined; s.token = (t: string) => s.tokens.push(t); s.done = (d: unknown) => { s.doneWith = d; };
  s.suggestions = () => undefined; s.profileUpdates = () => undefined; s.error = () => undefined; s.close = () => { s.closed = true; }; s.abort = () => undefined;
  return s;
}

async function engine(steps: ScriptedStep[], extra: Partial<MastraTurnDeps> = {}) {
  const m = scriptedModel(steps);
  const rt = await testRuntime(m.model);
  const deps: MastraTurnDeps = { runtime: async () => rt, passKey: KEY, spentToday: async () => 0, isDeleting: async () => false, toolsDeleting: async () => false, fold: false, platformBudget: async () => ({ over: false }) as never, ...extra };
  return { m, deps };
}
const search = (q: string, id?: string) => ({ tools: [{ name: WEB_SEARCH_TOOL, args: { query: q }, ...(id ? { id } : {}) }] });
const fixedSearch = (microUsd: number): WebSearchCall => async (q) => ({
  answer: `Found: ${q}.`, queries: [q], sources: [{ url: `https://example.org/${encodeURIComponent(q)}`, title: "Example page" }],
  cost: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 40, reasoningTokens: 0, webSearchCalls: 1, microUsd },
});

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  // Mastra's chat needs the pass key only: no /mcp, no MILA_TF_CHAT (P1).
  for (const k of ENV) delete process.env[k];
  process.env.NOMILA_MCP_PASS_KEY = KEY;
  await initTestDb();
  A = await seedAthlete("Juniper Hale");
}, 120_000);
afterAll(async () => {
  setResponsesTransport(null);
  await closeTestDb();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
beforeEach(() => { clearJobCache(); delete process.env.AGENT_SKILL_CAPS; setResponsesTransport(null); });

describe("W1: one web search on a Mastra chat turn", () => {
  it("runs one fast-tier OpenAI search with store:false and counts it on the turn's ledger row", async () => {
    const transport = fakeResponses(() => ({
      json: { answer: "Tour stops this spring: Austin on 14 March." }, sources: [{ url: "https://tour.example/2027", title: "Tour 2027" }],
      queries: ["tour schedule 2027"], usage: { input: 900, output: 60 },
    }));
    setResponsesTransport(transport);
    const { m, deps } = await engine([search("pro tour 2027 spring stops"), { text: "Austin is on 14 March." }]);
    const s = sse();
    const res = await runMastraTurn({ athleteId: A, message: "When is the Austin stop?", conversationId: randomUUID(), sse: s }, deps);

    expect(res).toMatchObject({ status: "completed", text: "Austin is on 14 March." });
    // Offered, with the registered description.
    expect(m.toolNames[0]).toContain(WEB_SEARCH_TOOL);
    expect(m.toolDescriptions[0][WEB_SEARCH_TOOL]).toBe(WEB_SEARCH_DESCRIPTION);
    // ZDR on the turn's own model calls, through Mastra.
    for (const po of m.providerOptions) expect((po as any)?.openai).toMatchObject({ store: false });

    // The search request: the existing helper's (callStructured) shape, one search, store:false, the chat/web-search skill.
    expect(transport.calls).toHaveLength(1);
    const body = transport.calls[0];
    expect(skillOf(body)).toBe(CHAT_WEB_SEARCH_SKILL);
    expect(body).toMatchObject({ store: false, max_tool_calls: 1, tools: [{ type: "web_search", search_context_size: "low" }] });
    expect(body.model).toBe("gpt-6-luna");
    expect(JSON.stringify(body.input)).toContain("pro tour 2027 spring stops");

    // What the model read: the fenced answer and the pages.
    const toolResult = JSON.stringify(m.prompts[1]);
    expect(toolResult).toContain("Tour stops this spring: Austin on 14 March.");
    expect(toolResult).toContain("https://tour.example/2027");

    // The ledger: the search is its own agent_runs row (cost, its web_search trace step), linked to the turn.
    const searchCost = costOf("gpt-6-luna", { inputTokens: 900, cachedInputTokens: 0, outputTokens: 60, reasoningTokens: 50, webSearchCalls: 1 }).microUsd;
    const modelCost = costOf("gpt-6-luna", { inputTokens: 2000, cachedInputTokens: 1600, outputTokens: 100, reasoningTokens: 20, webSearchCalls: 0 }).microUsd;
    const [row] = await db.select().from(agentRuns).where(and(eq(agentRuns.athlete_id, A), eq(agentRuns.parent_ref, searchParentRef(res.runId!, 1))));
    expect(row).toMatchObject({ skill_id: CHAT_WEB_SEARCH_SKILL, status: "completed", trigger: "chat", web_search_calls: 1, cost_micro_usd: searchCost });
    expect(searchCost).toBeGreaterThan(0);
    const ws = (row.steps as any[]).filter((st) => st.type === "web_search");
    expect(ws).toEqual([expect.objectContaining({ queries: ["tour schedule 2027"], sources: [{ url: "https://tour.example/2027", title: "Tour 2027" }] })]);
    // The turn's row: the search counted (no more hard-coded 0), its cost left on the search's row (never counted twice).
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run.web_search_calls).toBe(1);
    expect(run.cost_micro_usd).toBe(modelCost);
    expect((run.tools_called as any[]).map((t) => [t.name, t.kind, t.outcome])).toEqual([[WEB_SEARCH_TOOL, "builtin", "ok"]]);
    expect(run.evidence_read).toEqual(expect.arrayContaining([{ kind: "url", url: "https://tour.example/2027", title: "Tour 2027" }]));
    expect(JSON.stringify(s.doneWith.cards ?? [])).toContain("https://tour.example/2027");
  });
});

describe("W2: the per-turn cap", () => {
  it("chat allows 2 searches a turn; a third call is refused without a search", async () => {
    const calls: string[] = [];
    const seen: number[] = [];
    const fake: WebSearchCall = async (q, p) => { calls.push(q); seen.push(p.n); expect(p.athleteId).toBe(A); return fixedSearch(5_000)(q, p); };
    const { m, deps } = await engine([search("one", "c1"), search("two", "c2"), search("three", "c3"), { text: "Done." }], { webSearch: fake });
    const res = await runMastraTurn({ athleteId: A, message: "Look three things up.", conversationId: randomUUID(), sse: sse() }, deps);
    expect(res.status).toBe("completed");
    expect(calls).toEqual(["one", "two"]);
    expect(seen).toEqual([1, 2]);
    expect(JSON.stringify(m.prompts[3])).toContain("web search limit reached for this turn (2)");
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run.web_search_calls).toBe(2);
    expect((run.tools_called as any[]).map((t) => t.outcome)).toEqual(["ok", "ok", "denied"]);
  });

  it("AGENT_SKILL_CAPS can lower it to 0: web_search is not offered at all", async () => {
    process.env.AGENT_SKILL_CAPS = JSON.stringify({ chat: { max_web_searches: 0 } });
    const { m, deps } = await engine([{ text: "Hi." }], { webSearch: fixedSearch(1) });
    await runMastraTurn({ athleteId: A, message: "Hi.", conversationId: randomUUID(), sse: sse() }, deps);
    expect(m.toolNames[0]).not.toContain(WEB_SEARCH_TOOL);
  });
});

describe("W3: the run cap counts the searches", () => {
  it("an expensive search stops the turn after that step", async () => {
    const { m, deps } = await engine([search("pricey"), { text: "never reached" }], { webSearch: fixedSearch(200_000) });   // $0.20 > chat's $0.15
    const res = await runMastraTurn({ athleteId: A, message: "Look it up.", conversationId: randomUUID(), sse: sse() }, deps);
    expect(res).toMatchObject({ status: "stopped", stopReason: "cost_cap_run" });
    expect(m.calls).toBe(1);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run.web_search_calls).toBe(1);
  });
});

describe("W4: a failed search", () => {
  it("is an error result the model recovers from; the turn completes", async () => {
    const { m, deps } = await engine([search("down"), { text: "I couldn't look that up just now." }], { webSearch: async () => { throw new Error("provider down"); } });
    const res = await runMastraTurn({ athleteId: A, message: "Look it up.", conversationId: randomUUID(), sse: sse() }, deps);
    expect(res.status).toBe("completed");
    expect(JSON.stringify(m.prompts[1])).toContain("the web search failed; answer without it");
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run.web_search_calls).toBe(0);
    expect((run.tools_called as any[]).map((t) => t.outcome)).toEqual(["error"]);
  });
});

describe("W5: only for a skill that lists web_search", () => {
  it("the waitlist skill is never offered it", async () => {
    const { m, deps } = await engine([{ text: "Welcome." }], { webSearch: fixedSearch(1) });
    await runMastraTurn({ athleteId: A, message: "Hi.", conversationId: randomUUID(), sse: sse() }, deps, { skillId: "waitlist", scopes: ["read", "draft"] });
    expect(m.toolNames[0]).not.toContain(WEB_SEARCH_TOOL);
  });
});

describe("W6: the day cap", () => {
  it("a search refused at the day cap is recorded as denied, and the turn completes", async () => {
    const { m, deps } = await engine([search("late"), { text: "I can't look that up today." }], { webSearch: async () => { throw new WebSearchDayCap("day"); } });
    const res = await runMastraTurn({ athleteId: A, message: "Look it up.", conversationId: randomUUID(), sse: sse() }, deps);
    expect(res.status).toBe("completed");
    expect(JSON.stringify(m.prompts[1])).toContain("today's spending limit is reached");
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, res.runId!));
    expect(run.web_search_calls).toBe(0);
    expect((run.tools_called as any[]).map((t) => [t.outcome, t.rule])).toEqual([["denied", "cost_cap"]]);
  });
});
