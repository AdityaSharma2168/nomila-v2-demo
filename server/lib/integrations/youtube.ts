/**
 * YouTube direct integration — Google OAuth 2.0 + YouTube Data API v3.
 * Access token: 1hr. Refresh token: indefinite (revoked by user).
 */

import { db } from "../../db";
import { connectedAccounts } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import { createLogger } from "../../logger";
import { apiBaseUrl } from "../baseUrls";
import { signOAuthState } from "../oauthState";
import type { SnapshotSocialPlatform } from "../../services/snapshotSocial";
import type { ActivatedConnection, SocialAnalyticsResult } from "./types";
import type { SocialAnalyticsRaw } from "../../../shared/schema";
import type { YouTubeNative, YtVideo } from "../../services/intelligence/social/native";
import { openTokenFields, sealTokenFields } from "../tokenCrypto";
import { activateConnection, MissingAccountIdError } from "./activateConnection";

const logger = createLogger("integrations/youtube");

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID?.trim();
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET_WEB?.trim();
const API_BASE      = apiBaseUrl();
const REDIRECT      = `${API_BASE}/api/v1/auth/callback/youtube`;
const YT_API        = "https://www.googleapis.com/youtube/v3";
const YT_ANALYTICS  = "https://youtubeanalytics.googleapis.com/v2/reports";
const TOKEN_URL     = "https://oauth2.googleapis.com/token";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
].join(" ");

async function googleRefresh(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google credentials not configured");
  const res  = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
  });
  const data = await res.json() as any;
  if (!res.ok || data.error) throw new Error(`Google token refresh failed: ${data.error_description ?? data.error}`);
  return data;
}

async function ytGet<T>(path: string, token: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${YT_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res  = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json() as any;
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `YouTube API ${res.status}`);
  return json as T;
}

export function getAuthUrl(athleteId: string, _alias?: string, _loginHint?: string, clientPlatform?: string): string {
  if (!CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID not set");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id",     CLIENT_ID);
  url.searchParams.set("redirect_uri",  REDIRECT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope",         SCOPES);
  url.searchParams.set("access_type",   "offline");
  url.searchParams.set("prompt",        "consent");
  // Signed, expiring state (CSRF protection). See server/lib/oauthState.ts.
  url.searchParams.set("state", signOAuthState(athleteId, undefined, clientPlatform));
  return url.toString();
}

export async function handleCallback(code: string, athleteId: string): Promise<ActivatedConnection> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Google credentials not configured");

  const res  = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: REDIRECT }).toString(),
  });
  const data = await res.json() as any;
  if (!res.ok || data.error) throw new Error(`YouTube token exchange failed: ${data.error_description ?? data.error}`);

  // The channel id is the connection's identity. ytGet throws on a failed fetch; a Google account with
  // no channel returns no items — either way the connect fails rather than writing a row with a null id.
  const channelRes = await ytGet<any>("/channels", data.access_token, { part: "snippet,statistics", mine: "true" });
  const channel    = channelRes?.items?.[0];
  if (!channel?.id) {
    logger.error({ athleteId }, "YouTube connect: no channel on this account — no account id");
    throw new MissingAccountIdError("youtube");
  }

  const activated = await activateConnection({
    athleteId,
    platform:         "youtube",
    platformUserId:   String(channel.id),
    platformUsername: channel.snippet?.customUrl ?? channel.snippet?.title ?? null,
    accessToken:      data.access_token,
    refreshToken:     data.refresh_token ?? null,
    tokenExpiresAt:   data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    scopes:           typeof data.scope === "string" && data.scope.trim() ? data.scope : SCOPES,   // granted, not requested
  });

  logger.info({ athleteId, channelId: channel.id, connectionId: activated.connectionId, reactivated: activated.reactivated }, "YouTube connected");
  return activated;
}

