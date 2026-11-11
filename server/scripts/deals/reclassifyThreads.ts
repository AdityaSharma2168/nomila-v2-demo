/**
 * reclassifyThreads.ts — re-run the current classifier over every selected athlete's threads stored under one
 * category (./reclassifyThreadsCore), e.g. after the 8 Oct press-vs-content-collaboration prompt change:
 *
 *   1. DRY-RUN (default): npx tsx server/scripts/deals/reclassifyThreads.ts --all [--category MEDIA] [--env <path/.env>] [--out <dir>] [--yes]
 *                         (or --athlete <uuid> [--athlete <uuid> …] / --athletes a,b / --ids-file <path>)
 *   2. REVIEW the per-athlete .md / .json reports in --out (default reports/reclassify-threads).
 *   3. APPLY:             the same command plus --apply --yes — writes only the threads whose category or media_kind
 *                         changes, through the same write as her "reclassify" tap (services/reclassifyThread). A change
 *                         that would set a deal aside (NOISE / FAN) is held unless --allow-demote.
 *
 * COST: one classify call (Gemini Flash, the call ingest makes) per thread examined, in the dry run and again on
 * apply. Without --yes it prints the call estimate and stops.
 *
 * DRY-RUN is READ-ONLY by construction: the DB session is opened with PGOPTIONS `-c default_transaction_read_only=on`
 * BEFORE the pool module loads, and the run aborts unless `SHOW default_transaction_read_only` answers `on`.
 * Run by a person only: tests exercise the core with the classifier mocked.
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
    console.error(`${e.message}\nusage: reclassifyThreads.ts ${SELECTION_USAGE} [--category CAT] [--apply] [--allow-demote] [--yes] [--env path] [--out dir]`);
    process.exit(2);
  }
  const apply = has("--apply");
  const category = (arg("--category") ?? "MEDIA").trim().toUpperCase();
  const outDir = resolve(arg("--out") ?? "reports/reclassify-threads");
  loadEnv({ path: resolve(arg("--env") ?? ".env") });

  // Read-only BEFORE anything loads server/db: node-postgres reads PGOPTIONS on every new connection.
  if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { DEAL_CATEGORIES, classifyMessage } = await import("../../skills/dealDetector");
  if (!DEAL_CATEGORIES.has(category as any)) {
    console.error(`unknown category ${category} (one of ${[...DEAL_CATEGORIES].join(", ")})`);
    process.exit(2);
  }
  const { reclassifyAthlete, selectThreads, renderMarkdown } = await import("./reclassifyThreadsCore");
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
    const athleteIds = await resolveAthletes(db, selection);
    let calls = 0;
    for (const id of athleteIds) {
      const n = (await selectThreads(db, id, category)).length;
      calls += n;
      if (n) console.log(`athlete ${id}: ${n} ${category} thread(s)`);
    }
    console.log(`estimated classify calls over ${athleteIds.length} athlete(s): ${calls} (Gemini Flash; apply reuses each classification for its write).`);
    if (!has("--yes")) {
      console.log("stopping here: re-run with --yes to classify.");
      return;
    }
    mkdirSync(outDir, { recursive: true });
    const outcomes = await forEachAthlete(athleteIds, async (athleteId) => {
      const report = await reclassifyAthlete(db, athleteId, { category, apply, classify: classifyMessage, allowDemote: has("--allow-demote") });
      if (!report.counts.examined) return report.counts;
      const stamp = report.generated_at.replace(/[:.]/g, "-");
      const base = join(outDir, `reclassify-${category.toLowerCase()}-${report.mode}-${athleteId.slice(0, 8)}-${stamp}`);
      writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
      writeFileSync(`${base}.md`, renderMarkdown(report));
      console.log(`${athleteId}: ${JSON.stringify(report.counts)}`);
      return report.counts;
    });
    const failed = outcomes.filter((o) => !o.ok);
    const total = (k: "examined" | "category_changed" | "written" | "held" | "errors") => outcomes.reduce((n, o) => n + Number(o.result?.[k] ?? 0), 0);
    console.log(`\nsummary: ${outcomes.length - failed.length} athlete(s) ok, ${failed.length} failed · examined ${total("examined")} · category changes ${total("category_changed")} · written ${total("written")} · held ${total("held")} · errors ${total("errors")}`);
    for (const f of failed) console.log(`  FAILED ${f.athlete_id}: ${f.error}`);
    if (!apply) console.log(`dry run: nothing written. Reports in ${outDir}. Re-run with --apply --yes to write.`);
    if (failed.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
