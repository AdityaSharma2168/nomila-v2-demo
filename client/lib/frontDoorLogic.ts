// frontDoorLogic — the small pure rules behind the Front Door page in the app (components/frontDoor) and the Scouting
// report on Me (components/me/Scouting*). Fixed copy over served data; nothing athlete-, sport-, school- or brand-specific.
//
//   frontDoorModel(content, opts)   the page model from her card's content (GET /me/public-card/preview), the same
//                                   content the visitor's page renders: Highlights on her own photo, then her chapters
//                                   (from data) on atmosphere, the four doors exactly as resolved at publish
//   shortCount(n)                   the rail's numbers: 612 · 1.2K · 14K
//   brandSpan(brand, now)           "Since 2024" · "confirmed 3 Oct" · null (never a made-up date)
//   stageLine(stage)                "College · Developing"
//   sentence(t)                     a plain sentence, capitalised, with its full stop
//   knowsLine(facts, unconfirmed)   "24 facts · 3 couldn't confirm"

import type { ChapterKind, PublicCardContent, PublicGridTile } from "../../shared/publicCard";
import type { CareerBand, ScoutBrand } from "../../shared/meScouting";
import { pageModel, type PageItem } from "./publicCardLogic";

export interface FrontDoorTile {
  /** The door's intent: partner | book | shop | create | story | follow | ask. */
  key: PublicGridTile["intent"];
  label: string;
  sub: string;
  /** Create ("Coming soon") draws on the dark tile. */
  dark: boolean;
  /** story / follow fallbacks: the chapter the tile swipes to. */
  targetChapter?: string;
}

export interface FrontDoorChapter {
  key: ChapterKind;
  title: string;
  headline: string;
  /** Its items as short lines (beats, partners, results). */
  lines: string[];
}

export interface FrontDoorModel {
  name: string;
  firstName: string;
  handle: string;
  /** Her own photo (Highlights is about her), or null for the blank ground. */
  heroPhoto: string | null;
  identity: string | null;
  quote: string | null;
  chapters: FrontDoorChapter[];
  tiles: FrontDoorTile[];
  askMila: boolean;
  socials: { network: string; handle: string }[];
}

/** The doors' words (owner-approved): Partner · Book · Picks · Create. An older published card that says "Shop" reads "Picks". */
const doorLabel = (t: PublicGridTile) => (t.intent === "shop" ? "Picks" : t.label);

function lineOf(i: PageItem): string | null {
  switch (i.type) {
    case "beat": return i.text;
    case "partner": return [i.name, i.since].filter(Boolean).join(" · ");
    case "fact": return [i.text, i.detail].filter(Boolean).join(" · ");
    case "stat": return `${i.value} ${i.label}`.trim();
    default: return null;
  }
}

/**
 * The page model from her card's content. `heroPhoto` is her own photo (resolved by the caller: the published image, or
 * her library's best). Chapters keep her order; Highlights is drawn as the first card, never repeated as a chapter.
 */
export function frontDoorModel(content: PublicCardContent, opts: { handle: string | null; heroPhoto: string | null }): FrontDoorModel {
  const p = pageModel(content);
  const chapters: FrontDoorChapter[] = p.cards
    .filter((c) => c.key !== "highlights")
    // The card's eyebrow is her title for it; the display line is the chapter's own line ("Signed partnerships"), or her
    // title again when the chapter has none (the card then draws it once).
    .map((c) => ({ key: c.key, title: c.title, headline: c.eyebrow ?? c.title, lines: c.items.map(lineOf).filter((x): x is string => !!x).slice(0, 3) }));
  return {
    name: content.displayName || `${content.firstName} ${content.lastName}`.trim(),
    firstName: content.firstName,
    handle: opts.handle ?? "",
    heroPhoto: opts.heroPhoto,
    identity: p.identityLine ?? null,
    quote: p.quote ?? null,
    chapters,
    tiles: content.tiles.map((t) => ({
      key: t.intent, label: doorLabel(t), sub: t.hint || t.subLabel, dark: t.intent === "create" || !!t.soon,
      ...(t.targetChapterId ? { targetChapter: t.targetChapterId } : {}),
    })),
    askMila: !!content.doors.ask_mila,
    socials: content.socials.map((s) => ({ network: s.network, handle: s.handle.replace(/^@/, "") })),
  };
}

/** The category default a chapter falls back to (DESIGN.md §9: its icon, outlined word and blue mark). */
export const CHAPTER_DOMAIN: Record<ChapterKind, string> = {
  highlights: "positioning", story: "positioning", competition: "athletic", venture: "owned_venture",
  partnerships: "commercial", impact: "impact", media: "audience", picks: "commercial",
};

/** The rail's numbers: 612 · 1.2K · 14K. */
export const shortCount = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(n));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Since 2024" when a fact states the start; else "confirmed 3 Oct" (with the year when it is not this year); else null. */
export function brandSpan(b: Pick<ScoutBrand, "startedOn" | "latestConfirmedOn">, now: Date = new Date()): string | null {
  const y = b.startedOn?.match(/^(\d{4})/)?.[1];
  if (y) return `Since ${y}`;
  const m = b.latestConfirmedOn?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  return `confirmed ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${year !== now.getFullYear() ? ` ${year}` : ""}`;
}

export const BAND_WORDS: Record<CareerBand, string> = { early: "Early", developing: "Developing", established: "Established", elite: "Elite", retired: "Retired" };

/** "College · Developing"; just the label when it already names the band ("Established pro", not "… · Established"). */
export const stageLine = (s: { label: string; band: CareerBand }) => {
  const band = BAND_WORDS[s.band];
  const words = s.label.toLowerCase().split(/[^a-z]+/);
  return words.includes(band.toLowerCase()) ? s.label : `${s.label} · ${band}`;
};

/** A plain sentence: capitalised, ending in a full stop; never quoted, never labelled as the athlete's. */
export function sentence(t: string): string {
  const x = t.trim();
  if (!x) return x;
  const cap = x[0].toUpperCase() + x.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

/** The Knows door's line: "24 facts · 3 couldn't confirm". */
export function knowsLine(total: number, unconfirmed: number): string {
  return [`${total} ${total === 1 ? "fact" : "facts"}`, unconfirmed > 0 ? `${unconfirmed} couldn't confirm` : null].filter(Boolean).join(" · ");
}
