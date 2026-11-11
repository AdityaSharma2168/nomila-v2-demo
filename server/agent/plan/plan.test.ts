/**
 * plan.test.ts — one plan refresh end to end on the in-memory store with the model faked (no provider is reached).
 *
 *   P1 no Brief → skipped, no model call
 *   P2 the input: Brief (no internal past sponsors), M.I.A. strengths / constraints / missing with dimensions and never
 *      the score, intent, goals with who wrote the game plan, decisions, preferences and never-use names, connectors,
 *      dated events (E-keys), open threads (T-keys), facts with (care); the call: skill plan v1.3.1, reasoning tier, no
 *      tools, max_output_tokens 12,000
 *   P3 the write: recommended goals → pending goal decisions (detail), actions → action decisions (goal_id, or
 *      parent_decision_id for a recommended goal), game plans on Mila's goals only, held items on the run output
 *   P4 a refresh: unchanged input → reused, no call; a changed input → a new call; a repeated recommendation keeps its
 *      decision; what is not repeated expires — but never an action in the approval queue
 *   P5 budget: the week's plan cap and the day's cap skip the run (the last plan stays); a retried step pays nothing
 *   P6 plan 1.1.0 / 0119: goal domains stored (decision detail; an active goal with none gets one); Understand 1.9.0's
 *      conflicts reach the model and hold a pitch to what they block; a month-only event reads "(month only)"
 *   P7 plan 1.2.0 (register R3): the weekly moments scan's candidate posts reach the model as MOMENTS, under their
 *      event's E-key and best first (a moment filed under topic "moment" is an event too); a candidate whose moment is
 *      not an event the plan sees is left out; candidates are never listed as decisions; a post action timed to a
 *      moment's E-key is written against that moment's fact
 */
jest.mock("../../db", () => ({ db: {} }));

import type { MiaPreview } from "../../../shared/agent";
import type { ActionDecisionDetail, GoalDecisionDetail } from "../../../shared/plan";
import { fakeResponses, unfencedInput, type FakeTransport } from "../../testUtils/agentModel";
import { setResponsesTransport } from "../research/llm";
import { createMemoryStore, type AgentStore } from "../research/store";
import { momentLines, type PlanSources } from "./input";
import { runPlan, type PlanRunOutput } from "./run";

const A = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-10-10T09:00:00.000Z");
afterEach(() => setResponsesTransport(null));

function preview(): MiaPreview {
  const dim = (key: string, state: "strength" | "gap" | "unknown" | "neutral", rationale: string | null) => ({
    key, state, score: 60, confidence: "MEDIUM" as const, confidenceReason: null, rationale, components: [],
    sources: { grounded: [], site_only: [], nomila_supplied: [], not_support: [], unrecorded: [] }, weight: 0.125, contribution: 7.5, signals: [],
  });
  return {
    contract: "mia-preview/1", athleteId: A, status: "ready", score: 613, scale: { min: 0, max: 850 },
    groups: [
      { key: "audience", name: "Audience", contribution: 15, score: 60, dimensions: [{ key: "audience_scale", score: 60, weight: 0.125, contribution: 7.5, state: "strength" }] },
      { key: "performance", name: "Performance", contribution: 15, score: 60, dimensions: [{ key: "momentum", score: 60, weight: 0.125, contribution: 7.5, state: "gap" }] },
    ],
    assessment: {
      entryId: "e1", evidenceAsOf: "2026-10-09T00:00:00.000Z", createdAt: "2026-10-09T00:00:00.000Z", versions: { methodology: null, evaluator: null, params: null },
      score: 613, readState: "assessed", overall: { level: "MEDIUM", explanation: null }, confidenceBand: null, summary: null, hasReasons: true,
      dimensions: [dim("audience_scale", "strength", "A large, engaged following."), dim("momentum", "gap", "Flat between seasons."), dim("brand_fit", "unknown", null)],
      evidence: [], notes: { strengths: [], constraints: [], missingEvidence: ["Audience demographics."], evaluationRisks: [] },
    },
    preliminary: true, label: "Preliminary — connect to sharpen", confidence: { level: "MEDIUM", explanation: null },
    inputs: { public: [], measured: [] }, sharpen: [], evidenceAsOf: null, identity: { uncertain: false, factIds: [] }, provenance: null,
  };
}

