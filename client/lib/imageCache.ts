/**
 * imageCache — a stable cache identity for a remote image.
 *
 * Media urls are SIGNED per request (GCS v4: `?X-Goog-Signature=…&X-Goog-Expires=…`), so the same photo arrives under a
 * new url on every launch and an image cache keyed on the url never hits: every photo re-downloads, every time. The
 * object's path (origin + pathname) is stable, so that is the key. Unsigned urls keep the default (the url itself).
 */

const SIGNED = /[?&](X-Goog-Signature|X-Amz-Signature|Signature|GoogleAccessId)=/i;

/** The cache key for `uri`: origin + path for a signed url, else undefined (the url is already stable). */
export function stableImageKey(uri: string | null | undefined): string | undefined {
  if (!uri || !SIGNED.test(uri)) return undefined;
  const q = uri.indexOf("?");
  return q > 0 ? uri.slice(0, q) : undefined;
}

/** An expo-image source for `uri` with the stable key; `key` (e.g. an asset id) wins when the caller has one. */
export function cachedSource(uri: string, key?: string | null): { uri: string; cacheKey?: string } {
  const cacheKey = key ?? stableImageKey(uri);
  return cacheKey ? { uri, cacheKey } : { uri };
}
