/**
 * mediaBackfill — full-history, resumable, throttled ingestion of an athlete's media
 * (Instagram + TikTok + YouTube) into media_assets, reusing the exact ingest core from
 * rehostAthleteMedia (own the pixels once, refresh metadata on re-see, stamp pixel_grade).
 *
 * Pacing, not truncation (see docs/media-library-backfill.md): each tick paginates from the
 * per-athlete/platform checkpoint (media_backfill_state) up to ITEM_BUDGET_PER_TICK items,
 * ingests them, advances the cursor, and marks `complete` when history is exhausted. A
 * prolific account spans several ticks so it never bursts the shared API rate/quota budget
 * the daily sync depends on. BACKSTOP is a broken-loop guard only, never a content limit.
 * Best-effort and decoupled: a failure parks the platform at `error` and never throws.
 */
import { db } from "../db";
import { connectedAccounts, mediaBackfillState } from "../../shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { ingestOne, loadSeen, type RecentMedia } from "./rehostAthleteMedia";
import { listMediaPage as igListMediaPage } from "../lib/integrations/instagram";
import { listMediaPage as ttListMediaPage } from "../lib/integrations/tiktok";
import { listMediaPage as ytListMediaPage } from "../lib/integrations/youtube";
import { createLogger } from "../logger";
import { openTokenFields } from "../lib/tokenCrypto";

const logger = createLogger("media-backfill");
import { ingestBackfillPage } from "../services/intelligence/social/substrate";
import { substrateWriteEnabled } from "../services/intelligence/social/config";
import { adaptMedia } from "../services/intelligence/social/adapters/instagram";
import { adaptVideo } from "../services/intelligence/social/adapters/tiktok";
import { adaptYtVideo } from "../services/intelligence/social/adapters/youtube";
import type { ObservationInput, ContentInput } from "../services/intelligence/social/adapters/types";

const PLATFORMS = ["instagram", "tiktok", "youtube"] as const;
type Platform = (typeof PLATFORMS)[number];

type PageFetcher = (connectionId: string, cursor: string | null) => Promise<{ items: RecentMedia[]; nextCursor: string | null; native?: unknown[] }>;
const PAGE_FETCHERS: Record<Platform, PageFetcher> = {
  instagram: igListMediaPage,
  tiktok:    ttListMediaPage,
  youtube:   ytListMediaPage,
};

const ITEM_BUDGET_PER_TICK = 300;   // throttle: items paginated per platform per run
const BACKSTOP             = 10_000; // broken-loop guard (bad cursor that never ends) — not a content cap
const CONCURRENCY          = 4;

async function activeConnectionId(athleteId: string, platform: string): Promise<string | null> {
  const [row] = await db.select({ id: connectedAccounts.id }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.platform, platform), eq(connectedAccounts.status, "active")))
    .limit(1);
  return row?.id ?? null;
}

async function saveState(athleteId: string, platform: string, patch: Record<string, unknown>): Promise<void> {
  const set = { ...patch, updated_at: new Date() };
  await db.insert(mediaBackfillState).values({ athlete_id: athleteId, platform, ...set })
    .onConflictDoUpdate({ target: [mediaBackfillState.athlete_id, mediaBackfillState.platform], set });
}

