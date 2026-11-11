/** minor-evidence-policy/2 — data minimization, not a reduced research model. Synthetic; no network. */

import { describe, expect, it } from "@jest/globals";
import { DEFAULT_RESEARCH_POLICY } from "../policy";
import type { SearchEnvelope } from "../providers";
import { deriveArm } from "./evidence";
import { establishesMinor, minimizeArmForMinor, minimizeText, MINOR_POLICY_VERSION } from "./minorPolicy";
import type { ArmExtraction, ArmRun } from "./types";

const AS_OF = "2026-09-13";
const TEXT = "Jane Doe (born March 4, 2010) plays for Nationals SC in Troy, Michigan. Contact: jane@example.com, (248) 555-0100, 12 Maple Street. She was suspended for one match by the state association in 2025.";
function envelope(id: string, queryName: string): SearchEnvelope {
  return { id, provider: "gemini_grounded", model: "m", queryName, query: "q", fetchedAt: `${AS_OF}T10:00:00Z`, answerText: TEXT, chunks: [{ id: `${id}:c0`, url: "https://www.example-youth.org/jane", domain: "www.example-youth.org", title: null, text: TEXT, textKind: "provider_answer_segments" }], supports: [], raw: { keep: 1 }, request: {}, usage: { promptTokens: 100, completionTokens: 50, calls: 1, latencyMs: 1000 }, errors: [] };
}
const extraction: ArmExtraction = { id: "x0", provider: "kimi_extract", model: "k", schemaVersion: "cited-claims/3", extractionMode: "partitioned", fetchedAt: `${AS_OF}T10:05:00Z`, inferences: [], raw: { aboutIdentityConfidence: 0.7 }, request: {}, usage: { promptTokens: 500, completionTokens: 100, calls: 6, latencyMs: 9000 }, errors: [], parseError: null, degenerate: { degenerate: false, reason: null }, sectionOutcomes: {}, claims: [
  { kind: "profile_attribute", claim: { factKey: "birth_year", value: { year: 2010 }, dateOfBirth: "2010-03-04" }, citation: { chunkIds: ["g0:c0"], quote: "born March 4, 2010" }, confidence: 0.8, publishedAt: null },
  { kind: "profile_attribute", claim: { factKey: "hometown", value: { city: "Troy", region: "Michigan", country: "USA" } }, citation: { chunkIds: ["g0:c0"], quote: "Troy, Michigan" }, confidence: 0.8, publishedAt: null },
  { kind: "affiliation", claim: { factKey: "affiliation", value: { org: "Nationals SC", orgKind: "club", season: 2025 }, timeframe: "current" }, citation: { chunkIds: ["g0:c0"], quote: "plays for Nationals SC" }, confidence: 0.9, publishedAt: null },
  { kind: "social_handle", claim: { platform: "instagram", handle: "janedoe10", email: "jane@example.com", phone: "(248) 555-0100" }, citation: { chunkIds: ["g0:c0"], quote: "jane@example.com" }, confidence: 0.6, publishedAt: null },
  { kind: "reputation_event", claim: { event: "one-match suspension by the state association", stage: "official_finding_or_action", date: "2025-05-01" }, citation: { chunkIds: ["g0:c0"], quote: "suspended for one match by the state association" }, confidence: 0.8, publishedAt: null },
  { kind: "reputation_event", claim: { event: "rumoured incident", stage: "reported_allegation", date: "2025-06-01" }, citation: { chunkIds: ["g0:c0"], quote: "this text is not in the chunk" }, confidence: 0.3, publishedAt: null },   // uncited → dropped for a minor
] };
const arm: ArmRun = { athleteKey: "jane-doe", provider: "gemini_grounded", model: "m", extractor: "k", specVersion: "research-spec/1", asOf: AS_OF, startedAt: `${AS_OF}T10:00:00Z`, finishedAt: `${AS_OF}T10:06:00Z`, queries: [{ id: "Q1", name: "Identity + Biography + Affiliations", sections: ["S1", "S2"], query: "q", attempts: 1, completed: true, refused: false, chunks: 1, latencyMs: 1000 }], search: [envelope("g0", "Identity + Biography + Affiliations")], extraction, usage: { searchCalls: 1, extractCalls: 6, promptTokens: 600, completionTokens: 150, cachedTokens: 0, latencyMs: 10_000 }, estimatedCostUsd: { search: 0.05, extract: 0.01, total: 0.06, complete: true }, minorRedacted: false };

