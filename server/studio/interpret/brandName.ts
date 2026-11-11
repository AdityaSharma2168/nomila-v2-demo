/**
 * studio/interpret/brandName — the brand she NAMED, as its `inbox_brands` row (the interpreter, I.4; plan
 * v1 §3, M7).
 *
 * "turn this into an adidas ad" from Create anything has no brand attached; M7 makes the brand she named
 * the ad's brand, so its DO NOTs and category apply exactly as an attached brand's would. One SELECT, and
 * nothing written:
 *
 *   exactly one row   its id — the route sets it as `BriefInput.brandId`, and `assembleBrief` builds the
 *                     brand half, competitor DO NOT and all
 *   none, or several  null — the ad proceeds on the name alone, no DO NOTs, and a degraded note says so
 *                     (v1 §3's default, approved)
 *
 * A case-insensitive EXACT match on the name, agencies excluded (`is_agency`, brandResolver §2: an agency
 * row is not an advertiser). Never a prefix or a fuzzy match: "nike" is not "Nike Tech".
 *
 * ─── TENANCY: THE SAME ARGUMENT AS `resolveBrand` ────────────────────────────────────────────────────
 *
 * `inbox_brands` has no athlete_id; shared/schema.ts documents it as a general brand-identity table, and
 * everything the brief reads from a row is brand-public research (routes/studio.ts, `resolveBrand`). An id
 * found here is the id `resolveBrand` would accept had she picked the brand herself from Brand post. If
 * that read ever returns anything athlete-scoped, this lookup needs the restriction too.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { inboxBrands } from "../../../shared/schema";

/** The row id of the one advertiser with exactly this name, case aside — or null. */
export async function brandIdForName(name: string): Promise<number | null> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const rows = await db
    .select({ id: inboxBrands.id })
    .from(inboxBrands)
    .where(
      and(
        eq(sql`lower(${inboxBrands.name})`, wanted),
        or(isNull(inboxBrands.is_agency), eq(inboxBrands.is_agency, false)),
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0].id : null;
}
