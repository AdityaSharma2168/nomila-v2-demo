/**
 * social/stories.ts — Instagram Stories on the substrate (Phase A Step 1b).
 *
 * Extends Step 1a, it is not a parallel architecture: the same identity → sync run → sanitized
 * raw payload → canonical observation lineage, the same writer (ingest.ts), the same sanitizer
 * contract. Stories are observations only: entity_type content, entity_format story, asset_id
 * NULL, never a media_assets row. Gated by SOCIAL_STORIES_WRITE (its own flag).
 *
 * Two entry points, both called by server/skills/collectInstagramStories.ts which does the
 * fetching (this module never imports a provider):
 *   ingestStorySweep    — a listing plus insights for every live Story (every 8 h).
 *   ingestStoryLastLook — one more insight reading for a Story aged ≥ 22 h (hourly tick).
 * selectStoriesDueForLastLook implements the pure rule in storiesSchedule.ts against the
 * observation table: due = age in [22 h, 24 h) and no story_insights-family observation at or
 * after entity_time + 22 h. `listed` never satisfies it.
 */

import { sql } from "drizzle-orm";
import { createLogger } from "../../../logger";
import { db } from "../../../db";
import { socialIdentities, socialMetricObservations, socialSyncRuns } from "../../../../shared/schema";
import type { IgStoryInsightsNative, IgStoryNode, InstagramStoriesNative } from "./native";
import { adaptStories, adaptStoryInsights } from "./adapters/instagram";
import type { ObservationInput } from "./adapters/types";
import { assessStoryCollection, STORY_EMPTY_SWEEP_THRESHOLD, type StoryCollectionHealth } from "./storiesHealth";
export { assessStoryCollection, STORY_EMPTY_SWEEP_THRESHOLD, type StoryCollectionHealth } from "./storiesHealth";
import { getSubstrateParams, storiesWriteEnabled } from "./config";
import { closeSyncRun, ensureIdentity, openSyncRun, storePayload, writeObservations, type SyncRunError, type WriteContext, connectedByUserId } from "./ingest";
import { SanitizerLeakError } from "./sanitize";
import { DEFAULT_STORY_LAST_LOOK_HOURS, STORY_LIFE_HOURS, STORY_SUCCESS_METRICS } from "./storiesSchedule";

const logger = createLogger("social-stories");
const PROVIDER = "meta_graph";
const SOURCE_METHOD = "oauth_instagram_login";
const HOUR = 3_600_000;

export type ReadStoryInsights = (story: IgStoryNode) => Promise<IgStoryInsightsNative>;

export interface StoryRunResult {
  runId: string;
  identityId: string;
  stories: number;
  payloads: number;
  observations: number;
  status: "ok" | "partial" | "failed";
  /** True only when a call was classified `auth` (Meta 190/102): the caller may expire the connection. Nothing else may. */
  authFailure: boolean;
  subCalls: Array<{ step: string; message: string }>;
}

/** Store the three insight sub-responses of one Story and write its observations into an open run. */
async function writeStoryInsights(ctx: WriteContext, athleteId: string, ordinal: number, ins: IgStoryInsightsNative, retentionDays: number, secrets: string[]): Promise<{ payloads: number; observations: number; subCalls: Array<{ step: string; message: string }>; authFailure: boolean }> {
  const fetchedAt = new Date(ins.fetchedAt);
  const payloadIds: Record<string, string> = {};
  let payloads = 0;
  const families: Array<[string, unknown, Record<string, unknown>]> = [
    ["story_insights", ins.insights, { path: "/{story-id}/insights", params: { metric: ins.requestedMetrics.join(",") } }],
    ["story_navigation", ins.navigation, { path: "/{story-id}/insights", params: { metric: "navigation", breakdown: "story_navigation_action_type" } }],
    ["story_profile_activity", ins.profileActivity, { path: "/{story-id}/insights", params: { metric: "profile_activity", breakdown: "action_type" } }],
  ];
  for (const [family, body, request] of families) {
    if (body == null) continue;
    const stored = await storePayload({ runId: ctx.runId!, athleteId, platform: "instagram", provider: PROVIDER, endpointFamily: family, pageIndex: ordinal, sourceClass: "connected_verified", request, payload: body, fetchedAt, retentionDays, secrets });
    payloadIds[family] = stored.id; payloads++;
  }
  const obs: ObservationInput[] = [];
  adaptStoryInsights(ins, obs);
  const observations = await writeObservations({ ...ctx, payloadIds }, obs);
  const subCalls = ins.errors.map((e) => ({ step: `story:${ins.storyId}:${e.step}`, message: `${e.class}${e.code != null ? ` code ${e.code}` : ""}${e.subcode != null ? `/${e.subcode}` : ""}: ${e.message}` }));
  for (const m of ins.unsupportedMetrics) subCalls.push({ step: `story:${ins.storyId}:metric:${m}`, message: "absent: rejected by the provider for this media product type" });
  return { payloads, observations, subCalls, authFailure: ins.errors.some((e) => e.class === "auth") };
}

