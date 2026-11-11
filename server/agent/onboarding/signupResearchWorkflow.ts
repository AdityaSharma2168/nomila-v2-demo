/**
 * agent/onboarding/signupResearchWorkflow.ts — the waitlist sign-up's RESEARCH-ONLY agent run (process
 * "signup_research"), behind SIGNUP_RESEARCH_AGENT (off by default; signupResearch.ts startSignupAgentResearch is the
 * only start).
 *
 *   research_a ┐  the agent onboarding's own two web-search passes (workflow.ts AGENT_RESEARCH_STEPS: same code, same
 *   research_b ┘  skills, same per-run cost cap AGENT_ONBOARDING_COST_CAP_USD)
 *   research_merge   merge + measured facts from any connected account + the identity outcome, into her memory
 *   mia_preview      the M.I.A. score from those facts (services/miaPreview, the same evaluator as the onboarding's
 *                    step); held while research left her identity disputed. Never fails the run.
 *   quick_score      (v3, opt-in: QUICK_SCORE_ONE_CALL) beside the two passes: ONE web-searching call (OpenAI web search) with the existing
 *                    search-enabled M.I.A. prompt → a quick score she sees in about a minute (services/quickScore). The
 *                    passes, merge, mia_preview and email below are unchanged; it never fails the run.
 *   lean_research    (v4, opt-in: LEAN_SIGNUP_RESEARCH) in place of research_a / research_b / research_merge: lean
 *                    research (Wikidata, then OpenAI web search, our own fetch, extract-all, identity, verify) with its
 *                    verified facts kept in her memory (onboarding/leanResearchStep.ts)
 *   score_email      (v2) once her score has landed: the "your M.I.A. score is ready" email, ONCE (the step runs once
 *                    per run, and the run once per athlete), only while she is still waitlisted, through the existing
 *                    sender (lib/notify: Gmail when EMAIL_PROVIDER=gmail; off ⇒ logged, never sent). Never fails the run.
 *                    When she was already shown a quick score (v3/v4), it is the "your FULL score is ready" email
 *                    instead (WAITLIST_TEMPLATES.fullScoreReady): the full score has replaced the quick one.
 *
 * Nothing else: no reveal, no Brief, no turns. Those happen when she is let in: agent_onboarding v4 reuses this run's
 * facts at her first app launch instead of researching her again. Each model step reuses a finished agent run with the
 * same parent ref (workflow:<runId>), so a retried step never pays twice. The run ends `done`, so it reserves nothing on
 * the daily cap afterwards (dailyCap.ts inFlightCount).
 */
import { defineWorkflow } from "../../workflow/registry";
import type { DoneRun, StepDef } from "../../workflow/types";
import { createLogger } from "../../logger";
import { getMiaPreview } from "../../services/miaPreview/preview";
import { SIGNUP_RESEARCH_PROCESS } from "./dailyCap";
import { AGENT_RESEARCH_STEPS, budgetedPassStep, onboardingCostCapMicroUsd, parentPrefixFor } from "./workflow";
import { LEAN_RESEARCH_STEP_NAME, runLeanStep } from "./leanResearchStep";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { athletes } from "../../../shared/schema";
import { sendTemplate } from "../../services/notify/templates/send";
import { WAITLIST_TEMPLATES, waitlistPageUrl } from "../../services/notify/templates/waitlist";
import { QUICK_SCORE_STEP } from "../../services/quickScore/step";
import { isPlatformCapError } from "../../lib/platformSpend";

const logger = createLogger("agent/onboarding/signup-research");

export { SIGNUP_RESEARCH_PROCESS };

