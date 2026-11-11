/**
 * social/substrate.ts — the pipeline behind the flag: native envelope → sanitize → store raw →
 * adapt → write canonical rows → recompute features.
 *
 * Called by the skills that already fetch (collectSocialAnalytics, collectDiscoveryAnalytics,
 * mediaBackfill, enrichTopPostInsights) AFTER their existing writes, and only when
 * SOCIAL_SUBSTRATE_WRITE is on. Every entry point swallows its own errors into the sync run's
 * status so a substrate failure can never fail the pre-existing path.
 */

import { createLogger } from "../../../logger";
import type { SourceClass } from "../types";
import type { SocialNative, InstagramNative, TikTokNative, YouTubeNative, InstagramDiscoveryNative, YouTubeDiscoveryNative } from "./native";
import { adaptInstagram, adaptMedia } from "./adapters/instagram";
import { adaptTikTok } from "./adapters/tiktok";
import { adaptYouTube, adaptYouTubeDiscovery } from "./adapters/youtube";
import { adaptInstagramDiscovery } from "./adapters/discovery";
import type { AdaptContext, AdaptResult, ObservationInput, ContentInput } from "./adapters/types";
import { calculateSocialFeatures } from "./features";
import { getSubstrateParams, substrateWriteEnabled } from "./config";
import { closeSyncRun, ensureIdentity, listIdentities, loadDistributions, loadObservations, openSyncRun, storePayload, writeAdaptResult, writeFeatures, writeObservations, type WriteContext, connectedByUserId } from "./ingest";
import { SanitizerLeakError } from "./sanitize";
import { bioOf, persistProfileBio } from "./profileBio";
import { enforceRawRetention } from "./retention";
import { db } from "../../../db";
import { socialIdentities } from "../../../../shared/schema";
import type { IgMediaNode } from "./native";

// Step 1b — Instagram Stories live in ./stories.ts and share every helper here.
export { ingestStorySweep, ingestStoryLastLook, selectStoriesDueForLastLook } from "./stories";

const logger = createLogger("social-substrate");

export type SyncTrigger = "connect" | "nightly" | "backfill" | "discovery" | "manual" | "fixture" | "stories";

export interface IngestInput {
  athleteId: string;
  native: SocialNative;
  trigger: SyncTrigger;
  connectedAccountId?: string | null;
  /** Live credential strings for this call. Redacted from every stored byte and asserted absent. */
  secrets: string[];
}

export interface IngestResult { runId: string; identityId: string; payloads: number; observations: number; distributions: number; contentLinked: number; status: "ok" | "partial" | "failed" }

const PROVIDER: Record<SocialNative["platform"], string> = { instagram: "meta_graph", tiktok: "tiktok_display", youtube: "youtube" };

function classify(native: SocialNative): { sourceClass: SourceClass; endpointFamily: string } {
  if (native.sourceMethod === "meta_business_discovery") return { sourceClass: "platform_public", endpointFamily: "business_discovery" };
  if (native.sourceMethod === "youtube_data_api") return { sourceClass: "platform_public", endpointFamily: "public_channel" };
  return { sourceClass: "connected_verified", endpointFamily: `${native.platform}_connected_bundle` };
}

