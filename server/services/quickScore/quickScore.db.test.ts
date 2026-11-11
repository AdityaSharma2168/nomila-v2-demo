/**
 * quickScore.db.test.ts — the sign-up quick score (signup_research v3 quick_score step) on PGlite with the real M.I.A.
 * parser, params and scorer. The search provider is ALWAYS a mock (the step's injected provider); the OpenAI helper is
 * mocked to throw and genai() throws, so no test can reach a provider. Made-up athletes only.
 *
 *   Q1 success: one call with the existing search-enabled prompt (+ said facts), the token ceiling, search cap and
 *      timeout from config → a 0–850 score, the method's reasons, the cited links for her display; one agent_runs row
 *      with the cost (OpenAI token rates + per-search fee) and no answer text
 *   Q2 an unparseable answer is retried once; the second good answer is used
 *   Q3 retry-then-fallback: two bad answers (or two failed calls) ⇒ fallback, no score; the existing path scores her
 *   Q4 cost cap: no call when even one worst-case call does not fit; no retry once the first call spent the room
 *   Q5 thin coverage ⇒ low confidence (never a made-up score); the method's own LOW identity ⇒ withheld
 *   Q6 nothing searched is written to memory_facts (rows unchanged; no cited link anywhere in memory)
 *   Q7 flag off ⇒ unchanged: new runs are v2 (the default), the step makes no call
 *   Q8 a re-run step never calls twice
 *   Q9 the landing card (waitlistProgress quickScoreFrom): its sources (title + link)
 *   Q10 the progress read carries it while research runs
 *   Q11 the real provider maps the OpenAI helper's answer (citations, usage, search calls, max-tokens cut) and asks for
 *       the fast model, low search context, low effort and the search cap (the helper is mocked: no request is sent)
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../lib/backgroundHost", () => ({ runsBackgroundWork: () => false }));   // kick is a no-op: no research step runs
jest.mock("../../lib/models", () => ({ ...jest.requireActual("../../lib/models"), genai: () => ({ models: { generateContent: async () => { throw new Error("no provider in tests"); } } }) }));
const mockRunOnce = jest.fn(async (..._a: unknown[]): Promise<any> => { throw new Error("no provider in tests"); });
jest.mock("../../lib/research/providers/openaiWebSearch", () => ({ ...jest.requireActual("../../lib/research/providers/openaiWebSearch"), runOpenAIOnce: (...a: unknown[]) => mockRunOnce(...a) }));
jest.setTimeout(180_000);

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { agentRuns, memoryFacts } from "../../../shared/schema";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "../marketabilityBeta1FrozenParams";
import { BETA1_COHORTS_V0, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V1, seedBeta1Params } from "../marketabilityBeta1Params";
import { promptFor } from "../marketabilityBeta1Snapshot";
import { getDefinition } from "../../workflow/registry";
import "../../workflow/definitions/index";
import { startSignupAgentResearch } from "../../agent/onboarding/signupResearch";
import { quickScoreFrom, waitlistResearchProgress } from "../../agent/onboarding/waitlistProgress";
import { QUICK_SCORE_SKILL_ID, QUICK_SCORE_STEP, openaiQuickScoreProvider, quickScoreParentRef, runQuickScoreStep } from "./step";
import { AGENT_MODELS, costOf } from "../../agent/models";
import { SAID_HEADING, distinctSources, quickScorePrompt, type GroundedCall, type GroundedProvider, type GroundedRequest } from "./oneCall";

const ARTIFACTS = join(__dirname, "..", "..", "scripts", "calibration", "runs", "blind-eval-v2", "gemini");
/** A real evaluator answer from the frozen calibration runs (identity HIGH, overall confidence HIGH). */
const GOOD_TEXT: string = JSON.parse(readFileSync(join(ARTIFACTS, readdirSync(ARTIFACTS).filter((f) => f.endsWith(".dev37.raw.json")).sort()[0]), "utf8")).text;
const src = (n: number) => Array.from({ length: n }, (_, i) => ({ uri: `https://site${i}.example/story`, title: `site${i}.example` }));

