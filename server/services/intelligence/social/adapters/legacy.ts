/**
 * social/adapters/legacy.ts — the two backfill adapters: existing stored rows → canonical rows.
 *
 * Nomila already holds months of evidence in two places that predate the substrate:
 *   · social_analytics_snapshots — one display row per athlete × platform × day, with account
 *     columns and a raw_metrics blob (account, account_insights, recent_media, demographics,
 *     youtube). source_method 'legacy_snapshot'; observed_at = snapshot_date.
 *   · media_assets — durable content with counters and enriched per-post insights that were
 *     overwritten on every re-see, so each row yields ONE observation per metric, at the last
 *     time it was refreshed. source_method 'legacy_media_assets'.
 *
 * These adapters read plain objects (the rows as selected), never the database, so they run
 * identically against live tables and against committed fixtures (the Mia command's
 * --fixtures mode). Everything they cannot recover stays absent: no id on a discovery media
 * item → no content observation; no timestamp → no entity_time.
 */

import type { SourceClass } from "../../types";
import type { ContentFormat } from "../metrics";
import { type AdaptResult, type ObservationInput, type DistributionInput, type ContentInput, type IdentityFacts, daysWindow, dayWindow, isoOrNull, num, pushIf } from "./types";
import { igContentFormat } from "./instagram";

export type LegacyPlatform = "instagram" | "tiktok" | "youtube";

export interface LegacySnapshotRow {
  id: string; athlete_id: string; platform: string; source: string; connected_account_id: string | null;
  snapshot_date: string | Date; followers: number | null; following: number | null; post_count: number | null;
  total_likes: number | null; total_channel_views: number | null; is_verified: boolean | null;
  reach: number | null; impressions: number | null; profile_views: number | null; avg_watch_time_sec: number | null;
  raw_metrics: any;
}

export interface LegacyMediaRow {
  id: string; athlete_id: string; platform: string; origin: string; source_media_id: string | null; parent_media_id: string | null;
  media_type: string; permalink: string | null; posted_at: string | Date | null; like_count: number | null; comments_count: number | null;
  insights: any; metadata: any; metadata_updated_at: string | Date | null; ingested_at: string | Date | null;
}

export function legacySourceClass(source: string | null | undefined): SourceClass {
  switch (source) {
    case "connected": return "connected_verified";
    case "provider":  return "platform_public";
    case "discovery": return "platform_public";
    case "research":  return "web_researched";
    default:          return "platform_public";
  }
}

function legacyFormat(platform: string, mediaType: string | null | undefined): ContentFormat {
  if (platform === "instagram") return igContentFormat({ media_type: mediaType ?? undefined });
  if (platform === "youtube") return "video";
  return "video";
}

const iso = (v: string | Date | null | undefined): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : isoOrNull(v));

/**
 * One daily snapshot row → identity (when the raw account carries an id), account observations,
 * content observations for its recent_media, distributions.
 */
