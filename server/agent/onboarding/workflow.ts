/**
 * agent/onboarding/workflow.ts — the new onboarding as a durable, resumable workflow (the existing Postgres runner).
 *
 *   research_a ┐  two independent web-search passes with different angles (jobs/research.md), IN PARALLEL;
 *   research_b ┘  each reports its own progress
 *   research_merge   merge (jobs/research/merge.md) + measured facts from any connected account
 *   opening          turn 0 (jobs/onboarding.md): the REVEAL, as soon as the merge is done — the athlete can start
 *                    reviewing facts and talking from here (the turn API opens once this step is done)
 *   moments          (v2) the first moments scan (agent/moments): the dated moments worth a post in the next six weeks,
 *                    written to the moments store before the Brief; best-effort, capped, off unless AGENT_MOMENTS
 *   understand       the Brief (jobs/understand.md; no web search: its timing reads the dated moments on file),
 *                    in the background while the athlete reads;
 *                    once written it starts the plan step (agent/plan: recommended goals, game plans, this week's
 *                    actions) as its own plan_refresh run — never waited for: goals are optional
 *   mia_preview      (v3) beside the opening, right after the merge (v1/v2: beside understand): the M.I.A. PREVIEW from her memory (services/miaPreview) — the existing M.I.A.
 *                    evaluator on her found + measured facts; held while research left her identity disputed. Never
 *                    fails the onboarding: a failure is recorded on the step and Home simply has no preview yet
 *   insights         a system turn when the Brief is ready: early insight cards arrive in the conversation
 *   conversation     PARKS until every required checkpoint is met (not `goal`); the athlete's turns arrive through the API
 *                    (service.ts onboardingTurn), which completes this step when the last checkpoint is done
 *   finish           logs the path taken (for improving the skill) and the onboarding's total cost
 *
 * Process "agent_onboarding" (the old "onboarding" process is untouched). Each model step reuses a finished agent run
 * with the same parent ref, so a retried step never pays twice. The whole onboarding has a cost cap
 * (AGENT_ONBOARDING_COST_CAP_USD, default 2): a model call is refused once the spend reaches it.
 */
import { defineWorkflow } from "../../workflow/registry";
import type { StepCtx } from "../../workflow/types";
import { createLogger } from "../../logger";
import { dbStore } from "../research/dbStore";
import { connectedSummaryText, loadConnectedChannels, measuredFactsFrom, partnerPosts } from "../research/connected";
import { mergePasses, recordIdentityOutcome, searchPass, syncMeasured, type JobContext } from "../research/research";
import { getMiaPreview } from "../../services/miaPreview/preview";
import { understand } from "../research/understand";
import { loadNomilaDeals } from "../research/nomilaDeals";
import { listPreferences } from "../memory";
import { ageBandFrom } from "../ageBand";
import { allDone, turnPrefix } from "./turn";
import { onboardingTurnFn } from "./milaTurn";
import { connectedPlatforms } from "./connections";
import { onboardingCostCapMicroUsd } from "./costCap";
import { requestPlanRefresh } from "../plan/triggers";
import type { StepDef } from "../../workflow/types";
import { agentMomentsEnabled } from "../moments/config";
import { runMomentsScan } from "../moments/scan";
import { dbMomentsSources } from "../moments/sources";
import { jobAllowed } from "../welcome/gate";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { isAboutAthlete } from "../../../shared/agent";
import { RESEARCH_WRITTEN_STEPS, SIGNUP_RESEARCH_PROCESS } from "./dailyCap";

const logger = createLogger("agent/onboarding");

export const AGENT_ONBOARDING_PROCESS = "agent_onboarding";

export { onboardingCostCapMicroUsd };

export const parentPrefixFor = (workflowRunId: string) => `workflow:${workflowRunId}`;

/**
 * RESEARCH_PIPELINE_V2_SHADOW (dev only): after today's research has merged, start the narrow pipeline beside it for
 * comparison (agent/research/v2). It runs as its own workflow, never writes her record or score, and a failure to
 * start it never fails the merge step.
 */
