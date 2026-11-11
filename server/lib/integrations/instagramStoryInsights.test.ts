/**
 * instagramStoryInsights.test.ts — the conditional-metric probe never blacklists by guess, and a
 * media-level error 10 stops the read (Step 1b review fixes 1 and 2). No network: `call` is faked.
 */

import { createStoryMetricCache, readStoryInsights, STORY_METRICS_CONDITIONAL, STORY_METRICS_CORE, type InsightCall } from "./instagramStoryInsights";
import type { MetaErrorInfo } from "./metaErrors";
import { adaptStoryInsights } from "../../services/intelligence/social/adapters/instagram";

const story = { id: "s1", timestamp: "2026-09-12T10:00:00+0000", media_product_type: "STORY" };
const entries = (metrics: string[]) => ({ data: metrics.map((name) => ({ name, values: [{ value: 7 }] })) });
const err = (cls: MetaErrorInfo["class"], message: string, extra: Partial<MetaErrorInfo> = {}): MetaErrorInfo => ({ class: cls, message, code: cls === "not_enough_viewers" ? 10 : cls === "unsupported_metric" ? 100 : cls === "auth" ? 190 : 4, ...extra });

/** A fake provider: `rejects` lists conditional metrics it refuses; `named` says whether it names the metric in the error. */
function fakeProvider(opts: { rejects?: string[]; named?: boolean; coreError?: MetaErrorInfo; navError?: MetaErrorInfo }) {
  const calls: Array<Record<string, string>> = [];
  const call: InsightCall = async (_step, params) => {
    calls.push(params);
    if (params.metric === "navigation") return opts.navError ? { ok: false, c: opts.navError } : { ok: true, json: entries(["navigation"]) };
    if (params.metric === "profile_activity") return { ok: true, json: entries(["profile_activity"]) };
    const metrics = params.metric.split(",");
    if (opts.coreError && metrics.some((m) => (STORY_METRICS_CORE as readonly string[]).includes(m))) return { ok: false, c: opts.coreError };
    const bad = metrics.filter((m) => opts.rejects?.includes(m));
    if (bad.length) return { ok: false, c: err("unsupported_metric", opts.named ? `The Media Insights API does not support the ${bad[0]} metric for this media product type.` : "metric[0] must be one of the following values: reach, views, replies, shares", opts.named ? { metric: bad[0] } : {}) };
    return { ok: true, json: entries(metrics) };
  };
  return { call, calls };
}
const metricsOf = (calls: Array<Record<string, string>>) => calls.map((c) => c.metric);
const returned = (r: Awaited<ReturnType<typeof readStoryInsights>>) => (r.insights?.data ?? []).map((d) => d.name);

describe("conditional Story metrics (O7 probe)", () => {
  it("a rejection that names one conditional metric drops only that metric; the other two are still requested and delivered", async () => {
    const cache = createStoryMetricCache();
    const p = fakeProvider({ rejects: ["reposts"], named: true });
    const r = await readStoryInsights(p.call, story, cache);
    expect(metricsOf(p.calls)).toEqual([[...STORY_METRICS_CORE, ...STORY_METRICS_CONDITIONAL].join(","), [...STORY_METRICS_CORE, "link_clicks", "facebook_views"].join(","), "navigation", "profile_activity"]);
    expect(returned(r)).toEqual(expect.arrayContaining(["reach", "link_clicks", "facebook_views"]));
    expect(returned(r)).not.toContain("reposts");
    expect(r.unsupportedMetrics).toEqual(["reposts"]);
    expect([...cache.unsupported]).toEqual(["reposts"]);
    expect([...cache.supported].sort()).toEqual(["facebook_views", "link_clicks"]);
    expect(r.errors).toEqual([]);
  });

  it("an unnamed rejection never blacklists: the core is retried alone and each unknown conditional metric is probed individually once", async () => {
    const cache = createStoryMetricCache();
    const p = fakeProvider({ rejects: ["reposts"], named: false });
    const r = await readStoryInsights(p.call, story, cache);
    expect(metricsOf(p.calls)).toEqual([[...STORY_METRICS_CORE, ...STORY_METRICS_CONDITIONAL].join(","), STORY_METRICS_CORE.join(","), "link_clicks", "reposts", "facebook_views", "navigation", "profile_activity"]);
    expect(returned(r)).toEqual([...STORY_METRICS_CORE]);                    // probe values are not evidence on this Story
    expect(r.unsupportedMetrics).toEqual(["reposts"]);
    expect([...cache.unsupported]).toEqual(["reposts"]);
    expect([...cache.supported].sort()).toEqual(["facebook_views", "link_clicks"]);
    // A second Story in the same process: one combined call with the proven set, no probes.
    const p2 = fakeProvider({ rejects: ["reposts"], named: false });
    const r2 = await readStoryInsights(p2.call, { ...story, id: "s2" }, cache);
    expect(metricsOf(p2.calls)).toEqual([[...STORY_METRICS_CORE, "link_clicks", "facebook_views"].join(","), "navigation", "profile_activity"]);
    expect(r2.unsupportedMetrics).toEqual(["reposts"]);
    expect(r2.errors).toEqual([]);
  });

  it("only metrics proven unsupported are cached; a provider that accepts everything caches all three as supported", async () => {
    const cache = createStoryMetricCache();
    const p = fakeProvider({});
    await readStoryInsights(p.call, story, cache);
    expect(cache.unsupported.size).toBe(0);
    expect([...cache.supported].sort()).toEqual([...STORY_METRICS_CONDITIONAL].sort());
    expect(metricsOf(p.calls)).toHaveLength(3);
  });
});

