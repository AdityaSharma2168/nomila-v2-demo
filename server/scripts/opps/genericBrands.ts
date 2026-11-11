/**
 * genericBrands — the query behind reportGenericBrands.ts: brand rows whose NAME reads as a
 * description rather than a name ("Home Improvement Brand"), per looksGenericBrandName. SELECT
 * only; takes any drizzle instance so the report can pass its read-only one.
 */

import { sql } from "drizzle-orm";
import { inboxBrands } from "../../../shared/schema";
import { looksGenericBrandName } from "../../lib/brandName";

export interface GenericBrandRow {
  brand_id:  number;
  name:      string;
  domain:    string | null;
  is_agency: boolean | null;
  deals:     number;
  threads:   number;
  athletes:  number;
}

export async function listGenericBrands(dbx: any): Promise<GenericBrandRow[]> {
  const rows = (await dbx
    .select({
      brand_id:  inboxBrands.id,
      name:      inboxBrands.name,
      domain:    inboxBrands.domain,
      is_agency: inboxBrands.is_agency,
      deals:     sql<number>`(select count(*) from deals d where d.brand_id = inbox_brands.id)::int`,
      threads:   sql<number>`(select count(*) from inbox_threads t where t.brand_id = inbox_brands.id)::int`,
      athletes:  sql<number>`(select count(distinct d.athlete_id) from deals d where d.brand_id = inbox_brands.id)::int`,
    })
    .from(inboxBrands)
    .orderBy(inboxBrands.id)) as GenericBrandRow[];
  return rows.filter((r) => looksGenericBrandName(r.name));
}
