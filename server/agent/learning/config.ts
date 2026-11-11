/**
 * agent/learning/config.ts — the learning loop's flag and numbers (design "What works for you", 16 Oct 2026; L1).
 *
 * AGENT_LEARNING_LOOP — the nightly learning job (link → measure → judge → weekly summary → one message for an
 * exceptional post). Off unless exactly "true". DEV ONLY (gcp/cloud-run-dev.yaml); not in prod.
 *
 * Pure: no database. Nothing here names an athlete, sport, school or brand.
 */

export function agentLearningLoopEnabled(): boolean {
  return process.env.AGENT_LEARNING_LOOP === "true";
}

/** detail.kind of the loop's exceptional-post decision (job.ts writes it; wins.ts reads it back for Home v3). */
export const EXCEPTIONAL_DETAIL_KIND = "exceptional_post";

export const LEARNING = {
  /** The skill id the loop writes its own decisions under (the exceptional-post message). */
  SKILL_ID: "learning",
  /** The athlete's baseline: the athlete's own posts on that platform over this many days, by metric (medians). */
  BASELINE_DAYS: 90,
  /** A post counts in a baseline or the summary once it is this old (its 7-day reading is in). */
  SETTLED_DAYS: 7,
  /** The two readings of a post: about 2 days and about 7 days after posting. */
  CHECKPOINTS: [2, 7] as const,
  /** A reading at day N uses the latest observation up to N + this many days (the sync is nightly). */
  READING_SLACK_DAYS: 1,
  /** Fewer posts than this in the athlete's baseline for a metric: that metric is not judged. */
  MIN_BASELINE_POSTS: 5,
  /** The athlete's own data leads a line (format, platform …) from this many measured posts; below it the playbook leads. */
  LEADS_AT: 8,
  /** The plan, Understand and chat read a summary line only from this many posts (below it there is nothing to say yet). */
  SHOW_AT: 3,
  /** Only posts first seen this recently are linked to a plan action (older ones are measured, never linked). */
  LINK_LOOKBACK_DAYS: 30,
  /** A post action can only be linked to a post within this many days either side of its due date. */
  LINK_WINDOW_DAYS: 3,
  /** Post actions created this long ago or less are linking candidates. */
  ACTION_LOOKBACK_DAYS: 120,
  /** The judge's bands, on the median of the athlete's metric ratios: ≥ worked, ≤ did not work, else mixed. */
  WORKED_AT: 1.25,
  DID_NOT_WORK_AT: 0.75,
  /** Exceptional: at least this many times the athlete's usual reach or saves. */
  EXCEPTIONAL_RATIO: 3,
  /** …and at least this raw number (3 saves against a usual 1 is not news). */
  EXCEPTIONAL_MIN_VALUE: 5,
  /** Only a post this young is news (and at least the first checkpoint old). */
  EXCEPTIONAL_MAX_AGE_DAYS: 8,
  /** At most one exceptional-post message in this many days. */
  EXCEPTIONAL_EVERY_DAYS: 7,
  /** The weekly summary fact is rewritten when the last one is at least this old. */
  SUMMARY_EVERY_DAYS: 7,
} as const;
