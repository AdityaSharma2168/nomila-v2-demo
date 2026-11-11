/**
 * resolve.test.ts — the source-authority resolution (design §4.3, R1, R3, R4, rule 5, rule 7).
 */

import { classYearValidity, resolveFacts, type Candidate, type FactRow, type ResolvePolicy } from "./resolve";
import { DEFAULT_RESEARCH_POLICY } from "./policy";

const policy: ResolvePolicy = { asOf: "2026-09-11T00:00:00.000Z", ttlDays: DEFAULT_RESEARCH_POLICY.ttlDays, minCorroboration: 2, uncitedConfidenceCap: 0.5, hasAssertedAffiliations: false };
let n = 0;
const cand = (factKey: string, value: unknown, over: Partial<Candidate> = {}): Candidate => ({ factKey, value, evidenceId: `e${++n}`, sourceClass: "web_researched", sourceType: "major_news", sourceDomain: "espn.com", lineageStatus: "cited", suspect: false, confidence: 0.8, publishedAt: "2026-09-01", retrievedAt: "2026-09-10T00:00:00.000Z", ...over });
const row = (factKey: string, value: any, valueText: string, over: Partial<FactRow> = {}): FactRow => ({ id: `f${++n}`, factKey, value, valueText, status: "current", origin: "research", sourceClass: "web_researched", authorityTier: 3, confidence: 0.8, retrievedAt: "2026-09-01T00:00:00.000Z", observedAt: null, validFrom: null, validTo: null, provenance: { evidenceIds: ["e0"], domains: ["espn.com"] }, ...over });
const inserts = (r: ReturnType<typeof resolveFacts>) => r.decisions.filter((d): d is Extract<typeof d, { action: "insert" }> => d.action === "insert");
const refusals = (r: ReturnType<typeof resolveFacts>) => r.decisions.filter((d): d is Extract<typeof d, { action: "refuse" }> => d.action === "refuse");

describe("R1: source classes and registry", () => {
  it("refuses inferred and imputed as fact sources, suspect claims, unregistered keys and off-schema values", () => {
    const r = resolveFacts([], [
      cand("sport", { sport: "soccer" }, { sourceClass: "inferred" }),
      cand("sport", { sport: "soccer" }, { sourceClass: "imputed" }),
      cand("sport", { sport: "soccer" }, { suspect: true }),
      cand("favourite_color", { text: "blue" }),
      cand("graduation_year", { year: "twenty" }),
    ], [], policy);
    expect(refusals(r).map((d) => d.reason)).toEqual([expect.stringMatching(/inferred/), expect.stringMatching(/imputed/), expect.stringMatching(/suspect/), expect.stringMatching(/unregistered/), expect.stringMatching(/graduation_year/)]);
    expect(inserts(r)).toHaveLength(0);
  });
});

