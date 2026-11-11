/**
 * social/ingest.ts — the only writer of the substrate tables.
 *
 * Identities, sync runs, sanitized payloads, observations, distributions, content facts and
 * features all land through here. Writes are idempotent on the tables' unique keys, so
 * re-adapting the same payload is a no-op and a later definition version coexists with an
 * earlier one. Every payload insert runs assertNoSecrets first and refuses on a leak.
 *
 * This module imports the database and the schema. It imports no provider module.
 */

import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../../db";
import {
  mediaAssets, rawSourcePayloads, socialAudienceDistributions, socialFeatures, socialIdentities, socialMetricObservations, socialSyncRuns,
  type SocialIdentity, type SocialMetricObservation, type SocialAudienceDistribution,
} from "../../../../shared/schema";
import type { SourceClass } from "../types";
import { METRIC_DEFINITION_VERSION } from "./metrics";
import { upsertIdentityRow } from "./identityRow";
import { claimAccountOwnership } from "../identity/ownership";
import { assertNoSecrets, sanitizePayload, SANITIZER_VERSION } from "./sanitize";
import { canonicalJson } from "../params";
import type { AdaptResult, ContentInput, DistributionInput, IdentityFacts, ObservationInput } from "./adapters/types";
import { NATIVE_VERSION } from "./adapters/types";
import type { FeatureRow, FeatureObservation, FeatureDistribution } from "./features";

// ─── identities ──────────────────────────────────────────────────────────────

export interface EnsureIdentityInput extends IdentityFacts {
  /** Phase A Step 3a: the user who performed the OAuth (connected_accounts.connected_by_user_id), for the collision claim. */
  byUserId?: string | null;
  athleteId: string;
  platform: string;
  sourceClass: SourceClass;
  sourceMethod: string;
  confidence?: number;
  connectedAccountId?: string | null;
  verifiedAt?: Date;
}

/**
 * Upsert on (athlete, platform, account_id); a handle change appends to handle_history. Phase A Step 3a: a `connected_verified`
 * identity is written through identity/ownership.ts — the only path that may make it ACTIVE (D-13); every other source class
 * keeps today's upsert (social/identityRow.ts, the same body ensureIdentity always had).
 */
/** Phase A Step 3b: the user who performed the OAuth (connected_accounts.connected_by_user_id, 3a) — null when unknown. */
export async function connectedByUserId(connectedAccountId: string | null): Promise<string | null> {
  if (!connectedAccountId) return null;
  const { connectedAccounts } = await import("../../../../shared/schema");
  const [row] = await db.select({ u: connectedAccounts.connected_by_user_id }).from(connectedAccounts).where(eq(connectedAccounts.id, connectedAccountId)).limit(1);
  return row?.u ?? null;
}

export async function ensureIdentity(i: EnsureIdentityInput): Promise<SocialIdentity> {
  if (i.sourceClass === "connected_verified") {
    const r = await claimAccountOwnership({ ...i, sourceClass: "connected_verified", byUserId: i.byUserId ?? null });
    return r.identity;
  }
  return upsertIdentityRow(i, { status: "active" });
}

export async function listIdentities(athleteId: string): Promise<SocialIdentity[]> {
  return db.select().from(socialIdentities).where(eq(socialIdentities.athlete_id, athleteId)).orderBy(socialIdentities.platform);
}

// ─── sync runs and payloads ──────────────────────────────────────────────────

export interface OpenRunInput {
  athleteId: string; identityId: string | null; platform: string; provider: string; endpointFamily: string; apiVersion?: string | null;
  sourceClass: SourceClass; trigger: "connect" | "nightly" | "backfill" | "discovery" | "manual" | "fixture" | "stories"; connectedAccountId?: string | null;
}
export async function openSyncRun(i: OpenRunInput): Promise<string> {
  const [row] = await db.insert(socialSyncRuns).values({
    athlete_id: i.athleteId, identity_id: i.identityId, platform: i.platform, provider: i.provider, endpoint_family: i.endpointFamily,
    api_version: i.apiVersion ?? null, source_class: i.sourceClass, trigger: i.trigger, connected_account_id: i.connectedAccountId ?? null,
  }).returning({ id: socialSyncRuns.id });
  return row.id;
}

/** The only error shape a sync run may persist. Provider error objects are never stored as-is. */
export interface SyncRunError { reason: string; message: string | null; code?: string | number; subCalls?: Array<{ step: string; message: string }> }

