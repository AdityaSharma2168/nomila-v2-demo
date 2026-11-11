/**
 * agent/geminiProvider.ts — the Gemini adapter (Vertex, Flash) for the agent's ROUTINE jobs.
 *
 * The provider rule (10 Oct 2026): OpenAI for anything athlete-facing or any judgement an athlete sees, and for ALL
 * web search; Gemini Flash on Vertex (the GCP credits) for routine extraction, classification and tagging; voice stays
 * on Gemini Live; no per-message routing in chat. models.ts decides which skills land here (today: the `cheap` tier,
 * i.e. atmosphere/queries and atmosphere/check). Nothing in this file picks a model.
 *
 * Two entry points, mirroring the OpenAI side:
 *   - createGeminiProvider()   the harness's AgentModelProvider (agent/provider.ts): streamed text, function tools,
 *                              usage. Same interface as openaiResponses.ts, so the harness loop does not change.
 *   - callGeminiStructured()   one structured skill call with a JSON response schema (agent/research/llm.ts
 *                              callStructured delegates here when the skill's ModelChoice says provider "gemini").
 *
 * - Client: the repo's shared Vertex client (server/lib/models.ts genai(): ADC auth, project GCP_PROJECT_ID, location
 *   VERTEX_LOCATION, default `global`, which is the only location that serves the 3.x models). No API key.
 * - Streaming: `models.generateContentStream`; each non-thought text part goes to onText as it arrives.
 * - Function tools: offered as `functionDeclarations` with the JSON schema passed as `parametersJsonSchema`. The model's
 *   `functionCall` parts come back; results go back as `functionResponse` parts. Gemini needs the function NAME on
 *   the response, and the harness only hands back a call id, so the call id this adapter mints carries the name
 *   (`<name>#<id>`); toolOutput reads it back.
 * - Thought signatures: the model's content is appended to the conversation exactly as streamed (every part, including
 *   `thoughtSignature`), which is what Gemini 3 needs to continue a function-calling turn.
 * - Structured output: `responseMimeType: application/json` + `responseJsonSchema`.
 * - Effort: the skill's effort as `thinkingConfig.thinkingLevel` (minimal | low | medium | high → MINIMAL … HIGH).
 * - NO WEB SEARCH. Search stays on OpenAI by rule. A skill routed here that lists web_search (or asks a structured call
 *   for webSearch) fails loudly, before any call is made: a silent run without search would look like "nothing found".
 *   This file configures no search or grounding tool of any kind.
 * - Concurrency: structured calls go through geminiGate (server/lib/llm.ts), the shared Vertex Gemini gate.
 * - Usage → cost: promptTokenCount (cachedContentTokenCount is a subset of it, as on OpenAI); output = candidates +
 *   thoughts (thinking bills as output; reasoningTokens is the thoughts subset). Priced in models.ts.
 *
 * Tests inject a client (`createGeminiProvider({ client })`, `setGeminiClient`) and never reach Vertex.
 */
import type { JsonSchema, ModelChoice, RunCost, Skill } from "../../shared/agent";
import { geminiGate } from "../lib/llm";
import { costOf, type ModelUsage } from "./models";
import type { AgentModelProvider, ProviderFunctionCall, ProviderTurnRequest, ProviderTurnResult } from "./provider";
import { instructionsFor } from "./jobs";

/** The slice of the @google/genai client the adapter uses — so a test double is a few lines. */
export interface GeminiClient {
  models: { generateContentStream(params: Record<string, any>): Promise<AsyncIterable<any>> };
}

let _override: GeminiClient | null = null;

/** Tests swap the client. Pass null to restore the real one. */
export function setGeminiClient(c: GeminiClient | null): void {
  _override = c;
}

async function defaultClient(): Promise<GeminiClient> {
  if (_override) return _override;
  // Lazy import: the Vertex client (and its tracing) loads only when a Gemini call is actually made.
  const { genai } = await import("../lib/models");
  return genai() as unknown as GeminiClient;
}

export class GeminiWebSearchRefused extends Error {
  constructor(what: string) {
    super(`${what}: web search is not available on Gemini (search stays on OpenAI by rule). Route this skill to an OpenAI tier in server/agent/models.ts`);
    this.name = "GeminiWebSearchRefused";
  }
}

