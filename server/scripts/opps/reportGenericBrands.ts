/**
 * reportGenericBrands.ts — READ-ONLY list of inbox_brands rows whose name is a description, not a
 * name ("Home Improvement Brand", "a leading skincare company"), with how many deals and threads
 * point at each.
 *
 *   npx tsx server/scripts/opps/reportGenericBrands.ts [--env <path/.env>]
 *
 * Why: an agency writing for "a home improvement brand" used to have that description resolved as
 * the advertiser, minting a brand row for it. New mail no longer does (the classifier's
 * advertiser_named=false routes it to the agency's opportunity). Rows already written are NOT
 * rewritten here — this only lists them for a deliberate repair. The heuristic
 * (looksGenericBrandName) is for review and can list a real brand; read before acting.
 *
 * The session is opened read-only (default_transaction_read_only=on) before the pool loads, and the
 * run aborts unless the database confirms it. inbox_brands is global, so the list spans athletes.
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { readOnlyPgOptions } from "./readOnly";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

async function main(): Promise<void> {
  loadEnv({ path: resolve(arg("--env") ?? ".env") });
  process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { db, pool } = await import("../../db");
  const { listGenericBrands } = await import("./genericBrands");
  const { sql } = await import("drizzle-orm");
  try {
    const ro = await db.execute(sql`SHOW default_transaction_read_only`);
    if (String((ro as any).rows?.[0]?.default_transaction_read_only ?? "") !== "on") {
      console.error("refusing to run: the DB session is not read-only");
      process.exit(1);
    }
    const rows = await listGenericBrands(db);
    if (!rows.length) { console.log("No brand row has a generic-looking name."); return; }
    console.log(`${rows.length} brand row(s) have a generic-looking name:`);
    for (const r of rows) {
      console.log(`  #${r.brand_id} "${r.name}" domain=${r.domain ?? "-"}${r.is_agency ? " (agency)" : ""} — ${r.deals} deal(s), ${r.threads} thread(s), ${r.athletes} athlete(s)`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
