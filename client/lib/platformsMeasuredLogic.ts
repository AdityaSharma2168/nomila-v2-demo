// "Your platforms, measured" — the measured level under My Intelligence (frame 7): what her connected accounts report,
// as measured, with the date of each reading. Pure composition of GET /me/analytics (the latest snapshot per platform)
// and her connections (the handle). No comparisons, no tiers, no "× creator avg", no opinion: a value the platform did
// not report says "not measured".
//
//   platformCards(snapshots, connections)   one card per platform, in a fixed platform order
//   each card: name · handle · as-of date · three measured cells · up to three audience distributions as plain bars

import type { AnalyticsSnapshot, DemographicRow } from "../hooks/use-analytics";
import { readDate } from "./myIntelligenceLogic";

export const NOT_MEASURED = "not measured";
export const PLATFORM_ORDER: readonly string[] = ["instagram", "tiktok", "youtube"];
const PLATFORM_NAME: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };
const GENDER_WORD: Record<string, string> = { F: "Women", M: "Men", U: "Unknown", female: "Women", male: "Men", gender_other: "Other", other: "Other" };

export interface MeasuredCell { value: string; label: string; measured: boolean }
export interface MeasuredBar { key: string; pct: number }
export interface MeasuredBars { title: string; bars: MeasuredBar[] }
export interface PlatformCard {
  platform: string;
  name: string;
  /** "@handle" when a connection carries one, else null (the card still draws). */
  handle: string | null;
  asOf: string;
  cells: MeasuredCell[];
  distributions: MeasuredBars[];
}

export function platformName(platform: string): string {
  return PLATFORM_NAME[platform] ?? (platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : "");
}

/** "21,889" — whole numbers with thousands separators; never compacted, so a reading is read as read. */
export function fmtCount(n: number | null | undefined): string | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : null;
}
/** "6.9%" from a rate stored as a percentage (avg_engagement_rate is already ×100 in the snapshot). */
export function fmtRate(n: number | null | undefined): string | null {
  return typeof n === "number" && Number.isFinite(n) ? `${(Math.round(n * 10) / 10).toFixed(1)}%` : null;
}
/** "3h 12m" from minutes. */
export function fmtMinutes(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const h = Math.floor(n / 60), m = Math.round(n % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const cell = (value: string | null, label: string): MeasuredCell => ({ value: value ?? NOT_MEASURED, label, measured: value != null });

/** The three cells per platform: what each one measures, in its own terms. */
export function measuredCells(s: AnalyticsSnapshot): MeasuredCell[] {
  switch (s.platform) {
    case "youtube": {
      const yt = s.raw_metrics?.youtube;
      return [cell(fmtCount(s.followers), "subscribers"), cell(fmtCount(yt?.views_30d), "views, 30 days"), cell(fmtMinutes(yt?.minutes_watched_30d), "watch time, 30 days")];
    }
    case "tiktok":
      return [cell(fmtCount(s.followers), "followers"), cell(fmtCount(s.total_likes), "likes, all time"), cell(fmtCount(s.avg_views_per_post), "views per video")];
    default:
      return [cell(fmtCount(s.followers), "followers"), cell(fmtRate(s.avg_engagement_rate), "engagement per follower"), cell(fmtCount(s.reach), "reach, 30 days")];
  }
}

function topBars(rows: DemographicRow[] | undefined, label: (k: string) => string, n = 3): MeasuredBar[] {
  return (rows ?? [])
    .filter((r) => typeof r.pct === "number" && Number.isFinite(r.pct) && r.pct > 0)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, n)
    .map((r) => ({ key: label(r.key), pct: Math.round(r.pct) }));
}

/** Country · age · gender, each the top three shares as plain bars; a distribution the platform does not report is absent. */
export function distributions(s: AnalyticsSnapshot): MeasuredBars[] {
  const d = s.raw_metrics?.demographics;
  const yt = s.raw_metrics?.youtube;
  const out: MeasuredBars[] = [];
  const country = topBars(d?.country ?? yt?.countries, (k) => k);
  const age = topBars(d?.age, (k) => k.replace(/-/g, "–"));
  const gender = topBars(d?.gender, (k) => GENDER_WORD[k] ?? k);
  if (country.length) out.push({ title: "Where your audience is", bars: country });
  if (age.length) out.push({ title: "Ages", bars: age });
  if (gender.length) out.push({ title: "Gender", bars: gender });
  return out;
}

export function platformCards(snapshots: ReadonlyArray<AnalyticsSnapshot>, connections: ReadonlyArray<{ platform: string; status: string; platform_username: string | null }>): PlatformCard[] {
  const handleOf = (platform: string): string | null => {
    const c = connections.find((x) => x.platform === platform && x.status === "active" && x.platform_username) ?? connections.find((x) => x.platform === platform && x.platform_username);
    const u = c?.platform_username?.trim().replace(/^@/, "");
    return u ? `@${u}` : null;
  };
  const rank = (p: string) => { const i = PLATFORM_ORDER.indexOf(p); return i === -1 ? PLATFORM_ORDER.length : i; };
  return [...snapshots]
    .sort((a, b) => rank(a.platform) - rank(b.platform))
    .map((s) => ({ platform: s.platform, name: platformName(s.platform), handle: handleOf(s.platform), asOf: readDate(s.snapshot_date), cells: measuredCells(s), distributions: distributions(s) }));
}
