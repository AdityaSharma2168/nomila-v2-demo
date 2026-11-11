/**
 * plan.db.test.ts — the plan step end to end on PGlite: the plan_refresh workflow on the real Postgres runner, the
 * dbStore's 0118 columns, and the Goals API over HTTP. The model is faked (no provider is reached); AGENT_PLAN is on
 * for this suite only.
 *
 *   D1 requestPlanRefresh starts plan_refresh; the runner runs wait → plan → post_kits (off here); the plan is written to memory_decisions
 *      (kind, detail, parent_decision_id) and memory_goals (game_plan); the agent run is skill plan, trigger event, with
 *      the workflow's parent ref; a request while one is in flight joins it
 *   D2 GET /agent/goals serves goals, this week's actions, recommendations, comingUp and riskUpside; the writes answer
 *      with the goal-change card and the fresh read; Undo; results
 *   D3 tenancy: another athlete sees nothing and can change nothing — not through a path, not through a goal link
 *   D5 the sweep only enqueues; while the run is due, the read's `planning` is set, null once it is done
 *   D6 a run coalesced into the 6 hours after the last plan is not "in progress": `planning` stays null
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { closeTestDb, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { fakeResponses, skillOf, type FakeTransport } from "../../testUtils/agentModel";
import { getRun, listRuns } from "../../workflow/runner";
import { setResponsesTransport } from "../research/llm";
import { dbStore } from "../research/dbStore";
import { agentGoalsRouter } from "./routes";
import { requestPlanRefresh } from "./triggers";
import "./workflow";

let server: Server;
let base = "";
let A = "";
let B = "";
let transport: FakeTransport;
let readyLine = "Your plan's ready.";
const saved = process.env.AGENT_PLAN;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function call(as: string, method: string, path: string, body?: unknown) {
  (globalThis as any).__TEST_ATHLETE_ID = as;
  const res = await fetch(`${base}/api/v1/me${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

let goalId = "";
beforeAll(async () => {
  process.env.AGENT_PLAN = "true";
  await initTestDb();
  A = await seedAthlete("Pat Example");
  B = await seedAthlete("Rival Private");
  await dbStore.insertFacts(A, [
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "The athlete's name is Pat Example.", type: "said", source: { ref: "onboarding/wf#name" }, date: day(0), confidence: 1, runId: null },
    { subject: { kind: "athlete", name: "Pat Example" }, claim: "Pat Example won the conference final.", type: "found", source: { url: "https://example.org/final" }, date: "2026-05-01", confidence: 0.9, runId: null, topic: "achievement" },
    { subject: { kind: "event", name: "Home opener" }, claim: "The home opener is coming up.", type: "found", source: { url: "https://example.org/schedule" }, date: day(8), confidence: 0.9, runId: null, topic: "upcoming" },
  ]);
  await dbStore.writeBrief(A, { summary: "S", runId: null, factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, sections: [
    { key: "risks_upside", title: "Biggest risk and biggest upside", text: "", factIds: [], lines: [{ text: "Risk: a quiet off-season.", kind: "inference", factIds: [] }, { text: "Upside: the comeback story.", kind: "inference", factIds: [] }] },
  ] });
  goalId = (await dbStore.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null, horizon: "now" })).id;
  await dbStore.insertGoal(B, { text: "B's secret goal", source: "said", decisionId: null });

  transport = fakeResponses((body) => {
    if (skillOf(body) === "plan/ready") return { json: { line: readyLine } };
    if (skillOf(body) !== "plan") throw new Error(`unexpected skill ${skillOf(body)}`);
    const input = String(body.input);
    const f = /^(F\d+) \|[^\n]*won the conference final/m.exec(input)![1];
    const opener = day(6);
    return { json: {
      contract: "plan/1", stage_read: { band: "developing", why: "w" },
      recommended_goals: [{ key: "R1", goal: "Get a first local partner", horizon: "next", why_now: "Your final is fresh news.", value: { text: "A first deal", low: null, high: null, currency: null, drivers: [] }, value_confidence: "low", next_decision: "Pick two shops.", fact_keys: [f], similar_to_goal_id: null }],
      game_plans: [{ goal_ref: `G:${goalId}`, lines: ["Two posts a week."], kept_athlete_text: false }, { goal_ref: "R1", lines: ["Pitch two shops."], kept_athlete_text: false }],
      actions: [
        { goal_ref: `G:${goalId}`, kind: "post", what: "Opener post", why: "Timed to the opener.", due_on: opener, event_ref: "E1", button: "post", deliverable: { type: "post_brief", title: "Opener", body: "Caption: home.", target: null, platform: "instagram", thread_ref: null, connector: null }, fact_keys: [f, "E1"] },
        { goal_ref: "R1", kind: "pitch", what: "Pitch a shop", why: "w", due_on: null, event_ref: null, button: "send", deliverable: { type: "pitch", title: "Hi", body: "Hello.", target: { subject_kind: "brand", name: "Shop One" }, platform: null, thread_ref: null, connector: null }, fact_keys: [f] },
      ],
      goal_notes: [], missing: [{ text: "Connect Instagram so your reach is measured", unlocks: "connect", connector: "instagram" }], path_note: "p",
    } };
  });
  setResponsesTransport(transport);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", agentGoalsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  setResponsesTransport(null);
  if (saved === undefined) delete process.env.AGENT_PLAN; else process.env.AGENT_PLAN = saved;
  await new Promise((r) => server.close(r));
  await closeTestDb();
});

test("D1: the plan_refresh workflow runs the plan on the runner and writes it", async () => {
  const r = await requestPlanRefresh(A, { trigger: "event", reason: "the Brief was written", immediate: true, idempotencyKey: "plan:onboarding:wf-test" });
  expect(r).toMatchObject({ started: true, joined: false, notBefore: null });
  const wf = (await getRun((r as any).runId))!;
  expect(wf.run.status).toBe("done");
  expect(wf.steps.map((s) => [s.step, s.status])).toEqual([["wait", "done"], ["plan", "done"], ["post_kits", "done"], ["tell", "done"]]);
  // No chat asked for this plan: the tell step leaves no message and calls no model.
  expect(wf.steps.find((s) => s.step === "tell")!.output).toEqual({ status: "none", chats: 0 });
  expect(wf.steps.find((s) => s.step === "plan")!.output).toMatchObject({ status: "planned", recommended: 1, actions: 2, held: 0 });
  // Track E is dark in this suite (AGENT_POST_KITS unset): the step answers "off" and builds nothing.
  expect(wf.steps.find((s) => s.step === "post_kits")!.output).toEqual({ status: "off" });
  expect(transport.calls.map(skillOf)).toEqual(["plan"]);

  const runs = await dbStore.listRunsSince(A, { since: new Date(Date.now() - 3_600_000).toISOString(), skillId: "plan" });
  expect(runs.map((x) => [x.skillId, x.trigger, x.status, x.parentRef])).toEqual([["plan", "event", "completed", `workflow:${(r as any).runId}:plan`]]);
  const rec = (await dbStore.listDecisions(A, { kinds: ["goal"], responses: ["pending"] }))[0];
  expect(rec).toMatchObject({ skillId: "plan", kind: "goal", suggested: "Get a first local partner", detail: { key: "R1", horizon: "next", gamePlan: ["Pitch two shops."] } });
  const actions = await dbStore.listDecisions(A, { kinds: ["action"] });
  expect(actions.map((a) => [a.suggested, a.goalId, a.parentDecisionId])).toEqual([["Opener post", goalId, null], ["Pitch a shop", null, rec.id]]);
  expect((await dbStore.listDecisions(A, { parentDecisionId: rec.id })).map((a) => a.suggested)).toEqual(["Pitch a shop"]);
  expect((await dbStore.getGoal(A, goalId))!).toMatchObject({ gamePlan: "Two posts a week.", gamePlanBy: "mila", horizon: "now" });

  // The same idempotency key joins the finished run; nothing is paid twice.
  const again = await requestPlanRefresh(A, { trigger: "event", reason: "retry", immediate: true, idempotencyKey: "plan:onboarding:wf-test" });
  expect(again).toMatchObject({ started: true, runId: (r as any).runId, joined: true });
  expect(transport.calls).toHaveLength(1);
  expect((await listRuns({ athleteId: A, process: "plan_refresh" })).length).toBe(1);
}, 60_000);

test("D2: the Goals API — the read, keep, change, set aside, Undo, add, results", async () => {
  const read = await call(A, "GET", "/agent/goals");
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({
    contract: "agent-goals/1",
    goals: [{ id: goalId, text: "Grow my audience", plan: "Two posts a week.", horizon: "now", actions: [{ title: "Opener post", state: "to_start", button: "start", event: { label: "Home opener", date: day(8) } }] }],
    recommended: [{ goal: "Get a first local partner", horizon: "next", gamePlan: "Pitch two shops.", actions: [{ title: "Pitch a shop" }] }],
    comingUp: [{ date: day(8), label: "Home opener", goalId, actionsReady: 1 }],
    riskUpside: { risk: "a quiet off-season.", upside: "the comeback story." },
    missing: [{ text: "Connect Instagram so your reach is measured", unlocks: "connect", connector: "instagram" }],
  });
  expect(read.body.plan.runId).toBeTruthy();
  expect(read.body.planning).toBeNull();                                           // the run is done: nothing in progress

  const kept = await call(A, "POST", `/agent/goals/recommended/${read.body.recommended[0].decisionId}/keep`, {});
  expect(kept.status).toBe(200);
  expect(kept.body.change).toMatchObject({ op: "keep", after: { text: "Get a first local partner", horizon: "next", status: "active" }, thisWeek: [{ title: "Pitch a shop" }] });
  expect(kept.body.goals.goals.map((g: any) => g.text)).toEqual(["Grow my audience", "Get a first local partner"]);
  expect(kept.body.goals.recommended).toEqual([]);

  const changed = await call(A, "PATCH", `/agent/goals/${goalId}`, { gamePlan: "My own plan." });
  expect(changed.body.change).toMatchObject({ op: "change", goalId });
  expect((await dbStore.getGoal(A, goalId))!).toMatchObject({ gamePlan: "My own plan.", gamePlanBy: "athlete" });
  const undo = await call(A, "POST", `/agent/goals/changes/${changed.body.change.undoDecisionId}/undo`);
  expect(undo.status).toBe(200);
  expect((await dbStore.getGoal(A, goalId))!).toMatchObject({ gamePlan: "Two posts a week.", gamePlanBy: "mila" });

  const aside = await call(A, "POST", `/agent/goals/${goalId}/set-aside`, { reason: "after the season" });
  expect(aside.body.goals.setAside.map((g: any) => g.id)).toEqual([goalId]);
  expect((await call(A, "POST", `/agent/goals/${goalId}/set-aside`)).status).toBe(409);
  expect((await call(A, "POST", `/agent/goals/${goalId}/bring-back`)).body.goals.goals.map((g: any) => g.id)).toContain(goalId);

  const added = await call(A, "POST", "/agent/goals", { text: "Speak at a local school", horizon: "later" });
  expect(added.body.change).toMatchObject({ op: "add", after: { text: "Speak at a local school", horizon: "later" } });
  expect((await call(A, "POST", "/agent/goals", { text: "x", horizon: "someday" })).status).toBe(400);
  expect((await call(A, "POST", "/agent/goals", {})).status).toBe(400);

  const results = await call(A, "GET", "/agent/results");
  expect(results.body.contract).toBe("agent-results/1");
  expect(results.body.goals.map((g: any) => g.text)).toEqual(expect.arrayContaining(["Grow my audience", "Get a first local partner"]));
}, 60_000);

test("D4: the daily sweep — a weekly run where none ran in 7 days; an event run when a dated event has nothing timed before it", async () => {
  const started: Array<{ athleteId: string; trigger: string; notBefore: string | null }> = [];
  const start = async (o: any) => {
    // The sweep only enqueues (the tick runs plans), one key per athlete, trigger and day.
    expect([o.kick, o.idempotencyKey]).toEqual([false, `plan:${o.input.trigger}:${o.athleteId}:${new Date().toISOString().slice(0, 10)}`]);
    started.push({ athleteId: o.athleteId, trigger: o.input.trigger, notBefore: o.input.notBefore });
    return { runId: `wf-${started.length}`, created: true };
  };
  const { sweepPlanRefresh } = await import("./triggers");
  // A's opener action is still waiting: the opener is covered, and A planned today — nothing to start for A.
  const covered = await dbStore.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: "Warm-up clip", why: "-", evidence: [], goalId,
    detail: { kind: "post", what: "Warm-up clip", button: "post", dueOn: day(6), state: "to_start", event: { factId: (await dbStore.listFacts(A)).find((f) => f.subject.kind === "event")!.id, label: "Home opener", date: day(8), precision: "day" } } });
  // B gets a Brief and has never had a plan.
  await dbStore.writeBrief(B, { summary: "B", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null });
  expect(await sweepPlanRefresh({ start })).toMatchObject({ checked: 2, scheduled: 1, events: 0 });
  expect(started).toEqual([{ athleteId: B, trigger: "schedule", notBefore: null }]);
  // Once nothing is timed before the opener any more, A gets an event run — coalesced, A's last plan being minutes old.
  await dbStore.respondDecision(A, covered.id, "expired", "test");
  started.length = 0;
  expect(await sweepPlanRefresh({ start })).toMatchObject({ events: 1 });
  expect(started.find((s) => s.athleteId === A)).toMatchObject({ trigger: "event" });
  expect(started.find((s) => s.athleteId === A)!.notBefore).toBeTruthy();
});

test("D3: tenancy — another athlete sees nothing of these goals and can change none of them", async () => {
  const b = await call(B, "GET", "/agent/goals");
  expect(b.body.goals.map((g: any) => g.text)).toEqual(["B's secret goal"]);
  expect(b.text).not.toMatch(/Grow my audience|local partner|Opener post|Home opener/);
  expect((await call(B, "PATCH", `/agent/goals/${goalId}`, { text: "taken" })).status).toBe(404);
  expect((await call(B, "POST", `/agent/goals/${goalId}/drop`)).status).toBe(404);
  const aDecision = (await dbStore.listDecisions(A, { kinds: ["goal"] }))[0];
  expect((await call(B, "POST", `/agent/goals/recommended/${aDecision.id}/keep`)).status).toBe(404);
  expect((await call(B, "POST", `/agent/goals/changes/${aDecision.id}/undo`)).status).toBe(404);
  expect((await call(A, "GET", "/agent/goals")).text).not.toContain("B's secret goal");
  // A decision can never be linked to another athlete's goal (the check is in the statement).
  const bGoal = (await dbStore.listGoals(B))[0];
  const linked = await dbStore.updateDecision(A, aDecision.id, { goalId: bGoal.id });
  expect(linked!.goalId).toBeNull();
  expect(await dbStore.getGoal(A, bGoal.id)).toBeNull();
  expect(await dbStore.deleteGoal(A, bGoal.id)).toBe(false);
});

test("D5: the daily sweep only enqueues — nothing runs in the cron request; the workflow tick runs the plan", async () => {
  const { sweepPlanRefresh } = await import("./triggers");
  const { tick } = await import("../../workflow/runner");
  const C = await seedAthlete("Third Athlete");
  await dbStore.insertFacts(C, [{ subject: { kind: "athlete", name: "Third Athlete" }, claim: "Third Athlete won the conference final.", type: "found", source: { url: "https://example.org/c-final" }, date: "2026-05-01", confidence: 0.9, runId: null, topic: "achievement" }]);
  await dbStore.writeBrief(C, { summary: "C", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null });
  const calls = transport.calls.length;
  const out = await sweepPlanRefresh();
  expect(out.scheduled).toBeGreaterThanOrEqual(1);
  const [run] = await listRuns({ process: "plan_refresh", athleteId: C });
  expect(run).toMatchObject({ status: "running", idempotency_key: `plan:schedule:${C}:${new Date().toISOString().slice(0, 10)}` });
  expect(transport.calls.length).toBe(calls);                                        // the request ran no plan
  // Enqueued and due: Goals says a plan is in progress, from the runner's active run.
  expect((await call(C, "GET", "/agent/goals")).body.planning).toEqual({ runId: run.id, step: "plan", startedAt: new Date(run.started_at).toISOString() });
  for (let i = 0; i < 4 && (await getRun(run.id))!.run.status === "running"; i++) await tick();
  expect((await getRun(run.id))!.run.status).toBe("done");
  expect((await call(C, "GET", "/agent/goals")).body.planning).toBeNull();
  expect(transport.calls.slice(calls).map(skillOf)).toContain("plan");
  // The same cron again today starts nothing new for C: C has planned.
  await sweepPlanRefresh();
  expect((await listRuns({ process: "plan_refresh", athleteId: C })).length).toBe(1);
}, 60_000);

test("D6: a run still waiting out its coalescing window is not in progress — planning stays null", async () => {
  const { cancelRun } = await import("../../workflow/runner");
  // A planned minutes ago (D1): an event now is coalesced to 6 hours after that plan (or joins the one D2's add started).
  const r = await requestPlanRefresh(A, { trigger: "event", reason: "a deal came in" });
  expect(r).toMatchObject({ started: true });
  const wait = (await getRun((r as any).runId))!.steps.find((s) => s.step === "wait")!;
  expect(wait.ready_at.getTime()).toBeGreaterThan(Date.now());
  expect((await getRun((r as any).runId))!.run.status).toBe("running");
  expect((await call(A, "GET", "/agent/goals")).body.planning).toBeNull();
  await cancelRun((r as any).runId);
});

test("D7: a plan asked for in two chats — the tell step flips each progress card and writes one Mila row in each, once", async () => {
  const { tick } = await import("../../workflow/runner");
  const { chatMessages } = await import("../../../shared/schema");
  const { db } = await import("../../db");
  const { getConversationMessages } = await import("../../mila/conversations");
  const { planProgressCard } = await import("./tools");
  const E = await seedAthlete("Fifth Athlete");
  await dbStore.insertFacts(E, [{ subject: { kind: "athlete", name: "Fifth Athlete" }, claim: "Fifth Athlete won the conference final.", type: "found", source: { url: "https://example.org/e-final" }, date: "2026-05-01", confidence: 0.9, runId: null, topic: "achievement" }]);
  await dbStore.writeBrief(E, { summary: "E", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null });

  const r = await requestPlanRefresh(E, { trigger: "chat", reason: "asked in the chat", immediate: true, kick: false });
  expect(r).toMatchObject({ started: true });
  const runId = (r as any).runId as string;
  // refresh_plan's card on Mila's row in two chats (a request from the second chat joined the same run).
  const c1 = "11111111-1111-4111-8111-111111111111";
  const c2 = "22222222-2222-4222-8222-222222222222";
  const card = planProgressCard(runId, { athleteId: E, runId: "00000000-0000-4000-8000-00000000c4a7", skillId: "chat" }, false);
  for (const cid of [c1, c2]) {
    await db.insert(chatMessages).values({ athlete_id: E, role: "user", content: "Refresh my plan", conversation_id: cid });
    await db.insert(chatMessages).values({ athlete_id: E, role: "assistant", content: "On it.", conversation_id: cid, agent_cards: [card] });
  }
  // Another athlete's row naming the same run is never touched.
  await db.insert(chatMessages).values({ athlete_id: B, role: "assistant", content: "x", conversation_id: c1, agent_cards: [card] });

  readyLine = "Your plan's ready.";
  for (let i = 0; i < 6 && (await getRun(runId))!.run.status === "running"; i++) await tick();
  const wf = (await getRun(runId))!;
  expect(wf.run.status).toBe("done");
  expect(wf.steps.find((s) => s.step === "tell")!.output).toMatchObject({ status: "told", chats: 2, line: "model" });
  const tellRuns = await dbStore.listRunsSince(E, { since: new Date(Date.now() - 3_600_000).toISOString(), skillId: "plan/ready" });
  expect(tellRuns.map((x) => x.parentRef)).toEqual([`workflow:${runId}:tell`]);

  for (const cid of [c1, c2]) {
    const msgs = await getConversationMessages(E, cid);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([["user", "Refresh my plan"], ["assistant", "On it."], ["assistant", "Your plan's ready."]]);
    expect((msgs[1].agentCards as any[])[0]).toMatchObject({ kind: "progress", payload: { state: "done", planRunId: runId } });
    expect((msgs[2].agentCards as any[])[0]).toMatchObject({ id: `plan-ready:${runId}`, kind: "open-screen", payload: { screen: "goals" } });
  }
  expect((await getConversationMessages(B, c1)).map((m) => (m.agentCards as any[])[0].payload.state)).toEqual(["running"]);
});

/** A fresh athlete the fake plan model can plan for (a Brief and the fact its answer cites). */
async function plannable(name: string): Promise<string> {
  const id = await seedAthlete(name);
  await dbStore.insertFacts(id, [{ subject: { kind: "athlete", name }, claim: `${name} won the conference final.`, type: "found", source: { url: `https://example.org/${id}` }, date: "2026-05-01", confidence: 0.9, runId: null, topic: "achievement" }]);
  await dbStore.writeBrief(id, { summary: name, sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null });
  return id;
}
const until = async (f: () => Promise<boolean>, ms = 15_000) => {
  const t0 = Date.now();
  while (!(await f())) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); }
};

