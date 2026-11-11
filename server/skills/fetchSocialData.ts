/**
 * fetchSocialData.ts — Fetch connected platform data via direct integrations.
 *
 * Triggered from oauthCallback.ts after OAuth completes (fire-and-forget).
 * Never throws to the caller.
 *
 * Per platform (60s timeout):
 *   instagram  → instagram.fetchForScoring()
 *   tiktok     → tiktok.fetchForScoring()
 *   youtube    → youtube.fetchForScoring()
 *   spotify    → spotify.fetchForSpotifyProfile() — identity only, stored in sources.spotify_profile
 *   gmail      → no data fetch — push notification registration happens in oauthCallback.ts
 *
 * After fetch: merges into latest snapshot.social, recomputes _computed,
 * creates a new snapshot (first-look reads its social), and makes sure athletes_current exists.
 *
 * Legacy retirement P2-4 (8 Oct 2026): a connect no longer re-scores — no legacy /850 score, no v3 rate card.
 */

import { db } from "../db";
import { athletes, athleteSnapshots, connectedAccounts } from "../../shared/schema";
import { writeAthletesCurrent } from "../services/athletesCurrentWriter";
import { eq, desc } from "drizzle-orm";
import type {
  SnapshotSocial,
  SnapshotSocialPlatform,
} from "../services/snapshotSocial";
import * as instagram from "../lib/integrations/instagram";
import * as tiktok    from "../lib/integrations/tiktok";
import * as youtube   from "../lib/integrations/youtube";
import * as spotify   from "../lib/integrations/spotify";
import { createLogger } from "../logger";
import { snapshotDealsFor } from "../services/snapshotDeals";
import { scoringSnapshotsOf } from "../lib/snapshotRows";

const logger = createLogger("fetch-social-data");

const PLATFORM_TIMEOUT_MS = 60_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function isAuthError(err: unknown): boolean {
  const msg = ((err as any)?.message ?? "").toLowerCase();
  return msg.includes("unauthorized") || msg.includes("invalid token") ||
    msg.includes("auth") || msg.includes("403") || msg.includes("401");
}

function isRateLimitError(err: unknown): boolean {
  const msg = ((err as any)?.message ?? "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("429") || msg.includes("too many requests");
}

// Retry transient fetch failures with backoff. A single flaky call at connect
// time used to silently drop a whole platform from scoring (it just bumped
// last_fetched_at and wrote nothing) — retrying recovers those in-call.
// Auth and rate-limit errors are NOT retried: auth won't recover on a retry,
// and hammering a rate-limited API is counterproductive — both rethrow so the
// caller can mark the connection expired / skip, exactly as before.
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isAuthError(err) || isRateLimitError(err)) throw err;
      if (attempt < attempts) {
        const delayMs = 1500 * attempt; // 1.5s, 3s
        logger.warn({ label, attempt, error: (err as any)?.message?.slice(0, 120) }, "fetch attempt failed — retrying");
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}


