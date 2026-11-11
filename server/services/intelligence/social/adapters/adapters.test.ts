/**
 * adapters.test.ts — native envelopes become canonical rows with the right keys, units,
 * windows and formats; absent provider fields stay absent (never zero).
 */

import { adaptInstagram, adaptStories, adaptStoryInsights, igContentFormat } from "./instagram";
import { adaptTikTok } from "./tiktok";
import { adaptYouTube, ytContentFormat } from "./youtube";
import { adaptInstagramDiscovery } from "./discovery";
import { adaptLegacySnapshot, adaptLegacyMediaAsset } from "./legacy";
import type { InstagramNative, TikTokNative, YouTubeNative, InstagramDiscoveryNative } from "../native";
import type { AdaptContext } from "./types";
import { adaptYouTubeDiscovery } from "./youtube";
import type { YouTubeDiscoveryNative } from "../native";

const AT = "2026-09-09T04:30:00.000Z";
const ctx = (platform: AdaptContext["platform"]): AdaptContext => ({ athleteId: "a", platform, sourceClass: "connected_verified", sourceMethod: "oauth_test", provider: "test", observedAt: AT });
const byKey = (obs: Array<{ entityType: string; entityId: string; metricKey: string; value: number }>, entity: string, key: string) => obs.filter((o) => o.entityId === entity && o.metricKey === key).map((o) => o.value);

describe("Instagram adapter", () => {
  const native: InstagramNative = {
    platform: "instagram", accountId: "17841401", handle: "mia", fetchedAt: AT, apiVersion: "v22.0", sourceMethod: "oauth_instagram_login", toolsCalled: [], errors: [],
    profile: { id: "17841401", username: "mia", followers_count: 22093, follows_count: 500, media_count: 300 },
    accountInsights: { data: [{ name: "reach", total_value: { value: 50944 } }, { name: "views", total_value: { value: 43166 } }] },
    media: [
      { id: "m1", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-09-01T10:00:00+0000", like_count: 120, comments_count: 4, is_shared_to_feed: false,
        insights: { data: [{ name: "reach", total_value: { value: 60000 } }, { name: "saved", total_value: { value: 30 } }, { name: "shares", total_value: { value: 12 } }, { name: "total_interactions", total_value: { value: 166 } }, { name: "ig_reels_avg_watch_time", total_value: { value: 4500 } }] } },
      { id: "m2", media_type: "CAROUSEL_ALBUM", timestamp: "2026-08-20T10:00:00+0000", like_count: 80, comments_count: 2, children: { data: [{ id: "c1", media_type: "IMAGE" }] } },
      { id: "m3", media_type: "IMAGE", timestamp: "2026-08-10T10:00:00+0000" },
    ],
    mediaFetchMode: "with_insights",
    demographics: { country: [{ key: "US", value: 9000, pct: 46 }, { key: "CA", value: 2300, pct: 12 }], gender: [{ key: "F", value: 12000, pct: 61 }] },
  };
  const r = adaptInstagram(native, ctx("instagram"));

  it("account metrics are point-in-time, insights are day-windowed", () => {
    expect(byKey(r.observations, "17841401", "followers")).toEqual([22093]);
    const reach = r.observations.find((o) => o.metricKey === "account_reach")!;
    expect(reach.value).toBe(50944);
    expect(reach.windowStart).toBe("2026-09-09T00:00:00.000Z");
    expect(reach.windowEnd).toBe(AT);
  });
  it("content metrics keep reach, saves, shares, interactions, views and watch time (ms → s)", () => {
    expect(byKey(r.observations, "m1", "reach")).toEqual([60000]);
    expect(byKey(r.observations, "m1", "save_count")).toEqual([30]);
    expect(byKey(r.observations, "m1", "share_count")).toEqual([12]);
    expect(byKey(r.observations, "m1", "total_interactions")).toEqual([166]);
    expect(byKey(r.observations, "m1", "avg_watch_time_sec")).toEqual([4.5]);
    expect(byKey(r.observations, "m1", "view_count")).toEqual([]);   // not requested in the universal metric list
  });
  it("an image with no counts yields no observations, not zeros", () => {
    expect(r.observations.filter((o) => o.entityId === "m3")).toEqual([]);
  });
  it("formats: reel, carousel, post; native keeps product type, grid flag and children", () => {
    expect(igContentFormat({ media_type: "VIDEO", media_product_type: "REELS" })).toBe("reel");
    const c = r.content.find((x) => x.sourceMediaId === "m1")!;
    expect(c.contentFormat).toBe("reel");
    expect(c.native).toMatchObject({ media_product_type: "REELS", is_shared_to_feed: false });
    expect(r.content.find((x) => x.sourceMediaId === "m2")!.native).toMatchObject({ children: [{ id: "c1", media_type: "IMAGE" }] });
    expect(r.content.find((x) => x.sourceMediaId === "m3")!.contentFormat).toBe("post");
  });
  it("does not record the discovery-reel heuristic as a fact", () => {
    expect(r.observations.some((o) => /discovery/.test(o.metricKey))).toBe(false);
  });
  it("demographics keep every bucket with basis followers and a 30-day window", () => {
    expect(r.distributions).toHaveLength(3);
    expect(r.distributions[0]).toMatchObject({ dimension: "country", bucket: "US", pct: 46, basis: "followers", windowEnd: AT });
  });
});

