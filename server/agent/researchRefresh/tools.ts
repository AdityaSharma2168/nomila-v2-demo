/**
 * agent/researchRefresh/tools.ts — refresh_research, Mila's one research tool (owner, 26 Oct 2026), modelled on
 * refresh_plan (agent/plan/tools.ts). It asks the workflow runner for a lean research refresh of the athlete
 * (researchRefresh/leanRefresh.ts requestLeanRefresh: the same lean pipeline sign-up uses) and returns a short status;
 * the run goes on in the background and the chat turn never waits for it.
 *
 * Permission "draft": it starts our own runner workflow and sends nothing outside Nomila (no message, no post, no
 * payment). Takes no athlete id: the athlete is the run's (or the MCP pass's). Behind LEAN_SIGNUP_RESEARCH: while it is
 * off the tool is left out of every run (enabled()).
 */
import { z } from "zod";
import { errorResult, okResult, type AgentTool } from "../tools";
import { leanSignupResearchEnabled } from "../research/v2/lean";
import { LEAN_REFRESH_TOPICS, requestLeanRefresh, type LeanRefreshDeps, type LeanRefreshTopic } from "./leanRefresh";

export const REFRESH_RESEARCH_TOOL = "refresh_research";

/** Prompt Register: tool refresh_research 1.0.0 (description; exact text). */
export const REFRESH_RESEARCH_DESCRIPTION =
  "Look the athlete up on the public web again and update what Nomila knows about them: a background research run " +
  "(official team and school pages, Wikidata, a web search) whose checked, sourced facts are added to their record, then " +
  "their M.I.A. score is re-read. " +
  "Use it when the athlete asks you to look them up again, says what Nomila knows is out of date or missing (a new team, " +
  "a new partner or sponsor, recent results, upcoming events), or has just corrected their facts and wants a fresh look. " +
  "Do not use it to answer a question the facts you already have can answer (use recall_facts), to research another " +
  "person, a brand or a deal, or to fetch a page they sent you; do not call it twice in one conversation. " +
  "topics narrows the search: identity (confirm who they are), results_honours, partners, media, upcoming, or all " +
  "(the default). " +
  "Returns status started (say you're on it and that new facts will show in What Nomila knows within a few minutes; " +
  "they can leave), already_running (one is in progress), or a refusal with its reason: rate_limited or daily_budget " +
  "with next_allowed_at (say when they can ask again), no_anchor (Nomila needs their name and sport first).";

export function researchTools(deps: LeanRefreshDeps = {}): AgentTool[] {
  return [{
    name: REFRESH_RESEARCH_TOOL,
    description: REFRESH_RESEARCH_DESCRIPTION,
    kind: "ours", permission: "draft",
    enabled: () => leanSignupResearchEnabled(),
    args: z.object({
      topics: z.array(z.enum(LEAN_REFRESH_TOPICS)).max(LEAN_REFRESH_TOPICS.length).optional()
        .describe("What to look for. Omit (or all) for everything; identity only confirms who they are."),
    }),
    async execute(ctx, a: { topics?: LeanRefreshTopic[] }) {
      const topics: LeanRefreshTopic[] = a.topics?.length ? [...new Set(a.topics)] : ["all"];
      const r = await requestLeanRefresh(ctx.athleteId, topics, deps);
      if (r.started) return okResult({ started: true, run_id: r.runId, topics: r.topics });
      if (r.reason === "already_running") return okResult({ started: false, already_running: true, run_id: r.runId });
      if (r.reason === "rate_limited" || r.reason === "daily_budget") return errorResult(`research was not refreshed: ${JSON.stringify({ refused: r.reason, next_allowed_at: r.nextAllowedAt })}`);
      // Her identity is open: only the identity check runs. The refusal says what to do instead (actionable error).
      if (r.reason === "identity_open") return errorResult(`research was not refreshed: ${JSON.stringify({ refused: r.reason })} — Nomila has not yet confirmed which public profile is theirs, so only the identity check runs; call refresh_research again with topics ["identity"], or ask them to add their school or team, a social handle, or to connect an account`);
      return errorResult(`research was not refreshed: ${JSON.stringify({ refused: r.reason })}`);
    },
  }];
}
