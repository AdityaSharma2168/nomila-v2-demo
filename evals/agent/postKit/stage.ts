/**
 * evals/agent/postKit/stage.ts — the post-kit stage of `npm run eval:agent` (design "Moments → post kits" §14,
 * asset-match quality): made-up libraries and post actions, the real builder in memory (never a database), graded in
 * code from the kit it wrote.
 *
 *   npm run eval:agent -- --stage post-kit --mock          free: each case's scripted re-rank (CI runs the same in Jest)
 *   npm run eval:agent -- --stage post-kit --budget 0.25   LIVE and PAID: the post-kit/match skill's own model (Gemini
 *                                                          Flash on Vertex; about half a cent a case)
 *
 * The budget is a HARD stop: before each case the runner reserves the post-kit run cap (AGENT_POST_KIT_RUN_CAP_USD).
 * A live run needs Vertex ADC; with CI set only --mock runs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POST_KIT } from "../../../server/agent/postKit/config";
import type { GraderResult } from "../types";
import { gradePostKitCase } from "./graders";
import { loadPostKitCases } from "./loadPostKitCases";
import { runPostKitCase } from "./runPostKitCase";
import type { PostKitCaseRecord } from "./types";

export interface PostKitStageArgs { mock: boolean; cases: string[]; budgetUsd: number; outRoot: string; log?: (line: string) => void }

export function renderPostKitMarkdown(p: { mode: string; startedAt: string; budgetUsd: number; spentUsd: number; results: Array<{ caseId: string; graders: GraderResult[] }> }): string {
  const names = [...new Set(p.results.flatMap((r) => r.graders.map((g) => g.grader)))];
  const mark = (g?: GraderResult) => (!g ? "" : g.status === "pass" ? "PASS" : g.status === "fail" ? "FAIL" : g.status === "info" ? "·" : g.status === "warn" ? "warn" : "–");
  return [
    `# Agent eval — post-kit stage (${p.mode})`, ``,
    `Started ${p.startedAt} · spent $${p.spentUsd.toFixed(4)} of a $${p.budgetUsd.toFixed(2)} hard budget.`, ``,
    `| case | ${names.join(" | ")} |`, `|---|${names.map(() => "---").join("|")}|`,
    ...p.results.map((r) => `| ${r.caseId} | ${names.map((n) => mark(r.graders.find((g) => g.grader === n))).join(" | ")} |`),
    ``, `## Failures`, ``,
    ...p.results.flatMap((r) => r.graders.filter((g) => g.status === "fail").map((g) => `- **${r.caseId}** ${g.grader}: ${g.summary}`)),
  ].join("\n") + "\n";
}

/** Run the post-kit stage. Returns the exit code (1 when any grader failed). */
export async function runPostKitStage(a: PostKitStageArgs): Promise<number> {
  const log = a.log ?? ((l: string) => console.log(l));
  const all = loadPostKitCases();
  const unknown = a.cases.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new Error(`unknown post-kit case(s): ${unknown.join(", ")}`);
  const cases = a.cases.length ? all.filter((c) => a.cases.includes(c.id)) : all;
  const startedAt = new Date().toISOString();
  const cap = Math.round(a.budgetUsd * 1e6);
  let spent = 0;
  const results: Array<{ caseId: string; record: PostKitCaseRecord; graders: GraderResult[] }> = [];
  log(`post-kit eval (${a.mock ? "MOCK — scripted re-rank, no provider, no database" : "LIVE — paid"}): ${cases.length} case(s), hard budget $${a.budgetUsd.toFixed(2)}`);
  for (const c of cases) {
    if (!a.mock && spent + POST_KIT.RUN_RESERVE_MICRO_USD > cap) { log("budget reached: nothing more runs"); break; }
    const record = await runPostKitCase(c, a.mock ? "mock" : "live");
    spent += record.costMicroUsd;
    const graders = gradePostKitCase(c, record);
    results.push({ caseId: c.id, record, graders });
    const fails = graders.filter((g) => g.status === "fail").map((g) => g.grader);
    log(`▶ ${c.id}: ${fails.length ? `FAIL: ${fails.join(", ")}` : "all graders pass"} · $${(record.costMicroUsd / 1e6).toFixed(4)}`);
  }
  const outDir = join(a.outRoot, `${startedAt.replace(/[:.]/g, "-")}-post-kit${a.mock ? "-mock" : ""}`);
  mkdirSync(join(outDir, "records"), { recursive: true });
  for (const r of results) writeFileSync(join(outDir, "records", `${r.caseId}.json`), JSON.stringify(r.record, null, 2));
  const mode = a.mock ? "mock" : "live";
  writeFileSync(join(outDir, "report.json"), JSON.stringify({ version: 1, stage: "post-kit", mode, startedAt, finishedAt: new Date().toISOString(), budgetUsd: a.budgetUsd, spentUsd: spent / 1e6, results: results.map((r) => ({ caseId: r.caseId, graders: r.graders })) }, null, 2));
  writeFileSync(join(outDir, "report.md"), renderPostKitMarkdown({ mode, startedAt, budgetUsd: a.budgetUsd, spentUsd: spent / 1e6, results }));
  log(`report: ${join(outDir, "report.md")}`);
  return results.some((r) => r.graders.some((g) => g.status === "fail")) ? 1 : 0;
}
