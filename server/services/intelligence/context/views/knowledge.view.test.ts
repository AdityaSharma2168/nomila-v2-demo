/**
 * knowledge.view.test.ts — knowledgeView knowledge/3 (Concept 0.4 PR 4), pure (no DB, no provider).
 *
 *   K1 at a glance: name · school · sport · position · hometown · nationality · class ("Senior · 2026 season"); no graduation
 *   K2 tier = the EXISTING admissibility policy (identityIntelligence/claims.ts), equivalent on fixtures; her verdicts apply
 *   K3 logoDomain is presentation only: removing every logo source changes nothing but logoDomain (tier, order, counts)
 *   K4 teams = canonical facts + said/proof rows; a legacy `found` row without a fact is not shown (counted as omitted)
 *   K5 academics: present with an education fact or an academic honour, else the unavailable invite state
 *   K6 national-team participation sits in the athletic career, with its year; honours carry years
 *   K7 a disputed entry ("This isn't right") reads unconfirmed, carries her words and is not counted; nothing says "verified"
 */
jest.mock("../../../../db", () => ({ db: {}, pool: {} }));

import { brandProfileFrom, brandSourcesFrom, identityOf, knowledgeEntries, knowledgeView, tierOfEvidence, tierOfFact, BRAND_PROFILE_LIMITS, NO_KNOWLEDGE_VERDICTS, KNOWLEDGE_VIEW_VERSION, type AffiliationFactInfo, type KnowledgeExtras, type KnowledgeVerdicts } from "./knowledge";
import { sourceTierOfEvidence, sourceTierOfFact } from "../../identityIntelligence/claims";
import type { BuiltContext } from "../build";
import type { AffiliationRow, CanonicalAthleteContext, Evidence, Fact } from "../contract";

const T = "2026-09-01T00:00:00.000Z";
const fact = <V>(value: V, over: Partial<Fact<V>> = {}): Fact<V> => ({
  value, origin: "research", sourceClass: "web_researched", authorityTier: 3, status: "current", retrievedAt: T,
  validFrom: null, validTo: null, evidenceIds: [], freshness: "fresh", ...over,
} as Fact<V>);
const ev = <V>(value: V, over: Partial<Evidence<V>> = {}): Evidence<V> => ({
  value, sourceClass: "web_researched", sourceType: "major_news", sourceUrl: "https://news.example/a", sourceDomain: "news.example", retrievedAt: T, publishedAt: null,
  evidenceId: "00000000-0000-4000-8000-0000000000e1", lineage: "native_supported", ...over,
} as Evidence<V>);
const aff = (over: Partial<AffiliationRow> = {}): AffiliationRow => ({
  id: "row-said", org: "Example University", kind: "school", level: "D1", conference: "Example Conference", role: null, position: null, from: "2023-08-01", to: null,
  primary: true, current: true, kindOfFact: "said", source: "signup", recordedAt: T, ...over,
});

const EV_OFFICIAL = "00000000-0000-4000-8000-0000000000a1";
const EV_ACADEMIC = "00000000-0000-4000-8000-0000000000a2";
const EV_EDU = "00000000-0000-4000-8000-0000000000a3";
const F_CLUB = "00000000-0000-4000-8000-0000000000f1";

