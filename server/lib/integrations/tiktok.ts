/**
 * TikTok direct integration — TikTok Open API v2.
 * Access token: 24hr. Refresh token: 365 days.
 */

import { db } from "../../db";
import { connectedAccounts } from "../../../shared/schema";
import type { SocialAnalyticsRaw } from "../../../shared/schema";
import type { TikTokNative, TtVideo } from "../../services/intelligence/social/native";
import { eq } from "drizzle-orm";
import { createLogger } from "../../logger";
import { apiBaseUrl } from "../baseUrls";
import { signOAuthState } from "../oauthState";
import type { SnapshotSocialPlatform } from "../../services/snapshotSocial";
import type { ActivatedConnection, SocialAnalyticsResult } from "./types";
import { openTokenFields, sealTokenFields } from "../tokenCrypto";
import { activateConnection, MissingAccountIdError } from "./activateConnection";

const logger = createLogger("integrations/tiktok");

const CLIENT_KEY    = process.env.TIKTOK_CLIENT_KEY?.trim();
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET?.trim();
const API_BASE      = apiBaseUrl();
const REDIRECT      = `${API_BASE}/api/v1/auth/callback/tiktok`;
const TT_API        = "https://open.tiktokapis.com/v2";

// Audience demographics (creator/info) need the `creator_info` scope, which
// requires its own TikTok review. Keep it OFF until approved: requesting an
// unapproved scope can make TikTok reject the whole authorization. Flip this env
// flag to true once `creator_info` is granted — no code change, the demographics
// call below activates and the scope joins the auth request.
const DEMOGRAPHICS_ENABLED = process.env.TIKTOK_DEMOGRAPHICS_ENABLED === "true";

const SCOPES = [
  "user.info.basic",
  "user.info.profile",
  "user.info.stats",
  "video.list",
  ...(DEMOGRAPHICS_ENABLED ? ["creator_info"] : []),
].join(",");

