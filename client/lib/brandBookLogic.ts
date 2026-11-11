// The brand book on the app (screens/me/BrandBookScreen, the Me tile, Studio's Decks & pages). Pure: the server's book in,
// what each chapter shows out. Every word the athlete reads that is not hers or the copywriter's lives in BRAND_BOOK_COPY.
//
// brand-book/2 (settled 20 Oct 2026, https://claude.ai/artifact/CWzB53bLBVF8pu1BugWPDR): the agency's presentation to its own
// athlete in ten chapters — what we found, the brand we'd build and why, how we get there. Drawn in the app's one look
// (owner, 23 Oct 2026; it was the Nomi Card's Luxe craft). Chapter 10 (the plan) reads her goals live; nothing here invents a fact.
import type { BookChannel, BookDimension, BookGuardrail, BookPage, BookRate, BrandBookResponse } from "../../shared/brandBook";
import type { AgentGoalsResponse, GoalView, RecommendedGoalView } from "../../shared/plan";
import type { StudioItem } from "./agent/types";

export const BRAND_BOOK_COPY = {
  title: "Your brand book",
  write: "Write my brand book",
  rewrite: "Rewrite it",
  writingTitle: "Mila is writing your brand book",
  writingLine: "She's reading your story, your posts and your numbers. About two minutes.",
  emptyTitle: "Your brand book",
  emptyLine: "What we found, the brand we think you should build and why, and how we get there — written to you, from what Nomila knows about you.",
  staleLine: "Your brand book has a new shape: what we found, the brand we'd build, and the plan. Rewrite it to see yours.",
  failed: "Mila couldn't finish your brand book this time. Try again in a minute.",
  reel: "Make it a reel",
  reelRendering: "Making your reel…",
  reelReady: "Watch your reel",
  reelFailed: "The reel didn't finish. Try again.",
  share: "Share this page",
  swapTitle: "Pick a line",
  askMila: "Ask Mila to rewrite it",
  tileWriting: "Mila is writing it",
  tileEmpty: "Mila writes it for you",
  studioBook: "Your brand book",
  studioReel: "Brand book reel",
  privateTag: "Only you see this",
  strong: "Where you're strong",
  thin: "Where it's thin",
  opportunity: "The opportunity",
  scoreOf: "of 850",
  yourScore: "Your score",
  markCover: "Nomila · Brand book",
  markFoot: "Nomila",
  from: "From",
  to: "To",
  now: "Now",
  next: "Next",
  channels: "Your channels",
  where: "Where they are",
  strongest: "Your strongest posts",
  palette: "Your palette",
  sayIt: "Say it like",
  fromYou: "Your words",
  fromContract: "On file",
  fromRead: "Our read",
  rates: "Your rates",
  yourMin: "your minimum",
  setMin: "Set your minimum",
  partners: "Who you work with",
  inbound: "Who comes to you",
  planEmpty: "No goals yet. Keep one Mila suggests, or add your own.",
  suggests: "Mila suggests",
  keep: "Keep",
  notNow: "Not now",
  postsReady: (k: number) => `${k} post${k === 1 ? "" : "s"} for this`,
  openStudio: "See them in Studio",
  manageGoals: "All your goals",
  closeEyebrow: "That's your brand",
  closeNote: "Mila keeps this book current as your story moves. Your edits stay.",
  sharePage: "Share a page",
} as const;

export type BookTileState = "none" | "building" | "ready" | "failed";

/** The Me tile's state and its one quiet line (null when the book is ready: the picture says enough). */
export function bookTile(book: BrandBookResponse | null | undefined): { state: BookTileState; sub: string | null } {
  if (!book) return { state: "none", sub: null };
  if (book.status === "building") return { state: "building", sub: BRAND_BOOK_COPY.tileWriting };
  if (book.status === "ready" && book.book) return { state: "ready", sub: null };
  if (book.status === "failed") return { state: "failed", sub: BRAND_BOOK_COPY.tileEmpty };
  return { state: "none", sub: BRAND_BOOK_COPY.tileEmpty };
}

