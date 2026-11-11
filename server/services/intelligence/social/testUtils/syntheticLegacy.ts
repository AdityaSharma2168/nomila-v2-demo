/**
 * syntheticLegacy.ts — a seeded, structurally faithful stand-in for one athlete's legacy rows.
 *
 * Shapes mirror what the legacy adapters read from social_analytics_snapshots.raw_metrics
 * (account, account_insights, recent_media with insights, demographics) and from media_assets
 * (counters, insights, metadata.insights_enriched_at, carousel children), but every id, handle
 * and number is generated. No real athlete, connection or platform identifier appears here, so
 * the fixture can live in the repository and run in CI.
 *
 * Deterministic for a (seed, asOf, days) triple, so the calculator's output can be pinned.
 */

import type { LegacyMediaRow, LegacySnapshotRow } from "../adapters/legacy";
import type { LegacyConnection } from "../legacyBundle";

export interface SyntheticOptions { seed?: number; asOf?: string; days?: number }
export interface SyntheticLegacy { athleteId: string; connections: LegacyConnection[]; snapshots: LegacySnapshotRow[]; media: LegacyMediaRow[] }

/** mulberry32: tiny, deterministic, good enough for fixtures. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const DAY = 86_400_000;
const IG_ID = "17840000000000001";
const IG_APP_SCOPED_ID = "34470000000000001";   // Instagram Login's second id for the same account
const TT_ID = "tt-open-id-synthetic-0001";
const HANDLE = "synthetic_athlete";
const ATHLETE = "00000000-0000-4000-8000-000000000001";

export function syntheticLegacy(opts: SyntheticOptions = {}): SyntheticLegacy {
  const rnd = prng(opts.seed ?? 7);
  const asOf = new Date(opts.asOf ?? "2026-09-09T00:00:00.000Z").getTime();
  const days = opts.days ?? 45;
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const iso = (t: number) => new Date(t).toISOString();

  // ── Instagram posts: 30 items over ~150 days, 6 of them carousels with 1 child each ──
  const igPosts = Array.from({ length: 30 }, (_, i) => {
    const postedAt = asOf - int(1, 150) * DAY - int(0, 23) * 3_600_000;
    const type = i % 5 === 0 ? "CAROUSEL_ALBUM" : i % 3 === 0 ? "VIDEO" : "IMAGE";
    const baseLikes = int(150, 2500), baseComments = int(3, 90), reach = int(3000, 60000);
    return { id: `1800000000000${String(i).padStart(4, "0")}`, type, product: type === "VIDEO" ? "REELS" : "FEED", postedAt, baseLikes, baseComments, reach, saved: int(5, 120), shares: int(2, 80), views: type === "VIDEO" ? int(4000, 90000) : null };
  }).sort((a, b) => a.postedAt - b.postedAt);

  // ── TikTok videos: 12 items over ~120 days ──
  const ttVideos = Array.from({ length: 12 }, (_, i) => ({ id: `7${String(200000000000000000 + i * 7919)}`, postedAt: asOf - int(2, 120) * DAY, baseLikes: int(80, 4000), baseComments: int(2, 60), views: int(2000, 120000), shares: int(1, 200) })).sort((a, b) => a.postedAt - b.postedAt);

  // Counters drift upward with the item's age at observation time, like real re-fetched counts.
  const grown = (base: number, postedAt: number, at: number, rate: number) => Math.round(base * (1 + Math.min(0.35, Math.max(0, (at - postedAt) / DAY) * rate)));

  const snapshots: LegacySnapshotRow[] = [];
  let igFollowers = 18_000, ttFollowers = 9_000;
  for (let d = days - 1; d >= 0; d--) {
    const at = asOf - d * DAY + 4 * 3_600_000;              // 04:00Z nightly
    igFollowers += int(-15, 40); ttFollowers += int(-10, 25);
    const recent = igPosts.filter((p) => p.postedAt <= at).slice(-25).map((p) => ({
      id: p.id, media_type: p.type, media_product_type: p.product, timestamp: iso(p.postedAt), permalink: `https://www.instagram.com/p/synthetic_${p.id.slice(-4)}/`, caption: null, media_url: null, thumbnail_url: null,
      like_count: grown(p.baseLikes, p.postedAt, at, 0.002), comments_count: grown(p.baseComments, p.postedAt, at, 0.001),
      insights: { reach: grown(p.reach, p.postedAt, at, 0.003), saved: p.saved, shares: p.shares, total_interactions: grown(p.baseLikes + p.baseComments + p.saved + p.shares, p.postedAt, at, 0.002), ...(p.views != null ? { video_views: grown(p.views, p.postedAt, at, 0.004) } : {}) },
    }));
    const geo = [["US", 61], ["CA", 9], ["GB", 6], ["AU", 4], ["DE", 3]] as const;
    snapshots.push({
      id: `snap-ig-${d}`, athlete_id: ATHLETE, platform: "instagram", source: "connected", connected_account_id: "conn-ig-synthetic", snapshot_date: iso(at),
      followers: igFollowers, following: 410, post_count: igPosts.filter((p) => p.postedAt <= at).length + 90, total_likes: null, total_channel_views: null, is_verified: null,
      reach: int(1500, 9000), impressions: int(2500, 15000), profile_views: int(20, 200), avg_watch_time_sec: null,
      raw_metrics: {
        account: { id: d >= days - 5 ? IG_APP_SCOPED_ID : IG_ID, username: HANDLE, followers_count: igFollowers, follows_count: 410 },
        account_insights: { reach: int(1500, 9000), views: int(2500, 15000), profile_links_taps: int(2, 30) },
        recent_media: recent,
        demographics: {
          country: geo.map(([key, pct]) => ({ key, pct, value: Math.round((igFollowers * pct) / 100) })),
          city: [["Springfield", 8], ["Riverton", 6], ["Lakeside", 5]].map(([key, pct]) => ({ key, pct, value: Math.round((igFollowers * Number(pct)) / 100) })),
          age: [["13-17", 6], ["18-24", 31], ["25-34", 27], ["35-44", 18], ["45-54", 11], ["55-64", 5], ["65+", 2]].map(([key, pct]) => ({ key, pct, value: Math.round((igFollowers * Number(pct)) / 100) })),
          gender: [["F", 44], ["M", 38], ["U", 18]].map(([key, pct]) => ({ key, pct, value: Math.round((igFollowers * Number(pct)) / 100) })),
        },
      },
    });
    snapshots.push({
      id: `snap-tt-${d}`, athlete_id: ATHLETE, platform: "tiktok", source: "connected", connected_account_id: "conn-tt-synthetic", snapshot_date: iso(at),
      followers: ttFollowers, following: 120, post_count: ttVideos.filter((v) => v.postedAt <= at).length + 40, total_likes: int(150_000, 400_000), total_channel_views: null, is_verified: false,
      reach: null, impressions: null, profile_views: null, avg_watch_time_sec: null,
      raw_metrics: {
        account: { open_id: TT_ID, username: HANDLE, follower_count: ttFollowers },
        recent_media: ttVideos.filter((v) => v.postedAt <= at).slice(-20).map((v) => ({ id: v.id, media_type: "VIDEO", timestamp: iso(v.postedAt), permalink: `https://www.tiktok.com/@${HANDLE}/video/${v.id}`, like_count: grown(v.baseLikes, v.postedAt, at, 0.002), comments_count: v.baseComments, insights: { video_views: grown(v.views, v.postedAt, at, 0.003), shares: v.shares } })),
        demographics: { country: geo.map(([key, pct]) => ({ key, pct, value: null })), gender: [["F", 52], ["M", 40], ["U", 8]].map(([key, pct]) => ({ key, pct, value: null })), age: [["18-24", 40], ["25-34", 33], ["35+", 27]].map(([key, pct]) => ({ key, pct, value: null })) },
      },
    });
  }
  // A discovery row keyed by handle only (the same account seen publicly) and a research row.
  const discAt = asOf - 20 * DAY;
  snapshots.push({ id: "snap-ig-disc", athlete_id: ATHLETE, platform: "instagram", source: "discovery", connected_account_id: null, snapshot_date: iso(discAt), followers: 17_950, following: null, post_count: 118, total_likes: null, total_channel_views: null, is_verified: null, reach: null, impressions: null, profile_views: null, avg_watch_time_sec: null,
    raw_metrics: { account: { username: HANDLE }, recent_media: igPosts.filter((p) => p.postedAt <= discAt).slice(-10).map((p) => ({ id: p.id, media_type: p.type, timestamp: iso(p.postedAt), like_count: p.baseLikes, comments_count: p.baseComments })) } });
  snapshots.push({ id: "snap-tt-research", athlete_id: ATHLETE, platform: "tiktok", source: "research", connected_account_id: null, snapshot_date: iso(asOf - 60 * DAY), followers: 8_700, following: null, post_count: null, total_likes: null, total_channel_views: null, is_verified: null, reach: null, impressions: null, profile_views: null, avg_watch_time_sec: null,
    raw_metrics: { account: { username: HANDLE } } });

  // ── media_assets rows: the durable library, with enriched insights on most posts ──
  const media: LegacyMediaRow[] = [];
  const refreshedAt = iso(asOf - DAY + 5 * 3_600_000);
  igPosts.forEach((p, i) => {
    const enriched = i % 4 !== 3;
    media.push({ id: `ma-ig-${i}`, athlete_id: ATHLETE, platform: "instagram", origin: "connected", source_media_id: p.id, parent_media_id: null, media_type: p.type, permalink: `https://www.instagram.com/p/synthetic_${p.id.slice(-4)}/`, posted_at: iso(p.postedAt),
      like_count: grown(p.baseLikes, p.postedAt, asOf - DAY, 0.002), comments_count: grown(p.baseComments, p.postedAt, asOf - DAY, 0.001),
      insights: enriched ? { reach: grown(p.reach, p.postedAt, asOf - DAY, 0.003), saved: p.saved, shares: p.shares, total_interactions: p.baseLikes + p.baseComments + p.saved + p.shares, ...(p.views != null ? { video_views: grown(p.views, p.postedAt, asOf - DAY, 0.004), ig_reels_avg_watch_time: int(3000, 12000) } : {}) } : null,
      metadata: enriched ? { insights_enriched_at: iso(asOf - 2 * DAY) } : {}, metadata_updated_at: refreshedAt, ingested_at: iso(p.postedAt + DAY) });
    if (p.type === "CAROUSEL_ALBUM") media.push({ id: `ma-ig-${i}-c`, athlete_id: ATHLETE, platform: "instagram", origin: "connected", source_media_id: `${p.id}9`, parent_media_id: `ma-ig-${i}`, media_type: "CAROUSEL_CHILD", permalink: null, posted_at: iso(p.postedAt), like_count: null, comments_count: null, insights: null, metadata: {}, metadata_updated_at: refreshedAt, ingested_at: iso(p.postedAt + DAY) });
  });
  ttVideos.forEach((v, i) => media.push({ id: `ma-tt-${i}`, athlete_id: ATHLETE, platform: "tiktok", origin: "connected", source_media_id: v.id, parent_media_id: null, media_type: "VIDEO", permalink: `https://www.tiktok.com/@${HANDLE}/video/${v.id}`, posted_at: iso(v.postedAt), like_count: grown(v.baseLikes, v.postedAt, asOf - DAY, 0.002), comments_count: v.baseComments, insights: { video_views: grown(v.views, v.postedAt, asOf - DAY, 0.003), shares: v.shares }, metadata: {}, metadata_updated_at: refreshedAt, ingested_at: iso(v.postedAt + DAY) }));

  return {
    athleteId: ATHLETE,
    connections: [{ id: "conn-ig-synthetic", platform: "instagram", platform_user_id: IG_ID, platform_username: HANDLE }, { id: "conn-tt-synthetic", platform: "tiktok", platform_user_id: TT_ID, platform_username: HANDLE }],
    snapshots, media,
  };
}