describe("R3: authority tiers, corroboration, displacement, dispute", () => {
  it("with no current fact the best tier wins; the others are recorded disputed", () => {
    const r = resolveFacts([], [
      cand("hometown", { city: "Pittsburgh" }, { sourceType: "aggregator_or_blog", sourceDomain: "blog.x" }),
      cand("hometown", { city: "Mt. Lebanon" }, { sourceType: "official_team_or_school", sourceDomain: "gostanford.com" }),
    ], [], policy);
    const ins = inserts(r);
    expect(ins.find((d) => d.fact.valueText === "mt lebanon")).toMatchObject({ fact: { status: "current", authorityTier: 2 } });
    expect(ins.find((d) => d.fact.valueText === "pittsburgh")).toMatchObject({ fact: { status: "disputed" } });
    expect(r.disputedKeys).toEqual(["hometown"]);
  });
  it("newer + higher confidence alone never displaces a higher-tier current value → disputed", () => {
    const cur = row("hometown", { city: "Mt. Lebanon" }, "mt lebanon", { authorityTier: 2 });
    const r = resolveFacts([cur], [cand("hometown", { city: "Pittsburgh" }, { sourceType: "regional_news", confidence: 0.99, publishedAt: "2026-09-10" })], [], policy);
    expect(inserts(r)).toEqual([expect.objectContaining({ supersedes: [], fact: expect.objectContaining({ status: "disputed", valueText: "pittsburgh" }) })]);
  });
  it("a better tier, or tier ≤ 2, displaces: the old row is superseded", () => {
    const cur = row("position", { text: "Defender" }, "defender", { authorityTier: 5 });
    const r = resolveFacts([cur], [cand("position", { text: "Midfielder" }, { sourceType: "official_team_or_school" })], [], policy);
    expect(inserts(r)).toEqual([expect.objectContaining({ supersedes: [cur.id], fact: expect.objectContaining({ status: "current", valueText: "midfielder", authorityTier: 2 }) })]);
  });
  it("a lower tier displaces only a STALE current value with two independent domains", () => {
    const stale = row("position", { text: "Defender" }, "defender", { authorityTier: 3, retrievedAt: "2025-01-01T00:00:00.000Z" });   // affiliations TTL 180 d
    const one = resolveFacts([stale], [cand("position", { text: "Midfielder" }, { sourceType: "regional_news", sourceDomain: "a.com" })], [], policy);
    expect(inserts(one)[0].fact.status).toBe("disputed");
    const two = resolveFacts([stale], [cand("position", { text: "Midfielder" }, { sourceType: "regional_news", sourceDomain: "a.com" }), cand("position", { text: "Midfielder" }, { sourceType: "regional_news", sourceDomain: "b.com" })], [], policy);
    expect(inserts(two)).toEqual([expect.objectContaining({ supersedes: [stale.id], fact: expect.objectContaining({ status: "current", provenance: expect.objectContaining({ corroboration: 2 }) }) })]);
  });
  it("the same value again confirms: a new current row with merged provenance supersedes the old", () => {
    const cur = row("position", { text: "Midfielder" }, "midfielder", { authorityTier: 3 });
    const r = resolveFacts([cur], [cand("position", { text: "midfielder" }, { sourceType: "official_team_or_school", sourceDomain: "gostanford.com" })], [], policy);
    const d = inserts(r)[0];
    expect(d.supersedes).toEqual([cur.id]);
    expect(d.fact.provenance.evidenceIds).toEqual(expect.arrayContaining(["e0"]));
    expect(d.fact.authorityTier).toBe(2);
  });
  it("uncited evidence never establishes a current fact: it becomes disputed", () => {
    const r = resolveFacts([], [cand("sport", { sport: "soccer" }, { lineageStatus: "uncited" })], [], policy);
    expect(inserts(r)[0].fact).toMatchObject({ status: "disputed", authorityTier: null, confidence: 0.5 });
  });
  it("multi-valued keys keep every cited value current; no displacement", () => {
    const r = resolveFacts([], [cand("sport", { sport: "soccer" }), cand("sport", { sport: "futsal" }, { sourceDomain: "b.com" })], [], policy);
    expect(inserts(r).map((d) => d.fact.status)).toEqual(["current", "current"]);
  });
});

describe("R2 / R4: athlete assertion and proof override research", () => {
  it("an assertion wins its key, supersedes the researched current value, and later research only corroborates", () => {
    const cur = row("position", { text: "Defender" }, "defender", { authorityTier: 2 });
    const r = resolveFacts([cur], [cand("position", { text: "Goalkeeper" }, { sourceType: "official_governing_body" })], [{ factKey: "position", value: { text: "Midfielder" }, assertedId: "as1", kind: "asserted", at: "2026-09-05T00:00:00.000Z" }], policy);
    const ins = inserts(r);
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ supersedes: [cur.id], fact: { origin: "athlete_asserted", sourceClass: null, authorityTier: null, confidence: 1, valueText: "midfielder" } });
    expect(r.decisions.find((d) => d.action === "noop")).toMatchObject({ reason: "overridden by the athlete's assertion" });
  });
  it("proof carries origin athlete_proof", () => {
    const r = resolveFacts([], [], [{ factKey: "sport", value: { sport: "soccer" }, assertedId: "pr1", kind: "proof", at: "2026-09-05T00:00:00.000Z" }], policy);
    expect(inserts(r)[0].fact).toMatchObject({ origin: "athlete_proof", sourceClass: null, provenance: { proofId: "pr1" } });
  });
});

