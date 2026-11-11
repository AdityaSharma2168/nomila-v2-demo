/**
 * research/benchmark — pure comparison tests on SYNTHETIC cited-claims/3 arms (no provider, no network, no DB).
 * The athlete, sources and claims below are invented for the test; nothing here is real evidence.
 */

import { describe, expect, it } from "@jest/globals";
import { DEFAULT_RESEARCH_POLICY } from "../policy";
import type { SearchEnvelope } from "../providers";
import type { ReportedSectionOutcome, SectionId } from "../spec/researchSpecV1";
import { aggregate, buildLedger, compareAthlete } from "./compare";
import { deriveArm, followerMentions } from "./evidence";
import { identityFidelity } from "./identity";
import { ledgerCsv, renderAggregate, renderAthlete } from "./report";
import { coveredSubSignals } from "./subSignalCoverage";
import type { ArmExtraction, ArmRun, BenchmarkAthlete, GoldIdentity } from "./types";

const AS_OF = "2026-09-13";

function envelope(id: string, provider: string, queryName: string, chunks: Array<{ url: string; text: string }>, answerText?: string): SearchEnvelope {
  const answer = answerText ?? chunks.map((c) => c.text).join(" ");
  return {
    id, provider, model: "m", queryName, query: "q", fetchedAt: `${AS_OF}T10:00:00Z`, answerText: answer,
    chunks: chunks.map((c, n) => ({ id: `${id}:c${n}`, url: c.url, domain: new URL(c.url).hostname, title: null, text: c.text, textKind: "provider_answer_segments" as const })),
    supports: chunks.map((c, n) => ({ id: `${id}:s${n}`, chunkIds: [`${id}:c${n}`], text: c.text })),
    raw: null, request: {}, usage: { promptTokens: 500, completionTokens: 2000, calls: 1, latencyMs: 4000 }, errors: [],
  };
}
const outcome = (status: ReportedSectionOutcome["status"], items: Record<string, ReportedSectionOutcome["status"]>, reviewed: string[] = []): ReportedSectionOutcome => ({ status, items, reviewedChunkIds: reviewed, conflicts: [], reason: null });
function extraction(claims: ArmExtraction["claims"], sectionOutcomes: Partial<Record<SectionId, ReportedSectionOutcome>>, aic: number | null): ArmExtraction {
  return { id: "x0", provider: "kimi_extract", model: "k", schemaVersion: "cited-claims/3", fetchedAt: `${AS_OF}T10:05:00Z`, claims, inferences: [], sectionOutcomes, raw: { content: "{}", aboutIdentityConfidence: aic }, request: {}, usage: { promptTokens: 20_000, completionTokens: 2000, calls: 1, latencyMs: 30_000 }, errors: [], parseError: null };
}
function arm(provider: string, search: SearchEnvelope[], ext: ArmExtraction | null): ArmRun {
  return { athleteKey: "jane-doe", provider, model: `${provider}-model`, extractor: "kimi_extract@k", specVersion: "research-spec/1", asOf: AS_OF, startedAt: `${AS_OF}T10:00:00Z`, finishedAt: `${AS_OF}T10:06:00Z`, queries: [], search, extraction: ext, usage: { searchCalls: search.length, extractCalls: ext ? 1 : 0, promptTokens: 1, completionTokens: 1, cachedTokens: 0, latencyMs: 40_000 }, estimatedCostUsd: { search: 0.1, extract: 0.02, total: 0.12, complete: true }, minorRedacted: false };
}

const ATHLETE: BenchmarkAthlete = { key: "jane-doe", fullName: "Jane Doe", sport: "basketball", group: "niche", anchor: "basketball athlete, Example University", isMinor: false };
const GOLD: GoldIdentity = { key: "jane-doe", confirmed: { sport: ["basketball"], affiliation: ["example university"], hometown: ["springfield"] }, negativeAnchors: ["Jane Doe (actress)"] };