/** Advance one platform's backfill by up to `budget` items. Resumable — safe to call repeatedly. */
export async function backfillAthletePlatform(
  athleteId: string, platform: Platform, budget = ITEM_BUDGET_PER_TICK,
): Promise<{ platform: string; ingested: number; done: boolean; skipped?: string }> {
  const [state] = await db.select().from(mediaBackfillState)
    .where(and(eq(mediaBackfillState.athlete_id, athleteId), eq(mediaBackfillState.platform, platform))).limit(1);
  if (state?.status === "complete") return { platform, ingested: 0, done: true, skipped: "complete" };

  const connectionId = await activeConnectionId(athleteId, platform);
  if (!connectionId) return { platform, ingested: 0, done: true, skipped: "no-connection" };

  const fetchPage = PAGE_FETCHERS[platform];
  const seen = await loadSeen(athleteId);
  let cursor    = state?.cursor ?? null;
  let itemsSeen = state?.items_seen ?? 0;
  let ingested  = 0;
  let done      = false;
  let pageIndex = 0;
  let connRow: { id: string; platform_user_id: string | null; platform_username: string | null; access_token: string | null; refresh_token: string | null } | null = null;

  await saveState(athleteId, platform, { status: "running" });

  try {
    while (ingested < budget && itemsSeen < BACKSTOP) {
      const { items, nextCursor, native } = await fetchPage(connectionId, cursor);
      if (!items.length) { done = true; break; }
      // Shadow write (flag-gated): the page as a sanitized payload + content observations at fetch time.
      if (substrateWriteEnabled() && native?.length) {
        const conn = connRow ?? (connRow = await db.select({ id: connectedAccounts.id, platform_user_id: connectedAccounts.platform_user_id, platform_username: connectedAccounts.platform_username, access_token: connectedAccounts.access_token, refresh_token: connectedAccounts.refresh_token })
          .from(connectedAccounts).where(eq(connectedAccounts.id, connectionId)).limit(1).then(async (x) => (await openTokenFields(x[0])) ?? null));
        if (conn) await ingestBackfillPage({
          athleteId, platform, connectedAccountId: conn.id, accountId: conn.platform_user_id, handle: conn.platform_username,
          pageIndex, cursor, items: native, secrets: [conn.access_token, conn.refresh_token].filter((t): t is string => !!t),
          adaptItems: (at) => {
            const observations: ObservationInput[] = [], content: ContentInput[] = [];
            for (const n of native as any[]) {
              if (platform === "instagram") adaptMedia(n, at, observations, content);
              else if (platform === "tiktok") adaptVideo(n, at, observations, content);
              else adaptYtVideo(n, at, observations, content);
            }
            return { observations, content };
          },
        });
        pageIndex++;
      }
      for (let i = 0; i < items.length; i += CONCURRENCY) {
        const batch = items.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map((m) => ingestOne(athleteId, platform, "connected", m, seen).catch(() => "failed" as const)));
      }
      ingested  += items.length;
      itemsSeen += items.length;
      cursor     = nextCursor;
      if (!nextCursor) { done = true; break; }
    }
    if (!done && itemsSeen >= BACKSTOP) {
      done = true;
      logger.warn({ athleteId, platform, itemsSeen }, "backfill hit backstop — stopping (broken-loop guard)");
    }
    await saveState(athleteId, platform, { cursor, items_seen: itemsSeen, status: done ? "complete" : "pending", last_error: null });
  } catch (e: any) {
    await saveState(athleteId, platform, { cursor, items_seen: itemsSeen, status: "error", last_error: e?.message?.slice(0, 200) ?? "error" });
    logger.warn({ athleteId, platform, error: e?.message?.slice(0, 120) }, "backfill tick failed");
  }
  return { platform, ingested, done };
}

/** One backfill tick across all three platforms for a single athlete. */
export async function backfillAthlete(athleteId: string, budget = ITEM_BUDGET_PER_TICK) {
  const results = [];
  for (const p of PLATFORMS) results.push(await backfillAthletePlatform(athleteId, p, budget));
  logger.info({ athleteId, results }, "athlete media backfill tick");

  // FU2 — when a platform's download history FRESHLY completes this tick (done, and not merely
  // already-complete / no-connection), kick enrichment for this athlete so their Nomi Card, posts
  // and ads have a searchable index ASAP. Fire-and-forget drain (idempotent, resumable); the
  // scheduled media-enrich-cron catches any remainder if this is cut short.
  if (results.some((r) => r.done && !r.skipped)) {
    void import("../services/mediaEnrichment.js").then(async ({ enrichNextChunk }) => {
      try {
        for (let i = 0; i < 30; i++) {
          const r = await enrichNextChunk({ athleteId, chunk: 24 });
          if (r.remaining === 0 || r.total === 0) break;
        }
        logger.info({ athleteId }, "post-backfill enrichment drain complete");
      } catch (e: any) {
        logger.warn({ athleteId, error: e?.message?.slice(0, 120) }, "post-backfill enrichment kick failed");
      }
    });
  }
  return results;
}

/** Daily cron entry: advance the backfill one tick for every athlete with an active social connection. */
export async function backfillAllAthletes(budget = ITEM_BUDGET_PER_TICK): Promise<{ athletes: number }> {
  const rows = await db.selectDistinct({ id: connectedAccounts.athlete_id }).from(connectedAccounts)
    .where(and(inArray(connectedAccounts.platform, [...PLATFORMS]), eq(connectedAccounts.status, "active")));
  for (const r of rows) {
    await backfillAthlete(r.id, budget).catch((e: any) => logger.warn({ athleteId: r.id, error: e?.message?.slice(0, 120) }, "athlete backfill failed"));
  }
  logger.info({ athletes: rows.length }, "media backfill batch tick complete");
  return { athletes: rows.length };
}
