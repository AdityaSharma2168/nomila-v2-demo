/**
 * Report drift between shared/schema.ts and the live database.
 *
 * WHY THIS EXISTS: Drizzle names EVERY column of a table in the SQL it generates —
 * an insert lists all columns (absent ones get the literal `default`), and a bare
 * `db.select()` lists all columns too. So one column that exists in schema.ts but not
 * in the database breaks reads AND writes for that WHOLE table, not just the feature
 * that added it.
 *
 * That is what took deal ingestion down for four days in July 2026: deals.payment_status
 * was declared in schema.ts with the escrow work and never applied to prod, so every
 * upsertDealForThread insert — and GET /deals/:id and the reply-draft endpoint, both
 * bare selects — died on `column "payment_status" of relation "deals" does not exist`.
 * Mail kept classifying and summarizing fine, so nothing looked broken.
 *
 * Reads information_schema only; writes nothing.
 *
 *   DATABASE_URL=... npx tsx server/scripts/checkSchemaDrift.ts
 *   STRICT=1 DATABASE_URL=... npx tsx server/scripts/checkSchemaDrift.ts   # exit 1 on any drift
 *
 * Exit codes: 0 = no code-only drift (or STRICT unset and only prod-only leftovers),
 *             1 = code-only drift found (breaks inserts + bare selects), or STRICT drift.
 */
import { getTableConfig } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { db } from "../db";
import * as schema from "../../shared/schema";

const STRICT = process.env.STRICT === "1" || process.env.STRICT === "true";

interface Drift {
  table:     string;
  missing:   string[]; // in schema.ts, NOT in the DB — breaks insert + bare select
  extra:     string[]; // in the DB, not in schema.ts — stale, harmless to Drizzle
  noTable:   boolean;
}

async function main() {
  const live = await db.execute<{ table_name: string; column_name: string }>(
    sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
  );
  const rows = (live as any).rows ?? live;

  const liveMap = new Map<string, Set<string>>();
  for (const r of rows as { table_name: string; column_name: string }[]) {
    if (!liveMap.has(r.table_name)) liveMap.set(r.table_name, new Set());
    liveMap.get(r.table_name)!.add(r.column_name);
  }

  const drifts: Drift[] = [];

  for (const value of Object.values(schema)) {
    let cfg;
    try {
      cfg = getTableConfig(value as any);
    } catch {
      continue; // not a pgTable (enum, type, relation, helper)
    }

    const liveCols = liveMap.get(cfg.name);
    if (!liveCols) {
      drifts.push({ table: cfg.name, missing: [], extra: [], noTable: true });
      continue;
    }

    const codeCols = cfg.columns.map((c) => c.name);
    const missing  = codeCols.filter((c) => !liveCols.has(c));
    const extra    = [...liveCols].filter((c) => !codeCols.includes(c));
    if (missing.length || extra.length) {
      drifts.push({ table: cfg.name, missing, extra, noTable: false });
    }
  }

  if (!drifts.length) {
    console.log("✅ No drift — every table and column in shared/schema.ts exists in the database.");
    return 0;
  }

  // Only `missing` (and a missing table) actually breaks the app. Stale prod-only
  // columns are invisible to Drizzle — report them, but don't fail on them.
  const breaking = drifts.filter((d) => d.noTable || d.missing.length);

  console.log("Schema drift (shared/schema.ts → database)\n");
  for (const d of drifts) {
    if (d.noTable) {
      console.log(`❌ ${d.table}\n     TABLE MISSING from the database — every query against it fails\n`);
      continue;
    }
    const mark = d.missing.length ? "❌" : "⚠️ ";
    console.log(`${mark} ${d.table}`);
    if (d.missing.length) {
      console.log(`     in schema.ts, MISSING from db: ${d.missing.join(", ")}`);
      console.log(`     → breaks EVERY insert and bare select on "${d.table}"`);
    }
    if (d.extra.length) {
      console.log(`     in db, not in schema.ts (stale, harmless): ${d.extra.join(", ")}`);
    }
    console.log();
  }

  if (breaking.length) {
    console.log(`❌ ${breaking.length} table(s) with breaking drift. Add the missing DDL to the deploy`);
    console.log(`   workflow's "Applying schema DDL" block and a migrations/ file before shipping.`);
    return 1;
  }
  console.log("⚠️  Stale prod-only columns only — nothing breaks. Clean up when convenient.");
  return STRICT ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("checkSchemaDrift failed:", err.message);
    process.exit(1);
  });
