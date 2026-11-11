/**
 * referralCode.ts — every athlete's own referral code, derived from her id: no column, no migration, stable for life.
 *
 *   referralCodeFor(athleteId)    the 16 bytes of her UUID through one AES-128 block (a fixed permutation), written in
 *                                 base62: at most 22 letters and digits, the same every time
 *   athleteIdFromReferralCode()   the inverse: her id, or null for anything that is not a code
 *
 * Non-guessable because the id is (a random v4 UUID: 122 random bits); the permutation only keeps the internal id out of
 * shared links. Its key is a constant here, NOT a secret, on purpose: a secret that rotated would break every link
 * already shared. (athletes.referral_code is something else: the code she ARRIVED with, ?ref= on the landing.)
 */
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

const KEY = createHash("sha256").update("nomila/referral-code/1").digest().subarray(0, 16);
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 62^22 > 2^128 > 62^21: a code is at most 22 characters. */
export const REFERRAL_CODE_MAX = 22;

function block(bytes: Buffer, decrypt: boolean): Buffer {
  const c = decrypt ? createDecipheriv("aes-128-ecb", KEY, null) : createCipheriv("aes-128-ecb", KEY, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(bytes), c.final()]);
}

export function referralCodeFor(athleteId: string): string {
  if (!UUID.test(athleteId)) throw new Error("referralCodeFor: not an athlete id");
  let n = BigInt(`0x${block(Buffer.from(athleteId.replace(/-/g, ""), "hex"), false).toString("hex")}`);
  let out = "";
  do { out = ALPHABET[Number(n % 62n)] + out; n /= 62n; } while (n > 0n);
  return out;
}

export function athleteIdFromReferralCode(code: unknown): string | null {
  if (typeof code !== "string" || !code || code.length > REFERRAL_CODE_MAX || !/^[0-9A-Za-z]+$/.test(code)) return null;
  let n = 0n;
  for (const ch of code) n = n * 62n + BigInt(ALPHABET.indexOf(ch));
  if (n >= 1n << 128n) return null;
  const hex = block(Buffer.from(n.toString(16).padStart(32, "0"), "hex"), true).toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return referralCodeFor(id) === code ? id : null;   // one canonical spelling per id (no leading-zero variants)
}
