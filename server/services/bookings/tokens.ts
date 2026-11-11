/**
 * bookings/tokens.ts — the buyer's credentials and keyed hashes. Nothing here is stored raw.
 *
 *   buyer token   the private link's secret: HMAC(BOOKING_HASH_SECRET, "bt1:" + booking id), so a later email can carry
 *                 the same link without the server ever storing it; only sha256(token) is stored (buyer_token_hash).
 *                 The link alone opens nothing: the buyer page also needs a fresh email code (an access key).
 *   access key    proof the buyer confirmed an email code recently: HMAC over (booking id, expiry), sent back as a header.
 *   contact hash  HMAC of the normalised email / phone (blocks, bans, returning buyers) — never the raw value.
 *   codes         6-digit email codes; only HMAC(code) is stored, with an expiry and an attempt count.
 */
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { BOOKINGS } from "./config";

export class BookingSecretMissing extends Error { code = "BOOKINGS_NOT_CONFIGURED"; }

function secret(): string {
  const s = BOOKINGS.hashSecret;
  if (!s) throw new BookingSecretMissing("BOOKING_HASH_SECRET is not set");
  return s;
}
const hmac = (data: string) => createHmac("sha256", secret()).update(data).digest("base64url");

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The buyer's private-link token for a booking (deterministic, so later emails reuse the same link). */
export function buyerTokenFor(bookingId: string): string {
  return hmac(`bt1:${bookingId}`);
}
export function buyerTokenHash(token: string): string {
  return sha256(token);
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
/** Digits only, with a leading + kept (E.164-ish). */
export function normalisePhone(phone: string): string {
  const t = phone.trim();
  return (t.startsWith("+") ? "+" : "") + t.replace(/\D/g, "");
}
export function emailHash(email: string): string { return hmac(`em1:${normaliseEmail(email)}`); }
export function phoneHash(phone: string): string { return hmac(`ph1:${normalisePhone(phone)}`); }
export function cardFingerprintHash(fp: string): string { return hmac(`cf1:${fp}`); }

/** A fresh 6-digit code and its stored hash (bound to the booking, so a code can't be replayed on another one). */
export function newCode(bookingId: string): { code: string; hash: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return { code, hash: hmac(`otp1:${bookingId}:${code}`) };
}
export function codeMatches(bookingId: string, code: unknown, hash: string | null): boolean {
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim()) || !hash) return false;
  return safeEqual(hmac(`otp1:${bookingId}:${code.trim()}`), hash);
}

/** An access key valid until `expiresAt` for this booking. */
export function accessKeyFor(bookingId: string, expiresAt: Date): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return `${exp}.${hmac(`ak1:${bookingId}:${exp}`)}`;
}
export function accessKeyValid(bookingId: string, key: unknown, now: Date = new Date()): boolean {
  if (typeof key !== "string") return false;
  const [expRaw, mac] = key.split(".");
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || !mac || exp * 1000 < now.getTime()) return false;
  return safeEqual(hmac(`ak1:${bookingId}:${exp}`), mac);
}

/** A short support reference for a booking ("NB-1A2B3C"): from its id, never guessable into anything. */
export function bookingRef(bookingId: string): string {
  return `NB-${bookingId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}