function answer(text: string, o: Partial<GroundedCall> = {}): GroundedCall {
  return {
    text, finishReason: "STOP", ms: 50_000, usage: { input: 12_000, cached: 0, output: 9_000, thinking: 2_000, queries: 4 },
    sources: src(5), queries: ["q1", "q2", "q3", "q4"], ...o,
  };
}
const provider = (...replies: Array<GroundedCall | Error>) => {
  const calls: GroundedRequest[] = [];
  const fn: GroundedProvider & { calls: GroundedRequest[] } = Object.assign(async (req: GroundedRequest) => {
    calls.push(req);
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  }, { calls });
  return fn;
};

const env = process.env;
let seq = 0;
async function athleteWithSaid(): Promise<{ id: string; ctx: any }> {
  seq++;
  const name = `Quinn Example${seq}`;
  const id = await seedAthlete(name, { sport: "Rowing" } as any);
  const base = { athlete_id: id, subject_kind: "athlete", subject_name: name, confidence: 1, type: "said", source_title: "You told us" };
  await db.insert(memoryFacts).values([
    { ...base, claim: `The athlete's name is ${name}.`, source_ref: "onboarding/run#name" },
    { ...base, claim: `${name}'s sport is Rowing.`, source_ref: "onboarding/run#sport" },
    { ...base, claim: `${name}'s school or team is Example State.`, source_ref: "onboarding/run#school" },
  ] as any);
  return { id, ctx: { runId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, athleteId: id, runInput: { name, sport: "Rowing" }, outputs: {}, attempt: 1 } };
}
const memoryRows = async (id: string) => db.select().from(memoryFacts).where(eq(memoryFacts.athlete_id, id));
const runsOf = async (id: string) => db.select().from(agentRuns).where(eq(agentRuns.athlete_id, id));

beforeAll(async () => {
  await initTestDb();
  await seedBeta1Params({ engine: MARKETABILITY_BETA1_FROZEN_PARAMS, lookups: BETA1_LOOKUPS_V1, policy: BETA1_POLICY_V0, priors: BETA1_PRIORS_V1, cohorts: BETA1_COHORTS_V0, activate: true, createdBy: "quick-score-test" });
});
afterAll(async () => { process.env = env; await closeTestDb(); });
beforeEach(() => { process.env = { ...env, QUICK_SCORE_ONE_CALL: "true" }; delete process.env.QUICK_SCORE_MAX_USD; delete process.env.DAILY_RESEARCH_CAP_USD; });

test("Q1: one web-search call with the existing prompt → score, reasons, the cited links; cost recorded, no answer text kept", async () => {
  const { id, ctx } = await athleteWithSaid();
  const p = provider(answer(GOOD_TEXT));
  const out: any = await runQuickScoreStep(ctx, { provider: p });
  expect(p.calls).toHaveLength(1);
  // The existing search-enabled M.I.A. prompt, word for word, with her said facts as its evidence block.
  const name = ctx.runInput.name;
  expect(p.calls[0].prompt).toBe(quickScorePrompt({ name, sport: "Rowing", said: (await memoryRows(id)).map((r) => r.claim), socialBlock: null }));
  expect(p.calls[0].prompt.startsWith(promptFor({ name, sport: "Rowing", socialBlock: "" }).split("\n")[0])).toBe(true);
  expect(p.calls[0].prompt).toContain(SAID_HEADING);
  expect(p.calls[0].prompt).toContain(`${name}'s school or team is Example State.`);
  expect(p.calls[0]).toMatchObject({ model: AGENT_MODELS.fast, maxOutputTokens: 16_384, maxSearches: 5, timeoutMs: 120_000 });
  expect(out).toMatchObject({ status: "ready", quick: true, search: "openai_web_search", confidence: "high", low_confidence: false, attempts: 1, identity_confidence: "HIGH" });
  expect(out.score).toBeGreaterThan(0); expect(out.score).toBeLessThanOrEqual(850);
  expect(out.reasons.length).toBeGreaterThan(0);
  expect(out.display).toEqual({ sources: src(5) });
  const runs = await runsOf(id);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ skill_id: QUICK_SCORE_SKILL_ID, status: "completed", provider: "openai", model: AGENT_MODELS.fast, effort: "low", web_search_calls: 4, parent_ref: `${quickScoreParentRef(ctx.runId)}#1` });
  expect(runs[0].cost_micro_usd).toBe(costOf(AGENT_MODELS.fast, { inputTokens: 12_000, cachedInputTokens: 0, outputTokens: 11_000, reasoningTokens: 2_000, webSearchCalls: 4 }).microUsd);
  expect(JSON.stringify(runs[0].output)).not.toMatch(/http|site0/);
});

