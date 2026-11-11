/**
 * contractBrandScan — name the brand on a contract without asking a model.
 *
 * WHY THE DIRECTION MATTERS. The obvious approach is to let the extractor read the
 * contract, take the brand it reports, and match that back to a brand she already has.
 * That is inference, and it fails on the only two real contracts we have:
 *
 *   the contract says          normalizeBrand gives     her brand row is
 *   GORJANA & GRIFFIN, LLC  →  "gorjana griffin"        "gorjana"
 *   adidas America, Inc.    →  "adidas america"         "adidas"
 *
 * The residue is a co-founder's surname and a regional subsidiary. Neither is safe to
 * strip by rule — "America" is load-bearing in "Bank of America" — so resolveBrand misses
 * and, because it creates on a miss, mints a SECOND adidas. Her deals, logo and history
 * then split across two brand ids.
 *
 * Trigram similarity can bridge it (pg_trgm is installed, and word_similarity scores both
 * pairs at 1.0), but measured across her 175 brands a 0.5 threshold produced roughly seven
 * wrong pairs for every three right ones — `ccsu edu` against `sjsu edu`, `care` against
 * `lucy care`. Good enough to propose an answer, nowhere near good enough to act on one.
 *
 * So the question is asked the other way round: does this document MENTION a brand she
 * already has? That is an exact whole-word search over a known list, with no threshold and
 * no inference. On the real gorjana contract it returns one hit — gorjana, 17 mentions,
 * first at character 195 — in 6ms, against 913ms to pull the text and no model call at all.
 *
 * The model still reads the contract. It just does not run until she has confirmed where
 * the contract belongs, so a document she backs out of costs nothing.
 */

import { db } from "../db";
import { inboxBrands, deals } from "../../shared/schema";
import { and, eq, ne, inArray, desc } from "drizzle-orm";
import { extractPdfTextDetailed } from "../lib/pdfExtract";
import { createLogger } from "../logger";

const logger = createLogger("services/contract-brand-scan");

/**
 * Below this a brand name matches too much to be evidence. "co", "hm" and "us" are real
 * rows in her table and appear in the boilerplate of every contract ever drafted.
 */
const MIN_BRAND_NAME = 3;

/** How much of the document to search. The parties are named in the first page. */
const MAX_SCAN_CHARS = 200_000;

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

export interface BrandMention {
  brand_id:   number;
  name:       string;
  /** How many times the document names it. A passing reference is not a party. */
  mentions:   number;
  /** Character offset of the first mention — a contract names its parties up front. */
  first_at:   number;
}

export interface ContractScan {
  /** Whether the PDF yielded text at all. A scan of a photocopy will not. */
  readable:   boolean;
  chars:      number;
  /** Brands she already has that this document names, best first. */
  mentions:   BrandMention[];
  /** Deals on the best-matching brand, most recently detected first. */
  deals:      Array<{
    id: string; brand_name: string | null; brand_id: number | null;
    amount: string | null; status: string | null; deal_type: string | null;
    detected_at: Date | string | null;
  }>;
}

/**
 * Rank two mentions. Frequency first — a contract names its own party repeatedly — and
 * where they tie, whichever is named earliest.
 *
 * Deliberately NOT longest-name-wins. If both "gorjana" and a hypothetical "gorjana
 * griffin" were rows, the one the document actually leans on should win, and that is a
 * question about this document rather than about the names.
 */
function rank(a: BrandMention, b: BrandMention): number {
  return b.mentions - a.mentions || a.first_at - b.first_at;
}

/**
 * Brands named in `text`, out of the ones this athlete already has.
 *
 * Exported separately from the PDF handling so it can be tested against a string.
 */
export function mentionedBrands(
  text: string,
  brands: Array<{ id: number; name: string | null }>,
): BrandMention[] {
  const hay = text.toLowerCase();
  const out: BrandMention[] = [];

  for (const b of brands) {
    const name = (b.name ?? "").toLowerCase().trim();
    if (name.length < MIN_BRAND_NAME) continue;

    // Whole-word only. Without the boundaries "care" matches inside "healthcare" and
    // "on" matches inside almost everything — and both are real rows in her table.
    const re = new RegExp("\\b" + name.replace(RE_ESCAPE, "\\$&") + "\\b", "g");
    const found = hay.match(re);
    if (!found) continue;

    out.push({ brand_id: b.id, name: b.name ?? "", mentions: found.length, first_at: hay.search(re) });
  }

  return out.sort(rank);
}

/**
 * Read a contract's text and work out where it probably belongs — no model involved.
 *
 * Returns the brands it names and the deals on the strongest of them. Everything here is
 * a PROPOSAL for the screen that asks her; nothing is written and nothing is assumed.
 */
export async function scanContract(athleteId: string, pdf: Buffer): Promise<ContractScan> {
  let text = "";
  try {
    const r = await extractPdfTextDetailed(pdf, MAX_SCAN_CHARS);
    text = r.text;
  } catch (err: any) {
    // A scan with no text layer, or a photo. Not a failure — she picks the deal herself,
    // and the model reads the image later.
    logger.info({ athleteId, error: err.message?.slice(0, 120) }, "no text to scan; falling back to asking");
    return { readable: false, chars: 0, mentions: [], deals: [] };
  }

  if (text.trim().length < 200) {
    return { readable: false, chars: text.length, mentions: [], deals: [] };
  }

  // Only brands SHE has. A global brand table would make this a search engine; the
  // question is narrower than that — which of her own brands is this contract with.
  const herBrands = await db
    .selectDistinct({ id: inboxBrands.id, name: inboxBrands.name })
    .from(inboxBrands)
    .innerJoin(deals, eq(deals.brand_id, inboxBrands.id))
    .where(eq(deals.athlete_id, athleteId));

  const mentions = mentionedBrands(text, herBrands);

  // Deals on the best match, so the screen can offer one to confirm rather than a list to
  // search. Rejected deals are excluded: she is filing a contract, not browsing history.
  const best = mentions[0];
  const dealRows = best
    ? await db
        .select({
          id: deals.id, brand_name: deals.brand_name, brand_id: deals.brand_id,
          amount: deals.amount, status: deals.status, deal_type: deals.deal_type,
          detected_at: deals.detected_at,
        })
        .from(deals)
        .where(and(
          eq(deals.athlete_id, athleteId),
          eq(deals.brand_id, best.brand_id),
          ne(deals.status, "rejected"),
        ))
        .orderBy(desc(deals.detected_at))
        .limit(10)
    : [];

  logger.info(
    { athleteId, chars: text.length, brands: herBrands.length,
      matched: mentions[0]?.name ?? null, deals: dealRows.length },
    "scanned a contract for brands she already has",
  );

  return { readable: true, chars: text.length, mentions, deals: dealRows };
}
