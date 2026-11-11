/**
 * features.test.ts — the resolver's precedence rules and the calculator's numbers on a small,
 * hand-checked fixture. Every assertion names a number a person can recompute.
 */

import { resolveLatest, resolveNearest, lowestAuthority } from "./resolve";
import { calculateSocialFeatures, median, percentile, coefficientOfVariation, type FeatureObservation, type FeatureDistribution } from "./features";
import { FEATURE_CALCULATION_VERSION } from "./metrics";

const FRESH = { connected_verified: 2, platform_public: 7, web_researched: 30, imputed: 3650 };
const AS_OF = "2026-09-09T00:00:00.000Z";
const d = (daysAgo: number) => new Date(Date.parse(AS_OF) - daysAgo * 86_400_000).toISOString();
let seq = 0;
const obs = (p: Partial<FeatureObservation> & { metricKey: string; value: number }): FeatureObservation => ({
  id: ++seq, identityId: "id-ig", platform: "instagram", entityType: "account", entityId: "acct", sourceClass: "connected_verified", sourceMethod: "oauth", observedAt: d(0), ...p,
});

describe("resolveLatest", () => {
  it("connected beats public when fresh; a stale connected value loses to a fresh public one and is recorded", () => {
    const fresh = resolveLatest([obs({ metricKey: "followers", value: 100, sourceClass: "platform_public", observedAt: d(0) }), obs({ metricKey: "followers", value: 99, observedAt: d(1) })], AS_OF, FRESH)!;
    expect(fresh.value).toBe(99); expect(fresh.sourceClass).toBe("connected_verified");
    const stale = resolveLatest([obs({ metricKey: "followers", value: 100, sourceClass: "platform_public", observedAt: d(0) }), obs({ metricKey: "followers", value: 99, observedAt: d(10) })], AS_OF, FRESH)!;
    expect(stale.value).toBe(100); expect(stale.sourceClass).toBe("platform_public"); expect(stale.staleSkipped).toEqual(["connected_verified"]);
  });
  it("returns null when nothing is at or before as_of — unknown, not zero — and ignores inferred rows", () => {
    expect(resolveLatest([obs({ metricKey: "followers", value: 5, observedAt: d(-1) })], AS_OF, FRESH)).toBeNull();
    expect(resolveLatest([obs({ metricKey: "followers", value: 5, sourceClass: "inferred" })], AS_OF, FRESH)).toBeNull();
  });
  it("resolveNearest picks the closest within tolerance, by authority", () => {
    const r = resolveNearest([obs({ metricKey: "followers", value: 90, observedAt: d(31) }), obs({ metricKey: "followers", value: 91, observedAt: d(29), sourceClass: "platform_public" })], d(30), 3)!;
    expect(r.value).toBe(90);
    expect(resolveNearest([obs({ metricKey: "followers", value: 90, observedAt: d(40) })], d(30), 3)).toBeNull();
  });
  it("lowestAuthority is the conservative summary", () => {
    expect(lowestAuthority(["connected_verified", "platform_public"])).toBe("platform_public");
    expect(lowestAuthority(["connected_verified"])).toBe("connected_verified");
  });
});

describe("statistics", () => {
  it("median and percentiles interpolate; cv is std/mean", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(46);
    expect(coefficientOfVariation([2, 2, 2])).toBe(0);
    expect(coefficientOfVariation([5])).toBeNull();
  });
});

