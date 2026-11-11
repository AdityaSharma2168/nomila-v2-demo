/**
 * collectInstagramStories.ts — the Instagram Story sweep and the last-look tick (Phase A Step 1b).
 *
 * Runs only when SOCIAL_STORIES_WRITE=true (its own flag). Connected, active Instagram
 * accounts only; Nomila's shared discovery account is skipped. Fetching happens here (the
 * provider module); the substrate module (services/intelligence/social/stories.ts) writes.
 *
 * Connection expiry: ONLY a call classified `auth` (Meta OAuthException 190/102) marks the
 * connection expired. Every other error — not enough viewers, unsupported metric, rate limit,
 * permission scoping, transient, a bare 403 — leaves the connection intact and the run partial.
 * The nightly collector's message-regex classifier is deliberately not reused here.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { connectedAccounts } from "../../shared/schema";
import { createLogger } from "../logger";
import { openTokenFields } from "../lib/tokenCrypto";
import { fetchInstagramStoriesNative, fetchStoryInsightsNative } from "../lib/integrations/instagram";
import { ingestStoryLastLook, ingestStorySweep, selectStoriesDueForLastLook, type StoryRunResult } from "../services/intelligence/social/stories";
import { getSubstrateParams, storiesWriteEnabled } from "../services/intelligence/social/config";
import { isSharedDiscoveryAccount } from "./collectSocialAnalytics";

const logger = createLogger("collect-instagram-stories");

export interface StorySweepSummary { connections: number; ok: number; partial: number; failed: number; expired: number; stories: number; observations: number }

async function expireConnection(connectionId: string, why: string): Promise<void> {
  await db.update(connectedAccounts).set({ status: "expired" }).where(eq(connectedAccounts.id, connectionId));
  logger.warn({ connectionId, why }, "Instagram connection marked expired (auth-classified failure only)");
}

async function activeInstagramConnections() {
  const rows = await db.select().from(connectedAccounts).where(and(eq(connectedAccounts.platform, "instagram"), eq(connectedAccounts.status, "active")));
  return rows.filter((r) => r.access_token && r.platform_user_id && !isSharedDiscoveryAccount(r.platform, r.platform_user_id));
}

/** Every 8 hours: list live Stories per connected account and read each one's insights. */
export async function runStorySweep(): Promise<StorySweepSummary> {
  const summary: StorySweepSummary = { connections: 0, ok: 0, partial: 0, failed: 0, expired: 0, stories: 0, observations: 0 };
  if (!storiesWriteEnabled()) return summary;
  const conns = await activeInstagramConnections();
  summary.connections = conns.length;
  for (const conn of conns) {
    try {
      const list = await fetchInstagramStoriesNative(conn.id);
      if (!list) { summary.failed++; continue; }
      const opened  = await openTokenFields(conn);
      const secrets = [opened.access_token, opened.refresh_token].filter((s): s is string => !!s);
      const result = await ingestStorySweep({ athleteId: conn.athlete_id, connectedAccountId: conn.id, list, readInsights: (story) => fetchStoryInsightsNative(conn.id, story), secrets });
      tally(summary, result);
      if (result?.authFailure || list.errors.some((e) => (e as { class?: string }).class === "auth")) { await expireConnection(conn.id, "story sweep: Meta auth error"); summary.expired++; }
    } catch (err: any) {
      summary.failed++;
      logger.error({ connectionId: conn.id, error: err.message?.slice(0, 200) }, "story sweep: connection failed (connection kept)");
    }
  }
  logger.info(summary, "story sweep done");
  return summary;
}

/** Hourly: one more reading for every Story aged ≥ 22 h without a successful insight observation since then. */
export async function runStoryLastLookTick(now: Date = new Date()): Promise<StorySweepSummary & { due: number }> {
  const summary = { connections: 0, ok: 0, partial: 0, failed: 0, expired: 0, stories: 0, observations: 0, due: 0 };
  if (!storiesWriteEnabled()) return summary;
  const params = await getSubstrateParams();
  const due = await selectStoriesDueForLastLook(now, params.stories.lastLookHours);
  summary.due = due.length;
  for (const d of due) {
    if (!d.connectedAccountId) { summary.failed++; continue; }
    const [conn] = await db.select().from(connectedAccounts).where(and(eq(connectedAccounts.id, d.connectedAccountId), eq(connectedAccounts.status, "active"))).limit(1);
    if (!conn?.access_token || !conn.platform_user_id) { summary.failed++; continue; }
    try {
      const opened  = await openTokenFields(conn);
      const secrets = [opened.access_token, opened.refresh_token].filter((s): s is string => !!s);
      const result = await ingestStoryLastLook({ due: d, readInsights: (story) => fetchStoryInsightsNative(conn.id, story), secrets, accountId: conn.platform_user_id });
      tally(summary, result);
      if (result?.authFailure) { await expireConnection(conn.id, "story last look: Meta auth error"); summary.expired++; }
    } catch (err: any) {
      summary.failed++;
      logger.error({ connectionId: conn.id, storyId: d.entityId, error: err.message?.slice(0, 200) }, "story last look: failed (connection kept)");
    }
  }
  logger.info(summary, "story last-look tick done");
  return summary;
}

function tally(s: StorySweepSummary, r: StoryRunResult | null): void {
  if (!r) { s.failed++; return; }
  s.stories += r.stories; s.observations += r.observations;
  if (r.status === "ok") s.ok++; else if (r.status === "partial") s.partial++; else s.failed++;
}
