/** Path B through the benchmark layer: acceptance policies, provenance metrics, survival, four-arm ledger. Synthetic; no network. */

import { describe, expect, it } from "@jest/globals";
import { DEFAULT_RESEARCH_POLICY } from "../policy";
import type { SearchEnvelope } from "../providers";
import { parseDirectEvidence } from "../spec/directEvidenceV1";
import { matchOpenAIClaim, openaiSourcesToEnvelopeChunks, withLineage } from "../spec/directLineage";
import { sectionsFor } from "../spec/researchSpecV1";
import { aggregate, armMetrics, compareAthlete } from "./compare";
import { deriveArm } from "./evidence";
import { renderAggregate, renderAthlete } from "./report";
import type { ArmRun, BenchmarkAthlete } from "./types";

const AS_OF = "2026-09-14";
const all = sectionsFor(false);
const retrieved = [{ url: "https://www.ncaa.com/jane", title: "NCAA" }, { url: "https://www.example.edu/roster/jane", title: "Roster" }];
const json = JSON.stringify({
  identity: { anchor_match: "matched", confidence: 0.97, namesakes: [] },
  sections: { S1: { status: "found_cited", items: { full_name: "found_cited", sport_discipline: "found_cited", hometown: "not_found" } }, S2: { status: "found_cited", items: { current_affiliation: "found_cited" } } },
  claims: [
    { section: "S1", item: "full_name", kind: "profile_attribute", factKey: "name", value: { name: "Jane Doe" }, statement: "s", sources: [{ url: "https://www.ncaa.com/jane", quote: "Jane Doe" }], confidence: 0.9 },   // canonicalized name→full, native_retrieved
    { section: "S1", item: "sport_discipline", kind: "profile_attribute", factKey: "sport", value: { sport: "basketball" }, statement: "s", sources: [{ url: "https://www.example.edu/roster/jane/", quote: "basketball" }], confidence: 0.9 },   // normalized match
    { section: "S2", item: "current_affiliation", kind: "affiliation", factKey: "affiliation", value: { org: "Example University", orgKind: "school", season: 2026 }, timeframe: "current", statement: "s", sources: [{ url: "https://madeup.example/x", quote: "Example University" }], confidence: 0.8 },   // asserted_only
    { section: "S1", item: "hometown", kind: "profile_attribute", factKey: "hometown", value: { city: "Springfield" }, statement: "s", sources: [], confidence: 0.5 },   // unsupported
  ],
});
const parsed = parseDirectEvidence(json, all);
const claims = parsed.claims.map((c) => withLineage(c, matchOpenAIClaim(c.sources, retrieved, "od0")));
const envelope: SearchEnvelope = { id: "od0", provider: "openai_direct", model: "gpt-test", queryName: "Identity + Biography + Affiliations", query: "q", fetchedAt: `${AS_OF}T10:00:00Z`, answerText: "", chunks: openaiSourcesToEnvelopeChunks(retrieved, "od0"), supports: [], raw: null, request: {}, usage: { promptTokens: 9000, completionTokens: 3000, calls: 1, latencyMs: 12_000 }, errors: [] };
const directArm: ArmRun = {
  athleteKey: "jane-doe", provider: "openai_direct", path: "direct", model: "gpt-test", extractor: "openai_direct (direct-evidence/1, no Kimi)", specVersion: "research-spec/1", asOf: AS_OF, startedAt: `${AS_OF}T10:00:00Z`, finishedAt: `${AS_OF}T10:01:00Z`,
  queries: [{ id: "Q1", name: envelope.queryName, sections: ["S1", "S2"], query: "q", attempts: 1, completed: true, refused: false, chunks: 2, latencyMs: 12_000 }], search: [envelope],
  extraction: { id: "d0", provider: "openai_direct", model: "gpt-test", schemaVersion: "direct-evidence/1", extractionMode: "provider_direct", fetchedAt: `${AS_OF}T10:01:00Z`, claims, inferences: [], sectionOutcomes: parsed.sectionOutcomes, partitions: [{ queryId: "Q1", queryName: envelope.queryName, sections: ["S1", "S2"], envelopeIds: ["od0"], chunks: 2, status: "ok", reason: null, latencyMs: 12_000, promptTokens: 9000, completionTokens: 3000, claims: 4, raw: json, error: null }], identityByQuery: { Q1: { anchorMatch: "matched", confidence: 0.97, namesakes: 0 } }, degenerate: { degenerate: false, reason: null }, raw: { aboutIdentityConfidence: 0.97 }, request: {}, errors: [], parseError: null, usage: { promptTokens: 9000, completionTokens: 3000, calls: 0, latencyMs: 0 } },
  usage: { searchCalls: 1, extractCalls: 0, promptTokens: 9000, completionTokens: 3000, cachedTokens: 0, latencyMs: 12_000 }, estimatedCostUsd: { search: 0.03, extract: 0, total: 0.03, complete: true }, minorRedacted: false,
};
const ATHLETE: BenchmarkAthlete = { key: "jane-doe", fullName: "Jane Doe", sport: "basketball", group: "niche", anchor: "basketball athlete" };

