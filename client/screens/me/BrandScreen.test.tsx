/**
 * BrandScreen.test — one brand from What Nomila Knows as a deck + a letter (the density pass).
 *
 *   the deck    pages per field that exists, in BrandDeckHero's order: identity (always) · about (the description as
 *               stored, trimmed to ~2 sentences) · athletes they work with · their audience + sports; images but no text
 *               ⇒ identity + image-only pages; nothing ⇒ a single hero, no counter; never a fit page
 *   the letter  "<Brand> and you": what Nomila knows (tier · source · date), what she told Nomila (her-words style),
 *               heard-not-confirmed, the contract request only when an intelligence request asks for this brand's
 *               contract; NO "Deal status" or any placeholder row; the deck's facts never repeat in the letter
 *   control     tapping a fact opens the one existing info sheet with "This isn't right"
 */
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import React from "react";
import { Linking } from "react-native";
import { BrandScreen, contractRequestFor } from "./BrandScreen";

let params: any = { key: "brand p" };
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => {}, navigate: () => {}, getParent: () => undefined }),
  useRoute: () => ({ params }),
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
jest.mock("../../components/deals/AddContractSheet", () => ({ AddContractSheet: () => null }));

const mutate = jest.fn();
let knowledge: any = null;
let requests: any[] = [];
jest.mock("../../hooks/use-me-knowledge", () => ({
  useMeKnowledge: () => ({ data: knowledge, isLoading: false, isError: false, refetch: () => {} }),
  useDisputeKnowledgeEntry: () => ({ mutate, isPending: false, isError: false }),
}));
jest.mock("../../hooks/use-intelligence-requests", () => ({ useIntelligenceRequests: () => ({ data: { items: requests, waiting: 0 } }) }));

const src = (key: string, label: string, detail: string | null = null) => ({ key, label, detail });
const e = (over: any) => ({
  label: "Entry", value: "Value", state: "present", source: src("proof", "From your deals"), status: "current", stale: false, at: null, evidence: [], correct: null,
  tier: "established", logoDomain: null, logoUrl: null, ref: null, yourDispute: null, meta: null, ...over,
});
const profile = {
  category: "Luxury Goods",
  description: "gorjana-like is a coastal jewelry brand known for everyday pieces. Family-run since 2004, it has scaled nationwide. A third sentence that the deck never shows.",
  audienceSummary: "Primarily women aged 25-34 seeking accessible luxury.",
  sportCategories: ["tennis", "soccer"], knownAthletePartnerships: ["Athlete One", "Athlete Two"],
  coverUrl: "https://cdn.example/cover.jpg", images: ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"],
  sources: [{ url: "https://www.brandp.example/about", title: "About" }],
};
const view = (partnerOver: any = {}, extra: any[] = []) => ({
  version: "knowledge/3", athleteId: "a", builtAt: "2026-10-01T00:00:00.000Z", researchAsOf: null,
  identity: { displayName: "Sam", fullName: "Sam Example", photoUrl: null, primary: null, facts: [], nationality: null, role: null },
  keyFacts: [],
  categories: [
    { key: "partnerships", title: "Partnerships", blurb: "", state: "present", count: 1, bySource: {}, sections: [
      { key: "confirmed", title: "Your partnerships", entries: [e({ id: "partner_0", label: "Partner", value: "Brand P", logoDomain: "brandp.example", logoUrl: "https://cdn.example/brand-p.png", brandId: 164, brandProfile: profile, at: "2023-01-01T00:00:00.000Z", ...partnerOver })] },
      { key: "reported", title: "Reported partnerships", entries: [
        e({ id: "endorsement_1", label: "Nil deal", value: "Brand P · back-to-school campaign · 2023", source: src("researched", "Researched", "news.example"), tier: "reported", meta: { org: "Brand P" }, at: "2023-05-31T00:00:00.000Z" }),
        e({ id: "endorsement_2", label: "Nil deal", value: "Brand P · one of its first signings", source: src("researched", "Researched"), tier: "unconfirmed", meta: { org: "Brand P" } }),
        ...extra,
      ] },
      { key: "seen", title: "Brands seen with you", entries: [] },
    ] },
    { key: "interests", title: "Interests", blurb: "", state: "present", count: 1, bySource: {}, sections: [{ key: "interests", title: "In your words", entries: [
      e({ id: "brands_causes", label: "Brands & causes", value: "Personal contract with Brand P; the school deal is separate.", source: src("you", "Confirmed by you", "told Mila"), correct: { field: "brands_causes", shape: "list", label: "Brands & causes" } }),
    ] }] },
  ],
  total: 3, bySource: {}, omitted: { legacyValues: 0 },
});

