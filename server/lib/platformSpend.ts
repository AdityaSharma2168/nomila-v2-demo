/**
 * platformSpend.ts — ONE daily spend ceiling across every athlete (spend guards, Nov 2026).
 *
 * Every other cap is per athlete, per run or per job, so N athletes (or N fake accounts) can each spend their own cap.
 * This one is the backstop over all of them: once today's (UTC day) model and generation spend for the whole platform
 * reaches PLATFORM_DAY_COST_CAP_USD, every NEW paid call is refused for everyone, with PlatformCapError (a
 * CostCapError, so every existing cap handler already treats it as "stop, nothing more to spend"), and one alert line
 * is logged per process per UTC day: { event: "platform_spend_cap_reached" }.
 *
 * What it sums (the existing ledgers, no new one):
 *   agent_runs.cost_micro_usd        every agent / Mila model run, and every paid call the guarded path records;
 *   generation_jobs.cost_estimated_usd  Studio generations (not cancelled), the same figure Studio's own day cap sums;
 *   voice                            today's voice minutes, all athletes (the same transcript rows the per-athlete
 *                                    minutes cap reads: voice/voiceMinutes.ts) × VOICE_COST_PER_MINUTE_USD. An
 *                                    ESTIMATE, not a bill: Gemini Live and LiveKit bill elsewhere, and nothing here
 *                                    reads their invoices.
 *
 * When it is checked: before a paid call STARTS. A voice session is checked once, at grant time (POST /voice/token);
 * a session already running is never cut off when the platform crosses the ceiling. That overshoot is bounded per
 * athlete by their daily voice minutes (the grant never outlasts what is left of their day).
 *
 * What it never touches: reads. The app keeps serving everything already made; only a call that would SPEND asks
 * `assertPlatformBudget`. A failed spend read FAILS CLOSED: the last good total is used only while it is under
 * STALE_OK_MS (60 s) old; after that every new paid call is refused with the at-cap message (PLATFORM_CAP_MESSAGE), and
 * ONE alert line is logged per failure streak ({ event: "platform_spend_read_failed", refusing }), not one per call
 * (a second only when the streak outlives the 60 s and starts refusing).
 * A backstop that reads 0 when it cannot read is not a backstop.
 *
 * Cached per process for CACHE_MS so a busy minute is one grouped SELECT, not one per call: the ceiling can be passed by
 * at most what the platform spends in CACHE_MS (plus calls already in flight).
 */
import { createLogger } from "../logger";
import { CostCapError } from "./spendErrors";
import { readCap } from "./spendCap";

const logger = createLogger("platform-spend");

export const PLATFORM_DAY_CAP_DEFAULT_USD = 25;
export const PLATFORM_DAY_CAP_MAX_USD = 250;
const CACHE_MS = 30_000;
/** A failed re-read may lean on the last good total only while it is younger than this; older → refuse. */
export const STALE_OK_MS = 60_000;

/** PLATFORM_DAY_COST_CAP_USD in micro-dollars: default 25, never above 250 (lib/spendCap.ts; owner, 5 Nov 2026). */
export function platformDayCapMicroUsd(): number {
  return Math.round(readCap("PLATFORM_DAY_COST_CAP_USD", PLATFORM_DAY_CAP_DEFAULT_USD, PLATFORM_DAY_CAP_MAX_USD) * 1_000_000);
}

export const PLATFORM_CAP_MESSAGE =
  "Nomila has reached today's spending limit for paid AI work. Everything you already have still works; new " +
  "generations, research and Mila replies start again after midnight UTC.";

export class PlatformCapError extends CostCapError {
  readonly code = "platform_spend_cap";
  constructor(spentMicroUsd: number, capMicroUsd: number) {
    super(spentMicroUsd, capMicroUsd);
    this.name = "PlatformCapError";
    this.message = PLATFORM_CAP_MESSAGE;
  }
}

/**
 * Whether an error is (or wraps, through `cause`) the platform day cap's refusal. Matches the class, its code or its
 * fixed message, so a step that re-threw it as a plain Error (keeping the message) is still recognised. The workflow
 * runner uses it to HOLD a sign-up research step instead of failing it (agent/onboarding/dailyCap.ts holdsOnPlatformCap).
 */
export function isPlatformCapError(err: unknown): boolean {
  for (let e: any = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e instanceof PlatformCapError || e.code === "platform_spend_cap" || e.name === "PlatformCapError") return true;
    if (typeof e.message === "string" && e.message.includes(PLATFORM_CAP_MESSAGE)) return true;
  }
  return false;
}

