/**
 * dealScoreGrid.ts — deterministic deal scoring.
 *
 * The 1–10 score is DERIVED here, not emitted by the LLM. Kimi supplies the
 * subjective components (sport/audience fit, brand tier, red flags) and the
 * structured offer (amount + unit + deliverable counts); this module does all
 * the arithmetic — positioning the offer in the athlete's own rate card and
 * composing the final number off an economics × fit grid. Pure + side-effect
 * free (no imports) so it is fully unit-testable without a DB or Kimi.
 */

export type Ord  = "poor" | "fair" | "good" | "great";
export type Tier = "emerging" | "mid" | "established" | "premium";
export type Range = { low: number; mid: number; high: number };

// Athlete rate card (athletes_current.deal_type_rates). Any subset may be present.
export type RateKey =
  | "socialPost" | "appearance" | "ambassador" | "autograph" | "licensing" | "projectedAnnualValue";

export type OfferUnit =
  | "per_post" | "per_deliverable" | "total" | "monthly" | "annual"
  | "per_appearance" | "commission_only" | "gifting_only" | null;

export interface OfferStruct {
  amount: number | null;                              // GUARANTEED cash only
  /**
   * The value a brand STATES for a product, gifting or service component.
   *
   * Null is NOT zero. Many gifting offers never name a figure ("free product"), and the
   * summarizer correctly leaves those null rather than inventing one — so an unvalued
   * gift stays unbenchmarkable, while a stated one counts.
   *
   * TREAT THIS AS A CEILING, NOT AN ASSESSMENT. It is the sender's own number, and what a
   * gift is worth to the athlete varies enormously with what it is. $6,500 of jewellery
   * credit at a brand she is partnering with is close to cash — she keeps it, and would
   * plausibly have wanted it. $2,000 of medical examinations in Korea is not: contingent
   * on travel she may never make, non-transferable, consumed rather than kept, and priced
   * by the clinic itself. A human discounts the second instantly; this field does not.
   *
   * No haircut is applied, because any fixed discount would be invented rather than
   * measured — too harsh on the first case, too generous on the second. The signal that
   * would calibrate it is the athlete's own labels on product-heavy offers, which do not
   * exist yet. Until they do, a large stated product value should be read as "worth a
   * closer look", never as settled compensation.
   */
  product_value?: number | null;
  unit: OfferUnit;
  deliverable_counts?: Record<string, number> | null;
  /**
   * The deal's own type — 'social_post' | 'appearance' | 'ambassador' | 'autograph' |
   * 'licensing' | 'other', matching deals.deal_type and the rate card's own keys.
   *
   * Without it every offer was benchmarked against the per-POST rate, whatever it was for.
   * An ambassador agreement asking for appearances and autographs was priced as though its
   * whole workload were Instagram posts, and the `ambassador` rate — computed, stored, and
   * shown to her in settings — was never once used to judge a deal.
   */
  deal_type?: string | null;
  /**
   * How long the engagement runs. Lets a lump sum be read per YEAR, which is the only
   * honest way to compare a season-long agreement to a one-off post.
   */
  term_months?: number | null;
  /**
   * Whether `deliverable_counts` are per contract YEAR or for the whole TERM.
   *
   * "10 appearances" means something different over one year and over five, and dividing
   * money by the wrong one is wrong by the length of the contract. Null means unknown, and
   * unknown must never be guessed — the per-unit path is skipped instead.
   */
  counts_basis?: "per_year" | "term" | null;
}

/**
 * A deal's own type maps directly onto a rate-card key. The rate card has always carried a
 * rate per type; nothing ever looked one up by type.
 */
const RATE_KEY_FOR_DEAL_TYPE: Record<string, RateKey> = {
  social_post: "socialPost",
  appearance:  "appearance",
  ambassador:  "ambassador",
  autograph:   "autograph",
  licensing:   "licensing",
};

/**
 * What the deal is GUARANTEED to be worth: cash plus stated product.
 *
 * Commission is deliberately excluded. It is real money and it matters at payment time,
 * but its value depends on sales that have not happened, so folding a percentage into a
 * score would be inventing a number. It rides along on the offer for later reconciliation.
 *
 * This is the figure the grid positions against the rate card. Scoring cash alone
 * understated the athlete's largest signed deal by 46% — $7,500 of a $14,000 agreement —
 * and would have placed it BELOW her per-post floor, recommending she reject it.
 */
export function totalGuaranteedValue(offer: OfferStruct): number {
  return (offer.amount ?? 0) + (offer.product_value ?? 0);
}



/** True when the offer carries a guaranteed cash figure (not gifting/commission-only). */
export function hasGuaranteedCash(offer: OfferStruct): boolean {
  return offer.amount != null && offer.unit !== "commission_only" && offer.unit !== "gifting_only";
}

