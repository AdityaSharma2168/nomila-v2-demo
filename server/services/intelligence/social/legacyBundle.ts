/**
 * social/legacyBundle.ts — assemble an in-memory substrate from the rows Nomila already holds
 * (connected_accounts, social_analytics_snapshots, media_assets), through the legacy adapters
 * and the deterministic identity resolvers, into the calculator's input shape.
 *
 * Pure: it reads plain row objects and never the database. The same function serves the
 * synthetic fixture test, the `--synthetic` / `--fixtures` modes of socialFeatureVector, and the
 * `--from legacy` acceptance mode that reads an athlete's real rows on dev. Identity ids are
 * in-memory keys (`platform|account_id`); the database backfill assigns real ids but applies the
 * same resolution rules (backfillSocialSubstrate.ts).
 */

import type { SourceClass } from "../types";
import { adaptLegacyMediaAsset, adaptLegacySnapshot, legacySourceClass, resolveMediaIdentity, resolveSnapshotIdentity, type KnownIdentity, type LegacyMediaRow, type LegacySnapshotRow } from "./adapters/legacy";
import type { FeatureDistribution, FeatureObservation } from "./features";

export interface LegacyConnection { id?: string; platform: string; platform_user_id: string | null; platform_username: string | null }

export interface BundleIdentity extends KnownIdentity { platform: string; sourceClass: SourceClass }
export interface LegacyBundle {
  identities: BundleIdentity[];
  observations: FeatureObservation[];
  distributions: FeatureDistribution[];
  raw: Array<{ platform: string; family: string; observedAt: string; bytes: number }>;
  /** Rows whose owner could not be determined deterministically. Never attached to a guessed identity. */
  skipped: Array<{ platform: string; kind: "snapshot" | "media"; origin: string; rows: number; reason: string; candidates: string[] }>;
  resolutions: Record<string, number>;
}

export interface AssembleInput {
  connections: LegacyConnection[];
  snapshots: LegacySnapshotRow[];
  media: LegacyMediaRow[];
  /** Nomila's own shared discovery account is never an athlete identity. */
  isSharedAccount?: (platform: string, accountId: string) => boolean;
}

export function assembleLegacyBundle(input: AssembleInput): LegacyBundle {
  const identities: BundleIdentity[] = [];
  const known = (platform: string): KnownIdentity[] => identities.filter((i) => i.platform === platform);
  const keyOf = (platform: string, accountId: string) => `${platform}|${accountId}`;
  const resolutions: Record<string, number> = {};
  const count = (k: string) => { resolutions[k] = (resolutions[k] ?? 0) + 1; };
  const skipped: LegacyBundle["skipped"] = [];

  // 1. Connected accounts are identities in their own right (every status: D5).
  for (const c of input.connections) {
    if (!c.platform_user_id || input.isSharedAccount?.(c.platform, c.platform_user_id)) continue;
    const id = keyOf(c.platform, c.platform_user_id);
    const existing = identities.find((i) => i.id === id);
    if (existing) { if (c.id) (existing.connectedAccountIds ??= []).push(c.id); continue; }
    identities.push({ id, platform: c.platform, accountId: c.platform_user_id, accountIdKind: "platform_id", handle: c.platform_username, sourceClass: "connected_verified", connectedAccountIds: c.id ? [c.id] : [] });
  }

  let seq = 0;
  const observations: FeatureObservation[] = [], distributions: FeatureDistribution[] = [];
  const raw: LegacyBundle["raw"] = [];

  // 2. Snapshot rows → identity by rule, then observations/distributions.
  for (const s of [...input.snapshots].sort((a, b) => new Date(a.snapshot_date).getTime() - new Date(b.snapshot_date).getTime())) {
    const { identity, result } = adaptLegacySnapshot(s);
    if (!identity) { skipped.push({ platform: s.platform, kind: "snapshot", origin: s.source, rows: 1, reason: "no account id or handle in the row", candidates: [] }); continue; }
    const cls = legacySourceClass(s.source);
    const r = resolveSnapshotIdentity(known(s.platform), identity, s.connected_account_id);
    let id: string;
    if (r.ok) { id = r.id; count(`snapshot:${r.via}`); }
    else if (r.reason === "unknown_account") { id = keyOf(s.platform, identity.accountId); identities.push({ id, platform: s.platform, accountId: identity.accountId, accountIdKind: identity.accountIdKind, handle: identity.handle, sourceClass: cls }); count("snapshot:new_identity"); }
    else { skipped.push({ platform: s.platform, kind: "snapshot", origin: s.source, rows: 1, reason: r.reason, candidates: r.candidates }); continue; }
    raw.push({ platform: s.platform, family: "legacy_snapshot", observedAt: new Date(s.snapshot_date).toISOString(), bytes: JSON.stringify(s.raw_metrics ?? {}).length });
    for (const o of result.observations) observations.push({ id: ++seq, identityId: id, platform: s.platform, entityType: o.entityType, entityId: o.entityId, entityTime: o.entityTime ?? null, entityFormat: o.entityFormat ?? null, metricKey: o.metricKey, value: o.value, sourceClass: cls, sourceMethod: "legacy_snapshot", observedAt: o.observedAt, windowStart: o.windowStart ?? null, windowEnd: o.windowEnd ?? null });
    for (const d of result.distributions) distributions.push({ id: ++seq, identityId: id, platform: s.platform, dimension: d.dimension, bucket: d.bucket, value: d.value, pct: d.pct, basis: d.basis, sourceClass: cls, sourceMethod: "legacy_snapshot", observedAt: d.observedAt });
  }

  // 3. media_assets rows → identity only when the platform has exactly one candidate.
  const groups = new Map<string, LegacyMediaRow[]>();
  for (const m of input.media) { const k = `${m.platform}|${m.origin}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(m); }
  for (const [k, rows] of groups) {
    const [platform, origin] = k.split("|");
    const r = resolveMediaIdentity(known(platform), origin);
    if (!r.ok) { skipped.push({ platform, kind: "media", origin, rows: rows.length, reason: r.reason, candidates: r.candidates }); continue; }
    count(`media:${r.via}`);
    const cls: SourceClass = origin === "connected" ? "connected_verified" : "platform_public";
    for (const m of rows) {
      for (const o of adaptLegacyMediaAsset(m).observations) observations.push({ id: ++seq, identityId: r.id, platform, entityType: o.entityType, entityId: o.entityId, entityTime: o.entityTime ?? null, entityFormat: o.entityFormat ?? null, metricKey: o.metricKey, value: o.value, sourceClass: cls, sourceMethod: "legacy_media_assets", observedAt: o.observedAt, windowStart: null, windowEnd: null });
    }
  }

  return { identities, observations, distributions, raw, skipped, resolutions };
}
