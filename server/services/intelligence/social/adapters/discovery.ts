/**
 * social/adapters/discovery.ts — Instagram Business Discovery (public) → canonical rows.
 *
 * Public evidence, source_class platform_public. Business Discovery returns no reach, saves,
 * shares or demographics; those keys are absent. Media items carry an id only when the fetch
 * requested one (Step 1a adds it); items without an id produce no content observation.
 */

import type { InstagramDiscoveryNative } from "../native";
import { type AdaptContext, type AdaptResult, type ObservationInput, type ContentInput, isoOrNull, pushIf } from "./types";
import { igContentFormat } from "./instagram";

export function adaptInstagramDiscovery(n: InstagramDiscoveryNative, ctx: AdaptContext): AdaptResult {
  const at = ctx.observedAt;
  const obs: ObservationInput[] = [];
  const content: ContentInput[] = [];
  const bd = n.businessDiscovery;
  const acc = { entityType: "account" as const, entityId: n.accountId, observedAt: at, payloadFamily: "business_discovery" };
  pushIf(obs, { ...acc, metricKey: "followers",     unit: "count" }, bd.followers_count);
  pushIf(obs, { ...acc, metricKey: "content_count", unit: "count" }, bd.media_count);
  for (const m of bd.media?.data ?? []) {
    if (!m.id) continue;
    const format = igContentFormat(m);
    const postedAt = isoOrNull(m.timestamp);
    const base = { entityType: "content" as const, entityId: m.id, entityTime: postedAt, entityFormat: format, observedAt: at, payloadFamily: "business_discovery" };
    pushIf(obs, { ...base, metricKey: "like_count",     unit: "count" }, m.like_count);
    pushIf(obs, { ...base, metricKey: "comments_count", unit: "count" }, m.comments_count);
    content.push({ sourceMediaId: m.id, postedAt, contentFormat: format, native: { media_type: m.media_type ?? null, timestamp: m.timestamp ?? null } });
  }
  return {
    identity: {
      accountId: n.accountId, accountIdKind: bd.id ? "platform_id" : "handle",
      handle: n.handle, canonicalUrl: n.handle ? `https://www.instagram.com/${n.handle.replace(/^@/, "")}/` : null,
    },
    observations: obs, distributions: [], content,
  };
}
