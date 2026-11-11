/**
 * requalifyRetiredFloor.ts — legacy retirement P2-1: persist the "computed floor is not her floor" verdict.
 *
 *   npx tsx server/scripts/opps/requalifyRetiredFloor.ts            # DRY RUN: read-only session, prints the diff
 *   npx tsx server/scripts/opps/requalifyRetiredFloor.ts --apply    # writes inbox_threads.classification
 *
 * No model call, no email text: ids, the stored terms (kind / cash / units) and the verdict before → after.
 * See requalifyRetiredFloorCore.ts for the rule. Dev only — never point this at prod.
 */
import { readOnlyPgOptions } from "./readOnly";

const apply = process.argv.includes("--apply");
// Dry run: every pooled session is read-only BEFORE server/db loads, so any write statement fails.
if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

async function main() {
  const { selectRetiredFloorThreads, applyRequalify } = await import("./requalifyRetiredFloorCore");
  const rows = await selectRetiredFloorThreads();

  const counts: Record<string, number> = {};
  for (const r of rows) {
    const key = `${r.before.qualification} -> ${r.after.qualification}${r.after.qualification_floor ? " (her floor)" : " (no floor set)"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const athletes = new Set(rows.map((r) => r.athlete_id));
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${rows.length} thread(s) with a computed-rate floor, ${athletes.size} athlete(s)`);
  for (const [k, n] of Object.entries(counts)) console.log(`  ${n}  ${k}`);
  console.log("");
  for (const r of rows) {
    const f = r.before.qualification_floor;
    console.log(`  thread=${r.thread_id} deal=${r.deal_id ?? "-"} athlete=${r.athlete_id.slice(0, 8)}  ${f?.kind} $${f?.cash} x${f?.units} (computed floor $${f?.floor})  ${r.before.qualification} -> ${r.after.qualification}`);
  }
  if (!apply) {
    console.log(`\nDry run only — nothing written. Re-run with --apply.`);
    return;
  }
  const updated = await applyRequalify(rows);
  console.log(`\nDone. updated=${updated} of ${rows.length}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