function recomputeComputed(social: SnapshotSocial): NonNullable<SnapshotSocial["_computed"]> {
  const igFollowers    = social.instagram?.followers  ?? 0;
  const tkFollowers    = social.tiktok?.followers     ?? 0;
  const xFollowers     = social.x?.followers          ?? 0;
  const ytSubs         = social.youtube?.subscribers  ?? 0;
  const totalFollowers = igFollowers + tkFollowers + xFollowers + ytSubs;

  const rates = [
    social.instagram?.engagement_rate,
    social.tiktok?.engagement_rate,
    social.youtube?.engagement_rate,
    social.x?.engagement_rate,
  ].filter((r): r is number => r !== undefined && r > 0);
  const avgEngagementRate = rates.length > 0
    ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length * 100) / 100
    : 0;

  const contentFrequency = Math.max(
    social.instagram?.posts_last_30d ?? 0,
    social.tiktok?.posts_last_30d    ?? 0,
    social.youtube?.posts_last_30d   ?? 0,
  );

  const platformCount = [social.instagram, social.tiktok, social.x, social.youtube]
    .filter(Boolean).length;

  let crossPlatformConsistency: number | undefined;
  const ig = social.instagram?.engagement_rate;
  const tk = social.tiktok?.engagement_rate;
  if (ig && tk) {
    crossPlatformConsistency = Math.round((Math.min(ig, tk) / Math.max(ig, tk)) * 100) / 100;
  }

  return {
    total_followers:            totalFollowers > 0 ? totalFollowers : undefined,
    avg_engagement_rate:        avgEngagementRate > 0 ? avgEngagementRate : undefined,
    content_frequency:          contentFrequency > 0 ? contentFrequency : undefined,
    platform_count:             platformCount > 0 ? platformCount : undefined,
    cross_platform_consistency: crossPlatformConsistency,
    data_tier:                  "connected",
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function fetchSocialData(
  athleteId:    string,
  platform:     string,
  connectionId: string,  // connected_accounts.id (UUID)
): Promise<void> {
  const t0 = Date.now();
  logger.info({ athleteId, platform, connectionId }, "fetchSocialData start");

  // Gmail — no data to fetch; push notification setup is handled by oauthCallback.ts
  if (platform === "gmail" || platform === "outlook") {
    await db
      .update(connectedAccounts)
      .set({ last_fetched_at: new Date() })
      .where(eq(connectedAccounts.id, connectionId));
    logger.info({ athleteId, platform }, "Email platform — updated last_fetched_at, no data fetch");
    return;
  }

  // ── Load athlete ───────────────────────────────────────────────────────────
  const [athleteRow] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!athleteRow) {
    logger.error({ athleteId }, "fetchSocialData: athlete not found");
    return;
  }

  // ── Load snapshots ─────────────────────────────────────────────────────────
  const snapRows = await db
    .select()
    .from(athleteSnapshots)
    .where(scoringSnapshotsOf(athleteId))
    .orderBy(desc(athleteSnapshots.created_at))
    .limit(1);

  const [latestSnapRow] = snapRows;

  const existingSocial: SnapshotSocial  = (latestSnapRow?.social   as SnapshotSocial)           ?? {};
  const existingSources                  = (latestSnapRow?.sources  as Record<string, unknown>)  ?? {};

  // ── Fetch platform data ────────────────────────────────────────────────────
  let platformResult: { platform: SnapshotSocialPlatform; toolsCalled: string[] } | null = null;
  let spotifyResult:  { spotifyProfile: Record<string, unknown>; toolsCalled: string[] } | null = null;
  let authExpired = false;

  try {
    if (platform === "instagram") {
      platformResult = await withRetry("instagram", () => withTimeout(instagram.fetchForScoring(connectionId), PLATFORM_TIMEOUT_MS));
    } else if (platform === "tiktok") {
      platformResult = await withRetry("tiktok", () => withTimeout(tiktok.fetchForScoring(connectionId), PLATFORM_TIMEOUT_MS));
    } else if (platform === "youtube") {
      platformResult = await withRetry("youtube", () => withTimeout(youtube.fetchForScoring(connectionId), PLATFORM_TIMEOUT_MS));
    } else if (platform === "spotify") {
      spotifyResult  = await withRetry("spotify", () => withTimeout(spotify.fetchForSpotifyProfile(connectionId), PLATFORM_TIMEOUT_MS)) as any;
    } else {
      logger.warn({ athleteId, platform }, "fetchSocialData: unknown platform — no-op");
      return;
    }
  } catch (err: unknown) {
    if (isAuthError(err)) {
      logger.warn({ athleteId, platform, error: (err as any).message?.slice(0, 120) }, "Auth error — marking connection expired");
      authExpired = true;
    } else if (isRateLimitError(err)) {
      logger.warn({ athleteId, platform, error: (err as any).message?.slice(0, 80) }, "Rate limited — skipping fetch");
      return;
    } else {
      logger.error({ athleteId, platform, error: (err as any).message?.slice(0, 120) }, "fetchSocialData platform fetch failed");
    }
  }

  if (authExpired) {
    await db
      .update(connectedAccounts)
      .set({ status: "expired" })
      .where(eq(connectedAccounts.id, connectionId));
    return;
  }

  // ── Build updated social JSONB ─────────────────────────────────────────────
  const updatedSocial: SnapshotSocial = { ...existingSocial };
  const toolsCalled: string[] = [];
  let spotifyProfile: Record<string, unknown> | undefined;

  if (platformResult) {
    if (platform === "instagram") updatedSocial.instagram = platformResult.platform;
    if (platform === "tiktok")    updatedSocial.tiktok    = platformResult.platform;
    if (platform === "youtube")   updatedSocial.youtube   = platformResult.platform;
    toolsCalled.push(...platformResult.toolsCalled);
    updatedSocial._computed = recomputeComputed(updatedSocial);
  }

  if (spotifyResult) {
    spotifyProfile = (spotifyResult as any).spotifyProfile;
    toolsCalled.push(...(spotifyResult as any).toolsCalled);
  }

  const hasSocialUpdate  = platformResult !== null;
  const hasSpotifyUpdate = spotifyResult  !== null;

  if (!hasSocialUpdate && !hasSpotifyUpdate) {
    // Loud, not silent: this platform is now connected but nothing was collected on connect.
    // The daily analytics collection re-attempts it.
    logger.error(
      { athleteId, platform, connectionId },
      "fetchSocialData: no data collected after retries — platform NOT in the connect snapshot",
    );
    await db
      .update(connectedAccounts)
      .set({ last_fetched_at: new Date() })
      .where(eq(connectedAccounts.id, connectionId));
    return;
  }

  // ── Build new snapshot ────────────────────────────────────────────────────
  const nowIso       = new Date().toISOString();
  const socialToStore = hasSocialUpdate ? updatedSocial : existingSocial;

  const updatedSources = {
    ...existingSources,
    apis_called: [
      ...((existingSources.apis_called as string[]) ?? []),
      ...toolsCalled,
    ],
    ...(spotifyProfile ? { spotify_profile: spotifyProfile } : {}),
    social_connect: { platform, connected_at: nowIso },
  };

  // The deals behind the snapshot — read fresh, never inherited from the previous row.
  const snapshotDeals = await snapshotDealsFor(athleteId);

  // ── Insert snapshot ────────────────────────────────────────────────────────
  const [insertedSnap] = await db.insert(athleteSnapshots).values({
    athlete_id:          athleteId,
    trigger:             "social_connect",
    as_of:               latestSnapRow?.as_of ?? null,   // 2d-6 (D1): inherits the research as-of (NULL when unknown or no research yet)
    research:            latestSnapRow?.research ?? null,
    google_trends_score: latestSnapRow?.google_trends_score ?? null,
    gdelt_article_count: latestSnapRow?.gdelt_article_count ?? null,
    social:              socialToStore,
    deals:               snapshotDeals,
    sources:             updatedSources,
  }).returning({ id: athleteSnapshots.id });

  // ── athletes_current — through the ONE writer: the row exists once she has connected (no score, no rates) ──
  await writeAthletesCurrent({ athleteId });
  const ig = socialToStore.instagram;
  const tk = socialToStore.tiktok;
  const yt = socialToStore.youtube;

  // ── Update connection last_fetched_at ─────────────────────────────────────
  await db
    .update(connectedAccounts)
    .set({ last_fetched_at: new Date() })
    .where(eq(connectedAccounts.id, connectionId));

  const durationMs = Date.now() - t0;
  logger.info({
    athleteId,
    platform,
    toolsCalled,
    dataPointsCollected: {
      followers:       ig?.followers ?? tk?.followers ?? yt?.subscribers,
      engagement_rate: ig?.engagement_rate ?? tk?.engagement_rate ?? yt?.engagement_rate,
      posts_last_30d:  ig?.posts_last_30d ?? tk?.posts_last_30d ?? yt?.posts_last_30d,
    },
    snapshotId: insertedSnap.id,
    durationMs,
  }, "fetchSocialData complete");
}
