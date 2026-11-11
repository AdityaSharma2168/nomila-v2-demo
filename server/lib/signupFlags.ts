/**
 * signupFlags.ts — admin flags on a NEW account (anti-fake plan, owner, 24 Oct 2026). Signals for the admin list
 * (admin/index.html chips + "Flagged" filter; bulk promote skips flagged rows unless ticked), NEVER a block: the account
 * is always made and her research runs as for anyone else.
 *
 * Stored on athletes.signup_flags (0139, nullable jsonb), keyed by flag, each value { at, ...detail }:
 *   disposable_email      her e-mail's domain is on the bundled throwaway list (lib/disposableDomains.ts)
 *   same_network_burst    more than SAME_NETWORK_BURST_LIMIT (5) new accounts from the same network in 24 h, read from the
 *                         per-IP new-account hourly buckets lib/signupBurst.ts already counts (a keyed hash per hour,
 *                         never the IP). With NEW_ACCOUNTS_PER_IP_PER_HOUR=0 nothing is counted, so it never fires.
 *   no_athlete_footprint  the "real athlete?" check found no public footprint (agent/onboarding/footprintCheck.ts)
 * Never fatal: a failure is logged and the sign-up goes on.
 */
import type { Request } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { athletes } from "../../shared/schema";
import { createLogger } from "../logger";
import { isDisposableEmail } from "./disposableDomains";
import { recentTotal } from "./publicRateCounters";
import { newAccountIpParts } from "./signupBurst";

const logger = createLogger("lib/signupFlags");

export const SIGNUP_FLAGS = ["disposable_email", "same_network_burst", "no_athlete_footprint"] as const;
export type SignupFlag = (typeof SIGNUP_FLAGS)[number];
export const SAME_NETWORK_BURST_LIMIT = 5;
const DAY_MS = 86_400_000;

/** The flags a new account earns at creation, with their detail. */
export async function creationFlags(req: Request, email: string | null | undefined, now: Date = new Date()): Promise<Partial<Record<SignupFlag, Record<string, unknown>>>> {
  const at = now.toISOString();
  const out: Partial<Record<SignupFlag, Record<string, unknown>>> = {};
  if (isDisposableEmail(email)) out.disposable_email = { at, domain: email!.slice(email!.lastIndexOf("@") + 1).toLowerCase().slice(0, 120) };
  try {
    const n = await recentTotal(newAccountIpParts(req), "hour", DAY_MS, now);
    if (n > SAME_NETWORK_BURST_LIMIT) out.same_network_burst = { at, accounts24h: n };
  } catch (err: any) {
    logger.warn({ error: String(err?.message ?? err).slice(0, 200) }, "same-network count failed (no flag)");
  }
  return out;
}

/** Merge flags into her row (existing flags kept). No-op for none. */
export async function setSignupFlags(athleteId: string, flags: Partial<Record<SignupFlag, Record<string, unknown>>>): Promise<void> {
  if (!Object.keys(flags).length) return;
  await db.update(athletes).set({ signup_flags: sql`coalesce(${athletes.signup_flags}, '{}'::jsonb) || ${JSON.stringify(flags)}::jsonb` }).where(eq(athletes.id, athleteId));
}

/** Remove one flag from her row (NULL again when none are left). */
export async function clearSignupFlag(athleteId: string, flag: SignupFlag): Promise<void> {
  await db.update(athletes).set({ signup_flags: sql`nullif(coalesce(${athletes.signup_flags}, '{}'::jsonb) - ${flag}::text, '{}'::jsonb)` }).where(eq(athletes.id, athleteId));
}

/** At account creation: compute and store her flags. Never throws. */
export async function recordSignupFlags(athleteId: string, req: Request, email: string | null | undefined): Promise<void> {
  try {
    const flags = await creationFlags(req, email);
    await setSignupFlags(athleteId, flags);
    if (Object.keys(flags).length) logger.info({ athleteId, flags: Object.keys(flags) }, "new account flagged for admin review");
  } catch (err: any) {
    logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "signup flags not recorded");
  }
}

/** The flag names on a stored value (the admin list's chips). */
export function flagNames(v: unknown): SignupFlag[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return SIGNUP_FLAGS.filter((f) => f in (v as Record<string, unknown>));
}
