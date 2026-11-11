/**
 * searchScoreEval.lib.ts — the pure part of the quick search + M.I.A. score comparison (searchScoreEval.ts is the CLI).
 * Every provider is passed in (Providers), so tests run it with mocks and no network.
 *
 * WHAT IS COMPARED (owner, 26 Oct 2026: "whatever can be done on Vertex should be done on Vertex"; two scoring models):
 *   1  gemini_one_call     Gemini 3.8 Flash, ONE call: Google Search grounding + the frozen M.I.A. prompt (the existing
 *                          search-enabled evaluator text, blind-eval-spec 0.2.x, verbatim) → identity, score, evidence.
 *   2  deepseek_loop       DeepSeek V4.1 Flash on Vertex, thinking ON, ONE tool loop with our FREE tools only
 *                          (Wikidata lookup + our own page fetcher: robots.txt respected, Defuddle) and the same frozen
 *                          prompt. No general web search: Google grounding links may not be handed on for fetching
 *                          (Google terms §20(k)), so discovery is Wikidata + official sites. A DeepSeek Search API
 *                          backend exists behind DEEPSEEK_SEARCH_BACKEND=on — OFF by default and not part of this run.
 *   3  two_call:<scorer>   Gemini 3.8 Flash grounded quick evidence step (the research skill, verbatim, one pass), then
 *                          the EXISTING facts-only M.I.A. scorer (factsOnlyPrompt, verbatim; enforceFactsOnly) on
 *                          gemini-3.8-flash (low thinking) and on deepseek-v4.1-flash (thinking on).
 *   reference              the athlete's current stored M.I.A. score (full record, scored by gemini-3.5-flash).
 * Every setup sees the same input: name, sport, what the athlete told us (said facts) and the connected-account block.
 *
 * Scores are computed with the same functions the orchestrator uses (parseEvaluatorResponse → buildBeta1Dimensions →
 * computeMarketabilityBeta1), so a setup's number is comparable with the stored one. Nothing here writes to the database.
 *
 * Grader: GLM-5.2 on Vertex (Z.ai) — a third model family, neither Gemini nor DeepSeek (Claude is not enabled on this
 * project; probed 26 Oct 2026). It judges wrong-person and whether each fact is supported by the text it cites.
 * Grounded setups: Google's terms forbid fetching grounded links, so their facts are checked against Google's own
 * grounding support segments (mechanical overlap) plus the grader's consistency check against the athlete's record.
 */
import { randomUUID } from "node:crypto";
import { promptFor } from "../../services/marketabilityBeta1Snapshot";
import { parseEvaluatorResponse, extractJson, type EvaluatorOutput } from "../../services/marketabilityBeta1Evaluator";
import { buildBeta1Dimensions, type Beta1PriorFn } from "../../services/marketabilityBeta1Freeze";
import { computeMarketabilityBeta1, type MarketabilityBeta1Input, type MarketabilityBeta1Params } from "../../services/marketabilityBeta1";
import {
  allowedFromSources, enforceFactsOnly, factRefs, factsOnlyPrompt, notesFrom, resolveFactRefs,
  CARE_SOURCE_CLASS, CARE_CONDUCT_SOURCE_CLASS, FACT_SOURCE_CLASS, MEMORY_PLATFORM,
} from "../../services/miaPreview/factsOnlySpec";
import { composeFactsOnlyBlock, type PreviewFact } from "../../services/miaPreview/memoryAdapter";
import type { SocialAccountBlock } from "../../services/marketabilityBeta1SocialBlock";

// ── prices (January 2027 list; the owner asked for list, not intro or free-tier, prices) ─────────────────────────

/** Per 1M tokens, USD. Gemini 3.8 Flash: Vertex Billing Catalog standard rate (intro rate ends 31 Dec 2026).
 *  DeepSeek V4.1 Flash MaaS: Vertex Billing Catalog, 25 Oct 2026. GLM-5.2 MaaS: third-party price list (bifrost), not
 *  checked against the Billing Catalog. Grounding: $14 / 1,000 queries after 5,000 free a month — charged here at list. */
export const PRICES = {
  "gemini-3.8-flash": { in: 1.5, cached: 0.15, out: 7.5 },
  "deepseek-ai/deepseek-v4.1-flash-maas": { in: 0.3, cached: 0.03, out: 1.2 },
  "zai-org/glm-5.2-maas": { in: 1.4, cached: 1.4, out: 4.4 },
  groundingPerQuery: 0.014,
  deepseekSearchPerCall: 0.00075,
} as const;
export type PricedModel = "gemini-3.8-flash" | "deepseek-ai/deepseek-v4.1-flash-maas" | "zai-org/glm-5.2-maas";

export const GEMINI_MODEL: PricedModel = "gemini-3.8-flash";
export const DEEPSEEK_MODEL: PricedModel = "deepseek-ai/deepseek-v4.1-flash-maas";
export const GRADER_MODEL: PricedModel = "zai-org/glm-5.2-maas";

export interface Usage { input: number; cached: number; output: number; thinking: number; searches: number; toolCalls: number }
export const zeroUsage = (): Usage => ({ input: 0, cached: 0, output: 0, thinking: 0, searches: 0, toolCalls: 0 });
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, thinking: a.thinking + b.thinking,
  searches: a.searches + b.searches, toolCalls: a.toolCalls + b.toolCalls,
});

