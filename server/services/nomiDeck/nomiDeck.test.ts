import { describe, expect, it } from "@jest/globals";
import { planDeck, pickVariant, groundOf, editionOf, hasData, displaySize, deckLookOf } from "./layout";
import { renderNomiDeckHtml } from "./render";

const conf = { level: "verified", score: 1 } as any;
const base = (cards: any[], extra: any = {}) => ({
  athleteId: "a", identity: { name: "Alex Rivera", sport: "track", school: "State", hook: "" }, tokens: { theme: "luxe", accent: "#E84591" },
  cards, meta: { generatedAt: "", overallConfidence: 1 }, imagePool: [{ gcsPath: "p/pool1.jpg", shotType: "portrait", hero: 1 }], ...extra,
}) as any;
const cover = { id: "cover", type: "cover", emphasis: "hero", confidence: conf, eyebrow: "", image: "p/cover.jpg", nameLines: ["Alex", "Rivera"], meta: "Track · State", hook: "Fast, then faster.", stats: [{ value: "12K", label: "Followers" }] };
const record = { id: "achievements", type: "achievements", emphasis: "hero", confidence: conf, eyebrow: "", bg: "p/rec.jpg", heroEntry: { year: "2025", name: "Conference champion", badge: "", detail: "" }, entries: [{ year: "2024", name: "All-Region", level: "regional" }], footnote: "" };
const sig = { id: "signatureIdea", type: "signatureIdea", emphasis: "hero", confidence: conf, eyebrow: "", title: "Run Your Own Race", line: "A line.", lineEmphasis: "Payoff.", facets: ["Runner"], note: "", image: "p/cover.jpg" };
const emptyAudience = { id: "audience", type: "audience", emphasis: "standard", confidence: conf, eyebrow: "", headline: "", sub: "", share: null, geo: [], stats: [] };
const concept = { id: "campaignConcept", type: "campaignConcept", emphasis: "hero", confidence: conf, eyebrow: "", brand: { id: 9, name: "Brandco", category: "x" }, title: "T", line: "L", lineEmphasis: "", facets: [], note: "", image: null, brandImage: "https://brand.example/hero.jpg" };

describe("nomiDeck layout", () => {
  it("public edition follows the settled order, leaves data-less cards out, ends on the close", () => {
    const kit = base([cover, record, sig, emptyAudience]);
    expect(editionOf(kit)).toBe("public");
    expect(planDeck(kit).map((s) => s.cardType)).toEqual(["cover", "signatureIdea", "achievements", "close"]);
  });
  it("a card with no data is never drawn", () => {
    expect(hasData(emptyAudience as any)).toBe(false);
  });
  it("never uses the same photo on two screens (a repeat becomes type-led)", () => {
    const s = planDeck(base([cover, sig]));
    expect(s[0].image).toBe("p/cover.jpg");
    expect(s[1].image).toBeNull();
    expect(s[1].variant).toBe("C");
  });
  it("a pitch is recognised by its brand cards and its concept leads with the brand's own imagery", () => {
    const kit = base([cover, concept]);
    expect(editionOf(kit)).toBe("pitch");
    const s = planDeck(kit).find((x) => x.cardType === "campaignConcept")!;
    expect(s.image).toBe("https://brand.example/hero.jpg");
  });
  it("variants: rules over content shape, no repeat on consecutive screens of a kind", () => {
    expect(pickVariant("cover", { image: true, lineLength: 20 }, null)).toBe("A");
    expect(pickVariant("statement", { image: false, lineLength: 20 }, null)).toBe("C");
    expect(pickVariant("statement", { image: true, lineLength: 20 }, "B")).toBe("C");
    expect(groundOf("data", "A")).toBe("paper");
    expect(groundOf("record", "A")).toBe("ink");
  });
  it("type fitting shrinks long lines but never below the floor", () => {
    expect(displaySize("short", { max: 46, min: 24, perLine: 16, lines: 3 })).toBe(46);
    expect(displaySize("x".repeat(400), { max: 46, min: 24, perLine: 16, lines: 3 })).toBe(24);
  });
  it("looks: luxe and campaign; anything else draws as campaign", () => {
    expect(deckLookOf("luxe")).toBe("luxe");
    expect(deckLookOf("broadcast")).toBe("campaign");
  });
});

describe("nomiDeck render", () => {
  it("page mode: doors at the bottom, a sticky Work-with, no script and no style attributes", () => {
    const html = renderNomiDeckHtml(base([cover, record]), { look: "luxe", mode: "page", cssHref: "/p/_a/nomi.css", doors: [{ key: "partner", label: "Partner with Alex", href: "/p/alex/partner" }] });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\sstyle="/i);
    expect(html.indexOf("doors-block")).toBeGreaterThan(html.lastIndexOf("<section class=\"scr"));
    expect(html).toContain("Work with Alex");
  });
  it("escapes data (research text can never become markup)", () => {
    const html = renderNomiDeckHtml(base([{ ...cover, hook: "<img src=x onerror=alert(1)>" }]), { look: "campaign", mode: "deck" });
    expect(html).not.toContain("<img src=x");
  });
  it("never prints a price on a brand-facing card", () => {
    const html = renderNomiDeckHtml(base([cover, concept]), { look: "luxe", mode: "deck" });
    expect(html).not.toMatch(/\$\s?\d/);
  });
});

describe("nomiDeck review fixes (22 Oct)", () => {
  it("record: the copywriter's story line is the headline, the honour stays as the fact line", () => {
    const rec = { ...record, heroStory: "A first that opened the door.", entries: [{ year: "2024", name: "All-Region", level: "Regional", story: "Proof it travels." }] };
    const html = renderNomiDeckHtml(base([cover, rec]), { look: "luxe", mode: "deck" });
    expect(html).toContain("A first that opened the door.");
    expect(html).toContain('<span class="fact">Conference champion</span>');
    expect(html).toContain("Proof it travels.");
  });
  it("proof: shows only the measured stat block it is given", () => {
    const content = { id: "content", type: "content", emphasis: "hero", confidence: conf, eyebrow: "", heroStat: { value: "5.4M", label: "views on her top post" }, tiles: [], note: "", stats: [{ value: "12.6K", label: "Instagram reach per post" }] };
    const html = renderNomiDeckHtml(base([cover, content]), { look: "luxe", mode: "deck" });
    expect(html).toContain("12.6K");
    expect(html).toContain("statrow n1");
  });
  it("audience: big number, and on a pitch the brand's own audience beside it", () => {
    const aud = { ...emptyAudience, headline: "Women", share: 38, ages: [{ label: "18-24", pct: 30 }], brandAudience: { brand: "Brandco", text: "Modern women" } };
    const html = renderNomiDeckHtml(base([cover, aud, concept]), { look: "luxe", mode: "deck" });
    expect(html).toContain('<div class="bignum"><b>38%</b>');
    expect(html).toContain("Who Brandco sells to");
  });
});
