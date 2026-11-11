/**
 * shared/publicPageStats.ts — the Front Door page's counts and the switches its two renderers share (the visitor's
 * server-rendered /p/:handle and the athlete's own native view on Me).
 *
 *   POST /p/:handle/like                    { visitor, liked } → { liked }   a visitor's like (JSON + X-Nomila-Like: 1)
 *   GET  /api/v1/me/public-card/metrics     → PublicPageMetrics              her rail, last 30 days (owner only)
 *
 * Visitors never see a count. Types and constants only: no runtime dependencies.
 */

/** The window the metrics rail counts ("Last 30 days"). */
export const PUBLIC_PAGE_METRICS_DAYS = 30 as const;

/** Her metrics rail: views · likes · requests · bookings · shop, over the last 30 days (today included). */
export interface PublicPageMetrics {
  windowDays: typeof PUBLIC_PAGE_METRICS_DAYS;
  /** The first day counted (UTC, YYYY-MM-DD). */
  since: string;
  views: number;
  likes: number;
  /** Partner requests that reached you (the brand confirmed by email). */
  requests: number;
  /** Bookings past the buyer's email check. */
  bookings: number;
  /** Clicks on your picks' links. */
  shop: number;
}

/** POST /p/:handle/like. `visitor` is the visitor's own random token (16–64 of A–Z a–z 0–9 _ -). */
export interface PublicPageLikeRequest { visitor: string; liked: boolean }
export interface PublicPageLikeResponse { liked: boolean }

/** The custom header every like must carry (it forces a CORS preflight the app never allows). */
export const LIKE_HEADER = "x-nomila-like" as const;

/**
 * "Verified by Nomila" on the page (owner, 10 Oct 2026: undecided, so OFF). The one switch both renderers read: flip it
 * to draw the mark again for athletes the snapshot calls verified.
 */
export const SHOW_VERIFIED = false;