/** USD for one model's usage at the list prices above. Thinking tokens are billed as output. */
export function costUsd(model: PricedModel, u: Usage, extra: { groundingQueries?: number; deepseekSearchCalls?: number } = {}): number {
  const p = PRICES[model];
  const fresh = Math.max(0, u.input - u.cached);
  return (fresh / 1e6) * p.in + (u.cached / 1e6) * p.cached + ((u.output + u.thinking) / 1e6) * p.out
    + (extra.groundingQueries ?? 0) * PRICES.groundingPerQuery + (extra.deepseekSearchCalls ?? 0) * PRICES.deepseekSearchPerCall;
}

// ── providers (injected) ──────────────────────────────────────────────────────

export interface GroundingNative { chunks: Array<{ uri: string; title: string }>; supports: Array<{ text: string; chunks: number[] }>; queries: string[] }
export interface GeminiResult { text: string; usage: Usage; ms: number; native: GroundingNative }
/** DeepSeek's documented thinking efforts (thinking-mode guide: low, high, max; default high). */
export type DeepSeekEffort = "low" | "high" | "max";
/** A DeepSeek mode under test: thinking off, or on at an effort (undefined = the model's default). */
export interface DeepSeekMode { thinking: boolean; effort?: DeepSeekEffort; label: string }
export const DEEPSEEK_MODES: Record<string, DeepSeekMode> = {
  off: { thinking: false, label: "thinking off" },
  low: { thinking: true, effort: "low", label: "thinking low" },
  default: { thinking: true, label: "thinking on (default effort)" },
};
/** reasoning_content is carried on assistant messages: with tools, DeepSeek's guide says it MUST be passed back in every
 *  later request. */
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; reasoning_content?: string; tool_calls?: any[]; tool_call_id?: string; name?: string }
export interface ChatResult { message: { content: string | null; reasoning_content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; usage: Usage; ms: number }
export interface FetchedPage { url: string; title: string; text: string; skipped: string | null }
export interface WikidataHit { id: string; label: string; description: string; officialWebsite: string | null; enwiki: string | null; facts: string[] }

export interface Providers {
  /** Gemini on Vertex (global). search=true adds the googleSearch tool. */
  gemini(req: { model: PricedModel; system?: string; user: string; search: boolean; thinkingLevel: "low" }): Promise<GeminiResult>;
  /** Vertex MaaS OpenAI-compatible chat completions (DeepSeek, GLM). Sends chat_template_kwargs {thinking, reasoning_effort}
   *  (the vLLM shape Vertex serves); json=true sends response_format json_object. */
  vertexChat(req: { model: PricedModel; messages: ChatMessage[]; tools?: any[]; thinking: boolean; effort?: DeepSeekEffort; maxTokens: number; json?: boolean }): Promise<ChatResult>;
  /** Our own fetcher: robots.txt respected, Defuddle cleaner (agent/research/v2/fetchClean). */
  fetchPages(urls: string[]): Promise<FetchedPage[]>;
  /** Wikidata (free, CC0): entity search + a few claims. */
  wikidata(query: string): Promise<WikidataHit[]>;
  /** DeepSeek Search API — only present when DEEPSEEK_SEARCH_BACKEND=on (OFF by default; not part of this run). */
  deepseekSearch?: (query: string) => Promise<Array<{ title: string; url: string; summary: string }>>;
}

// ── the athlete input every setup shares ───────────────────────────────────────

export interface AthleteCase {
  id: string; name: string; sport: string;
  /** What the athlete told us (said facts), one line each. */
  said: string[];
  /** The connected-account (measured) accounts, rendered by the existing block renderer. */
  accounts: SocialAccountBlock[];
  /** The frozen block for those accounts (composeBlock(accounts, [])) — null when none are connected. */
  socialBlock: string | null;
  /** Reference: the stored M.I.A. score and a short anchor of the stored record (for the grader). */
  reference: { score: number | null; anchor: string[] };
}

/** The heading research.ts already uses for said facts ("WHAT THE ATHLETE HAS TOLD US (said; anchors identity)"). */
export const SAID_HEADING = "WHAT THE ATHLETE HAS TOLD US (said; anchors identity)";

/** Prompt Register: eval/search-score/said-block 1.0.0 — appended after the frozen block so setups 1 and 2 get the
 *  same said facts the research step gets. Reuses research.ts's own heading; no other words. */
export function saidBlock(said: string[]): string {
  return `${SAID_HEADING}\n${said.length ? said.map((s) => `- ${s}`).join("\n") : "- (none yet)"}`;
}

/** The frozen (search-enabled) M.I.A. prompt, verbatim, with the said facts appended to its evidence block. */
export function frozenPrompt(a: AthleteCase): string {
  const block = [a.socialBlock, saidBlock(a.said)].filter(Boolean).join("\n\n");
  return promptFor({ name: a.name, sport: a.sport, socialBlock: block });
}

// ── scoring (the orchestrator's own functions) ───────────────────────────────

export interface ScoringContext {
  params: MarketabilityBeta1Params;
  subWeights: Record<string, Record<string, number>>;
  prior: Beta1PriorFn;
}

export interface ScoreResult { score: number; composite: number; confidence: number; scored: number; missing: number; identityConfidence: string | null }

/** Judgements → score, exactly as scoreAndRecord computes it (source class only labels; it never moves the number). */
export function scoreFrom(out: EvaluatorOutput, a: AthleteCase, ctx: ScoringContext, asOf: string): ScoreResult {
  const dimensions = buildBeta1Dimensions({ signals: out.judgements } as any, a.sport, ctx.prior, ctx.subWeights, asOf) as MarketabilityBeta1Input["dimensions"];
  const r = computeMarketabilityBeta1({ athleteId: a.id, asOf, dimensions }, ctx.params);
  return {
    score: r.score, composite: r.composite, confidence: r.confidence,
    scored: out.judgements.filter((j) => j.status === "scored").length, missing: out.judgements.filter((j) => j.status !== "scored").length,
    identityConfidence: out.identityConfidence,
  };
}

// ── setup outputs ────────────────────────────────────────────────────────────

export interface StepRecord { name: string; model: PricedModel; ms: number; usage: Usage; costUsd: number }
export interface FactRecord { claim: string; url: string | null; supportText?: string | null }
export interface SetupRun {
  setup: string; athlete: string; run: number;
  identity: { resolved: boolean | null; description: string; confidence: string | null };
  result: ScoreResult | null; error: string | null;
  facts: FactRecord[]; steps: StepRecord[];
  /** Grounded setups: Google's own support segments (for the mechanical support check). Tool setup: fetched page text. */
  groundingSupports?: string[]; pages?: Array<{ url: string; text: string }>;
  grade?: Grade | null;
  /** A JSON repair turn was needed (harness measure of output validity). */
  repaired?: boolean;
}
export const runCost = (r: SetupRun) => r.steps.reduce((s, x) => s + x.costUsd, 0);
export const runMs = (r: SetupRun) => r.steps.reduce((s, x) => s + x.ms, 0);

function factsFromEvaluator(out: EvaluatorOutput): FactRecord[] {
  return out.evidence.filter((e) => e.claim).map((e) => ({ claim: String(e.claim), url: e.sourceUrl ?? null }));
}

// ── setup 1: Gemini one call ──────────────────────────────────────────────────

export async function runGeminiOneCall(p: Providers, a: AthleteCase, ctx: ScoringContext, run: number, asOf: string): Promise<SetupRun> {
  const base: SetupRun = { setup: "gemini_one_call", athlete: a.name, run, identity: { resolved: null, description: "", confidence: null }, result: null, error: null, facts: [], steps: [] };
  const r = await p.gemini({ model: GEMINI_MODEL, user: frozenPrompt(a), search: true, thinkingLevel: "low" });
  base.steps.push({ name: "search+score", model: GEMINI_MODEL, ms: r.ms, usage: r.usage, costUsd: costUsd(GEMINI_MODEL, r.usage, { groundingQueries: r.usage.searches }) });
  base.groundingSupports = r.native.supports.map((s) => s.text);
  try {
    const out = parseEvaluatorResponse(r.text, ctx.subWeights);
    base.facts = factsFromEvaluator(out);
    base.identity = { resolved: null, description: out.identityOrEvidenceRisks.join(" ").slice(0, 400), confidence: out.identityConfidence };
    base.result = scoreFrom(out, a, ctx, asOf);
  } catch (e: any) { base.error = String(e?.message ?? e).slice(0, 300); }
  return base;
}

// ── setup 2: DeepSeek on Vertex, one tool loop with our free tools ─────────────

/** Prompt Register: eval/search-score/deepseek-tools 1.0.0 — the system preamble for the DeepSeek tool loop. The user
 *  turn is the frozen M.I.A. prompt, verbatim; this only says which research tools exist instead of a web search. */
export const DEEPSEEK_TOOLS_SYSTEM = `You are evaluating an athlete with the M.I.A. method in the user's message. Where it tells you to research the athlete on the web, use these tools instead of a web search engine:
- wikidata_lookup(query): searches Wikidata (people, teams, schools, leagues) and returns matching entities with their official website, English Wikipedia page and a few facts.
- fetch_page(url): fetches one public web page and returns its readable text. Use it for official sites (team and school rosters and bios, league and federation pages), Wikipedia pages and links found on pages you fetched. Some sites refuse automated fetching; move on when one does.
Confirm you have the right person before relying on a page: the page must tie the name to the sport, team or school given. Cite the page URL of every fact you use. When you have enough evidence, or after at most 12 tool calls, stop calling tools and return the JSON exactly as the method specifies.`;

/** The DeepSeek Search tool, only offered when the backend is on (OFF by default; not part of this run). */
export const SEARCH_TOOL_LINE = "- search_web(query): a general web search; returns titles, URLs and short summaries.";

export const TOOL_SCHEMAS = {
  wikidata_lookup: { type: "function", function: { name: "wikidata_lookup", description: "Search Wikidata for a person, team, school or league.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  fetch_page: { type: "function", function: { name: "fetch_page", description: "Fetch one public web page and return its readable text.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  search_web: { type: "function", function: { name: "search_web", description: "General web search (DeepSeek Search API).", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
};

export const MAX_TOOL_CALLS = 12;
/** Prompt Register: eval/search-score/tool-budget 1.0.0 — sent once when the loop's tool budget is used up. */
/** Prompt Register: eval/search-score/json-repair 1.0.0 — one repair turn when an answer holds no parseable JSON, or a JSON
 *  object without the method's "dimensions" (seen 26 Oct with thinking off and json_object: only the athlete header). */
export const JSON_REPAIR = "Your last answer did not contain the complete JSON object the method asks for. Return only that JSON object now, complete — all eight dimensions with every sub-signal scored or missing, the dimension assessments and the overall confidence — with no other text.";
/** True when the text parses to a JSON object carrying a non-empty "dimensions" object (the method's output). */
export function hasDimensions(text: string): boolean {
  const j = extractJson(text).json;
  return !!j && typeof j.dimensions === "object" && j.dimensions !== null && Object.keys(j.dimensions).length > 0;
}
export const TOOL_BUDGET_SPENT = "Your research tool budget is used up; tools are no longer available. Using only what you have found, return the JSON now exactly as the method specifies, as one ```json fenced block.";
const PAGE_CHARS_TO_MODEL = 12_000;

export async function runDeepSeekLoop(p: Providers, a: AthleteCase, ctx: ScoringContext, run: number, asOf: string, modeKey: keyof typeof DEEPSEEK_MODES = "default"): Promise<SetupRun> {
  const mode = DEEPSEEK_MODES[modeKey];
  const thinking = mode.thinking;
  const base: SetupRun = { setup: modeKey === "default" ? "deepseek_loop" : `deepseek_loop_${modeKey}`, athlete: a.name, run, identity: { resolved: null, description: "", confidence: null }, result: null, error: null, facts: [], steps: [], pages: [] };
  const searchOn = !!p.deepseekSearch;
  const tools = [TOOL_SCHEMAS.wikidata_lookup, TOOL_SCHEMAS.fetch_page, ...(searchOn ? [TOOL_SCHEMAS.search_web] : [])];
  const system = searchOn ? DEEPSEEK_TOOLS_SYSTEM.replace("\n- fetch_page", `\n${SEARCH_TOOL_LINE}\n- fetch_page`) : DEEPSEEK_TOOLS_SYSTEM;
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: frozenPrompt(a) }];
  let usage = zeroUsage(); let ms = 0; let calls = 0; let searchCalls = 0; let finalText = "";
  let nudged = false; let repaired = false;
  for (let turn = 0; turn < MAX_TOOL_CALLS + 4; turn++) {
    const allowTools = calls < MAX_TOOL_CALLS;
    // Out of tool budget: say so once, so the model answers instead of writing another tool call as text.
    if (!allowTools && !nudged) { messages.push({ role: "user", content: TOOL_BUDGET_SPENT }); nudged = true; }
    // The final turn (budget spent) drops the tools and asks for a JSON object (response_format json_object, accepted by
    // Vertex DeepSeek — probed 26 Oct 2026; tool_choice "none" is NOT honoured: it writes the tool call as text).
    const r = await p.vertexChat({ model: DEEPSEEK_MODEL, messages, tools: allowTools ? tools : undefined, thinking, effort: mode.effort, maxTokens: 32_000, json: !allowTools });
    usage = addUsage(usage, r.usage); ms += r.ms;
    const tc = r.message.tool_calls ?? [];
    if (!tc.length || !allowTools) {
      finalText = r.message.content ?? "";
      // An answer with no JSON object (prose, or a tool call written as text): one repair turn, JSON only.
      if (!hasDimensions(finalText) && !repaired) {
        repaired = true;
        messages.push({ role: "assistant", content: finalText, ...(r.message.reasoning_content ? { reasoning_content: r.message.reasoning_content } : {}) }, { role: "user", content: JSON_REPAIR });
        calls = Math.max(calls, MAX_TOOL_CALLS); nudged = true;
        continue;
      }
      break;
    }
    messages.push({ role: "assistant", content: r.message.content ?? null, ...(r.message.reasoning_content ? { reasoning_content: r.message.reasoning_content } : {}), tool_calls: tc });
    for (const c of tc) {
      calls++;
      let args: any = {}; try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* bad args → error result */ }
      const t0 = Date.now();
      let content: string;
      try {
        if (c.function.name === "wikidata_lookup") content = JSON.stringify(await p.wikidata(String(args.query ?? "")));
        else if (c.function.name === "fetch_page") {
          const [pg] = await p.fetchPages([String(args.url ?? "")]);
          if (pg && !pg.skipped) base.pages!.push({ url: pg.url, text: pg.text });
          content = pg && !pg.skipped ? JSON.stringify({ url: pg.url, title: pg.title, text: pg.text.slice(0, PAGE_CHARS_TO_MODEL) }) : JSON.stringify({ error: `not fetched: ${pg?.skipped ?? "unknown"}` });
        } else if (c.function.name === "search_web" && p.deepseekSearch) { searchCalls++; content = JSON.stringify(await p.deepseekSearch(String(args.query ?? ""))); }
        else content = JSON.stringify({ error: `unknown tool ${c.function.name}` });
      } catch (e: any) { content = JSON.stringify({ error: String(e?.message ?? e).slice(0, 200) }); }
      ms += Date.now() - t0;
      messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content });
    }
  }
  usage.toolCalls = calls; usage.searches = searchCalls;
  if (process.env.SEARCH_SCORE_DEBUG) console.log(`[debug ${a.name}] calls=${calls} finalText(${finalText.length}): ${JSON.stringify(finalText.slice(0, 400))} … ${JSON.stringify(finalText.slice(-200))}`);
  base.repaired = repaired;
  base.steps.push({ name: "tool loop + score", model: DEEPSEEK_MODEL, ms, usage, costUsd: costUsd(DEEPSEEK_MODEL, usage, { deepseekSearchCalls: searchCalls }) });
  try {
    const out = parseEvaluatorResponse(finalText, ctx.subWeights);
    base.facts = factsFromEvaluator(out);
    base.identity = { resolved: null, description: out.identityOrEvidenceRisks.join(" ").slice(0, 400), confidence: out.identityConfidence };
    base.result = scoreFrom(out, a, ctx, asOf);
  } catch (e: any) { base.error = String(e?.message ?? e).slice(0, 300); }
  return base;
}