export function errorRecord(err: unknown): SyncRunError | null {
  if (err == null) return null;
  const e = err as any;
  // Free-text messages often embed the failing URL; its query string is never evidence, so it is dropped
  // before sanitization (a message that still carries `access_token=` would otherwise be withheld whole).
  const stripUrlQueries = (m: string) => m.replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, "$1");
  const raw = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : null;
  const message = raw ? stripUrlQueries(raw) : null;
  const rec: SyncRunError = { reason: typeof e?.reason === "string" ? e.reason.slice(0, 60) : err instanceof Error ? err.name : "error", message: message ? message.slice(0, 300) : null };
  if (typeof e?.code === "string" || typeof e?.code === "number") rec.code = typeof e.code === "string" ? e.code.slice(0, 60) : e.code;
  if (Array.isArray(e?.subCalls)) rec.subCalls = e.subCalls.slice(0, 20).map((c: any) => ({ step: String(c?.step ?? "").slice(0, 80), message: String(c?.message ?? "").slice(0, 300) }));
  return rec;
}

/** The only pagination shape a sync run may persist. */
export interface SyncRunPagination { cursor: string | null; pageIndex?: number }

/**
 * Close a run. `error` and `paginationState` go through the same sanitize → assertNoSecrets
 * contract as payloads, with the live secrets when the caller has them; a value that still
 * looks secret-like after sanitization is WITHHELD (a marker is stored), never persisted.
 */
export async function closeSyncRun(id: string, i: { status: "ok" | "partial" | "failed"; pages?: number; items?: number; error?: unknown; paginationState?: unknown; identityId?: string | null; secrets?: string[] }): Promise<void> {
  const secrets = i.secrets ?? [];
  let error: SyncRunError | null = null;
  const rec = errorRecord(i.error);
  if (rec) {
    const clean = sanitizePayload(rec, secrets).out;
    try { assertNoSecrets(clean, secrets, `sync_run ${id} error`); error = clean; }
    catch { error = { reason: "sanitizer_leak", message: "error record withheld: a secret-like string survived sanitization" }; }
  }
  let pagination: SyncRunPagination | null = null;
  if (i.paginationState != null && typeof i.paginationState === "object") {
    const p = i.paginationState as any;
    const shaped: SyncRunPagination = { cursor: typeof p.cursor === "string" ? p.cursor.slice(0, 2000) : null, ...(typeof p.pageIndex === "number" ? { pageIndex: p.pageIndex } : {}) };
    const clean = sanitizePayload(shaped, secrets).out;
    try { assertNoSecrets(clean, secrets, `sync_run ${id} pagination`); pagination = clean; }
    catch { pagination = { cursor: null }; }
  }
  await db.update(socialSyncRuns).set({
    status: i.status, finished_at: new Date(), pages: i.pages ?? 0, items: i.items ?? 0,
    error: error as any, pagination_state: pagination as any,
    ...(i.identityId ? { identity_id: i.identityId } : {}),
  }).where(eq(socialSyncRuns.id, id));
}

export interface StorePayloadInput {
  runId: string; athleteId: string; platform: string; provider: string; endpointFamily: string; pageIndex?: number;
  sourceClass: SourceClass; request: Record<string, unknown> | null; payload: unknown; fetchedAt: Date; retentionDays: number | null;
  /** Live credential strings for this call; they are redacted and then asserted absent. */
  secrets: string[];
}

/** Sanitize → assert → insert. Throws SanitizerLeakError rather than store a secret. */
export async function storePayload(i: StorePayloadInput): Promise<{ id: string; bytes: number; hash: string }> {
  const { out } = sanitizePayload(i.payload, i.secrets);
  const request = i.request ? sanitizePayload(i.request, i.secrets).out : null;
  assertNoSecrets(out, i.secrets, `${i.platform}/${i.endpointFamily}#${i.pageIndex ?? 0}`);
  if (request) assertNoSecrets(request, i.secrets, `${i.platform}/${i.endpointFamily} request`);
  const text = canonicalJson(out);
  const hash = createHash("sha256").update(text).digest("hex");
  const retainedUntil = i.retentionDays == null ? null : new Date(i.fetchedAt.getTime() + i.retentionDays * 86_400_000);
  const [row] = await db.insert(rawSourcePayloads).values({
    sync_run_id: i.runId, athlete_id: i.athleteId, platform: i.platform, provider: i.provider, endpoint_family: i.endpointFamily,
    page_index: i.pageIndex ?? 0, source_class: i.sourceClass, request: request as any, payload: out as any, payload_hash: hash,
    bytes: Buffer.byteLength(text), sanitizer_version: SANITIZER_VERSION, fetched_at: i.fetchedAt, retained_until: retainedUntil,
  }).returning({ id: rawSourcePayloads.id });
  return { id: row.id, bytes: Buffer.byteLength(text), hash };
}