describe("rule 7: affiliations for public (unclaimed) athletes", () => {
  const aff = (org: string, over: Partial<Candidate> = {}) => cand("affiliation", { org, orgKind: "school", level: "D1", conference: "ACC", season: 2026 }, over);
  it("tier ≤ 2 evidence with a season establishes a current, primary affiliation", () => {
    const r = resolveFacts([], [aff("Stanford University", { sourceType: "official_team_or_school", sourceDomain: "gostanford.com" })], [], policy);
    expect(inserts(r)[0].fact).toMatchObject({ status: "current", authorityTier: 2, value: expect.objectContaining({ org: "Stanford University", primary: true }), provenance: expect.objectContaining({ note: "established by rule 7" }) });
    expect(r.establishedAffiliations).toBe(1);
  });
  it("two independent tier ≤ 3 sources agreeing establish it; one regional source only proposes", () => {
    const two = resolveFacts([], [aff("Stanford University", { sourceDomain: "espn.com" }), aff("Stanford University", { sourceDomain: "si.com" })], [], policy);
    expect(inserts(two)[0].fact.status).toBe("current");
    const one = resolveFacts([], [aff("Stanford University", { sourceType: "regional_news", sourceDomain: "local.com" })], [], policy);
    expect(inserts(one)).toHaveLength(0);
    expect(one.decisions.find((d) => d.action === "propose")).toMatchObject({ reason: expect.stringContaining("below the establishing bar") });
  });
  it("without a season or date, and with uncited evidence, research only proposes", () => {
    const undated = resolveFacts([], [cand("affiliation", { org: "Stanford University", orgKind: "school" }, { sourceType: "official_team_or_school" })], [], policy);
    expect(inserts(undated)).toHaveLength(0);
    const uncited = resolveFacts([], [aff("Stanford University", { sourceType: "official_team_or_school", lineageStatus: "uncited" })], [], policy);
    expect(uncited.decisions.find((d) => d.action === "propose")).toMatchObject({ reason: expect.stringContaining("uncited") });
  });
  it("when the athlete has said/proof affiliations, research only proposes (found rows yield)", () => {
    const r = resolveFacts([], [aff("Stanford University", { sourceType: "official_governing_body" })], [], { ...policy, hasAssertedAffiliations: true });
    expect(inserts(r)).toHaveLength(0);
    expect(r.decisions.find((d) => d.action === "propose")).toMatchObject({ reason: expect.stringContaining("athlete has said/proof") });
  });
  it("a transfer: a newer affiliation with a STATED start replaces her current one (old → historical, new → primary)", () => {
    const old = row("affiliation", { org: "Duke University", orgKind: "school", season: 2024, primary: true }, "duke university school 2024", { authorityTier: 2 });
    const r = resolveFacts([old], [cand("affiliation", { org: "Stanford University", orgKind: "school", level: "D1", from: "2026" }, { sourceType: "official_team_or_school" })], [], policy);
    const ins = inserts(r);
    expect(ins.find((d) => d.fact.valueText.startsWith("stanford"))?.fact).toMatchObject({ status: "current", value: expect.objectContaining({ primary: true }) });
    expect(ins.find((d) => d.supersedes.includes(old.id))?.fact).toMatchObject({ status: "historical", validTo: "2024-12-31" });
  });
  it("a transfer corroborated by two independent sources replaces her current one too", () => {
    const old = row("affiliation", { org: "Duke University", orgKind: "school", season: 2024, primary: true }, "duke university school 2024", { authorityTier: 2 });
    const r = resolveFacts([old], [aff("Stanford University", { sourceType: "official_team_or_school", sourceDomain: "gostanford.com" }), aff("Stanford University", { sourceType: "major_news", sourceDomain: "espn.com" })], [], policy);
    expect(inserts(r).find((d) => d.supersedes.includes(old.id))?.fact).toMatchObject({ status: "historical" });
  });
  it("one source seeing another org as current in a later season adds it, but never ends or outranks her current team", () => {
    const old = row("affiliation", { org: "Duke University", orgKind: "school", season: 2024, primary: true }, "duke university school 2024", { authorityTier: 2 });
    const r = resolveFacts([old], [aff("Women's Program", { sourceType: "official_team_or_school" })], [], policy);
    const ins = inserts(r);
    expect(ins.find((d) => d.fact.valueText.startsWith("women"))?.fact).toMatchObject({ status: "current", value: expect.objectContaining({ primary: false }) });
    expect(ins.some((d) => d.supersedes.includes(old.id))).toBe(false);
  });
  it("registry v3: an official captaincy re-establishes the same-org row with the role; a later re-statement without a role keeps it", () => {
    const cur = row("affiliation", { org: "Northfield College", orgKind: "school", level: "D1", season: 2026, primary: true }, "northfield college school 2026", { authorityTier: 2 });
    const withRole = resolveFacts([cur], [cand("affiliation", { org: "Northfield College", orgKind: "school", level: "D1", season: 2026, role: "captain", roleSince: "2026-08-13" }, { sourceType: "official_team_or_school" })], [], policy);
    const ins = inserts(withRole)[0];
    expect(ins).toMatchObject({ supersedes: [cur.id], fact: { status: "current", value: { org: "Northfield College", role: "captain", roleSince: "2026-08-13", primary: true }, valueText: "northfield college school 2026", resolverVersion: "v3", registryVersion: "v3" } });
    const captained = row("affiliation", ins.fact.value, ins.fact.valueText, { authorityTier: 2 });
    const again = inserts(resolveFacts([captained], [aff("Northfield College", { sourceType: "official_team_or_school" })], [], policy))[0];
    expect(again).toMatchObject({ supersedes: [captained.id], fact: { value: { role: "captain", roleSince: "2026-08-13", conference: "ACC" } } });
    const nextSeason = inserts(resolveFacts([captained], [cand("affiliation", { org: "Northfield College", orgKind: "school", season: 2027 }, { sourceType: "official_team_or_school" })], [], policy))[0];
    expect(nextSeason.fact.value).not.toHaveProperty("role");   // a role belongs to its season; a new season does not inherit it
  });
});