// ── setup 3: quick grounded evidence, then the existing facts-only scorer ──────

/** Prompt Register: eval/search-score/quick-pass 1.0.0 — the input line for the single quick evidence pass (the research
 *  skill text is the system prompt, verbatim). Both of research.ts's PASS_ANGLES, one pass. */
export function quickPassInput(a: AthleteCase, today: string, angles: { a: string; b: string }): string {
  return [
    "ATHLETE", `- Name: ${a.name}`, `- Sport: ${a.sport}`, "",
    SAID_HEADING, a.said.length ? a.said.map((s) => `- ${s}`).join("\n") : "- (none yet)", "",
    "CONNECTED ACCOUNTS", a.socialBlock ?? "- (none connected)", "",
    `Today is ${today}. You are a SINGLE QUICK PASS covering both angles: ${angles.a}; and ${angles.b}. Search on your own.`,
  ].join("\n");
}

/** Prompt Register: eval/search-score/quick-pass-json 1.0.0 — grounding and a response schema are not combined here, so
 *  the schema the research skill names is stated in text. */
export const QUICK_PASS_JSON_LINE = "Return the JSON as one ```json fenced block matching this response schema:";

export interface QuickEvidence { identity: { resolved: boolean; description: string; ambiguity: string }; facts: PreviewFact[]; raw: any }

