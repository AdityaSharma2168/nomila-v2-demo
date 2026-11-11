/**
 * social/features.ts — the feature calculator v1 (Step 1 design §5).
 *
 * A pure function from stored rows to feature rows. It never fetches, never queries, and can
 * be re-run for any past as_of. Every feature carries n, the window, the lowest authority
 * among its inputs, a confidence, and lineage: the observation ids used and the full
 * per-class / per-method breakdown, so nobody may infer that every input shared the row's
 * single source_class.
 *
 * Observations are provider facts with an observed_at; features are numbers we computed for a
 * window ending at as_of. Unknown stays unknown: a feature with no inputs is not emitted.
 */

import type { SourceClass } from "../types";
import { FEATURE_CALCULATION_VERSION, type FeatureKey, type ContentFormat } from "./metrics";
import { AUTHORITY, groupByEntityMetric, lowestAuthority, resolveLatest, resolveNearest, type FreshnessDays, type ResolvableObservation } from "./resolve";

export interface FeatureObservation extends ResolvableObservation { identityId: string; platform: string }
export interface FeatureDistribution {
  id?: number | string; identityId: string; platform: string; dimension: string; bucket: string;
  value: number | null; pct: number | null; basis: string; sourceClass: SourceClass; sourceMethod: string; observedAt: string;
}
export interface FeatureIdentity { id: string; platform: string }

export interface FeatureWindows { default: number[]; cadence: number[]; growth: number[] }
export const DEFAULT_WINDOWS: FeatureWindows = { default: [30, 90], cadence: [7, 30, 90], growth: [7, 30, 90] };
export const DEFAULT_FRESHNESS: FreshnessDays = { connected_verified: 2, platform_public: 7, web_researched: 30, imputed: 3650 };
/** Content observations are facts about an item at a time; authority applies, freshness does not. */
const CONTENT_FRESHNESS: FreshnessDays = { connected_verified: 36500, platform_public: 36500, web_researched: 36500, imputed: 36500 };
const DISTRIBUTION_FRESHNESS_DAYS = 45;

/**
 * Privacy class of a feature's INPUTS, independent of authority (ADR-016). source_class says
 * how trustworthy the weakest input is; this says whether any input was the athlete's private
 * connected evidence. A feature over public and connected inputs is includes_athlete_private
 * even though its source_class is platform_public.
 */
export type InputAccessClass = "public_only" | "includes_athlete_private";
export function accessClassOf(byClass: Partial<Record<string, number>> | undefined): InputAccessClass {
  return byClass && (byClass.connected_verified ?? 0) > 0 ? "includes_athlete_private" : "public_only";
}

export interface FeatureRow {
  platform: string | null;
  identityId: string | null;
  featureKey: FeatureKey;
  value: number | null;
  valueJson: unknown | null;
  unit: string;
  n: number | null;
  windowDays: number;
  asOf: string;
  sourceClass: SourceClass;
  inputAccessClass: InputAccessClass;
  confidence: number;
  inputs: Record<string, unknown>;
  calculationVersion: string;
}

export interface CalculateInput {
  identities: FeatureIdentity[];
  observations: FeatureObservation[];
  distributions: FeatureDistribution[];
  asOf: string;
  windows?: FeatureWindows;
  freshness?: FreshnessDays;
}

// ─── statistics ──────────────────────────────────────────────────────────────

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
export const median = (v: number[]) => percentile(v, 0.5);
export function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}
const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const ms = (iso: string) => new Date(iso).getTime();
const DAY = 86_400_000;

const AUTHORITY_CAP: Record<SourceClass, number> = { connected_verified: 1, platform_public: 0.8, web_researched: 0.6, inferred: 0.5, imputed: 0.3 };
function confidenceFor(cls: SourceClass, n: number | null): number {
  const size = n == null ? 1 : Math.min(1, 0.5 + n / 20);
  return round(AUTHORITY_CAP[cls] * size, 2);
}

