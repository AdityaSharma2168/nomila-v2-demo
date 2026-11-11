/**
 * lib/research/providers/openaiWebSearch.ts — OpenAI Responses API web search → SearchEnvelope.
 *
 * The second search arm of the research provider benchmark (Step 4 calibration). It expresses the
 * SAME research intent as geminiGrounded.ts — the same system instruction (compiled only from
 * "Google Search" to "web search"), the same query text, the same retry/nonce/empty-answer
 * handling — through OpenAI's built-in `web_search` tool, and maps the response onto the
 * provider-independent SearchEnvelope: every distinct cited URL becomes a Chunk whose text is the
 * union of the PROVIDER's answer spans the url_citation annotations attribute to it (OpenAI, like
 * Gemini grounding, returns no page text — `textKind` is `provider_answer_segments`), and every
 * annotation becomes a Support. Nothing here is a source-page excerpt. Kimi extraction, lineage
 * validation and the resolver then treat both arms identically.
 *
 * Differences from Gemini grounding that the benchmark must interpret (documented in
 * docs/architecture/phase-a/step4-research-provider-benchmark.md): OpenAI annotations carry no
 * per-span confidence (Support.confidence is undefined); the search queries the model issued are
 * only visible as `web_search_call` output items.
 *
 * Credentials: OPENAI_API_KEY from the environment (local .env for the harness; Secret Manager on Cloud Run). Never logged.
 *
 * Runtime use: the sign-up quick score (services/quickScore/step.ts) calls runOpenAIOnce with its own model, search
 * context, tool-call cap, output ceiling and timeout (RunOnceOptions); every other caller keeps the module defaults.
 */

import OpenAI from "openai";
import type { Chunk, SearchEnvelope, Support } from "../../../services/intelligence/research/providers";
import { GROUNDED_SYSTEM, type GroundedSearchOpts, type GroundedSearchResult } from "./geminiGrounded";

export const OPENAI_PROVIDER_ID = "openai_web_search";
/** Approved benchmark tier (12 Sep 2026): the routine-research tier, matched to gemini-3.5-flash. Env-overridable like GEMINI.*. */
export const OPENAI_RESEARCH_MODEL = process.env.OPENAI_RESEARCH_MODEL ?? "gpt-5.4-mini";
export const OPENAI_SEARCH_CONTEXT_SIZE = (process.env.OPENAI_SEARCH_CONTEXT_SIZE ?? "medium") as "low" | "medium" | "high";
/** The Gemini system instruction, compiled for a provider whose tool is not Google Search. No other change. */
export const OPENAI_WEB_SEARCH_SYSTEM = GROUNDED_SYSTEM.replace("Always use Google Search", "Always use web search");

export interface OpenAIWebSearchRaw {
  text: string;
  /** url_citation annotations, with indices into `text`. */
  citations: Array<{ url: string; title: string; startIndex: number | null; endIndex: number | null }>;
  /** Queries the model issued (web_search_call items), when the API exposes them. */
  searchQueries: string[];
  finishReason?: string;
  responseId?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** Reasoning tokens (a subset of completionTokens, billed as output). */
  reasoningTokens?: number;
  /** web_search_call items in the output: each one is a billed search call. */
  searchCalls?: number;
  /** Every page the searches consulted (web_search_call action.sources), in order. Filled only when the request asked
   *  for them (RunOnceOptions.includeSources); empty otherwise. */
  searchSources?: Array<{ url: string; title: string }>;
}

function safeHost(uri: string): string | null { try { return new URL(uri).hostname.replace(/^www\./, ""); } catch { return null; } }

