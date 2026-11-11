/**
 * collectDiscoveryAnalytics.ts — write source='discovery' analytics rows for
 * athletes with a public handle but NO active connection on that platform.
 *
 * Feeds unconnected / pre-signup athletes into scoring and powers the rate-model
 * calibration harvest. Connected platforms are skipped (connected > discovery),
 * so this never clobbers verified OAuth data — with one narrow exception: for a
 * CONNECTED Instagram account the same public lookup is made for the connected
 * handle ONLY to keep its bio (Instagram Login exposes none). Nothing else from that
 * lookup is written; the bio is stored platform_public (ingestDiscoveryBio).
 *
 * NOTE: not yet wired to a cron. Discovery rows land in social_analytics_snapshots
 * but scoring won't correctly prefer/label them until the precedence resolver
 * (next milestone) is in. Trigger manually via /api/internal/discovery-collect-cron.
 */

import { db } from "../db";
import { athletes, athleteSnapshots, connectedAccounts, socialAnalyticsSnapshots } from "../../shared/schema";
import type { NewSocialAnalyticsSnapshot } from "../../shared/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { fetchInstagramDiscovery, fetchYouTubeDiscovery, type DiscoveryFetch } from "../lib/integrations/discovery";
import { createLogger } from "../logger";
import { ingestDiscoveryBio, ingestNative } from "../services/intelligence/social/substrate";
import { substrateWriteEnabled } from "../services/intelligence/social/config";
import { scoringSnapshotsOf } from "../lib/snapshotRows";
import type { InstagramDiscoveryNative } from "../services/intelligence/social/native";
import { syncPublicMeasuredFacts } from "../agent/research/publicPlatform";

const logger = createLogger("discovery-collect");

type Plat = "instagram" | "youtube";
const PLATFORMS: Plat[] = ["instagram", "youtube"];

function utcDay(): string { return new Date().toISOString().slice(0, 10); }

/** Which public accounts to look up: athletes.socials, else the latest blob's social_handles. */
export async function resolveHandles(athleteId: string, socials: Record<string, string>): Promise<Record<Plat, string | null>> {
  return resolveHandlesLegacy(athleteId, socials);
}

/** athletes.socials (user-provided) preferred; fall back to latest research handles. Pre-2d body, byte for byte. */
async function resolveHandlesLegacy(athleteId: string, socials: Record<string, string>): Promise<Record<Plat, string | null>> {
  let ig = socials.instagram ?? null;
  let yt = socials.youtube ?? null;
  if (!ig || !yt) {
    const [snap] = await db.select({ research: athleteSnapshots.research })
      .from(athleteSnapshots).where(scoringSnapshotsOf(athleteId))
      .orderBy(desc(athleteSnapshots.created_at)).limit(1);
    const h = ((snap?.research as any)?.social_handles ?? {}) as Record<string, string | null>;
    ig = ig ?? h.instagram ?? null;
    yt = yt ?? h.youtube ?? null;
  }
  return { instagram: ig, youtube: yt };
}

export interface DiscoveryRowResult {
  athleteId: string;
  platform:  Plat;
  status:    "written" | "not_found" | "skipped" | "failed";
  followers?: number | null;
  error?:    string | null;
  /** Connected Instagram only: the public bio lookup's outcome (null when the substrate flag is off). */
  bio?:      "stored" | "unchanged" | "none" | "failed" | null;
}

const discoverySecrets = () => [process.env.DISCOVERY_IG_TOKEN, process.env.IG_PAGE_ACCESS_TOKEN, process.env.YOUTUBE_DATA_API_KEY].filter((t): t is string => !!t);

/** Connected Instagram: the public Business Discovery lookup for the connected handle, kept for its bio only. */
async function connectedInstagramBio(athleteId: string, conn: { id: string; handle: string | null; puid: string | null } | undefined): Promise<DiscoveryRowResult["bio"]> {
  if (!conn?.handle || !substrateWriteEnabled()) return null;
  const disc = process.env.DISCOVERY_IG_BUSINESS_ID;
  if (disc && conn.puid === disc) return null;   // Nomila's shared discovery account is never an athlete's own
  const fetched = await fetchInstagramDiscovery(conn.handle);
  const native = fetched.found ? fetched.native : undefined;
  if (!native || native.sourceMethod !== "meta_business_discovery") return "none";
  return ingestDiscoveryBio({ athleteId, native: native as InstagramDiscoveryNative, connectedAccountId: conn.id, secrets: discoverySecrets() });
}

/**
 * ONE public lookup for one handle the athlete just confirmed, stored as the nightly collection stores it — the
 * registered entry point the confirm step (agent/research/publicPlatform.ts) calls, so no new acquisition path exists.
 */
export async function discoverConfirmedHandle(athleteId: string, platform: Plat, handle: string): Promise<DiscoveryRowResult> {
  const fetched = platform === "instagram" ? await fetchInstagramDiscovery(handle) : await fetchYouTubeDiscovery(handle);
  return writeDiscoveryRow(athleteId, platform, fetched);
}