/**
 * One sweep for one connected Instagram account: the listing → `listed` observations, then
 * insights per live Story. Never throws; a failure is the run's status and the return value.
 */
export async function ingestStorySweep(i: { athleteId: string; connectedAccountId: string | null; list: InstagramStoriesNative; readInsights: ReadStoryInsights; secrets: string[] }): Promise<StoryRunResult | null> {
  if (!storiesWriteEnabled()) return null;
  const fetchedAt = new Date(i.list.fetchedAt);
  let runId: string | null = null;
  try {
    const params = await getSubstrateParams();
    const retentionDays = params.rawRetentionDays.connected_verified;
    const identity = await ensureIdentity({ athleteId: i.athleteId, platform: "instagram", accountId: i.list.accountId, accountIdKind: "platform_id", handle: i.list.handle, canonicalUrl: null, sourceClass: "connected_verified", sourceMethod: SOURCE_METHOD, connectedAccountId: i.connectedAccountId, verifiedAt: fetchedAt, byUserId: await connectedByUserId(i.connectedAccountId) });
    runId = await openSyncRun({ athleteId: i.athleteId, identityId: identity.id, platform: "instagram", provider: PROVIDER, endpointFamily: "stories_list", apiVersion: i.list.apiVersion, sourceClass: "connected_verified", trigger: "stories", connectedAccountId: i.connectedAccountId });
    const ctx: WriteContext = { athleteId: i.athleteId, platform: "instagram", identityId: identity.id, sourceClass: "connected_verified", sourceMethod: SOURCE_METHOD, provider: PROVIDER, runId };

    const listRequest = { path: "/{ig-user-id}/stories", params: { fields: "id,media_type,media_product_type,timestamp,is_shared_to_feed" } };
    const listingFailed = !!i.list.listingError || i.list.errors.some((e) => e.step === "stories_list");
    const subCalls: Array<{ step: string; message: string }> = i.list.errors.map((e) => ({ step: e.step, message: `${(e as { class?: string }).class ?? "unknown"}: ${e.message}` }));
    let authFailure = i.list.errors.some((e) => (e as { class?: string }).class === "auth");

    if (listingFailed) {
      // The listing itself failed: no `listed` observation and no synthetic `{data: []}`. The
      // provider's actual error envelope, sanitized, is kept under its own family when we have it.
      let payloads = 0;
      if (i.list.listingError?.body != null) {
        await storePayload({ runId, athleteId: i.athleteId, platform: "instagram", provider: PROVIDER, endpointFamily: "stories_list_error", pageIndex: 0, sourceClass: "connected_verified", request: { ...listRequest, httpStatus: i.list.listingError.httpStatus }, payload: i.list.listingError.body, fetchedAt, retentionDays, secrets: i.secrets });
        payloads = 1;
      }
      const reason = authFailure ? "auth" : ((i.list.errors.find((e) => e.step === "stories_list") as { class?: string } | undefined)?.class ?? "unknown");
      await closeSyncRun(runId, { status: "failed", pages: payloads, items: 0, error: { reason, message: null, subCalls }, secrets: i.secrets });
      logger.warn({ athleteId: i.athleteId, runId, reason }, "story sweep: listing failed, nothing listed");
      return { runId, identityId: identity.id, stories: 0, payloads, observations: 0, status: "failed", authFailure, subCalls };
    }

    const listPayload = await storePayload({ runId, athleteId: i.athleteId, platform: "instagram", provider: PROVIDER, endpointFamily: "stories_list", pageIndex: 0, sourceClass: "connected_verified", request: listRequest, payload: { data: i.list.stories }, fetchedAt, retentionDays, secrets: i.secrets });
    const listed = adaptStories(i.list, { athleteId: i.athleteId, platform: "instagram", sourceClass: "connected_verified", sourceMethod: SOURCE_METHOD, provider: PROVIDER, observedAt: fetchedAt.toISOString() });
    let observations = await writeObservations({ ...ctx, payloadIds: { stories_list: listPayload.id } }, listed.observations);
    let payloads = 1;

    for (const [ordinal, story] of i.list.stories.entries()) {
      if (authFailure) break;
      const ins = await i.readInsights(story);
      const w = await writeStoryInsights(ctx, i.athleteId, ordinal + 1, ins, retentionDays, i.secrets);
      payloads += w.payloads; observations += w.observations; subCalls.push(...w.subCalls); authFailure ||= w.authFailure;
    }
    const status = authFailure ? "failed" : subCalls.length ? "partial" : "ok";
    const error: SyncRunError | null = subCalls.length ? { reason: authFailure ? "auth" : "partial", message: null, subCalls } : null;
    await closeSyncRun(runId, { status, pages: payloads, items: observations, error, secrets: i.secrets });
    logger.info({ athleteId: i.athleteId, runId, stories: i.list.stories.length, payloads, observations, status }, "story sweep");
    if (!i.list.stories.length) {
      // Empty list: say whether that looks like quiet or like blindness. Never throws — a health check that breaks
      // collection is worse than the gap it reports.
      const health = await storyCollectionHealth(i.athleteId).catch(() => null);
      if (health?.suspect) {
        logger.warn({ athleteId: i.athleteId, runId, ...health },
          "story sweep: consecutive empty listings while the account is posting to feed — the Story edge may not be returning this account's Stories");
      }
    }
    return { runId, identityId: identity.id, stories: i.list.stories.length, payloads, observations, status, authFailure, subCalls };
  } catch (err: any) {
    const reason = err instanceof SanitizerLeakError ? "sanitizer_leak" : "error";
    logger.error({ athleteId: i.athleteId, reason, error: err.message?.slice(0, 200) }, "story sweep failed");
    if (runId) await closeSyncRun(runId, { status: "failed", error: { reason, message: String(err.message ?? err) }, secrets: i.secrets }).catch(() => {});
    return null;
  }
}

