/**
 * shared/brandBook.ts — the athlete's brand book on the wire (server/services/brandBook, GET /api/v1/me/brand-book).
 *
 * The agency's presentation to its own athlete, written to her as "you": what we found, the brand we think we should
 * build and why, and how we get there. Ten chapters, none repeating another. A chapter carries FACTS (shown as facts,
 * from her own records) and crafted LINES on top. Every crafted line is a slot with the copywriter's options, so
 * swapping a line is one generic call (page, slot, option) and costs nothing. A chapter with no data behind it is simply
 * not in the book.
 *
 * Chapter 10 (the plan) is LIVE: the app reads her goals as they are now (GET /me/agent/goals); the book holds only its
 * crafted lines. Chapter 9 (commercial position) re-reads her rates on every read, so a minimum she sets shows at once.
 *
 * Private: this book is hers. Nothing in it is shown to a brand or on her public page.
 * Nothing here names an athlete, sport, school or brand.
 */

export const BRAND_BOOK_CONTRACT = "brand-book/2" as const;

export const BRAND_BOOK_PAGES = [
  "cover", "found", "big_idea", "pillars", "story", "listening", "voice_look", "avoid", "commercial", "plan", "close",
] as const;
export type BrandBookPageId = (typeof BRAND_BOOK_PAGES)[number];

/** A crafted line: the one shown, and every clean option the writer gave (the shown one included). */
export interface BookLine {
  text: string;
  options: string[];
}

/** One of her own posts as proof: its picture, its numbers as facts, where and when it went up. */
export interface BookPost {
  image: string;
  platform: string | null;
  likes: number | null;
  comments: number | null;
  postedAt: string | null;
  permalink: string | null;
}

/** One marketability dimension as the read of record scored it (0–100; null = not enough evidence). */
export interface BookDimension {
  key: string;
  score: number | null;
  /** The stored score × weight (of 100) that sizes the M.I.A. ring's band; absent on books written before 23 Oct 2026. */
  contribution?: number | null;
}

/** A connected channel's latest measured numbers. */
export interface BookChannel {
  platform: string;
  handle: string | null;
  followers: number | null;
  engagementRate: number | null;
  avgReach: number | null;
  avgViews: number | null;
}

/** A guardrail and where it comes from. */
export interface BookGuardrail {
  text: string;
  /** you = her own words (a preference or her confirmed voice); contract = an exclusivity on file; read = Nomila's read. */
  from: "you" | "contract" | "read";
}

/** A brand she works with, as our brand research describes it. */
export interface BookPartner {
  name: string;
  logoUrl: string | null;
  category: string | null;
  tier: string | null;
  audience: string | null;
}

/** One of her rates as the rates screen holds it (Mila's suggested range, and her own minimum when she set one). */
export interface BookRate {
  rateType: string;
  label: string;
  low: number | null;
  high: number | null;
  currency: string;
  minimum: number | null;
}

export interface BookPage {
  id: BrandBookPageId;
  /** The template's label for the chapter ("What we found", "Your pillars" …): structure, never model copy. */
  title: string;
  /**
   * Crafted lines by slot: "line", "eyebrow", "pillar.0.name", "pillar.0.proof", "pillar.0.chips", "beat.2", "say.1" …
   * Slots a chapter does not use are absent. "pillar.N.chips" holds 2–3 short evidence tags joined by " · ", each checked
   * against her stored facts (chipsOf splits them).
   */
  lines: Record<string, BookLine>;
  /** Her facts, shown as facts (one per row). */
  facts: string[];
  /** Images, in order. On the server: bucket paths. On the wire: signed URLs. */
  images: string[];
  /**
   * How well each image fits its slot's brief, parallel to `images` (21 Oct 2026): "strong" matches the page's theme,
   * "decent" passed every hard gate but matches less (the treatment step does more with it), "" = no image in that slot.
   * Absent on books built before it existed.
   */
  imageTiers?: Array<"strong" | "decent" | "atmosphere" | "">;
  /**
   * A toned (darkened, softly blurred; neutral in the one look) version of the page's photo, for drawing BEHIND a big line of type — statement
   * pages (big idea, plan). On the server: a bucket path. On the wire: a signed URL. Absent when none.
   */
  backdrop?: string;
  /** Chapter-specific facts with structure. */
  extra?: {
    /** found: the read of record (score, the eight dimensions, its own strengths and constraints) and the opportunity. */
    found?: { score: number | null; asOf: string | null; dimensions: BookDimension[]; strengths: string[]; thin: string[]; opportunity: string | null };
    /** big_idea: the positioning, from → to, and where the brand stands now / goes next (the Brief's own lines). */
    idea?: { statement: string | null; from: string | null; to: string | null; now: string | null; next: string | null };
    /** pillars: each pillar's evidence line, in order. */
    evidence?: string[];
    /** story: the dated milestones the beats speak to, oldest first. */
    milestones?: Array<{ date: string; fact: string }>;
    /** listening: her channels' measured numbers, where her audience is, and her own strongest posts. */
    listening?: { channels: BookChannel[]; countries: Array<{ label: string; share: number }>; posts: BookPost[] };
    /** voice_look: her palette, measured from her own photos. */
    palette?: string[];
    /** avoid: what the brand stays away from. */
    guardrails?: BookGuardrail[];
    /** commercial: her rates (live), the brands she works with, and the kinds of brands that come to her. */
    commercial?: { rates: BookRate[]; partners: BookPartner[]; inbound: Array<{ category: string; count: number }> };
  };
}

export interface BrandBookData {
  contract: typeof BRAND_BOOK_CONTRACT;
  version: number;
  generatedAt: string;
  firstName: string;
  pages: BookPage[];
}

export type BrandBookStatus = "none" | "building" | "ready" | "failed";
export type BrandBookReelStatus = "rendering" | "ready" | "failed";

/** The motion version, as stored (paths) and as sent (urls). */
export interface BrandBookReel {
  status: BrandBookReelStatus;
  /** The book version it was made from. */
  version: number;
  requestedAt: string;
  finishedAt?: string | null;
  assetId?: string | null;
  /** Server: bucket paths. */
  gcsPath?: string | null;
  posterPath?: string | null;
  /** Wire: signed URLs. */
  url?: string | null;
  posterUrl?: string | null;
  /** Her sentence when it failed. */
  error?: string | null;
}

/** GET /api/v1/me/brand-book. */
export interface BrandBookResponse {
  contract: typeof BRAND_BOOK_CONTRACT;
  status: BrandBookStatus;
  version: number;
  /** A book stored under an older contract is not sent (null, `stale: true`): she rewrites it. */
  book: BrandBookData | null;
  reel: BrandBookReel | null;
  /** Her sentence when the last build failed. */
  error: string | null;
  /** True when a book exists but was written in an older shape: the app offers "Rewrite it". */
  stale?: boolean;
}

/** The separator between a pillar's evidence chips in its "pillar.N.chips" line. */
export const CHIP_SEP = " · ";
/** A pillar's evidence chips (empty when it has none). */
export function chipsOf(page: Pick<BookPage, "lines">, pillar: number): string[] {
  const t = page.lines[`pillar.${pillar}.chips`]?.text ?? "";
  return t ? t.split(CHIP_SEP).map((x) => x.trim()).filter(Boolean) : [];
}

/** The slot keys of a page, in reading order. */
export function slotKeys(page: Pick<BookPage, "lines">): string[] {
  return Object.keys(page.lines);
}