const rowsOf = <T>(r: unknown): T[] => ((r as any)?.rows ?? r) as T[];
const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** Today's (UTC) platform spend in micro-dollars, from the two existing ledgers. */
export async function dbPlatformSpentTodayMicroUsd(now: Date = new Date()): Promise<number> {
  // Imported at call time (like agent/spendCron.ts): importing this module never opens the database.
  const [{ db }, { sql }] = await Promise.all([import("../db"), import("drizzle-orm")]);
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const { voiceSpendTodayMicroUsd } = await import("../voice/voiceMinutes");
  const [row] = rowsOf<{ agent: string | number | null; studio: string | number | null }>(await db.execute(sql`
    SELECT
      (SELECT coalesce(sum(cost_micro_usd), 0) FROM agent_runs WHERE started_at >= ${midnight}) AS agent,
      (SELECT coalesce(sum(cost_estimated_usd), 0) FROM generation_jobs WHERE created_at >= ${midnight} AND status <> 'canceled') AS studio
  `));
  const agent = Number(row?.agent ?? 0);
  const studio = Math.round(Number(row?.studio ?? 0) * 1_000_000);
  // Voice, estimated: every athlete's voice minutes today × the per-minute estimate (the same helper each athlete's
  // own day total uses: agent/trace.ts spentTodayMicroUsd).
  const voice = await voiceSpendTodayMicroUsd(null, now);
  return (Number.isFinite(agent) ? agent : 0) + (Number.isFinite(studio) ? studio : 0) + voice;
}

/** The jest setup file's stand-in (server/testUtils/platformSpendSetup.ts); never set outside tests. */
const testDefault = (): ((now: Date) => Promise<number>) | undefined =>
  (globalThis as { __platformSpendTestReader?: (now: Date) => Promise<number> }).__platformSpendTestReader;
let reader: ((now: Date) => Promise<number>) | null = null;
/** The last GOOD read (its `at` is when it was read, never moved forward by a failure). */
let cache: { day: string; at: number; microUsd: number } | null = null;
let alerted: string | null = null;
/** While reads are failing: what was last logged, so a streak logs once (and once more if it moves on to refusing). */
let readFailing: false | "stale-ok" | "refusing" = false;

/** Tests only: replace the spend read and forget the cache and the alert. */
export function setPlatformSpendReaderForTests(fn: ((now: Date) => Promise<number>) | null): void {
  reader = fn;
  cache = null;
  alerted = null;
  readFailing = false;
}

/** Add a just-recorded cost to the cached total, so this process sees its own spend before the next re-read. */
export function notePlatformSpend(microUsd: number, now: Date = new Date()): void {
  if (cache && cache.day === utcDay(now) && Number.isFinite(microUsd) && microUsd > 0) cache.microUsd += microUsd;
}

export interface PlatformBudget {
  spentMicroUsd: number;
  capMicroUsd: number;
  over: boolean;
  /** True when the total could not be read and the last good one is too old: refused, fail closed. */
  readFailed?: boolean;
}

export async function platformBudget(now: Date = new Date()): Promise<PlatformBudget> {
  const capMicroUsd = platformDayCapMicroUsd();
  const day = utcDay(now);
  if (!cache || cache.day !== day || now.getTime() - cache.at >= CACHE_MS) {
    try {
      cache = { day, at: now.getTime(), microUsd: await (reader ?? testDefault() ?? dbPlatformSpentTodayMicroUsd)(now) };
      readFailing = false;
    } catch (err: any) {
      const fresh = !!cache && cache.day === day && now.getTime() - cache.at < STALE_OK_MS;
      const state = fresh ? "stale-ok" : "refusing";
      if (readFailing !== state) {
        readFailing = state;
        logger.error({ event: "platform_spend_read_failed", refusing: !fresh, error: String(err?.message ?? err).slice(0, 200) },
          fresh ? "platform spend read failed; using the last good total (under 60s old)"
            : "platform spend read failed and no recent total: new paid calls are refused (fail closed)");
      }
      if (!fresh) return { spentMicroUsd: cache && cache.day === day ? cache.microUsd : capMicroUsd, capMicroUsd, over: true, readFailed: true };
    }
  }
  // Unreachable (a good read or a fresh-enough last one is in hand), but if not: refuse, never assume 0.
  if (!cache) return { spentMicroUsd: capMicroUsd, capMicroUsd, over: true, readFailed: true };
  const over = cache.microUsd >= capMicroUsd;
  if (over && alerted !== day) {
    alerted = day;
    logger.error({ event: "platform_spend_cap_reached", usd: Math.round(cache.microUsd / 10_000) / 100, cap_usd: capMicroUsd / 1_000_000 },
      "platform day spend cap reached: new paid calls are refused for everyone until UTC midnight");
  }
  return { spentMicroUsd: cache.microUsd, capMicroUsd, over };
}

/** Throws PlatformCapError once today's platform spend is at or over the ceiling. Call before any paid call. */
export async function assertPlatformBudget(now: Date = new Date()): Promise<void> {
  const b = await platformBudget(now);
  if (b.over) throw new PlatformCapError(b.spentMicroUsd, b.capMicroUsd);
}
