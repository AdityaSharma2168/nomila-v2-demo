/**
 * run-agent-eval.ts — the eval harness for the new agent (server/agent/*): research, understand (the Brief), the
 * onboarding turns and the M.I.A. preview, on the cases in evals/agent/cases/. See evals/agent/README.md.
 *
 *   npm run eval:agent -- --mock                       # no provider, no database: proves the pipeline (free)
 *   npm run eval:agent                                 # LIVE: every case, every stage, $8 hard budget
 *   npm run eval:agent -- --case <id> --stage research # one case, research only
 *   npm run eval:agent -- --budget 15                  # raise the hard budget (USD)
 *   npm run eval:agent -- --no-judge                   # skip the model judge
 *   npm run eval:agent -- --cleanup                    # delete eval athletes a crashed run left behind
 *   npm run eval:agent -- --stage moments --mock       # the weekly moments scan (made-up athletes, in memory): free
 *   npm run eval:agent -- --stage moments --budget 1.5 # the moments scan LIVE on its own model + web search (hard budget)
 *   npm run eval:agent -- --stage post-kit --mock      # the post-kit stage (made-up libraries, in memory): free
 *   npm run eval:agent -- --stage post-kit --budget 0.25  # the post-kit stage LIVE on post-kit/match's model (Gemini Flash)
 *   npm run eval:agent -- --stage plan-ready --mock    # Mila's plan-ready follow-up line (5 facts cases, in memory): free
 *   npm run eval:agent -- --stage plan-ready --budget 0.25  # the plan-ready line LIVE on the plan/ready skill's model (OpenAI)
 *
 * Writes evals/agent/runs/<timestamp>/report.json, report.md and records/<case>.json, and diffs against the previous
 * run of the same mode (better / worse / same per grader). Exit code 1 when any grader fails.
 *
 * LIVE runs are PAID (OpenAI Responses + web search for the agent, Vertex for the M.I.A. evaluator and the judge) and
 * need the owner's OK. They are READ-ONLY against the dev database except for the run's own throwaway athlete rows:
 * one `athletes` row per case, status raw, no sign-in, marked referral_code = "agent-eval:<run>", plus what the agent
 * writes under it (agent_runs, memory_*, checkpoints, the M.I.A. workflow/snapshot/ledger rows). After each case
 * every row of that athlete is deleted in the account-deletion manifest's order (server/lib/athleteDataManifest.ts) —
 * and only after checking the row still carries the marker and has no sign-in. Never in CI (tests never reach
 * providers): with CI set, only --mock runs. Refuses any database but dev (server/lib/devDatabaseGuard.ts).
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { onboardingCostCapMicroUsd } from "../server/agent/onboarding/costCap";
import { setResponsesTransport } from "../server/agent/research/llm";
import { createMemoryStore, type AgentStore } from "../server/agent/research/store";
import { loadJob } from "../server/agent/jobs";
import { modelFor } from "../server/agent/models";
import { caseCostMicroUsd, gradeCase } from "../evals/agent/graders";
import { JUDGE_PROMPT_ID, JUDGE_PROMPT_VERSION, vertexGeminiJudge, type JudgeCaller } from "../evals/agent/judge";
import { mockJudge, mockMia, mockTransportFor } from "../evals/agent/mock";
import { diffReports, previousReport, renderMarkdown, totalsOf, type CaseReport, type EvalReport } from "../evals/agent/report";
import { loadCases } from "../evals/agent/loadCases";
import { Budget, runCase, stagesFor } from "../evals/agent/runCase";
import { runMomentsStage } from "../evals/agent/moments/stage";
import { EVAL_STAGES, type EvalCase, type EvalStage, type RecordedMia } from "../evals/agent/types";

export const EVAL_MARKER = "agent-eval";
const ROOT = process.cwd();
const RUNS_DIR = join(ROOT, "evals", "agent", "runs");

interface Args {
  cases: string[]; stage: EvalStage | null; budgetUsd: number; mock: boolean; judge: boolean; cleanup: boolean;
  /** --stage moments: the weekly moments scan (evals/agent/moments), in memory, never a database. */
  moments: boolean;
  /** --stage post-kit: the post-kit stage (evals/agent/postKit), in memory, never a database. */
  postKit: boolean;
  /** --stage plan-ready: Mila's plan-ready follow-up line (evals/agent/planReady), in memory, never a database. */
  planReady: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cases: [], stage: null, budgetUsd: 8, mock: false, judge: true, cleanup: false, moments: false, postKit: false, planReady: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--case") a.cases.push(...String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    else if (k === "--stage") {
      const s = argv[++i];
      if (s === "moments") { a.moments = true; continue; }
      if (s === "post-kit") { a.postKit = true; continue; }
      if (s === "plan-ready") { a.planReady = true; continue; }
      if (!(EVAL_STAGES as readonly string[]).includes(s)) throw new Error(`--stage must be one of ${EVAL_STAGES.join(" | ")} | moments | post-kit | plan-ready`);
      a.stage = s as EvalStage;
    } else if (k === "--budget") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--budget needs a positive number of USD");
      a.budgetUsd = n;
    } else if (k === "--mock") a.mock = true;
    else if (k === "--no-judge") a.judge = false;
    else if (k === "--cleanup") a.cleanup = true;
    else throw new Error(`unknown flag ${k}`);
  }
  return a;
}

