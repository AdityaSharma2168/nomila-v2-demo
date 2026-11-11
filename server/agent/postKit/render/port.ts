/**
 * agent/postKit/render/port.ts — the production render port (request.ts PostKitRenderPort): the stitch queue, the
 * published outputs, and signed URLs for a screen. Loaded with the post-kit deps (deps.ts), never by the runner.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db";
import { mediaAssets } from "../../../../shared/schema";
import { signedUrl } from "../../../lib/mediaStore";
import { createLogger } from "../../../logger";
import { cancelQueuedStitch, queueStitchJob, readStitchJob } from "../../../studio/stitchJobs";
import { findPublishedOutputs, outputsExist } from "./publish";
import type { PostKitRenderPort, RenderJobStatus } from "./request";

const logger = createLogger("agent/postKit/render/port");

const JOB_STATUSES: readonly string[] = ["queued", "running", "succeeded", "failed", "canceled"];

export const dbPostKitRenderPort: PostKitRenderPort = {
  async queue(athleteId, spec) {
    const { id, createdAt } = await queueStitchJob(athleteId, spec);
    return { jobId: id, queuedAt: createdAt };
  },

  async cancel(athleteId, jobId) {
    await cancelQueuedStitch(athleteId, jobId, "Not needed: this post's preview is already asked for.");
  },

  async jobStatus(athleteId, jobId) {
    const row = await readStitchJob(athleteId, jobId);
    return row && JOB_STATUSES.includes(row.status) ? (row.status as RenderJobStatus) : null;
  },

  async clock() {
    const res = await db.execute(sql`SELECT now() AS now`);
    const rows = ((res as unknown as { rows?: Array<{ now: unknown }> }).rows ?? res) as unknown as Array<{ now: unknown }>;
    return new Date(rows[0].now as string).toISOString();
  },

  kick() {
    // AFTER the preview is written, unawaited and swallowed: the job is durably queued, so a failed kick costs latency
    // and never the render. The tick's own capacity guard stops this racing the scheduler into two workspaces.
    void import("../../../studio/stitchRunner")
      .then(({ stitchTick }) => stitchTick())
      .catch((err) => logger.warn({ error: String(err?.message ?? err).slice(0, 200) }, "post kit render kick failed — the scheduled tick will pick it up"));
  },

  published: findPublishedOutputs,
  outputsExist,

  async sign(athleteId, preview) {
    const ids = [...new Set([...preview.outputs.map((o) => o.assetId), ...(preview.coverAssetId ? [preview.coverAssetId] : [])])];
    if (!ids.length) return { items: [], coverUrl: null };
    const rows = await db.select({ id: mediaAssets.id, gcs_path: mediaAssets.gcs_path, gcs_thumb_path: mediaAssets.gcs_thumb_path })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.athlete_id, athleteId), inArray(mediaAssets.id, ids), isNull(mediaAssets.deleted_at)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = await Promise.all(preview.outputs.map(async (o) => {
      const path = byId.get(o.assetId)?.gcs_path;
      return path ? signedUrl(path) : null;
    }));
    const cover = preview.coverAssetId ? byId.get(preview.coverAssetId) : undefined;
    const coverPath = cover ? cover.gcs_thumb_path ?? cover.gcs_path : null;
    return { items, coverUrl: coverPath ? await signedUrl(coverPath) : null };
  },
};
