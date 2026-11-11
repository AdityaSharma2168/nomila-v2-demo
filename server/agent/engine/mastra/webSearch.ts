/**
 * agent/engine/mastra/webSearch.ts — web search for Mila's chat on Mastra (P1, 5 Nov 2026), as the retired harness chat had it.
 *
 * Mastra has no provider built-ins, so the chat skill's `web_search` (a provider built-in on the retired harness) is offered here
 * as one of our own tools. Each call is one search through the helper the app's other web searches use (voice's
 * web search, the footprint check): research/runSkill.ts runSkill with a web_search budget, on the skill
 * chat/web-search (fast tier, ONE search at low context; OpenAI Responses with store:false; the platform's day cap
 * checked before the call). The model sees a short answer, fenced as outside text; the pages the search used (the
 * provider's own list, never the model's) go on "How I got this".
 *
 * Counted against the caps, with the ledger row:
 *   per turn   at most the chat skill's max_web_searches calls (chat.yaml: 2; AGENT_SKILL_CAPS can lower it); a call
 *              over it is refused with a plain error the model can recover from, and nothing is spent
 *   ledger     each search is its OWN agent_runs row (skill chat/web-search, parent_ref "mastra-search:<turn run id>:<n>",
 *              its cost, its web_search trace step with the queries and pages), as voice's search is. So the athlete's
 *              day spend and the platform's count each search exactly once
 *   day        runSkill refuses a search once the athlete's day spend (read just before) is at the day cap
 *   run        the turn adds each search's cost to its running total, so the run cap it checks after every step
 *              includes it (mastra/turn.ts)
 *   turn row   web_search_calls counts the turn's searches and tools_called has one record per call; its
 *              cost_micro_usd stays the model's own (the searches are on their rows)
 *
 * Per call, in order (fail closed): the athlete pass from the call's requestContext is verified (as every tool,
 * tools.ts); the account-deletion fence; the per-turn cap; the search. A failed search returns an error result, never
 * throws (only a refused pass or the fence throws).
 */
import { z } from "zod";
import type { EvidenceRef, RunCost, ToolCallRecord } from "../../../../shared/agent";
import { createLogger } from "../../../logger";
import { external } from "../../../lib/externalContent";
import { isAthleteDeleting } from "../../../lib/privacy/deletionFence";
import { AGENT } from "../../config";
import { dbStore } from "../../research/dbStore";
import { ModelCallError } from "../../research/llm";
import { CostCapError, runSkill } from "../../research/runSkill";
import { spentTodayMicroUsd } from "../../trace";
import { verifyAthletePass } from "../tools/pass";
import { PASS_CONTEXT_KEY } from "../config";
import { ToolRefusedError } from "./tools";

const logger = createLogger("agent/engine/mastra/webSearch");

/** The tool's name: the chat skill's own (jobs/chat.yaml lists web_search), so Mila's definition reads the same. */
export const WEB_SEARCH_TOOL = "web_search";
/** The skill each call runs (jobs/chat/web-search.md). */
export const CHAT_WEB_SEARCH_SKILL = "chat/web-search";
/** Searches the provider may run for ONE call (max_tool_calls). */
export const SEARCHES_PER_CALL = 1;
/** The answer's output ceiling (tokens). */
export const WEB_SEARCH_MAX_OUTPUT_TOKENS = 800;
/** Sources returned to the model per call (all of them still go on "How I got this"). */
export const SOURCES_TO_MODEL = 5;

/**
 * Prompt Register: "Mila on Mastra: web_search tool". Model-facing, so it is registered with its exact text.
 */
export const WEB_SEARCH_DESCRIPTION =
  "Search the web for one public, outside fact: a market norm, a brand's news, an event date or result. " +
  "One short query per call; at most twice a turn. Returns a short answer and the pages it came from. " +
  "Do not use it for anything about the athlete that memory holds, or that the web can't have.";

