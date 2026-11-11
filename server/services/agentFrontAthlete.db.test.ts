/**
 * agentFrontAthlete.db.test.ts — the legacy intelligence switch-off (12 Oct 2026) on a real (PGlite) Postgres.
 *
 * An AGENT-FRONT athlete (athletes.agent_onboarding_required) is researched, scored and known by the new agent, so the
 * legacy machinery stays out for her — and ONLY for her: an older athlete keeps every existing trigger.
 *   lifecycle research + anchor re-entry · event refresh requests · the nightly planner roster
 *   the identity-resolved M.I.A. request (before she has memory) · new My Story runs
 * No provider is reached: lifecycle research and the workflow runner are stubbed at their module boundary.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const startLifecycleResearch = jest.fn(async () => ({ started: true }));
jest.mock("./intelligence/research/lifecycle", () => ({ startLifecycleResearch, reenterIdentityResolution: jest.fn(async () => ({})) }));
const startRun = jest.fn(async () => ({ run: { id: "run-1" }, created: true }));
jest.mock("../workflow/runner", () => ({ ...jest.requireActual("../workflow/runner"), startRun }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athleteResearchState, memoryFacts } from "../../shared/schema";
import { isAgentFrontAthlete } from "./agentFrontAthlete";
import { anchorFieldsBefore, enterLifecycleResearch } from "./intelligence/research/lifecycleHooks";
import { requestRefresh } from "./intelligence/research/triggers";
import { loadPlannerInput } from "./intelligence/research/planner";
import { requestIdentityRefresh } from "./intelligence/identityIntelligence/refresh";
import { evaluationOwed } from "./marketabilityBeta1Orchestrator";

const FLAGS = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct", IDENTITY_INTELLIGENCE_ENABLED: "true" };
let agentId: string; let olderId: string;

beforeAll(async () => {
  await initTestDb();
  agentId = await seedAthlete("Agent Front Athlete", { sport: "Soccer", status: "raw", agent_onboarding_required: true } as any);
  olderId = await seedAthlete("Older Athlete", { sport: "Soccer", status: "raw" } as any);
});
afterAll(closeTestDb);
beforeEach(() => { Object.assign(process.env, FLAGS); startLifecycleResearch.mockClear(); startRun.mockClear(); });
afterEach(() => { for (const k of Object.keys(FLAGS)) delete process.env[k]; });

describe("isAgentFrontAthlete", () => {
  it("true for an agent-front athlete; false for an older athlete and for a missing row", async () => {
    expect(await isAgentFrontAthlete(agentId)).toBe(true);
    expect(await isAgentFrontAthlete(olderId)).toBe(false);
    expect(await isAgentFrontAthlete("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

describe("legacy research skips the agent-front athlete only", () => {
  it("lifecycle entry: no legacy research for her; the older athlete's still starts", async () => {
    await enterLifecycleResearch(agentId, "signup");
    expect(startLifecycleResearch).not.toHaveBeenCalled();
    await enterLifecycleResearch(olderId, "signup");
    expect(startLifecycleResearch).toHaveBeenCalledWith(olderId, "signup");
  });

  it("anchor edits: no snapshot for her (so no re-entry); the older athlete's anchor is read", async () => {
    expect(await anchorFieldsBefore(agentId)).toBeNull();
    expect(await anchorFieldsBefore(olderId)).toEqual({ fullName: "Older Athlete", sport: "Soccer" });
  });

  it("event refresh (connect, admin): nothing queued for her, no state row; the older athlete's is queued", async () => {
    expect(await requestRefresh(agentId, ["identity"], "event", "connect:instagram")).toBeNull();
    expect(await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, agentId))).toHaveLength(0);
    expect(await requestRefresh(olderId, ["identity"], "event", "connect:instagram")).toEqual({ queued: 1 });
  });

  it("the nightly planner roster leaves her out; a named run (admin / script) still reads her", async () => {
    const night = await loadPlannerInput(new Date());
    const ids = night.rows.map((r) => r.athleteId);
    expect(ids).toContain(olderId);
    expect(ids).not.toContain(agentId);
    expect((await loadPlannerInput(new Date(), agentId)).rows.map((r) => r.athleteId)).toEqual([agentId]);
  });
});

describe("no new My Story run for her", () => {
  it("requestIdentityRefresh: null and no run for her; the older athlete's run is asked for", async () => {
    expect(await requestIdentityRefresh(agentId, "research refreshed")).toBeNull();
    expect(startRun).not.toHaveBeenCalled();
    expect(await requestIdentityRefresh(olderId, "research refreshed")).toEqual({ runId: "run-1", created: true });
    expect(startRun).toHaveBeenCalledTimes(1);
  });
});

describe("M.I.A.: no identity-resolved evaluation for her before she has memory", () => {
  it("evaluationOwed answers agent_path for her with no memory; once she has memory the ordinary rules apply again", async () => {
    await expect(evaluationOwed(agentId)).resolves.toEqual({ owed: false, why: "agent_path" });
    await db.insert(memoryFacts).values({ athlete_id: agentId, subject_kind: "athlete", subject_name: "Agent Front Athlete", claim: "The athlete's sport is Soccer.", type: "said", source_ref: "onboarding/test#sport", source_title: "You told us", confidence: 1 });
    const owed = await evaluationOwed(agentId);
    expect(owed.why).not.toBe("agent_path");
  });

  it("the older athlete is never answered agent_path", async () => {
    expect((await evaluationOwed(olderId)).why).not.toBe("agent_path");
  });
});
