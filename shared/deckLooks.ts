/**
 * deckLooks — the looks a public-facing document (a pitch deck, her Nomi Card) can wear, and the one rule that
 * recommends a look for a brand pitch (owner decision, 23 Oct 2026).
 *
 *   nomila     the app's one look (DESIGN.md): white ground, Outfit, one raspberry highlight. The DEFAULT.
 *   luxe       premium / lifestyle / fashion brands.
 *   broadcast  sports, beverage and energy brands.
 *
 * "campaign" and "immersive" are retired: a deck saved with either (or with anything unknown) renders in Nomila.
 *
 * The recommendation is a fixed rule table, not a model call, so it is explainable and testable: the brand's
 * CONFIRMED research category is matched against a few word stems, first row wins. Unconfirmed research or no
 * category means Nomila. It is only ever a preselection with a one-line reason; the athlete can switch.
 *
 * Pure: imported by the server (kitCache, kitRenderer, the card-theme route) and the app (the switchers).
 */

export const DECK_LOOKS = ["nomila", "luxe", "broadcast"] as const;
export type DeckLook = (typeof DECK_LOOKS)[number];

export const DEFAULT_DECK_LOOK: DeckLook = "nomila";

/** Looks a deck may have been saved with that are no longer offered. They render in the default look. */
export const RETIRED_DECK_LOOKS: readonly string[] = ["campaign", "immersive"];

export const DECK_LOOK_LABEL: Record<DeckLook, string> = {
  nomila: "Nomila",
  luxe: "Luxe",
  broadcast: "Broadcast",
};

export function isDeckLook(v: unknown): v is DeckLook {
  return typeof v === "string" && (DECK_LOOKS as readonly string[]).includes(v);
}

/** The look a stored theme renders in: one of the three, or Nomila for a retired, unknown or missing theme. */
export function resolveDeckLook(theme: string | null | undefined): DeckLook {
  return isDeckLook(theme) ? theme : DEFAULT_DECK_LOOK;
}

/**
 * The rule table. Each row lists word stems; a category word that STARTS WITH a stem matches ("sport" matches
 * "sports" and "sportswear", "jewel" matches "jewelry"). Rows are checked top to bottom and the first match wins,
 * so an explicitly premium category ("luxury sportswear", "sports fashion") reads as Luxe.
 */
export const LOOK_RULES: ReadonlyArray<{ look: Exclude<DeckLook, "nomila">; stems: readonly string[]; why: string }> = [
  {
    look: "luxe",
    stems: ["luxur", "jewel", "fashion", "couture", "beauty", "cosmetic", "skincare", "fragrance", "perfume", "makeup", "watch"],
    why: "premium look",
  },
  {
    look: "broadcast",
    stems: ["sport", "athlet", "athleis", "fitness", "gear", "equipment", "beverage", "drink", "hydration", "energy", "nutrition", "supplement", "protein"],
    why: "game-day energy",
  },
];

export interface LookAdvice {
  look: DeckLook;
  /** One plain line for under the switcher, e.g. "Luxe suits gorjana's premium look". */
  reason: string;
  /** "category" when a rule matched; "default" when Nomila was chosen for lack of one. */
  basis: "category" | "default";
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z]+/).filter(Boolean);

/** The look a rule row gives this category, or null when no row matches. */
export function lookForCategory(category: string | null | undefined): Exclude<DeckLook, "nomila"> | null {
  const ws = words(String(category ?? ""));
  if (!ws.length) return null;
  for (const row of LOOK_RULES) {
    if (ws.some((w) => row.stems.some((stem) => w.startsWith(stem)))) return row.look;
  }
  return null;
}

/**
 * The recommended look for a pitch to one brand. `category` must be the brand's research category ONLY when that
 * research is confirmed to be about the right company; pass `confirmed: false` otherwise and the answer is Nomila.
 */
export function recommendDeckLook(brand: { name: string; category?: string | null; confirmed: boolean }): LookAdvice {
  const name = brand.name.trim() || "this brand";
  const possessive = /s$/i.test(name) ? `${name}'` : `${name}'s`;
  const look = brand.confirmed ? lookForCategory(brand.category) : null;
  if (look) {
    const row = LOOK_RULES.find((r) => r.look === look)!;
    return { look, reason: `${DECK_LOOK_LABEL[look]} suits ${possessive} ${row.why}`, basis: "category" };
  }
  if (!brand.confirmed) return { look: "nomila", reason: `Nomila, your own look, until ${name} is confirmed`, basis: "default" };
  if (!String(brand.category ?? "").trim()) return { look: "nomila", reason: `Nomila, your own look: we don't know ${possessive} category yet`, basis: "default" };
  return { look: "nomila", reason: `Nomila, your own look, suits ${name}`, basis: "default" };
}