describe("calculateSocialFeatures", () => {
  // Followers: 1000 at as_of (connected), 900 thirty days earlier. Five reels posted in the last 30 days.
  const followers = [obs({ metricKey: "followers", value: 1000 }), obs({ metricKey: "followers", value: 900, observedAt: d(30) }), obs({ metricKey: "followers", value: 950, observedAt: d(7) })];
  const items = [
    { id: "p1", posted: 2, reach: 4000, likes: 100, comments: 10, saves: 40, shares: 20, ti: 170, views: 5000 },
    { id: "p2", posted: 5, reach: 2000, likes: 50,  comments: 5,  saves: 10, shares: 5,  ti: 70,  views: 2500 },
    { id: "p3", posted: 9, reach: 3000, likes: 80,  comments: 8,  saves: 20, shares: 10, ti: 118, views: 3500 },
    { id: "p4", posted: 20, reach: 1000, likes: 20, comments: 2,  saves: 5,  shares: 1,  ti: 28,  views: 1200 },
    { id: "p5", posted: 25, reach: 20000, likes: 500, comments: 40, saves: 200, shares: 150, ti: 890, views: 30000 },
  ];
  const content: FeatureObservation[] = items.flatMap((it) => ([
    ["reach", it.reach], ["like_count", it.likes], ["comments_count", it.comments], ["save_count", it.saves], ["share_count", it.shares], ["total_interactions", it.ti], ["view_count", it.views],
  ] as Array<[string, number]>).map(([k, v]) => obs({ entityType: "content", entityId: it.id, entityTime: d(it.posted), entityFormat: "reel", metricKey: k, value: v, observedAt: d(1) })));
  const distributions: FeatureDistribution[] = [
    { id: 901, identityId: "id-ig", platform: "instagram", dimension: "country", bucket: "US", value: 460, pct: 46, basis: "followers", sourceClass: "connected_verified", sourceMethod: "oauth", observedAt: d(1) },
    { id: 902, identityId: "id-ig", platform: "instagram", dimension: "country", bucket: "CA", value: 120, pct: 12, basis: "followers", sourceClass: "connected_verified", sourceMethod: "oauth", observedAt: d(1) },
    { id: 903, identityId: "id-ig", platform: "instagram", dimension: "gender", bucket: "F", value: 610, pct: 61, basis: "followers", sourceClass: "connected_verified", sourceMethod: "oauth", observedAt: d(1) },
  ];
  const rows = calculateSocialFeatures({ identities: [{ id: "id-ig", platform: "instagram" }], observations: [...followers, ...content], distributions, asOf: AS_OF });
  const get = (key: string, w = 30) => rows.find((r) => r.featureKey === key && r.windowDays === w && r.platform === "instagram");

  it("followers and growth", () => {
    expect(get("followers_latest", 0)!.value).toBe(1000);
    expect(get("followers_growth_abs", 30)!.value).toBe(100);
    expect(get("followers_growth_pct", 30)!.value).toBeCloseTo(11.1111, 3);
    expect(get("followers_growth_abs", 7)!.value).toBe(50);
    expect(get("followers_growth_abs", 90)).toBeUndefined();      // nothing near 90 days back → absent
  });
  it("distributions over the five items in the 30-day window", () => {
    expect(get("content_n")!.value).toBe(5);
    expect(get("reach_median")!.value).toBe(3000);
    expect(get("views_p90")!.value).toBe(20000);                    // interpolated 90th of [1200,2500,3500,5000,30000]
    expect(get("saves_median")!.value).toBe(20);
    expect(get("shares_median")!.value).toBe(10);
  });
  it("ratio features name their denominators and use the right one", () => {
    // interactions_per_reach per item: 170/4000=.0425, 70/2000=.035, 118/3000=.0393, 28/1000=.028, 890/20000=.0445 → median .0393
    expect(get("interactions_per_reach_median")!.value).toBeCloseTo(0.0393, 3);
    expect(get("interactions_per_reach_median")!.inputs.denominator).toBe("reach");
    // saves per 1k reach: 10, 5, 6.67, 5, 10 → median 6.67
    expect(get("saves_per_1k_reach_median")!.value).toBeCloseTo(6.6667, 3);
    // reach per follower uses followers at each item's observation (d(1) → nearest is 1000): 4, 2, 3, 1, 20 → median 3
    expect(get("reach_per_follower_median")!.value).toBe(3);
  });
  it("inferred non-follower share references evidence and carries the inferred class", () => {
    const f = get("non_follower_reach_share")!;
    expect(f.sourceClass).toBe("inferred");
    expect(f.value).toBe(0.8);                                       // 4 of 5 items reach ≥ 2 × 1000
    expect((f.inputs as any).derivedFrom).toBe("connected_verified");
    expect((f.inputs as any).observationIds.length).toBeGreaterThan(0);
  });
  it("breakout, concentration, consistency on views", () => {
    // median views 3500; ≥ 3 × 3500 = 10500 → only p5 → 0.2
    expect(get("breakout_rate")!.value).toBe(0.2);
    // top decile (1 item) share = 30000 / 42200
    expect(get("top_decile_share")!.value).toBeCloseTo(0.7109, 3);
    expect(get("performance_cv")!.value).toBeGreaterThan(1);
  });
  it("cadence and format mix", () => {
    expect(get("posts_per_week", 7)!.value).toBeCloseTo(2, 4);      // p1, p2 in 7 days → 2 per week
    expect(get("posts_per_week", 30)!.value).toBeCloseTo(5 / (30 / 7), 4);
    expect(get("days_since_last_post", 0)!.value).toBe(2);
    expect(get("format_mix")!.valueJson).toEqual({ reel: 1 });
  });
  it("audience: full distribution, top share and concentration, basis preserved", () => {
    expect(get("audience_top_country_share", 0)!.value).toBe(46);
    expect((get("audience_country_distribution", 0)!.valueJson as any[])[0]).toMatchObject({ bucket: "US", pct: 46 });
    expect(get("audience_geo_concentration", 0)!.value).toBeCloseTo(0.46 ** 2 + 0.12 ** 2, 4);
    expect((get("audience_country_distribution", 0)!.inputs as any).basis).toBe("followers");
  });
  it("lineage carries the complete class breakdown and confidence caps by authority", () => {
    const f = get("reach_median")!;
    expect((f.inputs as any).byClass).toEqual({ connected_verified: 35 });
    expect(f.confidence).toBeLessThanOrEqual(1);
    expect(f.sourceClass).toBe("connected_verified");
  });
  it("cross-platform rows exist and unknown platforms are simply absent", () => {
    expect(rows.find((r) => r.featureKey === "platform_breadth")!.value).toBe(1);
    expect(rows.find((r) => r.featureKey === "effective_reach_cross_platform")!.value).toBe(3000);
    expect(rows.some((r) => r.platform === "tiktok")).toBe(false);
  });
});

