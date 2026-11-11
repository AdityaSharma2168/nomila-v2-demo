/**
 * item-mapping/2 + deterministic career status (Phase A Step 4, Step 3): the provider researches observable evidence,
 * Nomila derives classifications. In this slice ONLY retired is derived, from explicit cited retirement language;
 * comeback, injury and current-affiliation readings are recognised but derive nothing until decided separately. Registry v2 keys reached through the mapping. No network.
 */

import { describe, expect, it } from "@jest/globals";
import { validateFactValue } from "../factRegistry";
import { canonicalizeValue } from "./canonicalize";
import type { Finding } from "./directEvidenceV2";
import { affiliationNamedIn, captaincyAffiliation, captaincyOf, classifyRetirementLanguage, deriveCareerStatus, INSTITUTION_REF, ITEM_MAPPING_VERSION, ITEM_MAPPINGS, mapFinding, mapFindings, participationYear, RESEARCH_FINDING_KIND } from "./itemMapping";

const cited = { level: "native_retrieved" as const, match: "url_exact" as const, boundChunkIds: ["od0:c0"], boundSources: [], detail: null, bindingMethod: "none" as const };
const asserted = { level: "asserted_only" as const, match: "none" as const, boundChunkIds: [], boundSources: [], detail: "not yet validated", bindingMethod: "none" as const };
const finding = (item: string, value: Record<string, unknown>, section: any = "S3", lineage: Finding["lineage"] = cited, statement = "s"): Finding =>
  ({ section, item, value, statement, asOf: "2026-09-13", sources: [{ url: "https://www.example.com/x", title: null, publishedAt: null, quote: "q" }], lineage });
const status = (...fs: Finding[]) => deriveCareerStatus(fs).status;
const rc = (event: string, date = "2024-09-08") => finding("retirement_comeback", { event, date });