const THINKING_LEVEL: Record<ModelChoice["effort"], string> = { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" };

/** Usage metadata → ModelUsage (OpenAI's shape: cached ⊂ input, reasoning ⊂ output). Exported for tests. */
export function usageOf(meta: any): ModelUsage {
  const thoughts = Number(meta?.thoughtsTokenCount ?? 0);
  return {
    inputTokens: Number(meta?.promptTokenCount ?? 0),
    cachedInputTokens: Number(meta?.cachedContentTokenCount ?? 0),
    outputTokens: Number(meta?.candidatesTokenCount ?? 0) + thoughts,
    reasoningTokens: thoughts,
    webSearchCalls: 0,
  };
}

const CALL_SEP = "#";
const nameOfCall = (callId: string): string => {
  const i = callId.lastIndexOf(CALL_SEP);
  return i > 0 ? callId.slice(0, i) : callId;
};

/** One streamed generation, folded: the model's content (all parts, as streamed), its text, its calls, its usage. */
interface Folded { parts: any[]; text: string; finishReason: string | null; usage: ModelUsage; responseId?: string }

async function fold(stream: AsyncIterable<any>, onText?: (delta: string) => void): Promise<Folded> {
  const parts: any[] = [];
  let text = "";
  let finishReason: string | null = null;
  let meta: any = null;
  let responseId: string | undefined;
  for await (const chunk of stream) {
    if (chunk?.usageMetadata) meta = chunk.usageMetadata;
    if (typeof chunk?.responseId === "string") responseId = chunk.responseId;
    const cand = chunk?.candidates?.[0];
    if (cand?.finishReason) finishReason = String(cand.finishReason);
    for (const p of Array.isArray(cand?.content?.parts) ? cand.content.parts : []) {
      parts.push(p);
      if (typeof p?.text === "string" && !p.thought) {
        text += p.text;
        if (p.text) onText?.(p.text);
      }
    }
  }
  if (finishReason && /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finishReason) && !text && !parts.some((p) => p?.functionCall)) {
    throw new Error(`Gemini stopped the response: ${finishReason}`);
  }
  return { parts, text, finishReason, usage: usageOf(meta), responseId };
}

/**
 * Consecutive functionResponse turns merged into one user turn: Gemini expects the answers to one model turn's calls
 * together. Everything else passes through unchanged. Exported for tests.
 */
export function mergeToolResponses(input: unknown[]): unknown[] {
  const out: any[] = [];
  const isResponses = (c: any) => c?.role === "user" && Array.isArray(c.parts) && c.parts.length > 0 && c.parts.every((p: any) => p?.functionResponse);
  for (const c of input as any[]) {
    const last = out[out.length - 1];
    if (isResponses(c) && isResponses(last)) out[out.length - 1] = { role: "user", parts: [...last.parts, ...c.parts] };
    else out.push(c);
  }
  return out;
}

/** The request for one harness turn. Exported for tests. Throws (before any call) when the turn asks for a built-in. */
export function buildTurnRequest(req: ProviderTurnRequest): Record<string, any> {
  if (req.builtins.length) throw new GeminiWebSearchRefused(`built-in tool(s) ${req.builtins.join(", ")} requested`);
  return {
    model: req.model.model,
    contents: mergeToolResponses(req.input),
    config: {
      systemInstruction: req.instructions,
      ...(req.functions.length
        ? { tools: [{ functionDeclarations: req.functions.map((f) => ({ name: f.name, description: f.description, parametersJsonSchema: f.parameters })) }] }
        : {}),
      thinkingConfig: { thinkingLevel: THINKING_LEVEL[req.model.effort] },
      ...(req.signal ? { abortSignal: req.signal } : {}),
    },
  };
}