async function writeDiscoveryRow(athleteId: string, platform: Plat, fetched: DiscoveryFetch): Promise<DiscoveryRowResult> {
  if (!fetched.found || !fetched.result) {
    const soft = fetched.error === "not_found" || fetched.error === "not_business_account";
    return { athleteId, platform, status: soft ? "not_found" : "failed", error: fetched.error };
  }
  const r = fetched.result;
  const values: NewSocialAnalyticsSnapshot = {
    athlete_id:           athleteId,
    connected_account_id: null,
    source:               "discovery",
    platform,
    snapshot_day:         utcDay(),
    followers:            r.followers,
    following:            r.following,
    post_count:           r.post_count,
    total_likes:          r.total_likes,
    total_channel_views:  r.total_channel_views,
    is_verified:          r.is_verified,
    reach:                r.reach,
    impressions:          r.impressions,
    profile_views:        r.profile_views,
    avg_engagement_rate:  r.avg_engagement_rate,
    avg_reach_per_post:   r.avg_reach_per_post,
    avg_views_per_post:   r.avg_views_per_post,
    avg_shares_per_post:  r.avg_shares_per_post,
    avg_saves_per_post:   r.avg_saves_per_post,
    avg_watch_time_sec:   r.avg_watch_time_sec,
    content_frequency:    r.content_frequency,
    posts_last_30d:       r.posts_last_30d,
    top_audience_country:   r.top_audience_country,
    top_audience_city:      r.top_audience_city,
    top_audience_age_range: r.top_audience_age_range,
    top_audience_gender:    r.top_audience_gender,
    raw_metrics:          r.raw_metrics,
  };
  await db.insert(socialAnalyticsSnapshots).values(values)
    .onConflictDoUpdate({
      target: [socialAnalyticsSnapshots.athlete_id, socialAnalyticsSnapshots.platform, socialAnalyticsSnapshots.snapshot_day],
      set: { ...values, snapshot_date: new Date() },
    });
  // Shadow write into the social substrate (flag-gated; public evidence, never fails the row above).
  if (fetched.native && substrateWriteEnabled()) {
    await ingestNative({
      athleteId, native: fetched.native, trigger: "discovery", connectedAccountId: null,
      secrets: discoverySecrets(),
    });
  }
  return { athleteId, platform, status: "written", followers: r.followers };
}

export async function collectDiscoveryForAthlete(
  athleteId: string,
  socials: Record<string, string>,
  opts: { dryRun?: boolean } = {},
): Promise<DiscoveryRowResult[]> {
  const handles = await resolveHandles(athleteId, socials);
  const conns = await db.select({ id: connectedAccounts.id, platform: connectedAccounts.platform, handle: connectedAccounts.platform_username, puid: connectedAccounts.platform_user_id })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active")));
  const connected = new Set(conns.map((c) => c.platform));

  const out: DiscoveryRowResult[] = [];
  for (const platform of PLATFORMS) {
    const handle = handles[platform];
    if (!handle)                 continue;                                                      // no handle → nothing to discover
    if (connected.has(platform)) {
      const row: DiscoveryRowResult = { athleteId, platform, status: "skipped", error: "connected" };
      if (platform === "instagram" && !opts.dryRun) {
        const c = conns.find((x) => x.platform === "instagram");
        row.bio = await connectedInstagramBio(athleteId, c)
          .catch((e: any) => { logger.warn({ athleteId, error: e.message?.slice(0, 120) }, "connected instagram bio lookup failed"); return "failed" as const; });
      }
      out.push(row); continue;
    }
    if (opts.dryRun)             { out.push({ athleteId, platform, status: "skipped", error: "dryRun", followers: null }); continue; }
    const fetched = platform === "instagram" ? await fetchInstagramDiscovery(handle) : await fetchYouTubeDiscovery(handle);
    out.push(await writeDiscoveryRow(athleteId, platform, fetched));
  }
  // A new public reading for a handle she CONFIRMED becomes a public-platform measured fact in memory (no-op for a
  // handle she has not confirmed, or an athlete without memory facts). Never fails the collection.
  if (out.some((r) => r.status === "written")) {
    const [a] = await db.select({ name: athletes.full_name }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    const synced = await syncPublicMeasuredFacts(athleteId, a?.name ?? "Athlete")
      .catch((e: any) => { logger.warn({ athleteId, error: String(e?.message ?? e).slice(0, 120) }, "public measured facts sync failed"); return null; });
    // A public reading that is new or moved ≥ 10% asks for an M.I.A. recompute (debounced, digest-skipped; never throws).
    const { rescoreIfMoved } = await import("../services/miaPreview/preview");
    await rescoreIfMoved(athleteId, synced, "nightly_discovery");
  }
  return out;
}

export async function collectAllDiscoveryAnalytics(
  opts: { dryRun?: boolean } = {},
): Promise<{ athletes: number; written: number; notFound: number; skipped: number; failed: number; results: DiscoveryRowResult[] }> {
  const roster = await db.select({ id: athletes.id, socials: athletes.socials })
    .from(athletes).where(inArray(athletes.status, ["raw", "enriched", "claimed", "active"]));

  const results: DiscoveryRowResult[] = [];
  for (const a of roster) {
    const rs = await collectDiscoveryForAthlete(a.id, (a.socials ?? {}) as Record<string, string>, opts)
      .catch((e: any) => {
        logger.error({ athleteId: a.id, error: e.message?.slice(0, 120) }, "discovery for athlete failed");
        return [] as DiscoveryRowResult[];
      });
    results.push(...rs);
  }
  const written  = results.filter((r) => r.status === "written").length;
  const notFound = results.filter((r) => r.status === "not_found").length;
  const skipped  = results.filter((r) => r.status === "skipped").length;
  const failed   = results.filter((r) => r.status === "failed").length;
  logger.info({ athletes: roster.length, written, notFound, skipped, failed, dryRun: opts.dryRun }, "collectAllDiscoveryAnalytics complete");
  return { athletes: roster.length, written, notFound, skipped, failed, results };
}
