/**
 * studio/enrich/retag — the PR 12 backfill: two keys onto rows the tagger has already read.
 *
 * ─── PHASE A, PER GO (ruling 6, 23 Sep 2026) ────────────────────────────────────────────────────
 *
 *   cell (a)  `face`     face_visibility + role onto every tagged photo that lacks them
 *   cell (b)  `subject`  subject (+ the derived athlete_present) onto pre-ternary rows (card F20)
 *   cell (c)  `frame`    face_box + text_in_image onto rows tagged before 21 Oct 2026 (where a crop keeps her; burned-in text)
 *
 * Each is a re-run of `tagAsset` on a row that already carries `vision` — which `enrichRows`
 * (services/mediaEnrichment.ts) would skip — so the backfill has its own door. Athlete-scoped,
 * capped, one row at a time, and NOTHING here runs on its own: a caller quotes (`quoteRetag`), Adi
 * says go, then `retag` runs the batch.
 *
 * ─── THE WRITE IS jsonb_set ON THE KEYS INSIDE vision, NEVER THE OBJECT ─────────────────────────
 *
 * Three writers share `media_assets.metadata` beside the photo tagger: the clip lane (`vision`,
 * `enrichment`, `provenance_signal`), a clip read on demand (`clip_read`, PR 9.5) and the spend
 * meter (`enrich_spend`). A whole-metadata or whole-vision write from a stale read erases whatever
 * they wrote in between (studio/qa/record.ts names the race; services/videoPoster.ts did it once).
 * So this writes `{vision,face_visibility}` and `{vision,role}` — or `{vision,subject}` and
 * `{vision,athlete_present}` — and not one other key. The model's answer to the OTHER 16 fields
 * is read and discarded: P-stable measured the prompt, and the write is what keeps stored rows
 * still (docs/probes/library-fields.md).
 *
 * ⚠️ MUTATIONS (retag.test):
 *   "backfill rewrites the vision object"   — write `vision` whole: the 16 fields and beats move
 *   "backfill clobbers clip_read"            — write `metadata` whole: clip_read is gone
 *   "backfill runs without a cap"            — drop `limit`
 */
import { notAPreview } from "../../lib/previewAsset";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { tagProfileFor } from "../../lib/tagProfile";
import {
  applyFaceRole,
  applyFrameKeys,
  applySubject,
  type FaceBox,
  tagAsset,
  type FaceVisibility,
  type TagRole,
  type TagSubject,
} from "../../lib/visionTag";

const logger = createLogger("studio/enrich/retag");

export type RetagCell = "face" | "subject" | "frame";

/** The tagger's estimated cost per call, USD — the P-stable measurement (docs/probes/library-fields.md). */
export const RETAG_USD_PER_ROW = 0.0048;

/**
 * The rows a cell would touch: hers, stored, top-level, tagged, missing the cell's key — photos AND
 * videos (Adi's ruling, 24 Sep 2026: YOUR VIDEOS sorts and labels off the poster tag, so the poster
 * tag gets the keys too). A video is re-tagged from what enrichment tagged it from — its poster, or
 * the still an Instagram clip stored — so a video with no poster and only an mp4 is not a candidate,
 * exactly as it is not one for enrichment (services/mediaEnrichment.ts UNENRICHED).
 */
export async function retagCandidates(
  athleteId: string,
  cell: RetagCell,
  limit: number,
): Promise<{ id: string; img: string }[]> {
  const missing =
    cell === "face"
      ? isNull(sql`${mediaAssets.metadata} -> 'vision' -> 'face_visibility'`)
      : cell === "frame"
        ? isNull(sql`${mediaAssets.metadata} -> 'vision' -> 'text_in_image'`)
        : isNull(sql`${mediaAssets.metadata} -> 'vision' -> 'subject'`);
  const rows = await db
    .select({
      id: mediaAssets.id,
      thumb: mediaAssets.gcs_thumb_path,
      path: mediaAssets.gcs_path,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, athleteId),
        eq(mediaAssets.status, "stored"),
        isNull(mediaAssets.deleted_at),
        isNull(mediaAssets.parent_media_id),
        ne(mediaAssets.origin, "reference"), notAPreview(), // never a reference she pointed the direction engine at (0062)
        isNotNull(sql`${mediaAssets.metadata} -> 'vision'`),
        missing,
        sql`(${mediaAssets.gcs_thumb_path} IS NOT NULL OR coalesce(${mediaAssets.content_type}, '') NOT LIKE 'video/%')`,
      ),
    )
    .orderBy(mediaAssets.id)
    .limit(limit);
  return rows
    .map((r) => ({ id: r.id, img: (r.thumb ?? r.path)! }))
    .filter((r) => r.img);
}

