/**
 * agent/evals/offline/cardChoice.cases.ts — "did Mila pick the right card?" (design "Mila card designs" v2.2, "Build
 * plan and evals"), as OFFLINE fixtures. Each case is a situation (what the athlete said, or a proactive turn, and what
 * the context holds) and what is expected: the card tool Mila should call (or none), and checks on the card.
 *
 * COPIED from #1193 (feat/mila-cards-v2, server/agent/evals/milaCards.cases.ts) on 3 Nov 2026, while #1193 is open: the
 * eleven cases verbatim, plus the scripted model output per case (CARD_CHOICE_RECORDED) and the tool → card map those
 * tools make (CARD_TOOL_CARDS: #1193 is merged, and cardChoice.test.ts pins this table and the headline budget to the
 * real MILA_TOOL_CARDS and CARD_TEXT; this file and milaCards.cases.ts can still
 * become one). Nothing here calls a model; `npm run evals:live` is the paid
 * run, by hand only. Every athlete, brand and number is made up.
 */
export type CardTool = "share_insight" | "ideas_suggest" | "offer_capability" | "ask_once" | "answer_with_sources" | "none";

export interface CardEvalCase {
  id: string;
  situation: string;
  /** The athlete's message; null = a proactive turn. */
  message: string | null;
  /** What the context holds (facts, the idea bank, choices) — for the runner's in-memory store. */
  given: {
    facts?: Array<{ key: string; claim: string; source: string }>;
    ideas?: Array<{ hook: string; faces: boolean }>;
    capabilities?: Record<string, "unset" | "not_now" | "never" | "enabled">;
    webResults?: Array<{ title: string; url: string }>;
    priorOffers?: number;
  };
  expect: {
    tool: CardTool;
    /** The card the tool must make, or none. */
    card: "insight" | "ideas" | "turn-on" | "quick-question" | "answer" | null;
    checks: string[];
  };
}

export const CARD_EVAL_CASES: readonly CardEvalCase[] = [
  {
    id: "proactive-saves-up", situation: "Proactive turn; facts show saves +96%", message: null,
    given: { facts: [{ key: "F1", claim: "Reel saves were 1940 in October, up 96% from 990 in September.", source: "https://instagram.com/insights" }] },
    expect: { tool: "share_insight", card: "insight", checks: ["media.kind = chart", "headline ≤ 8 words", "sources ≥ 1"] },
  },
  {
    id: "how-did-reels-do", situation: "\"How did my reels do?\"", message: "How did my reels do?",
    given: { facts: [{ key: "F1", claim: "Reel saves were 1940 in October, up 96% from 990 in September.", source: "https://instagram.com/insights" }] },
    expect: { tool: "answer_with_sources", card: "answer", checks: ["more.kind = stats", "not an insight card (they asked)"] },
  },
  {
    id: "what-to-post", situation: "\"What should I post?\" with 3 live bank ideas", message: "What should I post this week?",
    given: { ideas: [{ hook: "Game-day routine in 15 seconds", faces: true }, { hook: "Five serves, slowed down", faces: true }, { hook: "Your locker room playlist, as a story", faces: true }] },
    expect: { tool: "ideas_suggest", card: "ideas", checks: ["items = 3", "the text mentions only the first idea"] },
  },
  {
    id: "all-faces", situation: "Bank ideas whose frames all show their face", message: "Give me some post ideas",
    given: { ideas: [{ hook: "Game-day routine", faces: true }, { hook: "Five serves", faces: true }, { hook: "Locker room playlist", faces: true }] },
    expect: { tool: "ideas_suggest", card: "ideas", checks: ["the third thumbnail is face-free or atmosphere (≤ 2 faces)"] },
  },
  {
    id: "after-game-unset", situation: "\"I never know what to post after a game\" (post ideas unset)", message: "I never know what to post after a game.",
    given: { capabilities: { post_ideas: "unset" } },
    expect: { tool: "offer_capability", card: "turn-on", checks: ["capability = post_ideas", "sheet rows = 3", "nothing turned on"] },
  },
  {
    id: "yes-typed", situation: "\"Yes, turn it on\" typed", message: "Yes, turn it on",
    given: { capabilities: { post_ideas: "unset" } },
    expect: { tool: "offer_capability", card: "turn-on", checks: ["the card is shown for the tap", "the reply never says it is on"] },
  },
  {
    id: "second-product-only", situation: "Second product-only offer, no rule", message: "Kitewear just offered me free product again. What do I do?",
    given: {},
    expect: { tool: "ask_once", card: "quick-question", checks: ["once.choices 2–4", "media = the two brands' logos", "no option sends"] },
  },
  {
    id: "is-cobaltwave-legit", situation: "\"Is Cobaltwave legit?\" with web results", message: "Is Cobaltwave Hydration legit? Who have they worked with?",
    given: { webResults: [{ title: "Cobaltwave press", url: "https://cobaltwave.example/press" }, { title: "College Sports Daily", url: "https://collegesportsdaily.example/refill" }] },
    expect: { tool: "answer_with_sources", card: "answer", checks: ["brand = Cobaltwave Hydration (logo/cover)", "a domain chip", "every URL from this turn"] },
  },
  {
    id: "long-headline", situation: "Model writes a 14-word headline", message: "Is Cobaltwave Hydration legit?",
    given: { webResults: [{ title: "Cobaltwave press", url: "https://cobaltwave.example/press" }] },
    expect: { tool: "answer_with_sources", card: "answer", checks: ["the first call is refused (headline > 48)", "Mila retries within budget"] },
  },
  {
    id: "image-url", situation: "Model passes an image URL", message: "Is Cobaltwave Hydration legit?",
    given: { webResults: [{ title: "Cobaltwave press", url: "https://cobaltwave.example/press" }] },
    expect: { tool: "answer_with_sources", card: "answer", checks: ["the URL field is stripped", "media resolved by the server"] },
  },
  // Added 6 Nov 2026 (dev verification): asked for an insight as a card, Mila never reached for share_insight; asked for
  // a reply draft while draft replies was off, Mila claimed it could instead of offering it.
  {
    id: "asks-insight-as-card", situation: "\"What am I missing? Show it to me as a card.\" with a sourced change on record", message: "What am I missing in my numbers? Show it to me as a card.",
    given: { facts: [{ key: "F1", claim: "Reel saves were 1940 in October, up 96% from 990 in September.", source: "https://instagram.com/insights" }] },
    expect: { tool: "share_insight", card: "insight", checks: ["fact keys looked up first", "sources ≥ 1", "not answer_with_sources (they asked for an insight)"] },
  },
  {
    id: "draft-reply-off", situation: "\"Can you draft a reply?\" while draft replies is off (mailbox connected)", message: "Can you draft a reply to the Northpeak email?",
    given: { capabilities: { draft_replies: "unset" } },
    expect: { tool: "offer_capability", card: "turn-on", checks: ["capability = draft_replies", "the reply never says it can draft or drafted"] },
  },
  {
    id: "nothing-found", situation: "Web search finds nothing", message: "Has Zephyrline Socks ever sponsored a volleyball player?",
    given: { webResults: [] },
    expect: { tool: "none", card: null, checks: ["words only, no card"] },
  },
];

