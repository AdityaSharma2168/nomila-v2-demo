/**
 * social/native.ts — the native envelopes each platform fetch returns.
 *
 * These are Nomila's OWN shapes for "what the provider said", one per platform and one per
 * public-discovery path. They are deliberately close to the wire so nothing useful is
 * normalised away at fetch time (spec §28.5); the adapters turn them into canonical rows and the
 * integration modules project them into the legacy display contract. Envelopes are built by
 * server/lib/integrations/*.ts and consumed here — the dependency points INTO this directory,
 * never out of it (boundary.test.ts).
 *
 * Envelopes are sanitized before they reach any table (sanitize.ts); until then they may hold
 * signed CDN URLs, which the display projection still needs for the newest daily row.
 */

export type SocialPlatform = "instagram" | "tiktok" | "youtube";

export interface EnvelopeBase {
  platform:   SocialPlatform;
  /** The platform's own account id (IG user id, TikTok open_id, YouTube channel id). */
  accountId:  string;
  handle:     string | null;
  /** ISO instant the fetch ran. Point-in-time metrics are observed at this instant. */
  fetchedAt:  string;
  apiVersion: string;
  /** The exact provider path, e.g. oauth_instagram_login | meta_business_discovery | youtube_data_api. */
  sourceMethod: string;
  toolsCalled: string[];
  /** Sub-calls that failed, so a partial run is recorded as partial. */
  errors:     Array<{ step: string; message: string }>;
}

// ─── Instagram (connected, Instagram Login) ──────────────────────────────────

export interface IgInsightEntry { name?: string; period?: string; total_value?: { value?: number; breakdowns?: Array<{ dimension_keys?: string[]; results?: Array<{ dimension_values?: string[]; value?: number }> }> }; values?: Array<{ value?: number; end_time?: string }> }
export interface IgMediaNode {
  id: string; permalink?: string; media_type?: string; media_product_type?: string; caption?: string; timestamp?: string;
  media_url?: string; thumbnail_url?: string; like_count?: number; comments_count?: number; is_shared_to_feed?: boolean;
  insights?: { data?: IgInsightEntry[] };
  children?: { data?: Array<{ id: string; media_type?: string; media_url?: string; thumbnail_url?: string }> };
}
export interface IgBreakdownRow { key: string; value: number; pct: number }

export interface InstagramNative extends EnvelopeBase {
  platform: "instagram";
  profile: { id: string; username?: string; followers_count?: number; follows_count?: number; media_count?: number };
  /** The /insights response (period=day, metric_type=total_value) or null when the call failed. */
  accountInsights: { data?: IgInsightEntry[] } | null;
  media: IgMediaNode[];
  mediaFetchMode: "with_insights" | "bare" | "failed";
  /** follower_demographics by breakdown; only present when the call succeeded (≥100 followers). */
  demographics: Partial<Record<"country" | "city" | "age" | "gender", IgBreakdownRow[]>>;
}

// ─── TikTok (connected, Display API) ─────────────────────────────────────────

export interface TtVideo {
  id?: string | number; create_time?: number; view_count?: number; like_count?: number; comment_count?: number; share_count?: number;
  duration?: number; title?: string; video_description?: string; cover_image_url?: string; share_url?: string;
}
export interface TikTokNative extends EnvelopeBase {
  platform: "tiktok";
  user: { open_id?: string; display_name?: string; username?: string; bio_description?: string; follower_count?: number; following_count?: number; likes_count?: number; video_count?: number; is_verified?: boolean };
  videos: TtVideo[];
  /** creator/info demographics when DEMOGRAPHICS_ENABLED and the call succeeded. */
  demographics: { country: IgBreakdownRow[]; gender: IgBreakdownRow[]; age: IgBreakdownRow[] } | null;
}

// ─── YouTube (connected, Data API + Analytics API) ───────────────────────────

export interface YtVideo {
  id: string; snippet?: { title?: string; description?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string }> };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }; contentDetails?: { duration?: string }; topicDetails?: { topicCategories?: string[] };
}
export interface YtReport { columnHeaders: Array<{ name: string }>; rows?: unknown[][] }
export interface YouTubeNative extends EnvelopeBase {
  platform: "youtube";
  channel: { id: string; snippet?: { title?: string; customUrl?: string; description?: string }; statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string } };
  /** Analytics reports keyed by name; absent when the call failed. Window is [reportStart, reportEnd]. */
  analytics: { reportStart: string; reportEnd: string; totals?: YtReport; ageGender?: YtReport; countries?: YtReport; traffic?: YtReport; devices?: YtReport };
  videos: YtVideo[];
}

