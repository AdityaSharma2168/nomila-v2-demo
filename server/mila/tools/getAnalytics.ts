/**
 * getAnalytics.ts — Mila read tool: follower counts and recent trend.
 *
 * Reads `social_analytics_snapshots` filtered by athlete_id. The latest
 * snapshot_day per platform is the current follower count; 7-day and 30-day
 * deltas compare against the most recent snapshot on or before that target day
 * (robust to irregular capture cadence). The unique index
 * idx_sas_athlete_platform_day guarantees one row per athlete×platform×day, so a
 * day maps to a single followers value. Returns null when the athlete has no
 * snapshots for the requested scope.
 */

import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { socialAnalyticsSnapshots } from "../../../shared/schema";
import { MILA } from "../config";
import type { MilaTool } from "../types";

const PLATFORMS = ["instagram", "tiktok", "youtube"] as const;

const getAnalyticsArgs = z.object({
  platform: z
    .enum(PLATFORMS)
    .optional()
    .describe("Limit to one platform. Omit for all connected platforms."),
});

/** "YYYY-MM-DD" minus n days, in UTC, back to "YYYY-MM-DD". */
function minusDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) - n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export const getAnalyticsTool: MilaTool<typeof getAnalyticsArgs> = {
  name: "get_analytics",
  description:
    "Get the athlete's current follower count per platform (Instagram, TikTok, " +
    "YouTube) with 7-day and 30-day change. Optionally limit to one platform. " +
    "A delta is null when there isn't enough history yet. Returns null when the " +
    "athlete has no analytics snapshots.",
  argsSchema: getAnalyticsArgs,
  async execute(athleteId, args) {
    const platforms = args.platform ? [args.platform] : [...PLATFORMS];
    const out: Record<string, unknown> = {};

    for (const platform of platforms) {
      const rows = await db
        .select({
          snapshot_day: socialAnalyticsSnapshots.snapshot_day,
          followers: socialAnalyticsSnapshots.followers,
        })
        .from(socialAnalyticsSnapshots)
        .where(
          and(
            eq(socialAnalyticsSnapshots.athlete_id, athleteId),
            eq(socialAnalyticsSnapshots.platform, platform),
          ),
        )
        .orderBy(desc(socialAnalyticsSnapshots.snapshot_day))
        .limit(120);

      // One row per (athlete, platform, snapshot_day) is guaranteed by the
      // unique index, so a day maps to a single followers value. Skip rows with
      // a null follower count.
      const byDay = new Map<string, number>();
      for (const r of rows) {
        if (r.followers == null || !r.snapshot_day) continue;
        byDay.set(r.snapshot_day, r.followers);
      }
      if (byDay.size === 0) continue;

      const days = [...byDay.keys()].sort().reverse(); // newest first
      const latest = days[0];
      const current = byDay.get(latest)!;

      // Most recent snapshot on or before `latest - n days`.
      const deltaOver = (n: number): number | null => {
        const target = minusDays(latest, n);
        const past = days.find((d) => d <= target);
        return past === undefined ? null : current - byDay.get(past)!;
      };

      out[platform] = {
        followers: current,
        as_of: latest,
        delta_7d: deltaOver(7),
        delta_30d: deltaOver(30),
      };
    }

    if (Object.keys(out).length === 0) return null;

    // Budget guard: this payload is inherently tiny (≤3 small objects), but keep
    // the invariant explicit.
    if (JSON.stringify(out).length > MILA.TOOL_RESULT_MAX_CHARS) {
      return { truncated: true };
    }
    return out;
  },
};
