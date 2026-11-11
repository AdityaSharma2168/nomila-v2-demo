/**
 * agent/research/llm.ts — one structured model call for a skill: the OpenAI Responses API, the native `web_search`
 * built-in when the skill uses it, and a strict JSON response schema. A skill models.ts routes to Gemini (the routine
 * `cheap` tier) goes to agent/geminiProvider.ts callGeminiStructured instead: same result, no web search.
 *
 * Why not the harness's chat turn (agent/openaiResponses.ts): research and Understand need two things a chat turn does
 * not — a JSON response schema (`text.format`) and the full list of sources every search consulted
 * (`include: web_search_call.action.sources`), which is how code checks that each fact's URL was actually seen. Same
 * SDK, same stateless shape (`store: false`), same pricing (models.ts), same prompt-cache routing.
 *
 * - Outside text: a skill that declares an `external` input has its whole input fenced here, on both providers, by
 *   the shared escaper (jobs.ts fenceSkillInput → lib/externalContent.ts). Callers never fence it themselves.
 * - Prompt caching: the skill's procedure is the `instructions` (a stable prefix, identical across athletes); the
 *   athlete's data is the `input`. `prompt_cache_key` is the skill id + version, never athlete data.
 * - Streaming, so a long research pass (minutes, many searches) never sits on one idle socket.
 * - Effort and model come from the skill through models.ts (modelFor). Nothing here names a model.
 * - Credentials: OPENAI_API_KEY, read on the first call. Never logged. Tests inject a transport and never reach OpenAI.
 */
import OpenAI from "openai";
import type { JsonSchema, ModelChoice, RunCost, Skill } from "../../../shared/agent";
import { callGeminiStructured } from "../geminiProvider";
import { costOf, wireEffort, type ModelUsage } from "../models";
import { assertPlatformBudget } from "../../lib/platformSpend";
import { fenceSkillInput, instructionsFor } from "../jobs";

/** The slice of the SDK this module uses — so a test double is a few lines. */
export interface ResponsesTransport {
  create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AsyncIterable<any>>;
}

let _transport: ResponsesTransport | null = null;
let _override: ResponsesTransport | null = null;

/** Tests (and the smoke script's dry mode) swap the transport. Pass null to restore the real one. */
export function setResponsesTransport(t: ResponsesTransport | null): void {
  _override = t;
}

function transport(): ResponsesTransport {
  if (_override) return _override;
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set: the research skills cannot call OpenAI");
  if (!_transport) {
    // The installed SDK (4.104) types some current Responses params loosely; the call shape is the GA one.
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20 * 60_000, maxRetries: 1 }) as any;
    _transport = { create: (params, options) => client.responses.create(params, options) };
  }
  return _transport;
}

export interface StructuredCallRequest {
  /** With `inputs`: an input declared `external` fences the whole run input (jobs.ts fenceSkillInput). */
  skill: Pick<Skill, "id" | "version" | "instructions"> & Partial<Pick<Skill, "inputs">>;
  model: ModelChoice;
  /**
   * The variable part: the athlete's data for this run, as text, or a Responses input list when the call carries an
   * image (atmosphere/check sends one `input_image` beside its text).
   */
  input: string | Array<Record<string, unknown>>;
  schemaName: string;
  /** A strict JSON schema (every object closes additionalProperties and lists every key as required). */
  schema: JsonSchema;
  /** Offer the native web_search built-in, capped at maxCalls searches. */
  webSearch?: { maxCalls: number; contextSize?: "low" | "medium" | "high" };
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Live: each completed web_search call (its queries and sources), as the stream delivers it. */
  onSearch?: (search: { queries: string[]; sources: Array<{ url: string; title?: string }> }) => void;
  /** Live: the answer text so far, each time it grows. */
  onText?: (textSoFar: string) => void;
}

export interface StructuredCallResult {
  json: unknown;
  text: string;
  status: string;
  responseId: string | null;
  usage: ModelUsage;
  cost: RunCost;
  /** Queries the model issued, in order. */
  queries: string[];
  /** Every source a search consulted or the answer cited, de-duplicated, in first-seen order. */
  sources: Array<{ url: string; title?: string }>;
  durationMs: number;
}

export class ModelCallError extends Error {
  constructor(message: string, readonly partial?: Partial<StructuredCallResult>) {
    super(message);
  }
}

/** The request body. Exported for tests. */
export function buildStructuredRequest(req: StructuredCallRequest): Record<string, unknown> {
  return {
    model: req.model.model,
    // The base block (harness rules) + the procedure: the stable, cacheable prefix.
    instructions: instructionsFor(req.skill),
    // The athlete's data, fenced ONCE here when the skill declares outside text in it (never by the caller).
    input: fenceSkillInput(req.skill, req.input),
    ...(req.webSearch
      ? {
          tools: [{ type: "web_search", search_context_size: req.webSearch.contextSize ?? "medium" }],
          max_tool_calls: req.webSearch.maxCalls,
          include: ["web_search_call.action.sources"],
        }
      : {}),
    reasoning: { effort: wireEffort(req.model.model, req.model.effort) },
    text: { format: { type: "json_schema", name: req.schemaName, schema: req.schema, strict: true } },
    ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
    prompt_cache_key: `nomila:${req.skill.id}@${req.skill.version}`,
    store: false,
    stream: true,
  };
}