describe("career status: retired only on explicit, cited retirement language", () => {
  it("explicit retired / announced retirement / retired from … can produce retired", () => {
    for (const e of ["announced her retirement", "retired from professional soccer in 2024", "has retired", "retires after 15 seasons", "announced his retirement from the national team", "called time on her career", "hung up his boots"]) {
      expect(deriveCareerStatus([rc(e)])).toMatchObject({ status: "retired", basis: expect.stringContaining(e) });
      expect(classifyRetirementLanguage(e)).toBe("retirement");
    }
  });

  it("a former team or no current team does not", () => {
    expect(status(finding("past_affiliations", { organization: "Chelsea", organization_type: "pro", from: "2015", to: "2019" }, "S2"))).toBeNull();
    expect(status(finding("current_affiliation", { organization: "Chelsea", organization_type: "pro", from: "2015", to: "2019" }, "S2"))).toBeNull();   // ended affiliation ≠ retired
    expect(status(finding("current_affiliation", { organization: "Chelsea", organization_type: "pro", from: "2024" }, "S2"))).toBeNull();   // a current team ≠ active in this slice either
    expect(status(rc("former Chelsea striker, last with Aston Villa"))).toBeNull();
    expect(status(rc("currently without a club"))).toBeNull();
  });

  it("old age does not", () => {
    expect(status(finding("birth_year", { year: 1961 }, "S1"))).toBeNull();
    expect(status(finding("birth_year", { year: 1961 }, "S1"), rc("now aged 65"))).toBeNull();
  });

  it("long inactivity does not", () => {
    expect(status(finding("milestones_selections", { event: "last competitive match", date: "2016-05-01" }))).toBeNull();
    expect(status(rc("has not played a competitive match since 2016"))).toBeNull();
    expect(status(rc("no results recorded in the last five seasons"))).toBeNull();
  });

  it("historic career language does not", () => {
    for (const e of ["played for Arsenal from 2001 to 2010 and later coached the academy", "was a two-time champion with the club", "spent a decade in the WNBA before moving into broadcasting", "her playing days at Stanford"]) expect(status(rc(e))).toBeNull();
  });

  it("ambiguous, hedged, future, negated or jersey-number language remains unknown, never retired", () => {
    const cases = ["considering retirement", "will retire at the end of the season", "is retiring at the end of this season", "hinted at retirement", "denied retirement rumours", "farewell tour announced", "retirement speculation grows", "the club retired her number 10 jersey", "has no plans to retire", "reportedly weighing retirement", "may retire after the Olympics", "final season before retirement"];
    for (const e of cases) {
      const d = deriveCareerStatus([rc(e)]);
      expect(d.status).toBeNull();
      expect(d.basis).toMatch(/^ambiguous /);
      expect(classifyRetirementLanguage(e)).toBe("ambiguous");
    }
    expect(classifyRetirementLanguage("")).toBe("ambiguous");
  });

  it("explicit comeback language is recognised but derives nothing in this slice (unknown, not active)", () => {
    for (const e of ["came out of retirement", "returned from retirement to sign with Lyon", "announced a comeback"]) {
      expect(classifyRetirementLanguage(e)).toBe("comeback");
      const d = deriveCareerStatus([rc(e)]);
      expect(d.status).toBeNull();
      expect(d.basis).toMatch(/^comeback \(not derived in this slice\)/);
    }
    // the most recent dated event is the one read: a later comeback or ambiguity cancels an earlier retirement
    expect(status(rc("announced her retirement", "2022-01-01"), rc("came out of retirement", "2024-03-01"))).toBeNull();
    expect(status(rc("came out of retirement", "2020-03-01"), rc("announced her retirement", "2024-01-01"))).toBe("retired");
    expect(status(rc("announced her retirement", "2024-01-01"), rc("considering a comeback", "2025-01-01"))).toBeNull();
  });

  it("a current affiliation and a season-ending injury derive nothing in this slice (unknown)", () => {
    expect(deriveCareerStatus([finding("current_affiliation", { organization: "Indiana Fever" }, "S2")])).toEqual({ status: null, basis: null });
    expect(deriveCareerStatus([finding("injuries", { event: "torn ACL", status: "out for the season" })])).toEqual({ status: null, basis: null });
    expect(deriveCareerStatus([finding("current_affiliation", { organization: "Indiana Fever" }, "S2"), finding("injuries", { event: "torn ACL", status: "out for the season" })])).toEqual({ status: null, basis: null });
  });

  it("only accepted provenance can derive retired; asserted-only or unsupported retirement evidence leaves it unknown", () => {
    const unsupported = { level: "unsupported" as const, match: "none" as const, boundChunkIds: [], boundSources: [], detail: "no source given", bindingMethod: "none" as const };
    expect(status(finding("retirement_comeback", { event: "announced her retirement", date: "2024-09-08" }, "S3", asserted))).toBeNull();
    expect(status(finding("retirement_comeback", { event: "announced her retirement", date: "2024-09-08" }, "S3", unsupported))).toBeNull();
    expect(status(finding("retirement_comeback", { event: "announced her retirement", date: "2024-09-08" }, "S3", asserted), finding("current_affiliation", { organization: "Indiana Fever" }, "S2"))).toBeNull();
    expect(status(finding("retirement_comeback", { event: "announced her retirement", date: "2024-09-08" }, "S3", { ...cited, level: "native_supported" }))).toBe("retired");
  });

  it("the derivation is deterministic and order-independent; nothing else ever yields a status", () => {
    expect(deriveCareerStatus([])).toEqual({ status: null, basis: null });
    const fs = [rc("announced her retirement", "2024-01-01"), finding("injuries", { event: "x", status: "out for the season" }), finding("current_affiliation", { organization: "Indiana Fever" }, "S2")];
    expect(deriveCareerStatus(fs)).toMatchObject({ status: "retired" });
    expect(deriveCareerStatus(fs)).toEqual(deriveCareerStatus([...fs]));
    expect(deriveCareerStatus([...fs].reverse())).toEqual(deriveCareerStatus(fs));
    for (const d of [deriveCareerStatus(fs), deriveCareerStatus([rc("considering retirement")]), deriveCareerStatus([])]) expect([null, "retired"]).toContain(d.status);
  });

  it("the evidence row keeps the same reading: eventKind retirement | comeback | retirement_comeback (ambiguous)", () => {
    expect(mapFinding(rc("announced her retirement"))[0].claim).toMatchObject({ eventKind: "retirement" });
    expect(mapFinding(rc("came out of retirement"))[0].claim).toMatchObject({ eventKind: "comeback" });
    expect(mapFinding(rc("considering retirement"))[0].claim).toMatchObject({ eventKind: "retirement_comeback" });
    expect(mapFindings([finding("current_status", { status: "retired" })])[0]).toMatchObject({ kind: RESEARCH_FINDING_KIND, registryStatus: "unmapped" });   // a provider status is never a fact
  });
});

