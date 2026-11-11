/**
 * outcome/publishedIdentity.ts — THE PUBLISH → OBSERVATION JOIN. A Studio-published asset and the metric observations
 * ingested for that post were unconnectable: publishing records a permalink and the platform's media id on the publish
 * job, while observations are keyed by the platform's own entity id. This records that identity once, at publish time,
 * so one question can be answered deterministically:
 *
 *     WHICH METRIC OBSERVATIONS BELONG TO THIS PUBLISHED STUDIO ASSET?
 *
 * Precedence, strictly: (1) the platform's own media id; (2) an explicit provider mapping; (3) a canonicalised permalink
 * ONLY when no platform identity exists and the permalink is unique among her published assets. Never a caption, never a
 * timestamp, never fuzzy content. No metric value is copied anywhere — `social_metric_observations` stays authoritative.
 */
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { publishedAssetIdentities, socialMetricObservations } from "../../../../shared/schema";

type Db = PgDatabase<any, any, any>;
export const IDENTITY_SOURCES = ["platform_media_id", "provider_mapping", "permalink"] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export interface PublishedIdentity { id: string; athleteId: string; assetId: string; platform: string; platformMediaId: string | null; permalink: string | null; publishJobId: string | null; source: IdentitySource; recordedAt: string }
const toIdentity = (r: typeof publishedAssetIdentities.$inferSelect): PublishedIdentity => ({ id: r.id, athleteId: r.athlete_id, assetId: r.asset_id, platform: r.platform, platformMediaId: r.platform_media_id ?? null, permalink: r.permalink ?? null, publishJobId: r.publish_job_id ?? null, source: r.source as IdentitySource, recordedAt: new Date(r.recorded_at).toISOString() });

/** Strip query and fragment; drop a trailing slash. Enough to compare two references to the same post, and nothing more. */
export function canonicalPermalink(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim(); if (!trimmed) return null;
  try { const u = new URL(trimmed); return `${u.origin}${u.pathname.replace(/\/+$/, "")}`.toLowerCase(); }
  catch { return trimmed.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase(); }
}

export interface RecordIdentityInput { athleteId: string; assetId: string; platform: string; platformMediaId?: string | null; permalink?: string | null; publishJobId?: string | null }

/**
 * Records the identity of a published asset. Returns null when nothing authoritative is available — an unidentifiable
 * publication is recorded nowhere rather than guessed at. A permalink alone is accepted only when it is unique among
 * her other published assets (proven here, not assumed).
 */
export async function recordPublishedIdentity(db: Db, input: RecordIdentityInput, now = new Date()): Promise<PublishedIdentity | null> {
  const platformMediaId = input.platformMediaId?.trim() || null;
  const permalink = canonicalPermalink(input.permalink);
  let source: IdentitySource | null = platformMediaId ? "platform_media_id" : null;
  if (!source && permalink) {
    const clash = await db.select({ id: publishedAssetIdentities.id }).from(publishedAssetIdentities)
      .where(and(eq(publishedAssetIdentities.platform, input.platform), eq(publishedAssetIdentities.permalink, permalink), ne(publishedAssetIdentities.asset_id, input.assetId))).limit(1);
    if (!clash.length) source = "permalink";
  }
  if (!source) return null;
  const [row] = await db.insert(publishedAssetIdentities)
    .values({ athlete_id: input.athleteId, asset_id: input.assetId, platform: input.platform, platform_media_id: platformMediaId, permalink, publish_job_id: input.publishJobId ?? null, source, recorded_at: now })
    .onConflictDoUpdate({ target: [publishedAssetIdentities.asset_id, publishedAssetIdentities.platform], set: { platform_media_id: platformMediaId, permalink, publish_job_id: input.publishJobId ?? null, source, recorded_at: now } })
    .returning();
  return toIdentity(row);
}

export const publishedIdentityFor = async (db: Db, athleteId: string, assetId: string): Promise<PublishedIdentity[]> =>
  (await db.select().from(publishedAssetIdentities).where(and(eq(publishedAssetIdentities.athlete_id, athleteId), eq(publishedAssetIdentities.asset_id, assetId)))).map(toIdentity);

export interface ObservationRow { id: number; platform: string; entityId: string; metricKey: string; value: string; unit: string; sourceClass: string; observedAt: string; definitionVersion: string; assetId: string | null }

/**
 * The observations that belong to this published asset: matched by the platform identity recorded above, and — only as a
 * second path — by the `asset_id` ingest itself already stamped on an observation. Nothing else joins them.
 */
export async function observationsForAsset(db: Db, athleteId: string, assetId: string): Promise<{ observations: ObservationRow[]; via: Array<{ platform: string; entityId: string; source: IdentitySource }>; unidentified: boolean }> {
  const identities = await publishedIdentityFor(db, athleteId, assetId);
  const ids = identities.filter((i) => i.platformMediaId).map((i) => i.platformMediaId!) as string[];
  const rows = await db.select().from(socialMetricObservations).where(
    ids.length
      ? and(eq(socialMetricObservations.athlete_id, athleteId), eq(socialMetricObservations.entity_type, "content"), inArray(socialMetricObservations.entity_id, ids))
      : and(eq(socialMetricObservations.athlete_id, athleteId), eq(socialMetricObservations.asset_id, assetId), isNotNull(socialMetricObservations.asset_id)),
  );
  const observations: ObservationRow[] = rows.map((r: any) => ({ id: Number(r.id), platform: r.platform, entityId: r.entity_id, metricKey: r.metric_key, value: String(r.value), unit: r.unit, sourceClass: r.source_class, observedAt: new Date(r.observed_at).toISOString(), definitionVersion: r.definition_version, assetId: r.asset_id ?? null }));
  return { observations, via: identities.filter((i) => i.platformMediaId).map((i) => ({ platform: i.platform, entityId: i.platformMediaId!, source: i.source })), unidentified: identities.length === 0 };
}
