/**
 * agent/onboarding/signupResearch.ts — THE one way any sign-up entry point starts research for a new or newly-claimed
 * account, so the daily cap (dailyCap.ts, DAILY_RESEARCH_CAP_USD) covers every route:
 *   the landing page's POST /api/v1/waitlist (routes/waitlist.ts)          legacy onboarding run, createdBy "signup"
 *   the app's POST /auth/signup, both create branches (routes/auth.ts)     legacy onboarding run, createdBy "app_signup"
 *   the app's agent onboarding start (agent/onboarding/service.ts)         agent_onboarding run
 *   every sign-up / claim lifecycle entry (research/lifecycle.ts)          governed research_refresh v3, lifecycle_*
 *   an operator's waitlist promotion (routes/admin.ts)                     legacy onboarding run, NOT capped
 * Microsoft, Apple, e-mail code and the claim confirmations reach research only through the lifecycle entry (or the
 * app's later /auth/signup / agent onboarding start), so they are covered by the rows above.
 *
 * SIGNUP_RESEARCH_AGENT (off by default): the landing waitlist and both app /auth/signup create branches start the
 * AGENT's research-only run instead (startSignupAgentResearch → process signup_research, signupResearchWorkflow.ts):
 * the agent onboarding's two web-search passes and merge into her memory, then her M.I.A. score. Legacy researchAthlete
 * is not started for them. agent_onboarding v4 reuses that research at her first app launch.
 *
 *   startSignupResearchRun(start, { capped })
 *     capped, with a daily cap set ⇒ the run is always CREATED held (holdUntil: HELD_READY_AT, no kick), then admitted
 *       atomically (dailyCap.ts admitHeldRun: budget read + release under one advisory transaction lock). Room ⇒ its
 *       first steps move to now and it is kicked as before; no room, or the budget could not be read ⇒ it stays held
 *       (it exists, its input is recorded, one-active-run-per-athlete holds) until the minute workflow tick's
 *       releaseQueuedOnboardings starts it when there is budget again. FAIL CLOSED, but the athlete's sign-up (and her
 *       waitlist place) never depends on it: the start itself never throws for the cap;
 *     otherwise (`capped: false`, or no cap set) ⇒ startRun as before, EXCEPT past the cap: the runner refuses a new
 *       unheld research run while today's budget is spent or unreadable (dailyCap.ts researchCapRefusal, the hard stop),
 *       and this start then takes the capped route instead — created held, released by the minute tick.
 *
 * NEVER BOTH ROUTES for one athlete (one indexed read each):
 *   a legacy `onboarding` start is refused when she has a signup_research run (that run is returned, created false,
 *   refused "agent_research"), unless the caller passes legacyAfterAgentResearch (an operator's promotion while the
 *   agent app front is off: the legacy app needs its own research, design §5 rollback);
 *   the agent research start is refused when she has a legacy `onboarding` run, an agent_onboarding run, or a
 *   lifecycle research_refresh run (created_by lifecycle_*: e.g. the lifecycle entry ran when the agent start was
 *   refused for want of a real name, and she gave her name later).
 *
 * `capped: false` is for acts that are not a sign-up: an existing athlete's "Meet Mila" opt-in and an operator's
 * promotion. They skip the sign-up queue's reservation while the day has budget, never the hard stop. The guard in signupResearch.test.ts fails CI when a sign-up research run is started anywhere but here.
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import { athletes } from "../../../shared/schema";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { createLogger } from "../../logger";
import { cancelRun, HELD_READY_AT, kick, startRun, type StartInput } from "../../workflow/runner";
import { admitHeldRun, dailyResearchCapMicroUsd, LIFECYCLE_CREATED_BY_PREFIX, RESEARCH_WRITTEN_STEPS, SIGNUP_RESEARCH_PROCESS, type SignupResearchProcess } from "./dailyCap";
import { dbStore } from "../research/dbStore";
import { readLegacyRow } from "../../services/intelligence/context/legacyAdapter";

export { SIGNUP_RESEARCH_PROCESSES, SIGNUP_RESEARCH_PROCESS, LIFECYCLE_CREATED_BY_PREFIX } from "./dailyCap";

const logger = createLogger("agent/onboarding/signup-research");

/** SIGNUP_RESEARCH_AGENT: the sign-up fronts start the agent's research-only run instead of legacy research. */
export const signupResearchAgentEnabled = (): boolean => process.env.SIGNUP_RESEARCH_AGENT === "true";

export interface SignupResearchStart extends Omit<StartInput, "holdUntil" | "process"> {
  process: SignupResearchProcess;
}

/** The athlete's latest run of `process` that was not canceled, or null. */
export async function latestRunOf(athleteId: string, process: string) {
  const [r] = await db.select().from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, process), ne(workflowRuns.status, "canceled")))
    .orderBy(desc(workflowRuns.started_at)).limit(1);
  return r ?? null;
}

