/**
 * studio/jobs — the record of what the Studio ran, and what came out of it.
 *
 * Writes to `generation_jobs` and to generated rows in `media_assets`. It never touches an existing
 * ingested asset: every write here either inserts a new row or updates a job this module created.
 *
 * ⚠️  NO LEASING HERE, AND `claimJob` IS NOT AN IDEMPOTENCY GUARD. Read both halves before relying
 * on either.
 *
 * There is no lease token, no worker id, no `SELECT ... FOR UPDATE SKIP LOCKED`. `claimJob` below
 * moves pending → running with a guarded UPDATE, which makes a race on ONE job row *detectable*
 * but does not make concurrency *safe* in general.
 *
 * This file used to say that was fine "because Studio generation runs on ONE instance". That was
 * never true of the deployment: gcp/cloud-run-dev.yaml sets minScale 1 / maxScale 3, and
 * server/lib/pgAdvisoryLock.ts's header says so plainly. Treat that file as the correct account of
 * how many instances exist. What actually keeps this safe is narrower and worth stating exactly:
 *
 *   * NOTHING POLLS `status='pending'`. The double-charge the old note described needs a background
 *     runner, and there isn't one — studio/generate.ts runs generation INLINE in the request. Do not
 *     add a poller without building leasing first; with three instances it would double-charge.
 *   * `claimJob` DOES NOT stop a double-tapped Generate. `createGenerationJob` INSERTs a fresh row
 *     on every call, so two taps are two DIFFERENT job ids and each claims its own row happily.
 *     The guard has to sit on the thing there is only one of — the APPROVAL — which is what
 *     studio/previewStore.ts's atomic `consumePreview` does. That is the mechanism; this is not.
 *
 * See the same warning on the table definition in shared/schema.ts.
 *
 * LINEAGE — three pointers, each answering a different question:
 *   media_assets.generation_job_id       what made this?           (both modes, always)
 *   media_assets.derived_from_asset_id   what did it come from?    (EDIT only — a generate has no
 *                                                                   frame to preserve, by definition)
 *   generation_jobs.brief (jsonb)        what exactly was asked?   (both modes, frozen at creation)
 */
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { generationJobs, mediaAssets, type GenerationJob } from "../../shared/schema";
import { createLogger } from "../logger";
import { writeGeneratedThumbnail } from "./thumbnail";
import type { CreativeBrief } from "./brief";
import type { GenerationPreview } from "./preview";
import { GenerationError } from "./types";
import { STUDIO_PLATFORM } from "./config";

const logger = createLogger("studio/jobs");

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";

/**
 * Generated assets are not from a social platform, but `media_assets.platform` is NOT NULL and is
 * how every existing row is grouped. "studio" keeps them distinguishable from an ingested Instagram
 * row without widening the column's meaning.
 */
// Defined in studio/config.ts — see the note there — re-exported so call sites are unchanged.
export { STUDIO_PLATFORM };

/**
 * Open a job from a READY preview.
 *
 * A blocked preview is refused here as well as at runGeneration — this is the write side of the same
 * gate, so a blocked job never even gets a row, let alone a model call.
 */
export async function createGenerationJob(preview: GenerationPreview): Promise<GenerationJob> {
  if (preview.status !== "ready" || !preview.plan) {
    throw new GenerationError(
      `Refusing to open a job for a blocked preview (${preview.blockers.length} blocker(s))`,
      "invalid_input",
    );
  }
  const brief: CreativeBrief = preview.brief;
  const [row] = await db.insert(generationJobs).values({
    athlete_id: brief.athlete.athleteId,
    brand_id: brief.brand?.brandId ?? null,
    origin: brief.job.origin,
    mode: brief.job.mode,
    objective: brief.job.objective,
    deliverable: brief.job.deliverable,
    // Frozen: this is the record of what was asked, and it must not follow later edits to the brief.
    brief: brief as unknown as Record<string, unknown>,
    source_asset_id: brief.job.source?.mediaAssetId ?? null,
    status: "pending",
    provider: preview.plan.provider,
    model: preview.plan.model,
    // Stored as quoted. `cost_basis` is carried, never recomputed, so a pre-run estimate can never
    // later be read as a billed figure.
    cost_estimated_usd: preview.cost ? String(preview.cost.amountUsd) : null,
    cost_basis: preview.cost?.basis ?? null,
    // Provenance, not authorization (0072): from the frozen brief, so the spend leg's replay carries it too.
    creative_intent_id: brief.job.creativeIntentId ?? null,
    // #570 §6 (0073): which scope version and unit of scope this job fulfils — audit, never authorization.
    source_spec_id: brief.job.campaignLineage?.specId ?? null,
    source_spec_version: brief.job.campaignLineage?.specVersion ?? null,
    campaign_deliverable_id: brief.job.campaignLineage?.campaignDeliverableId ?? null,
  } as never).returning();

  logger.info(
    { jobId: row.id, athleteId: row.athlete_id, mode: row.mode, model: row.model, quotedUsd: row.cost_estimated_usd },
    "generation job opened",
  );
  return row;
}