describe("privacy class is independent of authority; denominators are lineage", () => {
  const o = (id: number, over: Partial<FeatureObservation>): FeatureObservation => ({ id, identityId: "i", platform: "instagram", entityType: "account", entityId: "acc", entityTime: null, entityFormat: null, metricKey: "followers", value: 1000, sourceClass: "platform_public", sourceMethod: "meta_business_discovery", observedAt: "2026-09-08T00:00:00.000Z", windowStart: null, windowEnd: null, ...over });
  const content = (id: number, cls: "connected_verified" | "platform_public") => [
    o(id, { entityType: "content", entityId: `c${id}`, entityTime: "2026-09-01T00:00:00.000Z", entityFormat: "post", metricKey: "like_count", value: 50, sourceClass: cls, sourceMethod: cls === "connected_verified" ? "oauth_instagram_login" : "meta_business_discovery" }),
    o(id + 1, { entityType: "content", entityId: `c${id}`, entityTime: "2026-09-01T00:00:00.000Z", entityFormat: "post", metricKey: "reach", value: 3000, sourceClass: cls, sourceMethod: cls === "connected_verified" ? "oauth_instagram_login" : "meta_business_discovery" }),
  ];
  const calc = (obs: FeatureObservation[]) => calculateSocialFeatures({ identities: [{ id: "i", platform: "instagram" }], observations: obs, distributions: [], asOf: "2026-09-09T00:00:00.000Z" });
  const find = (rows: ReturnType<typeof calc>, key: string) => rows.find((r) => r.featureKey === key && r.windowDays === 30)!;

  it("a public follower count under connected content: lowest authority is public, but the inputs include private evidence", () => {
    const rows = calc([o(1, {}), ...content(10, "connected_verified")]);
    const epf = find(rows, "engagement_per_follower_median");
    expect(epf.sourceClass).toBe("platform_public");
    expect(epf.inputAccessClass).toBe("includes_athlete_private");
    const i = epf.inputs as any;
    expect(i.denominatorObservationIds).toEqual([1]);
    expect(i.observationIds).toEqual(expect.arrayContaining([1, 10]));
    expect(i.byClass).toEqual({ connected_verified: 2, platform_public: 1 });   // like_count + reach of the item, plus the public follower count
    expect(i.byMethod).toEqual({ oauth_instagram_login: 2, meta_business_discovery: 1 });
    // The follower observation also lowers confidence relative to a connected-only ratio.
    const connectedOnly = calc([o(1, { sourceClass: "connected_verified", sourceMethod: "oauth_instagram_login" }), ...content(10, "connected_verified")]);
    expect(find(connectedOnly, "engagement_per_follower_median").confidence).toBeGreaterThan(epf.confidence);
    expect(find(rows, "likes_median").inputAccessClass).toBe("includes_athlete_private");
    expect(find(rows, "likes_median").sourceClass).toBe("connected_verified");
    expect(find(rows, "likes_median").inputs).not.toHaveProperty("denominatorObservationIds");
  });

  it("public-only inputs are public_only, and the inferred rule carries its denominators", () => {
    const rows = calc([o(1, {}), ...content(10, "platform_public")]);
    for (const r of rows) expect(r.inputAccessClass).toBe("public_only");
    const nf = find(rows, "non_follower_reach_share");
    expect(nf.sourceClass).toBe("inferred");
    expect((nf.inputs as any).denominatorObservationIds).toEqual([1]);
    expect((nf.inputs as any).observationIds).toEqual(expect.arrayContaining([1, 11]));
    expect((nf.inputs as any).derivedFrom).toBe("platform_public");
    expect(nf.value).toBe(1);   // 3000 reach ≥ 2 × 1000 followers
  });
});

