/**
 * igTokenRefresh.ts — Refresh the long-lived Instagram Page Access Token.
 *
 * Long-lived tokens expire after 60 days. We refresh every 50 days (10-day buffer).
 * The new token is written back to Secret Manager. The currently running instance
 * keeps using the old token (still valid for 10 days); next deploy picks up the new one.
 *
 * Invoked via POST /api/internal/ig-token-refresh (Cloud Scheduler) or node-cron.
 * Requires in env:
 *   IG_PAGE_ACCESS_TOKEN   — current token
 *   INSTAGRAM_APP_ID       — Facebook app client_id
 *   INSTAGRAM_APP_SECRET   — Facebook app client_secret
 *   GOOGLE_CLOUD_PROJECT   — GCP project ID (auto-set in Cloud Run)
 *
 * ─── EVERY FAILURE HAS A NAME (PR 7, Lane G2) ─────────────────────────────────────────────────────
 *
 * Until 23 Sep 2026 every failure here was the same `500 {"error":"Internal server error"}`, which
 * Cloud Scheduler shows as code 13 and nobody can act on. Now a failure is an IgTokenRefreshError with
 * a `kind` the route answers with its own status:
 *
 *   token_expired        FB error 190 (the token is dead; a human must mint a new one)       → 424
 *   secret_write_failed  Secret Manager refused the new version (IAM: the runtime SA cannot
 *                        add versions)                                                      → 502
 *   misconfigured        env missing, or the token belongs to ANOTHER app than the one the
 *                        exchange is signed with (dev's Meta TEST app vs the shared token —
 *                        the ledger's Finding 3), or FB says the app credentials are wrong  → 500
 *   transient            FB or Secret Manager 5xx, a timeout, a network error              → 503
 *
 * And BEFORE the exchange, one diagnostic call — FB `debug_token` — logs the token's STATE for the
 * run: is it valid, when it expires, which app it belongs to, its type. Never the token itself. A
 * failure to debug is a warning, not a refusal: the exchange still runs.
 *
 * ⚠️ MUTATION (igTokenRefresh.test): classify FB 190 as transient — "expired token reported as
 * transient" reds by name (the kind AND the status).
 */

import { GoogleAuth } from "google-auth-library";
import { createLogger } from "../logger";

const logger = createLogger("ig-token-refresh");

const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "gamechanger-pocket-agent";
const GRAPH_VERSION = "v21.0";
const SECRET_NAME = "IG_PAGE_ACCESS_TOKEN";

export type IgTokenRefreshKind = "token_expired" | "secret_write_failed" | "misconfigured" | "transient";

export class IgTokenRefreshError extends Error {
  constructor(
    readonly kind: IgTokenRefreshKind,
    message: string,
    /** Structured, token-free facts for the log line and the wire. */
    readonly detail: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.name = "IgTokenRefreshError";
  }
}

/** What the route answers for a refresh failure — the kind on the wire, never the message's innards. */
export function statusForRefreshError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof IgTokenRefreshError) {
    const status =
      err.kind === "token_expired" ? 424
      : err.kind === "secret_write_failed" ? 502
      : err.kind === "transient" ? 503
      : 500;
    return { status, body: { error: err.kind, ...err.detail } };
  }
  return { status: 500, body: { error: "Internal server error" } };
}

/** The token's state as FB reports it — every field token-free, so the whole object may be logged. */
export interface TokenState {
  isValid: boolean | null;
  expiresAt: string | null;
  dataAccessExpiresAt: string | null;
  tokenAppId: string | null;
  type: string | null;
  scopes: number | null;
}

const fbTimestamp = (v: unknown): string | null =>
  typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : null;

/**
 * FB `debug_token`: the token's own state, signed with the app token (`<id>|<secret>`). Diagnostic
 * only — null when FB will not say — and never a reason not to try the exchange.
 */