function ctxOf(o: { all?: AffiliationRow[]; education?: boolean; academic?: boolean } = {}): CanonicalAthleteContext {
  const all = o.all ?? [
    aff(),
    aff({ id: "row-found-fact", org: "Example City FC", kind: "club", kindOfFact: "found", source: "fact", primary: false, from: "2021-01-01", to: "2022-12-31", current: false, role: "captain" }),
    aff({ id: "row-found-legacy", org: "Legacy Found Club", kind: "club", kindOfFact: "found", source: "research", primary: false, current: true, from: null }),
  ];
  return {
    contractVersion: "x", athleteId: "ath", builtAt: T, sourceMode: "canonical",
    coverage: { identity: "populated", profile: "populated", affiliations: "populated", achievements: "populated", press: "populated", brand_mentions: "populated", narrative: "populated", social_handles: "populated", signals: "populated" },
    identity: {
      name: fact({ full: "Sam Example", first: "Sam", last: "Example" }, { origin: "legacy_row", factKey: "name", authorityTier: null, sourceClass: null }),
      aliases: [], sport: fact({ sport: "example sport" }, { factKey: "sport", factId: "00000000-0000-4000-8000-00000000f501" }),
      hometown: fact({ city: "Example City", region: "EX", country: "Testland" }, { factKey: "hometown", factId: "00000000-0000-4000-8000-00000000f502" }),
      nationality: [fact({ country: "Testland" }, { factKey: "nationality", factId: "00000000-0000-4000-8000-00000000f503", authorityTier: 1 })],
      careerStatus: fact({ status: "active" }, { origin: "athlete_asserted", factKey: "career_status" }),
      identityConfidence: 1, researchStatus: "research_complete", firstName: "Sam", photoUrl: null, createdAt: T,
    },
    affiliations: { current: all.find((a) => a.current && a.primary) ?? null, all, level: { org: null, kind: null, division: "D1", conference: "Example Conference", segment: null, alsoNational: false }, teamsLine: null },
    profile: {
      position: fact({ text: "Example Position" }, { factKey: "position", factId: "00000000-0000-4000-8000-00000000f504" }),
      classYear: fact({ label: "senior", season: 2026 }, { factKey: "class_year", factId: "00000000-0000-4000-8000-00000000f505" }),
      graduationYear: fact({ year: 2026 }, { factKey: "graduation_year", factId: "00000000-0000-4000-8000-00000000f506" }),
      event: [],
    },
    achievements: [
      fact({ name: "Conference Player of the Year", year: 2025, level: "conference", key: "award" }, { factKey: "award", factId: "00000000-0000-4000-8000-00000000f507", authorityTier: 2, evidenceIds: [EV_OFFICIAL] }),
      ...(o.academic ? [fact({ name: "Academic Honour Roll", year: 2024, level: "school", key: "award" }, { factKey: "award", factId: "00000000-0000-4000-8000-00000000f508", evidenceIds: [EV_ACADEMIC] })] : []),
    ],
    press: [ev({ outlet: "Example News", headline: "Sam scores twice" })],
    brandMentions: [ev({ brand: "Brand B", type: "tagged", confidence: 0.8 }, { evidenceId: "00000000-0000-4000-8000-0000000000e2", sourceType: "aggregator_or_blog", lineage: "cited" })],
    nilMentions: [],
    registryFacts: {
      rankings: [], seasonStatistics: [], endorsements: [],
      nationalTeam: [fact({ team: "U-20 National Team", level: "youth", year: 2024, event: "Qualifier" }, { factKey: "national_team_participation", factId: "00000000-0000-4000-8000-00000000f509", authorityTier: 1, evidenceIds: [EV_OFFICIAL] })],
      education: o.education ? [fact({ institution: "Example University", degree: "BS Example Studies", status: "completed", endYear: 2026 }, { factKey: "education", factId: "00000000-0000-4000-8000-00000000f50a", authorityTier: 2, evidenceIds: [EV_EDU] })] : [],
    },
    inferences: { storyArc: null, sentiment: null, brandFitTags: null },
    social: { handles: { instagram: { handle: "sam", sourceClass: "connected_verified", connected: true, confidence: 1, origin: "connected_account" } }, connectionStatus: "active", connectedPlatforms: ["instagram"] },
    assertions: [],
    freshness: { byDomain: {}, researchAsOf: null },
    commercial: { confirmedPartners: ["Brand P"], commercialState: "active" },
    audience: { gender: null, ageRange: null, topCity: null, geoCountry: [], share: null, sourceClass: "connected_verified", asOf: null, connected: false, platform: null },
    provenanceSummary: { canonicalFacts: 0, legacyFacts: 0, assertions: 0 },
  } as unknown as CanonicalAthleteContext;
}

