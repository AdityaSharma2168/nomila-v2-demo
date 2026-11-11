/**
 * snapshotDeals — the athlete's signed deals, as the score snapshot records them.
 *
 * WHY THIS EXISTS. Every snapshot wrote `deals: []`. researchAthlete hardcoded the empty
 * array and the other two writers copied the previous snapshot forward, so the value was
 * never anything but empty — the `deals` table was never queried. Commercial capital sums
 * `snapshot.deals`, so it has always been computed over nothing. Mia's signed $14,000
 * gorjana agreement contributed zero to her M.I.A. score.
 *
 * WHEN A DEAL COUNTS: at SIGNATURE, not at delivery. The summarizer maps deal_stage
 * 'signed' → deals.status 'accepted', and that is the moment the athlete has earned the
 * credit — the posts may run for a season afterwards. `completed` is the end of DELIVERY
 * and is set by hand; waiting for it would delay her score by months and, since nothing
 * currently sets it, forever.
 *
 * VALUE is deals.amount — the TOTAL guaranteed value, cash plus stated product. gorjana is
 * $14,000, not the $7,500 cash. Commission is excluded there by design, being contingent on
 * sales that have not happened.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { deals } from "../../shared/schema";

/** Statuses that mean the athlete has the deal: signed, or signed and delivered. */
export const EARNED_STATUSES = ["accepted", "completed"] as const;

/**
 * Sources where the ATHLETE is the one asserting the deal exists.
 *
 * `contract_upload` — she handed us the document and confirmed the fields.
 * `self_reported`   — she told us directly.
 *
 * Deliberately excludes `inbox_scan`: a deal reaches 'accepted' when the summarizer reads
 * a signature in a thread, which is a model's judgement and not her consent. Good enough
 * for her own score, not good enough to print a brand's name in a deck.
 */
export const ATHLETE_CONFIRMED_SOURCES = ["contract_upload", "self_reported"] as const;

export interface SnapshotDeal {
  id:         string;
  brand:      string | null;
  /** Total guaranteed value — cash + stated product. */
  amount:     number | null;
  status:     string;
  /** Money actually settled, as opposed to agreed. */
  paid:       boolean;
}

/**
 * Read the athlete's earned deals for a score snapshot.
 *
 * Never throws: a snapshot must still be written if this read fails, because a scoring run
 * that dies on a deals query is worse than one that records no deals — which is the state
 * we are already in.
 */
export async function snapshotDealsFor(athleteId: string): Promise<SnapshotDeal[]> {
  try {
    const rows = await db
      .select({
        id:             deals.id,
        brand:          deals.brand_name,
        amount:         deals.amount,
        status:         deals.status,
        payment_status: deals.payment_status,
      })
      .from(deals)
      .where(and(
        eq(deals.athlete_id, athleteId),
        inArray(deals.status, EARNED_STATUSES as unknown as string[]),
      ));

    return rows.map((r) => ({
      id:     r.id as string,
      brand:  r.brand ?? null,
      amount: r.amount == null ? null : Number(r.amount),
      status: r.status ?? "accepted",
      paid:   r.payment_status === "settled",
    }));
  } catch {
    return [];
  }
}

/**
 * The brands she has actually signed with — NAMES ONLY, never figures.
 *
 * WHY NAMES AND NOTHING ELSE. This feeds the media kit, and the media kit is sent TO BRANDS,
 * sometimes to a competitor of the one being named. Naming a partner is a credential; naming
 * what that partner pays is disclosing her terms to the party she will next negotiate with.
 * The two are not the same disclosure, and only the first belongs in a deck.
 *
 * WHY THIS EXISTS NOW. mediaKitService held `confirmedPartners: string[] = []` behind a TODO
 * reading "athlete-confirmed deals when that flow lands". That flow has landed — she can hand
 * us a contract and confirm it — so the array stops being a placeholder. Until now the empty
 * array pinned her commercial state to "undisclosed", which instructs the Narrator to say
 * brands are "already taking notice, without naming anyone": a hedge it could never stop
 * making, because it was waiting on a flag nothing could flip.
 *
 * EARNED_STATUSES, not "she uploaded something". An unsigned contract is `negotiating` and is
 * correctly absent — a deck must not claim a partnership she has not closed.
 */
export async function confirmedPartnersFor(athleteId: string): Promise<string[]> {
  try {
    const rows = await db
      .select({ brand: deals.brand_name, amount: deals.amount })
      .from(deals)
      .where(and(
        eq(deals.athlete_id, athleteId),
        inArray(deals.status, EARNED_STATUSES as unknown as string[]),
        // SHE told us, not a model. `status = 'accepted'` is written by threadSummarizer
        // from its own read of an email thread — no human is required for a deal to reach
        // it. That bar is right for her private score and wrong here, because this list
        // NAMES A BRAND in a deck that is sent to other brands, sometimes to that brand's
        // competitor. A misclassified thread would put a partnership she never had in
        // front of the wrong reader.
        inArray(deals.source, ATHLETE_CONFIRMED_SOURCES as unknown as string[]),
      ));

    // Biggest first, so a deck that shows only a few shows the ones that carry weight — but
    // the amount is used ONLY to order, and never leaves this function.
    const byBrand = new Map<string, number>();
    for (const r of rows) {
      const name = (r.brand ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const value = r.amount == null ? 0 : Number(r.amount);
      byBrand.set(key, Math.max(byBrand.get(key) ?? 0, Number.isFinite(value) ? value : 0));
    }
    const display = new Map<string, string>();
    for (const r of rows) {
      const name = (r.brand ?? "").trim();
      if (name) display.set(name.toLowerCase(), name);
    }
    return [...byBrand.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => display.get(key)!)
      .filter(Boolean);
  } catch {
    // A deck must still render if this read fails. Absent partners understates her; a failed
    // render helps nobody.
    return [];
  }
}