export function adaptLegacySnapshot(row: LegacySnapshotRow): { identity: IdentityFacts | null; result: Omit<AdaptResult, "identity"> } {
  const at = iso(row.snapshot_date) ?? new Date().toISOString();
  const platform = row.platform as LegacyPlatform;
  const raw = row.raw_metrics ?? {};
  const account = raw.account ?? {};
  const obs: ObservationInput[] = [];
  const dist: DistributionInput[] = [];
  const content: ContentInput[] = [];

  // Identity: the platform's account id when the row carried one, else the handle.
  const accountId: string | null =
    platform === "instagram" ? (account.id ? String(account.id) : null)
    : platform === "tiktok"  ? (account.open_id ? String(account.open_id) : null)
    : (account.id ? String(account.id) : (raw.discovery?.channelId ? String(raw.discovery.channelId) : null));
  const handle: string | null = account.username ?? account.customUrl ?? raw.discovery?.username ?? null;
  const identity: IdentityFacts | null = accountId
    ? { accountId, accountIdKind: "platform_id", handle, canonicalUrl: null }
    : handle ? { accountId: `handle:${String(handle).replace(/^@/, "").toLowerCase()}`, accountIdKind: "handle", handle, canonicalUrl: null }
    : null;
  const entityId = identity?.accountId ?? "unknown";
  const acc = { entityType: "account" as const, entityId, observedAt: at };

  // Account columns.
  pushIf(obs, { ...acc, metricKey: platform === "youtube" ? "subscribers" : "followers", unit: "count" }, row.followers);
  pushIf(obs, { ...acc, metricKey: "following",     unit: "count" }, row.following);
  pushIf(obs, { ...acc, metricKey: "content_count", unit: "count" }, row.post_count);
  pushIf(obs, { ...acc, metricKey: "likes_total",   unit: "count" }, row.total_likes);
  pushIf(obs, { ...acc, metricKey: "views_total",   unit: "count" }, row.total_channel_views);
  if (platform === "tiktok" && typeof row.is_verified === "boolean") pushIf(obs, { ...acc, metricKey: "is_verified", unit: "count" }, row.is_verified ? 1 : 0);
  if (platform === "instagram") {
    const w = dayWindow(at);
    pushIf(obs, { ...acc, metricKey: "account_reach",     unit: "count", ...w }, row.reach);
    pushIf(obs, { ...acc, metricKey: "account_views",     unit: "count", ...w }, row.impressions);
    pushIf(obs, { ...acc, metricKey: "profile_link_taps", unit: "count", ...w }, row.profile_views);
  }
  if (platform === "youtube") {
    const w = daysWindow(at, 30);
    const yt = raw.youtube ?? {};
    pushIf(obs, { ...acc, metricKey: "views_30d",             unit: "count",   ...w }, yt.views_30d ?? row.impressions);
    pushIf(obs, { ...acc, metricKey: "minutes_watched_30d",   unit: "count",   ...w }, yt.minutes_watched_30d);
    pushIf(obs, { ...acc, metricKey: "avg_view_pct_30d",      unit: "percent", ...w }, yt.avg_view_pct);
    pushIf(obs, { ...acc, metricKey: "avg_view_duration_30d", unit: "seconds", ...w }, row.avg_watch_time_sec);
    pushIf(obs, { ...acc, metricKey: "subs_gained_30d",       unit: "count",   ...w }, yt.subs_gained_30d);
    pushIf(obs, { ...acc, metricKey: "subs_lost_30d",         unit: "count",   ...w }, yt.subs_lost_30d);
    for (const r of yt.countries ?? []) dist.push({ dimension: "country",        bucket: String(r.key), value: num(r.value), pct: num(r.pct), basis: "views",   observedAt: at, ...w });
    for (const r of yt.traffic ?? [])   dist.push({ dimension: "traffic_source", bucket: String(r.key), value: num(r.value), pct: num(r.pct), basis: "views",   observedAt: at, ...w });
    for (const r of yt.devices ?? [])   dist.push({ dimension: "device",         bucket: String(r.key), value: num(r.value), pct: num(r.pct), basis: "views",   observedAt: at, ...w });
    for (const r of yt.age_gender ?? []) dist.push({ dimension: "age_gender",   bucket: `${r.age}|${r.gender}`, value: null, pct: num(r.pct), basis: "viewers", observedAt: at, ...w });
  }

  // Follower demographics (Instagram and TikTok store them by followers; YouTube's are handled above).
  if (platform !== "youtube") {
    const w30 = daysWindow(at, 30);
    for (const dim of ["country", "city", "age", "gender"] as const) {
      for (const r of raw.demographics?.[dim] ?? []) dist.push({ dimension: dim, bucket: String(r.key), value: num(r.value), pct: num(r.pct), basis: "followers", observedAt: at, ...w30 });
    }
  }

  // recent_media → content observations at the snapshot instant.
  for (const m of raw.recent_media ?? []) {
    if (!m?.id) continue;
    const format = legacyFormat(platform, m.media_type);
    const postedAt = isoOrNull(m.timestamp);
    const base = { entityType: "content" as const, entityId: String(m.id), entityTime: postedAt, entityFormat: format, observedAt: at };
    pushIf(obs, { ...base, metricKey: "like_count",         unit: "count" }, m.like_count);
    pushIf(obs, { ...base, metricKey: "comments_count",     unit: "count" }, m.comments_count);
    pushIf(obs, { ...base, metricKey: "reach",              unit: "count" }, m.insights?.reach);
    pushIf(obs, { ...base, metricKey: "save_count",         unit: "count" }, m.insights?.saved);
    pushIf(obs, { ...base, metricKey: "share_count",        unit: "count" }, m.insights?.shares);
    pushIf(obs, { ...base, metricKey: "total_interactions", unit: "count" }, m.insights?.total_interactions);
    pushIf(obs, { ...base, metricKey: "view_count",         unit: "count" }, m.insights?.video_views);
    content.push({ sourceMediaId: String(m.id), postedAt, contentFormat: format, native: { media_type: m.media_type ?? null, permalink: m.permalink ?? null, timestamp: m.timestamp ?? null, legacy: true } });
  }

  return { identity, result: { observations: obs, distributions: dist, content } };
}

