/** direct-evidence/2 + item-mapping/1 — provider-facing contract without Nomila vocabulary; deterministic mapping; scoring boundary. No network. */

import { describe, expect, it } from "@jest/globals";
import { validateFactValue } from "../factRegistry";
import { contractForV2, DERIVED_ITEM_PROSE_PROJECTIONS, DERIVED_ITEMS, directDegenerateV2, directRequestV2, FORBIDDEN_IN_V2_CONTRACT, ITEM_SHAPES, itemsFor, parseDirectEvidenceV2, projectQueryProse } from "./directEvidenceV2";
import { deriveCareerStatus, ITEM_MAPPINGS, mapFinding, mapFindings, RESEARCH_FINDING_KIND } from "./itemMapping";
import { compileRequest, FORBIDDEN_IN_REQUESTS, QUERIES, SECTIONS, sectionsFor } from "./researchSpecV1";

const all = sectionsFor(false);
const ADULT = { fullName: "Jane Doe", sport: "basketball", anchor: "basketball athlete, Example University", isMinor: false };
const Q = (id: string) => QUERIES.find((q) => q.id === id)!;
const lineage = { level: "native_retrieved" as const, match: "url_exact" as const, boundChunkIds: ["od0:c0"], boundSources: [], detail: null, bindingMethod: "none" as const };
const finding = (item: string, value: Record<string, unknown>, section: any = "S1") => ({ section, item, value, statement: "s", asOf: "2026-09-13", sources: [{ url: "https://www.ncaa.com/x", title: null, publishedAt: null, quote: "q" }], lineage });

