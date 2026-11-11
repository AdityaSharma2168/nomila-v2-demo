/**
 * reprocessLineage.test.ts — the dev-only lineage recovery tool against PGlite: an asserted_only claim whose
 * STATEMENT (not quote) is verbatim in a grounding-supported span rebinds to native_supported (statement_exact,
 * spec/directLineage.ts slice E) with no provider call; a claim already native_supported rebinds to the same
 * binding (quote_exact) so its old evidence row is recognised as the same finding and superseded; the context
 * builder (context/build.ts) stops surfacing the superseded row; athlete_facts settle to exactly one current row.
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }), logger: { info() {}, warn() {}, error() {}, debug() {} } }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteFacts, researchEvidence, researchRuns } from "../../../../shared/schema";
import { buildCanonicalContext } from "../context/build";
import { bindGeminiFinding, type GroundingChunkLike, type GroundingSupportLike } from "./spec/directLineage";
import { persistResearchRun } from "./persist";
import { reprocessAthleteLineage } from "./reprocessLineage";
import type { ExtractionEnvelope, SearchEnvelope } from "./providers";

let athleteId: string;
const AT = "2026-09-11T00:00:00.000Z";
const AT2 = "2026-09-13T00:00:00.000Z";
const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";

// One press statement (quote-bindable from the start) and one hometown statement (only its STATEMENT, never its
// quote, is verbatim in the prose — the bug this tool recovers from).
const S_PRESS = "ESPN reported that Test Athlete signed a deal with Acme Co.";
const S_HOMETOWN = "Test Athlete is from Springfield.";
const ANSWER = `${S_PRESS} ${S_HOMETOWN}`;
const rawGroundingChunks: GroundingChunkLike[] = [{ web: { uri: REDIRECT, title: "example.com", domain: "example.com" } }];
const rawGroundingSupports: GroundingSupportLike[] = [{ segment: { startIndex: 0, endIndex: ANSWER.length, text: ANSWER }, groundingChunkIndices: [0] }];

function directSearchEnvelope(): SearchEnvelope {
  return {
    id: "d0", provider: "gemini_direct", model: "gemini-test", queryName: "Identity + Press + Brands", query: "Test Athlete soccer", fetchedAt: AT,
    answerText: ANSWER,
    chunks: [{ id: "d0:c0", url: REDIRECT, domain: "example.com", title: "example.com", text: ANSWER, textKind: "provider_answer_segments" }],
    supports: [{ id: "d0:s0", chunkIds: ["d0:c0"], text: ANSWER }],
    raw: { text: ANSWER, groundingChunks: rawGroundingChunks, groundingSupports: rawGroundingSupports, webSearchQueries: ["x"], finishReason: "STOP" },
    request: { path: "generateContent", params: { contract: "v2" } }, errors: [],
  };
}

beforeAll(async () => { await initTestDb(); athleteId = await seedAthlete("Test Athlete"); });
afterAll(closeTestDb);
let prev: string | undefined;
beforeEach(() => { prev = process.env.RESEARCH_SUBSTRATE_WRITE; process.env.RESEARCH_SUBSTRATE_WRITE = "true"; });
afterEach(() => { if (prev === undefined) delete process.env.RESEARCH_SUBSTRATE_WRITE; else process.env.RESEARCH_SUBSTRATE_WRITE = prev; });

describe("reprocessAthleteLineage", () => {
  it("re-binds an asserted_only claim via statement_exact, keeps an already-bound claim's binding, supersedes the old evidence, and settles facts to one current row", async () => {
    // The press claim binds correctly from the start (quote_exact) — real bindGeminiFinding output, not hand-rolled,
    // so reprocessing's re-bind of an ALREADY native_supported claim can be checked against the same computation.
    const pressLineage = bindGeminiFinding({ quote: S_PRESS, statement: null }, ANSWER, rawGroundingSupports, rawGroundingChunks, "d0");
    expect(pressLineage.level).toBe("native_supported");

    const pressClaim = {
      kind: "press_mention", section: "S5", item: "national_coverage",
      claim: { outlet: "ESPN", headline: "Test Athlete signs with Acme", outletContext: "national", topic: "coverage" },
      citation: { chunkIds: pressLineage.boundChunkIds, quote: S_PRESS },
      sources: [{ url: REDIRECT, title: null, publishedAt: null, quote: S_PRESS }],
      lineage: pressLineage, statement: S_PRESS, confidence: 0.8, publishedAt: null,
    };
    // The hometown claim is the bug being recovered from: its STATEMENT is verbatim in a supported span, but the
    // stored quote is not — the old (quote-only) binder left it asserted_only.
    const hometownClaim = {
      kind: "profile_attribute", section: "S1", item: "hometown",
      claim: { factKey: "hometown", value: { city: "Springfield" } },
      citation: null,
      sources: [{ url: REDIRECT, title: null, publishedAt: null, quote: "a quote that never appears in the prose" }],
      lineage: { level: "asserted_only", match: "none", boundChunkIds: [], boundSources: [], detail: "quote not found verbatim in the factual prose", bindingMethod: "none" },
      statement: S_HOMETOWN, confidence: 0.8, publishedAt: null,
    };

    const extraction: ExtractionEnvelope = {
      id: "d-map", provider: "gemini_direct", model: "gemini-test", schemaVersion: "direct-evidence/2", fetchedAt: AT,
      claims: [pressClaim, hometownClaim] as any, inferences: [], raw: { version: "direct-research/1" }, request: { path: "reprocess" }, errors: [], parseError: null,
    };
    const r1 = await persistResearchRun({
      athleteId, trigger: "manual", domain: "full", hints: { athleteId, fullName: "Test Athlete", aliases: [], sport: "soccer", currentAffiliation: null, hometown: null, knownHandles: {} },
      search: [directSearchEnvelope()], extraction, signals: [], hasAssertedAffiliations: false, identityResolved: true, identityConfidence: 1, secrets: [], asOf: new Date(AT),
    });
    expect(r1).not.toBeNull();
    const [run1] = await db.select().from(researchRuns).where(eq(researchRuns.id, r1!.runId));
    expect(((run1.providers as any)[0])).toMatchObject({ provider: "gemini_direct" });   // eligibility precondition

    const oldEvidence = await db.select().from(researchEvidence).where(eq(researchEvidence.run_id, r1!.runId));
    const oldPress = oldEvidence.find((e) => e.kind === "press_mention")!;
    const oldHometown = oldEvidence.find((e) => e.kind === "profile_attribute")!;
    expect(oldPress.lineage_status).toBe("native_supported");
    expect(oldHometown.lineage_status).toBe("asserted_only");

    // ── reprocess: no provider call, no network — pure re-derivation over the rows already in Postgres ──
    const result = await reprocessAthleteLineage(athleteId, { asOf: new Date(AT2) });
    expect(result.status).toBe("reprocessed");
    expect(result.oldRunId).toBe(r1!.runId);
    expect(result.newRunId).toBeTruthy();
    expect(result.before).toMatchObject({ native_supported: 1, asserted_only: 1 });
    expect(result.after).toMatchObject({ native_supported: 2, asserted_only: 0 });
    expect(result.bindingMethodHistogram.statement_exact).toBe(1);
    expect(result.bindingMethodHistogram.quote_exact).toBe(1);
    expect(result.supersededCount).toBe(2);
    expect(result.unmatchedCount).toBe(0);

    // the new run: a backfill run over the full domain, referencing the source run
    const [newRun] = await db.select().from(researchRuns).where(eq(researchRuns.id, result.newRunId!));
    expect(newRun).toMatchObject({ trigger: "backfill", domain: "full" });
    expect(["ok", "partial"]).toContain(newRun.status);
    expect((newRun.summary as any)?.reprocess ?? (newRun as any).summary).toBeTruthy();

    // new evidence: the hometown claim is now native_supported via statement_exact
    const newEvidence = await db.select().from(researchEvidence).where(eq(researchEvidence.run_id, result.newRunId!));
    const newHometown = newEvidence.find((e) => e.kind === "profile_attribute")!;
    const newPress = newEvidence.find((e) => e.kind === "press_mention")!;
    expect(newHometown).toMatchObject({ lineage_status: "native_supported" });
    expect((newHometown.support as any).bindingMethod).toBe("statement_exact");
    expect(newPress).toMatchObject({ lineage_status: "native_supported" });
    expect((newPress.support as any).bindingMethod).toBe("quote_exact");

    // old evidence rows are superseded by their matching new rows (same kind + same claim content)
    const [refreshedOldHometown] = await db.select().from(researchEvidence).where(eq(researchEvidence.id, oldHometown.id));
    const [refreshedOldPress] = await db.select().from(researchEvidence).where(eq(researchEvidence.id, oldPress.id));
    expect(refreshedOldHometown.superseded_by).toBe(newHometown.id);
    expect(refreshedOldPress.superseded_by).toBe(newPress.id);

    // athlete_facts: hometown settles to exactly one CURRENT row (the old asserted_only attempt stayed disputed)
    const hometownFacts = await db.select().from(athleteFacts).where(eq(athleteFacts.athlete_id, athleteId));
    const hometown = hometownFacts.filter((f) => f.fact_key === "hometown");
    expect(hometown.filter((f) => f.status === "current")).toHaveLength(1);
    expect(hometown.find((f) => f.status === "current")).toMatchObject({ value: { city: "Springfield" } });

    // the context builder no longer surfaces the superseded press evidence row — only the new one
    const built = await buildCanonicalContext(athleteId, { asOf: new Date(AT2) });
    expect(built).not.toBeNull();
    const pressEvidenceIds = built!.ctx.press.map((p) => p.evidenceId);
    expect(pressEvidenceIds).toEqual([newPress.id]);
    expect(pressEvidenceIds).not.toContain(oldPress.id);
  });

  it("skips an athlete with no gemini_direct run, and refuses to write when RESEARCH_SUBSTRATE_WRITE is not true", async () => {
    const other = await seedAthlete("Nobody Researched");
    const skip = await reprocessAthleteLineage(other, {});
    expect(skip.status).toBe("skipped");

    // A fresh athlete with an eligible (non-backfill, ok) gemini_direct run, so the write-gate check is what refuses it.
    const gated = await seedAthlete("Gate Check");
    const gatedExtraction: ExtractionEnvelope = { id: "d-map", provider: "gemini_direct", model: "gemini-test", schemaVersion: "direct-evidence/2", fetchedAt: AT, claims: [], inferences: [], raw: {}, request: { path: "generateContent" }, errors: [], parseError: null };
    const gr = await persistResearchRun({
      athleteId: gated, trigger: "manual", domain: "full", hints: { athleteId: gated, fullName: "Gate Check", aliases: [], sport: "soccer", currentAffiliation: null, hometown: null, knownHandles: {} },
      search: [{ ...directSearchEnvelope(), id: "d0" }], extraction: gatedExtraction, signals: [], hasAssertedAffiliations: false, secrets: [], asOf: new Date(AT),
    });
    expect(gr).not.toBeNull();

    process.env.RESEARCH_SUBSTRATE_WRITE = "false";
    await expect(reprocessAthleteLineage(gated, {})).rejects.toThrow(/RESEARCH_SUBSTRATE_WRITE/);
  });
});
