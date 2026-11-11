/**
 * refresh.test.ts — one planner-driven refresh run (design §4.4) with the providers mocked at the adapter boundary.
 *
 *   gate false ⇒ refused, zero provider calls, no run row
 *   the run row opens before the first call; every attempt goes through the reservation; the plan restricts
 *   extraction; out-of-plan claims are dropped; outcomes per domain; at-least-once reuse; abandoned rows closed;
 *   a refused reservation ends the LLM-backed domains `failed (budget)`; signals-only runs use the signals lane
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../../testUtils/pgliteDb";
import { athleteAffiliations, athletes, researchBudgetDays, researchEvidence, researchRuns } from "../../../../shared/schema";
import { refreshAthlete as refreshWith, type RefreshInput, type RefreshProviders } from "./refresh";
import { __resetResearchPolicyCache } from "./config";
import type { ExtractionEnvelope, SearchEnvelope, SignalEnvelope } from "./providers";

const AT = new Date("2026-09-15T05:20:00.000Z");
const WF = "11111111-1111-4111-8111-111111111111";
let athleteId: string;
// Injected providers (the intelligence boundary forbids provider modules here; the real bindings are in skills/researchRefresh.ts).
const gs = jest.fn(); const ex = jest.fn();
const fetchGoogleTrends = jest.fn(async (name: string, sport: string | null, fetchedAt: string): Promise<SignalEnvelope> => ({ id: "sig-trends", provider: "google_trends", fetchedAt, windowDays: 30, values: { interest_score: 12 }, raw: {}, request: { path: "trends", params: { name, sport } } }));
const fetchGdelt = jest.fn(async (name: string, fetchedAt: string): Promise<SignalEnvelope> => ({ id: "sig-gdelt", provider: "gdelt", fetchedAt, windowDays: 30, values: { article_count: 3, avg_tone: 1.5 }, items: [], raw: {}, request: { path: "gdelt", params: { name } } }));
const providers: RefreshProviders = { search: (q, o) => gs(q, o), extract: (e, h, id, o) => ex(e, h, id, o), trends: fetchGoogleTrends, gdelt: fetchGdelt };
const refreshAthlete = (i: RefreshInput) => refreshWith(i, providers);

const envelope = (id: string, queryName: string): SearchEnvelope => ({ id, provider: "gemini_grounded", model: "gemini-test", queryName, query: "q", fetchedAt: AT.toISOString(), answerText: "ESPN reported that Refresh Athlete scored twice.", chunks: [{ id: `${id}:c0`, url: "https://espn.com/story/1", domain: "espn.com", title: "ESPN", text: "ESPN reported that Refresh Athlete scored twice.", textKind: "provider_answer_segments" }], supports: [{ id: `${id}:s0`, chunkIds: [`${id}:c0`], text: "ESPN reported that Refresh Athlete scored twice." }], raw: {}, request: { path: "generateContent" }, errors: [], usage: { calls: 1 } });
/** The mocked grounded search honours the reservation contract: one reservation per attempt, no call without one. */
const searchMock = (completed = true) => async (_q: string, opts: any) => {
  const ok = await opts.reserve();
  if (!ok) return { envelope: { ...envelope(opts.envelopeId, opts.queryName), chunks: [], supports: [], errors: [{ step: "attempt-1", message: "refused", class: "budget" }] }, attempts: 0, refused: true, completed: false };
  return { envelope: completed ? envelope(opts.envelopeId, opts.queryName) : { ...envelope(opts.envelopeId, opts.queryName), chunks: [], supports: [] }, attempts: 1, refused: false, completed };
};
const extractMock = (claims: ExtractionEnvelope["claims"], domainOutcomes?: ExtractionEnvelope["domainOutcomes"]) => async (envs: SearchEnvelope[], _h: unknown, id: string, opts: any) => {
  const ok = opts?.reserve ? await opts.reserve() : true;
  const base: ExtractionEnvelope = { id, provider: "kimi_extract", model: "kimi-test", schemaVersion: "cited-claims/2", fetchedAt: AT.toISOString(), claims: [], inferences: [], raw: {}, request: { path: "chat.completions", params: { domains: opts?.domains, allowedKinds: opts?.allowedKinds } }, errors: [], parseError: null, usage: { calls: 1 } };
  if (!ok) return { ...base, errors: [{ step: "extract", message: "refused", class: "budget" }] };
  const chunkId = envs[0]?.chunks[0]?.id ?? "g0:c0";
  return { ...base, claims: claims.map((c) => ({ ...c, citation: c.citation ? { ...c.citation, chunkIds: [chunkId] } : null })), domainOutcomes };
};
const pressClaim = { kind: "press_mention" as const, claim: { outlet: "ESPN", headline: "scored twice" }, citation: { chunkIds: ["g0:c0"], quote: "ESPN reported that Refresh Athlete scored twice" }, confidence: 0.9 };
const achievementClaim = { kind: "achievement" as const, claim: { factKey: "achievement", value: { name: "All-ACC First Team", year: 2025, level: "conference" } }, citation: { chunkIds: ["g0:c0"], quote: "ESPN reported that Refresh Athlete scored twice" }, confidence: 0.8 };
const runRows = () => db.select().from(researchRuns);

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Refresh Athlete");
  await db.update(athletes).set({ status: "active", sport: "soccer", school: "Example University", auth_id: "auth-r" } as any).where(eq(athletes.id, athleteId));
  await seedConnection({ athleteId, platform: "instagram", email: "refresh_ig" });
});
afterAll(closeTestDb);
beforeEach(async () => {
  process.env.RESEARCH_REFRESH_ENABLED = "true"; process.env.RESEARCH_SUBSTRATE_WRITE = "true"; __resetResearchPolicyCache();
  gs.mockReset(); ex.mockReset(); gs.mockImplementation(searchMock()); ex.mockImplementation(extractMock([pressClaim]));
  await db.delete(researchEvidence); await db.delete(researchRuns); await db.delete(researchBudgetDays);
});
afterEach(() => { delete process.env.RESEARCH_REFRESH_ENABLED; delete process.env.RESEARCH_SUBSTRATE_WRITE; });