/** The quote for one batch: rows × the per-row estimate. What Adi says go to. */
export async function quoteRetag(
  athleteId: string,
  cell: RetagCell,
  limit: number,
): Promise<{ rows: number; usd: number }> {
  const rows = (await retagCandidates(athleteId, cell, limit)).length;
  return { rows, usd: Number((rows * RETAG_USD_PER_ROW).toFixed(4)) };
}

/** One row's write for a cell: the keys, and nothing else. Exported so the test can hold the SQL shape. */
export async function writeRetag(
  id: string,
  cell: RetagCell,
  answer: {
    face_visibility?: FaceVisibility;
    role?: TagRole;
    subject?: TagSubject;
    athlete_present: boolean;
    face_box?: FaceBox | null;
    text_in_image?: { present: boolean; share: number };
  },
): Promise<boolean> {
  if (cell === "frame") {
    if (!answer.text_in_image || answer.face_box === undefined) return false;
    await db.execute(sql`
      UPDATE ${mediaAssets}
         SET metadata = jsonb_set(
               jsonb_set(metadata, '{vision,face_box}', ${JSON.stringify(answer.face_box)}::jsonb),
               '{vision,text_in_image}', ${JSON.stringify(answer.text_in_image)}::jsonb),
             metadata_updated_at = now()
       WHERE id = ${id} AND metadata -> 'vision' IS NOT NULL`);
    return true;
  }
  if (cell === "face") {
    if (!answer.face_visibility || !answer.role) return false;
    await db.execute(sql`
      UPDATE ${mediaAssets}
         SET metadata = jsonb_set(
               jsonb_set(metadata, '{vision,face_visibility}', ${JSON.stringify(answer.face_visibility)}::jsonb),
               '{vision,role}', ${JSON.stringify(answer.role)}::jsonb),
             metadata_updated_at = now()
       WHERE id = ${id} AND metadata -> 'vision' IS NOT NULL`);
    return true;
  }
  if (!answer.subject) return false;
  await db.execute(sql`
    UPDATE ${mediaAssets}
       SET metadata = jsonb_set(
             jsonb_set(metadata, '{vision,subject}', ${JSON.stringify(answer.subject)}::jsonb),
             '{vision,athlete_present}', ${JSON.stringify(answer.athlete_present)}::jsonb),
           metadata_updated_at = now()
     WHERE id = ${id} AND metadata -> 'vision' IS NOT NULL`);
  return true;
}

/**
 * One batch, after the go. `limit` is the batch; a row whose answer lacks the cell's keys is left
 * untouched and counted as `skipped` (the next batch sees it again).
 */
export async function retag(
  athleteId: string,
  cell: RetagCell,
  limit: number,
): Promise<{
  attempted: number;
  written: number;
  skipped: number;
  failed: number;
}> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("retag needs a batch limit");
  const rows = await retagCandidates(athleteId, cell, limit);
  const profile = await tagProfileFor(athleteId);
  let written = 0,
    skipped = 0,
    failed = 0;
  for (const r of rows) {
    const t = await tagAsset(r.img, profile);
    if (!t) {
      failed += 1;
      continue;
    }
    // Coerced here too — the write must never store a word no reader knows, whoever tagged.
    const a = applyFrameKeys(applyFaceRole(applySubject(t)));
    const ok = await writeRetag(r.id, cell, a);
    if (ok) written += 1;
    else skipped += 1;
  }
  const out = { attempted: rows.length, written, skipped, failed };
  logger.info({ athleteId, cell, ...out }, "retag batch done");
  return out;
}
