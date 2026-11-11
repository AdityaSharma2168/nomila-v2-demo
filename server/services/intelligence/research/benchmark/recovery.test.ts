/** Recovery path (13 Sep 2026): provider abstained ≠ extraction failed ≠ provider search failed; re-extraction reuses saved evidence byte-for-byte. Synthetic, no network. */

import { describe, expect, it } from "@jest/globals";
import { DEFAULT_RESEARCH_POLICY } from "../policy";
import type { SearchEnvelope } from "../providers";
import { armMetrics, aggregate, compareAthlete } from "./compare";
import { deriveArm } from "./evidence";
import { identityFidelity } from "./identity";
import { armStatus, canReextract, extractionDegenerate, mergeReextraction, normalizeSavedArm } from "./recovery";
import type { ArmExtraction, ArmRun, BenchmarkAthlete } from "./types";

const AS_OF = "2026-09-13";
const TEXT = "Jane Doe plays basketball for Example University.";
function envelope(id: string, chunks: number, completed = true): SearchEnvelope {
  return { id, provider: "gemini_grounded", model: "m", queryName: "Q1", query: "q", fetchedAt: `${AS_OF}T10:00:00Z`, answerText: completed ? TEXT : "", chunks: Array.from({ length: chunks }, (_, n) => ({ id: `${id}:c${n}`, url: `https://www.espn.com/${n}`, domain: "www.espn.com", title: null, text: TEXT, textKind: "provider_answer_segments" as const })), supports: [], raw: { keep: "me" }, request: {}, usage: { promptTokens: 100, completionTokens: 50, calls: 1, latencyMs: 1000 }, errors: completed ? [] : [{ step: "attempt-1", message: "empty", class: "empty" }] };
}
const okExtraction: ArmExtraction = { id: "x0", provider: "kimi_extract", model: "k", schemaVersion: "cited-claims/3", fetchedAt: `${AS_OF}T10:05:00Z`, claims: [{ kind: "profile_attribute", claim: { factKey: "sport", value: { sport: "basketball" } }, citation: { chunkIds: ["g0:c0"], quote: "plays basketball" }, confidence: 0.9, publishedAt: null }], inferences: [], sectionOutcomes: { S1: { status: "found_cited", items: { sport_discipline: "found_cited" }, reviewedChunkIds: ["g0:c0"], conflicts: [], reason: null } }, raw: { content: "{}", aboutIdentityConfidence: 0.9 }, request: {}, usage: { promptTokens: 5000, completionTokens: 400, calls: 1, latencyMs: 20_000 }, errors: [], parseError: null };
const timedOut: ArmExtraction = { ...okExtraction, claims: [], sectionOutcomes: {}, raw: null, usage: { calls: 1, latencyMs: 90_000 }, errors: [{ step: "extract", message: "kimiInstant timed out after 90000ms", class: "transient" }] };
const echo: ArmExtraction = { ...okExtraction, claims: [], sectionOutcomes: { S1: { status: "not_found", items: { full_name: "not_found", sport_discipline: "not_found" }, reviewedChunkIds: ["g0:c0"], conflicts: [], reason: null } }, raw: { content: "{}", aboutIdentityConfidence: 0 } };
const emptyButOk: ArmExtraction = { ...okExtraction, claims: [], sectionOutcomes: { S1: { status: "not_found", items: { sport_discipline: "not_found" }, reviewedChunkIds: ["g0:c0"], conflicts: [], reason: null } }, raw: { content: "{}", aboutIdentityConfidence: 0.2 } };

function arm(search: SearchEnvelope[], extraction: ArmExtraction | null, over: Partial<ArmRun> = {}): ArmRun {
  return { athleteKey: "jane-doe", provider: "gemini_grounded", model: "m", extractor: "kimi_extract@k", specVersion: "research-spec/1", asOf: AS_OF, startedAt: `${AS_OF}T10:00:00Z`, finishedAt: `${AS_OF}T10:06:00Z`, queries: search.map((e) => ({ id: "Q1", name: "Q1", sections: ["S1"], query: "q", attempts: 1, completed: e.chunks.length > 0, refused: false, chunks: e.chunks.length, latencyMs: 1000 })), search, extraction, usage: { searchCalls: search.length, extractCalls: extraction ? 1 : 0, promptTokens: 100 * search.length, completionTokens: 50 * search.length, cachedTokens: 0, latencyMs: 1000 * search.length + (extraction?.usage?.latencyMs ?? 0) }, estimatedCostUsd: { search: 0.2, extract: 0, total: 0.2, complete: !extraction || !!extraction.usage?.promptTokens }, minorRedacted: false, ...over };
}
const ATHLETE: BenchmarkAthlete = { key: "jane-doe", fullName: "Jane Doe", sport: "basketball", group: "niche", anchor: "basketball athlete" };

