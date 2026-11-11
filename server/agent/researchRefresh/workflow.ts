/**
 * agent/researchRefresh/workflow.ts — the PERIODIC REFRESH of the agent's research, as a durable workflow (the existing
 * Postgres runner). The same research the onboarding runs, again, on what we hold now:
 *
 *   research_a ┐  two independent web-search passes (jobs/research.md), IN PARALLEL, each told what she has said
 *   research_b ┘  (said facts anchor identity) — unchanged skill, unchanged input shape
 *   research_merge   merge (jobs/research/merge.md) against EVERY fact we already hold: a duplicate is skipped, a
 *                    conflict is written disputed, and what she SAID is never overwritten or disputed (research.ts
 *                    mergePasses); measured facts from her connected accounts are re-synced (a newer reading supersedes
 *                    the older one); an unresolved identity is kept as a disputed "#identity" fact (holds M.I.A.)
 *   understand       a new Brief from the facts now held (jobs/understand.md 1.12.0), with her CURRENT Brief as an
 *                    input: its strategy (thesis, positioning, pillars, narrative) is carried forward unchanged; the
 *                    fact sections refresh. When the facts MATERIALLY changed the strategy, Understand's new strategy is
 *                    stored as ONE suggestion (proposal.ts) and announced — a Mila message with the card, Home's row,
 *                    one push. Nothing in her strategy changes until she taps. Skipped when she holds no facts.
 *   mia_preview      beside understand: M.I.A. read through the memory adapter (services/miaPreview getMiaPreview —
 *                    the one gated mia_evaluation path; its evaluator call is skipped when her memory did not change)
 *   finish           records the identity anchor (name, sport, team) after the merge, and the refresh's cost
 *
 * Provenance is the merge's: research writes `found` facts with their sources; `said` (hers) and `made` (Nomila's) are
 * never rewritten here. Every model run is keyed "research_refresh:<workflow run id>:<step>", so a retried step reuses a
 * finished run (never pays twice) and the day cap can sum every refresh's spend.
 *
 * Who: athletes chosen by sweep.ts (stale, or her anchor changed), or one athlete on an operator's request. It covers
 * athletes who never onboarded through the agent: for them the first refresh is their first agent research, and from
 * then on M.I.A. reads them through the memory adapter like every agent athlete.
 */
import { defineWorkflow } from "../../workflow/registry";
import type { StepCtx, StepDef } from "../../workflow/types";
import { createLogger } from "../../logger";
import { dbStore } from "../research/dbStore";
import { connectedSummaryText, loadConnectedChannels, measuredFactsFrom, partnerPosts } from "../research/connected";
import { mergePasses, recordIdentityOutcome, searchPass, syncMeasured, type JobContext } from "../research/research";
import { understand } from "../research/understand";
import { loadNomilaDeals } from "../research/nomilaDeals";
import { listPreferences } from "../memory";
import { ageBandFrom } from "../ageBand";
import { getMiaPreview } from "../../services/miaPreview/preview";
import { RESEARCH_REFRESH, RESEARCH_REFRESH_PARENT, RESEARCH_REFRESH_PROCESS } from "./config";
import { currentAnchor, todaySpendMicroUsd } from "./state";
import { announceProposal, storeProposal } from "./proposal";

const logger = createLogger("agent/research-refresh");

export interface ResearchRefreshInput { name: string; sport: string; trigger: "schedule" | "anchor" | "manual"; reason: string }

export const refreshPrefixFor = (workflowRunId: string) => `${RESEARCH_REFRESH_PARENT}:${workflowRunId}`;

const inputOf = (ctx: StepCtx): ResearchRefreshInput => {
  const i = (ctx.runInput ?? {}) as Partial<ResearchRefreshInput>;
  if (!i.name || !i.sport) throw new Error("agent_research_refresh needs a name and a sport");
  return { name: i.name, sport: i.sport, trigger: i.trigger ?? "manual", reason: i.reason ?? "" };
};

/**
 * The job context with its budget: this refresh's cap, lowered to what is left of today's cap for all refreshes. Once
 * either is reached every model call is refused (runSkill's CostCapError) — the step fails, nothing is written.
 */