/** The sub-responses an envelope carries, stored one payload row each. */
function payloadsOf(native: SocialNative): Array<{ family: string; request: Record<string, unknown>; body: unknown }> {
  switch (native.sourceMethod) {
    case "meta_business_discovery": { const n = native as InstagramDiscoveryNative; return [{ family: "business_discovery", request: { path: "/{ig-business-id}", params: { fields: "business_discovery.username(...)" } }, body: n.businessDiscovery }]; }
    case "youtube_data_api": { const n = native as YouTubeDiscoveryNative; return [{ family: "channels", request: { path: "/channels", params: { part: "snippet,statistics" } }, body: n.channel }, { family: "videos", request: { path: "/videos", params: { part: "statistics,contentDetails,snippet" } }, body: n.videos }]; }
  }
  switch (native.platform) {
    case "instagram": { const n = native as InstagramNative; return [
      { family: "profile", request: { path: "/{ig-user-id}", params: { fields: "id,username,followers_count,follows_count,media_count" } }, body: n.profile },
      { family: "account_insights", request: { path: "/{ig-user-id}/insights", params: { metric: "reach,views,profile_links_taps", period: "day" } }, body: n.accountInsights },
      { family: "media", request: { path: "/{ig-user-id}/media", params: { limit: 25, fields: n.mediaFetchMode } }, body: n.media },
      { family: "demographics", request: { path: "/{ig-user-id}/insights", params: { metric: "follower_demographics", timeframe: "last_30_days" } }, body: n.demographics },
    ]; }
    case "tiktok": { const n = native as TikTokNative; return [
      { family: "user_info", request: { path: "/v2/user/info/", params: {} }, body: n.user },
      { family: "video_list", request: { path: "/v2/video/list/", params: { max_count: 20 } }, body: n.videos },
      { family: "creator_info", request: { path: "/v2/creator/info/", params: {} }, body: n.demographics },
    ]; }
    case "youtube": { const n = native as YouTubeNative; return [
      { family: "channels", request: { path: "/channels", params: { part: "snippet,statistics", mine: "true" } }, body: n.channel },
      { family: "analytics_reports", request: { path: "/v2/reports", params: { startDate: n.analytics.reportStart, endDate: n.analytics.reportEnd } }, body: n.analytics },
      { family: "videos", request: { path: "/videos", params: { part: "statistics,snippet" } }, body: n.videos },
    ]; }
  }
}

function adapt(native: SocialNative, ctx: AdaptContext): AdaptResult {
  if (native.sourceMethod === "meta_business_discovery") return adaptInstagramDiscovery(native as InstagramDiscoveryNative, ctx);
  if (native.sourceMethod === "youtube_data_api") return adaptYouTubeDiscovery(native as YouTubeDiscoveryNative, ctx);
  switch (native.platform) {
    case "instagram": return adaptInstagram(native as InstagramNative, ctx);
    case "tiktok":    return adaptTikTok(native as TikTokNative, ctx);
    case "youtube":   return adaptYouTube(native as YouTubeNative, ctx);
  }
}