describe("TikTok adapter", () => {
  const native: TikTokNative = {
    platform: "tiktok", accountId: "open-1", handle: "mia", fetchedAt: AT, apiVersion: "v2", sourceMethod: "oauth_tiktok_display", toolsCalled: [], errors: [],
    user: { open_id: "open-1", username: "mia", follower_count: 15527, following_count: 300, likes_count: 900000, video_count: 92, is_verified: false },
    videos: [{ id: 7001, create_time: 1756000000, view_count: 200000, like_count: 15000, comment_count: 300, share_count: 800, duration: 21, title: "t", video_description: "desc #x" }],
    demographics: null,
  };
  const r = adaptTikTok(native, ctx("tiktok"));
  it("keeps platform-native fields and never invents reach or saves", () => {
    expect(byKey(r.observations, "7001", "view_count")).toEqual([200000]);
    expect(byKey(r.observations, "7001", "share_count")).toEqual([800]);
    expect(byKey(r.observations, "7001", "duration_sec")).toEqual([21]);
    expect(r.observations.some((o) => o.metricKey === "reach" || o.metricKey === "save_count")).toBe(false);
    expect(r.content[0].native).toMatchObject({ title: "t", video_description: "desc #x", duration: 21 });
    expect(r.content[0].postedAt).toBe(new Date(1756000000 * 1000).toISOString());
    expect(byKey(r.observations, "open-1", "is_verified")).toEqual([0]);
  });
});

describe("YouTube adapter", () => {
  const native: YouTubeNative = {
    platform: "youtube", accountId: "UC1", handle: "@mia", fetchedAt: AT, apiVersion: "v3", sourceMethod: "oauth_youtube", toolsCalled: [], errors: [],
    channel: { id: "UC1", statistics: { subscriberCount: "42", viewCount: "1000", videoCount: "3" } },
    analytics: { reportStart: "2026-08-10", reportEnd: "2026-09-09",
      totals: { columnHeaders: [{ name: "views" }, { name: "averageViewPercentage" }], rows: [[500, 41.2]] },
      ageGender: { columnHeaders: [{ name: "ageGroup" }, { name: "gender" }, { name: "viewerPercentage" }], rows: [["age18-24", "female", 30.5], ["age18-24", "male", 20]] },
      countries: { columnHeaders: [{ name: "country" }, { name: "views" }], rows: [["US", 300], ["CA", 100]] } },
    videos: [{ id: "v1", snippet: { title: "T", publishedAt: "2026-09-01T00:00:00Z" }, statistics: { viewCount: "120", likeCount: "5" }, contentDetails: { duration: "PT45S" } }, { id: "v2", snippet: { publishedAt: "2026-08-01T00:00:00Z" }, statistics: { viewCount: "50" }, contentDetails: { duration: "PT12M3S" } }],
  };
  const r = adaptYouTube(native, ctx("youtube"));
  it("uses subscribers (not followers), windows the analytics report, keeps bases distinct", () => {
    expect(byKey(r.observations, "UC1", "subscribers")).toEqual([42]);
    expect(r.observations.some((o) => o.metricKey === "followers")).toBe(false);
    const v30 = r.observations.find((o) => o.metricKey === "views_30d")!;
    expect(v30.value).toBe(500);
    expect(v30.windowStart).toBe("2026-08-10T00:00:00.000Z");
    expect(r.distributions.find((d) => d.dimension === "age_gender")).toMatchObject({ bucket: "18-24|female", pct: 30.5, basis: "viewers" });
    expect(r.distributions.find((d) => d.dimension === "country")).toMatchObject({ bucket: "US", value: 300, pct: 75, basis: "views" });
  });
  it("segments shorts from long-form by duration", () => {
    expect(ytContentFormat(native.videos[0])).toBe("short");
    expect(ytContentFormat(native.videos[1])).toBe("long_form");
    expect(byKey(r.observations, "v2", "duration_sec")).toEqual([723]);
  });
});

