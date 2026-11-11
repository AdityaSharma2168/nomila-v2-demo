/**
 * backfillOpportunities.ts — Opportunities PR 2: put existing deals under opportunities.
 *
 *   1. DRY-RUN (default): npx tsx server/scripts/opps/backfillOpportunities.ts --all [--mirror-groups] [--env <path/.env>] [--out <dir>]
 *                         (or --athlete <uuid> [--athlete <uuid> …] / --athletes a,b / --ids-file <path>)
 *   2. REVIEW the per-athlete .md / .json plans in --out.
 *   3. APPLY:             the same command plus --apply — ONE transaction per athlete, a summary count per athlete.
 *
 * Athlete selection is ../athleteSelection: --all (every athlete) or an explicit list. One athlete failing is reported
 * and the run moves on to the next (its transaction rolled back).
 *
 * DRY-RUN by default, READ-ONLY by construction: the DB session is opened with PGOPTIONS
 * `-c default_transaction_read_only=on` BEFORE the pool module loads, and the run aborts unless
 * `SHOW default_transaction_read_only` answers `on`. It writes a Markdown report and a JSON plan
 * per athlete to --out (default reports/opps-backfill): every opportunity it would create, every
 * deal it would place, and every opportunity it would FILE (quiet since before 1 Aug 2026,
 * negotiating ones included). The JSON carries each deal's old deal_group_id — the rollback record.
 *
 * --apply plans and writes inside ONE transaction per athlete. Filed opportunities get one
 * reversible auto_archive receipt each (Undo reopens the opportunity and its threads).
 *
 * --mirror-groups (or OPPS_ONE_PER_BRAND=true in the env) also copies each opportunity id into
 * deal_group_id, so today's screens show one card per opportunity. Re-running with it after an
 * earlier apply only mirrors (placed deals are never re-placed).
 *
 * No model is called. Run by a person only: tests exercise ./backfillOpportunitiesCore.
 */

import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readOnlyPgOptions } from "./readOnly";
import { forEachAthlete, parseAthleteSelection, resolveAthletes, SELECTION_USAGE, type AthleteSelection } from "../athleteSelection";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(k);

async function main(): Promise<void> {
  let selection: AthleteSelection;
  try { selection = parseAthleteSelection(argv); } catch (e: any) {
    console.error(`${e.message}\nusage: backfillOpportunities.ts ${SELECTION_USAGE} [--apply] [--mirror-groups] [--env path] [--out dir]`);
    process.exit(2);
  }
  const apply = has("--apply");
  const outDir = resolve(arg("--out") ?? "reports/opps-backfill");

  loadEnv({ path: resolve(arg("--env") ?? ".env") });
  const mirrorGroups = has("--mirror-groups");

  // Read-only BEFORE anything loads server/db: node-postgres reads PGOPTIONS on every new connection.
  if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { planBackfill, applyBackfill, renderMarkdown } = await import("./backfillOpportunitiesCore");
  const { db, pool } = await import("../../db");
  const { sql } = await import("drizzle-orm");
  try {
    if (!apply) {
      const ro = await db.execute(sql`SHOW default_transaction_read_only`);
      const value = String((ro as any).rows?.[0]?.default_transaction_read_only ?? "");
      if (value !== "on") {
        console.error(`refusing to run: the DB session is not read-only (default_transaction_read_only=${value || "?"})`);
        process.exit(1);
      }
    }

    mkdirSync(outDir, { recursive: true });
    const athleteIds = await resolveAthletes(db, selection);
    console.log(`${apply ? "APPLYING" : "dry run over"} ${athleteIds.length} athlete(s)…`);
    const outcomes = await forEachAthlete(athleteIds, async (athleteId) => {
      // applyBackfill plans and writes inside ONE transaction for this athlete.
      const plan = apply
        ? await applyBackfill(db, athleteId, { mirrorGroups })
        : await planBackfill(db, athleteId, { mirrorGroups });
      const stamp = plan.generated_at.replace(/[:.]/g, "-");
      const base = join(outDir, `opps-backfill-${apply ? "apply" : "dryrun"}-${athleteId.slice(0, 8)}-${stamp}`);
      writeFileSync(`${base}.json`, JSON.stringify(plan, null, 2));
      writeFileSync(`${base}.md`, renderMarkdown(plan, apply ? "apply" : "dry-run"));
      console.log(`${athleteId}: ${JSON.stringify(plan.counts)}`);
      console.log(`  wrote ${base}.md and ${base}.json`);
      return plan.counts;
    });
    const failed = outcomes.filter((o) => !o.ok);
    const total = (k: keyof NonNullable<(typeof outcomes)[number]["result"]>) => outcomes.reduce((n, o) => n + Number(o.result?.[k] ?? 0), 0);
    console.log(`\nsummary: ${outcomes.length - failed.length} athlete(s) ok, ${failed.length} failed · deals to place ${total("deals_to_place")} · create open ${total("create_open")} · create closed ${total("create_closed")} · file ${total("file")}`);
    for (const f of failed) console.log(`  FAILED ${f.athlete_id}: ${f.error}`);
    if (!apply) console.log("dry run: nothing written. Review the plans, then re-run with --apply to write.");
    if (failed.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
