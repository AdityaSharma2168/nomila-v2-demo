/**
 * social/adapters/youtube.ts — YouTubeNative (connected: Data API + Analytics API) → canonical rows.
 *
 * Channel and video metrics come from the Data API; the trailing-30-day account metrics and
 * the viewer distributions come from Analytics reports and carry the report window. Ad-revenue
 * economics are deliberately not collected (spec §28.5).
 */

import type { YouTubeNative, YouTubeDiscoveryNative, YtVideo, YtReport } from "../native";
import { isoDurationSeconds } from "../native";
import type { ContentFormat } from "../metrics";
import { type AdaptContext, type AdaptResult, type ObservationInput, type DistributionInput, type ContentInput, isoOrNull, num, pushIf } from "./types";

function reportValue(r: YtReport | undefined, column: string): number | null {
  if (!r?.rows?.[0]) return null;
  const i = r.columnHeaders.findIndex((c) => c.name === column);
  return i >= 0 ? num(r.rows[0][i]) : null;
}

function pctRows(r: YtReport | undefined): Array<{ key: string; value: number; pct: number }> {
  const rows = r?.rows ?? [];
  const total = rows.reduce((a, row) => a + (num(row[1]) ?? 0), 0) || 1;
  return rows.map((row) => { const v = num(row[1]) ?? 0; return { key: String(row[0]), value: v, pct: Math.round((v / total) * 1000) / 10 }; });
}

export function ytContentFormat(v: YtVideo): ContentFormat {
  const s = isoDurationSeconds(v.contentDetails?.duration);
  if (s === null) return "video";
  return s < 60 ? "short" : "long_form";
}

export function adaptYouTube(n: YouTubeNative, ctx: AdaptContext): AdaptResult {
  const at = ctx.observedAt;
  const obs: ObservationInput[] = [];
  const dist: DistributionInput[] = [];
  const content: ContentInput[] = [];
  const acc = { entityType: "account" as const, entityId: n.accountId, observedAt: at, payloadFamily: "channels" };

  pushIf(obs, { ...acc, metricKey: "subscribers",   unit: "count" }, n.channel.statistics?.subscriberCount);
  pushIf(obs, { ...acc, metricKey: "views_total",   unit: "count" }, n.channel.statistics?.viewCount);
  pushIf(obs, { ...acc, metricKey: "content_count", unit: "count" }, n.channel.statistics?.videoCount);

  const a = n.analytics;
  const w = { windowStart: new Date(a.reportStart).toISOString(), windowEnd: new Date(a.reportEnd).toISOString(), payloadFamily: "analytics_reports" };
  if (a.totals) {
    pushIf(obs, { ...acc, metricKey: "views_30d",             unit: "count",   ...w }, reportValue(a.totals, "views"));
    pushIf(obs, { ...acc, metricKey: "minutes_watched_30d",   unit: "count",   ...w }, reportValue(a.totals, "estimatedMinutesWatched"));
    pushIf(obs, { ...acc, metricKey: "avg_view_duration_30d", unit: "seconds", ...w }, reportValue(a.totals, "averageViewDuration"));
    pushIf(obs, { ...acc, metricKey: "avg_view_pct_30d",      unit: "percent", ...w }, reportValue(a.totals, "averageViewPercentage"));
    pushIf(obs, { ...acc, metricKey: "subs_gained_30d",       unit: "count",   ...w }, reportValue(a.totals, "subscribersGained"));
    pushIf(obs, { ...acc, metricKey: "subs_lost_30d",         unit: "count",   ...w }, reportValue(a.totals, "subscribersLost"));
  }
  for (const row of a.ageGender?.rows ?? []) {
    const age = String(row[0]).replace(/^age/, ""), gender = String(row[1]), pct = num(row[2]);
    dist.push({ dimension: "age_gender", bucket: `${age}|${gender}`, value: null, pct, basis: "viewers", observedAt: at, ...w });
  }
  for (const r of pctRows(a.countries)) dist.push({ dimension: "country",        bucket: r.key, value: r.value, pct: r.pct, basis: "views", observedAt: at, ...w });
  for (const r of pctRows(a.traffic))   dist.push({ dimension: "traffic_source", bucket: r.key, value: r.value, pct: r.pct, basis: "views", observedAt: at, ...w });
  for (const r of pctRows(a.devices))   dist.push({ dimension: "device",         bucket: r.key, value: r.value, pct: r.pct, basis: "views", observedAt: at, ...w });

  for (const v of n.videos) adaptYtVideo(v, at, obs, content, "videos");

  return {
    identity: { accountId: n.accountId, accountIdKind: "platform_id", handle: n.handle, canonicalUrl: `https://www.youtube.com/channel/${n.accountId}` },
    observations: obs, distributions: dist, content,
  };
}

export function adaptYouTubeDiscovery(n: YouTubeDiscoveryNative, ctx: AdaptContext): AdaptResult {
  const at = ctx.observedAt;
  const obs: ObservationInput[] = [];
  const content: ContentInput[] = [];
  const acc = { entityType: "account" as const, entityId: n.accountId, observedAt: at, payloadFamily: "channels" };
  pushIf(obs, { ...acc, metricKey: "subscribers",   unit: "count" }, n.channel.statistics?.subscriberCount);
  pushIf(obs, { ...acc, metricKey: "views_total",   unit: "count" }, n.channel.statistics?.viewCount);
  pushIf(obs, { ...acc, metricKey: "content_count", unit: "count" }, n.channel.statistics?.videoCount);
  for (const v of n.videos) adaptYtVideo(v, at, obs, content, "videos");
  return {
    identity: { accountId: n.accountId, accountIdKind: "platform_id", handle: n.handle, canonicalUrl: `https://www.youtube.com/channel/${n.accountId}` },
    observations: obs, distributions: [], content,
  };
}

export function adaptYtVideo(v: YtVideo, at: string, obs: ObservationInput[], content: ContentInput[], payloadFamily?: string): void {
  if (!v.id) return;
  const format = ytContentFormat(v);
  const postedAt = isoOrNull(v.snippet?.publishedAt);
  const base = { entityType: "content" as const, entityId: v.id, entityTime: postedAt, entityFormat: format, observedAt: at, payloadFamily };
  pushIf(obs, { ...base, metricKey: "view_count",     unit: "count" },   v.statistics?.viewCount);
  pushIf(obs, { ...base, metricKey: "like_count",     unit: "count" },   v.statistics?.likeCount);
  pushIf(obs, { ...base, metricKey: "comments_count", unit: "count" },   v.statistics?.commentCount);
  pushIf(obs, { ...base, metricKey: "duration_sec",   unit: "seconds" }, isoDurationSeconds(v.contentDetails?.duration));
  content.push({
    sourceMediaId: v.id, postedAt, contentFormat: format, parentMediaId: null,
    native: {
      title: v.snippet?.title ?? null, description: v.snippet?.description ?? null, duration: v.contentDetails?.duration ?? null,
      topic_categories: v.topicDetails?.topicCategories ?? [], published_at: v.snippet?.publishedAt ?? null,
    },
  });
}
