/**
 * social/profileBio.ts — the athlete's own profile bio, kept as a time-stamped social feature.
 *
 * The bio rides in envelopes we already fetch; nothing here calls a provider. One row per change:
 * `social_features` with `feature_key = "profile.bio"`, `value_json = { text }`, the envelope's
 * platform and source class, and `as_of` = the fetch instant. An identical bio to the latest one
 * stored for the same account is not written again, so the rows read as a history of changes.
 *
 * Where each platform's bio comes from:
 *   youtube    connected channels.list (part=snippet) → snippet.description   connected_verified
 *              public channel lookup (YouTube Data API)  → snippet.description  platform_public
 *   tiktok     user/info `bio_description` (user.info.profile scope)         connected_verified
 *   instagram  Business Discovery `biography` (public business/creator accounts) platform_public —
 *              for unconnected athletes through the normal discovery ingest, and for CONNECTED
 *              accounts through the same nightly lookup on the connected handle, bio only
 *              (substrate.ts ingestDiscoveryBio; collectDiscoveryAnalytics)
 *              The Instagram-Login profile call (graph.instagram.com) does not list a bio field
 *              (documented fields: id, user_id, username, name, account_type, profile_picture_url,
 *              followers_count, follows_count, media_count), so no connected bio is requested.
 *
 * value is NULL, so numeric readers (and the Identity Intelligence envelope, which skips null
 * values) ignore the row; its calculation_version is its own, so the M.I.A. social block (which
 * filters on FEATURE_CALCULATION_VERSION) never sees it.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../../db";
import { socialFeatures } from "../../../../shared/schema";
import type { SourceClass } from "../types";
import type { FeatureKey } from "./metrics";
import type { InstagramDiscoveryNative, SocialNative, TikTokNative, YouTubeNative, YouTubeDiscoveryNative } from "./native";
import { writeFeatures } from "./ingest";

export const PROFILE_BIO_KEY = "profile.bio";
export const PROFILE_BIO_VERSION = "profile_bio/1";
const MAX_BIO_CHARS = 2000;

/** The bio an envelope carries, trimmed; null when it carries none or an empty one. */
export function bioOf(native: SocialNative): string | null {
  let raw: unknown = null;
  if (native.sourceMethod === "meta_business_discovery") raw = (native as InstagramDiscoveryNative).businessDiscovery?.biography;
  else if (native.platform === "youtube") raw = (native as YouTubeNative | YouTubeDiscoveryNative).channel?.snippet?.description;
  else if (native.platform === "tiktok") raw = (native as TikTokNative).user?.bio_description;
  if (typeof raw !== "string") return null;
  const text = raw.trim().slice(0, MAX_BIO_CHARS);
  return text || null;
}

export interface PersistBioInput {
  athleteId: string; platform: string; identityId: string | null; sourceClass: SourceClass;
  text: string | null; asOf: Date; inputs?: Record<string, unknown>;
}

/** Store the bio when non-empty and different from the latest stored for this account. Returns true when a row was written. */
export async function persistProfileBio(i: PersistBioInput): Promise<boolean> {
  const text = i.text?.trim();
  if (!text) return false;
  const [latest] = await db.select({ value_json: socialFeatures.value_json }).from(socialFeatures)
    .where(and(
      eq(socialFeatures.athlete_id, i.athleteId), eq(socialFeatures.platform, i.platform), eq(socialFeatures.feature_key, PROFILE_BIO_KEY),
      i.identityId ? eq(socialFeatures.identity_id, i.identityId) : isNull(socialFeatures.identity_id),
    ))
    .orderBy(desc(socialFeatures.as_of)).limit(1);
  if ((latest?.value_json as { text?: unknown } | null)?.text === text) return false;
  await writeFeatures(i.athleteId, [{
    platform: i.platform, identityId: i.identityId,
    // Not a calculated metric, so it is not in the FEATURES registry; stored through the same writer.
    featureKey: PROFILE_BIO_KEY as FeatureKey,
    value: null, valueJson: { text }, unit: "text", n: null, windowDays: 0, asOf: i.asOf.toISOString(),
    sourceClass: i.sourceClass,
    inputAccessClass: i.sourceClass === "connected_verified" ? "includes_athlete_private" : "public_only",
    confidence: i.sourceClass === "connected_verified" ? 1 : 0.7,
    inputs: i.inputs ?? {}, calculationVersion: PROFILE_BIO_VERSION,
  }]);
  return true;
}