/** Full ingest of one envelope. Never throws: returns a failed result and logs. */
export async function ingestNative(i: IngestInput): Promise<IngestResult | null> {
  if (!substrateWriteEnabled()) return null;
  const { sourceClass, endpointFamily } = classify(i.native);
  const provider = PROVIDER[i.native.platform];
  const fetchedAt = new Date(i.native.fetchedAt);
  let runId: string | null = null;
  try {
    const params = await getSubstrateParams();
    const identity = await ensureIdentity({
      athleteId: i.athleteId, platform: i.native.platform, accountId: i.native.accountId, accountIdKind: "platform_id",
      handle: i.native.handle, canonicalUrl: null, sourceClass, sourceMethod: i.native.sourceMethod,
      confidence: sourceClass === "connected_verified" ? 1 : 0.7, connectedAccountId: i.connectedAccountId ?? null, verifiedAt: fetchedAt,
      byUserId: await connectedByUserId(i.connectedAccountId ?? null),   // 3b: the connecting user (3a column) for a §3a-C collision claim
    });
    runId = await openSyncRun({ athleteId: i.athleteId, identityId: identity.id, platform: i.native.platform, provider, endpointFamily, apiVersion: i.native.apiVersion, sourceClass, trigger: i.trigger, connectedAccountId: i.connectedAccountId ?? null });

    const retentionDays = params.rawRetentionDays[sourceClass === "connected_verified" ? "connected_verified" : "platform_public"];
    // One stored payload per sub-response; each canonical row names the family it was read from,
    // so payload_id is the payload that actually produced it (or NULL, never another family's).
    let payloads = 0; const payloadIds: Record<string, string> = {};
    for (const [idx, p] of payloadsOf(i.native).entries()) {
      if (p.body == null) continue;
      const stored = await storePayload({ runId, athleteId: i.athleteId, platform: i.native.platform, provider, endpointFamily: p.family, pageIndex: idx, sourceClass, request: p.request, payload: p.body, fetchedAt, retentionDays, secrets: i.secrets });
      payloadIds[p.family] = stored.id; payloads++;
    }

    const ctx: AdaptContext = { athleteId: i.athleteId, platform: i.native.platform, sourceClass, sourceMethod: i.native.sourceMethod, provider, observedAt: fetchedAt.toISOString() };
    const result = adapt(i.native, ctx);
    const w: WriteContext = { athleteId: i.athleteId, platform: i.native.platform, identityId: identity.id, sourceClass, sourceMethod: i.native.sourceMethod, provider, runId, payloadIds };
    const written = await writeAdaptResult(w, result, i.secrets);
    // The profile bio the envelope already carries (social/profileBio.ts); a failure here never fails the run.
    const bio = bioOf(i.native);
    if (bio) {
      const family = i.native.sourceMethod === "meta_business_discovery" ? "business_discovery" : i.native.platform === "tiktok" ? "user_info" : "channels";
      await persistProfileBio({
        athleteId: i.athleteId, platform: i.native.platform, identityId: identity.id, sourceClass, text: bio, asOf: fetchedAt,
        inputs: { sync_run_id: runId, payload_id: payloadIds[family] ?? null, source_method: i.native.sourceMethod },
      }).catch((err: any) => logger.warn({ athleteId: i.athleteId, platform: i.native.platform, error: err.message?.slice(0, 200) }, "profile bio not stored"));
    }
    const status = i.native.errors.length ? "partial" : "ok";
    await closeSyncRun(runId, { status, pages: payloads, items: result.observations.length, error: i.native.errors.length ? { reason: "partial", subCalls: i.native.errors.map((e) => ({ step: e.step, message: e.message })) } : null, secrets: i.secrets });
    logger.info({ athleteId: i.athleteId, platform: i.native.platform, runId, status, ...written }, "substrate ingest");
    return { runId, identityId: identity.id, payloads, ...written, status };
  } catch (err: any) {
    const reason = err instanceof SanitizerLeakError ? "sanitizer_leak" : "error";
    logger.error({ athleteId: i.athleteId, platform: i.native.platform, reason, error: err.message?.slice(0, 200) }, "substrate ingest failed");
    if (runId) await closeSyncRun(runId, { status: "failed", error: { reason, message: String(err.message ?? err) }, secrets: i.secrets }).catch(() => {});
    return null;
  }
}

/**
 * The public bio of an account the athlete has CONNECTED on Instagram, read through the same
 * Business Discovery lookup the unconnected path uses (Instagram Login exposes no bio). Only the
 * bio is kept: the run and the payload are recorded exactly as a discovery ingest records them
 * (trigger 'discovery', platform_public, family business_discovery), and the bio row is
 * `platform_public` with source_method meta_business_discovery — never connected_verified. No
 * observations are written and no identity is created or upgraded: the connected account's
 * metrics come from the connected API only. The bio attaches to the athlete's existing Instagram
 * identity when there is one. Never throws.
 */
