/**
 * agentFrontAthlete.ts — is this athlete on the new agent path? (legacy intelligence switch-off, 12 Oct 2026)
 *
 * True when `athletes.agent_onboarding_required` is set: she signed up through the agent front (routes/auth.ts,
 * body.front === "agent") or opted in later (agent/onboarding/service.ts startOnboarding, optIn); or when her sign-up
 * research ran on the agent route (a signup_research run that was not canceled: the waitlist and app sign-ups behind
 * SIGNUP_RESEARCH_AGENT, agent/onboarding/signupResearch.ts) — while that run is still active (research in flight:
 * legacy machinery must not start beside it), and once it has finished only while the agent app front is on
 * (AGENT_ONBOARDING). With the front off (a rollback) she uses the legacy app, so a finished agent research no longer
 * keeps the legacy identity-resolved M.I.A., My Story and refreshes away from her. For her, the new agent
 * owns research (agent onboarding), the M.I.A. (the preview through the memory adapter) and what Nomila knows (memory),
 * so the LEGACY machinery stays out:
 *   - legacy lifecycle research and anchor re-entry      research/lifecycleHooks.ts
 *   - legacy event refresh requests (connect, admin)      research/triggers.ts requestRefresh
 *   - the nightly legacy research planner                 research/planner.ts loadPlannerInput
 *   - the identity-resolved M.I.A. request                marketabilityBeta1Orchestrator.ts evaluationOwed
 *   - new My Story (Identity Intelligence) runs           identityIntelligence/refresh.ts requestIdentityRefresh
 * Athletes who joined before the agent keep every existing trigger. Full retirement of legacy research comes after
 * they re-onboard through the agent (the 9 Oct clean-start plan).
 *
 * Kept deliberately light (db + schema + logger): the lifecycle hooks import it statically.
 * A failed read answers false — today's legacy behaviour — and is logged; it never throws.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { athletes } from "../../shared/schema";
import { createLogger } from "../logger";

const logger = createLogger("agent-front-athlete");

/** AGENT_ONBOARDING, read as agent/onboarding/routes.ts reads it (not imported: this module stays light). */
const agentAppFrontOn = () => process.env.AGENT_ONBOARDING === "true";

export async function isAgentFrontAthlete(athleteId: string): Promise<boolean> {
  try {
    const [row] = await db.select({
      required: athletes.agent_onboarding_required,
      agentResearch: sql<boolean>`EXISTS (SELECT 1 FROM workflow_runs w WHERE w.athlete_id = ${athleteId} AND w.process = 'signup_research' AND w.status ${agentAppFrontOn() ? sql`<> 'canceled'` : sql`IN ('running', 'waiting')`})`,
    }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    return row?.required === true || row?.agentResearch === true;
  } catch (err: any) {
    logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 160) }, "agent-front lookup failed; treating as a legacy athlete");
    return false;
  }
}