describe("minor policy activation", () => {
  it("activates only from a cited birth-year claim that deterministically establishes under 18; never from context", () => {
    const d = deriveArm(arm, DEFAULT_RESEARCH_POLICY);
    expect(establishesMinor(d.evidence, AS_OF)).toMatchObject({ minor: true, birthYear: 2010 });
    expect(establishesMinor(d.evidence, "2028-01-01")).toMatchObject({ minor: false });   // 18 that year → ambiguous → no trigger
    const ambiguous = d.evidence.map((e) => (e.claimedFactKey === "birth_year" ? { ...e, claim: { ...e.claim, value: { year: 2008 } } } : e));
    expect(establishesMinor(ambiguous, AS_OF).minor).toBe(false);
    const uncited = d.evidence.map((e) => (e.claimedFactKey === "birth_year" ? { ...e, lineage: "uncited" as const } : e));
    expect(establishesMinor(uncited, AS_OF).minor).toBe(false);
    const highSchoolOnly = d.evidence.filter((e) => e.claimedFactKey !== "birth_year");
    expect(establishesMinor(highSchoolOnly, AS_OF).minor).toBe(false);
  });
});

describe("minor minimization keeps the athlete record and removes only prohibited detail", () => {
  it("redacts PII patterns in text, drops prohibited fields, keeps year from a DOB, drops uncited reputation, keeps everything else", () => {
    const t = minimizeText(TEXT);
    expect(t.text).toContain("born 2010");
    expect(t.text).not.toMatch(/March 4|jane@example\.com|555-0100|Maple Street/);
    expect(t.text).toContain("Nationals SC in Troy, Michigan");
    expect(t.text).toContain("suspended for one match");
    expect(t.redactions).toBe(4);

    const derived = deriveArm(arm, DEFAULT_RESEARCH_POLICY);
    const m = minimizeArmForMinor(arm, derived);
    expect(m.report.version).toBe(MINOR_POLICY_VERSION);
    expect(m.arm.minorRedacted).toBe(true);
    // provider text kept (minimized), never stripped
    expect(m.arm.search[0].chunks[0].text).toContain("Nationals SC");
    expect(m.arm.search[0].answerText).not.toContain("example.com");
    // claims: public athletic record kept
    const kinds = m.arm.extraction!.claims.map((c) => `${c.kind}:${c.claim.factKey ?? ""}`);
    expect(kinds).toEqual(expect.arrayContaining(["profile_attribute:birth_year", "profile_attribute:hometown", "affiliation:affiliation", "social_handle:", "reputation_event:"]));
    // prohibited fields gone, year kept
    const by = m.arm.extraction!.claims.find((c) => c.claim.factKey === "birth_year")!;
    expect(by.claim).toEqual({ factKey: "birth_year", value: { year: 2010 } });
    const sh = m.arm.extraction!.claims.find((c) => c.kind === "social_handle")!;
    expect(sh.claim).toEqual({ platform: "instagram", handle: "janedoe10" });
    // the cited official finding stays; the uncited allegation is dropped
    const rep = m.arm.extraction!.claims.filter((c) => c.kind === "reputation_event");
    expect(rep).toHaveLength(1);
    expect(rep[0].claim.stage).toBe("official_finding_or_action");
    expect(m.report.claimsDropped).toEqual([{ id: "gemini_grounded:e5", reason: expect.stringContaining("unsourced allegation") }]);
    expect(m.derived.evidence.some((e) => e.id === "gemini_grounded:e5")).toBe(false);
    expect(m.derived.evidence.find((e) => e.claimedFactKey === "hometown")?.claim.value).toEqual({ city: "Troy", region: "Michigan", country: "USA" });
    expect(m.report.fieldsDropped).toEqual(expect.arrayContaining(["drop:dateOfBirth", "drop:email", "drop:phone"]));
    expect(JSON.stringify(m)).not.toMatch(/jane@example\.com|555-0100|Maple Street|March 4/);
  });
});
