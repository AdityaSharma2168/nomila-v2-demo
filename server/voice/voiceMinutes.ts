/**
 * voiceMinutes.ts — a per-athlete daily cap on voice minutes (spend guards, Nov 2026).
 *
 * Until now the only bound on voice was the grant's 60-minute expiry (./auth.ts VOICE_SESSION_MAX_MS), which expires
 * the worker's TOOLS, not the session, and says nothing about how many sessions a day. This adds a daily cap that is
 * checked when a session is granted (POST /voice/token, ./webTokenRoute.ts): at or over it, no token is minted.
 *
 * How usage is measured: from what voice already records, not a new ledger. Every spoken turn lands in chat_messages
 * with source = 'voice' (./transcriptRoute.ts). A session is a run of voice turns in one conversation with no gap
 * longer than SESSION_GAP_MS; it counts its span (first turn to last) plus one minute (the greeting before the first
 * transcribed turn, and a session that connected but said little). Today = since UTC midnight.
 *
 * The grant is also shortened to what is left today (never longer than VOICE_SESSION_MAX_MS), so a session that
 * starts with 10 minutes left has its tools expire after 10 minutes once VOICE_GRANT_ENFORCE is on.
 *
 * MILA_VOICE_DAY_MINUTES: default 20 (owner, 5 Nov 2026; at the $0.35 estimate below, 20 minutes ≈ $7 a day of voice,
 * counted in the platform total only, not the per-athlete agent day cap), hard maximum 300 (lib/spendCap.ts; a value that is not a usable number is 20).
 */
import { readCap, readPrice } from "../lib/spendCap";

/**
 * VOICE_COST_PER_MINUTE_USD — what one voice minute is ESTIMATED to cost, for the platform day total
 * (lib/platformSpend.ts). An estimate, not a bill: Gemini Live and LiveKit invoice separately and nothing reads those
 * invoices. Default $0.35, floor $0.25 (owner, 5 Nov 2026; lib/spendCap.ts readPrice: an override can make it more
 * cautious, never cheaper than the floor). Why: the worker is to bound its context with Gemini Live context-window
 * compression (trigger ~32k tokens, slide to ~16k), so a long call re-bills ~16k–32k tokens of context every turn:
 * ~4 turns a minute × ~16k–32k × $3/1M ≈ $0.19–0.38, plus fresh audio, audio out, instructions and LiveKit ≈ $0.25–0.40
 * a minute. Default near the middle, floor at the bottom. The 10-minute arithmetic it replaced (the context still small,
 * no compression reached) is kept below as the low bound:
 *
 *   Gemini 2.5 Flash Live API on Vertex (cloud.google.com/vertex-ai/generative-ai/pricing): audio in $3.00 / 1M tokens,
 *   audio out $12.00 / 1M, text in $0.50 / 1M, text out $2.00 / 1M; audio = 25 tokens a second; EVERY turn re-bills the
 *   whole session context so far. Reference session: 10 minutes, a turn every 15 s (40 turns), each turn 7.5 s of the athlete's
 *   speech (188 tokens) and 7.5 s of Mila's (188 tokens).
 *     fresh audio in     40 × 188 = 7,500 tokens × $3/1M   = $0.0225
 *     audio out          40 × 188 = 7,500 tokens × $12/1M  = $0.0900
 *     context re-billed  375 × (0 + 1 + … + 39) = 292,500 audio tokens × $3/1M = $0.8775
 *     instructions + tools ~6,000 text tokens × 40 turns = 240,000 × $0.50/1M = $0.1200
 *     transcription      ~350 text tokens a minute × 10 × $2/1M = $0.0070
 *     = $1.117 for 10 minutes = $0.1117 a minute
 *   LiveKit Cloud (livekit.com/pricing, Ship/Scale overage): agent session $0.01 a minute + 2 participants × $0.0005
 *   WebRTC minute + ~0.5 MB audio a minute × $0.12/GB ≈ $0.0111 a minute.
 *   Blended: $0.1117 + $0.0111 = $0.1228 a minute for a 10-minute call: the floor of $0.25 sits well above it.
 * Without compression, longer sessions cost more per minute still (the re-billed context grows without bound).
 */
