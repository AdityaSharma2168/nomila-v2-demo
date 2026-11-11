/**
 * brandFitStore.ts — durable storage for precomputed brand-fit narratives.
 *
 * `brand_fit_narratives`, keyed (athlete_id, brand_id). One row is the three
 * angles `narrateWhyFits` produced for one athlete about one brand.
 *
 * ── What this replaced, and why it had to ────────────────────────────────────
 * This was a gitignored JSON file at the repo root — scaffolding, deliberately,
 * so the precomputed call path could be proved before anyone paid for a
 * migration. That file cannot work in production: Cloud Run's filesystem is
 * ephemeral and per-instance, and the file is not in the image, so EVERY
 * brand-brief request would be cold forever and every one would spend a Gemini
 * Pro call. The interface below is unchanged from the file version — four
 * callers, none of which needed editing — which was the point of shaping it this
 * way to begin with.
 *
 * There is no file fallback. Two stores would mean two truths and a silent
 * divergence between them; the deploy applies the DDL (psql, ON_ERROR_STOP=1)
 * before the image is replaced, so the code never serves against a table that is
 * not there.
 *
 * ── Reject-don't-coerce, on both sides ───────────────────────────────────────
 * All three angles or none. A partial fit rationale read aloud is worse than the
 * honest short answer, so a row missing any angle reads as absent, and a write
 * with a blank angle does not happen. The columns are NOT NULL, so the schema
 * agrees with the code here rather than relying on it.
 *
 * NOT IMPLEMENTED, on purpose: staleness and re-fill. `updated_at` records when a
 * narrative was produced and nothing reads it yet. A narrative written today is
 * served until something overwrites it. Invalidation policy is a separate change.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { brandFitNarratives, inboxBrands } from "../../shared/schema";
import { researchConfirmed } from "../lib/brandIdentity";
import { createLogger } from "../logger";

const logger = createLogger("voice/brandFitStore");

/**
 * The three fit angles, exactly as `narrateWhyFits` produces them and exactly as
 * the voice wire speaks them. App-generated copy from our own constrained JSON
 * call — never brand-authored text (see brandBriefRoute's header).
 */
export interface BrandFitReasons {
  audience: string;
  credibility: string;
  whitespace: string;
}

const nonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/**
 * True when the failure is "the table has not shipped yet" rather than a real
 * fault. Postgres 42P01 is undefined_table; PGlite surfaces the same text.
 *
 * This is NOT a fallback store — nothing is served from anywhere else. It only
 * stops a missing relation from turning the brand path into a 500 during the
 * window between pulling this code and applying the DDL locally. In deploy that
 * window does not exist: the DDL runs first and aborts the deploy if it fails.
 */
function isMissingTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  if (e?.code === "42P01") return true;
  return (
    typeof e?.message === "string" &&
    /relation .*brand_fit_narratives.* does not exist/i.test(e.message)
  );
}

let warnedMissing = false;
function noteMissing(): void {
  if (warnedMissing) return;
  warnedMissing = true;
  logger.warn(
    "brand_fit_narratives not present — every brand brief will answer cold until the DDL is applied (migrations/0019)",
  );
}

/**
 * The precomputed narrative for one (athlete, brand) pair, or null.
 *
 * This is the hot path: on a hit the voice answer costs one indexed brand lookup
 * plus this read, and no model call at all.
 *
 * Gated on the brand's research identity (BRAND_IDENTITY_GATE, researchConfirmed): a narrative is
 * returned ONLY while the brand's research is confirmed to describe the right company. Older rows
 * were written from profiles that may be about a different company; they stay stored (a later
 * "one why-she-fits per athlete+brand" redesign replaces them) but are never read out.
 */
export async function getBrandFitReasons(
  athleteId: string,
  brandId: number,
): Promise<BrandFitReasons | null> {
  try {
    const [row] = await db
      .select({
        audience: brandFitNarratives.audience,
        credibility: brandFitNarratives.credibility,
        whitespace: brandFitNarratives.whitespace,
        enrichment: inboxBrands.enrichment,
      })
      .from(brandFitNarratives)
      .innerJoin(inboxBrands, eq(inboxBrands.id, brandFitNarratives.brand_id))
      .where(
        and(
          eq(brandFitNarratives.athlete_id, athleteId),
          eq(brandFitNarratives.brand_id, brandId),
        ),
      )
      .limit(1);

    if (!row) return null;
    if (!researchConfirmed(row.enrichment)) return null;

    // Re-validated on the way out even though the columns are NOT NULL: a row
    // written by hand, or by an older build, is not trustworthy just because it
    // is in our table. Same posture as voiceContext.
    if (
      !nonEmpty(row.audience) ||
      !nonEmpty(row.credibility) ||
      !nonEmpty(row.whitespace)
    ) {
      return null;
    }

    return {
      audience: row.audience.trim(),
      credibility: row.credibility.trim(),
      whitespace: row.whitespace.trim(),
    };
  } catch (err) {
    if (isMissingTable(err)) {
      noteMissing();
      return null;
    }
    // Degrade to "nothing precomputed" rather than failing the caller: every
    // consumer already has an honest answer for that case, and none has one for
    // a thrown read on a live call.
    logger.error(
      { athleteId, brandId, error: (err as Error).message },
      "Brand fit read failed",
    );
    return null;
  }
}

/**
 * Records the narrative for one pair, overwriting any existing one.
 *
 * Never throws: this runs from a fire-and-forget fill, and a storage failure
 * must cost the next asker a cold answer rather than surfacing anywhere.
 */
export async function setBrandFitReasons(
  athleteId: string,
  brandId: number,
  reasons: BrandFitReasons,
): Promise<void> {
  const audience = reasons.audience?.trim() ?? "";
  const credibility = reasons.credibility?.trim() ?? "";
  const whitespace = reasons.whitespace?.trim() ?? "";

  // All three or none. The columns are NOT NULL, so a partial write would fail
  // anyway — refusing here makes the reason explicit instead of a constraint
  // error in the log.
  if (!audience || !credibility || !whitespace) {
    logger.warn(
      { athleteId, brandId },
      "Refusing to store a partial brand-fit narrative",
    );
    return;
  }

  try {
    await db
      .insert(brandFitNarratives)
      .values({
        athlete_id: athleteId,
        brand_id: brandId,
        audience,
        credibility,
        whitespace,
      })
      .onConflictDoUpdate({
        target: [brandFitNarratives.athlete_id, brandFitNarratives.brand_id],
        set: { audience, credibility, whitespace, updated_at: sql`now()` },
      });
  } catch (err) {
    if (isMissingTable(err)) {
      noteMissing();
      return;
    }
    logger.error(
      { athleteId, brandId, error: (err as Error).message },
      "Brand fit write failed",
    );
  }
}

/** Test seam: the missing-table warning is once-per-process by design. */
export function _resetBrandFitStoreWarning(): void {
  warnedMissing = false;
}
