/**
 * studio/refusal — telling "this route will never make that" apart from "try again".
 *
 * ─── THE ONE FACT THAT MATTERS ──────────────────────────────────────────────────────────────────
 *
 * Every video refusal in this repo is currently `provider_error`. Veo's safety filter, Seedance's
 * flat rejection of real people, a 503 and a malformed response all arrive at `failJob` as the same
 * code carrying a different sentence — so nothing downstream can decide anything, and a retry loop
 * built on top of that is a loop that re-buys a refusal the provider will always give.
 *
 * There are two genuinely different refusals here, and the difference is whether the provider RAN:
 *
 *   content_blocked    it looked at the INPUT and would not take it. The identical request gets the
 *                      identical answer, forever. Seedance answers real-person image-to-video this
 *                      way 6 of 6 — `InputImageSensitiveContentDetected.PrivacyInformation`, a
 *                      stated BytePlus policy (docs/probes/kling-moderation.md §1). Never retry.
 *
 *   content_filtered   it generated something and its OUTPUT filter took the result. The same
 *                      request can produce a different outcome, so a retry is meaningful. This is
 *                      the shape kling-moderation.md §5 calls "an occasional refusal, which a job
 *                      can surface and a human can retry", and the same section's closing line —
 *                      "not a reason to remove refusal handling from the path" — is why this file
 *                      exists rather than a `catch` that swallows.
 *
 * ⚠️ A `content_filtered` RETRY IS NOT FREE. The provider ran the model and billed for it; the
 * filtered clip is money already spent, and a re-roll spends again. Worse, `spentTodayUsd`
 * (studio/jobs.ts) sums `generation_jobs.cost_estimated_usd` per ROW, and a retry reuses the row —
 * so the second clip is spend the daily ceiling never sees. Anything that automates a retry on this
 * code must be bounded and must be flagged off until the rate has been measured.
 *
 * ─── WHAT THIS FILE WILL NOT DO ─────────────────────────────────────────────────────────────────
 *
 * ⚠️ IT DOES NOT CLASSIFY ON VEO'S NUMERIC SUPPORT CODES. Google returns them in
 * `raiMediaFilteredReasons` ("Support Codes: …"), and nobody on this project has yet seen one in a
 * real response — so a table of them here would be a table of guesses with a provider's name on it.
 * The structural facts below are ones the wire shape itself establishes. When a support code is
 * actually observed, THIS is the function it gets added to, with the response that produced it
 * quoted in the test.
 *
 * ─── PURE, AND THAT IS THE TESTABLE SEAM ────────────────────────────────────────────────────────
 *
 * No network, no adapter, no `GenerationError`. It takes the shape a poll already has in hand and
 * returns a code, so every wire shape either provider can produce is a jest case with no fetch.
 * The adapters call it; the runner reads the code off the error it throws.
 */

import type { GenerationErrorCode } from "./types";

/** The two refusal codes this module decides between, plus the fallback it leaves alone. */
export type RefusalCode =
  | "content_blocked"
  | "content_filtered"
  | "provider_error";

/**
 * What a poll has in hand when something went wrong, from either provider.
 *
 * Every field optional: Vertex's shape and OpenRouter's share nothing structurally, and a caller
 * fills what its own response actually carried rather than inventing the fields it lacks.
 */
export interface RefusalSignal {
  /**
   * The provider's own message or error string, verbatim.
   *
   * ⚠️ UNTRUSTED TEXT. It is a provider's prose and it may quote our input back at us, so it is
   * MATCHED against fixed markers here and never parsed, evaluated or passed to a model.
   */
  message?: string | null;
  /**
   * The canonical gRPC status NAME on a long-running operation's error, when there is one —
   * `op.error.status`, e.g. "INVALID_ARGUMENT".
   */
  status?: string | null;
  /** `op.error.code` — the numeric gRPC status. 3 is INVALID_ARGUMENT, 9 is FAILED_PRECONDITION. */
  code?: number | null;
  /** Vertex: `response.raiMediaFilteredCount`. Non-zero ⇒ the output filter took something. */
  filteredCount?: number | null;
  /** Vertex: `response.raiMediaFilteredReasons`. Recorded and reported; never parsed for meaning. */
  filteredReasons?: readonly string[] | null;
  /** True when the operation reported DONE and simply returned nothing — see `refusalCodeFor`. */
  completedEmpty?: boolean;
}