export async function refreshJob(ctx: StepCtx, now = new Date()): Promise<JobContext> {
  const athleteId = ctx.athleteId!;
  const prefix = refreshPrefixFor(ctx.runId);
  const spent = (await dbStore.costByParentPrefix(athleteId, prefix)).microUsd;
  const dayLeft = Math.max(0, RESEARCH_REFRESH.DAY_CAP_MICRO_USD - (await todaySpendMicroUsd(now)));
  return { store: dbStore, athleteId, parentPrefix: prefix, budget: { spentMicroUsd: spent, capMicroUsd: Math.min(RESEARCH_REFRESH.RUN_CAP_MICRO_USD, spent + dayLeft) } };
}

async function pass(ctx: StepCtx, which: "a" | "b") {
  const job = await refreshJob(ctx);
  const { name, sport } = inputOf(ctx);
  const channels = await loadConnectedChannels(job.athleteId);
  const existing = await dbStore.listFacts(job.athleteId, ["active", "disputed"]);
  const r = await searchPass(job, { pass: which, athlete: { name, sport }, connectedSummary: connectedSummaryText(channels), existing });
  return { run_id: r.runId, facts: r.facts.length, dropped: r.dropped.length, cost_micro_usd: r.costMicroUsd };
}

const LONG = 25 * 60_000;

