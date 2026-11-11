/**
 * statusLabels.ts — friendly, context-aware loading phrases for the chat status
 * line (the "…" the athlete sees while a turn is working).
 *
 * The loop streams one of these via `sse.status(...)` per iteration: the phrase
 * for the tool(s) it's about to run, or DEFAULT_STATUS ("Thinking…") while it's
 * deciding / generating a no-tool answer. Purely presentational — nothing here
 * affects the answer, tool choice, or tenancy.
 *
 * NOTE ON WEB SEARCH: there is deliberately no "Searching the web…" phrase.
 * Gemini's googleSearch is a BUILT-IN tool the model runs internally — it is
 * never a functionCall the loop sees, and its groundingMetadata rides in with
 * the answer chunks (after tokens start), so there's no pre-emptive signal to
 * key a loading status off. Rather than fake one, we omit it (see grounding.ts).
 */

/** tool name → the phrase shown while that tool runs. Unlisted tools fall back
 *  to DEFAULT_STATUS. Keep these short, warm, and first-person-agent in voice. */
export const TOOL_STATUS: Record<string, string> = {
  list_deals: "Pulling up your deals…",
  get_deal: "Opening that deal…",
  get_score: "Checking your score…",
  get_profile: "Looking at your profile…",
  get_rate_card: "Checking your floor…",
  get_analytics: "Reading your analytics…",
  list_tasks_threads: "Checking your inbox…",
  get_brand: "Researching the brand…",
  get_brand_fit: "Sizing up the fit…",
  draft_reply: "Drafting your reply…",
  navigate: "Finding that screen…",
  get_help: "Figuring out the app…",
};

/** Shown while the model is thinking (no tools yet) and as the fallback for any
 *  tool without a mapped phrase. */
export const DEFAULT_STATUS = "Thinking…";

/**
 * The status phrase for a round's tool calls. Returns the first MAPPED tool's
 * phrase (so a round is labelled by a tool it can actually describe, even if an
 * unmapped tool leads the batch), and DEFAULT_STATUS when the round runs no
 * tools or none of them are mapped.
 */
export function statusForCalls(toolNames: string[]): string {
  for (const name of toolNames) {
    const phrase = TOOL_STATUS[name];
    if (phrase) return phrase;
  }
  return DEFAULT_STATUS;
}