const clubFact: AffiliationFactInfo = { factId: F_CLUB, org: "Example City FC", status: "historical", authorityTier: 2, evidenceIds: [EV_OFFICIAL], domains: ["club.example"], roleSeason: 2022 };
const extras = (over: Partial<KnowledgeExtras> = {}): KnowledgeExtras => ({
  evidenceUrls: new Map([
    [EV_OFFICIAL, { url: "https://club.example/news", domain: "club.example", sourceType: "official_team_or_school", category: "athletic" }],
    [EV_ACADEMIC, { url: "https://school.example/honours", domain: "school.example", sourceType: "official_team_or_school", category: "academic" }],
    [EV_EDU, { url: "https://school.example/roster", domain: "school.example", sourceType: "official_team_or_school", category: null }],
  ]),
  followers: [], inboxPartners: ["Brand Inbox"],
  affiliationFacts: new Map([["row-found-fact", clubFact], ["row-said-alias", { ...clubFact, factId: "00000000-0000-4000-8000-0000000000f2", org: "Example University", domains: ["uni.example"], authorityTier: 1, evidenceIds: [] }]]),
  brandDomains: new Map([["brand p", "brandp.example"]]),
  ...over,
});
const view = (o?: Parameters<typeof ctxOf>[0], x?: Partial<KnowledgeExtras>) => knowledgeView({ ctx: ctxOf(o) } as BuiltContext, extras(x));
const byId = (k: ReturnType<typeof view>, id: string) => knowledgeEntries(k).find((e) => e.id === id);
const textOf = (v: unknown): string => JSON.stringify(v);

describe("K1 at a glance", () => {
  it("is knowledge/3: nationality and class added, graduation dropped (still in Profile)", () => {
    const k = view();
    expect(k.version).toBe(KNOWLEDGE_VIEW_VERSION);
    expect(KNOWLEDGE_VIEW_VERSION).toBe("knowledge/3");
    expect(k.keyFacts.map((e) => e.id)).toEqual(["name", "team_row-said", "sport", "position", "hometown", "nationality", "class_year"]);
    expect(byId(k, "class_year")).toMatchObject({ label: "Class", value: "Senior · 2026 season", state: "present" });
    expect(byId(k, "nationality")).toMatchObject({ value: "Testland", source: { key: "official" }, tier: "established" });
    expect(k.keyFacts.some((e) => e.id === "graduation_year")).toBe(false);
    expect(k.categories[0].sections.find((s) => s.key === "profile")!.entries.some((e) => e.id === "graduation_year")).toBe(true);
  });
});

describe("K2 tier = the existing admissibility policy", () => {
  it("tierOfFact / tierOfEvidence equal claims.ts source tiers on fixtures (excluded shows as unconfirmed)", () => {
    for (const status of ["current", "historical", "disputed"] as const) {
      const own = sourceTierOfFact(status);
      expect([status, tierOfFact({ status, factId: "00000000-0000-4000-8000-0000000000ff" })]).toEqual([status, own === "excluded" ? "unconfirmed" : own]);
    }
    const lineages = ["native_supported", "native_retrieved", "cited", "source_read", "asserted_only"];
    const types = ["official_governing_body", "official_team_or_school", "major_news", "reference", "regional_news", "athlete_authored_public", "aggregator_or_blog", "unknown"];
    for (const lineage of lineages) for (const sourceType of types) {
      const own = sourceTierOfEvidence({ lineage, sourceType });
      expect([lineage, sourceType, tierOfEvidence({ lineage: lineage as any, sourceType, sourceDomain: "d.example", evidenceId: "00000000-0000-4000-8000-0000000000ee" })])
        .toEqual([lineage, sourceType, own === "excluded" ? "unconfirmed" : own]);
    }
  });

  it("her confirmation lifts, her denial lowers (assessClaim verdicts)", () => {
    const id = "00000000-0000-4000-8000-0000000000ee";
    const e = { lineage: "cited" as const, sourceType: "aggregator_or_blog", sourceDomain: "d.example", evidenceId: id };
    expect(tierOfEvidence(e)).toBe("unconfirmed");
    expect(tierOfEvidence(e, { ...NO_KNOWLEDGE_VERDICTS, confirmed: new Set([`evidence:${id}`]) })).toBe("established");
    expect(tierOfFact({ status: "current", factId: id }, { ...NO_KNOWLEDGE_VERDICTS, denied: new Set([`fact:${id}`]) })).toBe("unconfirmed");
  });

  it("every present entry carries a tier; athlete authority and connected accounts are established; blanks carry none", () => {
    const k = view();
    for (const e of knowledgeEntries(k)) expect([e.id, e.state === "present" ? !!e.tier : e.tier === null]).toEqual([e.id, true]);
    expect(byId(k, "name")!.tier).toBe("established");
    expect(byId(k, "partner_0")!.tier).toBe("established");
    expect(byId(k, "handle_instagram")!.tier).toBe("established");
    expect(byId(k, "press_00000000-0000-4000-8000-0000000000e1")).toMatchObject({ tier: "established", ref: { kind: "evidence" } });   // native_supported major_news
    expect(byId(k, "brand_seen_00000000-0000-4000-8000-0000000000e2")!.tier).toBe("unconfirmed");                                   // one blog source
  });
});