export async function ingestDiscoveryBio(i: { athleteId: string; native: InstagramDiscoveryNative; connectedAccountId: string | null; secrets: string[] }): Promise<"stored" | "unchanged" | "none" | "failed" | null> {
  if (!substrateWriteEnabled()) return null;
  const bio = bioOf(i.native);
  if (!bio) return "none";
  const sourceClass: SourceClass = "platform_public";
  const fetchedAt = new Date(i.native.fetchedAt);
  let runId: string | null = null;
  try {
    const params = await getSubstrateParams();
    const ids = (await listIdentities(i.athleteId)).filter((x) => x.platform === "instagram");
    const identity = ids.find((x) => i.connectedAccountId && x.connected_account_id === i.connectedAccountId) ?? ids.find((x) => x.account_id === i.native.accountId) ?? null;
    runId = await openSyncRun({ athleteId: i.athleteId, identityId: identity?.id ?? null, platform: "instagram", provider: PROVIDER.instagram, endpointFamily: "business_discovery", apiVersion: i.native.apiVersion, sourceClass, trigger: "discovery", connectedAccountId: null });
    const stored = await storePayload({ runId, athleteId: i.athleteId, platform: "instagram", provider: PROVIDER.instagram, endpointFamily: "business_discovery", pageIndex: 0, sourceClass, request: { path: "/{ig-business-id}", params: { fields: "business_discovery.username(...)" } }, payload: i.native.businessDiscovery, fetchedAt, retentionDays: params.rawRetentionDays.platform_public, secrets: i.secrets });
    const wrote = await persistProfileBio({
      athleteId: i.athleteId, platform: "instagram", identityId: identity?.id ?? null, sourceClass, text: bio, asOf: fetchedAt,
      inputs: { sync_run_id: runId, payload_id: stored.id, source_method: i.native.sourceMethod },
    });
    await closeSyncRun(runId, { status: "ok", pages: 1, items: 0, secrets: i.secrets });
    return wrote ? "stored" : "unchanged";
  } catch (err: any) {
    logger.error({ athleteId: i.athleteId, error: err.message?.slice(0, 200) }, "connected-account discovery bio failed");
    if (runId) await closeSyncRun(runId, { status: "failed", error: { reason: "error", message: String(err.message ?? err) }, secrets: i.secrets }).catch(() => {});
    return "failed";
  }
}

/**
 * Backfill page (media history) → payload + content observations at fetch time. The page is
 * already the provider's native items for that platform.
 */
export async function ingestBackfillPage(i: { athleteId: string; platform: "instagram" | "tiktok" | "youtube"; connectedAccountId: string | null; accountId: string | null; handle: string | null; pageIndex: number; cursor: string | null; items: unknown[]; adaptItems: (at: string) => { observations: ObservationInput[]; content: ContentInput[] }; secrets: string[]; fetchedAt?: Date }): Promise<IngestResult | null> {
  if (!substrateWriteEnabled() || !i.accountId) return null;
  const sourceClass: SourceClass = "connected_verified";
  const provider = PROVIDER[i.platform];
  const sourceMethod = i.platform === "instagram" ? "oauth_instagram_login" : i.platform === "tiktok" ? "oauth_tiktok_display" : "oauth_youtube";
  const fetchedAt = i.fetchedAt ?? new Date();
  let runId: string | null = null;
  try {
    const params = await getSubstrateParams();
    const identity = await ensureIdentity({ athleteId: i.athleteId, platform: i.platform, accountId: i.accountId, accountIdKind: "platform_id", handle: i.handle, canonicalUrl: null, sourceClass, sourceMethod, connectedAccountId: i.connectedAccountId, verifiedAt: fetchedAt, byUserId: await connectedByUserId(i.connectedAccountId) });
    runId = await openSyncRun({ athleteId: i.athleteId, identityId: identity.id, platform: i.platform, provider, endpointFamily: `${i.platform}_media_history`, sourceClass, trigger: "backfill", connectedAccountId: i.connectedAccountId });
    const stored = await storePayload({ runId, athleteId: i.athleteId, platform: i.platform, provider, endpointFamily: `${i.platform}_media_history`, pageIndex: i.pageIndex, sourceClass, request: { path: "media history page", params: { cursor: i.cursor } }, payload: i.items, fetchedAt, retentionDays: params.rawRetentionDays.connected_verified, secrets: i.secrets });
    const { observations, content } = i.adaptItems(fetchedAt.toISOString());
    const written = await writeAdaptResult({ athleteId: i.athleteId, platform: i.platform, identityId: identity.id, sourceClass, sourceMethod, provider, runId, payloadId: stored.id }, { observations, distributions: [], content }, i.secrets);
    await closeSyncRun(runId, { status: "ok", pages: 1, items: observations.length, paginationState: { cursor: i.cursor, pageIndex: i.pageIndex }, secrets: i.secrets });
    return { runId, identityId: identity.id, payloads: 1, ...written, status: "ok" };
  } catch (err: any) {
    logger.error({ athleteId: i.athleteId, platform: i.platform, error: err.message?.slice(0, 200) }, "substrate backfill page failed");
    if (runId) await closeSyncRun(runId, { status: "failed", error: { reason: "error", message: String(err.message ?? err) }, secrets: i.secrets }).catch(() => {});
    return null;
  }
}

