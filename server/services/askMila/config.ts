/**
 * askMila/config.ts — public Mila mode's flag and limits (design-public-card-v3 §4 "Limits", PR 5).
 *
 * ASK_MILA_PUBLIC gates the visitor chat on /p/:handle (POST /p/:handle/ask and its two tap routes) and the free-text
 * box in the page's Mila sheet. It needs PUBLIC_CARD as well: with either off, every public Mila route falls through to
 * the app's 404 and the sheet keeps its "typing opens soon" state. Off in dev and prod (gcp/cloud-run-*.yaml, pinned by
 * askMila.flag.test.ts). Read at call time so a test, or an incident, can flip it.
 *
 * The fixed numbers are the design's; the daily ones are env-tunable without a deploy. Every counter is DB-backed
 * (0104), never in memory, so they hold across Cloud Run instances.
 *
 * Nothing here names an athlete, sport, school, league or brand.
 */
import crypto from "node:crypto";
import { createLogger } from "../../logger";
import { readCap, readPrice } from "../../lib/spendCap";
import { publicCardEnabled } from "../publicCard/flag";

const logger = createLogger("askMila/config");

/** Exactly "true" is on (and PUBLIC_CARD must be on too); anything else is off. */
export const askMilaPublicEnabled = (): boolean => publicCardEnabled() && process.env.ASK_MILA_PUBLIC === "true";

const positiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const ASK_MILA = {
  /** A visitor message longer than this is refused (the sheet's input stops at it too). */
  messageMaxChars: 300,
  /** Visitor turns in one chat. The next message gets the turn-limit line and the chat ends. */
  sessionMaxTurns: 20,
  /** Minutes without a turn after which a chat is over; the next message starts a new one. */
  idleMinutes: 15,
  /** Per visitor (daily-salted IP hash), every athlete's card together. ASK_MILA_VISITOR_DAILY_TURNS. */
  get visitorDailyTurns(): number { return positiveInt("ASK_MILA_VISITOR_DAILY_TURNS", 30); },
  /** Per athlete, every visitor on her card together. ASK_MILA_ATHLETE_DAILY_TURNS. */
  get athleteDailyTurns(): number { return positiveInt("ASK_MILA_ATHLETE_DAILY_TURNS", 400); },
  /**
   * The GLOBAL daily spend cap of public Mila across every card, in US dollars (stored as micro-dollars).
   * ASK_MILA_DAILY_SPEND_CAP_USD. "0" is the kill switch: no model call, the sheet says Mila is resting today.
   */
  get dailySpendCapMicroUsd(): number { return Math.round(readCap("ASK_MILA_DAILY_SPEND_CAP_USD", 20, 200, { allowZero: true }) * 1_000_000); },
  /**
   * What one million tokens cost, for the spend counter. Conservative defaults for Mila's flash-class model, tunable
   * with ASK_MILA_PRICE_INPUT_PER_MTOK_USD / ASK_MILA_PRICE_OUTPUT_PER_MTOK_USD (thinking tokens bill as output).
   */
  // Floored at half the default (lib/spendCap.ts readPrice): an override can never make a turn free.
  get priceInputPerMTokUsd(): number { return readPrice("ASK_MILA_PRICE_INPUT_PER_MTOK_USD", 0.5, 0.25); },
  get priceOutputPerMTokUsd(): number { return readPrice("ASK_MILA_PRICE_OUTPUT_PER_MTOK_USD", 3, 1.5); },
  /** Transcripts are kept this long, then purged. */
  transcriptDays: 90,
  /** Messages of this chat replayed to the model (the newest; a chat has at most 2 × sessionMaxTurns). */
  historyMessages: 40,
  /** Mila's answer is cut to this many characters before the gate (a short chat answer, never an essay). */
  replyMaxChars: 900,
} as const;

/** Micro-dollars a model call cost, from its token usage. Rounded up so the counter never under-counts. */
export function costMicroUsd(u: { promptTokens: number; outputTokens: number; thinkingTokens: number }): number {
  const input = (u.promptTokens * ASK_MILA.priceInputPerMTokUsd);
  const output = ((u.outputTokens + u.thinkingTokens) * ASK_MILA.priceOutputPerMTokUsd);
  return Math.ceil(input + output); // tokens × $/MTok = micro-dollars
}

/**
 * The server-only HMAC key behind the daily visitor salt. Same resolution as oauthState.ts: SESSION_SECRET, else the
 * cron secret every instance shares. Production always has one; elsewhere a fixed dev key with a warning.
 */
export function visitorKey(): string {
  const s = process.env.SESSION_SECRET?.trim() || process.env.CRON_SECRET?.trim() || process.env.INTERNAL_CRON_SECRET?.trim();
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET / CRON_SECRET required for the Ask Mila visitor salt");
  logger.warn("No secret set: the Ask Mila visitor salt uses a dev-only key");
  return "dev-ask-mila-visitor-key";
}

/** UTC day, YYYY-MM-DD. */
export const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * The visitor's key for the daily limit: HMAC(secret, day ‖ ip). The salt changes every UTC day, so the same visitor
 * cannot be linked from one day to the next, and the IP itself is never stored anywhere.
 */
export function visitorHash(ip: string, now: Date): string {
  return crypto.createHmac("sha256", visitorKey()).update(`${dayOf(now)}|${ip}`).digest("base64url").slice(0, 32);
}
