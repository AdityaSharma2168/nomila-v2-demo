/**
 * leanResearch.db.test.ts — lean sign-up research LIVE (signup_research v4, the lean_research step) and in SHADOW
 * (leanRun), plus Mila's refresh_research tool, on PGlite. Every provider is mocked: the model calls (callStructured),
 * Wikidata, the web search and the page fetch; genai() throws. Made-up athletes only.
 *
 *   D1 flag on ⇒ new sign-up runs pin v4 (lean_research → mia_preview → score_email; quick_score beside it); flag off ⇒
 *      v3 (QUICK_SCORE_ONE_CALL) or v2 exactly as before, step for step
 *   D2 happy path: verified facts saved as FOUND facts with source URL, date and topic; the calls are agent_runs rows
 *      (extract, verify, and the searches' cost); the identity outcome is recorded; the step output says what was kept
 *   D3 a retried step pays nothing again and writes no copy (runSkill reuse + de-duplication)
 *   D4 identity not confirmed ⇒ no fact kept; a disputed "#identity" fact holds M.I.A., exactly as the merge records it
 *   D4b an identity-topic refresh re-checks a held identity: still unsure ⇒ its verdict replaces the old one (one open);
 *      confirmed ⇒ no open verdict
 *   D5 a conflict with a held fact ⇒ both disputed (the held one points at the new one)
 *   D6 shadow mode (leanShadowRun) writes nothing anywhere
 *   D7 refresh_research: hidden when the flag is off; started / already running / rate limited / a correction lifts the
 *      limit / the day cap refuses
 *   D8 the waitlist progress reads a lean run (done; the web and "checking" lines are the lean step)
 *   D9 topic-balanced scorer selection only for a lean athlete with the flag on
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../lib/backgroundHost", () => ({ runsBackgroundWork: () => false }));   // kick is a no-op
jest.mock("../../lib/models", () => ({ ...jest.requireActual("../../lib/models"), genai: () => ({ models: { generateContent: async () => { throw new Error("no provider in tests"); } } }) }));
const modelCalls: Array<{ skill: string; model: string }> = [];
let identityResolved = true;
let goalsClaim = "Casey Example scored 7 goals in 2025.";
jest.mock("../research/llm", () => {
  const actual = jest.requireActual("../research/llm");
  return {
    ...actual,
    callStructured: async (req: any) => {
      modelCalls.push({ skill: req.skill.id, model: req.model.model });
      const cost = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, reasoningTokens: 0, webSearchCalls: 0, microUsd: req.skill.id === "research/extract-all" ? 120_000 : 4_000 };
      if (req.skill.id === "research/extract-all") {
        const urls = [...String(req.input).matchAll(/^URL: (\S+)/gm)].map((m) => m[1]);
        const fact = (claim: string, topic: string, url: string) => ({ subject_kind: "athlete", subject_name: "Casey Example", claim, topic, source_url: url, source_title: "Page", source_type: "official", date: "2025", confidence: 0.9, sensitivity: "none", never_reason: "none", care_kind: "none" });
        const json = {
          identity: { resolved: identityResolved, description: "A college rowing athlete.", ambiguity: identityResolved ? "" : "Two rowers share this name.", candidates: [] },
          facts: [fact(goalsClaim, "stats", urls[0]), fact("Casey Example signed an NIL deal with Example Brand.", "sponsor", urls[0])], gaps: ["no audience numbers"], narrative: "",
        };
        return { json, text: "", status: "completed", responseId: null, usage: cost, cost, queries: [], sources: [], durationMs: 5 };
      }
      const ids = [...String(req.input).matchAll(/^(F\d+) \|/gm)].map((m) => m[1]);
      const json = { results: ids.map((id) => ({ id, verdict: "supported", reason: "stated" })) };
      return { json, text: "", status: "completed", responseId: null, usage: cost, cost, queries: [], sources: [], durationMs: 2 };
    },
  };
});
jest.setTimeout(180_000);

import { and, eq, sql } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { agentRuns, memoryFactReviews, memoryFacts } from "../../../shared/schema";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { getDefinition } from "../../workflow/registry";
import "../../workflow/definitions/index";
import { startSignupAgentResearch } from "./signupResearch";
import { runLeanStep } from "./leanResearchStep";
import { parentPrefixFor } from "./workflow";
import { researchStateFrom, researchStepsFrom } from "./waitlistProgress";
import { leanShadowRun } from "../research/v2/leanShadow";
import { researchTools, REFRESH_RESEARCH_TOOL } from "../researchRefresh/tools";
import { requestLeanRefresh, LEAN_REFRESH_PROCESS } from "../researchRefresh/leanRefresh";
import { createDefaultRegistry } from "../coreTools";
import { loadJob } from "../jobs";
import { leanBalancedFor } from "../../services/miaPreview/memoryAdapter";
import type { WikidataGet } from "../research/v2/wikidata";

const env = process.env;
const para = (s: string, n = 6) => Array.from({ length: n }, () => s).join(" ");
const html = (title: string, body: string) => `<html><head><title>${title}</title><meta property="article:published_time" content="2026-09-12T10:00:00Z"></head><body><article><h1>${title}</h1><p>${body}</p><p>${body}</p></article></body></html>`;
const PAGE = "https://rowing.example.edu/roster/casey-example";
const fetchImpl = (async (u: any) => {
  const url = String(u);
  if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
  if (url === PAGE) return new Response(html("Casey Example — Rowing roster", para("Casey Example is a rowing athlete at Example State and scored 7 goals in 2025.")), { headers: { "content-type": "text/html" } });
  return new Response("missing", { status: 404 });
}) as any;
const noWikidata: WikidataGet = async (p) => (p.action === "wbsearchentities" ? { search: [] } : { entities: {} });
const search = jest.fn(async () => ({ results: [{ url: PAGE, title: "Roster" }], costMicroUsd: 10_000, searchQueries: 1, searchFeeMicroUsd: 10_000 }));
const deps = { fetchImpl, wikidataGet: noWikidata, discoverQuery: search };

let seq = 0;
async function athlete(): Promise<{ id: string; ctx: any; name: string }> {
  seq++;
  const name = "Casey Example";
  const id = await seedAthlete(name, { sport: "Rowing", email: `casey${seq}@example.com`, status: "waitlisted" } as any);
  const runId = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return { id, name, ctx: { runId, athleteId: id, runInput: { name, sport: "Rowing" }, outputs: {}, attempt: 1, process: "signup_research", definitionVersion: 4, step: "lean_research", input: {} } };
}
const found = async (id: string) => db.select().from(memoryFacts).where(and(eq(memoryFacts.athlete_id, id), eq(memoryFacts.type, "found")));
const runsOf = async (id: string) => db.select().from(agentRuns).where(eq(agentRuns.athlete_id, id));
const step = (ctx: any) => runLeanStep(ctx, { moment: "signup", parentPrefix: parentPrefixFor(ctx.runId), capMicroUsd: 2_000_000, deps });

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { process.env = env; await closeTestDb(); });
beforeEach(() => {
  process.env = { ...env, LEAN_SIGNUP_RESEARCH: "true" };
  delete process.env.QUICK_SCORE_ONE_CALL; delete process.env.DAILY_RESEARCH_CAP_USD; delete process.env.LEAN_RESEARCH_EXTRACT_MODEL;
  modelCalls.length = 0; identityResolved = true; goalsClaim = "Casey Example scored 7 goals in 2025.";
});

test("D1: flag on ⇒ v4 (lean_research in place of the passes and merge); flag off ⇒ v3 / v2 unchanged", async () => {
  expect(getDefinition("signup_research", 4).steps.map((s) => `${s.ordinal}:${s.name}`)).toEqual(["0:lean_research", "0:quick_score", "1:mia_preview", "2:score_email"]);
  expect(getDefinition("signup_research").version).toBe(2);   // v4 is opt-in: the default stays v2
  expect(getDefinition("signup_research", 3).steps.map((s) => `${s.ordinal}:${s.name}`)).toEqual(["0:research_a", "0:research_b", "0:quick_score", "1:research_merge", "2:mia_preview", "3:score_email"]);
  const versionOf = async () => {
    const { id } = await athlete();
    const r = await startSignupAgentResearch(id, { createdBy: "signup" });
    expect(r.started).toBe(true);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, (r as any).runId));
    return run.definition_version;
  };
  expect(await versionOf()).toBe(4);
  delete process.env.LEAN_SIGNUP_RESEARCH;
  expect(await versionOf()).toBe(2);
  process.env.QUICK_SCORE_ONE_CALL = "true";
  expect(await versionOf()).toBe(3);
  process.env.LEAN_SIGNUP_RESEARCH = "false";
  expect(await versionOf()).toBe(3);
});

test("D2: verified facts saved as FOUND facts (source URL, date, topic); every call an agent_runs row; identity recorded", async () => {
  const { id, ctx } = await athlete();
  const out: any = await step(ctx);
  expect(out).toMatchObject({ outcome: "confirmed", identity_resolved: true, inserted: 2, duplicates: 0, facts_verified: 2 });
  expect(out.by_dimension.commercial_proof).toBe(1);
  const facts = await found(id);
  expect(facts.map((f) => f.claim).sort()).toEqual(["Casey Example scored 7 goals in 2025.", "Casey Example signed an NIL deal with Example Brand."]);
  for (const f of facts) expect(f).toMatchObject({ status: "active", source_url: PAGE, observed_on: "2025-01-01", date_precision: "year", source_type: "official" });
  expect(facts.map((f) => f.topic).sort()).toEqual(["sponsor", "stats"]);
  const runs = await runsOf(id);
  // One search record per round (the first round, and the follow-up for the dimensions it left empty), each the moment
  // its search finished (before any extract the platform day cap could refuse).
  expect(runs.map((r) => r.skill_id).sort()).toEqual(["research/extract-all", "research/lean-discover", "research/lean-discover", "research/verify-facts"]);
  expect(runs.filter((r) => r.skill_id === "research/lean-discover").map((r) => String(r.parent_ref).replace(/^.*:lean_discover/, "lean_discover")).sort()).toEqual(["lean_discover", "lean_discover:r2"]);
  expect(runs.every((r) => String(r.parent_ref).startsWith(parentPrefixFor(ctx.runId)))).toBe(true);
  expect(runs.find((r) => r.skill_id === "research/extract-all")).toMatchObject({ model: "gpt-6.1-sol", effort: "low", cost_micro_usd: 120_000 });
  expect(Number(runs.find((r) => r.skill_id === "research/lean-discover")!.cost_micro_usd)).toBeGreaterThan(0);
  const identity = (await db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, id))).filter((f) => String(f.source_ref ?? "").endsWith("#identity"));
  expect(identity).toEqual([]);
});

test("D3: a retried step pays nothing again and writes no copy", async () => {
  const { id, ctx } = await athlete();
  await step(ctx);
  const calls = modelCalls.length;
  const searches = search.mock.calls.length;
  const again: any = await step({ ...ctx, attempt: 2 });
  expect(modelCalls.length).toBe(calls);                      // extract and verify reused (same parent ref)
  expect(search.mock.calls.length).toBe(searches);            // both rounds' searches reused: nothing paid twice
  expect(again).toMatchObject({ inserted: 0, duplicates: 2 });
  expect(await found(id)).toHaveLength(2);
  expect((await runsOf(id)).filter((r) => r.skill_id === "research/lean-discover")).toHaveLength(2);   // searches reused: no new record
});

test("D4: identity not confirmed ⇒ nothing kept; a disputed #identity fact holds M.I.A.", async () => {
  identityResolved = false;
  const { id, ctx } = await athlete();
  const out: any = await step(ctx);
  expect(out).toMatchObject({ outcome: "unconfirmed", identity_resolved: false, inserted: 0, unconfirmed_reason: "Two rowers share this name." });
  expect(modelCalls.map((c) => c.skill)).toEqual(["research/extract-all"]);   // no verify call
  expect(await found(id)).toEqual([]);
  const made = await db.select().from(memoryFacts).where(and(eq(memoryFacts.athlete_id, id), eq(memoryFacts.type, "made")));
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ status: "disputed" });
  expect(String(made[0].source_ref)).toMatch(/#identity$/);
  expect(made[0].claim).toContain("Two rowers share this name.");
});

test("D4b: an identity-topic refresh re-checks a held identity — confirmed closes the verdict; still unsure replaces it", async () => {
  const openVerdicts = async (id: string) => (await db.select().from(memoryFacts).where(and(eq(memoryFacts.athlete_id, id), eq(memoryFacts.type, "made"))))
    .filter((f) => (f.status === "active" || f.status === "disputed") && String(f.source_ref).endsWith("#identity"));
  const refresh = (ctx: any, runId: string) => runLeanStep({ ...ctx, runId, process: "lean_research_refresh", definitionVersion: 1 }, { moment: "refresh", parentPrefix: `research_refresh:${runId}`, capMicroUsd: 1_500_000, aims: [], deps });
  // Sign-up could not tell: one open verdict.
  identityResolved = false;
  const { id, ctx } = await athlete();
  await step(ctx);
  const [first] = await openVerdicts(id);
  expect(first).toBeDefined();
  // A re-check that still cannot tell: its verdict replaces the old one (one open, the old superseded by it).
  modelCalls.length = 0;
  await refresh(ctx, "00000000-0000-4000-8000-0000000000a1");
  expect(modelCalls.map((c) => c.skill)).toEqual(["research/extract-all"]);   // the identity check ran (no verify: nothing kept)
  const open = await openVerdicts(id);
  expect(open).toHaveLength(1);
  expect(open[0].id).not.toBe(first.id);
  expect((await db.select().from(memoryFacts).where(eq(memoryFacts.id, first.id)))[0]).toMatchObject({ status: "superseded", superseded_by: open[0].id });
  // A re-check that confirms her: no open verdict (M.I.A. is no longer held), her facts kept.
  identityResolved = true;
  const out: any = await refresh(ctx, "00000000-0000-4000-8000-0000000000a2");
  expect(out).toMatchObject({ outcome: "confirmed", identity_resolved: true });
  expect(await openVerdicts(id)).toEqual([]);
});

test("D5: a conflict with a held fact ⇒ both disputed", async () => {
  const { id, ctx } = await athlete();
  const [held] = await db.insert(memoryFacts).values({ athlete_id: id, subject_kind: "athlete", subject_name: "Casey Example", claim: "Casey Example scored 9 goals in 2025.", type: "found", source_url: "https://other.example.com/x", observed_on: "2025-01-01", confidence: 0.8, status: "active" } as any).returning();
  const out: any = await step(ctx);
  expect(out.disputed).toBe(1);
  const rows = await found(id);
  const fresh = rows.find((f) => f.claim === "Casey Example scored 7 goals in 2025.")!;
  expect(fresh).toMatchObject({ status: "disputed", disputes: held.id });
  expect(rows.find((f) => f.id === held.id)).toMatchObject({ status: "disputed", disputes: fresh.id });
});

test("D6: shadow mode writes nothing anywhere", async () => {
  const { id } = await athlete();
  const counts = async () => {
    const one = async (t: string) => Number(((await db.execute(sql.raw(`select count(*)::int as n from ${t}`))) as any).rows[0].n);
    return { facts: await one("memory_facts"), runs: await one("agent_runs"), workflows: await one("workflow_runs"), steps: await one("workflow_steps"), snapshots: await one("mia_evidence_snapshots"), evaluations: await one("mia_evaluation_runs"), ledger: await one("intelligence_ledger") };
  };
  const before = await counts();
  const scoreCall = jest.fn(async () => ({ model: "gemini-test", modelVersion: null, responseId: null, latencyMs: 3, finishReason: "STOP", truncated: false, usage: { promptTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2, searchCalls: 0 }, costUsd: 0.01, text: "not json", native: {} }));
  const scoreParams = { params: { config: { subWeights: {} } }, bundle: {} } as any;
  const r = await leanShadowRun({ id, name: "Casey Example", sport: "Rowing" }, { search: "openai", dry: false, fresh: true, selection: "balanced" }, { ...deps, scoreCall: scoreCall as any, scoreParams });
  expect(r.outcome).toBe("confirmed");
  expect(r.wouldWrite.insert).toBe(2);
  expect(scoreCall).toHaveBeenCalled();
  expect(r.scorer.input?.selection).toBe("topic_balanced");
  expect(r.steps.extract.usd).toBeCloseTo(0.12);
  expect(await counts()).toEqual(before);
});

test("D7: refresh_research — hidden when off; started, already running, rate limited, a correction lifts it, the day cap refuses", async () => {
  const chatTools = () => createDefaultRegistry().forSkill(loadJob("chat")).map((t) => t.name);
  delete process.env.LEAN_SIGNUP_RESEARCH;
  expect(chatTools()).not.toContain(REFRESH_RESEARCH_TOOL);
  const { id } = await athlete();
  expect(await requestLeanRefresh(id)).toEqual({ started: false, reason: "off" });
  process.env.LEAN_SIGNUP_RESEARCH = "true";
  expect(chatTools()).toContain(REFRESH_RESEARCH_TOOL);

  const kick = jest.fn();
  const [tool] = researchTools({ kick });
  expect(tool.permission).toBe("draft");
  const started: any = await tool.execute!({ athleteId: id, runId: "chat-run", skillId: "chat" } as any, { topics: ["partners"] });
  expect(started).toMatchObject({ status: "ok", started: true, topics: ["partners"] });
  expect(kick).toHaveBeenCalledWith(started.run_id);
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, started.run_id));
  expect(run).toMatchObject({ process: LEAN_REFRESH_PROCESS, created_by: "mila_refresh_research" });
  expect(run.input).toMatchObject({ name: "Casey Example", sport: "Rowing", aims: ["partners"] });

  expect(await tool.execute!({ athleteId: id, runId: "chat-run", skillId: "chat" } as any, {})).toMatchObject({ status: "ok", started: false, already_running: true });
  await db.update(workflowRuns).set({ status: "done" }).where(eq(workflowRuns.id, run.id));
  const limited: any = await tool.execute!({ athleteId: id, runId: "chat-run", skillId: "chat" } as any, {});
  expect(limited.status).toBe("error");
  expect(limited.reason).toMatch(/"refused":"rate_limited","next_allowed_at":"/);

  // She corrects a fact: the limit lifts and a new run starts.
  const [f] = await db.insert(memoryFacts).values({ athlete_id: id, subject_kind: "athlete", subject_name: "Casey Example", claim: "Casey Example rows for Example State.", type: "found", source_url: PAGE, confidence: 0.9, status: "active" } as any).returning();
  await db.insert(memoryFactReviews).values({ athlete_id: id, fact_id: f.id, action: "correct", correction: "Casey Example rows for Example Tech." } as any);
  const again = await requestLeanRefresh(id, ["all"], { kick });
  expect(again).toMatchObject({ started: true });

  // The day cap: no room for one more run's cap today ⇒ refused until midnight UTC.
  const other = await athlete();
  process.env.AGENT_RESEARCH_REFRESH_DAY_CAP_USD = "1"; process.env.AGENT_RESEARCH_REFRESH_RUN_CAP_USD = "1.5";
  expect(await requestLeanRefresh(other.id, ["all"], { kick })).toMatchObject({ started: false, reason: "daily_budget" });
});

test("D8: the waitlist progress reads a lean run", () => {
  const now = new Date();
  const steps = [{ step: "lean_research", status: "done", ready_at: now, output: { inserted: 12 } }, { step: "mia_preview", status: "running", ready_at: now }];
  expect(researchStateFrom({ status: "running" }, steps, now).state).toBe("done");
  const lines = researchStepsFrom({ run: steps, instagram: null, evaluation: null, scoreReady: false });
  expect(lines.find((l) => l.key === "web")?.status).toBe("done");
  expect(lines.find((l) => l.key === "merge")).toMatchObject({ status: "done", count: 12 });
});

test("D9: topic-balanced scorer selection only for a lean athlete with the flag on", async () => {
  const { id } = await athlete();
  expect(await leanBalancedFor(id)).toBe(false);   // no lean run yet
  await db.insert(workflowRuns).values({ athlete_id: id, process: "signup_research", definition_version: 4, active_scope: "signup_research", status: "done", input: {}, created_by: "signup", started_at: new Date() } as any);
  expect(await leanBalancedFor(id)).toBe(true);
  process.env.LEAN_SIGNUP_RESEARCH = "false";
  expect(await leanBalancedFor(id)).toBe(false);
});