describe("refreshAthlete", () => {
  it("the query anchor is the projection; the extraction hints carry the ledger team", async () => {
    const env = process.env;
    try {
      await db.insert(athleteAffiliations).values({ athlete_id: athleteId, org_name: "Ledger University", org_kind: "school", level: "D1", is_primary: true, kind: "said", source: "onboarding", started_on: "2024-08-01" });
      await refreshAthlete({ athleteId, domains: ["press"], trigger: "ttl", workflowRunId: WF, asOf: AT });
      expect(String(gs.mock.calls[0][0])).toContain("Refresh Athlete Example University soccer");
      expect(ex.mock.calls[0][1]).toMatchObject({ currentAffiliation: "Ledger University", knownHandles: { instagram: "refresh_ig" } });   // hintsFor: the ledger team (#34 slip fixed)
      await db.delete(researchRuns);
    } finally { process.env = env; await db.delete(athleteAffiliations); }
  });

  it("gate false (either flag) ⇒ refused with zero provider calls and no run row", async () => {
    for (const [r, s] of [["true", "false"], ["false", "true"]]) {
      process.env.RESEARCH_REFRESH_ENABLED = r; process.env.RESEARCH_SUBSTRATE_WRITE = s;
      const out = await refreshAthlete({ athleteId, domains: ["press"], trigger: "ttl", workflowRunId: WF, asOf: AT });
      expect(out).toMatchObject({ ok: false, status: "refused", error: "execution_disabled", researchRunId: null });
    }
    expect(gs).not.toHaveBeenCalled(); expect(ex).not.toHaveBeenCalled();
    expect(await runRows()).toHaveLength(0);
  });

  it("a press refresh: run row opened with workflow link and as_of, one query + one extraction reserved, outcome refreshed, run ok", async () => {
    const out = await refreshAthlete({ athleteId, domains: ["press"], trigger: "ttl", workflowRunId: WF, asOf: AT });
    expect(out).toMatchObject({ ok: true, status: "ok", outcomes: { press: "refreshed" } });
    const [run] = await runRows();
    expect(run).toMatchObject({ workflow_run_id: WF, domain: "refresh", trigger: "ttl", llm_attempts: 2, signal_calls: 0, calls: 2, status: "ok" });
    expect(run.as_of!.toISOString()).toBe(AT.toISOString());
    expect((run.summary as any).plan.domains).toEqual(["press"]);
    expect(ex.mock.calls[0][3]).toMatchObject({ domains: ["press"], allowedKinds: ["press_mention", "media_asset"] });
    const [day] = await db.select().from(researchBudgetDays);
    expect(day.llm_attempts).toBe(2);
  });

  it("at-least-once: a second attempt for the same workflow run returns the existing successful run without calling providers; an abandoned running row is closed", async () => {
    const first = await refreshAthlete({ athleteId, domains: ["press"], trigger: "ttl", workflowRunId: WF, asOf: AT });
    gs.mockClear(); ex.mockClear();
    const again = await refreshAthlete({ athleteId, domains: ["press"], trigger: "ttl", workflowRunId: WF, asOf: AT });
    expect(again).toMatchObject({ ok: true, reused: true, researchRunId: first.researchRunId, outcomes: { press: "refreshed" } });
    expect(gs).not.toHaveBeenCalled(); expect(ex).not.toHaveBeenCalled();
    // abandoned: a running row for another workflow run is closed failed before a new attempt opens its own row
    const WF2 = "22222222-2222-4222-8222-222222222222";
    const [stale] = await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "refresh", trigger: "ttl", status: "running", workflow_run_id: WF2, started_at: new Date(AT.getTime() - 3_600_000) }).returning({ id: researchRuns.id });
    const out = await refreshAthlete({ athleteId, domains: ["press"], trigger: "ttl", workflowRunId: WF2, asOf: new Date(AT.getTime() + 60_000) });
    expect(out.ok).toBe(true);
    const [closed] = await db.select().from(researchRuns).where(eq(researchRuns.id, stale.id));
    expect(closed.status).toBe("failed"); expect((closed.error as any).reason).toBe("abandoned");
  });

  it("out-of-plan claims are dropped before any canonical write; an unplanned domain has no outcome", async () => {
    ex.mockImplementation(extractMock([pressClaim, achievementClaim]));
    const out = await refreshAthlete({ athleteId, domains: ["press"], trigger: "ttl", workflowRunId: WF, asOf: AT });
    expect(out.outcomes).toEqual({ press: "refreshed" });
    const [run] = await runRows();
    expect((run.summary as any).droppedOutOfPlan).toBe(1);
    const ev = await db.select().from(researchEvidence).where(eq(researchEvidence.run_id, run.id));
    expect(ev.every((e) => e.kind === "press_mention")).toBe(true);
  });

  it("a refused reservation (nightly cap reached) makes no provider call: the LLM-backed domain ends failed and the run is partial", async () => {
    await db.insert(researchBudgetDays).values({ day: "2026-09-15", llm_attempts: 150 });   // the default cap
    const out = await refreshAthlete({ athleteId, domains: ["press"], trigger: "ttl", workflowRunId: WF, asOf: AT });
    expect(out).toMatchObject({ ok: true, status: "partial", outcomes: { press: "failed" } });
    const [run] = await runRows();
    expect(run.llm_attempts).toBe(0);              // the extraction was attempted but its reservation was refused too: zero attempts reached a provider
    expect(ex).toHaveBeenCalledTimes(1);
    const [day] = await db.select().from(researchBudgetDays);
    expect(day.llm_attempts).toBe(150);
  });

  it("a signals-only plan uses the signals lane, never the LLM counter, and refreshes the signals domain", async () => {
    const out = await refreshAthlete({ athleteId, domains: ["signals"], trigger: "ttl", workflowRunId: WF, asOf: AT });
    expect(out).toMatchObject({ ok: true, outcomes: { signals: "refreshed" } });
    const [run] = await runRows();
    expect(run).toMatchObject({ llm_attempts: 0, signal_calls: 2, calls: 2 });
    expect(gs).not.toHaveBeenCalled(); expect(ex).not.toHaveBeenCalled();
    expect(fetchGoogleTrends).toHaveBeenCalled();
    const [day] = await db.select().from(researchBudgetDays);
    expect(day).toMatchObject({ llm_attempts: 0, signal_calls: 2 });
  });

  it("an incomplete query (empty grounded answer) leaves the domain failed even when the extractor claims none_found", async () => {
    gs.mockImplementation(searchMock(false));
    ex.mockImplementation(extractMock([], { press: { status: "none_found", reviewedChunkIds: [] } }));
    const out = await refreshAthlete({ athleteId, domains: ["press"], trigger: "ttl", workflowRunId: WF, asOf: AT });
    expect(out.outcomes).toEqual({ press: "failed" });
  });
});
