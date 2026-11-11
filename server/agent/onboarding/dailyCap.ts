/**
 * agent/onboarding/dailyCap.ts — the daily cap on sign-up research spend (DAILY_RESEARCH_CAP_USD; unset ⇒ no cap).
 *
 * WHY: each sign-up's research is capped at AGENT_ONBOARDING_COST_CAP_USD (default $2), but nothing capped the day, so a
 * spike of 10,000 sign-ups could spend about $20,000. With the cap set, a new sign-up still joins, completes the plain
 * steps (name and sports recorded, the run exists, her waitlist place), but her research is QUEUED instead of started
 * when the day's budget is used up; it starts by itself once there is budget again — the next UTC day at the latest,
 * when the day's spend resets.
 *
 * EVERY ROUTE: the decision is taken in ONE place, signupResearch.ts startSignupResearchRun, which every sign-up entry
 * point goes through (landing waitlist, app signup, agent onboarding start, lifecycle research, admin promotion). The
 * runs it governs are SIGNUP_RESEARCH_PROCESSES: the agent's agent_onboarding, the agent's research-only signup_research
 * (the waitlist sign-up's run behind SIGNUP_RESEARCH_AGENT), the legacy onboarding (v1–v3, whose first step calls
 * researchAthlete), and a research_refresh started by the lifecycle entry (created_by lifecycle_*).
 *
 * WHAT COUNTS (signupSpendTodayMicroUsd), everything since UTC midnight:
 *   agent_runs.cost_micro_usd        every agent model run of an athlete in her sign-up window (created in the last
 *                                    SIGNUP_WINDOW_DAYS, and an agent-front sign-up, one with a legacy sign-up
 *                                    onboarding run, or one with a signup_research run: the waitlist research's
 *                                    OpenAI passes and merge)
 *                                    PLUS every "real athlete?" footprint check (FOOTPRINT_SKILL_ID, footprintCheck.ts)
 *                                    of any athlete: it runs before any research run exists, and often instead of one
 *   mia_evaluation_runs.cost_usd     the M.I.A. score, same athletes (outside the per-onboarding $2 cap)
 *   legacy researchAthlete           athlete_snapshots trigger 'signup': researchAthlete records tokens, not dollars, so
 *                                    the spend is ESTIMATED from them at the research cost model's list prices
 *                                    (DEFAULT_COST_MODEL gemini_grounded per call + tokens, kimi_extract tokens)
 *   governed (lifecycle) research    research_runs.estimated_cost_usd, trigger 'signup' (the v3 runs record dollars)
 * Counting all of a new athlete's model spend, not only the onboarding's own runs, over-counts a little (her first
 * chats) and never under-counts. The spend lags the work by minutes (a run records its cost when it ends), so the
 * check also RESERVES each research still in flight at its worst case (perRunReserveMicroUsd: the per-onboarding cap
 * PLUS the M.I.A. score, which runs outside that cap: DAILY_CAP_MIA_RESERVE_USD, default $1, about three attempts at
 * ~$0.21 with margin): a burst of sign-ups cannot all start before any of their spend lands. A run is in flight only while a SPENDING step is open (inFlightCount): a model step
 * of an agent run, the research step of a legacy run. A run parked on a step that spends nothing (the agent
 * onboarding's conversation, the legacy greeting) reserves nothing, however long she takes. (A legacy research costs
 * well under $2, so its reservation over-reserves; it lasts only while its research step is open.)
 *
 *   room for one more  ⇔  spent today + (in flight + 1) × per-run reserve ≤ the daily cap, and nobody is queued
 *                         (first come, first served: a newcomer never jumps the queue)
 *
 * ATOMIC AND FAIL-CLOSED (admitHeldRun, releaseQueuedOnboardings): a capped sign-up's run is always CREATED held, then
 * admitted inside one transaction holding pg_advisory_xact_lock(LOCK_SIGNUP_RESEARCH_CAP): read the budget, and only if
 * there is room move its first steps to now. The lock serialises every admit and the tick's release across instances,
 * and the admitted run is in flight (counted) before the next holder reads, so two concurrent sign-ups can never both
 * take the last slot. Any failure (the budget read, the lock's 5 s timeout) leaves the run HELD: the next tick's
 * release starts it when there is room. Nothing starts on a budget nobody could read.
 *
 * THE QUEUE is the workflow runner itself: a held run (startRun holdUntil: HELD_READY_AT) whose first steps are `ready`
 * with a ready_at no clock reaches. releaseQueuedOnboardings — called from the minute workflow tick (Cloud Scheduler,
 * dev and prod; server/index.ts, no flag of its own), under its advisory lock — moves the oldest held runs' ready_at to
 * now while there is room, and the same tick claims them. No new table, no new cron.
 *
 * THE PLATFORM DAY CAP (lib/platformSpend.ts, PLATFORM_DAY_COST_CAP_USD; prod 250, the code maximum, since #1254; dev
 * leaves it unset, so dev runs on the $25 default) counts this spend too, and refuses every paid call for everyone once
 * it is reached. Prod's DAILY_RESEARCH_CAP_USD (200) sits under it, so on a normal day this cap queues research first.
 * Sign-up research must QUEUE, never fail (owner, 10 Nov 2026), so for the day the platform cap binds anyway:
 *   - a RESEARCH or SCORE step of a sign-up research run (PLATFORM_HOLD_STEPS; every step of a lifecycle
 *     research_refresh) whose paid call the platform cap refuses is HELD, not failed (workflow/runner.ts asks
 *     holdsOnPlatformCap): its row goes back to `ready` at HELD_READY_AT, the same attempt. Agent onboarding's
 *     athlete-facing steps (opening, understand, insights, moments) still fail as before;
 *   - admitHeldRun and releaseQueuedOnboardings check the PLATFORM's headroom as well as this cap's: a run starts only
 *     while platform spent + (in flight + 1) x the per-run reserve fits under the platform cap (spend lands only when
 *     a run finishes, so "not reached yet" is not enough: at UTC midnight a backlog would otherwise start 20 a minute);
 *   - a run is QUEUED (held) only when every open step of it is held: a held step beside a sibling that is still
 *     running leaves the run in flight (reserved) until that sibling ends;
 *   - runs held for more than HELD_TOO_LONG_DAYS are logged ({ event: "signup_research_held_long" }) for an alert;
 *   - DAILY_RESEARCH_CAP_FALLBACK_USD (200) sits under the platform cap's maximum (250), so a malformed sign-up cap
 *     still binds first.
 */
