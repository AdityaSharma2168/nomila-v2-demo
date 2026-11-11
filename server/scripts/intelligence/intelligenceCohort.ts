/**
 * intelligenceCohort.ts — run the dev/admin intelligence seams for a COHORT of athletes: resolve identity → governed v3
 * research → M.I.A. recompute, one athlete at a time, then print a per-athlete outcome report.
 *
 * It drives the ADMIN HTTP API of a running service (/api/v1/admin/intelligence/*), so every provider call happens on
 * that service, where the flags and credentials live; this process opens no database connection and calls no provider.
 *
 *   NOMILA_ADMIN_TOKEN=<admin Firebase ID token> \
 *   npx tsx server/scripts/intelligence/intelligenceCohort.ts --base-url https://<service> --ids <id>,<id>,… [options]
 *
 *   --ids a,b,c | --ids-file <path>   athlete ids (one per line in the file; # comments allowed)
 *   --promote-without-account         also enter athletes with NO Nomila account (the deliberate "promoted" public athlete);
 *                                     without it such athletes are reported `no_self_membership` and skipped
 *   --domains d1,d2                   research only these domains (default: the full plan, Q1–Q6 + signals)
 *   --no-mia                          skip the M.I.A. recompute
 *   --reresolve                       re-resolve athletes left ambiguous / failed (T7 admin; spends one Q1 each)
 *   --state <path>                    resume file (default: ./intelligence-cohort-state.json); re-running resumes
 *   --redo                            run athletes again even when the state says completed
 *   --out <path>                      also write the report JSON there
 *   --poll-ms <n> --timeout-ms <n>    polling cadence / per-stage wait (defaults 15 s / 15 min)
 *
 * Budget: before each athlete the service's daily LLM headroom must cover a resolve plus a full run; otherwise the
 * cohort stops and reports the rest `capped` (resume the next UTC day with the same --state). Caps are never raised.
 * The token is read from the environment and never printed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { httpSeamClient, runCohort, type CohortReportRow, type CohortState } from "../../services/intelligence/seams/cohort";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
const flag = (name: string) => process.argv.includes(name);

function idsFrom(): string[] {
  const inline = arg("--ids");
  const file = arg("--ids-file");
  const raw = [...(inline ? inline.split(",") : []), ...(file ? readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "")) : [])];
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
}

function line(r: CohortReportRow): string {
  const settled = Object.entries(r.research.settled).map(([d, o]) => `${d}:${o}`).join(",") || "-";
  return [
    r.athleteId, (r.name ?? "?").slice(0, 28).padEnd(28), r.account === null ? "?" : r.account ? "account" : "no-account",
    r.outcome.padEnd(17), `identity=${r.identity.value ?? "NULL"}${r.identity.reason ? `(${r.identity.reason})` : ""}`,
    `research=${r.research.outcome ?? "-"}${r.research.capped ? "[capped]" : ""}`, `settled=${settled}`, `facts=${r.facts.current}`,
    `mia=${r.mia.outcome ?? "-"}/${r.mia.pageState ?? "-"}${r.mia.score != null ? `:${r.mia.score}` : ""}/${r.mia.readState ?? "-"}`,
  ].join("  ");
}

async function main() {
  const base = arg("--base-url");
  const token = process.env.NOMILA_ADMIN_TOKEN;
  const ids = idsFrom();
  if (!base || !token || !ids.length) {
    console.error("usage: NOMILA_ADMIN_TOKEN=… npx tsx server/scripts/intelligence/intelligenceCohort.ts --base-url <url> --ids a,b | --ids-file f [--promote-without-account] [--domains d1,d2] [--no-mia] [--reresolve] [--state f] [--redo] [--out f]");
    process.exit(2);
  }
  const statePath = arg("--state") ?? "intelligence-cohort-state.json";
  const prior: CohortState | undefined = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
  if (prior) console.log(`resuming from ${statePath} (started ${prior.startedAt})`);
  const { report, stoppedBy } = await runCohort(ids, httpSeamClient(base, token), {
    promoteWithoutAccount: flag("--promote-without-account"),
    domains: arg("--domains")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
    mia: !flag("--no-mia"),
    reresolve: flag("--reresolve"),
    redo: flag("--redo"),
    pollMs: arg("--poll-ms") ? Number(arg("--poll-ms")) : undefined,
    timeoutMs: arg("--timeout-ms") ? Number(arg("--timeout-ms")) : undefined,
    save: (s) => writeFileSync(statePath, JSON.stringify(s, null, 2)),
    log: (m) => console.log(m),
  }, prior);
  console.log(`\nreport (${report.length})${stoppedBy ? ` — STOPPED: ${stoppedBy}` : ""}:`);
  for (const r of report) { console.log("  " + line(r)); for (const n of r.notes) console.log(`      · ${n}`); }
  const out = arg("--out");
  if (out) writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), stoppedBy, report }, null, 2));
}

main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