/** The card each card tool makes (#1193's MILA_TOOL_CARDS rows for these tools). */
export const CARD_TOOL_CARDS: Readonly<Record<Exclude<CardTool, "none">, readonly NonNullable<CardEvalCase["expect"]["card"]>[]>> = {
  share_insight: ["insight"],
  ideas_suggest: ["ideas"],
  offer_capability: ["turn-on"],
  ask_once: ["quick-question"],
  answer_with_sources: ["answer"],
};

/** #1193's text budget for a card headline (CARD_TEXT.headline): longer is refused and Mila retries. */
export const CARD_HEADLINE_MAX = 48;

/**
 * One model turn's card choice: the card tool calls it made, in order, each with the headline it passed and whether the
 * server refused it. SCRIPTED (written to the design page's expectations, not captured from a model): they pin what the
 * grader accepts, and the paid run grades a live turn the same way.
 */
export interface CardChoiceOutput {
  calls: Array<{ tool: Exclude<CardTool, "none">; card: NonNullable<CardEvalCase["expect"]["card"]>; headline: string; refused?: "headline_too_long" }>;
}

export const CARD_CHOICE_RECORDED: Readonly<Record<string, CardChoiceOutput>> = {
  "proactive-saves-up": { calls: [{ tool: "share_insight", card: "insight", headline: "Your reel saves nearly doubled" }] },
  "how-did-reels-do": { calls: [{ tool: "answer_with_sources", card: "answer", headline: "Reels: saves up 96% in October" }] },
  "what-to-post": { calls: [{ tool: "ideas_suggest", card: "ideas", headline: "Three posts for this week" }] },
  "all-faces": { calls: [{ tool: "ideas_suggest", card: "ideas", headline: "Post ideas from your bank" }] },
  "after-game-unset": { calls: [{ tool: "offer_capability", card: "turn-on", headline: "Post ideas from your camera roll" }] },
  "yes-typed": { calls: [{ tool: "offer_capability", card: "turn-on", headline: "Turn on camera roll ideas?" }] },
  "second-product-only": { calls: [{ tool: "ask_once", card: "quick-question", headline: "Free product offers: your rule?" }] },
  "is-cobaltwave-legit": { calls: [{ tool: "answer_with_sources", card: "answer", headline: "Cobaltwave looks like a real brand" }] },
  "long-headline": { calls: [
    { tool: "answer_with_sources", card: "answer", headline: "Cobaltwave Hydration appears to be a legitimate and established sports drink company", refused: "headline_too_long" },
    { tool: "answer_with_sources", card: "answer", headline: "Cobaltwave looks legit" },
  ] },
  "image-url": { calls: [{ tool: "answer_with_sources", card: "answer", headline: "Cobaltwave looks legit" }] },
  "asks-insight-as-card": { calls: [{ tool: "share_insight", card: "insight", headline: "Your reel saves nearly doubled" }] },
  "draft-reply-off": { calls: [{ tool: "offer_capability", card: "turn-on", headline: "Draft replies to brands" }] },
  "nothing-found": { calls: [] },
};
