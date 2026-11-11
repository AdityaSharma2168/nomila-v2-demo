/**
 * miaEvaluation.test.ts — the debounce on the real runner, where the money is.
 *
 * A grounded evaluation costs ~$0.21 and takes ~85s, so the two things that must be true are cost decisions before
 * they are correctness decisions:
 *
 *   COALESCING   an event cascade produces ONE run, not one per event. Proven through the runner's actual unique
 *                constraint rather than a queue of our own, because two simultaneous connects would both win a
 *                read-then-write.
 *   FRESHNESS    the run that fires at 10:10 builds its snapshot at 10:10. This is the whole reason `wait` is a step
 *                and the snapshot is not taken at scheduling time: a coalesced run must evaluate the athlete as they
 *                ARE, not as they were when the first of three events arrived.
 *
 * The orchestrator's own steps are mocked at their module boundary — what they do is covered in
 * marketabilityBeta1Orchestrator.test.ts against real SQL. What is under test here is the wiring.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../services/marketabilityBeta1Orchestrator", () => {
  const actual = jest.requireActual("../../services/marketabilityBeta1Orchestrator");
  return {
    ...actual,
    buildAndPersistSnapshot: jest.fn(),
    runEvaluation: jest.fn(),
    scoreAndRecord: jest.fn(),
  };
});

import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { workflowRuns, workflowSteps } from "../../../shared/schema";
import {
  MIA_DEBOUNCE_MS, MIA_EVALUATION_PROCESS,
  buildAndPersistSnapshot, runEvaluation, scoreAndRecord,
} from "../../services/marketabilityBeta1Orchestrator";
import { configureRunner, resetRunnerConfig, startRun, getRun, tick } from "../runner";
import "./index"; // registers mia_evaluation alongside the rest

const build = buildAndPersistSnapshot as jest.Mock;
const evaluate = runEvaluation as jest.Mock;
const score = scoreAndRecord as jest.Mock;

let athleteId: string;
let now = new Date("2026-09-15T10:00:00.000Z");

/** What the world looks like at snapshot time. A test moves this between scheduling and execution. */
let worldNow = { digest: "digest-at-1000", unchanged: false };

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Debounced Athlete");
});
afterAll(closeTestDb);

beforeEach(async () => {
  resetRunnerConfig();
  now = new Date("2026-09-15T10:00:00.000Z");
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } }, () => now);
  jest.clearAllMocks();
  worldNow = { digest: "digest-at-1000", unchanged: false };
  build.mockImplementation(async () => ({ snapshotId: "snap-1", evidenceAsOf: now.toISOString(), ...worldNow }));
  evaluate.mockResolvedValue({ runId: "run-1", status: "ok" });
  score.mockResolvedValue({ ledgerId: "led-1", score: 620, composite: 68, confidence: 80, becameCurrent: true });
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
});

const request = (input: Record<string, unknown>) =>
  startRun({ process: MIA_EVALUATION_PROCESS, athleteId, input: { trigger: "SOCIAL_BLOCK_CHANGED", force: false, reason: null, ...input }, kick: false });

test("three events inside the window collapse to one run, and one provider call", async () => {
  // Instagram connects at 10:00, YouTube at 10:04, a social sync lands at 10:07.
  const a = await request({ trigger: "IDENTITY_RESOLVED" });
  now = new Date("2026-09-15T10:04:00.000Z");
  const b = await request({ trigger: "SOCIAL_BLOCK_CHANGED" });
  now = new Date("2026-09-15T10:07:00.000Z");
  const c = await request({ trigger: "SOCIAL_BLOCK_CHANGED" });

  expect(a.created).toBe(true);
  expect(b.created).toBe(false);
  expect(c.created).toBe(false);
  expect(new Set([a.run.id, b.run.id, c.run.id]).size).toBe(1);
  expect(await db.select().from(workflowRuns)).toHaveLength(1);

  // Nothing has run yet: the window has not closed.
  now = new Date("2026-09-15T10:08:00.000Z");
  await tick();
  expect(build).not.toHaveBeenCalled();
  expect(evaluate).not.toHaveBeenCalled();
});

