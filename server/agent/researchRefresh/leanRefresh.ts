/**
 * agent/researchRefresh/leanRefresh.ts — a REFRESH of the athlete's research on the same lean pipeline sign-up uses
 * (agent/research/v2/lean.ts), asked for by Mila's refresh_research tool. Behind LEAN_SIGNUP_RESEARCH (off ⇒ nothing
 * starts and the tool is not offered).
 *
 * Process "lean_research_refresh":
 *   lean_research   lean research at the REFRESH moment (her record anchors identity; the plan aims at the topics asked
 *                   for, or at what her record covers least), verified facts kept with the same de-duplication and
 *                   identity rules as sign-up (onboarding/leanResearchStep.ts)
 *   mia_preview     the M.I.A. read through the one gated evaluation path (services/miaPreview getMiaPreview; its
 *                   evaluator call is skipped when her memory did not change)
 *
 * Guards (requestLeanRefresh), all checked before anything is started or spent:
 *   - identity open (an open "#identity" verdict, identityRecheck.ts): only topics ["identity"] run; any other topic is
 *     refused "identity_open" (researching everything on an unconfirmed identity buys the same "couldn't confirm");
 *   - one at a time: an active run is "already running";
 *   - per athlete: at most one per LEAN_REFRESH_MIN_HOURS (default 24) — unless she corrected, removed or disputed a fact
 *     since the last one started (memory_fact_reviews), which is exactly when a fresh look is worth it;
 *   - money: the existing research-refresh caps (researchRefresh/config.ts) — the run's budget is
 *     AGENT_RESEARCH_REFRESH_RUN_CAP_USD lowered to what is left of AGENT_RESEARCH_REFRESH_DAY_CAP_USD today, and no run
 *     starts while today's refresh spend plus one run's cap would pass the day cap. Every model call is keyed under
 *     "research_refresh:<run id>", the prefix the day cap sums;
 *   - the daily research cap (DAILY_RESEARCH_CAP_USD): a hard stop — the runner refuses a new run while today's research
 *     budget is spent or cannot be read (dailyCap.ts researchCapRefusal) ⇒ "daily_budget".
 * One run per athlete per day and correction state (the idempotency key), so a repeated tool call never starts twice.
 * An identity re-check on new evidence (identityRecheck.ts) comes through here too, with its own 24-hour window in place
 * of the per-athlete gap (opts.identityRecheck).
 */
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import { athletes, memoryFactReviews } from "../../../shared/schema";
import { workflowRuns } from "../../../shared/schemaWorkflow";
import { defineWorkflow } from "../../workflow/registry";
import type { DoneRun, StepCtx, StepDef } from "../../workflow/types";
import { createLogger } from "../../logger";
import { dbStore } from "../research/dbStore";
import { leanSignupResearchEnabled } from "../research/v2/lean";
import type { EvidenceAim } from "../research/v2/plan";
import { LEAN_RESEARCH_STEP_NAME, runLeanStep } from "../onboarding/leanResearchStep";
import { RESEARCH_REFRESH, RESEARCH_REFRESH_PARENT } from "./config";
import { todaySpendMicroUsd } from "./state";
import { hasOpenIdentityDispute, IDENTITY_RECHECK_CREATED_BY, IDENTITY_RECHECK_WINDOW_MS } from "./identityRecheck";

const logger = createLogger("agent/lean-refresh");

export const LEAN_REFRESH_PROCESS = "lean_research_refresh";

/** The topics the tool takes, and the evidence areas each one plans ([] = the identity queries only; null = all). */
export const LEAN_REFRESH_TOPICS = ["identity", "results_honours", "partners", "media", "upcoming", "all"] as const;
export type LeanRefreshTopic = (typeof LEAN_REFRESH_TOPICS)[number];
const TOPIC_AIMS: Record<LeanRefreshTopic, EvidenceAim[] | null> = {
  identity: [], results_honours: ["results", "honours"], partners: ["partners"], media: ["media"], upcoming: ["upcoming"], all: null,
};

/** Pure: topics → the evidence areas to plan (null: every area, steered by what her record covers least). */
export function aimsForTopics(topics: readonly LeanRefreshTopic[] | null | undefined): EvidenceAim[] | null {
  if (!topics?.length || topics.includes("all")) return null;
  return [...new Set(topics.flatMap((t) => TOPIC_AIMS[t] ?? []))];
}