describe("v3: retention is MEASURED only where there was something to measure", () => {
  /**
   * The bug this pins was caught on live dev data. Mia reconnected a YouTube channel she does not post to. YouTube
   * reported averageViewPercentage = 0 — meaning "nothing to average", not "viewers watched 0%" — and v2 passed it
   * through as a measured fact. It rendered into the authoritative block as
   *
   *     average percentage of video viewed (30 days, provider-reported): 0.00%
   *
   * under a header telling the evaluator to treat those values as authoritative and not replace them with web
   * estimates. An unused channel would have depressed her Engagement Quality with evidence that did not exist.
   *
   * The rule is universal, not a special case: zero views means retention is undefined; views above zero with a
   * genuine 0% average is real evidence and must survive.
   */
  const yt = (metricKey: string, value: number) =>
    obs({ identityId: "id-yt", platform: "youtube", entityType: "account", metricKey, value, observedAt: d(1) });
  const featuresFor = (observations: FeatureObservation[]) =>
    calculateSocialFeatures({ identities: [{ id: "id-yt", platform: "youtube" }], observations, distributions: [], asOf: AS_OF })
      .find((r) => r.featureKey === "avg_view_pct_account" && r.windowDays === 30);

  it("emits NOTHING when the provider reports 0% with zero views — undefined, not zero", () => {
    expect(featuresFor([yt("subscribers", 0), yt("views_30d", 0), yt("avg_view_pct_30d", 0)])).toBeUndefined();
  });

  it("emits NOTHING when there is no views_30d observation at all to establish a denominator", () => {
    expect(featuresFor([yt("subscribers", 500), yt("avg_view_pct_30d", 42)])).toBeUndefined();
  });

  it("KEEPS a genuine 0% when views exist — zero is valid evidence, and suppressing it would be the opposite bug", () => {
    const f = featuresFor([yt("subscribers", 500), yt("views_30d", 12_000), yt("avg_view_pct_30d", 0)]);
    expect(f).toBeDefined();
    expect(f!.value).toBe(0);
  });

  it("keeps an ordinary retention value when views exist", () => {
    const f = featuresFor([yt("subscribers", 500), yt("views_30d", 12_000), yt("avg_view_pct_30d", 42.5)]);
    expect(f!.value).toBeCloseTo(42.5, 4);
    expect(f!.unit).toBe("percent");
  });

  it("is stamped v3, so a block built before and after this change is reconstructable", () => {
    // The formula did not change; the SET of features produced from identical observations did. That difference
    // reaches an evaluator judgment and a MIA score, so calculation_version has to be able to explain it.
    expect(FEATURE_CALCULATION_VERSION).toBe("v3");
  });
});
