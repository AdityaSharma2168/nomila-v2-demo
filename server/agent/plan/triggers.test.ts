/**
 * triggers.test.ts — what starts a plan refresh, and the guards (in-memory store; the run starter is injected).
 *
 *   R1 off unless AGENT_PLAN is exactly "true" (nothing is read or started)
 *   R2 nothing without a current Brief
 *   R3 at most 1 scheduled and 4 event-or-chat plan runs per athlete per 7 days (failed runs do not count)
 *   R4 an event within 6 hours of the last plan waits until the 6 hours are up (coalesced); onboarding's first plan and
 *      a chat request go at once
 *   R5 a starter failure is reported, never thrown
 *   R6 plan 1.5.0: a standing trigger (weekly, before_event, deal_signed) scopes the run to the active goal repeating on it
 */
jest.mock("../../db", () => ({ db: {} }));

import { createMemoryStore, type AgentStore } from "../research/store";
import { agentPlanEnabled } from "./config";
import { requestPlanRefresh, type RunStarter } from "./triggers";

const A = "00000000-0000-4000-8000-0000000000aa";
const saved = process.env.AGENT_PLAN;
afterEach(() => { if (saved === undefined) delete process.env.AGENT_PLAN; else process.env.AGENT_PLAN = saved; });

function starter() {
  const calls: Array<Parameters<RunStarter>[0]> = [];
  const start: RunStarter = async (o) => { calls.push(o); return { runId: `wf-${calls.length}`, created: true }; };
  return { calls, start };
}
const brief = (store: AgentStore) => store.writeBrief(A, { summary: "S", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, runId: null });
async function planRun(store: AgentStore, trigger: "schedule" | "event" | "chat", status: "completed" | "failed" = "completed") {
  const id = await store.startRun({ athleteId: A, skillId: "plan", skillVersion: "1.0.0", trigger, model: { provider: "openai", model: "m", effort: "medium" }, parentRef: null });
  await store.finishRun(A, id, { status, stopReason: null, cost: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd: 1 }, steps: [], evidenceRead: [], output: null, error: null });
  return (await store.getRun(A, id))!;
}

test("R1: off unless AGENT_PLAN is exactly \"true\"", async () => {
  const { calls, start } = starter();
  for (const v of [undefined, "", "TRUE", "1", " true"]) {
    if (v === undefined) delete process.env.AGENT_PLAN; else process.env.AGENT_PLAN = v;
    expect(agentPlanEnabled()).toBe(false);
    expect(await requestPlanRefresh(A, { trigger: "event", reason: "x" }, { store: createMemoryStore(), start })).toEqual({ started: false, reason: "off" });
  }
  expect(calls).toHaveLength(0);
});

test("R2–R3: a Brief is needed; weekly and event caps per 7 days", async () => {
  process.env.AGENT_PLAN = "true";
  const store = createMemoryStore();
  const { calls, start } = starter();
  expect(await requestPlanRefresh(A, { trigger: "schedule", reason: "weekly" }, { store, start })).toEqual({ started: false, reason: "no_brief" });
  await brief(store);
  expect(await requestPlanRefresh(A, { trigger: "schedule", reason: "weekly" }, { store, start })).toMatchObject({ started: true, runId: "wf-1", joined: false, notBefore: null });
  expect(calls[0]).toEqual({ process: "plan_refresh", athleteId: A, input: { trigger: "schedule", reason: "weekly", goalId: null, notBefore: null }, createdBy: "plan:schedule", idempotencyKey: undefined });
  await planRun(store, "schedule");
  expect(await requestPlanRefresh(A, { trigger: "schedule", reason: "weekly" }, { store, start })).toEqual({ started: false, reason: "weekly_cap" });
  await planRun(store, "event", "failed");                                         // a failed run is not counted
  for (const t of ["event", "event", "chat", "event"] as const) await planRun(store, t);
  expect(await requestPlanRefresh(A, { trigger: "chat", reason: "plan my week", immediate: true }, { store, start })).toEqual({ started: false, reason: "event_cap" });
  expect(await requestPlanRefresh(A, { trigger: "event", reason: "a new deal" }, { store, start })).toEqual({ started: false, reason: "event_cap" });
});

