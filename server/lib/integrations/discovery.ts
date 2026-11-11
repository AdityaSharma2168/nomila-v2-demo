/**
 * discovery.ts — public social data for athletes who have NOT connected OAuth.
 *
 * Ported from v1's socialVerificationService, enriched for scoring: IG Business
 * Discovery also pulls recent media to compute engagement + posts_last_30d
 * (identical math to instagram.ts fetchAnalytics), so `source='discovery'` rows
 * are comparable to `connected` rows. YouTube uses the Data API (counts only;
 * per-video engagement is a follow-up).
 *
 * No athlete OAuth needed — Business Discovery runs from Nomila's own IG business
 * account: env DISCOVERY_IG_* preferred, else any active connected IG token
 * (v1's fallback). YouTube needs only the Data API key.
 *
 * Limits: Business Discovery works for Business/Creator accounts only (personal
 * accounts → not_business_account); TikTok has no free route (provider, later).
 *
 * THE ONE PUBLIC DISCOVERY CLIENT (research-acquisition architecture §8, D10). The request
 * builders below (requestInstagramBusinessDiscovery, requestYouTubeChannel / PlaylistItems /
 * Videos) are the only code that calls these endpoints. Three callers sit on them:
 *   - fetchInstagramDiscovery / fetchYouTubeDiscovery here (the substrate keeper);
 *   - lib/platformDiscovery.ts (legacy researchAthlete; derives topics + short-form itself);
 *   - the dormant M.I.A. lookups in services/marketabilityBeta1SocialBlock.ts.
 * Each caller keeps its own request shape (IG_FIELDS, parts) and its own failure policy, so
 * the consolidation moved no request, no stored payload and no output (discovery.parity.test.ts).
 * The raw results carry the profile `name` when requested and a hidden YouTube subscriber
 * count as null; a caller that reports 0 for it (legacy) does so in its own mapping.
 */

import type { SocialAnalyticsResult } from "./types";
import type { SocialAnalyticsRaw } from "../../../shared/schema";
import type { InstagramDiscoveryNative, YouTubeDiscoveryNative } from "../../services/intelligence/social/native";
import { createLogger } from "../../logger";

const logger = createLogger("discovery");
/** The one Graph API version for public discovery. */
export const GRAPH_API_VERSION = "v22.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const YOUTUBE = "https://www.googleapis.com/youtube/v3";

export type DiscoveryError =
  | "not_configured" | "no_token" | "not_business_account"
  | "rate_limited" | "token_expired" | "not_found" | "fetch_failed" | string;

export interface DiscoveryFetch {
  found:  boolean;
  result: SocialAnalyticsResult | null;
  error:  DiscoveryError | null;
  /** The provider's response as a native envelope (Phase A Step 1a), for the substrate. */
  native?: InstagramDiscoveryNative | YouTubeDiscoveryNative | null;
}

// ─── The client ───────────────────────────────────────────────────────────────

/**
 * One provider call as a value. The client never throws: a transport failure or an unparseable
 * body comes back as data, so each caller keeps the failure policy it had (return an error,
 * return null, or rethrow).
 */
export type ProviderCall =
  | { kind: "response"; status: number; httpOk: boolean; body: any }
  | { kind: "unparseable"; status: number; httpOk: boolean; cause: unknown }
  | { kind: "network"; cause: unknown };

type Failed   = Exclude<ProviderCall, { kind: "response" }>;
type Answered = Extract<ProviderCall, { kind: "response" }>;

async function providerGet(url: string, timeoutMs?: number): Promise<ProviderCall> {
  let res: Response;
  try { res = timeoutMs ? await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }) : await fetch(url); }
  catch (cause) { return { kind: "network", cause }; }
  try { return { kind: "response", status: res.status, httpOk: res.ok, body: await res.json() }; }
  catch (cause) { return { kind: "unparseable", status: res.status, httpOk: res.ok, cause }; }
}

/** A failed call's own message (what the keeper has always reported), else "fetch_failed". */
const failureMessage = (call: Failed): string => (call.cause as { message?: string } | null)?.message ?? "fetch_failed";

