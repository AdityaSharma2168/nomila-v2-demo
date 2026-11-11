/**
 * agent/milaCards/config.ts — the card system v2's server flag and its numbers (design "Mila card designs" v2.2,
 * approved 3 Nov 2026: https://claude.ai/artifact/AjybphZyA41JXNkmZ3TXsM).
 *
 * MILA_CARDS_V2 ("true" on dev, "false" in prod; scripts/prod-flag-guard.ts refuses a deploy that would switch it on in
 * prod): the producers of the five new cards (share_insight, ideas_suggest, offer_capability, ask_once,
 * answer_with_sources) join the chat's tools, and POST /api/v1/me/mila/cards/outcome records the taps. Off: the tools
 * are left out of every run (ToolRegistry.forSkill), the route answers 404, and the chat is exactly what it was.
 */
export function milaCardsV2Enabled(): boolean {
  return process.env.MILA_CARDS_V2 === "true";
}

const DAY = 86_400_000;

export const MILA_CARDS = {
  /** Insight: the same angle (or the same facts) is not shown again within 14 days. */
  insightRepeatMs: 14 * DAY,
  /** Ideas: at most one set per chat per day. */
  ideasPerChatMs: 1 * DAY,
  /** Idea "Not now": the item rests 14 days. */
  ideaNotNowMs: 14 * DAY,
  /** A made post's "Not now" (card content): it rests out of the Ready queue 14 days, still open. */
  contentNotNowMs: 14 * DAY,
  /** Idea "Don't suggest this": the idea and its pillar pause 30 days (decision 14). */
  pillarPauseMs: 30 * DAY,
  /** Turn-on "Not now": 14 → 30 → 60 → 90 days. */
  turnOnCooldownDays: [14, 30, 60, 90] as const,
  /** At most one new offer in 24 h. */
  turnOnGapMs: 1 * DAY,
  /** One-time question: one more ask after 30 days with no answer, then never (≤ 2 asks). */
  onceRetryMs: 30 * DAY,
  onceMaxAsks: 2,
  /** A card shown and not touched for 7 days is ignored (decision 12). */
  ignoredAfterMs: 7 * DAY,
} as const;

/** The memory_decisions skill ids the cards write (no new table, no migration: decision 12). */
export const CARD_SKILLS = {
  insight: "insight",
  answer: "mila-cards/answer",
  once: "mila-cards/once",
  turnOn: "mila-cards/turn-on",
  pillarPause: "mila-cards/pillar-pause",
} as const;
