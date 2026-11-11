/**
 * identityRefresh.test.ts — her change reaches My Story (Oct 2026), on PGlite. No provider is reached: the run step's
 * Identity Intelligence call and the envelope hash are mocked at their module boundary.
 *
 * Pinned:
 *   • flag off ⇒ a request starts nothing; flag on ⇒ one run, and a burst of requests coalesces into it
 *   • the run waits out the debounce, then asks Identity Intelligence ONCE, with the retry cap on
 *   • a provider outage throws (the runner retries it); validation failure is an answer, not a retry
 *   • a change made while the run executed is not lost: onDone re-requests when the live hash moved; it does not when
 *     nothing changed (no loop)
 *   • recordAssertions — the choke point for what she records — asks for a refresh
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../services/identityIntelligenceProvider", () => ({ callIdentitySynthesis: jest.fn(async () => { throw new Error("tests never reach providers"); }) }));
jest.mock("../../services/intelligence/identityIntelligence/run", () => {
  const actual = jest.requireActual("../../services/intelligence/identityIntelligence/run");
  return { ...actual, runIdentityIntelligence: jest.fn() };
});
jest.mock("../../services/intelligence/identityIntelligence/envelope", () => {
  const actual = jest.requireActual("../../services/intelligence/identityIntelligence/envelope");
  return { ...actual, buildIdentityEnvelope: jest.fn() };
});

import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { workflowRuns, workflowSteps } from "../../../shared/schema";
import { configureRunner, resetRunnerConfig, getRun, tick } from "../runner";
import { runIdentityIntelligence } from "../../services/intelligence/identityIntelligence/run";
import { buildIdentityEnvelope } from "../../services/intelligence/identityIntelligence/envelope";
import { IDENTITY_REFRESH_DEBOUNCE_MS, IDENTITY_REFRESH_PROCESS, requestIdentityRefresh } from "../../services/intelligence/identityIntelligence/refresh";
import { recordAssertions } from "../../mila/onboarding";
import "./index";

const runII = runIdentityIntelligence as jest.Mock;
const envelope = buildIdentityEnvelope as jest.Mock;

let athleteId: string;
let now = new Date("2026-10-05T10:00:00.000Z");
const later = (ms: number) => { now = new Date(now.getTime() + ms); };
const runsFor = (a: string) => db.select().from(workflowRuns).where(and(eq(workflowRuns.athlete_id, a), eq(workflowRuns.process, IDENTITY_REFRESH_PROCESS)));
const answer = (outcome: string, inputVersion = "v-1") => ({ outcome, inputVersion, entryId: null, athleteId, supersededEntryId: null, value: null, validation: [], runId: null, sufficiency: { met: true, reasons: [] } });

beforeAll(async () => { await initTestDb(); athleteId = await seedAthlete("Refresh Example"); });
afterAll(closeTestDb);

beforeEach(async () => {
  resetRunnerConfig();
  now = new Date("2026-10-05T10:00:00.000Z");
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } }, () => now);
  jest.clearAllMocks();
  process.env.IDENTITY_INTELLIGENCE_ENABLED = "true";
  envelope.mockResolvedValue({ inputVersion: "v-1" });
  runII.mockResolvedValue(answer("persisted"));
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
});
afterEach(() => { delete process.env.IDENTITY_INTELLIGENCE_ENABLED; });

test("flag off: a request starts nothing", async () => {
  delete process.env.IDENTITY_INTELLIGENCE_ENABLED;
  expect(await requestIdentityRefresh(athleteId, "test")).toBeNull();
  expect(await runsFor(athleteId)).toHaveLength(0);
});

test("a burst of requests coalesces into one run, which waits out the debounce and asks Identity Intelligence once", async () => {
  const first = await requestIdentityRefresh(athleteId, "first edit");
  const second = await requestIdentityRefresh(athleteId, "second edit");
  expect(first?.created).toBe(true);
  expect(second).toMatchObject({ runId: first!.runId, created: false });

  await tick(); await tick();
  expect(runII).not.toHaveBeenCalled();   // still inside the window

  later(IDENTITY_REFRESH_DEBOUNCE_MS + 1_000);
  await tick(); await tick(); await tick();
  expect(runII).toHaveBeenCalledTimes(1);
  expect(runII).toHaveBeenCalledWith(athleteId, expect.objectContaining({ skipIfFailedBefore: true }));
  expect(runII.mock.calls[0][1].force).toBeUndefined();
  expect((await getRun(first!.runId))!.run.status).toBe("done");
});

test("validation failure is an answer (the run is done, nothing retried); a provider outage throws so the runner retries", async () => {
  runII.mockResolvedValueOnce(answer("validation_failed"));
  const a = await requestIdentityRefresh(athleteId, "edit");
  later(IDENTITY_REFRESH_DEBOUNCE_MS + 1_000);
  await tick(); await tick(); await tick();
  expect((await getRun(a!.runId))!.run.status).toBe("done");
  expect(runII).toHaveBeenCalledTimes(1);

  await db.delete(workflowSteps); await db.delete(workflowRuns);
  runII.mockResolvedValueOnce({ ...answer("provider_error"), reason: "timeout" });
  const b = await requestIdentityRefresh(athleteId, "edit");
  later(IDENTITY_REFRESH_DEBOUNCE_MS + 1_000);
  await tick(); await tick(); await tick();
  expect((await getRun(b!.runId))!.run.status).not.toBe("done");
});

test("a change made while the run executed is picked up by one more run; an unchanged hash requests nothing", async () => {
  // The run answered v-1, but by the time it is done the live inputs hash to v-2.
  runII.mockResolvedValueOnce(answer("persisted", "v-1"));
  envelope.mockResolvedValue({ inputVersion: "v-2" });
  await requestIdentityRefresh(athleteId, "edit");
  later(IDENTITY_REFRESH_DEBOUNCE_MS + 1_000);
  await tick(); await tick(); await tick();
  const runs = await runsFor(athleteId);
  expect(runs).toHaveLength(2);
  expect(runs.filter((r) => r.status === "done")).toHaveLength(1);

  // The follow-up answers v-2 and the live hash is still v-2: nothing more.
  runII.mockResolvedValueOnce(answer("skipped_unchanged", "v-2"));
  later(IDENTITY_REFRESH_DEBOUNCE_MS + 1_000);
  await tick(); await tick(); await tick();
  expect(await runsFor(athleteId)).toHaveLength(2);
});

test("recordAssertions — the choke point for what she records — requests a refresh", async () => {
  await recordAssertions({ athleteId, runId: null, mode: "form", source: "settings", corrections: [{ field: "hobbies", value: ["woodworking"] }] });
  const runs = await runsFor(athleteId);
  expect(runs).toHaveLength(1);
  expect((runs[0].input as { reason: string }).reason).toContain("hobbies");
});