/** The URL as stored and shown: tracking parameters (utm_*) the search tool appends and the fragment removed. */
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.toString();
  } catch {
    return raw.trim();
  }
}

/** A comparison key for "the same page": the clean URL, host lower-cased without www., no trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(cleanUrl(raw));
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

/** Parse a completed response. Exported for tests. */
export function parseStructuredResponse(response: any): Omit<StructuredCallResult, "cost" | "durationMs"> {
  const output: any[] = Array.isArray(response?.output) ? response.output : [];
  let text = "";
  const queries: string[] = [];
  const sources: Array<{ url: string; title?: string }> = [];
  const seen = new Set<string>();
  const addSource = (url: unknown, title: unknown) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    const n = normalizeUrl(url);
    if (seen.has(n)) return;
    seen.add(n);
    sources.push({ url: cleanUrl(url), ...(typeof title === "string" && title ? { title } : {}) });
  };
  let webSearchCalls = 0;
  for (const item of output) {
    if (item?.type === "web_search_call") {
      webSearchCalls++;
      const q = item.action?.query ?? item.action?.queries;
      if (typeof q === "string" && q) queries.push(q);
      else if (Array.isArray(q)) for (const s of q) if (typeof s === "string") queries.push(s);
      for (const s of Array.isArray(item.action?.sources) ? item.action.sources : []) addSource(s?.url, s?.title);
    } else if (item?.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type !== "output_text" || typeof part.text !== "string") continue;
        text += part.text;
        for (const a of Array.isArray(part.annotations) ? part.annotations : []) {
          if (a?.type === "url_citation") addSource(a.url, a.title);
        }
      }
    }
  }
  let json: unknown = null;
  const trimmed = text.trim();
  if (trimmed) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
      const candidate = fenced ? fenced[1] : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
      try { json = JSON.parse(candidate); } catch { json = null; }
    }
  }
  const usage = response?.usage ?? {};
  return {
    json,
    text,
    status: typeof response?.status === "string" ? response.status : "unknown",
    responseId: typeof response?.id === "string" ? response.id : null,
    usage: {
      inputTokens: Number(usage.input_tokens ?? 0),
      cachedInputTokens: Number(usage.input_tokens_details?.cached_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      reasoningTokens: Number(usage.output_tokens_details?.reasoning_tokens ?? 0),
      webSearchCalls,
    },
    queries,
    sources,
  };
}

/**
 * The same structured call on Gemini Flash (Vertex), for the routine skills models.ts routes there (the `cheap` tier).
 * No web search on Gemini: a request with `webSearch` throws before any call (agent/geminiProvider.ts). Same result
 * shape and the same "no valid JSON is an error" rule; Gemini has no search, so queries and sources are always empty.
 */
async function callStructuredOnGemini(req: StructuredCallRequest): Promise<StructuredCallResult> {
  const r = await callGeminiStructured({
    skill: req.skill, model: req.model, input: fenceSkillInput(req.skill, req.input), schema: req.schema, webSearch: req.webSearch,
    maxOutputTokens: req.maxOutputTokens, signal: req.signal, onText: req.onText,
  });
  const result: StructuredCallResult = { ...r, queries: [], sources: [] };
  if (r.json == null || typeof r.json !== "object") {
    throw new ModelCallError(`${req.skill.id}: the model returned no valid JSON (status ${r.status})`, result);
  }
  return result;
}

/** One structured call. Throws ModelCallError (with whatever usage it saw) when the model returns no valid JSON. */
export async function callStructured(req: StructuredCallRequest): Promise<StructuredCallResult> {
  // The platform-wide day ceiling (lib/platformSpend.ts), at the primitive: callers that skip runSkill (the lean
  // research's direct path, atmosphere, brand cover/site search, deal replies, opportunity reads) are refused too.
  await assertPlatformBudget();
  if (req.model.provider === "gemini") return callStructuredOnGemini(req);
  const t0 = Date.now();
  const stream = await transport().create(buildStructuredRequest(req), req.signal ? { signal: req.signal } : undefined);
  let final: any = null;
  let textSoFar = "";
  for await (const ev of stream) {
    if (ev?.type === "response.output_item.done" && ev.item?.type === "web_search_call" && req.onSearch) {
      const one = parseStructuredResponse({ output: [ev.item] });
      try { req.onSearch({ queries: one.queries, sources: one.sources }); } catch { /* live events never break the call */ }
    } else if (ev?.type === "response.output_text.delta" && typeof ev.delta === "string" && req.onText) {
      textSoFar += ev.delta;
      try { req.onText(textSoFar); } catch { /* live events never break the call */ }
    } else if (ev?.type === "response.completed" || ev?.type === "response.incomplete") final = ev.response;
    else if (ev?.type === "response.failed") throw new ModelCallError(`OpenAI response failed: ${ev.response?.error?.message ?? "unknown"}`);
    else if (ev?.type === "error") throw new ModelCallError(`OpenAI stream error: ${ev.message ?? "unknown"}`);
  }
  if (!final) throw new ModelCallError("OpenAI stream ended without a completed response");
  const parsed = parseStructuredResponse(final);
  const result: StructuredCallResult = { ...parsed, cost: costOf(req.model.model, parsed.usage), durationMs: Date.now() - t0 };
  if (parsed.json == null || typeof parsed.json !== "object") {
    throw new ModelCallError(`${req.skill.id}: the model returned no valid JSON (status ${parsed.status})`, result);
  }
  return result;
}
