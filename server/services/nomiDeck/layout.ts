/**
 * nomiDeck/layout.ts — how a Nomi Card (the generic card / public page, or a pitch tailored to one brand) is laid out as
 * SCREENS, in the brand book's craft (21 Oct 2026: "the pitch and public page on the same engine as the brand book").
 *
 * Pure and platform-free. The same decisions as the brand book reader (shared/bookLayout.ts on the reader branch): one
 * idea per screen, warm ink for story pages, ivory paper for data, full-bleed treated photos for the hero moments, and a
 * card type's layout chosen by rules from the content's own shape — never by a model, never the same layout twice in a
 * row. The tokens below are the book's, value for value; once the reader branch lands, bookLayout imports them from here.
 *
 * Card lists (settled 20 Oct 2026):
 *   pitch  (one confirmed brand): cover · record · concept · proof · audience (+ overlap) · fit · calendar · close
 *   public (generic edition):     cover · signature idea · record · proof · audience · stands for · close
 * A card with no data is left out (never filler). Nothing here names an athlete, sport, school or brand.
 */
import type { MediaKitData } from "../mediaKitService";

type Kit = MediaKitData;
type AnyCard = Kit["cards"][number];

/** The book's tokens (warm ink, ivory paper, gold; one pink for actions only). */
export const DECK_TOKENS = {
  ink: "#15110D",
  inkRaised: "#1F1A14",
  paper: "#F3EDE3",
  paperRaised: "#FBF7F0",
  onInk: "#F4EEE2",
  onInkDim: "rgba(244,238,226,0.82)",
  onInkMut: "rgba(244,238,226,0.56)",
  onPaper: "#1B1712",
  onPaperDim: "rgba(27,23,18,0.78)",
  onPaperMut: "rgba(27,23,18,0.52)",
  gold: "#D3B07A",
  goldDeep: "#8E6C2F",
  rouge: "#B4473F",
  hairInk: "rgba(211,176,122,0.42)",
  hairPaper: "rgba(142,108,47,0.35)",
  pink: "#E84591",
} as const;

/** The two looks. Luxe = the book's own craft (Didone + gold). Campaign = the same system, louder: sans display, neutral grade, the brand's accent. */
export type DeckLook = "luxe" | "campaign";
export const DECK_LOOKS: readonly DeckLook[] = ["luxe", "campaign"];
export function deckLookOf(theme: string | null | undefined): DeckLook {
  return theme === "luxe" ? "luxe" : "campaign";
}

export type DeckEdition = "public" | "pitch";
export type DeckGround = "ink" | "paper" | "photo";
export type DeckKind = "cover" | "statement" | "record" | "data" | "gallery" | "fit" | "calendar" | "close";
export type DeckVariant = "A" | "B" | "C";

/** One screen of the deck. */
export interface DeckScreen {
  key: string;
  /** The card this screen draws (absent on the close, which is built from the edition). */
  cardId: string | null;
  cardType: string;
  kind: DeckKind;
  variant: DeckVariant;
  ground: DeckGround;
  /** The photo this screen leads with (a card image or background), or null. */
  image: string | null;
}

/** The settled order per edition. Each entry is a card type; the first one present is used. */
const ORDER: Record<DeckEdition, string[][]> = {
  pitch: [["cover"], ["achievements"], ["campaignConcept"], ["content"], ["audience"], ["whyFits", "fit"], ["activationPlan"]],
  public: [["cover"], ["signatureIdea"], ["achievements"], ["content"], ["audience"], ["values", "fit"]],
};

export function editionOf(kit: Kit): DeckEdition {
  return kit.cards.some((c) => c.type === "whyFits" || c.type === "campaignConcept") ? "pitch" : "public";
}

/** Does a card carry enough real data to be shown? Missing data → the card is left out. */
export function hasData(c: AnyCard): boolean {
  switch (c.type) {
    case "cover": return c.nameLines.length > 0;
    case "achievements": return !!c.heroEntry?.name || c.entries.length > 0;
    case "campaignConcept": return !!c.title && !!c.line;
    case "signatureIdea": return !!c.title && !!c.line;
    case "content": return c.tiles.some((t) => t.image) || !!c.heroStat?.value;
    case "audience": return !!c.headline || c.geo.length > 0 || (c.platforms?.length ?? 0) > 0 || (c.ages?.length ?? 0) > 0;
    case "whyFits": return c.reasons.length > 0;
    case "fit": return !!c.lead;
    case "values": return !!c.statement || c.planks.length > 0;
    case "activationPlan": return c.buckets.length > 0;
    default: return true;
  }
}

