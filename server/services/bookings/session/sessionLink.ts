/**
 * sessionLink.ts — the buyer's session link (/s/:token) and the in-person check-in link (/ok/:token).
 *
 * The buyer has no account. The booking's own buyer token (bookings.buyer_token_hash) is stored as a hash only, so a
 * job that runs later (the "join opens in 10 minutes" email, the "How did it go?" email) cannot put it in a link.
 * These links are therefore STATELESS and SIGNED: `<payload>.<sig>`, where the payload names the purpose, the booking
 * and an expiry, and the signature is an HMAC-SHA256 under the server's signing secret, domain-separated by a label so
 * a session link can never verify as a check-in link (or as anything else that secret signs).
 *
 *   purpose  "session"  — the buyer's call page and the after-session buttons ("It happened", "Report a problem").
 *                         Valid until the release window has long passed (end + release hours + 14 days); JOINING is
 *                         separately bounded by the join window, which the token mint checks on every call.
 *            "guest"    — a private-group friend's own call page (0153): the id in the link is the booking_guests row,
 *                         not the booking; revoking the guest ends it. Same lifetime as "session".
 *            "checkin"  — the read-only page her trusted friend opens for an in-person session ("checked in" or "not
 *                         yet"). Valid until a day after the end.
 *
 * A link binds ONE booking. Whatever a route does with it, the booking it acts on is the one in the verified payload,
 * never one named anywhere else in the request: a link for booking A can never reach booking B.
 *
 * No migration: nothing about a link is stored. Rotating the secret retires every outstanding link (the buyer can
 * still reach the booking page from their booking email, which the booking flow owns).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type SessionLinkPurpose = "session" | "checkin" | "guest";

const LABEL = "nomila-booking-link:v1";
const MAX_TOKEN_LENGTH = 256;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SessionLinkConfigError extends Error {
  constructor() { super("SESSION_LINK_SECRET_MISSING"); }
}

/**
 * The signing secret: the same resolution order as the OAuth state signer (server/lib/oauthState.ts), because Cloud
 * Run injects the cron secret and not SESSION_SECRET. No dev fallback: with no secret there are no links (fail closed,
 * the routes answer 503), rather than links signed with a guessable key.
 */
function secret(): string {
  const s = process.env.SESSION_SECRET?.trim() || process.env.CRON_SECRET?.trim() || process.env.INTERNAL_CRON_SECRET?.trim();
  if (!s) throw new SessionLinkConfigError();
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(`${LABEL}|${payload}`).digest("base64url");
}

/** Mint a link token for one booking (a booking_guests row for "guest") and one purpose, valid until `expiresAt`. */
export function mintSessionLink(bookingId: string, purpose: SessionLinkPurpose, expiresAt: Date): string {
  if (!UUID_RE.test(bookingId)) throw new Error("mintSessionLink: booking id must be a uuid");
  const payload = Buffer.from(`${purpose}:${bookingId.toLowerCase()}:${Math.floor(expiresAt.getTime() / 1000)}`).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * The booking id a presented token names, or null for anything else: a bad shape, a bad signature, the wrong purpose,
 * or an expired link. Constant-time on the signature. Throws SessionLinkConfigError only when no secret is configured.
 */
export function verifySessionLink(token: unknown, purpose: SessionLinkPurpose, now: Date = new Date()): string | null {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(payload), "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

  const parts = Buffer.from(payload, "base64url").toString("utf8").split(":");
  if (parts.length !== 3) return null;
  const [p, bookingId, exp] = parts;
  if (p !== purpose || !UUID_RE.test(bookingId)) return null;
  const expSec = Number(exp);
  if (!Number.isInteger(expSec) || expSec * 1000 <= now.getTime()) return null;
  return bookingId;
}