// ─── lineage bookkeeping ─────────────────────────────────────────────────────

class Lineage {
  ids = new Set<number | string>();
  byClass: Partial<Record<SourceClass, number>> = {};
  byMethod: Record<string, number> = {};
  notes: string[] = [];
  add(o: { id?: number | string; sourceClass: SourceClass; sourceMethod: string }) {
    if (o.id != null) this.ids.add(o.id);
    this.byClass[o.sourceClass] = (this.byClass[o.sourceClass] ?? 0) + 1;
    this.byMethod[o.sourceMethod] = (this.byMethod[o.sourceMethod] ?? 0) + 1;
  }
  merge(other: Lineage) {
    for (const id of other.ids) this.ids.add(id);
    for (const [c, n] of Object.entries(other.byClass)) this.byClass[c as SourceClass] = (this.byClass[c as SourceClass] ?? 0) + (n ?? 0);
    for (const [m, n] of Object.entries(other.byMethod)) this.byMethod[m] = (this.byMethod[m] ?? 0) + n;
  }
  classes(): SourceClass[] { return Object.keys(this.byClass) as SourceClass[]; }
  toJSON(extra: Record<string, unknown> = {}) {
    return { observationIds: [...this.ids], byClass: this.byClass, byMethod: this.byMethod, notes: this.notes, ...extra };
  }
}

// ─── content items resolved at as_of ─────────────────────────────────────────

interface Item {
  entityId: string; format: ContentFormat | null; postedAt: string | null; latestObservedAt: string;
  m: Partial<Record<string, number>>; lineage: Lineage;
}

function resolveItems(contentObs: FeatureObservation[], asOf: string): Item[] {
  const groups = groupByEntityMetric(contentObs);
  const items = new Map<string, Item>();
  for (const [key, list] of groups) {
    const [, entityId, metricKey] = key.split("|");
    const r = resolveLatest(list, asOf, CONTENT_FRESHNESS);
    if (!r) continue;
    const src = list.find((o) => o.id === r.observationId) ?? list[0];
    const item = items.get(entityId) ?? { entityId, format: (src.entityFormat as ContentFormat) ?? null, postedAt: src.entityTime ?? null, latestObservedAt: r.observedAt, m: {}, lineage: new Lineage() };
    item.m[metricKey] = r.value;
    if (ms(r.observedAt) > ms(item.latestObservedAt)) item.latestObservedAt = r.observedAt;
    item.lineage.add({ id: r.observationId, sourceClass: r.sourceClass, sourceMethod: r.sourceMethod });
    items.set(entityId, item);
  }
  return [...items.values()];
}

// ─── the calculator ───────────────────────────────────────────────────────────