test("R4: an event within 6 hours of the last plan is coalesced; onboarding and chat go at once", async () => {
  process.env.AGENT_PLAN = "true";
  const store = createMemoryStore();
  await brief(store);
  const last = await planRun(store, "event");
  const { calls, start } = starter();
  const now = new Date(Date.parse(last.startedAt) + 60 * 60_000);                 // an hour after the last plan
  const r = await requestPlanRefresh(A, { trigger: "event", reason: "a new deal", now }, { store, start });
  expect(r).toMatchObject({ started: true, notBefore: new Date(Date.parse(last.startedAt) + 6 * 3_600_000).toISOString() });
  expect(calls[0].input.notBefore).toBe((r as any).notBefore);
  expect(await requestPlanRefresh(A, { trigger: "event", reason: "the Brief was written", immediate: true, idempotencyKey: "plan:onboarding:wf", now }, { store, start })).toMatchObject({ started: true, notBefore: null });
  expect(calls[1].idempotencyKey).toBe("plan:onboarding:wf");
  expect(await requestPlanRefresh(A, { trigger: "chat", reason: "asked in the chat", goalId: "g1", now }, { store, start })).toMatchObject({ started: true, notBefore: null });
  expect(calls[2].input).toEqual({ trigger: "chat", reason: "asked in the chat", goalId: "g1", notBefore: null });
  // Seven hours later an event goes at once.
  expect(await requestPlanRefresh(A, { trigger: "event", reason: "new numbers", now: new Date(Date.parse(last.startedAt) + 7 * 3_600_000) }, { store, start })).toMatchObject({ notBefore: null });
});

test("R5: a starter failure is reported, never thrown", async () => {
  process.env.AGENT_PLAN = "true";
  const store = createMemoryStore();
  await brief(store);
  const r = await requestPlanRefresh(A, { trigger: "event", reason: "x" }, { store, start: async () => { throw new Error("db down"); } });
  expect(r).toEqual({ started: false, reason: "error" });
});

test("R6: plan 1.5.0 — a standing trigger scopes the run to the active goal that repeats on it (read off its recommendation)", async () => {
  process.env.AGENT_PLAN = "true";
  const store = createMemoryStore();
  const { calls, start } = starter();
  await brief(store);
  const rec = (repeats: string) => store.insertDecision(A, { runId: null, skillId: "plan", kind: "goal", suggested: `g ${repeats}`, why: "w", evidence: [], detail: { key: "R1", repeats } });
  const before = await rec("before_event");
  const weekly = await rec("weekly");
  await store.insertGoal(A, { text: "A post before every home race", source: "proposed_accepted", decisionId: before.id });
  const paused = await store.insertGoal(A, { text: "A post every week", source: "proposed_accepted", decisionId: weekly.id });
  await store.updateGoal(A, paused.id, { status: "paused" });
  const goals = await store.listGoals(A);
  const beforeGoal = goals.find((g) => g.decisionId === before.id)!;

  await requestPlanRefresh(A, { trigger: "event", reason: "a dated event is coming up (1)", standing: "before_event", immediate: true }, { store, start });
  expect(calls[0].input.goalId).toBe(beforeGoal.id);
  // A set-aside goal is not active: a weekly run is not scoped to it.
  await requestPlanRefresh(A, { trigger: "schedule", reason: "weekly refresh", standing: "weekly" }, { store, start });
  expect(calls[1].input.goalId).toBeNull();
  // An explicit goal wins; no standing goal for a trigger → none.
  await requestPlanRefresh(A, { trigger: "event", reason: "you kept a goal", goalId: "g-explicit", standing: "before_event", immediate: true }, { store, start });
  expect(calls[2].input.goalId).toBe("g-explicit");
  await requestPlanRefresh(A, { trigger: "event", reason: "a deal was agreed", standing: "deal_signed", immediate: true }, { store, start });
  expect(calls[3].input.goalId).toBeNull();
});