export function createGeminiProvider(opts: { client?: GeminiClient } = {}): AgentModelProvider {
  return {
    id: "gemini",
    userMessage: (text) => ({ role: "user", parts: [{ text }] }),
    assistantMessage: (text) => ({ role: "model", parts: [{ text }] }),
    toolOutput: (callId, output) => {
      let response: unknown;
      try { response = JSON.parse(output); } catch { response = output; }
      // functionResponse.response must be an object; the tool's JSON goes under `output` (Gemini's documented key).
      const wrapped = response && typeof response === "object" && !Array.isArray(response) ? response : { output: response };
      return { role: "user", parts: [{ functionResponse: { name: nameOfCall(callId), response: wrapped } }] };
    },
    async turn(req): Promise<ProviderTurnResult> {
      const body = buildTurnRequest(req);
      const client = opts.client ?? (await defaultClient());
      const f = await fold(await client.models.generateContentStream(body), req.onText);
      const functionCalls: ProviderFunctionCall[] = [];
      f.parts.forEach((p, i) => {
        const fc = p?.functionCall;
        if (!fc || typeof fc.name !== "string") return;
        functionCalls.push({ callId: `${fc.name}${CALL_SEP}${fc.id ?? i}`, name: fc.name, arguments: JSON.stringify(fc.args ?? {}) });
      });
      return {
        text: f.text,
        functionCalls,
        webSearches: [],
        usage: f.usage,
        outputItems: f.parts.length ? [{ role: "model", parts: f.parts }] : [],
        responseId: f.responseId,
      };
    },
  };
}

// ─── Structured skill calls ─────────────────────────────────────────────────────────────────────────────────────────

export interface GeminiStructuredRequest {
  skill: Pick<Skill, "id" | "version" | "instructions">;
  model: ModelChoice;
  /** Text, or a Responses-style input list (input_text / input_image parts), translated here to Gemini parts. */
  input: string | Array<Record<string, unknown>>;
  schema: JsonSchema;
  webSearch?: unknown;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onText?: (textSoFar: string) => void;
}

export interface GeminiStructuredResult {
  json: unknown;
  text: string;
  status: string;
  responseId: string | null;
  usage: ModelUsage;
  cost: RunCost;
  durationMs: number;
}

/** A Responses-style content part → a Gemini part. Exported for tests. */
export function partOf(p: Record<string, any>): Record<string, unknown> {
  if (p?.type === "input_text" || p?.type === "text") return { text: String(p.text ?? "") };
  if (p?.type === "input_image") {
    const url = String(p.image_url ?? "");
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
    throw new Error("Gemini structured call: an input_image must be a base64 data URL (the adapter never fetches a URL)");
  }
  throw new Error(`Gemini structured call: unsupported input part type ${String(p?.type)}`);
}

/** Text or a Responses-style input list → Gemini contents. Exported for tests. */
export function contentsOf(input: GeminiStructuredRequest["input"]): Array<Record<string, unknown>> {
  if (typeof input === "string") return [{ role: "user", parts: [{ text: input }] }];
  return input.map((m: Record<string, any>) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: typeof m.content === "string" ? [{ text: m.content }] : (Array.isArray(m.content) ? m.content : []).map(partOf),
  }));
}

/** The request body. Exported for tests. Throws (before any call) when web search is asked for. */
export function buildStructuredGeminiRequest(req: GeminiStructuredRequest): Record<string, any> {
  if (req.webSearch) throw new GeminiWebSearchRefused(`${req.skill.id}`);
  return {
    model: req.model.model,
    contents: contentsOf(req.input),
    config: {
      systemInstruction: instructionsFor(req.skill),
      responseMimeType: "application/json",
      responseJsonSchema: req.schema,
      thinkingConfig: { thinkingLevel: THINKING_LEVEL[req.model.effort] },
      ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(req.signal ? { abortSignal: req.signal } : {}),
    },
  };
}

function parseJson(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  try { return JSON.parse(fenced ? fenced[1] : t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch { return null; }
}

/**
 * One structured call on Gemini. Returns whatever came back (json null when it did not parse); the caller
 * (callStructured) decides that no valid JSON is an error, the same way for both providers.
 */
export async function callGeminiStructured(req: GeminiStructuredRequest): Promise<GeminiStructuredResult> {
  const body = buildStructuredGeminiRequest(req);
  const t0 = Date.now();
  const client = await defaultClient();
  let soFar = "";
  const f = await geminiGate.run(async () => fold(await client.models.generateContentStream(body), (d) => {
    soFar += d;
    try { req.onText?.(soFar); } catch { /* live events never break the call */ }
  }));
  return {
    json: parseJson(f.text),
    text: f.text,
    status: f.finishReason === "MAX_TOKENS" ? "incomplete" : f.finishReason ? "completed" : "unknown",
    responseId: f.responseId ?? null,
    usage: f.usage,
    cost: costOf(req.model.model, f.usage),
    durationMs: Date.now() - t0,
  };
}
