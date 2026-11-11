/**
 * agent/reads/dbSource.ts — the app's ReadsSource: the existing services, reused as they are, plus two small readers
 * that had no service (her recent posts with their stored counts, and the account snapshots' first and last day).
 * Every query filters the athlete id it is given (the run's); nothing here calls a provider except searchMedia's one
 * text embedding for the query. Loaded on first use (coreTools.ts), so the registry never imports the services.
 */
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { deals, inboxThreads, mediaAssets, socialAnalyticsSnapshots } from "../../../shared/schema";
import { readFinancialSummary } from "../../services/moneySummary";
import { searchMedia } from "../../services/mediaSearch";
import { readWhatMattersNext } from "../../services/whatMattersNext";
import { readBookingsSummary } from "../../services/bookings/summary";
import { listOutstandingDeliverables } from "../../studio/dealDeliverables";
import { readMeeting } from "../../skills/meetings";
import { whatWorksIfOn } from "../learning/db";
import type { MeetingRow, PostRow, ReadsSource, SnapshotRow } from "./source";

/** At most this many snapshot rows are read per call (three platforms × a 90-day window, with room). */
const SNAPSHOT_ROWS_MAX = 300;
/** At most this many meeting threads are read per call. */
const MEETING_ROWS_MAX = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numOrNull =(v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : v != null && Number.isFinite(Number(v)) ? Number(v) : null);

function insightsOf(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of ["reach", "saved", "shares", "total_interactions", "video_views"]) {
      const n = numOrNull((raw as Record<string, unknown>)[k]);
      if (n != null) out[k] = n;
    }
  }
  return out;
}

export const dbReadsSource: ReadsSource = {
  searchMedia: (athleteId, q) => searchMedia(athleteId, { brief: q.query, filters: q.filters, k: q.k, diverse: true, signUrls: false }),

  async recentPosts(athleteId, p): Promise<PostRow[]> {
    const rows = await db.select({
      id: mediaAssets.id, platform: mediaAssets.platform, mediaType: mediaAssets.media_type, postedAt: mediaAssets.posted_at,
      likes: mediaAssets.like_count, comments: mediaAssets.comments_count, insights: mediaAssets.insights, caption: mediaAssets.caption,
    }).from(mediaAssets).where(and(
      eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.origin, "connected"), isNull(mediaAssets.parent_media_id),
      isNull(mediaAssets.deleted_at), gte(mediaAssets.posted_at, p.since),
    )).orderBy(desc(mediaAssets.posted_at)).limit(p.limit);
    return rows.map((r) => ({
      id: r.id, platform: r.platform, mediaType: r.mediaType, postedAt: r.postedAt ? r.postedAt.toISOString() : null,
      likes: r.likes ?? null, comments: r.comments ?? null, insights: insightsOf(r.insights), caption: r.caption ?? null,
    }));
  },

  async accountTrend(athleteId, p) {
    const rows = await db.select({
      platform: socialAnalyticsSnapshots.platform, day: socialAnalyticsSnapshots.snapshot_day, followers: socialAnalyticsSnapshots.followers,
      reach: socialAnalyticsSnapshots.reach, engagementRate: socialAnalyticsSnapshots.avg_engagement_rate,
      avgReach: socialAnalyticsSnapshots.avg_reach_per_post, avgViews: socialAnalyticsSnapshots.avg_views_per_post,
      avgSaves: socialAnalyticsSnapshots.avg_saves_per_post, postsLast30d: socialAnalyticsSnapshots.posts_last_30d,
      topCountry: socialAnalyticsSnapshots.top_audience_country, topAgeRange: socialAnalyticsSnapshots.top_audience_age_range,
    }).from(socialAnalyticsSnapshots).where(and(
      eq(socialAnalyticsSnapshots.athlete_id, athleteId), gte(socialAnalyticsSnapshots.snapshot_date, p.since),
    )).orderBy(desc(socialAnalyticsSnapshots.snapshot_day)).limit(SNAPSHOT_ROWS_MAX);
    const by = new Map<string, SnapshotRow[]>();
    for (const r of rows) {
      const row: SnapshotRow = { ...r, day: String(r.day), engagementRate: numOrNull(r.engagementRate) };
      by.set(r.platform, [...(by.get(r.platform) ?? []), row]);
    }
    return [...by.entries()].map(([platform, list]) => ({ platform, newest: list[0], oldest: list[list.length - 1] }));
  },

  whatWorks: (athleteId, now) => whatWorksIfOn(athleteId, now),
  money: (athleteId, now) => readFinancialSummary(athleteId, now),
  next: (athleteId, now) => readWhatMattersNext(athleteId, now),
  deliverables: (athleteId) => listOutstandingDeliverables(athleteId),
  bookings: (athleteId) => readBookingsSummary(athleteId),

  async meetings(athleteId, p): Promise<MeetingRow[]> {
    const date = sql<string>`${inboxThreads.classification} -> 'meeting' -> 'start' ->> 'date'`;
    const rows = await db.select({ id: inboxThreads.id, classification: inboxThreads.classification })
      .from(inboxThreads)
      .where(and(eq(inboxThreads.athlete_id, athleteId), sql`${date} >= ${p.fromDay}`, sql`${date} <= ${p.toDay}`))
      .orderBy(sql`${date} ASC`).limit(MEETING_ROWS_MAX);
    const out: MeetingRow[] = [];
    const dealIds = new Set<string>();
    for (const r of rows) {
      const m = readMeeting(r.classification);
      if (!m?.start?.date || m.event === "canceled") continue;
      if (m.deal_id && UUID.test(m.deal_id)) dealIds.add(m.deal_id);
      out.push({ threadId: r.id, dealId: m.deal_id ?? null, brand: null, event: m.event, start: m.start });
    }
    if (dealIds.size) {
      // The brand comes from HER deal only (the join repeats her id).
      const ds = await db.select({ id: deals.id, brand: deals.brand_name }).from(deals)
        .where(and(eq(deals.athlete_id, athleteId), inArray(deals.id, [...dealIds])));
      const brand = new Map(ds.map((d) => [d.id, d.brand]));
      for (const o of out) if (o.dealId) { o.brand = brand.get(o.dealId) ?? null; if (!brand.has(o.dealId)) o.dealId = null; }
    }
    return out;
  },
};
