/**
 * identityBackfill.ts — re-check stored brand research against the brand's own domain (BRAND_IDENTITY_GATE).
 *
 *   PLAN (default, read-only DB + grounded searches):
 *     npx tsx server/scripts/brands/identityBackfill.ts [--env <path/.env>] [--out <dir>] [--yes]
 *   APPLY (writes exactly a reviewed plan; no searches):
 *     npx tsx server/scripts/brands/identityBackfill.ts --apply <out>/plan.json [--env <path/.env>]
 *
 * PLAN opens the DB read-only (PGOPTIONS default_transaction_read_only, verified) and, per in-scope brand
 * with a domain, runs the same four grounded searches live research runs (Gemini Flash + Google Search —
 * about 40 grounded queries per brand). Without --yes it prints the brand count and stops. Output:
 * plan.json + plan.md in --out (default reports/brand-identity).
 *
 * APPLY never re-decides: rows that changed since the plan are skipped and listed. Run by a person only:
 * tests never import this file.
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readOnlyPgOptions } from "../opps/readOnly";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(k);

async function main(): Promise<void> {
  loadEnv({ path: resolve(arg("--env") ?? ".env") });
  const applyPath = arg("--apply");

  if (applyPath) {
    const plan = JSON.parse(readFileSync(resolve(applyPath), "utf8"));
    const { db, pool } = await import("../../db");
    const { applyPlan } = await import("./identityBackfillCore");
    const { storeUnconfirmed } = await import("../../skills/researchBrand");
    try {
      const r = await applyPlan(db, plan, storeUnconfirmed);
      console.log(`applied ${r.applied} of ${plan.length}; skipped ${r.skipped.length}`);
      for (const s of r.skipped) console.log(`  skipped ${s.brand} (#${s.brand_id}): ${s.why}`);
    } finally {
      await pool.end();
    }
    return;
  }

  // Read-only BEFORE anything loads server/db.
  process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);
  const outDir = resolve(arg("--out") ?? "reports/brand-identity");
  const { db, pool } = await import("../../db");
  const { sql } = await import("drizzle-orm");
  try {
    const ro = await db.execute(sql`SHOW default_transaction_read_only`);
    const value = String((ro as any).rows?.[0]?.default_transaction_read_only ?? "");
    if (value !== "on") {
      console.error(`refusing to run: the DB session is not read-only (default_transaction_read_only=${value || "?"})`);
      process.exit(1);
    }
    const { brandsInScope, planIdentity, renderPlan } = await import("./identityBackfillCore");
    const rows = await brandsInScope(db);
    const withDomain = rows.filter((r: any) => !!r.domain).length;
    console.log(`${rows.length} brands behind open opportunities; ${withDomain} have a domain to check (4 grounded searches each).`);
    if (!has("--yes")) {
      console.log("nothing searched. Re-run with --yes to build the plan.");
      return;
    }
    const { searchBrand } = await import("../../skills/researchBrand");
    const plan = await planIdentity(rows, searchBrand);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "plan.json"), JSON.stringify(plan, null, 1));
    const md = renderPlan(plan);
    writeFileSync(join(outDir, "plan.md"), md + "\n");
    console.log(md);
    console.log(`\nwritten: ${join(outDir, "plan.json")}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