describe("rule 5: time", () => {
  it("class-year labels are current only for their season (academic roll-over in August)", () => {
    expect(classYearValidity(2026, "2026-09-11T00:00:00.000Z")).toMatchObject({ status: "current", validTo: "2026-12-31" });
    expect(classYearValidity(2027, "2026-09-11T00:00:00.000Z").status).toBe("current");   // "Class of 2027" in the fall
    expect(classYearValidity(2026, "2027-02-01T00:00:00.000Z").status).toBe("historical");
    expect(classYearValidity(2027, "2026-05-01T00:00:00.000Z").status).toBe("historical");
    const r = resolveFacts([], [cand("class_year", { label: "Senior (2026 season)", season: 2026 }, { sourceType: "official_team_or_school" })], [], policy);
    expect(inserts(r)[0].fact).toMatchObject({ status: "current", validFrom: "2025-08-01", validTo: "2026-12-31" });
  });
  it("dated achievements are historical facts; duplicates are noops; undated ones stay current", () => {
    const r = resolveFacts([], [cand("achievement", { name: "All-ACC First Team", year: 2025, level: "conference" }), cand("achievement", { name: "Captain", level: "school" })], [], policy);
    expect(inserts(r).map((d) => [d.fact.status, d.fact.validFrom])).toEqual([["historical", "2025-01-01"], ["current", null]]);
    const again = resolveFacts([row("achievement", { name: "All-ACC First Team", year: 2025, level: "conference" }, "all acc first team 2025", { status: "historical" })], [cand("achievement", { name: "all-acc first team", year: 2025, level: "conference" })], [], policy);
    expect(again.decisions[0]).toMatchObject({ action: "noop", reason: "already recorded" });
  });
});
