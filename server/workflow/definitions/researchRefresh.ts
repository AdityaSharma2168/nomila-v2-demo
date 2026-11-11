/**
 * research_refresh — a deliberate re-run of web research for one athlete.
 *
 * Started by the admin dashboard's "re-research" (promotion no longer researches; signup
 * does). The monthly re-enrich sweep moves onto this process in PR 4. Same skill as the
 * onboarding research step, trigger 'manual', handles scoped the same way.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { athletes } from "../../../shared/schema";
import { buildSearchName, researchAthlete } from "../../skills/researchAthlete";
import { createLogger } from "../../logger";
import { defineWorkflow } from "../registry";
import { collectKnownHandles } from "./onboarding";
import { searchInputsFor } from "../../services/intelligence/context/searchInputs";
import { runResearchRefresh, runResearchRefreshV3Query, runResearchRefreshV3Read, runResearchRefreshV3Signals } from "../../skills/researchRefresh";
import type { RefreshRunInput } from "../../services/intelligence/research/refresh";
import { resolveV3Plan, type V3QueryOutput, type V3RunInput } from "../../services/intelligence/research/v3Stage";
import { QUERY_IDS, type QueryId } from "../../services/intelligence/research/spec/researchSpecV1";
import type { StepCtx } from "../types";
import { requestIdentityRefresh } from "../../services/intelligence/identityIntelligence/refresh";

/** A finished refresh may change what My Story rests on; Identity Intelligence's input hash decides whether it did. */
const researchDone = async (run: { athleteId: string | null }): Promise<void> => { if (run.athleteId) await requestIdentityRefresh(run.athleteId, "research refreshed"); };

const logger = createLogger("research-refresh");

export const RESEARCH_REFRESH = defineWorkflow({
  process: "research_refresh",
  version: 1,
  onDone: researchDone,
  steps: [
    {
      name: "research",
      kind: "model",
      leaseMs: 3 * 60_000,
      retry: { maxAttempts: 2 },
      run: async (ctx) => {
        const athleteId = ctx.athleteId!;
        const [a] = await db.select({ full_name: athletes.full_name, school: athletes.school, sport: athletes.sport })
          .from(athletes).where(eq(athletes.id, athleteId)).limit(1);
        if (!a) throw new Error(`Athlete ${athleteId} not found`);
        // The projection anchor + collectKnownHandles.
        const inputs = await searchInputsFor(athleteId, { anchor: buildSearchName(a), handles: await collectKnownHandles(athleteId) });
        const result = await researchAthlete(athleteId, inputs.anchor, "manual", { handles: inputs.handles });
        return { snapshot_id: result.snapshotId };
      },
    },
  ],
});


/**
 * research_refresh v2 — Phase A Step 2b: ONE planner-driven domain refresh (design §4.4). Started only
 * by the nightly planner (createdBy 'schedule', idempotency key research_refresh:<athlete>:<UTC day>)
 * with the planned domains as input. v1 above stays the admin path while the execution gate is false
 * (admin pins version 1). The step throws on failure so the runner retries once, then fails the run.
 */
export const RESEARCH_REFRESH_V2 = defineWorkflow({
  process: "research_refresh",
  version: 2,
  onDone: researchDone,
  steps: [
    {
      name: "refresh",
      kind: "model",
      leaseMs: 5 * 60_000,
      retry: { maxAttempts: 2 },
      run: async (ctx) => {
        const input = (ctx.runInput ?? {}) as RefreshRunInput;
        const r = await runResearchRefresh({ athleteId: ctx.athleteId!, workflowRunId: ctx.runId, domains: input.domains ?? [], full: input.full ?? false, trigger: input.trigger ?? "manual", reason: input.reason ?? null, dueToDispute: input.dueToDispute ?? [] });
        if (!r.ok) throw new Error(r.error ?? "research refresh failed");

        // RESEARCH_REFRESHED IS RECORDED AND IGNORED FOR BETA.1 — a decision, logged so it is visible rather than an
        // absence someone later reads as an oversight. The M.I.A. evaluator performs its OWN grounded research and
        // never reads Nomila's research substrate (see the evaluator spec), so a refresh here changes nothing the
        // evaluator would see. Triggering on it would spend ~$0.21 re-sampling a non-deterministic model against
        // identical input, and the digest would skip it anyway.
        //
        // If the evaluator is ever given our research as supplied evidence, this becomes a real trigger and the line
        // below is where it starts.
        logger.info({ athleteId: ctx.athleteId, researchRunId: r.researchRunId, miaTriggered: false, reason: "evaluator performs its own grounded research (Beta.1)" }, "RESEARCH_REFRESHED recorded, MIA not triggered");

        return { research_run_id: r.researchRunId, status: r.status, outcomes: r.outcomes ?? {}, reused: r.reused ?? false, miaTriggered: false };
      },
    },
  ],
});

