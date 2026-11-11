/**
 * analytics.ts — read API for social_analytics_snapshots (display/trend layer).
 *
 * GET /api/v1/me/analytics                       → latest snapshot per connected platform
 * GET /api/v1/me/analytics/:platform             → latest snapshot for one platform
 * GET /api/v1/me/analytics/:platform/history     → last N snapshots (chronological) + trend deltas
 * GET /api/v1/me/analytics/:platform/demographics → latest audience breakdowns
 *
 * All endpoints are athlete-scoped via requireAuth → req.athleteId. This router
 * only READS the snapshot table — collection happens in collectSocialAnalytics.
 */

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { db } from "../db";
import { socialAnalyticsSnapshots } from "../../shared/schema";
import type { SocialAnalyticsSnapshot } from "../../shared/schema";
import { and, eq, desc } from "drizzle-orm";
import { createLogger } from "../logger";

const logger = createLogger("routes/analytics");
const router = Router();

const SUPPORTED = ["instagram", "tiktok", "youtube"];
const HISTORY_LIMIT = 12;

/** % change oldest→newest; null when either side is missing or the base is 0. */
function pctChange(older: number | null | undefined, newer: number | null | undefined): number | null {
  if (older == null || newer == null || older === 0) return null;
  return Math.round(((newer - older) / older) * 10_000) / 100;
}

async function latestForPlatform(athleteId: string, platform: string): Promise<SocialAnalyticsSnapshot | null> {
  const [row] = await db.select().from(socialAnalyticsSnapshots)
    .where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.platform, platform)))
    .orderBy(desc(socialAnalyticsSnapshots.snapshot_date))
    .limit(1);
  return row ?? null;
}

// ─── GET /analytics — latest snapshot per platform ───────────────────────────
router.get("/analytics", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  try {
    const platforms = await db.selectDistinct({ platform: socialAnalyticsSnapshots.platform })
      .from(socialAnalyticsSnapshots)
      .where(eq(socialAnalyticsSnapshots.athlete_id, athleteId));
    const snapshots = (await Promise.all(platforms.map((p) => latestForPlatform(athleteId, p.platform)))).filter(Boolean);
    res.json({ platforms: snapshots });
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "Failed to list analytics");
    res.status(500).json({ error: "Failed to load analytics" });
  }
});

// ─── GET /analytics/:platform — latest snapshot ──────────────────────────────
router.get("/analytics/:platform", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const platform  = req.params.platform.toLowerCase();
  if (!SUPPORTED.includes(platform)) { res.status(400).json({ error: `Unsupported platform: ${platform}` }); return; }
  try {
    const snapshot = await latestForPlatform(athleteId, platform);
    if (!snapshot) { res.status(404).json({ error: "No analytics yet for this platform" }); return; }
    res.json({ snapshot });
  } catch (err: any) {
    logger.error({ athleteId, platform, error: err.message }, "Failed to load analytics");
    res.status(500).json({ error: "Failed to load analytics" });
  }
});

// ─── GET /analytics/:platform/history — series + trend deltas ────────────────
router.get("/analytics/:platform/history", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const platform  = req.params.platform.toLowerCase();
  if (!SUPPORTED.includes(platform)) { res.status(400).json({ error: `Unsupported platform: ${platform}` }); return; }
  try {
    // Newest-first from the DB, then reverse to chronological for the client/sparklines.
    const recent = await db.select().from(socialAnalyticsSnapshots)
      .where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.platform, platform)))
      .orderBy(desc(socialAnalyticsSnapshots.snapshot_date))
      .limit(HISTORY_LIMIT);
    const series = recent.reverse();

    const latest = series[series.length - 1] ?? null;
    const prev7  = series.length >= 2 ? series[series.length - 2] : null;       // previous snapshot
    const prev30 = series.length >= 5 ? series[series.length - 5] : series[0];  // ~5 snapshots back, else oldest

    const trends = latest ? {
      followers_7d:    pctChange(prev7?.followers,           latest.followers),
      followers_30d:   pctChange(prev30?.followers,          latest.followers),
      engagement_30d:  pctChange(prev30?.avg_engagement_rate, latest.avg_engagement_rate),
      reach_30d:       pctChange(prev30?.reach,              latest.reach),
      views_30d:       pctChange(prev30?.impressions,        latest.impressions),  // `impressions` holds v22 `views`
    } : null;

    res.json({ platform, series, trends });
  } catch (err: any) {
    logger.error({ athleteId, platform, error: err.message }, "Failed to load history");
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ─── GET /analytics/:platform/demographics — latest audience breakdowns ──────
router.get("/analytics/:platform/demographics", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const platform  = req.params.platform.toLowerCase();
  if (!SUPPORTED.includes(platform)) { res.status(400).json({ error: `Unsupported platform: ${platform}` }); return; }
  try {
    const snapshot = await latestForPlatform(athleteId, platform);
    if (!snapshot) { res.status(404).json({ error: "No analytics yet for this platform" }); return; }
    res.json({
      platform,
      snapshot_date: snapshot.snapshot_date,
      top: {
        country:   snapshot.top_audience_country,
        city:      snapshot.top_audience_city,
        age_range: snapshot.top_audience_age_range,
        gender:    snapshot.top_audience_gender,
      },
      breakdowns: snapshot.raw_metrics?.demographics ?? null,
    });
  } catch (err: any) {
    logger.error({ athleteId, platform, error: err.message }, "Failed to load demographics");
    res.status(500).json({ error: "Failed to load demographics" });
  }
});

export default router;
