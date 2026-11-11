/**
 * agent/research/measuredSync.ts — keep a new-agent athlete's MEASURED memory facts current with her connected
 * accounts. Measured memory facts are the ONE PLACE the M.I.A. preview and the screens read measured data from (owner,
 * Oct 2026). One place, not less data: everything the M.I.A. used to read from the connected social-features block is
 * written here too, so moving the preview onto memory loses nothing.
 *
 *   snapshot metrics   from the latest connected snapshot per platform (connected.measuredFactsFrom): followers,
 *                      average engagement / reach / views, posts in the last 30 days, audience buckets
 *   derived features   from social_features (the nightly derivation and the connect-path recompute): every metric the
 *                      authoritative block supplied (marketabilityBeta1SocialBlock.BLOCK_FEATURE_METRICS — follower
 *                      growth, median engagement / reach / interactions, saves and shares per 1k reach, views, video
 *                      completion, story retention, top country share, cross-platform reach, platform breadth) plus
 *                      every other numeric connected feature the derivation writes. The latest row per metric and
 *                      window, with its window and date, and a source ref to that social_features row.
 *
 * Every social sync refreshes them, for every connected platform the sync collects (Instagram, TikTok, YouTube today):
 *   on connect     social_sync v2 (workflow/definitions/socialSync.ts), after it collects (and derives)
 *   nightly 04:30  collectAllAnalyticsSnapshots (skills/collectSocialAnalytics.ts), once per athlete it collected
 *   research       the onboarding merge step; and the M.I.A. preview, right before it builds its snapshot
 *
 * Code, never a model: the numbers are read straight from Nomila's own rows, and a newer reading of the same metric
 * supersedes the older one (research.syncMeasured). A no-op for an athlete with no memory (not on the new agent).
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { athletes, connectedAccounts, memoryFacts, socialFeatures } from "../../../shared/schema";
import { FEATURE_CALCULATION_VERSION } from "../../services/intelligence/social/metrics";
import { BLOCK_FEATURE_METRICS, formatFeature, type FeatureFormat } from "../../services/marketabilityBeta1SocialBlock";
import { CROSS_PLATFORM, loadConnectedChannels, measuredFactsFrom } from "./connected";
import { syncPublicMeasuredFacts } from "./publicPlatform";
import { dbStore } from "./dbStore";
import { syncMeasured } from "./research";
import { notifyPlanEvent } from "../plan/triggers";
import type { NewFact } from "./store";

/** True when the athlete has any memory_facts row (the new agent's memory). */
async function hasMemory(athleteId: string): Promise<boolean> {
  const [row] = await db.select({ id: memoryFacts.id }).from(memoryFacts).where(eq(memoryFacts.athlete_id, athleteId)).limit(1);
  return !!row;
}

/** The fields of a social_features row this module reads. */
export interface FeatureRow {
  id: number | string;
  platform: string | null;
  feature_key: string;
  window_days: number;
  value: string | number | null;
  unit: string;
  as_of: Date | string;
}

/** The platform key a cross-platform feature (platform NULL) is filed under in a measured ref (connected.ts). */
export { CROSS_PLATFORM };
const LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X" };
const day = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString()).slice(0, 10);

/** The measured-fact metric for a feature: "<feature_key>_<window>d" (window 0 = a point reading). */
export const featureMetric = (key: string, window: number) => `${key}_${window}d`;
/** The source ref of a feature-backed measured fact: the social_features row, plus which metric. */
export const featureRef = (r: FeatureRow) => `social_features/${r.id}#${r.platform ?? CROSS_PLATFORM}.${featureMetric(r.feature_key, r.window_days)}`;

/** A generic label and format for a numeric feature the block did not name, from its unit and window. */
function genericFeature(r: FeatureRow): { label: string; format: FeatureFormat | "days" | "per_week" } {
  const name = r.feature_key.replace(/_/g, " ");
  const label = r.window_days > 0 ? `${name} (${r.window_days} days)` : name;
  const format = r.unit === "ratio" ? "pct" : r.unit === "percent" ? "percent2" : r.unit === "days" ? "days" : r.unit === "posts_per_week" ? "per_week" : "num";
  return { label, format };
}

/**
 * Pure. Measured facts from connected social features: the latest row per (platform, feature, window); numeric values
 * only (a JSON-valued feature such as a distribution is left to its own reader). Each claim states the metric, its
 * window and its value exactly as the authoritative block wrote it; the fact is dated by the row's as-of and points
 * back to the row. `skipFollowersFor`: platforms whose follower count is already a snapshot fact (one follower number).
 */