export function calculateSocialFeatures(input: CalculateInput): FeatureRow[] {
  const asOf = new Date(input.asOf).toISOString();
  const windows = input.windows ?? DEFAULT_WINDOWS;
  const fresh = input.freshness ?? DEFAULT_FRESHNESS;
  const out: FeatureRow[] = [];
  const perPlatform: Record<string, { reachMedian?: number; viewsMedian?: number; contentN: number }> = {};

  const emit = (row: Omit<FeatureRow, "asOf" | "calculationVersion" | "confidence" | "inputAccessClass"> & { confidence?: number }) => {
    // Access class is derived from the lineage every row carries, so it cannot be forgotten per feature.
    out.push({ ...row, asOf, calculationVersion: FEATURE_CALCULATION_VERSION, confidence: row.confidence ?? confidenceFor(row.sourceClass, row.n), inputAccessClass: accessClassOf((row.inputs as { byClass?: Partial<Record<string, number>> }).byClass) });
  };

  for (const identity of input.identities) {
    const platform = identity.platform;
    const obs = input.observations.filter((o) => o.identityId === identity.id);
    const accountObs = obs.filter((o) => o.entityType === "account");
    // Stories are NOT feed content and are excluded from every aggregate below (v2). Until v1 this filter dropped
    // carousel_frame only, so Story reach and views were averaged together with post and reel reach — contaminating
    // reach_median, reach_per_follower_median, interactions_per_reach_median and the rest. Stories have entirely
    // different reach characteristics; the blended numbers described no real quantity. Stories get their own features.
    const contentObs = obs.filter((o) => o.entityType === "content" && o.entityFormat !== "carousel_frame" && o.entityFormat !== "story");
    const storyObs = obs.filter((o) => o.entityType === "content" && o.entityFormat === "story");
    const followersKey = platform === "youtube" ? "subscribers" : "followers";
    const followersObs = accountObs.filter((o) => o.metricKey === followersKey);

    // ── followers_latest (point feature: window 0) ──────────────────────────
    const fl = resolveLatest(followersObs, asOf, fresh);
    if (fl) {
      const lin = new Lineage(); lin.add({ id: fl.observationId, sourceClass: fl.sourceClass, sourceMethod: fl.sourceMethod });
      if (fl.staleSkipped.length) lin.notes.push(`stale classes skipped: ${fl.staleSkipped.join(",")}`);
      emit({ platform, identityId: identity.id, featureKey: "followers_latest", value: fl.value, valueJson: null, unit: "count", n: 1, windowDays: 0, sourceClass: fl.sourceClass, inputs: lin.toJSON({ candidates: fl.candidates, observedAt: fl.observedAt }) });
    }

    // ── growth per window ───────────────────────────────────────────────────
    for (const w of windows.growth) {
      if (!fl) break;
      const then = resolveNearest(followersObs, new Date(ms(asOf) - w * DAY).toISOString(), Math.max(2, Math.round(w / 6)));
      if (!then || then.observationId === fl.observationId) continue;
      const lin = new Lineage();
      lin.add({ id: fl.observationId, sourceClass: fl.sourceClass, sourceMethod: fl.sourceMethod });
      lin.add({ id: then.observationId, sourceClass: then.sourceClass, sourceMethod: then.sourceMethod });
      const cls = lowestAuthority(lin.classes());
      const abs = fl.value - then.value;
      emit({ platform, identityId: identity.id, featureKey: "followers_growth_abs", value: abs, valueJson: null, unit: "count", n: 2, windowDays: w, sourceClass: cls, inputs: lin.toJSON({ from: then.observedAt, to: fl.observedAt }) });
      if (then.value > 0) emit({ platform, identityId: identity.id, featureKey: "followers_growth_pct", value: round((abs / then.value) * 100), valueJson: null, unit: "percent", n: 2, windowDays: w, sourceClass: cls, inputs: lin.toJSON({ from: then.observedAt, to: fl.observedAt }) });
    }

    // ── content features per window ─────────────────────────────────────────
    const allItems = resolveItems(contentObs, asOf);
    for (const w of windows.default) {
      const start = ms(asOf) - w * DAY;
      const items = allItems.filter((it) => it.postedAt && ms(it.postedAt) > start && ms(it.postedAt) <= ms(asOf));
      if (!items.length) continue;
      const lin = new Lineage();
      for (const it of items) lin.merge(it.lineage);
      const cls = lowestAuthority(lin.classes());
      const base = { platform, identityId: identity.id, windowDays: w, sourceClass: cls };
      const vals = (k: string) => items.map((it) => it.m[k]).filter((v): v is number => typeof v === "number");
      const statFeature = (key: FeatureKey, values: number[], unit: string, fn: (v: number[]) => number | null, extra: Record<string, unknown> = {}) => {
        const v = fn(values); if (v === null || !values.length) return;
        emit({ ...base, featureKey: key, value: round(v), valueJson: null, unit, n: values.length, inputs: lin.toJSON({ metric: key, ...extra }) });
      };

      emit({ ...base, featureKey: "content_n", value: items.length, valueJson: null, unit: "count", n: items.length, inputs: lin.toJSON() });
      statFeature("views_median",    vals("view_count"),     "count", median);
      statFeature("views_p25",       vals("view_count"),     "count", (v) => percentile(v, 0.25));
      statFeature("views_p75",       vals("view_count"),     "count", (v) => percentile(v, 0.75));
      statFeature("views_p90",       vals("view_count"),     "count", (v) => percentile(v, 0.9));
      statFeature("reach_median",    vals("reach"),          "count", median);
      statFeature("reach_p75",       vals("reach"),          "count", (v) => percentile(v, 0.75));
      statFeature("reach_p90",       vals("reach"),          "count", (v) => percentile(v, 0.9));
      statFeature("likes_median",    vals("like_count"),     "count", median);
      statFeature("comments_median", vals("comments_count"), "count", median);
      statFeature("saves_median",    vals("save_count"),     "count", median);
      statFeature("shares_median",   vals("share_count"),    "count", median);

      // Ratios per item, then median. Each names its denominator. A follower-based ratio adds the
      // resolved follower observation(s) to its lineage: the denominator is evidence too and
      // shapes authority, access class and confidence.
      const followersAt = (it: Item) => resolveNearest(followersObs, it.latestObservedAt, 45) ?? fl;
      const ratio = (key: FeatureKey, unit: string, f: (it: Item, followers: number | null) => number | null, denominator: string, usesFollowers: boolean) => {
        const values: number[] = [];
        const rl = new Lineage(); rl.merge(lin);
        const denominatorIds: Array<number | string> = [];
        for (const it of items) {
          const fo = usesFollowers ? followersAt(it) : null;
          const v = f(it, fo ? fo.value : null);
          if (v === null || !Number.isFinite(v)) continue;
          values.push(v);
          if (fo && fo.observationId != null && !rl.ids.has(fo.observationId)) { rl.add({ id: fo.observationId, sourceClass: fo.sourceClass, sourceMethod: fo.sourceMethod }); denominatorIds.push(fo.observationId); }
        }
        const m = median(values); if (m === null || !values.length) return;
        emit({ platform, identityId: identity.id, windowDays: w, sourceClass: lowestAuthority(rl.classes()), featureKey: key, value: round(m), valueJson: null, unit, n: values.length, inputs: rl.toJSON({ metric: key, denominator, ...(usesFollowers ? { denominatorObservationIds: denominatorIds } : {}) }) });
      };
      ratio("engagement_per_follower_median", "ratio", (it, f) => (f && f > 0 && it.m.like_count != null ? ((it.m.like_count ?? 0) + (it.m.comments_count ?? 0)) / f : null), "followers at item observation", true);
      ratio("interactions_per_reach_median",  "ratio", (it) => (it.m.reach && it.m.total_interactions != null ? it.m.total_interactions / it.m.reach : null), "reach", false);
      ratio("interactions_per_view_median",   "ratio", (it) => (it.m.view_count ? ((it.m.like_count ?? 0) + (it.m.comments_count ?? 0) + (it.m.share_count ?? 0)) / it.m.view_count : null), "view_count", false);
      ratio("views_per_follower_median",      "ratio", (it, f) => (f && f > 0 && it.m.view_count != null ? it.m.view_count / f : null), "followers at item observation", true);
      ratio("reach_per_follower_median",      "ratio", (it, f) => (f && f > 0 && it.m.reach != null ? it.m.reach / f : null), "followers at item observation", true);
      ratio("saves_per_1k_reach_median",      "ratio", (it) => (it.m.reach && it.m.save_count != null ? (it.m.save_count * 1000) / it.m.reach : null), "reach", false);
      ratio("shares_per_1k_reach_median",     "ratio", (it) => (it.m.reach && it.m.share_count != null ? (it.m.share_count * 1000) / it.m.reach : null), "reach", false);
      ratio("shares_per_1k_views_median",     "ratio", (it) => (it.m.view_count && it.m.share_count != null ? (it.m.share_count * 1000) / it.m.view_count : null), "view_count", false);
      ratio("completion_pct_median",          "percent", (it) => (it.m.duration_sec && it.m.avg_watch_time_sec != null ? (it.m.avg_watch_time_sec / it.m.duration_sec) * 100 : null), "duration_sec", false);

      // Inferred: broad non-follower distribution (Instagram reach ≥ 2× followers). Evidence-linked,
      // including the follower observations the rule divided by.
      if (platform === "instagram") {
        const withReach = items.filter((it) => it.m.reach != null);
        if (withReach.length) {
          const rl = new Lineage(); rl.merge(lin);
          const denominatorIds: Array<number | string> = [];
          let hits = 0;
          for (const it of withReach) {
            const fo = followersAt(it);
            if (fo && fo.observationId != null && !rl.ids.has(fo.observationId)) { rl.add({ id: fo.observationId, sourceClass: fo.sourceClass, sourceMethod: fo.sourceMethod }); denominatorIds.push(fo.observationId); }
            if (fo && fo.value > 0 && (it.m.reach ?? 0) >= 2 * fo.value) hits++;
          }
          emit({ ...base, featureKey: "non_follower_reach_share", value: round(hits / withReach.length), valueJson: null, unit: "ratio", n: withReach.length, sourceClass: "inferred", confidence: round(0.5 * Math.min(1, 0.5 + withReach.length / 20), 2), inputs: rl.toJSON({ rule: "reach >= 2 x followers", derivedFrom: lowestAuthority(rl.classes()), denominatorObservationIds: denominatorIds }) });
        }
      }

      // Breakout, concentration, consistency on the performance metric (views if enough items carry it, else reach).
      const viewVals = vals("view_count"), reachVals = vals("reach");
      const perf = viewVals.length >= 3 ? { key: "view_count", v: viewVals } : reachVals.length >= 3 ? { key: "reach", v: reachVals } : null;
      if (perf) {
        const med = median(perf.v)!;
        const total = perf.v.reduce((a, b) => a + b, 0);
        const sorted = [...perf.v].sort((a, b) => b - a);
        const topN = Math.max(1, Math.ceil(sorted.length * 0.1));
        const topSum = sorted.slice(0, topN).reduce((a, b) => a + b, 0);
        if (med > 0) emit({ ...base, featureKey: "breakout_rate", value: round(perf.v.filter((x) => x >= 3 * med).length / perf.v.length), valueJson: null, unit: "ratio", n: perf.v.length, inputs: lin.toJSON({ metric: perf.key, rule: ">= 3 x median" }) });
        if (total > 0) emit({ ...base, featureKey: "top_decile_share", value: round(topSum / total), valueJson: null, unit: "ratio", n: perf.v.length, inputs: lin.toJSON({ metric: perf.key, topN }) });
        const cv = coefficientOfVariation(perf.v);
        if (cv !== null) emit({ ...base, featureKey: "performance_cv", value: round(cv), valueJson: null, unit: "ratio", n: perf.v.length, inputs: lin.toJSON({ metric: perf.key }) });
      }

      // Format mix and per-format medians.
      const byFormat: Record<string, Item[]> = {};
      for (const it of items) (byFormat[it.format ?? "unknown"] ??= []).push(it);
      const mix: Record<string, number> = {};
      for (const [f, list] of Object.entries(byFormat)) mix[f] = round(list.length / items.length);
      emit({ ...base, featureKey: "format_mix", value: null, valueJson: mix, unit: "json", n: items.length, inputs: lin.toJSON() });
      const perFormat = (metric: string) => {
        const o: Record<string, { median: number; n: number }> = {};
        for (const [f, list] of Object.entries(byFormat)) { const v = list.map((it) => it.m[metric]).filter((x): x is number => typeof x === "number"); const m = median(v); if (m !== null) o[f] = { median: round(m), n: v.length }; }
        return o;
      };
      const vbf = perFormat("view_count"); if (Object.keys(vbf).length) emit({ ...base, featureKey: "views_median_by_format", value: null, valueJson: vbf, unit: "json", n: items.length, inputs: lin.toJSON() });
      const rbf = perFormat("reach");      if (Object.keys(rbf).length) emit({ ...base, featureKey: "reach_median_by_format", value: null, valueJson: rbf, unit: "json", n: items.length, inputs: lin.toJSON() });

      const p = (perPlatform[platform] ??= { contentN: 0 });
      if (w === Math.min(...windows.default) || !p.contentN) { p.contentN = items.length; p.viewsMedian = median(viewVals) ?? undefined; p.reachMedian = median(reachVals) ?? undefined; }
    }    // ── story features per window (v2) ──────────────────────────────────────
    // Factual rates only. The engagement_quality.story_efficiency JUDGMENT stays the evaluator's, made from these
    // numbers under the frozen rubric. reply_count is deliberately unused: Meta reports 0 for creators in Europe and
    // Japan, so any rate built on it is silently region-dependent.
    const allStories = resolveItems(storyObs, asOf);
    for (const w of windows.default) {
      const start = ms(asOf) - w * DAY;
      const stories = allStories.filter((it) => it.postedAt && ms(it.postedAt) > start && ms(it.postedAt) <= ms(asOf));
      if (!stories.length) continue;
      const lin = new Lineage();
      for (const it of stories) lin.merge(it.lineage);
      const base = { platform, identityId: identity.id, windowDays: w, sourceClass: lowestAuthority(lin.classes()) };
      const storyRatio = (key: FeatureKey, unit: string, f: (it: (typeof stories)[number]) => number | null, denominator: string) => {
        const values = stories.map(f).filter((v): v is number => v !== null && Number.isFinite(v));
        const m = median(values);
        if (m === null || !values.length) return;
        emit({ ...base, featureKey: key, value: round(m), valueJson: null, unit, n: values.length, inputs: lin.toJSON({ metric: key, denominator }) });
      };
      storyRatio("story_retention_proxy", "ratio", (it) => (it.m.reach && it.m.story_nav_tap_exit != null ? 1 - it.m.story_nav_tap_exit / it.m.reach : null), "reach");
      storyRatio("story_tap_forward_rate", "ratio", (it) => (it.m.reach && it.m.story_nav_tap_forward != null ? it.m.story_nav_tap_forward / it.m.reach : null), "reach");
      const fNow = resolveLatest(followersObs, asOf, fresh);
      if (fNow && fNow.value > 0) storyRatio("story_reach_per_follower", "ratio", (it) => (it.m.reach != null ? it.m.reach / fNow.value : null), "followers at as_of");
    }

    // ── YouTube account-level retention (v2) ────────────────────────────────
    // Provider-reported averageViewPercentage, stored as an account observation and previously never surfaced.
    // Kept separate from completion_pct_median (Instagram reel watch-time / duration) on purpose: averaging a
    // channel-level average with per-reel completion would repeat the Story mistake somewhere else.
    for (const w of windows.default) {
      const avp = accountObs.filter((o) => o.metricKey === "avg_view_pct_30d");
      const latestAvp = resolveLatest(avp, asOf, fresh);
      if (!latestAvp || w !== 30) continue;

      // v3 VALIDITY GUARD. "Measured" cannot mean "the API returned a number" — it has to mean the number represents
      // the quantity it claims to. YouTube reports averageViewPercentage = 0 for a channel with nothing to average,
      // and v2 passed that through as a measured fact. Rendered into the authoritative block it read as "her videos
      // are watched 0% of the way through", under a header instructing the evaluator to treat it as authoritative and
      // not replace it with web estimates — catastrophic performance asserted where there is simply no evidence.
      //
      // Zero itself is perfectly valid: a channel with real views and a genuine 0% average should still report 0%.
      // What is invalid is zero with no viewing denominator. views_30d is the only authoritative measure over THIS
      // window (content_count is a lifetime total, so requiring it would be importing a different window's evidence
      // to justify this one), so the guard is exactly that and nothing invented beyond it.
      const views = resolveLatest(accountObs.filter((o) => o.metricKey === "views_30d"), asOf, fresh);
      if (!views || !(views.value > 0)) continue;
      const lin = new Lineage(); lin.add({ id: latestAvp.observationId, sourceClass: latestAvp.sourceClass, sourceMethod: latestAvp.sourceMethod });
      emit({ platform, identityId: identity.id, featureKey: "avg_view_pct_account", value: round(latestAvp.value), valueJson: null, unit: "percent", n: 1, windowDays: w, sourceClass: latestAvp.sourceClass, inputs: lin.toJSON({ metric: "avg_view_pct_30d", observedAt: latestAvp.observedAt }) });
    }



    // ── cadence per window (posts per week uses posted_at only) ─────────────
    for (const w of windows.cadence) {
      const start = ms(asOf) - w * DAY;
      const posted = allItems.filter((it) => it.postedAt && ms(it.postedAt) > start && ms(it.postedAt) <= ms(asOf));
      if (!posted.length) continue;
      const lin = new Lineage(); for (const it of posted) lin.merge(it.lineage);
      emit({ platform, identityId: identity.id, featureKey: "posts_per_week", value: round(posted.length / (w / 7)), valueJson: null, unit: "posts_per_week", n: posted.length, windowDays: w, sourceClass: lowestAuthority(lin.classes()), inputs: lin.toJSON() });
    }
    const lastPost = allItems.filter((it) => it.postedAt && ms(it.postedAt) <= ms(asOf)).sort((a, b) => ms(b.postedAt!) - ms(a.postedAt!))[0];
    if (lastPost) {
      emit({ platform, identityId: identity.id, featureKey: "days_since_last_post", value: round((ms(asOf) - ms(lastPost.postedAt!)) / DAY, 1), valueJson: null, unit: "days", n: 1, windowDays: 0, sourceClass: lowestAuthority(lastPost.lineage.classes()), inputs: lastPost.lineage.toJSON({ entityId: lastPost.entityId, postedAt: lastPost.postedAt }) });
    }

    // ── audience distributions: latest observation set per dimension, by authority ──
    const dists = input.distributions.filter((d) => d.identityId === identity.id && ms(d.observedAt) <= ms(asOf) && ms(asOf) - ms(d.observedAt) <= DISTRIBUTION_FRESHNESS_DAYS * DAY);
    const latestSet = (dimension: string): FeatureDistribution[] => {
      const rows = dists.filter((d) => d.dimension === dimension);
      for (const cls of AUTHORITY) {
        const ofClass = rows.filter((d) => d.sourceClass === cls);
        if (!ofClass.length) continue;
        const newest = ofClass.reduce((a, b) => (ms(b.observedAt) > ms(a.observedAt) ? b : a)).observedAt;
        return ofClass.filter((d) => d.observedAt === newest);
      }
      return [];
    };
    const distLineage = (rows: FeatureDistribution[]) => { const l = new Lineage(); for (const r of rows) l.add({ id: r.id, sourceClass: r.sourceClass, sourceMethod: r.sourceMethod }); return l; };
    const country = latestSet("country");
    if (country.length) {
      const lin = distLineage(country); const cls = lowestAuthority(lin.classes());
      const rows = country.map((r) => ({ bucket: r.bucket, pct: r.pct, value: r.value })).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
      emit({ platform, identityId: identity.id, featureKey: "audience_country_distribution", value: null, valueJson: rows, unit: "json", n: rows.length, windowDays: 0, sourceClass: cls, inputs: lin.toJSON({ basis: country[0].basis, observedAt: country[0].observedAt }) });
      if (rows[0]?.pct != null) emit({ platform, identityId: identity.id, featureKey: "audience_top_country_share", value: rows[0].pct, valueJson: null, unit: "percent", n: rows.length, windowDays: 0, sourceClass: cls, inputs: lin.toJSON({ basis: country[0].basis, bucket: rows[0].bucket }) });
      const hhi = rows.reduce((s, r) => s + ((r.pct ?? 0) / 100) ** 2, 0);
      if (rows.some((r) => r.pct != null)) emit({ platform, identityId: identity.id, featureKey: "audience_geo_concentration", value: round(hhi), valueJson: null, unit: "ratio", n: rows.length, windowDays: 0, sourceClass: cls, inputs: lin.toJSON({ basis: country[0].basis }) });
    }
    for (const [dim, key] of [["gender", "audience_gender_share"], ["age", "audience_age_distribution"]] as const) {
      const set = latestSet(dim);
      if (!set.length) continue;
      const lin = distLineage(set);
      emit({ platform, identityId: identity.id, featureKey: key, value: null, valueJson: set.map((r) => ({ bucket: r.bucket, pct: r.pct, value: r.value })), unit: "json", n: set.length, windowDays: 0, sourceClass: lowestAuthority(lin.classes()), inputs: lin.toJSON({ basis: set[0].basis, observedAt: set[0].observedAt }) });
    }
  }

  // ── cross-platform ──────────────────────────────────────────────────────────
  const platforms = Object.entries(perPlatform).filter(([, p]) => p.contentN > 0);
  if (platforms.length) {
    const w = Math.min(...windows.default);
    const used: Record<string, { metric: string; value: number }> = {};
    const excluded: string[] = [];
    let sum = 0;
    for (const [pf, p] of platforms) {
      if (p.reachMedian != null) { used[pf] = { metric: "reach_median", value: p.reachMedian }; sum += p.reachMedian; }
      else if (p.viewsMedian != null) { used[pf] = { metric: "views_median", value: p.viewsMedian }; sum += p.viewsMedian; }
      else excluded.push(pf);
    }
    const perPlatformRows = out.filter((r) => r.windowDays === w && (r.featureKey === "reach_median" || r.featureKey === "views_median"));
    const cls = lowestAuthority(perPlatformRows.map((r) => r.sourceClass));
    // Full provenance: the union of the per-platform rows' lineage, so byClass/byMethod/observationIds
    // stay complete on derived features too (design: inputs preserve the whole breakdown).
    const merged = { observationIds: [] as unknown[], byClass: {} as Record<string, number>, byMethod: {} as Record<string, number>, derivedFromFeatures: perPlatformRows.map((r) => `${r.platform}.${r.featureKey}@${r.windowDays}d`) };
    for (const r of perPlatformRows) {
      const i = r.inputs as { observationIds?: unknown[]; byClass?: Record<string, number>; byMethod?: Record<string, number> };
      merged.observationIds.push(...(i.observationIds ?? []));
      for (const [k, n] of Object.entries(i.byClass ?? {})) merged.byClass[k] = (merged.byClass[k] ?? 0) + n;
      for (const [k, n] of Object.entries(i.byMethod ?? {})) merged.byMethod[k] = (merged.byMethod[k] ?? 0) + n;
    }
    if (Object.keys(used).length) emit({ platform: null, identityId: null, featureKey: "effective_reach_cross_platform", value: round(sum), valueJson: null, unit: "count", n: Object.keys(used).length, windowDays: w, sourceClass: cls, inputs: { ...merged, used, excludedPlatforms: excluded, note: "sum of per-platform medians; platform view definitions differ and are named per platform" } });
    emit({ platform: null, identityId: null, featureKey: "platform_breadth", value: platforms.length, valueJson: null, unit: "count", n: platforms.length, windowDays: w, sourceClass: cls, inputs: { ...merged, platforms: platforms.map(([pf]) => pf) } });
  }

  return out;
}
