import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../lib/auth-context";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";

// ─── Types (mirror GET /api/v1/me/media) ────────────────────────────────────────
export interface MediaChild { id: string; media_type: string; url: string | null }

export interface MediaItem {
  id:             string;
  platform:       string;   // 'instagram' | 'tiktok' | 'youtube'
  media_type:     "IMAGE" | "VIDEO" | "REELS" | "CAROUSEL_ALBUM";
  permalink:      string | null;
  caption:        string | null;
  posted_at:      string | null;
  like_count:     number | null;
  comments_count: number | null;
  views:          number | null;   // TikTok/YouTube always; IG on enriched top posts
  reach:          number | null;   // IG enriched top posts
  saves:          number | null;
  shares:         number | null;
  url:            string | null;   // signed, ~1h TTL
  thumb_url:      string | null;   // poster image (fast grid tile)
  video_url:      string | null;   // playable mp4 when we own it (IG top performers); else null
  children?:      MediaChild[];    // CAROUSEL_ALBUM items
}

export interface MediaSummary {
  total:       number;
  by_platform: Record<string, number>;         // { instagram, tiktok, youtube }
  by_type:     { photos: number; videos: number };
}

async function getJson<T>(path: string): Promise<T | null> {
  const url     = new URL(path, getApiUrl()).toString();
  const headers = await getAuthHeaders();
  const res     = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** The athlete's own durable (re-hosted) posts, newest first. Scoped to one platform when given. */
export function useMedia(platform?: string) {
  const { athlete } = useAuth();
  const query = useQuery<{ items: MediaItem[]; top?: MediaItem[]; next_cursor: unknown; summary?: MediaSummary } | null>({
    queryKey: [`/api/v1/me/media`, athlete?.id, platform ?? "all"],
    enabled:  !!athlete?.id,
    queryFn:  () => getJson(`/api/v1/me/media${platform ? `?platform=${encodeURIComponent(platform)}` : ""}`),
    staleTime:      0,          // always consider stale so a mount refetches (avoids expired signed URLs)
    refetchOnMount: "always",   // force a fresh fetch — never render a stale cached response
  });
  return {
    items:     query.data?.items ?? [],
    top:       query.data?.top ?? [],
    summary:   query.data?.summary ?? null,
    isLoading: query.isLoading,
    error:     query.error as Error | null,
    refetch:   query.refetch,
  };
}