async function startResearchV2Shadow(ctx: StepCtx, athlete: { name: string; sport: string }): Promise<void> {
  const { researchV2ShadowEnabled } = await import("../research/v2/config");
  if (!researchV2ShadowEnabled() || !ctx.athleteId) return;
  try {
    const { startRun } = await import("../../workflow/runner");
    await startRun({
      process: "research_v2_shadow", athleteId: ctx.athleteId, createdBy: "research_v2_shadow", kick: false,
      idempotencyKey: `research_v2_shadow:${ctx.runId}`, input: { name: athlete.name, sport: athlete.sport, signup_run_id: ctx.runId },
    });
  } catch (err: any) {
    logger.warn({ athleteId: ctx.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "research v2 shadow: not started");
  }
}

interface RunInput { name: string; sport: string }
const inputOf = (ctx: StepCtx): RunInput => {
  const i = (ctx.runInput ?? {}) as Partial<RunInput>;
  if (!i.name || !i.sport) throw new Error("agent_onboarding needs a name and a sport");
  return { name: i.name, sport: i.sport };
};

async function jobCtx(ctx: StepCtx): Promise<JobContext> {
  const athleteId = ctx.athleteId!;
  const prefix = parentPrefixFor(ctx.runId);
  const spent = await dbStore.costByParentPrefix(athleteId, prefix);
  return { store: dbStore, athleteId, parentPrefix: prefix, budget: { spentMicroUsd: spent.microUsd, capMicroUsd: onboardingCostCapMicroUsd() } };
}

async function pass(ctx: StepCtx, which: "a" | "b", stopWhen?: { check: () => Promise<boolean>; everyMs: number }) {
  const job = await jobCtx(ctx);
  const athlete = inputOf(ctx);
  const channels = await loadConnectedChannels(job.athleteId);
  const existing = await dbStore.listFacts(job.athleteId, ["active", "disputed"]);
  const r = await searchPass(job, { pass: which, athlete, connectedSummary: connectedSummaryText(channels), existing, ...(stopWhen ? { stopWhen } : {}) });
  return { run_id: r.runId, facts: r.facts.length, dropped: r.dropped.length, cost_micro_usd: r.costMicroUsd, ...(r.cut ? { cut: "time_budget" } : {}) };
}

/**
 * SIGNUP_PASS_BUDGET_MS (default 270000, 4.5 minutes; 0 turns it off): the waitlist sign-up's time budget for each web-search
 * pass. On prod (24 Oct 2026) pass A took 4m50s and pass B 9m07s — B's searches were done in 90 seconds and the rest was
 * the model thinking, then writing its facts — so the sign-up's score waited ~12 minutes on the slower pass.
 */
export function signupPassBudgetMs(): number {
  const raw = process.env.SIGNUP_PASS_BUDGET_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 270_000;
}
/** How often a budgeted pass looks at the clock and at its sibling. */
export const SIGNUP_PASS_CHECK_MS = 10_000;

/**
 * A web-search pass with the sign-up's time budget: once the budget is spent AND the other pass has finished, it stops
 * and keeps the facts it had already written (research.ts salvagePassJson; often none, when it was still thinking).
 * Never both: a pass is only stopped once the other one is done, so the merge always has one whole pass. The step
 * records `cut: "time_budget"`; the merge reuses the stopped run as it is (no second model call).
 */
export function budgetedPassStep(which: "a" | "b", budgetMs: () => number = signupPassBudgetMs): StepDef {
  const base = byName(which === "a" ? "research_a" : "research_b");
  const sibling = which === "a" ? "research_b" : "research_a";
  return {
    ...base,
    run: async (ctx) => {
      const budget = budgetMs();
      if (!budget) return pass(ctx, which);
      const started = Date.now();
      return pass(ctx, which, { check: () => passBudgetSpent({ runId: ctx.runId, sibling, startedMs: started, budgetMs: budget }), everyMs: SIGNUP_PASS_CHECK_MS });
    },
  };
}

/** Whether a budgeted pass should stop now: its budget is spent AND its sibling pass (same run) has finished. */
export async function passBudgetSpent(o: { runId: string; sibling: string; startedMs: number; budgetMs: number; nowMs?: number }): Promise<boolean> {
  if ((o.nowMs ?? Date.now()) - o.startedMs < o.budgetMs) return false;
  const rows = await db.select({ status: workflowSteps.status }).from(workflowSteps)
    .where(and(eq(workflowSteps.run_id, o.runId), eq(workflowSteps.step, o.sibling), eq(workflowSteps.status, "done"))).limit(1);
  return rows.length > 0;
}

const LONG = 25 * 60_000;

/**
 * The first moments scan (v2): before Understand, so a new athlete's Brief has dated moments to time against instead of
 * a thin timing section. Best-effort and capped: off unless AGENT_MOMENTS; it runs before any Brief exists
 * (requireBrief false), inside the onboarding's own cap (jobBudget) as well as the scan's run, week and day caps; any
 * failure is recorded on the step and never fails the onboarding. Its agent run's parent ref is "<prefix>:moments", so
 * a retried step never pays twice and its cost counts toward the onboarding.
 */
export const MOMENTS_STEP: StepDef = {
  name: "moments", kind: "model", leaseMs: 10 * 60_000, retry: { maxAttempts: 1 },
  run: async (ctx) => {
    if (!agentMomentsEnabled()) return { status: "off" };
    const job = await jobCtx(ctx);
    // MILA_WELCOME: the moments scan is the optional moments_scan capability (registry), so even the first one runs
    // only after the athlete's yes; a new athlete is unset, so it is skipped and the Brief times against no moments.
    // Transparent while the flag is off.
    if (!(await jobAllowed("moments_scan", job.athleteId))) return { status: "skipped", reason: "not_chosen" };
    try {
      return await runMomentsScan({
        store: dbStore, sources: dbMomentsSources, athleteId: job.athleteId, trigger: "event", parentRef: `${job.parentPrefix}:moments`,
        requireBrief: false, jobBudget: job.budget, now: new Date(),
      });
    } catch (err: any) {
      logger.warn({ athleteId: job.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "agent onboarding: the first moments scan failed");
      return { status: "failed", error: String(err?.message ?? err).slice(0, 200) };
    }
  },
};

const STEPS_V1: StepDef[] = [
    { name: "research_a", kind: "model", leaseMs: LONG, retry: { maxAttempts: 2 }, run: (ctx) => pass(ctx, "a") },
    { name: "research_b", kind: "model", leaseMs: LONG, retry: { maxAttempts: 2 }, parallel: true, run: (ctx) => pass(ctx, "b") },
    {
      name: "research_merge", kind: "model", leaseMs: LONG, retry: { maxAttempts: 2 },
      run: async (ctx) => {
        const job = await jobCtx(ctx);
        const athlete = inputOf(ctx);
        const channels = await loadConnectedChannels(job.athleteId);
        const measured = await syncMeasured(dbStore, job.athleteId, measuredFactsFrom(channels, athlete.name));
        const existing = await dbStore.listFacts(job.athleteId, ["active", "disputed"]);
        const summary = connectedSummaryText(channels);
        // The passes are finished runs: these calls reuse them (no model call, no cost).
        const a = await searchPass(job, { pass: "a", athlete, connectedSummary: summary, existing });
        const b = await searchPass(job, { pass: "b", athlete, connectedSummary: summary, existing });
        // Her own posts that name a partner are evidence merge may cite for a current partnership (research 1.8.0).
        const m = await mergePasses(job, { athlete, a, b, existing, posts: partnerPosts(channels) });
        // Identity, kept in memory: an unresolved identity becomes a disputed "#identity" fact (holds M.I.A.).
        await recordIdentityOutcome(dbStore, job.athleteId, { runId: m.runId, resolved: m.identity.resolved, ambiguity: m.identity.ambiguity, athlete });
        await startResearchV2Shadow(ctx, athlete);
        return {
          run_id: m.runId, inserted: m.inserted.length, disputed: m.disputed, duplicates: m.duplicates, measured: measured.inserted,
          identity_resolved: m.identity.resolved, gaps: m.gaps.slice(0, 20).map((g) => g.slice(0, 200)), cost_micro_usd: m.costMicroUsd,
        };
      },
    },
    {
      name: "opening", kind: "model", leaseMs: 10 * 60_000, retry: { maxAttempts: 2 },
      run: async (ctx) => {
        const job = await jobCtx(ctx);
        const t = await onboardingTurnFn()(
          { store: dbStore, athleteId: job.athleteId, scope: ctx.runId, athlete: inputOf(ctx), connected: await connectedPlatforms(job.athleteId), budget: job.budget },
          { message: null, actions: [], reply: true, turnKey: "opening", phase: "ready", event: "Research is done. The Brief is still being written (insights come later): open with the reveal moment." },
        );
        return { run_id: t.runId, cards: t.cards.map((c) => c.kind) };
      },
    },
    {
      name: "understand", kind: "model", leaseMs: LONG, retry: { maxAttempts: 2 },
      run: async (ctx) => {
        const job = await jobCtx(ctx);
        const facts = await dbStore.listFacts(job.athleteId);
        const gaps = ((ctx.outputs.research_merge as { gaps?: string[] } | undefined)?.gaps) ?? [];
        // Held goals, when any exist (understand 1.11.0: the content direction may rest on them); none on a first Brief.
        const goals = await dbStore.listGoals(job.athleteId);
        // understand 1.13.0: her own agreed, accepted or signed deals in Nomila (usually none yet at sign-up).
        const nomilaDeals = await loadNomilaDeals(job.athleteId);
        // Her saved preferences, the same read the plan step makes (plan/sources.ts).
        const preferences = await listPreferences(job.athleteId);
        // understand 1.15.0: how the athlete's own posts did against their usual (null while the learning loop is off).
        const whatWorks = await (await import("../learning/db")).whatWorksIfOn(job.athleteId);
        // understand 1.16.0: the formats her playbook recommends per platform (none before a first Brief: no stage yet).
        const playbookFormats = await (await import("../playbook/read")).playbookFormatsForAthlete(job.athleteId);
        const u = await understand(job, { athlete: inputOf(ctx), facts, gaps, ageBand: ageBandFrom(facts), goals, nomilaDeals, preferences, whatWorks, playbookFormats });
        // The Brief is written: the plan step writes the recommended goals in its own run, beside the insights turn.
        // Onboarding never waits for it (goals are optional); a retried step joins the same run (idempotency key).
        // MILA_WELCOME: this FIRST plan is core sign-up service (registry first_plan), never optional: not gated on
        // plan_refresh, which covers the automatic refreshes after it. Its post kits still need post_ideas (plan/workflow.ts).
        const plan = await requestPlanRefresh(job.athleteId, { trigger: "event", reason: "the Brief was written", immediate: true, idempotencyKey: `plan:onboarding:${ctx.runId}` });
        return {
          run_id: u.runId, brief_id: u.brief.id, stage_band: u.stage.band, downgraded: u.downgraded, dropped_lines: u.droppedLines, cost_micro_usd: u.costMicroUsd,
          rate_ranges_saved: u.rateRangesSaved, dropped_ranges: u.droppedRanges, fee_redactions: u.feeRedactions, never_redactions: u.neverRedactions,
          plan_run_id: plan.started ? plan.runId : null,
        };
      },
    },
    {
      name: "mia_preview", kind: "model", parallel: true, leaseMs: 10 * 60_000,
      run: async (ctx) => {
        try {
          const p = await getMiaPreview(ctx.athleteId!, { trigger: "IDENTITY_RESOLVED", reason: `agent onboarding ${ctx.runId}` });
          return { status: p.status, computed: p.computed ?? null, score: p.score, preliminary: p.preliminary, ledger_entry_id: p.provenance?.ledgerEntryId ?? null };
        } catch (err: any) {
          logger.warn({ athleteId: ctx.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "agent onboarding: M.I.A. preview failed");
          return { status: "failed", error: String(err?.message ?? err).slice(0, 200) };
        }
      },
    },
    {
      name: "insights", kind: "model", leaseMs: 10 * 60_000, retry: { maxAttempts: 2 },
      run: async (ctx) => {
        const job = await jobCtx(ctx);
        const t = await onboardingTurnFn()(
          { store: dbStore, athleteId: job.athleteId, scope: ctx.runId, athlete: inputOf(ctx), connected: await connectedPlatforms(job.athleteId), budget: job.budget },
          { message: null, actions: [], reply: true, turnKey: "insights", event: "The Brief is ready. Share one or two early insights that prove value; pick up the conversation where it is." },
        );
        return { run_id: t.runId, cards: t.cards.map((c) => c.kind) };
      },
    },
    {
      name: "conversation",
      kind: "await_human",
      payload: async () => ({ asks: "onboarding_conversation" }),
      complete: async (ctx) => {
        const cp = await dbStore.getCheckpoints(ctx.athleteId!, ctx.runId);
        if (!allDone(cp)) throw new Error("onboarding checkpoints are not all met yet");
        return { completed_at: new Date().toISOString() };
      },
    },
    {
      name: "finish", kind: "code",
      run: async (ctx) => {
        const athleteId = ctx.athleteId!;
        const prefix = parentPrefixFor(ctx.runId);
        const cost = await dbStore.costByParentPrefix(athleteId, prefix);
        const turns = await dbStore.listRunsByPrefix(athleteId, turnPrefix(ctx.runId));
        // The path log: which checkpoints each turn completed, in order, so the onboarding skill can improve.
        const path: string[] = [];
        let before: Record<string, string> = {};
        for (const r of turns) {
          const t = (r.output as any)?.turn;
          if (!t) continue;
          const after = Object.fromEntries(Object.entries(t.checkpoints ?? {}).map(([k, v]: any) => [k, v.status]));
          const newly = Object.keys(after).filter((k) => after[k] === "done" && before[k] !== "done");
          path.push(`${t.turn}:${newly.join("+") || "-"}${t.pathNote ? ` (${String(t.pathNote).slice(0, 80)})` : ""}`);
          before = after;
        }
        logger.info({ athleteId, workflowRunId: ctx.runId, turns: turns.length, path, costUsd: cost.microUsd / 1e6, webSearchCalls: cost.webSearchCalls }, "agent onboarding finished");
        return { finished_at: new Date().toISOString(), turns: turns.length, cost_micro_usd: cost.microUsd, path: path.slice(0, 40) };
      },
    },
];

/** v1: kept for the runs that started on it (a run keeps its version; steps are never reordered inside one). */
export const AGENT_ONBOARDING = defineWorkflow({ process: AGENT_ONBOARDING_PROCESS, version: 1, steps: STEPS_V1 });

/** v2 (the default for new onboardings): the first moments scan runs between the reveal and Understand. */
const understandAt = STEPS_V1.findIndex((s) => s.name === "understand");
export const AGENT_ONBOARDING_V2 = defineWorkflow({
  process: AGENT_ONBOARDING_PROCESS, version: 2,
  steps: [...STEPS_V1.slice(0, understandAt), MOMENTS_STEP, ...STEPS_V1.slice(understandAt)],
});

/**
 * v3 (the default for new onboardings): the M.I.A. preview starts the moment research is merged, beside the reveal,
 * instead of waiting behind the reveal, the moments scan and the Brief. It reads only her FOUND and MEASURED facts
 * (services/miaPreview/memoryAdapter: no Brief, no dated moments, no said facts), all of which the merge has written,
 * so nothing it uses arrives later. With the runner running parallel siblings at once, the score is ready minutes
 * sooner; the reveal shows it as soon as it is ready, as before (turn.ts).
 */
const byName = (name: string) => STEPS_V1.find((s) => s.name === name)!;
/**
 * The research steps (both web-search passes and the merge), shared with the waitlist's research-only run
 * (signupResearchWorkflow.ts): the same code, the same skills, the same parent-ref idempotency and per-run cost cap.
 */
export const AGENT_RESEARCH_STEPS: readonly StepDef[] = [byName("research_a"), byName("research_b"), byName("research_merge")];
const MIA_BESIDE_REVEAL: StepDef = { ...byName("mia_preview"), parallel: true };
const UNDERSTAND_ALONE: StepDef = byName("understand");
export const AGENT_ONBOARDING_V3 = defineWorkflow({
  process: AGENT_ONBOARDING_PROCESS, version: 3,
  steps: [
    byName("research_a"), byName("research_b"), byName("research_merge"),
    byName("opening"), MIA_BESIDE_REVEAL,
    MOMENTS_STEP, UNDERSTAND_ALONE,
    byName("insights"), byName("conversation"), byName("finish"),
  ],
});

// ─── v4: reuse a fresh sign-up research ──────────────────────────────────────────────────────────────────────────────

/** SIGNUP_RESEARCH_FRESH_DAYS (default 30): how old a finished sign-up research may be and still be reused at launch. */
export function signupResearchFreshDays(): number {
  const n = Number(process.env.SIGNUP_RESEARCH_FRESH_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The same athlete and sport: the names share every token of the shorter one (as isAboutAthlete reads names), the sport is the same. */
export function sameAnchor(a: { name: string; sport: string }, b: { name: string; sport: string }): boolean {
  return !!norm(a.name) && !!norm(b.name) && isAboutAthlete({ kind: "athlete", name: a.name }, b.name) && norm(a.sport) === norm(b.sport);
}

export interface FreshSignupResearch { runId: string; mergedAt: string; merge: Record<string, unknown> }

/**
 * Her sign-up research (signup_research, the waitlist's agent run) that v4 may reuse instead of researching again: its
 * merge finished within SIGNUP_RESEARCH_FRESH_DAYS, for the same anchor (name and sport) this onboarding starts with.
 * Null otherwise (none, stale, still running, failed, or she changed her name or sport: research runs again).
 */
export async function freshSignupResearch(athleteId: string, anchor: { name: string; sport: string }, opts: { now?: Date; ignoreAge?: boolean } = {}): Promise<FreshSignupResearch | null> {
  const [run] = await db.select({ id: workflowRuns.id, input: workflowRuns.input }).from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, SIGNUP_RESEARCH_PROCESS), ne(workflowRuns.status, "canceled")))
    .orderBy(desc(workflowRuns.started_at)).limit(1);
  if (!run) return null;
  const input = (run.input ?? {}) as { name?: string; sport?: string };
  if (!input.name || !input.sport || !sameAnchor({ name: input.name, sport: input.sport }, anchor)) return null;
  const [merge] = await db.select({ output: workflowSteps.output, finished_at: workflowSteps.finished_at }).from(workflowSteps)
    .where(and(eq(workflowSteps.run_id, run.id), inArray(workflowSteps.step, [...RESEARCH_WRITTEN_STEPS]), eq(workflowSteps.status, "done")))
    .orderBy(desc(workflowSteps.attempt)).limit(1);
  if (!merge?.finished_at) return null;
  if (!opts.ignoreAge && (opts.now ?? new Date()).getTime() - merge.finished_at.getTime() > signupResearchFreshDays() * 86_400_000) return null;
  return { runId: run.id, mergedAt: merge.finished_at.toISOString(), merge: (merge.output ?? {}) as Record<string, unknown> };
}

/** A pass that reuses her fresh sign-up research when there is one (no model call, no cost), else runs as in v3. */
const reusingPass = (base: StepDef): StepDef => ({
  ...base,
  run: async (ctx) => {
    const reuse = await freshSignupResearch(ctx.athleteId!, inputOf(ctx));
    if (reuse) return { reused_from: reuse.runId, merged_at: reuse.mergedAt, facts: 0, dropped: 0, cost_micro_usd: 0 };
    return base.run!(ctx);
  },
});

/**
 * The merge, reusing: when BOTH passes reused the same sign-up research, her facts are already in memory (merged, the
 * identity outcome recorded), so this only brings her measured facts up to date (code, no model call) and hands on
 * that run's merge output (gaps, identity) for the Brief. The age is not re-checked here: the passes decided. Otherwise
 * the v3 merge.
 */
const REUSING_MERGE: StepDef = {
  ...byName("research_merge"),
  run: async (ctx) => {
    const from = (s: string) => (ctx.outputs[s] as { reused_from?: string } | undefined)?.reused_from ?? null;
    const a = from("research_a");
    const reuse = a && a === from("research_b") ? await freshSignupResearch(ctx.athleteId!, inputOf(ctx), { ignoreAge: true }) : null;
    if (!reuse || reuse.runId !== a) return byName("research_merge").run!(ctx);
    const athlete = inputOf(ctx);
    const channels = await loadConnectedChannels(ctx.athleteId!);
    const measured = await syncMeasured(dbStore, ctx.athleteId!, measuredFactsFrom(channels, athlete.name));
    return { ...reuse.merge, run_id: null, reused_from: reuse.runId, measured: measured.inserted, cost_micro_usd: 0 };
  },
};

/**
 * v4 (the default for new onboardings): v3, whose research steps REUSE a fresh sign-up research (the waitlist's
 * signup_research run, SIGNUP_RESEARCH_AGENT) instead of researching her again: a promoted waitlister neither pays twice
 * nor sees an empty greeting, because her facts and M.I.A. are already in memory (the mia_preview step then reuses the
 * evaluation for unchanged evidence: no new call). With no fresh sign-up research (none, older than
 * SIGNUP_RESEARCH_FRESH_DAYS, or a changed name or sport) it is exactly v3. v3 runs finish on v3.
 */
export const AGENT_ONBOARDING_V4 = defineWorkflow({
  process: AGENT_ONBOARDING_PROCESS, version: 4,
  steps: [
    reusingPass(byName("research_a")), reusingPass(byName("research_b")), REUSING_MERGE,
    byName("opening"), MIA_BESIDE_REVEAL,
    MOMENTS_STEP, UNDERSTAND_ALONE,
    byName("insights"), byName("conversation"), byName("finish"),
  ],
});