/**
 * True when the offer EXPLICITLY carries no cash — product-only, commission-only, or a
 * stated $0. This is distinct from "no offer stated yet" (amount null + unit null), which
 * is pending (N/A), NOT a zero offer. For a known-rate athlete an explicit no-cash offer
 * is below their cash floor by definition.
 */
export function isExplicitNoCash(offer: OfferStruct): boolean {
  // A gift with a stated retail value is compensation we can measure, so it is priced
  // rather than "no cash". Only an unvalued gift or a pure commission deal is below the
  // floor by definition.
  if ((offer.product_value ?? 0) > 0) return false;
  return offer.unit === "gifting_only" || offer.unit === "commission_only" || offer.amount === 0;
}

/**
 * Map the offer's unit → which rate-card range to compare against, and the
 * per-unit amount to compare. Returns null when it can't be matched (no cash,
 * commission/gifting-only, unknown unit) — caller falls back to an N/A band.
 * PAV is ANNUAL, so only annual/monthly(annualized)/uncounted-total land there.
 */
/**
 * The offer expressed per YEAR, or null when it honestly cannot be.
 *
 * This is the comparison that makes deal types commensurable. Money-per-year against
 * money-per-year needs no view on what a "unit" is — which matters because an ambassador
 * agreement's units are posts AND appearances AND autographs, priced differently, and no
 * single per-unit rate can stand for the mixture.
 *
 * Null rather than a guess: an unpriced one-off has no annual value, and inventing one
 * would put a fictional number in front of the athlete.
 */
export function annualizedValue(offer: OfferStruct): number | null {
  const total = totalGuaranteedValue(offer);
  if (total <= 0) return null;
  if (offer.unit === "annual")  return total;
  if (offer.unit === "monthly") return total * 12;
  // A term of a year or more makes a lump sum an annual figure. Under a year it does not:
  // a three-month campaign for $9,000 is not a $36,000-a-year athlete.
  const months = offer.term_months ?? null;
  if (months != null && months >= 12) return total / (months / 12);
  return null;
}

export function matchRate(offer: OfferStruct): { perUnit: number; key: RateKey } | null {
  const total = totalGuaranteedValue(offer);
  // Benchmarkable when there is guaranteed VALUE, not merely guaranteed cash — a
  // $6,500 product package is worth positioning even with no cash attached.
  if (total <= 0) return null;
  if (!hasGuaranteedCash(offer) && (offer.product_value ?? 0) <= 0) return null;
  const amount = total;
  const n = offer.deliverable_counts
    ? Object.values(offer.deliverable_counts).reduce((a, b) => a + (b || 0), 0)
    : 0;

  // An engagement that runs for a season or more is priced per YEAR, against her projected
  // annual value — which is itself a blend of every deal type she does. That comparison is
  // type-agnostic by construction, so it is tried first and it is why an ambassador
  // contract no longer has to pretend its workload is a pile of posts.
  const annual = annualizedValue(offer);
  if (annual != null) return { perUnit: annual, key: "projectedAnnualValue" };

  // Otherwise price per unit — against the rate for THIS KIND of deal, not always the post
  // rate. Falls back to socialPost when the type is unknown, which is the previous
  // behaviour and correct for the content deals that make up most of the inbox.
  const unitKey: RateKey =
    (offer.deal_type ? RATE_KEY_FOR_DEAL_TYPE[offer.deal_type] : undefined) ?? "socialPost";

  // Counts covering a whole multi-year term cannot be divided into a single period's money.
  // Rather than produce a per-unit figure that is wrong by the length of the contract, skip
  // the divide and let the lump compare against the annual benchmark.
  const countsUsable = n > 0 && offer.counts_basis !== "term";
  // A gift with a stated value buys the same deliverables a lump cash sum would, so it
  // positions the same way.
  if (offer.unit === "gifting_only" && (offer.product_value ?? 0) > 0) {
    return countsUsable
      ? { perUnit: amount / n, key: unitKey }
      : { perUnit: amount, key: "projectedAnnualValue" };
  }
  switch (offer.unit) {
    case "per_post":
    case "per_deliverable":  return { perUnit: amount, key: unitKey };
    case "per_appearance":   return { perUnit: amount, key: "appearance" };
    case "total":            return countsUsable
                               ? { perUnit: amount / n, key: unitKey }               // total ÷ N deliverables
                               : { perUnit: amount, key: "projectedAnnualValue" };    // lump campaign value
    // monthly/annual are handled by annualizedValue above and never reach here.
    case "monthly":          return { perUnit: amount * 12, key: "projectedAnnualValue" };
    case "annual":           return { perUnit: amount, key: "projectedAnnualValue" };
    default:                 return null;
  }
}

// The 1–10 deal score (fit band · composeScore · verdict · reconciled recommendation · scoreDealGrid) was
// retired on 6 Oct 2026 and deleted. What remains is the offer economics the commercial assessment, the
// deal value store and Mila's offer money still read. Ord / Tier / RecAction stay as vocabulary types.
export type RecAction = "accept" | "negotiate" | "reject" | "delete";
