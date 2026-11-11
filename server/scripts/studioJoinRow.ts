/**
 * studioJoinRow — print one generation's joined row: job ↔ asset ↔ edit row ↔ verdict ↔ cost lines.
 *
 * The read side of PR 11 (R-3), as a script. READ-ONLY: it opens the database, selects, reads the
 * cost log, prints, and exits. It writes nothing anywhere.
 *
 *   npx tsx --require dotenv/config server/scripts/studioJoinRow.ts --athlete <uuid> --asset <uuid>
 *   npx tsx --require dotenv/config server/scripts/studioJoinRow.ts --athlete <uuid> --job <uuid>
 *   npx tsx --require dotenv/config server/scripts/studioJoinRow.ts --athlete <uuid> --edit <uuid>
 *   npx tsx --require dotenv/config server/scripts/studioJoinRow.ts --athlete <uuid> --latest-edit
 *     --latest-edit                     her newest ACCEPTED typed edit, found under --athlete
 *     [--log ./studio-cost-log.jsonl]   which JSONL to read (default: STUDIO_COST_LOG or the repo's)
 *     [--json]                          the row as JSON instead of the printed form
 *
 * `--athlete` is required: the query is tenant-scoped like every read on this path, and a script has
 * no `req.athleteId` to take it from. Printed output is ids, states and money — never a brief, a
 * prompt, a caption or a signed url.
 */
import { pool } from "../db";
import { joinRow, latestAcceptedEditId, type JoinRow } from "../studio/qa/join";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const money = (n: number | string | null | undefined) =>
  n === null || n === undefined ? "—" : `$${Number(n).toFixed(4)}`;

/** The printed form: one block per half, `(none)` where a half is absent. */
export function formatRow(row: JoinRow): string {
  const out: string[] = [];
  const from = Object.entries(row.from)[0];
  out.push(`JOIN ROW  from ${from[0]}=${from[1]}`);
  out.push("");

  if (row.job) {
    const j = row.job;
    out.push("JOB");
    out.push(`  id        ${j.id}`);
    out.push(
      `  status    ${j.status}   mode ${j.mode}   deliverable ${j.deliverable}`,
    );
    out.push(`  route     ${j.provider ?? "—"} / ${j.model ?? "—"}`);
    out.push(
      `  quoted    ${money(j.cost_estimated_usd)}  (${j.cost_basis ?? "no basis"})`,
    );
    out.push(
      `  created   ${j.created_at?.toISOString() ?? "—"}   completed ${j.completed_at?.toISOString() ?? "—"}`,
    );
  } else out.push("JOB       (none)");
  out.push("");

  if (row.asset) {
    const a = row.asset;
    out.push("ASSET");
    out.push(`  id        ${a.id}`);
    out.push(
      `  type      ${a.mediaType}   approval ${a.approvalStatus ?? "—"}`,
    );
    out.push(`  job       ${a.generationJobId ?? "—"}`);
    out.push(
      `  derived   ${a.derivedFromAssetId ?? "— (a generate, or not an edit)"}`,
    );
    out.push(`  created   ${a.createdAt ?? "—"}`);
  } else out.push("ASSET     (none)");
  out.push("");

  if (row.edit) {
    const e = row.edit;
    out.push("EDIT ROW");
    out.push(`  id        ${e.id}   op ${e.op}   status ${e.status}`);
    out.push(
      `  batch     ${e.batch_id ?? "— (single edit)"}   preview ${e.preview_id ?? "—"}   job ${e.job_id ?? "—"}`,
    );
    out.push(
      `  source    ${e.source_asset_id}   accepted → ${e.accepted_asset_id ?? "—"}`,
    );
    out.push(
      `  quoted    ${money(e.cost_quoted_usd)}   actual ${money(e.cost_usd)}`,
    );
  } else out.push("EDIT ROW  (none)");
  out.push("");

  if (row.verdict) {
    const v = row.verdict;
    out.push("VERDICT");
    out.push(
      `  overall   ${v.overall}   subject ${v.subject}   unknown checks ${v.unknownChecks}   at ${v.at}`,
    );
    out.push(
      `  spend     ${money(v.spend.usd)}  (${v.spend.basis}; ${v.spend.visionCalls} vision, ${v.spend.embedCalls} embed)`,
    );
    out.push(
      `  identity  ${v.identityObservation ? "observation on record (never a check)" : "no observation"}`,
    );
  } else out.push("VERDICT   (none)");
  out.push("");

  out.push(`COST LINES  ${row.costLines.length} in ${row.costLinesFrom}`);
  for (const l of row.costLines) {
    out.push(
      `  ${l.timestamp}  ${l.task.padEnd(15)} ${l.model.padEnd(28)} ${money(l.cost)} ${l.costBasis.padEnd(13)} ` +
        `job=${l.jobId ?? "-"} edit=${l.editPreviewId ?? "-"} asset=${l.assetId ?? "-"} prompt=${l.promptVersion ?? "-"}`,
    );
  }
  if (!row.costLines.length)
    out.push(
      "  (none — a line written before PR 11 carries no join key, and the log is per machine)",
    );
  out.push("");
  return out.join("\n");
}

async function main(): Promise<void> {
  const athleteId = arg("athlete");
  const assetId = arg("asset");
  const jobId = arg("job");
  let editId = arg("edit");
  if (!athleteId) throw new Error("--athlete <uuid> is required");
  if (flag("latest-edit")) {
    editId = (await latestAcceptedEditId(athleteId)) ?? undefined;
    if (!editId) throw new Error("no accepted typed edit under that athlete");
  }
  if ([assetId, jobId, editId].filter(Boolean).length !== 1) {
    throw new Error(
      "usage: --athlete <uuid> and exactly one of --asset <uuid> | --job <uuid> | --edit <uuid> | --latest-edit [--log path] [--json]",
    );
  }
  const key = assetId
    ? { assetId }
    : jobId
      ? { jobId }
      : { editPreviewId: editId! };
  const row = await joinRow(athleteId, key, { logPath: arg("log") });
  // The brief is her words and the job's direction; it is not what this row is for and it never
  // reaches a terminal from here. Every other field is an id, a state or money.
  const printable = row.job
    ? { ...row, job: { ...row.job, brief: "(omitted)" } }
    : row;
  if (flag("json")) console.log(JSON.stringify(printable, null, 2));
  else console.log(formatRow(row));
}

// Only when run directly, so `formatRow` can be imported by a test without opening a database.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
