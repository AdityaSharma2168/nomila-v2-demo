/**
 * shared/bookLayout — the brand book as screens: chapters split to fit one screen, grounds, and the layout picker's rules
 * (from the content's shape; never the same layout twice in a row). Pure.
 */
import { chipsOf, type BookPage } from "../../shared/brandBook";
import {
  FIT, avoidAdjacentRepeats, editSlots, fitSize, coverVariant, dataVariant, pageTone, pillarVariant, readerPages, statementVariant, type ReaderPage,
} from "../../shared/bookLayout";

const L = (text: string) => ({ text, options: [text] });
const page = (id: BookPage["id"], over: Partial<BookPage> = {}): BookPage => ({ id, title: id, lines: {}, facts: [], images: [], ...over });

describe("layout picker", () => {
  it("cover: strong photo → full-bleed, short line → giant name, decent or none → split ivory", () => {
    expect(coverVariant("strong", "Every room you walk into, you leave the door open behind you.")).toBe("A");
    expect(coverVariant("strong", "The door opens wider.")).toBe("B");
    expect(coverVariant("decent", "The door opens wider.")).toBe("C");
    expect(coverVariant("", "x")).toBe("C");
  });
  it("statement: strong → line over the photo, decent → photo band, none → type on paper", () => {
    expect(statementVariant("strong")).toBe("B");
    expect(statementVariant("decent")).toBe("C");
    expect(statementVariant("")).toBe("A");
  });
  it("data: a score with 4+ dimensions → number + bars, fewer → ring, no score → stat tiles", () => {
    expect(dataVariant(595, 8)).toBe("A");
    expect(dataVariant(595, 3)).toBe("B");
    expect(dataVariant(null, 0)).toBe("C");
  });
  it("pillar: photo pillars alternate; decent reads toned; no photo is type-led", () => {
    expect(pillarVariant("strong", null)).toBe("A");
    expect(pillarVariant("strong", "A")).toBe("B");
    expect(pillarVariant("decent", null)).toBe("B");
    expect(pillarVariant("decent", "B")).toBe("A");
    expect(pillarVariant("", "A")).toBe("C");
  });
});

describe("readerPages", () => {
  const book = {
    pages: [
      page("cover", { lines: { line: L("Every room you walk into, you leave the door open behind you.") }, images: ["c.jpg"], imageTiers: ["strong"] }),
      page("found", { extra: { found: { score: 595, asOf: null, dimensions: Array.from({ length: 8 }, (_, i) => ({ key: `d${i}`, score: 50 })), strengths: ["s"], thin: ["t"], opportunity: "o" } } }),
      page("big_idea", { images: ["b.jpg"], imageTiers: ["strong"], backdrop: "b-tone.jpg" }),
      page("pillars", {
        lines: { "pillar.0.name": L("a"), "pillar.1.name": L("b"), "pillar.2.name": L("c") },
        images: ["p0.jpg", "p1.jpg", ""], imageTiers: ["strong", "strong", ""], extra: { evidence: ["e0", "e1", "e2"] },
      }),
      page("story", { images: ["s.jpg"], extra: { milestones: Array.from({ length: 5 }, (_, i) => ({ date: `202${i}`, fact: `f${i}` })) } }),
      page("listening", { extra: { listening: { channels: [], countries: [], posts: [] } } }),
      page("voice_look", { images: ["v0", "v1", "v2", "v3", "v4"] }),
      page("avoid", { extra: { guardrails: Array.from({ length: 4 }, (_, i) => ({ text: `g${i}`, from: "read" as const })) } }),
      page("commercial", { extra: { commercial: { rates: Array.from({ length: 7 }, (_, i) => ({ rateType: `r${i}`, label: `r${i}`, low: 1, high: 2, currency: "usd", minimum: null })), partners: [{ name: "x", logoUrl: null, category: null, tier: null, audience: null }], inbound: [] } } }),
      page("plan", { images: ["pl.jpg"], backdrop: "pl-tone.jpg" }),
    ],
  };
  const pages = readerPages(book);
  const keys = pages.map((p) => p.key);

  it("splits chapters so nothing scrolls: one pillar a page, four beats (three beside the photo), three guardrails, six rates", () => {
    expect(keys).toEqual([
      "cover", "found", "found.read", "big_idea", "pillars.0", "pillars.1", "pillars.2", "story.0", "story.1",
      "listening", "voice_look", "avoid.0", "avoid.1", "commercial.0", "commercial.1", "commercial.partners", "plan",
    ]);
    // The first story page carries the photo, so it holds one beat fewer.
    expect(pages.find((p) => p.key === "story.0")!.rows).toEqual([0, FIT.beatsPerPage - 1]);
    expect(pages.find((p) => p.key === "story.1")!.rows).toEqual([FIT.beatsPerPage - 1, 5]);
    expect(pages.find((p) => p.key === "avoid.1")!.rows).toEqual([3, 4]);
    expect(pages.find((p) => p.key === "commercial.1")!.rows).toEqual([6, 7]);
    expect(pages.find((p) => p.key === "pillars.1")!.part).toEqual({ i: 1, n: 3 });
  });

  it("sits story pages on ink, data on paper, hero moments on their photo", () => {
    const g = Object.fromEntries(pages.map((p) => [p.key, p.ground]));
    expect(g).toMatchObject({ cover: "photo", found: "paper", big_idea: "photo", "pillars.0": "photo", "pillars.2": "paper", "story.0": "ink", listening: "paper", "avoid.0": "paper", "commercial.0": "ink", plan: "photo" });
  });

  it("carries the toned backdrop on statement pages and the photo only on the first story page", () => {
    expect(pages.find((p) => p.key === "big_idea")!.backdrop).toBe("b-tone.jpg");
    expect(pages.find((p) => p.key === "story.0")!.image).toBe("s.jpg");
    expect(pages.find((p) => p.key === "story.1")!.image).toBeNull();
  });

  it("never puts the same layout on two pages in a row (pillars included)", () => {
    for (let i = 1; i < pages.length; i++) {
      const a = pages[i - 1], b = pages[i];
      const continuation = b.kind !== "pillar" && a.chapter === b.chapter && b.part.i > 0;
      if (!continuation) expect(`${a.kind}:${a.variant}`).not.toBe(`${b.kind}:${b.variant}`);
    }
    expect(pages.filter((p) => p.kind === "pillar").map((p) => p.variant)).toEqual(["A", "B", "C"]);
  });

  it("leaves out pages a chapter has nothing for (no read without strengths, no partners page without partners)", () => {
    const lean = readerPages({ pages: [page("found", { extra: { found: { score: 600, asOf: null, dimensions: [], strengths: [], thin: [], opportunity: null } } }), page("commercial", { extra: { commercial: { rates: [], partners: [], inbound: [] } } })] });
    expect(lean.map((p) => p.key)).toEqual(["found", "commercial.0"]);
  });

  it("moves a repeated layout to the next one the content supports", () => {
    const base: ReaderPage = { key: "a", chapter: "pillars", role: "main", kind: "pillar", variant: "A", ground: "photo", part: { i: 0, n: 2 }, image: "x", tier: "strong", backdrop: null, rows: [0, 1] };
    const out = avoidAdjacentRepeats([base, { ...base, key: "b", part: { i: 1, n: 2 } }]);
    expect(out.map((p) => p.variant)).toEqual(["A", "B"]);
  });
});

