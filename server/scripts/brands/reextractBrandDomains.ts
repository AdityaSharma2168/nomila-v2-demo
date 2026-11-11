/**
 * reextractBrandDomains.ts — catch existing opportunities up with the brand imagery pipeline, for ANY athlete.
 *
 *   1. DRY-RUN (default — read-only DB session, prints brand → domain found, writes nothing; a report per run):
 *        npx tsx server/scripts/brands/reextractBrandDomains.ts --all [--env <path/.env>] [--yes]
 *        (or --athlete <uuid> [--athlete <uuid> …] / --athletes a,b / --ids-file <path>; see ../athleteSelection)
 *   2. REVIEW the report in --out (default reports/brand-domains).
 *   3. APPLY (enqueues brand_identity_refresh for each brand that gains a domain or has identity work outstanding):
 *        the same selection plus --apply [--yes]
 *
 * Per brand behind an OPEN opportunity with no domain, the lead thread's latest inbound message is re-read LIVE
 * through the mailbox interface (MAILBOX_LIVE_READS must be on — stored bodies are never read) and the classify call
 * runs ONLY for advertiser_domain. COST: one classify call (Gemini Flash, up to 3 attempts on a transient failure)
 * per such brand, in BOTH modes. Without --yes it prints the estimate and stops. Run by a person only: tests import
 * the core (./reextractBrandDomainsCore), never this file.
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { readOnlyPgOptions } from "../opps/readOnly";
import { parseAthleteSelection, resolveAthletes, SELECTION_USAGE, type AthleteSelection } from "../athleteSelection";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(k);

async function main(): Promise<void> {
  let selection: AthleteSelection;
  try { selection = parseAthleteSelection(argv); } catch (e: any) {
    console.error(`${e.message}\nusage: reextractBrandDomains.ts ${SELECTION_USAGE} [--apply] [--env path] [--out dir] [--yes]`);
    process.exit(2);
  }
  const apply = has("--apply");
  loadEnv({ path: resolve(arg("--env") ?? ".env") });
  if (process.env.MAILBOX_LIVE_READS?.trim().toLowerCase() !== "true") {
    console.error("refusing to run: MAILBOX_LIVE_READS is not on, and this script never reads stored bodies");
    process.exit(1);
  }
  // Dry-run: read-only BEFORE anything loads server/db (node-postgres reads PGOPTIONS on every new connection).
  if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { db, pool } = await import("../../db.js");

  const core = await import("./reextractBrandDomainsCore.js");
  try {
    if (!apply) {
      const ro = await db.execute(sql`SHOW default_transaction_read_only`);
      const value = String((ro as any).rows?.[0]?.default_transaction_read_only ?? "");
      if (value !== "on") { console.error(`refusing to run: the DB session is not read-only (${value || "?"})`); process.exit(1); }
    }
    const athleteIds = await resolveAthletes(db, selection);
    const est = await core.estimate(db, athleteIds);
    console.log(`${athleteIds.length} athlete(s): ${est.brands} brand(s) behind open opportunities; ${est.classifyCalls} classify call(s) needed (${apply ? "APPLY" : "dry-run"}).`);
    if (!has("--yes")) { console.log("nothing read or classified. Re-run with --yes."); return; }

    if (apply && process.env.BRAND_IDENTITY_GATE !== "true") {
      console.error("refusing to apply: BRAND_IDENTITY_GATE is not on in this env, so no job would start");
      process.exit(1);
    }
    const { classifyMessage } = await import("../../skills/dealDetector.js");
    const { requestBrandIdentityRefresh } = await import("../../services/brandIdentityRefresh.js");
    await import("../../workflow/definitions/index.js"); // the runner resolves brand_identity_refresh from the registry
    const report = await core.reextractBrandDomains({
      dbx: db, athleteIds, apply,
      classify: classifyMessage,
      readLatestInbound: core.readLatestInboundLive,
      enqueue: (athleteId, brandId, domain) => requestBrandIdentityRefresh(athleteId, brandId, "catch-up: re-extracted brand domain", { domain }),
      onProgress: (r) => console.log(`  ${r.brand.slice(0, 28).padEnd(28)} → ${(r.found_domain ?? "—").padEnd(26)} ${r.action}${r.note ? ` (${r.note})` : ""}`),
    });
    const md = core.renderReport(report);
    const outDir = resolve(arg("--out") ?? "reports/brand-domains");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(outDir, `reextract-${stamp}.md`), md + "\n");
    console.log(`\n${md.split("\n").slice(0, 3).join("\n")}\nwritten: ${join(outDir, `reextract-${stamp}.md`)}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