/**
 * research_refresh v3 — PR E2a (design record docs/architecture/phase-a/pr-e-identity-resolution-design.md §5): the
 * direct binding (RESEARCH_REFRESH_PROVIDER=direct). OPT-IN: a caller that omits the version keeps getting v2; nothing
 * starts v3 in E2a (the lifecycle trigger and the planner's version-by-binding are E2b).
 *
 * Seven static, SEQUENTIAL steps (D16): q1 … q6 (one research-spec/1 query each, persisted on its own research_runs
 * row) and `signals` (v2's Trends/GDELT lane, unchanged, D13) LAST, after the gate. A step that must not run completes
 * with `{ skipped: "not_planned" | "identity_gate" | "all_platforms_connected" }`; it never cancels the run. Q1 is the
 * identity gate: q2 … q6 and signals read the determination fresh and, when the run governs identity and it is not
 * `resolved`, hold their domains in `pending` (D18) without a row or a provider call.
 *
 * Lease: one query's worst case is 3 attempts × the 60 s per-call timeout + ≈ 4 s back-off ≈ 184 s (policy.ts), under
 * the 5-min lease; a lapse re-claims the step and the stage reuses (workflow_run_id, query_id). Provider trouble never
 * throws (a failed Q2 does not fail Q3–Q6); a refused execution gate or binding throws, like v2, so nothing is called.
 */
export const V3_QUERY_STEPS: ReadonlyArray<{ step: string; queryId: QueryId }> = QUERY_IDS.map((queryId) => ({ step: queryId.toLowerCase(), queryId }));
export const V3_STEP_LEASE_MS = 5 * 60_000;
/**
 * The read step's lease: RESEARCH_TARGETED_READ_MAX_ATTEMPTS (default 5) single-attempt reads × the 60 s per-call timeout = 300 s,
 * plus bounded URL work before the calls (≤ 15 grounding-redirect resolutions and ≤ 8 YouTube oEmbed checks, 5 s timeout each) ≈ 415 s.
 */
export const V3_READ_LEASE_MS = 9 * 60_000;

const priorOutputs = (ctx: StepCtx): V3QueryOutput[] => V3_QUERY_STEPS.map((s) => ctx.outputs[s.step] as V3QueryOutput | undefined).filter((o): o is V3QueryOutput => !!o && typeof o === "object" && "queryId" in o);
const v3Args = (ctx: StepCtx) => ({ athleteId: ctx.athleteId!, workflowRunId: ctx.runId, plan: resolveV3Plan(ctx.runInput as V3RunInput), prior: priorOutputs(ctx) });
const refusedThrows = (o: V3QueryOutput): V3QueryOutput => { if (o.status === "refused" && !o.ran) throw new Error(o.error ?? "research_refresh v3 refused"); return o; };

export const RESEARCH_REFRESH_V3 = defineWorkflow({
  process: "research_refresh",
  version: 3,
  onDone: researchDone,
  steps: [
    ...V3_QUERY_STEPS.map(({ step, queryId }) => ({
      name: step,
      kind: "model" as const,
      leaseMs: V3_STEP_LEASE_MS,
      retry: { maxAttempts: 2 },
      run: async (ctx: StepCtx) => refusedThrows(await runResearchRefreshV3Query(v3Args(ctx), queryId)),
    })),
    {
      name: "signals",
      kind: "code",
      leaseMs: V3_STEP_LEASE_MS,
      retry: { maxAttempts: 2 },
      run: async (ctx: StepCtx) => refusedThrows(await runResearchRefreshV3Signals(v3Args(ctx))),
    },
    // Identity sources (appended, never reordered): the capped targeted source read over THIS run's athlete_media sources.
    // Up to RESEARCH_TARGETED_READ_MAX successful reads (default 3) within RESEARCH_TARGETED_READ_MAX_ATTEMPTS single-attempt
    // calls (default 5) × the 60 s per-call timeout, plus bounded URL resolution: V3_READ_LEASE_MS.
    {
      name: "read",
      kind: "model",
      leaseMs: V3_READ_LEASE_MS,
      retry: { maxAttempts: 2 },
      run: async (ctx: StepCtx) => refusedThrows(await runResearchRefreshV3Read(v3Args(ctx))),
    },
  ],
}, { optIn: true });