describe("direct-evidence/2 contract", () => {
  it("covers every research-spec/1 item except derived ones, with a shape, and exposes no Nomila vocabulary", () => {
    const specItems = SECTIONS.flatMap((s) => s.items.map((i) => i.id));
    for (const id of specItems) if (!DERIVED_ITEMS.has(id)) expect(ITEM_SHAPES[id]).toBeDefined();
    expect(DERIVED_ITEMS.has("current_status")).toBe(true);
    // derived items have no provider-facing shape at all and never appear in any query's contract or request text
    for (const id of DERIVED_ITEMS) {
      expect(ITEM_SHAPES[id]).toBeUndefined();
      for (const q of QUERIES) {
        expect(itemsFor(q, all).map((i) => i.id)).not.toContain(id);
        expect(contractForV2(q, all)).not.toContain(id);
        expect(directRequestV2(ADULT, q, all, "2026-09-13")).not.toContain(id);
      }
    }
    for (const q of QUERIES) {
      const c = contractForV2(q, all);
      const asked = itemsFor(q, all).map((i) => i.id);
      for (const id of asked) expect(c).toContain(`"${id}": {`);
      for (const id of specItems) if (!asked.includes(id)) expect(c).not.toContain(`"${id}": {`);
      for (const re of FORBIDDEN_IN_V2_CONTRACT) expect(c).not.toMatch(re);
      const req = directRequestV2(ADULT, q, all, "2026-09-13");
      for (const re of [...FORBIDDEN_IN_REQUESTS, ...FORBIDDEN_IN_V2_CONTRACT]) expect(req).not.toMatch(re);
      expect(req).not.toContain("FOUND / NOT FOUND / CONFLICTING / NOT APPLICABLE");
    }
    expect(itemsFor(Q("Q6"), all).map((i) => i.id)).not.toContain("current_status");
    expect(itemsFor(Q("Q1"), all)).toHaveLength(14);
  });

  it("Q6 v2 asks for the underlying career evidence but never the current_status classification; the frozen spec still does", () => {
    const MINOR = { ...ADULT, isMinor: true };
    for (const subject of [ADULT, MINOR]) {
      const spec = compileRequest(subject, Q("Q6"), "2026-09-13");
      const v2 = directRequestV2(subject, Q("Q6"), all, "2026-09-13");
      // the frozen spec keeps asking (canonical statement of what Nomila needs to know) …
      expect(spec).toMatch(/current status \(active, injured or out this season/);
      // … the v2 request projects it out: no status prompt, no classification vocabulary as a request
      expect(v2).not.toMatch(/current status/i);
      expect(v2).not.toMatch(/\(active, injured or out this season/);
      expect(v2).not.toContain("current_status");
      // the evidence the derivation needs is still asked, in the frozen wording
      for (const phrase of ["transfers, signings or promotions in the last 12 months", "injuries or\n   recoveries in the last 12 months", "milestones or major selections in the last 12 months", "retirement or\n   comeback announcements"]) expect(v2).toContain(phrase);
      expect(v2).toContain("9. Career status and recent developments — items: transfers, signings or promotions");
      // head, minor line and the reputation prose are carried unchanged from the spec
      expect(v2.split("\n\n")[0]).toBe(spec.split("\n\n")[0]);
      expect(v2).toContain(subject.isMinor ? "10. Reputation — for this minor athlete" : "10. Reputation — items, kept strictly apart");
      // and the item id is absent from the JSON contract while the evidence items are present
      for (const id of ["transfers_signings", "injuries", "milestones_selections", "retirement_comeback"]) expect(v2).toContain(`"${id}": {`);
    }
    // every derived item has a projection, and the projection must match the frozen prose (a silent no-op would ask the provider to classify)
    for (const id of DERIVED_ITEMS) expect(DERIVED_ITEM_PROSE_PROJECTIONS.some((p) => p.item === id)).toBe(true);
    expect(() => projectQueryProse({ ...Q("Q6"), text: () => "9. Career status — items: transfers only." }, false)).toThrow(/derived item current_status not found/);
    // queries without a derived item are passed through byte-for-byte
    for (const q of QUERIES.filter((x) => x.id !== "Q6")) expect(projectQueryProse(q, false)).toBe(q.text(false));
  });

  it("parses items, findings, sources and identity; unknown items are reported, derived items are never asked", () => {
    const json = JSON.stringify({ contract: "direct-evidence/2", query: "Q1", identity: { anchor_match: "matched", confidence: 0.97, namesakes: [] }, items: {
      full_name: { status: "found", findings: [{ value: { full: "Jane Doe" }, statement: "Her name is Jane Doe.", as_of: "2026-09-13", sources: [{ url: "https://www.ncaa.com/x", quote: "Jane Doe" }] }] },
      current_status: { status: "found", findings: [] },
      birth_year: { status: "not_found", findings: [] },
    } });
    const p = parseDirectEvidenceV2(json, Q("Q1"), all);
    expect(p.parseError).toBeNull();
    expect(p.items.full_name).toMatchObject({ status: "found", findings: [expect.objectContaining({ section: "S1", item: "full_name", value: { full: "Jane Doe" }, lineage: expect.objectContaining({ level: "asserted_only" }) })] });
    expect(p.items.birth_year).toMatchObject({ status: "not_found", findings: [] });
    expect(p.unknownItems).toEqual(["current_status"]);
    expect(directDegenerateV2(p, 10, 14).degenerate).toBe(false);
    const empty = parseDirectEvidenceV2(JSON.stringify({ identity: { anchor_match: "matched", confidence: 0.9 }, items: { full_name: { status: "not_found", findings: [] } } }), Q("Q1"), all);
    expect(directDegenerateV2(empty, 12, 14).reason).toMatch(/zero findings although the identity was matched/);
    const abst = parseDirectEvidenceV2(JSON.stringify({ identity: { anchor_match: "not_resolved", confidence: 0.1 }, items: { full_name: { status: "not_found", findings: [] } } }), Q("Q1"), all);
    expect(directDegenerateV2(abst, 12, 14).degenerate).toBe(false);
  });
});

describe("item-mapping/1", () => {
  it("maps items to registry keys deterministically and the values validate against the strict registry", () => {
    const cases: [string, Record<string, unknown>, string, Record<string, unknown>][] = [
      ["full_name", { full: "Jane Doe" }, "name", { full: "Jane Doe" }],
      ["nationality", { country: "United States" }, "nationality", { country: "United States" }],
      ["hometown", { city: "Springfield", region: "Illinois", country: "USA" }, "hometown", { city: "Springfield", region: "Illinois", country: "USA" }],
      ["sport_discipline", { sport: "basketball" }, "sport", { sport: "basketball" }],
      ["position_role", { position: "Guard", role: "starter" }, "position", { text: "Guard" }],
      ["current_affiliation", { organization: "Indiana Fever", organization_type: "pro", league: "WNBA", city: "Indianapolis", country: "United States", from: "2024" }, "affiliation", { org: "Indiana Fever", orgKind: "pro", from: "2024" }],
      ["national_team_programme", { team: "U.S. U-17 WNT", age_group: "U-17", year: "2022" }, "national_team_participation", { team: "U.S. U-17 WNT", level: "U-17", year: 2022 }],
      ["rankings", { body: "ESPN", rank: "#3", year: "2023", scope: "Class of 2024" }, "ranking", { body: "ESPN", rank: 3, year: 2023, scope: "Class of 2024" }],
      ["third_party_valuations", { estimator: "On3", value: "3.1M", currency: "$", year: "2025" }, "nil_mention", { source: "On3", value: "$ 3.1M", year: 2025 }],
    ];
    for (const [item, value, factKey, expected] of cases) {
      const out = mapFinding(finding(item, value));
      expect(out).toHaveLength(1);
      expect(out[0].claim.factKey).toBe(factKey);
      expect(out[0].claim.value).toEqual(expected);
      expect(() => validateFactValue(factKey, out[0].claim.value)).not.toThrow();
      expect(mapFinding(finding(item, value))).toEqual(out);   // deterministic
    }
    // descriptive fields ride beside the value (partial), never inside it
    const aff = mapFinding(finding("current_affiliation", { organization: "Indiana Fever", organization_type: "pro", league: "WNBA", city: "Indianapolis", country: "United States", from: "2024" }))[0];
    expect(aff.registryStatus).toBe("partial");
    expect(aff.claim).toMatchObject({ timeframe: "current", league: "WNBA", market: "Indianapolis, United States" });
  });

  it("splits a multi-year award into one dated claim per year, without inventing a level", () => {
    const out = mapFinding(finding("awards_selections", { name: "WNBA All-Star", years: [2024, 2025, 2026], awarded_by: "WNBA" }, "S4"));
    expect(out.map((c) => c.claim.value)).toEqual([{ name: "WNBA All-Star", year: 2024, org: "WNBA" }, { name: "WNBA All-Star", year: 2025, org: "WNBA" }, { name: "WNBA All-Star", year: 2026, org: "WNBA" }]);
    expect(out.every((c) => !("level" in (c.claim.value as object)))).toBe(true);   // level stays unknown until registry v2 / a deterministic lookup
    const scoped = mapFinding(finding("awards_selections", { name: "All-Big Ten", year: "2024", scope: "conference" }, "S4"))[0];
    expect(scoped.claim.value).toEqual({ name: "All-Big Ten", year: 2024, level: "conference" });   // only when the source stated it
    expect(() => validateFactValue("award", scoped.claim.value)).not.toThrow();
  });

  it("keeps sourced findings with no registry key as evidence, never as registry candidates; commercial relationships are never nil_mention", () => {
    const deal = mapFinding(finding("partnerships_deals", { brand: "Gainbridge", deal_type: "sponsorship", start: "2024-03-05" }, "S7"))[0];
    // registry v2 (Step 3): a deal maps to `endorsement` (never nil_mention); a statistic maps to `season_statistic`
    expect(deal).toMatchObject({ kind: "brand_mention", registryStatus: "partial", claim: { factKey: "endorsement", value: { brand: "Gainbridge", dealType: "sponsorship", startDate: "2024-03-05" }, brand: "Gainbridge", type: "sponsorship" } });
    expect(() => validateFactValue("endorsement", deal.claim.value)).not.toThrow();
    const stat = mapFinding(finding("season_statistics", { season: "2024", metric: "points per game", value: "19.2" }, "S4"))[0];
    expect(stat).toMatchObject({ kind: "achievement", registryStatus: "mapped", claim: { factKey: "season_statistic", value: { season: 2024, metric: "points per game", value: "19.2" } } });
    const unknownItem = mapFinding(finding("something_new", { text: "x" }))[0];
    expect(unknownItem).toMatchObject({ kind: RESEARCH_FINDING_KIND, registryStatus: "unmapped" });
    const followers = mapFinding(finding("follower_counts_as_stated", { platform: "instagram", metric: "followers", value: "1.2M", stated_on: "2026-08-01" }, "S8"))[0];
    expect(followers).toMatchObject({ kind: "social_metric_claim", registryStatus: "unmapped" });
    const rep = mapFinding(finding("reported_allegations", { event: "x", date: "2025-01-01" }, "S9"))[0];
    expect(rep).toMatchObject({ kind: "reputation_event", claim: { stage: "reported_allegation" }, registryStatus: "unmapped" });
    // a mapped item whose value carries nothing usable falls back to evidence with the intended key recorded
    const empty = mapFinding(finding("education_class_year", { class_year_label: "" }, "S2"))[0];   // item-mapping/4: a degree alone now yields an education claim
    expect(empty).toMatchObject({ kind: RESEARCH_FINDING_KIND, registryStatus: "unmapped", claim: { intendedFactKey: "class_year" } });
    expect(Object.values(ITEM_MAPPINGS).every((m) => m.factKey !== "career_status")).toBe(true);
  });

  it("derives career_status deterministically and never from a provider status item", () => {
    expect(deriveCareerStatus([finding("retirement_comeback", { event: "announced her retirement", date: "2024-09-08" }, "S3"), finding("current_affiliation", { organization: "San Diego Wave" })])).toMatchObject({ status: "retired" });
    // Step 3 (approved rule): only explicit cited retirement derives a status; comeback, affiliation and injury stay unknown
    expect(deriveCareerStatus([finding("retirement_comeback", { event: "returned from retirement", date: "2025-01-01" }, "S3")])).toMatchObject({ status: null });
    expect(deriveCareerStatus([finding("current_affiliation", { organization: "Indiana Fever" })])).toEqual({ status: null, basis: null });
    expect(deriveCareerStatus([finding("injuries", { event: "torn ACL", status: "out for the season" }, "S3")])).toEqual({ status: null, basis: null });
    expect(deriveCareerStatus([])).toEqual({ status: null, basis: null });
    expect(mapFindings([finding("current_status", { status: "active" }, "S3")])[0]).toMatchObject({ kind: RESEARCH_FINDING_KIND, registryStatus: "unmapped" });
  });
});
