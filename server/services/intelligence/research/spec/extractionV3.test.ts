/** cited-claims/3: exact section-key aliases, degenerate detection, partition plan and deterministic merge. Synthetic; no network. */

import { describe, expect, it } from "@jest/globals";
import type { SearchEnvelope } from "../providers";
import { armDegenerate, degenerateReason, mergePartitions, normalizeSectionKey, parseCitedExtractionV3, partitionPlan, SUBSTANTIVE_EVIDENCE_CHARS, type PartitionResult } from "./extractionV3";
import { QUERIES, SECTIONS, sectionsFor } from "./researchSpecV1";

function env(id: string, queryName: string, chars: number): SearchEnvelope {
  return { id, provider: "p", queryName, query: "q", fetchedAt: "t", answerText: "a".repeat(chars), chunks: chars ? [{ id: `${id}:c0`, url: "https://x.example/1", domain: "x.example", title: null, text: "x".repeat(chars), textKind: "provider_answer_segments" }] : [], supports: [], raw: null, request: {}, errors: [] };
}
const all = sectionsFor(false);
const S1 = SECTIONS[0];

describe("section key normalization", () => {
  it("accepts only exact deterministic aliases of the frozen spec", () => {
    expect(normalizeSectionKey("S1")).toBe("S1");
    expect(normalizeSectionKey(" S1 Identity & disambiguation ")).toBe("S1");
    expect(normalizeSectionKey("Identity & disambiguation")).toBe("S1");
    expect(normalizeSectionKey("S9 Reputation & brand safety")).toBe("S9");
    expect(normalizeSectionKey("S1 identity and disambiguation")).toBeNull();   // no fuzzy matching
    expect(normalizeSectionKey("Section 1")).toBeNull();
    expect(normalizeSectionKey("S10")).toBeNull();
  });

  it("parses label-form keys and reports unknown ones", () => {
    const p = parseCitedExtractionV3(JSON.stringify({ claims: [], about_identity_confidence: 0.5, section_outcomes: { "S1 Identity & disambiguation": { status: "not_found", items: { full_name: "not_found" } }, "Something else": { status: "found_cited", items: {} } } }), all);
    expect(Object.keys(p.sectionOutcomes)).toEqual(["S1"]);
    expect(p.unknownSectionKeys).toEqual(["Something else"]);
  });
});

describe("degenerate detection", () => {
  const big = [env("g0", QUERIES[0].name, SUBSTANTIVE_EVIDENCE_CHARS)];
  const small = [env("g0", QUERIES[0].name, 200)];
  const notFoundAll = { S1: { status: "not_found" as const, items: Object.fromEntries(S1.items.map((i) => [i.id, "not_found" as const])), reviewedChunkIds: ["g0:c0"], conflicts: [], reason: null } };

  it("flags malformed, alias-less, template-echo and zero-claims-on-substantive-evidence responses", () => {
    expect(degenerateReason({ claims: [], aboutIdentityConfidence: null, parseError: "Unexpected token", sectionOutcomes: {}, unknownSectionKeys: [] }, big, [S1]).reason).toMatch(/^malformed/);
    expect(degenerateReason({ claims: [], aboutIdentityConfidence: 0.7, parseError: null, sectionOutcomes: {}, unknownSectionKeys: ["Sec 1"] }, small, [S1]).reason).toMatch(/no section outcome matched an exact alias/);
    expect(degenerateReason({ claims: [], aboutIdentityConfidence: 0, parseError: null, sectionOutcomes: notFoundAll, unknownSectionKeys: [] }, small, [S1]).reason).toMatch(/template echo/);
    expect(degenerateReason({ claims: [], aboutIdentityConfidence: 0.7, parseError: null, sectionOutcomes: notFoundAll, unknownSectionKeys: [] }, big, [S1]).reason).toMatch(/zero claims on substantive evidence/);
  });

  it("does not flag a genuine abstention on thin evidence, nor any extraction that produced claims", () => {
    expect(degenerateReason({ claims: [], aboutIdentityConfidence: 0.2, parseError: null, sectionOutcomes: notFoundAll, unknownSectionKeys: [] }, small, [S1])).toEqual({ degenerate: false, reason: null });
    const claim = { kind: "identity_signal" as const, claim: { topic: "namesake" }, citation: { chunkIds: ["g0:c0"], quote: "x" } };
    expect(degenerateReason({ claims: [claim], aboutIdentityConfidence: 0, parseError: null, sectionOutcomes: notFoundAll, unknownSectionKeys: [] }, big, [S1]).degenerate).toBe(false);
  });
});