/** The pass's facts as PreviewFacts (synthetic ids) so the existing facts-only block renderer and enforcement apply. */
export function evidenceFacts(json: any, a: AthleteCase, nowIso: string): PreviewFact[] {
  const out: PreviewFact[] = [];
  for (const f of Array.isArray(json?.facts) ? json.facts : []) {
    if (!f?.claim || f.never_reason && f.never_reason !== "none") continue;
    const about = String(f.subject_kind ?? "athlete") === "athlete";
    const care = String(f.sensitivity ?? "") === "care";
    out.push({
      id: randomUUID(), type: "found", status: "active", claim: String(f.claim), subjectKind: about ? "athlete" : String(f.subject_kind),
      subjectName: about ? a.name : String(f.subject_name ?? ""), sourceUrl: f.source_url ? String(f.source_url) : null, sourceRef: null,
      sourceTitle: f.source_title ? String(f.source_title) : null, observedOn: f.date ? String(f.date).slice(0, 10) : null,
      confidence: typeof f.confidence === "number" ? f.confidence : 0.6, sensitive: care,
      careKind: care ? (f.care_kind === "conduct" ? "conduct" : "personal") : null, disputes: null, createdAt: nowIso, topic: f.topic ?? null,
    });
  }
  return out;
}

export async function runQuickEvidence(p: Providers, a: AthleteCase, skillText: string, schema: unknown, angles: { a: string; b: string }, today: string): Promise<{ ev: QuickEvidence; step: StepRecord; supports: string[] }> {
  const user = `${quickPassInput(a, today, angles)}\n\n${QUICK_PASS_JSON_LINE}\n${JSON.stringify(schema)}`;
  const r = await p.gemini({ model: GEMINI_MODEL, system: skillText, user, search: true, thinkingLevel: "low" });
  const json = extractJson(r.text).json ?? {};
  const ev: QuickEvidence = {
    identity: { resolved: json.identity?.resolved === true, description: String(json.identity?.description ?? ""), ambiguity: String(json.identity?.ambiguity ?? "") },
    facts: evidenceFacts(json, a, new Date().toISOString()), raw: json,
  };
  return { ev, step: { name: "quick evidence", model: GEMINI_MODEL, ms: r.ms, usage: r.usage, costUsd: costUsd(GEMINI_MODEL, r.usage, { groundingQueries: r.usage.searches }) }, supports: r.native.supports.map((s) => s.text) };
}

