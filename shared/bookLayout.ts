/**
 * shared/bookLayout.ts — how a brand book (and, later, the Nomi Card pitch and public page) is laid out as SCREENS.
 *
 * Pure and platform-free, so the app's reader (client/components/book) and the HTML renderer (server kitRenderer) read
 * the same decisions: which pages a chapter becomes (one idea per screen, never scrolling inside a page), which ground
 * each page sits on (warm ink for story pages, ivory paper for data, full-bleed photo for the hero moments), and which of
 * a card type's layouts it gets — chosen by rules from the content's own shape (is there a photo, how good a match, how
 * long is the line, how many numbers), never by a model, and never the same layout on two pages in a row.
 *
 * Design of record: "Brand book, polished" (https://claude.ai/artifact/NBTHEav4Jy5XZGN8YQzFyZ) and "Templates and motion"
 * (https://claude.ai/artifact/QhP12GAJcH24tkkmMRzXNW); drawn in the app's one look since 23 Oct 2026 (owner-approved
 * comparison https://claude.ai/artifact/2b1Wp7qqeNEeCxLL9Dznqa, version B): the colours and type are the app's own
 * (client/constants/theme.ts `Bold`), so this file carries no palette — only `pageTone`, which pages are dark.
 * Nothing here names an athlete, sport, school or brand.
 */
import type { BookPage, BrandBookData, BrandBookPageId } from "./brandBook";

/**
 * The ground a page's layout calls for. "ink" (story) and "paper" (data, lists of record) are the type pages — both
 * drawn on white in the one look (the names are the layout's, kept so the rules read the same); "photo" is a full-bleed
 * hero photo, drawn on the dark ground. See `pageTone`.
 */
export type BookGround = "ink" | "paper" | "photo";
/** The card types (Templates and motion §3), plus the two chapter shapes that only the book has (list, plan). */
export type BookKind = "cover" | "statement" | "data" | "pillar" | "timeline" | "gallery" | "list" | "plan" | "close";
export type BookVariant = "A" | "B" | "C";
export type ImageTier = "strong" | "decent" | "";

/** One screen of the reader. Rows of a chapter split across pages are given as [from, to) indices. */
export interface ReaderPage {
  /** Unique within the book ("pillars.1", "story.0" …). */
  key: string;
  chapter: BrandBookPageId;
  /** A sub-page's role inside its chapter: the read that follows the found chart, the partners after the rates. */
  role: "main" | "read" | "more";
  kind: BookKind;
  variant: BookVariant;
  ground: BookGround;
  /** Which part of the chapter this is (pillar 2 of 3, story 1 of 2). n = 1 for a single-page chapter. */
  part: { i: number; n: number };
  image: string | null;
  tier: ImageTier;
  backdrop: string | null;
  /** The rows this page shows (beats, guardrails, rates…), [from, to). */
  rows: [number, number];
  /** The pillar this page is about (pillar pages only). */
  pillar?: number;
}

/** How many rows fit one screen — the splitting rule ("a chapter that doesn't fit becomes two pages"). */
export const FIT = {
  beatsPerPage: 4,
  guardrailsPerPage: 3,
  ratesPerPage: 6,
  /** A cover line this short can carry the giant-name layout. */
  shortCoverLine: 52,
} as const;

const tierAt = (p: BookPage, i: number): ImageTier => {
  if (!p.images[i]) return "";
  const t = p.imageTiers?.[i];
  return t === "decent" ? "decent" : t === "" ? "" : "strong";
};
const line = (p: BookPage, slot: string) => p.lines[slot]?.text ?? "";
const pillarCount = (p: BookPage) =>
  Math.max(p.extra?.evidence?.length ?? 0, ...Object.keys(p.lines).map((k) => /^pillar\.(\d+)\./.exec(k)).filter(Boolean).map((m) => Number(m![1]) + 1), 0);
const chunks = (n: number, size: number): Array<[number, number]> =>
  n <= 0 ? [[0, 0]] : Array.from({ length: Math.ceil(n / size) }, (_, i) => [i * size, Math.min(n, (i + 1) * size)] as [number, number]);

