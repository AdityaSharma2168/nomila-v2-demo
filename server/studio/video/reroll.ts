/**
 * reroll.ts — what a failed clip verdict RECOMMENDS, and why nothing acts on it.
 *
 * ─── ⚠️  THIS RECORDS A DECISION. IT DOES NOT TAKE ONE. ────────────────────────────────────────
 *
 * When clip QA fails, this produces a structured recommendation and the runner writes it onto the
 * verdict. No provider call, no new job row, no retry. A re-roll is a NEW PREVIEW, a NEW APPROVAL
 * and a NEW JOB ROW, started from the client — and three rules already written in this codebase say
 * it has to be:
 *
 *   "A failed job stays failed. Re-running is a NEW job with its own row and its own cost line."
 *                                                                          — studio/jobs.ts:174
 *   "a re-run is a new check and a new cost line — never a silent retry against the same approval"
 *                                                                        — studio/generate.ts:1437
 *   "the approval is consumed before the call on purpose (it is the double-tap guard) ... a retry
 *    was a fresh approval at the full quote"                               — studio/generate.ts:910
 *
 * ─── AND THE ONE THAT DECIDES IT, WHICH IS ABOUT MONEY RATHER THAN TASTE ───────────────────────
 *
 * `spentTodayUsd` sums `cost_estimated_usd` over `generation_jobs`, and the quote is BANKED AT
 * INSERT (`createGenerationJob`). An in-runner re-roll reusing the same row would spend a second
 * $1.20 that the rolling 24-hour ceiling never sees. That is not a preference about UX; it is the
 * exact failure the day cap exists to prevent, and no amount of care inside the runner can put the
 * money back on a ledger that was never told about it.
 *
 * `generation_jobs.attempts` cannot be borrowed either: it is the LEASE counter, incremented at
 * claim and bounded by `maxAttempts()`. A re-roll that touched it would move a clip toward "gave up
 * after 5 attempts" for having been re-rolled — conflating "the instance died" with "the clip was
 * bad".
 *
 * ─── NO PROSE ──────────────────────────────────────────────────────────────────────────────────
 *
 * This returns FACTS — which checks failed, at which frames, what a re-run would cost — and not a
 * sentence to show her. Ask copy is a product decision that belongs with the person who owns the
 * product's voice (wave-d parked exactly such a note for that reason), and a phrase invented here
 * would be one nobody reviewed, shipped inside a jsonb where nobody would find it.
 */
import type { CheckName, CreativeQaVerdict } from "../qa/verdict";
import type { ShotType } from "../types";

/** One gating check that failed, and where in the clip it did. */
export interface RerollReason {
  check: CheckName;
  /** The sampled frame that gave the worst answer. Null when no frame could be attributed. */
  atSec: number | null;
  /** The check's own summary, verbatim. Data, never instruction. */
  summary: string;
}

export interface RerollAdvice {
  /** What kind of segment this was, so a surface knows what it would be re-rolling. */
  shotType: ShotType | null;
  reasons: RerollReason[];
  /**
   * What a re-run would cost, in USD — the SAME figure this clip was quoted, because a re-roll of
   * the same brief is the same job at the same price.
   *
   * ⚠️ NULL IS "WE DO NOT KNOW", NEVER ZERO. `studio/pricing.ts` refuses a confident zero and so
   * does this: a surface that showed $0.00 for a clip that costs $1.20 would be worse than one that
   * showed nothing.
   */
  quoteUsd: number | null;
  /**
   * Always false. On the record so that a reader of a stored verdict learns the posture from the
   * verdict itself rather than from this file — and so that the day anything DOES act on this, the
   * change is visible in the record's shape rather than only in a diff.
   */
  acted: false;
}

/**
 * Only the checks `overall` is allowed to summarise can justify spending her money again.
 *
 * `marks` is excluded for the reason it is advisory everywhere else: 16 false positives against 6
 * true negatives on the 36-row corpus. A re-roll recommendation driven by a check that fires on
 * three good clips in four would be a bill for nothing, four times out of five.
 */
const CAN_RECOMMEND: readonly CheckName[] = [
  "identity",
  "anatomy",
  "adherence",
  "text",
];

export interface RerollContext {
  shotType: ShotType | null;
  /** `generation_jobs.cost_estimated_usd` for the clip being inspected. */
  quotedUsd: number | null;
}

/**
 * A recommendation, or null when there is nothing to recommend.
 *
 * NULL ON ANYTHING BUT `fail`, and that includes `flag`. A flag means "worth a human's attention",
 * which is not the same as "worth her money" — and `unknown` is emphatically not a reason either:
 * a check that could not look has found nothing wrong, and charging her again on that basis would
 * invert the whole point of `unknown` being a distinct value.
 */
export function rerollFor(
  verdict: CreativeQaVerdict,
  ctx: RerollContext,
): RerollAdvice | null {
  if (verdict.subject !== "clip") return null;
  if (verdict.overall !== "fail") return null;

  const reasons: RerollReason[] = [];
  for (const name of CAN_RECOMMEND) {
    const result = verdict.checks[name];
    if (result.status !== "fail") continue;
    reasons.push({
      check: name,
      atSec: worstFrameSec(verdict, name),
      summary: result.summary,
    });
  }

  // A `fail` overall with no failing GATING check is not reachable through `combine`, and it is
  // still handled: recommending a re-roll with no stated reason would be asking her to pay for a
  // verdict nobody can read.
  if (!reasons.length) return null;

  return {
    shotType: ctx.shotType,
    reasons,
    quoteUsd:
      typeof ctx.quotedUsd === "number" && Number.isFinite(ctx.quotedUsd)
        ? ctx.quotedUsd
        : null,
    acted: false,
  };
}

/**
 * Which sampled frame gave this check its worst answer.
 *
 * Read off the per-frame records rather than parsed back out of the roll-up's summary string — the
 * summary is formatted for a human and a regex over it would break the first time the wording moved.
 * `marks` is the only per-frame check that can be null (the anchor has nothing to compare against),
 * and it is not in CAN_RECOMMEND, so the lookup below never has to reason about that.
 */
function worstFrameSec(
  verdict: CreativeQaVerdict,
  check: CheckName,
): number | null {
  const frames = verdict.clip?.frames ?? [];
  const RANK = { fail: 2, flag: 1, pass: 0, unknown: 0 } as const;
  let best: { timeSec: number; rank: number } | null = null;
  for (const f of frames) {
    const result =
      check === "anatomy"
        ? f.checks.anatomy
        : check === "text"
          ? f.checks.text
          : null;
    if (!result) continue;
    const rank = RANK[result.status];
    if (rank === 0) continue;
    if (!best || rank > best.rank) best = { timeSec: f.timeSec, rank };
  }
  return best?.timeSec ?? null;
}
