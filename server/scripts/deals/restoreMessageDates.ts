/**
 * restoreMessageDates.ts — restore thread / opportunity dates from the messages' own dates (./restoreMessageDatesCore).
 *
 *   1. DRY-RUN (default): npx tsx server/scripts/deals/restoreMessageDates.ts --all [--env <path/.env>] [--out <dir>]
 *                         (or --athlete <uuid> [--athlete <uuid> …] / --athletes a,b / --ids-file <path>)
 *   2. REVIEW the per-athlete .md / .json plans in --out (default reports/restore-message-dates).
 *   3. APPLY:             the same command plus --apply — ONE transaction per athlete.
 *
 * DRY-RUN by default, READ-ONLY by construction: the DB session is opened with PGOPTIONS
 * `-c default_transaction_read_only=on` BEFORE the pool module loads, and the run aborts unless
 * `SHOW default_transaction_read_only` answers `on`.
 *
 * No model is called and no message content is read. Run by a person only: tests exercise the core.
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readOnlyPgOptions } from "../opps/readOnly";
import { forEachAthlete, parseAthleteSelection, resolveAthletes, SELECTION_USAGE, type AthleteSelection } from "../athleteSelection";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(k);

async function main(): Promise<void> {
  let selection: AthleteSelection;
  try { selection = parseAthleteSelection(argv); } catch (e: any) {
    console.error(`${e.message}\nusage: restoreMessageDates.ts ${SELECTION_USAGE} [--apply] [--env path] [--out dir]`);
    process.exit(2);
  }
  const apply = has("--apply");
  const outDir = resolve(arg("--out") ?? "reports/restore-message-dates");
  loadEnv({ path: resolve(arg("--env") ?? ".env") });

  // Read-only BEFORE anything loads server/db: node-postgres reads PGOPTIONS on every new connection.
  if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { planRestore, applyRestore, renderMarkdown } = await import("./restoreMessageDatesCore");
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
      const plan = apply ? await applyRestore(db, athleteId) : await planRestore(db, athleteId);
      const stamp = plan.generated_at.replace(/[:.]/g, "-");
      const base = join(outDir, `restore-dates-${apply ? "apply" : "dryrun"}-${athleteId.slice(0, 8)}-${stamp}`);
      writeFileSync(`${base}.json`, JSON.stringify(plan, null, 2));
      writeFileSync(`${base}.md`, renderMarkdown(plan, apply ? "apply" : "dry-run"));
      if (plan.counts.threads || plan.counts.opportunities) console.log(`${athleteId}: ${JSON.stringify(plan.counts)}`);
      return plan.counts;
    });
    const failed = outcomes.filter((o) => !o.ok);
    const total = (k: "threads" | "opportunities" | "deals") => outcomes.reduce((n, o) => n + Number(o.result?.[k] ?? 0), 0);
    console.log(`\nsummary: ${outcomes.length - failed.length} athlete(s) ok, ${failed.length} failed · threads ${total("threads")} · opportunities ${total("opportunities")} · deals affected ${total("deals")}`);
    for (const f of failed) console.log(`  FAILED ${f.athlete_id}: ${f.error}`);
    if (!apply) console.log(`dry run: nothing written. Plans in ${outDir}. Re-run with --apply to write.`);
    if (failed.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