/**
 * pending → running. Guarded on the current status so a second caller gets `false` rather than
 * silently running the same job. That makes a race VISIBLE; it does not make it safe — see the
 * single-runner warning at the top of this file.
 */
/**
 * What this athlete has already been QUOTED today, in USD — the input to the per-day spend ceiling.
 *
 * ─── QUOTED, NOT BILLED, AND THAT IS THE ONLY HONEST ANSWER AVAILABLE ─────────────────
 *
 * `cost_estimated_usd` is the pre-generation estimate, written when the job row opens, and
 * `cost_basis` is carried rather than recomputed so an estimate is never displayed as an invoice.
 * There is no billed column to sum instead: the receipt exists only in the provider's own usage
 * numbers and in the JSONL cost log, which is per-instance and ephemeral on Cloud Run. So the
 * ceiling is enforced against the same figure every other money guard in this codebase reads. If
 * the quote is wrong, this is wrong in the same direction as the approval check and the per-job cap
 * — which is exactly why studio/pricing.ts treats an under-quote as the dangerous one.
 *
 * ─── WHAT COUNTS ─────────────────────────────────────────────────────────
 *
 * Every status except `canceled`. A `failed` job counts because failure is not a refund — the
 * provider call may well have happened and the failure landed after it, which is the exact shape
 * every guard in this PR exists to move money away from. `canceled` is excluded because it means
 * one specific thing here: the losing side of a double-tapped Generate, a row that opened and was
 * cancelled before `consumePreview` let anything through (studio/generate.ts step 4). Counting it
 * would charge the day twice for one tap.
 *
 * TENANCY: scoped by `athlete_id`, like every other query in this file. One athlete's day is
 * invisible to another's ceiling, which also means this is not a global budget — see maxDayUsd().
 *
 * "Today" is a rolling 24 hours rather than a calendar day, deliberately: a calendar boundary needs
 * a timezone to be a real thing, and the ceiling exists to stop a runaway in progress rather than to
 * balance a ledger. A loop cannot wait out midnight.
 */
export async function spentTodayUsd(athleteId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({
      total: sql<string | null>`coalesce(sum(${generationJobs.cost_estimated_usd}), 0)`,
    })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.athlete_id, athleteId),
        gte(generationJobs.created_at, since),
        ne(generationJobs.status, "canceled"),
      ),
    );
  const total = Number(row?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}

export async function claimJob(jobId: string, athleteId: string): Promise<boolean> {
  const claimed = await db.update(generationJobs)
    .set({ status: "running", started_at: new Date(), updated_at: new Date() })
    .where(and(
      eq(generationJobs.id, jobId),
      eq(generationJobs.athlete_id, athleteId),
      eq(generationJobs.status, "pending"),
    ))
    .returning({ id: generationJobs.id });
  if (!claimed.length) logger.warn({ jobId }, "job was not pending — not claimed");
  return claimed.length > 0;
}

/**
 * `costUsd` (PR 13, the rider from PR 11; 0066 `generation_jobs.cost_usd`): what the provider's result
 * said the job cost, written ONCE here when the caller has it — the image paths do (studio/generate.ts,
 * studio/concept.ts, studio/edit/engine.ts: `result.cost.amountUsd`); the video poll carries no billed
 * figure and passes nothing. Whatever its basis: `cost_basis` on the row is what tells a reported
 * figure from an estimated one, so the join can, and the day cap never reads this column —
 * `spentTodayUsd` sums the QUOTE, above. ⚠️ MUTATION (edit/engine.test): drop the write — "finish()
 * drops actual cost" reds by name.
 */
async function finish(
  jobId: string, athleteId: string, status: Extract<JobStatus, "succeeded" | "failed" | "canceled">,
  lastError?: string, costUsd?: number,
): Promise<void> {
  await db.update(generationJobs)
    .set({
      status,
      last_error: lastError ?? null,
      completed_at: new Date(),
      updated_at: new Date(),
      ...(typeof costUsd === "number" && Number.isFinite(costUsd) ? { cost_usd: String(costUsd) } : {}),
    })
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.athlete_id, athleteId)));
  logger.info({ jobId, status }, "generation job finished");
}

