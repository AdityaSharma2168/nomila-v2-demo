/**
 * revokeGrants.ts — sever each provider grant BEFORE account deletion removes the tokens, and say what happened.
 *
 * Unlike oauthRevoke.revokeProviderToken (fire-and-forget, used on disconnect), this returns an outcome per
 * connection so the deletion receipt can show it. Never throws; a failed revoke never blocks deletion (deleting
 * the token is what finally severs our access).
 *
 *   gmail / youtube → Google's revoke endpoint (the refresh token revokes the whole grant)
 *   outlook         → delete the Graph change-notification subscription. Microsoft offers no per-app revoke an app
 *                     can call for a personal account, so the grant itself ends with the deleted token.
 *   instagram       → unsubscribe the app's webhooks (DELETE /me/subscribed_apps). Instagram Login has no app-side
 *                     token revoke.
 *   tiktok          → TikTok's revoke endpoint (POST /v2/oauth/revoke/ with client_key, client_secret and the access
 *                     token), which ends the user's authorization of the app.
 *
 * Tokens may be stored sealed (tokenCrypto, TOKEN_KMS): they are opened here before being sent anywhere. A token
 * that cannot be opened is reported as `failed` (the grant then ends with the deleted token, as for any failure).
 */

import { createLogger } from "../../logger";
import { openTokenFields } from "../tokenCrypto";

const logger = createLogger("privacy/revokeGrants");

export interface GrantToRevoke {
  id:            string;
  platform:      string;
  access_token:  string | null;
  refresh_token: string | null;
}

export type RevokeOutcome =
  | "revoked" | "subscription_deleted" | "webhooks_unsubscribed" | "no_token" | "not_supported" | "failed";

export interface RevokeResult { connection_id: string; platform: string; outcome: RevokeOutcome; detail?: string }

const IG_GRAPH = "https://graph.instagram.com/v22.0"; // same version as server/lib/integrations/instagram.ts
const TIKTOK_REVOKE = "https://open.tiktokapis.com/v2/oauth/revoke/";

async function fetchWithTimeout(url: string, init: RequestInit, ms = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

export async function revokeGrantForDeletion(stored: GrantToRevoke): Promise<RevokeResult> {
  const base = { connection_id: stored.id, platform: stored.platform };
  try {
    const g = { ...stored, ...(await openTokenFields({ access_token: stored.access_token, refresh_token: stored.refresh_token })) };
    if (g.platform === "gmail" || g.platform === "youtube") {
      const token = g.refresh_token ?? g.access_token;
      if (!token) return { ...base, outcome: "no_token" };
      const res = await fetchWithTimeout("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
      // 400 invalid_token = already revoked or expired: the grant is gone either way.
      if (res.ok || res.status === 400) return { ...base, outcome: "revoked", ...(res.ok ? {} : { detail: "token already invalid" }) };
      return { ...base, outcome: "failed", detail: `google revoke ${res.status}` };
    }
    if (g.platform === "outlook") {
      const { deleteSubscriptionFor } = await import("../integrations/outlookPush.js");
      const had = await deleteSubscriptionFor(g.id);
      return { ...base, outcome: had ? "subscription_deleted" : "not_supported", detail: "Microsoft has no per-app revoke; the token is deleted" };
    }
    if (g.platform === "instagram") {
      if (!g.access_token) return { ...base, outcome: "no_token" };
      const url = new URL(`${IG_GRAPH}/me/subscribed_apps`);
      url.searchParams.set("access_token", g.access_token);
      const res = await fetchWithTimeout(url.toString(), { method: "DELETE" });
      if (res.ok) return { ...base, outcome: "webhooks_unsubscribed", detail: "Instagram Login has no app-side token revoke; the token is deleted" };
      return { ...base, outcome: "failed", detail: `instagram unsubscribe ${res.status}` };
    }
    if (g.platform === "tiktok") {
      if (!g.access_token) return { ...base, outcome: "no_token" };
      const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
      const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim();
      if (!clientKey || !clientSecret) return { ...base, outcome: "failed", detail: "TikTok client credentials not configured; the token is deleted" };
      const res = await fetchWithTimeout(TIKTOK_REVOKE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, token: g.access_token }).toString(),
      });
      // TikTok answers 200 with an empty body on success; a failure carries an error, either as a string
      // ({ error, error_description }) or as the v2 envelope ({ error: { code, message } }, code "ok" = success).
      const text = res.ok ? await res.text().catch(() => "") : "";
      let error: string | undefined;
      try {
        const e = text ? JSON.parse(text)?.error : undefined;
        error = typeof e === "string" ? (e || undefined) : e && typeof e === "object" && e.code && e.code !== "ok" ? String(e.code) : undefined;
      } catch { /* non-JSON = no error field */ }
      if (res.ok && !error) return { ...base, outcome: "revoked" };
      return { ...base, outcome: "failed", detail: `tiktok revoke ${res.status}${error ? ` ${String(error).slice(0, 60)}` : ""}` };
    }
    return { ...base, outcome: "not_supported" };
  } catch (err: any) {
    logger.warn({ connectionId: stored.id, platform: stored.platform, error: err?.message }, "Grant revoke failed (best-effort)");
    return { ...base, outcome: "failed", detail: String(err?.message ?? err).slice(0, 120) };
  }
}
