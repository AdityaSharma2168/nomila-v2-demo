/**
 * socialSync.test.ts — the social_sync definition on the real runner, with
 * collectSocialAnalytics mocked at its module boundary (network-bound fetch, out of scope here).
 *
 * What is pinned:
 *   - collect_analytics calls collectSocialAnalytics(connectionId, "connect") — the trigger the
 *     substrate ingest was built for but nothing ever passed (server/services/intelligence/
 *     social/substrate.ts SyncTrigger).
 *   - a second connect for the same connection id returns the SAME run — never a second one.
 *   - collectSocialAnalytics returning null (SOCIAL_SUBSTRATE_WRITE off, no provider, expired
 *     token, or the shared discovery account) is a clean success for the step, not a failure.
 *   - a rejected fetch is a normal step failure — the runner's own retry policy applies, no
 *     bespoke retry loop here.
 *   - an unsupported platform/shape is rejected before collectSocialAnalytics is ever called.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../skills/collectSocialAnalytics", () => ({ collectSocialAnalytics: jest.fn() }));
jest.mock("../../services/intelligence/social/substrate", () => ({ recomputeFeatures: jest.fn() }));
jest.mock("../../services/intelligence/social/config", () => ({ substrateWriteEnabled: jest.fn(() => true) }));

import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../testUtils/pgliteDb";
import { workflowRuns, workflowSteps } from "../../../shared/schema";
import { collectSocialAnalytics } from "../../skills/collectSocialAnalytics";
import { recomputeFeatures } from "../../services/intelligence/social/substrate";
import { substrateWriteEnabled } from "../../services/intelligence/social/config";
import { configureRunner, resetRunnerConfig, startRun, getRun, tick } from "../runner";
import { SOCIAL_SYNC, SOCIAL_SYNC_V2 } from "./socialSync";
import "./index"; // registers social_sync (and onboarding, first_look, research_refresh)

const collect = collectSocialAnalytics as jest.Mock;
const recompute = recomputeFeatures as jest.Mock;
const writeEnabled = substrateWriteEnabled as jest.Mock;

let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Sync Athlete");
});
afterAll(closeTestDb);

beforeEach(async () => {
  resetRunnerConfig();
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } });
  jest.clearAllMocks();
  (substrateWriteEnabled as jest.Mock).mockReturnValue(true);
  (recomputeFeatures as jest.Mock).mockResolvedValue({ features: 1, identities: 1, observations: 1 });
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
});

test("social_sync v1: collect_analytics calls collectSocialAnalytics with trigger 'connect' and the run completes", async () => {
  // version: 1 is pinned explicitly below. startRun defaults to the LATEST registered definition, which is now v2 —
  // that default is exactly what makes the OAuth callback pick up feature recomputation without touching the callback.
  const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "rileyathlete" });
  collect.mockResolvedValue({ id: "snap-1" });

  const input = { connectionId, platform: "instagram" };
  const { run, created } = await startRun({ process: "social_sync", athleteId, createdBy: "connect", input, idempotencyKey: `connect:${connectionId}`, version: 1 });

  expect(created).toBe(true);
  expect(run.status).toBe("done");
  expect(collect).toHaveBeenCalledTimes(1);
  expect(collect).toHaveBeenCalledWith(connectionId, "connect");

  const { steps } = (await getRun(run.id))!;
  expect(steps.map((s) => [s.step, s.status])).toEqual([["collect_analytics", "done"]]);
  expect(steps[0].output).toEqual({ connectionId, platform: "instagram", saved: true });
});

test("social_sync v1: a second connect for the same connection id returns the SAME run — not a duplicate", async () => {
  const connectionId = await seedConnection({ athleteId, platform: "tiktok", email: "rileyathlete_tt" });
  collect.mockResolvedValue({ id: "snap-2" });
  const input = { connectionId, platform: "tiktok" };

  const first = await startRun({ process: "social_sync", athleteId, createdBy: "connect", input, idempotencyKey: `connect:${connectionId}` });
  const second = await startRun({ process: "social_sync", athleteId, createdBy: "connect", input, idempotencyKey: `connect:${connectionId}` });

  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(second.run.id).toBe(first.run.id);
  expect(collect).toHaveBeenCalledTimes(1); // the second start never re-ran the step
});

test("social_sync v1: collectSocialAnalytics returning null (flag off, no provider, or expired token) is a clean success, not a failure", async () => {
  const connectionId = await seedConnection({ athleteId, platform: "youtube", email: "rileyathlete_yt" });
  collect.mockResolvedValue(null); // e.g. SOCIAL_SUBSTRATE_WRITE=false — ingestNative no-ops and returns null

  const { run } = await startRun({ process: "social_sync", athleteId, createdBy: "connect", input: { connectionId, platform: "youtube" } });

  expect(run.status).toBe("done");
  const { steps } = (await getRun(run.id))!;
  expect(steps[0].output).toEqual({ connectionId, platform: "youtube", saved: false });
});

test("social_sync v1: a thrown fetch failure is a normal step failure — the runner's own retry policy applies", async () => {
  const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "rileyathlete_fail" });
  collect.mockRejectedValue(new Error("token refresh failed"));

  const { run } = await startRun({ process: "social_sync", athleteId, createdBy: "connect", input: { connectionId, platform: "instagram" } });

  expect(run.status).toBe("failed");
  expect(run.last_error).toMatch(/collect_analytics: token refresh failed/);
});

test("social_sync v1: rejects an unsupported platform before collectSocialAnalytics is ever called", async () => {
  const { run } = await startRun({ process: "social_sync", athleteId, createdBy: "connect", input: { connectionId: "c-x", platform: "gmail" } });
  expect(run.status).toBe("failed");
  expect(run.last_error).toMatch(/social_sync needs/);
  expect(collect).not.toHaveBeenCalled();
});

/**
 * v2: collection is not the finish line.
 *
 * The regression these pin is not hypothetical. Reconnecting Mia's YouTube on dev wrote nine fresh observations at
 * 04:43:35 — including avg_view_pct_30d, retention evidence that had never been available — and the authoritative
 * block re-rendered BYTE-IDENTICAL, still reporting "youtube: not available". v1 said `done` because collection had
 * succeeded; the block reads social_features, and nothing had derived any.
 */