/** The facts-only block and its sources, built with the existing renderer (care / context split as memoryAdapter). */
export function factsBlockFor(a: AthleteCase, facts: PreviewFact[]): { block: string; sources: any[] } {
  const about = facts.filter((f) => f.subjectKind === "athlete");
  const pub = about.filter((f) => !f.sensitive);
  const care = about.filter((f) => f.sensitive);
  const context = facts.filter((f) => f.subjectKind !== "athlete");
  const block = composeFactsOnlyBlock(a.accounts, pub, care, context);
  const sources = [
    ...a.accounts.map((acc) => ({ platform: acc.platform, accountId: acc.handle, observedAt: acc.observedAt, sourceClass: acc.source })),
    ...pub.map((f) => ({ platform: MEMORY_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: FACT_SOURCE_CLASS })),
    ...context.map((f) => ({ platform: MEMORY_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: "web_researched_context" })),
    ...care.map((f) => ({ platform: MEMORY_PLATFORM, accountId: f.id, observedAt: f.createdAt, sourceClass: f.careKind === "conduct" ? CARE_CONDUCT_SOURCE_CLASS : CARE_SOURCE_CLASS })),
  ];
  return { block, sources };
}

/** deepseek-v4.1-flash = thinking at the default effort; -low = thinking at "low"; -nothink = thinking off. */
export type ScorerId = "gemini-3.8-flash" | "deepseek-v4.1-flash" | "deepseek-v4.1-flash-low" | "deepseek-v4.1-flash-nothink";
const scorerMode = (s: ScorerId): DeepSeekMode => (s === "deepseek-v4.1-flash-low" ? DEEPSEEK_MODES.low : s === "deepseek-v4.1-flash-nothink" ? DEEPSEEK_MODES.off : DEEPSEEK_MODES.default);

