/**
 * agent/postKit/disclosure.ts — whether a post owes `#ad`: a MATERIAL CONNECTION between the athlete and the brand the
 * post names, read from the athlete's own records — never from the post naming a brand (content engine plan, "The
 * guard": #ad when sponsored != null, a signed partner is named, or a partner's product is tagged).
 *
 *   MaterialConnection  one record: the brand, what kind of connection, and any discount codes it carries
 *   disclosureFor       the post's partner (deliverable.target, a brand) against those records → "required" (a match:
 *                       #ad leads the hashtags), "ask" (a brand named with no match: nothing is added, and the kit asks
 *                       the athlete once whether it is paid, gifted or affiliate), or "none" (no brand)
 *   sameBrand           names compared generically: case, accents, punctuation and spacing ignored; equal, or one is
 *                       the other plus words after it ("Partner" ~ "Partner Co") when the shorter has 4+ characters
 *   dbMaterialConnections  the records, on the real tables (loaded lazily: it imports the database):
 *     deals        accepted, or completed with its term still running, or signed by the athlete (signed_at), never
 *                  rejected — a paid deal ("deal"), product only ("gift"), commission with no cash ("affiliate")
 *     shop_items   a live shop link with a merchant ("affiliate"), with its discount code when it has one
 *   No record has a discount code on deals today (no such column), so a deal-linked kit allows any "code X" line, and an
 *   affiliate link with a code allows only that code (finalGuard.ts isCodeLine).
 *
 * Every read takes the athlete id first and reads only their rows. Nothing here is specific to any athlete or brand.
 */
import type { PlanTarget } from "../../../shared/plan";
import type { DisclosureNeed } from "./finalGuard";

export interface MaterialConnection {
  brand: string;
  kind: "deal" | "gift" | "affiliate";
  /** Discount codes the record carries, upper case ([] for none). */
  codes: string[];
  /** The record itself, when read from the tables: "deal:<id>" or "shop:<id>" (agent/ready/rights.ts keys a sponsored confirmation on it). */
  ref?: string;
  /** When the record was made (ISO): the newest matching record is the deal a confirmation is for. */
  since?: string | null;
}