export interface IgAuth { igBusinessId: string; token: string }

/** A Business Discovery field set: profile fields, plus nested recent media when `media` is set. */
export interface IgFieldSet { profile: string; media?: { limit: number; fields: string } }

/**
 * The field sets in use, one per caller, each exactly what that caller requested before the
 * consolidation. `substrate` is stored verbatim as the platform_public payload, so widening it
 * (e.g. adding `name`) changes what the substrate stores and is a separate, deliberate change.
 * `biography` was added to `substrate` deliberately: it is the public bio stored as the
 * `profile.bio` social feature (platform_public), because the Instagram-Login profile call
 * does not expose a bio (see social/profileBio.ts).
 */
export const IG_FIELDS = {
  substrate:         { profile: "id,username,biography,followers_count,media_count", media: { limit: 10, fields: "id,like_count,comments_count,timestamp,media_type" } },
  legacy:            { profile: "id,followers_count,media_count,website,username", media: { limit: 25, fields: "like_count,comments_count,timestamp,media_type" } },
  legacyProfileOnly: { profile: "id,followers_count,media_count,website,username" },
  identity:          { profile: "id,username,name,biography,website,followers_count,follows_count,media_count", media: { limit: 25, fields: "id,like_count,comments_count,timestamp,media_type,media_product_type" } },
} as const satisfies Record<string, IgFieldSet>;

/** Graph error → discovery vocabulary (110/2207013 personal or unknown account, 4/17 throttled, 190 token). */
export function classifyGraphError(error: { code?: number; error_subcode?: number; message?: string }): DiscoveryError {
  const code = error.code, sub = error.error_subcode;
  return (code === 110 || sub === 2207013) ? "not_business_account"
    : (code === 4 || code === 17)          ? "rate_limited"
    : (code === 190)                       ? "token_expired"
    : (error.message ?? "unknown");
}

export type InstagramDiscoveryCall = Failed | (Answered & {
  /** The business_discovery node as returned, or null when absent. */
  businessDiscovery: any | null;
  /** Profile display name; null unless the field set requests `name` and the account has one. */
  name: string | null;
  /** null on success; a classified Graph error; or not_found when no business_discovery node came back. */
  error: DiscoveryError | null;
});

/** Instagram Business Discovery for `handle`, used verbatim (callers normalise it). */
export async function requestInstagramBusinessDiscovery(
  handle: string,
  opts: { auth: IgAuth; fields: IgFieldSet; timeoutMs?: number },
): Promise<InstagramDiscoveryCall> {
  const { profile, media } = opts.fields;
  const url = new URL(`${GRAPH}/${opts.auth.igBusinessId}`);
  url.searchParams.set("fields", `business_discovery.username(${handle}){${profile}${media ? `,media.limit(${media.limit}){${media.fields}}` : ""}}`);
  url.searchParams.set("access_token", opts.auth.token);
  const call = await providerGet(url.toString(), opts.timeoutMs);
  if (call.kind !== "response") return call;
  const bd = call.body?.business_discovery ?? null;
  return {
    ...call,
    businessDiscovery: bd,
    name:  typeof bd?.name === "string" ? bd.name : null,
    error: call.body?.error ? classifyGraphError(call.body.error) : bd ? null : "not_found",
  };
}

export type YouTubeChannelCall = Failed | (Answered & {
  /** items[0] as returned, or null when the lookup matched nothing. */
  channel: any | null;
  /** Subscriber count; null when the channel hides it (never 0 for hidden) or the API omits it. */
  subscribers: number | null;
  hiddenSubscriberCount: boolean;
});

/**
 * channels.list for a handle (without "@"). `lookup: "auto"` treats a "UC…" value as a channel
 * id (keeper + legacy behaviour); `"handle"` always looks up by handle (M.I.A. behaviour).
 */
