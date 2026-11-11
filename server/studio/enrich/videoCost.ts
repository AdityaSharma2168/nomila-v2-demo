/**
 * studio/enrich/videoCost — the per-run budget for video enrichment.
 *
 * Every figure is an ESTIMATE (Vertex reports tokens; we multiply), and the estimate is counted
 * BEFORE the call, the way studio/spendCaps.ts banks a quote before money leaves: a run can never
 * read $0 spent while a clip is in flight. After the call the meter charges what Vertex reported,
 * so the run's total is real tokens × list rates, and the pre-call figure only ever decided
 * whether the call was allowed.
 */
import {
  VIDEO_ASSUMED_SECONDS,
  VIDEO_OUTPUT_TOKENS_FLAT,
  VIDEO_OUTPUT_TOKENS_PER_SECOND,
  VIDEO_PROMPT_TOKENS,
  VIDEO_TOKENS_PER_SECOND,
  videoEnrichMaxRunUsd,
  videoEnrichUsdPerInputToken,
  videoEnrichUsdPerOutputToken,
} from "./config";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** THE NAMED REFUSAL. Thrown by the budget, caught by the run loop, logged once; never a row's fault. */
export class VideoEnrichCapExceeded extends Error {
  readonly code = "video_enrich_cap" as const;
  constructor(
    readonly spentUsd: number,
    readonly nextUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `video enrichment run cap: $${spentUsd.toFixed(4)} spent, next clip ~$${nextUsd.toFixed(4)}, cap $${capUsd.toFixed(2)}. ` +
        `Raise STUDIO_VIDEO_ENRICH_MAX_RUN_USD for a planned run, or let the next pass resume.`,
    );
    this.name = "VideoEnrichCapExceeded";
  }
}

/** Tokens one clip is expected to cost, from its duration. Pure, so the eval can table it. */
export function estimateVideoTokens(
  durationSeconds: number | null,
): TokenUsage {
  const s =
    durationSeconds && durationSeconds > 0
      ? durationSeconds
      : VIDEO_ASSUMED_SECONDS;
  return {
    inputTokens: Math.ceil(s * VIDEO_TOKENS_PER_SECOND + VIDEO_PROMPT_TOKENS),
    outputTokens: Math.ceil(
      VIDEO_OUTPUT_TOKENS_FLAT + s * VIDEO_OUTPUT_TOKENS_PER_SECOND,
    ),
  };
}

export function usdOf(u: TokenUsage): number {
  return (
    u.inputTokens * videoEnrichUsdPerInputToken() +
    u.outputTokens * videoEnrichUsdPerOutputToken()
  );
}

/** One per run. `reserve` banks the estimate or throws; `settle` replaces it with what was reported. */
export class RunBudget {
  private spent = 0;
  readonly capUsd: number;
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;

  constructor(capUsd = videoEnrichMaxRunUsd()) {
    this.capUsd = capUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  /** Bank the estimate before the call. Throws VideoEnrichCapExceeded and banks nothing if it would not fit. */
  reserve(durationSeconds: number | null): number {
    const est = usdOf(estimateVideoTokens(durationSeconds));
    if (this.spent + est > this.capUsd)
      throw new VideoEnrichCapExceeded(this.spent, est, this.capUsd);
    this.spent += est;
    return est;
  }

  /** Swap a reservation for what Vertex reported. A call that reported nothing keeps its estimate. */
  settle(reservedUsd: number, usage: TokenUsage | null): void {
    this.calls++;
    if (!usage) return;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.spent += usdOf(usage) - reservedUsd;
  }

  /** A call that never happened (download failed, oversize) gives its reservation back. */
  release(reservedUsd: number): void {
    this.spent -= reservedUsd;
  }
}