test("the snapshot is built when the window closes, from the state AT THAT MOMENT", async () => {
  const { run } = await request({ trigger: "IDENTITY_RESOLVED" });

  // Between scheduling and execution, two more connects land and change the athlete's evidence.
  worldNow = { digest: "digest-at-1007", unchanged: false };

  now = new Date(now.getTime() + MIA_DEBOUNCE_MS + 1000);
  for (let i = 0; i < 5 && (await getRun(run.id))!.run.status === "running"; i++) await tick();

  // The point of the whole design: what got evaluated is the 10:10 world, not the 10:00 one.
  expect(build).toHaveBeenCalledTimes(1);
  const snapshotStep = (await getRun(run.id))!.steps.find((s) => s.step === "snapshot")!;
  expect((snapshotStep.output as any).digest).toBe("digest-at-1007");
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(score).toHaveBeenCalledTimes(1);
  expect((await getRun(run.id))!.run.status).toBe("done");
});

test("unchanged evidence completes the run without a provider call", async () => {
  worldNow = { digest: "digest-at-1000", unchanged: true };
  const { run } = await request({ trigger: "SOCIAL_BLOCK_CHANGED" });
  now = new Date(now.getTime() + MIA_DEBOUNCE_MS + 1000);
  for (let i = 0; i < 5 && (await getRun(run.id))!.run.status === "running"; i++) await tick();

  // Re-asking an identical question samples the evaluator's non-determinism and calls it news, at ~$0.21 a time.
  expect(build).toHaveBeenCalledTimes(1);
  expect(evaluate).not.toHaveBeenCalled();
  expect(score).not.toHaveBeenCalled();
  expect((await getRun(run.id))!.run.status).toBe("done");
});

test("a manual refresh is not absorbed by a debounced run, and evaluates unchanged evidence anyway", async () => {
  worldNow = { digest: "digest-at-1000", unchanged: true };
  const debounced = await request({ trigger: "SOCIAL_BLOCK_CHANGED" });
  const manual = await request({ trigger: "USER_REQUESTED_REFRESH", force: true, reason: "score looks wrong" });

  // A person asking for a refresh must not silently join a run that is about to decide nothing changed and skip.
  expect(manual.created).toBe(true);
  expect(manual.run.id).not.toBe(debounced.run.id);

  // And it starts immediately rather than waiting out someone else's debounce window.
  now = new Date(now.getTime() + 1000);
  for (let i = 0; i < 5 && (await getRun(manual.run.id))!.run.status === "running"; i++) await tick();
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect((await getRun(manual.run.id))!.run.status).toBe("done");

  // The debounced run is untouched by any of that.
  expect((await getRun(debounced.run.id))!.run.status).toBe("running");
});

test("two manual refreshes still coalesce — the exception is manual, not unlimited", async () => {
  const first = await request({ trigger: "USER_REQUESTED_REFRESH", force: true, reason: "one" });
  const second = await request({ trigger: "USER_REQUESTED_REFRESH", force: true, reason: "two" });
  expect(second.created).toBe(false);
  expect(second.run.id).toBe(first.run.id);
});

test("an athlete with no resolvable identity completes cleanly without asking anything", async () => {
  // The evaluator needs a sport, and guessing one would be inventing evidence. That is an ordinary outcome, not a
  // failure: failing the run would retry it twice and still not know the sport.
  build.mockResolvedValue(null);
  const { run } = await request({ trigger: "IDENTITY_RESOLVED" });
  now = new Date(now.getTime() + MIA_DEBOUNCE_MS + 1000);
  for (let i = 0; i < 5 && (await getRun(run.id))!.run.status === "running"; i++) await tick();

  expect(evaluate).not.toHaveBeenCalled();
  expect((await getRun(run.id))!.run.status).toBe("done");
});

test("an unrecognised trigger is refused at request time — no run, no scheduled call", async () => {
  // The refusal lands in startRun because the `wait` step computes readyAt as the run opens, and it validates the
  // input to do so. That is the right place for it: a trigger we do not recognise is a wiring bug, and a run that
  // exists only to fail ten minutes later would hide the cause behind a delay.
  await expect(
    startRun({ process: MIA_EVALUATION_PROCESS, athleteId, input: { trigger: "BECAUSE_I_SAID_SO" }, kick: false }),
  ).rejects.toThrow(/mia_evaluation needs/);
  expect(build).not.toHaveBeenCalled();
});
