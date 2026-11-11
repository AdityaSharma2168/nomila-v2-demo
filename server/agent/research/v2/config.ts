/**
 * agent/research/v2/config.ts — the narrow research pipeline (plan → discover → fetch + clean → rank → extract), run as
 * a SHADOW beside today's two web-search passes. Owner, 25 Oct 2026: build it now, prove it on dev, and only let it
 * change what athletes get once it beats today's research on facts, wrong-person mistakes, sources, time and cost.
 *
 * Why (Karpathy, "web sludge"; Anthropic and OpenAI deep research): a model that searches and reads whole pages itself
 * spends most of its tokens filtering menus and boilerplate. Here code fetches a few pages, strips them to their
 * article text, keeps only the passages about this athlete, and the model reasons over those alone.
 *
 * RESEARCH_PIPELINE_V2_SHADOW exactly "true" turns the shadow on (dev config only). It never writes the athlete's
 * record or score: its output stays on its own workflow run (research_v2_shadow) for comparison.
 */

export function researchV2ShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RESEARCH_PIPELINE_V2_SHADOW === "true";
}

/** The discovery provider: OpenAI web search, the one search provider (owner, 4 Nov 2026). The Gemini Google Search
 *  grounding arm and its RESEARCH_V2_DISCOVER switch were removed then; the id stays on each shadow run's output so
 *  older runs (provider "gemini_grounding") still read as what they were. */
export type DiscoverProviderId = "openai_search";

export function discoverProviderOf(): DiscoverProviderId {
  return "openai_search";
}

/** The page cleaner: Defuddle (default since the 26 Oct 2026 dev comparison: 82 vs 71 facts, 30 vs 23 sources, 1 vs 3
 *  "couldn't confirm" on the same 10 athletes) or Mozilla Readability (RESEARCH_V2_CLEANER exactly "readability"). */
export type CleanerId = "readability" | "defuddle";

export function cleanerOf(env: NodeJS.ProcessEnv = process.env): CleanerId {
  return env.RESEARCH_V2_CLEANER === "readability" ? "readability" : "defuddle";
}

/** The pipeline's caps. Small on purpose: the point is to send the model less, not more. */
export const V2 = {
  /** Targeted queries per athlete (the plan step). Sign-up plans 5–6 (overlapping ones merged): each planned query is a
   *  paid web search, so recall comes from reading found pages fully and following their links, not more searches. */
  maxQueries: 7,
  /** Result links kept per query before de-duplication. */
  resultsPerQuery: 8,
  /** Pages fetched per athlete. Most found pages are read (the comparison read ~8 of 12–21 and missed the athlete's own
   *  coverage); the passage budget below, not the page count, is what caps the tokens sent to the model. */
  maxFetch: 20,
  /** Pages fetched at once. */
  fetchConcurrency: 6,
  /** Per-page fetch timeout. */
  fetchTimeoutMs: 10_000,
  /** Largest page body read; anything bigger is cut there. */
  maxPageBytes: 2_000_000,
  /** A cleaned page with less article text than this is treated as script-only (nothing readable without a browser). */
  minCleanChars: 400,
  /** Same-site links followed from the athlete's official pages to their own roster / bio / stats pages (our fetcher,
   *  robots.txt respected) instead of paying for more searches. */
  maxFollow: 4,
  /** A page about the athlete (its title, URL or structured data names them, and it is anchored) is sent WHOLE, up to
   *  this many characters: roster and bio pages name the athlete once, then list stats and honours in rows that never
   *  repeat the name, which name-only passages lose. */
  wholePageChars: 12_000,
  /** Share of maxPassageChars whole athlete pages may take, so passages from other pages (match reports) still fit. */
  wholePagesShare: 0.75,
  /** One passage: a few paragraphs, about this many characters. */
  passageChars: 1_200,
  /** Passages kept after ranking (all pages together). */
  maxPassages: 24,
  /** Total characters of passages sent to the extract step (~4 characters per token → ~12k tokens). */
  maxPassageChars: 48_000,
  /** The user agent our fetcher identifies as; robots.txt rules for it (or for *) are respected. */
  userAgent: "NomilaResearchBot/1.0 (+https://nomila.co)",
} as const;
