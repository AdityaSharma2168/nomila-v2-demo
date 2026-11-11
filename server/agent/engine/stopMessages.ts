/**
 * agent/engine/stopMessages.ts — what Mila says when a turn stops before it answered (a cap, the step limit, an error).
 * Shared by the Mastra turn and the voice routes. Moved from the old harness
 * (5 Nov 2026; the harness was deleted in Mastra-only PR 2). Prompt Register: athlete-facing, fixed text.
 */
import type { StopReason } from "../../../shared/agent";

export const STOP_MESSAGES: Record<StopReason, string> = {
  cost_cap_run: "I stopped here: this question reached its spending limit. Try a narrower question.",
  cost_cap_day: "I've reached today's limit for your account. I'll be able to pick this up tomorrow.",
  max_steps: "I hit my step limit before finishing. Try asking again, or narrow the question down.",
  policy: "I can't do that.",
  aborted: "",
  error: "Something went wrong on my side. Try again in a moment.",
};
