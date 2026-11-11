/**
 * reportFreeMailBrands.ts — READ-ONLY list of inbox_brands rows whose stored domain is a free-mail
 * (shared mailbox) domain, with how many deals and threads point at each, per athlete.
 *
 *   npx tsx server/scripts/opps/reportFreeMailBrands.ts [--env <path/.env>]
 *
 * Why: until Opportunities PR 2 the resolver stored a free-mail sender's domain as a brand's
 * identity, so every later pitch from that mailbox matched the row by exact domain. New mail no
 * longer does that (brandDomainOf returns null for FREE_MAIL). The rows already written are NOT
 * rewritten here — this only lists them for a deliberate repair.
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
  const { listFreeMailBrands } = await import("./freeMailBrands");
  const { sql } = await import("drizzle-orm");
  try {
    const ro = await db.execute(sql`SHOW default_transaction_read_only`);
    if (String((ro as any).rows?.[0]?.default_transaction_read_only ?? "") !== "on") {
      console.error("refusing to run: the DB session is not read-only");
      process.exit(1);
    }
    const rows = await listFreeMailBrands(db);
    if (!rows.length) { console.log("No brand row stores a free-mail domain."); return; }
    console.log(`${rows.length} brand row(s) store a free-mail domain:`);
    for (const r of rows) {
      console.log(`  #${r.brand_id} "${r.name}" domain=${r.domain} — ${r.deals} deal(s), ${r.threads} thread(s), ${r.athletes} athlete(s)`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
