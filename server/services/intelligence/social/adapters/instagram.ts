/**
 * social/adapters/instagram.ts — InstagramNative (connected, Instagram Login) → canonical rows.
 *
 * Preserves per-media reach / saved / shares / total_interactions, media_product_type,
 * is_shared_to_feed and carousel structure (spec §28.5). The "discovery reel" rule is NOT
 * applied here: it is an inferred feature (non_follower_reach_share) computed later from
 * observations, never a fact recorded at ingestion (§28.7).
 */

import type { InstagramNative, IgMediaNode, InstagramStoriesNative, IgStoryInsightsNative } from "../native";
import { igBreakdown, igMetricValue } from "../native";
import type { ContentFormat } from "../metrics";
import { type AdaptContext, type AdaptResult, type ObservationInput, type DistributionInput, type ContentInput, dayWindow, daysWindow, isoOrNull, pushIf } from "./types";

export function igContentFormat(m: { media_type?: string; media_product_type?: string }): ContentFormat {
  const t = (m.media_type ?? "").toUpperCase();
  const p = (m.media_product_type ?? "").toUpperCase();
  if (t === "CAROUSEL_ALBUM") return "carousel";
  if (t === "CAROUSEL_CHILD") return "carousel_frame";
  if (t === "REELS" || p === "REELS") return "reel";
  if (p === "STORY") return "story";
  if (t === "VIDEO") return "video";
  return "post";
}

export function adaptInstagram(n: InstagramNative, ctx: AdaptContext): AdaptResult {
  const at = ctx.observedAt;
  const obs: ObservationInput[] = [];
  const dist: DistributionInput[] = [];
  const content: ContentInput[] = [];
  const accountEntity = { entityType: "account" as const, entityId: n.accountId, observedAt: at, payloadFamily: "profile" };

  // ── account, point in time ─────────────────────────────────────────────────
  pushIf(obs, { ...accountEntity, metricKey: "followers",     unit: "count" }, n.profile.followers_count);
  pushIf(obs, { ...accountEntity, metricKey: "following",     unit: "count" }, n.profile.follows_count);
  pushIf(obs, { ...accountEntity, metricKey: "content_count", unit: "count" }, n.profile.media_count);

  // ── account insights, period=day ──────────────────────────────────────────
  if (n.accountInsights?.data) {
    const w = { ...dayWindow(at), payloadFamily: "account_insights" };
    pushIf(obs, { ...accountEntity, metricKey: "account_reach",     unit: "count", ...w }, igMetricValue(n.accountInsights.data, "reach"));
    pushIf(obs, { ...accountEntity, metricKey: "account_views",     unit: "count", ...w }, igMetricValue(n.accountInsights.data, "views"));
    pushIf(obs, { ...accountEntity, metricKey: "profile_link_taps", unit: "count", ...w }, igMetricValue(n.accountInsights.data, "profile_links_taps"));
  }

  // ── media ──────────────────────────────────────────────────────────────────
  for (const m of n.media) adaptMedia(m, at, obs, content, "media");

  // ── follower demographics (timeframe last_30_days) ─────────────────────────
  const w30 = daysWindow(at, 30);
  for (const dim of ["country", "city", "age", "gender"] as const) {
    for (const r of n.demographics[dim] ?? []) {
      dist.push({ dimension: dim, bucket: String(r.key), value: r.value ?? null, pct: r.pct ?? null, basis: "followers", observedAt: at, ...w30, payloadFamily: "demographics" });
    }
  }

  return {
    identity: { accountId: n.accountId, accountIdKind: "platform_id", handle: n.handle, canonicalUrl: n.handle ? `https://www.instagram.com/${n.handle.replace(/^@/, "")}/` : null },
    observations: obs, distributions: dist, content,
  };
}

