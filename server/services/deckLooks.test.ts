/**
 * The deck looks (owner decision, 23 Oct 2026): three looks, Nomila the default; a retired look renders in Nomila;
 * a brand pitch is preselected from the brand's CONFIRMED research category by a fixed rule table. Pure, except
 * brandLookAdvice, whose one read is answered by a stub db. Nothing reaches a model.
 */
const rows: any[] = [];
jest.mock("../db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => rows.splice(0) }) }) }) },
}));
jest.mock("../lib/models", () => ({
  genai: () => ({ models: { generateContent: async () => { throw new Error("tests must never reach a provider"); } } }),
  GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" },
  KIMI:   { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" },
}));

import {
  DECK_LOOKS, DEFAULT_DECK_LOOK, LOOK_RULES, lookForCategory, recommendDeckLook, resolveDeckLook,
} from "../../shared/deckLooks";
import { renderKitHtml, listPickableThemes } from "./kitRenderer";
import { brandLookAdvice } from "./kitCache";

describe("the looks", () => {
  it("offers Nomila, Luxe and Broadcast, Nomila first and the default", () => {
    expect(DECK_LOOKS).toEqual(["nomila", "luxe", "broadcast"]);
    expect(DEFAULT_DECK_LOOK).toBe("nomila");
    expect(listPickableThemes()).toEqual(["nomila", "luxe", "broadcast"]);
  });

  it("a retired, unknown or missing look resolves to Nomila; the three resolve to themselves", () => {
    for (const t of ["campaign", "immersive", "neon", "", null, undefined]) expect(resolveDeckLook(t as any)).toBe("nomila");
    for (const t of DECK_LOOKS) expect(resolveDeckLook(t)).toBe(t);
  });
});

describe("the rule table", () => {
  it.each([
    ["Jewelry", "luxe"], ["Fine jewellery", "luxe"], ["Luxury goods", "luxe"], ["Fashion & Apparel", "luxe"],
    ["Beauty & Personal Care", "luxe"], ["Skincare", "luxe"], ["Fragrance", "luxe"], ["Watches", "luxe"],
    ["Sports Nutrition", "broadcast"], ["Beverages", "broadcast"], ["Energy drinks", "broadcast"],
    ["Hydration", "broadcast"], ["Athletic apparel", "broadcast"], ["Sporting goods", "broadcast"],
    ["Fitness equipment", "broadcast"], ["Protein supplements", "broadcast"], ["Athleisure", "broadcast"],
    ["Software", null], ["Banking", null], ["Apparel", null], ["Restaurants", null], ["", null], [null, null],
  ])("%s → %s", (category, look) => {
    expect(lookForCategory(category as any)).toBe(look);
  });

  it("first row wins: an explicitly premium sports category reads as Luxe", () => {
    expect(LOOK_RULES[0].look).toBe("luxe");
    expect(lookForCategory("Luxury sportswear")).toBe("luxe");
    expect(lookForCategory("Sports fashion")).toBe("luxe");
  });
});

describe("recommendDeckLook", () => {
  it("recommends from a confirmed category, with a one-line reason", () => {
    expect(recommendDeckLook({ name: "gorjana", category: "Jewelry", confirmed: true }))
      .toEqual({ look: "luxe", reason: "Luxe suits gorjana's premium look", basis: "category" });
    expect(recommendDeckLook({ name: "Northline Hydration", category: "Beverages", confirmed: true }))
      .toEqual({ look: "broadcast", reason: "Broadcast suits Northline Hydration's game-day energy", basis: "category" });
  });

  it("unconfirmed research never recommends from its category: Nomila", () => {
    const a = recommendDeckLook({ name: "Stan Eats", category: "Energy drinks", confirmed: false });
    expect(a.look).toBe("nomila");
    expect(a.basis).toBe("default");
    expect(a.reason).toContain("until Stan Eats is confirmed");
  });

  it("no category, or one no row matches: Nomila", () => {
    expect(recommendDeckLook({ name: "Acme", category: null, confirmed: true })).toMatchObject({ look: "nomila", basis: "default" });
    expect(recommendDeckLook({ name: "Ledgerly", category: "Fintech", confirmed: true })).toMatchObject({ look: "nomila", basis: "default" });
  });

  it("a name ending in s takes a bare apostrophe", () => {
    expect(recommendDeckLook({ name: "Oaks", category: "Jewelry", confirmed: true }).reason).toBe("Luxe suits Oaks' premium look");
  });
});

describe("brandLookAdvice (the pitch's preselected look)", () => {
  const confirmed = { identity: { status: "confirmed", domain: "x.example" } };
  it("reads the category only when the research is confirmed", async () => {
    rows.push({ name: "Aurelle Jewelry", category: "Jewelry", enrichment: confirmed });
    expect((await brandLookAdvice(7)).look).toBe("luxe");
    rows.push({ name: "Aurelle Jewelry", category: "Jewelry", enrichment: { identity: { status: "unconfirmed" } } });
    expect((await brandLookAdvice(7)).look).toBe("nomila");
  });
  it("falls back to enrichment.industry when the column is empty", async () => {
    rows.push({ name: "Northline Hydration", category: null, enrichment: { ...confirmed, industry: "Sports beverages" } });
    expect((await brandLookAdvice(8)).look).toBe("broadcast");
  });
  it("a missing brand: Nomila", async () => {
    expect((await brandLookAdvice(9)).look).toBe("nomila");
  });
});

// ── the HTML renderer ───────────────────────────────────────────────────────────────────────────────
const conf = { level: "verified", score: 0.9 };
const card = (id: string, type: string, extra: any) => ({ id, type, emphasis: "standard", confidence: conf, eyebrow: `${type} eyebrow`, bg: null, ...extra });
const kitWith = (theme: string) => {
  const cards = [
    card("cover", "cover", { image: null, nameLines: ["Jordan", "Lee"], meta: "Soccer · Riverside", hook: "The forward a whole stadium leans in for.", stats: [{ value: "18K", label: "Followers" }] }),
    card("index", "index", { value: 684, max: 850, scale: "mia", verdict: "People come back to see what she does next." }),
    card("audience", "audience", { headline: "aged 18–24", sub: "Mostly in California", share: 62, geo: [{ label: "California", pct: 48 }], stats: [{ n: "18K", k: "Followers" }] }),
    card("content", "content", { heroStat: { value: "212K", label: "views" }, tiles: [{ image: null, stat: "88K" }], note: "Her training reels travel." }),
    card("video", "video", { posterUrl: null, videoUrl: "https://example.test/v.mp4", note: "In motion." }),
    card("whyFits", "whyFits", { brand: { id: 1, name: "Northline Hydration", category: "Beverages", logo: null }, lead: "Built for the long game.", reasons: [{ head: "Same audience", insight: "Her fans are its buyers.", basis: "audience" }] }),
    card("story", "story", { beats: [{ year: "2024", where: "Riverside", line: "First team.", current: true }], close: "Still climbing." }),
    card("values", "values", { statement: "Show up early, leave nothing.", planks: [{ name: "Grit", line: "Every session.", provenance: "self_reported" }], note: "In her words." }),
    card("achievements", "achievements", { heroEntry: { year: "2025", name: "Conference Player of the Year", badge: "MVP", detail: "9 goals" }, entries: [{ year: "2024", name: "All-Region", level: "First team" }], footnote: "From the team site." }),
    card("fit", "fit", { image: null, lead: "Brands that run on effort.", body: "", tags: ["Hydration", "Training"] }),
    card("campaignConcept", "campaignConcept", { brand: { id: 1, name: "Northline Hydration", category: "Beverages", logo: null }, title: "The Long Game", line: "Ninety minutes,", lineEmphasis: "zero days off.", facets: ["Match day"], note: "A season-long series.", image: null }),
    card("activationPlan", "activationPlan", { lead: "All year, not one post.", buckets: [{ label: "Preseason", audience: "fans", line: "The build." }], close: "Four moments." }),
    card("signatureIdea", "signatureIdea", { title: "Own The Early Hours", line: "The work", lineEmphasis: "nobody sees.", facets: [], note: "", image: null }),
  ];
  return { athleteId: "a", identity: { name: "Jordan Lee", sport: "Soccer", school: "Riverside", hook: "" }, tokens: { theme, accent: "#000000" },
    cards, deck: cards.map((c) => c.id), meta: { generatedAt: "", overallConfidence: 1 } } as any;
};

describe("renderKitHtml", () => {
  it("the Nomila look draws every card type the assembler makes, with the mark treatment", () => {
    const html = renderKitHtml(kitWith("nomila"));
    expect((html.match(/<article class="card /g) ?? []).length).toBe(13);
    expect(html).toContain("cardmark");            // the cardmark on the cover
    expect(html).toContain("rings-wm");            // the watermark on the text-led cards
    expect(html).toContain("cobrand");             // the logo × mark lockup
    expect(html).toContain("#C8325A");             // the one raspberry
    expect(html).toContain("fonts.googleapis.com/css2?family=Outfit");
    expect(html).toContain("Own The Early Hours");
  });

  it.each(["campaign", "immersive", "unknown"])("a deck saved with %s renders in Nomila", (theme) => {
    const html = renderKitHtml(kitWith(theme));
    expect(html).toBe(renderKitHtml(kitWith("nomila")));
  });

  it("an explicit look wins over the kit's own", () => {
    expect(renderKitHtml(kitWith("nomila"), "luxe")).toContain("Bodoni");
    expect(renderKitHtml(kitWith("campaign"), "broadcast")).toContain("Anton");
  });

  it("Luxe and Broadcast carry the mark treatment too: the cardmark, the watermark and the lockup", () => {
    for (const look of ["luxe", "broadcast"]) {
      const html = renderKitHtml(kitWith(look));
      expect(html).toContain("nomila-mark");
      expect(html).toContain("rings-wm");
      expect(html).toContain("&times;");
    }
  });

  it("Broadcast draws the brand creative cards instead of dropping them", () => {
    const html = renderKitHtml(kitWith("broadcast"));
    expect(html).toContain("The Long Game");
    expect(html).toContain("All year, not one post.");
    expect(html).toContain("Own The Early Hours");
  });

  it("chrome=none hides the Nomila deck's own controls", () => {
    expect(renderKitHtml(kitWith("nomila"), undefined, { chrome: "none" })).toContain(".actions,.stage-cap,.toast{display:none !important;}");
  });
});
