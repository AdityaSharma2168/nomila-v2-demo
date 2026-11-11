/**
 * brandToken.ts — the brand's single-purpose delivery-confirmation credential.
 *
 * The payment id is NOT a credential for confirming delivery: the athlete knows it, and
 * confirming releases her own funds. Instead, each "mark delivered" mints a fresh random
 * token that is emailed ONLY to the brand (the email captured at Checkout). The database
 * keeps its SHA-256 (payments.brand_confirm_token_hash), never the token, and no athlete
 * route returns it. Minting a new token invalidates the previous one.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url — unguessable and URL-safe. */
export function mintBrandConfirmToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashBrandConfirmToken(token) };
}

export function hashBrandConfirmToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time check of a presented token against the stored hash. Missing either side → false. */
export function brandConfirmTokenMatches(presented: unknown, storedHash: string | null | undefined): boolean {
  if (typeof presented !== "string" || !presented || !storedHash) return false;
  if (presented.length > 128) return false;
  const a = Buffer.from(hashBrandConfirmToken(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
