/**
 * studio/qa/join — one generation, joined: job ↔ asset ↔ edit row ↔ verdict ↔ cost lines (PR 11, R-3).
 *
 * A QUERY, NOT A TABLE. Every half of this row already exists somewhere — the job on
 * `generation_jobs`, the asset on `media_assets` (with `generation_job_id` and `derived_from_asset_id`),
 * a typed edit on `studio_edit_previews` (with `job_id` and `accepted_asset_id`), the verdict under
 * `media_assets.metadata.creative_qa`, and the cost on the JSONL the router writes — and nothing
 * joined them. This reads them together, by whichever id the caller holds, and returns exactly what
 * is there.
 *
 * ─── IT NEVER INVENTS A HALF ────────────────────────────────────────────────────────────────────
 *
 * A job with no asset (failed, canceled, still running) returns `asset: null`; an asset with no
 * verdict returns `verdict: null`; a generate has `edit: null`. A row that filled a missing half with
 * a plausible default would be the "confident zero" studio/config.ts refuses, in a different shape.
 * ⚠️ MUTATION (join.test): synthesize an asset for a job that has none — "join query invents a row
 * when the job has no asset" reds by name.
 *
 * ─── TENANCY ───────────────────────────────────────────────────────────────────────────────────
 *
 * `athleteId` is in every predicate. An id that is not hers resolves to null exactly as one that does
 * not exist, and the halves are walked from the one she named — a job's asset is looked up under her,
 * never by the job id alone.
 *
 * ─── THE COST LINES ARE WHAT THE LOG HOLDS, WHICH IS LESS THAN THE TRUTH ─────────────────────────
 *
 * The JSONL is per instance and ephemeral on Cloud Run (studio/jobs.ts says so), and a line written
 * before PR 11 carries no join key at all. So `costLines` is every line in THIS log that names this
 * job, asset or edit row — possibly none — and `costLinesFrom` says which file was read. The
 * verdict's own `spend` is on the verdict, separately, because it was written there first.
 */
import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "../../db";
import {
  generationJobs,
  mediaAssets,
  studioEditPreviews,
  type GenerationJob,
  type StudioEditPreview,
} from "../../../shared/schema";
import { logPath, readLog, type GenerationRecord } from "../costLog";
import { readVerdict } from "./record";
import type { CreativeQaVerdict } from "./verdict";

/** The asset half — the columns a join reader needs, never the whole row (metadata is the verdict's). */
export interface JoinedAsset {
  id: string;
  mediaType: string;
  gcsPath: string | null;
  approvalStatus: string | null;
  generationJobId: string | null;
  derivedFromAssetId: string | null;
  createdAt: string | null;
}

export interface JoinRow {
  /** Which id the caller held, so a printed row says what it was walked from. */
  from: { assetId: string } | { jobId: string } | { editPreviewId: string };
  job: GenerationJob | null;
  asset: JoinedAsset | null;
  edit: StudioEditPreview | null;
  verdict: CreativeQaVerdict | null;
  costLines: GenerationRecord[];
  costLinesFrom: string;
}

export type JoinKey =
  | { assetId: string }
  | { jobId: string }
  | { editPreviewId: string };

const assetColumns = {
  id: mediaAssets.id,
  media_type: mediaAssets.media_type,
  gcs_path: mediaAssets.gcs_path,
  approval_status: mediaAssets.approval_status,
  generation_job_id: mediaAssets.generation_job_id,
  derived_from_asset_id: mediaAssets.derived_from_asset_id,
  created_at: mediaAssets.created_at,
};

type AssetRow = {
  id: string;
  media_type: string;
  gcs_path: string | null;
  approval_status: string | null;
  generation_job_id: string | null;
  derived_from_asset_id: string | null;
  created_at: Date | null;
};

const present = (r: AssetRow): JoinedAsset => ({
  id: r.id,
  mediaType: r.media_type,
  gcsPath: r.gcs_path,
  approvalStatus: r.approval_status,
  generationJobId: r.generation_job_id,
  derivedFromAssetId: r.derived_from_asset_id,
  createdAt: r.created_at ? r.created_at.toISOString() : null,
});

async function assetById(
  athleteId: string,
  id: string,
): Promise<AssetRow | null> {
  const [row] = await db
    .select(assetColumns)
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, id), eq(mediaAssets.athlete_id, athleteId)))
    .limit(1);
  return row ?? null;
}

