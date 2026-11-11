/**
 * agent/postKit/media.ts — the post-kit builder's library port, on the real tables (build.ts PostKitMedia).
 *
 *   search   services/mediaSearch.ts searchMedia, exactly as the Nomi Card curator casts (brief, athlete present,
 *            diverse, k 12) with brand_safe as a HARD filter, plus a clip-only search (playable video, purpose video);
 *            the ids only — never trusted as a verdict
 *   load     studio/agent/cast.ts loadCastable: the ids through herPhoto OR herClip (studio/photoPredicate.ts), under
 *            the athlete's id — another athlete's id, a deleted row, a reference and a poster-only video do not come back
 *   newlyTagged  herPhoto OR herClip, tagged, tag time after a cursor, OLDEST first (a page), then the same loadCastable
 *   urls     signed URLs for a screen (lib/mediaStore.ts)
 *   trackUrl a short-lived listening link for one of the product's music files (a kit's suggested track)
 *
 * Loaded lazily by the routes and the workflow: mediaSearch and the caster build cloud clients at load.
 */
import { and, asc, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { signedUrl } from "../../lib/mediaStore";
import { BED_PREVIEW_TTL_MS } from "../../studio/video/beds";
import { searchMedia } from "../../services/mediaSearch";
import { loadCastable } from "../../studio/agent/cast";
import { herClip, herPhoto } from "../../studio/photoPredicate";
import type { PostKitMedia } from "./build";

/**
 * When a row's tags were last written: every enrichment writer (services/mediaEnrichment.ts, studio/enrich/*) bumps
 * metadata_updated_at; a row never re-written falls back to when it arrived.
 */
export const TAG_TIME = sql`coalesce(${mediaAssets.metadata_updated_at}, ${mediaAssets.ingested_at})`;

export const dbPostKitMedia: PostKitMedia = {
  async search(athleteId, brief, opts) {
    const excludeBrands = opts.excludeBrands.length ? { excludeBrands: opts.excludeBrands } : {};
    const [stills, clips] = await Promise.all([
      searchMedia(athleteId, { brief, filters: { athletePresent: true, onlyHer: true, brandSafe: true, ...excludeBrands }, purpose: "hero", diverse: true, k: opts.k }),
      searchMedia(athleteId, { brief, filters: { athletePresent: true, onlyHer: true, brandSafe: true, playableVideo: true, ...excludeBrands }, purpose: "video", diverse: true, k: opts.k }),
    ]);
    const ordered = opts.clipsFirst ? [...clips, ...stills] : interleave(stills, clips);
    return [...new Set(ordered.map((r) => r.id))];
  },

  load: (athleteId, ids) => loadCastable(athleteId, ids),

  async newlyTagged(athleteId, after, limit) {
    if (limit <= 0) return [];
    const tagged = sql`${mediaAssets.metadata} -> 'vision' IS NOT NULL`;
    // To the microsecond (the column's own precision), so a cursor at a row's tag time never re-reads that row.
    const rows = await db.select({ id: mediaAssets.id, taggedAt: sql<string>`to_char((${TAG_TIME}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` }).from(mediaAssets)
      .where(and(
        or(herPhoto(athleteId, tagged), herClip(athleteId, tagged)),
        ...(after ? [sql`(${TAG_TIME}, ${mediaAssets.id}::text) > (${after.at}::timestamptz, ${after.id})`] : []),
      ))
      .orderBy(asc(TAG_TIME), asc(mediaAssets.id))
      .limit(limit);
    const loaded = await loadCastable(athleteId, rows.map((r) => r.id));
    return rows.flatMap((r) => {
      const row = loaded.get(r.id);
      return row ? [{ row, taggedAt: r.taggedAt }] : [];
    });
  },

  async urls(row) {
    return {
      thumbUrl: row.gcsPath ? await signedUrl(row.gcsPath) : null,
      videoUrl: row.videoPath ? await signedUrl(row.videoPath) : null,
    };
  },

  // The product's own music file (never hers), by the catalogue id's path. The caller (edit.ts musicView) asks only
  // for a file installed here (beds.ts musicInstalled: each catalogue's own gate).
  async trackUrl(gcsPath) {
    return signedUrl(gcsPath, BED_PREVIEW_TTL_MS);
  },
};

/** Two ranked lists, alternated (a, b, a, b …), so neither kind crowds the other out of a mixed shortlist. */
export function interleave<T>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}