export const VOICE_COST_PER_MINUTE_DEFAULT_USD = 0.35;
export const VOICE_COST_PER_MINUTE_FLOOR_USD = 0.25;
export function voiceCostPerMinuteUsd(): number {
  return readPrice("VOICE_COST_PER_MINUTE_USD", VOICE_COST_PER_MINUTE_DEFAULT_USD, VOICE_COST_PER_MINUTE_FLOOR_USD);
}

export const VOICE_DAY_MINUTES_DEFAULT = 20;
export const VOICE_DAY_MINUTES_MAX = 300;
/** A silence longer than this between two voice turns of one conversation starts a new session. */
export const SESSION_GAP_MS = 10 * 60_000;

export function voiceDayMinutesCap(): number {
  return readCap("MILA_VOICE_DAY_MINUTES", VOICE_DAY_MINUTES_DEFAULT, VOICE_DAY_MINUTES_MAX);
}

export const VOICE_MINUTES_MESSAGE =
  "You've used today's voice time. Text chat with Mila still works, and voice is back tomorrow.";

const rowsOf = <T>(r: unknown): T[] => ((r as any)?.rows ?? r) as T[];

/** Voice minutes used today (UTC), measured from the voice transcript rows: one athlete's, or (null) every athlete's. */
export async function voiceMinutesUsedToday(athleteId: string | null, now: Date = new Date()): Promise<number> {
  const [{ db }, { sql }] = await Promise.all([import("../db"), import("drizzle-orm")]);
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const gapSeconds = SESSION_GAP_MS / 1000;
  const [row] = rowsOf<{ minutes: string | number | null }>(await db.execute(sql`
    WITH turns AS (
      SELECT athlete_id, conversation_id, created_at,
             CASE WHEN lag(created_at) OVER w IS NULL
                    OR extract(epoch FROM created_at - lag(created_at) OVER w) > ${gapSeconds}
                  THEN 1 ELSE 0 END AS starts
      FROM chat_messages
      WHERE ${athleteId === null ? sql`TRUE` : sql`athlete_id = ${athleteId}::uuid`} AND source = 'voice' AND created_at >= ${midnight}
      WINDOW w AS (PARTITION BY athlete_id, conversation_id ORDER BY created_at)
    ), numbered AS (
      SELECT athlete_id, conversation_id, created_at, sum(starts) OVER (PARTITION BY athlete_id, conversation_id ORDER BY created_at) AS session
      FROM turns
    )
    SELECT coalesce(sum(extract(epoch FROM last_at - first_at) / 60.0 + 1), 0) AS minutes
    FROM (SELECT min(created_at) AS first_at, max(created_at) AS last_at FROM numbered GROUP BY athlete_id, conversation_id, session) s
  `));
  const n = Number(row?.minutes ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Today's (UTC) voice spend in micro-dollars, ESTIMATED: voice minutes today × VOICE_COST_PER_MINUTE_USD. One athlete's
 * (their day total, agent/trace.ts spentTodayMicroUsd, so every per-athlete day cap counts voice), or (null) every
 * athlete's (the platform day total, lib/platformSpend.ts). An estimate, not a bill: see voiceCostPerMinuteUsd above.
 */
export async function voiceSpendTodayMicroUsd(
  athleteId: string | null,
  now: Date = new Date(),
  used: (athleteId: string | null, now: Date) => Promise<number> = voiceMinutesUsedToday,
): Promise<number> {
  const microUsd = Math.round((await used(athleteId, now)) * voiceCostPerMinuteUsd() * 1_000_000);
  return Number.isFinite(microUsd) && microUsd > 0 ? microUsd : 0;
}

export interface VoiceAllowance { capMinutes: number; usedMinutes: number; remainingMs: number; allowed: boolean }

/** What is left of today's voice time. Refused (allowed: false) under one minute left. */
export async function voiceAllowance(
  athleteId: string,
  now: Date = new Date(),
  used: (athleteId: string, now: Date) => Promise<number> = voiceMinutesUsedToday,
): Promise<VoiceAllowance> {
  const capMinutes = voiceDayMinutesCap();
  const usedMinutes = await used(athleteId, now);
  const remainingMs = Math.max(0, Math.floor((capMinutes - usedMinutes) * 60_000));
  return { capMinutes, usedMinutes, remainingMs, allowed: remainingMs >= 60_000 };
}
