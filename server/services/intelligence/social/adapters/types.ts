/**
 * social/adapters/types.ts — what every platform adapter produces.
 *
 * An adapter is a pure function from a native envelope to canonical rows: identity facts,
 * metric observations, audience distributions and durable content facts. It never touches the
 * database and never imports a provider module. Definition versions are stamped at write time
 * from the registry, not here.
 */

import type { SourceClass } from "../../types";
import type { MetricKey, MetricUnit, ContentFormat } from "../metrics";

export interface AdaptContext {
  athleteId:    string;
  platform:     "instagram" | "tiktok" | "youtube";
  sourceClass:  SourceClass;
  /** The exact provider path, e.g. oauth_instagram_login | meta_business_discovery | legacy_snapshot. */
  sourceMethod: string;
  /** Provider family, e.g. meta_graph | tiktok_display | youtube. */
  provider:     string;
  /** ISO instant used for point-in-time metrics. */
  observedAt:   string;
  /** 0–1; applied to every row unless the row sets its own. */
  confidence?:  number;
}

export interface IdentityFacts {
  accountId:     string;
  accountIdKind: "platform_id" | "handle";
  handle:        string | null;
  canonicalUrl:  string | null;
}

export interface ObservationInput {
  entityType:    "account" | "content" | "audience";
  entityId:      string;
  entityTime?:   string | null;
  entityFormat?: ContentFormat | null;
  metricKey:     MetricKey;
  value:         number;
  unit:          MetricUnit;
  observedAt:    string;
  windowStart?:  string | null;
  windowEnd?:    string | null;
  confidence?:   number;
  /** Which stored sub-response (raw_source_payloads.endpoint_family) this row was read from. Rows without one keep payload_id NULL and rely on sync_run_id. */
  payloadFamily?: string;
}

export interface DistributionInput {
  dimension:    "country" | "city" | "age" | "gender" | "age_gender" | "traffic_source" | "device";
  bucket:       string;
  value:        number | null;
  pct:          number | null;
  basis:        "followers" | "viewers" | "views";
  observedAt:   string;
  windowStart?: string | null;
  windowEnd?:   string | null;
  payloadFamily?: string;
}

/** Durable, immutable facts about one content item, for media_assets.native / content_format. */
export interface ContentInput {
  sourceMediaId: string;
  postedAt:      string | null;
  contentFormat: ContentFormat;
  parentMediaId?: string | null;
  native:        Record<string, unknown>;
}

export interface AdaptResult {
  identity:      IdentityFacts;
  observations:  ObservationInput[];
  distributions: DistributionInput[];
  content:       ContentInput[];
}

export const NATIVE_VERSION = "v1";

/** Numbers only; a missing or non-finite value is absent, never zero. */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}

export function isoOrNull(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
  return null;
}

export function dayWindow(observedAt: string): { windowStart: string; windowEnd: string } {
  const end = new Date(observedAt);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  return { windowStart: start.toISOString(), windowEnd: end.toISOString() };
}

export function daysWindow(observedAt: string, days: number): { windowStart: string; windowEnd: string } {
  const end = new Date(observedAt);
  return { windowStart: new Date(end.getTime() - days * 86_400_000).toISOString(), windowEnd: end.toISOString() };
}

/** Push an observation only when the value is a finite number. */
export function pushIf(out: ObservationInput[], base: Omit<ObservationInput, "value" | "unit"> & { unit: MetricUnit }, value: unknown): void {
  const n = num(value);
  if (n === null) return;
  out.push({ ...base, value: n });
}
