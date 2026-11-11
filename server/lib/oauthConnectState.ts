/**
 * oauthConnectState.ts — the OAuth connect state, held server-side: single-use, and bound to the browser that started it.
 *
 * WHY (security review, 24 Oct 2026): the signed state (lib/oauthState.ts) was the whole check, so the provider link
 * a connect produces was a bearer link. Anyone who opened it (a victim sent the link by the starter) would attach THEIR
 * Instagram / Gmail to the STARTER's athlete, and a captured state could be replayed until it expired.
 *
 *   connect start  POST /api/v1/me/connect/:platform (authenticated) → recordConnectState: one oauth_connect_states row
 *                  (sha256 of the state's nonce, the athlete, the platform, a 10-minute expiry). A BROWSER connect
 *                  (clientPlatform "web" or "landing:<origin>") also gets a random binding value: its sha256 goes in the
 *                  row and the value itself in an HttpOnly, Secure, SameSite=Lax cookie on the connect response, scoped
 *                  to the API host (no Domain) and to the callback path. The clients send that request with
 *                  credentials: "include" (CORS allows credentials for the allowed origins only).
 *   callback       GET /api/v1/auth/callback/:platform → consumeConnectState: one atomic UPDATE marks the row used only
 *                  if it is unused, unexpired, for this athlete and platform and, when it has a binding, only when this
 *                  request carries the matching cookie (SameSite=Lax cookies ride the provider's top-level redirect).
 *                  Replayed, unknown, expired, wrong-athlete and missing / mismatched-cookie callbacks are refused.
 *
 * NATIVE connects (no clientPlatform: the app opens the link in the system auth session) get the single-use row but no
 * cookie: the app's own fetch and the system browser do not share a cookie jar. See the PR for the follow-up.
 * OAUTH_BROWSER_BINDING=off is an emergency switch that stops REQUIRING the cookie (the row stays single-use).
 */
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { and, eq, isNull, gt, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { oauthConnectStates } from "../../shared/schema";
import { createLogger } from "../logger";

const logger = createLogger("oauth-connect-state");

/** The state's life (matches oauthState.ts MAX_AGE_MS). */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;
const COOKIE_PATH = "/api/v1/auth/callback";

const sha256 = (s: string): string => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** A connect that returns to a browser (the web app or the landing page): the only kind the cookie can bind. */
export const isBrowserConnect = (clientPlatform: string | undefined): boolean =>
  clientPlatform === "web" || (typeof clientPlatform === "string" && clientPlatform.startsWith("landing:"));

export const browserBindingRequired = (): boolean => process.env.OAUTH_BROWSER_BINDING !== "off";

/** One cookie per platform, so connecting Instagram never clobbers a Gmail connect in flight. */
export const bindingCookieName = (platform: string): string => `nomila_oauth_${platform.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

function cookieHeader(platform: string, value: string, maxAgeSec: number): string {
  return `${bindingCookieName(platform)}=${value}; Max-Age=${maxAgeSec}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`;
}

/** The named cookie from the request's Cookie header (no cookie-parser in this app), or null. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/**
 * At connect start: store the state's nonce (hashed) with the athlete, platform and expiry; for a browser connect set
 * the binding cookie on `res`. Also prunes rows a day past expiry (cheap: indexed, at most a handful per connect).
 */
export async function recordConnectState(res: Response, i: { nonce: string; athleteId: string; platform: string; clientPlatform?: string; now?: Date }): Promise<void> {
  const now = i.now ?? new Date();
  const binding = isBrowserConnect(i.clientPlatform) ? crypto.randomBytes(32).toString("base64url") : null;
  await db.insert(oauthConnectStates).values({
    nonce_hash: sha256(i.nonce), athlete_id: i.athleteId, platform: i.platform,
    binding_hash: binding ? sha256(binding) : null, expires_at: new Date(now.getTime() + CONNECT_STATE_TTL_MS),
  });
  if (binding) res.append("Set-Cookie", cookieHeader(i.platform, binding, CONNECT_STATE_TTL_MS / 1000));
  await db.delete(oauthConnectStates).where(lt(oauthConnectStates.expires_at, new Date(now.getTime() - 86_400_000)))
    .catch((err: any) => logger.warn({ error: String(err?.message ?? err).slice(0, 200) }, "connect state prune failed"));
}

export type ConsumeOutcome = "ok" | "unknown_or_used" | "binding_mismatch";

/**
 * At the callback: accept this state once. "ok" marks the row used. A row that exists but needs a cookie this request
 * does not carry (or carries wrong) is "binding_mismatch" and stays unused (only the starting browser can finish it).
 */
export async function consumeConnectState(req: Request, i: { nonce: string | undefined; athleteId: string; platform: string; now?: Date }): Promise<ConsumeOutcome> {
  if (!i.nonce) return "unknown_or_used";
  const now = i.now ?? new Date();
  const cookie = readCookie(req, bindingCookieName(i.platform));
  const bindingOk = browserBindingRequired()
    ? (cookie ? sql`(${oauthConnectStates.binding_hash} IS NULL OR ${oauthConnectStates.binding_hash} = ${sha256(cookie)})` : isNull(oauthConnectStates.binding_hash))
    : sql`true`;
  const live = and(eq(oauthConnectStates.nonce_hash, sha256(i.nonce)), eq(oauthConnectStates.athlete_id, i.athleteId),
    eq(oauthConnectStates.platform, i.platform), isNull(oauthConnectStates.used_at), gt(oauthConnectStates.expires_at, now));
  const used = await db.update(oauthConnectStates).set({ used_at: now }).where(and(live, bindingOk)).returning({ id: oauthConnectStates.id });
  if (used.length) return "ok";
  const [pending] = await db.select({ id: oauthConnectStates.id }).from(oauthConnectStates).where(live).limit(1);
  return pending ? "binding_mismatch" : "unknown_or_used";
}

/** Clear the binding cookie once the callback has used (or refused) it. */
export function clearBindingCookie(res: Response, platform: string): void {
  res.append("Set-Cookie", cookieHeader(platform, "", 0));
}
