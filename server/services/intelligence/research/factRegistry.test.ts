/**
 * factRegistry.test.ts — every fact key is registered, typed and normalized; unknown keys and
 * off-schema values are refused (design §4.5, R8).
 */

import { BLOCKING_KEYS, FACT_REGISTRY, FACT_REGISTRY_VERSION, getFactDefinition, isRegisteredKey, normalizeConference, normalizeText, RegistryError, validateFactValue, valueTextFor } from "./factRegistry";
import { FRESHNESS_FAMILIES, RESEARCH_DOMAINS } from "./registries";

describe("Fact Registry v1", () => {
  it("is versioned and every entry declares schema, cardinality, normalizer, resolver, freshness, scoring, blocking and display", () => {
    expect(FACT_REGISTRY_VERSION).toBe("v3");
    for (const [key, d] of Object.entries(FACT_REGISTRY)) {
      expect(d.key).toBe(key);
      expect(["single", "multi", "dated_multi"]).toContain(d.cardinality);
      expect(["authority_default", "affiliation", "dated_event", "identity_signal"]).toContain(d.resolver);
      expect(FRESHNESS_FAMILIES).toContain(d.freshnessFamily);
      expect(RESEARCH_DOMAINS).toContain(d.domain);
      expect(typeof d.scoring.eligible).toBe("boolean");
      if (d.scoring.eligible) expect(d.scoring.dimension).toBeTruthy();
      expect(typeof d.blocking).toBe("boolean");
      expect(d.display.label).toBeTruthy();
    }
    expect(BLOCKING_KEYS.sort()).toEqual(["affiliation", "name", "sport"]);
    expect(FACT_REGISTRY.nil_mention.scoring.eligible).toBe(false);   // never commercial_proof
  });

  it("validates values against the key's schema and refuses extra keys, wrong types and unknown keys", () => {
    expect(validateFactValue("sport", { sport: "Soccer" })).toEqual({ sport: "Soccer" });
    expect(() => validateFactValue("sport", { sport: "Soccer", extra: 1 })).toThrow(RegistryError);
    expect(() => validateFactValue("graduation_year", { year: "2027" })).toThrow(RegistryError);
    expect(() => validateFactValue("achievement", { name: "x", level: "galactic" })).toThrow(RegistryError);
    expect(() => validateFactValue("favourite_color", { text: "blue" })).toThrow(/unknown fact key/);
    expect(isRegisteredKey("story_arc")).toBe(false);   // prose is an inference, never a fact
    expect(() => getFactDefinition("story_arc")).toThrow(RegistryError);
  });

  it("normalizers give the grouping form: case, diacritics, whitespace, parenthesised conference abbreviations", () => {
    expect(normalizeText("  Mía  BHÚTA ")).toBe("mia bhuta");
    expect(normalizeConference("Atlantic Coast Conference (ACC)")).toBe("acc");
    expect(normalizeConference("ACC")).toBe("acc");
    expect(valueTextFor("affiliation", { org: "Stanford University", orgKind: "school", season: 2026 })).toBe("stanford university school 2026");
    expect(valueTextFor("achievement", { name: "All-ACC First Team", year: 2025, level: "conference" })).toBe("all acc first team 2025");
    expect(valueTextFor("class_year", { label: "Senior (2026 season)", season: 2026 })).toBe("senior 2026 season 2026");
  });
});