export async function storyCollectionHealth(athleteId: string, threshold = STORY_EMPTY_SWEEP_THRESHOLD): Promise<StoryCollectionHealth> {
  const runs = await db.select({ items: socialSyncRuns.items, startedAt: socialSyncRuns.started_at, status: socialSyncRuns.status })
    .from(socialSyncRuns)
    .where(sql`${socialSyncRuns.athlete_id} = ${athleteId} and ${socialSyncRuns.trigger} = 'stories' and ${socialSyncRuns.endpoint_family} = 'stories_list'`)
    .orderBy(sql`${socialSyncRuns.started_at} desc`)
    .limit(Math.max(threshold, 20));
  const [feed] = await db.select({ at: sql<string | null>`max(${socialMetricObservations.entity_time})` })
    .from(socialMetricObservations)
    .where(sql`${socialMetricObservations.athlete_id} = ${athleteId} and ${socialMetricObservations.platform} = 'instagram' and ${socialMetricObservations.entity_type} = 'content' and coalesce(${socialMetricObservations.entity_format}, '') <> 'story'`);
  return assessStoryCollection(runs, feed?.at ? new Date(feed.at).toISOString() : null, threshold);
}

export interface StoryDue { athleteId: string; identityId: string; connectedAccountId: string | null; entityId: string; entityTime: Date; ageHours: number }

/**
 * Stories due for a last look at `now`: age in [lastLookHours, 24 h) and no story_insights
 * observation (reach / view_count) at or after entity_time + lastLookHours. Read from the
 * observation table only; `listed` rows make a Story known but never satisfy the rule.
 */
