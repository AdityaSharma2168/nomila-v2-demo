/**
 * instagramStoryInsights.ts — how one Story's insights are read (Phase A Step 1b), as a pure
 * function over an injected `call`, so the metric probe and the error rules are unit-tested
 * without the network. instagram.ts supplies the real call (token, URL, classification).
 *
 * Rules (design §3 O7, §8, review 2):
 *   · Core metrics are always requested. Conditional metrics (link_clicks, reposts,
 *     facebook_views) are documented for STORY but probed: a metric is cached as unsupported
 *     ONLY when the provider rejects it by name, or when an individual probe of that metric is
 *     rejected. A rejection that does not name a metric never blacklists the others: the core
 *     call is retried alone and each still-unknown conditional metric is probed individually
 *     once. Probes are CAPABILITY checks only: their responses update the in-process cache and
 *     are never merged into `insights`, so the raw payload persisted for the Story is exactly
 *     the one envelope the successful core call returned, and no observation comes from a probe.
 *     Once support is known, later Stories collect those metrics through the normal combined
 *     call as real evidence.
 *   · Error 10 "Not enough viewers for the media to show insights" is media-level (Meta:
 *     "Story media metrics with values less than 5 return an error code 10 …"; the message
 *     says "for the media"). A core error 10 therefore stops the read: navigation and
 *     profile_activity are not called for that Story at that moment; the next sweep or the
 *     last-look tick retries.
 *   · `auth` and `rate_limited` on any call stop the read; other errors on one family leave the
 *     others to proceed.
 */

import type { MetaErrorInfo } from "./metaErrors";
import type { IgInsightEntry, IgStoryCallError, IgStoryInsightsNative, IgStoryNode } from "../../services/intelligence/social/native";

export const STORY_METRICS_CORE = ["reach", "views", "replies", "shares", "total_interactions", "profile_visits", "follows"] as const;
export const STORY_METRICS_CONDITIONAL = ["link_clicks", "reposts", "facebook_views"] as const;

export type InsightCallResult = { ok: true; json: { data?: IgInsightEntry[] } } | { ok: false; c: MetaErrorInfo };
/** One /insights request on the Story. `params` is the exact query (metric, breakdown). */
export type InsightCall = (step: string, params: Record<string, string>) => Promise<InsightCallResult>;

/** Process-lifetime memory of what the provider has PROVEN about conditional metrics. Unknown metrics are re-probed. */
export interface StoryMetricCache { supported: Set<string>; unsupported: Set<string> }
export const createStoryMetricCache = (): StoryMetricCache => ({ supported: new Set(), unsupported: new Set() });

const errorOf = (step: string, c: MetaErrorInfo): IgStoryCallError => ({ step, message: c.message, class: c.class, code: c.code, subcode: c.subcode, type: c.type, httpStatus: c.httpStatus });
const stops = (c: MetaErrorInfo) => c.class === "auth" || c.class === "rate_limited";

export async function readStoryInsights(call: InsightCall, story: IgStoryNode, cache: StoryMetricCache, fetchedAt = new Date().toISOString()): Promise<IgStoryInsightsNative> {
  const out: IgStoryInsightsNative = { storyId: String(story.id), story, fetchedAt, insights: null, navigation: null, profileActivity: null, requestedMetrics: [], unsupportedMetrics: [], errors: [] };
  const conditional = STORY_METRICS_CONDITIONAL.filter((m) => !cache.unsupported.has(m));
  out.unsupportedMetrics.push(...STORY_METRICS_CONDITIONAL.filter((m) => cache.unsupported.has(m)));

  // ── 1. combined call: core + every conditional metric not proven unsupported ──
  let metrics: string[] = [...STORY_METRICS_CORE, ...conditional];
  let toProbe: string[] = [];
  let stopped = false;
  for (let attempt = 0; attempt < STORY_METRICS_CONDITIONAL.length + 2; attempt++) {
    out.requestedMetrics = metrics;
    const r = await call("story_insights", { metric: metrics.join(",") });
    if (r.ok) { out.insights = r.json; for (const m of metrics) if ((STORY_METRICS_CONDITIONAL as readonly string[]).includes(m)) cache.supported.add(m); break; }
    if (r.c.class === "unsupported_metric") {
      const named = r.c.metric && (STORY_METRICS_CONDITIONAL as readonly string[]).includes(r.c.metric) && metrics.includes(r.c.metric) ? r.c.metric : null;
      if (named) { cache.unsupported.add(named); out.unsupportedMetrics.push(named); metrics = metrics.filter((m) => m !== named); continue; }
      // Unnamed rejection: never blacklist. Retry the core alone (plus proven-supported metrics) and
      // probe each still-unknown conditional metric individually below.
      const unknown = metrics.filter((m) => (STORY_METRICS_CONDITIONAL as readonly string[]).includes(m) && !cache.supported.has(m));
      if (unknown.length) { toProbe = unknown; metrics = metrics.filter((m) => !unknown.includes(m)); continue; }
    }
    out.errors.push(errorOf("story_insights", r.c));
    stopped = stops(r.c) || r.c.class === "not_enough_viewers";   // error 10 is media-level: nothing else will answer either
    break;
  }
  if (stopped) return out;

  // ── 2. individual probes, once per process, for metrics an unnamed rejection left unknown.
  //       Capability checks only: the response is discarded after updating the cache. `insights`
  //       and `requestedMetrics` stay exactly what the successful core call returned/requested.
  for (const m of toProbe) {
    const r = await call(`story_insights:probe:${m}`, { metric: m });
    if (r.ok) { cache.supported.add(m); continue; }
    if (r.c.class === "unsupported_metric") { cache.unsupported.add(m); out.unsupportedMetrics.push(m); continue; }
    out.errors.push(errorOf(`story_insights:probe:${m}`, r.c));
    if (stops(r.c)) return out;
  }

  // ── 3. breakdown families ──
  const nav = await call("story_navigation", { metric: "navigation", breakdown: "story_navigation_action_type" });
  if (nav.ok) out.navigation = nav.json; else { out.errors.push(errorOf("story_navigation", nav.c)); if (stops(nav.c)) return out; }
  const pa = await call("story_profile_activity", { metric: "profile_activity", breakdown: "action_type" });
  if (pa.ok) out.profileActivity = pa.json; else out.errors.push(errorOf("story_profile_activity", pa.c));
  return out;
}
