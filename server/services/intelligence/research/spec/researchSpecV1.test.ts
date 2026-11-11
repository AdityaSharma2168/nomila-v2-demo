/** research-spec/1 — the frozen text, provider neutrality, minor handling, item coverage derivation. Pure. */

import { describe, expect, it } from "@jest/globals";
import { SECTION_OUTCOMES, buildCitedExtractionPromptV3, parseCitedExtractionV3 } from "./extractionV3";
import { compileRequest, compileSystemInstruction, deriveSectionStatus, FORBIDDEN_IN_REQUESTS, QUERIES, RESEARCH_SPEC_VERSION, SECTIONS, sectionCoverage, sectionOf, sectionsFor, SYSTEM_INSTRUCTION, type ClaimView } from "./researchSpecV1";

const ADULT = { fullName: "Jane Doe", sport: "basketball", anchor: "basketball athlete, Example University", isMinor: false };
const MINOR = { ...ADULT, fullName: "Kid Doe", isMinor: true };

describe("research-spec/1", () => {
  it("has nine sections with 63 requested items (research-spec/1.1: + athlete_media and seven S6 identity items), asked identically for a minor (minimization, not a reduced model)", () => {
    expect(RESEARCH_SPEC_VERSION).toBe("research-spec/1.1");
    expect(SECTIONS.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"]);
    expect(SECTIONS.reduce((a, s) => a + s.items.length, 0)).toBe(63);
    expect(sectionsFor(true).map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"]);
    const ids = SECTIONS.flatMap((s) => s.items.map((i) => `${s.id}.${i.id}`));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("compiles identical request text for every provider, and the system instruction differs only by the tool name", () => {
    const asOf = "2026-09-13";
    for (const q of QUERIES) {
      const text = compileRequest(ADULT, q, asOf);
      expect(text.startsWith("Athlete identity anchor: basketball athlete, Example University\nAthlete: Jane Doe — basketball\nAs-of date: 2026-09-13\n\n")).toBe(true);
      expect(text).toContain("FOUND / NOT FOUND / CONFLICTING / NOT APPLICABLE");
      for (const re of FORBIDDEN_IN_REQUESTS) expect(text).not.toMatch(re);
    }
    expect(compileSystemInstruction("openai")).toBe(SYSTEM_INSTRUCTION);
    expect(compileSystemInstruction("gemini")).toBe(SYSTEM_INSTRUCTION.replace("Always use web search", "Always use Google Search"));
    expect(compileSystemInstruction("gemini").split("Google Search")).toHaveLength(2);
    for (const re of FORBIDDEN_IN_REQUESTS) expect(SYSTEM_INSTRUCTION).not.toMatch(re);
    expect(SYSTEM_INSTRUCTION).toContain("Describe, do not rate");
    expect(SYSTEM_INSTRUCTION).not.toMatch(/richer dossier/);
  });

  it("compiles a minor Q1 that never seeks an exact date of birth or a home address, keeps hometown at city/region, and a minor Q6 narrowed to material public matters", () => {
    const q1 = QUERIES.find((q) => q.id === "Q1")!;
    const body = q1.text(true);
    expect(body).toMatch(/birth year or age band \(not an exact date of birth\)/);
    expect(body).toMatch(/hometown \(city or region, never a home or street address\)/);
    expect(body).not.toMatch(/birth year or date;/);
    expect(q1.text(false)).toMatch(/birth year or date; nationality; hometown/);
    const q6 = QUERIES.find((q) => q.id === "Q6")!;
    expect(q6.text(true)).toContain("10. Reputation — for this minor athlete report only documented, materially relevant public matters");
    expect(q6.text(true)).toMatch(/official\s+eligibility rulings; suspensions; governing-body findings; doping findings; disciplinary actions/);
    expect(q6.text(true)).toMatch(/no rumors/);
    expect(q6.text(false)).toContain("10. Reputation — items, kept strictly apart");
    expect(compileRequest(MINOR, q1, "2026-09-13")).toContain("This athlete is a minor. Collect the same publicly sourced");
    expect(compileRequest(ADULT, q1, "2026-09-13")).not.toContain("minor");
    for (const q of QUERIES) if (q.id !== "Q1" && q.id !== "Q6") expect(q.text(true)).toBe(q.text(false));
  });

  it("maps kinds and fact keys to sections", () => {
    expect(sectionOf("profile_attribute", "hometown")).toBe("S1");
    expect(sectionOf("profile_attribute", "career_status")).toBe("S3");
    expect(sectionOf("affiliation", "affiliation")).toBe("S2");
    expect(sectionOf("achievement", "award")).toBe("S4");
    expect(sectionOf("press_mention", null)).toBe("S5");
    expect(sectionOf("narrative_claim", null)).toBe("S6");
    expect(sectionOf("nil_mention", "nil_mention")).toBe("S7");
    expect(sectionOf("social_metric_claim", null)).toBe("S8");
    expect(sectionOf("reputation_event", null)).toBe("S9");
    expect(sectionOf("signal", null)).toBeNull();
  });

  it("derives item coverage from cited claims and the section status from items", () => {
    const s7 = SECTIONS.find((s) => s.id === "S7")!;
    const claims: ClaimView[] = [
      { kind: "brand_mention", claimedFactKey: null, claim: { brand: "Acme", type: "sponsorship", category: "apparel", renewal: true }, cited: true },
      { kind: "representation", claimedFactKey: null, claim: { agency: "Agency X" }, cited: false },   // uncited: does not count
    ];
    const cov = sectionCoverage(s7, claims, { status: "found_cited", items: { partnerships_deals: "found_cited", representation: "found_cited", ventures: "not_applicable" }, reviewedChunkIds: [], conflicts: [], reason: null });
    expect(cov.items.find((i) => i.item === "partnerships_deals")).toMatchObject({ reported: "found_cited", derived: "found_cited", agree: true });
    expect(cov.items.find((i) => i.item === "deal_categories")).toMatchObject({ reported: null, derived: "found_cited", agree: null });
    expect(cov.items.find((i) => i.item === "renewals_repeat")?.derived).toBe("found_cited");
    expect(cov.items.find((i) => i.item === "representation")).toMatchObject({ reported: "found_cited", derived: "not_found", agree: false });
    expect(cov).toMatchObject({ found: 3, requested: 9, derivedStatus: "found_cited" });
    expect(deriveSectionStatus({ a: "not_found", b: "conflicting" })).toBe("conflicting");
    expect(deriveSectionStatus({ a: "not_applicable", b: "not_applicable" })).toBe("not_applicable");
    expect(deriveSectionStatus({ a: "not_applicable", b: "not_found" })).toBe("not_found");
    expect(deriveSectionStatus({})).toBe("not_found");
  });
});

describe("cited-claims/3 prompt and parser", () => {
  it("names every section and item in scope, fences chunks as untrusted data, and never asks for a tier", () => {
    const prompt = buildCitedExtractionPromptV3([{ id: "g0", provider: "p", queryName: "Q1", query: "q", fetchedAt: "t", answerText: "a", chunks: [{ id: "g0:c0", url: "https://x.example/1", domain: "x.example", title: null, text: "Jane Doe plays.", textKind: "provider_answer_segments" }], supports: [], raw: null, request: {}, errors: [] }], { athleteId: "a", fullName: "Jane Doe", aliases: [], sport: "basketball", currentAffiliation: null, hometown: null, knownHandles: {} }, sectionsFor(true).filter((x) => x.id !== "S9"));
    expect(prompt).toContain("S8 Public & social presence: official_accounts");
    expect(prompt).not.toContain("S9 ");
    expect(prompt).toContain("<<<UNTRUSTED_WEB_DATA");
    expect(prompt).not.toMatch(/tier\s*\d|brand quality score|safety score/i);
  });

  it("parses section outcomes per asked item, keeps only staged reputation events and known kinds", () => {
    const raw = JSON.stringify({
      claims: [
        { kind: "reputation_event", claim: { event: "x", stage: "reported_allegation", date: "2025-01-01" }, citation: { chunkIds: ["g0:c0"], quote: "x" }, confidence: 0.5 },
        { kind: "reputation_event", claim: { event: "no stage" }, citation: { chunkIds: ["g0:c0"], quote: "x" } },
        { kind: "social_metric_claim", claim: { platform: "instagram", metric: "followers", metricValue: 100 }, citation: { chunkIds: ["g0:c0"], quote: "100 followers" } },
        { kind: "brand_quality_tier", claim: { tier: 1 }, citation: { chunkIds: ["g0:c0"], quote: "x" } },
      ],
      about_identity_confidence: 0.8,
      section_outcomes: {
        S9: { status: "found_cited", items: { reported_allegations: "found_cited", official_findings_actions: "not_found", resolutions_outcomes: "bogus", extra_item: "found_cited" }, reviewedChunkIds: ["g0:c0"], conflicts: [{ item: "reported_allegations", values: [{ value: "a", chunkIds: ["g0:c0"] }] }] },
        S1: { status: "nonsense", items: {} },
        S3: { status: "not_applicable", items: { current_status: "not_applicable" }, reason: "retired decades ago" },
      },
    });
    const p = parseCitedExtractionV3(raw, sectionsFor(false));
    expect(p.claims.map((c) => c.kind)).toEqual(["reputation_event", "social_metric_claim"]);
    expect(p.aboutIdentityConfidence).toBe(0.8);
    expect(p.sectionOutcomes.S9).toMatchObject({ status: "found_cited", items: { reported_allegations: "found_cited", official_findings_actions: "not_found" }, reviewedChunkIds: ["g0:c0"] });
    expect(p.sectionOutcomes.S9!.items).not.toHaveProperty("resolutions_outcomes");
    expect(p.sectionOutcomes.S9!.items).not.toHaveProperty("extra_item");
    expect(p.sectionOutcomes.S9!.conflicts).toHaveLength(1);
    expect(p.sectionOutcomes.S1!.status).toBe("not_found");
    expect(p.sectionOutcomes.S3).toMatchObject({ status: "not_applicable", reason: "retired decades ago" });
    expect(parseCitedExtractionV3("not json", sectionsFor(false)).parseError).toBeTruthy();
    expect(SECTION_OUTCOMES).toEqual(["found_cited", "not_found", "conflicting", "not_applicable"]);
  });

  it("ignores outcomes for sections that were not asked", () => {
    const p = parseCitedExtractionV3(JSON.stringify({ claims: [], section_outcomes: { S9: { status: "found_cited", items: {} } } }), sectionsFor(true).filter((x) => x.id !== "S9"));
    expect(p.sectionOutcomes.S9).toBeUndefined();
  });
});