import { and, asc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { agentRuns, athleteSnapshots, athletes, miaEvaluationRuns, researchRuns } from "../../../shared/schema";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { createLogger } from "../../logger";
import { DEFAULT_COST_MODEL } from "../../services/intelligence/research/policy";
import { cancelRun, HELD_READY_AT, runnerNow } from "../../workflow/runner";
import { LOCK_SIGNUP_RESEARCH_CAP } from "../../lib/pgAdvisoryLock";
import { onboardingCostCapMicroUsd } from "./costCap";
import { readCap as readSpendCap } from "../../lib/spendCap";
import { isPlatformCapError, platformBudget } from "../../lib/platformSpend";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The database or the cap lock's transaction: every read the admit decision makes goes through the lock holder. */
type Ex = typeof db | Tx;

const logger = createLogger("agent/onboarding/daily-cap");

const AGENT_ONBOARDING_PROCESS = "agent_onboarding";   // workflow.ts AGENT_ONBOARDING_PROCESS (not imported: that module pulls every skill)
/** The "real athlete?" check's skill (footprintCheck.ts; not imported: that module imports this one). */
export const FOOTPRINT_SKILL_ID = "onboarding/athlete-footprint";
/** The agent's research-only sign-up run (the waitlist sign-up behind SIGNUP_RESEARCH_AGENT). */
export const SIGNUP_RESEARCH_PROCESS = "signup_research";
/** The steps whose completion means a research run's facts are in her memory: the merge (signup_research v1–v3,
 *  agent_onboarding) or lean research (signup_research v4, LEAN_SIGNUP_RESEARCH). A run has one or the other. */
export const RESEARCH_WRITTEN_STEPS = ["research_merge", "lean_research"] as const;
/** The processes whose runs are sign-up research (signupResearch.ts starts them; the cap queues and reserves them). */
export const SIGNUP_RESEARCH_PROCESSES = [AGENT_ONBOARDING_PROCESS, SIGNUP_RESEARCH_PROCESS, "onboarding", "research_refresh"] as const;
export type SignupResearchProcess = (typeof SIGNUP_RESEARCH_PROCESSES)[number];
/** research_refresh is sign-up research only when the lifecycle entry started it (research/lifecycle.ts createdBy). */
export const LIFECYCLE_CREATED_BY_PREFIX = "lifecycle_";
/** The legacy onboarding run's created_by on a sign-up (waitlist.ts, auth.ts). */
const LEGACY_SIGNUP_CREATED_BY = ["signup", "app_signup"];
/** researchAthlete's grounded searches per run (its buildQueries), before retries. */
export const LEGACY_RESEARCH_QUERIES = 4;
/** How long after sign-up an athlete's spend counts as sign-up spend. */
export const SIGNUP_WINDOW_DAYS = 7;
/** At most this many queued researches released per tick (the tick runs every minute). */
export const RELEASE_BATCH = 20;

/**
 * What a DAILY_RESEARCH_CAP_USD that is set but not a usable number falls back to (fail closed: prod's value, 200 since
 * 10 Nov 2026). It must stay under the platform day cap's maximum (PLATFORM_DAY_CAP_MAX_USD, $250), which counts this
 * spend too: the sign-up cap QUEUES research, the platform cap only holds it once it is reached.
 */
export const DAILY_RESEARCH_CAP_FALLBACK_USD = 200;
/** The hard maximum of DAILY_RESEARCH_CAP_USD (lib/spendCap.ts). Above PLATFORM_DAY_CAP_MAX_USD the platform cap binds first. */
export const DAILY_RESEARCH_CAP_MAX_USD = 1500;

/**
 * DAILY_RESEARCH_CAP_USD in micro-dollars, clamped to DAILY_RESEARCH_CAP_MAX_USD. Null (no sign-up cap) only when
 * UNSET (local dev and tests; both Cloud Run yamls set it, and the platform-wide day cap, lib/platformSpend.ts, still
 * bounds everything). Set but not a usable number → DAILY_RESEARCH_CAP_FALLBACK_USD (fail closed, never "no cap").
 */
export function dailyResearchCapMicroUsd(): number | null {
  const raw = process.env.DAILY_RESEARCH_CAP_USD;
  if (raw == null || raw.trim() === "") return null;
  return Math.round(readSpendCap("DAILY_RESEARCH_CAP_USD", DAILY_RESEARCH_CAP_FALLBACK_USD, DAILY_RESEARCH_CAP_MAX_USD) * 1_000_000);
}

/** The M.I.A. score's worst case per sign-up (DAILY_CAP_MIA_RESERVE_USD, default $1; 0 allowed), in micro-dollars. */
export function miaReserveMicroUsd(): number {
  const raw = process.env.DAILY_CAP_MIA_RESERVE_USD;
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Math.round((Number.isFinite(n) && n >= 0 ? n : 1) * 1_000_000);
}

/** A sign-up research run (as the runner sees it): one of SIGNUP_RESEARCH_PROCESSES, research_refresh only from the lifecycle. */
export function isSignupResearchRun(run: { process: string; created_by?: string | null }): boolean {
  if (run.process === "research_refresh") return (run.created_by ?? "").startsWith(LIFECYCLE_CREATED_BY_PREFIX);
  return (SIGNUP_RESEARCH_PROCESSES as readonly string[]).includes(run.process);
}

/**
 * The research and score steps a platform-cap refusal HOLDS (in agent_onboarding, signup_research and the legacy
 * onboarding): the research passes and their merge, lean research, the quick score and the M.I.A. preview. Agent
 * onboarding's athlete-facing steps (opening, understand, insights, moments) are not here: they fail as before.
 */
export const PLATFORM_HOLD_STEPS: ReadonlySet<string> = new Set(["research_a", "research_b", "research_merge", "lean_research", "quick_score", "mia_preview"]);

/**
 * The runner's question when a step throws: hold this step (queue the run) instead of failing it? True only for the
 * platform day cap's refusal, in a research or score step of a sign-up research run (PLATFORM_HOLD_STEPS, or any step
 * of a lifecycle research_refresh). Every other error, step and process fails and retries as before.
 */
export function holdsOnPlatformCap(err: unknown, run: { process: string; created_by?: string | null }, stepName: string): boolean {
  if (!isSignupResearchRun(run) || !isPlatformCapError(err)) return false;
  return run.process === "research_refresh" || PLATFORM_HOLD_STEPS.has(stepName);
}

/** The platform day cap's reading for an admit decision; null when it cannot be read (the caller then starts nothing). */
async function readPlatform(now: Date): Promise<{ spent: number; cap: number } | null> {
  try {
    const b = await platformBudget(now);
    return b.readFailed ? null : { spent: b.spentMicroUsd, cap: b.capMicroUsd };
  } catch { return null; }
}

/** Room on the PLATFORM cap for one more run, the in-flight ones reserved at the same per-run worst case as this cap. */
const platformHasRoom = (p: { spent: number; cap: number } | null, inFlight: number, perRun: number) =>
  p !== null && p.spent + (inFlight + 1) * perRun <= p.cap;

/** What one sign-up research may spend at worst: the per-onboarding cap plus the M.I.A. score outside it. */
export const perRunReserveMicroUsd = (): number => onboardingCostCapMicroUsd() + miaReserveMicroUsd();

export const utcMidnight = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
export const nextUtcMidnight = (now: Date) => new Date(utcMidnight(now).getTime() + 86_400_000);

export interface SignupSpend { agentRuns: number; mia: number; legacyResearch: number; governedResearch: number; total: number }

/** The legacy researchAthlete spend since `since`, estimated from the calls and tokens its snapshots record. */
async function legacyResearchMicroUsd(since: Date, ex: Ex = db): Promise<number> {
  const sum = (path: string) => sql<string>`coalesce(sum(coalesce((${sql.raw(path)})::numeric, 0)), 0)::text`;
  const [r] = await ex.select({
    snaps: sql<string>`count(*)::text`,
    retries: sum("sources->'gemini_stats'->>'retries_fired'"),
    gIn: sum("sources->'gemini_usage'->>'prompt_tokens'"),
    gOut: sum("sources->'gemini_usage'->>'candidate_tokens'"),
    kIn: sum("sources->'kimi_usage'->>'prompt_tokens'"),
    kOut: sum("sources->'kimi_usage'->>'completion_tokens'"),
  }).from(athleteSnapshots).where(and(eq(athleteSnapshots.trigger, "signup"), gte(athleteSnapshots.created_at, since)));
  const g = DEFAULT_COST_MODEL.gemini_grounded ?? {};
  const k = DEFAULT_COST_MODEL.kimi_extract ?? {};
  const n = (v: string | undefined) => Number(v ?? 0);
  const usd = (n(r?.snaps) * LEGACY_RESEARCH_QUERIES + n(r?.retries)) * (g.perCallUsd ?? 0)
    + (n(r?.gIn) / 1e6) * (g.perMTokInUsd ?? 0) + (n(r?.gOut) / 1e6) * (g.perMTokOutUsd ?? 0)
    + (n(r?.kIn) / 1e6) * (k.perMTokInUsd ?? 0) + (n(r?.kOut) / 1e6) * (k.perMTokOutUsd ?? 0);
  return Math.round(usd * 1_000_000);
}

/** Today's (UTC) sign-up research spend, every source, in micro-dollars. */
export async function signupSpendTodayMicroUsd(now: Date = runnerNow(), ex: Ex = db): Promise<SignupSpend> {
  const since = utcMidnight(now);
  const windowStart = new Date(now.getTime() - SIGNUP_WINDOW_DAYS * 86_400_000);
  const createdBy = sql.join(LEGACY_SIGNUP_CREATED_BY.map((c) => sql`${c}`), sql`, `);
  const legacySignupRun = sql`EXISTS (SELECT 1 FROM workflow_runs w WHERE w.athlete_id = ${athletes.id} AND w.process = 'onboarding' AND w.created_by IN (${createdBy}))`;
  // The waitlist's agent research (signup_research): her OpenAI passes, merge and M.I.A. are sign-up spend too.
  const agentSignupResearchRun = sql`EXISTS (SELECT 1 FROM workflow_runs w WHERE w.athlete_id = ${athletes.id} AND w.process = ${SIGNUP_RESEARCH_PROCESS})`;
  const signup = and(gte(athletes.created_at, windowStart), sql`(${athletes.agent_onboarding_required} = true OR ${legacySignupRun} OR ${agentSignupResearchRun})`);
  const [a] = await ex.select({ m: sql<string>`coalesce(sum(${agentRuns.cost_micro_usd}), 0)::text` })
    .from(agentRuns).innerJoin(athletes, eq(athletes.id, agentRuns.athlete_id))
    .where(and(gte(agentRuns.started_at, since), or(signup, eq(agentRuns.skill_id, FOOTPRINT_SKILL_ID))));
  const [m] = await ex.select({ usd: sql<string>`coalesce(sum(${miaEvaluationRuns.cost_usd}), 0)::text` })
    .from(miaEvaluationRuns).innerJoin(athletes, eq(athletes.id, miaEvaluationRuns.athlete_id))
    .where(and(gte(miaEvaluationRuns.started_at, since), signup));
  const [gv] = await ex.select({ usd: sql<string>`coalesce(sum(${researchRuns.estimated_cost_usd}), 0)::text` })
    .from(researchRuns).where(and(eq(researchRuns.trigger, "signup"), gte(researchRuns.started_at, since)));
  const agent = Number(a?.m ?? 0);
  const mia = Math.round(Number(m?.usd ?? 0) * 1_000_000);
  const legacyResearch = await legacyResearchMicroUsd(since, ex);
  const governedResearch = Math.round(Number(gv?.usd ?? 0) * 1_000_000);
  return { agentRuns: agent, mia, legacyResearch, governedResearch, total: agent + mia + legacyResearch + governedResearch };
}

/** A sign-up research run: one of SIGNUP_RESEARCH_PROCESSES (research_refresh only when the lifecycle entry started it). */
const signupResearchRun = () => sql`(${workflowRuns.process} IN (${AGENT_ONBOARDING_PROCESS}, ${SIGNUP_RESEARCH_PROCESS}, 'onboarding') OR (${workflowRuns.process} = 'research_refresh' AND ${workflowRuns.created_by} LIKE ${LIFECYCLE_CREATED_BY_PREFIX + "%"}))`;
/** The run is held: a first step waits on HELD_READY_AT. */
const isHeld = () => sql`(EXISTS (SELECT 1 FROM workflow_steps s WHERE s.run_id = ${workflowRuns.id} AND s.status = 'ready' AND s.ready_at >= ${HELD_READY_AT})
  AND NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.run_id = ${workflowRuns.id} AND (s.status = 'running' OR (s.status = 'ready' AND s.ready_at < ${HELD_READY_AT}))))`;

/** How long a held (queued) sign-up research may wait before it is logged as stuck. */
export const HELD_TOO_LONG_DAYS = 2;
let heldLongLoggedAt = 0;
/** At most once an hour per process: the runs held longer than HELD_TOO_LONG_DAYS ({ event: "signup_research_held_long" }). */
export async function logHeldTooLong(now: Date, ex: Ex = db): Promise<number> {
  if (heldLongLoggedAt && now.getTime() - heldLongLoggedAt < 3_600_000) return -1;
  heldLongLoggedAt = now.getTime();
  const before = new Date(now.getTime() - HELD_TOO_LONG_DAYS * 86_400_000);
  const [r] = await ex.select({ n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${workflowRuns.started_at})::text` }).from(workflowRuns)
    .where(and(eq(workflowRuns.status, "running"), signupResearchRun(), isHeld(), sql`${workflowRuns.started_at} < ${before}`));
  const n = Number(r?.n ?? 0);
  if (n > 0) logger.error({ event: "signup_research_held_long", count: n, oldest: r?.oldest ?? null, days: HELD_TOO_LONG_DAYS }, "sign-up research held (queued) for more than the alert window");
  return n;
}

/** Tests only: let the next release log the held-too-long count again. */
export function resetHeldLongLogForTests(): void { heldLongLoggedAt = 0; }

/**
 * A held signup_research run nobody needs any more: a landing sign-up's (created_by signup) whose athlete is no longer
 * waitlisted (promoted: the app researches her now), or any whose athlete has since started another research run
 * (agent_onboarding or legacy onboarding). Releasing it would research her twice.
 */
const staleSignupResearch = () => sql`(${workflowRuns.process} = ${SIGNUP_RESEARCH_PROCESS} AND EXISTS (SELECT 1 FROM athletes a WHERE a.id = ${workflowRuns.athlete_id} AND (
  (${workflowRuns.created_by} = 'signup' AND a.status <> 'waitlisted')
  OR EXISTS (SELECT 1 FROM workflow_runs o WHERE o.athlete_id = a.id AND o.process IN (${AGENT_ONBOARDING_PROCESS}, 'onboarding') AND o.status <> 'canceled'))))`;

/** The held (queued) sign-up research runs, every process, oldest first; never a stale signup_research run; with `aheadOf`, only
 * the runs queued before that one (started earlier; equal start times broken by id), never itself. */
async function queuedRunIds(limit: number, ex: Ex = db, aheadOf?: string): Promise<string[]> {
  const rows = await ex.select({ id: workflowRuns.id }).from(workflowRuns)
    .where(and(eq(workflowRuns.status, "running"), signupResearchRun(), isHeld(), sql`NOT ${staleSignupResearch()}`,
      ...(aheadOf ? [sql`(${workflowRuns.started_at}, ${workflowRuns.id}) < (SELECT r.started_at, r.id FROM workflow_runs r WHERE r.id = ${aheadOf})`] : [])))
    .orderBy(asc(workflowRuns.started_at)).limit(limit);
  return rows.map((r) => r.id);
}

/** Cancel held signup_research runs nobody needs any more (staleSignupResearch), at most `limit`. Returns how many. */
async function cancelStaleQueued(limit: number): Promise<number> {
  const rows = await db.select({ id: workflowRuns.id }).from(workflowRuns)
    .where(and(eq(workflowRuns.status, "running"), isHeld(), staleSignupResearch())).limit(limit);
  for (const r of rows) await cancelRun(r.id);
  if (rows.length) logger.info({ canceled: rows.length }, "daily research cap: stale queued sign-up research canceled (promoted or researched elsewhere)");
  return rows.length;
}

/**
 * Researches in flight, not held: a sign-up research run with a SPENDING step open (ready or running):
 *   legacy onboarding        its research step (or the v3 identity step before it); afterwards it parks on the
 *                            greeting (greet, doors: await_human) for days, and that wait spends nothing;
 *   every other process      a step of kind 'model' (agent_onboarding's passes, merge, reveal, M.I.A., Brief and turns;
 *                            signup_research; lifecycle research_refresh). A run parked on agent onboarding's
 *                            conversation (await_human) or on its finish (code) reserves nothing.
 * Run status running OR waiting: a waiting run can still have a model sibling open, so the step decides, not the run.
 */
async function inFlightCount(ex: Ex = db): Promise<number> {
  const legacyResearching = sql`EXISTS (SELECT 1 FROM workflow_steps s WHERE s.run_id = ${workflowRuns.id} AND s.step IN ('identity_confirmed', 'research') AND s.status IN ('ready', 'running'))`;
  const modelStepOpen = sql`EXISTS (SELECT 1 FROM workflow_steps s WHERE s.run_id = ${workflowRuns.id} AND s.kind = 'model' AND s.status IN ('ready', 'running'))`;
  const [r] = await ex.select({ n: sql<number>`count(*)::int` }).from(workflowRuns)
    .where(and(inArray(workflowRuns.status, ["running", "waiting"]), signupResearchRun(), sql`NOT ${isHeld()}`,
      sql`((${workflowRuns.process} = 'onboarding' AND ${legacyResearching}) OR (${workflowRuns.process} <> 'onboarding' AND ${modelStepOpen}))`));
  return Number(r?.n ?? 0);
}

export interface CapRead { cap: number | null; spent: number; inFlight: number; queued: number; perOnboarding: number }

async function readCap(now: Date, ex: Ex = db, aheadOf?: string): Promise<CapRead> {
  const cap = dailyResearchCapMicroUsd();
  const perOnboarding = perRunReserveMicroUsd();
  if (cap === null) return { cap, spent: 0, inFlight: 0, queued: (await queuedRunIds(1, ex, aheadOf)).length, perOnboarding };
  // Sequential, not Promise.all: inside the lock's transaction they share one connection anyway.
  const spend = await signupSpendTodayMicroUsd(now, ex);
  const inFlight = await inFlightCount(ex);
  const queued = await queuedRunIds(1, ex, aheadOf);
  return { cap, spent: spend.total, inFlight, queued: queued.length, perOnboarding };
}

/**
 * Run `fn` inside a transaction holding the cap's advisory transaction lock (released at commit / rollback). A waiter
 * gives up after 5 s (lock_timeout) and throws: the callers then leave the run held, never start it.
 */
async function withCapLock<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_SIGNUP_RESEARCH_CAP.toString()}::bigint)`);
    return fn(tx);
  });
}

