/**
 * KnowsScreen.test — Concept 0.4 "What Nomila Knows" (knowledge/3, grouped on the client), rendered from served data only.
 *
 *   hero         "What Nomila knows about you"; nothing anywhere says "verified"
 *   at a glance  team / school with its OWN logo (ui/LogoMark), sport · position, hometown · nationality · class;
 *                "Confirmed by you" only under the fact she confirmed — never as a card-wide badge
 *   career       one row per organisation; the org's own logo, a glyph mark for a national team (never the school's
 *                site that reported it); the year range; the role chip only from firmly held entries; tap → the entries
 *   honours      grouped title + year, the year in its column; the unconfirmed folded under "Unconfirmed (n)"
 *   brands       one row per brand with relationship chips, the STORED logo (inbox_brands.logo_url) first, else the
 *                brand's own domain; a brand row opens the brand screen; academics present or the invite; business invite
 *   density      At a glance and Brands & business stay plain; every other section shows ONE preview row and "See all N"
 *                expanding in place ("Show less" to fold); the unconfirmed fold stays independent of it
 *   eyebrows     sentence case in copy ("At a glance"), capitals by the eyebrow role
 *   provenance   a glyph per row, no "Researched" / "Official source" words on the face; the tier in words in the sheet
 *   tap          a correctable entry opens the existing editor; any other opens the info sheet with "This isn't right",
 *                which sends POST /me/knowledge/disputes { entryId, said }
 */
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import React from "react";
import { KnowsScreen } from "./KnowsScreen";

const navigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => {}, navigate, getParent: () => undefined, setParams: () => {} }),
  useRoute: () => ({ params: undefined }),
}));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
jest.mock("../../components/record/RecordSheet", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { RecordSheet: ({ entry }: { entry: { field: string } | null }) => (entry ? React.createElement(Text, null, `record-sheet:${entry.field}`) : null) };
});
jest.mock("../../components/record/TeamSheet", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { TeamSheet: ({ index }: { index: number | null }) => React.createElement(Text, null, `team-sheet:${index}`) };
});
jest.mock("../../components/record/CareerSheet", () => ({ CareerSheet: () => null }));

const mutate = jest.fn();
let knowledge: any = null;
jest.mock("../../hooks/use-me-knowledge", () => ({
  useMeKnowledge: () => ({ data: knowledge, isLoading: false, isError: false, refetch: () => {} }),
  useMePool: () => [],
  useDisputeKnowledgeEntry: () => ({ mutate, isPending: false, isError: false }),
}));

const src = (key: string, label: string, detail: string | null = null) => ({ key, label, detail });
const e = (over: any) => ({
  label: "Entry", value: "Value", state: "present", source: src("you", "Confirmed by you"), status: "current", stale: false, at: null, evidence: [], correct: null,
  tier: "established", logoDomain: null, ref: null, yourDispute: null, meta: null, ...over,
});
const blank = (id: string, label: string) => e({ id, label, value: null, state: "unknown", source: null, tier: null, status: null });
const teamsCorrect = { field: "affiliations", shape: "teams", label: "Teams", raw: { index: 0, teams: [] } };