describe("Instagram discovery adapter", () => {
  it("is platform_public, uses the id when present and skips media without ids", () => {
    const native: InstagramDiscoveryNative = { platform: "instagram", accountId: "1784", handle: "someone", fetchedAt: AT, apiVersion: "v22.0", sourceMethod: "meta_business_discovery", toolsCalled: [], errors: [],
      businessDiscovery: { id: "1784", username: "someone", followers_count: 1200, media_count: 40, media: { data: [{ id: "p1", like_count: 10, comments_count: 1, timestamp: "2026-09-01T00:00:00+0000", media_type: "IMAGE" }, { like_count: 5 }] } } };
    const r = adaptInstagramDiscovery(native, { ...ctx("instagram"), sourceClass: "platform_public" });
    expect(r.identity.accountIdKind).toBe("platform_id");
    expect(byKey(r.observations, "1784", "followers")).toEqual([1200]);
    expect(r.observations.filter((o) => o.entityType === "content")).toHaveLength(2);
    expect(r.content).toHaveLength(1);
  });
});

describe("Legacy adapters", () => {
  it("a daily snapshot row becomes account, content and distribution rows at snapshot_date", () => {
    const { identity, result } = adaptLegacySnapshot({
      id: "s1", athlete_id: "a", platform: "instagram", source: "connected", connected_account_id: "c", snapshot_date: "2026-07-01T04:30:00.000Z",
      followers: 22000, following: 400, post_count: 290, total_likes: null, total_channel_views: null, is_verified: false, reach: 5000, impressions: 8000, profile_views: 12, avg_watch_time_sec: null,
      raw_metrics: { account: { id: "17841401", username: "mia" }, recent_media: [{ id: "m9", media_type: "VIDEO", timestamp: "2026-06-30T00:00:00+0000", like_count: 10, comments_count: 1, insights: { reach: 900, saved: 3 } }], demographics: { country: [{ key: "US", value: 10, pct: 50 }] } },
    });
    expect(identity).toMatchObject({ accountId: "17841401", accountIdKind: "platform_id", handle: "mia" });
    expect(byKey(result.observations, "17841401", "followers")).toEqual([22000]);
    expect(byKey(result.observations, "17841401", "account_views")).toEqual([8000]);
    expect(byKey(result.observations, "m9", "reach")).toEqual([900]);
    expect(result.observations.every((o) => o.observedAt === "2026-07-01T04:30:00.000Z")).toBe(true);
    expect(result.distributions[0]).toMatchObject({ dimension: "country", bucket: "US", basis: "followers" });
  });
  it("a discovery row with only a handle gets a handle-kind identity", () => {
    const { identity } = adaptLegacySnapshot({ id: "s2", athlete_id: "a", platform: "instagram", source: "discovery", connected_account_id: null, snapshot_date: new Date("2026-07-02T00:00:00Z"), followers: 100, following: null, post_count: null, total_likes: null, total_channel_views: null, is_verified: false, reach: null, impressions: null, profile_views: null, avg_watch_time_sec: null, raw_metrics: { discovery: { username: "Some.One" } } });
    expect(identity).toMatchObject({ accountId: "handle:some.one", accountIdKind: "handle" });
  });
  it("a media_assets row yields one observation per metric at its refresh time", () => {
    const { observations, contentFormat } = adaptLegacyMediaAsset({ id: "x", athlete_id: "a", platform: "instagram", origin: "connected", source_media_id: "m5", parent_media_id: null, media_type: "VIDEO", permalink: null, posted_at: "2026-05-01T00:00:00Z", like_count: 70, comments_count: 3, insights: { reach: 4000, video_views: 5000, ig_reels_avg_watch_time: 3200 }, metadata: { insights_enriched_at: "2026-08-01T00:00:00.000Z" }, metadata_updated_at: "2026-09-01T00:00:00.000Z", ingested_at: null });
    expect(contentFormat).toBe("video");
    expect(observations.find((o) => o.metricKey === "like_count")).toMatchObject({ value: 70, observedAt: "2026-09-01T00:00:00.000Z" });
    expect(observations.find((o) => o.metricKey === "reach")).toMatchObject({ value: 4000, observedAt: "2026-08-01T00:00:00.000Z" });
    expect(observations.find((o) => o.metricKey === "avg_watch_time_sec")!.value).toBe(3.2);
  });
});

