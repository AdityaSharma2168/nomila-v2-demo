/**
 * platformsMeasuredLogic.test.ts — "Your platforms, measured": one card per platform from the latest snapshots.
 *
 * Pinned:
 *   • fixed platform order; the handle from an active connection, "@"-prefixed once; the as-of date from the snapshot
 *   • a value the platform did not report says "not measured" — never a dash, never a guess, never a comparison
 *   • distributions are the top three shares as plain bars, with gender codes as words; absent when not reported
 *   • no field names, no "× creator avg", no tier words anywhere in the output
 */
import { NOT_MEASURED, distributions, fmtCount, fmtRate, measuredCells, platformCards } from "./platformsMeasuredLogic";
import type { AnalyticsSnapshot } from "../hooks/use-analytics";

const snap = (over: Partial<AnalyticsSnapshot> = {}): AnalyticsSnapshot => ({
  platform: "instagram", snapshot_date: "2026-10-01T06:00:00.000Z", snapshot_day: "2026-10-01",
  followers: 21889, following: null, post_count: null, total_likes: null, total_channel_views: null, is_verified: false,
  reach: null, impressions: null, profile_views: null, avg_engagement_rate: 6.94, avg_reach_per_post: null, avg_views_per_post: null,
  avg_shares_per_post: null, avg_saves_per_post: null, avg_watch_time_sec: null, content_frequency: null,
  top_audience_country: "US", top_audience_city: null, top_audience_age_range: "18-24", top_audience_gender: "F",
  raw_metrics: { demographics: {
    country: [{ key: "US", value: 15000, pct: 69.2 }, { key: "IN", value: 1500, pct: 7.1 }, { key: "CA", value: 600, pct: 2.9 }, { key: "GB", value: 400, pct: 1.8 }],
    age: [{ key: "18-24", value: 6500, pct: 30 }, { key: "25-34", value: 5000, pct: 23 }, { key: "13-17", value: 3500, pct: 16 }],
    gender: [{ key: "F", value: 8000, pct: 38 }, { key: "U", value: 7500, pct: 35 }, { key: "M", value: 6000, pct: 27 }],
  } }, ...over,
});

test("cards: fixed order, handle from the active connection, as-of from the snapshot", () => {
  const cards = platformCards(
    [snap({ platform: "youtube", followers: 0, avg_engagement_rate: null, raw_metrics: null }), snap(), snap({ platform: "tiktok", followers: 15463, total_likes: 120000, raw_metrics: null })],
    [{ platform: "instagram", status: "active", platform_username: "@handle_one" }, { platform: "tiktok", status: "expired", platform_username: "handle_one" }, { platform: "youtube", status: "active", platform_username: null }],
  );
  expect(cards.map((c) => [c.platform, c.name, c.handle, c.asOf])).toEqual([
    ["instagram", "Instagram", "@handle_one", "1 Oct 2026"],
    ["tiktok", "TikTok", "@handle_one", "1 Oct 2026"],
    ["youtube", "YouTube", null, "1 Oct 2026"],
  ]);
  // YouTube's 0 is a reading, not a missing value.
  expect(cards[2].cells[0]).toEqual({ value: "0", label: "subscribers", measured: true });
  expect(cards[2].cells[1]).toEqual({ value: NOT_MEASURED, label: "views, 30 days", measured: false });
});

test("cells: measured values read as read; the unreported say 'not measured'", () => {
  expect(measuredCells(snap()).map((c) => [c.value, c.label])).toEqual([["21,889", "followers"], ["6.9%", "engagement per follower"], [NOT_MEASURED, "reach, 30 days"]]);
  expect(measuredCells(snap({ platform: "tiktok", followers: 15463, total_likes: null, avg_views_per_post: 4200 })).map((c) => c.value)).toEqual(["15,463", NOT_MEASURED, "4,200"]);
  expect(measuredCells(snap({ platform: "youtube", followers: 12, raw_metrics: { youtube: { views_30d: 1234, minutes_watched_30d: 195 } } })).map((c) => c.value)).toEqual(["12", "1,234", "3h 15m"]);
  expect(fmtCount(null)).toBeNull();
  expect(fmtRate(0)).toBe("0.0%");
});

test("distributions: top three shares as bars, gender codes as words, absent when not reported", () => {
  const d = distributions(snap());
  expect(d.map((x) => x.title)).toEqual(["Where your audience is", "Ages", "Gender"]);
  expect(d[0].bars).toEqual([{ key: "US", pct: 69 }, { key: "IN", pct: 7 }, { key: "CA", pct: 3 }]);
  expect(d[1].bars.map((b) => b.key)).toEqual(["18–24", "25–34", "13–17"]);
  expect(d[2].bars).toEqual([{ key: "Women", pct: 38 }, { key: "Unknown", pct: 35 }, { key: "Men", pct: 27 }]);
  expect(distributions(snap({ raw_metrics: null }))).toEqual([]);
});

test("nothing judges: no field names, no creator averages, no tier words", () => {
  const text = JSON.stringify(platformCards([snap()], []));
  expect(text).not.toMatch(/avg_|followers_latest|raw_metrics|creator avg|×|excellent|below average|tier/i);
});
