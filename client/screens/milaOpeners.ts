/**
 * milaOpeners.ts — the fresh-chat empty-state content for Ask Mila, chosen by the
 * launching screen's context. Pure (no React/RN), so it unit-tests without the
 * screen. Two siblings, both keyed off MilaContext["type"]:
 *   - openersFor  → the tappable suggestion rows (PR-6.5 scaffolding, moved here)
 *   - greetingFor → the single greeting line at the top of a fresh chat
 *
 * Presentational only: nothing here calls a tool, touches the loop, or affects
 * safety. The keys are the exact MilaContext["type"] values contextForTab emits
 * (deals-list, brand, studio, profile) plus the forward-looking item contexts
 * (score, deal); because the maps are typed by that union, a typo is a compile
 * error, never a silent fall-through to the default.
 */

import type { MilaContext } from "../hooks/use-mila-chat";
import { AGENT_DEALS_TOOLS, AGENT_V3 } from "../lib/flags";

// ─── Openers (tappable suggestion rows) ─────────────────────────────────────────

// The default set runs when the chat is opened with no launch context; otherwise
// the set is chosen by context TYPE (never per specific deal/item).
export const DEFAULT_OPENERS = [
  "Find my top deal",
  "What's expiring soon?",
  "Paid deals over $5K",
  "How much do I have in play?",
  "Show my best brand fit",
];

export const OPENERS_BY_CONTEXT: Partial<
  Record<MilaContext["type"], string[]>
> = {
  "deals-list": [
    "Which deal should I prioritize?",
    "What's expiring soon?",
    "Any deal I should pass on?",
    "How much do I have in play?",
  ],
  brand: [
    "How's my score looking?",
    "What's my strongest capital?",
    "What should I focus on to grow?",
    "What's my best brand fit?",
  ],
  score: [
    "How do I raise my score?",
    "What's my weakest capital?",
    "What's dragging my score down?",
    "How's my score trending?",
  ],
  studio: [
    "What should I pitch next?",
    "Which brands fit me best?",
    "Help me plan a media kit",
    "Who should I follow up with?",
  ],
  profile: [
    "What are my current rates?",
    "How do I raise my score?",
    "Is my profile missing anything?",
    "What's my rate for a post?",
  ],
  deal: [
    "Is this a good offer?",
    "What should I counter with?",
    "What am I missing on this deal?",
    "How does this compare to my others?",
  ],
  // The first entry auto-opens with "Hi Mila." — no rows to tap before she speaks.
  onboarding: [],
};

// ─── Honest openers on the new agent (AGENT_V3) ─────────────────────────────────
// The rows above are the old loop's, which has deal tools. On the new agent Mila may only offer what she can do: no
// deal row until her deal tools are on (AGENT_DEALS_TOOLS), and then the deal rows are the ones those tools answer.

/** The new agent without deal tools: goals, the plan, her read — never a deal. */
export const AGENT_DEFAULT_OPENERS = [
  "What should I focus on this month?",
  "Plan my week",
  "How's my M.I.A. looking?",
  "What should I post next?",
];

/** The new agent with deal tools: what the deals toolset answers. */
export const AGENT_DEAL_OPENERS = [
  "What needs me?",
  "What's waiting for my tap?",
  "Any deal I should pass on?",
  "What's waiting on brands?",
];

/** Opened from one deal: about THAT deal (the chat starts with OPENED FROM deal <id>). */
export const AGENT_ONE_DEAL_OPENERS = [
  "Is this worth it?",
  "What should I ask for?",
  "Draft a reply",
  "Tell them no, nicely",
];

export function openersFor(context?: MilaContext, flags: { agentV3: boolean; dealsTools: boolean } = { agentV3: AGENT_V3, dealsTools: AGENT_DEALS_TOOLS }): string[] {
  if (flags.agentV3) {
    if (context?.type === "onboarding") return [];
    if (!flags.dealsTools) return AGENT_DEFAULT_OPENERS;
    if (context?.type === "deal") return AGENT_ONE_DEAL_OPENERS;
    if (context?.type === "deals-list" || !context) return AGENT_DEAL_OPENERS;
    return AGENT_DEFAULT_OPENERS;
  }
  return (context && OPENERS_BY_CONTEXT[context.type]) || DEFAULT_OPENERS;
}

// ─── Greeting (the single top line of a fresh chat) ─────────────────────────────

// Shown when the chat is opened from home / an unmapped screen / no context. Also
// the fallback for any context type without its own line — so the greeting is
// never blank.
// A composer greeting, not a search box's: no "about your deals" — she does more than deals.
export const DEFAULT_GREETING = "What can I do for you?";

// The deal greeting needs the brand name, so it's built in greetingFor (below),
// not a static entry here. brand + score both map to the score line: the Brand
// tab is the reachable score surface, and the item-level "score" context is
// forward-looking (no launcher emits it yet, like the deal/score openers above).
const GREETING_BY_CONTEXT: Partial<Record<MilaContext["type"], string>> = {
  "deals-list": "Want to go over your deals?",
  brand: "Curious about your score?",
  score: "Curious about your score?",
  onboarding: "Hi, I'm Mila.",
};

export function greetingFor(context?: MilaContext, flags: { agentV3: boolean; dealsTools: boolean } = { agentV3: AGENT_V3, dealsTools: AGENT_DEALS_TOOLS }): string {
  if (!context) return DEFAULT_GREETING;
  // The new agent without deal tools never opens on deals it can't talk about.
  if (flags.agentV3 && !flags.dealsTools && (context.type === "deal" || context.type === "deals-list")) return DEFAULT_GREETING;
  if (context.type === "deal") {
    // Fall back on absent AND blank/whitespace brandName, so we never render the
    // malformed "Questions about the  deal?".
    const brand = context.brandName?.trim();
    return brand
      ? `Questions about the ${brand} deal?`
      : "Questions about this deal?";
  }
  return GREETING_BY_CONTEXT[context.type] ?? DEFAULT_GREETING;
}

/** The line under the greeting. Deals are named only where Mila can talk about them. */
export function emptySubtitleFor(flags: { agentV3: boolean; dealsTools: boolean } = { agentV3: AGENT_V3, dealsTools: AGENT_DEALS_TOOLS }): string {
  if (flags.agentV3 && !flags.dealsTools) return "Your goals, your plan, your next post — ask, or just talk.";
  return "Your deals, your score, your next pitch — ask, or just talk.";
}
