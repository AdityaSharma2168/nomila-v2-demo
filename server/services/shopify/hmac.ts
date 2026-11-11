/**
 * shopify/hmac.ts — every signature the Shopify app checks or makes. Constant-time compares throughout.
 *
 *   verifyQueryHmac   Shopify's signature on an app launch / OAuth callback query: hex HMAC-SHA256 over the other
 *                     params, sorted, joined as key=value&…
 *   verifyWebhookHmac X-Shopify-Hmac-Sha256: base64 HMAC-SHA256 over the RAW request body
 *   signToken / verifyToken   our own short-lived tokens (the OAuth `state`, the brand page session): base64url(JSON)
 *                     "." base64url(HMAC), with an expiry inside the signed part
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const safeEqual = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/** Shopify launch / callback query signature. Array-valued params are refused (never sent by Shopify here). */
export function verifyQueryHmac(query: Record<string, unknown>, secret: string): boolean {
  const given = query.hmac;
  if (typeof given !== "string" || !/^[0-9a-f]{64}$/i.test(given)) return false;
  const pairs: string[] = [];
  for (const key of Object.keys(query).sort()) {
    if (key === "hmac" || key === "signature") continue;
    const v = query[key];
    if (typeof v !== "string") return false;
    pairs.push(`${key}=${v}`);
  }
  const want = createHmac("sha256", secret).update(pairs.join("&")).digest();
  return safeEqual(want, Buffer.from(given, "hex"));
}

export function verifyWebhookHmac(raw: Buffer, header: unknown, secret: string): boolean {
  if (typeof header !== "string" || !header) return false;
  const want = createHmac("sha256", secret).update(raw).digest();
  let got: Buffer;
  try { got = Buffer.from(header, "base64"); } catch { return false; }
  return safeEqual(want, got);
}

/** A Shopify timestamp (seconds) within `maxSkewS` of now. */
export const freshTimestamp = (ts: unknown, nowMs: number = Date.now(), maxSkewS = 300): boolean => {
  const n = typeof ts === "string" ? Number(ts) : NaN;
  return Number.isFinite(n) && Math.abs(nowMs / 1000 - n) <= maxSkewS;
};

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signToken(payload: Record<string, unknown>, secret: string, ttlMs: number, nowMs: number = Date.now()): string {
  const body = b64u(JSON.stringify({ ...payload, exp: nowMs + ttlMs, n: randomBytes(8).toString("hex") }));
  return `${body}.${b64u(createHmac("sha256", secret).update(`nomila-shopify|${body}`).digest())}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: unknown, secret: string, nowMs: number = Date.now()): T | null {
  if (typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", secret).update(`nomila-shopify|${body}`).digest();
  if (!safeEqual(want, Buffer.from(sig, "base64url"))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof p?.exp === "number" && p.exp > nowMs ? (p as T) : null;
  } catch { return null; }
}