const STEPS: StepDef[] = [
  { name: "research_a", kind: "model", leaseMs: LONG, retry: { maxAttempts: 2 }, run: (ctx) => pass(ctx, "a") },
  { name: "research_b", kind: "model", leaseMs: LONG, retry: { maxAttempts: 2 }, parallel: true, run: (ctx) => pass(ctx, "b") },
  {
    name: "research_merge", kind: "model", leaseMs: LONG, retry: { maxAttempts: 2 },
    run: async (ctx) => {
      const job = await refreshJob(ctx);
      const { name, sport } = inputOf(ctx);
      const athlete = { name, sport };
      const channels = await loadConnectedChannels(job.athleteId);
      const measured = await syncMeasured(dbStore, job.athleteId, measuredFactsFrom(channels, name));
      const existing = await dbStore.listFacts(job.athleteId, ["active", "disputed"]);
      const summary = connectedSummaryText(channels);
      // The passes are finished runs: these calls reuse them (no model call, no cost).
      const a = await searchPass(job, { pass: "a", athlete, connectedSummary: summary, existing });
      const b = await searchPass(job, { pass: "b", athlete, connectedSummary: summary, existing });
      const m = await mergePasses(job, { athlete, a, b, existing, posts: partnerPosts(channels) });
      await recordIdentityOutcome(dbStore, job.athleteId, { runId: m.runId, resolved: m.identity.resolved, ambiguity: m.identity.ambiguity, athlete });
      return {
        run_id: m.runId, inserted: m.inserted.length, disputed: m.disputed, duplicates: m.duplicates, measured: measured.inserted,
        identity_resolved: m.identity.resolved, gaps: m.gaps.slice(0, 20).map((g) => g.slice(0, 200)), cost_micro_usd: m.costMicroUsd,
      };
    },
  },
  {
    name: "understand", kind: "model", leaseMs: LONG, retry: { maxAttempts: 2 },
    run: async (ctx) => {
      const job = await refreshJob(ctx);
      const facts = await dbStore.listFacts(job.athleteId);
      if (!facts.length) return { status: "skipped", reason: "no facts held" };
      const gaps = ((ctx.outputs.research_merge as { gaps?: string[] } | undefined)?.gaps) ?? [];
      const goals = await dbStore.listGoals(job.athleteId);
      const { name, sport } = inputOf(ctx);
      // Her current Brief is carried forward (absent for an athlete with no Brief yet: a first Brief, as at onboarding).
      const carry = await dbStore.currentBrief(job.athleteId);
      // understand 1.13.0: her own agreed, accepted or signed deals in Nomila; the Brief refreshes her suggested rates.
      const nomilaDeals = await loadNomilaDeals(job.athleteId);
      // Her saved preferences, the same read the plan step makes (plan/sources.ts).
      const preferences = await listPreferences(job.athleteId);
      // understand 1.15.0: how the athlete's own posts did against their usual (null while the learning loop is off).
      const whatWorks = await (await import("../learning/db")).whatWorksIfOn(job.athleteId);
      // understand 1.16.0: the formats her playbook recommends on each platform she is on, so every one gets a range.
      const playbookFormats = await (await import("../playbook/read")).playbookFormatsForAthlete(job.athleteId);
      const u = await understand(job, { athlete: { name, sport }, facts, gaps, ageBand: ageBandFrom(facts), goals, carry, nomilaDeals, preferences, whatWorks, playbookFormats });
      let suggestion: { decision_id: string | null; status: string } = { decision_id: null, status: "none" };
      if (u.proposal) {
        const s = await storeProposal(dbStore, job.athleteId, { understandRunId: u.runId, workflowRunId: ctx.runId, draft: u.proposal });
        if (s.stored) {
          await announceProposal(dbStore, job.athleteId, s.decisionId);
          suggestion = { decision_id: s.decisionId, status: s.created ? "suggested" : "already_suggested" };
        } else suggestion = { decision_id: null, status: s.reason };
      }
      return {
        run_id: u.runId, brief_id: u.brief.id, stage_band: u.stage.band, carried: !!u.carried, downgraded: u.downgraded, dropped_lines: u.droppedLines,
        cost_micro_usd: u.costMicroUsd, suggestion,
        rate_ranges_saved: u.rateRangesSaved, dropped_ranges: u.droppedRanges, fee_redactions: u.feeRedactions, never_redactions: u.neverRedactions,
      };
    },
  },
  {
    name: "mia_preview", kind: "model", parallel: true, leaseMs: 10 * 60_000,
    run: async (ctx) => {
      try {
        const p = await getMiaPreview(ctx.athleteId!, { trigger: "USER_REQUESTED_REFRESH", reason: `agent research refresh ${ctx.runId}` });
        return { status: p.status, computed: p.computed ?? null, score: p.score, ledger_entry_id: p.provenance?.ledgerEntryId ?? null };
      } catch (err: any) {
        logger.warn({ athleteId: ctx.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "research refresh: M.I.A. preview failed");
        return { status: "failed", error: String(err?.message ?? err).slice(0, 200) };
      }
    },
  },
  {
    name: "finish", kind: "code",
    run: async (ctx) => {
      const athleteId = ctx.athleteId!;
      const cost = await dbStore.costByParentPrefix(athleteId, refreshPrefixFor(ctx.runId));
      const anchor = await currentAnchor(athleteId);
      const { trigger, reason } = inputOf(ctx);
      logger.info({ athleteId, workflowRunId: ctx.runId, trigger, reason, costUsd: cost.microUsd / 1e6, webSearchCalls: cost.webSearchCalls }, "agent research refresh finished");
      return { finished_at: new Date().toISOString(), anchor, cost_micro_usd: cost.microUsd, web_search_calls: cost.webSearchCalls };
    },
  },
];

/**
 * MILA_WELCOME: the monthly (schedule) refresh is the optional profile_refresh capability. Every step checks the
 * athlete's choice again when it RUNS, so turning it off stops a refresh already queued or part done (no further model
 * call, nothing written). Anchor and manual refreshes are data upkeep and operator runs: never gated. Transparent while
 * the flag is off.
 */
function gated(step: StepDef): StepDef {
  if (!step.run) return step;
  const run = step.run;
  return {
    ...step,
    run: async (ctx) => {
      if ((ctx.runInput as Partial<ResearchRefreshInput> | null)?.trigger === "schedule" && ctx.athleteId) {
        const { jobAllowed } = await import("../welcome/gate");
        if (!(await jobAllowed("profile_refresh", ctx.athleteId))) return { status: "skipped", reason: "not_chosen" };
      }
      return run(ctx);
    },
  };
}

export const AGENT_RESEARCH_REFRESH = defineWorkflow({ process: RESEARCH_REFRESH_PROCESS, version: 1, steps: STEPS.map(gated) });