const view = (over: { academics?: any; extraHonours?: any[] } = {}) => ({
  version: "knowledge/3", athleteId: "a", builtAt: "2026-10-01T00:00:00.000Z", researchAsOf: null,
  identity: { displayName: "Sam", fullName: "Sam Example", photoUrl: null, primary: null, facts: [], nationality: "Testland", role: null },
  keyFacts: [
    e({ id: "name", label: "Name", value: "Sam Example" }),
    e({ id: "team_1", label: "School", value: "Example University", logoDomain: "example.edu", correct: { ...teamsCorrect }, meta: { org: "Example University", orgKind: "school" } }),
    e({ id: "sport", label: "Sport", value: "Example Sport", correct: { field: "sport", shape: "text", label: "Sport" } }),
    e({ id: "position", label: "Position", value: "Example Position", correct: { field: "position", shape: "text", label: "Position" } }),
    e({ id: "hometown", label: "Hometown", value: "Example City", source: src("official", "Official source"), correct: { field: "hometown", shape: "text", label: "Hometown" } }),
    e({ id: "nationality", label: "Nationality", value: "Testland", source: src("researched", "Researched", "news.example"), tier: "reported", ref: { kind: "fact", id: "f-nat" }, evidence: [{ url: "https://news.example/a", domain: "news.example" }] }),
    e({ id: "class_year", label: "Class", value: "Senior · 2026 season", source: src("official", "Official source"), correct: { field: "class_year", shape: "text", label: "Class year" } }),
  ],
  categories: [
    { key: "athletics", title: "Athletics", blurb: "", state: "present", count: 4, bySource: {}, sections: [
      { key: "profile", title: "Profile", entries: [e({ id: "level", label: "Level", value: "D1 · Example Conference" })] },
      { key: "teams", title: "Athletic career", entries: [
        e({ id: "team_1", label: "Current team", value: "Example University — 2023 – present", logoDomain: "example.edu", correct: { ...teamsCorrect }, meta: { org: "Example University", orgKind: "school", span: "2023 – present", role: "Captain (2026)" } }),
        e({ id: "team_2", label: "Past team", value: "Example City FC", status: "historical", source: src("researched", "Researched"), meta: { org: "Example City FC", orgKind: "club", span: "2021 – 2022", role: "Captain" }, tier: "unconfirmed", ref: { kind: "fact", id: "f-club" } }),
        // Two national-team entries, both reported by the SCHOOL's official site: one row, and never the school's logo.
        e({ id: "national_1", label: "National team", value: "U-20 National Team (2024)", source: src("official", "Official source"), logoDomain: "example.edu", meta: { org: "U-20 National Team", orgKind: "national", span: "2024", year: 2024 }, ref: { kind: "fact", id: "f-nt" } }),
        e({ id: "national_2", label: "National team", value: "U-20 National Team · Friendly (2025)", source: src("official", "Official source"), logoDomain: "example.edu", meta: { org: "U-20 National Team", orgKind: "national", span: "2025", year: 2025 }, ref: { kind: "fact", id: "f-nt2" } }),
      ] },
      { key: "honours", title: "Recognition & honours", entries: [
        e({ id: "achievement_1", label: "Award", value: "Conference Player of the Year (2025)", source: src("official", "Official source"), meta: { year: 2025 }, ref: { kind: "fact", id: "f-a1" } }),
        e({ id: "achievement_3", label: "Award", value: "Conference player of the year (2025)", source: src("researched", "Researched"), tier: "reported", meta: { year: 2025 }, ref: { kind: "fact", id: "f-a3" } }),
        e({ id: "ranking_1", label: "Ranking", value: "#12 national — Site A (2024)", source: src("researched", "Researched"), tier: "unconfirmed", status: "disputed", meta: { year: 2024 }, ref: { kind: "fact", id: "f-r1" } }),
        ...(over.extraHonours ?? []),
      ] },
    ] },
    { key: "partnerships", title: "Partnerships", blurb: "", state: "present", count: 1, bySource: {}, sections: [
      { key: "confirmed", title: "Your partnerships", entries: [e({ id: "partner_0", label: "Partner", value: "Brand P", source: src("proof", "From your deals"), logoDomain: "brandp.example", logoUrl: "https://cdn.example/brand-p.png" })] },
      { key: "reported", title: "Reported partnerships", entries: [e({ id: "endorsement_1", label: "Nil deal", value: "Brand P · campaign · 2023", source: src("researched", "Researched"), tier: "reported", logoDomain: "unrelated.example", meta: { org: "Brand P" } })] },
      { key: "seen", title: "Brands seen with you", entries: [blank("seen", "Brands seen with you")] },
    ] },
    { key: "media", title: "Media & audience", blurb: "", state: "unknown", count: 0, bySource: {}, sections: [{ key: "press", title: "Press", entries: [blank("press", "Press")] }, { key: "social", title: "Social", entries: [blank("audience", "Audience")] }] },
    { key: "interests", title: "Interests", blurb: "", state: "unknown", count: 0, bySource: {}, sections: [{ key: "interests", title: "In your words", entries: [blank("hobbies", "Off the field")] }] },
    over.academics ?? { key: "academics", title: "Academics", blurb: "Nothing on record about your studies yet.", state: "unavailable", count: null, bySource: {}, sections: [] },
    { key: "business", title: "Business", blurb: "Nomila doesn't track ventures yet.", state: "unavailable", count: null, bySource: {}, sections: [] },
  ],
  total: 9, bySource: {}, omitted: { legacyValues: 1 },
});