/** Cover: A full-bleed portrait · B giant name over the photo (short line) · C split ivory + photo (a decent match, or none). */
export function coverVariant(tier: ImageTier, coverLine: string): BookVariant {
  if (tier !== "strong") return "C";
  return coverLine.length > 0 && coverLine.length <= FIT.shortCoverLine ? "B" : "A";
}
/** Statement: A type only on paper (no photo) · B the line over the full-bleed photo (strong) · C a photo band above the line (decent). */
export function statementVariant(tier: ImageTier): BookVariant {
  return tier === "strong" ? "B" : tier === "decent" ? "C" : "A";
}
/** Data: A big number + bars (a score and four or more dimensions) · B the ring + the read (fewer) · C stat tiles (channels, no score). */
export function dataVariant(score: number | null | undefined, dimensions: number): BookVariant {
  if (score == null) return "C";
  return dimensions >= 4 ? "A" : "B";
}
/**
 * Pillar: A full-bleed photo · B full-bleed, toned ink-to-gold (a decent match reads as intended, not as a weak photo) ·
 * C type only on paper (no photo). Photo pillars alternate A/B so two pillars in a row never share a layout.
 */
export function pillarVariant(tier: ImageTier, prev: BookVariant | null): BookVariant {
  if (!tier) return "C";
  if (tier === "decent") return prev === "B" ? "A" : "B";
  return prev === "A" ? "B" : "A";
}

/** The ground a page sits on: photo for the hero moments, paper for data and lists of record, ink for story. */
function groundOf(kind: BookKind, variant: BookVariant, chapter: BrandBookPageId, hasImage: boolean, hasBackdrop: boolean): BookGround {
  if (kind === "cover") return variant === "C" ? "paper" : "photo";
  if (kind === "statement") return variant === "A" ? "paper" : variant === "B" ? "photo" : "ink";
  if (kind === "pillar") return variant === "C" ? "paper" : "photo";
  if (kind === "plan") return hasBackdrop || hasImage ? "photo" : "ink";
  if (kind === "close") return hasImage ? "photo" : "ink";
  if (kind === "data") return "paper";
  if (kind === "list") return chapter === "avoid" ? "paper" : "ink";
  return "ink";
}

/**
 * The book as screens, in reading order. Chapters that hold more than a screen split (pillars one per page, four story
 * beats a page, three guardrails, five rates); the found chart's read and the commercial partners get their own page when
 * there is something to say. Pure.
 */