export const succeedJob = (jobId: string, athleteId: string, costUsd?: number) =>
  finish(jobId, athleteId, "succeeded", undefined, costUsd);
export const cancelJob  = (jobId: string, athleteId: string) => finish(jobId, athleteId, "canceled");
/** A failed job stays failed. Re-running is a NEW job with its own row and its own cost line. */
export const failJob = (jobId: string, athleteId: string, error: string) =>
  finish(jobId, athleteId, "failed", error.slice(0, 500));

export interface GeneratedAssetInput {
  athleteId: string;
  jobId: string;
  /** Where the pixels landed. A GCS path, never a signed url. */
  gcsPath: string;
  contentType: string;
  mediaType?: "IMAGE" | "VIDEO";
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
  durationSeconds?: number | null;
  /**
   * The pixels themselves, when the caller still holds them.
   *
   * Only ever an optimisation: `writeGeneratedThumbnail` reads the object back when this is absent,
   * which is the path a rehosted-from-url asset and the backfill both take. Named apart from
   * `bytes` (a COUNT) so the two cannot be transposed at a call site.
   */
  bytes_buffer?: Buffer;
  /** EDIT mode only: the asset whose pixels this one preserves. Omit for `generate`. */
  derivedFromAssetId?: string | null;
}

/**
 * Record one generated asset.
 *
 * Always lands in `draft`. A generated asset is never born cleared — that is the entire point of the
 * approval machine, and the publish trigger enforces it even if this function is bypassed.
 *
 * One job may produce SEVERAL assets (the router takes `n`), so approval is per asset, not per job.
 *
 * ─── AND IT IS THUMBNAILED HERE, WHICH IS A RETRIEVAL FIX RATHER THAN A UI ONE ─────────────────
 *
 * Every generated asset used to be written with `gcs_thumb_path` null, and `mediaEnrichment` embeds
 * `thumb ?? path` — so the embedder was handed a 4000x6000 quality-100 JPEG. Over the cap, no
 * embedding, and `mediaSearch`'s near-duplicate suppression reads `cand.emb && …`, so an asset with
 * no embedding can never be deduped. Studio is the one origin that produces many near-identical
 * frames, so the blindness landed precisely where dedup was needed.
 *
 * WRITTEN AT RECORD TIME, NOT LEFT TO THE CRON, because the cron is what the missing thumb breaks.
 * A row with vision tagged and embedding null stays in `UNENRICHED` forever and is retried every
 * tick — the treadmill this closes from the other end.
 *
 * ⚠️ IT CANNOT FAIL THE WRITE. `writeGeneratedThumbnail` returns null rather than throwing, and the
 * insert proceeds with `gcs_thumb_path: null` exactly as it always did. This runs after a paid
 * generation whose bytes are already safe; turning a degraded search into a lost asset would be a
 * far worse trade than the one it fixes.
 */
export async function recordGeneratedAsset(input: GeneratedAssetInput) {
  const thumbPath = await writeGeneratedThumbnail(input.gcsPath, {
    bytes: input.bytes_buffer,
    mediaType: input.mediaType ?? "IMAGE",
  });

  const [row] = await db.insert(mediaAssets).values({
    athlete_id: input.athleteId,
    platform: STUDIO_PLATFORM,
    origin: "generated",
    media_type: input.mediaType ?? "IMAGE",
    status: "stored",
    approval_status: "draft",
    generation_job_id: input.jobId,
    derived_from_asset_id: input.derivedFromAssetId ?? null,
    gcs_path: input.gcsPath,
    gcs_thumb_path: thumbPath,
    content_type: input.contentType,
    width: input.width ?? null,
    height: input.height ?? null,
    bytes: input.bytes ?? null,
    duration_seconds: input.durationSeconds ?? null,
    ingested_at: new Date(),
  } as never).returning();

  logger.info(
    {
      assetId: row.id, jobId: input.jobId, athleteId: input.athleteId,
      derivedFrom: row.derived_from_asset_id,
      // Logged as a boolean rather than a path: which of the two branches ran is the fact worth
      // having when an asset turns up unembedded later, and a null here is the whole diagnosis.
      thumbed: thumbPath !== null,
    },
    "generated asset recorded as draft",
  );
  return row;
}

/** One job's output, for a review screen. Tenancy-scoped like everything else. */
export async function assetsForJob(jobId: string, athleteId: string) {
  return db.select().from(mediaAssets)
    .where(and(eq(mediaAssets.generation_job_id, jobId), eq(mediaAssets.athlete_id, athleteId)));
}