test("D8: the race — a run that finishes before the asking chat's turn is written looks again, and tells that chat", async () => {
  const { tick, configureRunner, resetRunnerConfig } = await import("../../workflow/runner");
  const { chatMessages } = await import("../../../shared/schema");
  const { db } = await import("../../db");
  const { getConversationMessages } = await import("../../mila/conversations");
  const { goalTools } = await import("./tools");
  const { activePlanning } = await import("./planning");
  // A short backoff (the runner's default is a minute): long enough that the chat turn lands between attempts.
  configureRunner({ retry: { minTimeoutMs: 1500, maxTimeoutMs: 1500, randomize: false } });
  try {
    const F = await plannable("Sixth Athlete");
    readyLine = "Your plan's ready.";
    // The tool's real path: refresh_plan starts the run in the background and answers with its progress card.
    const refresh = goalTools(dbStore).find((t) => t.name === "refresh_plan")!;
    const cid = "33333333-3333-4333-8333-333333333333";
    const turn = { factKeys: new Map<string, string>(), conversationId: cid, offeredConnectors: [], today: "2026-10-12" };
    const ctx = { athleteId: F, runId: "00000000-0000-4000-8000-00000000d8d8", skillId: "chat", turn };
    const result = await refresh.execute!(ctx, {}) as any;
    expect(result).toMatchObject({ status: "ok", started: true });
    const runId = result.plan_run_id as string;
    const card = refresh.card!(result, ctx)!;
    // The run gets to tell before the chat turn's row exists: tell's first attempt finds no chat and looks again.
    await until(async () => (await getRun(runId))!.steps.some((s) => s.step === "tell" && s.status === "failed"));
    expect((await getRun(runId))!.run.status).toBe("running");
    expect((await activePlanning(F))?.step).toBe("tell");                                   // Goals still says "updating"
    expect((await getRun(runId))!.run.input).toMatchObject({ trigger: "chat", askedFrom: [cid] });
    // Now the chat turn is written (the chat turn writes exactly this row).
    await db.insert(chatMessages).values({ athlete_id: F, role: "assistant", content: "On it.", conversation_id: cid, agent_cards: [card], agent_run_id: ctx.runId });
    await until(async () => { await tick(); return (await getRun(runId))!.run.status !== "running"; });
    const wf = (await getRun(runId))!;
    expect(wf.run.status).toBe("done");
    expect(wf.steps.filter((s) => s.step === "tell").map((s) => s.status)).toEqual(["failed", "done"]);
    expect(wf.steps.find((s) => s.step === "tell" && s.status === "done")!.output).toMatchObject({ status: "told", chats: 1 });
    expect((await getConversationMessages(F, cid)).map((m) => m.content)).toEqual(["On it.", "Your plan's ready."]);
  } finally { resetRunnerConfig(); }
}, 60_000);

