import { createLogger } from "../logger";
import type { SnapshotSocial } from "../services/snapshotSocial";
import {
  IG_FIELDS, requestInstagramBusinessDiscovery, requestYouTubeChannel, requestYouTubePlaylistItems, requestYouTubeVideos,
  type ProviderCall,
} from "./integrations/discovery";

const logger = createLogger("platform-discovery");

const YOUTUBE_API_KEY  = process.env.YOUTUBE_DATA_API_KEY;
// Business Discovery runs from Nomila's own IG business account (Facebook-Login token).
// Same secret as discovery.ts — one token to maintain. Falls back to IG_PAGE_ACCESS_TOKEN
// for backward compat if the new vars aren't set yet.
const IG_TOKEN         = process.env.DISCOVERY_IG_TOKEN      ?? process.env.IG_PAGE_ACCESS_TOKEN;
const IG_ACCOUNT_ID    = process.env.DISCOVERY_IG_BUSINESS_ID ?? process.env.IG_BUSINESS_ACCOUNT_ID;
// The endpoints themselves (and the one Graph version) live in integrations/discovery.ts; this
// file keeps only the legacy mapping and failure policy.

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return parseInt(m[1] ?? "0", 10) * 3600
       + parseInt(m[2] ?? "0", 10) * 60
       + parseInt(m[3] ?? "0", 10);
}

/**
 * The legacy failure policy over a client call: a transport failure throws (the runner then drops
 * the platform), a non-2xx returns null (the caller degrades to what it has), and only a 2xx body
 * is parsed — an unreadable 2xx body throws, as `await resp.json()` did.
 */
function okBody(call: ProviderCall): any | null {
  if (call.kind === "network") throw call.cause;
  if (!call.httpOk) return null;
  if (call.kind === "unparseable") throw call.cause;
  return call.body;
}

// ─── YouTube Discovery ────────────────────────────────────────────────────────
// 3 API calls: channels.list → playlistItems.list → videos.list
// Total quota cost: ~3 units (vs 100+ for search-based approach)

interface YouTubeDiscovery {
  handle:           string;
  channel_id:       string;
  subscribers:      number;
  avg_views:        number;
  avg_likes:        number;
  avg_comments:     number;
  engagement_rate:  number;
  posts_last_30d:   number;
  topic_categories: string[];
  short_form_ratio: number;
  fetched_at:       string;
  source:           "data_api";
}

async function discoverYouTube(handle: string): Promise<YouTubeDiscovery | null> {
  if (!YOUTUBE_API_KEY) return null;

  const cleanHandle = handle.replace(/^@/, "");
  const fetchedAt   = new Date().toISOString();

  // Step 1: Channel lookup
  const chanData = okBody(await requestYouTubeChannel(cleanHandle, { key: YOUTUBE_API_KEY, part: "snippet,statistics,contentDetails", timeoutMs: 8_000 }));
  if (!chanData) return null;
  const channel  = chanData.items?.[0];
  if (!channel) return null;

  const channelId       = channel.id as string;
  // A hidden count is reported as 0 here, not null (the client's raw `subscribers` is null): the
  // frozen legacy score reads this value, so it keeps its historical meaning.
  const subscriberCount = parseInt(channel.statistics?.subscriberCount ?? "0", 10) || 0;
  const videoCount      = parseInt(channel.statistics?.videoCount      ?? "0", 10) || 0;
  const totalViews      = parseInt(channel.statistics?.viewCount       ?? "0", 10) || 0;
  const uploadsId       = channel.contentDetails?.relatedPlaylists?.uploads as string | undefined;

  const bare: YouTubeDiscovery = {
    handle: `@${cleanHandle}`, channel_id: channelId,
    subscribers: subscriberCount,
    avg_views: videoCount > 0 ? Math.round(totalViews / videoCount) : 0,
    avg_likes: 0, avg_comments: 0, engagement_rate: 0, posts_last_30d: 0,
    topic_categories: [], short_form_ratio: 0,
    fetched_at: fetchedAt, source: "data_api",
  };

  if (!uploadsId || subscriberCount === 0) return bare;

  // Step 2: Recent video IDs + timestamps from uploads playlist
  const plData = okBody(await requestYouTubePlaylistItems(uploadsId, { key: YOUTUBE_API_KEY, part: "snippet", maxResults: 10, timeoutMs: 8_000 }));
  if (!plData) return bare;

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let postsLast30d = 0;
  const videoIds: string[] = [];

  for (const item of (plData.items ?? []) as any[]) {
    const id = item.snippet?.resourceId?.videoId as string | undefined;
    if (id) videoIds.push(id);
    const pub = item.snippet?.publishedAt as string | undefined;
    if (pub && new Date(pub).getTime() > thirtyDaysAgo) postsLast30d++;
  }

  if (videoIds.length === 0) return { ...bare, posts_last_30d: postsLast30d };

  // Step 3: Per-video stats, content details, topic categories
  const vidData = okBody(await requestYouTubeVideos(videoIds, { key: YOUTUBE_API_KEY, part: "statistics,contentDetails,topicDetails", timeoutMs: 8_000 }));
  if (!vidData) return { ...bare, posts_last_30d: postsLast30d };
  const videos  = (vidData.items ?? []) as any[];

  let totalLikes = 0, totalComments = 0, totalViewsRecent = 0, shortFormCount = 0;
  const topicSet = new Set<string>();

  for (const v of videos) {
    totalLikes         += parseInt(v.statistics?.likeCount    ?? "0", 10) || 0;
    totalComments      += parseInt(v.statistics?.commentCount ?? "0", 10) || 0;
    totalViewsRecent   += parseInt(v.statistics?.viewCount    ?? "0", 10) || 0;
    if (parseDuration(v.contentDetails?.duration ?? "") < 60) shortFormCount++;
    for (const catUrl of (v.topicDetails?.topicCategories ?? []) as string[]) {
      const topic = decodeURIComponent(catUrl.split("/").pop() ?? "");
      if (topic) topicSet.add(topic);
    }
  }

  const count       = videos.length;
  const avgLikes    = count > 0 ? Math.round(totalLikes    / count) : 0;
  const avgComments = count > 0 ? Math.round(totalComments / count) : 0;
  const avgViews    = count > 0 ? Math.round(totalViewsRecent / count) : 0;
  const engRate     = subscriberCount > 0 && count > 0
    ? Math.round(((avgLikes + avgComments) / subscriberCount) * 10000) / 100
    : 0;

  logger.info({ handle, channelId, subscriberCount, engRate, postsLast30d }, "YouTube discovery complete");

  return {
    handle: `@${cleanHandle}`, channel_id: channelId,
    subscribers:      subscriberCount,
    avg_views:        avgViews,
    avg_likes:        avgLikes,
    avg_comments:     avgComments,
    engagement_rate:  engRate,
    posts_last_30d:   postsLast30d,
    topic_categories: Array.from(topicSet),
    short_form_ratio: count > 0 ? Math.round((shortFormCount / count) * 100) / 100 : 0,
    fetched_at:       fetchedAt,
    source:           "data_api",
  };
}