const G_TEXT_1 = "Jane Doe plays basketball for Example University in the Big Example Conference. She was named 2025 Conference Player of the Year.";
const G_TEXT_2 = "Jane Doe has 1.2M followers on Instagram and signed with Acme Shoes in 2025 as an apparel sponsorship.";
const G_TEXT_3 = "In 2024 Jane Doe was suspended for two games by the conference; the suspension was later reduced on appeal.";
const geminiArm = arm("gemini_grounded", [
  envelope("g0", "gemini_grounded", "Identity + Biography + Affiliations", [{ url: "https://www.espn.com/jane", text: G_TEXT_1 }]),
  envelope("g3", "gemini_grounded", "Commercial + Brand + Representation", [{ url: "https://www.instagram.com/janedoe", text: G_TEXT_2 }]),
  envelope("g5", "gemini_grounded", "Recent Developments + Reputation", [{ url: "https://www.example-conference.org/news", text: G_TEXT_3 }]),
], extraction([
  { kind: "profile_attribute", claim: { factKey: "sport", value: { sport: "basketball" } }, citation: { chunkIds: ["g0:c0"], quote: "plays basketball for Example University" }, confidence: 0.9, publishedAt: "2026-08-01" },
  { kind: "affiliation", claim: { factKey: "affiliation", value: { org: "Example University", orgKind: "school", level: "D1", conference: "Big Example", season: 2026 }, timeframe: "current", league: "Big Example Conference" }, citation: { chunkIds: ["g0:c0"], quote: "plays basketball for Example University" }, confidence: 0.9, publishedAt: "2026-08-01" },
  { kind: "achievement", claim: { factKey: "award", value: { name: "Conference Player of the Year", year: 2025, level: "conference" }, category: "athletic" }, citation: { chunkIds: ["g0:c0"], quote: "2025 Conference Player of the Year" }, confidence: 0.85, publishedAt: null },
  { kind: "profile_attribute", claim: { factKey: "hometown", value: { city: "Springfield", region: "Illinois", country: "USA" } }, citation: { chunkIds: ["g0:c0"], quote: "born and raised in Springfield" }, confidence: 0.6, publishedAt: null },   // quote not in chunk → uncited
  { kind: "brand_mention", claim: { brand: "Acme Shoes", type: "sponsorship", category: "apparel", startDate: "2025-01-01" }, citation: { chunkIds: ["g3:c0"], quote: "signed with Acme Shoes in 2025" }, confidence: 0.8, publishedAt: "2025-03-01" },
  { kind: "social_metric_claim", claim: { platform: "instagram", metric: "followers", metricValue: 1_200_000, statedOn: "2026-08-01", statedBy: "provider answer" }, citation: { chunkIds: ["g3:c0"], quote: "1.2M followers on Instagram" }, confidence: 0.6, publishedAt: null },
  { kind: "reputation_event", claim: { event: "two-game suspension by the conference", stage: "official_finding_or_action", date: "2024-02-01" }, citation: { chunkIds: ["g5:c0"], quote: "suspended for two games by the conference" }, confidence: 0.8, publishedAt: "2024-02-02" },
  { kind: "reputation_event", claim: { event: "suspension reduced on appeal", stage: "resolution_or_outcome", outcome: "reduced", date: "2024-02-15" }, citation: { chunkIds: ["g5:c0"], quote: "the suspension was later reduced on appeal" }, confidence: 0.8, publishedAt: null },
  { kind: "reputation_event", claim: { event: "unstaged rumour" }, citation: { chunkIds: ["g5:c0"], quote: "suspended" }, confidence: 0.3, publishedAt: null },   // no stage → the derived layer still records it as evidence; the parser would have dropped it
], {
  S1: outcome("found_cited", { full_name: "not_found", aliases: "not_found", birth_year: "not_found", nationality: "not_found", hometown: "found_cited", sport_discipline: "found_cited", namesakes: "not_found" }, ["g0:c0"]),
  S2: outcome("found_cited", { current_affiliation: "found_cited", league_level_division: "found_cited", market: "not_found", past_affiliations: "not_found", position_role: "not_found", education_class_year: "not_found", national_team_programme: "not_applicable" }, ["g0:c0"]),
  S7: outcome("found_cited", { partnerships_deals: "found_cited", deal_categories: "found_cited", deal_dates: "found_cited", renewals_repeat: "not_found", campaigns: "not_found", published_values: "not_found", representation: "not_found", ventures: "not_found", third_party_valuations: "not_found" }, ["g3:c0"]),
  S9: outcome("found_cited", { reported_allegations: "not_found", official_findings_actions: "found_cited", resolutions_outcomes: "found_cited" }, ["g5:c0"]),
}, 0.92));

