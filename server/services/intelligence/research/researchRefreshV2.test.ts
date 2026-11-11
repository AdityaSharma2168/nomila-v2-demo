/**
 * researchRefreshV2.test.ts — the research_refresh v2 definition on the real runner (the skills binder runResearchRefresh mocked).
 *
 *   a v2 run carries the plan as input and calls refreshAthlete with it; the step returns references only
 *   a refused/failed refresh throws so the runner records the error and schedules the retry
 *   v1 still exists (the admin path pins it) and the latest version is 2
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../../skills/researchAthlete", () => ({ buildSearchName: (a: any) => a.full_name, researchAthlete: jest.fn() }));
jest.mock("../../../skills/researchRefresh", () => ({ runResearchRefresh: jest.fn(), REAL_REFRESH_PROVIDERS: {} }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { workflowRuns, workflowSteps } from "../../../../shared/schema";
import { configureRunner, getRun, resetRunnerConfig, startRun } from "../../../workflow/runner";
import { getDefinition } from "../../../workflow/registry";
import "../../../workflow/definitions/researchRefresh";
import { runResearchRefresh } from "../../../skills/researchRefresh";

const refresh = runResearchRefresh as jest.Mock;
let athleteId: string;

beforeAll(async () => { await initTestDb(); athleteId = await seedAthlete("V2 Athlete"); });
afterAll(closeTestDb);
beforeEach(async () => { resetRunnerConfig(); configureRunner({ retry: { randomize: false } }); refresh.mockReset(); await db.delete(workflowSteps); await db.delete(workflowRuns); });

it("research_refresh has versions 1 and 2; the latest is 2", () => {
  expect(getDefinition("research_refresh").version).toBe(2);
  expect(getDefinition("research_refresh", 1).version).toBe(1);
});

it("a v2 run passes the planned domains to refreshAthlete and finishes with references only", async () => {
  refresh.mockResolvedValue({ ok: true, researchRunId: "rr-1", status: "ok", outcomes: { press: "refreshed" } });
  const { run } = await startRun({ process: "research_refresh", version: 2, athleteId, createdBy: "schedule", idempotencyKey: `research_refresh:${athleteId}:2026-09-15`, input: { domains: ["press"], trigger: "ttl", reason: "press:stale", reserveCalls: 4, estUsd: 0.06 } });
  expect(run.status).toBe("done");
  expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ athleteId, workflowRunId: run.id, domains: ["press"], trigger: "ttl", full: false }));
  const r = await getRun(run.id);
  // miaTriggered records the Beta.1 decision ON THE RUN rather than only in a log line: RESEARCH_REFRESHED is
  // recorded and IGNORED, because the M.I.A. evaluator performs its own grounded research and never reads Nomila's
  // research substrate. Keeping it in the step output makes that decision queryable afterwards, so "why was no
  // assessment requested here?" is answerable from the run itself instead of from log retention.
  expect(r!.steps[0].output).toEqual({ research_run_id: "rr-1", status: "ok", outcomes: { press: "refreshed" }, reused: false, miaTriggered: false });
});

it("a refused refresh throws: the step records the error and the run waits for its retry", async () => {
  refresh.mockResolvedValue({ ok: false, researchRunId: null, status: "refused", error: "execution_disabled" });
  const { run } = await startRun({ process: "research_refresh", version: 2, athleteId, createdBy: "schedule", input: { domains: ["press"], trigger: "ttl" } });
  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.run_id, run.id));
  expect(steps.some((s) => s.status === "failed" && String(s.error).includes("execution_disabled"))).toBe(true);
  expect(run.status).not.toBe("done");
});
