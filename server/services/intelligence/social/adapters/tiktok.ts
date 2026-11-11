/**
 * social/adapters/tiktok.ts — TikTokNative (connected, Display API) → canonical rows.
 *
 * Keeps duration, title and video_description as separate native fields (spec §28.5, §29.1);
 * nothing is forced into an Instagram-shaped object. TikTok exposes no reach and no saves, so
 * those keys are simply absent. Views are view_count and never pooled with other platforms.
 */

import type { TikTokNative, TtVideo } from "../native";
import { type AdaptContext, type AdaptResult, type ObservationInput, type DistributionInput, type ContentInput, isoOrNull, pushIf } from "./types";

export function adaptTikTok(n: TikTokNative, ctx: AdaptContext): AdaptResult {
  const at = ctx.observedAt;
  const obs: ObservationInput[] = [];
  const dist: DistributionInput[] = [];
  const content: ContentInput[] = [];
  const acc = { entityType: "account" as const, entityId: n.accountId, observedAt: at, payloadFamily: "user_info" };

  pushIf(obs, { ...acc, metricKey: "followers",     unit: "count" }, n.user.follower_count);
  pushIf(obs, { ...acc, metricKey: "following",     unit: "count" }, n.user.following_count);
  pushIf(obs, { ...acc, metricKey: "likes_total",   unit: "count" }, n.user.likes_count);
  pushIf(obs, { ...acc, metricKey: "content_count", unit: "count" }, n.user.video_count);
  if (typeof n.user.is_verified === "boolean") pushIf(obs, { ...acc, metricKey: "is_verified", unit: "count" }, n.user.is_verified ? 1 : 0);

  for (const v of n.videos) adaptVideo(v, at, obs, content, "video_list");

  if (n.demographics) {
    for (const dim of ["country", "gender", "age"] as const) {
      for (const r of n.demographics[dim] ?? []) dist.push({ dimension: dim, bucket: String(r.key), value: r.value ?? null, pct: r.pct ?? null, basis: "followers", observedAt: at, payloadFamily: "creator_info" });
    }
  }

  return {
    identity: { accountId: n.accountId, accountIdKind: "platform_id", handle: n.handle, canonicalUrl: n.handle ? `https://www.tiktok.com/@${n.handle.replace(/^@/, "")}` : null },
    observations: obs, distributions: dist, content,
  };
}

export function adaptVideo(v: TtVideo, at: string, obs: ObservationInput[], content: ContentInput[], payloadFamily?: string): void {
  const id = v.id != null ? String(v.id) : "";
  if (!id) return;
  const postedAt = isoOrNull(v.create_time);
  const base = { entityType: "content" as const, entityId: id, entityTime: postedAt, entityFormat: "video" as const, observedAt: at, payloadFamily };
  pushIf(obs, { ...base, metricKey: "view_count",     unit: "count" },   v.view_count);
  pushIf(obs, { ...base, metricKey: "like_count",     unit: "count" },   v.like_count);
  pushIf(obs, { ...base, metricKey: "comments_count", unit: "count" },   v.comment_count);
  pushIf(obs, { ...base, metricKey: "share_count",    unit: "count" },   v.share_count);
  pushIf(obs, { ...base, metricKey: "duration_sec",   unit: "seconds" }, v.duration);
  content.push({
    sourceMediaId: id, postedAt, contentFormat: "video", parentMediaId: null,
    native: { title: v.title ?? null, video_description: v.video_description ?? null, duration: v.duration ?? null, share_url: v.share_url ?? null, create_time: v.create_time ?? null },
  });
}
