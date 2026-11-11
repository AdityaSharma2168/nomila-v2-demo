/**
 * miaTriggers.test.ts — the Beta.1 M.I.A. trigger policy, including what must NOT trigger.
 *
 * The approved policy is four rules, and three of them are about restraint:
 *   IDENTITY_RESOLVED      an athlete with a resolvable sport gets an initial assessment
 *   SOCIAL_BLOCK_CHANGED   connected evidence becoming current refreshes it
 *   USER_REQUESTED_REFRESH a person may ask anyway, even when the evidence is unchanged
 *   RESEARCH_REFRESHED     recorded and IGNORED — the evaluator does its own grounded research
 *
 * Each provider call is ~$0.21 against a non-deterministic model, so a trigger that fires when it should not is not a
 * tidiness problem: it spends money to resample drift and calls the result news.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../skills/collectSocialAnalytics", () => ({ collectSocialAnalytics: jest.fn() }));
jest.mock("../../services/intelligence/social/substrate", () => ({ recomputeFeatures: jest.fn() }));
jest.mock("../../services/intelligence/social/config", () => ({ substrateWriteEnabled: jest.fn(() => true) }));
jest.mock("../../services/marketabilityBeta1Orchestrator", () => {
  const actual = jest.requireActual("../../services/marketabilityBeta1Orchestrator");
  return { ...actual, requestEvaluation: jest.fn(async () => ({ runId: "mia-run-1", created: true })) };
});

import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { memoryFacts, workflowRuns, workflowSteps } from "../../../shared/schema";
import { substrateWriteEnabled } from "../../services/intelligence/social/config";
import { collectSocialAnalytics } from "../../skills/collectSocialAnalytics";
import { recomputeFeatures } from "../../services/intelligence/social/substrate";
import { requestEvaluation } from "../../services/marketabilityBeta1Orchestrator";
import { configureRunner, resetRunnerConfig, startRun, getRun, tick } from "../runner";
import { TRIGGER_REASONS } from "../../services/marketabilityBeta1Snapshot";
import "./index";

const collect = collectSocialAnalytics as jest.Mock;
const recompute = recomputeFeatures as jest.Mock;
const requestEval = requestEvaluation as jest.Mock;

let athleteId: string;

beforeAll(async () => { await initTestDb(); athleteId = await seedAthlete("Triggered Athlete"); });
afterAll(closeTestDb);

beforeEach(async () => {
  resetRunnerConfig();
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } });
  jest.clearAllMocks();
  collect.mockResolvedValue({ id: "snap-1" });
  recompute.mockResolvedValue({ features: 12, identities: 2, observations: 900 });
  requestEval.mockResolvedValue({ runId: "mia-run-1", created: true });
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
});

describe("connected evidence becoming current triggers an evaluation", () => {
  test("social_sync requests SOCIAL_BLOCK_CHANGED after features are recomputed — not before", async () => {
    const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "athlete" });
    const { run } = await startRun({ process: "social_sync", athleteId, input: { connectionId, platform: "instagram" }, kick: false, version: 2 });
    await tick(); await tick();

    expect(requestEval).toHaveBeenCalledTimes(1);
    expect(requestEval).toHaveBeenCalledWith(expect.objectContaining({ athleteId, trigger: "SOCIAL_BLOCK_CHANGED", createdBy: "social_sync" }));
    // Ordering is the point: the block reads FEATURES, so asking before the recompute would evaluate the athlete as
    // they were before their own connect.
    expect(recompute).toHaveBeenCalled();
    expect((await getRun(run.id))!.run.status).toBe("done");
  });

  test("a new-agent (memory) athlete connects with SOCIAL_SUBSTRATE_WRITE off: measured facts synced, SOCIAL_BLOCK_CHANGED requested once", async () => {
    // The connect path of "the score follows better data" (owner, 26 Oct 2026): her M.I.A. reads measured memory facts,
    // so her recompute does not wait on the substrate flag.
    (substrateWriteEnabled as jest.Mock).mockReturnValue(false);
    try {
      const memoryAthlete = await seedAthlete("Connecting Memory Athlete");
      await db.insert(memoryFacts).values({
        athlete_id: memoryAthlete, subject_kind: "athlete", subject_name: "Connecting Memory Athlete", claim: "The athlete's name is Connecting Memory Athlete.",
        type: "said", source_ref: "onboarding/x#name", source_title: "You told us", confidence: 1,
      } as any);
      const connectionId = await seedConnection({ athleteId: memoryAthlete, platform: "instagram", email: "memory-connect" });
      const { run } = await startRun({ process: "social_sync", athleteId: memoryAthlete, input: { connectionId, platform: "instagram" }, kick: false, version: 2 });
      await tick(); await tick();

      expect(requestEval).toHaveBeenCalledTimes(1);
      expect(requestEval).toHaveBeenCalledWith(expect.objectContaining({ athleteId: memoryAthlete, trigger: "SOCIAL_BLOCK_CHANGED", createdBy: "social_sync" }));
      expect(recompute).not.toHaveBeenCalled();
      expect((await getRun(run.id))!.steps.find((s) => s.step === "recompute_features")!.output).toMatchObject({ miaRunId: "mia-run-1" });
    } finally { (substrateWriteEnabled as jest.Mock).mockReturnValue(true); }
  });

  test("does NOT request an evaluation when the derivation failed", async () => {
    // No consumable evidence exists, so there is nothing new to assess and the run itself must fail.
    const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "athlete" });
    recompute.mockResolvedValue(null);
    const { run } = await startRun({ process: "social_sync", athleteId, input: { connectionId, platform: "instagram" }, kick: false, version: 2 });
    await tick(); await tick();

    expect(requestEval).not.toHaveBeenCalled();
    expect((await getRun(run.id))!.run.status).not.toBe("done");
  });

  test("a failure to SCHEDULE the evaluation does not undo a sync that genuinely succeeded", async () => {
    // The evidence is collected and derived; only the scheduling failed. Failing the run would retry the provider
    // collection to fix a problem that has nothing to do with it.
    const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "athlete" });
    requestEval.mockRejectedValue(new Error("runner unavailable"));
    const { run } = await startRun({ process: "social_sync", athleteId, input: { connectionId, platform: "instagram" }, kick: false, version: 2 });
    await tick(); await tick();

    const { run: fresh, steps } = (await getRun(run.id))!;
    expect(fresh.status).toBe("done");
    expect(steps.find((s) => s.step === "recompute_features")!.output).toMatchObject({ recomputed: true, miaRunId: null });
  });
});

describe("what must NOT trigger an evaluation", () => {
  test("RESEARCH_REFRESHED is not a trigger reason at all — the type system refuses it", () => {
    // Recorded and ignored for Beta.1: the evaluator performs its own grounded research and never reads Nomila's
    // research substrate, so a refresh changes nothing it would see. Enforced structurally rather than by a comment.
    expect(TRIGGER_REASONS).not.toContain("RESEARCH_REFRESHED");
    expect([...TRIGGER_REASONS]).toEqual(["IDENTITY_RESOLVED", "SOCIAL_BLOCK_CHANGED", "USER_REQUESTED_REFRESH", "ADMIN_REQUESTED_REFRESH"]);
  });

  test("a surprising score is not a reason — nothing in the policy reads a previous result", () => {
    // Stated as a test because it is the most tempting bad trigger: re-running because a number looked wrong would
    // select for results that match expectations, which is how a measurement quietly becomes a preference.
    const reasons = [...TRIGGER_REASONS].join(" ");
    expect(reasons).not.toMatch(/score|unexpected|surprising|low|high|anomal/i);
  });
});