const ARGS = z.object({ query: z.string().trim().min(2).max(300).describe("What to look up, as a short search query.") });
const ANSWER_SCHEMA = {
  type: "object", additionalProperties: false, required: ["answer"],
  properties: { answer: { type: "string" } },
} as const;

/** One search's result as the turn records it. */
export interface WebSearchDone {
  answer: string;
  queries: string[];
  sources: Array<{ url: string; title?: string }>;
  cost: RunCost;
}

/** Who a search is for: the athlete and run from the verified pass, and the call's number in the turn. */
export interface WebSearchFor { athleteId: string; runId: string; n: number; signal?: AbortSignal }

/** The search itself. Injectable: tests never reach a provider. */
export type WebSearchCall = (query: string, p: WebSearchFor) => Promise<WebSearchDone>;

/** A search refused because the athlete's day cap is spent (no call made). */
export class WebSearchDayCap extends Error {}

/** The parent_ref of a turn's n-th search: unique per call, so runSkill never reuses one search for another. */
export const searchParentRef = (runId: string, n: number) => `mastra-search:${runId}:${n}`;

export const realWebSearch: WebSearchCall = async (query, p) => {
  const spent = await spentTodayMicroUsd(p.athleteId);
  try {
    const r = await runSkill({
      store: dbStore, athleteId: p.athleteId, skillId: CHAT_WEB_SEARCH_SKILL, trigger: "chat", parentRef: searchParentRef(p.runId, p.n),
      input: JSON.stringify({ query }), schemaName: "web_answer", schema: ANSWER_SCHEMA as never,
      webSearch: { maxCalls: SEARCHES_PER_CALL, contextSize: "low" }, maxOutputTokens: WEB_SEARCH_MAX_OUTPUT_TOKENS, signal: p.signal,
      budget: { spentMicroUsd: spent, capMicroUsd: AGENT.DAY_COST_CAP_MICRO_USD },
    });
    const answer = typeof (r.json as { answer?: unknown })?.answer === "string" ? (r.json as { answer: string }).answer.trim() : "";
    return { answer, queries: r.queries, sources: r.sources, cost: r.cost };
  } catch (err) {
    if (err instanceof CostCapError) throw new WebSearchDayCap(err.message);
    throw err;
  }
};

const ZERO: RunCost = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, microUsd: 0 };

/** What the turn's searches spent and found, so far (one per turn; the turn reads it for its caps and its row). */
export class WebSearchLedger {
  /** Tool calls admitted (a call is counted before it runs, so parallel calls respect the cap). The searches' cost is
   * summed here for the turn's run cap; it is recorded on each search's own agent_runs row. */
  calls = 0;
  readonly cost: RunCost = { ...ZERO };
  readonly records: ToolCallRecord[] = [];
  readonly searches: Array<{ queries: string[]; sources: Array<{ url: string; title?: string }> }> = [];
  constructor(readonly cap: number) {}

  add(c: Partial<RunCost> | undefined): void {
    if (!c) return;
    for (const k of Object.keys(ZERO) as Array<keyof RunCost>) {
      const v = c[k];
      if (typeof v === "number" && Number.isFinite(v)) this.cost[k] += v;
    }
  }

  /** The pages every search used, once each, as evidence for "How I got this". */
  evidence(): EvidenceRef[] {
    const seen = new Set<string>();
    const out: EvidenceRef[] = [];
    for (const s of this.searches) for (const p of s.sources) {
      if (!p.url || seen.has(p.url)) continue;
      seen.add(p.url);
      out.push({ kind: "url", url: p.url, ...(p.title ? { title: p.title } : {}) });
    }
    return out;
  }
}

/** The searches a skill allows per turn: 0 unless it lists web_search; its max_web_searches (none set ⇒ 0, fail closed). */
export function webSearchCap(skill: { tools: readonly string[] }, maxWebSearches: number | null): number {
  return skill.tools.includes(WEB_SEARCH_TOOL) && maxWebSearches != null && maxWebSearches > 0 ? maxWebSearches : 0;
}