export async function refreshTokenIfNeeded(connectionId: string): Promise<string> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) throw new Error("YouTube token not found");

  if (row.token_expires_at && (row.token_expires_at.getTime() - Date.now()) > 5 * 60_000) {
    return row.access_token;
  }
  if (!row.refresh_token) throw new Error("No YouTube refresh token — user must reconnect");

  const fresh = await googleRefresh(row.refresh_token);
  await db.update(connectedAccounts).set(await sealTokenFields({
    access_token:     fresh.access_token,
    token_expires_at: new Date(Date.now() + fresh.expires_in * 1000),
  })).where(eq(connectedAccounts.id, connectionId));

  logger.info({ connectionId }, "YouTube token refreshed");
  return fresh.access_token;
}

export async function fetchForScoring(connectionId: string): Promise<{
  platform: SnapshotSocialPlatform;
  toolsCalled: string[];
} | null> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) return null;

  const token = await refreshTokenIfNeeded(connectionId);
  const toolsCalled: string[] = [];

  // Channel stats
  const chanRes = await ytGet<any>("/channels", token, { part: "snippet,statistics", mine: "true" });
  toolsCalled.push("youtube_channels");

  const channel   = chanRes?.items?.[0];
  if (!channel) return null;

  const subs       = parseInt(channel.statistics?.subscriberCount  ?? "0", 10) || 0;
  const totalViews = parseInt(channel.statistics?.viewCount        ?? "0", 10) || 0;
  const vidCount   = parseInt(channel.statistics?.videoCount       ?? "0", 10) || 0;
  const handle     = channel.snippet?.customUrl
    ? (channel.snippet.customUrl.startsWith("@") ? channel.snippet.customUrl : `@${channel.snippet.customUrl}`)
    : undefined;

  if (!subs) {
    return { toolsCalled, platform: { handle, subscribers: 0, fetched_at: new Date().toISOString(), source: "connected" } };
  }

  // Recent videos (last 10)
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  let postsLast30d = 0, totalLikes = 0, totalComments = 0, videoViews = 0, videoCount = 0;
  let shortFormCount = 0;
  const topicSet = new Set<string>();

  try {
    const searchRes = await ytGet<any>("/search", token, {
      part:       "id",
      channelId:  channel.id,
      type:       "video",
      order:      "date",
      maxResults: "10",
    });
    toolsCalled.push("youtube_search");

    const ids = (searchRes?.items ?? []).map((i: any) => i.id?.videoId).filter(Boolean).join(",");
    if (ids) {
      const vidsRes = await ytGet<any>("/videos", token, { part: "statistics,contentDetails,topicDetails,snippet", id: ids });
      toolsCalled.push("youtube_videos");

      for (const v of vidsRes?.items ?? []) {
        videoCount++;
        videoViews    += parseInt(v.statistics?.viewCount    ?? "0", 10) || 0;
        totalLikes    += parseInt(v.statistics?.likeCount    ?? "0", 10) || 0;
        totalComments += parseInt(v.statistics?.commentCount ?? "0", 10) || 0;
        if (v.snippet?.publishedAt > cutoff) postsLast30d++;
        const dur = v.contentDetails?.duration ?? "";
        if (dur) {
          const m = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (m) {
            const secs = parseInt(m[1] ?? "0", 10) * 3600 + parseInt(m[2] ?? "0", 10) * 60 + parseInt(m[3] ?? "0", 10);
            if (secs < 60) shortFormCount++;
          }
        }
        for (const catUrl of (v.topicDetails?.topicCategories ?? []) as string[]) {
          const cat = decodeURIComponent(catUrl.split("/").pop() ?? "");
          if (cat) topicSet.add(cat);
        }
      }
    }
  } catch (err: any) {
    logger.debug({ connectionId, error: err.message?.slice(0, 80) }, "YouTube video fetch failed — using channel averages");
    videoViews = vidCount > 0 ? Math.round(totalViews / vidCount) : 0;
  }

  const avgViews    = videoCount > 0 ? Math.round(videoViews    / videoCount) : 0;
  const avgLikes    = videoCount > 0 ? Math.round(totalLikes    / videoCount) : 0;
  const avgComments = videoCount > 0 ? Math.round(totalComments / videoCount) : 0;
  const engRate     = subs > 0 && videoCount > 0
    ? Math.round(((avgLikes + avgComments) / subs) * 10_000) / 100
    : 0;

  return {
    toolsCalled,
    platform: {
      handle,
      subscribers:      subs,
      avg_views:        avgViews,
      avg_likes:        avgLikes,
      avg_comments:     avgComments,
      engagement_rate:  engRate,
      posts_last_30d:   postsLast30d,
      topic_categories: topicSet.size > 0 ? Array.from(topicSet) : undefined,
      short_form_ratio: videoCount > 0 ? Math.round((shortFormCount / videoCount) * 100) / 100 : undefined,
      fetched_at:       new Date().toISOString(),
      source:           "connected",
    },
  };
}