// clientPlatform "web" (signed into state) sends a web connect back to the web app; the connect route passes it for
// TikTok only when the client asks (webReturn — the dev web build), so today's clients keep today's return page.
export function getAuthUrl(athleteId: string, _alias?: string, _loginHint?: string, clientPlatform?: string): string {
  if (!CLIENT_KEY) throw new Error("TIKTOK_CLIENT_KEY not set");
  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.searchParams.set("client_key",    CLIENT_KEY);
  url.searchParams.set("redirect_uri",  REDIRECT);
  url.searchParams.set("state",         signOAuthState(athleteId, undefined, clientPlatform));
  url.searchParams.set("scope",         SCOPES);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

export async function handleCallback(code: string, athleteId: string): Promise<ActivatedConnection> {
  if (!CLIENT_KEY || !CLIENT_SECRET) throw new Error("TikTok credentials not configured");

  const body = new URLSearchParams({
    client_key:    CLIENT_KEY,
    client_secret: CLIENT_SECRET,
    code,
    grant_type:    "authorization_code",
    redirect_uri:  REDIRECT,
  });

  const res = await fetch(`${TT_API}/oauth/token/`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  const data = await res.json() as any;
  if (data.error || !data.access_token) {
    throw new Error(`TikTok token exchange failed: ${data.error_description ?? data.error ?? "unknown"}`);
  }

  // Fetch user info to get username and follower count
  const userFields = "open_id,display_name,username,follower_count,is_verified";
  const userRes = await fetch(`${TT_API}/user/info/?fields=${userFields}`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  const userJson = await userRes.json() as any;
  const user = userJson?.data?.user ?? {};

  const expiresAt        = data.expires_in        ? new Date(Date.now() + data.expires_in        * 1000) : null;
  const refreshExpiresAt = data.refresh_expires_in ? new Date(Date.now() + data.refresh_expires_in * 1000) : null;

  // open_id is the connection's identity (the token response carries it; user/info is the fallback).
  const openId = data.open_id ?? user.open_id;
  if (!openId) {
    logger.error({ athleteId }, "TikTok connect: no open_id in token or user info");
    throw new MissingAccountIdError("tiktok");
  }

  const activated = await activateConnection({
    athleteId,
    platform:         "tiktok",
    platformUserId:   String(openId),
    platformUsername: user.username ?? user.display_name ?? null,
    accessToken:      data.access_token,
    refreshToken:     data.refresh_token ?? null,
    tokenExpiresAt:   expiresAt,
    scopes:           data.scope ?? SCOPES,
  });

  logger.info({ athleteId, openId, connectionId: activated.connectionId, reactivated: activated.reactivated }, "TikTok connected");
  return activated;
}

export async function refreshTokenIfNeeded(connectionId: string): Promise<void> {
  if (!CLIENT_KEY || !CLIENT_SECRET) return;

  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token || !row.token_expires_at) return;

  const minsLeft = (row.token_expires_at.getTime() - Date.now()) / 60_000;
  if (minsLeft > 30) return;

  if (!row.refresh_token) {
    await db.update(connectedAccounts).set({ status: "expired" }).where(eq(connectedAccounts.id, connectionId));
    return;
  }

  const body = new URLSearchParams({
    client_key:    CLIENT_KEY,
    client_secret: CLIENT_SECRET,
    grant_type:    "refresh_token",
    refresh_token: row.refresh_token,
  });

  const res  = await fetch(`${TT_API}/oauth/token/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const data = await res.json() as any;
  if (data.error || !data.access_token) throw new Error(`TikTok token refresh failed: ${data.error}`);

  await db.update(connectedAccounts).set(await sealTokenFields({
    access_token:     data.access_token,
    refresh_token:    data.refresh_token ?? row.refresh_token,
    token_expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : row.token_expires_at,
  })).where(eq(connectedAccounts.id, connectionId));

  logger.info({ connectionId }, "TikTok token refreshed");
}

export async function fetchForScoring(connectionId: string): Promise<{
  platform: SnapshotSocialPlatform;
  toolsCalled: string[];
} | null> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) return null;

  const token       = row.access_token;
  const toolsCalled: string[] = [];

  // User stats
  const userFields = "open_id,display_name,username,follower_count,is_verified";
  const userRes  = await fetch(`${TT_API}/user/info/?fields=${userFields}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const userJson = await userRes.json() as any;
  toolsCalled.push("tiktok_user_info");

  const user      = userJson?.data?.user ?? {};
  const followers = user.follower_count ?? 0;
  const handle    = user.username ? `@${user.username}` : (user.display_name ? `@${user.display_name}` : undefined);
  const verified  = user.is_verified ?? false;

  if (!followers) {
    return { toolsCalled, platform: { handle, followers: 0, verified, fetched_at: new Date().toISOString(), source: "connected" } };
  }

  // Recent videos
  const videoRes = await fetch(`${TT_API}/video/list/`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ max_count: 10, fields: ["id", "create_time", "view_count", "like_count", "comment_count"] }),
  });
  const videoJson = await videoRes.json() as any;
  toolsCalled.push("tiktok_video_list");

  const videos   = (videoJson?.data?.videos ?? []) as Array<any>;
  const cutoff   = Date.now() - 30 * 864e5;
  let totalViews = 0, totalLikes = 0, totalComments = 0, postsLast30d = 0;

  for (const v of videos) {
    totalViews    += v.view_count    ?? 0;
    totalLikes    += v.like_count    ?? 0;
    totalComments += v.comment_count ?? 0;
    const ts = v.create_time;
    if (ts && new Date(typeof ts === "number" ? ts * 1000 : ts).getTime() > cutoff) postsLast30d++;
  }

  const count    = videos.length;
  const avgViews    = count > 0 ? Math.round(totalViews    / count) : 0;
  const avgLikes    = count > 0 ? Math.round(totalLikes    / count) : 0;
  const avgComments = count > 0 ? Math.round(totalComments / count) : 0;
  const engRate = avgViews > 0 ? Math.round(((avgLikes + avgComments) / avgViews) * 10_000) / 100 : 0;

  return {
    toolsCalled,
    platform: {
      handle,
      followers,
      verified,
      engagement_rate: engRate,
      avg_views:       avgViews,
      avg_likes:       avgLikes,
      avg_comments:    avgComments,
      posts_last_30d:  postsLast30d,
      fetched_at:      new Date().toISOString(),
      source:          "connected",
    },
  };
}

// ─── Analytics (snapshot pipeline) ─────────────────────────────────────────────
// Richer counterpart to fetchForScoring for the social_analytics_snapshots row.
// Demographics (audience_countries/genders/ages) are gated behind
// DEMOGRAPHICS_ENABLED + the creator_info scope; until then that block is skipped
// and the audience fields stay null. Everything is best-effort.

// bio_description is a user.info.profile field — a scope already in SCOPES above, so adding it needs no new consent.
const TT_USER_FIELDS = "open_id,display_name,username,bio_description,follower_count,following_count,likes_count,video_count,is_verified";
const TT_VIDEO_FIELDS = ["id", "create_time", "view_count", "like_count", "comment_count", "share_count", "duration", "title", "video_description", "cover_image_url", "share_url"];