export async function startSignupResearchRun(start: SignupResearchStart, opts: { capped: boolean; legacyAfterAgentResearch?: boolean }) {
  if (start.process === "onboarding" && start.athleteId && !opts.legacyAfterAgentResearch) {
    const agent = await latestRunOf(start.athleteId, SIGNUP_RESEARCH_PROCESS);
    if (agent) {
      logger.info({ athleteId: start.athleteId, createdBy: start.createdBy, agentRunId: agent.id }, "legacy sign-up research refused: she was researched on the agent route");
      return { run: agent, created: false, queued: false, refused: "agent_research" as const };
    }
  }
  if (!opts.capped || dailyResearchCapMicroUsd() === null) {
    try {
      const { run, created } = await startRun(start);
      return { run, created, queued: false };
    } catch (err) {
      // The hard stop (the runner's research cap): start it held instead, as a capped sign-up does.
      if ((err as { code?: unknown })?.code !== "daily_research_cap") throw err;
    }
  }
  const { run, created } = await startRun({ ...start, holdUntil: HELD_READY_AT, kick: false });
  if (!created) return { run, created, queued: false };
  const admitted = await admitHeldRun(run.id);
  if (!admitted) {
    logger.info({ athleteId: start.athleteId, process: start.process, runId: run.id, createdBy: start.createdBy }, "sign-up research queued by the daily cap");
    return { run, created, queued: true };
  }
  if (start.kick !== false) await kick(run.id).catch((err) => logger.warn({ runId: run.id, error: String(err?.message ?? err).slice(0, 200) }, "sign-up research: kick failed (the tick will retry)"));
  return { run, created, queued: false };
}

/** A name research can search for: the athlete's own, never the "Athlete" fallback or her e-mail's local part. */
export function researchableName(fullName: string | null | undefined, email: string | null | undefined): string | null {
  const name = (fullName ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name || name.toLowerCase() === "athlete") return null;
  const local = (email ?? "").split("@")[0]?.trim().toLowerCase();
  if (local && name.toLowerCase() === local) return null;
  return name;
}

/**
 * The school / team she typed (the landing and app store it in the school projection column). Read through
 * the one sanctioned reader of the projection, context/legacyAdapter.ts readLegacyRow (sourceGuard.test.ts G5), never
 * directly. "" when none.
 */
async function schoolOrTeamOf(athleteId: string): Promise<string> {
  return (await readLegacyRow(athleteId))?.school ?? "";
}

const PLATFORM_NAMES: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", twitter: "X" };

export type AgentResearchStart =
  | { started: true; runId: string; created: boolean; queued: boolean }
  | { started: false; reason: "no_athlete" | "no_name" | "no_sport" | "legacy_research" | "agent_onboarding" | "lifecycle_research" };

/**
 * The signup_research version a new run pins:
 *   LEAN_SIGNUP_RESEARCH "true"  ⇒ v4 (lean research in place of the two passes and the merge; quick_score beside it,
 *                                  still on its own flag)
 *   else QUICK_SCORE_ONE_CALL     ⇒ v3 (v2 + the one-call quick score beside the passes)
 *   else                          ⇒ the default (v2)
 */
export async function signupResearchVersion(): Promise<{ version?: number }> {
  const { leanSignupResearchEnabled } = await import("../research/v2/lean");
  if (leanSignupResearchEnabled()) return { version: 4 };
  const { quickScoreOneCallEnabled } = await import("../../services/quickScore/config");
  return quickScoreOneCallEnabled() ? { version: 3 } : {};
}

/**
 * Start the sign-up's research-only agent run (signup_research) for this athlete, from what her row holds. Idempotent:
 * key signup_research:<id> and one active run per athlete, so the landing's repeat posts return the same run. Her
 * "said" facts (name, sport, school or team, typed handles) are written once, when the run is created, before the
 * research starts (the passes read them). Capped by the daily cap like every sign-up.
 */