// ── Analytics (display layer) — YouTube Analytics API, yt-analytics.readonly ──
async function ytAnalytics(token: string, params: Record<string, string>): Promise<{ columnHeaders: Array<{ name: string }>; rows?: any[][] }> {
  const url = new URL(YT_ANALYTICS);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res  = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json() as any;
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `YouTube Analytics ${res.status}`);
  return json;
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Rich display analytics for a connected channel: watch-time, retention, sub
 * gained/lost, demographics, geography, traffic, devices — all owner-OAuth via the
 * YouTube Analytics API (the scope we already request). Headline metrics map to the
 * flat columns; breakdowns live in raw_metrics.youtube. Every call is best-effort.
 */
// ─── Native fetch + display projection (Phase A Step 1a) ─────────────────────
// The same Data API and Analytics API calls as before, returned as a native envelope with the
// Analytics reports kept separate from channel/video facts; `projectYouTubeDisplay` reproduces
// the legacy SocialAnalyticsResult from it. Ad-revenue metrics are not requested.

export async function fetchYouTubeNative(connectionId: string): Promise<YouTubeNative | null> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) return null;

  const token = await refreshTokenIfNeeded(connectionId);
  const toolsCalled: string[] = [];
  const errors: YouTubeNative["errors"] = [];

  // Channel stats (Data API)
  const chanRes = await ytGet<any>("/channels", token, { part: "snippet,statistics", mine: "true" });
  toolsCalled.push("youtube_channels");
  const channel = chanRes?.items?.[0] as YouTubeNative["channel"] | undefined;
  if (!channel) return null;

  const end = ymd(new Date()), start = ymd(new Date(Date.now() - 30 * 864e5));
  const analytics: YouTubeNative["analytics"] = { reportStart: start, reportEnd: end };

  try {
    analytics.totals = await ytAnalytics(token, { ids: "channel==MINE", startDate: start, endDate: end,
      metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost" });
    toolsCalled.push("youtube_analytics_totals");
  } catch (err: any) { logger.warn({ connectionId, error: err.message?.slice(0, 100) }, "YT analytics totals unavailable"); errors.push({ step: "analytics_totals", message: String(err.message ?? err).slice(0, 200) }); }

  try {
    analytics.ageGender = await ytAnalytics(token, { ids: "channel==MINE", startDate: start, endDate: end, dimensions: "ageGroup,gender", metrics: "viewerPercentage" });
    toolsCalled.push("youtube_analytics_demographics");
  } catch (err: any) { logger.warn({ connectionId, error: err.message?.slice(0, 80) }, "YT demographics unavailable"); errors.push({ step: "analytics_demographics", message: String(err.message ?? err).slice(0, 200) }); }

  try { analytics.countries = await ytAnalytics(token, { ids: "channel==MINE", startDate: start, endDate: end, dimensions: "country", metrics: "views", sort: "-views", maxResults: "5" }); } catch (err: any) { errors.push({ step: "analytics_countries", message: String(err.message ?? err).slice(0, 200) }); }
  try { analytics.traffic   = await ytAnalytics(token, { ids: "channel==MINE", startDate: start, endDate: end, dimensions: "insightTrafficSourceType", metrics: "views", sort: "-views", maxResults: "6" }); } catch (err: any) { errors.push({ step: "analytics_traffic", message: String(err.message ?? err).slice(0, 200) }); }
  try { analytics.devices   = await ytAnalytics(token, { ids: "channel==MINE", startDate: start, endDate: end, dimensions: "deviceType", metrics: "views", sort: "-views" }); } catch (err: any) { errors.push({ step: "analytics_devices", message: String(err.message ?? err).slice(0, 200) }); }

  // Recent videos (Data API) for the recent-posts strip + engagement averages
  let videos: YtVideo[] = [];
  try {
    const searchRes = await ytGet<any>("/search", token, { part: "id", channelId: channel.id, type: "video", order: "date", maxResults: "10" });
    const ids = (searchRes?.items ?? []).map((i: any) => i.id?.videoId).filter(Boolean).join(",");
    if (ids) {
      const vidsRes = await ytGet<any>("/videos", token, { part: "statistics,snippet,contentDetails,topicDetails", id: ids });
      videos = (vidsRes?.items ?? []) as YtVideo[];
      toolsCalled.push("youtube_videos");
    }
  } catch (err: any) { logger.warn({ connectionId, error: err.message?.slice(0, 80) }, "YT recent videos unavailable"); errors.push({ step: "videos", message: String(err.message ?? err).slice(0, 200) }); }

  const handle = channel.snippet?.customUrl ?? channel.snippet?.title ?? null;
  return {
    platform: "youtube", accountId: channel.id, handle,
    fetchedAt: new Date().toISOString(), apiVersion: "v3", sourceMethod: "oauth_youtube",
    toolsCalled, errors, channel, analytics, videos,
  };
}

/** The legacy display contract, computed from the native envelope. Same arithmetic as before. */
export function projectYouTubeDisplay(n: YouTubeNative): SocialAnalyticsResult {
  const raw: SocialAnalyticsRaw = {};
  const channel = n.channel;
  const subs       = parseInt(channel.statistics?.subscriberCount ?? "0", 10) || 0;
  const totalViews = parseInt(channel.statistics?.viewCount       ?? "0", 10) || 0;
  const vidCount   = parseInt(channel.statistics?.videoCount      ?? "0", 10) || 0;
  raw.account = { username: channel.snippet?.customUrl ?? channel.snippet?.title, title: channel.snippet?.title, id: channel.id };

  const yt: NonNullable<SocialAnalyticsRaw["youtube"]> = {};
  let avgWatchSec: number | null = null;
  const a = n.analytics;

  if (a.totals) {
    const cols = a.totals.columnHeaders.map((c) => c.name), vals = (a.totals.rows?.[0] ?? []) as any[];
    const g = (name: string) => { const i = cols.indexOf(name); return i >= 0 ? Number(vals[i]) : null; };
    yt.views_30d = g("views") ?? undefined;
    yt.minutes_watched_30d = g("estimatedMinutesWatched") ?? undefined;
    avgWatchSec = g("averageViewDuration");
    yt.avg_view_pct = g("averageViewPercentage") ?? undefined;
    const sg = g("subscribersGained") ?? 0, sl = g("subscribersLost") ?? 0;
    yt.subs_gained_30d = sg; yt.subs_lost_30d = sl; yt.subs_net_30d = sg - sl;
  }

  let topAge: string | null = null, topGender: string | null = null;
  if (a.ageGender) {
    const ag = ((a.ageGender.rows ?? []) as any[][]).map((r) => ({ age: String(r[0]).replace("age", ""), gender: String(r[1]), pct: Number(r[2]) }))
      .sort((x, y) => y.pct - x.pct);
    if (ag.length) {
      yt.age_gender = ag; topAge = ag[0].age;
      const byGender: Record<string, number> = {};
      for (const x of ag) byGender[x.gender] = (byGender[x.gender] ?? 0) + x.pct;
      topGender = Object.entries(byGender).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    }
  }

  const pctRows = (rows: any[][]) => { const total = rows.reduce((acc, r) => acc + Number(r[1]), 0) || 1;
    return rows.map((r) => ({ key: String(r[0]), value: Number(r[1]), pct: Math.round((Number(r[1]) / total) * 1000) / 10 })); };
  let topCountry: string | null = null;
  if (a.countries) { yt.countries = pctRows((a.countries.rows ?? []) as any[][]); topCountry = yt.countries[0]?.key ?? null; }
  if (a.traffic)   { yt.traffic = pctRows((a.traffic.rows ?? []) as any[][]); }
  if (a.devices)   { yt.devices = pctRows((a.devices.rows ?? []) as any[][]); }
  if (Object.keys(yt).length) raw.youtube = yt;

  // Mirror into the standard demographics shape so the shared audience UI renders for YT too.
  const demo: NonNullable<SocialAnalyticsRaw["demographics"]> = {};
  if (yt.countries?.length) demo.country = yt.countries;
  if (yt.age_gender?.length) {
    const byAge: Record<string, number> = {}, byGender: Record<string, number> = {};
    for (const x of yt.age_gender) { byAge[x.age] = (byAge[x.age] ?? 0) + x.pct; byGender[x.gender] = (byGender[x.gender] ?? 0) + x.pct; }
    const toRows = (m: Record<string, number>) => Object.entries(m).sort((x, y) => y[1] - x[1]).map(([k, v]) => ({ key: k, value: Math.round(v * 10) / 10, pct: Math.round(v * 10) / 10 }));
    demo.age = toRows(byAge); demo.gender = toRows(byGender);
  }
  if (Object.keys(demo).length) raw.demographics = demo;

  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  let postsLast30d = 0, totalLikes = 0, totalComments = 0, videoViews = 0, videoCount = 0;
  const recentMedia: NonNullable<SocialAnalyticsRaw["recent_media"]> = [];
  const stamps: number[] = [];
  for (const v of n.videos) {
    const views = parseInt(v.statistics?.viewCount ?? "0", 10) || 0;
    const likes = parseInt(v.statistics?.likeCount ?? "0", 10) || 0;
    const comments = parseInt(v.statistics?.commentCount ?? "0", 10) || 0;
    videoCount++; videoViews += views; totalLikes += likes; totalComments += comments;
    if (v.snippet?.publishedAt) { stamps.push(new Date(v.snippet.publishedAt).getTime()); if (v.snippet.publishedAt > cutoff) postsLast30d++; }
    recentMedia.push({
      id: v.id, permalink: `https://youtube.com/watch?v=${v.id}`, media_type: "VIDEO",
      caption: v.snippet?.title ?? null, timestamp: v.snippet?.publishedAt ?? "",
      media_url: null, thumbnail_url: v.snippet?.thumbnails?.medium?.url ?? null,
      like_count: likes, comments_count: comments, insights: { video_views: views },
    });
  }
  if (n.videos.length) raw.recent_media = recentMedia;

  const avgViews    = videoCount > 0 ? Math.round(videoViews / videoCount) : null;
  const avgLikes    = videoCount > 0 ? Math.round(totalLikes / videoCount) : 0;
  const avgComments = videoCount > 0 ? Math.round(totalComments / videoCount) : 0;
  const engRate     = subs > 0 && videoCount > 0 ? Math.round(((avgLikes + avgComments) / subs) * 10_000) / 100 : null;
  let contentFrequency: number | null = null;
  if (stamps.length >= 2) { stamps.sort((x, y) => y - x); const weeks = (stamps[0] - stamps[stamps.length - 1]) / (7 * 864e5);
    contentFrequency = weeks > 0 ? Math.round((stamps.length / weeks) * 100) / 100 : null; }

  return {
    followers: subs || null, following: null, post_count: vidCount || null,
    total_likes: null, total_channel_views: totalViews || null, is_verified: false,
    reach: null, impressions: yt.views_30d ?? null, profile_views: null,
    avg_engagement_rate: engRate, avg_reach_per_post: null, avg_views_per_post: avgViews,
    avg_shares_per_post: null, avg_saves_per_post: null, avg_watch_time_sec: avgWatchSec,
    content_frequency: contentFrequency, posts_last_30d: postsLast30d,
    top_audience_country: topCountry, top_audience_city: null,
    top_audience_age_range: topAge, top_audience_gender: topGender,
    raw_metrics: raw, toolsCalled: n.toolsCalled,
  };
}

export async function fetchAnalytics(connectionId: string): Promise<SocialAnalyticsResult | null> {
  const native = await fetchYouTubeNative(connectionId);
  return native ? projectYouTubeDisplay(native) : null;
}

export const fetchNative = fetchYouTubeNative;
export const project = projectYouTubeDisplay;

// ─── Full-history media pagination (media backfill) ──────────────────────────
function bestThumb(t: any): string | null {
  return t?.maxres?.url ?? t?.standard?.url ?? t?.high?.url ?? t?.medium?.url ?? t?.default?.url ?? null;
}

/**
 * One page of the channel's uploads for the backfill, via the uploads playlist
 * (`playlistItems` = 1 quota unit/page; never `search`, which is 100). Thumbnail +
 * title/description + stats; no raw video (ToS). Returns the next `pageToken`, or null.
 */
export async function listMediaPage(connectionId: string, pageToken: string | null):
  Promise<{ items: NonNullable<SocialAnalyticsRaw["recent_media"]>; nextCursor: string | null; native: YtVideo[] }> {
  const token = await refreshTokenIfNeeded(connectionId);
  const ch = await ytGet<any>("/channels", token, { part: "contentDetails", mine: "true" });
  const uploads = ch?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { items: [], nextCursor: null, native: [] };
  const pl = await ytGet<any>("/playlistItems", token, {
    part: "snippet,contentDetails", playlistId: uploads, maxResults: "50", ...(pageToken ? { pageToken } : {}),
  });
  const nodes: any[] = pl?.items ?? [];
  const ids = nodes.map((n) => n.contentDetails?.videoId).filter(Boolean);
  const statsById: Record<string, any> = {};
  if (ids.length) {
    const st = await ytGet<any>("/videos", token, { part: "statistics,snippet,contentDetails", id: ids.join(",") });
    for (const v of st?.items ?? []) statsById[v.id] = v;
  }
  const items = nodes.map((n) => {
    const id: string = n.contentDetails?.videoId ?? "";
    const s = statsById[id];
    const title = n.snippet?.title ?? "";
    const desc  = s?.snippet?.description ?? n.snippet?.description ?? "";
    return {
      id, permalink: `https://youtube.com/watch?v=${id}`, media_type: "VIDEO",
      caption: [title, desc].filter(Boolean).join("\n\n").slice(0, 2000) || null,
      timestamp: n.contentDetails?.videoPublishedAt ?? n.snippet?.publishedAt ?? "",
      media_url: null as string | null, thumbnail_url: bestThumb(s?.snippet?.thumbnails ?? n.snippet?.thumbnails),
      like_count: s?.statistics?.likeCount != null ? Number(s.statistics.likeCount) : null,
      comments_count: s?.statistics?.commentCount != null ? Number(s.statistics.commentCount) : null,
      insights: { video_views: s?.statistics?.viewCount != null ? Number(s.statistics.viewCount) : undefined },
    };
  }).filter((it) => it.id);
  const nextCursor: string | null = pl?.nextPageToken ?? null;
  return { items, nextCursor, native: ids.map((id) => statsById[id]).filter(Boolean) as YtVideo[] };
}