describe("K3 logoDomain is presentation only", () => {
  it("teams, schools, national teams and brands get a logo domain from official provenance / brand domains", () => {
    const k = view({ education: true });
    expect(byId(k, "team_row-found-fact")!.logoDomain).toBe("club.example");
    expect(byId(k, "team_row-said")!.logoDomain).toBe("uni.example");                 // a said team shares its org's fact logo
    expect(byId(k, "national_00000000-0000-4000-8000-00000000f509")!.logoDomain).toBe("club.example");
    expect(byId(k, "partner_0")!.logoDomain).toBe("brandp.example");
    expect(byId(k, "education_00000000-0000-4000-8000-00000000f50a")!.logoDomain).toBe("school.example");
  });

  it("a brand's stored logo (inbox_brands.logo_url) rides its rows as logoUrl — additive, null everywhere else, never authority", () => {
    const k = view({ education: true }, { brandLogoUrls: new Map([["brand p", "https://cdn.example/brand-p.png"]]) });
    expect(byId(k, "partner_0")).toMatchObject({ logoDomain: "brandp.example", logoUrl: "https://cdn.example/brand-p.png", tier: "established" });
    expect(byId(k, "partner_inbox_0")!.logoUrl).toBeNull();                        // Brand Inbox: no stored logo
    expect(byId(k, "team_row-found-fact")!.logoUrl).toBeNull();                    // teams never carry one
    expect(knowledgeEntries(k).every((e) => "logoUrl" in e)).toBe(true);
    const strip = (x: ReturnType<typeof view>) => JSON.parse(JSON.stringify(x, (key, v) => (key === "logoUrl" ? undefined : v)));
    expect(strip(k)).toEqual(strip(view({ education: true })));
  });

  it("without any logo source the view is identical except logoDomain (tier, order, counts unchanged)", () => {
    const strip = (k: ReturnType<typeof view>) => JSON.parse(JSON.stringify(k, (key, v) => (key === "logoDomain" ? undefined : v)));
    const withLogos = view({ education: true });
    const noOfficial = new Map([...extras().evidenceUrls].map(([id, l]) => [id, { ...l, sourceType: "major_news" }]));
    const without = view({ education: true }, { brandDomains: new Map(), evidenceUrls: noOfficial, affiliationFacts: new Map([...extras().affiliationFacts!].map(([id, f]) => [id, { ...f, domains: [], authorityTier: 5 }])) });
    expect(knowledgeEntries(without).every((e) => e.logoDomain === null)).toBe(true);
    // authorityTier on the fact info only feeds the logo fallback; tiers come from the fact's status.
    expect(strip(without)).toEqual(strip(withLogos));
  });
});