export const SIGNUP_MIA_STEP: StepDef = {
  name: "mia_preview", kind: "model", leaseMs: 10 * 60_000,
  run: async (ctx) => {
    try {
      const p = await getMiaPreview(ctx.athleteId!, { trigger: "IDENTITY_RESOLVED", reason: `signup research ${ctx.runId}` });
      return { status: p.status, computed: p.computed ?? null, score: p.score, preliminary: p.preliminary, ledger_entry_id: p.provenance?.ledgerEntryId ?? null };
    } catch (err: any) {
      // The platform day cap's refusal is rethrown: the runner HOLDS this step (it runs again when there is room).
      if (isPlatformCapError(err)) throw err;
      logger.warn({ athleteId: ctx.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "signup research: M.I.A. preview failed");
      return { status: "failed", error: String(err?.message ?? err).slice(0, 200) };
    }
  },
};

/**
 * Every version, once the run is done: Mila is told at the top of the athlete's next message that research
 * finished (agent/engine/events.ts; nothing while MILA_TF_CHAT is off or before the athlete has a Mila conversation).
 * Never throws; a dynamic import keeps the chat module out of this workflow's load.
 */
export const signupResearchOnDone = (run: DoneRun): Promise<void> =>
  import("../engine/events")
    .then(({ noteResearchDone }) => noteResearchDone(SIGNUP_RESEARCH_PROCESS, { runId: run.runId, athleteId: run.athleteId, outputs: run.outputs as Record<string, unknown> }))
    .then(() => undefined, () => undefined);

export const SIGNUP_RESEARCH = defineWorkflow({
  process: SIGNUP_RESEARCH_PROCESS, version: 1,
  steps: [...AGENT_RESEARCH_STEPS, SIGNUP_MIA_STEP],
  onDone: signupResearchOnDone,
});

/**
 * Whether her run showed her a quick score (the quick_score step's output is a card the landing could show: ready). A
 * disputed identity never reaches the email (no full score), so it needs no check here.
 */
export async function quickScoreWasShown(output: unknown): Promise<boolean> {
  if ((output as { status?: unknown } | null | undefined)?.status !== "ready") return false;
  const { quickScoreFrom } = await import("./waitlistProgress");
  return quickScoreFrom(output) !== null;
}

/** How many times the email step looks again for a score still being computed (about 40 minutes in all). */
export const SCORE_EMAIL_ATTEMPTS = 6;

/**
 * The score-ready email (v2). Sends only when her score is ready, she is still waitlisted and has an address, and this
 * deployment can send (scoreEmailEnabled: delivery on, and a landing link; outside production only with LANDING_URL
 * set). A score the mia_preview step left IN FLIGHT (its evaluation still retrying) is looked up again: the step throws
 * so the runner retries it later (backoff from 2 minutes), up to SCORE_EMAIL_ATTEMPTS, then gives up quietly. The
 * outcome is the step's output (sent / skipped / why), so an operator can see it on the run.
 */
export const SCORE_EMAIL_STEP: StepDef = {
  name: "score_email", kind: "code",
  retry: { maxAttempts: SCORE_EMAIL_ATTEMPTS, factor: 2, minTimeoutMs: 2 * 60_000, maxTimeoutMs: 15 * 60_000, randomize: false },
  run: async (ctx) => {
    const mia = ctx.outputs.mia_preview as { status?: string; score?: number | null; computed?: string | null } | undefined;
    let ready = mia?.status === "ready" && typeof mia.score === "number";
    if (!ready && mia?.computed === "in_flight") {
      const { readMiaPreview } = await import("../../services/miaPreview/preview");
      const now = await readMiaPreview(ctx.athleteId!);
      ready = now.status === "ready" && typeof now.score === "number";
      if (!ready) {
        if (ctx.attempt < SCORE_EMAIL_ATTEMPTS) throw new Error("score still being computed: the email waits for it");
        return { sent: false, reason: "score_not_ready" };
      }
    }
    if (!ready) return { sent: false, reason: "no_score" };
    const [a] = await db.select({ email: athletes.email, first_name: athletes.first_name, full_name: athletes.full_name, status: athletes.status })
      .from(athletes).where(eq(athletes.id, ctx.athleteId!)).limit(1);
    if (!a) return { sent: false, reason: "no_athlete" };
    if (a.status !== "waitlisted") return { sent: false, reason: "not_waitlisted" };
    if (!a.email) return { sent: false, reason: "no_email" };
    const link = waitlistPageUrl();
    if (!link) return { sent: false, skipped: true, reason: "no_landing_url" };
    const first = a.first_name?.trim() || a.full_name?.trim().split(/\s+/)[0] || "there";
    try {
      // ?go=score: the landing opens her score screen once she is signed in (and only when she has a score).
      // She was already shown a quick score (v3/v4): the email says her FULL score is ready and has replaced it.
      const afterQuick = await quickScoreWasShown(ctx.outputs.quick_score);
      const r = await sendTemplate(a.email, afterQuick ? WAITLIST_TEMPLATES.fullScoreReady : WAITLIST_TEMPLATES.scoreReady, { first, link: `${link}?go=score` });
      return { sent: r.sent, ...(afterQuick ? { template: "full_score_ready" } : {}), ...(r.skipped ? { skipped: true, reason: "email_off" } : {}), ...(r.error ? { reason: "send_failed" } : {}) };
    } catch (err: any) {
      logger.warn({ athleteId: ctx.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "signup research: score email failed");
      return { sent: false, reason: "send_failed" };
    }
  },
};

/**
 * v2 (the default for new runs): v1 + the score-ready email, and each web-search pass on the sign-up's time budget
 * (workflow.ts budgetedPassStep: once one pass is done, the other stops at SIGNUP_PASS_BUDGET_MS and keeps what it had
 * written), so the score is not held ~12 minutes by one slow pass. v1 runs finish on v1.
 */
export const SIGNUP_RESEARCH_V2 = defineWorkflow({
  process: SIGNUP_RESEARCH_PROCESS, version: 2,
  steps: [budgetedPassStep("a"), budgetedPassStep("b"), AGENT_RESEARCH_STEPS[2], SIGNUP_MIA_STEP, SCORE_EMAIL_STEP],
  onDone: signupResearchOnDone,
});

/**
 * v3 (OPT-IN: startSignupAgentResearch pins it only while QUICK_SCORE_ONE_CALL is "true"; dev on, prod off): v2 plus the
 * quick_score step beside the two web-search passes (same ordinal, so it starts with them and the merge waits only for
 * the slower pass, as before). Everything else is v2's, step for step. With the flag off new runs are v2, unchanged.
 */
export const SIGNUP_RESEARCH_V3 = defineWorkflow({
  process: SIGNUP_RESEARCH_PROCESS, version: 3,
  steps: [budgetedPassStep("a"), budgetedPassStep("b"), QUICK_SCORE_STEP, AGENT_RESEARCH_STEPS[2], SIGNUP_MIA_STEP, SCORE_EMAIL_STEP],
  onDone: signupResearchOnDone,
}, { optIn: true });

/**
 * The `lean_research` step of v4: lean research (onboarding/leanResearchStep.ts) on the sign-up's own parent prefix
 * ("workflow:<run id>") and the onboarding's per-run cost cap (AGENT_ONBOARDING_COST_CAP_USD), so the daily sign-up cap
 * counts every call exactly as it counts the passes. A retried step reuses its finished calls (never pays twice).
 */
export const LEAN_RESEARCH_STEP: StepDef = {
  name: LEAN_RESEARCH_STEP_NAME, kind: "model", leaseMs: 20 * 60_000, retry: { maxAttempts: 2 },
  run: (ctx) => runLeanStep(ctx, { moment: "signup", parentPrefix: parentPrefixFor(ctx.runId), capMicroUsd: onboardingCostCapMicroUsd() }),
};

/**
 * v4 (OPT-IN: startSignupAgentResearch pins it only while LEAN_SIGNUP_RESEARCH is "true"; dev on, prod off): the
 * identity and index checks in front of the run are unchanged (the athlete-index claim and the footprint check run
 * before the run starts); then ONE lean_research step replaces research_a / research_b / research_merge, then the same
 * M.I.A. step (the existing facts-only scorer, prompt and enforcement unchanged) and the same email. The quick_score
 * step stays beside lean_research, controlled by its own flag (QUICK_SCORE_ONE_CALL off ⇒ it answers "off", no call).
 * With LEAN_SIGNUP_RESEARCH off, new runs are v3 or v2 exactly as before.
 */
export const SIGNUP_RESEARCH_V4 = defineWorkflow({
  process: SIGNUP_RESEARCH_PROCESS, version: 4,
  steps: [LEAN_RESEARCH_STEP, QUICK_SCORE_STEP, SIGNUP_MIA_STEP, SCORE_EMAIL_STEP],
  onDone: signupResearchOnDone,
}, { optIn: true });