describe("social_sync v2 — done means the evidence is consumable, not merely collected", () => {
  test("recomputes features for the athlete after a successful collection", async () => {
    const connectionId = await seedConnection({ athleteId, platform: "youtube", email: "rileyathlete2514" });
    collect.mockResolvedValue({ id: "snap-1" });
    recompute.mockResolvedValue({ features: 12, identities: 3, observations: 9 });

    const { run } = await startRun({ process: "social_sync", athleteId, input: { connectionId, platform: "youtube" }, kick: false, version: 2 });
    await tick(); await tick();

    expect(recompute).toHaveBeenCalledWith(athleteId);
    const { run: fresh, steps } = (await getRun(run.id))!;
    expect(fresh.status).toBe("done");
    expect(steps.find((s) => s.step === "recompute_features")!.output).toMatchObject({ recomputed: true, features: 12 });
  });

  test("FAILS the run when derivation fails, rather than reporting done on unusable evidence", async () => {
    // The v1 bug exactly: collection succeeded, so the run went green while every reader still saw stale evidence.
    const connectionId = await seedConnection({ athleteId, platform: "youtube", email: "rileyathlete2514" });
    collect.mockResolvedValue({ id: "snap-1" });
    recompute.mockResolvedValue(null);   // recomputeFeatures swallows its own errors and returns null

    const { run } = await startRun({ process: "social_sync", athleteId, input: { connectionId, platform: "youtube" }, kick: false, version: 2 });
    await tick(); await tick();

    const { run: fresh, steps } = (await getRun(run.id))!;
    expect(fresh.status).not.toBe("done");
    const step = steps.find((s) => s.step === "recompute_features")!;
    expect(step.status).not.toBe("done");
    expect(String(step.error)).toMatch(/no reader can consume them/);
  });

  test("a disabled substrate write is a clean no-op, NOT a failure", async () => {
    // recomputeFeatures returns null for BOTH "flag off" and "it threw". Conflating them would fail every sync in an
    // environment with the flag off, so the step checks the flag itself rather than inferring from the null.
    const connectionId = await seedConnection({ athleteId, platform: "youtube", email: "rileyathlete2514" });
    collect.mockResolvedValue(null);
    writeEnabled.mockReturnValueOnce(false);

    const { run } = await startRun({ process: "social_sync", athleteId, input: { connectionId, platform: "youtube" }, kick: false, version: 2 });
    await tick(); await tick();

    expect(recompute).not.toHaveBeenCalled();
    const { run: fresh, steps } = (await getRun(run.id))!;
    expect(fresh.status).toBe("done");
    expect(steps.find((s) => s.step === "recompute_features")!.output).toMatchObject({ recomputed: false });
  });

  test("v1 remains registered and unchanged, so in-flight runs are unaffected", () => {
    expect(SOCIAL_SYNC.version).toBe(1);
    expect(SOCIAL_SYNC.steps.map((s) => s.name)).toEqual(["collect_analytics"]);
    expect(SOCIAL_SYNC_V2.steps.map((s) => s.name)).toEqual(["collect_analytics", "recompute_features"]);
  });
});

