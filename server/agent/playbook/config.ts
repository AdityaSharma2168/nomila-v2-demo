/**
 * agent/playbook/config.ts — the shared content playbook's flag and limits, in one place (design "Moments → post
 * kits" §5/§13/§15). Getters, so env is read at call time; the same pattern as agent/moments/config.ts.
 *
 * AGENT_PLAYBOOK — the DAILY sweep (POST /api/internal/playbook-refresh-cron) refreshes content_playbooks: one
 * OpenAI fast-tier call with web search per (sport, stage, platform) key found in the live roster whose active row
 * is stale. Off unless exactly "true" (off in BOTH Cloud Run yamls until the owner turns it on).
 *
 * The sweep runs daily, not monthly: a key is only actually refreshed once a month, on the UTC calendar-month
 * rollover (triggers.ts isStale — review fix: an EARLIER version of this file also stacked a flat day-count
 * threshold on top of the month check, which just meant most keys refreshed TWICE a month; the month check alone is
 * both necessary and sufficient for "at least once a month, every month"). Checking daily just means the staleness
 * test runs more often; it does not raise the refresh rate or the cost below. A key that just failed backs off for
 * FAILURE_BACKOFF_DAYS rather than being retried on every subsequent daily check.
 *
 * Cost (design §15): ≈$0.06–0.12 a key a month — mostly the web_search fee ($0.01 a call, a handful of calls); tokens
 * are near-free on the fast tier, and the cost is SHARED across every athlete at that key, not paid per athlete.
 * Bounds, mirroring agent/moments/config.ts:
 *   - per key, per run: at most PLAYBOOK_MAX_SEARCHES searches (default 8) and PLAYBOOK_MAX_OUTPUT_TOKENS output
 *     tokens (default 3,000); AGENT_PLAYBOOK_RUN_CAP_USD (default 0.25) is the worst case one key's refresh may cost
 *     — a key whose actual cost comes in over this is logged, never retried;
 *   - per sweep: at most PLAYBOOK_MAX_KEYS_PER_RUN keys (default 50) AND at most RUN_BUDGET_MS of wall-clock time
 *     (default 25 minutes), whichever is reached first, so one cron call stays well inside its 1800s attempt
 *     deadline even on a roster with many distinct keys.
 */
import { readCap } from "../../lib/spendCap";

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function agentPlaybookEnabled(): boolean {
  return process.env.AGENT_PLAYBOOK === "true";
}

export const PLAYBOOK_SKILL_ID = "playbook";

export const PLAYBOOK = {
  /** Searches one refresh call may run (the provider-side max_tool_calls). */
  get MAX_SEARCHES(): number { return Math.floor(positive("AGENT_PLAYBOOK_MAX_SEARCHES", 8)); },
  /** The model's output ceiling. */
  get MAX_OUTPUT_TOKENS(): number { return Math.floor(positive("AGENT_PLAYBOOK_MAX_OUTPUT_TOKENS", 3_000)); },
  /** The worst case one key's refresh may cost (USD → micro-dollars) — logged, not pre-checked (no per-key spend history exists; the hard bound is MAX_SEARCHES / MAX_OUTPUT_TOKENS). */
  get RUN_RESERVE_MICRO_USD(): number { return Math.round(readCap("AGENT_PLAYBOOK_RUN_CAP_USD", 0.25, 2.5) * 1_000_000); },
  /** Keys refreshed in one sweep call (the rest wait for tomorrow's sweep or a manual run). */
  get MAX_KEYS_PER_RUN(): number { return Math.floor(positive("AGENT_PLAYBOOK_MAX_KEYS_PER_RUN", 50)); },
  /** Wall-clock budget for one sweep call (ms): stop STARTING new keys once this much time has passed, well inside
   * the scheduler's 1800s attempt deadline (provision-schedulers.sh). A key already in flight still finishes. */
  get RUN_BUDGET_MS(): number { return Math.floor(positive("AGENT_PLAYBOOK_RUN_BUDGET_MS", 25 * 60_000)); },
  /** A key that just failed (store.ts recordPlaybookFailure) is skipped by the sweep for this many days, rather than
   * paying for (and likely repeating) the same failure on every subsequent daily check. Floored at 1: a fractional
   * env value (e.g. "0.5") would otherwise floor to 0 and back off for no time at all. */
  get FAILURE_BACKOFF_DAYS(): number { return Math.max(1, Math.floor(positive("AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS", 3))); },
} as const;
