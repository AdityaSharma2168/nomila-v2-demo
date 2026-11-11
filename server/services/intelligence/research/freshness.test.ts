/**
 * freshness.test.ts — domain outcomes and monotonic freshness through persist (design §3.1, §3.2).
 *
 *   B. a planned domain whose queries returned only irrelevant/dropped evidence stays stale (no date change,
 *      failure counter, run partial); out-of-plan claims are dropped before any canonical write
 *   C. an explicit, trusted "searched, nothing new" (none_found with completed queries + reviewed chunks)
 *      refreshes the domain; the same assertion with a failed query does NOT
 *   D. an older run finishing after a newer one cannot regress freshness (its evidence is still persisted)
 *   + a full run keeps the Step 2a run-status rule and domain dates follow outcomes, not "touched"
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteResearchState, researchEvidence, researchRuns } from "../../../../shared/schema";
import { persistResearchRun, type PersistInput } from "./persist";
import type { ExtractionEnvelope, IdentityHints, SearchEnvelope } from "./providers";

const T0 = "2026-01-05T00:00:00.000Z", T1 = "2026-09-10T00:00:00.000Z", T2 = "2026-09-20T00:00:00.000Z";
const hintsFor = (athleteId: string): IdentityHints => ({ athleteId, fullName: "Fresh Athlete", aliases: [], sport: "soccer", currentAffiliation: null, hometown: null, knownHandles: {} });
const search = (id: string, at: string): SearchEnvelope => ({
  id, provider: "gemini_grounded", model: "gemini-test", queryName: "Performance + Press", query: "Fresh Athlete soccer", fetchedAt: at,
  answerText: "ESPN reported that Fresh Athlete scored twice. She was named All-ACC First Team in 2025.",
  chunks: [
    { id: `${id}:c0`, url: "https://espn.com/story/9", domain: "espn.com", title: "ESPN", text: "ESPN reported that Fresh Athlete scored twice.", textKind: "provider_answer_segments" },
    { id: `${id}:c1`, url: "https://espn.com/story/10", domain: "espn.com", title: "ESPN", text: "She was named All-ACC First Team in 2025.", textKind: "provider_answer_segments" },
  ],
  supports: [{ id: `${id}:s0`, chunkIds: [`${id}:c0`], text: "ESPN reported that Fresh Athlete scored twice." }, { id: `${id}:s1`, chunkIds: [`${id}:c1`], text: "She was named All-ACC First Team in 2025." }],
  raw: {}, request: { path: "generateContent" }, errors: [],
});
const extraction = (at: string, over: Partial<ExtractionEnvelope> = {}): ExtractionEnvelope => ({ id: "x0", provider: "kimi_extract", model: "kimi-test", schemaVersion: "cited-claims/2", fetchedAt: at, raw: { content: "{}" }, request: { path: "chat.completions" }, errors: [], parseError: null, claims: [], inferences: [], ...over });
const pressCited = (id: string) => ({ kind: "press_mention" as const, claim: { outlet: "ESPN", headline: "scored twice" }, citation: { chunkIds: [`${id}:c0`], quote: "ESPN reported that Fresh Athlete scored twice" }, confidence: 0.9 });
const pressUncited = (id: string) => ({ kind: "press_mention" as const, claim: { outlet: "Blog", headline: "rumour" }, citation: { chunkIds: [`${id}:c0`], quote: "this quote is not in the chunk" }, confidence: 0.5 });
const achievementCited = (id: string) => ({ kind: "achievement" as const, claim: { factKey: "achievement", value: { name: "All-ACC First Team", year: 2025, level: "conference" } }, citation: { chunkIds: [`${id}:c1`], quote: "named All-ACC First Team in 2025" }, confidence: 0.8, publishedAt: "2025-11-02" });

const base = (athleteId: string, at: string, id: string, x: ExtractionEnvelope | null, plan: PersistInput["plan"]): PersistInput => ({ athleteId, trigger: "ttl", domain: "refresh", hints: hintsFor(athleteId), search: [search(id, at)], extraction: x, signals: [], hasAssertedAffiliations: false, identityResolved: true, secrets: [], asOf: new Date(at), retrievedAt: new Date(at), plan });
const pressPlan = (completed = true): PersistInput["plan"] => ({ domains: ["press"], queryStatus: { press: { completed, chunksReviewed: 2 } } });
const stateOf = async (athleteId: string) => (await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)))[0];

beforeAll(initTestDb);
afterAll(closeTestDb);
let prevFlag: string | undefined;
beforeEach(() => { prevFlag = process.env.RESEARCH_SUBSTRATE_WRITE; process.env.RESEARCH_SUBSTRATE_WRITE = "true"; });
afterEach(() => { if (prevFlag === undefined) delete process.env.RESEARCH_SUBSTRATE_WRITE; else process.env.RESEARCH_SUBSTRATE_WRITE = prevFlag; });

/** A press domain refreshed at T0 (stale by T1: TTL 30 d). */
async function seedStalePress(athleteId: string) {
  const r = await persistResearchRun(base(athleteId, T0, "g0", extraction(T0, { claims: [pressCited("g0")] }), pressPlan()));
  expect(r!.domains.press.outcome).toBe("refreshed");
  const st = await stateOf(athleteId);
  expect((st.domains as any).press.lastResearchedAt).toBe(T0);
  return r!.runId;
}