test("Q2: an unparseable answer is retried once; the good second answer is used", async () => {
  const { id, ctx } = await athleteWithSaid();
  const p = provider(answer("Sorry, here is my thinking without JSON"), answer(GOOD_TEXT));
  const out: any = await runQuickScoreStep(ctx, { provider: p });
  expect(p.calls).toHaveLength(2);
  expect(out).toMatchObject({ status: "ready", attempts: 2 });
  expect((await runsOf(id)).map((r) => r.status).sort()).toEqual(["completed", "failed"]);
});

test("Q3: retry-then-fallback — two bad answers, or two failed calls, end with no quick score", async () => {
  const a = await athleteWithSaid();
  const bad = provider(answer('{"broken": '), answer(GOOD_TEXT, { finishReason: "MAX_TOKENS" }));
  const out: any = await runQuickScoreStep(a.ctx, { provider: bad });
  expect(bad.calls).toHaveLength(2);
  expect(out).toMatchObject({ status: "fallback", reason: "invalid_response", attempts: 2 });
  expect(out.score).toBeUndefined();
  expect((await runsOf(a.id)).every((r) => r.status === "failed")).toBe(true);

  const b = await athleteWithSaid();
  const down = provider(new Error("The operation was aborted due to timeout"));
  const out2: any = await runQuickScoreStep(b.ctx, { provider: down });
  expect(down.calls).toHaveLength(2);
  expect(out2).toMatchObject({ status: "fallback", reason: "call_failed", attempts: 2 });
  expect(quickScoreFrom(out2)).toBeNull();
});

test("Q4: cost cap — no call when one worst case does not fit; no retry once the first call spent the room", async () => {
  const a = await athleteWithSaid();
  process.env.QUICK_SCORE_MAX_USD = "0.05";
  const p = provider(answer(GOOD_TEXT));
  expect(await runQuickScoreStep(a.ctx, { provider: p })).toMatchObject({ status: "fallback", reason: "cost_cap", attempts: 0 });
  expect(p.calls).toHaveLength(0);

  const b = await athleteWithSaid();
  process.env.QUICK_SCORE_MAX_USD = "0.5";
  process.env.QUICK_SCORE_MAX_OUTPUT_TOKENS = "8000";
  process.env.QUICK_SCORE_TIMEOUT_MS = "60000";
  // A runaway first answer (40k output tokens, 50 searches ≈ $0.52): unusable, and no room left for a second call.
  const runaway = provider(answer("no json", { usage: { input: 20_000, cached: 0, output: 40_000, thinking: 0, queries: 50 } }), answer(GOOD_TEXT));
  const out: any = await runQuickScoreStep(b.ctx, { provider: runaway });
  expect(runaway.calls).toHaveLength(1);
  expect(runaway.calls[0]).toMatchObject({ maxOutputTokens: 8000, timeoutMs: 60_000 });
  expect(out).toMatchObject({ status: "fallback", reason: "cost_cap", attempts: 1 });
});