/**
 * MEASURED input-policy markers. Each one has been seen in a real response by this project.
 *
 * ⚠️ ADD A MARKER ONLY WITH THE RESPONSE THAT PRODUCED IT. The cost of a wrong entry here is
 * asymmetric: a false `content_blocked` turns a retryable blip into a dead job, and a false
 * `content_filtered` re-buys a refusal. Neither is a guess worth making from a provider's docs.
 */
const INPUT_POLICY_MARKERS = [
  // BytePlus/Seedance, 6 of 6 on real-person image-to-video (docs/probes/kling-moderation.md §1).
  "inputimagesensitivecontentdetected",
] as const;

/**
 * gRPC status codes that are deterministic for the SAME request.
 *
 * Grounded in the status contract rather than in any provider's safety behaviour: INVALID_ARGUMENT
 * is specified as "the client specified an invalid argument… regardless of the state of the
 * system", and FAILED_PRECONDITION as an operation the caller should not retry until the state is
 * fixed. Both mean re-submitting these exact bytes cannot start working, which is the only property
 * this module needs from them. Every other status stays `provider_error` and keeps the retry
 * behaviour it has today.
 */
const DETERMINISTIC_STATUSES = new Set([
  "INVALID_ARGUMENT",
  "FAILED_PRECONDITION",
]);
const DETERMINISTIC_CODES = new Set([3, 9]);

/**
 * The classification. Order is the design, cheapest and most certain first.
 *
 *   1. A MEASURED input-policy marker in the message. The most specific evidence there is.
 *   2. A deterministic status/code on the operation's error. Structural, not safety-specific.
 *   3. The output filter: a DONE operation that returned nothing while reporting a filtered count.
 *   4. Anything else is what it was before this file existed.
 *
 * ⚠️ 3 IS AFTER 2 ON PURPOSE. An operation can carry an error AND a filtered count; the error is
 * the stronger statement, because it says the operation did not complete rather than that its
 * output was withheld. Reading the count first would call an input rejection retryable.
 */
export function refusalCodeFor(signal: RefusalSignal): RefusalCode {
  const haystack = (signal.message ?? "").toLowerCase();
  if (INPUT_POLICY_MARKERS.some((m) => haystack.includes(m)))
    return "content_blocked";

  if (
    (signal.status &&
      DETERMINISTIC_STATUSES.has(signal.status.toUpperCase())) ||
    (typeof signal.code === "number" && DETERMINISTIC_CODES.has(signal.code))
  ) {
    return "content_blocked";
  }

  // The provider ran and withheld the result. `completedEmpty` is required as well as the count:
  // a filtered count beside a clip we DID get is not a refusal at all — it means one sample of
  // several was dropped, and the job has its video.
  if (signal.completedEmpty && (signal.filteredCount ?? 0) > 0)
    return "content_filtered";

  return "provider_error";
}

/**
 * Whether a refusal is worth asking the same question about twice.
 *
 * ⚠️ TRUE HERE MEANS "A RETRY CAN PRODUCE A DIFFERENT ANSWER", AND NOTHING ELSE. It does not mean
 * a retry is free, wise, or permitted — the money note at the top of this file stands, and the
 * decision to actually spend again belongs to the caller and to a flag, not to this predicate.
 */
export const isRetryableRefusal = (code: GenerationErrorCode): boolean =>
  code === "content_filtered";

/** Provider prose, capped for a log line or a stored `last_error`. Never shown to an athlete. */
export const describeReasons = (
  reasons: readonly string[] | null | undefined,
): string => (reasons ?? []).join("; ").slice(0, 200);
