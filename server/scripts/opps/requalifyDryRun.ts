/**
 * requalifyDryRun.ts — Opportunities PR 1: what would qualified intake do to athletes' open deals?
 *
 *   npx tsx server/scripts/opps/requalifyDryRun.ts --all [--limit 25] [--env <path/.env>] [--out <dir>]
 *       [--test-senders "dev@team.example, team.example"] [--yes]
 *   (or --athlete <uuid> [--athlete <uuid> …] / --athletes a,b / --ids-file <path>; see ../athleteSelection)
 *
 * Always a dry run (it never writes; there is no apply). --limit is PER ATHLETE. Without --yes it prints the
 * summed classify-call estimate over every selected athlete and stops; with --yes it reports one athlete at a time,
 * one report pair per athlete.
 *
 * POSSIBLE TEST EMAILS: when the latest inbound comes from a configured internal sender
 * (INTERNAL_TEST_SENDERS in the env, or --test-senders; comma-separated addresses and/or domains;
 * nothing is hard-coded), the deal is listed in its own section, not classified, and excluded
 * from every count — developer test mail must not distort the review.
 *
 * READ-ONLY, by construction:
 *   · the DB session is opened with PGOPTIONS `-c default_transaction_read_only=on` BEFORE the pool
 *     module loads, and the run aborts unless `SHOW default_transaction_read_only` answers `on` —
 *     any INSERT/UPDATE/DELETE would fail;
 *   · the core (./requalifyCore) only SELECTs; its test runs it under a read-only session.
 *
 * COST: it calls the real classify model (Gemini Flash, the same call ingest makes) once per open
 * deal examined — up to 3 attempts on a transient failure. Without `--yes` it prints the estimate
 * and stops. Run by a person only: tests never import this file.
 *
 * Output: a Markdown report and a JSON dump in --out (default reports/opps-requalify), listing per
 * deal brand / advertiser / channel / agency, current status + category, the new
 * qualification + reason, and what OPPS_QUALIFIED_INTAKE would do (keep / file / mark verify);
 * summary counts per state and the changes vs today.
 */

import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readOnlyPgOptions } from "./readOnly";
import { forEachAthlete, parseAthleteSelection, resolveAthletes, SELECTION_USAGE, type AthleteSelection } from "../athleteSelection";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(k);

const MAX_LIMIT = 500;

async function main(): Promise<void> {
  let selection: AthleteSelection;
  try { selection = parseAthleteSelection(argv); } catch (e: any) {
    console.error(`${e.message}\nusage: requalifyDryRun.ts ${SELECTION_USAGE} [--limit N] [--env path] [--out dir] [--test-senders list] [--yes]`);
    process.exit(2);
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(arg("--limit") ?? 25) || 25));
  const outDir = resolve(arg("--out") ?? "reports/opps-requalify");

  loadEnv({ path: resolve(arg("--env") ?? ".env") });
  // Developer test mail to set aside: --test-senders wins over INTERNAL_TEST_SENDERS from the env.
  const testSenders = arg("--test-senders") ?? process.env.INTERNAL_TEST_SENDERS ?? "";

  // Read-only BEFORE anything loads server/db: node-postgres reads PGOPTIONS on every new connection.
  process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { countCandidates, requalifyAthlete, renderMarkdown } = await import("./requalifyCore");
  const { db, pool } = await import("../../db");
  const { sql } = await import("drizzle-orm");
  try {
    const ro = await db.execute(sql`SHOW default_transaction_read_only`);
    const value = String((ro as any).rows?.[0]?.default_transaction_read_only ?? "");
    if (value !== "on") {
      console.error(`refusing to run: the DB session is not read-only (default_transaction_read_only=${value || "?"})`);
      process.exit(1);
    }

    const athleteIds = await resolveAthletes(db, selection);
    let calls = 0;
    for (const athleteId of athleteIds) {
      const { total, withThread, willClassify } = await countCandidates(db, athleteId, limit);
      calls += willClassify;
      console.log(`athlete ${athleteId}: ${total} open deals, ${withThread} with a thread, ${willClassify} to classify.`);
    }
    console.log(`estimated classify calls over ${athleteIds.length} athlete(s): ${calls} (Gemini Flash, up to ${calls * 3} with retries).`);
    if (!has("--yes")) {
      console.log("dry run of the dry run: nothing classified. Re-run with --yes to proceed.");
      return;
    }

    const { classifyMessage } = await import("../../skills/dealDetector");
    mkdirSync(outDir, { recursive: true });
    const outcomes = await forEachAthlete(athleteIds, async (athleteId) => {
      console.log(`── ${athleteId}`);
      const report = await requalifyAthlete({
        dbx: db,
        athleteId,
        limit,
        classify: classifyMessage,
        testSenders,
        onProgress: (done, of) => { if (done % 5 === 0 || done === of) console.log(`  ${done}/${of}`); },
      });
      const stamp = report.generated_at.replace(/[:.]/g, "-");
      const base = join(outDir, `requalify-${athleteId.slice(0, 8)}-${stamp}`);
      writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
      writeFileSync(`${base}.md`, renderMarkdown(report));
      console.log(`by state:  ${JSON.stringify(report.counts_by_state)}`);
      console.log(`by action: ${JSON.stringify(report.counts_by_action)}`);
      console.log(`possible test emails set aside (not counted): ${report.possible_tests.length}`);
      console.log(`wrote ${base}.md and ${base}.json`);
    });
    const failed = outcomes.filter((o) => !o.ok);
    console.log(`\nsummary: ${outcomes.length - failed.length} athlete(s) reported, ${failed.length} failed.`);
    for (const f of failed) console.log(`  FAILED ${f.athlete_id}: ${f.error}`);
    if (failed.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
