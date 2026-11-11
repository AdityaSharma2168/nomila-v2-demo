/**
 * collectSocialAnalytics — captures one social_analytics_snapshots row per
 * connected account.
 *
 * Pipeline per account:
 *   1. refreshTokenIfNeeded()  — TikTok access tokens are 24h; without this the
 *      pull silently returns nothing a day after connect.
 *   2. fetchAnalytics()        — best-effort; individual metric calls degrade to
 *      null rather than throwing.
 *   3. on auth failure (401/403) → mark the connection `expired` (mirrors
 *      fetchSocialData) instead of writing an empty row.
 *   4. upsert one row keyed by (connected_account_id, snapshot_day=UTC date).
 *
 * This is a DISPLAY/TREND layer: it writes ONLY to social_analytics_snapshots and
 * never touches athlete_snapshots, athletes_current, or scoring. A failure here
 * can never regress the Capital Score or DM ingestion.
 */

import { db } from "../db";
import { connectedAccounts, socialAnalyticsSnapshots } from "../../shared/schema";
import type { SocialAnalyticsSnapshot, NewSocialAnalyticsSnapshot } from "../../shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import * as instagram from "../lib/integrations/instagram";
import * as tiktok    from "../lib/integrations/tiktok";
import * as youtube   from "../lib/integrations/youtube";
import type { AnalyticsProvider } from "../lib/integrations/types";
import { createLogger } from "../logger";
import { openTokenFields } from "../lib/tokenCrypto";
import { ingestNative, runSubstrateNightly, type SyncTrigger } from "../services/intelligence/social/substrate";
import { substrateWriteEnabled } from "../services/intelligence/social/config";

const logger = createLogger("collect-social-analytics");

// Platforms wired for the analytics pipeline. Spotify can be added by
// implementing fetchAnalytics() on its module and registering it here.
const PROVIDERS: Record<string, AnalyticsProvider> = {
  instagram,
  tiktok,
  youtube,
};

const isAuthError = (msg: string | undefined): boolean =>
  !!msg && /\b(401|403)\b|unauthor|invalid.*token|token.*expired|permission/i.test(msg);

/** True for Nomila's shared IG discovery account — a lens for other accounts, never an athlete's own. */
export function isSharedDiscoveryAccount(platform: string, platformUserId: string | null): boolean {
  const disc = process.env.DISCOVERY_IG_BUSINESS_ID;
  return platform === "instagram" && !!disc && platformUserId === disc;
}