/** Move held runs' first steps to `now` (they start: the next claim, or the caller's kick, picks them up). */
async function releaseRuns(ex: Ex, runIds: string[], now: Date): Promise<void> {
  await ex.update(workflowSteps).set({ ready_at: now })
    .where(and(inArray(workflowSteps.run_id, runIds), eq(workflowSteps.status, "ready"), gte(workflowSteps.ready_at, HELD_READY_AT)));
}

/**
 * Admit a sign-up research run that was just created HELD: under the cap lock, start it now if there is room for it
 * and nobody else is queued ahead of it (first come, first served), else leave it held for the tick. Returns true when
 * it was started. FAILS CLOSED: any error leaves it held (false); the tick's release starts it once the budget reads.
 */
export async function admitHeldRun(runId: string, now: Date = runnerNow()): Promise<boolean> {
  try {
    const platform = await readPlatform(now);
    return await withCapLock(async (tx) => {
      const c = await readCap(now, tx, runId);
      if (c.queued > 0 || !hasRoom(c, c.inFlight)) return false;
      // The platform day cap too: no room there for this run's worst case => it stays queued for the tick.
      if (!platformHasRoom(platform, c.inFlight, c.perOnboarding)) {
        logger.info({ runId, platformSpentMicroUsd: platform?.spent ?? null, platformCapMicroUsd: platform?.cap ?? null }, "sign-up research queued: no room under the platform day cap");
        return false;
      }
      await releaseRuns(tx, [runId], now);
      return true;
    });
  } catch (err: any) {
    logger.warn({ runId, error: String(err?.message ?? err).slice(0, 200) }, "daily research cap read failed: research held (failing closed); the tick will retry");
    return false;
  }
}

