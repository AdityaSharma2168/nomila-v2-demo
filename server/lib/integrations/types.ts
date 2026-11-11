/**
 * Provider contracts for direct integrations.
 *
 * OAuthProvider  — every connectable platform (inbox + social).
 * InboxProvider  — platforms whose messages feed the deal-detection funnel
 *                  (detectDeal): gmail, outlook, instagram DMs.
 *
 * Providers are plain modules (`import * as gmail`) registered in registry.ts.
 * A module satisfies these interfaces structurally — no class/base required.
 */

/** What a successful handleCallback activated (see activateConnection.ts). */
export interface ActivatedConnection {
  /** The account's one connected_accounts row — the id every follow-up (onConnected, first_look, social_sync) must use. */
  connectionId: string;
  /** This connect's generation (connected_accounts.connected_at). Workflow idempotency keys carry it. */
  connectedAt:  Date;
  /** true when an existing row for the same provider account was updated in place (a reconnect). */
  reactivated:  boolean;
}

export interface OAuthProvider {
  /** Build the provider's OAuth authorization URL. state = athleteId[:alias[:clientPlatform]]. */
  getAuthUrl(athleteId: string, alias?: string, loginHint?: string, clientPlatform?: string): string;
  /**
   * Exchange the auth code for tokens, identify the provider account, and activate its ONE connected_accounts
   * row via activateConnection (reusing the existing row on a reconnect). Throws when the account can't be identified.
   */
  handleCallback(code: string, athleteId: string, alias?: string): Promise<ActivatedConnection>;
}

export interface InboxSyncResult {
  detected: number;
  skipped: number;
}

export interface InboxProvider extends OAuthProvider {
  /**
   * Fire-and-forget after an active connection exists. Use for one-time setup:
   * push/watch registration, webhook subscription, initial backfill.
   * Inbox providers that define this are NOT routed through fetchSocialData.
   */
  onConnected?(connectionId: string, athleteId: string): Promise<void>;
  /** Periodic + webhook-driven pull → normalize → detectDeal. Used by inboxCronSync. */
  syncRecent(connectionId: string, athleteId: string): Promise<InboxSyncResult>;
}

// ─── Analytics ────────────────────────────────────────────────────────────────
// A platform's fetchAnalytics() returns the metric columns + raw_metrics for one
// social_analytics_snapshots row. The collectSocialAnalytics skill stamps the
// athlete_id / connected_account_id / snapshot_day and writes the row.
// This is a DISPLAY/TREND layer — never read by scoringService. All fields are
// best-effort: a value is null when the platform/account/scope doesn't provide it.
import type { SocialAnalyticsRaw } from "../../../shared/schema";

export interface SocialAnalyticsResult {
  followers:            number | null;
  following:            number | null;
  post_count:           number | null;
  total_likes:          number | null;   // TikTok lifetime likes
  total_channel_views:  number | null;   // YouTube
  is_verified:          boolean;

  // Account-level insights
  reach:                number | null;
  impressions:          number | null;   // deprecated on Graph v22 → may carry `views`
  profile_views:        number | null;

  // Derived per-post / per-video aggregates
  avg_engagement_rate:  number | null;
  avg_reach_per_post:   number | null;
  avg_views_per_post:   number | null;
  avg_shares_per_post:  number | null;
  avg_saves_per_post:   number | null;
  avg_watch_time_sec:   number | null;
  content_frequency:    number | null;   // posts/week
  posts_last_30d:       number | null;   // exact 30-day post count (for scoring)

  // Audience demographics (top values; full breakdowns live in raw_metrics)
  top_audience_country:   string | null;
  top_audience_city:      string | null;
  top_audience_age_range: string | null;
  top_audience_gender:    string | null;

  raw_metrics:          SocialAnalyticsRaw;
  toolsCalled:          string[];
}

/** A platform module that supports the analytics snapshot pipeline. */
import type { SocialNative } from "../../services/intelligence/social/native";

/**
 * A platform module that supports the analytics snapshot pipeline.
 *
 * Phase A Step 1a: `fetchNative` returns the provider's responses as a native envelope and
 * `project` turns that envelope into the SocialAnalyticsResult above. `fetchAnalytics` is
 * `project(await fetchNative())` on every platform, so the display contract is unchanged; the
 * envelope is what the social substrate sanitizes, stores and adapts. SocialAnalyticsResult is
 * a DISPLAY projection and stops being a scoring input once the engines read features (Step 4).
 */
export interface AnalyticsProvider {
  fetchAnalytics(connectionId: string): Promise<SocialAnalyticsResult | null>;
  fetchNative(connectionId: string): Promise<SocialNative | null>;
  project(native: any): SocialAnalyticsResult;
  refreshTokenIfNeeded(connectionId: string): Promise<void | string>;
}