describe("error handling per family", () => {
  it("a core error 10 (Not enough viewers, media-level) stops the read: navigation and profile_activity are not called", async () => {
    const cache = createStoryMetricCache();
    const p = fakeProvider({ coreError: err("not_enough_viewers", "(#10) Not enough viewers for the media to show insights") });
    const r = await readStoryInsights(p.call, story, cache);
    expect(p.calls).toHaveLength(1);
    expect(r.insights).toBeNull(); expect(r.navigation).toBeNull(); expect(r.profileActivity).toBeNull();
    expect(r.errors).toEqual([expect.objectContaining({ step: "story_insights", class: "not_enough_viewers", code: 10 })]);
    expect(cache.unsupported.size).toBe(0);   // a viewer threshold says nothing about metric support
  });

  it("auth and rate-limit on the core call stop the read; a navigation error does not block profile_activity", async () => {
    const cache = createStoryMetricCache();
    const auth = fakeProvider({ coreError: err("auth", "Invalid OAuth access token", { code: 190, subcode: 463 }) });
    expect((await readStoryInsights(auth.call, story, cache)).errors[0].class).toBe("auth");
    expect(auth.calls).toHaveLength(1);
    const limited = fakeProvider({ coreError: err("rate_limited", "throttled", { code: 4 }) });
    await readStoryInsights(limited.call, story, cache);
    expect(limited.calls).toHaveLength(1);
    const nav = fakeProvider({ navError: err("unsupported_metric", "The Media Insights API does not support the navigation metric for this media product type.", { code: 100, metric: "navigation" }) });
    const r = await readStoryInsights(nav.call, story, cache);
    expect(r.navigation).toBeNull(); expect(r.profileActivity).not.toBeNull();
    expect(r.errors).toEqual([expect.objectContaining({ step: "story_navigation", class: "unsupported_metric" })]);
    expect(cache.unsupported.has("navigation")).toBe(false);   // only the three conditional metrics are ever cached
  });
});

describe("evidence lineage (review fix)", () => {
  it("individual probe responses are capability checks only: never merged into insights, never observations", async () => {
    const cache = createStoryMetricCache();
    const coreEnvelope = entries([...STORY_METRICS_CORE]);
    const probed: string[] = [];
    const call: InsightCall = async (_step, params) => {
      const metrics = params.metric.split(",");
      if (params.metric === "navigation" || params.metric === "profile_activity") return { ok: true, json: entries([params.metric]) };
      if (metrics.length === 1 && (STORY_METRICS_CONDITIONAL as readonly string[]).includes(metrics[0])) { probed.push(metrics[0]); return metrics[0] === "reposts" ? { ok: false, c: err("unsupported_metric", "The Media Insights API does not support the reposts metric for this media product type.", { metric: "reposts" }) } : { ok: true, json: entries([metrics[0]]) }; }
      if (metrics.some((m) => (STORY_METRICS_CONDITIONAL as readonly string[]).includes(m))) return { ok: false, c: err("unsupported_metric", "metric[0] must be one of the following values: reach, views") };
      return { ok: true, json: coreEnvelope };
    };
    const r = await readStoryInsights(call, story, cache);
    expect(probed).toEqual([...STORY_METRICS_CONDITIONAL]);
    expect(r.insights).toBe(coreEnvelope);                                   // the exact envelope the core call returned, by reference
    expect(returned(r)).toEqual([...STORY_METRICS_CORE]);
    expect(r.requestedMetrics).toEqual([...STORY_METRICS_CORE]);
    expect([...cache.supported].sort()).toEqual(["facebook_views", "link_clicks"]);
    expect([...cache.unsupported]).toEqual(["reposts"]);
    const obs: Array<{ metricKey: string }> = [];
    adaptStoryInsights(r, obs as any);
    expect(obs.map((o) => o.metricKey)).not.toEqual(expect.arrayContaining(["link_clicks", "facebook_views", "reposts"]));
    expect(obs.some((o) => o.metricKey === "reach")).toBe(true);
    // Once support is known, the next Story collects the proven metrics through the normal combined call.
    const p2 = fakeProvider({ rejects: ["reposts"], named: false });
    const r2 = await readStoryInsights(p2.call, { ...story, id: "s2" }, cache);
    expect(metricsOf(p2.calls)[0]).toBe([...STORY_METRICS_CORE, "link_clicks", "facebook_views"].join(","));
    expect(returned(r2)).toEqual(expect.arrayContaining(["link_clicks", "facebook_views"]));
  });
});