const sources = (over: Partial<PlanSources> = {}): PlanSources => ({
  mia: async () => preview(),
  connected: async () => [{ id: "gmail", lastReadAt: "2026-10-09T00:00:00.000Z" }],
  openThreads: async () => [{ opportunityId: "opp-1", threadId: "th-1", brand: "Brand B", line: "They asked for your rates", since: "2026-10-08T00:00:00.000Z" }],
  playbook: async () => [],
  preferences: async () => [
    { id: "p1", athleteId: A, kind: "avoid", statement: "Never use: Robin", source: "said", status: "active", runId: null, createdAt: "2026-10-01T00:00:00.000Z" },
    { id: "p2", athleteId: A, kind: "voice", statement: "Short and warm.", source: "said", status: "active", runId: null, createdAt: "2026-10-01T00:00:00.000Z" },
  ],
  ...over,
});

async function seed(store: AgentStore) {
  const [name, result, event, care] = await store.insertFacts(A, [
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "The athlete's name is Pat Example.", type: "said", source: { ref: "onboarding/wf#name" }, date: "2026-10-01", confidence: 1, runId: null },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example won the conference final in 2026.", type: "found", source: { url: "https://example.org/final" }, date: "2026-05-01", confidence: 0.9, runId: null, topic: "achievement" },
    { subject: { kind: "event", name: "Home opener" }, claim: "The home opener is on 18 October 2026.", type: "found", source: { url: "https://example.org/schedule" }, date: "2026-10-18", confidence: 0.9, runId: null, topic: "upcoming" },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example missed the spring with a knee injury.", type: "found", source: { url: "https://example.org/injury" }, date: "2026-03-01", confidence: 0.9, runId: null, sensitive: true, careKind: "personal" },
  ]);
  await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Pat Example" }, claim: `Pat Example chose where to start: "Find and manage your deals".`, type: "said", source: { ref: "onboarding/wf#capability:deals" }, date: "2026-10-02", confidence: 1, runId: null }]);
  await store.writeBrief(A, {
    summary: "A conference champion with a story.", runId: null, factIds: [result.id],
    internal: { currentSponsors: [{ name: "Brand A", factIds: [] }], pastSponsors: [{ name: "INTERNAL-PAST-SPONSOR", factIds: [] }] },
    sections: [
      { key: "brand_now_next", title: "Brand: now → next", text: "", factIds: [result.id], lines: [{ text: "Champion in 2026.", kind: "fact", factIds: [result.id] }] },
      { key: "risks_upside", title: "Biggest risk and biggest upside", text: "", factIds: [], lines: [{ text: "Risk: a quiet off-season could cost reach.", kind: "inference", factIds: [] }, { text: "Upside: the comeback story opens bigger brands.", kind: "inference", factIds: [] }] },
      { key: "refresh_cadence", title: "Refresh cadence", text: "", factIds: [], lines: [{ text: "CADENCE-LINE", kind: "inference", factIds: [] }] },
    ],
  });
  const mine = await store.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null, horizon: "now" });
  const theirs = await store.insertGoal(A, { text: "Land a first paid partnership", source: "said", decisionId: null, gamePlan: "My own plan.", gamePlanBy: "athlete" });
  return { name, result, event, care, mine, theirs };
}

/** A plan the fake model writes, referencing the keys it was given. */
function planJson(goalIds: { mine: string; theirs: string }, over: Record<string, unknown> = {}) {
  return {
    contract: "plan/1", stage_read: { band: "developing", why: "A conference champion." },
    recommended_goals: [{ key: "R1", goal: "Get a first local partner before playoffs", horizon: "next", why_now: "Your opener gets press.", value: { text: "A first deal on record", low: 500, high: 2000, currency: "usd", drivers: ["local reach"] }, value_confidence: "medium", next_decision: "Pick two shops.", fact_keys: ["F1"], similar_to_goal_id: null }],
    game_plans: [
      { goal_ref: `G:${goalIds.mine}`, lines: ["Two posts a week from clips you have."], kept_athlete_text: false },
      { goal_ref: `G:${goalIds.theirs}`, lines: ["A rewrite."], kept_athlete_text: false },
      { goal_ref: "R1", lines: ["Pitch two shops with your opener story."], kept_athlete_text: false },
    ],
    actions: [
      { goal_ref: `G:${goalIds.mine}`, kind: "post", what: "Opener post", why: "Timed to the opener.", due_on: "2026-10-16", event_ref: "E1", button: "post", deliverable: { type: "post_brief", title: "Opener", body: "Caption: Back home.", target: null, platform: "instagram", thread_ref: null, connector: null }, fact_keys: ["F1", "E1"] },
      { goal_ref: `G:${goalIds.theirs}`, kind: "reply", what: "Reply to Brand B", why: "They asked.", due_on: "2026-10-12", event_ref: null, button: "send", deliverable: { type: "reply_draft", title: "Rates", body: "Thanks, here are my rates.", target: null, platform: null, thread_ref: "T1", connector: null }, fact_keys: ["F1"] },
      { goal_ref: "R1", kind: "pitch", what: "Pitch a local shop", why: "They back your league.", due_on: "2026-10-15", event_ref: "E1", button: "send", deliverable: { type: "pitch", title: "Hello", body: "I'd love to work together.", target: { subject_kind: "brand", name: "Shop One" }, platform: null, thread_ref: null, connector: null }, fact_keys: ["F1"] },
      { goal_ref: `G:${goalIds.mine}`, kind: "other", what: "Too late", why: "x", due_on: "2026-10-20", event_ref: "E1", button: "start", deliverable: { type: "checklist", title: "x", body: "x", target: null, platform: null, thread_ref: null, connector: null }, fact_keys: ["F1"] },
    ],
    goal_notes: [], missing: [], path_note: "planned around the opener",
    ...over,
  };
}

