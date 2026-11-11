/**
 * studio/agent/brands — when she names a sportswear brand, which of her photographs show ANOTHER one.
 *
 * Device check finding 3 (21 Sep 2026): a plan for an Adidas ad cast a photograph with a Nike logo on
 * it, and nothing said so. The Agent cannot remove a logo (see the ledger's logo-swap card); what it
 * can do is say, in plain fact, what the photograph shows — and prefer a clean photograph when one
 * fits as well.
 *
 * ─── ⚠️  SPORTSWEAR ONLY, ON PURPOSE ─────────────────────────────────────────────────────────────
 *
 * `brands_visible` is Gemini free text (lib/visionTag.ts), and on a real library most of it is not a
 * competitor of anything: her school, her league, her team's shirt sponsor, a drink on a bench. In the
 * device check's count, a school's name was on ~165 of 365 photos. "Any other brand" would flag most
 * of her library, and a flag on everything is a flag on nothing. So the comparison is between
 * SPORTSWEAR brands only — the marks on her kit and her shoes, which is where a paid ad and a
 * photograph actually collide. A drink in a drinks ad is not caught here; that needs a category the
 * tagger does not write (ledger).
 *
 * ─── MATCHING ───────────────────────────────────────────────────────────────────────────────────
 *
 * Name against name is services/mediaSearch.ts's own `brandNamesMatch` — the rule the media kit's
 * curator already runs in production (`curator.ts`) — never a second matcher. What it cannot do is
 * find a brand INSIDE a sentence: its substring rule would read ASICS out of "back to basics". So her
 * sentence is normalised with the same `normalizeBrandName` and searched for whole words.
 *
 * Imported by cast.ts, which the route loads dynamically — mediaSearch builds cloud clients at load.
 */
import {
  brandNamesMatch,
  normalizeBrandName,
} from "../../services/mediaSearch";

/** A sportswear brand, as she reads it, and the ways it is written. */
export interface Brand {
  name: string;
  spellings: string[];
}

/**
 * Apparel and footwear makers — the marks on what she wears. Ball makers are left out: a ball is not
 * what a kit deal is about, and "Wilson" in a sentence is as often a coach as a brand.
 */
export const SPORTSWEAR_BRANDS: readonly Brand[] = [
  { name: "Adidas", spellings: ["adidas"] },
  { name: "Air Jordan", spellings: ["air jordan", "jordan brand", "jumpman"] },
  { name: "ASICS", spellings: ["asics"] },
  { name: "Fila", spellings: ["fila"] },
  { name: "Hoka", spellings: ["hoka"] },
  { name: "Lululemon", spellings: ["lululemon"] },
  { name: "Mizuno", spellings: ["mizuno"] },
  { name: "New Balance", spellings: ["new balance"] },
  { name: "Nike", spellings: ["nike"] },
  { name: "Puma", spellings: ["puma"] },
  { name: "Reebok", spellings: ["reebok"] },
  { name: "Skechers", spellings: ["skechers"] },
  { name: "Umbro", spellings: ["umbro"] },
  { name: "Under Armour", spellings: ["under armour", "under armor"] },
];

/** The sportswear brands her sentence names, as whole words. */
export function brandsNamed(sentence: string): Brand[] {
  const words = ` ${normalizeBrandName(sentence)} `;
  return SPORTSWEAR_BRANDS.filter((b) =>
    b.spellings.some((s) => words.includes(` ${normalizeBrandName(s)} `)),
  );
}

/**
 * The brands a photograph must not show for this sentence — every OTHER sportswear brand. Empty when
 * she named none: an ad that names no brand has no brand for a photograph to contradict.
 */
export function brandsToAvoid(sentence: string): Brand[] {
  const named = brandsNamed(sentence);
  if (named.length === 0) return [];
  return SPORTSWEAR_BRANDS.filter((b) => !named.includes(b));
}

/**
 * ─── ALIAS FOLDING — OBSERVED CLUSTERS ONLY ────────────────────────────────────────────────────
 *
 * The tagger writes a team or a school several ways across a library (enrichment eval, 22 Sep
 * 2026: Stanford / Stanford University / Stanford Cardinal / Stanford Athletics at 183 / 39 / 8 /
 * 1; NJ/NY Gotham FC / Gotham FC at 30 / 8; Bolyn / Bolyn Sporting Goods / BOLYN sporting goods).
 * `normalizeBrandName` folds case and punctuation and nothing else, so each variant reached the
 * planner as a different brand. This table folds the OBSERVED clusters to one name each — a
 * literal list, never a rule ("X University → X" would fold names it has never seen). Georgetown
 * G / Hoyas are left alone: two different marks, not one written twice. `normalizeBrandName`
 * itself is shared code and is not touched.
 */
export const BRAND_ALIASES: readonly { name: string; variants: string[] }[] = [
  {
    name: "Stanford",
    variants: [
      "Stanford",
      "Stanford University",
      "Stanford Athletics",
      "Stanford Cardinal",
    ],
  },
  {
    name: "Bolyn",
    variants: ["Bolyn", "Bolyn Sporting Goods", "BOLYN sporting goods"],
  },
  { name: "Gotham FC", variants: ["Gotham FC", "NJ/NY Gotham FC"] },
];

const ALIAS_BY_NORMALIZED: ReadonlyMap<string, string> = new Map(
  BRAND_ALIASES.flatMap((a) =>
    a.variants.map((v) => [normalizeBrandName(v), a.name] as const),
  ),
);

/** One tagger string, folded to its cluster's name — or itself when it is in no cluster. */
export const foldBrand = (raw: string): string =>
  ALIAS_BY_NORMALIZED.get(normalizeBrandName(raw)) ?? raw;

/**
 * vision.brands_visible, read safely — the tagger's own strings, aliases folded (above), order
 * kept, duplicates dropped; or nothing.
 */
export function brandsOf(vision: Record<string, unknown> | null): string[] {
  const raw = vision?.brands_visible;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const b of raw) {
    if (typeof b !== "string") continue;
    const folded = foldBrand(b);
    if (!out.includes(folded)) out.push(folded);
  }
  return out;
}

/** Which of `avoid` a photograph's tags show — by `brandNamesMatch`, the production rule. */
export function brandsShown(
  visible: string[],
  avoid: readonly Brand[],
): Brand[] {
  return avoid.filter((b) =>
    visible.some((v) => b.spellings.some((s) => brandNamesMatch(v, s))),
  );
}

/**
 * The line she reads on a photograph that shows another brand — a fact, never a verdict. It does not
 * say "competitor": she may have a reason, and the tagger may be wrong.
 */
export function brandFlag(
  visible: string[],
  avoid: readonly Brand[],
): string | null {
  const shown = brandsShown(visible, avoid).map((b) => b.name);
  return shown.length ? `This photo shows ${shown.join(" and ")}.` : null;
}