test("Q5: thin coverage ⇒ low confidence; the method's LOW identity ⇒ withheld, no score", async () => {
  const a = await athleteWithSaid();
  const out: any = await runQuickScoreStep(a.ctx, { provider: provider(answer(GOOD_TEXT, { sources: src(1) })) });
  expect(out).toMatchObject({ status: "ready", confidence: "low", low_confidence: true });
  expect(quickScoreFrom(out)).toMatchObject({ confidence: "low", lowConfidence: true });

  const b = await athleteWithSaid();
  const lowId = GOOD_TEXT.replace(/"identity_confidence"\s*:\s*"HIGH"/, '"identity_confidence": "LOW"');
  expect(lowId).not.toBe(GOOD_TEXT);
  const out2: any = await runQuickScoreStep(b.ctx, { provider: provider(answer(lowId)) });
  expect(out2).toMatchObject({ status: "withheld_identity", identity_confidence: "LOW" });
  expect(out2.score).toBeUndefined();
  expect(quickScoreFrom(out2)).toBeNull();
});

test("Q6: nothing searched is written to memory_facts", async () => {
  const { id, ctx } = await athleteWithSaid();
  const before = await memoryRows(id);
  await runQuickScoreStep(ctx, { provider: provider(answer(GOOD_TEXT)) });
  const after = await memoryRows(id);
  expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
  expect(after.every((r) => r.type === "said")).toBe(true);
  expect(JSON.stringify(after)).not.toMatch(/site\d\.example/);
});

test("Q7: flag off ⇒ unchanged (v2 runs, no call)", async () => {
  // The default definition is still v2 (v3 is opt-in), v2's steps unchanged.
  expect(getDefinition("signup_research").version).toBe(2);
  expect(getDefinition("signup_research").steps.map((s) => `${s.ordinal}:${s.name}`)).toEqual(["0:research_a", "0:research_b", "1:research_merge", "2:mia_preview", "3:score_email"]);
  expect(getDefinition("signup_research", 3).steps.map((s) => `${s.ordinal}:${s.name}`)).toEqual(["0:research_a", "0:research_b", "0:quick_score", "1:research_merge", "2:mia_preview", "3:score_email"]);

  delete process.env.QUICK_SCORE_ONE_CALL;
  const off = await seedAthlete("Rowan Example", { sport: "Rowing", email: "rowan@example.com" } as any);
  const r = await startSignupAgentResearch(off, { createdBy: "signup" });
  expect(r.started).toBe(true);
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.athlete_id, off));
  expect(run.definition_version).toBe(2);
  const p = provider(answer(GOOD_TEXT));
  const { ctx } = await athleteWithSaid();
  expect(await runQuickScoreStep(ctx, { provider: p })).toEqual({ status: "off", reason: "flag_off" });
  expect(await QUICK_SCORE_STEP.run!(ctx)).toEqual({ status: "off", reason: "flag_off" });

  process.env.QUICK_SCORE_ONE_CALL = "true";
  const on = await seedAthlete("Sasha Example", { sport: "Rowing", email: "sasha@example.com" } as any);
  await startSignupAgentResearch(on, { createdBy: "signup" });
  const [run3] = await db.select().from(workflowRuns).where(eq(workflowRuns.athlete_id, on));
  expect(run3.definition_version).toBe(3);
  expect(p.calls).toHaveLength(0);
});

test("Q8: a re-run step never calls twice", async () => {
  const { id, ctx } = await athleteWithSaid();
  const p = provider(answer(GOOD_TEXT));
  await runQuickScoreStep(ctx, { provider: p });
  const again: any = await runQuickScoreStep({ ...ctx, attempt: 2 }, { provider: p });
  expect(p.calls).toHaveLength(1);
  expect(again).toMatchObject({ status: "fallback", reason: "already_attempted", prior_status: null });
  expect(await runsOf(id)).toHaveLength(1);
});

