/**
 * agent/postKit/render/publish.ts — a preview's files become DERIVED media assets in the athlete's own space, with
 * their lineage (design §11 v2, build step 9).
 *
 *   where     athletes/<athlete>/studio/post-kit/<decision>/<key>/<i>-of-<n>.mp4|jpg under the athlete's own prefix; a
 *             video's cover still beside it (<i>-of-<n>.cover.jpg) as its gcs_thumb_path (its poster)
 *   what      origin "generated" (made here), platform "studio", born approval "draft", derived_from_asset_id = the kit
 *             asset it was cut from (a carousel picture: its own photo; a reel: its opening position — the stitch row's
 *             spec.clips names every source), and content_format "post_kit_preview" — the mark every library reader,
 *             the Made shelf and enrichment skip (lib/previewAsset.ts): a preview is reached only through its kit
 *   once      the path is the identity. The row writes run in ONE transaction under a transaction-scoped advisory lock
 *             on (athlete, key), re-selecting by path inside it — so two runs of the same key (a reaped lease, or two
 *             jobs that both got past their checks) update one row per path instead of inserting two. No migration.
 *
 * Every read and write carries the athlete id, which comes off the claimed job row — never off the spec.
 */
import { stat } from "fs/promises";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { db } from "../../../db";
import { mediaAssets } from "../../../../shared/schema";
import type { PostKitPreviewOutput } from "../../../../shared/postKit";
import { uploadLocalFile } from "../../../lib/mediaStore";
import { POST_KIT_PREVIEW_FORMAT } from "../../../lib/previewAsset";
import { createLogger } from "../../../logger";
import { STUDIO_PLATFORM } from "../../../studio/config";
import { parseRenderOutputPath, renderCoverPath, renderKeyPrefix, renderOutputPath } from "./compile";
import type { LocalRender } from "./local";

const logger = createLogger("agent/postKit/render/publish");

export interface PublishInput {
  athleteId: string;
  decisionId: string;
  key: string;
  render: LocalRender;
}

/** Upload every output (and a video's cover), then write or update their rows atomically. The outputs, in order. */
export async function publishRenderOutputs(input: PublishInput): Promise<PostKitPreviewOutput[]> {
  const { athleteId, decisionId, key, render } = input;
  const count = render.outputs.length;
  const prepared: Array<{ fields: Record<string, unknown>; kind: "video" | "image"; sourceAssetId: string; gcsPath: string }> = [];
  // The bytes first, outside the transaction: an upload to the same path twice is an overwrite, never a duplicate.
  for (const [i, o] of render.outputs.entries()) {
    const gcsPath = renderOutputPath(athleteId, decisionId, key, i, count, o.kind);
    await uploadLocalFile(o.path, gcsPath, o.contentType);
    let thumbPath: string | null = null;
    if (render.cover.outputIndex === i && render.cover.path) {
      thumbPath = renderCoverPath(athleteId, decisionId, key, i, count);
      await uploadLocalFile(render.cover.path, thumbPath, "image/jpeg");
    }
    prepared.push({
      kind: o.kind, sourceAssetId: o.sourceAssetId, gcsPath,
      fields: {
        gcs_path: gcsPath,
        gcs_thumb_path: thumbPath,
        content_type: o.contentType,
        content_format: POST_KIT_PREVIEW_FORMAT,
        width: o.width,
        height: o.height,
        bytes: (await stat(o.path)).size,
        duration_seconds: o.durationSec === null ? null : Math.round(o.durationSec),
        duration_seconds_precise: o.durationSec,
        derived_from_asset_id: o.sourceAssetId,
        status: "stored",
      },
    });
  }

  const out = await db.transaction(async (tx) => {
    // Serialises every writer of THIS athlete's THIS key until commit; nothing else waits on it.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${athleteId}), hashtext(${key}))`);
    const rows: PostKitPreviewOutput[] = [];
    for (const p of prepared) {
      const [existing] = await tx.select({ id: mediaAssets.id }).from(mediaAssets)
        .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.gcs_path, p.gcsPath), isNull(mediaAssets.deleted_at)))
        .limit(1);
      let assetId: string;
      if (existing) {
        await tx.update(mediaAssets).set(p.fields as never).where(and(eq(mediaAssets.id, existing.id), eq(mediaAssets.athlete_id, athleteId)));
        assetId = existing.id;
      } else {
        const [row] = await tx.insert(mediaAssets).values({
          athlete_id: athleteId,
          platform: STUDIO_PLATFORM,
          origin: "generated",
          media_type: p.kind === "video" ? "VIDEO" : "IMAGE",
          approval_status: "draft",
          generation_job_id: null,
          ingested_at: new Date(),
          ...p.fields,
        } as never).returning({ id: mediaAssets.id });
        assetId = row.id;
      }
      rows.push({ assetId, kind: p.kind, sourceAssetId: p.sourceAssetId });
    }
    return rows;
  });
  logger.info({ athleteId, decisionId, key, outputs: out.length }, "post kit preview published");
  return out;
}

/**
 * The outputs published before for this kit and key, in order — what a run ACTUALLY wrote (its own count is in every
 * path), or null unless one count's every index is there, stored and not deleted. The athlete's own rows only.
 */
export async function findPublishedOutputs(athleteId: string, decisionId: string, key: string): Promise<PostKitPreviewOutput[] | null> {
  const prefix = renderKeyPrefix(athleteId, decisionId, key);
  const rows = await db.select({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path, derived: mediaAssets.derived_from_asset_id })
    .from(mediaAssets)
    .where(and(
      eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"), isNull(mediaAssets.deleted_at),
      like(mediaAssets.gcs_path, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
    ));
  const byCount = new Map<number, Map<number, PostKitPreviewOutput>>();
  for (const r of rows) {
    const p = r.gcs_path ? parseRenderOutputPath(r.gcs_path) : null;
    if (!p || !r.derived || r.gcs_path !== renderOutputPath(athleteId, decisionId, key, p.index, p.count, p.kind)) continue;
    if (!byCount.has(p.count)) byCount.set(p.count, new Map());
    byCount.get(p.count)!.set(p.index, { assetId: r.id, kind: p.kind, sourceAssetId: r.derived });
  }
  for (const [count, set] of [...byCount].sort((a, b) => b[0] - a[0])) {
    if (set.size === count) return [...Array(count).keys()].map((i) => set.get(i)!);
  }
  return null;
}

/** Whether every one of these assets is still the athlete's, stored and not deleted (a ready preview's outputs). */
export async function outputsExist(athleteId: string, assetIds: readonly string[]): Promise<boolean> {
  if (!assetIds.length) return false;
  const rows = await db.select({ id: mediaAssets.id }).from(mediaAssets)
    .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"), isNull(mediaAssets.deleted_at),
      inArray(mediaAssets.id, [...assetIds])));
  return new Set(rows.map((r) => r.id)).size === new Set(assetIds).size;
}