async function debugToken(currentToken: string, appId: string, appSecret: string): Promise<TokenState | null> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token`);
  url.searchParams.set("input_token", currentToken);
  url.searchParams.set("access_token", `${appId}|${appSecret}`);
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  const data = (await resp.json().catch(() => null)) as any;
  const d = data?.data;
  if (!resp.ok || !d || typeof d !== "object") return null;
  return {
    isValid: typeof d.is_valid === "boolean" ? d.is_valid : null,
    expiresAt: fbTimestamp(d.expires_at),
    dataAccessExpiresAt: fbTimestamp(d.data_access_expires_at),
    tokenAppId: d.app_id != null ? String(d.app_id) : null,
    type: typeof d.type === "string" ? d.type : null,
    scopes: Array.isArray(d.scopes) ? d.scopes.length : null,
  };
}

/** An FB error body, read into a kind. 190 is the dead token; the OAuth family otherwise is the app. */
export function classifyFbError(status: number, data: any): IgTokenRefreshError {
  const code = Number(data?.error?.code ?? NaN);
  const type = typeof data?.error?.type === "string" ? data.error.type : null;
  const message = typeof data?.error?.message === "string" ? data.error.message.slice(0, 200) : `HTTP ${status}`;
  if (code === 190)
    return new IgTokenRefreshError("token_expired", `FB token exchange error 190: ${message}`, { fbCode: 190, fbType: type });
  if (type === "OAuthException" || code === 100 || code === 101)
    return new IgTokenRefreshError("misconfigured", `FB token exchange error ${code}: ${message}`, {
      fbCode: Number.isFinite(code) ? code : null,
      fbType: type,
    });
  if (status >= 500 || status === 429)
    return new IgTokenRefreshError("transient", `FB token exchange HTTP ${status}: ${message}`, { httpStatus: status });
  return new IgTokenRefreshError("misconfigured", `FB token exchange HTTP ${status}: ${message}`, { httpStatus: status });
}

// Calls the FB long-lived token exchange endpoint and returns the new token + expiry seconds
async function exchangeForNewToken(currentToken: string, appId: string, appSecret: string): Promise<{ token: string; expiresInSeconds: number }> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", currentToken);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  } catch (err: any) {
    throw new IgTokenRefreshError("transient", `FB token exchange unreachable: ${String(err?.message ?? err).slice(0, 120)}`, { network: true });
  }
  const data = (await resp.json().catch(() => null)) as any;
  if (!resp.ok || data?.error) throw classifyFbError(resp.status, data);
  if (typeof data?.access_token !== "string" || !data.access_token)
    throw new IgTokenRefreshError("transient", "FB token exchange answered without a token", { httpStatus: resp.status });
  return {
    token:            data.access_token as string,
    expiresInSeconds: (data.expires_in ?? 5184000) as number, // default 60 days
  };
}

// Writes a new secret version to Secret Manager using the runtime service account
async function writeSecretVersion(secretId: string, value: string): Promise<void> {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  if (!accessToken.token) throw new IgTokenRefreshError("secret_write_failed", "Could not obtain GCP access token", { step: "auth" });

  const endpoint = `https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/${secretId}/versions`;
  const payload = Buffer.from(value).toString("base64");

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken.token}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ payload: { data: payload } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new IgTokenRefreshError("transient", `Secret Manager unreachable: ${String(err?.message ?? err).slice(0, 120)}`, { network: true, step: "secret" });
  }
  if (!resp.ok) {
    const body = await resp.text();
    const kind: IgTokenRefreshKind = resp.status >= 500 || resp.status === 429 ? "transient" : "secret_write_failed";
    throw new IgTokenRefreshError(kind, `Secret Manager write HTTP ${resp.status}: ${body.slice(0, 200)}`, { httpStatus: resp.status, step: "secret" });
  }
}

// Main export — called by the HTTP endpoint and the node-cron schedule
export async function refreshInstagramToken(): Promise<{ newExpiryDate: string; expiresInSeconds: number }> {
  const currentToken = process.env.IG_PAGE_ACCESS_TOKEN;
  const appId        = process.env.INSTAGRAM_APP_ID;
  const appSecret    = process.env.INSTAGRAM_APP_SECRET;

  if (!currentToken || !appId || !appSecret) {
    throw new IgTokenRefreshError("misconfigured", "Missing required env vars: IG_PAGE_ACCESS_TOKEN, INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET", {
      hasToken: !!currentToken, hasAppId: !!appId, hasAppSecret: !!appSecret,
    });
  }

  logger.info("Starting Instagram token refresh");

  // The token's state for this run — token-free, so the whole object is the log line.
  let state: TokenState | null = null;
  try {
    state = await debugToken(currentToken, appId, appSecret);
    if (state) logger.info({ ...state, ourAppId: appId, appMatches: state.tokenAppId === null ? null : state.tokenAppId === appId }, "Instagram token state");
    else logger.warn("Instagram token state unavailable — debug_token gave no data");
  } catch (err: any) {
    logger.warn({ error: String(err?.message ?? err).slice(0, 120) }, "Instagram token state unavailable");
  }

  let exchanged: { token: string; expiresInSeconds: number };
  try {
    exchanged = await exchangeForNewToken(currentToken, appId, appSecret);
  } catch (err) {
    // An OAuth refusal on a token that belongs to another app is the app mismatch, said plainly.
    if (err instanceof IgTokenRefreshError && err.kind !== "transient" && state?.tokenAppId && state.tokenAppId !== appId)
      throw new IgTokenRefreshError("misconfigured", `${err.message} — the token belongs to app ${state.tokenAppId}, the exchange is signed by ${appId}`, {
        ...err.detail, tokenAppId: state.tokenAppId, ourAppId: appId,
      });
    throw err;
  }
  const expiryDate = new Date(Date.now() + exchanged.expiresInSeconds * 1000).toISOString();

  await writeSecretVersion(SECRET_NAME, exchanged.token);

  logger.info({ expiryDate, expiresInSeconds: exchanged.expiresInSeconds }, "Instagram token refreshed and written to Secret Manager");

  return { newExpiryDate: expiryDate, expiresInSeconds: exchanged.expiresInSeconds };
}
