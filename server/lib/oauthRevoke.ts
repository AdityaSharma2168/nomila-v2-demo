/**
 * oauthRevoke.ts — best-effort revocation of a provider OAuth grant.
 *
 * Called on disconnect + account deletion so a live refresh/access token isn't left
 * valid provider-side after the user severs the connection (defense against the
 * "disconnect only flips a status column, token stays live" gap).
 */

import { createLogger } from "../logger";
import { openToken } from "./tokenCrypto";

const logger = createLogger("oauth-revoke");

export async function revokeProviderToken(
  platform: string,
  /** The stored column value — legacy plain text or a TOKEN_KMS envelope (opened here, only when a revoke call needs it). */
  token: string | null | undefined,
): Promise<void> {
  if (!token) return;
  try {
    if (platform === "gmail" || platform === "youtube") {
      // Google's OAuth 2.0 token revocation endpoint accepts either the access or
      // refresh token; revoking the refresh token invalidates the whole grant.
      const ctrl = new AbortController();
      const plain = await openToken(token);
      const timer = setTimeout(() => ctrl.abort(), 5000);
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: plain }).toString(),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
    }
    // Instagram/TikTok/Spotify/Outlook expose no equivalent server-side revoke that
    // works with our stored token; deleting the local token row severs our access.
  } catch (err: any) {
    logger.warn({ platform, err: err?.message }, "Provider token revoke failed (best-effort)");
  }
}