describe("arm status: abstained ≠ extraction_failed ≠ extraction_degenerate ≠ search_failed", () => {
  it("classifies the four states from what happened", () => {
    expect(armStatus(arm([envelope("g0", 3)], okExtraction))).toBe("complete");
    expect(armStatus(arm([envelope("g0", 3)], timedOut))).toBe("extraction_failed");
    expect(armStatus(arm([envelope("g0", 3)], null))).toBe("extraction_failed");
    expect(armStatus(arm([envelope("g0", 3)], echo))).toBe("extraction_degenerate");                 // template echo: zero claims, identity 0.0, all not_found
    expect(extractionDegenerate(arm([envelope("g0", 3)], echo)).reason).toMatch(/template echo/);
    expect(armStatus(arm([envelope("g0", 3)], { ...okExtraction, claims: [], parseError: "bad json" }))).toBe("extraction_degenerate");
    expect(armStatus(arm([envelope("g0", 3)], emptyButOk))).toBe("complete");                        // a genuine abstention on thin evidence stays complete
    expect(armStatus(arm([envelope("g0", 0, false)], null))).toBe("search_failed");
    expect(armStatus(arm([envelope("g0", 0, false), envelope("g1", 2)], okExtraction))).toBe("complete");   // some queries completed
  });

  it("never reports a provider abstention for an infrastructure failure", () => {
    const failed = deriveArm(arm([envelope("g0", 3)], timedOut), DEFAULT_RESEARCH_POLICY);
    const f = identityFidelity(failed, null, []);
    expect(failed.extractionFailed).toBe(true);
    expect(f.abstention.claims).toBe(0);
    expect(f.abstention.abstained).toBe(false);
    const m = armMetrics(arm([envelope("g0", 3)], timedOut), failed, null);
    expect(m.status).toBe("extraction_failed");
    const degenerate = deriveArm(arm([envelope("g0", 3)], echo), DEFAULT_RESEARCH_POLICY);
    expect(degenerate.extractionFailed).toBe(true);
    expect(identityFidelity(degenerate, null, []).abstention.abstained).toBe(false);
    expect(armMetrics(arm([envelope("g0", 3)], echo), degenerate, null)).toMatchObject({ status: "extraction_degenerate", statusReason: expect.stringContaining("template echo") });
    // a genuine abstention: extraction ran, reviewed the chunks, found nothing
    const abst = deriveArm(arm([envelope("g0", 3)], emptyButOk), DEFAULT_RESEARCH_POLICY);
    expect(identityFidelity(abst, null, []).abstention.abstained).toBe(true);
    expect(armMetrics(arm([envelope("g0", 3)], emptyButOk), abst, null).status).toBe("complete");
    // the aggregate counts abstentions only on complete arms and reports incomplete arms separately
    const a = aggregate([compareAthlete(ATHLETE, [arm([envelope("g0", 3)], timedOut)], null, DEFAULT_RESEARCH_POLICY, deriveArm)], AS_OF);
    expect(a.perProvider.gemini_grounded).toMatchObject({ abstentions: 0, incompleteArms: 1 });
    const b = aggregate([compareAthlete(ATHLETE, [arm([envelope("g0", 3)], emptyButOk)], null, DEFAULT_RESEARCH_POLICY, deriveArm)], AS_OF);
    expect(b.perProvider.gemini_grounded).toMatchObject({ abstentions: 1, incompleteArms: 0 });
  });
});