export function toSearchEnvelope(raw: OpenAIWebSearchRaw, opts: { envelopeId: string; queryName: string; query: string; model: string; fetchedAt: string; latencyMs?: number; errors?: SearchEnvelope["errors"] }): SearchEnvelope {
  // One chunk per distinct URL, in first-citation order; supports keep the annotation order.
  const urlIndex = new Map<string, number>();
  const urls: Array<{ url: string; title: string }> = [];
  for (const c of raw.citations) {
    if (!c.url || urlIndex.has(c.url)) continue;
    urlIndex.set(c.url, urls.length);
    urls.push({ url: c.url, title: c.title });
  }
  const chunkText: string[] = urls.map(() => "");
  const supports: Support[] = raw.citations.map((c, j) => {
    const n = urlIndex.get(c.url);
    const text = c.startIndex != null && c.endIndex != null && c.endIndex > c.startIndex ? raw.text.slice(c.startIndex, c.endIndex) : "";
    if (n != null && text) chunkText[n] = chunkText[n] ? (chunkText[n].includes(text) ? chunkText[n] : `${chunkText[n]}\n${text}`) : text;
    return { id: `${opts.envelopeId}:s${j}`, chunkIds: n == null ? [] : [`${opts.envelopeId}:c${n}`], text, start: c.startIndex ?? undefined, end: c.endIndex ?? undefined };
  });
  const chunks: Chunk[] = urls.map((u, n) => ({ id: `${opts.envelopeId}:c${n}`, url: u.url, domain: safeHost(u.url), title: u.title || null, text: chunkText[n], textKind: "provider_answer_segments" }));
  return {
    id: opts.envelopeId, provider: OPENAI_PROVIDER_ID, model: opts.model, queryName: opts.queryName, query: opts.query, fetchedAt: opts.fetchedAt,
    answerText: raw.text, chunks, supports,
    raw: { text: raw.text, citations: raw.citations, searchQueries: raw.searchQueries, finishReason: raw.finishReason ?? null, responseId: raw.responseId ?? null },
    request: { path: "responses.create", params: { model: opts.model, tools: "web_search", searchContextSize: OPENAI_SEARCH_CONTEXT_SIZE, queryName: opts.queryName } },
    usage: { promptTokens: raw.promptTokens, completionTokens: raw.completionTokens, cachedTokens: raw.cachedTokens, calls: 1, latencyMs: opts.latencyMs },
    errors: opts.errors ?? [],
  };
}

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set (benchmark harness: put it in the local .env; it is not a Cloud Run variable)");
  return (_client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 180_000, maxRetries: 0 }));
}

/** Parse a Responses API result: output_text with url_citation annotations (indices re-based onto the concatenated text) and web_search_call queries. */
export function parseResponsesOutput(response: any): OpenAIWebSearchRaw {
  let text = "";
  const citations: OpenAIWebSearchRaw["citations"] = [];
  const searchQueries: string[] = [];
  let searchCalls = 0;
  const searchSources: Array<{ url: string; title: string }> = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type === "web_search_call") {
      searchCalls++;
      const q = item.action?.query ?? item.action?.queries;
      if (typeof q === "string" && q) searchQueries.push(q);
      else if (Array.isArray(q)) for (const s of q) if (typeof s === "string") searchQueries.push(s);
      for (const src of Array.isArray(item.action?.sources) ? item.action.sources : []) {
        if (typeof src?.url === "string" && src.url) searchSources.push({ url: src.url, title: typeof src.title === "string" ? src.title : "" });
      }
      continue;
    }
    if (item?.type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type !== "output_text" || typeof part.text !== "string") continue;
      const base = text.length;
      text += (text ? "\n" : "") + part.text;
      const offset = base ? base + 1 : 0;
      for (const a of Array.isArray(part.annotations) ? part.annotations : []) {
        if (a?.type !== "url_citation" || typeof a.url !== "string") continue;
        citations.push({ url: a.url, title: typeof a.title === "string" ? a.title : "", startIndex: Number.isInteger(a.start_index) ? offset + a.start_index : null, endIndex: Number.isInteger(a.end_index) ? offset + a.end_index : null });
      }
    }
  }
  const usage = response?.usage ?? {};
  return {
    text, citations, searchQueries,
    finishReason: response?.status === "incomplete" ? `incomplete:${response?.incomplete_details?.reason ?? "unknown"}` : (response?.status ?? "unknown"),
    responseId: typeof response?.id === "string" ? response.id : undefined,
    promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, cachedTokens: usage.input_tokens_details?.cached_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens, searchCalls, searchSources,
  };
}

/** Per-call settings for a runtime caller; each one omitted keeps today's call exactly (the module defaults, no cap). */
export interface RunOnceOptions {
  model?: string;
  contextSize?: "low" | "medium" | "high";
  /** max_tool_calls: the most web searches the model may run for this answer. */
  maxToolCalls?: number;
  maxOutputTokens?: number;
  /** reasoning.effort as the model takes it on the wire (agent/models.ts wireEffort). */
  effort?: string;
  timeoutMs?: number;
  /** Ask for every page the searches consulted (include web_search_call.action.sources), not only the inline citations. */
  includeSources?: boolean;
  /** false: the provider keeps no copy of the response (store: false), as the agent harness sends. Omitted: the API default. */
  store?: boolean;
}

