/**
 * view.ts — PublicCardView, the ONE input of the public page renderer (/p/:handle).
 *
 * The page never reads a table. It renders this shape, which is everything the athlete PUBLISHED and nothing else.
 * In production it comes from the published snapshot (public_card_snapshots) through a thin adapter
 * (publicCard/snapshotAdapter.ts); the dev-only fixture route and tests build it from made-up data instead
 * (fixtures.ts). Either way the renderer does not change.
 *
 * Rules the shape encodes (design: public profile v2 "Mila at the centre", public card v3.2 §8, §9, §11):
 *   - Everything here was published and approved by her. Text is her words or text she approved, verbatim.
 *   - The four grid tiles are resolved at PUBLISH time (tiles.ts → resolveTileSlots). The page never works out a
 *     fallback live; it draws `tiles` in order.
 *   - Nothing athlete-specific lives in code: sport, school, league and brand words only ever arrive as data here.
 *   - Prices are already-quoted all-in totals (quoteBookingCharge at publish), in minor units.
 */

/** Chapter kinds are a small vocabulary that says what data a card reads. They carry no sport, school or league words. */
export type ChapterKind = "highlights" | "story" | "competition" | "venture" | "partnerships" | "impact" | "media" | "picks";

/** A published image or video. `src` is a same-origin URL (the media proxy /p/:handle/m/:key), never a raw bucket path. */
export interface PublicMedia {
  kind: "image" | "video";
  src: string;
  /** Video only: a still shown before play and under reduced motion. */
  poster?: string;
  /** Plain description for screen readers. Empty string = decorative. */
  alt: string;
}

/** One item on a chapter card. Each kind draws the same way for every athlete. */
export type PublicChapterItem =
  /** A measured number she chose to show, with its date ("as of"). */
  | { type: "stat"; label: string; value: string; asOf?: string }
  /** A Story beat she approved (origin, rise, defining moment, now…). */
  | { type: "beat"; label: string; text: string }
  /** A signed partner she switched on for display. Never terms or amounts. */
  | { type: "partner"; name: string; since?: string; logo?: PublicMedia }
  /** A confirmed fact: an honour, a selection, a cause, a venture. */
  | { type: "fact"; text: string; detail?: string }
  /** A photo or video she picked. */
  | { type: "media"; media: PublicMedia; caption?: string }
  /** A press link she approved (link card only). */
  | { type: "link"; title: string; outlet: string; url: string };

export interface PublicChapter {
  /** Stable id within the snapshot; the DOM anchor is `ch-<id>`. */
  id: string;
  kind: ChapterKind;
  /** Her title for the chapter (she can rename any chapter). Shown as "Title · 2 of 6". */
  title: string;
  /** Large uppercase line on the card. */
  headline: string;
  /** Small label above the headline (e.g. "Signed partnerships"). */
  eyebrow?: string;
  /** One short approved paragraph, third person. */
  body?: string;
  /** Her own words, verbatim, never edited. */
  quote?: string;
  items: PublicChapterItem[];
  /** The card's full-bleed background. Absent = the neutral gradient. */
  media?: PublicMedia | null;
  /** Provenance line, e.g. "Published 2 Oct 2026". */
  source?: string;
}

/** What a grid tile does when tapped. partner/book/shop open a Mila chat with that intent; create opens the one-line
 *  sheet; story jumps to a chapter card; follow lists her linked social profiles. "ask" is never a tile (it is the centre
 *  avatar) except as the last-resort fallback described in tiles.ts. */
export type TileIntent = "partner" | "book" | "shop" | "create" | "story" | "follow" | "ask";

/** Grid position: top-left, top-right, bottom-left, bottom-right. Reading order Partner → Book → Shop → Create. */
export type TileSlot = "tl" | "tr" | "bl" | "br";

export interface PublicTile {
  slot: TileSlot;
  intent: TileIntent;
  /** One word, shown uppercase next to the icon. */
  label: string;
  /** One short plain line under the label (may wrap to two lines). */
  subLabel: string;
  /** Optional factual hint from published data ("Next: Thu 4:30p"). Off by default; when set it replaces the sub-label. */
  hint?: string | null;
  /** story/follow fallbacks: the chapter the tile opens. */
  targetChapterId?: string;
  /** The dock's "Soon" badge (Create). */
  soon?: boolean;
}

/** A Book offer, as published. Price is the quoted all-in total the visitor pays. */
export interface PublicOffer {
  id: string;
  title: string;
  durationMin: number;
  format: "virtual" | "in_person";
  allInMinor: number;
  currency: string;
  /** Short plain note under the title ("Includes the Nomila service fee"). */
  note?: string;
}

/** A Shop pick (her own link, or one from a brand she works with). Every pick is a paid link. */
export interface PublicPick {
  id: string;
  title: string;
  merchant: string;
  /** Listed price in minor units, if the merchant page gave one. */
  priceMinor?: number | null;
  currency?: string;
  /** Her own words about it, ≤140 characters, typed by her, never generated. */
  herWords?: string;
  /** Opaque click code; the buy link is /go/:code (a plain 302 counted daily). */
  goCode: string;
  image?: PublicMedia | null;
  /** True for "From brands [First] works with" (catalog picks). */
  fromBrand?: boolean;
  /** True when the link is an Amazon link (adds the Associates statement). */
  amazon?: boolean;
}

/** A linked social profile, for the Follow fallback tile and the footer. */
export interface PublicSocialLink {
  /** Display name of the network ("Instagram"). Data, not code. */
  network: string;
  url: string;
  /** Her handle on it, without the @. */
  handle: string;
}

/** A fixed question chip for Ask Mila: a template for a chapter she published, never generated. */
export interface PublicAskChip {
  label: string;
  /** The chapter that answers it. */
  chapterId: string;
}

export interface PublicCardView {
  /** The public handle (URL segment). */
  handle: string;
  /** Snapshot version; the page's ETag. */
  version: number;
  /** ISO timestamp of the publish. */
  publishedAt: string;
  /** Her "Let search engines find my card" switch. Default false → noindex. */
  indexable: boolean;
  athlete: {
    firstName: string;
    lastName: string;
    /** Her one identity line (approved). */
    identityLine?: string;
    /** One line in her own words, verbatim. */
    quote?: string;
    /** Claimed account + at least one connected, measured social account. */
    verified: boolean;
    /** Under 18: no Book, no Shop, questions only. The publisher already removed those tiles; kept for the widget. */
    minor?: boolean;
  };
  /** The opening hero (on the Highlights card). */
  hero?: PublicMedia | null;
  /** Her published chapters, in her order. Highlights first. */
  chapters: PublicChapter[];
  /** Exactly four tiles, in slot order tl, tr, bl, br, resolved at publish. */
  tiles: [PublicTile, PublicTile, PublicTile, PublicTile];
  offers: PublicOffer[];
  picks: PublicPick[];
  socials: PublicSocialLink[];
  askChips: PublicAskChip[];
  /** Her Ask Mila switch in this published version (the centre door). Public Mila mode answers only while it is on. */
  askMila?: boolean;
}