describe("payload-family lineage", () => {
  // The families must match what substrate.ts stores one raw payload row for (payloadsOf).
  const FAMILIES = {
    instagram: ["profile", "account_insights", "media", "demographics"],
    tiktok: ["user_info", "video_list", "creator_info"],
    youtube: ["channels", "analytics_reports", "videos"],
    instagram_discovery: ["business_discovery"],
    youtube_discovery: ["channels", "videos"],
  };
  const families = (r: { observations: Array<{ payloadFamily?: string }>; distributions: Array<{ payloadFamily?: string }> }) => [...r.observations, ...r.distributions].map((x) => x.payloadFamily);

  it("every Instagram, TikTok, YouTube and discovery row names a stored sub-response", () => {
    const ig = adaptInstagram({ platform: "instagram", accountId: "1", handle: "h", fetchedAt: AT, apiVersion: "v22.0", sourceMethod: "oauth_instagram_login", toolsCalled: [], errors: [],
      profile: { id: "1", followers_count: 10 }, accountInsights: { data: [{ name: "reach", total_value: { value: 3 } }] }, media: [{ id: "m", media_type: "IMAGE", like_count: 1, insights: { data: [{ name: "reach", total_value: { value: 2 } }] } }], mediaFetchMode: "with_insights", demographics: { country: [{ key: "US", pct: 50 }] } } as unknown as InstagramNative, ctx("instagram"));
    expect(new Set(families(ig))).toEqual(new Set(FAMILIES.instagram));
    const tt = adaptTikTok({ platform: "tiktok", accountId: "t", handle: "h", fetchedAt: AT, apiVersion: "v2", sourceMethod: "oauth_tiktok_display", toolsCalled: [], errors: [],
      user: { follower_count: 4 }, videos: [{ id: "v", view_count: 9, create_time: 1_700_000_000 }], demographics: { country: [{ key: "US", pct: 50 }] } } as unknown as TikTokNative, ctx("tiktok"));
    expect(new Set(families(tt))).toEqual(new Set(FAMILIES.tiktok));
    const yt = adaptYouTube({ platform: "youtube", accountId: "c", handle: "h", fetchedAt: AT, apiVersion: "v3", sourceMethod: "oauth_youtube", toolsCalled: [], errors: [],
      channel: { id: "c", statistics: { subscriberCount: "7" } }, analytics: { reportStart: "2026-08-10", reportEnd: "2026-09-09", totals: { columnHeaders: [{ name: "views" }], rows: [[12]] }, countries: { columnHeaders: [{ name: "country" }, { name: "views" }], rows: [["US", 12]] } }, videos: [{ id: "v", snippet: { publishedAt: AT }, statistics: { viewCount: "3" }, contentDetails: { duration: "PT30S" } }] } as unknown as YouTubeNative, ctx("youtube"));
    expect(new Set(families(yt))).toEqual(new Set(FAMILIES.youtube));
    const bd = adaptInstagramDiscovery({ platform: "instagram", accountId: "handle:x", handle: "x", fetchedAt: AT, apiVersion: "v22.0", sourceMethod: "meta_business_discovery", toolsCalled: [], errors: [],
      businessDiscovery: { username: "x", followers_count: 3, media: { data: [{ id: "m", like_count: 1, media_type: "IMAGE" }] } } } as unknown as InstagramDiscoveryNative, ctx("instagram"));
    expect(new Set(families(bd))).toEqual(new Set(FAMILIES.instagram_discovery));
    const ytd = adaptYouTubeDiscovery({ platform: "youtube", accountId: "c", handle: "h", fetchedAt: AT, apiVersion: "v3", sourceMethod: "youtube_data_api", toolsCalled: [], errors: [],
      channel: { id: "c", statistics: { subscriberCount: "7" } }, videos: [{ id: "v", snippet: { publishedAt: AT }, statistics: { viewCount: "3" }, contentDetails: { duration: "PT30S" } }] } as unknown as YouTubeDiscoveryNative, ctx("youtube"));
    expect(new Set(families(ytd))).toEqual(new Set(FAMILIES.youtube_discovery));
    for (const r of [ig, tt, yt, bd, ytd]) for (const x of [...r.observations, ...r.distributions]) expect(typeof x.payloadFamily).toBe("string");
  });
});