export async function requestYouTubeChannel(
  handle: string,
  opts: { key: string; part: string; lookup?: "auto" | "handle"; timeoutMs?: number },
): Promise<YouTubeChannelCall> {
  const url = new URL(`${YOUTUBE}/channels`);
  url.searchParams.set("part", opts.part);
  url.searchParams.set("key", opts.key);
  if ((opts.lookup ?? "auto") === "auto" && handle.startsWith("UC")) url.searchParams.set("id", handle);
  else                                                                 url.searchParams.set("forHandle", `@${handle}`);
  const call = await providerGet(url.toString(), opts.timeoutMs);
  if (call.kind !== "response") return call;
  const channel = call.body?.items?.[0] ?? null;
  const st = channel?.statistics ?? {};
  const hidden = st.hiddenSubscriberCount === true;
  const n = st.subscriberCount == null ? NaN : Number(st.subscriberCount);
  return { ...call, channel, hiddenSubscriberCount: hidden, subscribers: hidden || !Number.isFinite(n) ? null : n };
}

/** playlistItems.list — a channel's uploads playlist. */
export function requestYouTubePlaylistItems(
  playlistId: string,
  opts: { key: string; part: string; maxResults: number; timeoutMs?: number },
): Promise<ProviderCall> {
  const url = new URL(`${YOUTUBE}/playlistItems`);
  url.searchParams.set("part", opts.part);
  url.searchParams.set("playlistId", playlistId);
  url.searchParams.set("maxResults", String(opts.maxResults));
  url.searchParams.set("key", opts.key);
  return providerGet(url.toString(), opts.timeoutMs);
}

/** videos.list — with part topicDetails / contentDetails it carries topic categories and durations. */
export function requestYouTubeVideos(
  ids: string[],
  opts: { key: string; part: string; timeoutMs?: number },
): Promise<ProviderCall> {
  const url = new URL(`${YOUTUBE}/videos`);
  url.searchParams.set("part", opts.part);
  url.searchParams.set("id", ids.join(","));
  url.searchParams.set("key", opts.key);
  return providerGet(url.toString(), opts.timeoutMs);
}

// ─── Substrate keeper ─────────────────────────────────────────────────────────

function emptyResult(): SocialAnalyticsResult {
  return {
    followers: null, following: null, post_count: null, total_likes: null,
    total_channel_views: null, is_verified: false, reach: null, impressions: null,
    profile_views: null, avg_engagement_rate: null, avg_reach_per_post: null,
    avg_views_per_post: null, avg_shares_per_post: null, avg_saves_per_post: null,
    avg_watch_time_sec: null, content_frequency: null, posts_last_30d: null,
    top_audience_country: null, top_audience_city: null, top_audience_age_range: null,
    top_audience_gender: null, raw_metrics: {} as SocialAnalyticsRaw, toolsCalled: [],
  };
}

/** Nomila's IG business account for Business Discovery (Facebook-Login token). Requires DISCOVERY_IG_* env. */
export async function getDiscoveryIgAuth(): Promise<IgAuth | null> {
  if (process.env.DISCOVERY_IG_TOKEN && process.env.DISCOVERY_IG_BUSINESS_ID) {
    return { igBusinessId: process.env.DISCOVERY_IG_BUSINESS_ID, token: process.env.DISCOVERY_IG_TOKEN };
  }
  // No connected-account fallback: connected accounts now hold Instagram-Login tokens, and
  // Business Discovery is Facebook-Login-only — a connected token can't call it.
  return null;
}

