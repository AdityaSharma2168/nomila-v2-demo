/**
 * config.ts — single source of truth for Mila agent configuration.
 *
 * Every Mila module reads model names, limits, and feature flags from here.
 * Never hardcode any of these values at a call site.
 */

import { readCap } from "../lib/spendCap";
import { GEMINI } from "../lib/models";

export const MILA = {
  /**
   * Web voice flag — default off: it gates real spend. Every token this
   * mints dispatches a LiveKit worker job and opens a billable Gemini Live
   * realtime session, so voice must be switchable without touching the text
   * agent.
   *
   * This replaced the NODE_ENV check that used to keep POST /voice/token off
   * production. That gate was a stand-in for authentication; now that the route
   * authenticates and scopes per athlete, what remains is a deliberate on/off
   * switch — and it is a FLAG rather than an environment predicate so that
   * turning voice on (or off, in an incident) is a config change, not a deploy.
   *
   * Getter so the env var is read at call time, not frozen at module load (tests
   * and late env injection both rely on this). */
  get VOICE_WEB(): boolean {
    return process.env.MILA_VOICE_WEB === "true";
  },
  /**
   * Voice web search — default off: it gates spend on its own surface, so voice
   * search can be killed in an incident on its own. The voice route searches with
   * OpenAI web search (skill voice/web-search) and returns bounded structured hits
   * (server/voice/webSearchRoute.ts).
   *
   * Getter so env injection at call time works (same reason as the flags above).
   */
  get VOICE_WEB_SEARCH(): boolean {
    return process.env.MILA_VOICE_WEB_SEARCH === "true";
  },
  /**
   * One Mila for voice — default off; ON in dev only (gcp/cloud-run-dev.yaml), guarded off in prod
   * (scripts/prod-flag-guard.ts). Turns on POST /api/internal/voice/session and POST /api/internal/voice/tool
   * (server/voice/oneMila): the voice worker gets Mila's one definition, the chat's per-turn CONTEXT and the registry's
   * tools as Gemini Live declarations, and runs every tool call through the server's guarded path. Off: both routes 404
   * and the worker keeps its own briefing and tools. Getter, read at call time.
   */
  get VOICE_ONE(): boolean {
    return process.env.MILA_VOICE_ONE === "true";
  },
  /** Per-athlete web-search rate limit: at most this many searches per window.
   *  SHARED by the voice search route and Studio's moment search — one athlete,
   *  one budget, whichever surface spends it. Env-overridable so it can be tuned
   *  without a deploy; bad/blank/non-positive values fall back to the default.
   *  Getter for the same read-at-call-time reason as the flags above. */
  get WEB_SEARCH_MAX_PER_WINDOW(): number {
    // Clamped to 50 (lib/spendCap.ts): each search is paid, so the override has a ceiling.
    return Math.floor(readCap("MILA_WEB_SEARCH_MAX", 10, 50));
  },
  /** The web-search rate-limit window (ms). Default 60s → ~10 searches/min. */
  get WEB_SEARCH_WINDOW_MS(): number {
    const n = Number(process.env.MILA_WEB_SEARCH_WINDOW_MS);
    return Number.isFinite(n) && n > 0 ? n : 60_000;
  },
  // Model id comes from the fleet registry (lib/models.ts). 3.x resolves only in the
  // `global` Vertex location (gemini-2.5-* retires 2026-10-16; us-central1 404s 3.x).
  MODEL: GEMINI.flash,
  PROJECT: process.env.GCP_PROJECT_ID || "gamechanger-pocket-agent",
  LOCATION: "global",
  /**
   * Max tool-call rounds per user turn before the loop force-stops. 8 (was 6) is a
   * safety margin for ranking questions that legitimately need a list + a couple of
   * deep-dives — NOT a licence to fan out a tool per deal (the prompt forbids that).
   */
  MAX_TOOL_ITERATIONS: 8,
  /**
   * Hard cap on replayed history messages per conversation. Phase-1 memory loads a
   * whole conversation by id (no time window), so this is the primary bound — and
   * the seam where Phase 2's rolling summary will slot in (summarize older turns
   * once a conversation exceeds the cap, replay summary + the recent tail).
   */
  HISTORY_MESSAGE_CAP: 50,
  /**
   * Phase-2 rolling summary — fold trigger. Once a conversation has accumulated
   * this many replayable (user/assistant text) messages PAST the current summary
   * watermark, the async post-answer summarizer folds the older turns into the
   * rolling summary. Kept well under HISTORY_MESSAGE_CAP so a conversation is
   * folded long before it could hit the flat replay cap.
   */
  SUMMARY_TRIGGER_MESSAGES: 30,
  /**
   * Phase-2 rolling summary — verbatim tail. When the summarizer folds, it keeps
   * this many of the most-recent replayable messages OUT of the summary so they
   * still replay word-for-word; everything older is absorbed into `summary` and
   * the watermark advances to the newest folded message.
   */
  SUMMARY_TAIL_MESSAGES: 10,
  /** Per-tool execution timeout. */
  TOOL_TIMEOUT_MS: 8000,
  /** Budget for a serialized tool result handed back to the model. */
  TOOL_RESULT_MAX_CHARS: 4000,
  /**
   * Thinking-token budget for the loop's model calls (gemini-3.5-flash). Default
   * dynamic thinking can balloon on the FINAL answer — measured 1.8k–5.5k thinking
   * tokens, most of a turn's latency — while the tool-selection rounds stay under
   * ~1000. A MODERATE cap trims that final-answer tail WITHOUT starving tool
   * selection (which is why it's not 0 — disabling thinking degrades tool choice,
   * which would cost more iterations than it saves). `-1` restores the model's
   * uncapped default; `0` disables thinking entirely (too aggressive — do not use
   * for the loop). Env-overridable (MILA_THINKING_BUDGET) so it can be tuned or
   * reverted without a deploy; a blank/non-numeric value falls back to the default.
   * Getter for read-at-call-time (same reason as the flags above).
   */
  get THINKING_BUDGET(): number {
    const raw = process.env.MILA_THINKING_BUDGET;
    // Blank/unset → default (never let an empty string coerce to 0 = thinking off).
    if (raw == null || raw.trim() === "") return 1536;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 1536;
  },
} as const;
