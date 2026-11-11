/**
 * followers.ts — her follower counts per platform, from the social substrate (legacy retirement P2-3).
 *
 * The ONE reader for "how many followers does she have" (Mila's get_score, the Facts "Followers" row, the canonical
 * record view, and the deck's combined following). It used to be `athletes_current.{ig,tk,x}_followers /
 * yt_subscribers` — copied there by the legacy scoring writer — and, on the deck, the follower counts stored INSIDE
 * the retired v3 rate card. Neither is a source; both go with the legacy score.
 *
 * Source, per platform:
 *   1. `social_features.followers_latest` (Phase A Step 1a: the most authoritative fresh followers / subscribers
 *      observation, chosen by the feature builder), current calculation version, newest `as_of`;
 *   2. else the newest `social_analytics_snapshots.followers` for that platform, any source;
 *   3. else the newest `athlete_snapshots.social` that carries the platform (research's public-discovery fill —
 *      the source the legacy copy had for an athlete who never connected and has no analytics row).
 * A platform with neither is null — never zero, never guessed.
 *
 * SELECTs only; tenancy is the athlete id the caller already owns.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { athleteSnapshots, socialAnalyticsSnapshots, socialFeatures } from "../../shared/schema";
import { FEATURE_CALCULATION_VERSION } from "./intelligence/social/metrics";

export const FOLLOWER_PLATFORMS = ["instagram", "tiktok", "youtube", "x"] as const;
export type FollowerPlatform = typeof FOLLOWER_PLATFORMS[number];

export interface Followers {
  counts: Record<FollowerPlatform, number | null>;
  /** The newest observation behind any count, ISO; null when there is none. */
  asOf: string | null;
}

const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;   // 0 reads as "no count" (the old copy hid zeros too)
};

export async function readFollowers(athleteId: string, dbx: any = defaultDb): Promise<Followers> {
  const [features, snapshots] = await Promise.all([
    dbx.select({ platform: socialFeatures.platform, value: socialFeatures.value, as_of: socialFeatures.as_of })
      .from(socialFeatures)
      .where(and(
        eq(socialFeatures.athlete_id, athleteId),
        eq(socialFeatures.feature_key, "followers_latest"),
        eq(socialFeatures.calculation_version, FEATURE_CALCULATION_VERSION),
      ))
      .orderBy(desc(socialFeatures.as_of))
      .limit(50),
    dbx.select({ platform: socialAnalyticsSnapshots.platform, followers: socialAnalyticsSnapshots.followers, at: socialAnalyticsSnapshots.snapshot_date })
      .from(socialAnalyticsSnapshots)
      .where(eq(socialAnalyticsSnapshots.athlete_id, athleteId))
      .orderBy(desc(socialAnalyticsSnapshots.snapshot_date))
      .limit(50),
  ]);

  const counts = Object.fromEntries(FOLLOWER_PLATFORMS.map((p) => [p, null])) as Followers["counts"];
  let asOf: Date | null = null;
  const take = (platform: string | null, value: unknown, at: Date | string | null) => {
    if (!platform || !(FOLLOWER_PLATFORMS as readonly string[]).includes(platform)) return;
    const p = platform as FollowerPlatform;
    if (counts[p] != null) return;                        // rows are newest first: the first usable one wins
    const n = finite(value);
    if (n == null) return;
    counts[p] = n;
    const d = at ? new Date(at) : null;
    if (d && !Number.isNaN(d.getTime()) && (!asOf || d > asOf)) asOf = d;
  };
  for (const f of features) take(f.platform, f.value, f.as_of);
  for (const s of snapshots) take(s.platform, s.followers, s.at);
  if (FOLLOWER_PLATFORMS.some((p) => counts[p] == null)) {
    const snaps = await dbx.select({ social: athleteSnapshots.social, at: athleteSnapshots.created_at })
      .from(athleteSnapshots)
      .where(and(eq(athleteSnapshots.athlete_id, athleteId), sql`${athleteSnapshots.social} IS NOT NULL`))
      .orderBy(desc(athleteSnapshots.created_at))
      .limit(10);
    for (const row of snaps) {
      const social = (row.social ?? {}) as Record<string, any>;
      for (const p of FOLLOWER_PLATFORMS) {
        const v = social?.[p];
        if (v && typeof v === "object") take(p, p === "youtube" ? (v.subscribers ?? v.followers) : v.followers, row.at);
      }
    }
  }
  return { counts, asOf: asOf ? (asOf as Date).toISOString() : null };
}

/** The deck's "combined following": the sum of the known counts (0 when none is known). */
export function combinedFollowing(f: Followers): number {
  return Object.values(f.counts).reduce<number>((s, n) => s + (n ?? 0), 0);
}