function texts(node: any): string[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.children);
}
const allText = () => texts(screen.toJSON()).join(" | ");
const letterText = () => texts(screen.getByTestId("letter")).join(" | ");
const images = () => screen.UNSAFE_queryAllByType(require("react-native").Image).map((i: any) => String(i.props.source?.uri ?? ""));

beforeEach(() => { mutate.mockReset(); knowledge = view(); requests = []; params = { key: "brand p" }; });

describe("the brand deck", () => {
  it("full research: identity · about (two sentences, as stored) · athletes · audience + sports — four pages, counter 1 / 4, no fit page", () => {
    render(<BrandScreen />);
    expect(screen.getByText("1 / 4")).toBeTruthy();
    expect(screen.getByTestId("deck-identity")).toBeTruthy();
    expect(screen.getByText(" · Luxury Goods")).toBeTruthy();
    expect(within(screen.getByTestId("deck-about")).getByText("gorjana-like is a coastal jewelry brand known for everyday pieces. Family-run since 2004, it has scaled nationwide.")).toBeTruthy();
    expect(allText()).not.toContain("A third sentence");
    // The research's web sources ride the about page as clickable links (OpenAI's citation rule).
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    fireEvent.press(within(screen.getByTestId("deck-about")).getByLabelText("Open source: brandp.example"));
    expect(open).toHaveBeenCalledWith("https://www.brandp.example/about");
    open.mockRestore();
    const athletes = within(screen.getByTestId("deck-athletes"));
    expect(athletes.getByText("Athlete One")).toBeTruthy();
    expect(athletes.getByText("Athlete Two")).toBeTruthy();
    const audience = within(screen.getByTestId("deck-audience"));
    expect(audience.getByText("Primarily women aged 25-34 seeking accessible luxury.")).toBeTruthy();
    expect(audience.getByText("tennis")).toBeTruthy();
    expect(screen.getAllByTestId("deck-chip-blue")).toHaveLength(2);
    expect(allText()).not.toMatch(/Fit for you|Sport fit|Audience fit|Diversification/);
    // the cover leads; the fact pages take the ranked images; the brand's logo rides the identity pill
    expect(images()).toEqual(expect.arrayContaining(["https://cdn.example/cover.jpg", "https://cdn.example/1.jpg", "https://cdn.example/2.jpg", "https://cdn.example/brand-p.png"]));
    // the deck's facts never repeat in the letter
    const letter = letterText();
    expect(letter).not.toContain("Athlete One");
    expect(letter).not.toContain("accessible luxury");
    expect(letter).not.toContain("coastal jewelry");
  });

  it("images but no text research: identity plus image-only pages; no research at all: a single hero, no counter", () => {
    knowledge = view({ brandProfile: { ...profile, category: "Athletic Apparel", description: null, audienceSummary: null, sportCategories: [], knownAthletePartnerships: [] } });
    const a = render(<BrandScreen />);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(screen.queryByTestId("deck-about")).toBeNull();
    expect(screen.queryByTestId("deck-athletes")).toBeNull();
    expect(screen.getByTestId("deck-image-2").props.source.uri).toBe("https://cdn.example/1.jpg");
    expect(screen.getByTestId("deck-image-3").props.source.uri).toBe("https://cdn.example/2.jpg");
    a.unmount();
    knowledge = view({ brandProfile: null, brandId: null });
    render(<BrandScreen />);
    expect(screen.queryByTestId("deck-counter")).toBeNull();
    expect(screen.queryByTestId("deck-page-2")).toBeNull();
    expect(screen.getByTestId("deck-blank-1")).toBeTruthy();
    expect(screen.getByTestId("deck-identity")).toBeTruthy();
  });
});