describe("K4 teams: facts + said/proof; legacy found rows excluded", () => {
  it("drops the found row with no fact and counts it as omitted legacy", () => {
    const k = view();
    const teams = k.categories[0].sections.find((s) => s.key === "teams")!;
    expect(teams.title).toBe("Athletic career");
    expect(teams.entries.map((e) => e.id)).toEqual(["team_row-said", "team_row-found-fact", "national_00000000-0000-4000-8000-00000000f509"]);
    expect(textOf(k).includes("Legacy Found Club")).toBe(false);
    expect(k.omitted.legacyValues).toBeGreaterThanOrEqual(1);
    expect(byId(k, "team_row-found-fact")).toMatchObject({ source: { key: "researched" }, status: "historical", tier: "established", ref: { kind: "fact", id: F_CLUB }, meta: { org: "Example City FC", span: "2021 – 2022", role: "Captain (2022)" }, evidence: [{ url: "https://club.example/news", domain: "club.example" }] });
    expect(byId(k, "team_row-said")).toMatchObject({ source: { key: "you" }, tier: "established", ref: null, meta: { span: "2023 – present" } });
    // the teams editor sees the shown rows only
    expect((byId(k, "team_row-said")!.correct!.raw as any).teams.map((t: any) => t.org)).toEqual(["Example University", "Example City FC"]);
  });

  it("the Me header and the career agree: a legacy found primary team never becomes identity.primary", () => {
    const legacy = aff({ id: "row-legacy-primary", org: "Legacy Primary Club", kind: "club", kindOfFact: "found", source: "research", primary: true, current: true });
    const backed = aff({ id: "row-backed", org: "Backed City FC", kind: "club", kindOfFact: "found", source: "fact", primary: false, current: true });
    const ctx = ctxOf({ all: [legacy, backed] });
    expect(ctx.affiliations.current?.id).toBe("row-legacy-primary");   // what the builder alone would pick
    const facts = new Map([["row-backed", { ...clubFact, org: "Backed City FC", status: "current" as const }]]);
    const k = knowledgeView({ ctx } as BuiltContext, extras({ affiliationFacts: facts }));
    const career = k.categories[0].sections.find((s) => s.key === "teams")!.entries.filter((e) => e.id.startsWith("team_"));
    expect(career.map((e) => e.meta?.org)).toEqual(["Backed City FC"]);
    expect(k.identity.primary).toMatchObject({ org: "Backed City FC", orgKind: "club" });
    expect(k.keyFacts[1].id).toBe("team_row-backed");
    expect(identityOf(ctx, facts).primary?.org).toBe(k.identity.primary?.org);
    expect(textOf(k).includes("Legacy Primary Club")).toBe(false);
    // without a fact behind any found row, neither shows a team (the header falls back to the sport alone)
    expect(identityOf(ctx).primary).toMatchObject({ org: null });
  });

  it("with no extras about facts, every found row is legacy", () => {
    const k = view(undefined, { affiliationFacts: undefined });
    expect(byId(k, "team_row-found-fact")).toBeUndefined();
  });
});

describe("K5 academics", () => {
  it("unavailable (invite) with nothing on record", () => {
    expect(view().categories.find((c) => c.key === "academics")).toMatchObject({ state: "unavailable", count: null, sections: [] });
  });

  it("present with an education fact and an academic honour (which leaves athletics honours)", () => {
    const k = view({ education: true, academic: true });
    const acad = k.categories.find((c) => c.key === "academics")!;
    expect(acad).toMatchObject({ state: "present", count: 2 });
    expect(acad.sections.map((s) => s.key)).toEqual(["education", "academic_honours"]);
    expect(acad.sections[0].entries[0]).toMatchObject({ label: "Degree", value: "BS Example Studies · Example University", tier: "established", meta: { org: "Example University", span: "2026" } });
    expect(acad.sections[1].entries[0]).toMatchObject({ value: "Academic Honour Roll (2024)", meta: { year: 2024 } });
    const honours = k.categories[0].sections.find((s) => s.key === "honours")!.entries.map((e) => e.value);
    expect(honours).toEqual(["Conference Player of the Year (2025)"]);
  });
});

describe("K6 career + honours carry years", () => {
  it("national team in the career with its year; honours with theirs", () => {
    const k = view();
    expect(byId(k, "national_00000000-0000-4000-8000-00000000f509")).toMatchObject({ label: "National team", meta: { org: "U-20 National Team", orgKind: "national", year: 2024 } });
    expect(k.categories[0].sections.find((s) => s.key === "honours")!.entries[0]).toMatchObject({ meta: { year: 2025 } });
  });
});