/** UTC calendar day as 'YYYY-MM-DD' — the dedup key for the unique index. */
function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Collect + persist a snapshot for one connection. Returns the stored row, or
 * null if the platform isn't supported, the token is missing/expired, or the
 * fetch failed outright.
 *
 * `trigger` is passed straight through to the substrate shadow-write below, so a sync run
 * is attributable to what caused it — 'nightly' (the default, matching the cron batch) or
 * 'connect' (the OAuth callback's own sync, see server/workflow/definitions/socialSync.ts).
 */
export async function collectSocialAnalytics(connectionId: string, trigger: SyncTrigger = "nightly"): Promise<SocialAnalyticsSnapshot | null> {
  const conn = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!conn) { logger.warn({ connectionId }, "connection not found"); return null; }

  const provider = PROVIDERS[conn.platform];
  if (!provider) { logger.info({ connectionId, platform: conn.platform }, "no analytics provider — skipping"); return null; }

  // Nomila's shared discovery IG account (DISCOVERY_IG_BUSINESS_ID) is a LENS for looking up OTHER
  // accounts' public data (server/lib/integrations/discovery.ts → source='discovery'). It must never
  // be ingested as an athlete's OWN 'connected' analytics — if it lands as a connected row (its token
  // was set up via an athlete), fetching it would overwrite that athlete's real numbers with the shared
  // account's own (e.g. 1-follower) metrics. Guard here regardless of how it was selected.
  if (isSharedDiscoveryAccount(conn.platform, conn.platform_user_id)) {
    logger.warn({ connectionId, athleteId: conn.athlete_id }, "skipping shared discovery IG account — not the athlete's own analytics");
    return null;
  }

  try {
    await provider.refreshTokenIfNeeded(connectionId);
  } catch (err: any) {
    logger.warn({ connectionId, platform: conn.platform, error: err.message?.slice(0, 100) }, "token refresh failed");
    // Don't abort — a stale-but-valid token may still work; fetch will surface a hard auth error.
  }

  // Phase A Step 1a: fetch the provider's native envelope once and project it into the display
  // contract; the projection IS the old fetchAnalytics arithmetic, so the row below is unchanged.
  let native: Awaited<ReturnType<AnalyticsProvider["fetchNative"]>> = null;
  let result;
  try {
    native = await provider.fetchNative(connectionId);
    result = native ? provider.project(native) : null;
  } catch (err: any) {
    if (isAuthError(err.message)) {
      await db.update(connectedAccounts).set({ status: "expired" }).where(eq(connectedAccounts.id, connectionId));
      logger.warn({ connectionId, platform: conn.platform }, "auth failed — marked connection expired");
    } else {
      logger.error({ connectionId, platform: conn.platform, error: err.message?.slice(0, 150) }, "fetchAnalytics threw");
    }
    return null;
  }
  if (!result) { logger.warn({ connectionId, platform: conn.platform }, "fetchAnalytics returned null (missing token?)"); return null; }

  const values: NewSocialAnalyticsSnapshot = {
    athlete_id:           conn.athlete_id,
    connected_account_id: conn.id,
    source:               "connected",
    platform:             conn.platform,
    snapshot_day:         utcDay(),
    followers:            result.followers,
    following:            result.following,
    post_count:           result.post_count,
    total_likes:          result.total_likes,
    total_channel_views:  result.total_channel_views,
    is_verified:          result.is_verified,
    reach:                result.reach,
    impressions:          result.impressions,
    profile_views:        result.profile_views,
    avg_engagement_rate:  result.avg_engagement_rate,
    avg_reach_per_post:   result.avg_reach_per_post,
    avg_views_per_post:   result.avg_views_per_post,
    avg_shares_per_post:  result.avg_shares_per_post,
    avg_saves_per_post:   result.avg_saves_per_post,
    avg_watch_time_sec:   result.avg_watch_time_sec,
    content_frequency:    result.content_frequency,
    posts_last_30d:       result.posts_last_30d,
    top_audience_country:   result.top_audience_country,
    top_audience_city:      result.top_audience_city,
    top_audience_age_range: result.top_audience_age_range,
    top_audience_gender:    result.top_audience_gender,
    raw_metrics:          result.raw_metrics,
  };

  // One row per athlete × platform × UTC day — re-running the same day overwrites.
  const [saved] = await db.insert(socialAnalyticsSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: [socialAnalyticsSnapshots.athlete_id, socialAnalyticsSnapshots.platform, socialAnalyticsSnapshots.snapshot_day],
      set: { ...values, snapshot_date: new Date() },
    })
    .returning();

  logger.info(
    { connectionId, platform: conn.platform, followers: result.followers, reach: result.reach, tools: result.toolsCalled },
    "social analytics snapshot saved",
  );

  // Shadow write into the social substrate (flag-gated; never fails the row above).
  if (native && substrateWriteEnabled()) {
    await ingestNative({
      athleteId: conn.athlete_id, native, trigger, connectedAccountId: conn.id,
      secrets: [conn.access_token, conn.refresh_token].filter((t): t is string => !!t),
    });
  }
  return saved;
}
/**
 * Batch: collect snapshots for every active connection on a supported platform.
 * Runs with bounded concurrency, staggered from inbox sync. Used by the cron.
 *
 * Then, once per athlete with at least one fresh snapshot, refresh her MEASURED memory facts (new-agent athletes only;
 * a no-op for anyone else): they are the one measured source the M.I.A. preview and the screens read, so the nightly
 * sync keeps them current for every platform it collects — not only the connect path and research. Never fatal: a
 * failed refresh leaves the last reading in place and is counted in `memorySyncFailed`. A reading that is new or moved
 * ≥ 10% asks for an M.I.A. recompute (miaPreview/preview.ts rescoreIfMoved; counted in `rescoreRequested`).
 */