const hasRoom = (c: Pick<CapRead, "cap" | "spent" | "perOnboarding">, inFlight: number) =>
  c.cap === null || c.spent + (inFlight + 1) * c.perOnboarding <= c.cap;

/**
 * Whether a NEW sign-up's research would be queued now (a read-only view; the start itself decides through
 * admitHeldRun, under the lock). False with no cap (decided before anything else is read). Fails CLOSED (true) on a
 * read error: nothing starts on a budget nobody could read.
 */
export async function shouldQueueNewResearch(now?: Date): Promise<boolean> {
  if (dailyResearchCapMicroUsd() === null) return false;
  try {
    const c = await readCap(now ?? runnerNow());
    return c.queued > 0 || !hasRoom(c, c.inFlight);
  } catch (err: any) {
    logger.warn({ error: String(err?.message ?? err).slice(0, 200) }, "daily research cap read failed (failing closed)");
    return true;
  }
}

/**
 * THE HARD STOP (owner, 3 Nov 2026). Every research process: a new run that is not created HELD is refused by the
 * workflow runner (startRun → researchCapRefusal) while the daily cap is spent. Sign-up research is created held and
 * admitted under the lock above, so it keeps "held, then released by the minute tick"; every other research start (the
 * lean refresh, the identity re-check, Mila's refresh_research, the agent research refresh, the legacy research_refresh
 * and onboarding runs, the v2 shadow) is refused.
 */