export function readerPages(book: Pick<BrandBookData, "pages">): ReaderPage[] {
  const out: ReaderPage[] = [];
  const push = (p: BookPage, x: Omit<ReaderPage, "chapter" | "ground" | "backdrop"> & { backdrop?: string | null }) => {
    const ground = groundOf(x.kind, x.variant, p.id, !!x.image, !!x.backdrop);
    out.push({ chapter: p.id, ground, backdrop: x.backdrop ?? null, ...x });
  };

  for (const p of book.pages) {
    switch (p.id) {
      case "cover":
        push(p, { key: "cover", role: "main", kind: "cover", variant: coverVariant(tierAt(p, 0), line(p, "line")), part: { i: 0, n: 1 }, image: p.images[0] ?? null, tier: tierAt(p, 0), rows: [0, 0] });
        break;
      case "found": {
        const f = p.extra?.found;
        push(p, { key: "found", role: "main", kind: "data", variant: dataVariant(f?.score, f?.dimensions.filter((d) => d.score != null).length ?? 0), part: { i: 0, n: 1 }, image: null, tier: "", rows: [0, f?.dimensions.length ?? 0] });
        const reads = (f?.strengths.length ?? 0) + (f?.thin.length ?? 0) + (f?.opportunity ? 1 : 0);
        if (reads) push(p, { key: "found.read", role: "read", kind: "list", variant: "A", part: { i: 0, n: 1 }, image: null, tier: "", rows: [0, reads] });
        break;
      }
      case "big_idea":
        push(p, { key: "big_idea", role: "main", kind: "statement", variant: statementVariant(tierAt(p, 0)), part: { i: 0, n: 1 }, image: p.images[0] ?? null, tier: tierAt(p, 0), rows: [0, 0], backdrop: p.backdrop ?? null });
        break;
      case "pillars": {
        const n = pillarCount(p);
        let prev: BookVariant | null = null;
        for (let i = 0; i < n; i++) {
          const tier = tierAt(p, i);
          const variant = pillarVariant(tier, prev);
          prev = variant;
          push(p, { key: `pillars.${i}`, role: "main", kind: "pillar", variant, part: { i, n }, image: p.images[i] || null, tier, rows: [i, i + 1], pillar: i });
        }
        break;
      }
      case "story": {
        const beats = p.extra?.milestones?.length ?? 0;
        // The first page carries the story's photo, so it holds one beat fewer.
        const first = p.images[0] ? FIT.beatsPerPage - 1 : FIT.beatsPerPage;
        const parts: Array<[number, number]> = beats <= first ? [[0, beats]] : [[0, first], ...chunks(beats - first, FIT.beatsPerPage).map(([a, b]) => [a + first, b + first] as [number, number])];
        parts.forEach((rows, i) => push(p, {
          key: `story.${i}`, role: i ? "more" : "main", kind: "timeline", variant: i === 0 && p.images[0] ? "A" : "B", part: { i, n: parts.length },
          image: i === 0 ? p.images[0] ?? null : null, tier: i === 0 ? tierAt(p, 0) : "", rows,
        }));
        break;
      }
      case "listening":
        push(p, { key: "listening", role: "main", kind: "data", variant: "C", part: { i: 0, n: 1 }, image: null, tier: "", rows: [0, p.extra?.listening?.posts.length ?? 0] });
        break;
      case "voice_look":
        push(p, { key: "voice_look", role: "main", kind: "gallery", variant: "A", part: { i: 0, n: 1 }, image: p.images[0] ?? null, tier: tierAt(p, 0), rows: [0, Math.min(4, p.images.length)] });
        break;
      case "avoid": {
        const parts = chunks(p.extra?.guardrails?.length ?? 0, FIT.guardrailsPerPage);
        parts.forEach((rows, i) => push(p, { key: `avoid.${i}`, role: i ? "more" : "main", kind: "list", variant: "A", part: { i, n: parts.length }, image: null, tier: "", rows }));
        break;
      }
      case "commercial": {
        const c = p.extra?.commercial;
        const parts = chunks(c?.rates.length ?? 0, FIT.ratesPerPage);
        parts.forEach((rows, i) => push(p, { key: `commercial.${i}`, role: i ? "more" : "main", kind: "list", variant: "B", part: { i, n: parts.length }, image: null, tier: "", rows }));
        if ((c?.partners.length ?? 0) + (c?.inbound.length ?? 0) > 0) {
          push(p, { key: "commercial.partners", role: "more", kind: "list", variant: "C", part: { i: 0, n: 1 }, image: null, tier: "", rows: [0, c!.partners.length] });
        }
        break;
      }
      case "plan":
        push(p, { key: "plan", role: "main", kind: "plan", variant: "A", part: { i: 0, n: 1 }, image: p.images[0] ?? null, tier: tierAt(p, 0), rows: [0, 0], backdrop: p.backdrop ?? null });
        break;
      case "close":
        // The closing page exists only with its line (the server leaves it out otherwise; older books never have it).
        if (line(p, "line")) push(p, { key: "close", role: "main", kind: "close", variant: "A", part: { i: 0, n: 1 }, image: p.images[0] ?? null, tier: tierAt(p, 0), rows: [0, 0] });
        break;
    }
  }
  return avoidAdjacentRepeats(out);
}

/**
 * The last rule: two pages in a row never share a layout. Where they would (same kind, same variant), the second one
 * moves to the next variant that the content still supports. Pure.
 */