function texts(node: any): string[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.children);
}
const allText = () => texts(screen.toJSON()).join(" | ");
const imageUris = () => screen.UNSAFE_getAllByType(require("react-native").Image).map((i: any) => String(i.props.source?.uri ?? ""));

beforeEach(() => { mutate.mockReset(); navigate.mockReset(); knowledge = view(); });

describe("What Nomila Knows (grouped)", () => {
  it("hero, at a glance and the career rows; nothing says verified", () => {
    render(<KnowsScreen />);
    const t = allText();
    expect(t).toContain("What Nomila knows about you");
    expect(t).toContain("At a glance");
    expect(t).not.toContain("AT A GLANCE");                 // sentence case in copy; the eyebrow role sets the capitals
    expect(t).toContain("Example University");
    expect(t).toContain("Example Sport · Example Position");
    expect(t).toContain("Example City");
    expect(t).toContain("Testland");
    expect(t).toContain("Senior · 2026 season");
    expect(t).toContain("Your athletic career");
    expect(t).toContain("2023 – present");
    expect(t.toLowerCase()).not.toContain("verified");
  });

  it("density: the career shows ONE preview row and See all 3; expanded in place, Show less folds it; At a glance stays plain", () => {
    render(<KnowsScreen />);
    expect(screen.queryByText("U-20 National Team")).toBeNull();
    expect(screen.queryByText("Example City FC")).toBeNull();
    const fold = screen.getByTestId("knows-career-see-all");
    expect(fold.props.accessibilityState).toEqual({ expanded: false });
    expect(within(fold).getByText("See all 3")).toBeTruthy();
    fireEvent.press(fold);
    expect(screen.getByText("U-20 National Team")).toBeTruthy();
    expect(screen.getByText("Example City FC")).toBeTruthy();
    expect(within(screen.getByTestId("knows-career-see-all")).getByText("Show less")).toBeTruthy();
    fireEvent.press(screen.getByTestId("knows-career-see-all"));
    expect(screen.queryByText("U-20 National Team")).toBeNull();
    // one row only: nothing to fold
    expect(screen.queryByTestId("knows-honours-see-all")).toBeNull();
    expect(screen.queryByTestId("knows-glance-see-all")).toBeNull();
    expect(screen.queryByTestId("knows-brands-see-all")).toBeNull();
  });

  it("one row per organisation; the org's OWN logo, never the reporting site's; the year range; the role chip only when firm", () => {
    render(<KnowsScreen />);
    fireEvent.press(screen.getByTestId("knows-career-see-all"));
    const t = allText();
    // The two national-team entries collapse into one row with their range.
    expect(screen.getAllByText("U-20 National Team")).toHaveLength(1);
    expect(t).toContain("2024 – 2025");
    // The school's logo appears for the school (glance + career), and NOWHERE else: the national team gets the flag.
    const uris = imageUris().filter((u) => u.includes("example.edu"));
    expect(uris).toHaveLength(2);
    expect(within(screen.getByTestId("career-u-20-national-team")).getByText("icon:flag")).toBeTruthy();
    expect(t).toContain("Captain (2026)");               // established current team
    expect(t).not.toMatch(/(^|\| )Captain( \||$)/);      // the unconfirmed past team's role is not shown as a chip
    // Tapping a grouped row opens the entries behind it.
    fireEvent.press(screen.getByTestId("career-u-20-national-team"));
    const behind = within(screen.getByTestId("knows-behind"));
    expect(behind.getByText("U-20 National Team (2024)")).toBeTruthy();
    expect(behind.getByText("U-20 National Team · Friendly (2025)")).toBeTruthy();
  });

  it("'Confirmed by you' only under the fact she confirmed; provenance as glyphs, not words, on the face", () => {
    render(<KnowsScreen />);
    fireEvent.press(screen.getByTestId("knows-career-see-all"));
    const t = allText();
    expect(screen.getAllByText("Confirmed by you")).toHaveLength(1);          // under the glance team (hers), nowhere else
    expect(t).not.toMatch(/\| (Researched|Official source)( · (reported|unconfirmed))? \|/);
    expect(screen.getAllByTestId(/^prov-/).length).toBeGreaterThan(3);
  });

  it("honours grouped, the year in its column, the unconfirmed folded; academics invite; brands as one row with chips; business invite", () => {
    render(<KnowsScreen />);
    const t = allText();
    expect(screen.getAllByText("Conference Player of the Year")).toHaveLength(1);   // two entries, one row
    expect(t).toContain("2025");
    expect(t).not.toContain("Conference Player of the Year (2025)");
    expect(t).not.toContain("#12 national");                                        // folded
    fireEvent.press(screen.getByTestId("knows-unconfirmed"));
    expect(within(screen.getByTestId("knows-unconfirmed-list")).getByText("#12 national — Site A")).toBeTruthy();
    expect(t).toContain("Unconfirmed (1)");
    expect(t).toContain("Nothing on record about your studies yet.");
    // One brand row: the confirmed partner and the reported deal; the STORED logo first (never the unrelated site's).
    expect(screen.getAllByText("Brand P")).toHaveLength(1);
    expect(imageUris()).toContain("https://cdn.example/brand-p.png");
    expect(imageUris().some((u) => u.includes("unrelated.example"))).toBe(false);
    expect(imageUris().some((u) => u.includes("clearbit"))).toBe(false);
    const brand = within(screen.getByTestId("brand-brand-p"));
    expect(brand.getByText("Partner")).toBeTruthy();
    expect(brand.getByText("Nil deal")).toBeTruthy();
    expect(t).toContain("Help Nomila know you: tell Mila about anything you've started or built.");
    // a brand row opens the brand's deck + letter
    fireEvent.press(screen.getByTestId("brand-brand-p"));
    expect(navigate).toHaveBeenLastCalledWith("KnowsBrand", { key: "brand p" });
    expect(screen.queryByTestId("knows-behind")).toBeNull();
  });

  it("academics, when present, lists education and academic honours", () => {
    knowledge = view({ academics: { key: "academics", title: "Academics", blurb: "", state: "present", count: 1, bySource: {}, sections: [
      { key: "education", title: "Education", entries: [e({ id: "education_1", label: "Degree", value: "BS Example Studies · Example University", source: src("official", "Official source"), logoDomain: "example.edu", meta: { org: "Example University", year: 2026 } })] },
    ] } });
    render(<KnowsScreen />);
    expect(allText()).toContain("BS Example Studies · Example University");
    expect(allText()).not.toContain("Nothing on record about your studies yet.");
  });

  it("a correctable entry opens the existing editor", () => {
    render(<KnowsScreen />);
    fireEvent.press(screen.getByTestId("entry-class_year"));
    expect(allText()).toContain("record-sheet:class_year");
  });

  it("any other entry opens its info sheet with the tier in words; This isn't right sends the dispute with her words", () => {
    render(<KnowsScreen />);
    fireEvent.press(screen.getByTestId("entry-nationality"));
    const t = allText();
    expect(t).toContain("Researched · reported");
    expect(t).toContain("news.example");
    fireEvent.changeText(screen.getByLabelText("What's wrong with it"), "Wrong country");
    fireEvent.press(screen.getByText("This isn't right"));
    expect(mutate).toHaveBeenCalledWith({ entryId: "nationality", said: "Wrong country" }, expect.anything());
  });

  it("an entry she already disputed folds under Unconfirmed, shows her words in its sheet and offers no second dispute", () => {
    knowledge = view({ extraHonours: [e({ id: "achievement_2", label: "Award", value: "Disputed Award (2024)", source: src("official", "Official source"), tier: "unconfirmed", yourDispute: { said: "Never won it", at: null }, meta: { year: 2024 } })] });
    render(<KnowsScreen />);
    expect(allText()).toContain("Unconfirmed (2)");
    fireEvent.press(screen.getByTestId("knows-unconfirmed"));
    fireEvent.press(screen.getByTestId("honour-achievement_2"));
    expect(allText()).toContain("You said | “Never won it”");   // the her-words block: the blue label, then her words
    expect(screen.queryByText("This isn't right")).toBeNull();
  });
});
