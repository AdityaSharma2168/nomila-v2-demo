/**
 * agent/moments/sources.ts — the moments scan's non-memory input, read from the database (scan.ts MomentsSources).
 * Every query is scoped to the athlete.
 *
 *   deals  the athlete's current and recent deals — accepted or in negotiation, signed, or with a term still running or
 *          ended in the last 90 days — newest first, with the brand's category when the brand is known, so a partner
 *          campaign date can be a moment. Never amounts: the scan has no use for money.
 *   preferences  her active preferences (memory listPreferences): the avoid-list and never-use names (moments 1.1.0).
 */
import { and, desc, eq, gte, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "../../db";
import { deals, inboxBrands } from "../../../shared/schema";
import { listPreferences } from "../memory";
import type { MomentDeal, MomentsSources } from "./scan";

const DAY = 86_400_000;
const LIVE_STATUSES = ["accepted", "negotiating"];

async function recentDeals(athleteId: string, today: string): Promise<MomentDeal[]> {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * DAY).toISOString().slice(0, 10);
  const rows = await db.select({
    id: deals.id, brand: deals.brand_name, category: inboxBrands.category, status: deals.status, termStart: deals.term_start,
    termEnd: deals.term_end, signedAt: deals.signed_at,
  }).from(deals).leftJoin(inboxBrands, eq(inboxBrands.id, deals.brand_id))
    .where(and(eq(deals.athlete_id, athleteId), or(inArray(deals.status, LIVE_STATUSES), isNotNull(deals.signed_at), gte(deals.term_end, since))))
    .orderBy(desc(deals.created_at)).limit(25);
  const day = (v: unknown) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
  return rows.map((r) => ({
    id: r.id, brand: r.brand, category: r.category ?? null, status: r.status ?? null, termStart: day(r.termStart), termEnd: day(r.termEnd), signed: r.signedAt != null,
  }));
}

// preferences: the plan's own source (plan/sources.ts), so moments read the same avoid-list and never-use names.
export const dbMomentsSources: MomentsSources = { deals: recentDeals, preferences: listPreferences };