export const CAPPED_RESEARCH_PROCESSES: ReadonlySet<string> = new Set([
  ...SIGNUP_RESEARCH_PROCESSES, "agent_research_refresh", "lean_research_refresh", "research_v2_shadow",
]);

export interface ResearchCapRefusal { reason: "daily_cap" | "cap_unreadable"; nextAllowedAt: string }

/**
 * The ONE check behind the hard stop: null when a new research may start now, else why not. The cap unset ⇒ null (no
 * read). Refused when today's spend (the same count the sign-up cap reads: signupSpendTodayMicroUsd) is at or above
 * DAILY_RESEARCH_CAP_USD, or when a sign-up's research is already held by the cap (nobody jumps that queue). FAILS
 * CLOSED: a budget nobody could read is a refusal.
 */
export async function researchCapRefusal(now: Date = runnerNow(), read: (now: Date) => Promise<Pick<CapRead, "spent" | "queued">> = readCap): Promise<ResearchCapRefusal | null> {
  const cap = dailyResearchCapMicroUsd();
  if (cap === null) return null;
  try {
    const c = await read(now);
    if (c.spent >= cap || c.queued > 0) return { reason: "daily_cap", nextAllowedAt: nextUtcMidnight(now).toISOString() };
    return null;
  } catch (err: any) {
    logger.warn({ error: String(err?.message ?? err).slice(0, 200) }, "daily research cap read failed: research not started (failing closed)");
    return { reason: "cap_unreadable", nextAllowedAt: new Date(now.getTime() + 5 * 60_000).toISOString() };
  }
}