describe("item-mapping/2 onto registry v2", () => {
  const accepted = (key: string, value: unknown) => validateFactValue(key, canonicalizeValue(key, value).value);

  it("is versioned and deterministic", () => {
    expect(ITEM_MAPPING_VERSION).toBe("item-mapping/5");
    const f = finding("partnerships_deals", { brand: "Gainbridge", deal_type: "sponsorship", start: "2024-03-05", category: "insurance", renewal: "true" }, "S7");
    expect(mapFinding(f)).toEqual(mapFinding(f));
  });

  it("commercial relationships map to `endorsement` (never nil_mention); descriptive fields ride beside the value", () => {
    const deal = mapFinding(finding("partnerships_deals", { brand: "Gainbridge", deal_type: "sponsorship", start: "2024-03-05", category: "insurance", renewal: "true", published_value: "1.2M", currency: "USD" }, "S7"))[0];
    expect(deal).toMatchObject({ kind: "brand_mention", registryStatus: "partial", claim: { factKey: "endorsement", value: { brand: "Gainbridge", dealType: "sponsorship", startDate: "2024-03-05", category: "insurance" }, renewal: true, publishedValue: "1.2M", currency: "USD" } });
    expect(() => accepted("endorsement", deal.claim.value)).not.toThrow();
    expect(accepted("endorsement", { brand: "Gainbridge", deal_type: "Brand ambassador" })).toEqual({ brand: "Gainbridge", dealType: "ambassador" });
    // a deal without a brand reaches the registry and is refused there — it is not silently completed
    const noBrand = mapFinding(finding("partnerships_deals", { deal_type: "sponsorship", start: "2024-03-05" }, "S7"))[0];
    expect(noBrand.claim.factKey).toBe("endorsement");
    expect(() => accepted("endorsement", noBrand.claim.value)).toThrow();
    expect(mapFinding(finding("third_party_valuations", { estimator: "On3", value: "3.1M", currency: "$", year: "2025" }, "S7"))[0].claim.factKey).toBe("nil_mention");
  });

  it("season statistics map to `season_statistic`; a YYYY-YY season resolves to its first year", () => {
    const stat = mapFinding(finding("season_statistics", { season: "2024-25", metric: "points per game", value: "19.2", competition: "WNBA" }, "S4"))[0];
    expect(stat).toMatchObject({ kind: "achievement", registryStatus: "mapped", claim: { factKey: "season_statistic", value: { metric: "points per game", value: "19.2", season: 2024, competition: "WNBA" } } });
    expect(() => accepted("season_statistic", stat.claim.value)).not.toThrow();
    const noSeason = mapFinding(finding("season_statistics", { metric: "goals", value: "12" }, "S4"))[0];
    expect(() => accepted("season_statistic", noSeason.claim.value)).toThrow();   // year required; nothing invented
  });

  it("aliases: a bundled list splits into one claim each; the kind defaults to nickname only because the item is `aliases`", () => {
    const out = mapFinding(finding("aliases", { aliases: [{ text: "CC" }, { text: "@caitlin", type: "handle" }, "Clark"] }, "S1"));
    expect(out.map((c) => c.claim.value)).toEqual([{ text: "CC", kind: "nickname" }, { text: "@caitlin", kind: "handle_name" }, { text: "Clark", kind: "nickname" }]);
    for (const c of out) expect(() => accepted("alias", c.claim.value)).not.toThrow();
    expect(mapFinding(finding("aliases", { text: "Chef", type: "maiden" }, "S1"))[0].claim.value).toEqual({ text: "Chef", kind: "maiden" });
  });

  it("national-team participation: the team may be omitted only when the item establishes the programme and level + year are stated", () => {
    const noTeam = mapFinding(finding("national_team_programme", { age_group: "U-17", year: "2022" }, "S2"))[0];
    expect(noTeam.claim.value).toEqual({ level: "U-17", year: 2022 });
    expect(() => accepted("national_team_participation", noTeam.claim.value)).not.toThrow();
    expect(() => accepted("national_team_participation", mapFinding(finding("national_team_programme", { team: "USWNT U-17", year: "2022" }, "S2"))[0].claim.value)).toThrow();   // no level → refused
    expect(() => accepted("national_team_participation", mapFinding(finding("national_team_programme", { team: "USWNT U-17", age_group: "U-17" }, "S2"))[0].claim.value)).toThrow();   // no year → refused
  });

  it("birth year maps to the v2 `birth_year` key (year only) and awards without a level stay level-less", () => {
    const by = mapFinding(finding("birth_year", { year: "2010" }, "S1"))[0];
    expect(by.claim).toMatchObject({ factKey: "birth_year", value: { year: 2010 } });
    expect(() => accepted("birth_year", by.claim.value)).not.toThrow();
    const award = mapFinding(finding("awards_selections", { name: "WNBA All-Star", years: [2024, 2025] }, "S4"));
    expect(award.map((c) => c.claim.value)).toEqual([{ name: "WNBA All-Star", year: 2024 }, { name: "WNBA All-Star", year: 2025 }]);
    for (const c of award) expect(() => accepted("award", c.claim.value)).not.toThrow();
  });
});

