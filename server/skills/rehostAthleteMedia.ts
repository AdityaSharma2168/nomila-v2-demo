/**
 * rehostAthleteMedia — re-host an athlete's recent Instagram post media into GCS +
 * media_assets, turning ephemeral CDN URLs into owned durable stills.
 *
 * Runs in the daily 04:30 cron RIGHT AFTER collectAllAnalyticsSnapshots — so it reads
 * fresh, unexpired media_url/thumbnail_url from the just-written snapshot. Best-effort
 * and fully decoupled: a media failure never touches analytics or scoring.
 *
 * v1: stills only (image → media_url; video/Reel → poster thumbnail). Carousels store
 * the album cover on the parent + one CAROUSEL_CHILD row per child. Pixels download
 * once; caption + counts + insights refresh every pass (captions are editable). Rows
 * that previously failed are retried. See docs/durable-media-rehosting.md.
 */
import { db } from "../db";
import { socialAnalyticsSnapshots, mediaAssets } from "../../shared/schema";
import type { NewMediaAsset, SocialAnalyticsRaw } from "../../shared/schema";
import { and, eq, desc } from "drizzle-orm";
import { rehostFromUrl } from "../lib/mediaStore";
import { createLogger } from "../logger";

const logger = createLogger("rehost-media");
const PLATFORMS = ["instagram", "tiktok", "youtube"] as const;   // discovery-source flows through the same path once BD is live
const CONCURRENCY = 4;

export type RecentMedia = NonNullable<SocialAnalyticsRaw["recent_media"]>[number];
type PixelGrade = "full" | "thumbnail";

/** Load the athlete's already-ingested media ids → status, so ingest downloads pixels once. */
export async function loadSeen(athleteId: string): Promise<Map<string, string>> {
  const priorRows = await db.select({ sid: mediaAssets.source_media_id, status: mediaAssets.status })
    .from(mediaAssets).where(eq(mediaAssets.athlete_id, athleteId));
  const seen = new Map<string, string>();
  for (const r of priorRows) if (r.sid) seen.set(r.sid, r.status);
  return seen;
}

/**
 * The ownable still per platform/type + its grade — a fact about the source, not a quality call
 * (drives the "no hero imagery from thumbnails" selection rule; see docs/media-library-backfill.md):
 *   IG image / carousel cover / carousel child image → the image itself                (full)
 *   IG video / Reel                                  → poster thumbnail                (thumbnail; full mp4 = later flag)
 *   TikTok / YouTube                                 → cover/thumbnail only            (thumbnail)
 * TikTok/YouTube `media_url` is a share/watch webpage, never a media file — never download it;
 * their durable video link lives in `permalink`.
 */
function pixelFor(platform: string, mediaType: string, media_url: string | null, thumbnail_url: string | null): { url: string | null; grade: PixelGrade } {
  if (platform === "tiktok" || platform === "youtube") return { url: thumbnail_url, grade: "thumbnail" };
  if (mediaType === "VIDEO" || mediaType === "REELS")  return { url: thumbnail_url ?? media_url, grade: "thumbnail" };
  return { url: media_url ?? thumbnail_url, grade: "full" };
}

async function upsert(row: NewMediaAsset): Promise<void> {
  await db.insert(mediaAssets).values(row).onConflictDoUpdate({
    target: [mediaAssets.athlete_id, mediaAssets.platform, mediaAssets.source_media_id],
    set: { ...row },
  });
}