/** What enforcement changed on a run (counts only), as the orchestrator records it on base.raw.enforcement. */
export interface EnforcementCounts { unknownIds: number; careRemoved: number; demoted: number; contextOnly: number; notesDropped: number }
export interface FactsOnlyScore {
  out: EvaluatorOutput | null; result: ScoreResult | null; step: StepRecord; error: string | null;
  /** Calls made: 1, or 2 when the first answer failed to parse (prod retries a parse failure; a refusal is not retried). */
  attempts: number; parseFailures: number; enforcement: EnforcementCounts | null;
}

/** The existing facts-only scorer (prompt text verbatim) on one model; enforcement as the orchestrator applies it, and
 *  one retry on a parse failure as the evaluate step's bounded retry does. Steps from both attempts are summed. */
export async function scoreFactsOnly(p: Providers, a: AthleteCase, block: string, sources: any[], scorer: ScorerId, ctx: ScoringContext, asOf: string): Promise<FactsOnlyScore> {
  const prompt = factsOnlyPrompt({ name: a.name, sport: a.sport }, block);
  const model = scorer === "gemini-3.8-flash" ? GEMINI_MODEL : DEEPSEEK_MODEL;
  const step: StepRecord = { name: `score (${scorer})`, model, ms: 0, usage: zeroUsage(), costUsd: 0 };
  let attempts = 0; let parseFailures = 0; let lastError: string | null = null;
  // DeepSeek: the same prompt text, sent with response_format json_object (accepted on Vertex). A parse failure gets ONE
  // repair turn in the same conversation; Gemini is re-asked once, as prod's bounded retry does.
  const chat: ChatMessage[] = [{ role: "user", content: prompt }];
  while (attempts < 2) {
    attempts++;
    let text: string;
    if (scorer === "gemini-3.8-flash") {
      const r = await p.gemini({ model: GEMINI_MODEL, user: prompt, search: false, thinkingLevel: "low" });
      text = r.text; step.ms += r.ms; step.usage = addUsage(step.usage, r.usage);
    } else {
      const m = scorerMode(scorer);
      const r = await p.vertexChat({ model: DEEPSEEK_MODEL, messages: chat, thinking: m.thinking, effort: m.effort, maxTokens: 32_000, json: true });
      text = r.message.content ?? ""; step.ms += r.ms; step.usage = addUsage(step.usage, r.usage);
      if (!hasDimensions(text)) {
        chat.push({ role: "assistant", content: text }, { role: "user", content: JSON_REPAIR });
        step.costUsd = costUsd(model, step.usage);
        if (attempts < 2) { parseFailures++; lastError = "answer held no dimensions object (repair turn)"; continue; }
      }
    }
    step.costUsd = costUsd(model, step.usage);
    let parsed: EvaluatorOutput;
    try { parsed = parseEvaluatorResponse(text, ctx.subWeights); } catch (e: any) {
      lastError = String(e?.message ?? e).slice(0, 300);
      if (process.env.SEARCH_SCORE_DEBUG) {
        const j = extractJson(text).json;
        const dims = j?.dimensions && typeof j.dimensions === "object" ? Object.keys(j.dimensions) : [];
        const nodes = dims.flatMap((d) => Object.values(j.dimensions[d] ?? {}));
        console.log(`[debug score ${a.name} ${scorer}] ${lastError} · keys=${j ? Object.keys(j).join(",") : "none"} · dims=${dims.length} nodes=${nodes.length} scored=${nodes.filter((n: any) => n?.status === "scored").length} statuses=${[...new Set(nodes.map((n: any) => n?.status))].join("/")} · head=${JSON.stringify(text.slice(0, 200))}`);
      }
      if (e?.retryable) { parseFailures++; continue; }
      return { out: null, result: null, step, error: lastError, attempts, parseFailures, enforcement: null };
    }
    const refs = resolveFactRefs(parsed, notesFrom(extractJson(text).json), factRefs(block).refs);
    const held = enforceFactsOnly(refs.output, allowedFromSources(sources), refs.notes);
    const e = held.enforcement;
    const enforcement: EnforcementCounts = {
      unknownIds: Object.values(e.unknownIds).reduce((s, x) => s + x.length, 0), careRemoved: Object.values(e.careRemoved).reduce((s, x) => s + x.length, 0),
      demoted: e.demoted.length, contextOnly: e.contextOnly.length, notesDropped: e.notesDropped.length,
    };
    if (!held.output.judgements.some((j) => j.status === "scored")) return { out: null, result: null, step, error: "no signal scored from the supplied facts", attempts, parseFailures, enforcement };
    return { out: held.output, result: scoreFrom(held.output, a, ctx, asOf), step, error: null, attempts, parseFailures, enforcement };
  }
  return { out: null, result: null, step, error: lastError, attempts, parseFailures, enforcement: null };
}

/** Prompt Register: eval/search-score/rationale-grader 1.0.0 (GLM-5.2 on Vertex) — Part A: are the scorer's claims
 *  supported by the facts it was given? */