const O_TEXT_1 = "Jane Doe is a basketball guard at Example University from Shelbyville, Illinois.";
const O_TEXT_2 = "Jane Doe (actress) starred in the film Example.";
const openaiArm = arm("openai_web_search", [
  envelope("o0", "openai_web_search", "Identity + Biography + Affiliations", [{ url: "https://www.ncaa.com/jane", text: O_TEXT_1 }, { url: "https://www.moviesite.example/jane", text: O_TEXT_2 }]),
  envelope("o3", "openai_web_search", "Commercial + Brand + Representation", [], "I could not find any brand partnerships for Jane Doe."),
], extraction([
  { kind: "profile_attribute", claim: { factKey: "sport", value: { sport: "basketball" } }, citation: { chunkIds: ["o0:c0"], quote: "is a basketball guard" }, confidence: 0.9, publishedAt: null },
  { kind: "affiliation", claim: { factKey: "affiliation", value: { org: "Example University", orgKind: "school", level: "D1", season: 2026 }, timeframe: "current" }, citation: { chunkIds: ["o0:c0"], quote: "basketball guard at Example University" }, confidence: 0.9, publishedAt: null },
  { kind: "profile_attribute", claim: { factKey: "hometown", value: { city: "Shelbyville", region: "Illinois", country: "USA" } }, citation: { chunkIds: ["o0:c0"], quote: "from Shelbyville, Illinois" }, confidence: 0.7, publishedAt: null },
  { kind: "press_mention", claim: { outlet: "moviesite", headline: "Jane Doe (actress) starred in the film Example", outletContext: "mainstream", topic: "coverage" }, citation: { chunkIds: ["o0:c1"], quote: "Jane Doe (actress) starred" }, confidence: 0.5, publishedAt: null },
  { kind: "identity_signal", claim: { topic: "namesake", text: "an actress named Jane Doe appears in one source" }, citation: { chunkIds: ["o0:c1"], quote: "Jane Doe (actress)" }, confidence: 0.9, publishedAt: null },
], {
  S1: outcome("found_cited", { full_name: "not_found", aliases: "not_found", birth_year: "not_found", nationality: "not_found", hometown: "found_cited", sport_discipline: "found_cited", namesakes: "found_cited" }, ["o0:c0", "o0:c1"]),
  S2: outcome("found_cited", { current_affiliation: "found_cited", league_level_division: "not_found", market: "not_found", past_affiliations: "not_found", position_role: "found_cited", education_class_year: "not_found", national_team_programme: "not_found" }, ["o0:c0"]),
  S7: outcome("not_found", { partnerships_deals: "not_found", deal_categories: "not_found", deal_dates: "not_found", renewals_repeat: "not_found", campaigns: "not_found", published_values: "not_found", representation: "not_found", ventures: "not_found", third_party_valuations: "not_found" }, ["o0:c0", "o0:c1"]),
}, 0.7));

