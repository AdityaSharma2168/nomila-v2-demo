/**
 * publicRateCounters.ts — database-backed counters for public routes (the Partner door, the relay).
 *
 * express-rate-limit counts per Cloud Run instance; a public form needs one count across the fleet. A bucket is a
 * keyed hash (never an IP, never an email): `take()` atomically adds one in the bucket's current fixed window and says
 * whether the caller is still within the limit. Old windows are pruned by pruneCounters() (the partner sweep calls it hourly).
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { publicRateCounters } from "../../shared/schema";
import { createHash } from "node:crypto";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export type Window = "hour" | "day" | "week";
const WINDOW_MS: Record<Window, number> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };

function windowStart(w: Window, now: Date): Date {
  const ms = WINDOW_MS[w];
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** Count one more against `parts` in this window; true when the count is still ≤ limit. */
export async function take(parts: string[], limit: number, w: Window, now: Date = new Date()): Promise<boolean> {
  const bucket = sha256(`${w}|${parts.join("|")}`);
  const start = windowStart(w, now);
  const rows = await db.insert(publicRateCounters)
    .values({ bucket, window_start: start, count: 1 })
    .onConflictDoUpdate({ target: [publicRateCounters.bucket, publicRateCounters.window_start], set: { count: sql`${publicRateCounters.count} + 1` } })
    .returning({ count: publicRateCounters.count });
  return (rows[0]?.count ?? 1) <= limit;
}

/**
 * Read-only: the total counted against `parts` (as take() counts them in window `w`) over the windows that start within
 * the last `spanMs`, including the current one. Adds nothing. (The admin flags read the per-IP new-account hourly
 * buckets over 24 h this way: lib/signupFlags.ts.)
 */
export async function recentTotal(parts: string[], w: Window, spanMs: number, now: Date = new Date()): Promise<number> {
  const bucket = sha256(`${w}|${parts.join("|")}`);
  const since = new Date(windowStart(w, now).getTime() - Math.max(0, spanMs - WINDOW_MS[w]));
  const rows = await db.select({ total: sql<number>`coalesce(sum(${publicRateCounters.count}), 0)::int` }).from(publicRateCounters)
    .where(and(eq(publicRateCounters.bucket, bucket), gte(publicRateCounters.window_start, since)));
  return Number(rows[0]?.total ?? 0);
}

/** Drop windows older than a week (the longest window). */
export async function pruneCounters(now: Date = new Date()): Promise<number> {
  const rows = await db.delete(publicRateCounters)
    .where(lt(publicRateCounters.window_start, new Date(now.getTime() - 2 * WINDOW_MS.week)))
    .returning({ bucket: publicRateCounters.bucket });
  return rows.length;
}