export const RATIONALE_GRADER_SYSTEM = `You are an independent reviewer checking an athlete marketability assessment against the evidence it was given. You see the EVIDENCE block (the only facts the assessor had, each with an ID) and the assessor's statements: one rationale per scored signal, its strengths, constraints and summary.

For each numbered statement decide: "supported" if every factual claim in it about the athlete (numbers, results, teams, partners, audience, dates) is stated in or directly follows from the EVIDENCE; "unsupported" if it asserts any fact about the athlete that the EVIDENCE does not contain. Opinions, judgements and general knowledge about sports or marketing are not facts about the athlete and do not make a statement unsupported. A missing-data note ("no audience data was provided") is supported.

Return JSON only: {"unsupported": [{"n": <number>, "claim": "<the unsupported claim, at most 20 words>"}]} — list only unsupported statements; an empty list means all are supported.`;

export interface RationaleGrade { statements: number; unsupported: Array<{ n: number; claim: string }>; usage: Usage; ms: number; costUsd: number }

/** The scorer's statements, numbered: each scored signal's rationale, then strengths, constraints and the summary. */
export function statementsOf(out: EvaluatorOutput): string[] {
  const s: string[] = [];
  for (const j of out.judgements) if (j.status === "scored" && j.rationale) s.push(`[${j.dimension}.${j.key}] ${j.rationale}`);
  for (const x of out.keyStrengths) s.push(`[strength] ${x}`);
  for (const x of out.keyConstraints) s.push(`[constraint] ${x}`);
  if (out.summary) s.push(`[summary] ${out.summary}`);
  return s;
}

export async function gradeRationales(p: Providers, a: Pick<AthleteCase, "name" | "sport">, block: string, out: EvaluatorOutput): Promise<RationaleGrade> {
  const st = statementsOf(out);
  const user = `ATHLETE: ${a.name} — ${a.sport}\n\nEVIDENCE\n${block}\n\nSTATEMENTS\n${st.map((x, i) => `${i + 1}. ${x}`).join("\n")}`;
  const r = await p.vertexChat({ model: GRADER_MODEL, messages: [{ role: "system", content: RATIONALE_GRADER_SYSTEM }, { role: "user", content: user }], thinking: false, maxTokens: 4_000 });
  const j = extractJson(r.message.content ?? "").json ?? {};
  const un = (Array.isArray(j.unsupported) ? j.unsupported : []).filter((x: any) => Number.isInteger(x?.n) && x.n >= 1 && x.n <= st.length)
    .map((x: any) => ({ n: x.n, claim: String(x.claim ?? "").slice(0, 200) }));
  return { statements: st.length, unsupported: un, usage: r.usage, ms: r.ms, costUsd: costUsd(GRADER_MODEL, r.usage) };
}

// ── grading (third family) ─────────────────────────────────────────────────────

/** Prompt Register: eval/search-score/grader 1.0.0 (GLM-5.2 on Vertex). */
export const GRADER_SYSTEM = `You are an independent reviewer checking an automated athlete-research result. You see: the athlete as Nomila already knows them (name, sport and anchor facts from their record), the identity the result settled on, and the facts it used, each with the source text it relied on when available.

Answer three things:
1. wrong_person: true if the result is about a different person than the athlete described (another person with the same name), false if it is the same person, "unclear" if you cannot tell.
2. For each fact (by its number): "supported" if the given source text states it, "unsupported" if the source text is given and does not state it, "no_source_text" if no source text is given; and "contradicts_record" true if it contradicts the anchor facts.
3. One sentence on the result's main problem, or "none".

A care fact (an injury, availability or family matter) is a legitimate fact when it is true and sourced. Judge only what is given. Return JSON only: {"wrong_person": true|false|"unclear", "facts": [{"n": 1, "support": "supported|unsupported|no_source_text", "contradicts_record": false}], "problem": "..."}`;

export interface Grade { wrongPerson: boolean | "unclear" | null; supported: number; unsupported: number; noSourceText: number; contradictions: number; problem: string; usage: Usage; ms: number; costUsd: number }

/** Mechanical support for grounded facts: the claim shares ≥ half its content words with one of Google's support segments. */
export function groundingSupported(claim: string, supports: string[]): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const c = words(claim); if (!c.size) return false;
  return supports.some((s) => { const w = words(s); let hit = 0; for (const x of c) if (w.has(x)) hit++; return hit / c.size >= 0.5; });
}

/** Source text for each fact: the fetched page (tool setup) or the matching Google support segment (grounded setups). */
export function sourceTextFor(f: FactRecord, run: Pick<SetupRun, "pages" | "groundingSupports">): string | null {
  if (run.pages?.length && f.url) {
    const pg = run.pages.find((x) => x.url === f.url || x.url.replace(/\/$/, "") === f.url!.replace(/\/$/, ""));
    if (pg) return pg.text.slice(0, 4_000);
  }
  if (run.groundingSupports?.length) {
    const seg = run.groundingSupports.find((s) => groundingSupported(f.claim, [s]));
    if (seg) return seg.slice(0, 1_000);
  }
  return null;
}

