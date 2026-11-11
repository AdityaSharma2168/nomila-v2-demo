/**
 * knowledgeGrouping.test.ts — What Nomila Knows, grouped on the client (Me screens refinement, Oct 2026).
 *
 * Pinned:
 *   • career: one row per organisation (exact meta.org, normalised), a year range, role chips only from firmly held
 *     entries, the entries behind it; the logo is the ORGANISATION's own domain — the evidence site's never passes, a
 *     generic name (a national team) gets the neutral mark
 *   • honours: identical title + year grouped; established → official → newest; the unconfirmed folded apart, never dropped
 *   • brands: one row per brand with its relationship chips
 *   • provenance: a glyph per fact; "Confirmed by you" is true only for a fact she herself confirmed
 */
import { brandGroups, careerGroups, confirmedByYou, honoursModel, isUnconfirmed, orgGroupKey, orgLogoDomain, provenanceOf } from "./knowledgeLogic";
import type { AthleteKnowledge, KnowledgeEntry } from "../hooks/use-me-knowledge";

const src = (key: KnowledgeEntry["source"] extends infer S ? S extends { key: infer K } ? K : never : never, label: string) => ({ key, label, detail: null });
const e = (over: Partial<KnowledgeEntry> & { id: string }): KnowledgeEntry => ({
  label: "Entry", value: "Value", state: "present", source: src("researched", "Researched"), status: "current", stale: false, at: null, evidence: [], correct: null,
  tier: "reported", logoDomain: null, ref: null, yourDispute: null, meta: null, ...over,
});

test("the organisation's own domain, never the evidence site's; a generic name vouches for nothing", () => {
  expect(orgLogoDomain("Example University", "example.edu")).toBe("example.edu");
  expect(orgLogoDomain("Example University", "www.goexample.com")).toBe("www.goexample.com");
  expect(orgLogoDomain("Harbour Rowing Club", "harbourrc.org.uk")).toBe("harbourrc.org.uk");
  // The school's site reported her national-team call-up: its domain must not become the national team's logo.
  expect(orgLogoDomain("United States Youth National Team", "goexample.com")).toBeNull();
  expect(orgLogoDomain("U-20 National Team", "news.example")).toBeNull();
  // A news site that reported a club is not the club.
  expect(orgLogoDomain("Harbour Rowing Club", "news.example")).toBeNull();
  // A brand's own site passes; a guessed, unrelated one does not.
  expect(orgLogoDomain("Brand P", "brandp.example")).toBe("brandp.example");
  expect(orgLogoDomain("Yuwa football academy", "yuwa-india.org")).toBe("yuwa-india.org");
  expect(orgLogoDomain("Nil Deal", "amazon.com")).toBeNull();
  expect(orgLogoDomain("Anything", null)).toBeNull();
  expect(orgGroupKey("  Café United FC ")).toBe("cafe united fc");
});

test("career: one row per organisation, year range, role chips from firm entries, the entries behind it", () => {
  const groups = careerGroups([
    e({ id: "team_1", label: "Current team", value: "Example University — 2023 – present", logoDomain: "example.edu", tier: "established", source: src("you", "Confirmed by you"), meta: { org: "Example University", orgKind: "school", span: "2023 – present", role: "Captain (2026)", year: null } }),
    e({ id: "national_1", label: "National team", value: "U-17 National Team · World Cup (2022)", source: src("official", "Official source"), tier: "established", logoDomain: "goexample.com", meta: { org: "U-17 National Team", orgKind: "national", span: "2022", role: "Captain", year: 2022 } }),
    e({ id: "national_2", label: "National team", value: "U-17 National Team · Friendly (2023)", source: src("researched", "Researched"), tier: "reported", logoDomain: "news.example", meta: { org: "U-17 National Team", orgKind: "national", span: "2023", role: null, year: 2023 } }),
    e({ id: "team_2", label: "Past team", value: "Harbour FC", status: "historical", tier: "unconfirmed", meta: { org: "Harbour FC", orgKind: "club", span: "2019 – 2021", role: "Captain", year: null } }),
    e({ id: "blank", state: "unknown", value: null }),
  ]);
  expect(groups.map((g) => [g.org, g.range, g.entries.length, g.roles, g.logoDomain, g.provenance.glyph, g.provenance.unconfirmed])).toEqual([
    ["Example University", "2023 – present", 1, ["Captain (2026)"], "example.edu", "you", false],
    ["U-17 National Team", "2022 – 2023", 2, ["Captain"], null, "document", false],          // the school's site never becomes its logo
    ["Harbour FC", "2019 – 2021", 1, [], null, "search", true],                              // unconfirmed: no role chip, folded glyph
  ]);
});