describe("re-extraction from saved evidence", () => {
  const saved = arm([envelope("g0", 3), envelope("g1", 2)], timedOut, { estimatedCostUsd: { search: 0.2, extract: 0, total: 0.2, complete: false } });

  it("is allowed for extraction_failed and extraction_degenerate arms with intact evidence text", () => {
    expect(canReextract(saved)).toEqual({ ok: true });
    expect(canReextract(arm([envelope("g0", 3)], echo))).toEqual({ ok: true });
    expect(canReextract(arm([envelope("g0", 3)], okExtraction)).ok).toBe(false);
    expect(canReextract(arm([envelope("g0", 0, false)], null)).ok).toBe(false);
    const stripped = { ...saved, search: saved.search.map((e) => ({ ...e, chunks: e.chunks.map((c) => ({ ...c, text: "" })) })) };
    expect(canReextract(stripped)).toMatchObject({ ok: false, reason: expect.stringContaining("no chunk text") });
  });

  it("replaces only the extraction layer, preserves the envelopes byte-for-byte, and records the retry", () => {
    const before = JSON.stringify(saved.search);
    const merged = mergeReextraction(saved, okExtraction, `${AS_OF}T12:00:00Z`, 0.004);
    expect(JSON.stringify(merged.search)).toBe(before);
    expect(merged.queries).toEqual(saved.queries);
    expect(merged.asOf).toBe(AS_OF);
    expect(merged.startedAt).toBe(saved.startedAt);
    expect(merged.estimatedCostUsd.search).toBe(0.2);
    expect(merged.extraction).toBe(okExtraction);
    expect(merged.status).toBe("complete");
    expect(merged.extractionRetried).toBe(true);
    expect(merged.extractionHistory).toHaveLength(2);
    expect(merged.extractionHistory![0]).toMatchObject({ mode: "single", outcome: "failed", error: expect.stringContaining("timed out"), latencyMs: 90_000, promptTokens: null });
    expect(merged.extractionHistory![1]).toMatchObject({ mode: "recovery", outcome: "ok", error: null, promptTokens: 5000, claims: 1 });
    // every attempt was billed: extraction calls and cost accumulate; the timed-out attempt's tokens are unknown → cost incomplete
    expect(merged.usage.extractCalls).toBe(2);
    expect(merged.usage.promptTokens).toBe(200 + 5000);   // two envelopes × 100 search tokens + the successful attempt
    expect(merged.usage.latencyMs).toBe(2000 + 90_000 + 20_000);
    expect(merged.estimatedCostUsd).toMatchObject({ extract: 0.004, total: 0.204, complete: false });
    // derived from the merged arm: a complete arm with claims, not an abstention
    const d = deriveArm(merged, DEFAULT_RESEARCH_POLICY);
    expect(d.evidence).toHaveLength(1);
    expect(identityFidelity(d, null, merged.search).abstention.abstained).toBe(false);
    // a second failure keeps the status and the history growing
    const again = mergeReextraction(merged, timedOut, `${AS_OF}T13:00:00Z`, 0);
    expect(again.status).toBe("extraction_failed");
    expect(again.extractionHistory).toHaveLength(3);
    // a partitioned attempt records its partitions and counts each real call
    const partitioned: ArmExtraction = { ...okExtraction, extractionMode: "partitioned", usage: { promptTokens: 3000, completionTokens: 300, calls: 2, latencyMs: 40_000 }, partitions: [
      { queryId: "Q1", queryName: "Q1", sections: ["S1", "S2"], envelopeIds: ["g0"], chunks: 3, status: "ok", reason: null, latencyMs: 20_000, promptTokens: 1500, completionTokens: 150, claims: 1, raw: "{}", error: null },
      { queryId: "Q2", queryName: "Q2", sections: ["S4"], envelopeIds: ["g1"], chunks: 2, status: "ok", reason: null, latencyMs: 20_000, promptTokens: 1500, completionTokens: 150, claims: 0, raw: "{}", error: null },
      { queryId: "Q3", queryName: "Q3", sections: ["S5", "S6"], envelopeIds: [], chunks: 0, status: "skipped", reason: "no chunks", latencyMs: null, promptTokens: null, completionTokens: null, claims: 0, raw: null, error: null },
    ] };
    const part = mergeReextraction(saved, partitioned, `${AS_OF}T14:00:00Z`, 0.002, "partitioned");
    expect(part.status).toBe("complete");
    expect(part.extractionHistory![1]).toMatchObject({ mode: "partitioned", outcome: "ok", partitions: [expect.objectContaining({ queryId: "Q1", status: "ok" }), expect.objectContaining({ queryId: "Q2" }), expect.objectContaining({ queryId: "Q3", status: "skipped" })] });
    expect(part.usage.extractCalls).toBe(1 + 2);
  });

  it("normalizes artifacts written before the recovery path", () => {
    const legacy = { ...saved } as ArmRun;
    delete (legacy as any).status; delete (legacy as any).extractionHistory;
    const n = normalizeSavedArm(legacy);
    expect(n.status).toBe("extraction_failed");
    expect(n.extractionHistory).toHaveLength(1);
    expect(n.extractionRetried).toBe(false);
    expect(normalizeSavedArm(n)).toEqual(n);
  });
});
