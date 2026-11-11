/**
 * studio/qa/record — where a verdict is stored, and the one flag that turns the stage on.
 *
 * ─── `media_assets.metadata.creative_qa`. NO MIGRATION, AND NOT A SQUAT. ───────────────────────
 *
 * `metadata` is an existing jsonb column and the codebase already treats it as a namespace keyed by
 * producer, each writer merging its own top-level key and bumping `metadata_updated_at`:
 *
 *   services/mediaEnrichment.ts   metadata.vision, metadata.embedding, metadata.enrichment
 *   skills/rehostAthleteMedia.ts  metadata.pixel_grade
 *   skills/enrichTopPostInsights  metadata.insights_enriched_at
 *   routes/media.ts:105           already QUERIES `metadata -> 'vision'`
 *
 * `creative_qa` is one more of those. Nothing collides: `recordGeneratedAsset` writes no metadata
 * at all today, so every generated row's column is NULL. And per-asset is the right grain — one job
 * produces many assets and QA inspects an IMAGE, which is the same argument the schema already
 * makes for `approval_status` being per-asset rather than per-job.
 *
 * A dedicated column was the alternative and would have meant a migration against a live table for
 * a flag-off observational stage. The prod rule allows nullable-first, but the cheaper correct
 * option is the one that needs no DDL at all.
 *
 * ─── ⚠️  THE MERGE IS READ-MODIFY-WRITE, AND THAT IS A REAL RACE ───────────────────────────────
 *
 * `jsonb` has no partial update here without raw SQL, so this reads the row, spreads, and writes
 * back. If media enrichment wrote `metadata.vision` on the same row between the read and the write,
 * that write would be lost.
 *
 * Why it is acceptable TODAY, stated so nobody assumes it was thought about later: enrichment only
 * ever targets rows where `vision IS NULL OR embedding IS NULL`, it runs from a cron rather than
 * inline, and a generated asset is inspected within seconds of being created — the two writers do
 * not currently overlap on one row in one moment. If that stops being true, the fix is
 * `jsonb_set` in raw SQL on the single key, not a lock.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { studioFlag } from "../studioFlag";
import type { CreativeQaVerdict } from "./verdict";

const logger = createLogger("studio/qa/record");

/** The key this module owns inside `metadata`. Nothing else may write it. */
export const QA_METADATA_KEY = "creative_qa";

/**
 * The flag. Default OFF, and it gates whether the stage RUNS — never what it does with a verdict,
 * because the stage does nothing with a verdict except write it down.
 *
 * This is the Content Hub engine, which has its own `STUDIO_*` flag convention (studioEnabled, garmentMaskEnabled, objectMaskEnabled...).
 */
export const creativeQaEnabled = () =>
  studioFlag(process.env.STUDIO_CREATIVE_QA);

/**
 * The keys OTHER writers own inside `creative_qa`, which replacing the verdict must keep (quality-scrappy):
 * `structure` (video/structure.ts, STUDIO_CLIP_QC), `gate` (studio/outputGate.ts, STUDIO_OUTPUT_GATE) and `score`
 * (studio/templateScore.ts, STUDIO_PROMPT_REGISTRY). Each is written by jsonb_set on its one key; without this, a
 * verdict landing after them would erase them. With none present — every record before quality-scrappy, and every
 * record with those flags off — this is `{}` and the verdict is written exactly as it was.
 *
 * ⚠️ MUTATION (video/structure.test.ts): return `{}` — "a verdict written after the structure check keeps it" reds.
 */
export const KEPT_BESIDE_VERDICT = ["structure", "gate", "score"] as const;
function keptBeside(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const prior = existing[QA_METADATA_KEY];
  if (!prior || typeof prior !== "object") return {};
  return Object.fromEntries(
    KEPT_BESIDE_VERDICT.filter((k) => k in (prior as object)).map((k) => [
      k,
      (prior as Record<string, unknown>)[k],
    ]),
  );
}

/**
 * Merge a verdict into one asset's metadata. Tenancy in the predicate.
 *
 * Best-effort and never throws: this is bookkeeping about a generation that has already succeeded
 * and been paid for, and failing it because a jsonb write failed would be the arithmetic the whole
 * qa/ module refuses everywhere else (studio/segment.ts makes the same argument for masks).
 */
export async function writeVerdict(
  assetId: string,
  athleteId: string,
  verdict: CreativeQaVerdict,
): Promise<boolean> {
  try {
    const [row] = await db
      .select({ metadata: mediaAssets.metadata })
      .from(mediaAssets)
      .where(
        and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId)),
      )
      .limit(1);

    if (!row) {
      logger.warn(
        { assetId },
        "no such asset under this athlete — verdict not written",
      );
      return false;
    }

    const existing = (row.metadata ?? {}) as Record<string, unknown>;
    await db
      .update(mediaAssets)
      .set({
        metadata: {
          ...existing,
          [QA_METADATA_KEY]: { ...keptBeside(existing), ...verdict },
        } as never,
        metadata_updated_at: new Date(),
      })
      .where(
        and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId)),
      );

    logger.info(
      {
        assetId,
        overall: verdict.overall,
        unknownChecks: verdict.unknownChecks,
        usd: verdict.spend.usd,
        chainDepth: verdict.comparison.chainDepth,
      },
      "creative QA verdict recorded",
    );
    return true;
  } catch (err: unknown) {
    logger.warn(
      {
        assetId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "creative QA verdict could not be written",
    );
    return false;
  }
}

/** Read a stored verdict back — for the backfill script, and for anyone auditing the stage. */
export async function readVerdict(
  assetId: string,
  athleteId: string,
): Promise<CreativeQaVerdict | null> {
  const [row] = await db
    .select({ metadata: mediaAssets.metadata })
    .from(mediaAssets)
    .where(
      and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId)),
    )
    .limit(1);
  const v = (row?.metadata as Record<string, unknown> | null)?.[
    QA_METADATA_KEY
  ];
  return (v as CreativeQaVerdict | undefined) ?? null;
}
