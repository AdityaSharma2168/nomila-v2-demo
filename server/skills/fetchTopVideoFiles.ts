/**
 * fetchTopVideoFiles — download the actual mp4 for an athlete's top-performing Instagram
 * videos (by views), so the media kit can embed a *playable* reel instead of a poster that
 * links out. Instagram only — TikTok/YouTube never expose the raw file (permalink/embed only).
 *
 * Targeted: top N videos by views (the enrichment populated views first), and only if we don't
 * already own the mp4. On success the mp4 becomes the row's primary `gcs_path` (pixel_grade
 * 'full') and `gcs_thumb_path` is left NULL: the poster worker (services/videoPoster.ts, which
 * takes origin 'connected' too) cuts the poster from the mp4, measures its precise duration,
 * transcodes it and records `original_gcs_path` — the full job an upload gets. Until that tick
 * (every 5 min) the row has no thumbnail, as an upload does. Best-effort: never throws; oversized
 * files are skipped (poster kept). See docs/media-library-backfill.md.
 *
 * N is INSTAGRAM_VIDEO_FETCH_CAP, default 8 — the value it has always had (PR 4, Studio ingest).
 *
 * ─── MEDIA_VIDEO_FIXES ON: EVERY VIDEO SHE OWNS (media-intake plan, fix 1) ───────────────────────
 *
 * The top 8 left 203 of one athlete's 212 reels as a single poster frame, and a poster can't be cut into a post. With
 * the flag on, every Instagram video of hers whose mp4 we don't hold yet is a candidate, in this order: the most-viewed
 * (the top N above) first, then the newest. Each nightly tick takes at most INSTAGRAM_VIDEO_FETCH_TICK_MAX files and
 * INSTAGRAM_VIDEO_FETCH_TICK_MB megabytes per athlete, so the 04:30 chain stays bounded and the backlog drains over a
 * few nights. A file over the 100 MB cap is marked once and never retried; a fetch that fails three nights running is
 * left as its poster. The poster JPEG the mp4 replaces is LEFT where it is (about 200 KB, and a saved card may still
 * name its path); the poster worker cuts the clip's own poster off the mp4. Every metadata write is jsonb on its own keys, never the row's metadata as read. Off: exactly
 * the top-8 behaviour above.
 */
import { db } from "../db";
import { connectedAccounts, mediaAssets } from "../../shared/schema";
import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { fetchMediaFileUrl } from "../lib/integrations/instagram";
import { rehostFromUrl } from "../lib/mediaStore";
import { createLogger } from "../logger";
import {
  INSTAGRAM_VIDEO_FETCH_MAX_FAILURES, instagramVideoTickBytes, instagramVideoTickMax, mediaVideoFixesEnabled,
} from "../lib/mediaVideoFixes";

const logger = createLogger("top-video-files");
const TOP_VIDEOS_DEFAULT = 8;
/** How many top videos per athlete get their mp4 — env, read per call, default unchanged. */
export const topVideosCap = (): number => {
  const n = Number(process.env.INSTAGRAM_VIDEO_FETCH_CAP);
  return Number.isInteger(n) && n > 0 ? n : TOP_VIDEOS_DEFAULT;
};
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;   // 100 MB — reels run tens of MB vs ~200 kB posters

async function activeConnectionId(athleteId: string, platform: string): Promise<string | null> {
  const [row] = await db.select({ id: connectedAccounts.id }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.platform, platform), eq(connectedAccounts.status, "active")))
    .limit(1);
  return row?.id ?? null;
}

export async function fetchTopVideoFiles(athleteId: string): Promise<{ fetched: number; skipped: number; failed: number }> {
  const connId = await activeConnectionId(athleteId, "instagram");
  if (!connId) return { fetched: 0, skipped: 0, failed: 0 };
  if (mediaVideoFixesEnabled()) return fetchEveryVideoFile(athleteId, connId);

  const top = await db.select().from(mediaAssets)
    .where(and(
      eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.platform, "instagram"),
      eq(mediaAssets.status, "stored"), isNull(mediaAssets.parent_media_id),
      inArray(mediaAssets.media_type, ["VIDEO", "REELS"]),
    ))
    .orderBy(sql`(${mediaAssets.insights}->>'video_views')::bigint DESC NULLS LAST`)
    .limit(topVideosCap());

  let fetched = 0, skipped = 0, failed = 0;
  for (const r of top) {
    if (!r.source_media_id) continue;
    if ((r.content_type ?? "").startsWith("video/")) continue;   // already own the mp4

    const mp4Url = await fetchMediaFileUrl(connId, r.source_media_id).catch(() => null);
    if (!mp4Url) { failed++; continue; }

    const rr = await rehostFromUrl(mp4Url, `athletes/${athleteId}/instagram/${r.source_media_id}`, VIDEO_MAX_BYTES);
    if (rr && "gcs_path" in rr) {
      await db.update(mediaAssets).set({
        gcs_path:            rr.gcs_path,                                   // the mp4 is now the primary asset
        content_type:        rr.content_type,
        bytes:               rr.bytes,
        metadata:            { ...(r.metadata as Record<string, unknown> ?? {}), pixel_grade: "full", video_fetched_at: new Date().toISOString() } as any,
        metadata_updated_at: new Date(),
      }).where(eq(mediaAssets.id, r.id));
      fetched++;
    } else if (rr && "skipped" in rr) {
      skipped++;
    } else {
      failed++;
    }
  }
  logger.info({ athleteId, fetched, skipped, failed }, "top video files fetched");
  return { fetched, skipped, failed };
}

