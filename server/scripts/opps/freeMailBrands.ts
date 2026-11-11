/**
 * freeMailBrands — the query behind reportFreeMailBrands.ts: brand rows whose stored domain is a
 * free-mail domain (FREE_MAIL, the same list brandDomainOf refuses). SELECT only; takes any drizzle
 * instance so the report can pass its read-only one.
 */

import { inArray, sql } from "drizzle-orm";
import { inboxBrands } from "../../../shared/schema";
import { FREE_MAIL } from "../../lib/senderProfile";

export interface FreeMailBrandRow {
  brand_id: number;
  name:     string;
  domain:   string;
  deals:    number;
  threads:  number;
  athletes: number;
}

export async function listFreeMailBrands(dbx: any): Promise<FreeMailBrandRow[]> {
  const rows = await dbx
    .select({
      brand_id: inboxBrands.id,
      name:     inboxBrands.name,
      domain:   inboxBrands.domain,
      deals:    sql<number>`(select count(*) from deals d where d.brand_id = inbox_brands.id)::int`,
      threads:  sql<number>`(select count(*) from inbox_threads t where t.brand_id = inbox_brands.id)::int`,
      athletes: sql<number>`(select count(distinct d.athlete_id) from deals d where d.brand_id = inbox_brands.id)::int`,
    })
    .from(inboxBrands)
    .where(inArray(sql`lower(${inboxBrands.domain})`, [...FREE_MAIL]))
    .orderBy(inboxBrands.id);
  return rows as FreeMailBrandRow[];
}