test("honours: identical title + year grouped; established → official → newest; the unconfirmed folded apart", () => {
  const m = honoursModel([
    e({ id: "a1", value: "All-Region first team (2024)", source: src("official", "Official source"), tier: "established", meta: { year: 2024 } }),
    e({ id: "a2", value: "Conference Tournament Champions (2025)", source: src("official", "Official source"), tier: "established", meta: { year: 2025 } }),
    e({ id: "a3", value: "Conference tournament champions (2025)", source: src("researched", "Researched"), tier: "reported", meta: { year: 2025 } }),   // the same honour, worded alike
    e({ id: "a4", value: "Preseason Watch List (2025)", source: src("researched", "Researched"), tier: "reported", meta: { year: 2025 } }),
    e({ id: "a5", value: "All-America fourth team (2024)", source: src("official", "Official source"), tier: "established", meta: { year: 2024 } }),
    e({ id: "a6", value: "#12 national ranking — Site A (2024)", tier: "unconfirmed", status: "disputed", meta: { year: 2024 } }),
    e({ id: "a7", value: "#9 national ranking — Site B (2024)", tier: "unconfirmed", status: "disputed", meta: { year: 2024 } }),
    e({ id: "a8", value: "Player of the Week (2023)", source: src("official", "Official source"), tier: "established", meta: { year: 2023 } }),
    e({ id: "a9", value: "Disputed Award (2022)", source: src("official", "Official source"), tier: "unconfirmed", yourDispute: { said: "Never won it", at: null }, meta: { year: 2022 } }),
  ], 4);
  expect(m.top.map((h) => [h.name, h.year, h.entries.length])).toEqual([
    ["Conference Tournament Champions", 2025, 2],
    ["All-Region first team", 2024, 1],
    ["All-America fourth team", 2024, 1],
    ["Player of the Week", 2023, 1],
  ]);
  expect(m.more.map((h) => h.name)).toEqual(["Preseason Watch List"]);
  expect(m.unconfirmed.map((h) => h.name)).toEqual(["#12 national ranking — Site A", "#9 national ranking — Site B", "Disputed Award"]);
  for (const h of m.unconfirmed) expect(h.provenance.unconfirmed).toBe(true);
  // The year never stays in the title.
  for (const h of [...m.top, ...m.more, ...m.unconfirmed]) expect(h.name).not.toMatch(/\(\d{4}\)/);
});

test("brands: one row per brand with its relationship chips; the logo only from the brand's own domain", () => {
  const k = {
    categories: [{ key: "partnerships", title: "", blurb: "", state: "present", count: 3, bySource: {}, sections: [
      { key: "confirmed", title: "", entries: [e({ id: "partner_0", label: "Partner", value: "Brand P", source: src("proof", "From your deals"), tier: "established", logoDomain: "brandp.example" })] },
      { key: "reported", title: "", entries: [e({ id: "endorsement_1", label: "Nil deal", value: "Brand P · campaign · 2023", meta: { org: "Brand P" }, logoDomain: "amazon.com", logoUrl: "https://cdn.example/brand-p.png" }), e({ id: "endorsement_2", label: "Sponsorship", value: "Brand Q · 2024", meta: { org: "Brand Q" } })] },
      { key: "seen", title: "", entries: [e({ id: "brand_seen_1", label: "Seen with", value: "Brand Q", meta: { org: "Brand Q" }, logoDomain: "brandq.example" }), e({ id: "blank", state: "unknown", value: null })] },
    ] }],
  } as unknown as AthleteKnowledge;
  // The stored logo (inbox_brands.logo_url) rides the row from whichever entry carries it; presentation only.
  expect(brandGroups(k).map((g) => [g.name, g.chips, g.entries.length, g.logoDomain, g.logoUrl, g.provenance.glyph])).toEqual([
    ["Brand P", ["Partner", "Nil deal"], 2, "brandp.example", "https://cdn.example/brand-p.png", "proof"],
    ["Brand Q", ["Sponsorship", "Seen with"], 2, "brandq.example", null, "search"],
  ]);
});

test("provenance per fact: the glyph by source; 'Confirmed by you' only for her own word; unconfirmed by tier, dispute or her denial", () => {
  expect(provenanceOf(e({ id: "x", source: src("you", "Confirmed by you") }))).toEqual({ glyph: "you", unconfirmed: false });
  expect(provenanceOf(e({ id: "x", source: src("official", "Official source") })).glyph).toBe("document");
  expect(provenanceOf(e({ id: "x", source: src("proof", "From your deals") })).glyph).toBe("proof");
  expect(provenanceOf(e({ id: "x", source: src("connected", "Connected") })).glyph).toBe("link");
  expect(provenanceOf(e({ id: "x", source: src("researched", "Researched"), tier: "unconfirmed" }))).toEqual({ glyph: "search", unconfirmed: true });
  expect(isUnconfirmed(e({ id: "x", status: "disputed" }))).toBe(true);
  expect(isUnconfirmed(e({ id: "x", yourDispute: { said: null, at: null } }))).toBe(true);
  expect(confirmedByYou(e({ id: "x", source: src("you", "Confirmed by you") }))).toBe(true);
  expect(confirmedByYou(e({ id: "x", source: src("official", "Official source"), tier: "established" }))).toBe(false);
});
