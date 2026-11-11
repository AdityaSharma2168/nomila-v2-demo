/**
 * studioFlag — how every BOOLEAN Studio flag reads, and the one master that can turn them all on (PR 20,
 * docs/probes/ship.md, ADI-S20-GO).
 *
 * ─── THE RULE ─────────────────────────────────────────────────────────────────────────────────────
 *
 *   STUDIO_ALL_ON unset (or anything but exactly "true"): a flag is on only when its own variable is exactly
 *   "true" — every flag's rule before this file existed, byte for byte.
 *   STUDIO_ALL_ON === "true": a flag is on unless its own variable is exactly "false". Unset, "1", "TRUE" all
 *   read on; one explicit "false" keeps that one flag off under the master.
 *
 * ─── WHAT IT COVERS, AND WHAT IT NEVER TOUCHES ────────────────────────────────────────────────────
 *
 * Every boolean Studio flag reads through here — ADI-S20-GO lists them, twenty-eight, including the ones that
 * spend in the background (STUDIO_VIDEO_ENRICH), off the day cap (STUDIO_AGENT_RETRY, STUDIO_DIRECTION_MOMENTS)
 * or claim a fact about the bucket (STUDIO_STITCH_BEDS_READY). studioFlag.test.ts holds the list and fails
 * when a boolean read anywhere in server/studio bypasses this helper.
 *
 * The VALUE flags never read through here: STUDIO_PUBLISH_MODE (off | dry | live — a master cannot choose
 * "live" for anyone), STUDIO_MAX_JOB_USD, STUDIO_MAX_DAY_USD, STUDIO_ENRICH_DAILY_CAP_USD and
 * STUDIO_VIDEO_ENRICH_MAX_RUN_USD. Caps travel WITH the master as their own lines (the runbook), never through it.
 *
 * The GOVERNANCE flags never read through the master either: STUDIO_CREATIVE_INTENTS and
 * STUDIO_CAMPAIGN_GOVERNANCE open surfaces where an athlete governs work (confirming a creative interpretation,
 * approving a campaign spec, ending a campaign) and where Nomila records her decisions as durable intelligence.
 * Opening one of those is a decision, never a side effect of turning Studio's features on for testing — so each
 * is on only when its own variable is exactly "true", with or without the master (`studioGovernanceFlag`). The
 * same strict reading is what the Brain's execution-readiness projection uses, so the two can never disagree.
 *
 * Read at call time, like every STUDIO_* flag, so a test can set the environment between calls. No imports:
 * config.ts, qa/record.ts, enrich/config.ts and video/beds.ts all read through it without a cycle.
 *
 * ⚠️ MUTATIONS (studioFlag.test.ts): the helper ignoring the master — "under the master …" rows red by name; the
 * helper treating unset as on without the master — "master unset: … byte-identical" rows red; STUDIO_PUBLISH_MODE
 * wired through it — "a value flag does not move under the master" reds.
 */

/** Whether the master is on. Exactly "true", as every flag was before it. */
export const studioAllOn = (): boolean => process.env.STUDIO_ALL_ON === "true";

/** One boolean flag's value under the master. Pass the variable itself: `studioFlag(process.env.STUDIO_X)`. */
export const studioFlag = (value: string | undefined): boolean =>
  value === "true" || (studioAllOn() && value !== "false");

/**
 * A GOVERNANCE flag: on only when its own variable is exactly "true". The master never turns one on. Pass the
 * variable itself: `studioGovernanceFlag(process.env.STUDIO_X)`.
 *
 * Also the flags that change what she sees or what a spend asks for, and so wait for Adi's walk before any master
 * reaches them (quality-scrappy, ADI-QS-GO; unified here by ADI-QS-10): STUDIO_DIALECTS, STUDIO_OUTPUT_GATE,
 * STUDIO_FINISHING. Moving one under the master is moving its read to `studioFlag`, in a PR of its own.
 */
export const studioGovernanceFlag = (value: string | undefined): boolean => value === "true";
