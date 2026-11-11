/**
 * oauthState.ts — signed, expiring OAuth `state` parameter (CSRF protection).
 *
 * The OAuth callback (GET /api/v1/auth/callback/:platform) previously trusted a
 * plaintext state of the form "athleteId:alias:clientPlatform". Anyone could mint
 * a state for an arbitrary athleteId, so a victim could be tricked into completing
 * a flow that binds the wrong account (classic OAuth CSRF / account-linking abuse).
 *
 * We now HMAC-sign the state with a server-only secret and stamp it with a nonce +
 * issue time. The callback rejects any state that isn't a valid, unexpired
 * signature produced by us. The signature verifies across all Cloud Run instances that share SESSION_SECRET.
 *
 * The signature alone is not enough (security review, 24 Oct 2026): a signed state is a bearer link, so a link started
 * by one person could be opened by another and attach the victim's account to the starter's athlete, and a captured
 * state could be replayed for 10 minutes. lib/oauthConnectState.ts therefore stores the state's NONCE server-side at
 * connect start (with the athlete, platform, expiry and, for a browser connect, a hash of an HttpOnly cookie) and the
 * callback consumes it once, only with that cookie.
 *
 * Wire format:  <base64url(payload JSON)>.<base64url(HMAC-SHA256)>
 */

import crypto from "crypto";
import { createLogger } from "../logger";

const logger = createLogger("oauth-state");

// 10 minutes: long enough for a human to pick an account + grant consent, short
// enough to bound replay of a captured state.
const MAX_AGE_MS = 10 * 60 * 1000;

export interface OAuthStatePayload {
  athleteId: string;
  alias?: string;
  clientPlatform?: string;
  /** The per-connect nonce (lib/oauthConnectState.ts stores its hash at connect start and consumes it once). */
  nonce?: string;
}

function secret(): string {
  // Resolve a stable, server-only HMAC key. In Cloud Run the cron secret is
  // injected as env CRON_SECRET (SESSION_SECRET is not wired in), so fall back to
  // it — mirrors how server/index.ts resolves the internal secret. All instances
  // share the same value, so signatures verify across the fleet.
  const s =
    process.env.SESSION_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim() ||
    process.env.INTERNAL_CRON_SECRET?.trim();
  if (!s) {
    // In production one of these is always provided from Secret Manager; failing
    // loudly is safer than silently signing with a guessable key.
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET / CRON_SECRET required to sign OAuth state");
    }
    logger.warn("No signing secret set — using a dev-only fallback signing key");
    return "dev-oauth-state-fallback-key";
  }
  return s;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payloadB64: string): string {
  return crypto.createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

/** Build a signed state string for an outbound OAuth auth URL. */
export function signOAuthState(
  athleteId: string,
  alias?: string,
  clientPlatform?: string,
): string {
  const payload = {
    a: athleteId,
    l: alias || undefined,
    c: clientPlatform || undefined,
    n: crypto.randomBytes(9).toString("base64url"), // per-request nonce
    t: Date.now(),
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify a state string from an OAuth callback. Returns the decoded payload, or
 * null if the signature is invalid, the format is wrong, or it has expired.
 */
export function verifyOAuthState(state: string | undefined): OAuthStatePayload | null {
  if (!state || typeof state !== "string") return null;
  const dot = state.indexOf(".");
  if (dot <= 0) return null;

  const payloadB64 = state.slice(0, dot);
  const providedSig = state.slice(dot + 1);
  const expectedSig = sign(payloadB64);

  // Constant-time compare; timingSafeEqual throws on length mismatch.
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!payload || typeof payload.a !== "string" || typeof payload.t !== "number") return null;
  if (Date.now() - payload.t > MAX_AGE_MS) return null;

  return {
    athleteId: payload.a,
    alias: typeof payload.l === "string" ? payload.l : undefined,
    clientPlatform: typeof payload.c === "string" ? payload.c : undefined,
    nonce: typeof payload.n === "string" ? payload.n : undefined,
  };
}
