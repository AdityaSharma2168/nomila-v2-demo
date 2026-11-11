/**
 * v3Stage.test.ts — PR E2a: the research_refresh v3 provider stage's pure parts and its calibration loop (the CLI on the
 * same stage, governIdentity false; design record §5.3, D9), against PGlite with an INJECTED fake provider (no provider
 * module is imported here; nothing reaches a network).
 *
 *   - plan resolution, acceptance / settle sets (profile = Q1 + Q6; Q1's national-team fact lands in achievements)
 *   - Q5 post-filter (D12): exact, normalized platform match; only the connected-platform items
 *   - calibration: gate before spend (RESEARCH_SUBSTRATE_WRITE), request guard, minor activation from a cited birth year,
 *     one row per query, the gate OBSERVED (wouldGate) — Q2–Q6 still run, NOTHING written to the determination or pending
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }), logger: { info() {}, warn() {}, error() {}, debug() {} } }));

import { eq, sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteResearchState, researchRuns } from "../../../../shared/schema";
import type { DirectCallOpts, DirectCallResult } from "../../../lib/research/providers/geminiDirect";
import { planV3, v3AcceptanceDomains, v3SettleDomains } from "./plans";
import { MINOR_REQUEST_LINE, type QueryId, type SectionId } from "./spec/researchSpecV1";
import type { Finding } from "./spec/directEvidenceV2";
import { assertDirectRequestClean, citedBirthYearEstablishesMinor, filterConnectedQ5, normalizePlatform, resolveV3Plan, runV3Calibration } from "./v3Stage";

const ASOF = new Date("2026-10-01T00:00:00.000Z");
const URL0 = "https://example.edu/roster/jane-doe";
const finding = (section: SectionId, item: string, value: Record<string, unknown>, statement = "s", level: Finding["lineage"]["level"] = "native_supported", env = "d0"): Finding =>
  ({ section, item, value, statement, asOf: null, sources: [{ url: URL0, title: null, publishedAt: null, quote: statement }], lineage: { level, match: "index_support", boundChunkIds: [`${env}:c0`], boundSources: [], detail: null, bindingMethod: level === "native_supported" ? "quote_exact" : "none" } });

describe("plan, acceptance and settle (pure)", () => {
  test("planV3 never adds the profile ↔ affiliations companion (D11); resolveV3Plan defaults", () => {
    expect(planV3(["affiliations"])).toEqual({ domains: ["affiliations"], queries: ["Q1"], signals: false });
    expect(planV3(["profile"])).toEqual({ domains: ["profile"], queries: ["Q1", "Q6"], signals: false });
    expect(resolveV3Plan({})).toMatchObject({ queries: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"], signals: true, governIdentity: false, trigger: "manual" });
    expect(resolveV3Plan({}).domains).toHaveLength(9);
    expect(resolveV3Plan({ queries: ["Q2"] })).toMatchObject({ queries: ["Q2"], signals: false, domains: ["achievements"] });
    expect(() => resolveV3Plan({ trigger: "nightly" as any })).toThrow(/unknown trigger/);
  });

  test("acceptance = every domain the query's items land in (incl. registry fact-key domains); settle = all covering queries ran", () => {
    expect(v3AcceptanceDomains("Q1")).toEqual(["identity", "profile", "affiliations", "achievements"]);   // national_team_participation → achievements
    expect(v3AcceptanceDomains("Q6")).toEqual(["profile", "press"]);
    const all = resolveV3Plan({}).domains;
    expect(v3SettleDomains("Q1", all, new Set<QueryId>(["Q1"]))).toEqual(["identity", "affiliations"]);   // profile waits for Q6
    expect(v3SettleDomains("Q3", all, new Set<QueryId>(["Q1", "Q3"]))).toEqual(["narrative"]);            // press waits for Q6
    expect(v3SettleDomains("Q6", all, new Set<QueryId>(["Q1", "Q3", "Q6"]))).toEqual(["profile", "press"]);
    expect(v3SettleDomains("Q6", all, new Set<QueryId>(["Q6"]))).toEqual([]);                             // Q1/Q3 never ran (held / not planned)
    expect(v3SettleDomains("Q1", ["identity"], new Set<QueryId>(["Q1"]))).toEqual(["identity"]);          // only planned domains settle
  });
});

describe("Q5 post-filter (pure)", () => {
  test("drops only official account / verification / follower findings of a connected platform, exact after normalization", () => {
    const fs = [
      finding("S8", "official_accounts", { platform: "Instagram", handle: "jd" }),
      finding("S8", "verification_status", { platform: "instagram", verified: true }),
      finding("S8", "follower_counts_as_stated", { platform: "X (Twitter)", value: "10K" }),
      finding("S8", "official_accounts", { platform: "TikTok", handle: "jd" }),
      finding("S8", "official_website", { url: "https://janedoe.com" }),
      finding("S8", "content_formats", { platform: "Instagram", description: "reels" }),
      finding("S8", "official_accounts", { platform: "Insta", handle: "jd" }),   // no fuzzy match
    ];
    const { kept, dropped } = filterConnectedQ5(fs, new Set(["instagram", "x"]));
    expect(dropped).toEqual({ instagram: 2, x: 1 });
    expect(kept.map((f) => `${f.item}:${f.value.platform ?? "-"}`)).toEqual(["official_accounts:TikTok", "official_website:-", "content_formats:Instagram", "official_accounts:Insta"]);
    expect(normalizePlatform("Twitter")).toBe("x");
    expect(normalizePlatform("You Tube")).toBe("youtube");
    expect(normalizePlatform(null)).toBeNull();
  });
});

// ── the calibration loop on the stage ─────────────────────────────────────────
const HYBRID = (env: string, fs: Finding[], anchor: "matched" | "uncertain" | "not_resolved" | null = "matched", namesakes = 0): DirectCallResult => {
  const items: Record<string, { status: "found"; reason: null; findings: Finding[] }> = {};
  for (const f of fs) (items[f.item] ??= { status: "found", reason: null, findings: [] }).findings.push({ ...f, lineage: { ...f.lineage, boundChunkIds: [`${env}:c0`] } });
  return {
    envelope: { id: env, provider: "gemini_direct", model: "gemini-test", queryName: "q", query: "(fake)", fetchedAt: ASOF.toISOString(), answerText: "", chunks: [{ id: `${env}:c0`, url: URL0, domain: "example.edu", title: "Roster", text: fs.map((f) => f.statement).join(" "), textKind: "provider_answer_segments" }], supports: [], raw: null, request: {}, usage: { calls: 1 }, errors: [] },
    parsed: null, parsedV2: { items, identity: { anchorMatch: anchor, confidence: 0.8, namesakes: Array.from({ length: namesakes }, () => ({ description: "another", sourceUrl: null })) }, parseError: null, unknownItems: [] },
    prose: "", markerFound: true, attempts: 1, refused: false, completed: true, nativeSources: 1, searchQueries: 1,
  };
};
const subject = { fullName: "Jane Doe", sport: "soccer", anchor: "soccer athlete, Example University", isMinor: false };

let athleteId: string;
let prev: string | undefined;
beforeAll(initTestDb);
afterAll(closeTestDb);
beforeEach(async () => {
  prev = process.env.RESEARCH_SUBSTRATE_WRITE; process.env.RESEARCH_SUBSTRATE_WRITE = "true";
  for (const k of ["RESEARCH_REFRESH_ENABLED", "RESEARCH_REFRESH_PROVIDER"]) delete process.env[k];
  athleteId = await seedAthlete(`Jane Doe ${Math.random().toString(36).slice(2, 8)}`);
});
afterEach(() => { if (prev === undefined) delete process.env.RESEARCH_SUBSTRATE_WRITE; else process.env.RESEARCH_SUBSTRATE_WRITE = prev; });
const runCount = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(researchRuns))[0].n);

describe("runV3Calibration — the calibration CLI on the v3 stage (governIdentity false)", () => {
  test("the gate is OBSERVED: an ambiguous Q1 still lets Q2–Q6 run; nothing is written to the determination or pending", async () => {
    await db.insert(athleteResearchState).values({ athlete_id: athleteId });
    const seen: string[] = [];
    const call = async (request: string, opts: DirectCallOpts) => { seen.push(opts.query!.id); if (!(await opts.reserve())) throw new Error("unexpected refusal"); return HYBRID(opts.envelopeId, opts.query!.id === "Q1" ? [finding("S1", "full_name", { full: "Jane Doe" }, "Her name is Jane Doe.")] : [], opts.query!.id === "Q1" ? "uncertain" : "matched"); };
    const r = await runV3Calibration({ athleteId, subject, asOf: ASOF }, { direct: call });
    expect(seen).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
    expect(r.wouldGate).toBe(true);
    expect(r.runIds).toHaveLength(6);
    const rows = await db.select().from(researchRuns).where(eq(researchRuns.athlete_id, athleteId));
    expect(rows.map((x) => x.query_id).sort()).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
    expect(rows.every((x) => x.workflow_run_id === null && x.status !== "running")).toBe(true);
    const [s] = await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId));
    expect(s.identity_resolution).toBeNull();
    expect(s.identity_resolution_detail).toBeNull();
    expect(s.pending).toEqual([]);
    expect(r.outputs[1].gate).toEqual({ enforced: false, value: null, wouldGate: true });
    expect(r.outputs[0].identity!.applied).toEqual({ written: false, reason: "observed" });
  });

  test("per-invocation per-run cap: one calibration invocation shares maxCallsPerRun across its query rows; the next invocation starts fresh", async () => {
    // Every query wants 3 attempts. Cap 5 for this process (plannerOverride, as the CLI's --run-cap): Q1 3 + Q2 2 → refused, loop stops.
    let reached = 0;
    const call = async (_request: string, opts: DirectCallOpts) => {
      let attempts = 0, refused = false;
      for (let n = 0; n < 3; n++) { if (!(await opts.reserve())) { refused = true; break; } attempts++; reached++; }
      const r = HYBRID(opts.envelopeId, opts.query!.id === "Q1" ? [finding("S1", "full_name", { full: "Jane Doe" }, "Her name is Jane Doe.")] : []);
      return refused ? { ...r, attempts, refused, completed: false, parsedV2: null, markerFound: false, envelope: { ...r.envelope, errors: [{ step: `attempt-${attempts + 1}`, message: "LLM budget reservation refused — no call made", class: "budget" }] } } : { ...r, attempts };
    };
    const big = { maxLlmCallsPerNight: 100_000, maxCallsPerRun: 5 };
    const r1 = await runV3Calibration({ athleteId, subject, asOf: ASOF, plannerOverride: big }, { direct: call });
    expect(reached).toBe(5);                                    // 3 + 2 across TWO rows, never 3 + 3
    expect(r1.queries.map((q) => [q.id, q.attempts, q.refused])).toEqual([["Q1", 3, false], ["Q2", 2, true]]);
    const rows1 = await db.select().from(researchRuns).where(eq(researchRuns.athlete_id, athleteId));
    expect(rows1.reduce((n, x) => n + x.llm_attempts, 0)).toBe(5);
    // a second invocation is a new run: its own budget, unaffected by the first invocation's rows
    reached = 0;
    const r2 = await runV3Calibration({ athleteId, subject, asOf: ASOF, plannerOverride: big, queryIds: ["Q1"] }, { direct: call });
    expect(reached).toBe(3);
    expect(r2.queries).toEqual([expect.objectContaining({ id: "Q1", attempts: 3, refused: false })]);
  });

  test("gate before spend: without RESEARCH_SUBSTRATE_WRITE no row is opened and no provider is called", async () => {
    delete process.env.RESEARCH_SUBSTRATE_WRITE;
    let calls = 0;
    const before = await runCount();
    const r = await runV3Calibration({ athleteId, subject, asOf: ASOF }, { direct: async () => { calls++; throw new Error("never"); } });
    expect(calls).toBe(0);
    expect(await runCount()).toBe(before);
    expect(r).toMatchObject({ status: "refused", runIds: [] });
    expect(r.error).toMatch(/RESEARCH_SUBSTRATE_WRITE/);
  });

  test("the request guard aborts before any row or call; the minor policy activates only from a cited birth year and reaches later requests", async () => {
    expect(() => assertDirectRequestClean("please research the cohort")).toThrow(/forbidden word/);
    const before = await runCount();
    let calls = 0;
    const bad = await runV3Calibration({ athleteId, subject: { ...subject, anchor: "holdout cohort athlete" }, asOf: ASOF }, { direct: async () => { calls++; throw new Error("never"); } });
    expect(bad).toMatchObject({ status: "failed", error: expect.stringMatching(/forbidden word/) });
    expect(calls).toBe(0);
    expect(await runCount()).toBe(before);

    expect(citedBirthYearEstablishesMinor([finding("S1", "birth_year", { year: "2010" })], ASOF)).toBe(true);
    expect(citedBirthYearEstablishesMinor([finding("S1", "birth_year", { year: "2010" }, "s", "asserted_only")], ASOF)).toBe(false);
    const requests: Record<string, string> = {};
    const call = async (request: string, opts: DirectCallOpts) => { requests[opts.query!.id] = request; await opts.reserve(); return HYBRID(opts.envelopeId, opts.query!.id === "Q1" ? [finding("S1", "full_name", { full: "Jane Doe" }, "Her name is Jane Doe."), finding("S1", "birth_year", { year: "2010" }, "Jane Doe was born in 2010.")] : []); };
    const r = await runV3Calibration({ athleteId, subject, asOf: ASOF, queryIds: ["Q1", "Q6"] }, { direct: call });
    expect(r.minorActivated).toBe(true);
    expect(requests.Q1).not.toContain(MINOR_REQUEST_LINE);
    expect(requests.Q6).toContain(MINOR_REQUEST_LINE);
  });
});