export async function fetchInstagramDiscovery(handle: string): Promise<DiscoveryFetch> {
  const auth = await getDiscoveryIgAuth();
  if (!auth) return { found: false, result: null, error: "no_token" };
  const clean = handle.replace(/^@/, "").trim();

  const call = await requestInstagramBusinessDiscovery(clean, { auth, fields: IG_FIELDS.substrate });
  if (call.kind !== "response") return { found: false, result: null, error: failureMessage(call) };

  if (call.body?.error) {
    if (call.error === "token_expired") logger.warn({ code: call.body.error.code }, "discovery IG token expired — refresh DISCOVERY_IG_TOKEN");
    return { found: false, result: null, error: call.error };
  }

  const bd = call.businessDiscovery;
  if (!bd) return { found: false, result: null, error: "not_found" };

  const followers = bd.followers_count ?? 0;
  const media: Array<{ like_count?: number; comments_count?: number; timestamp?: string }> = bd.media?.data ?? [];
  const cutoff30 = Date.now() - 30 * 864e5;
  let totalLikes = 0, totalComments = 0, postsLast30d = 0;
  for (const m of media) {
    totalLikes    += m.like_count     ?? 0;
    totalComments += m.comments_count ?? 0;
    if (m.timestamp && new Date(m.timestamp).getTime() > cutoff30) postsLast30d++;
  }
  const count       = media.length;
  const avgLikes    = count > 0 ? Math.round(totalLikes    / count) : 0;
  const avgComments = count > 0 ? Math.round(totalComments / count) : 0;
  const engRate     = followers > 0 && count > 0
    ? Math.round(((avgLikes + avgComments) / followers) * 10_000) / 100
    : null;

  let contentFrequency: number | null = null;
  const stamps = media.map((m) => (m.timestamp ? new Date(m.timestamp).getTime() : 0)).filter(Boolean).sort((a, b) => b - a);
  if (stamps.length >= 2) {
    const weeks = (stamps[0] - stamps[stamps.length - 1]) / (7 * 864e5);
    contentFrequency = weeks > 0 ? Math.round((stamps.length / weeks) * 100) / 100 : null;
  }

  const result = emptyResult();
  result.followers           = followers || null;
  result.post_count          = bd.media_count ?? null;
  result.avg_engagement_rate = engRate;
  result.posts_last_30d      = postsLast30d;
  result.content_frequency   = contentFrequency;
  result.raw_metrics         = { discovery: { platform: "instagram", username: clean, source: "business_discovery" } } as unknown as SocialAnalyticsRaw;
  result.toolsCalled         = ["instagram_business_discovery"];
  const native: InstagramDiscoveryNative = {
    platform: "instagram", accountId: bd.id ? String(bd.id) : `handle:${clean.toLowerCase()}`, handle: bd.username ?? clean,
    fetchedAt: new Date().toISOString(), apiVersion: GRAPH_API_VERSION, sourceMethod: "meta_business_discovery",
    toolsCalled: ["instagram_business_discovery"], errors: [], businessDiscovery: bd,
  };
  return { found: true, result, error: null, native };
}

export async function fetchYouTubeDiscovery(handle: string): Promise<DiscoveryFetch> {
  const key = process.env.YOUTUBE_DATA_API_KEY;
  if (!key) return { found: false, result: null, error: "not_configured" };
  const clean = handle.replace(/^@/, "").trim();

  const call = await requestYouTubeChannel(clean, { key, part: "snippet,statistics" });
  if (call.kind !== "response") return { found: false, result: null, error: failureMessage(call) };
  if (!call.httpOk) return { found: false, result: null, error: call.body?.error?.message ?? "api_error" };
  // `result.followers` keeps its historical mapping (a "0" for a hidden count stays 0); the
  // client's call.subscribers is the null-for-hidden value, for readers that want it.
  const channel = call.channel;
  if (!channel)  return { found: false, result: null, error: "not_found" };

  const result = emptyResult();
  result.followers           = channel.statistics?.subscriberCount ? parseInt(channel.statistics.subscriberCount, 10) : null;
  result.post_count          = channel.statistics?.videoCount      ? parseInt(channel.statistics.videoCount, 10)      : null;
  result.total_channel_views = channel.statistics?.viewCount       ? parseInt(channel.statistics.viewCount, 10)       : null;
  result.raw_metrics         = { discovery: { platform: "youtube", username: clean, channelId: channel.id, source: "youtube_data_api" } } as unknown as SocialAnalyticsRaw;
  result.toolsCalled         = ["youtube_data_api"];
  const native: YouTubeDiscoveryNative = {
    platform: "youtube", accountId: String(channel.id), handle: channel.snippet?.customUrl ?? channel.snippet?.title ?? clean,
    fetchedAt: new Date().toISOString(), apiVersion: "v3", sourceMethod: "youtube_data_api",
    toolsCalled: ["youtube_data_api"], errors: [], channel, videos: [],
  };
  return { found: true, result, error: null, native };
}
