/**
 * evals/agent/report.ts — report.json + report.md for one eval run, and the diff against the previous run.
 *
 * The diff compares each (case, grader) present in both runs: better / worse / same. A status change decides it
 * (pass > warn > fail); with the same status, a grader's score decides it (recall up = better, cost or latency down =
 * better; cost and latency within ±10% are "same", so normal noise does not read as a change).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraderResult, GraderStatus } from "./types";

export interface CaseReport {
  id: string;
  reviewed: boolean;
  description: string;
  stopped: { reason: string; detail: string } | null;
  costUsd: number;
  judgeUsd: number;
  wallMs: number;
  graders: GraderResult[];
}

export interface DiffRow {
  caseId: string;
  grader: string;
  verdict: "better" | "worse" | "same";
  before: string;
  after: string;
}

export interface EvalReport {
  version: 1;
  mode: "live" | "mock";
  startedAt: string;
  finishedAt: string;
  stages: string[];
  budgetUsd: number;
  spentUsd: number;
  stoppedForBudget: boolean;
  skills: Record<string, string>;
  models: Record<string, string>;
  judge: { provider: string; model: string; prompt: string } | null;
  git: string | null;
  cases: CaseReport[];
  totals: Record<GraderStatus, number>;
  previous: string | null;
  diff: DiffRow[];
}

const RANK: Partial<Record<GraderStatus, number>> = { pass: 2, warn: 1, fail: 0 };
const NOISY = new Set(["cost", "latency"]);

function describe(g: GraderResult): string {
  return `${g.status}${g.score != null ? ` (${g.score})` : ""}`;
}

export function diffReports(prev: Pick<EvalReport, "cases">, next: Pick<EvalReport, "cases">): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const c of next.cases) {
    const p = prev.cases.find((x) => x.id === c.id);
    if (!p) continue;
    for (const g of c.graders) {
      const b = p.graders.find((x) => x.grader === g.grader);
      if (!b || b.status === "skip" || g.status === "skip") continue;
      let verdict: DiffRow["verdict"] = "same";
      const rb = RANK[b.status];
      const ra = RANK[g.status];
      if (rb != null && ra != null && rb !== ra) verdict = ra > rb ? "better" : "worse";
      else if (b.score != null && g.score != null && b.score !== g.score) {
        const rel = Math.abs(g.score - b.score) / Math.max(Math.abs(b.score), 1e-9);
        if (!(NOISY.has(g.grader) && rel <= 0.1)) {
          const up = g.score > b.score;
          verdict = (g.higherIsBetter ?? true) === up ? "better" : "worse";
        }
      }
      rows.push({ caseId: c.id, grader: g.grader, verdict, before: describe(b), after: describe(g) });
    }
  }
  return rows;
}

/** The newest earlier run of the same mode in `runsDir` (by directory name, which is a timestamp). */
export function previousReport(runsDir: string, currentDir: string, mode: "live" | "mock"): { dir: string; report: EvalReport } | null {
  if (!existsSync(runsDir)) return null;
  const dirs = readdirSync(runsDir).filter((d) => d < currentDir && existsSync(join(runsDir, d, "report.json"))).sort().reverse();
  for (const d of dirs) {
    try {
      const r = JSON.parse(readFileSync(join(runsDir, d, "report.json"), "utf8")) as EvalReport;
      if (r.mode === mode) return { dir: d, report: r };
    } catch { /* skip unreadable */ }
  }
  return null;
}

export function totalsOf(cases: CaseReport[]): Record<GraderStatus, number> {
  const t: Record<GraderStatus, number> = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0 };
  for (const c of cases) for (const g of c.graders) t[g.status]++;
  return t;
}