describe("direct path in the benchmark layer", () => {
  it("applies the provenance level under the acceptance policy: retrieved-source accepts native_retrieved, strict accepts only native_supported; asserted/unsupported never resolve", () => {
    const retrievedPolicy = deriveArm(directArm, DEFAULT_RESEARCH_POLICY, false, "retrieved");
    const byKey = Object.fromEntries(retrievedPolicy.evidence.map((e) => [e.claimedFactKey, e]));
    expect(byKey.name).toMatchObject({ provenanceLevel: "native_retrieved", provenanceMatch: "url_exact", lineage: "cited", sourceDomain: "ncaa.com", sourceType: "official_governing_body", registry: { status: "accepted_canonicalized" }, acceptancePolicy: "retrieved" });
    expect(byKey.sport).toMatchObject({ provenanceLevel: "native_retrieved", provenanceMatch: "url_normalized", lineage: "cited", registry: { status: "accepted" } });
    expect(byKey.affiliation).toMatchObject({ provenanceLevel: "asserted_only", lineage: "uncited", sourceUrl: null });
    expect(byKey.hometown).toMatchObject({ provenanceLevel: "unsupported", lineage: "uncited" });
    expect(retrievedPolicy.facts.map((f) => f.factKey).sort()).toEqual(["name", "sport"]);
    const strict = deriveArm(directArm, DEFAULT_RESEARCH_POLICY, false, "strict");
    expect(strict.evidence.every((e) => e.lineage === "uncited")).toBe(true);
    expect(strict.facts).toEqual([]);
  });

  it("reports provenance distribution, both policies, survival, costs and the direct identity block", () => {
    const derived = deriveArm(directArm, DEFAULT_RESEARCH_POLICY, false, "retrieved");
    const m = armMetrics(directArm, derived, null, null, (acc) => deriveArm(directArm, DEFAULT_RESEARCH_POLICY, false, acc));
    expect(m.path).toBe("direct");
    expect(m.provenance).toEqual({ native_supported: 0, native_retrieved: 2, asserted_only: 1, unsupported: 1 });
    expect(m.policies.retrieved).toMatchObject({ cited: 2, factsAccepted: 2, registryAccepted: 1, registryCanonicalized: 1, registryRefused: 0 });
    expect(m.policies.strict).toMatchObject({ cited: 0, factsAccepted: 0 });
    expect(m.survival).toMatchObject({ providerEvidence: 4, afterExtractionOrProvenance: 2, afterRegistry: 2 });
    expect(m.costs).toEqual({ providerUsd: 0.03, kimiUsd: 0, totalUsd: 0.03 });
    expect(m.directIdentity).toEqual({ anchorMatch: "matched", confidence: 0.97, namesakes: 0 });
    expect(m.status).toBe("complete");
    expect(m.identity.abstention.abstained).toBe(false);
  });

  it("compares a path-A arm and a path-B arm in one athlete report with the ledger labelled per arm", () => {
    const kimiArm: ArmRun = { ...directArm, provider: "gemini_grounded", path: "kimi", extractor: "kimi_extract@k", extraction: { ...directArm.extraction!, provider: "kimi_extract", extractionMode: "partitioned", claims: [{ kind: "profile_attribute", claim: { factKey: "sport", value: { sport: "basketball" } }, citation: { chunkIds: ["od0:c0"], quote: "x" }, confidence: 0.9, publishedAt: null }], identityByQuery: undefined }, search: [{ ...envelope, provider: "gemini_grounded", chunks: envelope.chunks.map((c) => ({ ...c, text: "plays basketball x", textKind: "provider_answer_segments" as const })) }], estimatedCostUsd: { search: 0.05, extract: 0.02, total: 0.07, complete: true } };
    const c = compareAthlete(ATHLETE, [kimiArm, directArm], null, DEFAULT_RESEARCH_POLICY, (arm, policy, isMinor) => deriveArm(arm, policy, isMinor, "retrieved"));
    expect(Object.keys(c.arms)).toEqual(["gemini_grounded", "openai_direct"]);
    expect(c.arms.gemini_grounded).toMatchObject({ path: "kimi", provenance: null, costs: { providerUsd: 0.05, kimiUsd: 0.02, totalUsd: 0.07 } });
    expect(c.arms.openai_direct.path).toBe("direct");
    const sport = c.ledger.find((r) => r.claimedFactKey === "sport")!;
    expect(sport.agreement).toBe("both");
    const a = aggregate([c], AS_OF);
    expect(a.perProvider.openai_direct).toMatchObject({ path: "direct", provenance: { native_retrieved: 2 }, policies: { strict: { factsAccepted: 0 }, retrieved: { factsAccepted: 2 } } });
    expect(a.perProvider.gemini_grounded.provenance).toBeNull();
    const md = renderAthlete(c) + renderAggregate(a);
    expect(md).toContain("direct (provider → Nomila)");
    expect(md).toContain("facts accepted: strict policy / retrieved-source policy");
    expect(md).toContain("survival");
  });
});
