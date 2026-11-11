/**
 * agent/openaiResponses.ts — the OpenAI Responses API adapter (Mila's thinking).
 *
 * - Streaming: `responses.create({ stream: true })`; text deltas go to onText, the final `response.completed` (or
 *   `response.incomplete`) event carries the whole response, which is what we parse.
 * - Tool calls: our tools and connector tools are offered as `function` tools; the model's `function_call` items come
 *   back with a call_id, and results go back as `function_call_output` items.
 * - Web search: the native `web_search` built-in. Its queries come from `web_search_call` items and its sources from the
 *   `url_citation` annotations on the answer.
 * - Reasoning effort: `reasoning.effort` from the skill's ModelChoice.
 * - Stateless and not stored: `store: false`, and reasoning comes back encrypted (`include: reasoning.encrypted_content`)
 *   so it can be replayed without OpenAI keeping the conversation. Within a run, the harness appends EVERY output item
 *   of a call that made function calls (reasoning items included) before the function_call_output items, as OpenAI
 *   advises for reasoning models; `outputItems` is the response's output exactly as returned.
 * - Function tools are sent with `strict: true` when the harness marks the schema strict-ready (all of ours are).
 * - Prompt caching: automatic on OpenAI for a stable prefix; `prompt_cache_key` (the skill id + version, never athlete
 *   data) routes a skill's runs to the same cache.
 * - Usage → cost: input / cached input / output / reasoning tokens and web_search calls, priced in models.ts.
 *
 * Credentials: OPENAI_API_KEY from the environment, read when the first call is made. Never logged. Tests inject a fake
 * client (`createOpenAIProvider({ client })`) and never reach OpenAI.
 */
import OpenAI from "openai";
import { wireEffort } from "./models";
import type { AgentModelProvider, ProviderFunctionCall, ProviderTurnRequest, ProviderTurnResult, ProviderWebSearch } from "./provider";

/** The slice of the SDK the adapter uses — so a test double is a few lines. */
export interface ResponsesClient {
  responses: { create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AsyncIterable<any>> };
}

let _client: ResponsesClient | null = null;
function defaultClient(): ResponsesClient {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set: the agent harness cannot call OpenAI");
  // The installed SDK (4.104) types some current Responses params loosely; the call shape is the GA one.
  return (_client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 1 }) as unknown as ResponsesClient);
}

/** Parse a completed Responses API response into the provider-neutral result. Exported for tests. */
export function parseResponse(response: any): Omit<ProviderTurnResult, "text"> & { text: string } {
  const output: any[] = Array.isArray(response?.output) ? response.output : [];
  let text = "";
  const functionCalls: ProviderFunctionCall[] = [];
  const queries: string[] = [];
  const sources: Array<{ url: string; title?: string }> = [];
  const seen = new Set<string>();
  let webSearchCalls = 0;
  for (const item of output) {
    if (item?.type === "function_call" && typeof item.name === "string") {
      functionCalls.push({ callId: String(item.call_id ?? item.id ?? ""), name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "{}" });
    } else if (item?.type === "web_search_call") {
      webSearchCalls++;
      const q = item.action?.query ?? item.action?.queries;
      if (typeof q === "string" && q) queries.push(q);
      else if (Array.isArray(q)) for (const s of q) if (typeof s === "string") queries.push(s);
      for (const s of Array.isArray(item.action?.sources) ? item.action.sources : []) {
        if (typeof s?.url === "string" && !seen.has(s.url)) { seen.add(s.url); sources.push({ url: s.url, ...(s.title ? { title: String(s.title) } : {}) }); }
      }
    } else if (item?.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type !== "output_text" || typeof part.text !== "string") continue;
        text += part.text;
        for (const a of Array.isArray(part.annotations) ? part.annotations : []) {
          if (a?.type === "url_citation" && typeof a.url === "string" && !seen.has(a.url)) {
            seen.add(a.url);
            sources.push({ url: a.url, ...(typeof a.title === "string" && a.title ? { title: a.title } : {}) });
          }
        }
      }
    }
  }
  const usage = response?.usage ?? {};
  const webSearches: ProviderWebSearch[] = webSearchCalls || sources.length ? [{ queries, sources }] : [];
  return {
    text,
    functionCalls,
    webSearches,
    usage: {
      inputTokens: Number(usage.input_tokens ?? 0),
      cachedInputTokens: Number(usage.input_tokens_details?.cached_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      reasoningTokens: Number(usage.output_tokens_details?.reasoning_tokens ?? 0),
      webSearchCalls,
      // Input written to the prompt cache (billed at 1.25× input, models.ts costOf). Absent on responses that report none.
      cacheWriteTokens: Number(usage.input_tokens_details?.cache_write_tokens ?? usage.input_tokens_details?.cache_creation_tokens ?? 0),
    },
    outputItems: output,
    responseId: typeof response?.id === "string" ? response.id : undefined,
  };
}

/** The request body for one turn. Exported for tests. */
export function buildRequest(req: ProviderTurnRequest): Record<string, unknown> {
  const tools: unknown[] = [
    // Strict mode (structured outputs for function calls) when the harness sent a strict-ready schema: every property
    // required, optional ones nullable, no extra keys (tools.ts strictJsonSchema). The harness drops the nulls again.
    ...req.functions.map((f) => ({ type: "function", name: f.name, description: f.description, parameters: f.parameters, strict: f.strict === true })),
    ...req.builtins.map((b) => ({ type: b })),
  ];
  return {
    model: req.model.model,
    instructions: req.instructions,
    input: req.input,
    ...(tools.length ? { tools } : {}),
    reasoning: { effort: wireEffort(req.model.model, req.model.effort) },
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
    stream: true,
  };
}

export function createOpenAIProvider(opts: { client?: ResponsesClient } = {}): AgentModelProvider {
  return {
    id: "openai",
    userMessage: (text) => ({ role: "user", content: text }),
    assistantMessage: (text) => ({ role: "assistant", content: text }),
    toolOutput: (callId, output) => ({ type: "function_call_output", call_id: callId, output }),
    async turn(req) {
      const client = opts.client ?? defaultClient();
      const stream = await client.responses.create(buildRequest(req), req.signal ? { signal: req.signal } : undefined);
      let final: any = null;
      for await (const ev of stream) {
        if (ev?.type === "response.output_text.delta" && typeof ev.delta === "string") req.onText?.(ev.delta);
        else if (ev?.type === "response.completed" || ev?.type === "response.incomplete") final = ev.response;
        else if (ev?.type === "response.failed") throw new Error(`OpenAI response failed: ${ev.response?.error?.message ?? "unknown"}`);
        else if (ev?.type === "error") throw new Error(`OpenAI stream error: ${ev.message ?? "unknown"}`);
      }
      if (!final) throw new Error("OpenAI stream ended without a completed response");
      return parseResponse(final);
    },
  };
}
