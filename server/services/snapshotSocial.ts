/**
 * snapshotSocial.ts — the shape of `athlete_snapshots.social` / `.research` as the snapshot writers store them.
 *
 * Moved out of the retired v7.2 scoring engine (services/scoringService.ts, deleted in the legacy retirement P2-5,
 * 8 Oct 2026). The snapshots are still written (research, social connect) and read (first-look, research merge,
 * platform discovery); only the score computed from them is gone. Byte for byte the types they were.
 */

export interface SnapshotSocialPlatform {
  handle?:            string | null;
  followers?:         number;
  engagement_rate?:   number;
  posts_last_30d?:    number;
  avg_likes?:         number;
  avg_comments?:      number;
  avg_views?:         number;
  subscribers?:       number;
  monthly_listeners?: number;
  media_count?:       number;
  verified?:          boolean;
  website?:           string;
  topic_categories?:  string[];
  short_form_ratio?:  number;
  fetched_at?:        string;
  source?:            "business_discovery" | "data_api" | "connected" | "oauth" | "research";
}

export interface SnapshotSocial {
  instagram?: SnapshotSocialPlatform;
  tiktok?:    SnapshotSocialPlatform;
  x?:         SnapshotSocialPlatform;
  youtube?:   SnapshotSocialPlatform;
  spotify?:   SnapshotSocialPlatform;
  _computed?: {
    total_followers?:            number;
    content_frequency?:          number;
    avg_engagement_rate?:        number;
    platform_count?:             number;
    cross_platform_consistency?: number;
    data_tier?:                  "discovery" | "connected";
  };
}

export interface SnapshotResearch {
  achievements?:    Array<{ name: string; year?: string; level?: string }>;
  press_mentions?:  Array<{ outlet: string; headline: string; date?: string }>;
  brand_mentions?:  Array<{ brand: string; type?: string; confidence?: number | string }>;
  story_arc?:       string | null;
  sentiment?:       { positive?: number; negative?: number };
  media_assets?:    { images?: unknown[]; videos?: unknown[]; audio?: unknown[] };
}
