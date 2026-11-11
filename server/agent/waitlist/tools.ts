/**
 * agent/waitlist/tools.ts (moved from agent/tf/waitlistTools.ts, 8 Nov 2026) — Mila's three tools while she hosts the waitlist join flow (MILA_TF_WAITLIST, dev only;
 * docs/design/mila-hosted-waitlist.md). Registered in the app registry (coreTools.ts), so a pass whose skill lists them
 * (jobs/waitlist.md) sees them; while the flag is off they are left out of every run (enabled()).
 *
 *   waitlist_status     read   her real waitlist state (state.ts): research, live stage, score, accounts, spot
 *   start_research      draft  start her sign-up research, or join the run already going (idempotent: the runner's key
 *                              signup_research:<id>; the sport tap normally started it already)
 *   show_waitlist_card  read   ask the landing to show one of its EXISTING cards again; `shown` only when her real state
 *                              allows it, as a code-built `waitlist-card` (never drawn from model prose)
 *
 * Deliberately NOT a tool: confirming or rejecting an account. That is her tap on the handle rows only (POST
 * /api/v1/waitlist/handles/:platform), never the model's.
 *
 * Prompt Register: the three descriptions below (exact text), "Mila & agent" → tools, 1.0.0.
 */
import { z } from "zod";
import { WAITLIST_CARDS, type ChatCard, type WaitlistCard } from "../../../shared/agent";
import { errorResult, okResult, type AgentTool } from "../tools";
import { milaWaitlistEnabled } from "../engine/config";
import { cardAvailability, readWaitlistState, STATE_WORDS, type WaitlistStateDeps } from "./state";

export const WAITLIST_STATUS_TOOL = "waitlist_status";
export const START_RESEARCH_TOOL = "start_research";
export const SHOW_WAITLIST_CARD_TOOL = "show_waitlist_card";
export const WAITLIST_TOOL_NAMES = [WAITLIST_STATUS_TOOL, START_RESEARCH_TOOL, SHOW_WAITLIST_CARD_TOOL] as const;

export const WAITLIST_STATUS_DESCRIPTION =
  "Read the athlete's waitlist status from Nomila's records right now: their research (state, what it is doing now, " +
  "which steps are done), their M.I.A. score (none yet, the quick score or the full score, with its value of 850 and " +
  "confidence), the Instagram or YouTube accounts research found and whether they confirmed each, how many sourced " +
  "facts were found, and their spot on the list. Free, reads only. " +
  "Use it before you say anything about their progress that CONTEXT does not already state, or when they ask how it " +
  "is going, how long it takes, or what you found. " +
  "Don't use it to guess what comes next: say only what it returns, and when a step is still running, say so.";

export const START_RESEARCH_DESCRIPTION =
  "Start the athlete's sign-up research (Nomila reads public pages about them, keeps the facts it can check, then works " +
  "out their M.I.A. score), or join the research already running. Safe to repeat: it never starts a second run. Sends " +
  "nothing outside Nomila. " +
  "Use it only when CONTEXT or waitlist_status says research has not started and their sport is saved. " +
  "Don't use it when research is running, queued, done or waiting for more detail (it will say so), and never to look " +
  "anyone else up. " +
  "Returns outcome started (new), already_running, queued (it starts when there is room today, by tomorrow at the " +
  "latest), done, or not started with a reason: no_sport (ask them to pick their sport on the sport card), no_name, " +
  "needs_more (no public trace yet: a team or Instagram helps), or another reason to say plainly.";

export const SHOW_WAITLIST_CARD_DESCRIPTION =
  "Ask the page to show one of the waitlist's own cards under your reply. card is one of: sport (pick what they play), " +
  "is_this_you (the profile match Nomila found), handles (the accounts research found, with That's me / Not me), score " +
  "(their M.I.A. score), invite (their share card and link for their team). " +
  "Use it when they ask to see one of these again or to go to that step (\"show me my score\", \"where do I invite my " +
  "team\"). The page already shows each card at its step by itself, so don't call it for a card that was just shown. " +
  "Returns shown true (the card is on screen: point to it in one line, don't repeat what it says) or shown false with " +
  "the reason (say it plainly, e.g. the score is not ready yet). You never answer a card for them: their taps on it " +
  "are theirs.";