/** A chapter's crafted line for a slot, or null. */
export function lineOf(page: BookPage, slot: string): string | null {
  return page.lines[slot]?.text ?? null;
}

/** Pillars as rows: name, proof, evidence, and the pillar's own photo (the chapter holds one per pillar, in order). */
export function pillarRows(page: BookPage): Array<{ i: number; name: string | null; proof: string | null; evidence: string | null; image: string | null }> {
  const count = Math.max(page.extra?.evidence?.length ?? 0, ...Object.keys(page.lines).map((k) => /^pillar\.(\d+)\./.exec(k)).filter(Boolean).map((m) => Number(m![1]) + 1));
  return Array.from({ length: count }, (_, i) => ({
    i, name: lineOf(page, `pillar.${i}.name`), proof: lineOf(page, `pillar.${i}.proof`), evidence: page.extra?.evidence?.[i] ?? null,
    image: page.images[i] ?? null,
  }));
}

/** Story beats as rows: the dated fact under the crafted line. */
export function beatRows(page: BookPage): Array<{ i: number; date: string; fact: string; line: string | null }> {
  return (page.extra?.milestones ?? []).map((m, i) => ({ i, date: m.date, fact: m.fact, line: lineOf(page, `beat.${i}`) }));
}

/** The "say it like" lines of the voice and look chapter. */
export function sayLines(page: BookPage): Array<{ slot: string; text: string }> {
  return Object.keys(page.lines).filter((k) => /^say\.\d+$/.test(k)).sort().map((k) => ({ slot: k, text: page.lines[k].text }));
}

const num = (v: number) => v.toLocaleString("en-US");
/** "21.7K", "78.7K", "1.2M", "940": a number as a stat. */
export function compact(v: number): string {
  if (v >= 1_000_000) return `${Math.round(v / 100_000) / 10}M`;
  if (v >= 1000) return `${Math.round(v / 100) / 10}K`;
  return String(Math.round(v));
}

/** "4,200 likes · 31 comments" — her numbers, as facts. */
export function postStats(likes: number | null, comments: number | null): string {
  return [likes != null ? `${num(likes)} likes` : null, comments != null ? `${num(comments)} comments` : null].filter(Boolean).join(" · ");
}

const DIMENSION_NAMES: Record<string, string> = {
  athletic_authority: "Athletic authority", audience_scale: "Audience scale", engagement_quality: "Engagement quality",
  cultural_relevance: "Cultural relevance", narrative_power: "Narrative power", brand_fit: "Brand fit",
  commercial_proof: "Commercial proof", momentum: "Momentum",
};

export type DimensionBand = "strong" | "mid" | "thin" | "none";
/** The eight dimensions as chart rows, strongest first; unscored ones last. Scores rounded. */
export function dimensionRows(dims: BookDimension[]): Array<{ key: string; name: string; score: number | null; band: DimensionBand }> {
  return [...dims]
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .map((d) => {
      const score = d.score == null ? null : Math.round(d.score);
      const band: DimensionBand = score == null ? "none" : score >= 70 ? "strong" : score >= 45 ? "mid" : "thin";
      return { key: d.key, name: DIMENSION_NAMES[d.key] ?? d.key.replace(/_/g, " "), score, band };
    });
}

const PLATFORM: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", facebook: "Facebook", threads: "Threads" };
export const platformName = (p: string | null | undefined) => (p ? PLATFORM[p] ?? p.charAt(0).toUpperCase() + p.slice(1) : "");

