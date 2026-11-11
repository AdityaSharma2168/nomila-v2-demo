import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { db } from "../db";
import { deals, inboxBrands } from "../../shared/schema";
import { eq, and, ilike, sql } from "drizzle-orm";
import { containsPattern } from "../lib/likePattern";
import { createLogger } from "../logger";

const logger = createLogger("routes/search");
const router = Router();

// GET /search?q=<query>
// Returns deals owned by this athlete whose brand_name matches the query,
// plus inbox_brands matched by name (via inbox_threads join).
// Requires q >= 2 characters.
router.get("/search", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const q = (req.query.q as string ?? "").trim();

  if (q.length < 2) {
    res.json({ deals: [], brands: [] });
    return;
  }

  try {
    const pattern = containsPattern(q);

    // Search deals owned by this athlete, matching brand_name.
    //
    // The domain comes from the JOIN, not from raw_data. `deals.brand_id` was added after this
    // route was written, and the note that used to sit here — "deals has no brand_id column" —
    // outlived the schema: raw_data.brand_domain is written by nothing, so it is null on every
    // deal in the database (271 of 271), and the search results rendered a generic icon instead
    // of the brand's logo. 263 of those deals carry a brand_id, so the domain is simply a join
    // away. (The other half of that note is still true: deals really has no `score` column.)
    //
    // LEFT join, and raw_data kept as the COALESCE fallback: the ~8 deals with no brand_id must
    // still appear in search — a missing logo is a blemish, a missing search result is a bug.
    const dealRows = await db
      .select({
        id:           deals.id,
        brand_name:   deals.brand_name,
        deal_type:    deals.deal_type,
        amount:       deals.amount,
        status:       deals.status,
        brand_domain: sql<string | null>`COALESCE(${inboxBrands.domain}, ${deals.raw_data}->>'brand_domain')`,
      })
      .from(deals)
      .leftJoin(inboxBrands, eq(deals.brand_id, inboxBrands.id))
      .where(and(
        eq(deals.athlete_id, athleteId),
        ilike(deals.brand_name, pattern),
      ))
      .limit(8);

    // Search inbox_brands by name, scoped to brands linked to this athlete's
    // inbox threads (inbox_threads.brand_id → inbox_brands.id).
    const brandRows = await db.execute(
      sql`
        SELECT DISTINCT ib.id, ib.name, ib.domain, ib.category
        FROM inbox_brands ib
        INNER JOIN inbox_threads it ON it.brand_id = ib.id
        WHERE it.athlete_id = ${athleteId}
          AND ib.name ILIKE ${pattern}
        LIMIT 8
      `
    );

    res.json({
      deals: dealRows,
      brands: brandRows.rows,
    });
  } catch (err: any) {
    logger.error({ athleteId, q, error: err.message }, "Search failed");
    res.status(500).json({ error: "Search failed" });
  }
});

export default router;
