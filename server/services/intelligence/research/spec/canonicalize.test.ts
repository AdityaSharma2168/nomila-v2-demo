/** claim-canonicalization/1 — closed, deterministic, schema-preserving; never infers, never loosens the registry. */

import { describe, expect, it } from "@jest/globals";
import { validateFactValue } from "../factRegistry";
import { CANONICALIZATION_VERSION, canonicalizeValue } from "./canonicalize";

const ok = (key: string, raw: unknown) => { const c = canonicalizeValue(key, raw); validateFactValue(key, c.value); return c; };
const refused = (key: string, raw: unknown) => { const c = canonicalizeValue(key, raw); expect(() => validateFactValue(key, c.value)).toThrow(); return c; };

describe("claim-canonicalization/1", () => {
  it("maps unambiguous field aliases and records every rule with the raw value", () => {
    const c = ok("name", { name: "Jane Doe" });
    expect(c).toMatchObject({ value: { full: "Jane Doe" }, raw: { name: "Jane Doe" }, applied: ["alias:name->full"], version: CANONICALIZATION_VERSION });
    expect(ok("nationality", { nationality: "United States" }).value).toEqual({ country: "United States" });
    expect(ok("position", { position: "Guard" }).value).toEqual({ text: "Guard" });
    expect(ok("graduation_year", { graduationYear: "2027" }).value).toEqual({ year: 2027 });
    expect(ok("affiliation", { team: "Indiana Fever", type: "professional", year: "2025-26" }).value).toEqual({ org: "Indiana Fever", orgKind: "pro", season: 2025 });
  });

  it("never overwrites a canonical field that is already present", () => {
    const c = canonicalizeValue("name", { full: "Jane Doe", name: "J. Doe" });
    expect(c.value).toEqual({ full: "Jane Doe", name: "J. Doe" });   // the alias is left in place → the strict registry refuses it
    expect(c.applied).toEqual([]);
    refused("name", { full: "Jane Doe", name: "J. Doe" });
  });

  it("maps closed enum aliases and safe year representations", () => {
    expect(ok("award", { name: "All-Big Ten First Team", year: "2024", level: "Conference" }).value).toEqual({ name: "All-Big Ten First Team", year: 2024, level: "conference" });
    expect(ok("achievement", { name: "WNBA Rookie of the Year", year: 2024, level: "League" }).value).toMatchObject({ level: "conference" });
    expect(ok("career_status", { status: "Free agent" }).value).toEqual({ status: "between_teams" });
    expect(ok("career_status", { value: "injured" }).value).toEqual({ status: "out_this_season" });
    expect(ok("ranking", { rankingBody: "ESPN", rank: "#3", year: "2023", scope: "Class of 2024" }).value).toEqual({ body: "ESPN", rank: 3, year: 2023, scope: "Class of 2024" });
    expect(ok("alias", { name: "CC", type: "Nickname" }).value).toEqual({ text: "CC", kind: "nickname" });
  });

  it("removes only known non-semantic or misplaced keys", () => {
    expect(ok("sport", { sport: "basketball", level: "WNBA", source: "espn", confidence: 0.9 }).value).toEqual({ sport: "basketball" });
    expect(ok("hometown", { city: "Troy", region: "Michigan", country: "USA", url: "https://x" }).value).toEqual({ city: "Troy", region: "Michigan", country: "USA" });
  });

  it("refuses rather than infers: a missing required field, an unknown enum, a free-text location or an ambiguous season stay refused", () => {
    expect(refused("alias", { name: "CC" }).applied).toEqual(["alias:name->text"]);            // kind is required and cannot be inferred
    expect(refused("award", { name: "MVP", year: 2024, level: "Galactic" }).applied).toEqual([]);   // unknown enum value is left as is
    expect(refused("hometown", { text: "Troy, Michigan" }).applied).toEqual([]);                   // never parsed into city/region, never emptied
    expect(refused("affiliation", { org: "USC", orgKind: "school", season: "2024-2026" }).applied).toEqual([]);   // a two-season range is not one year
    expect(refused("class_year", { season: 2026 }).applied).toEqual([]);                          // label missing
    expect(refused("national_team_participation", { team: "U-17 WNT", year: "2022" }).applied).toEqual(["year:year:\"2022\"->2022"]);   // level still missing
    expect(canonicalizeValue("name", "Jane Doe")).toMatchObject({ value: "Jane Doe", applied: [] });   // non-object values pass through untouched
  });
});

