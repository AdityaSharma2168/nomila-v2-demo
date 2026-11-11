/**
 * enrichTopPostInsights — fetch richer per-post insights for an athlete's TOP posts,
 * so the media kit + content analysis have reach/saves/shares/watch-time, not just
 * likes. Targeted (top N by the metric we already have), not the whole catalog —
 * cheap (~1-2 API calls/post) and the long tail rarely matters for a media kit.
 *
 * Instagram: reach + saved + shares + total_interactions (+ views/watch-time on video).
 *   Ranked by engagement (likes+comments), since reach/views aren't known until fetched.
 * TikTok: already complete via the Display API (views/likes/comments/shares) — skipped.
 * YouTube: retention (avg view %/duration, subs gained) via the Analytics API — TODO,
 *   wire when a YouTube-active athlete exists to validate against.
 *
 * See docs/media-library-backfill.md. Best-effort: a failure skips that post, never throws.
 */
import { db } from "../db";
import { connectedAccounts, mediaAssets } from "../../shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { fetchMediaInsights } from "../lib/integrations/instagram";
import { createLogger } from "../logger";
import { openTokenFields } from "../lib/tokenCrypto";
import { ingestMediaInsights } from "../services/intelligence/social/substrate";
import { substrateWriteEnabled } from "../services/intelligence/social/config";

const logger = createLogger("enrich-top-posts");
const TOP_N = 15;

async function activeConnectionId(athleteId: string, platform: string): Promise<string | null> {
  const [row] = await db.select({ id: connectedAccounts.id }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.platform, platform), eq(connectedAccounts.status, "active")))
    .limit(1);
  return row?.id ?? null;
}

export async function enrichTopPostInsights(athleteId: string): Promise<{ enriched: number; failed: number }> {
  const connId = await activeConnectionId(athleteId, "instagram");
  if (!connId) return { enriched: 0, failed: 0 };

  // Rank by engagement (likes+comments) — the only signal we have before fetching reach/views.
  const top = await db.select().from(mediaAssets)
    .where(and(
      eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.platform, "instagram"),
      eq(mediaAssets.status, "stored"), isNull(mediaAssets.parent_media_id),
    ))
    .orderBy(sql`(coalesce(${mediaAssets.like_count}, 0) + coalesce(${mediaAssets.comments_count}, 0)) DESC`)
    .limit(TOP_N);

  let enriched = 0, failed = 0;
  let connRow: { id: string; platform_user_id: string | null; platform_username: string | null; access_token: string | null; refresh_token: string | null } | null = null;
  for (const r of top) {
    if (!r.source_media_id) continue;
    const ins = await fetchMediaInsights(connId, r.source_media_id, r.media_type).catch(() => null);
    if (!ins) { failed++; continue; }
    // Shadow write: the same metrics as content observations with an observed_at (flag-gated).
    if (substrateWriteEnabled()) {
      const conn = connRow ?? (connRow = await db.select({ id: connectedAccounts.id, platform_user_id: connectedAccounts.platform_user_id, platform_username: connectedAccounts.platform_username, access_token: connectedAccounts.access_token, refresh_token: connectedAccounts.refresh_token })
        .from(connectedAccounts).where(eq(connectedAccounts.id, connId)).limit(1).then(async (x) => (await openTokenFields(x[0])) ?? null));
      if (conn) await ingestMediaInsights({
        athleteId, connectedAccountId: conn.id, accountId: conn.platform_user_id, handle: conn.platform_username,
        mediaId: r.source_media_id, mediaType: r.media_type, postedAt: r.posted_at?.toISOString() ?? null, metrics: ins,
        secrets: [conn.access_token, conn.refresh_token].filter((t): t is string => !!t),
      });
    }
    await db.update(mediaAssets).set({
      insights:            { ...(r.insights as Record<string, unknown> ?? {}), ...ins } as any,
      metadata:            { ...(r.metadata as Record<string, unknown> ?? {}), insights_enriched_at: new Date().toISOString() } as any,
      metadata_updated_at: new Date(),
    }).where(eq(mediaAssets.id, r.id));
    enriched++;
  }
  logger.info({ athleteId, enriched, failed }, "top-post insights enriched");
  return { enriched, failed };
}

/** Daily cron entry: enrich top posts for every athlete with an active Instagram connection. */
export async function enrichAllAthletesTopPosts(): Promise<{ athletes: number }> {
  const rows = await db.selectDistinct({ id: connectedAccounts.athlete_id }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.platform, "instagram"), eq(connectedAccounts.status, "active")));
  for (const r of rows) {
    await enrichTopPostInsights(r.id).catch((e: any) => logger.warn({ athleteId: r.id, error: e?.message?.slice(0, 120) }, "top-post enrich failed"));
  }
  logger.info({ athletes: rows.length }, "top-post insights batch complete");
  return { athletes: rows.length };
}