describe("K7 her dispute", () => {
  it("a disputed fact and a disputed entry read unconfirmed with her words, and are not counted", () => {
    const base = view();
    const verdicts: KnowledgeVerdicts = {
      ...NO_KNOWLEDGE_VERDICTS,
      denied: new Set(["fact:00000000-0000-4000-8000-00000000f507"]),
      refDisputes: new Map([["fact:00000000-0000-4000-8000-00000000f507", { said: "That was a different year", at: T }]]),
      entryDisputes: new Map([["partner_inbox_0", { said: null, at: T }]]),
    };
    const k = view(undefined, { verdicts });
    expect(byId(k, "achievement_00000000-0000-4000-8000-00000000f507")).toMatchObject({ tier: "unconfirmed", yourDispute: { said: "That was a different year" } });
    expect(byId(k, "partner_inbox_0")).toMatchObject({ tier: "unconfirmed", yourDispute: { said: null } });
    expect(k.total).toBe(base.total - 2);
    expect(textOf(k).toLowerCase().includes("verified")).toBe(false);
  });
});

describe("K8 (Oct 2026) removing a found team removes it; one entry per real-world item", () => {
  it("a found team whose fact she denied (removed from her teams) is hidden from the career and never becomes her team", () => {
    const deniedClub: KnowledgeVerdicts = { ...NO_KNOWLEDGE_VERDICTS, denied: new Set([`fact:${F_CLUB}`]) };
    const before = view();
    expect(byId(before, "team_row-found-fact")).toBeTruthy();
    const after = view(undefined, { verdicts: deniedClub });
    expect(byId(after, "team_row-found-fact")).toBeUndefined();
    expect(textOf(after)).not.toContain("Example City FC");
  });

  it("national teams name their age group, and restatements of one age group + year collapse into the strongest entry", () => {
    const ctx = ctxOf();
    const nt = (team: string, level: string, year: number, id: string, over: Partial<Fact<any>> = {}) =>
      fact({ team, level, year }, { factKey: "national_team_participation", factId: id, authorityTier: 3, ...over });
    (ctx.registryFacts as any).nationalTeam = [
      nt("Example Youth National Team", "U-19", 2024, "00000000-0000-4000-8000-0000000000c1"),
      nt("Example U17", "Example U-17 Cup", 2022, "00000000-0000-4000-8000-0000000000c2"),
      nt("Example Youth National Team", "U-17", 2022, "00000000-0000-4000-8000-0000000000c3", { value: { team: "Example Youth National Team", level: "U-17", year: 2022, role: "captain" } } as any),
      nt("Example U-17 team", "Example U-17 Cup", 2022, "00000000-0000-4000-8000-0000000000c4", { status: "disputed" }),
      nt("Example Youth National Team", "U-20", 2025, "00000000-0000-4000-8000-0000000000c5"),
    ];
    const k = knowledgeView({ ctx } as BuiltContext, extras());
    const national = knowledgeEntries(k).filter((e) => e.id.startsWith("national_"));
    expect(national.map((e) => e.value)).toEqual([
      "Example Youth National Team · U-19 (2024)",
      "Example Youth National Team · U-17 (2022)",
      "Example Youth National Team · U-20 (2025)",
    ]);
    // The U-17 2022 entry is the one that states the most (the role), carrying the merged group's sources.
    expect(national[1].meta).toMatchObject({ role: "Captain", year: 2022 });
  });

  it("statistics merge on season + metric + value only; different values never merge", () => {
    const ctx = ctxOf();
    const st = (competition: string, metric: string, value: number, id: string) => fact({ season: 2024, competition, metric, value }, { factKey: "season_statistic", factId: id });
    (ctx.registryFacts as any).seasonStatistics = [
      st("League A", "goals", 3, "00000000-0000-4000-8000-0000000000d1"),
      st("League A full name", "Goals", 3, "00000000-0000-4000-8000-0000000000d2"),
      st("League A", "goals", 4, "00000000-0000-4000-8000-0000000000d3"),
    ];
    const k = knowledgeView({ ctx } as BuiltContext, extras());
    expect(knowledgeEntries(k).filter((e) => e.id.startsWith("stat_")).map((e) => e.value)).toEqual(["goals: 3", "goals: 4"]);
  });
});

