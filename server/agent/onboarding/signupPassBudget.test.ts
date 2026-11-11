/**
 * signupPassBudget.test.ts — the waitlist sign-up's time budget per web-search pass (workflow.ts budgetedPassStep).
 *
 * Prod, 24 Oct 2026: pass A took 4m50s, pass B 9m07s (its searches were done in 90 s; the rest was the model thinking),
 * so the sign-up's score waited ~12 minutes on one pass. A pass now stops at SIGNUP_PASS_BUDGET_MS — but only once the
 * other pass has finished, so the merge always has one whole pass. Pinned here on PGlite (no provider is reached):
 *   - under the budget: never stop, whatever the sibling did
 *   - over the budget, sibling still running: keep going (never both cut)
 *   - over the budget, sibling done: stop
 *   - the budget's default and its switch-off (0)
 *   - the sign-up run's passes are the budgeted ones; the app onboarding's are not
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { passBudgetSpent, signupPassBudgetMs } from "./workflow";

let runId: string;

beforeAll(async () => {
  await initTestDb();
  const athleteId = await seedAthlete("Budget Athlete");
  const [run] = await db.insert(workflowRuns).values({
    athlete_id: athleteId, process: "signup_research", definition_version: 2, active_scope: "signup_research", status: "running", created_by: "signup",
  }).returning();
  runId = run.id;
});
afterAll(closeTestDb);

const BUDGET = 270_000;

test("under the budget a pass never stops", async () => {
  expect(await passBudgetSpent({ runId, sibling: "research_a", startedMs: 0, budgetMs: BUDGET, nowMs: BUDGET - 1 })).toBe(false);
});

test("over the budget with the other pass still running: keep going (both are never cut)", async () => {
  await db.insert(workflowSteps).values({ run_id: runId, step: "research_a", ordinal: 0, kind: "model", status: "running" });
  expect(await passBudgetSpent({ runId, sibling: "research_a", startedMs: 0, budgetMs: BUDGET, nowMs: BUDGET + 60_000 })).toBe(false);
});

test("over the budget once the other pass is done: stop", async () => {
  await db.update(workflowSteps).set({ status: "done" });
  expect(await passBudgetSpent({ runId, sibling: "research_a", startedMs: 0, budgetMs: BUDGET, nowMs: BUDGET })).toBe(true);
  // A different run's finished pass never counts.
  expect(await passBudgetSpent({ runId: "00000000-0000-0000-0000-000000000000", sibling: "research_a", startedMs: 0, budgetMs: BUDGET, nowMs: BUDGET })).toBe(false);
});

test("SIGNUP_PASS_BUDGET_MS: 4.5 minutes by default, 0 turns it off, junk falls back to the default", () => {
  const prev = process.env.SIGNUP_PASS_BUDGET_MS;
  try {
    delete process.env.SIGNUP_PASS_BUDGET_MS;
    expect(signupPassBudgetMs()).toBe(270_000);
    process.env.SIGNUP_PASS_BUDGET_MS = "0";
    expect(signupPassBudgetMs()).toBe(0);
    process.env.SIGNUP_PASS_BUDGET_MS = "360000";
    expect(signupPassBudgetMs()).toBe(360_000);
    process.env.SIGNUP_PASS_BUDGET_MS = "soon";
    expect(signupPassBudgetMs()).toBe(270_000);
  } finally {
    if (prev === undefined) delete process.env.SIGNUP_PASS_BUDGET_MS; else process.env.SIGNUP_PASS_BUDGET_MS = prev;
  }
});

test("the sign-up run's passes are budgeted; the app onboarding's passes are untouched", async () => {
  const { SIGNUP_RESEARCH_V2, SIGNUP_RESEARCH } = await import("./signupResearchWorkflow");
  const { AGENT_RESEARCH_STEPS } = await import("./workflow");
  expect(SIGNUP_RESEARCH_V2.steps.map((s) => s.name)).toEqual(["research_a", "research_b", "research_merge", "mia_preview", "score_email"]);
  expect(SIGNUP_RESEARCH_V2.steps[0].run).not.toBe(AGENT_RESEARCH_STEPS[0].run);
  expect(SIGNUP_RESEARCH_V2.steps[1].run).not.toBe(AGENT_RESEARCH_STEPS[1].run);
  expect(SIGNUP_RESEARCH_V2.steps[1].parallel).toBe(true);
  expect(SIGNUP_RESEARCH_V2.steps[2].run).toBe(AGENT_RESEARCH_STEPS[2].run);
  // v1 runs finish on v1, unchanged.
  expect(SIGNUP_RESEARCH.steps[0].run).toBe(AGENT_RESEARCH_STEPS[0].run);
});
