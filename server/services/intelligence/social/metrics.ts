/**
 * social/metrics.ts — the metric and feature registries (spec §28.6, Step 1 design §4–5).
 *
 * Every observation row names a metric from METRICS and the definition version that produced
 * it; every feature row names a feature from FEATURES and the calculation version. Keys are
 * platform-neutral; a key absent on a platform is simply absent — never zero. Nothing here is
 * called "engagement rate": each derived metric names its denominator.
 *
 * Types only plus constants; no runtime dependencies.
 */

export const METRIC_DEFINITION_VERSION = "v1";
/**
 * v2 (15 Sep 2026) — two corrections, both of which change stored values, so existing features must be recomputed:
 *   1. Story observations are no longer pooled into the feed-content aggregates. Until v1 they were: the content filter
 *      excluded carousel_frame only, so Story reach and views were averaged together with post and reel reach in
 *      reach_median, reach_per_follower_median, interactions_per_reach_median and every other aggregate. Stories have
 *      very different reach characteristics; the resulting numbers described no real quantity.
 *   2. Story-specific features exist (story_retention_proxy, story_tap_forward_rate, story_reach_per_follower) and
 *      YouTube account-level retention is exposed (avg_view_pct_account).
 */
/**
 * v3 (16 Sep 2026) — retention validity. The FORMULA for avg_view_pct_account is unchanged, but the SET of features
 * produced from identical observations is not: v2 emitted the provider's 0 for a channel with no views, v3 emits
 * nothing because an average view percentage over zero views is undefined rather than zero.
 *
 * That difference propagates into the authoritative block, an evaluator judgment and ultimately a MIA score, so it
 * has to be reconstructable later: "why did the same athlete evidence produce different blocks before and after this
 * date?" is a question calculation_version exists to answer.
 */
export const FEATURE_CALCULATION_VERSION = "v3";

export type MetricEntity = "account" | "content" | "audience";
export type MetricUnit = "count" | "ratio" | "seconds" | "percent";
export type MetricWindow = "point" | "day" | "30d" | "static";

export interface MetricDefinition {
  entity:      MetricEntity;
  unit:        MetricUnit;
  window:      MetricWindow;
  /** Which platforms can produce it, and the native field it comes from. */
  platforms:   Partial<Record<"instagram" | "tiktok" | "youtube", string>>;
  description: string;
}