describe("domain outcomes (§3.1)", () => {
  it("B. only irrelevant/dropped evidence leaves the domain stale; out-of-plan claims are dropped before any write", async () => {
    const athleteId = await seedAthlete("Fresh B");
    await seedStalePress(athleteId);
    const r = await persistResearchRun(base(athleteId, T1, "g1", extraction(T1, { claims: [pressUncited("g1"), achievementCited("g1")] }), pressPlan()));
    expect(r!.domains.press.outcome).toBe("no_relevant");
    expect(r!.status).toBe("partial");
    expect(r!.droppedOutOfPlan).toBe(1);
    expect(r!.domains.achievements).toBeUndefined();
    const st = await stateOf(athleteId);
    expect((st.domains as any).press).toMatchObject({ lastResearchedAt: T0, status: "stale", outcome: "no_relevant" });
    expect((st.refresh_failures as any).press.count).toBe(1);
    // the out-of-plan achievement never reached research_evidence
    const ev = await db.select().from(researchEvidence).where(eq(researchEvidence.run_id, r!.runId));
    expect(ev.every((e) => e.kind === "press_mention")).toBe(true);
  });

  it("C. an explicit, trusted 'searched, nothing new' refreshes the domain; with a failed query it does not", async () => {
    const athleteId = await seedAthlete("Fresh C");
    await seedStalePress(athleteId);
    const r = await persistResearchRun(base(athleteId, T1, "g1", extraction(T1, { claims: [], domainOutcomes: { press: { status: "none_found", reviewedChunkIds: ["g1:c0", "g1:c1"] } } }), pressPlan()));
    expect(r!.domains.press.outcome).toBe("confirmed_empty");
    expect(r!.status).toBe("ok");
    let st = await stateOf(athleteId);
    expect((st.domains as any).press).toMatchObject({ lastResearchedAt: T1, status: "complete", lastRunId: r!.runId });
    expect((st.refresh_failures as any).press).toBeUndefined();
    // negative twin: none_found on a domain whose query did not complete ⇒ failed, no date change
    const r2 = await persistResearchRun(base(athleteId, T2, "g2", extraction(T2, { claims: [], domainOutcomes: { press: { status: "none_found", reviewedChunkIds: ["g2:c0"] } } }), pressPlan(false)));
    expect(r2!.domains.press.outcome).toBe("failed");
    st = await stateOf(athleteId);
    expect((st.domains as any).press.lastResearchedAt).toBe(T1);
    expect((st.refresh_failures as any).press.count).toBe(1);
  });

  it("consecutive non-successful attempts defer the domain after maxConsecutiveFailures", async () => {
    const athleteId = await seedAthlete("Fresh Defer");
    await seedStalePress(athleteId);
    for (const [n, at] of ["2026-09-11T00:00:00.000Z", "2026-09-12T00:00:00.000Z", "2026-09-13T00:00:00.000Z"].entries()) {
      await persistResearchRun(base(athleteId, at, `g${n + 1}`, extraction(at, { claims: [pressUncited(`g${n + 1}`)] }), pressPlan()));
    }
    const st = await stateOf(athleteId);
    expect((st.refresh_failures as any).press.count).toBe(3);
    expect((st.refresh_failures as any).press.deferredUntil).toBe(new Date(new Date("2026-09-13T00:00:00.000Z").getTime() + 7 * 86_400_000).toISOString());
  });
});