// ─── observations, distributions, content ────────────────────────────────────

export interface WriteContext {
  athleteId: string; platform: string; identityId: string; sourceClass: SourceClass; sourceMethod: string; provider: string;
  confidence?: number; runId?: string | null; definitionVersion?: string;
  /** Single-payload runs only: the ONE stored payload every row came from. */
  payloadId?: string | null;
  /** Multi-payload runs: endpoint_family → stored payload id. A row names its family; an unknown family stores NULL, never a guess. */
  payloadIds?: Record<string, string>;
}

/** Lineage rule: exact family match, else the single payload of a single-payload run, else NULL (sync_run_id still links the run). */
export function payloadIdFor(ctx: WriteContext, family: string | undefined): string | null {
  if (ctx.payloadIds) return family ? (ctx.payloadIds[family] ?? null) : null;
  return ctx.payloadId ?? null;
}

/** Insert observations; duplicates on the unique key are skipped. Returns the number inserted. */
export async function writeObservations(ctx: WriteContext, rows: ObservationInput[], assetIds: Map<string, string> = new Map()): Promise<number> {
  if (!rows.length) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((o) => ({
      athlete_id: ctx.athleteId, platform: ctx.platform, identity_id: ctx.identityId,
      entity_type: o.entityType, entity_id: o.entityId, entity_time: o.entityTime ? new Date(o.entityTime) : null, entity_format: o.entityFormat ?? null,
      asset_id: o.entityType === "content" ? (assetIds.get(o.entityId) ?? null) : null,
      metric_key: o.metricKey, value: String(o.value), unit: o.unit,
      source_class: ctx.sourceClass, source_method: ctx.sourceMethod, provider: ctx.provider, confidence: String(o.confidence ?? ctx.confidence ?? 1),
      observed_at: new Date(o.observedAt), window_start: o.windowStart ? new Date(o.windowStart) : null, window_end: o.windowEnd ? new Date(o.windowEnd) : null,
      definition_version: ctx.definitionVersion ?? METRIC_DEFINITION_VERSION, sync_run_id: ctx.runId ?? null, payload_id: payloadIdFor(ctx, o.payloadFamily),
    }));
    const r = await db.insert(socialMetricObservations).values(chunk).onConflictDoNothing().returning({ id: socialMetricObservations.id });
    inserted += r.length;
  }
  return inserted;
}

export async function writeDistributions(ctx: WriteContext, rows: DistributionInput[]): Promise<number> {
  if (!rows.length) return 0;
  const r = await db.insert(socialAudienceDistributions).values(rows.map((d) => ({
    athlete_id: ctx.athleteId, platform: ctx.platform, identity_id: ctx.identityId,
    dimension: d.dimension, bucket: d.bucket, value: d.value == null ? null : String(d.value), pct: d.pct == null ? null : String(d.pct), basis: d.basis,
    source_class: ctx.sourceClass, source_method: ctx.sourceMethod, provider: ctx.provider, confidence: String(ctx.confidence ?? 1),
    observed_at: new Date(d.observedAt), window_start: d.windowStart ? new Date(d.windowStart) : null, window_end: d.windowEnd ? new Date(d.windowEnd) : null,
    definition_version: ctx.definitionVersion ?? METRIC_DEFINITION_VERSION, sync_run_id: ctx.runId ?? null, payload_id: payloadIdFor(ctx, d.payloadFamily),
  }))).onConflictDoNothing().returning({ id: socialAudienceDistributions.id });
  return r.length;
}

/**
 * Attach native facts to EXISTING media_assets rows for this athlete × platform (D1). Rows are
 * never created here — pixels and lifecycle belong to rehostAthleteMedia / mediaBackfill — so a
 * content item not yet in the library simply has observations with asset_id NULL until the
 * backfill creates its row. Returns source_media_id → asset id for the rows that exist.
 */
export async function attachContentNative(ctx: { athleteId: string; platform: string; identityId: string }, items: ContentInput[], secrets: string[] = []): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!items.length) return out;
  const ids = items.map((c) => c.sourceMediaId);
  const existing = await db.select({ id: mediaAssets.id, source_media_id: mediaAssets.source_media_id, native_version: mediaAssets.native_version })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.athlete_id, ctx.athleteId), eq(mediaAssets.platform, ctx.platform), inArray(mediaAssets.source_media_id, ids)));
  const byId = new Map(existing.map((e) => [e.source_media_id!, e]));
  for (const c of items) {
    const row = byId.get(c.sourceMediaId);
    if (!row) continue;
    out.set(c.sourceMediaId, row.id);
    const native = sanitizePayload(c.native, secrets).out;
    assertNoSecrets(native, secrets, `media_assets.native ${c.sourceMediaId}`);
    await db.update(mediaAssets).set({
      social_identity_id: ctx.identityId, native: native as any, content_format: c.contentFormat, native_version: NATIVE_VERSION,
      first_seen_at: sql`coalesce(${mediaAssets.first_seen_at}, now())`,
    }).where(eq(mediaAssets.id, row.id));
  }
  return out;
}