const keyOf = (input: string, claim: string) => new RegExp(`^(F\\d+) \\|[^\\n]*${claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").exec(input)?.[1];

test("P1: no Brief → skipped, no model call", async () => {
  const store = createMemoryStore();
  const t = fakeResponses(() => { throw new Error("no call expected"); });
  setResponsesTransport(t);
  expect(await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: null, now: NOW })).toEqual({ status: "skipped", reason: "no_brief" });
  expect(t.calls).toHaveLength(0);
});

test("P2–P3: the input carries every block (never the score or the internal past); the plan is checked and written", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  let t: FakeTransport;
  t = fakeResponses((body) => {
    const input = unfencedInput(body.input);
    // The model refers to the conference result by its F-key.
    const f = keyOf(input, "won the conference final");
    return { json: JSON.parse(JSON.stringify(planJson({ mine: s.mine.id, theirs: s.theirs.id })).replace(/"F1"/g, `"${f}"`)), usage: { input: 13_000, cached: 2_500, output: 2_500, reasoning: 4_000 } };
  });
  setResponsesTransport(t);
  const out = await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", reason: "the Brief was written", parentRef: "workflow:w1:plan", now: NOW });
  expect(out).toMatchObject({ status: "planned", recommended: 1, actions: 3, held: 1 });

  const body = t.calls[0];
  const input = unfencedInput(body.input);
  expect(body.prompt_cache_key).toBe("nomila:plan@1.7.0");
  expect(body.max_output_tokens).toBe(12_000);
  expect(body.tools).toBeUndefined();
  expect(body.text.format.name).toBe("plan");
  expect(input).toMatch(/^TODAY: 2026-10-10/);
  expect(input).toContain("WHY THIS RUN: the Brief was written");
  expect(input).toContain("- Champion in 2026. [");                                  // brief lines cite F-keys
  expect(input).toContain("- Brand A");                                              // current sponsors (internal) …
  expect(input).not.toContain("INTERNAL-PAST-SPONSOR");                              // … never the past ones
  expect(input).not.toContain("CADENCE-LINE");                                       // no refresh cadence
  expect(input).toContain("- [audience_scale] A large, engaged following.");         // M.I.A. strengths with dimensions
  expect(input).toContain("- [momentum] Flat between seasons.");
  expect(input).toContain("- [brand_fit] Not enough evidence to judge yet.");
  expect(input).not.toContain("613");                                                // never the score
  expect(input).toContain(`chose where to start: "Find and manage your deals"`);
  expect(input).toContain(`G:${s.theirs.id} | active`);
  expect(input).toContain("game plan (written by the athlete: echo it, never rewrite): My own plan.");
  expect(input).toContain("Never use these names anywhere: Robin");
  expect(input).toContain("- gmail | Gmail | inbox | connected, last read 2026-10-09 | can offer now: no");
  expect(input).toContain("- instagram | Instagram | social | not connected | can offer now: yes");
  expect(input).toContain("E1 | 2026-10-18 | Home opener | The home opener is on 18 October 2026.");
  expect(input).toContain("T1 | Brand B | They asked for your rates | waiting since 2026-10-08");
  expect(input).toMatch(/F\d+ \| found \(care\) \| athlete: Pat Example \| Pat Example missed the spring/);

  // Written: one pending recommendation with its detail; its action held for it; actions for the goals held.
  const decisions = await store.listDecisions(A, { skillId: "plan" });
  const rec = decisions.find((d) => d.kind === "goal")!;
  expect(rec).toMatchObject({ suggested: "Get a first local partner before playoffs", why: "Your opener gets press.", response: "pending", evidence: [{ kind: "fact", factId: s.result.id }] });
  expect(rec.detail as unknown as GoalDecisionDetail).toMatchObject({ key: "R1", horizon: "next", valueConfidence: "low", value: { low: 500, high: 2000, currency: "USD" }, gamePlan: ["Pitch two shops with your opener story."] });
  const actions = decisions.filter((d) => d.kind === "action");
  expect(actions.map((a) => [a.suggested, a.goalId, a.parentDecisionId])).toEqual([
    ["Opener post", s.mine.id, null], ["Reply to Brand B", s.theirs.id, null], ["Pitch a local shop", null, rec.id],
  ]);
  const post = actions[0].detail as unknown as ActionDecisionDetail;
  expect(post).toMatchObject({ kind: "post", button: "post", dueOn: "2026-10-16", state: "to_start", event: { factId: s.event.id, label: "Home opener", date: "2026-10-18", precision: "day" } });
  expect((actions[1].detail as unknown as ActionDecisionDetail).deliverable.thread).toEqual({ opportunityId: "opp-1", threadId: "th-1", label: "Brand B" });
  // Game plans: Mila's goal rewritten; the athlete's own never.
  expect((await store.getGoal(A, s.mine.id))!.gamePlan).toBe("Two posts a week from clips you have.");
  expect((await store.getGoal(A, s.theirs.id))!).toMatchObject({ gamePlan: "My own plan.", gamePlanBy: "athlete" });
  // The run keeps the model's JSON, the validated plan, what was held, the digest.
  const run = (await store.getRun(A, out.status === "planned" ? out.runId : ""))!;
  const o = run.output as PlanRunOutput;
  expect(run).toMatchObject({ skillId: "plan", skillVersion: "1.7.0", trigger: "event", status: "completed", parentRef: "workflow:w1:plan" });
  expect(o.held).toEqual([{ what: "Too late", reason: "due_on 2026-10-20 falls after the event (2026-10-18)" }]);
  expect(o.plan!.stageRead).toEqual({ band: "developing", why: "A conference champion." });
  expect(o.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(run.cost.microUsd).toBeGreaterThan(0);
});

test("P4: unchanged input reuses the last plan; a change replans — repeats keep their decision, the rest expire (never an approval)", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  let json: any = null;
  const t = fakeResponses((body) => ({ json: JSON.parse(JSON.stringify(json).replace(/"F1"/g, `"${keyOf(unfencedInput(body.input), "won the conference final")}"`)) }));
  setResponsesTransport(t);
  json = planJson({ mine: s.mine.id, theirs: s.theirs.id });
  const first = await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:w1:plan", now: NOW });
  expect(first.status).toBe("planned");
  // Same input, later the same week: no model call.
  const again = await runPlan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:w2:plan", now: new Date("2026-10-11T09:00:00.000Z") });
  expect(again).toEqual({ status: "reused", runId: (first as any).runId, why: "unchanged_input" });
  expect(t.calls).toHaveLength(1);

  // The reply goes into the approval queue (Track E's seam): a refresh never expires it.
  const before = await store.listDecisions(A, { skillId: "plan" });
  const reply = before.find((d) => d.suggested === "Reply to Brand B")!;
  (await (store as any).dump()).decisions.find((d: any) => d.id === reply.id).approvalId = "00000000-0000-4000-8000-00000000a99a";

  // Something new is known: the plan is written again. The recommendation is repeated; the post and the pitch are not.
  await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example was named team captain.", type: "found", source: { url: "https://example.org/captain" }, date: "2026-10-09", confidence: 0.9, runId: null }]);
  json = planJson({ mine: s.mine.id, theirs: s.theirs.id }, { actions: [] });
  const second = await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:w3:plan", now: new Date("2026-10-11T10:00:00.000Z") });
  expect(second).toMatchObject({ status: "planned", recommended: 1, actions: 0, expired: 2 });
  const after = await store.listDecisions(A, { skillId: "plan" });
  const rec = after.filter((d) => d.kind === "goal");
  expect(rec).toHaveLength(1);                                                        // the same decision, refreshed
  expect(rec[0]).toMatchObject({ id: before.find((d) => d.kind === "goal")!.id, response: "pending", runId: (second as any).runId });
  expect(Object.fromEntries(after.filter((d) => d.kind === "action").map((d) => [d.suggested, d.response]))).toEqual({
    "Opener post": "expired", "Pitch a local shop": "expired", "Reply to Brand B": "pending",
  });
});

test("P5: the week's and the day's caps skip the run; a retried step pays nothing", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const t = fakeResponses((body) => ({ json: JSON.parse(JSON.stringify(planJson({ mine: s.mine.id, theirs: s.theirs.id })).replace(/"F1"/g, `"${keyOf(unfencedInput(body.input), "won the conference final")}"`)) }));
  setResponsesTransport(t);
  const done = await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:w1:plan", now: NOW });
  expect(await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:w1:plan", now: NOW })).toEqual({ status: "reused", runId: (done as any).runId, why: "retried_step" });
  expect(t.calls).toHaveLength(1);

  // $0.90 of plan runs this week: one more ($0.15 worst case) would pass $1.
  const spend = async (skillId: string, microUsd: number) => {
    const id = await store.startRun({ athleteId: A, skillId, skillVersion: "x", trigger: "event", model: { provider: "openai", model: "m", effort: "medium" }, parentRef: null });
    await store.finishRun(A, id, { status: "completed", stopReason: null, cost: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd }, steps: [], evidenceRead: [], output: null, error: null });
  };
  await spend("plan", 900_000);
  await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Pat Example" }, claim: "New.", type: "said", source: { ref: "chat:1" }, date: null, confidence: 1, runId: null }]);
  expect(await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:w4:plan", now: new Date() })).toEqual({ status: "skipped", reason: "week_cap" });

  const other = createMemoryStore();
  const s2 = await seed(other);
  void s2;
  const id = await other.startRun({ athleteId: A, skillId: "chat", skillVersion: "x", trigger: "chat", model: { provider: "openai", model: "m", effort: "medium" }, parentRef: null });
  await other.finishRun(A, id, { status: "completed", stopReason: null, cost: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd: 4_900_000 }, steps: [], evidenceRead: [], output: null, error: null });
  expect(await runPlan({ store: other, sources: sources(), athleteId: A, trigger: "event", parentRef: null, now: new Date() })).toEqual({ status: "skipped", reason: "day_cap" });
  expect(t.calls).toHaveLength(1);
});

test("P6: plan 1.1.0 — domains stored and served; the conflicts block reaches the model and holds a blocked pitch; a month-only event reads as a month", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  await store.insertFacts(A, [{ subject: { kind: "event", name: "Winter showcase" }, claim: "The winter showcase is in November 2026.", type: "found", source: { url: "https://example.org/showcase" }, date: "2026-11-01", datePrecision: "month", confidence: 0.9, runId: null, topic: "upcoming" }]);
  // Understand 1.9.0's internal read: Brand A holds the category and blocks Shop One.
  await store.writeBrief(A, {
    summary: "A conference champion with a story.", runId: null, factIds: [s.result.id], sections: [],
    internal: { currentSponsors: [{ name: "Brand A", factIds: [] }], pastSponsors: [], exclusivityConflicts: [{ what: "Brand A holds your shop category.", blocks: ["Shop One", "other local shops"], factIds: [s.result.id] }] },
  });
  const t = fakeResponses((body) => {
    const input = unfencedInput(body.input);
    const f = keyOf(input, "won the conference final");
    const json = planJson({ mine: s.mine.id, theirs: s.theirs.id });
    json.recommended_goals[0] = { ...json.recommended_goals[0], domain: "commercial" } as any;
    json.game_plans = json.game_plans.map((p: any) => ({ ...p, domain: p.goal_ref === `G:${s.mine.id}` ? "audience" : p.goal_ref === "R1" ? "commercial" : "not-a-domain" }));
    return { json: JSON.parse(JSON.stringify(json).replace(/"F1"/g, `"${f}"`)) };
  });
  setResponsesTransport(t);
  const out = await runPlan({ store, sources: sources(), athleteId: A, trigger: "event", parentRef: "workflow:w6:plan", now: NOW });
  expect(out).toMatchObject({ status: "planned", recommended: 1 });
  const input = String(t.calls[0].input);
  expect(input).toContain("## Exclusivity and category conflicts (internal)");
  expect(input).toMatch(/- Brand A holds your shop category\. \| blocks: Shop One; other local shops \[F\d+\]/);
  expect(input).toContain("| 2026-11 (month only) | Winter showcase |");
  expect(input).toContain(`G:${s.mine.id} | active | horizon now | domain - |`);

  // The pitch to Shop One is blocked by the conflict; the recommendation keeps its domain; Mila's goal gets one.
  const o = (await store.getRun(A, (out as any).runId))!.output as PlanRunOutput;
  expect(o.held).toEqual(expect.arrayContaining([{ what: "Pitch a local shop", reason: "the pitch target is in an exclusivity or category conflict" }]));
  const rec = (await store.listDecisions(A, { skillId: "plan" })).find((d) => d.kind === "goal")!;
  expect((rec.detail as unknown as GoalDecisionDetail).domain).toBe("commercial");
  expect((await store.getGoal(A, s.mine.id))!.domain).toBe("audience");
  expect((await store.getGoal(A, s.theirs.id))!.domain).toBeNull();                 // "not-a-domain" is never guessed
});

test("P7: plan 1.2.0 — the moments scan's candidate posts reach the model under their event's E-key; a post action can take one", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const [derby, far] = await store.insertFacts(A, [
    { subject: { kind: "event", name: "City derby" }, claim: "The city derby is on 25 October 2026.", type: "found", source: { url: "https://example.org/derby" }, date: "2026-10-25", confidence: 0.9, runId: null, topic: "moment" },
    { subject: { kind: "event", name: "Spring opener" }, claim: "The spring opener is on 1 March 2027.", type: "found", source: { url: "https://example.org/spring" }, date: "2027-03-01", confidence: 0.9, runId: null, topic: "moment" },
  ]);
  const candidate = (factId: string, name: string, rank: number, hook: string) => ({
    runId: null, skillId: "moments", kind: "other" as const, suggested: hook, why: `Why ${name}.`, evidence: [{ kind: "fact" as const, factId }],
    detail: {
      kind: "moment", factId, name, date: "2026-10-25", datePrecision: "day", category: "schedule", whyNow: `${name} is close.`, rank,
      idea: { hook, format: "reel", platform: "instagram", timing: "two days before" },
      brief: { show: "Warm-up to the first whistle.", captionAngle: "Home ground.", avoid: "Anything about the rival's injuries." },
      mediaNeeds: "an action shot in team colours", scannedAt: "2026-10-09T13:00:00.000Z",
    },
  });
  await store.insertDecision(A, candidate(derby.id, "City derby", 2, "DERBY-HOOK"));
  await store.insertDecision(A, candidate(s.event.id, "Home opener", 1, "OPENER-HOOK"));
  await store.insertDecision(A, candidate(far.id, "Spring opener", 3, "FAR-HOOK"));                      // past the 60-day horizon
  const gone = await store.insertDecision(A, candidate(derby.id, "City derby", 4, "EXPIRED-HOOK"));
  await store.respondDecision(A, gone.id, "expired", "refreshed");

  const t = fakeResponses(() => ({
    json: planJson({ mine: s.mine.id, theirs: s.theirs.id }, {
      recommended_goals: [], game_plans: [{ goal_ref: `G:${s.mine.id}`, lines: ["Post around home games."], kept_athlete_text: false }],
      actions: [{ goal_ref: `G:${s.mine.id}`, kind: "post", what: "Derby reel", why: "The derby is the week's biggest crowd.", due_on: "2026-10-23", event_ref: "E2", button: "post",
        deliverable: { type: "post_brief", title: "Derby reel", body: "Caption: Home ground.\nShots: warm-up, the first whistle.", target: null, platform: "instagram", thread_ref: null, connector: null }, fact_keys: ["E2"] }],
      missing: [{ text: "Connect Instagram", unlocks: "connect", connector: "instagram" }],
    }),
  }));
  setResponsesTransport(t);
  const out = await runPlan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: "workflow:w7:plan", now: NOW });
  expect(out).toMatchObject({ status: "planned", actions: 1, held: 0 });

  const input = String(t.calls[0].input);
  expect(input).toContain("E1 | 2026-10-18 | Home opener |");
  expect(input).toContain("E2 | 2026-10-25 | City derby | The city derby is on 25 October 2026.");     // topic "moment" is an event
  const block = input.slice(input.indexOf("MOMENTS (candidate posts"), input.indexOf("OPEN THREADS WAITING"));
  expect(block.indexOf("E1 | Home opener | schedule | why now: Home opener is close.")).toBeGreaterThan(0);  // rank 1 first …
  expect(block.indexOf("E2 | City derby | schedule")).toBeGreaterThan(block.indexOf("E1 | Home opener"));  // … then rank 2
  expect(block).toContain("  idea: DERBY-HOOK | reel on instagram | timing: two days before");
  expect(block).toContain("  brief: show Warm-up to the first whistle. | caption angle: Home ground. | avoid: Anything about the rival's injuries.");
  expect(block).toContain("  media it needs: an action shot in team colours");
  expect(input).not.toContain("FAR-HOOK");                                            // its moment is not an event the plan sees
  expect(input).not.toContain("EXPIRED-HOOK");                                        // only pending candidates
  const decisionsBlock = input.slice(input.indexOf("DECISIONS AND OUTCOMES"), input.indexOf("PREFERENCES AND AVOID-LIST"));
  expect(decisionsBlock).not.toMatch(/moments|HOOK/);                                 // candidates are not decisions

  const action = (await store.listDecisions(A, { skillId: "plan", kinds: ["action"] }))[0];
  expect(action.detail as unknown as ActionDecisionDetail).toMatchObject({ kind: "post", dueOn: "2026-10-23", event: { factId: derby.id, label: "City derby", date: "2026-10-25" } });
  expect(action.evidence).toEqual(expect.arrayContaining([{ kind: "fact", factId: derby.id }]));
});

test("P7c: mid-month — a month-only moment in the current month is still an event, and an action may be due within it", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const [month, ended] = await store.insertFacts(A, [
    { subject: { kind: "event", name: "Rivalry month" }, claim: "October 2026 is rivalry month.", type: "found", source: { url: "https://example.org/rivalry" }, date: "2026-10-01", datePrecision: "month", confidence: 0.9, runId: null, topic: "moment" },
    { subject: { kind: "event", name: "September cup" }, claim: "The September cup.", type: "found", source: { url: "https://example.org/sept" }, date: "2026-09-01", datePrecision: "month", confidence: 0.9, runId: null, topic: "moment" },
  ]);
  const t = fakeResponses((body) => {
    const e = /^(E\d+) \| 2026-10 \(month only\) \| Rivalry month/m.exec(unfencedInput(body.input))![1];
    return { json: planJson({ mine: s.mine.id, theirs: s.theirs.id }, {
      recommended_goals: [], game_plans: [], missing: [{ text: "Connect Instagram", unlocks: "connect", connector: "instagram" }],
      actions: [{ goal_ref: `G:${s.mine.id}`, kind: "post", what: "Rivalry post", why: "It is rivalry month.", due_on: "2026-10-20", event_ref: e, button: "post",
        deliverable: { type: "post_brief", title: "Rivalry", body: "Caption: Our month.", target: null, platform: "instagram", thread_ref: null, connector: null }, fact_keys: [e] }],
    }) };
  });
  setResponsesTransport(t);
  const out = await runPlan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(out).toMatchObject({ status: "planned", actions: 1, held: 0 });
  const input = String(t.calls[0].input);
  const events = input.slice(input.indexOf("DATED EVENTS"), input.indexOf("MOMENTS (candidate posts"));
  expect(events).toContain("Rivalry month");
  expect(events).not.toContain("September cup");                                      // its month has ended
  const action = (await store.listDecisions(A, { skillId: "plan", kinds: ["action"] }))[0];
  expect(action.detail as unknown as ActionDecisionDetail).toMatchObject({ dueOn: "2026-10-20", event: { factId: month.id, precision: "month" } });
  expect(ended.id).toBeTruthy();
});

test("P7d: candidates from the newest scan come first, then by that scan's rank (ranks of different scans never mix)", () => {
  const ev = (factId: string, key: string) => [key, { fact: {} as any, factId, label: key, date: "2026-10-20", precision: "day" as const }] as const;
  const events = new Map([ev("f-old", "E1"), ev("f-new1", "E2"), ev("f-new2", "E3")]);
  const dec = (factId: string, name: string, rank: number, scannedAt: string) => ({
    id: name, athleteId: A, runId: null, skillId: "moments", suggested: name, why: "w", evidence: [], response: "pending" as const, responseReason: null, respondedAt: null,
    outcome: "unknown" as const, outcomeNote: null, outcomeAt: null, approvalId: null, createdAt: scannedAt, goalId: null, kind: "other" as const, parentDecisionId: null,
    detail: { kind: "moment", factId, name, category: "schedule", whyNow: "w", rank, scannedAt, idea: { hook: "h", format: "reel", platform: "instagram", timing: "t" }, brief: { show: "s", captionAngle: "c", avoid: "a" }, mediaNeeds: "m" },
  });
  const lines = momentLines([dec("f-old", "OLD-RANK-1", 1, "2026-10-01T13:00:00.000Z"), dec("f-new2", "NEW-RANK-2", 2, "2026-10-08T13:00:00.000Z"), dec("f-new1", "NEW-RANK-1", 1, "2026-10-08T13:00:00.000Z")], events, 5);
  expect(lines.map((l) => l.split(" | ")[1])).toEqual(["NEW-RANK-1", "NEW-RANK-2", "OLD-RANK-1"]);
});

test("P7b: with no candidate posts the MOMENTS block says so", async () => {
  const store = createMemoryStore();
  const s = await seed(store);
  const t = fakeResponses(() => ({ json: planJson({ mine: s.mine.id, theirs: s.theirs.id }, { recommended_goals: [], actions: [], game_plans: [], missing: [{ text: "Connect Instagram", unlocks: "connect", connector: "instagram" }] }) }));
  setResponsesTransport(t);
  await runPlan({ store, sources: sources(), athleteId: A, trigger: "schedule", parentRef: null, now: NOW });
  expect(String(t.calls[0].input)).toContain("MOMENTS (candidate posts from the weekly moments scan, best first, under their event's E-key)\n- (no candidate posts for the events above)");
});

test("P10: plan 1.5.0 apply — a recommendation keeps its repeats; a post prepared before Keep goes with a recommendation the run does not repeat", async () => {
  const { applyPlan } = await import("./apply");
  const store = createMemoryStore();
  const [f] = await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example races for a club.", type: "found", source: { url: "https://example.org/a" }, date: null, confidence: 0.9, runId: null }]);
  const value = { text: "Reach", low: null, high: null, currency: null, drivers: [] };
  const old = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "goal", suggested: "Start a monthly newsletter for fans", why: "w", evidence: [], detail: { key: "R1", horizon: "next", value, valueConfidence: "low", nextDecision: "n", gamePlan: [] } });
  const deliverable = { type: "post_brief" as const, title: "t", body: "b", target: null, platform: "instagram", thread: null, connector: null };
  const prepared = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Held post", why: "w", evidence: [], parentDecisionId: old.id,
    detail: { kind: "post", what: "Held post", button: "post", dueOn: "2026-10-14", event: null, deliverable, state: "made", prepared: { studioItemId: "x" } } });
  const out = await applyPlan(store, A, "run-p10", {
    contract: "plan/1", stageRead: { band: "developing", why: "w" }, goalNotes: [], missing: [], ideaMoves: [], pathNote: "p", actions: [], gamePlans: [],
    week: { posts: 0, target: null, stories: 0, why: "w" },
    recommendedGoals: [{ key: "R1", goal: "A post before every home race", horizon: "now", domain: "content", whyNow: "w", value, valueConfidence: "low", nextDecision: "n", factIds: [f.id], similarToGoalId: null, repeats: "before_event" }],
  });
  const fresh = (await store.getDecision(A, out.recommended[0].decisionId))!;
  expect((fresh.detail as unknown as GoalDecisionDetail).repeats).toBe("before_event");
  expect((await store.getDecision(A, old.id))!.response).toBe("expired");
  expect((await store.getDecision(A, prepared.id))!.response).toBe("expired");
});

test("P11: a new plan's post replaces an earlier UNTOUCHED prepared post for the same goal (expired, kept as history); one she worked on, one in the approval queue, and another goal's stay", async () => {
  const { applyPlan } = await import("./apply");
  const store = createMemoryStore();
  const goal = await store.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null });
  const other = await store.insertGoal(A, { text: "Land a first partner", source: "said", decisionId: null });
  const deliverable = { type: "post_brief" as const, title: "t", body: "b", target: null, platform: "instagram", thread: null, connector: null };
  const at = "2026-10-08T10:00:00.000Z";
  const kit = (over: Record<string, unknown> = {}) => ({ builtAt: at, updatedAt: at, caption: { text: "c", hashtags: [], edited: false }, assets: [], ...over });
  const post = (what: string, goalId: string, k: Record<string, unknown>) => store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: what, why: "w", evidence: [], goalId,
    detail: { kind: "post", what, button: "post", dueOn: "2026-10-14", event: null, deliverable, state: "made", prepared: { studioItemId: "x", postKit: k } } });
  const untouched = await post("Captain portrait", goal.id, kit());
  const swapped = await post("Team photo", goal.id, kit({ updatedAt: "2026-10-09T10:00:00.000Z" }));
  const recaptioned = await post("Training clip", goal.id, kit({ caption: { text: "mine", hashtags: [], edited: true } }));
  const queued = await post("Match day", goal.id, kit());
  (store as any).dump().decisions.find((d: { id: string }) => d.id === queued.id).approvalId = "appr-1";
  const elsewhere = await post("Partner teaser", other.id, kit());

  await applyPlan(store, A, "run-p11", {
    contract: "plan/1", stageRead: { band: "developing", why: "w" }, goalNotes: [], missing: [], ideaMoves: [], pathNote: "p", gamePlans: [], recommendedGoals: [],
    week: { posts: 1, target: null, stories: 0, why: "w" },
    actions: [{ goalRef: { kind: "goal", goalId: goal.id }, kind: "post", what: "Captain portrait carousel", why: "w", dueOn: "2026-10-15", event: null, button: "post", deliverable, factIds: [], post: null, source: null }],
  });
  const row = async (id: string) => (await store.getDecision(A, id))!;
  expect((await row(untouched.id)).response).toBe("expired");
  // history kept: the row and its kit are still there
  expect(((await row(untouched.id)).detail as unknown as ActionDecisionDetail).prepared?.postKit).toBeTruthy();
  expect((await row(swapped.id)).response).toBe("pending");
  expect((await row(recaptioned.id)).response).toBe("pending");
  expect((await row(queued.id)).response).toBe("pending");
  expect((await row(elsewhere.id)).response).toBe("pending");
});