export async function grade(p: Providers, a: AthleteCase, run: SetupRun): Promise<Grade> {
  const facts = run.facts.slice(0, 40);
  const user = [
    `ATHLETE: ${a.name} — ${a.sport}`, "ANCHOR FACTS (Nomila's record):", ...(a.reference.anchor.length ? a.reference.anchor.map((x) => `- ${x}`) : ["- (none)"]), "",
    `IDENTITY THE RESULT SETTLED ON: ${run.identity.description || "(not stated)"} (confidence ${run.identity.confidence ?? "n/a"})`, "",
    "FACTS USED:", ...facts.map((f, i) => `${i + 1}. ${f.claim}\n   source: ${f.url ?? "(none)"}\n   source text: ${sourceTextFor(f, run) ?? "(not available)"}`),
  ].join("\n");
  const r = await p.vertexChat({ model: GRADER_MODEL, messages: [{ role: "system", content: GRADER_SYSTEM }, { role: "user", content: user }], thinking: false, maxTokens: 4_000 });
  const j = extractJson(r.message.content ?? "").json ?? {};
  const fs: any[] = Array.isArray(j.facts) ? j.facts : [];
  return {
    wrongPerson: j.wrong_person === true || j.wrong_person === false ? j.wrong_person : j.wrong_person === "unclear" ? "unclear" : null,
    supported: fs.filter((x) => x.support === "supported").length, unsupported: fs.filter((x) => x.support === "unsupported").length,
    noSourceText: fs.filter((x) => x.support === "no_source_text").length, contradictions: fs.filter((x) => x.contradicts_record === true).length,
    problem: String(j.problem ?? ""), usage: r.usage, ms: r.ms, costUsd: costUsd(GRADER_MODEL, r.usage),
  };
}

// ── summary ───────────────────────────────────────────────────────────────────

export interface SetupSummary { setup: string; runs: number; failed: number; meanAbsDelta: number | null; meanSpread: number | null; wrongPerson: number; unsupported: number; meanMs: number; meanCostUsd: number }

export function summarise(runs: SetupRun[], cases: AthleteCase[]): SetupSummary[] {
  const bySetup = new Map<string, SetupRun[]>();
  for (const r of runs) bySetup.set(r.setup, [...(bySetup.get(r.setup) ?? []), r]);
  const ref = new Map(cases.map((c) => [c.name, c.reference.score]));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  return [...bySetup.entries()].map(([setup, rs]) => {
    const deltas = rs.filter((r) => r.result && ref.get(r.athlete) != null).map((r) => Math.abs(r.result!.score - (ref.get(r.athlete) as number)));
    const spreads: number[] = [];
    for (const name of new Set(rs.map((r) => r.athlete))) {
      const s = rs.filter((r) => r.athlete === name && r.result).map((r) => r.result!.score);
      if (s.length > 1) spreads.push(Math.max(...s) - Math.min(...s));
    }
    return {
      setup, runs: rs.length, failed: rs.filter((r) => !r.result).length, meanAbsDelta: mean(deltas), meanSpread: mean(spreads),
      wrongPerson: rs.filter((r) => r.grade?.wrongPerson === true).length, unsupported: rs.reduce((s, r) => s + (r.grade?.unsupported ?? 0), 0),
      meanMs: mean(rs.map(runMs)) ?? 0, meanCostUsd: mean(rs.map(runCost)) ?? 0,
    };
  });
}

// ── estimate (dry run) ──────────────────────────────────────────────────────────

/** Assumptions behind the dry-run estimate, stated so the approval knows what it rests on. */
export const ESTIMATE_ASSUMPTIONS = {
  geminiGroundedExtraInput: 8_000,      // retrieved search content added to a grounded call's prompt
  groundingQueriesPerCall: 5,
  frozenOutput: 9_000, frozenThinkingLow: 2_000,          // the 44-signal JSON + evidence, low thinking
  factsOnlyOutput: 7_000,
  deepseekThinking: 6_000,
  deepseekLoopTurns: 8, deepseekPageTokens: 3_000,       // each fetched page ≈ 12k chars → 3k tokens, resent every turn
  quickPassOutput: 5_000,
  graderInput: 9_000, graderOutput: 1_500,
};

export function estimateRunUsd(promptTokens: { frozen: number; factsOnly: number; skill: number }, athletes: number, runs: number): { perAthleteRun: Record<string, number>; total: number } {
  const A = ESTIMATE_ASSUMPTIONS;
  const g = (u: Partial<Usage>, q = 0) => costUsd(GEMINI_MODEL, { ...zeroUsage(), ...u }, { groundingQueries: q });
  const d = (u: Partial<Usage>) => costUsd(DEEPSEEK_MODEL, { ...zeroUsage(), ...u });
  const gr = costUsd(GRADER_MODEL, { ...zeroUsage(), input: A.graderInput, output: A.graderOutput });
  // DeepSeek loop: context grows by one page a turn; input summed over turns.
  let loopIn = 0; for (let t = 0; t < A.deepseekLoopTurns; t++) loopIn += promptTokens.frozen + t * A.deepseekPageTokens;
  const per = {
    gemini_one_call: g({ input: promptTokens.frozen + A.geminiGroundedExtraInput, output: A.frozenOutput, thinking: A.frozenThinkingLow }, A.groundingQueriesPerCall) + gr,
    deepseek_loop: d({ input: loopIn, output: A.frozenOutput, thinking: A.deepseekThinking * 2 }) + gr,
    quick_evidence: g({ input: promptTokens.skill + A.geminiGroundedExtraInput, output: A.quickPassOutput, thinking: A.frozenThinkingLow }, A.groundingQueriesPerCall) + gr,
    "two_call:gemini-3.8-flash (scorer)": g({ input: promptTokens.factsOnly, output: A.factsOnlyOutput, thinking: A.frozenThinkingLow }),
    "two_call:deepseek-v4.1-flash (scorer)": d({ input: promptTokens.factsOnly, output: A.factsOnlyOutput, thinking: A.deepseekThinking }),
  };
  const one = Object.values(per).reduce((s, x) => s + x, 0);
  return { perAthleteRun: per, total: one * athletes * runs };
}
