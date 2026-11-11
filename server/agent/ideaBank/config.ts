/**
 * agent/ideaBank/config.ts — the idea bank's limits, in one place (design "Moments → post kits" v2 §6–§7, build step 8).
 *
 * The idea bank is always on (AGENT_IDEA_BANK, retired 2 Nov 2026): the plan reads the idea bank, the content pillars
 * and the shared playbook, and writes back to the bank (an idea used, skipped or adapted; a fresh evergreen idea); the
 * weekly moments scan files each moment's candidate post in the bank too; the reverse pass (post-kit/ideas) is shown
 * the content pillars.
 *
 * Cost (design §15): $0 — no new model call. The bank rides on calls that already run (the scan, the reverse pass, the
 * plan); the plan's input grows by at most BANK_LINES + MISSED_LINES ideas, a few pillars and one playbook line per
 * platform, inside the plan's own caps (AGENT_PLAN_WEEK_CAP_USD, max_output_tokens).
 */


export const IDEA_BANK = {
  /** Ideas the plan is shown besides the moments' own (timely soonest first, then evergreen newest first). */
  BANK_LINES: 8,
  /** Slots reserved for each kind (timely, evergreen) within BANK_LINES; a kind that is short gives its spare to the other. */
  SLOTS_PER_KIND: 4,
  /** Missed timely ideas the plan may adapt to a later event (newest moment first). */
  MISSED_LINES: 5,
  /** A timely idea counts as missed (adaptable) for this long after its moment went. */
  MISSED_DAYS: 30,
  /** The pillar rotation reads post actions this far back (design §7: "the last 30 days of decisions"). */
  PILLAR_LOOKBACK_DAYS: 30,
  /** A conditional write to an idea row is retried on a fresh read at most this many times. */
  WRITE_ATTEMPTS: 3,
  /**
   * How long a plan run's claim on a missed idea (an idea move adapting it) stays live without its new row: past it, the
   * run is taken to have crashed and another may adapt the idea. A plan's apply runs in seconds; this is far past that.
   */
  CLAIM_LEASE_MS: 15 * 60 * 1000,
} as const;
