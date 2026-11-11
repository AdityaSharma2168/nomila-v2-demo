/**
 * pitchConcept.test.ts — the Nomi Card's creative core (PITCH_CONCEPT_V1): confirmed research only, the gate (prices,
 * competitors, her avoided words, malformed packages), the editor's pick, the generic signature idea, the focus parser,
 * the accent rule, and the concept/calendar/idea cards in BOTH kept looks. Never reaches a provider: the writer and the
 * editor are stubbed.
 */
jest.mock("../db", () => ({ db: {} }));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
jest.mock("../lib/models", () => ({
  GEMINI: { flash: "stub", flashLite: "stub", pro: "stub" }, KIMI: { vertexModel: "stub", moonshotModel: "stub" },
  genai: () => ({ models: { generateContent: async () => { throw new Error("no provider in tests"); } } }),
}));
jest.mock("../lib/kimi", () => ({ kimiThinking: async () => { throw new Error("no provider in tests"); } }));
jest.mock("./narrator", () => ({ ...jest.requireActual("./narrator"), fableJson: jest.fn(), editorJson: jest.fn() }));

import { editorJson, fableJson, type NarratorContext } from "./narrator";
import {
  brandResearchFrom, buildConceptPrompt, CONCEPT_SYSTEM, gatePackages, parseFocus, SIGNATURE_SYSTEM, usableAccent,
  writePitchConcept, writeSignatureIdea, type BrandResearch,
} from "./pitchConcept";
import { renderKitHtml, listPickableThemes, listThemes } from "./kitRenderer";

const fable = fableJson as jest.Mock;
const editor = editorJson as jest.Mock;
beforeEach(() => { fable.mockReset(); editor.mockReset(); });

const ctx: NarratorContext = {
  name: "Alex Rivera", sport: "volleyball", school: "State", storyArc: "A setter who runs the floor.", signalHighlights: ["Named captain"],
  brandFitTags: [], commercial: "none", gender: undefined,
};

const row = (status: "confirmed" | "unconfirmed") => ({
  name: "Brandco", category: "Apparel", brand_tier: "established", description: "Everyday apparel built to be layered.",
  audience_summary: "Active young women.", sport_categories: ["volleyball"], known_athlete_partnerships: ["Someone Else"],
  image_url: "https://brand.example/img.jpg", images: ["https://brand.example/a.jpg"],
  enrichment: {
    identity: { status, domain: "brand.example" }, brand_values: "Made to move", content_style: "sunlit", recent_campaigns: ["Spring drop"],
    product_categories: ["tops"], partnership_style: "ambassador", competitors: ["Rivalwear"], own_site: { cover: "https://brand.example/cover.jpg" },
    logo_check: { color: "#835E35" },
  },
});

const pkg = (title: string, extra: Partial<Record<"note" | "line", string>> = {}) => ({
  concept: { title, line: extra.line ?? "Every set starts before the ball does.", lineEmphasis: "Built to layer.", facets: ["Setter", "Captain", "Student"], note: extra.note ?? "Her floor game meets the brand's layering idea." },
  activation: { lead: "One idea, every season.", buckets: [
    { label: "In Season", audience: "Game-day fans", line: "Warm-up layers on match days." },
    { label: "Campus", audience: "Students", line: "A layering guide for the dorm-to-gym day." },
    { label: "Community", audience: "Young players", line: "A clinic in the brand's kit." },
  ], close: "Not one post. A season." },
  whyFits: { audience: "Her followers are the brand's buyers.", credibility: "A captain's kit carries weight.", whitespace: "No apparel partner yet." },
});

describe("brand research (identity gate)", () => {
  it("is null unless the research is confirmed to be about this company", () => {
    expect(brandResearchFrom(row("unconfirmed"))).toBeNull();
    expect(brandResearchFrom(null)).toBeNull();
  });
  it("shapes the confirmed research: values, style, campaigns, products, image, colour", () => {
    const b = brandResearchFrom(row("confirmed"))!;
    expect(b).toMatchObject({ name: "Brandco", values: "Made to move", contentStyle: "sunlit", recentCampaigns: ["Spring drop"], products: ["tops"],
      partnershipStyle: "ambassador", image: "https://brand.example/cover.jpg", color: "#835E35", competitors: ["Rivalwear"] });
  });
  it("puts the research and her chosen angles in fenced data, never the competitors", () => {
    const b = brandResearchFrom(row("confirmed"))!;
    const p = buildConceptPrompt(ctx, b, ["Your audience overlap: they already follow her"]);
    expect(p).toContain("<external_content");
    expect(p).toContain("Made to move");
    expect(p).toContain("they already follow her");
    expect(p).not.toContain("Rivalwear");
    expect(CONCEPT_SYSTEM).toMatch(/No prices/);
    expect(SIGNATURE_SYSTEM).toMatch(/Name no brand/);
  });
});