describe("benchmark: derive evidence, facts and item coverage by the substrate's rules + ResearchSpec v1", () => {
  const g = deriveArm(geminiArm, DEFAULT_RESEARCH_POLICY);
  const o = deriveArm(openaiArm, DEFAULT_RESEARCH_POLICY);

  it("applies lineage validation, Nomila source tiers and the resolver; evidence-only kinds never become facts", () => {
    expect(g.evidence).toHaveLength(9);
    expect(g.evidence.find((e) => e.claimedFactKey === "hometown")?.lineage).toBe("uncited");
    expect(g.evidence.find((e) => e.claimedFactKey === "sport")).toMatchObject({ sourceType: "major_news", tier: 3, section: "S1" });
    expect(o.evidence.find((e) => e.claimedFactKey === "sport")?.sourceType).toBe("official_governing_body");
    expect(g.evidence.filter((e) => e.kind === "reputation_event").map((e) => e.section)).toEqual(["S9", "S9", "S9"]);
    expect(g.facts.map((f) => f.factKey).sort()).toEqual(expect.arrayContaining(["sport", "award"]));
    expect(g.facts.some((f) => JSON.stringify(f).match(/follower|suspension|Acme/))).toBe(false);
  });

  it("derives item coverage from cited claims and keeps the extractor's reported outcomes beside it", () => {
    const s7 = g.coverage.find((c) => c.section === "S7")!;
    expect(s7).toMatchObject({ found: 3, requested: 9, reportedStatus: "found_cited", derivedStatus: "found_cited" });
    expect(s7.items.find((i) => i.item === "deal_dates")).toMatchObject({ reported: "found_cited", derived: "found_cited", agree: true });
    expect(s7.items.find((i) => i.item === "renewals_repeat")).toMatchObject({ derived: "not_found", agree: true });
    const s2g = g.coverage.find((c) => c.section === "S2")!;
    expect(s2g.items.find((i) => i.item === "league_level_division")?.derived).toBe("found_cited");
    const s1g = g.coverage.find((c) => c.section === "S1")!;
    // the extractor reported hometown found, but its only hometown claim is uncited → derived not_found, disagreement recorded
    expect(s1g.items.find((i) => i.item === "hometown")).toMatchObject({ reported: "found_cited", derived: "not_found", agree: false });
    const s9 = g.coverage.find((c) => c.section === "S9")!;
    expect(s9).toMatchObject({ found: 2, requested: 3 });
    const s7o = o.coverage.find((c) => c.section === "S7")!;
    expect(s7o).toMatchObject({ found: 0, derivedStatus: "not_found" });
    // a section the extractor did not report still gets derived coverage
    expect(o.coverage.find((c) => c.section === "S4")).toMatchObject({ reportedStatus: null, found: 0, derivedStatus: "not_found" });
    expect(g.coverage.map((c) => c.section)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"]);
  });

  it("captures social metric claims and follower mentions as evidence only", () => {
    expect(followerMentions(geminiArm.search)).toEqual([expect.objectContaining({ chunkId: "g3:c0", platform: "instagram", count: 1_200_000 })]);
    expect(g.evidence.filter((e) => e.kind === "social_metric_claim")).toHaveLength(1);
    expect(g.coverage.find((c) => c.section === "S8")!.items.find((i) => i.item === "follower_counts_as_stated")?.derived).toBe("found_cited");
  });

  it("reports sub-signal evidence coverage without producing values", () => {
    const covered = coveredSubSignals(g.evidence);
    expect(covered).toEqual(expect.arrayContaining(["athletic_authority.competition_level", "athletic_authority.rankings_recognition", "brand_fit.category_breadth", "brand_fit.brand_safety"]));
    expect(covered.some((p) => p.startsWith("audience_scale.") || p.startsWith("engagement_quality."))).toBe(false);
  });
});

describe("benchmark: identity fidelity", () => {
  it("scores anchor agreement, internal conflicts, conflation, namesakes, unsupported claims and abstention", () => {
    const g = identityFidelity(deriveArm(geminiArm, DEFAULT_RESEARCH_POLICY), GOLD, geminiArm.search);
    expect(g.aboutIdentityConfidence).toBe(0.92);
    expect(g.anchorAgreement).toMatchObject({ checked: 2, agree: 2, disagree: 0 });
    expect(g.conflated).toEqual([]);
    expect(g.unsupported).toEqual({ count: 1, share: 1 / 9 });
    expect(g.abstention.abstained).toBe(false);
    expect(g.abstention.itemsNotApplicable).toBe(1);

    const o = identityFidelity(deriveArm(openaiArm, DEFAULT_RESEARCH_POLICY), GOLD, openaiArm.search);
    expect(o.anchorAgreement.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: "hometown", agree: false })]));
    expect(o.conflated.length).toBeGreaterThanOrEqual(1);
    expect(o.namesakesReported).toBe(1);
    expect(o.abstention.sectionsNotFound).toEqual(["S7"]);
    expect(o.abstention.explicitNotFound).toBe(1);
  });

  it("treats zero claims as abstention", () => {
    const empty = arm("openai_web_search", [envelope("o0", "openai_web_search", "Identity + Biography + Affiliations", [], "The identity could not be resolved; no reliable information was found.")], extraction([], { S1: outcome("not_found", { full_name: "not_found" }) }, 0.2));
    const f = identityFidelity(deriveArm(empty, DEFAULT_RESEARCH_POLICY), null, empty.search);
    expect(f.abstention).toMatchObject({ claims: 0, abstained: true, sectionsNotFound: ["S1"] });
    expect(f.abstention.explicitNotFound).toBeGreaterThanOrEqual(1);
  });
});