/** Per-post insight enrichment → content observations (Instagram). */
export async function ingestMediaInsights(i: { athleteId: string; connectedAccountId: string | null; accountId: string | null; handle: string | null; mediaId: string; mediaType: string | null; postedAt: string | null; metrics: Record<string, number>; secrets: string[] }): Promise<number> {
  if (!substrateWriteEnabled() || !i.accountId) return 0;
  try {
    const identity = await ensureIdentity({ athleteId: i.athleteId, platform: "instagram", accountId: i.accountId, accountIdKind: "platform_id", handle: i.handle, canonicalUrl: null, sourceClass: "connected_verified", sourceMethod: "oauth_instagram_login", connectedAccountId: i.connectedAccountId, byUserId: await connectedByUserId(i.connectedAccountId) });
    const at = new Date().toISOString();
    const node: IgMediaNode = { id: i.mediaId, media_type: i.mediaType ?? undefined, timestamp: i.postedAt ?? undefined, insights: { data: Object.entries(i.metrics).map(([name, value]) => ({ name: name === "video_views" ? "views" : name, total_value: { value } })) } };
    const obs: ObservationInput[] = [], content: ContentInput[] = [];
    adaptMedia(node, at, obs, content);
    const runId = await openSyncRun({ athleteId: i.athleteId, identityId: identity.id, platform: "instagram", provider: "meta_graph", endpointFamily: "media_insights", sourceClass: "connected_verified", trigger: "nightly", connectedAccountId: i.connectedAccountId });
    const n = await writeObservations({ athleteId: i.athleteId, platform: "instagram", identityId: identity.id, sourceClass: "connected_verified", sourceMethod: "oauth_instagram_login", provider: "meta_graph", runId }, obs.filter((o) => o.metricKey !== "like_count" && o.metricKey !== "comments_count"));
    await closeSyncRun(runId, { status: "ok", pages: 0, items: n, secrets: i.secrets });
    return n;
  } catch (err: any) {
    logger.error({ athleteId: i.athleteId, mediaId: i.mediaId, error: err.message?.slice(0, 200) }, "substrate media insights failed");
    return 0;
  }
}

/** Recompute and store the feature vector for one athlete at as_of (default now). */
export async function recomputeFeatures(athleteId: string, asOf: Date = new Date()): Promise<{ features: number; identities: number; observations: number } | null> {
  if (!substrateWriteEnabled()) return null;
  try {
    const params = await getSubstrateParams();
    const identities = await listIdentities(athleteId);
    if (!identities.length) return { features: 0, identities: 0, observations: 0 };
    const from = new Date(asOf.getTime() - 400 * 86_400_000);
    const observations = await loadObservations(athleteId, from, asOf);
    const distributions = await loadDistributions(athleteId, from, asOf);
    const rows = calculateSocialFeatures({ identities: identities.map((i) => ({ id: i.id, platform: i.platform })), observations, distributions, asOf: asOf.toISOString(), windows: params.windows, freshness: params.freshnessDays });
    const features = await writeFeatures(athleteId, rows);
    logger.info({ athleteId, asOf: asOf.toISOString(), features, identities: identities.length, observations: observations.length }, "substrate features");
    return { features, identities: identities.length, observations: observations.length };
  } catch (err: any) {
    logger.error({ athleteId, error: err.message?.slice(0, 200) }, "substrate features failed");
    return null;
  }
}

/** Every athlete with an identity gets a fresh feature vector; then raw retention is enforced. */
export async function runSubstrateNightly(now: Date = new Date()): Promise<{ athletes: number; retentionDeleted: number }> {
  if (!substrateWriteEnabled()) return { athletes: 0, retentionDeleted: 0 };
  const rows = await db.selectDistinct({ id: socialIdentities.athlete_id }).from(socialIdentities);
  for (const r of rows) await recomputeFeatures(r.id, now);
  const { deleted } = await enforceRawRetention(now);
  logger.info({ athletes: rows.length, retentionDeleted: deleted }, "substrate nightly pass");
  return { athletes: rows.length, retentionDeleted: deleted };
}
