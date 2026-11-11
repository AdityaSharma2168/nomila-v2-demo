/**
 * brandFitFill.ts — produces a brand-fit narrative and records it. The ONLY
 * place a model call happens on the voice brand path.
 *
 * ── Where this sits ───────────────────────────────────────────────────────────
 * ./brandBriefRoute answers from ./brandFitStore and never waits for a model. A
 * pair with nothing precomputed gets the honest enum-only answer immediately and
 * calls `enqueueBrandFitFill` on the way out, so the SECOND time that athlete
 * asks about that brand the answer is rich and instant. Nothing about the
 * response depends on this module finishing, or starting, or succeeding.
 *
 * The same `fillBrandFit` is what the backfill script awaits, one pair at a time.
 * One implementation, two callers: a narrative produced ahead of time and one
 * produced by a cold ask must be identical, or the backfill would not actually be
 * testing the thing that serves live traffic.
 *
 * ── Why the fire-and-forget wrapper needs its own guards ──────────────────────
 * `enqueueBrandFitFill` returns before the work starts, so nothing upstream can
 * apply backpressure. Two guards do it here instead:
 *
 *   - a per-pair in-flight set, so an athlete asking about the same brand three
 *     times in twenty seconds spawns ONE narrate rather than three; and
 *   - a global cap on concurrent fills, so a session that walks through a list of
 *     un-backfilled brands cannot open an unbounded number of model calls. At the
 *     cap the enqueue is DROPPED, not queued — the athlete's answer is already
 *     sent and correct, and the pair will fill on any later ask.
 *
 * Dropping is the right failure mode for a cost guard: a queue would preserve
 * every request and just spend the money later, which is the outcome the guard
 * exists to prevent. Model spend is real, and this path is reachable from an
 * open microphone.
 *
 * NOT a retry: a fill that fails is simply not recorded, and the next ask tries
 * again. There is no backoff and no failure memo, because the natural retry rate
 * here is "however often a human says the brand's name out loud".
 */

import { getBrandFitTool } from "../mila/tools/getBrandFit";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { setBrandFitReasons, type BrandFitReasons } from "./brandFitStore";

const logger = createLogger("voice/brandFitFill");

/**
 * Bounds the narrate call. Generous — 30s where the old synchronous route had to
 * live inside 17s — precisely BECAUSE nobody is waiting on it: this runs after
 * the athlete already has an answer, so the only thing the bound protects is a
 * hung request holding its DB connection (the reason withTimeout exists at all).
 */
const FILL_TIMEOUT_MS = 30_000;

/**
 * Most fills running at once across the whole process. Four is chosen against
 * what it is guarding, not against throughput: a live call generates fills one
 * spoken brand name at a time, so anything above a handful means something is
 * looping, and that is the case worth dropping.
 *
 * The backfill script does NOT go through this cap — it awaits `fillBrandFit`
 * directly and paces itself.
 */
const MAX_CONCURRENT_FILLS = 4;

const inFlight = new Set<string>();

const keyOf = (athleteId: string, brandId: number) => `${athleteId}:${brandId}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const nonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/**
 * The tool's `reasons` → the stored shape, or null. All three angles or none —
 * the same reject-don't-coerce rule the route and the store both apply, applied
 * here so a partial narrative is never WRITTEN in the first place.
 */
function readReasons(result: unknown): BrandFitReasons | null {
  if (!isRecord(result)) return null;
  const { reasons } = result;
  if (!isRecord(reasons)) return null;
  const { audience, credibility, whitespace } = reasons;
  if (
    !nonEmptyString(audience) ||
    !nonEmptyString(credibility) ||
    !nonEmptyString(whitespace)
  ) {
    return null;
  }
  return {
    audience: audience.trim(),
    credibility: credibility.trim(),
    whitespace: whitespace.trim(),
  };
}

/**
 * Narrates one (athlete, brand) pair and records it. Returns the reasons on
 * success, or null on any failure — never throws.
 *
 * TENANCY: `athleteId` is passed straight to the tool, which filters every
 * athlete read by it server-side. It is a server-resolved id in both callers
 * (the route's validated path param, the script's own argument), never a value
 * a model chose.
 *
 * `brandName` is the free-text name the tool resolves internally; `brandId` is
 * the row the caller ALREADY resolved that name to, and is what the result is
 * stored under. Passing both looks redundant and is not: storing under the
 * caller's resolved id is what keeps the store's key consistent with the read
 * side, no matter how the tool re-resolves the string.
 */
export async function fillBrandFit(
  athleteId: string,
  brandId: number,
  brandName: string,
): Promise<BrandFitReasons | null> {
  const started = Date.now();
  try {
    const fit = await withTimeout(
      getBrandFitTool.execute(athleteId, { brand_name: brandName }),
      FILL_TIMEOUT_MS,
      "voice brand_fit fill",
    );
    const reasons = readReasons(fit);
    if (!reasons) {
      // The narrator returned null (it catches its own failures), the athlete has
      // no profile to pitch, or the brand wasn't enriched by the tool's own read.
      logger.info(
        { athleteId, brandId, outcome: "empty", ms: Date.now() - started },
        "Brand fit fill produced no narrative",
      );
      return null;
    }

    await setBrandFitReasons(athleteId, brandId, reasons);
    logger.info(
      { athleteId, brandId, outcome: "stored", ms: Date.now() - started },
      "Brand fit fill stored",
    );
    return reasons;
  } catch (err: any) {
    // Never log the brand name: it is model-supplied, untrusted free text.
    logger.warn(
      {
        athleteId,
        brandId,
        error: err?.message?.slice(0, 120),
        ms: Date.now() - started,
      },
      "Brand fit fill failed",
    );
    return null;
  }
}

/**
 * Starts a fill in the background and returns immediately.
 *
 * Returns whether the work was actually started, which is for tests and logs
 * only — no caller changes its response based on it, and none may: the point of
 * this function is that the answer has already been sent.
 */
export function enqueueBrandFitFill(
  athleteId: string,
  brandId: number,
  brandName: string,
): boolean {
  const key = keyOf(athleteId, brandId);
  if (inFlight.has(key)) return false;
  if (inFlight.size >= MAX_CONCURRENT_FILLS) {
    logger.warn(
      { athleteId, brandId, inFlight: inFlight.size },
      "Brand fit fill dropped — concurrency cap",
    );
    return false;
  }

  inFlight.add(key);
  // `fillBrandFit` never rejects, so this cannot produce an unhandled rejection;
  // the `finally` is what guarantees the guard is released even if that changes.
  void fillBrandFit(athleteId, brandId, brandName).finally(() => {
    inFlight.delete(key);
  });
  return true;
}

/** Test seam: module state outlives a test file otherwise. */
export function _resetBrandFitFill(): void {
  inFlight.clear();
}