/** Map a TikTok demographics array (creator/info) to sorted {key,value,pct} rows. */
function ttDemographicRows(arr: any[] | undefined): Array<{ key: string; value: number; pct: number }> {
  if (!Array.isArray(arr)) return [];
  const total = arr.reduce((s, r) => s + (r?.percentage ?? r?.value ?? 0), 0);
  return arr
    .map((r) => {
      const value = r?.percentage ?? r?.value ?? 0;
      return {
        key: String(r?.country ?? r?.gender ?? r?.age_group ?? r?.key ?? "unknown"),
        value,
        pct: total > 0 ? Math.round((value / total) * 100) : Math.round(value),
      };
    })
    .sort((a, b) => b.value - a.value);
}

// ─── Native fetch + display projection (Phase A Step 1a) ─────────────────────
// Same three calls as before (user/info, video/list, creator/info when enabled), returned as a
// native envelope; `projectTikTokDisplay` reproduces the legacy SocialAnalyticsResult from it.
// Platform-native fields (duration, title, video_description) ride in the envelope untouched.

export async function fetchTikTokNative(connectionId: string): Promise<TikTokNative | null> {
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) return null;

  const token = row.access_token;
  const toolsCalled: string[] = [];
  const errors: TikTokNative["errors"] = [];

  // ── User stats ───────────────────────────────────────────────────────────
  const userRes  = await fetch(`${TT_API}/user/info/?fields=${TT_USER_FIELDS}`, { headers: { Authorization: `Bearer ${token}` } });
  const userJson = await userRes.json() as any;
  toolsCalled.push("tiktok_user_info");
  const user = (userJson?.data?.user ?? {}) as TikTokNative["user"];

  // ── Recent videos (best-effort) ──────────────────────────────────────────
  // NOTE: TikTok's video/list wants `fields` as a QUERY param; only max_count/
  // cursor go in the body. Passing fields in the body → 400 "fields is required".
  let videos: TtVideo[] = [];
  try {
    const videoRes = await fetch(`${TT_API}/video/list/?fields=${TT_VIDEO_FIELDS.join(",")}`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ max_count: 20 }),
    });
    const videoJson = await videoRes.json() as any;
    if (videoJson?.error && videoJson.error.code !== "ok") {
      logger.warn({ connectionId, error: videoJson.error.message?.slice(0, 100) }, "TikTok video list error");
      errors.push({ step: "video_list", message: String(videoJson.error.message ?? videoJson.error.code).slice(0, 200) });
    }
    videos = videoJson?.data?.videos ?? [];
    toolsCalled.push("tiktok_video_list");
  } catch (err: any) {
    logger.warn({ connectionId, error: err.message?.slice(0, 100) }, "TikTok video list failed");
    errors.push({ step: "video_list", message: String(err.message ?? err).slice(0, 200) });
  }

  // ── Demographics (dormant until creator_info approved) ───────────────────
  let demographics: TikTokNative["demographics"] = null;
  if (DEMOGRAPHICS_ENABLED) {
    try {
      const res  = await fetch(`${TT_API}/creator/info/?fields=audience_countries,audience_genders,audience_ages`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json() as any;
      const d    = json?.data ?? {};
      const country = ttDemographicRows(d.audience_countries);
      const gender  = ttDemographicRows(d.audience_genders);
      const age     = ttDemographicRows(d.audience_ages);
      if (country.length || gender.length || age.length) {
        demographics = { country, gender, age };
        toolsCalled.push("tiktok_creator_info");
      }
    } catch (err: any) {
      logger.warn({ connectionId, error: err.message?.slice(0, 100) }, "TikTok demographics unavailable");
      errors.push({ step: "creator_info", message: String(err.message ?? err).slice(0, 200) });
    }
  }

  return {
    platform: "tiktok", accountId: String(user.open_id ?? row.platform_user_id ?? ""), handle: user.username ?? user.display_name ?? null,
    fetchedAt: new Date().toISOString(), apiVersion: "v2", sourceMethod: "oauth_tiktok_display",
    toolsCalled, errors, user, videos, demographics,
  };
}

