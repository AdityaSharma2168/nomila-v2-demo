/**
 * dedupeBrands.ts — merge brand rows that are the same company (./dedupeBrandsCore). Brands are shared by every
 * athlete, so this runs over the whole brand table, never one athlete's view of it.
 *
 *   1. DRY-RUN (default — read-only DB session, writes nothing but a report):
 *        npx tsx server/scripts/brands/dedupeBrands.ts [--env <path/.env>] [--out <dir>]
 *   2. REVIEW the report in --out (default reports/brand-dedupe): every merge set and every same-name set kept apart.
 *   3. APPLY: the same command plus --apply --yes. Each merge set is its own transaction.
 *
 * No model calls. Run by a person only: tests import the core, never this file.
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { readOnlyPgOptions } from "../opps/readOnly";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(k);

async function main(): Promise<void> {
  const apply = has("--apply");
  const outDir = resolve(arg("--out") ?? "reports/brand-dedupe");
  loadEnv({ path: resolve(arg("--env") ?? ".env") });
  // Dry-run: read-only BEFORE anything loads server/db (node-postgres reads PGOPTIONS on every new connection).
  if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { db, pool } = await import("../../db.js");
  const core = await import("./dedupeBrandsCore.js");
  try {
    if (!apply) {
      const ro = await db.execute(sql`SHOW default_transaction_read_only`);
      const value = String((ro as any).rows?.[0]?.default_transaction_read_only ?? "");
      if (value !== "on") { console.error(`refusing to run: the DB session is not read-only (${value || "?"})`); process.exit(1); }
    }
    const rows = ((await db.execute(sql`SELECT id, name, domain, is_agency, created_at FROM inbox_brands ORDER BY id`)) as any).rows;
    const { merges, skipped } = core.planMerges(rows);
    const report = core.renderPlan(merges, skipped);
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = join(outDir, `brand-dedupe-${apply ? "apply" : "dry-run"}-${stamp}`);
    writeFileSync(`${base}.md`, report);
    console.log(report);
    if (!apply) { console.log(`\ndry-run: nothing written. Report: ${base}.md`); return; }
    if (!has("--yes")) { console.log("\nstopping: re-run with --apply --yes to merge."); return; }
    const results = [];
    for (const plan of merges) {
      const r = await core.applyMerge(db, plan);
      results.push(r);
      console.log(`merged ${plan.key}: #${r.canonical} ← ${r.merged.map((i) => `#${i}`).join(", ")} ${JSON.stringify(r.counts)} folded opportunities: ${r.foldedOpportunities}`);
    }
    writeFileSync(`${base}.json`, JSON.stringify(results, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
