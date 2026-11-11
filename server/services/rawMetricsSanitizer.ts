/**
 * rawMetricsSanitizer.ts — strip secrets and signed-URL query strings from
 * social_analytics_snapshots.raw_metrics (Phase A decision D7, 10 Sep 2026).
 *
 * Production code: the nightly cron calls scrubStoredRawMetrics after the media re-host, so the newest row per
 * athlete x platform is left untouched — the Growth tab renders cover thumbnails from that row and rehostAthleteMedia
 * fetches pixels from its URLs, both inside the CDN's expiry window. Every older row's signed URLs are already dead, so
 * stripping them loses nothing.
 *
 * The operator CLI lives at server/scripts/sanitizeStoredRawMetrics.ts and imports this module. It used to be the other
 * way round — server/index.ts imported the script — which server/scriptsBoundary.test.ts now forbids.
 */

import { db } from "../db";
import { socialAnalyticsSnapshots } from "../../shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { createLogger } from "../logger";

const logger = createLogger("sanitize-raw-metrics");

const SECRET_PARAM = /^(access_token|refresh_token|id_token|token|key|api_key|apikey|client_secret|signature|sig|x-signature|x-expires|oh|oe|_nc_.*)$/i;
const META_TOKEN = /EAA[A-Za-z0-9]{100,}/;
export const DETECT = /access_token=|refresh_token=|Bearer |EAA[A-Za-z0-9]{100,}/;

export function stripUrlSecrets(s: string): string {
  if (!/^https?:\/\//i.test(s)) return META_TOKEN.test(s) ? s.replace(META_TOKEN, "<redacted:secret>") : s;
  let u: URL;
  try { u = new URL(s); } catch { return s; }
  let hit = false;
  for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) hit = true;
  if (!hit) return s;
  u.search = "";
  return u.toString();
}

export function scrubTree(v: unknown): { out: unknown; changed: number } {
  let changed = 0;
  const rec = (x: unknown): unknown => {
    if (typeof x === "string") { const y = stripUrlSecrets(x); if (y !== x) changed++; return y; }
    if (Array.isArray(x)) return x.map(rec);
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        if (k === "paging") { changed++; continue; }
        o[k] = rec(val);
      }
      return o;
    }
    return x;
  };
  return { out: rec(v), changed };
}

export interface ScrubResult { candidates: number; rewritten: number; stillDirty: number; skippedLatest: number }

/**
 * Rewrite every stored row that carries a secret-like string. With keepLatest (the cron's
 * setting) the newest row per athlete × platform is skipped this run and picked up next time.
 */
export async function scrubStoredRawMetrics(opts: { apply: boolean; keepLatest: boolean; log?: (line: string) => void }): Promise<ScrubResult> {
  const say = opts.log ?? (() => {});
  const rows = await db.select({
    id: socialAnalyticsSnapshots.id, athlete_id: socialAnalyticsSnapshots.athlete_id,
    platform: socialAnalyticsSnapshots.platform, day: socialAnalyticsSnapshots.snapshot_day, raw: socialAnalyticsSnapshots.raw_metrics,
  }).from(socialAnalyticsSnapshots)
    .where(sql`${socialAnalyticsSnapshots.raw_metrics}::text ~ 'access_token=|refresh_token=|Bearer |EAA[A-Za-z0-9]{100,}'`);

  let latest = new Set<string>();
  if (opts.keepLatest) {
    const l = await db.execute<{ id: string }>(sql`
      select distinct on (athlete_id, platform) id from social_analytics_snapshots
      order by athlete_id, platform, snapshot_date desc`);
    latest = new Set(((l as any).rows ?? l).map((r: { id: string }) => r.id));
  }

  let rewritten = 0, stillDirty = 0, skippedLatest = 0;
  for (const r of rows) {
    if (latest.has(r.id)) { skippedLatest++; say(`  skip latest ${r.platform} ${r.day}`); continue; }
    const { out, changed } = scrubTree(r.raw);
    const clean = !DETECT.test(JSON.stringify(out));
    if (!clean) stillDirty++;
    say(`  ${r.platform} ${r.day} changes=${changed} clean_after=${clean}`);
    if (opts.apply && clean) {
      await db.update(socialAnalyticsSnapshots).set({ raw_metrics: out as any })
        .where(and(eq(socialAnalyticsSnapshots.id, r.id)));
      rewritten++;
    }
  }
  const result = { candidates: rows.length, rewritten, stillDirty, skippedLatest };
  logger.info(result, "raw_metrics scrub");
  return result;
}
