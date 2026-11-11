/**
 * signupBurst.ts — an anti-script guard on NEW account creation, across every Cloud Run instance.
 *
 * Owner decision (24 Oct 2026): sign-ups are never limited as such. Every real sign-up succeeds; the research budget
 * never refuses one (the daily research cap, agent/onboarding/dailyCap.ts, only QUEUES research). This guard exists
 * only to stop a script minting accounts from one address:
 *   per IP     NEW_ACCOUNTS_PER_IP_PER_HOUR   default 200 (a whole team on one campus Wi-Fi never reaches it); 0 = off
 *   global     NEW_ACCOUNTS_PER_HOUR          default OFF (unset or 0); a positive number turns on a service-wide
 *                                             hourly ceiling, for an emergency only
 * Counted in the shared database counters (lib/publicRateCounters.ts: a keyed hash per fixed hour, never the IP itself),
 * and only for a NEW account (never an existing one updating her answers, never a claim link). Over a limit that is on
 * ⇒ the caller answers 429 with Retry-After (refuseBurst); the landing reads it as "try again in a little while".
 * A counter that cannot be written fails OPEN (logged).
 */
import type { Request, Response } from "express";
import { take } from "./publicRateCounters";
import { createLogger } from "../logger";

const logger = createLogger("lib/signupBurst");

/** A limit from env: a positive integer is the limit, "0" is off (null), unset or unreadable is `fallback`. */
function envLimit(name: string, fallback: number | null): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (n === 0) return null;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
/** The per-IP hourly guard, or null when off. */
export const newAccountsPerIpPerHour = (): number | null => envLimit("NEW_ACCOUNTS_PER_IP_PER_HOUR", 200);
/** The service-wide hourly ceiling, or null when off (the default). */
export const newAccountsPerHour = (): number | null => envLimit("NEW_ACCOUNTS_PER_HOUR", null);

/** The per-IP hourly bucket's key parts (hashed by publicRateCounters; the IP itself is never stored). lib/signupFlags.ts reads it. */
export const newAccountIpParts = (req: Request): string[] => ["new_account_ip", req.ip || "unknown"];

/** Count one new account for this caller; false only when a limit that is ON is passed. */
export async function newAccountAllowed(req: Request, now: Date = new Date()): Promise<boolean> {
  const perIp = newAccountsPerIpPerHour();
  const global = newAccountsPerHour();
  if (perIp === null && global === null) return true;
  try {
    if (perIp !== null && !(await take(newAccountIpParts(req), perIp, "hour", now))) {
      logger.warn({ scope: "ip" }, "new account refused: per-IP hourly anti-script guard");
      return false;
    }
    if (global !== null && !(await take(["new_account_all"], global, "hour", now))) {
      logger.warn({ scope: "global" }, "new account refused: global hourly ceiling (NEW_ACCOUNTS_PER_HOUR is set)");
      return false;
    }
    return true;
  } catch (err: any) {
    logger.warn({ error: String(err?.message ?? err).slice(0, 200) }, "new account burst counter failed (failing open)");
    return true;
  }
}

export const SIGNUP_BUSY_ERROR = "signups_busy";

/** The calm 429: nothing was created; try again in a while. */
export function refuseBurst(res: Response, now: Date = new Date()): void {
  const retryAfterSec = Math.max(60, Math.ceil((3_600_000 - (now.getTime() % 3_600_000)) / 1000));
  res.setHeader("Retry-After", String(retryAfterSec));
  res.status(429).json({ error: SIGNUP_BUSY_ERROR, message: "Too many new accounts from this network just now. Please try again in a little while.", retryAfterSec });
}