// ─── Public discovery ────────────────────────────────────────────────────────

export interface InstagramDiscoveryNative extends EnvelopeBase {
  platform: "instagram";
  sourceMethod: "meta_business_discovery";
  businessDiscovery: { id?: string; username?: string; biography?: string; followers_count?: number; media_count?: number; website?: string; media?: { data?: Array<{ id?: string; like_count?: number; comments_count?: number; timestamp?: string; media_type?: string }> } };
}
export interface YouTubeDiscoveryNative extends EnvelopeBase {
  platform: "youtube";
  sourceMethod: "youtube_data_api";
  channel: YouTubeNative["channel"];
  videos: YtVideo[];
}

export type SocialNative = InstagramNative | TikTokNative | YouTubeNative | InstagramDiscoveryNative | YouTubeDiscoveryNative;

/** Pull a numeric value out of an insights `data[]` entry (total_value or the latest time-series point). */
export function igMetricValue(data: IgInsightEntry[] | undefined, name: string): number | null {
  const m = data?.find((d) => d?.name === name);
  if (!m) return null;
  if (typeof m.total_value?.value === "number") return m.total_value.value;
  const vals = m.values;
  if (Array.isArray(vals) && vals.length) {
    const v = vals[vals.length - 1]?.value;
    if (typeof v === "number") return v;
  }
  return null;
}

/** ISO 8601 duration (PT1H2M3S) → seconds. */
export function isoDurationSeconds(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return parseInt(m[1] ?? "0", 10) * 3600 + parseInt(m[2] ?? "0", 10) * 60 + parseInt(m[3] ?? "0", 10);
}

// ─── Instagram Stories (Step 1b) ─────────────────────────────────────────────

/** How a provider call failed, by Meta error CODE (classified in lib/integrations/metaErrors.ts). Only `auth` may expire a connection. */
export type ProviderErrorClass = "auth" | "permission" | "not_enough_viewers" | "unsupported_metric" | "rate_limited" | "transient" | "unknown";

export interface IgStoryNode {
  id: string;
  media_type?: string;            // IMAGE | VIDEO — a subtype kept in the raw payload only (decision O3)
  media_product_type?: string;    // STORY
  timestamp?: string;
  is_shared_to_feed?: boolean;
}

/** GET /{ig-user-id}/stories — the live Stories (≤ 24 h). media_url / thumbnail_url are never requested (O4). */
export interface InstagramStoriesNative extends EnvelopeBase {
  platform: "instagram";
  /** Live Stories. Empty AND `listingError` unset = a real empty provider response. */
  stories: IgStoryNode[];
  /** Set when GET /stories itself failed: the provider's actual response body (sanitized before storage). No `listed` observation and no `{data: []}` payload is ever written for a failed listing. */
  listingError?: { httpStatus: number; body: unknown } | null;
}

export interface IgStoryCallError { step: string; message: string; class: ProviderErrorClass; code?: number; subcode?: number; type?: string; httpStatus?: number }

/** The three insight sub-responses for one Story, each stored as its own raw payload family. */
export interface IgStoryInsightsNative {
  storyId: string;
  story: IgStoryNode;
  fetchedAt: string;
  /** /insights?metric=<requestedMetrics> — family story_insights. */
  insights: { data?: IgInsightEntry[] } | null;
  /** /insights?metric=navigation&breakdown=story_navigation_action_type — family story_navigation. */
  navigation: { data?: IgInsightEntry[] } | null;
  /** /insights?metric=profile_activity&breakdown=action_type — family story_profile_activity. */
  profileActivity: { data?: IgInsightEntry[] } | null;
  requestedMetrics: string[];
  /** Documented metrics the provider rejected for this media (O7): omitted, recorded absent, never zero. */
  unsupportedMetrics: string[];
  errors: IgStoryCallError[];
}

/** Breakdown results of an insight entry: dimension value → count. */
export function igBreakdown(data: IgInsightEntry[] | undefined, name: string): Record<string, number> {
  const m = data?.find((d) => d?.name === name) as any;
  const out: Record<string, number> = {};
  for (const b of m?.total_value?.breakdowns ?? []) {
    for (const r of b?.results ?? []) {
      const key = Array.isArray(r?.dimension_values) ? String(r.dimension_values[0]) : null;
      if (key && typeof r?.value === "number") out[key.toUpperCase()] = r.value;
    }
  }
  return out;
}