/** One media_assets row → its observations at the last refresh time it recorded. */
export function adaptLegacyMediaAsset(row: LegacyMediaRow): { observations: ObservationInput[]; contentFormat: ContentFormat } {
  const obs: ObservationInput[] = [];
  const format = row.media_type === "CAROUSEL_CHILD" ? "carousel_frame" : legacyFormat(row.platform, row.media_type);
  if (!row.source_media_id) return { observations: obs, contentFormat: format };
  const refreshedAt = iso(row.metadata_updated_at) ?? iso(row.ingested_at);
  const enrichedAt = iso(row.metadata?.insights_enriched_at) ?? refreshedAt;
  const postedAt = iso(row.posted_at);
  const base = { entityType: "content" as const, entityId: row.source_media_id, entityTime: postedAt, entityFormat: format };
  if (refreshedAt) {
    pushIf(obs, { ...base, metricKey: "like_count",     unit: "count", observedAt: refreshedAt }, row.like_count);
    pushIf(obs, { ...base, metricKey: "comments_count", unit: "count", observedAt: refreshedAt }, row.comments_count);
  }
  const ins = row.insights ?? {};
  if (enrichedAt) {
    pushIf(obs, { ...base, metricKey: "reach",              unit: "count", observedAt: enrichedAt }, ins.reach);
    pushIf(obs, { ...base, metricKey: "save_count",         unit: "count", observedAt: enrichedAt }, ins.saved);
    pushIf(obs, { ...base, metricKey: "share_count",        unit: "count", observedAt: enrichedAt }, ins.shares);
    pushIf(obs, { ...base, metricKey: "total_interactions", unit: "count", observedAt: enrichedAt }, ins.total_interactions);
    pushIf(obs, { ...base, metricKey: "view_count",         unit: "count", observedAt: enrichedAt }, ins.video_views);
    const wt = num(ins.ig_reels_avg_watch_time);
    if (wt !== null) pushIf(obs, { ...base, metricKey: "avg_watch_time_sec", unit: "seconds", observedAt: enrichedAt }, wt / 1000);
  }
  return { observations: obs, contentFormat: format };
}

// ─── identity resolution for legacy rows (deterministic; never a guess) ───────

export interface KnownIdentity { id: string; accountId: string; accountIdKind: "platform_id" | "handle"; handle: string | null; /** connected_accounts ids that established this identity */ connectedAccountIds?: string[] }
export type IdentityResolution =
  | { ok: true; id: string; via: "account_id" | "connected_account" | "handle_match" | "sole_identity" }
  | { ok: false; reason: "unknown_account" | "ambiguous_handle" | "no_identity" | "ambiguous_platform"; candidates: string[] };

const normHandle = (h: string | null | undefined): string | null => { const v = (h ?? "").replace(/^@/, "").trim().toLowerCase(); return v || null; };

/**
 * A snapshot row's identity facts → one of the athlete's known identities on that platform.
 * Rules, in order:
 *   1. the exact account id;
 *   2. the row's connected_account_id names a connection that established a known identity
 *      (Instagram Login returns two ids for one account — the professional account id the
 *      connection is keyed on and an app-scoped id the profile call reports — so the linkage,
 *      not the id string, is the evidence);
 *   3. a handle-keyed row whose handle equals exactly one platform_id identity's handle (the same
 *      account seen through discovery/research);
 *   otherwise `unknown_account`, which the caller may turn into a NEW identity — the facts are
 * its own. Two platform_id identities sharing a handle is `ambiguous_handle`: the row is skipped.
 */
export function resolveSnapshotIdentity(known: KnownIdentity[], facts: IdentityFacts, connectedAccountId?: string | null): IdentityResolution {
  const exact = known.find((k) => k.accountId === facts.accountId);
  if (exact) return { ok: true, id: exact.id, via: "account_id" };
  if (connectedAccountId) {
    const linked = known.filter((k) => k.connectedAccountIds?.includes(connectedAccountId));
    if (linked.length === 1) return { ok: true, id: linked[0].id, via: "connected_account" };
  }
  if (facts.accountIdKind === "handle") {
    const h = normHandle(facts.handle);
    const matches = known.filter((k) => k.accountIdKind === "platform_id" && normHandle(k.handle) === h);
    if (matches.length === 1) return { ok: true, id: matches[0].id, via: "handle_match" };
    if (matches.length > 1) return { ok: false, reason: "ambiguous_handle", candidates: matches.map((m) => m.id) };
  }
  return { ok: false, reason: "unknown_account", candidates: [] };
}

/**
 * A media_assets row carries no account linkage, so its identity is deterministic only when the
 * platform has exactly one candidate: connected-origin rows belong to a platform_id identity;
 * discovery-origin rows to any identity. Anything else is reported and skipped, never attached
 * to an arbitrary account.
 */
export function resolveMediaIdentity(known: KnownIdentity[], origin: string): IdentityResolution {
  const pool = origin === "connected" ? known.filter((k) => k.accountIdKind === "platform_id") : known;
  if (pool.length === 1) return { ok: true, id: pool[0].id, via: "sole_identity" };
  if (pool.length === 0) return { ok: false, reason: "no_identity", candidates: [] };
  return { ok: false, reason: "ambiguous_platform", candidates: pool.map((k) => k.id) };
}