export function waitlistTools(deps: WaitlistStateDeps & { startResearch?: (athleteId: string) => Promise<any>; enabled?: () => boolean } = {}): AgentTool[] {
  const enabled = deps.enabled ?? milaWaitlistEnabled;

  const status: AgentTool = {
    name: WAITLIST_STATUS_TOOL, description: WAITLIST_STATUS_DESCRIPTION, kind: "ours", permission: "read", enabled,
    args: z.object({}),
    async execute(ctx) {
      const s = await readWaitlistState(ctx.athleteId, deps);
      return okResult({
        research: { state: s.research.state, meaning: STATE_WORDS[s.research.state] ?? s.research.state, now: s.research.live, steps: s.research.steps, ...(s.research.reason ? { why: s.research.reason } : {}) },
        score: s.score.stage === "none" ? { shown: "none yet", full_score: s.score.full } : { shown: s.score.stage === "quick" ? "quick score" : "full score", value: s.score.value, of: 850, confidence: s.score.confidence, full_score: s.score.full },
        accounts: s.handles.map((h) => ({ platform: h.platform, handle: h.handle, confirmed_by_them: h.status === "confirmed" })),
        facts_found: s.findings,
        spot: s.spot,
        sport: s.athlete.sport,
        team: s.athlete.team,
      });
    },
  };

  const start: AgentTool = {
    name: START_RESEARCH_TOOL, description: START_RESEARCH_DESCRIPTION, kind: "ours", permission: "draft", enabled,
    args: z.object({}),
    async execute(ctx) {
      const s = await readWaitlistState(ctx.athleteId, deps);
      if (!s.athlete.sport) return okResult({ started: false, reason: "no_sport" });
      if (s.research.state === "needs_more") return okResult({ started: false, reason: "needs_more", why: s.research.reason });
      if (s.research.state === "done") return okResult({ started: false, reason: "done" });
      const { signupResearchAgentEnabled } = await import("../onboarding/signupResearch");
      if (!deps.startResearch && !signupResearchAgentEnabled()) return errorResult("research cannot be started from here on this server");
      const r = await (deps.startResearch ?? (async (id: string) => (await import("../onboarding/footprintCheck")).startSignupResearchChecked(id, { createdBy: "signup" })))(ctx.athleteId);
      if (!r?.started) return okResult({ started: false, reason: r?.reason === "no_footprint" ? "needs_more" : String(r?.reason ?? "unknown") });
      if (r.queued) return okResult({ started: true, outcome: "queued", run_id: r.runId });
      return okResult({ started: true, outcome: r.created ? "started" : "already_running", run_id: r.runId });
    },
  };

  const show: AgentTool = {
    name: SHOW_WAITLIST_CARD_TOOL, description: SHOW_WAITLIST_CARD_DESCRIPTION, kind: "ours", permission: "read", enabled,
    args: z.object({ card: z.enum(WAITLIST_CARDS).describe("Which card: sport, is_this_you, handles, score or invite.") }),
    async execute(ctx, a: { card: WaitlistCard }) {
      const s = await readWaitlistState(ctx.athleteId, deps);
      const v = cardAvailability(a.card, s);
      return v.shown ? okResult({ card: a.card, shown: true }) : okResult({ card: a.card, shown: false, reason: v.reason });
    },
    card(result, ctx): ChatCard | null {
      const r = result as { card?: WaitlistCard; shown?: boolean };
      if (!r.shown || !r.card) return null;
      return { id: `waitlist:${ctx.runId}:${r.card}`, kind: "waitlist-card", title: r.card, payload: { card: r.card }, links: [], runId: ctx.runId };
    },
  };

  return [status, start, show];
}