/** Observed metrics: facts a provider states. */
export const METRICS = {
  // ── account, point in time ─────────────────────────────────────────────────
  followers:          { entity: "account", unit: "count", window: "point",  platforms: { instagram: "followers_count", tiktok: "follower_count" }, description: "Accounts following this account." },
  subscribers:        { entity: "account", unit: "count", window: "point",  platforms: { youtube: "statistics.subscriberCount" }, description: "YouTube subscribers. Distinct from followers by design." },
  following:          { entity: "account", unit: "count", window: "point",  platforms: { instagram: "follows_count", tiktok: "following_count" }, description: "Accounts this account follows." },
  content_count:      { entity: "account", unit: "count", window: "point",  platforms: { instagram: "media_count", tiktok: "video_count", youtube: "statistics.videoCount" }, description: "Total published items reported by the platform." },
  likes_total:        { entity: "account", unit: "count", window: "point",  platforms: { tiktok: "likes_count" }, description: "Lifetime likes across the account." },
  views_total:        { entity: "account", unit: "count", window: "point",  platforms: { youtube: "statistics.viewCount" }, description: "Lifetime channel views." },
  is_verified:        { entity: "account", unit: "count", window: "point",  platforms: { tiktok: "is_verified" }, description: "1 when the platform marks the account verified, else 0." },
  // ── account, windowed ──────────────────────────────────────────────────────
  account_reach:      { entity: "account", unit: "count", window: "day",    platforms: { instagram: "insights.reach (period=day)" }, description: "Unique accounts reached in the day." },
  account_views:      { entity: "account", unit: "count", window: "day",    platforms: { instagram: "insights.views (period=day)" }, description: "Views in the day (Graph v22+ views; formerly impressions)." },
  profile_link_taps:  { entity: "account", unit: "count", window: "day",    platforms: { instagram: "insights.profile_links_taps (period=day)" }, description: "Taps on profile links in the day." },
  views_30d:          { entity: "account", unit: "count", window: "30d",    platforms: { youtube: "analytics views" }, description: "Channel views in the trailing 30 days." },
  minutes_watched_30d:{ entity: "account", unit: "count", window: "30d",    platforms: { youtube: "analytics estimatedMinutesWatched" }, description: "Minutes watched in the trailing 30 days." },
  avg_view_pct_30d:   { entity: "account", unit: "percent", window: "30d",  platforms: { youtube: "analytics averageViewPercentage" }, description: "Average percentage of a video watched, trailing 30 days." },
  avg_view_duration_30d: { entity: "account", unit: "seconds", window: "30d", platforms: { youtube: "analytics averageViewDuration" }, description: "Average view duration, trailing 30 days." },
  subs_gained_30d:    { entity: "account", unit: "count", window: "30d",    platforms: { youtube: "analytics subscribersGained" }, description: "Subscribers gained, trailing 30 days." },
  subs_lost_30d:      { entity: "account", unit: "count", window: "30d",    platforms: { youtube: "analytics subscribersLost" }, description: "Subscribers lost, trailing 30 days." },
  // ── content, point in time ─────────────────────────────────────────────────
  like_count:         { entity: "content", unit: "count", window: "point",  platforms: { instagram: "like_count", tiktok: "like_count", youtube: "statistics.likeCount" }, description: "Likes on the item at observation." },
  comments_count:     { entity: "content", unit: "count", window: "point",  platforms: { instagram: "comments_count", tiktok: "comment_count", youtube: "statistics.commentCount" }, description: "Comments on the item at observation." },
  share_count:        { entity: "content", unit: "count", window: "point",  platforms: { instagram: "insights.shares", tiktok: "share_count" }, description: "Shares of the item at observation." },
  save_count:         { entity: "content", unit: "count", window: "point",  platforms: { instagram: "insights.saved" }, description: "Saves of the item at observation." },
  view_count:         { entity: "content", unit: "count", window: "point",  platforms: { instagram: "insights.views (video/reel; Story views when entity_format = story)", tiktok: "view_count", youtube: "statistics.viewCount" }, description: "Views of the item at observation. Platform definitions differ and are never pooled." },
  reach:              { entity: "content", unit: "count", window: "point",  platforms: { instagram: "insights.reach" }, description: "Unique accounts reached by the item." },
  total_interactions: { entity: "content", unit: "count", window: "point",  platforms: { instagram: "insights.total_interactions" }, description: "Provider-summed interactions on the item." },
  avg_watch_time_sec: { entity: "content", unit: "seconds", window: "point", platforms: { instagram: "insights.ig_reels_avg_watch_time (ms → s)" }, description: "Average watch time of a reel." },
  duration_sec:       { entity: "content", unit: "seconds", window: "static", platforms: { tiktok: "duration", youtube: "contentDetails.duration" }, description: "Length of the video." },
  // ── Instagram Stories (Step 1b): cumulative counts at observation, entity_format = story ──
  listed:                 { entity: "content", unit: "count", window: "point", platforms: { instagram: "/{ig-user-id}/stories (presence)" }, description: "1 when the provider listed the item as live at observation. A presence fact, never an insight reading." },
  reply_count:            { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.replies (STORY)" }, description: "Story replies. Meta reports 0 for creators in Europe and Japan; stored as reported, no feature reads it until region is known." },
  profile_visits:         { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.profile_visits (STORY)" }, description: "Profile visits attributed to the Story." },
  follows:                { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.follows (STORY)" }, description: "Follows attributed to the Story." },
  story_nav_swipe_forward:{ entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.navigation[story_navigation_action_type=SWIPE_FORWARD]" }, description: "Swipes to the next account's story." },
  story_nav_tap_back:     { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.navigation[story_navigation_action_type=TAP_BACK]" }, description: "Taps back to the previous story." },
  story_nav_tap_exit:     { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.navigation[story_navigation_action_type=TAP_EXIT]" }, description: "Exits from the Story." },
  story_nav_tap_forward:  { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.navigation[story_navigation_action_type=TAP_FORWARD]" }, description: "Taps forward to the next story." },
  story_profile_activity_bio_link_clicked: { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.profile_activity[action_type=BIO_LINK_CLICKED]" }, description: "Bio link clicks from the Story." },
  story_profile_activity_call:      { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.profile_activity[action_type=CALL]" }, description: "Call actions from the Story." },
  story_profile_activity_direction: { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.profile_activity[action_type=DIRECTION]" }, description: "Direction actions from the Story." },
  story_profile_activity_email:     { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.profile_activity[action_type=EMAIL]" }, description: "Email actions from the Story." },
  story_profile_activity_other:     { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.profile_activity[action_type=OTHER]" }, description: "Other profile actions from the Story." },
  story_profile_activity_text:      { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.profile_activity[action_type=TEXT]" }, description: "Text actions from the Story." },
  link_clicks:            { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.link_clicks (STORY, conditional)" }, description: "Link clicks on the Story. Documented; probed at run time and absent when the provider rejects it." },
  reposts:                { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.reposts (STORY, conditional)" }, description: "Reposts of the Story. Documented; probed at run time and absent when the provider rejects it." },
  facebook_views:         { entity: "content", unit: "count", window: "point", platforms: { instagram: "insights.facebook_views (STORY, conditional)" }, description: "Views on Facebook of a cross-posted Story. Documented; probed at run time and absent when the provider rejects it." },
} as const satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRICS;

export function isMetricKey(k: string): k is MetricKey {
  return Object.prototype.hasOwnProperty.call(METRICS, k);
}

/** Derived features: numbers we compute from observations for a window ending at as_of. */
export interface FeatureDefinition {
  unit:        MetricUnit | "days" | "json" | "posts_per_week";
  /** true when the value is Nomila's interpretation of evidence rather than an aggregate of it. */
  inferred?:   boolean;
  description: string;
}

export const FEATURES = {
  followers_latest:              { unit: "count",  description: "Most authoritative fresh followers (or subscribers) observation at as_of." },
  followers_growth_abs:          { unit: "count",  description: "followers at as_of minus followers at as_of − window." },
  followers_growth_pct:          { unit: "percent", description: "Growth over the window as a percentage of the earlier value." },
  content_n:                     { unit: "count",  description: "Content items posted in the window with at least one observation." },
  views_median:                  { unit: "count",  description: "Median view_count across items in the window." },
  views_p25:                     { unit: "count",  description: "25th percentile of view_count." },
  views_p75:                     { unit: "count",  description: "75th percentile of view_count." },
  views_p90:                     { unit: "count",  description: "90th percentile of view_count." },
  reach_median:                  { unit: "count",  description: "Median reach across items (Instagram connected only)." },
  reach_p75:                     { unit: "count",  description: "75th percentile of reach." },
  reach_p90:                     { unit: "count",  description: "90th percentile of reach." },
  likes_median:                  { unit: "count",  description: "Median like_count." },
  comments_median:               { unit: "count",  description: "Median comments_count." },
  saves_median:                  { unit: "count",  description: "Median save_count." },
  shares_median:                 { unit: "count",  description: "Median share_count." },
  engagement_per_follower_median:{ unit: "ratio",  description: "Median of (like_count + comments_count) ÷ followers at the item's observation time." },
  interactions_per_reach_median: { unit: "ratio",  description: "Median of total_interactions ÷ reach (Instagram connected only)." },
  interactions_per_view_median:  { unit: "ratio",  description: "Median of (like_count + comments_count + share_count) ÷ view_count." },
  views_per_follower_median:     { unit: "ratio",  description: "Median of view_count ÷ followers." },
  reach_per_follower_median:     { unit: "ratio",  description: "Median of reach ÷ followers (reach efficiency)." },
  saves_per_1k_reach_median:     { unit: "ratio",  description: "Median of save_count × 1000 ÷ reach." },
  shares_per_1k_reach_median:    { unit: "ratio",  description: "Median of share_count × 1000 ÷ reach." },
  shares_per_1k_views_median:    { unit: "ratio",  description: "Median of share_count × 1000 ÷ view_count." },
  completion_pct_median:         { unit: "percent", description: "Median of avg_watch_time_sec ÷ duration_sec where both are known." },
  non_follower_reach_share:      { unit: "ratio",  inferred: true, description: "Share of items whose reach ≥ 2 × followers. A Nomila heuristic for broad non-follower distribution, not provider proof of a trial/discovery reel." },
  breakout_rate:                 { unit: "ratio",  description: "Share of items whose views (or reach) ≥ 3 × the window median." },
  top_decile_share:              { unit: "ratio",  description: "Share of total views (or reach) contributed by the top 10% of items." },
  performance_cv:                { unit: "ratio",  description: "Coefficient of variation of views (or reach) across items." },
  posts_per_week:                { unit: "posts_per_week", description: "Items posted in the window ÷ weeks in the window." },
  days_since_last_post:          { unit: "days",   description: "Days from the most recent posted item to as_of." },
  format_mix:                    { unit: "json",   description: "Share of items by content_format." },
  views_median_by_format:        { unit: "json",   description: "Median view_count per content_format, with n per format." },
  reach_median_by_format:        { unit: "json",   description: "Median reach per content_format, with n per format." },
  audience_top_country_share:    { unit: "percent", description: "Share of the largest country bucket (basis preserved in inputs)." },
  audience_country_distribution: { unit: "json",   description: "Full country distribution, latest observation." },
  audience_gender_share:         { unit: "json",   description: "Gender distribution, latest observation." },
  audience_age_distribution:     { unit: "json",   description: "Age distribution, latest observation." },
  audience_geo_concentration:    { unit: "ratio",  description: "Herfindahl index over the country distribution (1 = one country)." },
  effective_reach_cross_platform:{ unit: "count",  description: "Sum over platforms of reach_median where present, else views_median; excluded platforms are named in inputs." },
  platform_breadth:              { unit: "count",  description: "Platforms with at least one content item in the window." },
  /**
   * Story features (v2). Computed from entity_format = "story" observations ONLY, never pooled with feed content.
   * These are factual rates. The engagement_quality.story_efficiency JUDGMENT remains the evaluator's, made from these
   * numbers under the frozen rubric — there is deliberately no metric-to-score mapping here.
   * reply_count is excluded by design: Meta reports 0 for creators in Europe and Japan, so any rate built on it is
   * silently region-dependent.
   */
  story_retention_proxy:         { unit: "ratio",  description: "Median over stories of 1 - (story_nav_tap_exit / reach). Higher means fewer viewers exited the story." },
  story_tap_forward_rate:        { unit: "ratio",  description: "Median over stories of story_nav_tap_forward / reach. Higher means more viewers skipped ahead." },
  story_reach_per_follower:      { unit: "ratio",  description: "Median over stories of reach / followers at observation." },
  /**
   * YouTube account-level retention (v2). Deliberately a SEPARATE key from completion_pct_median, which is Instagram
   * reel watch-time over duration: averaging a channel-level average-view-percentage with per-reel completion would
   * repeat the Story mistake in a different place.
   */
  avg_view_pct_account:          { unit: "percent", description: "Provider-reported average percentage of the video viewed, account level over the window (YouTube Analytics averageViewPercentage)." },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureKey = keyof typeof FEATURES;

/** Canonical content formats (media_assets.content_format). */
export const CONTENT_FORMATS = ["post", "reel", "story", "carousel", "carousel_frame", "video", "short", "long_form"] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];