/** Write one adapted envelope's rows. */
export async function writeAdaptResult(ctx: WriteContext, r: Omit<AdaptResult, "identity">, secrets: string[] = []): Promise<{ observations: number; distributions: number; contentLinked: number }> {
  const assetIds = await attachContentNative({ athleteId: ctx.athleteId, platform: ctx.platform, identityId: ctx.identityId }, r.content, secrets);
  const observations = await writeObservations(ctx, r.observations, assetIds);
  const distributions = await writeDistributions(ctx, r.distributions);
  return { observations, distributions, contentLinked: assetIds.size };
}

// ─── reads for the calculator ────────────────────────────────────────────────

export async function loadObservations(athleteId: string, from: Date, to: Date): Promise<FeatureObservation[]> {
  const rows = await db.select().from(socialMetricObservations)
    .where(and(eq(socialMetricObservations.athlete_id, athleteId), gte(socialMetricObservations.observed_at, from), lte(socialMetricObservations.observed_at, to)))
    .orderBy(desc(socialMetricObservations.observed_at));
  return rows.map(toFeatureObservation);
}

export function toFeatureObservation(o: SocialMetricObservation): FeatureObservation {
  return {
    id: o.id, identityId: o.identity_id, platform: o.platform, entityType: o.entity_type, entityId: o.entity_id,
    entityTime: o.entity_time?.toISOString() ?? null, entityFormat: o.entity_format, metricKey: o.metric_key, value: Number(o.value),
    sourceClass: o.source_class as SourceClass, sourceMethod: o.source_method, observedAt: o.observed_at.toISOString(),
    windowStart: o.window_start?.toISOString() ?? null, windowEnd: o.window_end?.toISOString() ?? null,
  };
}

export async function loadDistributions(athleteId: string, from: Date, to: Date): Promise<FeatureDistribution[]> {
  const rows = await db.select().from(socialAudienceDistributions)
    .where(and(eq(socialAudienceDistributions.athlete_id, athleteId), gte(socialAudienceDistributions.observed_at, from), lte(socialAudienceDistributions.observed_at, to)));
  return rows.map(toFeatureDistribution);
}

export function toFeatureDistribution(d: SocialAudienceDistribution): FeatureDistribution {
  return {
    id: d.id, identityId: d.identity_id, platform: d.platform, dimension: d.dimension, bucket: d.bucket,
    value: d.value == null ? null : Number(d.value), pct: d.pct == null ? null : Number(d.pct), basis: d.basis,
    sourceClass: d.source_class as SourceClass, sourceMethod: d.source_method, observedAt: d.observed_at.toISOString(),
  };
}

// ─── features ────────────────────────────────────────────────────────────────

/** Upsert on the feature unique key: a rerun for the same as_of and version replaces the value and lineage. */
export async function writeFeatures(athleteId: string, rows: FeatureRow[]): Promise<number> {
  let n = 0;
  for (const r of rows) {
    await db.insert(socialFeatures).values({
      athlete_id: athleteId, platform: r.platform, identity_id: r.identityId, feature_key: r.featureKey,
      value: r.value == null ? null : String(r.value), value_json: r.valueJson == null ? null : (r.valueJson as any), unit: r.unit, n: r.n,
      window_days: r.windowDays, as_of: new Date(r.asOf), source_class: r.sourceClass, confidence: String(r.confidence), imputed: false, input_access_class: r.inputAccessClass,
      calculation_version: r.calculationVersion, inputs: r.inputs as any, computed_at: new Date(),
    }).onConflictDoUpdate({
      target: [socialFeatures.athlete_id, socialFeatures.platform, socialFeatures.identity_id, socialFeatures.feature_key, socialFeatures.window_days, socialFeatures.as_of, socialFeatures.calculation_version],
      set: { value: r.value == null ? null : String(r.value), value_json: r.valueJson == null ? null : (r.valueJson as any), n: r.n, source_class: r.sourceClass, confidence: String(r.confidence), input_access_class: r.inputAccessClass, inputs: r.inputs as any, computed_at: new Date() },
    });
    n++;
  }
  return n;
}