// ─── Instagram Discovery ──────────────────────────────────────────────────────
// Single call with nested media fields (fallback to profile-only if permissions fail)
// Requires: IG_PAGE_ACCESS_TOKEN + IG_BUSINESS_ACCOUNT_ID in Secret Manager

interface InstagramDiscovery {
  handle:          string;
  followers:       number;
  media_count:     number;
  avg_likes:       number;
  avg_comments:    number;
  engagement_rate: number;
  posts_last_30d:  number;
  website:         string | null;
  fetched_at:      string;
  source:          "business_discovery";
}

async function discoverInstagram(handle: string): Promise<InstagramDiscovery | null> {
  if (!IG_TOKEN || !IG_ACCOUNT_ID) return null;

  const cleanHandle = handle.replace(/^@/, "");
  const auth        = { igBusinessId: IG_ACCOUNT_ID, token: IG_TOKEN };
  const fetchedAt   = new Date().toISOString();

  // Attempt: profile + nested media (like_count, comments_count, timestamp)
  let call = await requestInstagramBusinessDiscovery(cleanHandle, { auth, fields: IG_FIELDS.legacy, timeoutMs: 10_000 });
  // Retry profile-only if media nesting hits a permissions error
  if (call.kind === "response" && (call.body?.error?.code === 200 || call.body?.error?.code === 10 || call.body?.error?.type === "OAuthException")) {
    call = await requestInstagramBusinessDiscovery(cleanHandle, { auth, fields: IG_FIELDS.legacyProfileOnly, timeoutMs: 10_000 });
  }
  if (call.kind !== "response") {
    logger.warn({ handle, error: (call.cause as { message?: string } | null)?.message?.slice(0, 120) }, "Instagram discovery network error");
    return null;
  }
  const data = call.body;

  if (data.error) {
    const { code, error_subcode: subcode, message } = data.error;
    // Personal accounts and "user not found" — common for college athletes, log at debug
    if (code === 100 || code === 803 || code === 190 || code === 110 || subcode === 2207013) {
      logger.debug({ handle, code, subcode }, "Instagram: account not accessible (personal/not found)");
    } else {
      logger.warn({ handle, code, message: (message ?? "").slice(0, 120) }, "Instagram discovery API error");
    }
    return null;
  }

  const d = data.business_discovery;
  if (!d) return null;

  const followers  = (d.followers_count ?? 0)  as number;
  const mediaCount = (d.media_count     ?? 0)  as number;
  const website    = (d.website         ?? null) as string | null;
  const posts      = (d.media?.data     ?? [])  as any[];

  let totalLikes = 0, totalComments = 0, recentPosts = 0;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const post of posts) {
    totalLikes    += (post.like_count     ?? 0) as number;
    totalComments += (post.comments_count ?? 0) as number;
    if (post.timestamp && new Date(post.timestamp).getTime() > thirtyDaysAgo) recentPosts++;
  }

  const count       = posts.length;
  const avgLikes    = count > 0 ? Math.round(totalLikes    / count) : 0;
  const avgComments = count > 0 ? Math.round(totalComments / count) : 0;
  const engRate     = followers > 0 && count > 0
    ? Math.round(((avgLikes + avgComments) / followers) * 10000) / 100
    : 0;

  logger.info({ handle, followers, engRate, recentPosts }, "Instagram discovery complete");

  return {
    handle: `@${cleanHandle}`,
    followers, media_count: mediaCount,
    avg_likes: avgLikes, avg_comments: avgComments,
    engagement_rate: engRate, posts_last_30d: recentPosts,
    website, fetched_at: fetchedAt, source: "business_discovery",
  };
}

