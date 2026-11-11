/**
 * evals/agent/moments/stage.ts — the moments stage of `npm run eval:agent` (design "Moments → post kits" §14): the
 * weekly moments scan on made-up athletes, in memory (never a database), graded in code.
 *
 *   npm run eval:agent -- --stage moments --mock            free: each case's scripted answer (CI runs this)
 *   npm run eval:agent -- --stage moments --budget 1.5      LIVE and PAID: the moments skill's own model (fast tier) and
 *                                                           web search, on today's date
 *
 * The budget is a HARD stop: before every case the runner reserves the scan's per-run reserve (AGENT_MOMENTS_RUN_CAP_USD,
 * default $0.25), so a run can never spend past it. A live run needs OPENAI_API_KEY; with CI set only --mock runs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOMENTS } from "../../../server/agent/moments/config";
import { setResponsesTransport } from "../../../server/agent/research/llm";
import type { GraderResult } from "../types";
import { gradeMomentsCase } from "./graders";
import { loadMomentsCases } from "./loadMomentsCases";
import { momentsMockTransport } from "./mock";
import { runMomentsCase } from "./runMomentsCase";
import type { MomentsRecord } from "./types";

export interface MomentsStageArgs {
  mock: boolean;
  cases: string[];
  budgetUsd: number;
  outRoot: string;
  log?: (line: string) => void;
}

export interface MomentsResult { caseId: string; record: MomentsRecord; graders: GraderResult[] }

export function renderMomentsMarkdown(p: { mode: string; startedAt: string; budgetUsd: number; spentUsd: number; results: MomentsResult[] }): string {
  const names = [...new Set(p.results.flatMap((r) => r.graders.map((g) => g.grader)))];
  const mark = (g?: GraderResult) => (!g ? "" : g.status === "pass" ? "PASS" : g.status === "fail" ? "FAIL" : g.status === "warn" ? "warn" : g.status === "info" ? "·" : "–");
  return [
    `# Agent eval — moments stage (${p.mode})`, ``,
    `Started ${p.startedAt} · spent $${p.spentUsd.toFixed(4)} of a $${p.budgetUsd.toFixed(2)} hard budget.`, ``,
    `| case | ${names.join(" | ")} |`, `|---|${names.map(() => "---").join("|")}|`,
    ...p.results.map((r) => `| ${r.caseId} | ${names.map((n) => mark(r.graders.find((g) => g.grader === n))).join(" | ")} |`),
    ``, `## Failures and warnings`, ``,
    ...p.results.flatMap((r) => r.graders.filter((g) => g.status === "fail" || g.status === "warn").map((g) => `- **${r.caseId}** ${g.grader} (${g.status}): ${g.summary}`)),
    ``, `## What each scan kept and held`, ``,
    ...p.results.flatMap((r) => [
      `### ${r.caseId} — ${r.record.status}`,
      ...r.record.candidates.filter((c) => c.response === "pending").sort((a, b) => a.rank - b.rank).map((c) => `${c.rank}. ${c.name} (${c.category}) — ${c.whyNow} · ${c.idea.hook}${c.idea.angle ? ` (angle: ${c.idea.angle})` : ` (${c.idea.format} on ${c.idea.platform})`}`),
      ...r.record.held.map((h) => `- held: ${h.what} — ${h.reason}`),
      ``,
    ]),
  ].join("\n") + "\n";
}

/** Run the moments stage. Returns the exit code (1 when any grader failed). */
export async function runMomentsStage(a: MomentsStageArgs): Promise<number> {
  const log = a.log ?? ((l: string) => console.log(l));
  const all = loadMomentsCases();
  const unknown = a.cases.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new Error(`unknown moments case(s): ${unknown.join(", ")}`);
  const cases = a.cases.length ? all.filter((c) => a.cases.includes(c.id)) : all;
  const startedAt = new Date().toISOString();
  const capMicroUsd = Math.round(a.budgetUsd * 1e6);
  let spent = 0;
  const results: MomentsResult[] = [];
  log(`moments eval (${a.mock ? "MOCK — scripted answers, no provider, no database" : "LIVE — paid"}): ${cases.length} case(s), hard budget $${a.budgetUsd.toFixed(2)}`);
  try {
    for (const c of cases) {
      if (spent + MOMENTS.RUN_RESERVE_MICRO_USD > capMicroUsd) { log("budget reached: nothing more runs"); break; }
      const today = a.mock ? c.mock_today : new Date().toISOString().slice(0, 10);
      log(`\n▶ ${c.id} — ${c.athlete.name} (${c.athlete.sport}), ${today}`);
      setResponsesTransport(a.mock ? momentsMockTransport(c, today) : null);
      const record = await runMomentsCase(c, { mode: a.mock ? "mock" : "live", today });
      spent += record.run?.costMicroUsd ?? 0;
      const graders = gradeMomentsCase(c, record);
      results.push({ caseId: c.id, record, graders });
      const fails = graders.filter((g) => g.status === "fail").map((g) => g.grader);
      log(`  ${record.status}${fails.length ? ` · FAIL: ${fails.join(", ")}` : " · all graders pass"} · $${((record.run?.costMicroUsd ?? 0) / 1e6).toFixed(4)} · spent $${(spent / 1e6).toFixed(4)}`);
    }
  } finally {
    setResponsesTransport(null);
  }
  const outDir = join(a.outRoot, `${startedAt.replace(/[:.]/g, "-")}-moments${a.mock ? "-mock" : ""}`);
  mkdirSync(join(outDir, "records"), { recursive: true });
  for (const r of results) writeFileSync(join(outDir, "records", `${r.caseId}.json`), JSON.stringify(r.record, null, 2));
  const mode = a.mock ? "mock" : "live";
  writeFileSync(join(outDir, "report.json"), JSON.stringify({ version: 1, stage: "moments", mode, startedAt, finishedAt: new Date().toISOString(), budgetUsd: a.budgetUsd, spentUsd: spent / 1e6, results: results.map((r) => ({ caseId: r.caseId, graders: r.graders })) }, null, 2));
  writeFileSync(join(outDir, "report.md"), renderMomentsMarkdown({ mode, startedAt, budgetUsd: a.budgetUsd, spentUsd: spent / 1e6, results }));
  log(`report: ${join(outDir, "report.md")}`);
  return results.some((r) => r.graders.some((g) => g.status === "fail")) ? 1 : 0;
}
