/**
 * signups.ts — the sign-ups kill switch and the LIKE-pattern guard used by name matching in auth.
 *
 * SIGNUPS_OPEN: only the exact string "true" lets an auth path CREATE a new athlete row. Anything else (unset, "false",
 * "1", "TRUE") closes sign-ups: the create branches of /auth/signup, /auth/microsoft and /waitlist answer
 * 403 { error: "signups_closed" }. Sign-in for a caller whose uid already owns a row (athletes.auth_id) is never
 * affected, and neither is linking an existing row on a claim proof (a verified e-mail) — neither creates an account.
 */

export const SIGNUPS_CLOSED_ERROR = "signups_closed" as const;

export function signupsOpen(): boolean {
  return process.env.SIGNUPS_OPEN === "true";
}

export { escapeLike } from "./likePattern";

/** Shortest name (after trimming, wildcards excluded) that may be used to look up an existing profile by name. */
export const MIN_NAME_MATCH_LENGTH = 4;

/** True when a name is long enough to be used as a lookup key (counts letters and digits only). */
export function nameUsableForMatch(name: string): boolean {
  return (name.trim().match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= MIN_NAME_MATCH_LENGTH;
}