describe("Fact Registry v2: every relaxation preserves determinism and every v1 value stays valid", () => {
  const V1_VALID: [string, unknown][] = [
    ["name", { full: "Jane Doe" }], ["alias", { text: "JD", kind: "nickname" }], ["sport", { sport: "basketball" }], ["position", { text: "Guard" }], ["event", { text: "100m" }],
    ["class_year", { label: "Senior", season: 2026 }], ["graduation_year", { year: 2027 }], ["hometown", { city: "Springfield", region: "IL" }], ["nationality", { country: "USA" }],
    ["career_status", { status: "active" }], ["affiliation", { org: "Indiana Fever", orgKind: "pro", season: 2025 }],
    ["achievement", { name: "Champion", year: 2024, level: "national" }], ["award", { name: "MVP", year: 2024, level: "conference", org: "Big Ten" }],
    ["ranking", { body: "ESPN", rank: 3, year: 2023, scope: "Class of 2024" }], ["national_team_participation", { team: "USWNT U-17", level: "U-17", year: 2022 }],
    ["nil_mention", { source: "On3", value: "$3.1M", year: 2025 }],
  ];

  it("is v2 and keeps every v1 key; the three new keys are registered, typed, never scoring inputs and never blocking", () => {
    expect(FACT_REGISTRY_VERSION).toBe("v3");
    for (const [key, value] of V1_VALID) { expect(isRegisteredKey(key)).toBe(true); expect(validateFactValue(key, value)).toEqual(value); expect(validateFactValue(key, value)).toEqual(validateFactValue(key, value)); }
    for (const key of ["endorsement", "season_statistic", "birth_year"]) {
      expect(isRegisteredKey(key)).toBe(true);
      expect(getFactDefinition(key).scoring.eligible).toBe(false);
      expect(getFactDefinition(key).blocking).toBe(false);
    }
    expect(BLOCKING_KEYS.sort()).toEqual(["affiliation", "name", "sport"]);
  });

  it("award/achievement level: optional or null stays unknown (never defaulted); the enum gains pro; unknown words are refused", () => {
    expect(validateFactValue("award", { name: "MVP", year: 2024 })).toEqual({ name: "MVP", year: 2024 });
    expect(validateFactValue("award", { name: "MVP", year: 2024, level: null })).toEqual({ name: "MVP", year: 2024, level: null });
    expect(validateFactValue("achievement", { name: "Champion", year: 2024 })).toEqual({ name: "Champion", year: 2024 });
    expect(validateFactValue("award", { name: "MVP", year: 2024, level: "pro" }).level).toBe("pro");
    expect(() => validateFactValue("award", { name: "MVP", year: 2024, level: "AFLW" })).toThrow(RegistryError);
    expect(() => validateFactValue("award", { name: "MVP", year: 2024, level: "professional" })).toThrow(RegistryError);   // aliases live in canonicalization, not the registry
    expect(() => validateFactValue("award", { name: "MVP", level: "pro" })).toThrow(RegistryError);   // year still required
    expect(valueTextFor("award", { name: "MVP", year: 2024 })).toBe("mvp 2024");
  });

  it("national_team_participation: team may be omitted, level and year may not; event/result are optional; normalizer is stable", () => {
    expect(validateFactValue("national_team_participation", { level: "U-17", year: 2022 })).toEqual({ level: "U-17", year: 2022 });
    expect(validateFactValue("national_team_participation", { team: null, level: "senior", year: 2024, event: "Olympic Games", result: "gold" })).toMatchObject({ event: "Olympic Games", result: "gold" });
    expect(() => validateFactValue("national_team_participation", { team: "USWNT", year: 2022 })).toThrow(RegistryError);
    expect(() => validateFactValue("national_team_participation", { team: "USWNT", level: "senior" })).toThrow(RegistryError);
    expect(valueTextFor("national_team_participation", { level: "U-17", year: 2022 })).toBe("u 17 2022");
    expect(valueTextFor("national_team_participation", { team: "USWNT U-17", level: "U-17", year: 2022 })).toBe("uswnt u 17 u 17 2022");
  });

  it("endorsement, season_statistic and birth_year are strict shapes; nothing optional is invented", () => {
    expect(validateFactValue("endorsement", { brand: "Nike", dealType: "sponsorship" })).toEqual({ brand: "Nike", dealType: "sponsorship" });
    expect(() => validateFactValue("endorsement", { brand: "Nike" })).toThrow(RegistryError);
    expect(() => validateFactValue("endorsement", { brand: "Nike", dealType: "friendship" })).toThrow(RegistryError);
    expect(() => validateFactValue("endorsement", { brand: "Nike", dealType: "sponsorship", value: "$1M" })).toThrow(RegistryError);   // published value is evidence, not part of the fact
    expect(valueTextFor("endorsement", { brand: "Nike", dealType: "sponsorship", startDate: "2024-01-01" })).toBe("nike sponsorship 2024-01-01");
    expect(validateFactValue("season_statistic", { metric: "ppg", value: "19.2", season: 2024 })).toEqual({ metric: "ppg", value: "19.2", season: 2024 });
    expect(() => validateFactValue("season_statistic", { metric: "ppg", value: "19.2" })).toThrow(RegistryError);
    expect(validateFactValue("birth_year", { year: 2010 })).toEqual({ year: 2010 });
    expect(() => validateFactValue("birth_year", { year: 2010, date: "2010-05-01" })).toThrow(RegistryError);   // a date is never stored (minor minimization)
    expect(getFactDefinition("birth_year").cardinality).toBe("single");
    expect(getFactDefinition("endorsement").domain).toBe("brand_mentions");
  });
});

describe("Fact Registry v3 (Concept 0.4 B1): education, affiliation role; every v2 value stays valid", () => {
  it("keeps every v2 value valid (affiliation with a role but no roleSince/roleSeason, national team with a year)", () => {
    for (const [key, value] of [
      ["affiliation", { org: "Northfield College", orgKind: "school", season: 2026, role: "starter" }],
      ["national_team_participation", { team: "Freedonia U-20", level: "U-20", year: 2023, role: "captain" }],
      ["endorsement", { brand: "Acme", dealType: "sponsorship" }], ["season_statistic", { metric: "goals", value: "9", season: 2025 }], ["birth_year", { year: 2004 }],
    ] as [string, unknown][]) expect(validateFactValue(key, value)).toEqual(value);
  });

  it("education: institution required; program/degree/level/status/years optional and strict; never scoring, never blocking", () => {
    expect(validateFactValue("education", { institution: "Northfield College", degree: "BA Economics" })).toEqual({ institution: "Northfield College", degree: "BA Economics" });
    expect(validateFactValue("education", { institution: "Northfield College", program: "Economics", level: "undergraduate", status: "enrolled", startYear: 2023, endYear: 2027 })).toMatchObject({ level: "undergraduate", status: "enrolled" });
    expect(() => validateFactValue("education", { degree: "BA Economics" })).toThrow(/institution Required/);   // never invented
    expect(() => validateFactValue("education", { institution: "Northfield College", level: "postdoc" })).toThrow(RegistryError);
    expect(() => validateFactValue("education", { institution: "Northfield College", gpa: "4.0" })).toThrow(RegistryError);
    expect(valueTextFor("education", { institution: "Northfield College", degree: "B.A. Economics" })).toBe("northfield college b a economics");
    expect(getFactDefinition("education")).toMatchObject({ cardinality: "multi", domain: "profile", blocking: false, scoring: { eligible: false } });
  });

  it("affiliation: optional roleSince / roleSeason; the role never changes the grouping form", () => {
    const v = { org: "Northfield College", orgKind: "school", season: 2026, role: "co-captain", roleSince: "2026-08-13", roleSeason: 2026 };
    expect(validateFactValue("affiliation", v)).toEqual(v);
    expect(valueTextFor("affiliation", v)).toBe(valueTextFor("affiliation", { org: "Northfield College", orgKind: "school", season: 2026 }));
    expect(() => validateFactValue("affiliation", { ...v, roleSeason: "2026" })).toThrow(RegistryError);
  });
});