const flat = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Two brand names for the same brand (see the header). */
export function sameBrand(a: string, b: string): boolean {
  const x = flat(a);
  const y = flat(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.replace(/ /g, "").length >= 4 && long.startsWith(`${short} `);
}

export interface Disclosure {
  need: DisclosureNeed;
  /** The matching records' discount codes (when `need` is "required"). */
  codes: string[];
}

/** What disclosure a post owes, from its partner and the athlete's records. */
export function disclosureFor(partner: PlanTarget | null | undefined, connections: readonly MaterialConnection[]): Disclosure {
  if (!partner || partner.subjectKind !== "brand" || !partner.name.trim()) return { need: "none", codes: [] };
  const matches = connections.filter((c) => sameBrand(c.brand, partner.name));
  if (!matches.length) return { need: "ask", codes: [] };
  return { need: "required", codes: [...new Set(matches.flatMap((c) => c.codes))] };
}

/**
 * What the words themselves owe: every brand the text names or @-tags, against the athlete's records.
 *   a record's brand NAMED (brandNamedIn) or @-tagged (the handle is the brand's name without spaces, or starts with it
 *   when the name has 4+ characters) → "required", with that record's codes
 *   an @-tag that matches no record, or a known brand (`knownBrands`) named with no record → "ask"
 *   neither → "none"
 * Generic: nothing here is any athlete's or brand's own.
 */
export function disclosureInText(text: string, connections: readonly MaterialConnection[], knownBrands: readonly string[]): Disclosure {
  const handles = [...text.matchAll(/(?<![\p{L}\p{N}_.])@([A-Za-z0-9_.]{2,30})/gu)].map((m) => flat(m[1]).replace(/ /g, ""));
  const squash = (s: string) => flat(s).replace(/ /g, "");
  const handleIs = (h: string, brand: string) => { const b = squash(brand); return h === b || (b.length >= 4 && h.startsWith(b)); };
  const hits = connections.filter((c) => brandNamedIn(text, c.brand) || handles.some((h) => handleIs(h, c.brand)));
  if (hits.length) return { need: "required", codes: [...new Set(hits.flatMap((c) => c.codes))] };
  const unknownTag = handles.some((h) => !connections.some((c) => handleIs(h, c.brand)));
  if (unknownTag || knownBrands.some((b) => brandNamedIn(text, b))) return { need: "ask", codes: [] };
  return { need: "none", codes: [] };
}

/**
 * Whether a text NAMES a brand — written as a name, not as the everyday word many brand names also are ("Celsius",
 * "Converse", "Vans", "Body Armor"). An occurrence (the brand's words in order, any punctuation or spacing between
 * them, whole words) counts when it is written:
 *   - exactly as the brand writes itself ("gorjana" for a brand recorded in lower case, "BodyArmor", "GORJANA"), or
 *   - with every word capitalised, mid-sentence ("my new Converse spikes", "two Vans of fans" does not: lower case);
 * and never when:
 *   - it opens a sentence and the brand is one ordinary capitalised word ("Converse with your team." is a verb) —
 *     unless its own casing is distinctive (more than one word, a capital inside it, or all capitals);
 *   - it follows "degrees" or "°" ("30 degrees Celsius").
 * Brands recorded with accents or punctuation are compared on letters and digits only.
 */
export function brandNamedIn(text: string, brand: string): boolean {
  const words = brand.normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length || words.join("").length < 3) return false;
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(esc).join("[^\\p{L}\\p{N}]{0,3}")}(?![\\p{L}\\p{N}])`, "giu");
  const t = text.normalize("NFC");
  const distinctive = words.length > 1 || /\p{Lu}/u.test(words[0].slice(1)) || words[0] === words[0].toLowerCase();
  for (const m of t.matchAll(re)) {
    const got = m[0].split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const exact = got.join(" ") === words.join(" ");
    const capitalised = got.every((w) => /^\p{Lu}/u.test(w));
    if (!exact && !capitalised) continue;
    const before = t.slice(0, m.index!);
    if (/(?:\bdegrees?|°)\s*$/iu.test(before)) continue;
    const opensSentence = /(?:^|[.!?…]\s+|\n\s*)["“'(]?$/u.test(before);
    if (opensSentence && !(exact && distinctive)) continue;
    return true;
  }
  return false;
}
/** The athlete's material connections, on the real tables (see the header). */
export async function dbMaterialConnections(athleteId: string): Promise<MaterialConnection[]> {
  const { and, eq, isNotNull, ne, or, sql } = await import("drizzle-orm");
  const { db } = await import("../../db");
  const { deals, inboxBrands, shopItems } = await import("../../../shared/schema");
  const today = new Date().toISOString().slice(0, 10);
  const [dealRows, shopRows] = await Promise.all([
    db.select({
      id: deals.id, createdAt: deals.created_at, brand: deals.brand_name, bName: inboxBrands.name, cash: deals.amount_cash, product: deals.amount_product, commission: deals.commission_pct,
    }).from(deals).leftJoin(inboxBrands, eq(inboxBrands.id, deals.brand_id))
      .where(and(eq(deals.athlete_id, athleteId), ne(deals.status, "rejected"), or(
        eq(deals.status, "accepted"),
        and(eq(deals.status, "completed"), sql`${deals.term_end} >= ${today}::date`),
        isNotNull(deals.signed_at),
      ))),
    db.select({ id: shopItems.id, createdAt: shopItems.created_at, merchant: shopItems.merchant, code: shopItems.discount_code })
      .from(shopItems).where(and(eq(shopItems.athlete_id, athleteId), eq(shopItems.status, "live"), isNotNull(shopItems.merchant))),
  ]);
  const pos = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0; };
  const isoOf = (v: unknown): string | null => { if (v == null) return null; const d = v instanceof Date ? v : new Date(String(v)); return Number.isFinite(d.getTime()) ? d.toISOString() : null; };
  return [
    ...dealRows.map((r): MaterialConnection => ({
      brand: r.bName ?? r.brand,
      kind: pos(r.cash) ? "deal" : pos(r.product) ? "gift" : pos(r.commission) ? "affiliate" : "deal",
      codes: [], ref: `deal:${r.id}`, since: isoOf(r.createdAt),
    })),
    ...shopRows.map((r): MaterialConnection => ({
      brand: r.merchant!, kind: "affiliate", codes: r.code?.trim() ? [r.code.trim().toUpperCase()] : [],
      ref: `shop:${r.id}`, since: isoOf(r.createdAt),
    })),
  ];
}
