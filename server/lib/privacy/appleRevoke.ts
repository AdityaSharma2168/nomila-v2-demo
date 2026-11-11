/**
 * appleRevoke.ts — Sign in with Apple token revocation at account deletion (App Store "Offering account deletion in your
 * app": apps that support Sign in with Apple should revoke the user's tokens with the Sign in with Apple REST API).
 *
 * Nomila never stores an Apple token: Apple sign-in goes straight into Firebase. So at delete time the app asks Apple
 * to confirm it's them (expo-apple-authentication) and sends the fresh, single-use authorization code with the delete
 * request. Here it is exchanged for a refresh token (POST /auth/token) and that token is revoked (POST /auth/revoke),
 * which ends the app's grant ("Stop using Apple ID" in their Apple account).
 *
 * The client secret is an ES256 JWT signed with the app's Sign in with Apple key (a .p8 from the Apple Developer
 * account), made fresh for each call and valid for five minutes. Config, all server-only:
 *
 *   APPLE_TEAM_ID              the Apple Developer team id (10 characters)
 *   APPLE_SIGN_IN_KEY_ID       the key id of the Sign in with Apple key
 *   APPLE_SIGN_IN_PRIVATE_KEY  the key itself (PEM; "\n" escapes are accepted)
 *   APPLE_CLIENT_ID            optional: the app's bundle id, default co.nomila.app (the code was issued to it)
 *
 * Missing config is reported as `not_configured`, never thrown. Never throws; never logs a code or a token.
 */

import jwt from "jsonwebtoken";
import { createLogger } from "../../logger";

const logger = createLogger("privacy/appleRevoke");

export const APPLE_ID_HOST = "https://appleid.apple.com";
export const APPLE_DEFAULT_CLIENT_ID = "co.nomila.app";

export interface AppleRevokeConfig { teamId: string; keyId: string; privateKey: string; clientId: string }

export type AppleRevokeOutcome = "revoked" | "not_configured" | "failed";
export interface AppleRevokeResult { outcome: AppleRevokeOutcome; detail?: string }

/** The env names this needs and does not have (names only, never values). Empty = configured. */
export function appleRevokeMissingConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["APPLE_TEAM_ID", "APPLE_SIGN_IN_KEY_ID", "APPLE_SIGN_IN_PRIVATE_KEY"].filter((k) => !env[k]?.trim());
}

export function appleRevokeConfig(env: NodeJS.ProcessEnv = process.env): AppleRevokeConfig | null {
  if (appleRevokeMissingConfig(env).length) return null;
  return {
    teamId:     env.APPLE_TEAM_ID!.trim(),
    keyId:      env.APPLE_SIGN_IN_KEY_ID!.trim(),
    privateKey: env.APPLE_SIGN_IN_PRIVATE_KEY!.replace(/\\n/g, "\n").trim(),
    clientId:   env.APPLE_CLIENT_ID?.trim() || APPLE_DEFAULT_CLIENT_ID,
  };
}

/** The client secret Apple's REST API wants: an ES256 JWT, iss = team, sub = client id, aud = appleid.apple.com. */
export function appleClientSecret(cfg: AppleRevokeConfig, nowSec = Math.floor(Date.now() / 1000)): string {
  return jwt.sign(
    { iss: cfg.teamId, iat: nowSec, exp: nowSec + 300, aud: APPLE_ID_HOST, sub: cfg.clientId },
    cfg.privateKey,
    { algorithm: "ES256", keyid: cfg.keyId },
  );
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function post(fetcher: FetchLike, path: string, form: Record<string, string>, ms = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetcher(`${APPLE_ID_HOST}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
}

/**
 * Exchange the fresh authorization code and revoke the grant. `revoked` only when Apple answered 200 to the revoke.
 */
export async function revokeAppleSignIn(
  authorizationCode: string,
  opts: { config?: AppleRevokeConfig | null; fetch?: FetchLike; now?: number } = {},
): Promise<AppleRevokeResult> {
  const cfg = opts.config === undefined ? appleRevokeConfig() : opts.config;
  if (!cfg) return { outcome: "not_configured", detail: `missing ${appleRevokeMissingConfig().join(", ") || "Apple config"}` };
  const fetcher: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  try {
    const secret = appleClientSecret(cfg, opts.now);
    const tokenRes = await post(fetcher, "/auth/token", {
      client_id: cfg.clientId, client_secret: secret, code: authorizationCode, grant_type: "authorization_code",
    });
    if (!tokenRes.ok) {
      const err = String(((await tokenRes.json().catch(() => ({}))) as any)?.error ?? "").slice(0, 40);
      return { outcome: "failed", detail: `apple token ${tokenRes.status}${err ? ` ${err}` : ""}` };
    }
    const tokens = (await tokenRes.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string };
    const token = tokens.refresh_token ?? tokens.access_token;
    if (!token) return { outcome: "failed", detail: "apple token response had no token" };
    const revokeRes = await post(fetcher, "/auth/revoke", {
      client_id: cfg.clientId, client_secret: secret, token,
      token_type_hint: tokens.refresh_token ? "refresh_token" : "access_token",
    });
    if (revokeRes.ok) return { outcome: "revoked" };
    return { outcome: "failed", detail: `apple revoke ${revokeRes.status}` };
  } catch (err: any) {
    logger.warn({ error: String(err?.message ?? err).slice(0, 120) }, "Apple revoke failed (best-effort)");
    return { outcome: "failed", detail: String(err?.message ?? err).slice(0, 120) };
  }
}
