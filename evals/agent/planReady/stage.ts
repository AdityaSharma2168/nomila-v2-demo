/**
 * evals/agent/planReady/stage.ts — the plan-ready stage of `npm run eval:agent` (design "Goals tab post details + plan
 * ready", 12 Oct 2026): Mila's follow-up line when a plan refresh she was asked for has finished. Each case is a facts
 * object (server/agent/plan/tell.ts PlanReadyFacts) and what the line must and must not say; the REAL plan/ready skill
 * writes the line (in memory, never a database) and code grades it.
 *
 *   npm run eval:agent -- --stage plan-ready --mock          free: each case's scripted line (CI runs the same in Jest)
 *   npm run eval:agent -- --stage plan-ready --budget 0.25   LIVE and PAID: the plan/ready skill's own model (OpenAI)
 *
 * Graders (code only):
 *   checks       the production checks pass (tell.ts lineProblem): every number one the facts hold, no name the facts
 *                don't hold, no code, not empty, ≤ 280 characters — else the app would show the plain line
 *   numbers      every count the case names appears as written (numbers right)
 *   reason_kept  the reason the facts give (what media is missing, why a kit was held, why it was skipped) is in the line
 *   no_invented  none of the case's must-not phrases: no invented cause, nothing "posted" or "sent"
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lineProblem, planReadyWriter, type PlanReadyFacts } from "../../../server/agent/plan/tell";
import { setResponsesTransport } from "../../../server/agent/research/llm";
import { createMemoryStore } from "../../../server/agent/research/store";
import { fakeResponses, skillOf } from "../../../server/testUtils/agentModel";
import type { GraderResult } from "../types";

export const PLAN_READY_CASES_DIR = join(__dirname, "cases");
const EVAL_ATHLETE_ID = "00000000-0000-4000-8000-0000000000e2";
/** The skill's own cap (jobs/plan/ready.md limits.cost_cap_usd): the reserve per live case. */
const CASE_RESERVE_MICRO_USD = 50_000;

export interface PlanReadyCase {
  id: string;
  description: string;
  reviewed: boolean;
  facts: PlanReadyFacts;
  /** --mock: the line the scripted model answers. */
  mock_line: string;
  expect: {
    /** Each written exactly as it must appear (case-insensitive): the counts the line must get right. */
    numbers: string[];
    /** Groups of alternatives ("|"): every group must match — the reason the facts give. */
    reason: string[];
    /** Phrases that must not appear (case-insensitive). */
    must_not: string[];
  };
}

export interface PlanReadyRecord { caseId: string; mode: "mock" | "live"; line: string; costMicroUsd: number; error?: string }

export function loadPlanReadyCases(dir: string = PLAN_READY_CASES_DIR): PlanReadyCase[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as PlanReadyCase;
    const where = `plan-ready case ${f}`;
    if (`${c.id}.json` !== f) throw new Error(`${where}: id must equal the file name`);
    if (!c.description?.trim() || !c.facts?.counts || typeof c.mock_line !== "string") throw new Error(`${where}: needs description, facts and mock_line`);
    if (!Array.isArray(c.expect?.numbers) || !Array.isArray(c.expect?.reason) || !Array.isArray(c.expect?.must_not)) throw new Error(`${where}: expect needs numbers, reason and must_not`);
    return c;
  });
}

export async function runPlanReadyCase(c: PlanReadyCase, mode: "mock" | "live"): Promise<PlanReadyRecord> {
  const store = createMemoryStore();
  if (mode === "mock") setResponsesTransport(fakeResponses((body) => {
    if (skillOf(body) !== "plan/ready") throw new Error(`unexpected skill ${skillOf(body)}`);
    return { json: { line: c.mock_line } };
  }));
  try {
    const w = await planReadyWriter(store, EVAL_ATHLETE_ID, null)(c.facts);
    const runs = await store.listRunsSince(EVAL_ATHLETE_ID, { since: new Date(0).toISOString() });
    return { caseId: c.id, mode, line: w?.line ?? "", costMicroUsd: runs.reduce((n, r) => n + r.cost.microUsd, 0) };
  } catch (err: any) {
    return { caseId: c.id, mode, line: "", costMicroUsd: 0, error: String(err?.message ?? err).slice(0, 300) };
  } finally {
    if (mode === "mock") setResponsesTransport(null);
  }
}

const has = (line: string, alternatives: string) => alternatives.split("|").some((a) => line.toLowerCase().includes(a.trim().toLowerCase()));

export function gradePlanReadyCase(c: PlanReadyCase, r: PlanReadyRecord): GraderResult[] {
  const g = (grader: string, ok: boolean, summary: string): GraderResult => ({ grader, status: ok ? "pass" : "fail", summary });
  const problem = r.error ? `error: ${r.error}` : lineProblem(r.line, c.facts);
  const missingNumbers = c.expect.numbers.filter((n) => !has(r.line, n));
  const missingReason = c.expect.reason.filter((alts) => !has(r.line, alts));
  const said = c.expect.must_not.filter((p) => has(r.line, p));
  return [
    g("checks", !problem, problem ? `fails the production checks (${problem}): the app would show the plain line` : "passes the production checks"),
    g("numbers", !missingNumbers.length, missingNumbers.length ? `missing ${missingNumbers.join(", ")}` : "the counts are right"),
    g("reason_kept", !missingReason.length, missingReason.length ? `the reason is missing: ${missingReason.join("; ")}` : "the reason is kept"),
    g("no_invented", !said.length, said.length ? `says ${said.join(", ")}` : "no invented cause, nothing said to have gone out"),
  ];
}

export async function runPlanReadyStage(a: { mock: boolean; cases: string[]; budgetUsd: number; outRoot: string; log?: (l: string) => void }): Promise<number> {
  const log = a.log ?? ((l: string) => console.log(l));
  const all = loadPlanReadyCases();
  const unknown = a.cases.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new Error(`unknown plan-ready case(s): ${unknown.join(", ")}`);
  if (!a.mock && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const cases = a.cases.length ? all.filter((c) => a.cases.includes(c.id)) : all;
  const startedAt = new Date().toISOString();
  const cap = Math.round(a.budgetUsd * 1e6);
  let spent = 0;
  const results: Array<{ caseId: string; record: PlanReadyRecord; graders: GraderResult[] }> = [];
  log(`plan-ready eval (${a.mock ? "MOCK — scripted line, no provider" : "LIVE — paid"}): ${cases.length} case(s), hard budget $${a.budgetUsd.toFixed(2)}`);
  for (const c of cases) {
    if (!a.mock && spent + CASE_RESERVE_MICRO_USD > cap) { log("budget reached: nothing more runs"); break; }
    const record = await runPlanReadyCase(c, a.mock ? "mock" : "live");
    spent += record.costMicroUsd;
    const graders = gradePlanReadyCase(c, record);
    results.push({ caseId: c.id, record, graders });
    const fails = graders.filter((x) => x.status === "fail").map((x) => x.grader);
    log(`▶ ${c.id}: ${fails.length ? `FAIL: ${fails.join(", ")}` : "all graders pass"} · "${record.line}"`);
  }
  const outDir = join(a.outRoot, `${startedAt.replace(/[:.]/g, "-")}-plan-ready${a.mock ? "-mock" : ""}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify({ version: 1, stage: "plan-ready", mode: a.mock ? "mock" : "live", startedAt, budgetUsd: a.budgetUsd, spentUsd: spent / 1e6, results }, null, 2));
  log(`report: ${join(outDir, "report.json")}`);
  return results.some((r) => r.graders.some((x) => x.status === "fail")) ? 1 : 0;
}
