/**
 * marketabilityCitationLineage.test.ts — a cited source is support only when the provider's grounding shows it was
 * retrieved. No provider calls: the fixtures are shaped exactly like a stored M.I.A. run (`raw.text`, `raw.native`
 * with vertexaisearch redirect URIs + web.domain/title, supports indexing the prose) and its evidence snapshot,
 * modelled on Mia's run of 29 Sep 2026.
 */
import { describe, expect, it } from "@jest/globals";
import { classifyCitation, groundCitations, groundingContextFor, judgementSourceOf } from "./marketabilityCitationLineage";
import { assessmentValueFor } from "./marketabilityLedgerMapping";
import { findingsFromMia } from "./intelligence/state/build";
import { renderStateBlock } from "./intelligence/opportunity/stateBlock";
import { ATHLETE_STATE_VERSION, type AthleteState } from "./intelligence/contracts/athleteState";
import { citationStrength, type LedgerEvidenceCitation } from "./intelligence/contracts/intelligenceLedger";
import type { EvaluatorOutput } from "./marketabilityBeta1Evaluator";

const redirect = (tag: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ${tag}xDoU2jSGzwpbrzenqn0mBpn5aaOsVAeIgmsLUMv7UAQS7VqN4WU0lIV_zdo==`;
const chunk = (domain: string, tag: string) => ({ web: { uri: redirect(tag), title: domain, domain } });

// E7's claim occurs once in the response (inside the JSON evidence list) and a support covers that span, naming the
// gostanford chunk. In Mia's real run no support covers the JSON list, so every web citation fell to domain/asserted.
const PROSE_LEAD = "Mia Bhuta is a Stanford midfielder. ";
const E7_CLAIM = "She started all 23 matches for Stanford in 2024.";
const JSON_EVIDENCE = [
  { id: "E1", claim: "Mia Bhuta plays for the Stanford Cardinal women's soccer team.", source_url: "https://gostanford.com/sports/womens-soccer/roster/mia-bhuta/20560", source_type: "official", source_title: "Stanford Roster" },
  { id: "E2", claim: "At age 16, Bhuta became the first Indian-American to represent the U.S. at a World Cup at any level.", source_url: "https://en.wikipedia.org/wiki/Mia_Bhuta", source_type: "secondary", source_title: "Mia Elizabeth Bhuta - Wikipedia" },
  { id: "E6", claim: "Authoritative platform metrics supplied: Instagram followers 21,925 (declining), TikTok followers 15,481, IG engagement per follower 7.12%.", source_url: "platform_discovery", source_type: "platform", source_title: "Nomila Verified Athlete Social Data Block" },
  { id: "E7", claim: E7_CLAIM, source_url: "https://www.gostanford.com/news/2024/recap", source_type: "official", source_title: "Recap" },
  { id: "E8", claim: "She was named to a preseason watch list.", source_url: "not_a_url", source_type: "platform", source_title: "Unknown" },
];
const TEXT = `${PROSE_LEAD}\n\n\`\`\`json\n${JSON.stringify({ evidence: JSON_EVIDENCE })}\n\`\`\``;
const e7At = TEXT.indexOf(E7_CLAIM);

const RAW = {
  text: TEXT,
  native: {
    groundingChunks: [chunk("gostanford.com", "H3kj"), chunk("unionprogress.com", "H5Go"), chunk("lebomag.com", "HlF7")],
    groundingSupports: [
      { segment: { text: PROSE_LEAD.trim(), startIndex: 0, endIndex: PROSE_LEAD.length - 1 }, groundingChunkIndices: [1] },
      { segment: { text: E7_CLAIM, startIndex: e7At, endIndex: e7At + E7_CLAIM.length }, groundingChunkIndices: [0] },
    ],
    webSearchQueries: ["Mia Bhuta Stanford soccer"],
  },
  conditions: "google-search-grounding; thinking=default; temperature=1.0",
};
const SOCIAL_BLOCK = [
  "AUTHORITATIVE SOCIAL DATA", "",
  "Measured platform facts supplied by Nomila.",
  "- tiktok @rileyathlete — source: connected verified; observed 2026-09-29; identity: athlete-connected account (OAuth) (HIGH). followers: 15,481",
  "- instagram @rileyathlete — source: connected verified; observed 2026-09-29; identity: athlete-connected account (OAuth) (HIGH). followers: 21,925; median engagement per follower (30 days): 7.12%",
  "- x: not available (no authoritative route)",
].join("\n");
const SNAPSHOT = {
  social_block: SOCIAL_BLOCK,
  social_sources: [
    { platform: "tiktok", accountId: "rileyathlete", observedAt: "2026-09-29", sourceClass: "connected_verified" },
    { platform: "instagram", accountId: "rileyathlete", observedAt: "2026-09-29", sourceClass: "connected_verified" },
  ],
};
const ctx = groundingContextFor(RAW, SNAPSHOT)!;
const cite = (id: string): LedgerEvidenceCitation => {
  const e = JSON_EVIDENCE.find((x) => x.id === id)!;
  return { id: e.id, claim: e.claim, sourceUrl: e.source_url, sourceType: e.source_type, sourceTitle: e.source_title };
};

describe("classifyCitation", () => {
  it("grounded: the claim binds to a support whose chunk is the cited domain", () => {
    expect(classifyCitation(cite("E7"), ctx)).toMatchObject({ level: "native_supported", match: "index_support", retrievedDomains: ["gostanford.com"] });
  });

  it("domain only: a chunk from the cited domain was retrieved, but nothing binds the claim (redirect URIs)", () => {
    expect(classifyCitation(cite("E1"), ctx)).toMatchObject({ level: "native_retrieved", match: "domain", retrievedDomains: ["gostanford.com"] });
  });

  it("asserted, not retrieved: no chunk from the cited domain (Mia's Wikipedia citation)", () => {
    const l = classifyCitation(cite("E2"), ctx);
    expect(l).toMatchObject({ level: "asserted_only", match: "none" });
    expect(l.detail).toContain("wikipedia.org");
  });

  it("the redirect host is never taken for the source's domain", () => {
    const vx = { ...cite("E2"), sourceUrl: redirect("H3kj") };
    expect(classifyCitation(vx, { ...ctx, native: { groundingChunks: [{ web: { uri: redirect("H3kj") } }], groundingSupports: [] } }).level).toBe("asserted_only");
  });

  it("Nomila-supplied: identified from the snapshot it restates, not the model's 'platform' label", () => {
    expect(classifyCitation(cite("E6"), ctx)).toMatchObject({ level: "nomila_supplied", match: "snapshot" });
    // Same self-label, nothing from the block restated → not Nomila's, and not a URL either.
    expect(classifyCitation(cite("E8"), ctx)).toMatchObject({ level: "unsupported", match: "none" });
    // Same E6 text, but Nomila sent no social block → the model's label alone does not make it Nomila's.
    const noBlock = groundingContextFor(RAW, { social_block: null, social_sources: [] })!;
    expect(classifyCitation(cite("E6"), noBlock).level).toBe("unsupported");
  });

  it("a run with no stored grounding metadata is left unclassified, never guessed", () => {
    expect(groundingContextFor({ text: TEXT }, SNAPSHOT)).toBeNull();
    const { evidence } = groundCitations([], [cite("E1")], null);
    expect(evidence[0].lineage).toBeUndefined();
    expect(citationStrength(evidence[0])).toBe("unrecorded");
  });
});

describe("dangling evidence ids", () => {
  it("moves ids absent from the evidence list out of citedEvidence, on components and the finding", () => {
    const { findings } = groundCitations(
      [{ key: "d", value: 50, confidence: null, citedEvidence: ["E1", "E9"], components: [{ key: "d.s", value: 1, evidenceClass: "EVALUATED", citedEvidence: ["E1", "E9", "E10"] }] }],
      [cite("E1")], null,
    );
    expect(findings[0].citedEvidence).toEqual(["E1"]);
    expect(findings[0].danglingEvidence).toEqual(["E10", "E9"]);
    expect(findings[0].components![0]).toMatchObject({ citedEvidence: ["E1"], danglingEvidence: ["E10", "E9"] });
  });
});

describe("through the ledger mapping, State and the state block", () => {
  const out = {
    judgements: [], identityConfidence: null, summary: null, summaryWords: 0,
    evidence: JSON_EVIDENCE.map((e) => ({ id: e.id, claim: e.claim, sourceTitle: e.source_title, sourceUrl: e.source_url, sourceType: e.source_type, date: "2026-09-29" })),
    dimensionAssessments: { athletic_authority: { prose: "Strong.", confidence: "HIGH", confidenceReason: "official sources" } },
    overallConfidence: null, keyStrengths: [], keyConstraints: [], importantMissingData: [], identityOrEvidenceRisks: [],
  } as unknown as EvaluatorOutput;
  const dims = [{ dimension: "athletic_authority", score: 90, confidence: 80, signals: [{ key: "athletic_authority.role_importance", value: 90, source: "web_researched", evidenceIds: ["E1", "E2", "E6", "E7", "E99"] }] }];
  const value = assessmentValueFor(dims, 700, out, ctx);

  it("the ledger value carries each citation's lineage and the dangling id", () => {
    const by = Object.fromEntries(value.evidence.map((e) => [e.id, e.lineage?.level]));
    expect(by).toEqual({ E1: "native_retrieved", E2: "asserted_only", E6: "nomila_supplied", E7: "native_supported", E8: "unsupported" });
    expect(value.findings[0].citedEvidence).toEqual(["E1", "E2", "E6", "E7"]);
    expect(value.findings[0].danglingEvidence).toEqual(["E99"]);
  });

  it("State does not carry the asserted citation as support; the state block does not present it as a source", () => {
    const [f] = findingsFromMia({ id: "row-1", value: { dimensions: dims, ...value }, evidence_as_of: new Date("2026-09-29T00:00:00Z") });
    // Three distinct classes of support — a domain match is never listed beside a grounded source.
    expect(f.citedEvidence!.map((e) => e.id)).toEqual(["E7"]);
    expect(f.siteOnlyCitations!.map((e) => e.id)).toEqual(["E1"]);
    expect(f.nomilaSuppliedCitations!.map((e) => e.id)).toEqual(["E6"]);
    expect(f.unsupportedCitations!.map((e) => e.id)).toEqual(["E2"]);
    expect(f.danglingEvidence).toEqual(["E99"]);
    expect(f.rationale!.evidenceIds).toEqual(["E1", "E6", "E7"]);

    const m = (value: unknown) => ({ value, owner: "athlete_state", confidence: "HIGH", asOf: "x", evidenceClass: "MEASURED", evidenceIds: ["e"], sourceMethod: "test" });
    const state = {
      athleteId: "a1", asOf: "2026-09-29T00:00:00.000Z", version: ATHLETE_STATE_VERSION,
      identity: { name: "Mia", sport: null, competitionContext: null, careerStatus: null },
      findings: [f],
      audienceTrajectory: { value: null, owner: "athlete_intelligence", asOf: "x", evidenceClass: "MISSING", reason: "none" },
      commercialPosition: {
        closedDeals: m(0), activeRelationships: m([]), demonstratedEconomics: { value: null, owner: "athlete_state", asOf: "x", evidenceClass: "MISSING", reason: "none" },
        pricingEvidence: "none", pipeline: m({ detected: 0, negotiating: 0, rejected: 0, accepted: 0, completed: 0 }), inbound: [],
      },
      constraints: [], preferences: [], audience: [], contentPerformance: [], representation: null, dates: [], athleteNotes: [],
      materialGaps: [], overallConfidence: "LOW", sources: [],
    } as unknown as AthleteState;
    const block = renderStateBlock(state);
    const section = (from: string, to: string) => block.slice(block.indexOf(from), block.indexOf(to));
    const direct = section("SOURCE EVIDENCE M.I.A. CITED", "WEAKER LINEAGE");
    expect(direct).toContain("E7  official · 2026-09-29  [retrieved · grounded]");
    expect(direct).not.toMatch(/E1 |E2 |E6 /);
    const weaker = section("WEAKER LINEAGE", "NOMILA-SUPPLIED DATA");
    expect(weaker).toContain("E1  official · 2026-09-29  [weaker lineage: site retrieved, page unproven]");
    expect(weaker).not.toMatch(/E2 |E6 |E7 /);
    const nomila = section("NOMILA-SUPPLIED DATA", "CITED BY M.I.A. BUT NOT RETRIEVED");
    expect(nomila).toContain("E6  platform · 2026-09-29  [Nomila-supplied platform data]");
    expect(nomila).not.toMatch(/E2 /);
    expect(block).not.toContain("en.wikipedia.org");
    expect(block).toContain("E2  [asserted_only]");
    expect(block).toContain("CITED EVIDENCE IDS THAT DO NOT EXIST — not support: E99");
  });
});

describe("judgementSourceOf — a judgement's source class from what it cites (A2)", () => {
  const cite = (id: string, level: string | null): LedgerEvidenceCitation =>
    ({ id, claim: "c", sourceUrl: null, sourceType: null, sourceTitle: null, observedAt: null, ...(level ? { lineage: { level, match: "none", detail: "d" } } : {}) }) as LedgerEvidenceCitation;
  const evidence = [cite("n1", "nomila_supplied"), cite("n2", "nomila_supplied"), cite("w1", "native_retrieved"), cite("a1", "asserted_only"), cite("u1", null)];
  it("all Nomila-supplied → the block's class; nothing cited → inferred; anything else → web_researched", () => {
    const of = judgementSourceOf(evidence, ["connected_verified"]);
    expect(of({ evidenceIds: ["n1", "n2"] })).toBe("connected_verified");
    expect(of({ evidenceIds: [] })).toBe("inferred");
    expect(of({ evidenceIds: ["n1", "w1"] })).toBe("web_researched");
    expect(of({ evidenceIds: ["a1"] })).toBe("web_researched");
    expect(of({ evidenceIds: ["u1"] })).toBe("web_researched");      // unclassified (no grounding): the frozen default
    expect(of({ evidenceIds: ["missing"] })).toBe("web_researched"); // a dangling id is never Nomila's
  });
  it("a block that includes a public, not connected, account is platform_public", () => {
    expect(judgementSourceOf(evidence, ["connected_verified", "meta_business_discovery"])({ evidenceIds: ["n1"] })).toBe("platform_public");
    expect(judgementSourceOf(evidence, [])({ evidenceIds: ["n1"] })).toBe("platform_public");
  });
});