/**
 * One score per sign-up (prod, 24 Oct 2026): a waitlist sign-up connected Instagram while her signup_research run was
 * still searching; social_sync asked for its own M.I.A. evaluation, the sign-up run scored her too, and the later of
 * the two (629) replaced the score she had just been emailed (649). While her sign-up run has not started its merge,
 * that run's score reads this connect's evidence, so the social path must not start a second one.
 */
describe("social_sync v2 — one score per sign-up", () => {
  const future = () => new Date(Date.now() + 60 * 60_000);
  async function signupRun(merge: "none" | "running") {
    const [run] = await db.insert(workflowRuns).values({
      athlete_id: athleteId, process: "signup_research", definition_version: 2, active_scope: "signup_research", status: "running", created_by: "signup",
    }).returning();
    // Rows the runner will not claim: leased far into the future.
    await db.insert(workflowSteps).values({ run_id: run.id, step: "research_a", ordinal: 0, kind: "model", status: "running", lease_until: future() });
    if (merge === "running") await db.insert(workflowSteps).values({ run_id: run.id, step: "research_merge", ordinal: 1, kind: "model", status: "running", lease_until: future() });
    return run.id;
  }
  const miaRuns = async () => (await db.select().from(workflowRuns)).filter((r) => r.process === "mia_evaluation");

  test("while her sign-up run has not merged, the connect leaves scoring to it (no second evaluation)", async () => {
    const signupId = await signupRun("none");
    const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "rileyathlete_one" });
    collect.mockResolvedValue({ id: "snap-1" });

    const { run } = await startRun({ process: "social_sync", athleteId, input: { connectionId, platform: "instagram" }, kick: false, version: 2 });
    await tick(); await tick();

    expect(recompute).toHaveBeenCalledWith(athleteId);   // the features are still derived: the sign-up's score reads them
    const { run: fresh, steps } = (await getRun(run.id))!;
    expect(fresh.status).toBe("done");
    expect(steps.find((s) => s.step === "recompute_features")!.output).toMatchObject({ recomputed: true, miaCreated: false, scoredBySignupRun: signupId });
    expect(await miaRuns()).toHaveLength(0);
  });

  test("once her sign-up run's merge has started, the connect asks for its own evaluation as before", async () => {
    await signupRun("running");
    const connectionId = await seedConnection({ athleteId, platform: "instagram", email: "rileyathlete_two" });
    collect.mockResolvedValue({ id: "snap-1" });

    const { run } = await startRun({ process: "social_sync", athleteId, input: { connectionId, platform: "instagram" }, kick: false, version: 2 });
    await tick(); await tick();

    const { steps } = (await getRun(run.id))!;
    const out = steps.find((s) => s.step === "recompute_features")!.output as Record<string, unknown>;
    expect(out.scoredBySignupRun).toBeUndefined();
    expect(await miaRuns()).toHaveLength(1);
  });
});