export async function ingestOne(
  athleteId: string, platform: string, origin: string, m: RecentMedia, seen: Map<string, string>,
): Promise<"stored" | "updated" | "failed"> {
  const basePath = (id: string) => `athletes/${athleteId}/${platform}/${id}`;
  const postedAt = m.timestamp ? new Date(m.timestamp) : null;
  const metaFields = {
    caption: m.caption ?? null, like_count: m.like_count ?? null,
    comments_count: m.comments_count ?? null, insights: (m.insights ?? null) as any,
    metadata_updated_at: new Date(),
  };

  const prior = seen.get(m.id);
  const alreadyStored = prior != null && prior !== "failed";

  if (alreadyStored) {
    // refresh metadata only — pixels are immutable, but caption/counts change
    await db.update(mediaAssets).set(metaFields)
      .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.platform, platform), eq(mediaAssets.source_media_id, m.id)));
  } else {
    // new or previously-failed → (re)download the still
    const { url: stillUrl, grade } = pixelFor(platform, m.media_type, m.media_url, m.thumbnail_url);
    let pix = { gcs_path: null as string | null, content_type: null as string | null, bytes: null as number | null, status: "failed" as string };
    if (stillUrl) {
      const r = await rehostFromUrl(stillUrl, basePath(m.id));
      if (r && "gcs_path" in r) pix = { gcs_path: r.gcs_path, content_type: r.content_type, bytes: r.bytes, status: "stored" };
      else if (r && "skipped" in r) pix.status = "skipped_size";
    }
    await upsert({
      athlete_id: athleteId, platform, origin, source_media_id: m.id, parent_media_id: null,
      media_type: m.media_type, permalink: m.permalink ?? null, posted_at: postedAt,
      gcs_thumb_path: null, ingested_at: new Date(), metadata: { pixel_grade: grade } as any, ...metaFields, ...pix,
    });
  }

  // carousel children — each gets its own CAROUSEL_CHILD row
  if (m.media_type === "CAROUSEL_ALBUM" && m.children?.length) {
    for (const c of m.children) {
      if (seen.get(c.id) != null && seen.get(c.id) !== "failed") continue;
      const { url: childUrl, grade } = pixelFor(platform, c.media_type, c.media_url, c.thumbnail_url);
      let pix = { gcs_path: null as string | null, content_type: null as string | null, bytes: null as number | null, status: "failed" as string };
      if (childUrl) {
        const r = await rehostFromUrl(childUrl, basePath(c.id));
        if (r && "gcs_path" in r) pix = { gcs_path: r.gcs_path, content_type: r.content_type, bytes: r.bytes, status: "stored" };
        else if (r && "skipped" in r) pix.status = "skipped_size";
      }
      await upsert({
        athlete_id: athleteId, platform, origin, source_media_id: c.id, parent_media_id: m.id,
        media_type: "CAROUSEL_CHILD", permalink: m.permalink ?? null, posted_at: postedAt,
        caption: null, like_count: null, comments_count: null, insights: null,
        gcs_thumb_path: null, ingested_at: new Date(), metadata: { pixel_grade: grade } as any, ...pix,
      });
    }
  }
  return alreadyStored ? "updated" : "stored";
}

export async function rehostAthleteMedia(athleteId: string): Promise<{ processed: number; stored: number; updated: number; failed: number }> {
  let processed = 0, stored = 0, updated = 0, failed = 0;

  const seen = await loadSeen(athleteId);

  for (const platform of PLATFORMS) {
    const [snap] = await db.select().from(socialAnalyticsSnapshots)
      .where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.platform, platform)))
      .orderBy(desc(socialAnalyticsSnapshots.snapshot_date)).limit(1);
    if (!snap) continue;
    const origin = snap.source === "discovery" ? "discovery" : "connected";
    const media = (snap.raw_metrics as SocialAnalyticsRaw | null)?.recent_media ?? [];
    for (let i = 0; i < media.length; i += CONCURRENCY) {
      const batch = media.slice(i, i + CONCURRENCY);
      const res = await Promise.all(batch.map((m) => ingestOne(athleteId, platform, origin, m, seen).catch(() => "failed" as const)));
      for (const r of res) { processed++; r === "stored" ? stored++ : r === "updated" ? updated++ : failed++; }
    }
  }
  logger.info({ athleteId, processed, stored, updated, failed }, "media rehost complete");
  return { processed, stored, updated, failed };
}

/** Batch: re-host media for every athlete that has a social analytics snapshot. Used by the daily cron. */
export async function rehostAllAthletesMedia(): Promise<{ athletes: number }> {
  const rows = await db.selectDistinct({ id: socialAnalyticsSnapshots.athlete_id }).from(socialAnalyticsSnapshots);
  for (const r of rows) {
    await rehostAthleteMedia(r.id).catch((e: any) => logger.warn({ athleteId: r.id, error: e.message?.slice(0, 120) }, "rehost failed"));
  }
  logger.info({ athletes: rows.length }, "media rehost batch complete");
  return { athletes: rows.length };
}