/** The FIRST asset a job produced, oldest first. One job may produce several; the row names one. */
async function assetByJob(
  athleteId: string,
  jobId: string,
): Promise<AssetRow | null> {
  const [row] = await db
    .select(assetColumns)
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.generation_job_id, jobId),
        eq(mediaAssets.athlete_id, athleteId),
      ),
    )
    .orderBy(asc(mediaAssets.created_at))
    .limit(1);
  return row ?? null;
}

async function jobById(
  athleteId: string,
  id: string,
): Promise<GenerationJob | null> {
  const [row] = await db
    .select()
    .from(generationJobs)
    .where(
      and(eq(generationJobs.id, id), eq(generationJobs.athlete_id, athleteId)),
    )
    .limit(1);
  return row ?? null;
}

async function editById(
  athleteId: string,
  id: string,
): Promise<StudioEditPreview | null> {
  const [row] = await db
    .select()
    .from(studioEditPreviews)
    .where(
      and(
        eq(studioEditPreviews.id, id),
        eq(studioEditPreviews.athlete_id, athleteId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function editByAcceptedAsset(
  athleteId: string,
  assetId: string,
): Promise<StudioEditPreview | null> {
  const [row] = await db
    .select()
    .from(studioEditPreviews)
    .where(
      and(
        eq(studioEditPreviews.accepted_asset_id, assetId),
        eq(studioEditPreviews.athlete_id, athleteId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function editByJob(
  athleteId: string,
  jobId: string,
): Promise<StudioEditPreview | null> {
  const [row] = await db
    .select()
    .from(studioEditPreviews)
    .where(
      and(
        eq(studioEditPreviews.job_id, jobId),
        eq(studioEditPreviews.athlete_id, athleteId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Her newest ACCEPTED typed edit — the row the join script prints when no id is given. Tenant-scoped
 * like every read here; null when she has none.
 */
export async function latestAcceptedEditId(
  athleteId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: studioEditPreviews.id })
    .from(studioEditPreviews)
    .where(
      and(
        eq(studioEditPreviews.athlete_id, athleteId),
        eq(studioEditPreviews.status, "accepted"),
      ),
    )
    .orderBy(
      desc(studioEditPreviews.decided_at),
      desc(studioEditPreviews.created_at),
    )
    .limit(1);
  return row?.id ?? null;
}

/** The lines in one log that name this row by any of its keys. Pre-PR-11 lines name nothing and never match. */
export function costLinesFor(
  lines: GenerationRecord[],
  keys: {
    jobId: string | null;
    assetId: string | null;
    editPreviewId: string | null;
  },
): GenerationRecord[] {
  return lines.filter(
    (l) =>
      (keys.jobId !== null && l.jobId === keys.jobId) ||
      (keys.assetId !== null && l.assetId === keys.assetId) ||
      (keys.editPreviewId !== null && l.editPreviewId === keys.editPreviewId),
  );
}

/**
 * The row. Walked from whichever id the caller holds; every other half is looked up under the same
 * athlete or left null.
 */
export async function joinRow(
  athleteId: string,
  key: JoinKey,
  opts: { logPath?: string } = {},
): Promise<JoinRow> {
  let job: GenerationJob | null = null;
  let asset: AssetRow | null = null;
  let edit: StudioEditPreview | null = null;

  if ("assetId" in key) {
    asset = await assetById(athleteId, key.assetId);
    if (asset?.generation_job_id)
      job = await jobById(athleteId, asset.generation_job_id);
    edit = await editByAcceptedAsset(athleteId, key.assetId);
  } else if ("jobId" in key) {
    job = await jobById(athleteId, key.jobId);
    if (job) {
      asset = await assetByJob(athleteId, job.id);
      edit = await editByJob(athleteId, job.id);
    }
  } else {
    edit = await editById(athleteId, key.editPreviewId);
    if (edit?.job_id) job = await jobById(athleteId, edit.job_id);
    if (edit?.accepted_asset_id)
      asset = await assetById(athleteId, edit.accepted_asset_id);
  }

  // The verdict lives on the asset and only there. No asset → no verdict, never a guess.
  const verdict = asset ? await readVerdict(asset.id, athleteId) : null;

  const path = opts.logPath ?? logPath();
  const costLines = costLinesFor(await readLog(path), {
    jobId: job?.id ?? null,
    assetId: asset?.id ?? null,
    editPreviewId: edit?.id ?? null,
  });

  return {
    from: key,
    job,
    asset: asset ? present(asset) : null,
    edit,
    verdict,
    costLines,
    costLinesFrom: path,
  };
}
