/**
 * emailCodeSignIn — sign in with a 6-digit email code (design "Sign in with email", 12 Oct 2026): the two server calls
 * (server/routes/authEmailCode.ts) turned into outcomes the front draws, and the small pure rules around them. No
 * React. The custom token never leaves auth-context, which signs in with it exactly as Microsoft sign-in does.
 */
import { getApiUrl } from "./query-client";

/** Code length, as the server makes them. */
export const CODE_LENGTH = 6;

export type StartOutcome =
  | { kind: "sent"; resendAfterSec: number }
  /** A code went to this address less than a minute ago; it still works, so the code screen opens on the countdown. */
  | { kind: "too_soon"; retryAfterSec: number }
  | { kind: "too_many"; retryAfterSec: number }
  | { kind: "invalid" }
  /** The service-wide cap on codes sent is reached (503 busy): a plain "lots of sign-ins" line, not "check your connection". */
  | { kind: "busy" }
  /** Not sent: delivery off, the send failed, no network, or anything unexpected. Never reported as sent. */
  | { kind: "failed" };

export type VerifyOutcome =
  | { kind: "ok"; customToken: string }
  | { kind: "wrong"; triesLeft: number }
  | { kind: "expired" }
  | { kind: "locked" }
  | { kind: "failed" };

/** The address as the server compares it. */
export const normEmail = (e: string): string => e.trim().toLowerCase();

/** The server's own plausibility rule (lib/emailCode.ts validEmail): one @, a dotted domain, no spaces, ≤ 254. */
export function looksLikeEmail(e: string): boolean {
  const v = e.trim();
  return v.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v);
}

/** What a code field may hold: digits only, at most six (a pasted "482 913" or "Code: 482913" keeps its digits). */
export const codeDigits = (s: string): string => s.replace(/\D/g, "").slice(0, CODE_LENGTH);

/** "0:42" for a countdown in seconds. */
export function countdown(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Whole minutes to wait, rounded up, at least 1. */
export const minutesToWait = (sec: number): number => Math.max(1, Math.ceil(sec / 60));

const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);

async function post(path: string, body: unknown, fetchImpl: typeof fetch): Promise<{ status: number; json: Record<string, unknown> } | null> {
  try {
    const res = await fetchImpl(new URL(`/api/v1/auth/email-code/${path}`, getApiUrl()).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return null;
  }
}

export async function startEmailCode(email: string, fetchImpl: typeof fetch = fetch): Promise<StartOutcome> {
  const r = await post("start", { email: normEmail(email) }, fetchImpl);
  if (!r) return { kind: "failed" };
  if (r.status === 202) return { kind: "sent", resendAfterSec: num(r.json.resendAfterSec, 60) };
  if (r.status === 400 && r.json.error === "invalid_email") return { kind: "invalid" };
  if (r.status === 429 && r.json.error === "too_soon") return { kind: "too_soon", retryAfterSec: num(r.json.retryAfterSec, 60) };
  if (r.status === 429) return { kind: "too_many", retryAfterSec: num(r.json.retryAfterSec, 15 * 60) };
  if (r.status === 503 && r.json.error === "busy") return { kind: "busy" };
  return { kind: "failed" };
}

export async function verifyEmailCode(email: string, code: string, fetchImpl: typeof fetch = fetch): Promise<VerifyOutcome> {
  const r = await post("verify", { email: normEmail(email), code }, fetchImpl);
  if (!r) return { kind: "failed" };
  if (r.status === 200 && typeof r.json.customToken === "string") return { kind: "ok", customToken: r.json.customToken };
  if (r.status === 400 && r.json.error === "wrong_code") return { kind: "wrong", triesLeft: num(r.json.triesLeft, 1) };
  if (r.status === 410) return { kind: "expired" };
  if (r.status === 423) return { kind: "locked" };
  return { kind: "failed" };
}
