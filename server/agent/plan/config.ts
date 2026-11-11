/**
 * agent/plan/config.ts — the plan step's flag and limits, in one place. Getters, so env is read at call time.
 *
 * AGENT_PLAN — the plan step runs (triggers start plan_refresh runs) and its app routes are mounted. Off unless exactly
 * "true" (not set in either Cloud Run yaml: dark in dev and prod until someone turns it on).
 *
 * Cost (design, 9 Oct 2026): ≈ $0.09 a run; typical 2 runs a week. The hard ceiling per run is max_output_tokens
 * (12,000 ≈ $0.15 at the reasoning tier's price); per athlete, AGENT_PLAN_WEEK_CAP_USD (default 1.00) summed over the
 * plan runs of the last 7 days; and the harness's AGENT_DAY_COST_CAP_USD still applies to everything the athlete runs.
 */
import { readCap } from "../../lib/spendCap";
import { AGENT_CAP_MAX } from "../config";
import { GOAL_REPEATS, type Decision, type GoalRepeats } from "../../../shared/agent";
import type { GoalDecisionDetail } from "../../../shared/plan";

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function agentPlanEnabled(): boolean {
  return process.env.AGENT_PLAN === "true";
}

export const PLAN_SKILL_ID = "plan";

/**
 * A goal's standing trigger (plan 1.5.0): its recommendation's detail.repeats, read defensively; null for a one-off, a
 * row written before 1.5.0 or anything not on the list. Here, beside the flag, so the triggers read it without loading
 * the input builder.
 */
export function repeatsOf(d: Pick<Decision, "detail"> | null | undefined): Exclude<GoalRepeats, "once"> | null {
  const r = (d?.detail as Partial<GoalDecisionDetail> | undefined)?.repeats;
  return typeof r === "string" && r !== "once" && (GOAL_REPEATS as readonly string[]).includes(r) ? (r as Exclude<GoalRepeats, "once">) : null;
}
export const PLAN_PROCESS = "plan_refresh";

export const PLAN = {
  /** The model's output ceiling: the hard per-run cost bound. */
  get MAX_OUTPUT_TOKENS(): number { return Math.floor(positive("AGENT_PLAN_MAX_OUTPUT_TOKENS", 12_000)); },
  /** The worst case one run may cost (USD → micro-dollars): a run starts only if this still fits under the week cap. */
  get RUN_RESERVE_MICRO_USD(): number { return Math.round(readCap("AGENT_PLAN_RUN_CAP_USD", 0.15, 1.5) * 1_000_000); },
  /** Per athlete, summed over plan runs in the last 7 days (USD → micro-dollars). */
  get WEEK_CAP_MICRO_USD(): number { return Math.round(readCap("AGENT_PLAN_WEEK_CAP_USD", 1, 10) * 1_000_000); },
  /** The harness's per-athlete per-UTC-day cap (shared with every run). */
  get DAY_CAP_MICRO_USD(): number { return Math.round(readCap("AGENT_DAY_COST_CAP_USD", 5, AGENT_CAP_MAX.DAY_USD) * 1_000_000); },
  /** Events within this long of the last run are coalesced into one run after it. */
  COALESCE_MS: 6 * 60 * 60 * 1000,
  /** At most this many scheduled runs, and this many event (or chat) runs, per athlete per 7 days. */
  MAX_SCHEDULED_PER_WEEK: 1,
  MAX_EVENT_PER_WEEK: 4,
  /** Dated events the plan reads, and Home's "Coming up", look this far ahead. */
  HORIZON_DAYS: 60,
  /** The daily sweep's window for an event coming up with nothing due before it. */
  EVENT_SWEEP_MIN_DAYS: 3,
  EVENT_SWEEP_MAX_DAYS: 14,
  /** A skipped or dropped recommendation is not suggested again for this long. */
  QUIET_DAYS: 90,
  /** A reused (unchanged-input) plan is trusted for at most this long. */
  REUSE_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  /**
   * Input caps (design "Inputs"). events and moments fit a full moments scan (moments 1.2.0: up to 12 moments, in the
   * same 60-day window) beside the athlete's own schedule.
   */
  CAPS: { goals: 8, decisions: 40, decisionDays: 60, preferences: 30, events: 24, moments: 12, threads: 8, facts: 80, briefChars: 10_000, miaChars: 10_000, whatWorks: 24 },
} as const;