/** One media node → content facts + point-in-time observations. Shared with the backfill page adapter. */
export function adaptMedia(m: IgMediaNode, at: string, obs: ObservationInput[], content: ContentInput[], payloadFamily?: string): void {
  if (!m.id) return;
  const format = igContentFormat(m);
  const postedAt = isoOrNull(m.timestamp);
  const base = { entityType: "content" as const, entityId: m.id, entityTime: postedAt, entityFormat: format, observedAt: at, payloadFamily };
  pushIf(obs, { ...base, metricKey: "like_count",     unit: "count" }, m.like_count);
  pushIf(obs, { ...base, metricKey: "comments_count", unit: "count" }, m.comments_count);
  const ins = m.insights?.data;
  if (ins) {
    pushIf(obs, { ...base, metricKey: "reach",              unit: "count" }, igMetricValue(ins, "reach"));
    pushIf(obs, { ...base, metricKey: "save_count",         unit: "count" }, igMetricValue(ins, "saved"));
    pushIf(obs, { ...base, metricKey: "share_count",        unit: "count" }, igMetricValue(ins, "shares"));
    pushIf(obs, { ...base, metricKey: "total_interactions", unit: "count" }, igMetricValue(ins, "total_interactions"));
    pushIf(obs, { ...base, metricKey: "view_count",         unit: "count" }, igMetricValue(ins, "views"));
    const wt = igMetricValue(ins, "ig_reels_avg_watch_time");
    if (wt !== null) pushIf(obs, { ...base, metricKey: "avg_watch_time_sec", unit: "seconds" }, wt / 1000);
  }
  content.push({
    sourceMediaId: m.id, postedAt, contentFormat: format, parentMediaId: null,
    native: {
      media_type: m.media_type ?? null, media_product_type: m.media_product_type ?? null,
      is_shared_to_feed: m.is_shared_to_feed ?? null, permalink: m.permalink ?? null, timestamp: m.timestamp ?? null,
      children: (m.children?.data ?? []).map((c) => ({ id: c.id, media_type: c.media_type ?? null })),
    },
  });
}

// ─── Instagram Stories (Step 1b): observations only, entity_format = story ───

const STORY_MAIN: Array<[string, import("../metrics").MetricKey]> = [
  ["reach", "reach"], ["views", "view_count"], ["replies", "reply_count"], ["shares", "share_count"], ["total_interactions", "total_interactions"],
  ["profile_visits", "profile_visits"], ["follows", "follows"], ["link_clicks", "link_clicks"], ["reposts", "reposts"], ["facebook_views", "facebook_views"],
];
const STORY_NAV: Record<string, import("../metrics").MetricKey> = { SWIPE_FORWARD: "story_nav_swipe_forward", TAP_BACK: "story_nav_tap_back", TAP_EXIT: "story_nav_tap_exit", TAP_FORWARD: "story_nav_tap_forward" };
const STORY_PROFILE: Record<string, import("../metrics").MetricKey> = { BIO_LINK_CLICKED: "story_profile_activity_bio_link_clicked", CALL: "story_profile_activity_call", DIRECTION: "story_profile_activity_direction", EMAIL: "story_profile_activity_email", OTHER: "story_profile_activity_other", TEXT: "story_profile_activity_text" };

/** The listing → one `listed = 1` presence observation per live Story. No content rows: Story media never enters media_assets. */
export function adaptStories(n: InstagramStoriesNative, ctx: AdaptContext): AdaptResult {
  const obs: ObservationInput[] = [];
  for (const s of n.stories) {
    if (!s?.id) continue;
    obs.push({ entityType: "content", entityId: String(s.id), entityTime: isoOrNull(s.timestamp), entityFormat: "story", metricKey: "listed", value: 1, unit: "count", observedAt: ctx.observedAt, payloadFamily: "stories_list" });
  }
  return { identity: { accountId: n.accountId, accountIdKind: "platform_id", handle: n.handle, canonicalUrl: n.handle ? `https://www.instagram.com/${n.handle.replace(/^@/, "")}/` : null }, observations: obs, distributions: [], content: [] };
}

/** One Story's three insight sub-responses → observations, each naming the payload family it came from. */
export function adaptStoryInsights(n: IgStoryInsightsNative, obs: ObservationInput[]): void {
  const base = { entityType: "content" as const, entityId: String(n.storyId), entityTime: isoOrNull(n.story.timestamp), entityFormat: "story" as const, observedAt: n.fetchedAt };
  const ins = n.insights?.data;
  if (ins) for (const [provider, key] of STORY_MAIN) pushIf(obs, { ...base, metricKey: key, unit: "count", payloadFamily: "story_insights" }, igMetricValue(ins, provider));
  for (const [dim, key] of Object.entries(STORY_NAV)) pushIf(obs, { ...base, metricKey: key, unit: "count", payloadFamily: "story_navigation" }, igBreakdown(n.navigation?.data, "navigation")[dim]);
  for (const [dim, key] of Object.entries(STORY_PROFILE)) pushIf(obs, { ...base, metricKey: key, unit: "count", payloadFamily: "story_profile_activity" }, igBreakdown(n.profileActivity?.data, "profile_activity")[dim]);
}