/** The request body (exported for tests). */
export function runOnceRequest(query: string, instructions: string, o: RunOnceOptions = {}): Record<string, unknown> {
  return {
    model: o.model ?? OPENAI_RESEARCH_MODEL,
    ...(instructions ? { instructions } : {}),   // "" ⇒ no system instruction (the quick score's frozen prompt is the whole request)
    input: query,
    tools: [{ type: "web_search", search_context_size: o.contextSize ?? OPENAI_SEARCH_CONTEXT_SIZE }],
    ...(o.maxToolCalls ? { max_tool_calls: o.maxToolCalls } : {}),
    ...(o.maxOutputTokens ? { max_output_tokens: o.maxOutputTokens } : {}),
    ...(o.effort ? { reasoning: { effort: o.effort } } : {}),
    ...(o.includeSources ? { include: ["web_search_call.action.sources"] } : {}),
    ...(o.store === false ? { store: false } : {}),
  };
}

export async function runOpenAIOnce(query: string, instructions: string = OPENAI_WEB_SEARCH_SYSTEM, opts: RunOnceOptions = {}): Promise<OpenAIWebSearchRaw> {
  // The installed SDK (4.104) types the tool as `web_search_preview`; the GA tool name is `web_search` on the same endpoint.
  const response: any = await (client() as any).responses.create(runOnceRequest(query, instructions, opts), opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined);
  return parseResponsesOutput(response);
}

export interface WebSearchOpts extends Omit<GroundedSearchOpts, "call"> { call?: (query: string) => Promise<OpenAIWebSearchRaw> }

/** The OpenAI twin of geminiGrounded.groundedSearch: same retry cap semantics, nonce, budget reservation before EVERY attempt, empty-answer detection. */
export async function webSearch(query: string, opts: WebSearchOpts): Promise<GroundedSearchResult> {
  const call = opts.call ?? ((q: string) => runOpenAIOnce(q, opts.systemInstruction ?? OPENAI_WEB_SEARCH_SYSTEM));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchedAt = new Date().toISOString();
  const t0 = Date.now();
  const errors: SearchEnvelope["errors"] = [];
  let last: OpenAIWebSearchRaw = { text: "", citations: [], searchQueries: [], finishReason: "unknown" };
  let attempts = 0;
  let refused = false;
  // Every attempt is billed (search calls and tokens): usage is SUMMED across attempts; a thrown attempt has none → usageIncomplete.
  const totals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, incomplete: false };
  const maxAttempts = 1 + Math.max(0, opts.retryMax);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!(await opts.reserve())) { refused = true; errors.push({ step: `attempt-${attempt}`, message: "LLM budget reservation refused — no call made", class: "budget" }); break; }
    attempts++;
    const nonce = attempt > 1 ? ` [retry-${attempt}-ts:${Date.now()}]` : "";
    try {
      const result = await call(query + nonce);
      last = result;
      totals.promptTokens += result.promptTokens ?? 0; totals.completionTokens += result.completionTokens ?? 0; totals.cachedTokens += result.cachedTokens ?? 0;
      if (result.promptTokens == null && result.completionTokens == null) totals.incomplete = true;
      const empty = result.text.trim().length === 0 || result.citations.length === 0;
      if (!empty) break;
      errors.push({ step: `attempt-${attempt}`, message: `empty web-search answer (${result.finishReason ?? "unknown"})`, class: "empty" });
    } catch (e: any) {
      totals.incomplete = true;
      errors.push({ step: `attempt-${attempt}`, message: String(e?.message ?? e).slice(0, 300), class: "transient" });
    }
    if (attempt < maxAttempts) await sleep(Math.pow(2, attempt - 1) * 1000 + Math.random() * 500);
  }
  const completed = last.citations.length > 0 && last.text.trim().length > 0;
  const envelope = toSearchEnvelope(last, { envelopeId: opts.envelopeId, queryName: opts.queryName, query, model: OPENAI_RESEARCH_MODEL, fetchedAt, latencyMs: Date.now() - t0, errors: completed ? [] : errors });
  envelope.usage = { ...(envelope.usage ?? {}), promptTokens: attempts ? totals.promptTokens : undefined, completionTokens: attempts ? totals.completionTokens : undefined, cachedTokens: attempts ? totals.cachedTokens : undefined, calls: attempts, ...(totals.incomplete ? { usageIncomplete: true } : {}) };
  return { envelope, attempts, refused, completed };
}