// ─── Combined runner ──────────────────────────────────────────────────────────

export async function runPlatformDiscovery(
  handles: { youtube?: string | null; instagram?: string | null; x?: string | null; tiktok?: string | null },
): Promise<SnapshotSocial | null> {
  const tasks: Promise<void>[] = [];
  const social: SnapshotSocial = {};

  if (handles.youtube) {
    tasks.push(
      discoverYouTube(handles.youtube)
        .then(r => {
          if (!r) return;
          social.youtube = {
            handle:           r.handle,
            subscribers:      r.subscribers,
            engagement_rate:  r.engagement_rate,
            avg_likes:        r.avg_likes,
            avg_comments:     r.avg_comments,
            avg_views:        r.avg_views,
            posts_last_30d:   r.posts_last_30d,
            topic_categories: r.topic_categories.length > 0 ? r.topic_categories : undefined,
            short_form_ratio: r.short_form_ratio > 0 ? r.short_form_ratio : undefined,
            fetched_at:       r.fetched_at,
            source:           r.source,
          };
        })
        .catch(err => logger.warn({ handle: handles.youtube, error: err.message }, "YouTube discovery threw")),
    );
  }

  // Instagram — Business Discovery on the handle we hold (unconnected path only; connected athletes are handled
  // upstream via fetchForScoring where the handle is already authorized). The Claude web-search handle resolver that
  // used to run first was retired 4 Nov 2026 (one search provider, owner decision): her connected account, or the
  // handle she typed or research found, is how a handle is known; nothing here searches the web.
  if (handles.instagram) {
    const handleForBD = handles.instagram;
    tasks.push((async () => {
      const r = await discoverInstagram(handleForBD).catch(err => {
        logger.warn({ handle: handleForBD, error: err.message }, "Instagram discovery threw");
        return null;
      });
      if (!r) return;
      social.instagram = {
        handle:          r.handle,
        followers:       r.followers,
        media_count:     r.media_count,
        engagement_rate: r.engagement_rate,
        avg_likes:       r.avg_likes,
        avg_comments:    r.avg_comments,
        posts_last_30d:  r.posts_last_30d,
        website:         r.website ?? undefined,
        fetched_at:      r.fetched_at,
        source:          r.source,
      };
    })());
  }

  await Promise.all(tasks);

  const hasPlatforms = !!(social.instagram || social.youtube || social.tiktok || social.x);
  if (!hasPlatforms) return null;

  const totalFollowers =
    (social.instagram?.followers ?? 0) +
    (social.tiktok?.followers    ?? 0) +
    (social.x?.followers         ?? 0) +
    (social.youtube?.subscribers ?? 0);

  const rates = [
    social.instagram?.engagement_rate,
    social.tiktok?.engagement_rate,
    social.x?.engagement_rate,
    social.youtube?.engagement_rate,
  ].filter((r): r is number => r !== undefined && r > 0);

  const avgEngagementRate = rates.length > 0
    ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length * 100) / 100
    : 0;

  const contentFrequency = Math.max(
    social.instagram?.posts_last_30d ?? 0,
    social.tiktok?.posts_last_30d    ?? 0,
    social.youtube?.posts_last_30d   ?? 0,
  );

  social._computed = {
    total_followers:     totalFollowers,
    avg_engagement_rate: avgEngagementRate,
    platform_count:      [social.instagram, social.tiktok, social.x, social.youtube].filter(Boolean).length,
    content_frequency:   contentFrequency > 0 ? contentFrequency : undefined,
    data_tier:           "discovery",
  };

  return social;
}
