/**
 * status.db.test.ts — PR E3, readResearchStatus on a real (PGlite) Postgres (design record §6, §5.6).
 *
 *   - the reader joins athlete_research_state, identity_resolution (via readIdentityState), the active research_refresh
 *     workflow run + its steps, and running research_runs rows into the two axes
 *   - an athlete with no research state reads identity null and every domain not_requested
 *   - NO WRITES: every statement the reader issues is a SELECT, and it runs under a READ ONLY session
 *
 * No provider is reachable: nothing here imports one.
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { eq } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteResearchState, researchRuns, workflowRuns, workflowSteps } from "../../../../shared/schema";
import { RESEARCH_DOMAINS } from "./registries";
import { readResearchStatus, type ResearchStatusConfig } from "./status";

const AS_OF = new Date("2026-10-01T12:00:00.000Z");
const ago = (ms: number) => new Date(AS_OF.getTime() - ms);
const CONFIG: ResearchStatusConfig = { executionEnabled: true, binding: "direct", identityResolutionEnabled: true };

beforeAll(initTestDb);
afterAll(closeTestDb);

async function seedScenario(): Promise<string> {
  const athleteId = await seedAthlete(`Status ${Math.random()}`);
  await db.insert(athleteResearchState).values({
    athlete_id: athleteId,
    // legacy ACCOUNT signals that must never be read as identity
    research_status: "identity_resolved", identity_confidence: "1.00", identity_resolved_at: ago(86_400_000),
    domains: {
      identity: { status: "complete", lastRunId: "r0", lastResearchedAt: ago(86_400_000).toISOString(), staleAfter: new Date(AS_OF.getTime() + 86_400_000).toISOString(), outcome: "refreshed", blockingDispute: false },
      achievements: { status: "missing", lastRunId: null, lastResearchedAt: ago(86_400_000).toISOString(), staleAfter: null, outcome: "confirmed_empty", blockingDispute: false },
      brand_mentions: { status: "missing", lastRunId: null, lastResearchedAt: null, staleAfter: null, outcome: "failed", blockingDispute: false },
      narrative: { status: "missing", lastRunId: null, lastResearchedAt: null, staleAfter: null, outcome: null, blockingDispute: false },
    } as any,
    pending: [{ domain: "social_handles", trigger: "event", reason: "identity_gate", requestedAt: ago(1000).toISOString() }] as any,
    refresh_failures: { brand_mentions: { count: 1, lastOutcome: "failed", deferredUntil: null } } as any,
    identity_resolution: "ambiguous",
    identity_resolution_detail: { at: ago(5000).toISOString(), basis: "q1", researchRunId: "rr-q1", workflowRunId: null, queryId: "Q1", anchorMatch: "uncertain", confidence: 0.4, namesakes: 2, namesakeEvidenceIds: [], anchorHash: "h", reason: "uncertain", previous: null } as any,
  });
  const [run] = await db.insert(workflowRuns).values({ athlete_id: athleteId, process: "research_refresh", definition_version: 2, active_scope: "research_refresh", status: "running", input: { domains: ["press"], full: false } as any }).returning({ id: workflowRuns.id });
  await db.insert(workflowSteps).values({ run_id: run.id, step: "refresh", ordinal: 0, attempt: 1, kind: "model", status: "running", lease_until: new Date(AS_OF.getTime() + 60_000) });
  await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "refresh", trigger: "ttl", status: "running", started_at: ago(60_000), summary: { plan: { domains: ["press", "narrative"] } } as any });
  // a closed run and an abandoned running row: neither is in flight
  await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "signals", trigger: "ttl", status: "ok", started_at: ago(60_000) });
  await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "affiliations", trigger: "ttl", status: "running", started_at: ago(2 * 3600_000) });
  return athleteId;
}

describe("readResearchStatus", () => {
  test("joins the stores into two independent axes", async () => {
    const athleteId = await seedScenario();
    const r = await readResearchStatus(athleteId, { asOf: AS_OF, config: CONFIG });
    expect(r.identity).toEqual({ value: "ambiguous", basis: "q1", reason: "uncertain", confidence: 0.4, determinedAt: ago(5000).toISOString(), researchRunId: "rr-q1" });
    expect(r.domains.identity).toMatchObject({ lifecycle: "settled", outcome: "refreshed", status: "complete", producer: "available" });
    expect(r.domains.achievements).toMatchObject({ lifecycle: "settled", outcome: "confirmed_empty", status: "missing" });
    expect(r.domains.brand_mentions).toMatchObject({ lifecycle: "settled", outcome: "failed", failures: { count: 1, deferredUntil: null } });
    expect(r.domains.press).toMatchObject({ lifecycle: "running" });              // the v2 step (and the refresh row)
    expect(r.domains.narrative).toMatchObject({ lifecycle: "running" });          // the refresh row's plan
    expect(r.domains.social_handles).toMatchObject({ lifecycle: "queued", heldBy: "identity_gate" });
    expect(r.domains.affiliations).toMatchObject({ lifecycle: "not_requested" }); // abandoned row
    expect(r.domains.signals).toMatchObject({ lifecycle: "not_requested" });      // closed row
  });

  test("no research state at all: identity null (not pending), every domain not_requested; account signals never count", async () => {
    const athleteId = await seedAthlete(`Bare ${Math.random()}`);
    const r = await readResearchStatus(athleteId, { asOf: AS_OF, config: CONFIG });
    expect(r.identity.value).toBeNull();
    for (const d of RESEARCH_DOMAINS) expect(r.domains[d]).toMatchObject({ lifecycle: "not_requested", outcome: null, status: "missing" });
    await db.insert(athleteResearchState).values({ athlete_id: athleteId, research_status: "identity_resolved", identity_confidence: "1.00", identity_resolved_at: AS_OF });
    expect((await readResearchStatus(athleteId, { asOf: AS_OF, config: CONFIG })).identity.value).toBeNull();
  });

  test("a finished workflow run is not active", async () => {
    const athleteId = await seedAthlete(`Done ${Math.random()}`);
    const [run] = await db.insert(workflowRuns).values({ athlete_id: athleteId, process: "research_refresh", definition_version: 2, active_scope: "research_refresh", status: "done", input: { domains: ["press"] } as any }).returning({ id: workflowRuns.id });
    await db.insert(workflowSteps).values({ run_id: run.id, step: "refresh", ordinal: 0, attempt: 1, kind: "model", status: "ready" });
    expect((await readResearchStatus(athleteId, { asOf: AS_OF, config: CONFIG })).domains.press.lifecycle).toBe("not_requested");
  });
});

describe("no writes", () => {
  test("every statement the reader issues is a SELECT", async () => {
    const athleteId = await seedScenario();
    const q = jest.spyOn(client, "query");
    const x = jest.spyOn(client, "exec");
    try {
      await readResearchStatus(athleteId, { asOf: AS_OF, config: CONFIG });
      const statements = [...q.mock.calls, ...x.mock.calls].map((c) => String(c[0]));
      expect(statements.length).toBeGreaterThanOrEqual(5);
      for (const s of statements) expect(s.trim()).toMatch(/^select\b/i);
    } finally { q.mockRestore(); x.mockRestore(); }
  });

  test("it runs under a READ ONLY session (which does refuse a write)", async () => {
    const athleteId = await seedScenario();
    const before = await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId));
    await client.exec("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    try {
      await expect(db.update(athleteResearchState).set({ last_planned_at: AS_OF }).where(eq(athleteResearchState.athlete_id, athleteId))).rejects.toThrow(/read-only/i);
      const r = await readResearchStatus(athleteId, { asOf: AS_OF });   // the real configuration path too
      expect(r.contract).toBe("research-status/1");
    } finally {
      await client.exec("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE");
    }
    expect(await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId))).toEqual(before);
  });
});