/** LEAN_REFRESH_MIN_HOURS (default 24): the shortest gap between two refreshes for one athlete without a correction. */
export function leanRefreshMinHours(): number {
  const n = Number(process.env.LEAN_REFRESH_MIN_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

const prefixFor = (runId: string) => `${RESEARCH_REFRESH_PARENT}:${runId}`;

async function budgetCap(athleteId: string, prefix: string, now = new Date()): Promise<number> {
  const spent = (await dbStore.costByParentPrefix(athleteId, prefix)).microUsd;
  const dayLeft = Math.max(0, RESEARCH_REFRESH.DAY_CAP_MICRO_USD - (await todaySpendMicroUsd(now)));
  return Math.min(RESEARCH_REFRESH.RUN_CAP_MICRO_USD, spent + dayLeft);
}

const LEAN_REFRESH_STEP: StepDef = {
  name: LEAN_RESEARCH_STEP_NAME, kind: "model", leaseMs: 20 * 60_000, retry: { maxAttempts: 2 },
  run: async (ctx: StepCtx) => {
    const prefix = prefixFor(ctx.runId);
    const aims = ((ctx.runInput ?? {}) as { aims?: EvidenceAim[] | null }).aims ?? null;
    return runLeanStep(ctx, { moment: "refresh", parentPrefix: prefix, capMicroUsd: await budgetCap(ctx.athleteId!, prefix), aims });
  },
};

const MIA_STEP: StepDef = {
  name: "mia_preview", kind: "model", leaseMs: 10 * 60_000,
  run: async (ctx) => {
    try {
      const { getMiaPreview } = await import("../../services/miaPreview/preview");
      const p = await getMiaPreview(ctx.athleteId!, { trigger: "USER_REQUESTED_REFRESH", reason: `lean research refresh ${ctx.runId}` });
      return { status: p.status, computed: p.computed ?? null, score: p.score };
    } catch (err: any) {
      logger.warn({ athleteId: ctx.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "lean refresh: M.I.A. preview failed");
      return { status: "failed", error: String(err?.message ?? err).slice(0, 200) };
    }
  },
};

/**
 * Once the run is done, Mila is told at the top of the athlete's next message that the refresh finished
 * and how many facts it saved (agent/engine/events.ts; nothing while MILA_TF_CHAT is off). Never throws.
 */
export const leanRefreshOnDone = (run: DoneRun): Promise<void> =>
  import("../engine/events")
    .then(({ noteResearchDone }) => noteResearchDone(LEAN_REFRESH_PROCESS, { runId: run.runId, athleteId: run.athleteId, outputs: run.outputs as Record<string, unknown> }))
    .then(() => undefined, () => undefined);

export const LEAN_RESEARCH_REFRESH = defineWorkflow({ process: LEAN_REFRESH_PROCESS, version: 1, steps: [LEAN_REFRESH_STEP, MIA_STEP], onDone: leanRefreshOnDone });

export type LeanRefreshRequest =
  | { started: true; runId: string; topics: LeanRefreshTopic[] }
  | { started: false; reason: "off" | "no_anchor" | "identity_open" | "error" }
  | { started: false; reason: "already_running"; runId: string }
  | { started: false; reason: "rate_limited" | "daily_budget"; nextAllowedAt: string };

export interface LeanRefreshDeps { now?: Date; kick?: (runId: string) => void }

/** Pure: the topics ask for the identity check only (the one refresh that runs while her identity is open). */
export const identityOnly = (topics: readonly LeanRefreshTopic[]): boolean => topics.length > 0 && topics.every((t) => t === "identity");

export interface LeanRefreshOptions {
  /**
   * An identity re-check on new evidence (identityRecheck.ts requestIdentityRecheck, which has already applied its own
   * guards: the fence, an open identity, the 24-hour window, the daily sign-up research cap). The topics must be
   * ["identity"]. The tool's per-athlete gap does not apply (her new evidence is the reason to look again); one run at
   * a time and the refresh day cap still do. Created by "identity_recheck", keyed by `idempotencyKey`.
   */
  identityRecheck?: { idempotencyKey: string; evidence: string };
}

/** Ask for a lean research refresh for this athlete, under the guards above. Never throws (an error is reason "error"). */
export async function requestLeanRefresh(athleteId: string, topics: LeanRefreshTopic[] = ["all"], deps: LeanRefreshDeps = {}, opts: LeanRefreshOptions = {}): Promise<LeanRefreshRequest> {
  if (!leanSignupResearchEnabled()) return { started: false, reason: "off" };
  const now = deps.now ?? new Date();
  const recheck = opts.identityRecheck && identityOnly(topics) ? opts.identityRecheck : null;
  try {
    const [a] = await db.select({ name: athletes.full_name, sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    const name = a?.name?.replace(/\s+/g, " ").trim();
    const sport = a?.sport?.replace(/\s+/g, " ").trim();
    if (!name || !sport) return { started: false, reason: "no_anchor" };
    // Her identity is open (an open "#identity" verdict): only the identity check runs (identityRecheck.ts).
    if (!identityOnly(topics) && await hasOpenIdentityDispute(athleteId)) return { started: false, reason: "identity_open" };

    const [last] = await db.select({ id: workflowRuns.id, status: workflowRuns.status, startedAt: workflowRuns.started_at }).from(workflowRuns)
      .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, LEAN_REFRESH_PROCESS), ne(workflowRuns.status, "canceled")))
      .orderBy(desc(workflowRuns.started_at)).limit(1);
    if (last && (last.status === "running" || last.status === "waiting")) return { started: false, reason: "already_running", runId: last.id };
    // Corrections since the last refresh started lift the per-athlete limit (and key a new run).
    const [corrected] = last && !recheck ? await db.select({ id: memoryFactReviews.id }).from(memoryFactReviews)
      .where(and(eq(memoryFactReviews.athlete_id, athleteId), inArray(memoryFactReviews.action, ["correct", "remove", "dispute"]), gt(memoryFactReviews.created_at, last.startedAt)))
      .orderBy(desc(memoryFactReviews.created_at)).limit(1) : [];
    const gapMs = recheck ? IDENTITY_RECHECK_WINDOW_MS : leanRefreshMinHours() * 3_600_000;
    if (!recheck && last && !corrected && now.getTime() - last.startedAt.getTime() < gapMs) {
      return { started: false, reason: "rate_limited", nextAllowedAt: new Date(last.startedAt.getTime() + gapMs).toISOString() };
    }
    if ((await todaySpendMicroUsd(now)) + RESEARCH_REFRESH.RUN_CAP_MICRO_USD > RESEARCH_REFRESH.DAY_CAP_MICRO_USD) {
      const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      return { started: false, reason: "daily_budget", nextAllowedAt: midnight.toISOString() };
    }
    const { startRun } = await import("../../workflow/runner");
    const day = now.toISOString().slice(0, 10);
    const { run, created } = await startRun({
      process: LEAN_REFRESH_PROCESS, athleteId, createdBy: recheck ? IDENTITY_RECHECK_CREATED_BY : "mila_refresh_research", kick: false,
      idempotencyKey: recheck ? recheck.idempotencyKey : `${LEAN_REFRESH_PROCESS}:${athleteId}:${day}:${corrected?.id ?? "-"}`,
      input: { name, sport, topics, aims: aimsForTopics(topics), ...(recheck ? { trigger: IDENTITY_RECHECK_CREATED_BY, evidence: recheck.evidence.slice(0, 40) } : {}) },
    });
    if (!created) {
      if (run.status === "running" || run.status === "waiting") return { started: false, reason: "already_running", runId: run.id };
      return { started: false, reason: "rate_limited", nextAllowedAt: new Date(run.started_at.getTime() + gapMs).toISOString() };
    }
    (deps.kick ?? kickInBackground)(run.id);
    return { started: true, runId: run.id, topics };
  } catch (err: any) {
    // The daily research cap's hard stop (the runner refuses; dailyCap.ts researchCapRefusal): nothing started.
    if (err?.code === "daily_research_cap") return { started: false, reason: "daily_budget", nextAllowedAt: String(err.nextAllowedAt) };
    logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "lean refresh: not started");
    return { started: false, reason: "error" };
  }
}

function kickInBackground(runId: string): void {
  void import("../../workflow/runner")
    .then(({ kick }) => kick(runId))
    .catch((err: any) => logger.warn({ runId, error: String(err?.message ?? err).slice(0, 200) }, "background kick failed: the tick will run it"));
}
