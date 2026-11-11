/**
 * resummarizeOpenOpportunities.ts — re-run the thread summarizer on the threads behind OPEN
 * opportunities only (every athlete), so their conversation_state picks up the current prompt
 * (e.g. the second-person voice from #805). Existing rows otherwise only change on their next summary.
 *
 *   npx tsx server/scripts/opps/resummarizeOpenOpportunities.ts            # DRY RUN: list only, no model calls
 *   npx tsx server/scripts/opps/resummarizeOpenOpportunities.ts --apply    # summarize sequentially
 *
 * Calls the app's own summarizeThread, so MAILBOX_LIVE_READS / MAILBOX_ZERO_RETENTION / TOKEN_KMS
 * behave exactly as the environment says — run it with the same values the target service has.
 * A thread whose mailbox can't be read is left as it was (summarizeThread writes nothing).
 * Output is model summaries (one line each), never email text.
 */
import { selectOpenOpportunityThreads, thirdPersonHits } from "./resummarizeOpenOpportunitiesCore";

const DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s: string | null | undefined) => (s ?? "∅").replace(/\s+/g, " ").trim();

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await selectOpenOpportunityThreads();

  const opps = new Set(rows.map((r) => r.opportunity_id));
  const athletes = new Set(rows.map((r) => r.athlete_id));
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${rows.length} thread(s) behind ${opps.size} open opportunit(ies), ${athletes.size} athlete(s)\n`);
  for (const r of rows) {
    const hits = thirdPersonHits(r.current_state, [r.athlete_name, r.athlete_first_name]);
    console.log(`  ${r.thread_id}  ${r.brand_name ?? "(no brand)"}  msgs=${r.message_count}  athlete=${r.athlete_id.slice(0, 8)}${hits.length ? `  3P[${hits.join(",")}]` : ""}`);
  }
  if (!apply) {
    console.log(`\nDry run only — ${rows.length} model call(s) would be made. Re-run with --apply.`);
    return;
  }

  const { summarizeThread } = await import("../../skills/threadSummarizer");
  let ok = 0, failed = 0, calls = 0, remaining = 0;
  for (const [i, r] of rows.entries()) {
    const before = oneLine(r.current_state);
    let after: string | null = null;
    let error: string | null = null;
    try {
      const parsed = await summarizeThread(r.thread_id);
      calls++;
      after = (parsed?.conversation_state as string | undefined) ?? null;
    } catch (e: any) {
      error = e?.message ?? String(e);
    }
    const hits = thirdPersonHits(after, [r.athlete_name, r.athlete_first_name]);
    if (after) ok++; else failed++;
    if (hits.length) remaining++;
    console.log(`\n[${after ? "ok" : "FAILED"}] ${r.brand_name ?? "(no brand)"} ${r.thread_id}${error ? `  error=${error}` : ""}`);
    console.log(`  before: ${before}`);
    console.log(`  after:  ${after ? oneLine(after) : "(unchanged — summary not written)"}${hits.length ? `  ⚠ 3P[${hits.join(",")}]` : ""}`);
    if (i < rows.length - 1) await sleep(DELAY_MS);
  }
  console.log(`\nDone. ok=${ok} failed=${failed} summarizer calls=${calls} third-person remaining=${remaining}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
