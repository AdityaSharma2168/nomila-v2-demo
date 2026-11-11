/**
 * studioCostReport — print what the spike's generations cost and how long they took.
 *
 * This is the deliverable of the spike's cost question: "Nano edit ran N times, $X total, ~Ys each."
 * Reads the JSONL the router writes (server/studio/costLog.ts) and prints one row per
 * model x task x provider. Read-only — it never generates and never touches the database.
 *
 *   npx tsx server/scripts/studioCostReport.ts
 *   npx tsx server/scripts/studioCostReport.ts --log ./run-2.jsonl
 *   npx tsx server/scripts/studioCostReport.ts --json          # machine-readable rows
 *
 * Tag a generation's quality by hand while reviewing output (the harness always leaves it null):
 *   npx tsx server/scripts/studioCostReport.ts --tag <id> "identity held" --note "kit + eyes right"
 *
 * `--list` prints ids with their prompts' outputs so there is something to tag against.
 */
import { aggregate, formatReport, readLog, tagGeneration, logPath } from "../studio/costLog";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const path = arg("log") ?? logPath();

  // --tag <id> <label> [--note ...]
  const tagIdx = process.argv.indexOf("--tag");
  if (tagIdx >= 0) {
    const id = process.argv[tagIdx + 1];
    const label = process.argv[tagIdx + 2];
    if (!id || !label || label.startsWith("--")) {
      throw new Error('usage: --tag <generationId> "<quality tag>" [--note "<why>"]');
    }
    const known = (await readLog(path)).some((r) => r.id === id);
    if (!known) throw new Error(`No generation ${id} in ${path} — run --list to see the ids.`);
    await tagGeneration(id, label, arg("note"), path);
    console.log(`\nTagged ${id}: ${label}\n`);
    return;
  }

  const records = await readLog(path);

  if (flag("list")) {
    console.log("");
    for (const r of records) {
      const tag = r.qualityTag ? `  [${r.qualityTag}]` : "";
      console.log(
        `${r.id}  ${r.timestamp}  ${r.task.padEnd(15)} ${r.model.padEnd(28)} ` +
        `$${r.cost}${r.costBasis === "estimated" ? "~" : ""}  ${(r.latencyMs / 1000).toFixed(1)}s${tag}`,
      );
    }
    console.log(`\n${records.length} generation(s) in ${path}\n`);
    return;
  }

  const rows = aggregate(records);

  if (flag("json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`\nStudio generation cost - ${path}\n`);
  console.log(formatReport(rows));
}

main().then(() => process.exit(0)).catch((err) => { console.error(`\n${err?.message ?? err}\n`); process.exit(1); });
