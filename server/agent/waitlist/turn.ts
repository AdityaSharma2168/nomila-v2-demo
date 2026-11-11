/**
 * agent/waitlist/turn.ts (moved from agent/tf/waitlistTurn.ts, 8 Nov 2026) — one Mila turn while she hosts the landing's waitlist join flow (MILA_TF_WAITLIST, dev only;
 * docs/design/mila-hosted-waitlist.md). The same path as the chat (agent/engine runMilaTurn, on Mastra), with:
 *
 *   conversation  ONE per athlete, a fixed id derived from hers (waitlistConversationId), so the waitlist turns and later
 *                 her agent_onboarding turns (onboarding/milaTurn.ts) share one session (its Mastra thread): Mila remembers
 *   skill         "waitlist" (jobs/waitlist.md): the pass sees waitlist_status, start_research and show_waitlist_card,
 *                 scopes read · draft
 *   input         <app_updates> the moment's line (fixed text below) · the waitlist surface (and the playbook on the
 *                 session's first turn) · <context> her real waitlist state (state.ts) · ATHLETE MESSAGE
 *   cards         every card goes out on `done` (the landing draws waitlist-cards with its own code); waitlist-cards are
 *                 never saved to the chat history (the app does not draw them)
 *
 * A moment turn carries no message of hers: no chat row is written for her. Every step and tap stays the landing's
 * code-built card and our endpoints; nothing here decides a step is done.
 *
 * Prompt Register: "Mila on TrueForge — waitlist moments" (WAITLIST_MOMENT_LINES, exact text) and the playbook wrapper
 * (PLAYBOOK_TAG with name="waitlist", built by the shared wrapTagged).
 */
import { createHash } from "node:crypto";
import { tagOpen, wrapTagged } from "../../lib/externalContent";
import type { SSEStream } from "../../lib/sse";
import { readPlaybook } from "../mila/build";
import { readSurface, type MilaTextEngine } from "../mila/load";
import { runMilaTurn } from "../engine";
import { readWaitlistState, waitlistContextText, type WaitlistStateDeps } from "./state";

import { WAITLIST_SKILL_ID, type MilaTurnDeps, type TurnResult } from "../engine/turnTypes";
export { WAITLIST_SKILL_ID };
export const WAITLIST_SCOPES = ["read", "draft"] as const;

export const WAITLIST_MOMENTS = ["hello", "research_started", "handles_found", "score_quick", "score_final", "invite"] as const;
export type WaitlistMoment = (typeof WAITLIST_MOMENTS)[number];
export const isWaitlistMoment = (x: unknown): x is WaitlistMoment => typeof x === "string" && (WAITLIST_MOMENTS as readonly string[]).includes(x);

/** What each moment means, in our words (the page shows the card; Mila talks around it). Prompt Register, exact text. */
export const WAITLIST_MOMENT_LINES: Record<WaitlistMoment, string> = {
  hello: "Moment hello: the athlete has just signed in to join the waitlist. Under your reply the page shows the sport card, where they pick what they play.",
  research_started: "Moment research_started: their sport is saved and Nomila has started their research. Under your reply the page shows the live research status.",
  handles_found: "Moment handles_found: research found Instagram or YouTube accounts that may be theirs. Under your reply the page shows them with That's me and Not me.",
  score_quick: "Moment score_quick: their quick M.I.A. score is ready. Under your reply the page shows it; the full score is still being worked out.",
  score_final: "Moment score_final: their full M.I.A. score is ready. Under your reply the page shows it, in place of the quick score.",
  invite: "Moment invite: they opened the invite card. Under your reply the page shows their M.I.A. card and their own link to share with their team.",
};

export const PLAYBOOK_TAG = "playbook";
/** How the playbook block opens (tests and the register match on it). */
export const PLAYBOOK_OPEN = tagOpen(PLAYBOOK_TAG).replace(">", ' name="waitlist">');

/** The athlete's one waitlist conversation: a fixed UUID (v4 layout) derived from her id. */
export function waitlistConversationId(athleteId: string): string {
  const h = createHash("sha256").update(`nomila:waitlist-conversation:${athleteId}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The waitlist surface as built (comments out), for the top of every waitlist turn, in the words of the turn's engine. */
export function waitlistSurfaceText(engine: MilaTextEngine = "mastra"): string {
  return readSurface("waitlist", undefined, engine);
}

/** The preface: the surface every turn; the playbook too when the turn opens a session (its Mastra thread). */
export function waitlistPreface(isNew: boolean, engine: MilaTextEngine = "mastra"): string[] {
  return [waitlistSurfaceText(engine), ...(isNew ? [wrapTagged(readPlaybook("waitlist").trim(), PLAYBOOK_TAG, { name: "waitlist" }, { newlines: true })] : [])];
}

export async function runWaitlistTurn(
  p: { athleteId: string; moment: WaitlistMoment | null; message: string | null; sse: SSEStream },
  deps: MilaTurnDeps & { state?: WaitlistStateDeps } = {},
): Promise<TurnResult> {
  const now = deps.now ?? (() => new Date());
  return runMilaTurn(
    { athleteId: p.athleteId, message: p.message, conversationId: waitlistConversationId(p.athleteId), sse: p.sse },
    deps,
    {
      skillId: WAITLIST_SKILL_ID,
      scopes: WAITLIST_SCOPES,
      trigger: p.moment ? "event" : "chat",
      updates: p.moment ? [WAITLIST_MOMENT_LINES[p.moment]] : [],
      preface: ({ isNew, engine }) => waitlistPreface(isNew, engine),
      context: async () => waitlistContextText(await readWaitlistState(p.athleteId, deps.state), now()),
      keepInHistory: (c) => c.kind !== "waitlist-card",
    },
  );
}
