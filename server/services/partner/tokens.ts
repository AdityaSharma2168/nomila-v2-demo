/**
 * partner/tokens.ts — the visitor's credentials, none of which is ever stored in the clear.
 *
 *   draft token   random, returned once to the visitor's page while they build the request; its SHA-256 is stored.
 *   confirm / status / reply tokens   DERIVED: HMAC(server key, purpose | request id | token_nonce). Only their SHA-256
 *                 is stored (for lookup), and the server can re-derive the same link for a later content-free notice.
 *                 Rotating token_nonce revokes all three at once.
 *   email hash    HMAC of the lower-cased address ("Your requests" looks requests up by it; no plain index on emails).
 *   codes         6 digits, SHA-256 of (email hash | code) stored, 15 minutes, 5 attempts.
 *
 * The key is PARTNER_TOKEN_SECRET, else the server's existing signing secret (SESSION_SECRET / CRON_SECRET /
 * INTERNAL_CRON_SECRET, as oauthState.ts resolves it), domain-separated by the "partner-intake" prefix. In production a
 * missing key throws rather than signing with a guessable one.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

function key(): string {
  const s = process.env.PARTNER_TOKEN_SECRET?.trim()
    || process.env.SESSION_SECRET?.trim()
    || process.env.CRON_SECRET?.trim()
    || process.env.INTERNAL_CRON_SECRET?.trim();
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("PARTNER_TOKEN_SECRET (or SESSION_SECRET / CRON_SECRET) required for partner intake");
  return "dev-partner-intake-fallback-key";
}

export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (s: string): Buffer => createHmac("sha256", key()).update(`partner-intake|${s}`, "utf8").digest();

export type DerivedPurpose = "confirm" | "status" | "reply";

/** The token for a purpose, re-derivable from the row. Reply tokens are lower-case hex (mail local parts fold case). */
export function deriveToken(purpose: DerivedPurpose, requestId: string, nonce: string): string {
  const mac = hmac(`${purpose}|${requestId}|${nonce}`);
  return purpose === "reply" ? mac.subarray(0, 16).toString("hex") : mac.toString("base64url");
}

/** A fresh random token (draft) or nonce. */
export const randomToken = (bytes = 24): string => randomBytes(bytes).toString("base64url");

/** "ref XXXXXX": the short reference a visitor sees. Unambiguous alphabet (no 0/O, 1/I). */
export function publicRef(): string {
  const A = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) out += A[randomInt(A.length)];
  return out;
}

export const normEmail = (e: string): string => e.trim().toLowerCase();
export const emailHash = (email: string): string => hmac(`email|${normEmail(email)}`).toString("hex");

/** The visitor's daily-salted IP hash: lives only inside a counter bucket, never stored as an IP. */
export function visitorHash(ip: string | undefined, now: Date = new Date()): string {
  return hmac(`ip|${now.toISOString().slice(0, 10)}|${ip ?? "unknown"}`).toString("hex").slice(0, 32);
}

export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
export const codeHash = (emailH: string, code: string): string => sha256(`${emailH}|${code.trim()}`);

/** HMAC seal over a JSON value, so a fit preview computed by one call can be attached by a later one unaltered. */
export function seal(value: unknown): string {
  return hmac(`seal|${JSON.stringify(value)}`).toString("base64url");
}
export function sealValid(value: unknown, given: unknown): boolean {
  if (typeof given !== "string" || !given) return false;
  const want = Buffer.from(seal(value));
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** A signed, expiring value for the "checked by email code" cookie: `${emailHash}.${expiresMs}.${mac}`. */
export function signVisitorCheck(emailH: string, expiresMs: number): string {
  return `${emailH}.${expiresMs}.${hmac(`visitor|${emailH}|${expiresMs}`).toString("base64url")}`;
}
export function readVisitorCheck(raw: string | undefined, now: number = Date.now()): string | null {
  if (!raw) return null;
  const [h, exp, mac] = raw.split(".");
  if (!h || !exp || !mac || !/^[0-9a-f]{64}$/.test(h)) return null;
  const expiresMs = Number(exp);
  if (!Number.isFinite(expiresMs) || expiresMs < now) return null;
  const want = Buffer.from(hmac(`visitor|${h}|${expiresMs}`).toString("base64url"));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? h : null;
}