describe("Instagram Stories adapters (Step 1b)", () => {
  const list = { platform: "instagram", accountId: "178", handle: "h", fetchedAt: AT, apiVersion: "v22.0", sourceMethod: "oauth_instagram_login", toolsCalled: [], errors: [],
    stories: [{ id: "s1", media_type: "IMAGE", media_product_type: "STORY", timestamp: "2026-09-09T01:00:00+0000" }, { id: "s2", media_type: "VIDEO", media_product_type: "STORY", timestamp: "2026-09-08T20:00:00+0000" }, { media_type: "IMAGE" }] } as any;
  it("the listing becomes one `listed` presence observation per Story, format story, no content rows", () => {
    const r = adaptStories(list, ctx("instagram"));
    expect(r.content).toEqual([]);
    expect(r.distributions).toEqual([]);
    expect(r.observations).toEqual([
      expect.objectContaining({ entityType: "content", entityId: "s1", entityTime: "2026-09-09T01:00:00.000Z", entityFormat: "story", metricKey: "listed", value: 1, observedAt: AT, payloadFamily: "stories_list" }),
      expect.objectContaining({ entityId: "s2", entityFormat: "story", metricKey: "listed", value: 1 }),
    ]);
  });
  it("the three insight sub-responses become observations that name their payload family; absent metrics stay absent", () => {
    const obs: any[] = [];
    adaptStoryInsights({ storyId: "s1", story: list.stories[0], fetchedAt: AT,
      insights: { data: [{ name: "reach", period: "lifetime", values: [{ value: 120 }] }, { name: "views", values: [{ value: 140 }] }, { name: "replies", values: [{ value: 2 }] }, { name: "shares", values: [{ value: 3 }] }, { name: "profile_visits", values: [{ value: 4 }] }] },
      navigation: { data: [{ name: "navigation", total_value: { breakdowns: [{ dimension_keys: ["story_navigation_action_type"], results: [{ dimension_values: ["TAP_FORWARD"], value: 90 }, { dimension_values: ["TAP_EXIT"], value: 10 }, { dimension_values: ["SWIPE_FORWARD"], value: 7 }] }] } }] },
      profileActivity: { data: [{ name: "profile_activity", total_value: { breakdowns: [{ dimension_keys: ["action_type"], results: [{ dimension_values: ["BIO_LINK_CLICKED"], value: 1 }] }] } }] },
      requestedMetrics: ["reach", "views", "replies", "shares", "total_interactions", "profile_visits", "follows"], unsupportedMetrics: ["reposts"], errors: [] }, obs);
    const byKey = Object.fromEntries(obs.map((o) => [o.metricKey, o]));
    expect(byKey.reach).toMatchObject({ value: 120, payloadFamily: "story_insights", entityFormat: "story", entityId: "s1", entityTime: "2026-09-09T01:00:00.000Z" });
    expect(byKey.view_count.value).toBe(140);
    expect(byKey.reply_count.value).toBe(2);
    expect(byKey.share_count.value).toBe(3);
    expect(byKey.profile_visits.value).toBe(4);
    expect(byKey.story_nav_tap_forward).toMatchObject({ value: 90, payloadFamily: "story_navigation" });
    expect(byKey.story_nav_tap_exit.value).toBe(10);
    expect(byKey.story_nav_swipe_forward.value).toBe(7);
    expect(byKey.story_nav_tap_back).toBeUndefined();                     // not in the breakdown → absent
    expect(byKey.story_profile_activity_bio_link_clicked).toMatchObject({ value: 1, payloadFamily: "story_profile_activity" });
    expect(byKey.total_interactions).toBeUndefined();                     // not returned → absent, never zero
    expect(byKey.reposts).toBeUndefined();                                // rejected by the provider → absent
    expect(obs.some((o) => o.metricKey === "listed")).toBe(false);        // insights never write presence
  });
  it("a Story whose insights were refused yields no observations", () => {
    const obs: any[] = [];
    adaptStoryInsights({ storyId: "s1", story: list.stories[0], fetchedAt: AT, insights: null, navigation: null, profileActivity: null, requestedMetrics: [], unsupportedMetrics: [], errors: [{ step: "story_insights", message: "(#10) Not enough viewers for the media to show insights", class: "not_enough_viewers", code: 10 }] }, obs);
    expect(obs).toEqual([]);
  });
});
