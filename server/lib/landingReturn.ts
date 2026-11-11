/**
 * landingReturn.ts — send a web OAuth connect started from the landing page back to the landing page.
 *
 * The landing page (nomila.co) runs the sign-up flow and its socials step calls POST /api/v1/me/connect/:platform
 * with clientPlatform "web". The callback used to send every web connect to WEB_APP_URL (the app), so an athlete who
 * connected Instagram from nomila.co ended up in the app instead of back in her sign-up flow.
 *
 * The client now also sends `returnOrigin: location.origin`. Only an origin on the allowlist below is accepted; it is
 * then signed into the OAuth state (as clientPlatform "landing:<origin>") and checked again in the callback. Never an
 * open redirect: an origin not on the list is dropped (the connect behaves exactly as before), and the state is
 * HMAC-signed, so it cannot be edited in transit.
 */

/** Production landing origins. Exact match only (scheme + host, no port, no path). */
const LANDING_ORIGINS = new Set(["https://nomila.co", "https://www.nomila.co"]);

/** Local landing development (any port), accepted only outside production. */
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export const LANDING_CLIENT_PREFIX = "landing:";

/** The origin if it is an allowed landing origin, else null. */
export function allowedLandingOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  if (LANDING_ORIGINS.has(value)) return value;
  if (process.env.NODE_ENV !== "production" && LOCAL_ORIGIN.test(value)) return value;
  return null;
}

/**
 * The clientPlatform to sign into the OAuth state. A web connect with an allowed returnOrigin becomes
 * "landing:<origin>"; everything else is returned unchanged.
 */
export function withLandingReturn(clientPlatform: string | undefined, returnOrigin: unknown): string | undefined {
  if (clientPlatform !== "web") return clientPlatform;
  const origin = allowedLandingOrigin(returnOrigin);
  return origin ? `${LANDING_CLIENT_PREFIX}${origin}` : clientPlatform;
}

/** The landing origin carried by a verified state's clientPlatform, re-checked against the allowlist; else null. */
export function landingOriginOf(clientPlatform: string | undefined): string | null {
  if (!clientPlatform || !clientPlatform.startsWith(LANDING_CLIENT_PREFIX)) return null;
  return allowedLandingOrigin(clientPlatform.slice(LANDING_CLIENT_PREFIX.length));
}
