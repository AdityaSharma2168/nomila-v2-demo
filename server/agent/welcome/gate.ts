/**
 * agent/welcome/gate.ts — how the always-on OPTIONAL jobs ask the athlete's choice before running for them (design
 * "Mila welcome flow" §12 "Enforcement"; owner, 28 Oct 2026: "always-on jobs must check the athlete's choice").
 *
 * With MILA_WELCOME off both helpers are transparent (every athlete passes, no SQL is added, no query runs), so the
 * jobs behave exactly as before. With it on, a job runs only for athletes whose choice for its capability is enabled
 * and whose consent covers the job's action (choices.ts isAllowed); any error fails closed (the athlete is skipped).
 *
 *   OPTIONAL_JOBS        the gated jobs, their capability and the consent action each one performs.
 *   jobGate(job)         a per-sweep, memoised (athleteId) => Promise<boolean>.
 *   enabledChoiceSql()   a WHERE fragment for a sweep's athlete query, so athletes who never said yes do not take the
 *                        sweep's batch slots (and starve those who did).
 *
 * Where each job checks (sweep, and again when the work RUNS, so turning a capability off stops work already queued):
 *   moments_scan     sweepMomentsScan + the moments_scan workflow step
 *   post_ideas       sweepPostIdeas, per athlete, right before the pass
 *   plan_refresh     sweepPlanRefresh / notifyPlanEvent + the plan and post_kits steps of an optional run (input.optional)
 *   post_took_off    runLearningLoop, right before the message
 *   auto_archive     archiveStaleDeals / sweepOpportunities, per row right before the write
 *   profile_refresh  sweepResearchRefresh + every step of a schedule-triggered research refresh
 *
 * Core work (sign-up research, the score, deal detection on a connected inbox, alerts, data upkeep) is never gated here.
 */
import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import { createLogger } from "../../logger";
import { milaWelcomeEnabled } from "./config";

const logger = createLogger("agent/welcome/gate");

export const OPTIONAL_JOBS = {
  moments_scan:    { capability: "moments_scan",    action: "scan_moments" },
  post_ideas:      { capability: "post_ideas",      action: "propose_post_ideas" },
  plan_refresh:    { capability: "plan_refresh",    action: "refresh_plan" },
  post_took_off:   { capability: "post_took_off",   action: "message_post_took_off" },
  auto_archive:    { capability: "auto_archive",    action: "archive_quiet_deal" },
  profile_refresh: { capability: "profile_refresh", action: "refresh_research" },
} as const;
export type OptionalJob = keyof typeof OPTIONAL_JOBS;

/** One sweep's gate: asks each athlete once. Transparent (always true, no query) while MILA_WELCOME is off. */
export function jobGate(job: OptionalJob): (athleteId: string) => Promise<boolean> {
  const { capability, action } = OPTIONAL_JOBS[job];
  const memo = new Map<string, Promise<boolean>>();
  return (athleteId: string) => {
    if (!milaWelcomeEnabled()) return Promise.resolve(true);
    let p = memo.get(athleteId);
    if (!p) {
      // Imported lazily: the gated job modules stay loadable (and unit-testable) without a database while the flag is off.
      p = import("./choices").then(({ isAllowed }) => isAllowed(athleteId, capability, null, action)).then((r) => r.allowed).catch((err: any) => {
        logger.warn({ athleteId, job, error: String(err?.message ?? err).slice(0, 200) }, "choice check failed: skipped");
        return false;
      });
      memo.set(athleteId, p);
    }
    return p;
  };
}

/** Is this one athlete allowed this job now (a single check, for hot paths)? */
export function jobAllowed(job: OptionalJob, athleteId: string): Promise<boolean> {
  return jobGate(job)(athleteId);
}

/**
 * `EXISTS (an enabled athlete-wide choice for the job's capability)` for the athlete id column of a sweep's query, or
 * undefined while MILA_WELCOME is off (drizzle's and() drops undefined, so the query is unchanged).
 */
export function enabledChoiceSql(athleteId: AnyColumn | SQL, job: OptionalJob): SQL | undefined {
  if (!milaWelcomeEnabled()) return undefined;
  const { capability } = OPTIONAL_JOBS[job];
  return sql`EXISTS (SELECT 1 FROM mila_choices mc WHERE mc.athlete_id = ${athleteId} AND mc.capability = ${capability} AND mc.state = 'enabled' AND mc.account_ref IS NULL)`;
}