type CallContext = { requestContext?: { get(k: string): unknown } } | undefined;

export interface WebSearchToolDeps {
  passKey?: string | null;
  isDeleting?: (athleteId: string) => Promise<boolean>;
  search?: WebSearchCall;
  /** The turn's abort signal (a Stop, the timeout, a cap): an in-flight search is cancelled with the turn. */
  signal?: AbortSignal;
}

const errorText = (reason: string) => JSON.stringify({ status: "error", reason });

/** The web_search tool for one turn, writing into that turn's ledger. */
export async function webSearchTool(ledger: WebSearchLedger, deps: WebSearchToolDeps = {}) {
  const { createTool } = await import("@mastra/core/tools");
  const fenced = deps.isDeleting ?? isAthleteDeleting;
  const search = deps.search ?? realWebSearch;
  return createTool({
    id: WEB_SEARCH_TOOL,
    description: WEB_SEARCH_DESCRIPTION,
    inputSchema: ARGS as never,
    execute: async (input: unknown, context: CallContext) => {
      let pass;
      try { pass = verifyAthletePass(context?.requestContext?.get(PASS_CONTEXT_KEY) as string | undefined, deps.passKey); }
      catch (err: any) {
        logger.warn({ code: err?.code ?? "invalid" }, "mastra web search: athlete pass refused");
        throw new ToolRefusedError("pass_refused", "athlete pass refused");
      }
      if (await fenced(pass.athleteId).catch(() => true)) throw new ToolRefusedError("athlete_deleting", "account being deleted");
      const t0 = Date.now();
      const record = (outcome: ToolCallRecord["outcome"], extra: Partial<ToolCallRecord> = {}) =>
        ledger.records.push({ name: WEB_SEARCH_TOOL, kind: "builtin", permission: "read", outcome, durationMs: Date.now() - t0, ...extra });
      const args = ARGS.safeParse(input ?? {});
      if (!args.success) { record("error", { reason: "invalid arguments" }); return errorText("give one short search query"); }
      if (ledger.calls >= ledger.cap) {
        record("denied", { rule: "cost_cap", reason: `web search limit reached (${ledger.cap} a turn)` });
        return errorText(`web search limit reached for this turn (${ledger.cap}); answer with what you have`);
      }
      const n = ++ledger.calls;
      try {
        const r = await search(args.data.query, { athleteId: pass.athleteId, runId: pass.runId, n, signal: deps.signal });
        ledger.add(r.cost);
        ledger.searches.push({ queries: r.queries.length ? r.queries : [args.data.query], sources: r.sources });
        record("ok");
        logger.info({ athleteId: pass.athleteId, runId: pass.runId, searches: r.cost.webSearchCalls, sources: r.sources.length, microUsd: r.cost.microUsd }, "mastra web search");
        const body = { status: "ok", answer: r.answer || "(the search found nothing reliable)", sources: r.sources.slice(0, SOURCES_TO_MODEL) };
        return external(JSON.stringify(body), {}, { newlines: true })!;
      } catch (err: any) {
        if (err instanceof WebSearchDayCap) {
          record("denied", { rule: "cost_cap", reason: "the day cap is reached" });
          return errorText("today's spending limit is reached, so the web search did not run; answer without it");
        }
        // A failed call still spent what it spent (a partial usage, when the provider reported one; it is on its row).
        ledger.add(err instanceof ModelCallError ? err.partial?.cost : undefined);
        record("error", { reason: String(err?.message ?? err).slice(0, 200) });
        logger.warn({ athleteId: pass.athleteId, runId: pass.runId, err: String(err?.message ?? err).slice(0, 200) }, "mastra web search failed");
        return errorText("the web search failed; answer without it");
      }
    },
  } as never);
}
