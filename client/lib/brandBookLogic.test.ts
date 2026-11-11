import {
  beatRows, bookStudioItems, bookTile, channelRows, compact, dimensionRows, guardrailSource, isBookItem, pillarRows, planRows,
  postStats, rateRow, sayLines, showReel, BRAND_BOOK_COPY,
} from "./brandBookLogic";
import type { BookPage, BrandBookResponse } from "../../shared/brandBook";
import type { AgentGoalsResponse } from "../../shared/plan";

const line = (text: string) => ({ text, options: [text, `${text} (2)`] });
const pages: BookPage[] = [
  { id: "cover", title: "Your brand book", lines: { line: line("You show up first.") }, facts: ["Ana"], images: ["https://x/cover.jpg"] },
  { id: "pillars", title: "Your pillars", lines: { "pillar.0.name": line("Lead"), "pillar.0.proof": line("Proof"), "pillar.1.name": line("Learn") }, facts: [], images: ["https://x/p0.jpg"], extra: { evidence: ["Captain", "Studies", "Clinic"] } },
  { id: "story", title: "Your story", lines: { "beat.0": line("It opened a door."), line: line("Chapters.") }, facts: [], images: [], extra: { milestones: [{ date: "2022", fact: "First cap." }, { date: "2025", fact: "Captain." }] } },
  { id: "voice_look", title: "Your voice and look", lines: { line: line("Short and real."), "say.1": line("b"), "say.0": line("a") }, facts: [], images: [] },
];
const ready: BrandBookResponse = {
  contract: "brand-book/2", status: "ready", version: 2, error: null,
  book: { contract: "brand-book/2", version: 2, generatedAt: "2026-10-20T10:00:00Z", firstName: "Ana", pages },
  reel: null,
};

describe("brand book on the app", () => {
  it("the Me tile says what is happening, and nothing once the book is ready", () => {
    expect(bookTile(null)).toEqual({ state: "none", sub: null });
    expect(bookTile({ ...ready, status: "none", book: null })).toEqual({ state: "none", sub: BRAND_BOOK_COPY.tileEmpty });
    expect(bookTile({ ...ready, status: "none", book: null, stale: true }).state).toBe("none");
    expect(bookTile({ ...ready, status: "building", book: null }).sub).toBe(BRAND_BOOK_COPY.tileWriting);
    expect(bookTile(ready)).toEqual({ state: "ready", sub: null });
  });

  it("reads pillars (each with its own photo), beats and say-lines as rows", () => {
    expect(pillarRows(pages[1])).toEqual([
      { i: 0, name: "Lead", proof: "Proof", evidence: "Captain", image: "https://x/p0.jpg" },
      { i: 1, name: "Learn", proof: null, evidence: "Studies", image: null },
      { i: 2, name: null, proof: null, evidence: "Clinic", image: null },
    ]);
    expect(beatRows(pages[2])).toEqual([
      { i: 0, date: "2022", fact: "First cap.", line: "It opened a door." },
      { i: 1, date: "2025", fact: "Captain.", line: null },
    ]);
    expect(sayLines(pages[3]).map((s) => s.text)).toEqual(["a", "b"]);
  });

  it("charts the read of record strongest first, rounded, unscored last", () => {
    const rows = dimensionRows([{ key: "audience_scale", score: 32 }, { key: "narrative_power", score: 90.8 }, { key: "momentum", score: null }, { key: "brand_fit", score: 55 }]);
    expect(rows.map((r) => [r.name, r.score, r.band])).toEqual([
      ["Narrative power", 91, "strong"], ["Brand fit", 55, "mid"], ["Audience scale", 32, "thin"], ["Momentum", null, "none"],
    ]);
  });

  it("shows each channel's headline and only the stats that were measured", () => {
    expect(channelRows([
      { platform: "instagram", handle: "ana", followers: 21714, engagementRate: 5.2, avgReach: 12546, avgViews: null },
      { platform: "tiktok", handle: null, followers: 15429, engagementRate: 11.95, avgReach: null, avgViews: 78662 },
    ])).toEqual([
      { platform: "Instagram", handle: "@ana", followers: "21.7K", stats: [{ value: "5.2%", label: "engagement" }, { value: "12.5K", label: "reach a post" }] },
      { platform: "TikTok", handle: null, followers: "15.4K", stats: [{ value: "12%", label: "engagement" }, { value: "78.7K", label: "views a post" }] },
    ]);
    expect(compact(940)).toBe("940");
    expect(compact(1_250_000)).toBe("1.3M");
  });

  it("labels where a guardrail comes from, and writes rates with her minimum", () => {
    expect(guardrailSource({ text: "x", from: "you" })).toBe("Your words");
    expect(guardrailSource({ text: "x", from: "contract" })).toBe("On file");
    expect(guardrailSource({ text: "x", from: "read" })).toBe("Our read");
    expect(rateRow({ rateType: "ig_post", label: "Instagram feed post", low: 1500, high: 5000, currency: "USD", minimum: 1000 }))
      .toEqual({ label: "Instagram feed post", range: "$1,500–5,000", minimum: "$1,000" });
    expect(rateRow({ rateType: "ig_reel", label: "Reel", low: null, high: null, currency: "USD", minimum: 800 }).range).toBeNull();
  });

  it("reads the plan chapter live: goals with their lined-up posts, and what Mila suggests keeping", () => {
    const goals = {
      goals: [{ id: "g1", text: "Post each week", plan: "Two posts a week", horizon: "now", actions: [{ planKind: "post" }, { planKind: "reply" }, { planKind: "post" }] }],
      recommended: [{ decisionId: "d1", goal: "One partner project", horizon: "later", why: "You have the story." }],
    } as unknown as AgentGoalsResponse;
    const label = (h: unknown) => (h === "now" ? "This month" : h === "later" ? "This year" : null);
    expect(planRows(goals, label as any)).toEqual({
      goals: [{ id: "g1", text: "Post each week", horizon: "This month", posts: 2, plan: "Two posts a week" }],
      suggested: [{ decisionId: "d1", text: "One partner project", horizon: "This year", why: "You have the story." }],
    });
    expect(planRows(null, label as any)).toEqual({ goals: [], suggested: [] });
  });

  it("puts the book, and the reel once made, on Studio's Decks & pages", () => {
    expect(bookStudioItems(null)).toEqual([]);
    const one = bookStudioItems(ready);
    expect(one.map((i) => [i.id, i.kind, i.thumbUrl, i.meta])).toEqual([["brand-book", "page", "https://x/cover.jpg", "4 chapters"]]);
    const two = bookStudioItems({ ...ready, reel: { status: "ready", version: 2, requestedAt: "t", finishedAt: "u", url: "https://x/r.mp4", posterUrl: "https://x/p.jpg" } });
    expect(two.map((i) => i.id)).toEqual(["brand-book", "brand-book-reel"]);
    expect(isBookItem("brand-book-reel")).toBe(true);
    expect(isBookItem("deck-3")).toBe(false);
  });

  it("puts the reel on the cover and the last chapter only", () => {
    expect([0, 1, 5, 9].map((i) => showReel(i, 10))).toEqual([true, false, false, true]);
  });

  it("writes her numbers plainly", () => {
    expect(postStats(4200, 31)).toBe("4,200 likes · 31 comments");
    expect(postStats(null, 3)).toBe("3 comments");
  });
});