describe("graduation_year (D7, item-mapping/3)", () => {
  const accepted = (key: string, value: unknown) => validateFactValue(key, canonicalizeValue(key, value).value);

  it("a class-year finding that states the graduation year yields its own graduation_year claim with the finding's provenance", () => {
    const f = finding("education_class_year", { class_year_label: "Junior", season: "2026", graduation_year: "2028", degree: "Marketing" }, "S2");
    const out = mapFinding(f);
    expect(out.map((c) => c.claim.factKey)).toEqual(["class_year", "graduation_year", "education"]);   // /4: the degree also yields education
    const [cls, grad] = out;
    expect(cls).toMatchObject({ kind: "profile_attribute", registryStatus: "partial", claim: { value: { label: "Junior", season: 2026 }, degree: "Marketing" } });
    expect(cls.claim).not.toHaveProperty("graduationYear");   // no longer only an `extra`
    expect(grad).toMatchObject({ kind: "profile_attribute", item: "education_class_year", section: "S2", registryStatus: "mapped", claim: { factKey: "graduation_year", value: { year: 2028 } } });
    // same provenance as the finding: sources (the source tier is classified from these by persist), lineage, citation, mapping version
    expect(grad.sources).toBe(f.sources);
    expect(grad.lineage).toBe(f.lineage);
    expect(grad.citation).toEqual(cls.citation);
    expect(grad.mappingVersion).toBe(ITEM_MAPPING_VERSION);
    expect(() => accepted("graduation_year", grad.claim.value)).not.toThrow();
    expect(mapFinding(f)).toEqual(out);   // deterministic
  });

  it("a graduation year alone still maps (it no longer falls back to evidence only)", () => {
    const out = mapFinding(finding("education_class_year", { graduation_year: 2027 }, "S2"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "profile_attribute", registryStatus: "mapped", claim: { factKey: "graduation_year", value: { year: 2027 } } });
  });

  it("absent or unusable graduation year: no graduation_year claim, nothing invented", () => {
    expect(mapFinding(finding("education_class_year", { class_year_label: "Senior", season: "2026" }, "S2")).map((c) => c.claim.factKey)).toEqual(["class_year"]);
    expect(mapFinding(finding("education_class_year", { class_year_label: "Senior", season: "2026", graduation_year: "unknown" }, "S2")).map((c) => c.claim.factKey)).toEqual(["class_year"]);
    // nothing usable at all → evidence only, the intended key recorded as before
    expect(mapFinding(finding("education_class_year", { notes: "x" }, "S2"))).toEqual([expect.objectContaining({ kind: RESEARCH_FINDING_KIND, registryStatus: "unmapped", claim: expect.objectContaining({ intendedFactKey: "class_year" }) })]);
    // /4: a degree alone is an education claim (institution still to be bound by persist), never a class_year
    expect(mapFinding(finding("education_class_year", { degree: "Marketing" }, "S2")).map((c) => c.claim.factKey)).toEqual(["education"]);
  });

  it("an uncited finding keeps its asserted_only lineage (acceptance stays the resolver's decision)", () => {
    const grad = mapFinding(finding("education_class_year", { graduation_year: "2027" }, "S2", asserted))[0];
    expect(grad.claim.factKey).toBe("graduation_year");
    expect(grad.lineage.level).toBe("asserted_only");
  });

  it("career_status and event stay unmapped (D7: deliberately untouched)", () => {
    const keys = Object.values(ITEM_MAPPINGS).flatMap((m) => [m.factKey, ...(m.also ?? []).map((x) => x.factKey)]);
    expect(keys).toContain("graduation_year");
    expect(keys).not.toContain("career_status");
    expect(keys).not.toContain("event");
  });
});

