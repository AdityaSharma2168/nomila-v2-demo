/**
 * services/quickScore/config.ts — the switches and caps of the sign-up QUICK SCORE (owner decision, 26 Oct 2026: one
 * web-searching call with the existing search-enabled M.I.A. prompt word for word, plus her said facts and connected
 * numbers). Since 4 Nov 2026 ("one search provider") the call is OpenAI web search on the fast model at low search
 * context, not Gemini with Google Search grounding. Every value reads the environment at call time.
 *
 *   QUICK_SCORE_ONE_CALL          "true" ⇒ new signup_research runs use v3 (the quick_score step). Dev "true", prod "false".
 *   QUICK_SCORE_MODEL             default AGENT_MODELS.fast (gpt-6-luna; OPENAI_AGENT_FAST_MODEL overrides the tier).
 *   QUICK_SCORE_MAX_OUTPUT_TOKENS default 16384 — includes reasoning tokens (the Responses API's max_output_tokens
 *                                 covers visible output and reasoning).
 *   QUICK_SCORE_TIMEOUT_MS        default 120000 per call.
 *   QUICK_SCORE_MAX_USD           default 0.60 for the whole step (both attempts); a retry is made only while the spend
 *                                 so far leaves room for one more worst-case call.
 *   QUICK_SCORE_MIN_SOURCES       default 3: fewer distinct cited sources ⇒ the quick score is marked low confidence.
 *
 * QUICK_SCORE_STORE_GROUNDED is gone: it was a Google-grounding terms gate (keeping a score built from Grounded Results).
 * OpenAI's web-search terms ask only that results shown are shown with clickable citations, which the landing does.
 */
import { AGENT_MODELS } from "../../agent/models";
import { readCap } from "../../lib/spendCap";

const num = (name: string, dflt: number, min = 0): number => {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= min ? n : dflt;
};

export const quickScoreOneCallEnabled = (): boolean => process.env.QUICK_SCORE_ONE_CALL === "true";
export const quickScoreModel = (): string => process.env.QUICK_SCORE_MODEL?.trim() || AGENT_MODELS.fast;
export const quickScoreMaxOutputTokens = (): number => Math.round(num("QUICK_SCORE_MAX_OUTPUT_TOKENS", 16_384, 1_024));
export const quickScoreTimeoutMs = (): number => Math.round(num("QUICK_SCORE_TIMEOUT_MS", 120_000, 5_000));
/** Clamped to $6 (10× the default; lib/spendCap.ts); a value that is not a usable number is the default. */
export const quickScoreMaxUsd = (): number => readCap("QUICK_SCORE_MAX_USD", 0.6, 6);
export const quickScoreMinSources = (): number => Math.round(num("QUICK_SCORE_MIN_SOURCES", 3, 0));

/** The search side of the call: low search context and at most this many web searches per answer (max_tool_calls). */
export const QUICK_SCORE_SEARCH_CONTEXT = "low" as const;
export const QUICK_SCORE_MAX_SEARCHES = 5;