export async function collectAllAnalyticsSnapshots(opts: { concurrency?: number } = {}): Promise<{ processed: number; succeeded: number; failed: number; memorySynced: number; memorySyncFailed: number; rescoreRequested: number }> {
  const concurrency = opts.concurrency ?? 4;
  const all = await db
    .select({ id: connectedAccounts.id, athleteId: connectedAccounts.athlete_id, platform: connectedAccounts.platform, puid: connectedAccounts.platform_user_id })
    .from(connectedAccounts)
    .where(and(
      inArray(connectedAccounts.platform, Object.keys(PROVIDERS)),
      eq(connectedAccounts.status, "active"),
    ));
  // Never ingest the shared discovery IG account as an athlete's own analytics (see collectSocialAnalytics).
  const rows = all.filter((r) => !isSharedDiscoveryAccount(r.platform, r.puid));

  let succeeded = 0, failed = 0;
  const collected = new Set<string>();
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((r) =>
      collectSocialAnalytics(r.id).then((s) => !!s).catch(() => false),
    ));
    results.forEach((ok, n) => { if (ok) { succeeded++; collected.add(batch[n].athleteId); } else failed++; });
  }

  // Loaded lazily: the memory layer is not needed by the collection itself.
  const { syncMemoryMeasuredFacts } = await import("../agent/research/measuredSync");
  const { rescoreIfMoved } = await import("../services/miaPreview/preview");
  let memorySynced = 0, memorySyncFailed = 0, rescoreRequested = 0;
  for (const athleteId of collected) {
    try {
      const r = await syncMemoryMeasuredFacts(athleteId);
      if (r) memorySynced++;
      if (await rescoreIfMoved(athleteId, r, "nightly_social_sync")) rescoreRequested++;
    } catch (err: any) {
      memorySyncFailed++;
      logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "measured memory sync failed after nightly collection");
    }
  }

  // The learning loop (AGENT_LEARNING_LOOP, off otherwise): link the posts just read to the plan actions they came from,
  // measure and judge them against the athlete's own usual, refresh the weekly "what works for you", and send at most one
  // message for an exceptional post. The same athletes, after their measured memory sync. Never fatal.
  const { agentLearningLoopEnabled } = await import("../agent/learning/config");
  if (agentLearningLoopEnabled() && collected.size) {
    try {
      const { runLearningLoopNightly } = await import("../agent/learning/db");
      await runLearningLoopNightly(collected);
    } catch (err: any) {
      logger.warn({ error: String(err?.message ?? err).slice(0, 200) }, "learning loop failed after nightly collection");
    }
  }

  logger.info({ processed: rows.length, succeeded, failed, memorySynced, memorySyncFailed, rescoreRequested }, "analytics batch complete");
  return { processed: rows.length, succeeded, failed, memorySynced, memorySyncFailed, rescoreRequested };
}

/**
 * Nightly substrate pass, run at the END of the 04:30 block (after discovery, backfill and
 * enrichment have written their observations): recompute every athlete's feature vector and
 * enforce raw-payload retention. Flag-gated inside; a no-op when the flag is off.
 *
 * Then the freshly derived features are written into each new-agent athlete's MEASURED memory facts (the one place the
 * M.I.A. preview reads measured data from): every athlete with an active connection on a collected platform. A no-op
 * for anyone not on the new memory; never fatal.
 */
export async function runSubstrateNightlyPass(): Promise<{ memorySynced: number; memorySyncFailed: number; rescoreRequested: number } | void> {
  if (!substrateWriteEnabled()) return;
  await runSubstrateNightly();
  const rows = await db.selectDistinct({ athleteId: connectedAccounts.athlete_id }).from(connectedAccounts)
    .where(and(inArray(connectedAccounts.platform, Object.keys(PROVIDERS)), eq(connectedAccounts.status, "active")));
  const { syncMemoryMeasuredFacts } = await import("../agent/research/measuredSync");
  const { rescoreIfMoved } = await import("../services/miaPreview/preview");
  let memorySynced = 0, memorySyncFailed = 0, rescoreRequested = 0;
  for (const { athleteId } of rows) {
    try {
      const r = await syncMemoryMeasuredFacts(athleteId);
      if (r) memorySynced++;
      if (await rescoreIfMoved(athleteId, r, "nightly_substrate_pass")) rescoreRequested++;
    } catch (err: any) {
      memorySyncFailed++;
      logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "measured memory sync failed after the nightly substrate pass");
    }
  }
  logger.info({ memorySynced, memorySyncFailed, rescoreRequested }, "measured memory sync after the nightly substrate pass");
  return { memorySynced, memorySyncFailed, rescoreRequested };
}
