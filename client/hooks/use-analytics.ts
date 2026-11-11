import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../lib/auth-context";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";

// ─── Types (mirror server social_analytics_snapshots + raw_metrics) ────────────

export interface DemographicRow { key: string; value: number; pct: number }

export interface SnapshotMedia {
  id:             string;
  permalink:      string;
  media_type:     string;
  caption:        string | null;
  timestamp:      string;
  media_url:      string | null;
  thumbnail_url:  string | null;
  like_count:     number | null;
  comments_count: number | null;
  is_shared_to_feed?: boolean | null;   // raw Graph flag (false = not cross-posted to grid — the default)
  is_discovery?:      boolean | null;   // confirmed Trial/Discovery reel (reach ≥ 2× followers)
  insights: {
    reach?: number; saved?: number; shares?: number; video_views?: number; total_interactions?: number;
  } | null;
}

export interface AnalyticsSnapshot {
  platform:             "instagram" | "tiktok" | "youtube";
  snapshot_date:        string;
  snapshot_day:         string;
  followers:            number | null;
  following:            number | null;
  post_count:           number | null;
  total_likes:          number | null;
  total_channel_views:  number | null;
  is_verified:          boolean;
  reach:                number | null;
  impressions:          number | null;   // v22 `views`
  profile_views:        number | null;
  avg_engagement_rate:  number | null;
  avg_reach_per_post:   number | null;
  avg_views_per_post:   number | null;
  avg_shares_per_post:  number | null;
  avg_saves_per_post:   number | null;
  avg_watch_time_sec:   number | null;
  content_frequency:    number | null;
  top_audience_country:   string | null;
  top_audience_city:      string | null;
  top_audience_age_range: string | null;
  top_audience_gender:    string | null;
  raw_metrics: {
    demographics?: { country?: DemographicRow[]; city?: DemographicRow[]; age?: DemographicRow[]; gender?: DemographicRow[] };
    recent_media?: SnapshotMedia[];
    discovery?: { reels: number; total_reach: number; avg_reach: number | null };  // Trial-reel reach, kept out of core avg
    youtube?: {
      views_30d?: number; minutes_watched_30d?: number; avg_view_pct?: number;
      subs_gained_30d?: number; subs_lost_30d?: number; subs_net_30d?: number;
      age_gender?: Array<{ age: string; gender: string; pct: number }>;
      countries?: DemographicRow[]; traffic?: DemographicRow[]; devices?: DemographicRow[];
    };
  } | null;
}

export interface AnalyticsTrends {
  followers_7d:   number | null;
  followers_30d:  number | null;
  engagement_30d: number | null;
  reach_30d:      number | null;
  views_30d:      number | null;
}

async function get<T>(path: string): Promise<T | null> {
  const url     = new URL(path, getApiUrl()).toString();
  const headers = await getAuthHeaders();
  const res     = await fetch(url, { headers });
  if (res.status === 404) return null;      // no analytics yet — not an error
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ─── Hooks ─────────────────────────────────────────────────────────────────────

/** Latest snapshot per connected platform. */
export function useAnalytics() {
  const { athlete } = useAuth();
  const query = useQuery<{ platforms: AnalyticsSnapshot[] } | null>({
    queryKey: [`/api/v1/me/analytics`, athlete?.id],
    enabled:  !!athlete?.id,
    queryFn:  () => get<{ platforms: AnalyticsSnapshot[] }>("/api/v1/me/analytics"),
  });
  return {
    platforms: query.data?.platforms ?? [],
    isLoading: query.isLoading,
    error:     query.error as Error | null,
    refetch:   query.refetch,
  };
}

/** Chronological series + trend deltas for one platform (drives the sparkline). */
export function useAnalyticsHistory(platform: string | null) {
  const { athlete } = useAuth();
  const query = useQuery<{ platform: string; series: AnalyticsSnapshot[]; trends: AnalyticsTrends | null } | null>({
    queryKey: [`/api/v1/me/analytics`, platform, "history", athlete?.id],
    enabled:  !!athlete?.id && !!platform,
    queryFn:  () => get(`/api/v1/me/analytics/${platform}/history`),
  });
  return {
    series:    query.data?.series ?? [],
    trends:    query.data?.trends ?? null,
    isLoading: query.isLoading,
  };
}