describe("partitioned extraction", () => {
  it("plans one partition per query with that query's envelopes and in-scope sections only", () => {
    const envelopes = QUERIES.map((q, i) => env(`g${i}`, q.name, 100));
    const plan = partitionPlan(envelopes, all);
    expect(plan.map((p) => [p.queryId, p.sections.map((s) => s.id), p.envelopes.map((e) => e.id)])).toEqual([
      ["Q1", ["S1", "S2"], ["g0"]], ["Q2", ["S4"], ["g1"]], ["Q3", ["S5", "S6"], ["g2"]], ["Q4", ["S7"], ["g3"]], ["Q5", ["S8"], ["g4"]], ["Q6", ["S3", "S9"], ["g5"]],
    ]);
    // a minor is asked the same sections (S9 kept, narrowly framed)
    expect(partitionPlan(envelopes, sectionsFor(true)).find((p) => p.queryId === "Q6")!.sections.map((s) => s.id)).toEqual(["S3", "S9"]);
  });

  it("merges deterministically in query order: claims concatenated, one outcome per section, identity confidence from Q1, failed partitions contribute nothing", () => {
    const parsed = (claims: number, sections: Record<string, any>, aic: number | null) => ({ claims: Array.from({ length: claims }, (_, i) => ({ kind: "press_mention" as const, claim: { outlet: `o${i}` }, citation: null })), inferences: [], aboutIdentityConfidence: aic, parseError: null, sectionOutcomes: sections, unknownSectionKeys: [] });
    const base = { envelopeIds: [], chunks: 1, reason: null, latencyMs: 1, promptTokens: 1, completionTokens: 1, raw: null, error: null };
    const results: PartitionResult[] = [
      { ...base, queryId: "Q3", queryName: "x", sections: ["S5", "S6"], status: "ok", claims: 2, parsed: parsed(2, { S5: { status: "found_cited", items: {}, reviewedChunkIds: [], conflicts: [], reason: null } }, 0.4) },
      { ...base, queryId: "Q1", queryName: "x", sections: ["S1", "S2"], status: "ok", claims: 1, parsed: parsed(1, { S1: { status: "found_cited", items: {}, reviewedChunkIds: [], conflicts: [], reason: null }, S2: { status: "not_found", items: {}, reviewedChunkIds: [], conflicts: [], reason: null } }, 0.9) },
      { ...base, queryId: "Q2", queryName: "x", sections: ["S4"], status: "failed", claims: 0, parsed: null, error: "timed out" },
      { ...base, queryId: "Q4", queryName: "x", sections: ["S7"], status: "degenerate", claims: 0, parsed: parsed(0, { S7: { status: "not_found", items: {}, reviewedChunkIds: [], conflicts: [], reason: null } }, 0), reason: "template echo" },
    ];
    const m = mergePartitions(results);
    expect(m.claims.map((c) => (c.claim as any).outlet)).toEqual(["o0", "o0", "o1"]);   // Q1 first, then Q3
    expect(Object.keys(m.sectionOutcomes).sort()).toEqual(["S1", "S2", "S5"]);            // the degenerate Q4 contributes no outcome: S7 is unknown, not not_found
    expect(m.sectionsUnavailable).toEqual(["S4", "S7"]);
    expect(m.aboutIdentityConfidence).toBe(0.9);
    expect(m.identityConfidenceByPartition).toEqual({ Q1: 0.9, Q2: null, Q3: 0.4, Q4: 0 });
    expect(m).toMatchObject({ partitionsOk: 2, partitionsFailed: 1, partitionsDegenerate: 1, partitionsSkipped: 0 });
    expect(mergePartitions([...results].reverse())).toEqual(m);   // order-independent
    // a degenerate Q1 leaves identity confidence unknown rather than 0
    const q1deg = results.map((r) => (r.queryId === "Q1" ? { ...r, status: "degenerate" as const } : r));
    expect(mergePartitions(q1deg).aboutIdentityConfidence).toBeNull();
  });
});

describe("arm-level degenerate rule", () => {
  const r = (queryId: string, status: string) => ({ queryId, status, reason: status === "degenerate" ? "template echo" : null });
  const merged = (ok: number, claims: number) => ({ partitionsOk: ok, claims: Array.from({ length: claims }) } as any);
  it("is degenerate only when nothing usable came back", () => {
    expect(armDegenerate(merged(0, 0), [r("Q1", "degenerate"), r("Q2", "degenerate")]).degenerate).toBe(true);
    expect(armDegenerate(merged(1, 0), [r("Q1", "degenerate"), r("Q2", "degenerate"), r("Q3", "ok")]).degenerate).toBe(true);     // 2 ≥ 1 and zero claims
    expect(armDegenerate(merged(4, 27), [r("Q1", "degenerate"), r("Q4", "degenerate"), r("Q2", "ok"), r("Q3", "ok"), r("Q5", "ok"), r("Q6", "ok")])).toMatchObject({ degenerate: false, reason: expect.stringContaining("sections unknown") });
    expect(armDegenerate(merged(6, 10), [r("Q1", "ok")])).toEqual({ degenerate: false, reason: null });
    expect(armDegenerate(merged(0, 0), [r("Q1", "degenerate"), r("Q2", "failed")]).degenerate).toBe(false);   // a failed partition makes the arm extraction_failed instead
  });
});
