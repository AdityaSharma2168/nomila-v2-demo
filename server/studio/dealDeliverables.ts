/**
 * studio/dealDeliverables — what this athlete still OWES her brands.
 *
 * One function, `listOutstandingDeliverables(athleteId, opts)`, backing the Now feed's OWED rows,
 * the calendar's DUE entries and the brand-post brief picker. A pure read: SELECTs only, no model
 * call, no write.
 *
 * ─── ⚠️ THIS RETURNS OUTSTANDING WORK, NOT ALL WORK ─────────────────────────────────────────────
 *
 * READ THIS BEFORE REUSING IT. The query filters, and the name says so on purpose:
 *
 *   deal_deliverables.status = 'open'      fulfilled / waived / cancelled work is not owed
 *   deal_deliverables.superseded_at IS NULL  an amended row is history, not an obligation
 *   deals.status <> 'rejected'             a deal she turned down never created obligations
 *
 * That is right for every surface reading it today — all three ask "what is still owed" — and it
 * is WRONG for a deal-history or contract-detail view, which needs the fulfilled rows, the waived
 * ones and the superseded ones to show what a deal actually contained and how it changed. Do not
 * reach for this function there and assume it returns everything; it never has. That view needs its
 * own unfiltered read, and adding a `includeClosed` flag here would quietly turn one honest query
 * into two behaviours behind one name.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────
 *
 * `athleteId` is trusted as given and MUST come from `req.athleteId`. Deliverables have no
 * athlete_id of their own — they hang off a deal, and the deal is what belongs to somebody. So the
 * predicate lives on the JOIN's WHERE (`deals.athlete_id`), which means there is no moment where an
 * unscoped set of deliverables exists to be filtered afterwards. No deliverable id, deal id or
 * athlete id is ever accepted from a client.
 *
 * `opts.brandId` narrows to one brand's deals. It can only ever REDUCE her own set — it is applied
 * alongside the athlete predicate, never instead of it — which is why it needs no ownership check
 * of its own (inbox_brands is a global catalog; see resolveBrand() in routes/studio.ts).
 */
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { dealDeliverables, deals, inboxBrands, mediaAssets } from "../../shared/schema";
import { createLogger } from "../logger";

const logger = createLogger("studio/dealDeliverables");

/**
 * One outstanding commitment, in the shape the client's `Deliverable` renders.
 *
 * `dueOn` is a DATE and stays a STRING — "2026-10-12", exactly as Postgres hands it over. Drizzle's
 * `date()` with no mode is PgDateString, so nothing here has to convert it, and nothing here may:
 * `new Date("2026-10-12")` is UTC midnight, which is the previous day for every athlete west of
 * Greenwich, and rendering it would put "1 day late" on work due today. The client parses it as a
 * local calendar day (localDay() in screens/studio/nowLogic.ts). Same reasoning as deals.term_end.
 */
export interface OutstandingDeliverable {
  id: string;
  dealId: string;
  brandId: number | null;
  brandName: string;
  campaign: string;
  format: string;
  dueOn: string | null;
  optional: boolean;
  delivered: number;
  total: number;
}

/**
 * How many pieces count against an obligation.
 *
 * DERIVED, never stored. A `delivered_count` column would be `deals.amount` again — the
 * denormalized copy that went stale badly enough that dealVoice now opens with "NEVER speak
 * deals.amount". The count is the join, every time.
 *
 * ⚠️ IT IS 0 FOR EVERY ROW TODAY, AND THAT IS CORRECT. Nothing writes
 * `media_assets.deal_deliverable_id` — not recordGeneratedAsset, not any publish path, and the
 * Studio client has never held a deal id (see the column's own comment in shared/schema.ts). So
 * nothing has been attributed to an obligation yet and "0 of 3 delivered" is an accurate sentence
 * rather than a placeholder. When the attribution PR lands, this line starts returning real numbers
 * with no change here.
 *
 * APPROVED IS A PROXY UNTIL POSTING EXISTS. "Delivered" really means it went out to the brand, and
 * nothing publishes Studio output yet — posted is the real definition, and this should move to it
 * the moment there is a posting record to read. Approval is the closest honest stand-in we have:
 * it is the athlete clearing a piece for publication, which is the last gate she controls.
 */
const deliveredCount = sql<number>`(
  SELECT count(*)::int FROM ${mediaAssets}
   WHERE ${mediaAssets.deal_deliverable_id} = ${dealDeliverables.id}
     AND ${mediaAssets.deleted_at} IS NULL
     AND ${mediaAssets.approval_status} = 'approved'
)`;

export async function listOutstandingDeliverables(
  athleteId: string,
  opts: { brandId?: number | null } = {},
): Promise<OutstandingDeliverable[]> {
  const rows = await db
    .select({
      id: dealDeliverables.id,
      deal_id: dealDeliverables.deal_id,
      campaign: dealDeliverables.campaign,
      format: dealDeliverables.format,
      due_on: dealDeliverables.due_on,
      optional: dealDeliverables.optional,
      quantity: dealDeliverables.quantity,
      brand_id: deals.brand_id,
      // The catalog's name when the deal resolved to a real brand, and the deal's own text when it
      // did not — `deals.brand_id` is nullable and legacy rows carry only `brand_name`.
      brand_name: inboxBrands.name,
      deal_brand_name: deals.brand_name,
      delivered: deliveredCount,
    })
    .from(dealDeliverables)
    // INNER, not left: a deliverable whose deal does not resolve under this athlete must not
    // appear at all. This join IS the tenancy boundary — see the header.
    .innerJoin(deals, eq(dealDeliverables.deal_id, deals.id))
    // No predicate: inbox_brands is a global catalog, not anybody's data.
    .leftJoin(inboxBrands, eq(deals.brand_id, inboxBrands.id))
    .where(
      and(
        eq(deals.athlete_id, athleteId), // ← the whole ballgame
        isNull(dealDeliverables.superseded_at),
        eq(dealDeliverables.status, "open"),
        ne(deals.status, "rejected"),
        ...(opts.brandId != null ? [eq(deals.brand_id, opts.brandId)] : []),
      ),
    )
    // Soonest first, undated last. `seq` breaks ties so the order is stable across reads rather
    // than left to the planner.
    .orderBy(sql`${dealDeliverables.due_on} ASC NULLS LAST`, asc(dealDeliverables.seq));

  logger.info(
    { athleteId, brandId: opts.brandId ?? null, deliverables: rows.length },
    "outstanding deliverables read",
  );

  return rows.map((r) => {
    // Never blank: `campaign` is the row TITLE on both surfaces that render it, so it falls back
    // through the brand to a plain word rather than leaving an empty line on the screen.
    const brandName = r.brand_name ?? r.deal_brand_name ?? "Brand";
    return {
      id: r.id,
      dealId: r.deal_id,
      brandId: r.brand_id,
      brandName,
      campaign: r.campaign ?? brandName,
      format: r.format,
      dueOn: r.due_on, // the DATE string, untouched. See OutstandingDeliverable.
      optional: r.optional,
      delivered: r.delivered ?? 0,
      total: r.quantity,
    };
  });
}