export async function selectStoriesDueForLastLook(now: Date = new Date(), lastLookHours = DEFAULT_STORY_LAST_LOOK_HOURS): Promise<StoryDue[]> {
  const from = new Date(now.getTime() - STORY_LIFE_HOURS * HOUR);
  const to = new Date(now.getTime() - lastLookHours * HOUR);
  // One query: candidate Stories (age in [lastLookHours, 24 h)) anti-joined against their own
  // successful insight observations at or after entity_time + lastLookHours.
  const rows = await db.execute(sql`
    select o.athlete_id, o.identity_id, o.entity_id, min(o.entity_time) as entity_time, i.connected_account_id
    from ${socialMetricObservations} o
    join ${socialIdentities} i on i.id = o.identity_id
    where o.platform = 'instagram' and o.entity_type = 'content' and o.entity_format = 'story'
      and o.entity_time > ${from} and o.entity_time <= ${to}
    group by o.athlete_id, o.identity_id, o.entity_id, i.connected_account_id
    having not exists (
      select 1 from ${socialMetricObservations} s
      where s.identity_id = o.identity_id and s.entity_id = o.entity_id
        and s.metric_key in (${sql.join(STORY_SUCCESS_METRICS.map((m) => sql`${m}`), sql`, `)})
        and s.observed_at >= min(o.entity_time) + ${lastLookHours} * interval '1 hour'
    )
    order by min(o.entity_time)`);
  return (rows.rows as Array<Record<string, unknown>>).map((r) => {
    const entityTime = new Date(r.entity_time as string | Date);
    return { athleteId: String(r.athlete_id), identityId: String(r.identity_id), connectedAccountId: r.connected_account_id == null ? null : String(r.connected_account_id), entityId: String(r.entity_id), entityTime, ageHours: Math.round(((now.getTime() - entityTime.getTime()) / HOUR) * 10) / 10 };
  });
}

/** One last-look attempt for one Story: its own run (endpoint_family story_last_look) so retries are visible. */
export async function ingestStoryLastLook(i: { due: StoryDue; readInsights: ReadStoryInsights; secrets: string[]; accountId: string }): Promise<StoryRunResult | null> {
  if (!storiesWriteEnabled()) return null;
  let runId: string | null = null;
  try {
    const params = await getSubstrateParams();
    runId = await openSyncRun({ athleteId: i.due.athleteId, identityId: i.due.identityId, platform: "instagram", provider: PROVIDER, endpointFamily: "story_last_look", sourceClass: "connected_verified", trigger: "stories", connectedAccountId: i.due.connectedAccountId });
    const ctx: WriteContext = { athleteId: i.due.athleteId, platform: "instagram", identityId: i.due.identityId, sourceClass: "connected_verified", sourceMethod: SOURCE_METHOD, provider: PROVIDER, runId };
    const ins = await i.readInsights({ id: i.due.entityId, timestamp: i.due.entityTime.toISOString(), media_product_type: "STORY" });
    const w = await writeStoryInsights(ctx, i.due.athleteId, 1, ins, params.rawRetentionDays.connected_verified, i.secrets);
    const status = w.authFailure ? "failed" : w.subCalls.length ? "partial" : "ok";
    await closeSyncRun(runId, { status, pages: w.payloads, items: w.observations, error: w.subCalls.length ? { reason: w.authFailure ? "auth" : "partial", message: null, subCalls: w.subCalls } : null, secrets: i.secrets });
    logger.info({ athleteId: i.due.athleteId, storyId: i.due.entityId, ageHours: i.due.ageHours, status, observations: w.observations }, "story last look");
    return { runId, identityId: i.due.identityId, stories: 1, payloads: w.payloads, observations: w.observations, status, authFailure: w.authFailure, subCalls: w.subCalls };
  } catch (err: any) {
    const reason = err instanceof SanitizerLeakError ? "sanitizer_leak" : "error";
    logger.error({ athleteId: i.due.athleteId, storyId: i.due.entityId, reason, error: err.message?.slice(0, 200) }, "story last look failed");
    if (runId) await closeSyncRun(runId, { status: "failed", error: { reason, message: String(err.message ?? err) }, secrets: i.secrets }).catch(() => {});
    return null;
  }
}
