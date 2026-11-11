/**
 * mediaKey.ts — opaque public keys. A published photo or video goes by an opaque key on the page (/p/:handle/m/:key), never the
 * asset id or a bucket path: a hash of the athlete and the asset, stable across versions so the page caches well.
 */
import { createHash } from "node:crypto";

export const MEDIA_KEY_PATTERN = /^m[0-9a-f]{20}$/;

export function mediaKeyOf(athleteKey: string, assetId: string): string {
  return `m${createHash("sha256").update(`${athleteKey}:${assetId}`).digest("hex").slice(0, 20)}`;
}

/** Item keys whose raw form carries an internal id (a deal, an asset, a fact, an assertion, an affiliation row). */
const OPAQUE_PREFIX = /^(hl\.aff|hl\.quote|partner|media|comp|impact\.cause|impact\.value):/;

/**
 * The public form of an item key. Keys travel in the published content (her decisions and removals use them), so any
 * key built from an internal id is replaced by a stable hash of the athlete and the raw key. Keys that are already
 * public (offer:<public id>, pick:<go code>, hl.stat:<platform>, story.<beat> …) are kept as they are.
 */
export function opaqueItemKey(athleteKey: string, rawKey: string): string {
  const m = rawKey.match(OPAQUE_PREFIX);
  if (!m) return rawKey;
  return `${m[1]}:${createHash("sha256").update(`${athleteKey}|${rawKey}`).digest("hex").slice(0, 16)}`;
}
