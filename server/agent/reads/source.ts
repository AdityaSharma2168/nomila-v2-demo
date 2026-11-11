/**
 * agent/reads/source.ts — what Mila's read tools (reads/tools.ts) read, as one seam. Every method takes the RUN's
 * athlete (ToolContext), never one from the model; dbSource.ts is the app's (existing services, reused), tests pass
 * their own.
 *
 *   searchMedia     services/mediaSearch.ts searchMedia (one text embedding for the query; no signed URLs)
 *   recentPosts     her own posts (media_assets, origin connected) with the counts and insights the sync stored
 *   accountTrend    social_analytics_snapshots: per platform, the newest day and the oldest day in the window
 *   whatWorks       agent/learning/db.ts whatWorksIfOn (null while the learning loop is off)
 *   money           services/moneySummary.ts readFinancialSummary
 *   next            services/whatMattersNext.ts readWhatMattersNext (Home's list)
 *   deliverables    studio/dealDeliverables.ts listOutstandingDeliverables (open, not superseded, her deals only)
 *   meetings        calendar invites placed on her deals (inbox_threads.classification.meeting, skills/meetings.ts)
 *   bookings        services/bookings/summary.ts readBookingsSummary (requests and upcoming sessions)
 */
import type { BookingsSummary, FinancialSummary, WhatMattersNext } from "../../../shared/meSummaries";
import type { WhatWorks } from "../learning/core";
import type { MediaFilters, SearchResult } from "../../services/mediaSearch";
import type { OutstandingDeliverable } from "../../studio/dealDeliverables";

/** The switch for Mila's read tools (media_search, posts_performance, money_summary, whats_next). Exactly "true" is on. */
export const milaReadToolsEnabled = (): boolean => process.env.MILA_READ_TOOLS === "true";

export interface PostRow {
  id: string;
  platform: string;
  mediaType: string;
  postedAt: string | null;
  likes: number | null;
  comments: number | null;
  /** The sync's per-post insights as stored: reach, saved, shares, total_interactions, video_views (any may be absent). */
  insights: Record<string, number>;
  caption: string | null;
}

export interface SnapshotRow {
  platform: string;
  day: string;
  followers: number | null;
  reach: number | null;
  engagementRate: number | null;
  avgReach: number | null;
  avgViews: number | null;
  avgSaves: number | null;
  postsLast30d: number | null;
  topCountry: string | null;
  topAgeRange: string | null;
}

export interface MeetingRow {
  threadId: string;
  dealId: string | null;
  brand: string | null;
  event: string;
  start: { date: string; time: string | null; tz: string | null };
}

export interface ReadsSource {
  searchMedia(athleteId: string, q: { query: string; filters: MediaFilters; k: number }): Promise<SearchResult[]>;
  recentPosts(athleteId: string, p: { since: Date; limit: number }): Promise<PostRow[]>;
  accountTrend(athleteId: string, p: { since: Date }): Promise<Array<{ platform: string; newest: SnapshotRow; oldest: SnapshotRow }>>;
  whatWorks(athleteId: string, now: Date): Promise<WhatWorks | null>;
  money(athleteId: string, now: Date): Promise<FinancialSummary>;
  next(athleteId: string, now: Date): Promise<WhatMattersNext>;
  deliverables(athleteId: string): Promise<OutstandingDeliverable[]>;
  meetings(athleteId: string, p: { fromDay: string; toDay: string }): Promise<MeetingRow[]>;
  bookings(athleteId: string): Promise<BookingsSummary>;
}