/** Each channel as a headline number and up to two supporting stats (only what was measured). */
export function channelRows(channels: BookChannel[]): Array<{ platform: string; handle: string | null; followers: string | null; stats: Array<{ value: string; label: string }> }> {
  return channels.map((c) => ({
    platform: platformName(c.platform),
    handle: c.handle ? `@${c.handle}` : null,
    followers: c.followers != null ? compact(c.followers) : null,
    stats: [
      c.engagementRate != null ? { value: `${Math.round(c.engagementRate * 10) / 10}%`, label: "engagement" } : null,
      c.avgReach != null ? { value: compact(c.avgReach), label: "reach a post" } : null,
      c.avgViews != null ? { value: compact(c.avgViews), label: "views a post" } : null,
    ].filter((s): s is { value: string; label: string } => !!s).slice(0, 2),
  }));
}

/** Where a guardrail comes from, in her words. */
export function guardrailSource(g: BookGuardrail): string {
  return g.from === "you" ? BRAND_BOOK_COPY.fromYou : g.from === "contract" ? BRAND_BOOK_COPY.fromContract : BRAND_BOOK_COPY.fromRead;
}

/** "$1,500"; null when unknown. */
export function money(v: number | null, currency = "USD"): string | null {
  if (v == null) return null;
  return `${currency.toUpperCase() === "USD" ? "$" : `${currency.toUpperCase()} `}${num(Math.round(v))}`;
}
/** A rate as the commercial chapter lists it: "$1,500–5,000" and her own minimum. */
export function rateRow(r: BookRate): { label: string; range: string | null; minimum: string | null } {
  const lo = money(r.low, r.currency);
  const hi = r.high != null ? num(Math.round(r.high)) : null;
  return { label: r.label, range: lo && hi ? `${lo}–${hi}` : lo, minimum: money(r.minimum, r.currency) };
}

export interface PlanGoalRow { id: string; text: string; horizon: string | null; posts: number; plan: string | null }
export interface PlanSuggestionRow { decisionId: string; text: string; horizon: string | null; why: string }

/** The plan chapter: her goals with how many posts are lined up for each, and what Mila suggests keeping. */
export function planRows(goals: AgentGoalsResponse | null | undefined, horizonLabel: (h: GoalView["horizon"]) => string | null): { goals: PlanGoalRow[]; suggested: PlanSuggestionRow[] } {
  const posts = (actions: GoalView["actions"]) => actions.filter((a) => a.planKind === "post").length;
  return {
    goals: (goals?.goals ?? []).map((g) => ({ id: g.id, text: g.text, horizon: horizonLabel(g.horizon), posts: posts(g.actions), plan: g.plan })),
    suggested: (goals?.recommended ?? []).map((r: RecommendedGoalView) => ({ decisionId: r.decisionId, text: r.goal, horizon: horizonLabel(r.horizon), why: r.why })),
  };
}

/** The book (and its reel, once made) as Studio items for the Decks & pages shelf. */
export function bookStudioItems(book: BrandBookResponse | null | undefined): StudioItem[] {
  if (!book?.book || book.status === "none") return [];
  const cover = book.book.pages[0]?.images[0] ?? null;
  const out: StudioItem[] = [{
    id: "brand-book", kind: "page", title: BRAND_BOOK_COPY.studioBook, status: "approved", version: book.version, goal: null,
    thumbUrl: cover, updatedAt: book.book.generatedAt, meta: `${book.book.pages.length} chapters`, open: null,
  }];
  if (book.reel?.status === "ready" && book.reel.url) {
    out.push({
      id: "brand-book-reel", kind: "page", title: BRAND_BOOK_COPY.studioReel, status: "draft", version: book.reel.version, goal: null,
      thumbUrl: book.reel.posterUrl ?? cover, updatedAt: book.reel.finishedAt ?? book.reel.requestedAt, meta: "Reel", open: null,
    });
  }
  return out;
}

/** "Watch your reel" sits on the cover and the last chapter only (every chapter keeps Rewrite it). */
export const showReel = (index: number, count: number) => index === 0 || index === count - 1;

export const isBookItem = (id: string) => id === "brand-book" || id === "brand-book-reel";
