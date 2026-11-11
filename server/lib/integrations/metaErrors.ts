/**
 * metaErrors.ts — classify a Meta Graph error by its CODE, never by HTTP status or message text
 * alone (Step 1b design §8).
 *
 * Only `auth` may expire a connection: OAuthException code 190 (invalid / expired token, any
 * subcode: 458 app removed, 460 password changed, 463 expired, 467 invalidated) or code 102
 * (session). Everything else — permission scoping (200–299), "not enough viewers" (10),
 * an unsupported metric (100), rate limits (4, 17, 32, 613, 80002), transient 5xx, and any
 * bare 403 — leaves the connection intact and makes the run partial.
 *
 * Pure: no I/O, no logging. Provider-specific by nature, so it lives under lib/integrations,
 * never under services/intelligence.
 */

import type { ProviderErrorClass } from "../../services/intelligence/social/native";

export interface MetaErrorInfo {
  class: ProviderErrorClass;
  code?: number;
  subcode?: number;
  type?: string;
  httpStatus?: number;
  message: string;
  /** For `unsupported_metric`: the metric the message names, when it names one. */
  metric?: string;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);

export function classifyMetaError(json: unknown, httpStatus?: number): MetaErrorInfo {
  const e = (json as any)?.error;
  if (!e || typeof e !== "object") {
    const message = typeof json === "string" ? json.slice(0, 300) : httpStatus ? `HTTP ${httpStatus}` : "no error body";
    return { class: httpStatus != null && httpStatus >= 500 ? "transient" : "unknown", httpStatus, message };
  }
  const code = typeof e.code === "number" ? e.code : Number.isFinite(Number(e.code)) ? Number(e.code) : undefined;
  const subcode = typeof e.error_subcode === "number" ? e.error_subcode : undefined;
  const type = typeof e.type === "string" ? e.type : undefined;
  const message = String(e.message ?? "").slice(0, 300);
  const base = { code, subcode, type, httpStatus, message };

  if (code === 190 || code === 102) return { ...base, class: "auth" };
  if (code != null && code >= 200 && code <= 299) return { ...base, class: "permission" };
  if (code === 10) return { ...base, class: /not enough viewers/i.test(message) ? "not_enough_viewers" : "permission" };
  if (code === 100 && /metric/i.test(message)) {
    const named = /support the (\w+) metric/i.exec(message)?.[1];
    return { ...base, class: "unsupported_metric", ...(named ? { metric: named } : {}) };
  }
  if (code != null && RATE_LIMIT_CODES.has(code)) return { ...base, class: "rate_limited" };
  if (httpStatus != null && httpStatus >= 500) return { ...base, class: "transient" };
  return { ...base, class: "unknown" };
}

/** True only for the class that may expire a connection. */
export const isAuthClass = (c: ProviderErrorClass): boolean => c === "auth";