function gitSha(): string | null {
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; }
}

/** host:port/db of a database URL — never the user or password. */
function dbTarget(url: string): string {
  try { const u = new URL(url); return `${u.hostname}:${u.port || "5432"}${u.pathname}`; } catch { return "(unparseable DATABASE_URL)"; }
}

// ─── Live: the dev database ────────────────────────────────────────────────────────────────────────────────────────

interface Live {
  store: AgentStore;
  createAthlete: (c: EvalCase) => Promise<string>;
  cleanupAthlete: (id: string) => Promise<number>;
  sweep: () => Promise<{ athletes: number; rows: number }>;
  mia: (athleteId: string) => Promise<RecordedMia>;
  close: () => Promise<void>;
}

async function live(runStamp: string): Promise<Live> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL is not set (start the Cloud SQL proxy and load .env)");
  // Dev only: the connected database itself must be the dev database (not a guess from the URL), before any write or spend.
  await (await import("../server/lib/devDatabaseGuard")).assertDevDatabase();
  console.log(`database: ${dbTarget(url)}`);
  const { and, eq, like, sql } = await import("drizzle-orm");
  const { db, pool } = await import("../server/db");
  const { athletes, miaEvaluationRuns } = await import("../shared/schema");
  const { dbStore } = await import("../server/agent/research/dbStore");
  const { ATHLETE_DATA_MANIFEST, athleteWhere } = await import("../server/lib/athleteDataManifest");
  const { resolveAthleteScope, rowsOf } = await import("../server/services/privacy/athleteScope");
  // Register the workflow definitions (the M.I.A. preview runs the mia_evaluation workflow) and the M.I.A. seam the
  // onboarding reveal reads — exactly what the server loads.
  await import("../server/workflow/definitions");
  const { getMiaPreview } = await import("../server/services/miaPreview/preview");

  const marker = `${EVAL_MARKER}:${runStamp}`;
  const cleanupAthlete = (id: string) => db.transaction(async (tx) => {
    const [row] = rowsOf<{ referral_code: string | null; auth_id: string | null; claimed_at: Date | null }>(
      await tx.execute(sql`SELECT referral_code, auth_id, claimed_at FROM athletes WHERE id = ${id}::uuid FOR UPDATE`));
    if (!row) return 0;
    if (!String(row.referral_code ?? "").startsWith(`${EVAL_MARKER}:`) || row.auth_id || row.claimed_at) throw new Error(`refusing to delete athlete ${id}: it is not an eval athlete`);
    const scope = await resolveAthleteScope(tx, id);
    if (!scope) return 0;
    let n = 0;
    for (const entry of ATHLETE_DATA_MANIFEST) {
      const [r] = rowsOf<{ n: number }>(await tx.execute(sql`WITH d AS (DELETE FROM ${entry.table} WHERE ${athleteWhere(entry, scope)} RETURNING 1) SELECT count(*)::int AS n FROM d`));
      n += Number(r?.n ?? 0);
    }
    return n;
  });

  return {
    store: dbStore,
    createAthlete: async (c) => {
      const [row] = await db.insert(athletes).values({ full_name: c.input.name, sport: c.input.sport, status: "raw", referral_code: marker }).returning({ id: athletes.id });
      return row.id;
    },
    cleanupAthlete,
    sweep: async () => {
      const rows = await db.select({ id: athletes.id }).from(athletes)
        .where(and(like(athletes.referral_code, `${EVAL_MARKER}:%`), sql`${athletes.auth_id} IS NULL`, sql`${athletes.claimed_at} IS NULL`));
      let total = 0;
      for (const r of rows) total += await cleanupAthlete(r.id);
      return { athletes: rows.length, rows: total };
    },
    mia: async (athleteId) => {
      const t0 = Date.now();
      try {
        const p = await getMiaPreview(athleteId, { trigger: "IDENTITY_RESOLVED", reason: "agent eval" });
        const runs = await db.select({ cost: miaEvaluationRuns.cost_usd }).from(miaEvaluationRuns).where(eq(miaEvaluationRuns.athlete_id, athleteId));
        const costMicroUsd = runs.reduce((n, r) => n + Math.round(Number(r.cost ?? 0) * 1e6), 0);
        return { status: p.status, score: p.score, preliminary: p.preliminary, computed: p.computed ?? null, costMicroUsd, latencyMs: Date.now() - t0 };
      } catch (err: any) {
        return { status: "failed", score: null, preliminary: null, computed: null, costMicroUsd: 0, latencyMs: Date.now() - t0, error: String(err?.message ?? err).slice(0, 300) };
      }
    },
    close: () => pool.end(),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (process.env.CI && !args.mock) throw new Error("refusing: live evals never run in CI (tests never reach providers); use --mock");

  // The moments stage: made-up athletes in memory — no database, no cleanup needed; live only spends on the scan.
  if (args.moments) {
    if (!args.mock && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    return runMomentsStage({ mock: args.mock, cases: args.cases, budgetUsd: args.budgetUsd, outRoot: RUNS_DIR });
  }

  // The post-kit stage: made-up libraries in memory — no database; live only spends on the cheap-tier re-rank.
  // The plan-ready stage: facts objects in memory — no database; live only spends on the plan/ready line.
  if (args.planReady) {
    const { runPlanReadyStage } = await import("../evals/agent/planReady/stage");
    return runPlanReadyStage({ mock: args.mock, cases: args.cases, budgetUsd: args.budgetUsd, outRoot: RUNS_DIR });
  }
  if (args.postKit) {
    const { runPostKitStage } = await import("../evals/agent/postKit/stage");
    return runPostKitStage({ mock: args.mock, cases: args.cases, budgetUsd: args.budgetUsd, outRoot: RUNS_DIR });
  }

  const startedAt = new Date();
  const runStamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const all = loadCases();
  const selected = args.cases.length ? all.filter((c) => args.cases.includes(c.id)) : all;
  const unknown = args.cases.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new Error(`unknown case(s): ${unknown.join(", ")} (have: ${all.map((c) => c.id).join(", ")})`);

  const env = args.mock ? null : await live(runStamp);
  if (args.cleanup) {
    if (!env) throw new Error("--cleanup needs the live database (drop --mock)");
    const r = await env.sweep();
    console.log(`cleanup: deleted ${r.athletes} eval athlete(s), ${r.rows} row(s)`);
    await env.close();
    return 0;
  }
  if (!args.mock && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

  const stages = stagesFor(args.stage);
  const budget = new Budget(Math.round(args.budgetUsd * 1e6));
  const capMicroUsd = onboardingCostCapMicroUsd();
  const judge: JudgeCaller | null = !args.judge || !stages.includes("understand") ? null : args.mock ? mockJudge : await vertexGeminiJudge();
  const outDir = join(RUNS_DIR, `${runStamp}${args.mock ? "-mock" : ""}`);
  mkdirSync(join(outDir, "records"), { recursive: true });
  console.log(`agent eval (${args.mock ? "MOCK — no provider, no database" : "LIVE — paid"}): ${selected.length} case(s), stages ${stages.join(" → ")}, budget $${args.budgetUsd.toFixed(2)}, per-case cap $${(capMicroUsd / 1e6).toFixed(2)}`);

  // Ctrl-C: delete what this run created before leaving.
  const created: string[] = [];
  let interrupted = false;
  process.once("SIGINT", () => { interrupted = true; console.log("\ninterrupted: cleaning up after the current step …"); });

  const caseReports: CaseReport[] = [];
  let stoppedForBudget = false;
  try {
    for (const c of selected) {
      if (interrupted) break;
      console.log(`\n▶ ${c.id} — ${c.input.name} (${c.input.sport})`);
      if (args.mock) setResponsesTransport(mockTransportFor(c));
      const store = env?.store ?? createMemoryStore();
      const { record, athleteId } = await runCase(c, stages, {
        mode: args.mock ? "mock" : "live", store,
        createAthlete: async (x) => {
          const id = env ? await env.createAthlete(x) : `00000000-0000-4000-8000-${String(caseReports.length + 1).padStart(12, "0")}`;
          created.push(id);
          return id;
        },
        mia: env ? env.mia : mockMia(c),
        judge, budget, onboardingCapMicroUsd: capMicroUsd, log: (l) => console.log(l),
      });
      if (env && athleteId) {
        const n = await env.cleanupAthlete(athleteId);
        created.splice(created.indexOf(athleteId), 1);
        console.log(`  cleaned up: ${n} row(s) of the eval athlete deleted`);
      }
      writeFileSync(join(outDir, "records", `${c.id}.json`), JSON.stringify(record, null, 2));
      const graders = gradeCase(c, record, { costCapMicroUsd: capMicroUsd, foreignNames: all.filter((x) => x.id !== c.id).map((x) => x.input.name) });
      caseReports.push({
        id: c.id, reviewed: c.reviewed, description: c.description, stopped: record.stopped,
        costUsd: caseCostMicroUsd(record) / 1e6, judgeUsd: (record.judge?.costMicroUsd ?? 0) / 1e6, wallMs: record.wallMs, graders,
      });
      const fails = graders.filter((g) => g.status === "fail").map((g) => g.grader);
      console.log(`  ${fails.length ? `FAIL: ${fails.join(", ")}` : "all graders pass"} · $${(caseCostMicroUsd(record) / 1e6).toFixed(3)} · spent $${(budget.spentMicroUsd / 1e6).toFixed(2)} of $${args.budgetUsd.toFixed(2)}`);
      if (record.stopped?.reason === "budget") { stoppedForBudget = true; console.log("  budget reached: no further cases run"); break; }
    }
  } finally {
    setResponsesTransport(null);
    if (env) {
      for (const id of [...created]) {
        try { console.log(`cleanup after stop: ${await env.cleanupAthlete(id)} row(s) of ${id}`); } catch (err: any) { console.error(`cleanup FAILED for ${id}: ${err?.message} — run --cleanup`); }
      }
      await env.close();
    }
  }

  const skillIds = ["research", "research/merge", "research/merge-compact", "understand", "onboarding"];
  const report: EvalReport = {
    version: 1, mode: args.mock ? "mock" : "live", startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(), stages, budgetUsd: args.budgetUsd, spentUsd: budget.spentMicroUsd / 1e6, stoppedForBudget,
    skills: Object.fromEntries(skillIds.map((id) => [id, loadJob(id).version])),
    models: Object.fromEntries(skillIds.map((id) => { const m = modelFor(loadJob(id)); return [id, `${m.model} (${m.effort})`]; })),
    judge: judge ? { provider: args.mock ? "mock" : "vertex-gemini", model: args.mock ? "mock" : process.env.AGENT_EVAL_JUDGE_MODEL || "GEMINI.pro", prompt: `${JUDGE_PROMPT_ID}@${JUDGE_PROMPT_VERSION}` } : null,
    git: gitSha(), cases: caseReports, totals: totalsOf(caseReports), previous: null, diff: [],
  };
  const prev = previousReport(RUNS_DIR, outDir.slice(RUNS_DIR.length + 1), report.mode);
  if (prev) { report.previous = prev.dir; report.diff = diffReports(prev.report, report); }
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "report.md"), renderMarkdown(report));

  console.log(`\n${report.totals.pass} pass · ${report.totals.fail} fail · ${report.totals.warn} warn · ${report.totals.skip} skipped — spent $${report.spentUsd.toFixed(2)}`);
  if (prev) {
    const n = (v: string) => report.diff.filter((d) => d.verdict === v).length;
    console.log(`vs ${prev.dir}: ${n("better")} better, ${n("worse")} worse, ${n("same")} same`);
  }
  console.log(`report: ${join(outDir, "report.md")}`);
  return report.totals.fail > 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err?.message ?? err); process.exit(2); });
