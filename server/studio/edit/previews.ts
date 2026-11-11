/**
 * studio/edit/previews — the studio_edit_previews table (migration 0063), athlete-scoped, as the engine
 * reads and writes it. The row is the whole story of one typed edit: quoted → running → ready →
 * accepted | discarded, or failed.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────────
 *
 * Every read filters by the athlete the ROUTE resolved, never by an id a client sent alone: a row that is
 * not hers reads as missing. ⚠️ MUTATION (engine.test): drop the athlete filter in `readEditPreview` —
 * "another athlete's edit preview is invisible" reds by name.
 *
 * ─── THE STATUS MACHINE IS A COMPARE-AND-SET ────────────────────────────────────────────────────────
 *
 * `advance` moves a row from ONE expected status to the next and reports whether it did. Two accepts,
 * an accept racing a discard, a run on a row already running: the second caller reads `false` and does
 * nothing — the same shape as previewStore's consume, so a paid call or a library write can happen once.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../../db";
import {
  studioEditPreviews,
  type StudioEditOp,
  type StudioEditPreview,
  type StudioEditPreviewStatus,
} from "../../../shared/schema";

/** How long a quoted-but-unrun row, and a ready-but-undecided one, is kept. The bytes go with it (sweep). */
export const EDIT_PREVIEW_TTL_MS = 24 * 60 * 60_000;

export interface NewEditPreview {
  athleteId: string;
  sourceAssetId: string;
  op: StudioEditOp;
  params: Record<string, unknown>;
  /** The quote row (studio_generation_previews) this edit is priced under. */
  previewId: string;
  costQuotedUsd: number | null;
  batchId?: string | null;
}

export async function insertEditPreview(
  input: NewEditPreview,
): Promise<StudioEditPreview> {
  const [row] = await db
    .insert(studioEditPreviews)
    .values({
      athlete_id: input.athleteId,
      source_asset_id: input.sourceAssetId,
      op: input.op,
      params: input.params,
      preview_id: input.previewId,
      cost_quoted_usd:
        input.costQuotedUsd === null ? null : String(input.costQuotedUsd),
      batch_id: input.batchId ?? null,
      status: "quoted",
      expires_at: new Date(Date.now() + EDIT_PREVIEW_TTL_MS),
    })
    .returning();
  return row;
}

/** Her row by id, or null — never another athlete's. */
export async function readEditPreview(
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

/**
 * Her rows, newest first — a batch's when one is named. NEVER an expired one (PR 10, R-7 / AUDIT2 F3):
 * a preview past `expires_at` is gone from every list — the Now feed, the batch view, accept-all, the
 * re-roll cap — the way the single-row run and accept already refuse it. The bytes are the sweeper's
 * (still a card). ⚠️ MUTATION (batch.test): drop the `gt` predicate — "an expired ready row shows under
 * Now" reds by name.
 */
export async function listEditPreviews(
  athleteId: string,
  opts: { batchId?: string; limit?: number } = {},
): Promise<StudioEditPreview[]> {
  const live = gt(studioEditPreviews.expires_at, new Date());
  const where = opts.batchId
    ? and(
        eq(studioEditPreviews.athlete_id, athleteId),
        eq(studioEditPreviews.batch_id, opts.batchId),
        live,
      )
    : and(eq(studioEditPreviews.athlete_id, athleteId), live);
  return db
    .select()
    .from(studioEditPreviews)
    .where(where)
    .orderBy(desc(studioEditPreviews.created_at))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
}

/** Compare-and-set: from `from` to `to`, with these fields, for her row. True when THIS call moved it. */
export async function advance(
  athleteId: string,
  id: string,
  from: StudioEditPreviewStatus,
  to: StudioEditPreviewStatus,
  fields: Partial<{
    job_id: string | null;
    gcs_path: string | null;
    content_type: string | null;
    bytes: number | null;
    width: number | null;
    height: number | null;
    cost_usd: string | null;
    accepted_asset_id: string | null;
    error: string | null;
    ran_at: Date | null;
    decided_at: Date | null;
  }> = {},
): Promise<boolean> {
  const moved = await db
    .update(studioEditPreviews)
    .set({ status: to, ...fields })
    .where(
      and(
        eq(studioEditPreviews.id, id),
        eq(studioEditPreviews.athlete_id, athleteId),
        eq(studioEditPreviews.status, from),
      ),
    )
    .returning({ id: studioEditPreviews.id });
  return moved.length === 1;
}

/** Where a preview's bytes live: under her prefix, under studio/edit-previews — NEVER a library path. */
export const editPreviewObjectBase = (athleteId: string, id: string): string =>
  `athletes/${athleteId}/studio/edit-previews/${id}`;

export const isEditPreviewExpired = (
  row: StudioEditPreview,
  now = Date.now(),
): boolean => row.expires_at.getTime() <= now;