describe("the brand letter", () => {
  it("'<Brand> and you': what Nomila knows with tier · source · date, her words in her-words style, heard-not-confirmed; no deal status or placeholder row", () => {
    render(<BrandScreen />);
    expect(screen.getByTestId("letter-title").props.children).toBe("Brand P and you");
    const t = allText();
    expect(t).toContain("What Nomila knows, and where each fact came from");
    expect(within(screen.getByTestId("letter")).getByText("Partner")).toBeTruthy();           // the relationship chip
    const knows = within(screen.getByTestId("brand-knows"));
    expect(knows.getByText("Partner · Brand P")).toBeTruthy();
    expect(knows.getByText("Brand P · back-to-school campaign · 2023")).toBeTruthy();
    expect(knows.getByText("Established")).toBeTruthy();
    expect(knows.getByText("Reported")).toBeTruthy();
    expect(knows.getByText("From your deals")).toBeTruthy();
    expect(knows.getByText("Researched · news.example")).toBeTruthy();
    expect(knows.getByText("1 Jan 2023")).toBeTruthy();
    expect(knows.getByText("31 May 2023")).toBeTruthy();
    const told = within(screen.getByTestId("brand-told"));
    expect(told.getByText("You told Nomila")).toBeTruthy();
    expect(told.getByText("“Personal contract with Brand P; the school deal is separate.”")).toBeTruthy();
    expect(told.getByText("told Mila")).toBeTruthy();
    const heard = within(screen.getByTestId("brand-heard"));
    expect(heard.getByText("Brand P · one of its first signings")).toBeTruthy();
    expect(heard.getByText("Unconfirmed")).toBeTruthy();
    expect(t).not.toMatch(/Deal status|Contract terms|Not connected/i);
    expect(screen.queryByTestId("brand-contract")).toBeNull();
    expect(t.toLowerCase()).not.toContain("verified");
  });

  it("the contract request appears only when an open intelligence request asks for THIS brand's contract", () => {
    requests = [
      { requestId: "r1", status: "open", sheAsked: null, nomilaSays: "Add your Brand P contract so Nomila can read the terms.", cta: { kind: "add_contract", label: "Add contract" } },
      { requestId: "r2", status: "open", sheAsked: null, nomilaSays: "Add your Other Brand contract.", cta: { kind: "add_contract", label: "Add contract" } },
    ];
    render(<BrandScreen />);
    const c = within(screen.getByTestId("brand-contract"));
    expect(c.getByText("Your Brand P contract")).toBeTruthy();
    expect(c.getByText("Add your Brand P contract so Nomila can read the terms.")).toBeTruthy();
    expect(c.getByText("Add")).toBeTruthy();
    expect(contractRequestFor(requests, "Brand P")?.requestId).toBe("r1");
    expect(contractRequestFor(requests, "Nobody")).toBeNull();
    expect(contractRequestFor([{ ...requests[0], status: "acquired" }], "Brand P")).toBeNull();
  });

  it("tapping a fact opens the existing info sheet; This isn't right sends the dispute", () => {
    render(<BrandScreen />);
    fireEvent.press(screen.getByTestId("entry-endorsement_2"));
    expect(allText()).toContain("Researched · unconfirmed");
    fireEvent.press(screen.getByText("This isn't right"));
    expect(mutate).toHaveBeenCalledWith({ entryId: "endorsement_2", said: "" }, expect.anything());
  });

  it("an unknown key: the not-found line, never a blank deck", () => {
    params = { key: "nobody" };
    render(<BrandScreen />);
    expect(screen.getByText("Couldn't find this brand.")).toBeTruthy();
    expect(screen.queryByTestId("brand-deck")).toBeNull();
  });
});