/** The legacy display contract, computed from the native envelope. Same arithmetic as before. */
export function projectTikTokDisplay(n: TikTokNative): SocialAnalyticsResult {
  const raw: SocialAnalyticsRaw = {};
  const user = n.user as any;
  raw.account = user;
  const followers = user.follower_count ?? 0;
  const videos = n.videos as any[];

  let totalViews = 0, totalLikes = 0, totalComments = 0, totalShares = 0;
  const recentMedia: NonNullable<SocialAnalyticsRaw["recent_media"]> = [];
  for (const v of videos) {
    totalViews    += v.view_count    ?? 0;
    totalLikes    += v.like_count    ?? 0;
    totalComments += v.comment_count ?? 0;
    totalShares   += v.share_count   ?? 0;
    recentMedia.push({
      id: String(v.id ?? ""), permalink: v.share_url ?? "", media_type: "VIDEO",
      caption: v.video_description ?? v.title ?? null,
      timestamp: v.create_time ? new Date(v.create_time * 1000).toISOString() : "",
      media_url: v.share_url ?? null, thumbnail_url: v.cover_image_url ?? null,
      like_count: v.like_count ?? null, comments_count: v.comment_count ?? null,
      insights: { video_views: v.view_count ?? undefined, shares: v.share_count ?? undefined },
    });
  }
  raw.recent_media = recentMedia;

  const count       = videos.length;
  const avgViews    = count > 0 ? Math.round(totalViews    / count) : null;
  const avgShares   = count > 0 ? Math.round(totalShares   / count) : null;
  const avgLikes    = count > 0 ? totalLikes    / count : 0;
  const avgComments = count > 0 ? totalComments / count : 0;
  // views-based engagement rate (engagements ÷ views) — consistent with fetchForScoring
  const engRate     = avgViews && avgViews > 0 ? Math.round(((avgLikes + avgComments) / avgViews) * 10_000) / 100 : null;

  let contentFrequency: number | null = null;
  const stamps = videos.map((v) => (v.create_time ? v.create_time * 1000 : 0)).filter(Boolean).sort((a, b) => b - a);
  if (stamps.length >= 2) {
    const weeks = (stamps[0] - stamps[stamps.length - 1]) / (7 * 864e5);
    contentFrequency = weeks > 0 ? Math.round((stamps.length / weeks) * 100) / 100 : null;
  }
  const postsLast30d = stamps.filter((t) => t > Date.now() - 30 * 864e5).length;

  let topCountry: string | null = null, topAge: string | null = null, topGender: string | null = null;
  if (n.demographics) {
    const { country, gender, age } = n.demographics;
    raw.demographics = { country, gender, age };
    topCountry = country[0]?.key ?? null;
    topGender  = gender[0]?.key  ?? null;
    topAge     = age[0]?.key     ?? null;
  }

  return {
    followers:            followers || null,
    following:            user.following_count ?? null,
    post_count:           user.video_count ?? null,
    total_likes:          user.likes_count ?? null,
    total_channel_views:  null,
    is_verified:          user.is_verified ?? false,
    reach:                null,                 // TikTok has no account-reach metric
    impressions:          null,
    profile_views:        null,
    avg_engagement_rate:  engRate,
    avg_reach_per_post:   null,
    avg_views_per_post:   avgViews,
    avg_shares_per_post:  avgShares,
    avg_saves_per_post:   null,
    avg_watch_time_sec:   null,
    content_frequency:    contentFrequency,
    posts_last_30d:       postsLast30d,
    top_audience_country:   topCountry,
    top_audience_city:      null,
    top_audience_age_range: topAge,
    top_audience_gender:    topGender,
    raw_metrics:          raw,
    toolsCalled:          n.toolsCalled,
  };
}

export async function fetchAnalytics(connectionId: string): Promise<SocialAnalyticsResult | null> {
  const native = await fetchTikTokNative(connectionId);
  return native ? projectTikTokDisplay(native) : null;
}

export const fetchNative = fetchTikTokNative;
export const project = projectTikTokDisplay;

// ─── Full-history media pagination (media backfill) ──────────────────────────
/**
 * One page of the user's TikTok video history for the backfill — cover + stats +
 * share link (Display API exposes no raw video). `cursor` is TikTok's numeric page
 * cursor as a string; returns the next one, or null when `has_more` is false.
 */
export async function listMediaPage(connectionId: string, cursor: string | null):
  Promise<{ items: NonNullable<SocialAnalyticsRaw["recent_media"]>; nextCursor: string | null; native: TtVideo[] }> {
  await refreshTokenIfNeeded(connectionId).catch(() => {});
  const row = await openTokenFields((await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1))[0]);
  if (!row?.access_token) return { items: [], nextCursor: null, native: [] };
  const body: Record<string, unknown> = { max_count: 20 };
  if (cursor) body.cursor = Number(cursor);
  const res = await fetch(`${TT_API}/video/list/?fields=${TT_VIDEO_FIELDS.join(",")}`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${row.access_token}`, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({} as any));
  const videos: any[] = data?.data?.videos ?? [];
  const items = videos.map((v) => ({
    id: String(v.id ?? ""), permalink: v.share_url ?? "", media_type: "VIDEO",
    caption: v.video_description ?? v.title ?? null,
    timestamp: v.create_time ? new Date(v.create_time * 1000).toISOString() : "",
    media_url: v.share_url ?? null, thumbnail_url: v.cover_image_url ?? null,
    like_count: v.like_count ?? null, comments_count: v.comment_count ?? null,
    insights: { video_views: v.view_count ?? undefined, shares: v.share_count ?? undefined },
  }));
  const nextCursor = data?.data?.has_more ? String(data?.data?.cursor ?? "") : null;
  return { items, nextCursor, native: videos as TtVideo[] };
}
