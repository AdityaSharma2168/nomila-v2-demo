/**
 * agent/moments/config.ts — the weekly moments scan's flag and limits, in one place. Getters, so env is read at call time.
 *
 * AGENT_MOMENTS — the first scan at onboarding runs, and the daily sweep (POST /api/internal/moments-scan-cron)
 * enqueues weekly moments_scan runs. Off unless exactly "true": "true" in the dev Cloud Run yaml (DEV ONLY), "false"
 * in prod.
 *
 * Cost (design "Moments → post kits" §15): ≈ $0.06–0.12 a scan — mostly the web_search fee ($0.01 a call, 5–10 calls);
 * tokens are near-free on the fast tier. Bounds, mirroring the plan step (agent/plan/config.ts):
 *   - per run: at most AGENT_MOMENTS_MAX_SEARCHES searches (default 10) and AGENT_MOMENTS_MAX_OUTPUT_TOKENS output
 *     tokens (default 6,000); AGENT_MOMENTS_RUN_CAP_USD (default 0.25) is the worst case reserved before a run starts;
 *   - per athlete: AGENT_MOMENTS_WEEK_CAP_USD (default 0.50) summed over the moments runs of the last 7 days, and the
 *     harness's AGENT_DAY_COST_CAP_USD (default 5.00) over everything the athlete ran today.
 */
import { readCap } from "../../lib/spendCap";
import { AGENT_CAP_MAX } from "../config";

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function agentMomentsEnabled(): boolean {
  return process.env.AGENT_MOMENTS === "true";
}

export const MOMENTS_SKILL_ID = "moments";
export const MOMENTS_PROCESS = "moments_scan";

export const MOMENTS = {
  /** Searches one scan may run (the provider-side max_tool_calls). */
  get MAX_SEARCHES(): number { return Math.floor(positive("AGENT_MOMENTS_MAX_SEARCHES", 10)); },
  /** The model's output ceiling. */
  get MAX_OUTPUT_TOKENS(): number { return Math.floor(positive("AGENT_MOMENTS_MAX_OUTPUT_TOKENS", 6_000)); },
  /** The worst case one scan may cost (USD → micro-dollars): a scan starts only if this still fits under both caps. */
  get RUN_RESERVE_MICRO_USD(): number { return Math.round(readCap("AGENT_MOMENTS_RUN_CAP_USD", 0.25, 2.5) * 1_000_000); },
  /** Per athlete, summed over moments runs in the last 7 days (USD → micro-dollars). */
  get WEEK_CAP_MICRO_USD(): number { return Math.round(readCap("AGENT_MOMENTS_WEEK_CAP_USD", 0.5, 5) * 1_000_000); },
  /** The harness's per-athlete per-UTC-day cap (shared with every run). */
  get DAY_CAP_MICRO_USD(): number { return Math.round(readCap("AGENT_DAY_COST_CAP_USD", 5, AGENT_CAP_MAX.DAY_USD) * 1_000_000); },
  /**
   * How far ahead a scan looks: the same window as the plan's dated events (agent/plan/config.ts HORIZON_DAYS), so every
   * moment a scan writes is one the plan can time a post to. The searches, not the window, set a scan's cost.
   */
  HORIZON_DAYS: 60,
  /** A scan returns at most this many moments (moments 1.2.0: every real, dated moment in the window, up to 12). */
  MAX_MOMENTS: 12,
  /** One scheduled scan per athlete per this many days. */
  SCAN_EVERY_DAYS: 7,
  /** Input caps: the athlete's facts a moment may rest on, deals, and the moments already on file. */
  CAPS: { facts: 40, deals: 12, existing: 30 },
} as const;