/** One candidate for fix 1: what the order and the budget need, nothing more. */
export interface VideoFileCandidate {
  id: string;
  sourceMediaId: string;
  gcsPath: string | null;
  views: number | null;
  postedAt: Date | null;
}

/**
 * Fix 1's order: the `top` most-viewed first (by views, most first), then every other candidate newest first. Pure.
 * A candidate with no views sorts after every one with views inside the top slice, and by date after it.
 */
export function videoFetchOrder(rows: readonly VideoFileCandidate[], top: number): VideoFileCandidate[] {
  const byViews = [...rows].sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || a.id.localeCompare(b.id));
  const head = byViews.slice(0, top).filter((r) => r.views !== null);
  const taken = new Set(head.map((r) => r.id));
  const rest = rows
    .filter((r) => !taken.has(r.id))
    .sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  return [...head, ...rest];
}

/** Add one key's worth of state to a row's metadata, in SQL (never the object as read). */
async function markRow(id: string, patch: Record<string, unknown>): Promise<void> {
  await db.update(mediaAssets).set({
    metadata: sql`coalesce(${mediaAssets.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    metadata_updated_at: new Date(),
  }).where(eq(mediaAssets.id, id));
}

/** Fix 1 (MEDIA_VIDEO_FIXES): the mp4 for every Instagram video of hers we don't hold yet, under the tick's budget. */
async function fetchEveryVideoFile(athleteId: string, connId: string): Promise<{ fetched: number; skipped: number; failed: number }> {
  const rows = await db.select({
    id: mediaAssets.id, sourceMediaId: mediaAssets.source_media_id, gcsPath: mediaAssets.gcs_path,
    views: sql<string | null>`${mediaAssets.insights}->>'video_views'`, postedAt: mediaAssets.posted_at,
    failures: sql<string | null>`${mediaAssets.metadata}->>'video_fetch_failures'`,
  }).from(mediaAssets)
    .where(and(
      eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.platform, "instagram"),
      eq(mediaAssets.status, "stored"), isNull(mediaAssets.parent_media_id), isNull(mediaAssets.deleted_at),
      inArray(mediaAssets.media_type, ["VIDEO", "REELS"]),
      sql`coalesce(${mediaAssets.content_type}, '') NOT LIKE 'video/%'`,
      sql`${mediaAssets.metadata}->>'video_fetch_skipped' IS NULL`,
      sql`coalesce((${mediaAssets.metadata}->>'video_fetch_failures')::int, 0) < ${INSTAGRAM_VIDEO_FETCH_MAX_FAILURES}`,
    ))
    .limit(2000);
  const ordered = videoFetchOrder(
    rows.filter((r) => r.sourceMediaId).map((r) => ({
      id: r.id, sourceMediaId: r.sourceMediaId!, gcsPath: r.gcsPath,
      views: r.views === null || r.views === undefined || !Number.isFinite(Number(r.views)) ? null : Number(r.views),
      postedAt: r.postedAt ?? null,
    })),
    topVideosCap(),
  );
  const failuresOf = new Map(rows.map((r) => [r.id, Number(r.failures ?? 0) || 0]));

  const maxFiles = instagramVideoTickMax();
  const maxBytes = instagramVideoTickBytes();
  let fetched = 0, skipped = 0, failed = 0, bytes = 0;
  for (const r of ordered) {
    if (fetched + skipped + failed >= maxFiles || bytes >= maxBytes) break;
    const mp4Url = await fetchMediaFileUrl(connId, r.sourceMediaId).catch(() => null);
    const rr = mp4Url ? await rehostFromUrl(mp4Url, `athletes/${athleteId}/instagram/${r.sourceMediaId}`, VIDEO_MAX_BYTES) : null;
    if (rr && "gcs_path" in rr) {
      await db.update(mediaAssets).set({
        gcs_path: rr.gcs_path, content_type: rr.content_type, bytes: rr.bytes,
        metadata: sql`coalesce(${mediaAssets.metadata}, '{}'::jsonb) - 'video_fetch_failures' || ${JSON.stringify({ pixel_grade: "full", video_fetched_at: new Date().toISOString() })}::jsonb`,
        metadata_updated_at: new Date(),
      }).where(eq(mediaAssets.id, r.id));
      bytes += rr.bytes;
      fetched++;
    } else if (rr && "skipped" in rr) {
      await markRow(r.id, { video_fetch_skipped: "size" });
      skipped++;
    } else {
      await markRow(r.id, { video_fetch_failures: (failuresOf.get(r.id) ?? 0) + 1 });
      failed++;
    }
  }
  logger.info({ athleteId, fetched, skipped, failed, bytes, candidates: ordered.length }, "instagram video files fetched (every video)");
  return { fetched, skipped, failed };
}

/** Daily cron entry: fetch top-video files for every athlete with an active Instagram connection. */
export async function fetchAllTopVideoFiles(): Promise<{ athletes: number }> {
  const rows = await db.selectDistinct({ id: connectedAccounts.athlete_id }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.platform, "instagram"), eq(connectedAccounts.status, "active")));
  for (const r of rows) {
    await fetchTopVideoFiles(r.id).catch((e: any) => logger.warn({ athleteId: r.id, error: e?.message?.slice(0, 120) }, "top video fetch failed"));
  }
  logger.info({ athletes: rows.length }, "top video files batch complete");
  return { athletes: rows.length };
}