describe("claim-canonicalization/2", () => {
  it("parses a whole value given as a JSON string only when it parses to an object; anything else is untouched", () => {
    const c = ok("name", '{"name": "Jane Doe"}');
    expect(c.value).toEqual({ full: "Jane Doe" });
    expect(c.applied).toEqual(["json:parse", "alias:name->full"]);
    expect(canonicalizeValue("name", "not json")).toMatchObject({ value: "not json", applied: [] });
    expect(canonicalizeValue("name", '["Jane Doe"]')).toMatchObject({ value: '["Jane Doe"]', applied: [] });
    expect(canonicalizeValue("name", '{"name": "Jane Doe"')).toMatchObject({ value: '{"name": "Jane Doe"', applied: [] });   // invalid JSON stays a string → refused
    refused("name", "not json");
  });

  it("splits an affiliation tenure YYYY-YYYY into from/to only when neither is present; a single season is not a range", () => {
    const c = ok("affiliation", { team: "Portland Thorns", type: "pro", seasons: "2016-2020" });
    expect(c.value).toEqual({ org: "Portland Thorns", orgKind: "pro", from: "2016", to: "2020" });
    expect(c.applied).toContain('seasons:seasons:"2016-2020"->from/to');
    expect(canonicalizeValue("affiliation", { org: "X", orgKind: "pro", from: "2018", seasons: "2016-2020" }).value).toMatchObject({ from: "2018", seasons: "2016-2020" });   // never overwrites
    refused("affiliation", { org: "X", orgKind: "pro", from: "2018", seasons: "2016-2020" });
    expect(canonicalizeValue("affiliation", { org: "X", orgKind: "pro", seasons: "2025-26" }).value).toMatchObject({ seasons: "2025-26" });   // one season, not a tenure → refused, not guessed
    expect(canonicalizeValue("affiliation", { org: "X", orgKind: "pro", seasons: "2020-2016" }).value).toMatchObject({ seasons: "2020-2016" });
  });

  it("closed aliases for the v2 `pro` level and the endorsement deal type; unknown words are still refused", () => {
    expect(ok("award", { name: "All-AFLW", year: 2024, level: "Professional" }).value).toEqual({ name: "All-AFLW", year: 2024, level: "pro" });
    refused("award", { name: "All-AFLW", year: 2024, level: "AFLW" });
    expect(ok("endorsement", { brand_name: "Nike", type: "Brand ambassador", start: "2024-01-01" }).value).toEqual({ brand: "Nike", dealType: "ambassador", startDate: "2024-01-01" });
    expect(ok("endorsement", { brand: "Nike", deal_type: "Partnership" }).value).toEqual({ brand: "Nike", dealType: "sponsorship" });
    refused("endorsement", { brand: "Nike", deal_type: "friendship" });
    expect(ok("season_statistic", { stat: "assists", value: "8.4", year: "2024-25", league: "WNBA" }).value).toEqual({ metric: "assists", value: "8.4", season: 2024, competition: "WNBA" });
    expect(ok("birth_year", { born: "2010" }).value).toEqual({ year: 2010 });
    expect(ok("award", { name: "All-Star", year: 2024, level: null }).value).toEqual({ name: "All-Star", year: 2024, level: null });
    expect(ok("award", { name: "All-Star", year: 2024 }).value).toEqual({ name: "All-Star", year: 2024 });   // level unknown stays unknown
  });

  it("is deterministic and idempotent over a corpus: a second application changes nothing", () => {
    const corpus: [string, unknown][] = [
      ["name", '{"name": "Jane Doe"}'], ["name", { full: "Jane Doe", name: "J. Doe" }], ["affiliation", { team: "Indiana Fever", type: "professional", year: "2025-26" }],
      ["affiliation", { team: "Portland Thorns", type: "pro", seasons: "2016–2020" }], ["award", { title: "All-Big Ten", season: "2024", level: "Conference", source: "x" }],
      ["award", { name: "MVP", year: 2024, level: "Professional" }], ["ranking", { body: "ESPN", rank: "#3", year: "2023", scope: "Class of 2024" }],
      ["career_status", { status: "Free agent" }], ["endorsement", { brand_name: "Nike", type: "Brand ambassador", start: "2024-01-01" }],
      ["season_statistic", { stat: "assists", value: "8.4", year: "2024-25" }], ["birth_year", { born: "2010" }], ["nil_mention", { estimator: "On3", valuation: "$3.1M", season: "2025" }],
      ["national_team_participation", { programme: "USWNT", ageGroup: "U-17", season: "2022" }], ["hometown", { text: "somewhere" }], ["name", "not json"],
    ];
    for (const [key, raw] of corpus) {
      const once = canonicalizeValue(key, raw);
      const again = canonicalizeValue(key, raw);
      expect(again).toEqual(once);                                 // deterministic
      const twice = canonicalizeValue(key, once.value);
      expect(twice.value).toEqual(once.value);                     // idempotent
      expect(twice.applied).toEqual([]);
      expect(once.version).toBe(CANONICALIZATION_VERSION);
    }
  });
});