describe("item-mapping/4 (registry v3, Concept 0.4 B1): education, national-team year, captaincy", () => {
  const accepted = (key: string, value: unknown) => validateFactValue(key, canonicalizeValue(key, value).value);
  const school = (id: string, org: string, orgKind = "school", extra: Record<string, unknown> = {}) => ({ id, value: { org, orgKind, season: 2026, ...extra } });
  const supported = { ...cited, level: "native_supported" as const };

  it("education: the stated degree becomes an education claim; an item institution is used as is; otherwise it is marked for binding, never invented", () => {
    const own = mapFinding(finding("education_class_year", { degree: "MS Applied Physics", institution: "Northfield College" }, "S2")).find((c) => c.claim.factKey === "education")!;
    expect(own.claim.value).toEqual({ institution: "Northfield College", degree: "MS Applied Physics" });
    expect(own.claim).not.toHaveProperty("institutionRef");
    expect(() => accepted("education", own.claim.value)).not.toThrow();
    const f = finding("education_class_year", { class_year_label: "Senior", degree: "Data Science / Operations Research (MS)" }, "S2", cited, "She is a senior at Northfield College studying data science.");
    const out = mapFinding(f);
    expect(out.map((c) => c.claim.factKey)).toEqual(["class_year", "education"]);
    const edu = out[1];
    expect(edu.claim).toMatchObject({ value: { degree: "Data Science / Operations Research (MS)" }, institutionRef: INSTITUTION_REF });
    expect(edu.claim.value).not.toHaveProperty("institution");
    expect(() => accepted("education", edu.claim.value)).toThrow(/institution Required/);   // unbound → still refused
  });

  it("class_year: unchanged — no season in the item stays refused (no as-of or label guess)", () => {
    const cls = mapFinding(finding("education_class_year", { class_year_label: "Senior", degree: "x" }, "S2"))[0];
    expect(cls.claim.value).toEqual({ label: "Senior" });
    expect(() => accepted("class_year", cls.claim.value)).toThrow(/season Required/);
  });

  it("national team: a missing year comes from ONE explicit year in the value text, else ONE in the statement; none or several → still refused", () => {
    const inEvent = mapFinding(finding("national_team_programme", { team: "Freedonia U-17", age_group: "U-17", role: "captain", event: "2022 U-17 World Cup" }, "S2"))[0];
    expect(inEvent.claim.value).toEqual({ team: "Freedonia U-17", level: "U-17", year: 2022, role: "captain", event: "2022 U-17 World Cup" });
    expect(() => accepted("national_team_participation", inEvent.claim.value)).not.toThrow();
    const inStatement = mapFinding(finding("national_team_programme", { team: "Freedonia U-17", age_group: "U-17", role: "captain" }, "S2", cited, "She captained Freedonia at the 2022 U-17 World Cup."))[0];
    expect(inStatement.claim.value).toMatchObject({ year: 2022, role: "captain" });
    const none = mapFinding(finding("national_team_programme", { team: "Freedonia U-17", age_group: "U-17", role: "captain" }, "S2", cited, "She captained the U-17 side."))[0];
    expect(none.claim.value).not.toHaveProperty("year");
    expect(() => accepted("national_team_participation", none.claim.value)).toThrow(/year Required/);
    const two = mapFinding(finding("national_team_programme", { team: "Freedonia U-17", age_group: "U-17" }, "S2", cited, "Called up in 2021 and again in 2022."))[0];
    expect(two.claim.value).not.toHaveProperty("year");
    const born = mapFinding(finding("national_team_programme", { team: "Freedonia U-17", age_group: "U-17" }, "S2", cited, "The forward, born 2007, plays for the U-17 side."))[0];
    expect(born.claim.value).not.toHaveProperty("year");   // a birth year is never a participation year
    expect(participationYear({ year: "2019", event: "2022 Cup" }, null)).toBe(2019);   // the item's own year wins
    const intl = mapFinding(finding("international_results", { team: "Freedonia", competition: "2024 Continental Cup", result: "runner-up" }, "S4"))[0];
    expect(intl.claim.value).toMatchObject({ year: 2024 });
  });

  it("captaincy: generic language is annotated on the milestone; hedged / former captaincy is not", () => {
    const m = mapFinding(finding("milestones_selections", { event: "Named Northfield team captain", date: "2026-08-13" }, "S3"))[0];
    expect(m).toMatchObject({ kind: "career_event", registryStatus: "unmapped", claim: { eventKind: "milestone", captaincy: { role: "captain", roleSince: "2026-08-13" } } });
    expect(captaincyOf("Voted co-captain for the 2025 season", undefined)).toEqual({ role: "co-captain", roleSeason: 2025 });
    expect(captaincyOf("Named Co Captain", "2026-05-02")).toMatchObject({ role: "co-captain" });   // "May" is never a hedge
    for (const e of ["former captain of the side", "stripped of the captaincy and no longer captain", "expected to be named captain", "scored twice in the final"]) expect(captaincyOf(e, undefined)).toBeNull();
  });

  it("affiliationNamedIn: domain first, else at least one distinctive word; exactly one current affiliation or nothing", () => {
    const affs = [{ ...school("a1", "Northfield College"), domains: ["athletics.northfield.edu"] }, { ...school("a2", "Riverton Hawks FC", "club"), domains: ["rivertonhawks.example"] }];
    expect(affiliationNamedIn("Named Northfield team captain", affs)?.id).toBe("a1");
    expect(affiliationNamedIn("Named Riverton team captain", affs)?.id).toBe("a2");   // nickname dropped → still maps
    expect(affiliationNamedIn("Named team captain", affs)).toBeNull();   // no name, no domain
    expect(affiliationNamedIn("Named team captain", affs, undefined, "athletics.northfield.edu")?.id).toBe("a1");   // the affiliation's own domain
    expect(affiliationNamedIn("Named team captain", affs, undefined, "espn.com")).toBeNull();   // a domain that established nothing
    expect(affiliationNamedIn("Northfield and Riverton both named her captain", affs)).toBeNull();   // two match → ambiguous
    expect(affiliationNamedIn("Named College team captain", affs)).toBeNull();   // generic words alone never match
    expect(affiliationNamedIn("Northfield College senior", affs, ["club"])).toBeNull();   // kind filter
    const shared = [{ ...school("s1", "Northfield College"), domains: ["shared.example"] }, { ...school("s2", "Riverton Hawks FC", "club"), domains: ["shared.example"] }];
    expect(affiliationNamedIn("Named team captain", shared, undefined, "shared.example")).toBeNull();   // a domain behind two affiliations → ambiguous
  });

  it("captaincyAffiliation: nickname-dropped name or the affiliation's own domain maps; a non-official source never does", () => {
    const affs = [{ ...school("h1", "Riverton Hawks", "club"), domains: ["rivertonhawks.example"] }];
    const named = mapFinding(finding("milestones_selections", { event: "Named Riverton team captain", date: "2026-08-13" }, "S3", supported))[0].claim;
    expect(captaincyAffiliation(named, "native_supported", "official_team_or_school", affs)?.value).toMatchObject({ org: "Riverton Hawks", role: "captain" });
    const unnamed = mapFinding(finding("milestones_selections", { event: "Named team captain", date: "2026-08-13" }, "S3", supported))[0].claim;
    expect(captaincyAffiliation(unnamed, "native_supported", "official_team_or_school", affs, "rivertonhawks.example")?.factId).toBe("h1");
    expect(captaincyAffiliation(unnamed, "native_supported", "official_team_or_school", affs)).toBeNull();
    expect(captaincyAffiliation(named, "native_supported", "major_news", affs)).toBeNull();
    expect(captaincyAffiliation(unnamed, "native_supported", "major_news", affs, "rivertonhawks.example")).toBeNull();
    const two = [...affs, school("h2", "Riverton Academy")];
    expect(captaincyAffiliation(named, "native_supported", "official_team_or_school", two)).toBeNull();   // both current affiliations match → no map
  });

  it("captaincyAffiliation: only native_supported + official team/school or governing-body source + a named current affiliation", () => {
    const affs = [school("a1", "Northfield College", "school", { level: "NCAA D1", role: "starter", primary: true })];
    const claim = mapFinding(finding("milestones_selections", { event: "Named Northfield team captain", date: "2026-08-13" }, "S3", supported))[0].claim;
    const ok = captaincyAffiliation(claim, "native_supported", "official_team_or_school", affs)!;
    expect(ok).toEqual({ factId: "a1", org: "Northfield College", value: { org: "Northfield College", orgKind: "school", season: 2026, level: "NCAA D1", role: "captain", roleSince: "2026-08-13" } });
    expect(() => accepted("affiliation", ok.value)).not.toThrow();
    expect(captaincyAffiliation(claim, "native_supported", "official_governing_body", affs)).not.toBeNull();
    expect(captaincyAffiliation(claim, "native_supported", "major_news", affs)).toBeNull();   // non-official source → no role
    expect(captaincyAffiliation(claim, "native_supported", "aggregator_or_blog", affs)).toBeNull();
    expect(captaincyAffiliation(claim, "native_retrieved", "official_team_or_school", affs)).toBeNull();   // lineage below native_supported
    expect(captaincyAffiliation(claim, "asserted_only", "official_team_or_school", affs)).toBeNull();
    expect(captaincyAffiliation(claim, "native_supported", "official_team_or_school", [school("b1", "Southgate University")])).toBeNull();   // not the athlete's team
    const plain = mapFinding(finding("milestones_selections", { event: "Scored her 50th goal", date: "2026-08-13" }, "S3", supported))[0].claim;
    expect(captaincyAffiliation(plain, "native_supported", "official_team_or_school", affs)).toBeNull();
  });
});