describe("K8 (density pass) a brand's inbox_brands research rides its entry — additive, presentation only", () => {
  const profile = {
    category: "Luxury Goods", description: "A coastal jewelry brand. Family-run since 2004. Now omnichannel.", audienceSummary: "Women 25–34.",
    sportCategories: ["tennis", "soccer"], knownAthletePartnerships: ["Athlete One", "Athlete Two"], coverUrl: "https://cdn.example/cover.jpg", images: ["https://cdn.example/1.jpg"], sources: [],
  };
  it("brandId + brandProfile on every entry of a known brand (partner, seen with); nothing else changes", () => {
    const k = view({ education: true }, { brandProfiles: new Map([["brand p", { brandId: 164, profile }], ["brand b", { brandId: 52, profile: null }]]) });
    expect(byId(k, "partner_0")).toMatchObject({ brandId: 164, brandProfile: profile, tier: "established", logoDomain: "brandp.example" });
    expect(byId(k, "brand_seen_00000000-0000-4000-8000-0000000000e2")).toMatchObject({ brandId: 52, brandProfile: null });   // a row with no research yet
    expect("brandId" in byId(k, "partner_inbox_0")!).toBe(false);                                                           // Brand Inbox is not in inbox_brands
    expect("brandId" in byId(k, "team_row-said")!).toBe(false);                                                             // never on a non-brand entry
    const strip = (x: ReturnType<typeof view>) => JSON.parse(JSON.stringify(x, (key, v) => (key === "brandId" || key === "brandProfile" ? undefined : v)));
    expect(strip(k)).toEqual(strip(view({ education: true })));
    expect(k.version).toBe("knowledge/3");
  });

  it("without profiles no entry carries the keys at all (an older client sees exactly what it saw)", () => {
    const k = view();
    expect(knowledgeEntries(k).some((e) => "brandId" in e || "brandProfile" in e)).toBe(false);
  });

  it("brandSourcesFrom: the research's web sources, only http(s) links, de-duplicated, capped — for the clickable source links", () => {
    expect(brandSourcesFrom(null)).toEqual([]);
    expect(brandSourcesFrom("x")).toEqual([]);
    expect(brandSourcesFrom([
      { url: "https://brand.example/about", title: " About " },
      { url: "https://brand.example/about", title: "dup" },
      { url: "javascript:alert(1)", title: "bad" },
      null,
      { url: "http://news.example/a" },
      ...Array.from({ length: 8 }, (_, i) => ({ url: `https://s${i}.example/` })),
    ])).toEqual([
      { url: "https://brand.example/about", title: "About" },
      { url: "http://news.example/a", title: null },
      { url: "https://s0.example/", title: null },
      { url: "https://s1.example/", title: null },
      { url: "https://s2.example/", title: null },
    ]);
    expect(BRAND_PROFILE_LIMITS.sources).toBe(5);
    expect(brandProfileFrom({ description: "A brand.", sources: [{ url: "https://brand.example/" }] })?.sources).toEqual([{ url: "https://brand.example/", title: null }]);
    // Sources alone are not a profile.
    expect(brandProfileFrom({ sources: [{ url: "https://brand.example/" }] })).toBeNull();
  });

  it("brandProfileFrom: as stored, trimmed, deduplicated and capped; only http(s) images, the cover never repeated; null when the row holds nothing", () => {
    expect(brandProfileFrom({ category: null, description: "  ", audience_summary: null, sport_categories: [], known_athlete_partnerships: null, image_url: null, images: null })).toBeNull();
    const p = brandProfileFrom({
      category: " Luxury Goods ", description: "As stored.", audience_summary: null, sport_categories: ["tennis", "tennis", " soccer "],
      known_athlete_partnerships: Array.from({ length: 20 }, (_, i) => `Athlete ${i}`), image_url: "https://cdn.example/cover.jpg", images: ["https://cdn.example/cover.jpg", "gs://bucket/x.jpg", "https://cdn.example/1.jpg"],
    })!;
    expect(p).toMatchObject({ category: "Luxury Goods", description: "As stored.", audienceSummary: null, sportCategories: ["tennis", "soccer"], coverUrl: "https://cdn.example/cover.jpg", images: ["https://cdn.example/1.jpg"] });
    expect(p.knownAthletePartnerships).toHaveLength(BRAND_PROFILE_LIMITS.athletes);
  });
});