/** Whether this run is queued (held by the daily cap), and when it is expected to start at the latest. */
export async function researchQueueState(runId: string, now: Date = runnerNow()): Promise<{ queued: boolean; expectedBy: string | null }> {
  // Queued = the run is still running and every open step of it is held: a failed or canceled run's leftover held
  // rows, or a held step beside a sibling still running, are not "queued".
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "running"), isHeld()));
  const queued = Number(r?.n ?? 0) > 0;
  return { queued, expectedBy: queued ? nextUtcMidnight(now).toISOString() : null };
}

/**
 * Start queued researches (every sign-up research process) while there is room, oldest first, at most `limit` per
 * call, under the same cap lock as a sign-up's admit. With the cap unset every queued research is released (a cap that
 * was lifted). Returns how many were released; the caller's tick claims them.
 */
export async function releaseQueuedOnboardings(now: Date = runnerNow(), limit = RELEASE_BATCH): Promise<number> {
  await cancelStaleQueued(limit);
  await logHeldTooLong(now).catch(() => undefined);
  const platform = await readPlatform(now);
  const out = await withCapLock(async (tx) => {
    const ids = await queuedRunIds(limit, tx);
    if (!ids.length) return null;
    const c = await readCap(now, tx);
    let inFlight = c.inFlight;
    const release: string[] = [];
    for (const id of ids) {
      // Both caps: this one's room AND the platform day cap's headroom (spend lands only when a run ends, so each
      // released run is reserved at its worst case there too; an unreadable platform total releases nothing).
      if (!hasRoom(c, inFlight) || !platformHasRoom(platform, inFlight, c.perOnboarding)) break;
      release.push(id);
      inFlight++;
    }
    if (release.length) await releaseRuns(tx, release, now);
    return { released: release.length, c };
  });
  if (!out?.released) return 0;
  logger.info({ released: out.released, spentMicroUsd: out.c.spent, capMicroUsd: out.c.cap }, "daily research cap: queued researches released");
  return out.released;
}