test("Q9: the landing card carries the sources (title + link, shown as clickable chips)", async () => {
  const { ctx } = await athleteWithSaid();
  const out = await runQuickScoreStep(ctx, { provider: provider(answer(GOOD_TEXT)) });
  const card = quickScoreFrom(out)!;
  expect(card).toMatchObject({ quick: true, value: (out as any).score, raise: null });
  expect(card.sources).toEqual(src(5).map((s) => ({ title: s.title, url: s.uri })));
  expect(card.groups.map((g) => g.key)).toEqual(["audience", "commercial", "brand", "performance"]);
  expect(card.lines.length).toBeGreaterThan(0);
});

test("Q10: GET /waitlist/progress's read shows her quick score while research runs", async () => {
  const id = await seedAthlete("Tatum Example", { sport: "Rowing", email: "tatum@example.com" } as any);
  const r = await startSignupAgentResearch(id, { createdBy: "signup" });
  if (!r.started) throw new Error("not started");
  const out = await runQuickScoreStep({ runId: r.runId, athleteId: id, runInput: { name: "Tatum Example", sport: "Rowing" }, outputs: {}, attempt: 1 } as any, { provider: provider(answer(GOOD_TEXT)) });
  await db.update(workflowSteps).set({ status: "done", output: out as any }).where(and(eq(workflowSteps.run_id, r.runId), eq(workflowSteps.step, "quick_score")));
  const p = await waitlistResearchProgress(id, "Tatum Example");
  expect(p.research.state).toBe("running");
  expect(p.score).toBeNull();
  expect(p.quickScore).toMatchObject({ quick: true, value: (out as any).score, sources: src(5).map((s) => ({ title: s.title, url: s.uri })) });
});

test("Q11: the real provider — the OpenAI helper's answer mapped, the fast model at low context, low effort, the search cap", async () => {
  mockRunOnce.mockResolvedValueOnce({
    text: "{}", finishReason: "completed", searchQueries: ["q1", "q2"], searchCalls: 2, promptTokens: 9_000, completionTokens: 3_000, cachedTokens: 1_000, reasoningTokens: 1_200,
    citations: [{ url: "https://site0.example/story?utm_source=openai", title: "Site 0", startIndex: 0, endIndex: 1 }, { url: "", title: "x", startIndex: null, endIndex: null }],
    // Every page the searches consulted (as Gemini's groundingChunks listed them), not only the inline citations.
    searchSources: [{ url: "https://site0.example/story", title: "" }, { url: "https://www.site1.example/a?utm_source=openai", title: "" }],
  });
  const call = await openaiQuickScoreProvider({ model: AGENT_MODELS.fast, prompt: "PROMPT", maxOutputTokens: 16_384, maxSearches: 5, timeoutMs: 120_000 });
  expect(mockRunOnce).toHaveBeenLastCalledWith("PROMPT", "", expect.objectContaining({ model: AGENT_MODELS.fast, contextSize: "low", maxToolCalls: 5, maxOutputTokens: 16_384, timeoutMs: 120_000, includeSources: true, store: false }));
  expect((mockRunOnce.mock.calls.at(-1)![2] as any).effort).toBeTruthy();
  expect(call).toMatchObject({ text: "{}", finishReason: "completed", queries: ["q1", "q2"], usage: { input: 9_000, cached: 1_000, output: 1_800, thinking: 1_200, queries: 2 } });
  // utm_ tags removed; a consulted page without a title shows its host; oneCall's distinctSources then dedupes by URL.
  expect(call.sources).toEqual([{ uri: "https://site0.example/story", title: "Site 0" }, { uri: "https://site0.example/story", title: "site0.example" }, { uri: "https://www.site1.example/a", title: "site1.example" }]);
  expect(distinctSources(call.sources)).toHaveLength(2);
  mockRunOnce.mockResolvedValueOnce({ text: "{", finishReason: "incomplete:max_output_tokens", searchQueries: [], citations: [] });
  expect((await openaiQuickScoreProvider({ model: AGENT_MODELS.fast, prompt: "P", maxOutputTokens: 1_024, maxSearches: 5, timeoutMs: 5_000 })).finishReason).toBe("MAX_TOKENS");
});