export async function startSignupAgentResearch(athleteId: string, opts: { createdBy: string; capped?: boolean }): Promise<AgentResearchStart> {
  const [row] = await db.select({ full_name: athletes.full_name, email: athletes.email, sport: athletes.sport, socials: athletes.socials })
    .from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!row) return { started: false, reason: "no_athlete" };
  const name = researchableName(row.full_name, row.email);
  if (!name) return { started: false, reason: "no_name" };
  const sport = (row.sport ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!sport) return { started: false, reason: "no_sport" };
  if (await latestRunOf(athleteId, "onboarding")) return { started: false, reason: "legacy_research" };
  if (await latestRunOf(athleteId, "agent_onboarding")) return { started: false, reason: "agent_onboarding" };
  const [lifecycle] = await db.select({ id: workflowRuns.id }).from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, "research_refresh"), ne(workflowRuns.status, "canceled"), sql`${workflowRuns.created_by} LIKE ${LIFECYCLE_CREATED_BY_PREFIX + "%"}`)).limit(1);
  if (lifecycle) return { started: false, reason: "lifecycle_research" };

  await import("./signupResearchWorkflow");   // registers the definition (it pulls the research skills: loaded on first use)
  const { run, created, queued } = await startSignupResearchRun(
    { process: SIGNUP_RESEARCH_PROCESS, athleteId, input: { name, sport }, createdBy: opts.createdBy, idempotencyKey: `${SIGNUP_RESEARCH_PROCESS}:${athleteId}`, kick: false, ...(await signupResearchVersion()) },
    { capped: opts.capped ?? true },
  );
  if (created) {
    const today = new Date().toISOString().slice(0, 10);
    const said = (claim: string, ref: string) => ({ subject: { kind: "athlete" as const, name }, claim, type: "said" as const, source: { ref: `onboarding/${run.id}#${ref}`, title: "You told us" }, date: today, confidence: 1, runId: null });
    const school = (await schoolOrTeamOf(athleteId)).replace(/\s+/g, " ").trim().slice(0, 120);
    const handles = Object.entries((row.socials ?? {}) as Record<string, unknown>)
      .filter(([k, v]) => PLATFORM_NAMES[k] && typeof v === "string" && v.trim())
      .map(([k, v]) => said(`${name}'s ${PLATFORM_NAMES[k]} handle is @${String(v).trim().replace(/^@/, "").slice(0, 64)}.`, `handle:${k}`));
    await dbStore.insertFacts(athleteId, [
      said(`The athlete's name is ${name}.`, "name"),
      said(`${name}'s sport is ${sport}.`, "sport"),
      ...(school ? [said(`${name}'s school or team is ${school}.`, "school")] : []),
      ...handles,
    ]);
    if (queued) logger.info({ athleteId, runId: run.id }, "signup research: queued by the daily cap");
    else void kick(run.id).catch((err) => logger.warn({ athleteId, runId: run.id, error: String(err?.message ?? err).slice(0, 200) }, "signup research: kick failed (the tick will retry)"));
  }
  return { started: true, runId: run.id, created, queued: !!queued };
}

/**
 * The join flow asks her school or team AFTER the sport (only when the index finds nothing), and her agent research
 * starts at the sport. Its run input stays her name and sport (the anchor v4 compares), but the passes and the merge
 * read her facts when they execute, so a school / team she gives later is recorded now as a said fact, if her
 * signup_research run has not merged yet and the same words are not already on file. A pass already running does not
 * see it; a queued run, the merge, and agent_onboarding v4's later work do.
 */
export async function recordLateSaidFacts(athleteId: string): Promise<boolean> {
  const run = await latestRunOf(athleteId, SIGNUP_RESEARCH_PROCESS);
  if (!run || run.status === "done" || run.status === "failed") return false;
  const [merged] = await db.select({ n: sql<number>`count(*)::int` }).from(workflowSteps)
    .where(and(eq(workflowSteps.run_id, run.id), inArray(workflowSteps.step, [...RESEARCH_WRITTEN_STEPS]), eq(workflowSteps.status, "done")));
  if (Number(merged?.n ?? 0) > 0) return false;
  const name = ((run.input ?? {}) as { name?: string }).name;
  const school = (await schoolOrTeamOf(athleteId)).replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name || !school) return false;
  const claim = `${name}'s school or team is ${school}.`;
  const known = (await dbStore.listFacts(athleteId, ["active"])).some((f) => f.type === "said" && f.claim.trim().toLowerCase() === claim.toLowerCase());
  if (known) return false;
  await dbStore.insertFacts(athleteId, [{ subject: { kind: "athlete", name }, claim, type: "said", source: { ref: `onboarding/${run.id}#school`, title: "You told us" }, date: new Date().toISOString().slice(0, 10), confidence: 1, runId: null }]);
  return true;
}

/**
 * At promotion: stop her sign-up research where it would be paid for twice. An ACTIVE signup_research run (held by the
 * daily cap, or still researching) is canceled, unless keepMerged and its merge is done (agent_onboarding v4 reuses a
 * merged run; its remaining M.I.A. / email steps may finish). A finished run is left alone. A step already running
 * finishes its call (the runner then stops: a canceled run never advances); nothing new starts.
 */
export async function retireSignupResearch(athleteId: string, opts: { keepMerged: boolean }): Promise<{ canceled: string | null }> {
  const run = await latestRunOf(athleteId, SIGNUP_RESEARCH_PROCESS);
  if (!run || (run.status !== "running" && run.status !== "waiting")) return { canceled: null };
  if (opts.keepMerged) {
    const [merged] = await db.select({ n: sql<number>`count(*)::int` }).from(workflowSteps)
      .where(and(eq(workflowSteps.run_id, run.id), inArray(workflowSteps.step, [...RESEARCH_WRITTEN_STEPS]), eq(workflowSteps.status, "done")));
    if (Number(merged?.n ?? 0) > 0) return { canceled: null };
  }
  await cancelRun(run.id);
  logger.info({ athleteId, runId: run.id, keepMerged: opts.keepMerged }, "signup research canceled at promotion (it would research her twice)");
  return { canceled: run.id };
}
