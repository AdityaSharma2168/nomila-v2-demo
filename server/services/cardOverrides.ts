/**
 * cardOverrides — the athlete's EDITS to a Nomi Card, applied as a thin layer at serve time
 * (docs/media-kit-specs.md Spec 8, "the editor"). The base kit (Strategist/Curator/Narrator DAG)
 * stays fully regenerable; edits live in a small overrides object keyed per athlete × brand and are
 * re-applied after cache-load, before render. Principle: the athlete edits a VIEW, not the source.
 *
 *  - order    — her card sequence (cover stays pinned first)
 *  - removed  — cards hidden from the deck (data still assembled → restore is instant)
 *  - added    — library cards pulled into the deck
 *  - copy     — chosen alternate / her own words for a crafted-copy slot (`${cardId}.${field}`)
 *  - images   — a swapped photo for a card (from curated candidates only)
 *
 * What she can NEVER override: the facts layer (stats, meters, rates math, provenance). Verified
 * means verified — that's the moat.
 */
import { db } from "../db";
import { cardOverrides } from "../../shared/schema";
import { and, eq } from "drizzle-orm";
import type { MediaKitData } from "./mediaKitService";

export interface CardOverrides {
  order?: string[];                                            // card ids, athlete's sequence
  removed?: string[];                                          // hidden card ids
  added?: string[];                                            // library card ids pulled into the deck
  copy?: Record<string, { text: string; pick?: number }>;     // key = `${cardId}.${field}`; text = resolved words
  // cardId → media swap. A bare gcsPath for photo cards (image/bg); {path,poster} for the video card.
  images?: Record<string, string | { path: string; poster?: string }>;
  theme?: string;                                             // the athlete's chosen look (shared/deckLooks: nomila|luxe|broadcast)
}

// The crafted-copy fields the athlete may edit per card type (never the facts layer). Each maps to a
// Narrator slot whose alternates the editor offers; `eyebrow`/`tagline`/`extra` are the raw slots.
const EDITABLE: Record<string, Array<{ field: string; slot: "eyebrow" | "tagline" | "extra" }>> = {
  cover:        [{ field: "eyebrow", slot: "eyebrow" }, { field: "hook", slot: "tagline" }],
  index:        [{ field: "eyebrow", slot: "eyebrow" }, { field: "verdict", slot: "tagline" }],
  mix:          [{ field: "eyebrow", slot: "eyebrow" }, { field: "tagline", slot: "tagline" }, { field: "reframe", slot: "extra" }],
  audience:     [{ field: "eyebrow", slot: "eyebrow" }, { field: "sub", slot: "tagline" }],
  content:      [{ field: "eyebrow", slot: "eyebrow" }, { field: "note", slot: "tagline" }],
  video:        [{ field: "eyebrow", slot: "eyebrow" }, { field: "note", slot: "tagline" }],
  rates:        [{ field: "eyebrow", slot: "eyebrow" }, { field: "tagline", slot: "tagline" }],
  payments:     [{ field: "eyebrow", slot: "eyebrow" }, { field: "lead", slot: "tagline" }],
  whyFits:      [{ field: "eyebrow", slot: "eyebrow" }, { field: "lead", slot: "tagline" }],
  story:        [{ field: "eyebrow", slot: "eyebrow" }, { field: "close", slot: "tagline" }],
  values:       [{ field: "eyebrow", slot: "eyebrow" }, { field: "statement", slot: "tagline" }],
  achievements: [{ field: "eyebrow", slot: "eyebrow" }],
  fit:          [{ field: "eyebrow", slot: "eyebrow" }, { field: "lead", slot: "tagline" }],
};

/** The editable crafted-copy fields for a card type (the editor asks this to build its copy-picker). */
export function editableFields(type: string): Array<{ field: string; slot: "eyebrow" | "tagline" | "extra" }> {
  return EDITABLE[type] ?? [{ field: "eyebrow", slot: "eyebrow" }];
}

export async function getOverrides(athleteId: string, brandId = 0): Promise<CardOverrides | null> {
  const [row] = await db.select({ data: cardOverrides.data })
    .from(cardOverrides).where(and(eq(cardOverrides.athlete_id, athleteId), eq(cardOverrides.brand_id, brandId))).limit(1);
  return (row?.data as CardOverrides) ?? null;
}

export async function saveOverrides(athleteId: string, brandId: number, data: CardOverrides): Promise<void> {
  await db.insert(cardOverrides)
    .values({ athlete_id: athleteId, brand_id: brandId, data: data as any, updated_at: new Date() })
    .onConflictDoUpdate({ target: [cardOverrides.athlete_id, cardOverrides.brand_id], set: { data: data as any, updated_at: new Date() } });
}

const isBlank = (s: unknown) => typeof s !== "string" || !s.trim();

/** Apply overrides over a base kit → the resolved kit to render. Facts are never touched. */
export function applyOverrides(kit: MediaKitData, ov: CardOverrides | null | undefined): MediaKitData {
  if (!ov) return kit;
  const cards = kit.cards.map((c) => ({ ...c })) as MediaKitData["cards"];

  // copy + image overrides on each card (only the whitelisted crafted-copy fields / the image slot)
  for (const c of cards) {
    for (const { field } of editableFields(c.type)) {
      const o = ov.copy?.[`${c.id}.${field}`];
      if (o && !isBlank(o.text)) (c as any)[field] = o.text;
    }
    const swap = ov.images?.[c.id];
    // Route the swap by card type. The video card gets {path,poster} → videoUrl/posterUrl; photo cards
    // get a bare gcsPath → image (cover/fit) or bg (everything else). signKit signs all four fields.
    if (swap) {
      if (c.type === "video") {
        if (typeof swap === "object") { (c as any).videoUrl = swap.path; if (swap.poster) (c as any).posterUrl = swap.poster; }
      } else {
        const path = typeof swap === "string" ? swap : swap.path;
        if ("image" in c) (c as any).image = path;
        else if ("bg" in c) (c as any).bg = path;
      }
    }
  }

  // deck composition: base deck → + added → − removed → reordered → cover pinned first, deduped
  const ids = new Set(cards.map((c) => c.id));
  let deck = (kit.deck?.length ? kit.deck : cards.map((c) => c.id)).slice();
  for (const id of ov.added ?? []) if (ids.has(id) && !deck.includes(id)) deck.push(id);
  if (ov.removed?.length) deck = deck.filter((id) => !ov.removed!.includes(id));
  if (ov.order?.length) {
    const ordered = ov.order.filter((id) => deck.includes(id));
    deck = [...ordered, ...deck.filter((id) => !ordered.includes(id))];
  }
  deck = ["cover", ...deck.filter((id) => id !== "cover")].filter((id, i, a) => a.indexOf(id) === i && ids.has(id));

  // the athlete's chosen look rides on tokens.theme — both the app (CardView) and the web
  // renderer (renderKitHtml / applyThemeImagery) read it, so shares pick it up automatically.
  const tokens = ov.theme ? { ...kit.tokens, theme: ov.theme } : kit.tokens;
  return { ...kit, cards, deck, tokens };
}