describe("fact-bearing domains (review of PR #400)", () => {
  it("cited, non-suspect, domain-relevant evidence with zero accepted/re-confirmed facts stays no_relevant and does not advance freshness", async () => {
    const athleteId = await seedAthlete("Fresh FactBearing");
    // profile is fact-bearing. The position claim is cited and not suspect (evidence accepted), but the athlete's
    // own assertion overrides it, so the resolver accepts / re-confirms NO fact from this run.
    const positionClaim = { kind: "profile_attribute" as const, claim: { factKey: "position", value: { text: "Forward" } }, citation: { chunkIds: ["g1:c0"], quote: "ESPN reported that Fresh Athlete scored twice" }, confidence: 0.9 };
    const plan: PersistInput["plan"] = { domains: ["affiliations", "profile"], queryStatus: { profile: { completed: true, chunksReviewed: 2 }, affiliations: { completed: true, chunksReviewed: 2 } } };
    const r = await persistResearchRun({ ...base(athleteId, T1, "g1", extraction(T1, { claims: [positionClaim] }), plan), assertions: [{ factKey: "position", value: { text: "Midfielder" }, assertedId: "00000000-0000-4000-8000-000000000321", kind: "asserted", at: T0 }] });
    expect(r!.domains.profile.accepted).toMatchObject({ evidence: 1, factBearing: 1, facts: 0 });
    expect(r!.domains.profile.outcome).toBe("no_relevant");
    expect(r!.status).toBe("partial");
    const st = await stateOf(athleteId);
    expect((st.domains as any).profile.lastResearchedAt).toBeNull();
    expect((st.domains as any).profile.lastRunId).toBeNull();
    expect((st.refresh_failures as any).profile.count).toBe(1);
    // the evidence row itself is still persisted (cited, accepted) — it just does not make the domain fresh
    const ev = await db.select().from(researchEvidence).where(eq(researchEvidence.run_id, r!.runId));
    expect(ev.filter((e) => (e.claim as any).factKey === "position" && e.lineage_status === "cited" && !e.suspect)).toHaveLength(1);
  });
});

describe("monotonic freshness (§3.2)", () => {
  it("D. an older run finishing after a newer one cannot regress lastResearchedAt, lastRunId, staleAfter or status; its evidence is still persisted", async () => {
    const athleteId = await seedAthlete("Fresh D");
    const newer = await persistResearchRun(base(athleteId, T2, "g2", extraction(T2, { claims: [pressCited("g2")] }), pressPlan()));
    expect(newer!.domains.press.outcome).toBe("refreshed");
    const before = await stateOf(athleteId);
    const older = await persistResearchRun(base(athleteId, T1, "g1", extraction(T1, { claims: [pressCited("g1")] }), pressPlan()));
    expect(older!.domains.press.outcome).toBe("refreshed");
    expect(older!.domains.press.freshnessSkipped).toBe("older_than_current");
    const after = await stateOf(athleteId);
    expect((after.domains as any).press).toMatchObject({ lastResearchedAt: T2, lastRunId: newer!.runId, staleAfter: (before.domains as any).press.staleAfter, status: "complete" });
    expect(after.research_status).toBe(before.research_status);
    expect(after.last_researched_at!.toISOString()).toBe(T2);
    const olderEvidence = await db.select().from(researchEvidence).where(eq(researchEvidence.run_id, older!.runId));
    expect(olderEvidence.length).toBeGreaterThan(0);
    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, older!.runId));
    expect((run.summary as any).domains.press.freshnessSkipped).toBe("older_than_current");
    expect(run.as_of!.toISOString()).toBe(T1);
  });
});

describe("full runs (no explicit plan)", () => {
  it("domain dates follow outcomes: a full run with press and achievement evidence refreshes those domains only; the run status keeps the Step 2a rule", async () => {
    const athleteId = await seedAthlete("Fresh Full");
    const r = await persistResearchRun({ ...base(athleteId, T1, "g0", extraction(T1, { claims: [pressCited("g0"), achievementCited("g0")], inferences: [{ key: "story_arc", value: "A striker on the rise.", citation: null }] }), undefined), trigger: "dual_write", domain: "full" });
    expect(r!.status).toBe("ok");   // no sub-calls, nothing conflicting or suspect: not demoted by no_relevant domains
    expect(r!.domains.press.outcome).toBe("refreshed");
    expect(r!.domains.achievements.outcome).toBe("refreshed");
    expect(r!.domains.narrative.outcome).toBe("refreshed");
    expect(r!.domains.brand_mentions.outcome).toBe("no_relevant");
    const st = await stateOf(athleteId);
    expect((st.domains as any).press.lastResearchedAt).toBe(T1);
    expect((st.domains as any).brand_mentions.lastResearchedAt).toBeNull();
    expect((st.domains as any).brand_mentions.status).toBe("missing");
  });
});
