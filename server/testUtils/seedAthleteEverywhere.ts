/**
 * seedAthleteEverywhere.ts — give one athlete a row in EVERY athlete data manifest table (PGlite only).
 *
 * Rows are generated from the drizzle column definitions, parents before children (reverse manifest order), with
 * every foreign key — nullable ones too — pointed at this athlete's own parent row, so the deletion test exercises
 * the real FK graph. Values are unique per row (so a leak of one athlete's row into another's export is visible).
 *
 * CHECK constraints are dropped first (dropCheckConstraints): they pin enum-like vocabularies the generator cannot
 * know, and they play no part in what deletion and export must prove. Foreign keys, NOT NULL and unique indexes
 * stay enforced. Not a *.test.ts file, so jest doesn't collect it.
 */

import { randomUUID } from "node:crypto";
import { getTableColumns, sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../shared/schema";
import { ATHLETE_DATA_MANIFEST } from "../lib/athleteDataManifest";
import { db, client } from "./pgliteDb";

export async function dropCheckConstraints(): Promise<void> {
  const res = await client.query<{ t: string; c: string }>(
    `SELECT conrelid::regclass::text AS t, conname AS c FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`,
  );
  for (const { t, c } of res.rows) await client.exec(`ALTER TABLE ${t} DROP CONSTRAINT "${c}"`);
}

let seq = 0;
const uniq = () => `${++seq}-${randomUUID().slice(0, 8)}`;

function valueFor(col: any): unknown {
  if (col.enumValues?.length) return col.enumValues[0];
  switch (col.columnType) {
    case "PgUUID":       return randomUUID();
    case "PgNumeric":    return "1";
    case "PgDateString": return "2026-01-01";
    case "PgDate":       return new Date("2026-01-01");
    case "PgBigInt64":   return BigInt(1);
  }
  switch (col.dataType) {
    case "string":  return `v-${uniq()}`;
    case "number":  return 1;
    case "boolean": return false;
    case "date":    return new Date();
    case "json":    return {};
    case "array":   return [];
    case "bigint":  return BigInt(1);
    case "buffer":  return Buffer.from("x");
  }
  throw new Error(`seedAthleteEverywhere: no generator for ${col.name} (${col.columnType}/${col.dataType})`);
}

export interface SeededAthlete {
  athleteId: string;
  /** table → the row inserted for this athlete (DB column names). */
  rows: Map<string, Record<string, unknown>>;
}

/** Overrides per table, by DB column name. `$athlete` is replaced by the athlete id. */
const OVERRIDES: Record<string, Record<string, unknown>> = {
  intelligence_ledger:   { subject_type: "athlete", subject_id: "$athlete" },
  account_roles:         { account_id: "$athlete" },
  athlete_index_matches: { chosen_athlete_id: "$athlete", created_athlete_id: null },
  users:                 { provider: "firebase" },
  inbox_messages:        { body: "STORED-EMAIL-BODY", subject: "STORED-EMAIL-SUBJECT" },
};

async function insertRow(table: PgTable, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cols = getTableColumns(table) as Record<string, any>;
  const byJs: Record<string, unknown> = {};
  for (const [js, col] of Object.entries(cols)) if (col.name in values) byJs[js] = values[col.name];
  const [row] = await db.insert(table).values(byJs as any).returning();
  const out: Record<string, unknown> = {};
  for (const [js, col] of Object.entries(cols)) out[col.name] = (row as any)[js];
  return out;
}

let sharedBrandId: string | number | null = null;

/** One inbox_brands row shared by every seeded athlete (shared research, never hers). */
export async function sharedBrand(): Promise<string | number> {
  if (sharedBrandId) return sharedBrandId;
  const row = await insertRow(schema.inboxBrands, { name: `Shared Brand ${uniq()}`, normalized_name: `shared-${uniq()}` });
  sharedBrandId = row.id as string | number;
  return sharedBrandId;
}

let sharedShopId: string | null = null;

/** One shopify_shops row shared by every seeded athlete (a brand's store, never hers; Her picks §12). */
export async function sharedShopifyShop(): Promise<string> {
  if (sharedShopId) return sharedShopId;
  const row = await insertRow(schema.shopifyShops, { shop_domain: `shared-${uniq()}.myshopify.com`.toLowerCase() });
  sharedShopId = row.id as string;
  return sharedShopId;
}

let sharedAtmosphereId: string | null = null;

/** One atmosphere_library row shared by every seeded athlete (the shared photo library, never hers; 0120). */
export async function sharedAtmospherePhoto(): Promise<string> {
  if (sharedAtmosphereId) return sharedAtmosphereId;
  const id = uniq();
  const row = await insertRow(schema.atmosphereLibrary, {
    source: "unsplash", source_id: id, source_url: "https://example.org/shared-atmosphere-photo", licence: "Unsplash License",
    category: "general", purposes: ["texture"], gcs_path: `atmosphere/shared/general/${id}.webp`, content_type: "image/webp",
    width: 1, height: 1, bytes: 1, check_result: {},
  });
  sharedAtmosphereId = row.id as string;
  return sharedAtmosphereId;
}

export async function seedAthleteEverywhere(label = "Seeded"): Promise<SeededAthlete> {
  const brandId = await sharedBrand();
  const shopId = await sharedShopifyShop();
  const atmosphereId = await sharedAtmospherePhoto();
  const rows = new Map<string, Record<string, unknown>>();
  let athleteId = "";

  for (const entry of [...ATHLETE_DATA_MANIFEST].reverse()) {
    const cfg = getTableConfig(entry.table);
    // column → [parent table, parent column] for every FK
    const fkOf = new Map<string, { parent: string; parentCol: string }>();
    for (const fk of cfg.foreignKeys) {
      const r = fk.reference();
      r.columns.forEach((c, i) => fkOf.set(c.name, { parent: getTableConfig(r.foreignTable).name, parentCol: r.foreignColumns[i].name }));
    }
    const overrides = OVERRIDES[entry.name] ?? {};
    const values: Record<string, unknown> = {};
    for (const col of cfg.columns as any[]) {
      if (col.name in overrides) { values[col.name] = overrides[col.name] === "$athlete" ? athleteId : overrides[col.name]; continue; }
      if (/(^|_)athlete_id$/.test(col.name) && entry.name !== "athletes") { values[col.name] = athleteId; continue; }
      const fk = fkOf.get(col.name);
      if (fk) {
        if (fk.parent === entry.name) { if (col.notNull) throw new Error(`self FK ${entry.name}.${col.name} is NOT NULL`); continue; }
        if (fk.parent === "inbox_brands") { values[col.name] = brandId; continue; }
        if (fk.parent === "shopify_shops") { values[col.name] = shopId; continue; }
        if (fk.parent === "atmosphere_library") { values[col.name] = atmosphereId; continue; }
        if (fk.parent === "athletes" && fk.parentCol === "id") { values[col.name] = athleteId; continue; }
        const parentRow = rows.get(fk.parent);
        if (parentRow) { values[col.name] = parentRow[fk.parentCol]; continue; }
        if (col.notNull) throw new Error(`${entry.name}.${col.name} needs ${fk.parent}, not seeded yet`);
        continue;
      }
      if (entry.name === "athletes" && col.name === "full_name") { values[col.name] = `${label} ${uniq()}`; continue; }
      if (entry.name === "athletes" && col.name === "auth_id") { values[col.name] = `auth-${uniq()}`; continue; }
      if (col.notNull && !col.hasDefault) values[col.name] = valueFor(col);
    }
    const row = await insertRow(entry.table, values);
    rows.set(entry.name, row);
    if (entry.name === "athletes") athleteId = row.id as string;
  }
  return { athleteId, rows };
}

/** Rows of `table` in the whole test database. */
export async function countRows(table: string): Promise<number> {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`);
  return Number(((res as any).rows ?? res)[0].n);
}