test("D9: a chat ask that joins a coalesced run ends its wait now, is recorded as asking, and is told", async () => {
  const { tick, configureRunner, resetRunnerConfig } = await import("../../workflow/runner");
  const { chatMessages } = await import("../../../shared/schema");
  const { db } = await import("../../db");
  const { getConversationMessages } = await import("../../mila/conversations");
  const { planProgressCard } = await import("./tools");
  configureRunner({ retry: { minTimeoutMs: 1500, maxTimeoutMs: 1500, randomize: false } });
  try {
  const G = await plannable("Seventh Athlete");
  // A plan just ran; an event now is coalesced into the 6 hours after it.
  expect(await requestPlanRefresh(G, { trigger: "event", reason: "first", immediate: true })).toMatchObject({ started: true });
  const coalesced = await requestPlanRefresh(G, { trigger: "event", reason: "a deal came in" });
  const runId = (coalesced as any).runId as string;
  const waitOf = async () => (await getRun(runId))!.steps.find((s) => s.step === "wait")!;
  expect((await waitOf()).ready_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
  // She asks in the chat: it joins that run, and the wait ends now.
  const cid = "44444444-4444-4444-8444-444444444444";
  const asked = await requestPlanRefresh(G, { trigger: "chat", reason: "asked in the chat", immediate: true, kick: false, conversationId: cid });
  expect(asked).toMatchObject({ started: true, runId, joined: true });
  expect((await waitOf()).ready_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  // The run was started by an event, but a chat joined it: it is told too.
  expect((await getRun(runId))!.run.input).toMatchObject({ trigger: "event", askedFrom: [cid] });
  await requestPlanRefresh(G, { trigger: "chat", reason: "again", immediate: true, kick: false, conversationId: cid });
  expect(((await getRun(runId))!.run.input as any).askedFrom).toEqual([cid]);              // once per chat
  await db.insert(chatMessages).values({ athlete_id: G, role: "assistant", content: "On it.", conversation_id: cid,
    agent_cards: [planProgressCard(runId, { athleteId: G, runId: "00000000-0000-4000-8000-00000000d9d9", skillId: "chat" }, false)] });
  readyLine = "Your plan's ready.";
  await until(async () => { await tick(); return (await getRun(runId))!.run.status !== "running"; });
  expect((await getRun(runId))!.run.status).toBe("done");
  expect((await getConversationMessages(G, cid)).map((m) => m.content)).toEqual(["On it.", "Your plan's ready."]);
  } finally { resetRunnerConfig(); }
}, 60_000);

test("D10: a chat-started run with no conversation at all settles at once (no retries to wait out)", async () => {
  const { tick } = await import("../../workflow/runner");
  const H = await plannable("Eighth Athlete");
  const r = await requestPlanRefresh(H, { trigger: "chat", reason: "asked in the chat", immediate: true, conversationId: null });
  const runId = (r as any).runId as string;
  await until(async () => { await tick(); return (await getRun(runId))!.run.status !== "running"; });
  const wf = (await getRun(runId))!;
  expect(wf.run.status).toBe("done");
  expect(wf.steps.filter((s) => s.step === "tell").map((s) => [s.status, s.output])).toEqual([["done", { status: "none", chats: 0 }]]);
}, 60_000);

test("D11: a run joined by a second chat is told in both, even when the first chat's turn is written and the second's is not yet", async () => {
  const { tick, configureRunner, resetRunnerConfig } = await import("../../workflow/runner");
  const { chatMessages } = await import("../../../shared/schema");
  const { db } = await import("../../db");
  const { getConversationMessages } = await import("../../mila/conversations");
  const { planProgressCard } = await import("./tools");
  configureRunner({ retry: { minTimeoutMs: 1500, maxTimeoutMs: 1500, randomize: false } });
  try {
    const J = await plannable("Ninth Athlete");
    const c1 = "55555555-5555-4555-8555-555555555555";
    const c2 = "66666666-6666-4666-8666-666666666666";
    const first = await requestPlanRefresh(J, { trigger: "chat", reason: "asked in the chat", immediate: true, kick: false, conversationId: c1 });
    const runId = (first as any).runId as string;
    const joined = await requestPlanRefresh(J, { trigger: "chat", reason: "asked in another chat", immediate: true, kick: false, conversationId: c2 });
    expect(joined).toMatchObject({ runId, joined: true });
    expect(((await getRun(runId))!.run.input as any).askedFrom).toEqual([c1, c2]);
    const row = (cid: string, ref: string) => ({ athlete_id: J, role: "assistant" as const, content: "On it.", conversation_id: cid,
      agent_cards: [planProgressCard(runId, { athleteId: J, runId: ref, skillId: "chat" }, false)] });
    // Only the first chat's turn is written when the run reaches tell.
    await db.insert(chatMessages).values(row(c1, "00000000-0000-4000-8000-0000000d1101"));
    readyLine = "Your plan's ready.";
    await until(async () => { await tick(); return (await getRun(runId))!.steps.some((s) => s.step === "tell" && s.status === "failed"); });
    expect((await getRun(runId))!.run.status).toBe("running");
    expect((await getConversationMessages(J, c1)).map((m) => m.content)).toEqual(["On it.", "Your plan's ready."]);
    // The second chat's turn lands: the next look tells it, and the first chat is not told twice.
    await db.insert(chatMessages).values(row(c2, "00000000-0000-4000-8000-0000000d1102"));
    await until(async () => { await tick(); return (await getRun(runId))!.run.status !== "running"; });
    expect((await getRun(runId))!.run.status).toBe("done");
    for (const cid of [c1, c2]) expect((await getConversationMessages(J, cid)).map((m) => m.content)).toEqual(["On it.", "Your plan's ready."]);
  } finally { resetRunnerConfig(); }
}, 60_000);