export function featureFactsFrom(rows: FeatureRow[], handles: Map<string, string>, athleteName: string, skipFollowersFor: ReadonlySet<string> = new Set()): NewFact[] {
  const latest = new Map<string, FeatureRow>();
  for (const r of rows) {
    if (r.value == null || !Number.isFinite(Number(r.value))) continue;
    const k = `${r.platform ?? CROSS_PLATFORM}|${r.feature_key}|${r.window_days}`;
    const cur = latest.get(k);
    if (!cur || day(r.as_of) > day(cur.as_of) || (day(r.as_of) === day(cur.as_of) && Number(r.id) > Number(cur.id))) latest.set(k, r);
  }
  const facts: NewFact[] = [];
  for (const r of [...latest.values()].sort((a, b) => featureRef(a).localeCompare(featureRef(b)))) {
    if (r.feature_key === "followers_latest" && r.platform && skipFollowersFor.has(r.platform)) continue;
    const known = BLOCK_FEATURE_METRICS.find((m) => m.key === r.feature_key && (m.window == null || m.window === r.window_days)
      && (m.scope === "cross") === (r.platform == null));
    const { label, format } = known ?? genericFeature(r);
    const v = Number(r.value);
    const value = format === "days" ? `${v} days` : format === "per_week" ? `${v} per week` : formatFeature(format, v);
    const where = r.platform ? `${LABEL[r.platform] ?? r.platform}${handles.get(r.platform) ? ` (@${handles.get(r.platform)})` : ""}` : "Across connected platforms,";
    const platformLabel = r.platform ? LABEL[r.platform] ?? r.platform : "social";
    facts.push({
      subject: { kind: "athlete", name: athleteName }, claim: `${where} ${label}: ${value}.`, type: "measured",
      source: { ref: featureRef(r), title: `Connected ${platformLabel} account (derived)` },
      date: day(r.as_of), confidence: 1, runId: null,
    });
  }
  return facts;
}

/** The athlete's connected social features at the current calculation version (connected_verified only, as the block). */
async function loadConnectedFeatures(athleteId: string): Promise<FeatureRow[]> {
  return db.select({
    id: socialFeatures.id, platform: socialFeatures.platform, feature_key: socialFeatures.feature_key, window_days: socialFeatures.window_days,
    value: socialFeatures.value, unit: socialFeatures.unit, as_of: socialFeatures.as_of,
  }).from(socialFeatures).where(and(
    eq(socialFeatures.athlete_id, athleteId),
    eq(socialFeatures.source_class, "connected_verified"),
    eq(socialFeatures.calculation_version, FEATURE_CALCULATION_VERSION),
  ));
}

/**
 * Refresh one athlete's measured memory facts from her connected accounts: the snapshot metrics and the derived
 * features. Returns null for an athlete not on the new memory, else what changed and which platforms were read.
 */
export async function syncMemoryMeasuredFacts(athleteId: string): Promise<{ inserted: number; superseded: number; moved: number; platforms: string[] } | null> {
  if (!(await hasMemory(athleteId))) return null;
  const [row] = await db.select({ name: athletes.full_name }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  const name = row?.name ?? "Athlete";
  const channels = await loadConnectedChannels(athleteId);
  const snapshotFacts = measuredFactsFrom(channels, name);
  const conns = await db.select({ platform: connectedAccounts.platform, username: connectedAccounts.platform_username }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active")));
  const handles = new Map(conns.filter((c) => c.username).map((c) => [c.platform, String(c.username).replace(/^@+/, "")]));
  for (const c of channels) if (c.handle) handles.set(c.platform, c.handle);
  const withFollowers = new Set(channels.filter((c) => c.followers != null).map((c) => c.platform));
  const featureFacts = featureFactsFrom(await loadConnectedFeatures(athleteId), handles, name, withFollowers);
  const all = [...snapshotFacts, ...featureFacts];
  const platforms = [...new Set([...channels.map((c) => c.platform), ...featureFacts.map((f) => (f.source.ref ?? "").split("#")[1]?.split(".")[0]).filter((p): p is string => !!p && p !== CROSS_PLATFORM)])];
  // The platforms' public APIs, for a handle she confirmed and has not connected (publicPlatform.ts; no API call here —
  // the discovery rows Nomila already holds). After the connected readings, so connected data stays the one source
  // for a connected platform.
  const pub = await syncPublicMeasuredFacts(athleteId, name).catch(() => ({ inserted: 0, superseded: 0, moved: 0, platforms: [] as string[] }));
  if (!all.length) return { inserted: pub.inserted, superseded: pub.superseded, moved: pub.moved, platforms: [...platforms, ...pub.platforms] };
  const r = await syncMeasured(dbStore, athleteId, all);
  const moved = (r.moved ?? 0) + pub.moved;
  r.inserted += pub.inserted; r.superseded += pub.superseded; platforms.push(...pub.platforms.filter((p) => !platforms.includes(p)));
  // The plan step: an account newly read, or a metric that moved ≥ 10%, is an event for the plan (no-op unless
  // AGENT_PLAN; never throws; the plan's own guards coalesce a burst into one run).
  if (r.moved) notifyPlanEvent(athleteId, "new measured data from your accounts");
  return { inserted: r.inserted, superseded: r.superseded, moved, platforms };
}