/** A card's lead photo. A concept leads with the BRAND's own imagery when its research has some (the brand's world). */
const imageOf = (c: AnyCard): string | null => {
  const any = c as any;
  if (c.type === "campaignConcept" && any.brandImage) return any.brandImage as string;
  return (any.image as string | null) ?? (any.bg as string | null) ?? null;
};

const KIND: Record<string, DeckKind> = {
  cover: "cover", signatureIdea: "statement", campaignConcept: "statement", achievements: "record",
  content: "gallery", audience: "data", whyFits: "fit", fit: "fit", values: "statement", activationPlan: "calendar",
};

/**
 * The layout a screen gets — rules over the content's shape, never the same variant on two screens of the same kind in a
 * row. A: photo-led. B: type over a toned photo. C: type-led on paper (no photo, or a long line).
 */
export function pickVariant(kind: DeckKind, opts: { image: boolean; lineLength: number }, prev: DeckVariant | null): DeckVariant {
  let v: DeckVariant;
  if (kind === "cover") v = opts.image ? (opts.lineLength <= 52 ? "A" : "B") : "C";
  else if (kind === "statement") v = !opts.image || opts.lineLength > 120 ? "C" : "B";
  else v = opts.image ? "A" : "C";
  if (prev && prev === v && kind !== "cover") {
    if (v === "A") v = opts.image ? "B" : "C";
    else if (v === "B") v = "C";
    else v = opts.image ? "A" : "C";
  }
  return v;
}

/** Which ground a screen sits on. Data and record pages are paper (numbers read best there); hero moments are photo; the rest warm ink. */
export function groundOf(kind: DeckKind, variant: DeckVariant): DeckGround {
  if (kind === "data") return "paper";
  if (kind === "record") return variant === "A" ? "ink" : "paper";
  if (kind === "cover" || kind === "fit") return variant === "C" ? "ink" : "photo";
  if (kind === "statement") return variant === "C" ? "paper" : "photo";
  return "ink";
}

const lineOf = (c: AnyCard): string => {
  const any = c as any;
  return String(any.line ?? any.hook ?? any.lead ?? any.statement ?? "");
};

/** The screens of a kit, in the settled order, data-less cards left out, plus the close. */
export function planDeck(kit: Kit, edition: DeckEdition = editionOf(kit)): DeckScreen[] {
  const out: DeckScreen[] = [];
  const lastVariant: Partial<Record<DeckKind, DeckVariant>> = {};
  let prevKind: DeckKind | null = null;
  const seen = new Set<string>();
  for (const types of ORDER[edition]) {
    const card = types.map((t) => kit.cards.find((c) => c.type === t)).find((c) => c && hasData(c));
    if (!card) continue;
    const kind = KIND[card.type] ?? "statement";
    // Never the same photo on two screens: a repeat becomes a type-led screen instead.
    const candidate = imageOf(card);
    const image = candidate && !seen.has(candidate) ? candidate : null;
    if (image) seen.add(image);
    const variant = pickVariant(kind, { image: !!image, lineLength: lineOf(card).length }, prevKind === kind ? lastVariant[kind] ?? null : null);
    lastVariant[kind] = variant;
    prevKind = kind;
    out.push({ key: card.id, cardId: card.id, cardType: card.type, kind, variant, ground: groundOf(kind, variant), image });
  }
  const coverImage = (kit.cards.find((c) => c.type === "cover") as any)?.image ?? null;
  const used = new Set(out.map((s) => s.image).filter(Boolean));
  const closeImage = (kit.imagePool ?? []).map((p) => p.gcsPath).find((p) => p && !used.has(p)) ?? null;
  out.push({ key: "close", cardId: null, cardType: "close", kind: "close", variant: closeImage ? "A" : "C", ground: closeImage ? "photo" : "ink", image: closeImage ?? (coverImage && !used.has(coverImage) ? coverImage : null) });
  return out;
}