export function avoidAdjacentRepeats(pages: ReaderPage[]): ReaderPage[] {
  const next: Record<BookKind, (v: BookVariant, p: ReaderPage) => BookVariant | null> = {
    cover: () => null,
    statement: () => null,
    data: () => null,
    pillar: (v, p) => (p.tier ? (v === "A" ? "B" : "A") : null),
    timeline: () => null,
    gallery: () => null,
    list: () => null,
    plan: () => null,
    close: () => null,
  };
  return pages.map((p, i, all) => {
    const prev = i ? all[i - 1] : null;
    if (!prev || prev.kind !== p.kind || prev.variant !== p.variant) return p;
    // A chapter's own continuation (story beats 5–8, the second guardrails page) reads as one chapter: exempt.
    if (p.kind !== "pillar" && prev.chapter === p.chapter && p.part.i > 0) return p;
    const v = next[p.kind](p.variant, p);
    if (!v) return p;
    const moved = { ...p, variant: v };
    all[i] = moved;
    return moved;
  });
}

/** The crafted lines a screen shows, in reading order — what its Edit pill offers to change. Pure. */
export function editSlots(rp: ReaderPage, page: Pick<BookPage, "lines">): string[] {
  const has = (k: string) => !!page.lines[k]?.text;
  const keep = (ks: string[]) => ks.filter(has);
  switch (rp.chapter) {
    case "pillars": return keep([`pillar.${rp.pillar}.name`, `pillar.${rp.pillar}.proof`, `pillar.${rp.pillar}.chips`]);
    case "story": {
      const beats = Array.from({ length: rp.rows[1] - rp.rows[0] }, (_, i) => `beat.${rp.rows[0] + i}`);
      return keep(rp.part.i === rp.part.n - 1 ? [...beats, "line"] : beats);
    }
    case "voice_look": return keep(["line", ...Object.keys(page.lines).filter((k) => /^say\.\d+$/.test(k)).sort()]);
    case "found": return rp.role === "read" ? [] : keep(["line"]);
    case "commercial": return rp.key === "commercial.0" ? keep(["line"]) : [];
    case "avoid": return rp.part.i === 0 ? keep(["line"]) : [];
    default: return keep(["line"]);
  }
}

/** The small header over a screen: the chapter's own label, with its part when it spans pages ("Pillar 2 of 3"). */
export function screenTitle(rp: ReaderPage, chapterTitle: string): string {
  if (rp.kind === "pillar") return `Pillar ${rp.part.i + 1} of ${rp.part.n}`;
  if (rp.role === "read") return "Our read";
  if (rp.key === "commercial.partners") return "Who you work with";
  return rp.part.n > 1 ? `${chapterTitle} · ${rp.part.i + 1} of ${rp.part.n}` : chapterTitle;
}

/**
 * A crafted line's type size: its layout's size while the line is comfortable, stepping down as it runs longer, never
 * below 72% — so a long line still fits its screen instead of being cut off mid-sentence. Pure.
 */
export function fitSize(text: string | null | undefined, base: number, comfortableChars: number): number {
  const n = (text ?? "").length;
  if (n <= comfortableChars) return base;
  return Math.round(base * Math.max(0.72, Math.sqrt(comfortableChars / n)) * 10) / 10;
}

/**
 * How a screen is lit in the one look (owner, 23 Oct 2026): white pages, with the DARK ground kept for the cover (always,
 * photo or not) and the full-bleed photo pages. `top` / `bottom` say whether the reader's chrome over the page's top
 * and foot sits on dark (white chrome) or on white (ink chrome): a page with a photo band across its top (the plan's
 * backdrop, a statement's photo band) is dark at the top and white at the foot. Pure.
 */
export function pageTone(rp: Pick<ReaderPage, "kind" | "variant" | "ground" | "image" | "backdrop">): { dark: boolean; top: "dark" | "light"; bottom: "dark" | "light" } {
  if (rp.kind === "cover") return { dark: true, top: "dark", bottom: "dark" };
  if (rp.kind === "plan") return { dark: false, top: rp.backdrop || rp.image ? "dark" : "light", bottom: "light" };
  if (rp.ground === "photo") return { dark: true, top: "dark", bottom: "dark" };
  if (rp.kind === "statement" && rp.variant === "C" && rp.image) return { dark: false, top: "dark", bottom: "light" };
  return { dark: false, top: "light", bottom: "light" };
}

/** Where the reel button and the "…" menu live: the cover and the last page. */
export const isBookEnd = (index: number, count: number) => index === 0 || index === count - 1;
