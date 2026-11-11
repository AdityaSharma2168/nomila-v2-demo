/**
 * brandBook.test.ts — the brand book's template, copy gate and reel scenes. Pure: the writer and the editor are injected
 * fakes (tests never reach a provider), and no database is touched.
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
jest.mock("../../lib/models", () => ({
  GEMINI: { flash: "stub", flashLite: "stub", pro: "stub" }, KIMI: { vertexModel: "stub", moonshotModel: "stub" },
  genai: () => ({ models: { generateContent: async () => { throw new Error("no provider in tests"); } } }),
}));
jest.mock("../../lib/kimi", () => ({ kimiThinking: async () => { throw new Error("no provider in tests"); } }));
jest.mock("../../lib/mediaStore", () => ({ readObject: async () => null, uploadLocalFile: async () => {}, signedUrl: async () => "" }));
jest.mock("../athleteContext", () => ({ getAthleteContext: async () => { throw new Error("not read in these tests"); } }));
jest.mock("../curator", () => ({ curateAthleteMedia: async () => { throw new Error("not read in these tests"); } }));
jest.mock("../intelligence/views/myIntelligence", () => ({ buildMyIntelligence: async () => { throw new Error("not read in these tests"); } }));
jest.mock("../../agent/research/connected", () => ({ loadConnectedChannels: async () => [] }));
import { assemblePages, bookBriefs, chipFactsFor, photoBriefsFor, monthYear, pagesFor, readLines, withRestated, type BookSources } from "./pages";
import { writeBookCopy, buildBookPrompt, buildBookEditorPrompt, buildRestatePrompt, chipBacked, restateLines, sameNumbers } from "./copy";
import { isGrassGreen, paletteFromPixels } from "./palette";
import { reelScenes } from "./reel";
import { countriesFrom, guardrailsOf, humanDuration, humaniseDurations, milestonesFrom, nowNextFrom, sentenceCut } from "./sources";
import type { NarratorContext } from "../narrator";
import { chipsOf, type BrandBookData } from "../../../shared/brandBook";

const full: BookSources = {
  firstName: "Ana",
  found: {
    score: 600, asOf: "2026-10-01",
    dimensions: [
      { key: "narrative_power", score: 90 }, { key: "brand_fit", score: 80 }, { key: "audience_scale", score: 30 }, { key: "momentum", score: null },
    ],
    strengths: ["Distinctive story"], thin: ["Small audience"],
  },
  opportunity: "Turn the leadership story into a current one.",
  positioning: { statement: "A leader on and off the field.", from: "A rising player", to: "A leader people follow", pillars: [
    { name: "Leadership", line: "Captain two seasons running." }, { name: "Learning", line: "Studies engineering." }, { name: "Access", line: "Runs a clinic for kids." },
  ] },
  nowNext: { now: "Credibility rests on the armband.", next: "The next step is to make it visible weekly." },
  milestones: [{ date: "2022", fact: "Made the national youth team." }, { date: "2025", fact: "Named team captain." }],
  channels: [{ platform: "instagram", handle: "ana", followers: 20000, engagementRate: 5.1, avgReach: 12000, avgViews: null }],
  countries: [{ label: "US", share: 70 }, { label: "CA", share: 5 }],
  posts: [{ image: "a/p1.jpg", platform: "instagram", likes: 900, comments: 40, postedAt: "2026-05-01", permalink: "https://x/p/1" }],
  palette: ["#AA2233", "#2255AA", "#111111"],
  voice: null,
  captions: ["Back on the field after a long week of exams.", "Grateful for this group every single day."],
  guardrails: [{ text: "Promising reach the recent posts do not support.", from: "read" }],
  partners: [{ name: "Brandco", logoUrl: null, category: "Apparel", tier: "established", audience: null }],
  inbound: [{ category: "Beverage", count: 2 }],
  hasRates: true,
  goals: ["Grow my audience before the season ends"],
  moments: [{ date: "2026-11-07", name: "Tournament final" }],
  images: {
    cover: "a/hero.jpg", big_idea: "a/idea.jpg", "pillar.0": "a/p0.jpg", "pillar.1": null, "pillar.2": "a/p2.jpg",
    story: "a/story.jpg", "voice.0": "a/v0.jpg", "voice.1": "a/v1.jpg", "voice.2": null, "voice.3": "a/v3.jpg", plan: "a/plan.jpg",
  },
};

const ctx: NarratorContext = {
  name: "Ana Example", sport: "soccer", school: "Northfield University", storyArc: "", signalHighlights: [], brandFitTags: [], commercial: "none",
  voice: { avoid: ["superstar"] },
};

describe("brand book template", () => {
  it("has every page when the data is there, in book order", () => {
    expect(pagesFor(full)).toEqual(["cover", "found", "big_idea", "pillars", "story", "listening", "voice_look", "avoid", "commercial", "plan", "close"]);
  });

  it("leaves out a page with nothing true to show — a data-poor athlete gets a shorter book", () => {
    const thin: BookSources = {
      ...full, found: null, positioning: { pillars: [] }, milestones: [], channels: [], countries: [], posts: [], palette: [], captions: [],
      guardrails: [], partners: [], inbound: [], hasRates: false, goals: [], moments: [],
    };
    // The plan chapter always stands: her goals are read live, and an empty plan is the place to start one.
    expect(pagesFor(thin)).toEqual(["cover", "plan", "close"]);
    // A read with fewer than three scored dimensions is not a diagnosis.
    expect(pagesFor({ ...full, found: { ...full.found!, dimensions: [{ key: "brand_fit", score: 80 }] } })).not.toContain("found");
  });

  it("briefs speak to her as you and list the facts already shown", () => {
    const briefs = bookBriefs(full);
    const prompt = buildBookPrompt(ctx, briefs, full.captions);
    expect(prompt).toContain('speaks to: the athlete as "you"');
    expect(prompt).toContain("Named team captain.");
    expect(prompt).toContain("<external_content>");
    expect(briefs.find((b) => b.page === "pillars")?.slots[0]).toMatchObject({ key: "pillar", count: 3 });
  });

  it("assembles chapters with her facts and distinct images, and keeps a pillar's own name when no line came back", () => {
    const pages = assemblePages(full, {});
    expect(pages.find((p) => p.id === "story")!.extra?.milestones?.[0]).toEqual({ date: "2022", fact: "Made the national youth team." });
    expect(pages.find((p) => p.id === "pillars")!.lines["pillar.0.name"].text).toBe("Leadership");
    const imgs = pages.filter((p) => p.id !== "listening").flatMap((p) => p.images);
    expect(new Set(imgs).size).toBe(imgs.length);
    expect(pages[0].images).toEqual(["a/hero.jpg"]);
  });

  it("gives each page its own cast photo, keeps a pillar's slot when it has none, and leaves an uncast page type-led", () => {
    const pages = assemblePages({ ...full, images: { ...full.images, story: null } }, {});
    expect(pages.find((p) => p.id === "pillars")!.images).toEqual(["a/p0.jpg", "", "a/p2.jpg"]);
    expect(pages.find((p) => p.id === "voice_look")!.images).toEqual(["a/v0.jpg", "a/v1.jpg", "a/v3.jpg"]);
    expect(pages.find((p) => p.id === "story")!.images).toEqual([]);
  });

  it("writes every photo brief from the page's own words, with a face on the cover", () => {
    const briefs = photoBriefsFor(full);
    const by = Object.fromEntries(briefs.map((b) => [b.key, b]));
    expect(by.cover.needFace).toBe(true);
    expect(by["pillar.0"].query).toContain("Leadership");
    expect(by.story.query).toContain(full.milestones[full.milestones.length - 1].fact);
    expect(new Set(briefs.map((b) => b.key)).size).toBe(briefs.length);
    // No brief carries a name, school or sport the page did not give: they are the page's words plus the slot's framing.
    expect(briefs.every((b) => b.query.length <= 260)).toBe(true);
  });

  it("puts each fact in exactly one chapter (no chapter repeats another)", () => {
    const pages = assemblePages(full, {});
    const found = pages.find((p) => p.id === "found")!.extra!.found!;
    expect(found.opportunity).toBe("Turn the leadership story into a current one.");
    expect(found.dimensions).toHaveLength(4);
    const idea = pages.find((p) => p.id === "big_idea")!.extra!.idea!;
    expect(idea).toMatchObject({ from: "A rising player", to: "A leader people follow", next: "The next step is to make it visible weekly." });
    expect(pages.find((p) => p.id === "listening")!.extra!.listening!.posts).toHaveLength(1);
    expect(pages.find((p) => p.id === "avoid")!.extra!.guardrails).toHaveLength(1);
    // Rates are read live on every read, never frozen into the stored book.
    expect(pages.find((p) => p.id === "commercial")!.extra!.commercial).toMatchObject({ rates: [], partners: [{ name: "Brandco" }] });
    // The story's milestones are not repeated as plain facts on any chapter.
    const allFacts = pages.flatMap((p) => p.facts);
    expect(allFacts.some((f) => f.includes("Named team captain."))).toBe(false);
  });

  it("asks the commercial chapter for no price and no brand name, and the diagnosis to be frank", () => {
    const briefs = bookBriefs(full);
    expect(briefs.find((b) => b.page === "commercial")!.intent).toMatch(/Never a price, never a brand name/);
    expect(briefs.find((b) => b.page === "found")!.intent).toContain("narrative power 90/100");
  });

  it("formats dates plainly", () => {
    expect(monthYear("2024-10-03")).toBe("Oct 2024");
    expect(monthYear("2024")).toBe("2024");
  });

  it("reads where her audience is, the Brief's now / next, and her guardrails in her own words first", () => {
    expect(countriesFrom(["US 69%", "IN 7%", "CA 3%", "unknown"])).toEqual([{ label: "US", share: 69 }, { label: "IN", share: 7 }, { label: "CA", share: 3 }]);
    expect(nowNextFrom(["Today it rests on the armband.", "Also a recent start.", "The next step is weekly leadership."]))
      .toEqual({ now: "Today it rests on the armband.", next: "The next step is weekly leadership." });
    expect(guardrailsOf({ avoid: ["No alcohol brands"], voiceAvoid: ["superstar"], conflicts: [{ what: "The team's apparel partner holds apparel." }], risk: "Overpromising reach." }))
      .toEqual([
        { text: "No alcohol brands", from: "you" }, { text: "Never say: superstar", from: "you" },
        { text: "The team's apparel partner holds apparel.", from: "contract" }, { text: "Overpromising reach.", from: "read" },
      ]);
  });

  it("keeps a guardrail whole: its first sentence, or whole words with an ellipsis — never cut mid-word", () => {
    expect(sentenceCut("Short one.", 240)).toBe("Short one.");
    expect(sentenceCut(`The biggest risk is overpromising reach. ${"More detail. ".repeat(30)}`, 240)).toBe("The biggest risk is overpromising reach.");
    const long = sentenceCut(`${"word ".repeat(80)}end`, 40);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("word…")).toBe(true);
  });

  it("writes durations the way a person reads them", () => {
    expect(humaniseDurations("TikTok has been inactive for 573.3 days.")).toBe("TikTok has been inactive for over a year and a half.");
    expect(humaniseDurations("quiet for 45 days")).toBe("quiet for 6 weeks");
    expect(humaniseDurations("no posts in the last 30 days")).toBe("no posts in the last 4 weeks");
    expect(humaniseDurations("back in 3 days")).toBe("back in 3 days");
    expect(humanDuration(200)).toBe("7 months");
    expect(humanDuration(800)).toBe("over 2 years");
  });

  it("restates read lines to her as you, keeping every number, and refuses a line that changes one", async () => {
    const lines = ["Mia's Instagram reaches 12,541 accounts.", "She captains the team."];
    const write = jest.fn(async () => ({ lines: ["Your Instagram reaches 12,541 accounts.", "You captain the team."] }));
    const map = await restateLines("Mia", lines, { write });
    expect(map.get(lines[0])).toBe("Your Instagram reaches 12,541 accounts.");
    expect(map.get(lines[1])).toBe("You captain the team.");
    const bad = await restateLines("Mia", lines, { write: async () => ({ lines: ["Your Instagram reaches 20,000 accounts.", "You captain the team."] }) });
    expect(bad.has(lines[0])).toBe(false);
    expect(sameNumbers("12,541 and 5.2%", "5.2% then 12,541")).toBe(true);
    expect(buildRestatePrompt("Mia", lines)).toContain("<external_content>");
    const s2 = withRestated(full, new Map([[full.opportunity!, "Your upside."]]));
    expect(s2.opportunity).toBe("Your upside.");
    expect(readLines(full)).toContain(full.guardrails[0].text);
    expect(readLines(full)).toContain("Named team captain.");
    expect(withRestated(full, new Map([["Named team captain.", "You were named team captain."]])).milestones[1].fact).toBe("You were named team captain.");
  });

  it("drops a crafted line that speaks of her in the third person", async () => {
    const briefs = bookBriefs(full).filter((b) => b.page === "cover");
    const out = await writeBookCopy(ctx, briefs, [], {}, {
      write: async () => ({ cards: [{ card: "cover", line: ["Show the leader while she's leading.", "You lead out loud."] }] }),
      rank: async () => ({}),
    });
    expect(out!.lines.cover!.line.options).toEqual(["You lead out loud."]);
  });

  it("reads milestones from the copy context's dated signals, oldest first", () => {
    expect(milestonesFrom(["2025: Named captain.", "2022: First cap."])).toEqual([{ date: "2022", fact: "First cap." }, { date: "2025", fact: "Named captain." }]);
  });
});

describe("brand book copy", () => {
  const briefs = bookBriefs(full).filter((b) => b.page === "cover" || b.page === "pillars");

  it("drops lines that name her or use wording she banned, keeps the rest as options, takes the editor's pick", async () => {
    const write = jest.fn(async () => ({ cards: [
      { card: "cover", line: ["You make the room braver.", "Ana Example, always.", "A superstar in the making.", "You show up first."] },
      { card: "pillars", pillar: [
        [{ name: "Lead From Inside", proof: "The armband keeps finding you." }, { name: "Think It Through", proof: "You study the game." }, { name: "Hold The Door", proof: "Being first is not the point." }],
        [{ name: "Northfield Pride", proof: "x" }, { name: "B", proof: "y" }, { name: "C", proof: "z" }],
      ] },
    ] }));
    const rank = jest.fn(async () => ({ "cover/line": 1 }));
    const out = await writeBookCopy(ctx, briefs, [], {}, { write, rank });
    const cover = out!.lines.cover!.line;
    expect(cover.text).toBe("You show up first.");
    expect(cover.options).toEqual(["You show up first.", "You make the room braver."]);
    // The set naming her school is dropped whole; the clean one fills every pillar slot.
    expect(out!.lines.pillars!["pillar.2.name"].text).toBe("Hold The Door");
    expect(out!.lines.pillars!["pillar.0.proof"].options).toHaveLength(1);
    expect(buildBookEditorPrompt("Ana", "x")).toContain("RANK only");
  });

  it("keeps a pillar chip only when her stored facts back it — no invented claims", () => {
    const facts = { evidence: "Team captain two seasons running.", dated: ["2022 Made the national youth team.", "2025 Named team captain."] };
    // The pillar's own evidence names it; a milestone's year may date it.
    expect(chipBacked("Team captain 2025", facts)).toBe(true);
    expect(chipBacked("Two seasons captain", facts)).toBe(true);
    // Another pillar's territory (a milestone the evidence does not name), a wrong year, or an invented claim: dropped.
    expect(chipBacked("National youth team", facts)).toBe(false);
    expect(chipBacked("Team captain 2024", facts)).toBe(false);
    expect(chipBacked("All-America", facts)).toBe(false);
    expect(chipBacked("First ever captain", facts)).toBe(false);
    // Short or nothing.
    expect(chipBacked("Captain of the national youth team seasons", facts)).toBe(false);
    expect(chipFactsFor(full)[0]).toEqual({ evidence: "Captain two seasons running.", dated: ["2022 Made the national youth team.", "2025 Named team captain."] });
  });

  it("writes chips with each pillar, keeps the backed ones, and never loses the pillar for a bad chip", async () => {
    const pillarBriefs = bookBriefs(full).filter((b) => b.page === "pillars");
    expect(pillarBriefs[0].slots[0]).toMatchObject({ key: "pillar", fields: ["name", "proof", "chips"] });
    const write = async () => ({ cards: [{ card: "pillars", pillar: [[
      { name: "Lead From Inside", proof: "The armband keeps finding you.", chips: ["Captain 2025", "Captain 2019", "World champion"] },
      { name: "Think It Through", proof: "You study the game.", chips: ["Engineering studies", "Captain 2025"] },
      { name: "Hold The Door", proof: "You open the way.", chips: [] },
    ]] }] });
    const out = await writeBookCopy(ctx, pillarBriefs, [], { chipFacts: chipFactsFor(full) }, { write, rank: async () => ({}) });
    const lines = out!.lines.pillars!;
    expect(lines["pillar.0.chips"].text).toBe("Captain 2025");
    expect(lines["pillar.1.chips"].text).toBe("Engineering studies");
    expect(lines["pillar.2.chips"]).toBeUndefined();
    expect(lines["pillar.2.name"].text).toBe("Hold The Door");
    expect(chipsOf({ lines }, 0)).toEqual(["Captain 2025"]);
  });

  it("closes the book with its own line, and leaves the closing page out when no line came back", async () => {
    const closeBrief = bookBriefs(full).filter((b) => b.page === "close");
    expect(closeBrief[0].slots).toEqual([{ kind: "line", key: "line", max: 90 }]);
    expect(closeBrief[0].intent).toContain("different line from the cover");
    const out = await writeBookCopy(ctx, closeBrief, [], {}, { write: async () => ({ cards: [{ card: "close", line: ["Lead in public. Keep the door open."] }] }), rank: async () => ({}) });
    const withClose = assemblePages({ ...full, images: { ...full.images, close: "a/close.jpg" } }, { close: out!.lines.close! });
    const close = withClose.find((p) => p.id === "close")!;
    expect(close.lines.line.text).toBe("Lead in public. Keep the door open.");
    expect(close.images).toEqual(["a/close.jpg"]);
    expect(assemblePages(full, {}).some((p) => p.id === "close")).toBe(false);
  });

  it("returns null when the writer cannot run, and survives a failed editor", async () => {
    expect(await writeBookCopy(ctx, briefs, [], {}, { write: async () => null })).toBeNull();
    const out = await writeBookCopy(ctx, briefs, [], {}, {
      write: async () => ({ cards: [{ card: "cover", line: ["One.", "Two."] }] }),
      rank: async () => { throw new Error("down"); },
    });
    expect(out!.lines.cover!.line.text).toBe("One.");
  });
});

describe("palette", () => {
  it("finds the colours that recur and closes with a deep neutral", () => {
    const px = (rgb: number[], n: number) => Uint8Array.from(Array.from({ length: n }, () => rgb).flat());
    const photo = Uint8Array.from([...px([200, 30, 50], 60), ...px([30, 60, 200], 30), ...px([12, 12, 14], 10)]);
    const pal = paletteFromPixels([photo]);
    expect(pal.length).toBe(3);
    expect(pal[pal.length - 1]).toMatch(/^#0/);
  });
  it("is empty with nothing to read", () => {
    expect(paletteFromPixels([])).toEqual([]);
  });
  it("leaves out the pitch: grass green never leads her palette", () => {
    const px = (rgb: number[], n: number) => Uint8Array.from(Array.from({ length: n }, () => rgb).flat());
    const photo = Uint8Array.from([...px([60, 160, 70], 70), ...px([190, 25, 40], 20), ...px([12, 12, 14], 10)]);
    const pal = paletteFromPixels([photo]);
    expect(pal).toHaveLength(2);
    expect(isGrassGreen([60, 160, 70])).toBe(true);
    expect(isGrassGreen([190, 25, 40])).toBe(false);
  });
});

describe("reel scenes", () => {
  it("takes one strong line per photo, in the book's order, and skips pages without one", () => {
    const pages = assemblePages(full, {
      cover: { line: { text: "You show up first.", options: ["You show up first."] } },
      big_idea: { line: { text: "Lead so others can.", options: ["Lead so others can."] } },
    });
    const book: BrandBookData = { contract: "brand-book/2", version: 1, generatedAt: "", firstName: "Ana", pages };
    const scenes = reelScenes(book);
    expect(scenes[0]).toEqual({ image: "a/hero.jpg", kicker: "ANA", text: "You show up first." });
    expect(scenes.map((s) => s.kicker)).toEqual(["ANA", "THE BIG IDEA", "PILLAR 1", "PILLAR 3"]);
  });
});