// ── The public page's doors (front door v2.1, simplified 22 Oct 2026) ──────────────────────────────────────────────
// Up to three doors, never more: Partner (primary, the only coloured one) · Book (when bookings are on) · Shop (when
// there are picks). No fourth door (the cards ARE the story), no Create, no Mila avatar for now. Every door is the same
// tile: a label and a one-liner from data, never a price. Arrangement: 1 → one full-width tile; 2 → two equal tiles;
// 3 → Partner full width on top, Book and Shop side by side below (three in a row cannot hold a label + one-liner at
// 375pt without wrapping into four lines).

export type FrontDoorKey = "partner" | "book" | "shop";
export interface FrontDoor { key: FrontDoorKey; label: string; line: string; primary: boolean }
export type FrontDoorArrangement = "one" | "two" | "stack" | "none";

/** A Book offer as the page knows it (no price is ever read here). */
export interface FrontDoorOffer { durationMin: number; format?: "virtual" | "in_person" | string | null }

/** The Book one-liner from the athlete's real offers: the shortest session, its format; never a price. */
export function bookLine(first: string, offers: FrontDoorOffer[]): string {
  const live = offers.filter((o) => Number.isFinite(o.durationMin) && o.durationMin > 0);
  if (!live.length) return `Sessions with ${first}`;
  const shortest = live.reduce((a, b) => (b.durationMin < a.durationMin ? b : a));
  const noun = shortest.format === "virtual" ? "calls" : "sessions";
  return `From ${shortest.durationMin}-min ${noun}`;
}

/** The doors and how they sit, from the athlete's switches. Pure. */
export function frontDoors(input: { first: string; partnerOn: boolean; bookOn: boolean; shopOn: boolean; offers?: FrontDoorOffer[] }): { doors: FrontDoor[]; arrangement: FrontDoorArrangement } {
  const f = input.first;
  const doors: FrontDoor[] = [];
  if (input.partnerOn) doors.push({ key: "partner", label: `Partner with ${f}`, line: "Sponsorships, posts, appearances", primary: true });
  if (input.bookOn) doors.push({ key: "book", label: `Book ${f}`, line: bookLine(f, input.offers ?? []), primary: false });
  if (input.shopOn) doors.push({ key: "shop", label: `Shop ${f}'s picks`, line: `Gear ${f} actually uses`, primary: false });
  const arrangement: FrontDoorArrangement = doors.length === 0 ? "none" : doors.length === 1 ? "one" : doors.length === 2 ? "two" : "stack";
  return { doors, arrangement };
}

/** The status label a hero card carries ("Cover · 1 of 6"). */
export const CARD_TITLE: Record<string, string> = {
  cover: "Cover", signatureIdea: "The idea", campaignConcept: "The idea", achievements: "The record", content: "The proof",
  audience: "Audience", values: "Stands for", fit: "The fit", whyFits: "Why it fits", activationPlan: "All year", close: "Work together",
};

/**
 * How the cover sets its type (22 Oct 2026, legibility): the name block sits in the bottom ~45% of the cover. In a
 * full-length portrait (a small face, so the body fills that zone) the type would sit on the jersey, so the cover splits:
 * a face-aware band on top, the name on ink below. Otherwise the photo stays full-bleed and the type gets its own dark
 * panel. Either way the type sits on ≥ 88% ink (≥ 4.5:1 for the cream and gold type). Pure.
 */
export type CoverFit = "overlay" | "split";
export const FULL_LENGTH_FACE_H = 0.2;
export function coverFitFor(face: { x?: number; y?: number; w?: number; h: number } | null | undefined): CoverFit {
  return face && face.h > 0 && face.h < FULL_LENGTH_FACE_H ? "split" : "overlay";
}

/** Type fitting: the display size a line gets so it never overflows a phone screen (px at 390 wide). */
export function displaySize(text: string, opts: { max: number; min: number; perLine: number; lines: number }): number {
  const n = text.length;
  if (n <= opts.perLine * opts.lines) return opts.max;
  const scaled = Math.floor(opts.max * Math.sqrt((opts.perLine * opts.lines) / n));
  return Math.max(opts.min, Math.min(opts.max, scaled));
}
