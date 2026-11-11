/**
 * agent/evals/milaCards.cases.ts — "did Mila pick the right card?" (design "Mila card designs" v2.2, "Build plan and
 * evals"), as OFFLINE fixtures. Each case is a situation (what the athlete said, or a proactive turn, and what the
 * context holds) and what is expected: the card tool Mila should call (or none), and checks on the card.
 *
 * Nothing here calls a model. `scripts/run-card-eval.ts` can play the cases against the real chat turn, but only when run
 * by hand with --paid (it is never run by CI or `npm test`); milaCards.cases.test.ts only checks the cases are well
 * formed and that the server-side rules they lean on hold. Every athlete, brand and number is made up.
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
    id: "after-game-unset", situation: "\"I never know what to post after a game\" (camera-roll ideas unset)", message: "I never know what to post after a game.",
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
  {
    id: "nothing-found", situation: "Web search finds nothing", message: "Has Zephyrline Socks ever sponsored a volleyball player?",
    given: { webResults: [] },
    expect: { tool: "none", card: null, checks: ["words only, no card"] },
  },
];