describe("the gate", () => {
  it("drops packages that quote a price, name a competitor, use avoided words, or are incomplete", () => {
    const raw = { packages: [
      pkg("Good One"),
      pkg("Priced", { note: "A $5,000 activation." }),
      pkg("Rival", { note: "Better than Rivalwear." }),
      pkg("Avoided", { line: "She is a girlboss on court." }),
      { concept: { title: "Broken" } },
    ] };
    const kept = gatePackages(raw, { competitors: ["Rivalwear"], avoid: ["girlboss"] });
    expect(kept.map((p) => p.concept.title)).toEqual(["Good One"]);
  });
});

describe("writePitchConcept", () => {
  const brand = brandResearchFrom(row("confirmed")) as BrandResearch;
  it("writes nothing without confirmed research (no model call)", async () => {
    expect(await writePitchConcept(ctx, null)).toBeNull();
    expect(fable).not.toHaveBeenCalled();
  });
  it("takes the editor's pick and keeps the rest as alternates", async () => {
    fable.mockResolvedValue({ packages: [pkg("First"), pkg("Second"), pkg("Third")] });
    editor.mockResolvedValue({ pick: 1 });
    const r = await writePitchConcept(ctx, brand, []);
    expect(r?.concept.title).toBe("Second");
    expect(r?.alternates.map((a) => a.concept.title)).toEqual(["First", "Third"]);
  });
  it("falls back to the first option when the editor fails, and to null when every option is gated", async () => {
    fable.mockResolvedValue({ packages: [pkg("First"), pkg("Second")] });
    editor.mockRejectedValue(new Error("down"));
    expect((await writePitchConcept(ctx, brand))?.concept.title).toBe("First");
    fable.mockResolvedValue({ packages: [pkg("Priced", { note: "$900 a post" })] });
    expect(await writePitchConcept(ctx, brand)).toBeNull();
  });
  it("never throws: a writer failure is null", async () => {
    fable.mockRejectedValue(new Error("refusal"));
    expect(await writePitchConcept(ctx, brand)).toBeNull();
  });
});

describe("writeSignatureIdea", () => {
  it("returns the picked idea with no brand in it", async () => {
    fable.mockResolvedValue({ ideas: [pkg("Own The Floor").concept, pkg("Second Idea").concept] });
    editor.mockResolvedValue({ pick: 0 });
    const r = await writeSignatureIdea(ctx);
    expect(r?.idea.title).toBe("Own The Floor");
    expect(r?.alternates).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("parses her chosen angles from the query, capped and safe", () => {
    expect(parseFocus(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
    expect(parseFocus("not json")).toEqual([]);
    expect(parseFocus(JSON.stringify(Array.from({ length: 10 }, (_, i) => `x${i}`)))).toHaveLength(6);
    expect(parseFocus(undefined)).toEqual([]);
  });
  it("uses a brand colour as the accent only when it reads on a dark card", () => {
    expect(usableAccent("#835E35")).toBe("#835E35");
    expect(usableAccent("#FFFFFF")).toBeNull();
    expect(usableAccent("#000000")).toBeNull();
    expect(usableAccent(null)).toBeNull();
  });
});

describe("renderers: the creative cards in every look", () => {
  const base = (cards: any[]) => ({
    athleteId: "a", identity: { name: "Alex Rivera", sport: "volleyball", school: "State", hook: "" }, tokens: { theme: "nomila", accent: "#835E35" },
    cards, deck: cards.map((c) => c.id), meta: { generatedAt: "", overallConfidence: 1 },
  } as any);
  const conf = { level: "inferred", score: 0.6 };
  const p = pkg("The Layer Game");
  const kit = base([
    { id: "campaignConcept", type: "campaignConcept", emphasis: "hero", confidence: conf, eyebrow: "Campaign concept", bg: null, brand: { id: 1, name: "Brandco", category: "Apparel", logo: null },
      ...p.concept, image: null, brandImage: "https://brand.example/cover.jpg" },
    { id: "activationPlan", type: "activationPlan", emphasis: "standard", confidence: conf, eyebrow: "All year", bg: null, ...p.activation },
    { id: "signatureIdea", type: "signatureIdea", emphasis: "hero", confidence: conf, eyebrow: "The idea", bg: null, ...pkg("Own The Floor").concept, image: null },
  ]);
  for (const theme of ["nomila", "luxe", "broadcast"]) {
    it(`${theme} renders the concept, the calendar and the signature idea`, () => {
      const html = renderKitHtml(kit, theme);
      expect(html).toContain("The Layer Game");
      expect(html).toContain("Warm-up layers on match days.");
      expect(html).toContain("Own The Floor");
    });
  }
  it("the picker offers Nomila, Luxe and Broadcast; the retired looks are not renderers any more", () => {
    expect(listPickableThemes()).toEqual(["nomila", "luxe", "broadcast"]);
    expect(listThemes()).toEqual(["nomila", "luxe", "broadcast"]);
  });
});

describe("writer retry", () => {
  it("retries once when the writer's answer is not JSON", async () => {
    const brand = brandResearchFrom(row("confirmed")) as BrandResearch;
    fable.mockRejectedValueOnce(new SyntaxError("Expected ',' in JSON")).mockResolvedValueOnce({ packages: [pkg("Second Try")] });
    expect((await writePitchConcept(ctx, brand))?.concept.title).toBe("Second Try");
    expect(fable).toHaveBeenCalledTimes(2);
  });
});
