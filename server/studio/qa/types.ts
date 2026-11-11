/**
 * studio/qa/types — the shape every check answers in, and the vocabulary of a verdict.
 *
 * ─── FOUR OUTCOMES, AND "unknown" IS NOT A PASS ────────────────────────────────────────────────
 *
 * The whole reason PR Q exists is that things shipped looking fine: 2.2's swoosh never appeared and
 * the job reported success, 1.5a came back with three hands and "overreach 0, padSpill 0, mask
 * used, job succeeded". Every guard passed because every guard was geometric and none of them
 * inspected the picture. A QA stage that answers "pass" when it could not see is the same bug in a
 * new coat, so a check that did not run, timed out, or could not find what it needed answers
 * `unknown` — a distinct value that is reported, never folded into `pass`.
 *
 *   pass     the check looked and found nothing wrong
 *   flag     something worth a human's attention
 *   fail     something a human would call broken
 *   unknown  the check could not answer — no face in frame, a timeout, an unparseable reply
 *
 * ─── THE VERDICT GATES NOTHING, DELIBERATELY AND FOR NOW ───────────────────────────────────────
 *
 * Nothing here blocks, retries or alters a generation, and the call site in studio/generate.ts is
 * observation-only by construction: it writes to the record and its return value is discarded.
 * Enforcement is a later flag and a DIFFERENT call site, not an evolution of this one. Build the
 * measurement honestly first — a gate calibrated on a stage nobody has watched run is a gate
 * calibrated on nothing.
 */
import type { QaSpend } from "./cost";

export type CheckStatus = "pass" | "flag" | "fail" | "unknown";

/**
 * How bad each status is, for any caller that has to pick the worst of several.
 *
 * ⚠️ `unknown` RANKS 0, THE SAME AS `pass`, AND THAT IS NOT IT BEING TREATED AS A PASS. It means a
 * check that could not answer does not drag a verdict down and does not lift one either — it is
 * carried separately, as its own count, which is the whole distinction this file opens with. A
 * reader picking the worst of several statuses gets the worst ANSWER; the fact that something went
 * unanswered has to be reported beside it, never inside it.
 *
 * It lives HERE, beside the vocabulary it orders, rather than in qa/verdict.ts where it started.
 * Two things now need it — the verdict's own `combine` across checks, and video QA's roll-up of one
 * check across sampled frames (qa/videoClip.ts) — and a four-entry ordering restated in two places
 * is exactly the shape that drifts. Same lesson the interpreter learned the expensive way: the
 * classifier's vocabulary is not private to the classifier.
 */
export const STATUS_RANK: Record<CheckStatus, number> = {
  pass: 0,
  unknown: 0,
  flag: 1,
  fail: 2,
};

/** What every check returns. `status` is the verdict; the rest is why, and what it cost. */
export interface CheckResult<T> {
  status: CheckStatus;
  /** One short human sentence. Goes on the record; read by whoever is deciding about enforcement. */
  summary: string;
  /** The check's own measurements — the numbers a later calibration will be recomputed from. */
  detail: T | null;
  /** Null unless the check could not run. Present means `status` is "unknown". */
  error: string | null;
  spend: QaSpend;
  latencyMs: number;
}

export const unknownResult = <T>(
  summary: string,
  error: string | null,
  spend: QaSpend,
  latencyMs: number,
): CheckResult<T> => ({
  status: "unknown",
  summary,
  detail: null,
  error,
  spend,
  latencyMs,
});

/** Where a requested mark change came from: her words, our suggestion, or the ad's brand (plan v2 N7). */
export type MarkSource = "yours" | "suggested" | "brand";

/**
 * What an interpreted edit asked to happen to brand marks (the interpreter, I.5; plan v2 N7, C-6) — read
 * off the frozen interpretation (studio/interpret/markProvenance.ts), never from a model. Brands as the
 * classifier's BRANDS writes them, lowercase.
 */
export interface MarkProvenance {
  /** Brands whose marks the edit brings in: a swap to the brand, a design or a worn add naming it. */
  arrivals: { brand: string; source: MarkSource }[];
  /** Brands whose marks the edit takes away: a swapped item's old brand, a removal, an exclusion. */
  departures: { brand: string; source: MarkSource }[];
}

/**
 * The two frames a check compares.
 *
 * `source` IS THE CHAIN ROOT, always — never the immediately preceding step. A chain of edits each
 * measured against its own parent reports four small, innocent deltas and never notices that the
 * fourth output no longer resembles the photograph the athlete uploaded. Measured against the root,
 * cumulative drift is visible in the number itself. `qa/chain.ts` walks `derived_from_asset_id` to
 * find it; this type just carries the result so no check can accidentally use a parent.
 */
export interface ComparisonPair {
  /** The original photograph at the root of the edit chain. */
  sourceAssetId: string | null;
  sourceBytes: Buffer;
  sourceMimeType: string;
  /** The generated image being inspected. */
  outputAssetId: string | null;
  outputBytes: Buffer;
  outputMimeType: string;
  /** How many edits separate them. 1 is a direct edit; >1 means cumulative drift is in play. */
  chainDepth: number;
  /** Her instruction for THIS step, verbatim. Untrusted — always delimited before it reaches a prompt. */
  instruction: string;
  /**
   * Which brand marks the edit asked to bring in or take away, and who asked — only on a job the
   * interpreter proposed (qa/marks.ts). Absent on every other job, and then marks are judged exactly as
   * they were before it existed.
   */
  provenance?: MarkProvenance;
}