describe("benchmark: cross-provider ledger", () => {
  const g = deriveArm(geminiArm, DEFAULT_RESEARCH_POLICY);
  const o = deriveArm(openaiArm, DEFAULT_RESEARCH_POLICY);
  const ledger = buildLedger("jane-doe", { gemini_grounded: g, openai_web_search: o });

  it("marks facts found by both, by one, conflicts on single-cardinality keys (with lineage), and section abstention", () => {
    const sport = ledger.find((r) => r.claimedFactKey === "sport")!;
    expect(sport.agreement).toBe("both");
    expect(sport.arms.gemini_grounded).toMatchObject({ found: true, lineage: "cited", sourceDomain: "www.espn.com", tier: 3, publishedAt: "2026-08-01" });
    expect(sport.arms.openai_web_search).toMatchObject({ found: true, sourceDomain: "www.ncaa.com", tier: 1 });
    const brand = ledger.find((r) => r.kind === "brand_mention")!;
    expect(brand).toMatchObject({ agreement: "only:gemini_grounded", section: "S7", abstained: ["openai_web_search"] });
    const homeG = ledger.find((r) => r.claimedFactKey === "hometown" && r.valueText.includes("springfield"))!;
    expect(homeG.conflict).toEqual([{ provider: "openai_web_search", valueText: expect.stringContaining("shelbyville"), lineage: "cited" }]);
    const homeO = ledger.find((r) => r.claimedFactKey === "hometown" && r.valueText.includes("shelbyville"))!;
    expect(homeO.conflict).toEqual([{ provider: "gemini_grounded", valueText: expect.stringContaining("springfield"), lineage: "uncited" }]);
    const award = ledger.find((r) => r.claimedFactKey === "award")!;
    expect(award).toMatchObject({ agreement: "only:gemini_grounded", abstained: [] });   // openai made no S4 assertion
    expect(ledger.find((r) => r.kind === "reputation_event")?.section).toBe("S9");
  });

  it("compares an athlete and aggregates without inventing Beta.1 numbers", () => {
    const c = compareAthlete(ATHLETE, [geminiArm, openaiArm], GOLD, DEFAULT_RESEARCH_POLICY, deriveArm);
    expect(c.summary.both).toBe(2);
    expect(c.summary.conflicts).toBe(2);
    expect(c.arms.gemini_grounded.coverage).toMatchObject({ itemsRequested: 63, sectionsFoundCited: 6 });   // research-spec/1.1: 63 items; S1 S2 S4 S7 S8 S9
    expect(c.arms.gemini_grounded.reputation).toEqual({ reported_allegation: 0, official_finding_or_action: 1, resolution_or_outcome: 1 });
    expect(c.arms.gemini_grounded.beta1).toMatchObject({ normalizedSignals: null, dimensionScores: null, mia: null });
    expect(c.deltas.mia).toBeNull();
    expect(c.deltas.coverage).not.toBeNull();
    const a = aggregate([c], AS_OF);
    expect(a.providers).toEqual(["gemini_grounded", "openai_web_search"]);
    expect(a.perProvider.gemini_grounded.avgClaims).toBe(9);
    expect(a.perProvider.gemini_grounded.avgSectionCoverage.S7).toBeCloseTo(3 / 9, 3);
    expect(a.perProvider.openai_web_search.abstentions).toBe(0);
    expect(a.mia.avgAbsDiff).toBeNull();
    const md = renderAthlete(c) + renderAggregate(a);
    expect(md).toContain("blocked (no parameter bundle)");
    expect(md).toContain("Factual disagreements:");
    expect(md).toContain("S7 items found");
    const csv = ledgerCsv(c.ledger, a.providers);
    expect(csv.split("\n")).toHaveLength(c.ledger.length + 1);
    expect(csv).toContain("gemini_grounded.sourceUrl");
  });
});

describe("benchmark: registry canonicalization provenance", () => {
  it("records raw and canonical values and the registry outcome on every fact-bearing record", () => {
    const g = deriveArm(geminiArm, DEFAULT_RESEARCH_POLICY);
    const award = g.evidence.find((e) => e.claimedFactKey === "award")!;
    expect(award.registry).toEqual({ status: "accepted", reason: null });
    expect(award.canonicalization).toMatchObject({ version: "claim-canonicalization/2", applied: [] });
    const brand = g.evidence.find((e) => e.kind === "brand_mention")!;
    expect(brand.registry.status).toBe("not_applicable");
    expect(brand.canonicalization).toBeNull();
    expect(g.registry).toMatchObject({ accepted: expect.any(Number), acceptedCanonicalized: 0, notApplicable: expect.any(Number) });
    expect(g.coverage.map((c) => c.section)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"]);
    expect(deriveArm({ ...geminiArm, athleteKey: "minor" }, DEFAULT_RESEARCH_POLICY, true).coverage.map((c) => c.section)).toContain("S9");   // a minor is asked the same sections
  });
});