describe("fitSize", () => {
  it("keeps the layout's size for a comfortable line and steps down for a long one, never below 72%", () => {
    expect(fitSize("short", 30, 60)).toBe(30);
    expect(fitSize("x".repeat(120), 30, 60)).toBeLessThan(30);
    expect(fitSize("x".repeat(2000), 30, 60)).toBe(21.6);
    expect(fitSize(null, 30, 60)).toBe(30);
  });
});

describe("closing page and pillar chips", () => {
  it("ends the book on its closing page only when it has a line, full-bleed over its photo", () => {
    const withClose = readerPages({ pages: [page("cover", { lines: { line: L("x") } }), page("plan"), page("close", { lines: { line: L("Lead in public.") }, images: ["c.jpg"] })] });
    const last = withClose[withClose.length - 1];
    expect(last).toMatchObject({ chapter: "close", kind: "close", ground: "photo", image: "c.jpg" });
    const noLine = readerPages({ pages: [page("cover"), page("plan"), page("close")] });
    expect(noLine.some((p) => p.chapter === "close")).toBe(false);
  });
  it("lets the Edit pill offer a pillar's chips alongside its name and proof", () => {
    const pillars = page("pillars", { lines: { "pillar.0.name": L("Lead"), "pillar.0.proof": L("You lead."), "pillar.0.chips": L("Team captain 2025 · All-America 2024") }, images: [""] });
    const rp = readerPages({ pages: [pillars] })[0];
    expect(editSlots(rp, pillars)).toEqual(["pillar.0.name", "pillar.0.proof", "pillar.0.chips"]);
    expect(chipsOf(pillars, 0)).toEqual(["Team captain 2025", "All-America 2024"]);
  });
});

describe("pageTone (the one look, 23 Oct 2026)", () => {
  const rp = (over: Partial<ReaderPage>): ReaderPage => ({
    key: "x", chapter: "found", role: "main", kind: "data", variant: "A", ground: "paper", part: { i: 0, n: 1 },
    image: null, tier: "", backdrop: null, rows: [0, 0], ...over,
  });
  it("puts the cover on the dark ground always, photo or not", () => {
    expect(pageTone(rp({ kind: "cover", variant: "C", ground: "paper" }))).toEqual({ dark: true, top: "dark", bottom: "dark" });
    expect(pageTone(rp({ kind: "cover", variant: "B", ground: "photo", image: "c.jpg" })).dark).toBe(true);
  });
  it("draws full-bleed photo pages dark and every type page (ink or paper) on white", () => {
    expect(pageTone(rp({ kind: "pillar", ground: "photo", image: "p.jpg" }))).toEqual({ dark: true, top: "dark", bottom: "dark" });
    expect(pageTone(rp({ kind: "timeline", ground: "ink" }))).toEqual({ dark: false, top: "light", bottom: "light" });
    expect(pageTone(rp({ kind: "data", ground: "paper" }))).toEqual({ dark: false, top: "light", bottom: "light" });
  });
  it("lights a photo band's top dark and its foot white (the plan's backdrop, a statement's band)", () => {
    expect(pageTone(rp({ kind: "plan", ground: "photo", backdrop: "b.jpg" }))).toEqual({ dark: false, top: "dark", bottom: "light" });
    expect(pageTone(rp({ kind: "plan", ground: "ink" }))).toEqual({ dark: false, top: "light", bottom: "light" });
    expect(pageTone(rp({ kind: "statement", variant: "C", ground: "ink", image: "s.jpg" }))).toEqual({ dark: false, top: "dark", bottom: "light" });
  });
});