const MARK: Record<GraderStatus, string> = { pass: "PASS", fail: "FAIL", warn: "warn", skip: "–", info: "·" };
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderMarkdown(r: EvalReport): string {
  const graderNames = [...new Set(r.cases.flatMap((c) => c.graders.map((g) => g.grader)))];
  const out: string[] = [];
  out.push(`# Agent eval — ${r.startedAt.slice(0, 19).replace("T", " ")} UTC (${r.mode})`);
  out.push("");
  if (r.mode === "mock") out.push("> MOCK RUN: fake model answers built from the case files, in-memory store, stub M.I.A. and judge. It proves the plumbing, not the model.", "");
  out.push(`- Stages: ${r.stages.join(", ")}`);
  out.push(`- Spend: $${r.spentUsd.toFixed(2)} of a $${r.budgetUsd.toFixed(2)} budget${r.stoppedForBudget ? " — **stopped at the budget**" : ""}`);
  out.push(`- Skills: ${Object.entries(r.skills).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  out.push(`- Models: ${Object.entries(r.models).map(([k, v]) => `${k} → ${v}`).join(", ")}`);
  if (r.judge) out.push(`- Judge: ${r.judge.provider} ${r.judge.model} (${r.judge.prompt})`);
  if (r.git) out.push(`- Commit: ${r.git}`);
  out.push(`- Totals: ${r.totals.pass} pass, ${r.totals.fail} fail, ${r.totals.warn} warn, ${r.totals.skip} skipped`);
  out.push("");
  out.push(`| case | ${graderNames.join(" | ")} |`);
  out.push(`|---|${graderNames.map(() => "---").join("|")}|`);
  for (const c of r.cases) {
    const cells = graderNames.map((n) => {
      const g = c.graders.find((x) => x.grader === n);
      if (!g) return "";
      return g.score != null && (g.status === "info" || n === "cost" || n === "expected_recall") ? `${MARK[g.status]} ${g.score}` : MARK[g.status];
    });
    out.push(`| ${c.id}${c.reviewed ? "" : "*"} | ${cells.join(" | ")} |`);
  }
  out.push("", "\\* case not yet reviewed by the owner (`reviewed: false`).", "");

  out.push("## Diff against the previous run");
  if (!r.previous) out.push("", "No earlier run of this mode to compare with.");
  else {
    const changed = r.diff.filter((d) => d.verdict !== "same");
    const count = (v: DiffRow["verdict"]) => r.diff.filter((d) => d.verdict === v).length;
    out.push("", `Compared with \`${r.previous}\`: ${count("better")} better, ${count("worse")} worse, ${count("same")} same.`);
    if (changed.length) {
      out.push("", "| case | grader | change | before | after |", "|---|---|---|---|---|");
      for (const d of changed) out.push(`| ${d.caseId} | ${d.grader} | ${d.verdict} | ${d.before} | ${d.after} |`);
    }
  }
  out.push("");

  out.push("## Cases");
  for (const c of r.cases) {
    out.push("", `### ${c.id}`, "", `${c.description}${c.reviewed ? "" : " (expected facts not yet reviewed)"}`);
    out.push("", `Cost $${c.costUsd.toFixed(3)} (+ judge $${c.judgeUsd.toFixed(3)}), wall ${Math.round(c.wallMs / 1000)}s${c.stopped ? `. **Stopped (${c.stopped.reason}):** ${esc(c.stopped.detail)}` : ""}`);
    out.push("", "| grader | result | summary |", "|---|---|---|");
    for (const g of c.graders) out.push(`| ${g.grader} | ${MARK[g.status]} | ${esc(g.summary)} |`);
    const problems = c.graders.filter((g) => (g.status === "fail" || g.status === "warn") && Array.isArray(g.details) && g.details.length);
    for (const g of problems) {
      out.push("", `<details><summary>${g.grader}: ${(g.details as unknown[]).length} item(s)</summary>`, "");
      for (const d of (g.details as any[]).slice(0, 25)) out.push(`- ${esc(typeof d === "string" ? d : JSON.stringify(d))}`);
      out.push("", "</details>");
    }
  }
  out.push("");
  return out.join("\n");
}
