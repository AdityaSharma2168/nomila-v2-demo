/**
 * lib/research/providers/openaiDirect.ts — OpenAI one-call direct research (path B; 13 Sep 2026).
 *
 * Research / Fact Mode: the `web_search` tool ON. One Responses call per ResearchSpec query returns the
 * direct-evidence/1 JSON (contract in the prompt text: OpenAI rejects JSON mode together with web search), and the
 * request includes `web_search_call.action.sources` so the search call's retrieved-source list comes back natively.
 * Lineage is bound downstream by exact, then conservatively normalized, URL matching against that list
 * (native_retrieved). OpenAI exposes no claim-level binding for structured output, and none is manufactured.
 * Same retry / nonce / reservation semantics as the search adapters. Never throws.
 */

import OpenAI from "openai";
import type { SearchEnvelope } from "../../../services/intelligence/research/providers";
import { DIRECT_OUTPUT_RULE_JSON, parseDirectEvidence, type ParsedDirect } from "../../../services/intelligence/research/spec/directEvidenceV1";
import { DIRECT_V2_OUTPUT_RULE_JSON, parseDirectEvidenceV2, type ParsedDirectV2 } from "../../../services/intelligence/research/spec/directEvidenceV2";
import type { DirectContract , DirectCallOpts, DirectCallResult } from "./geminiDirect";
import { matchOpenAIClaim, openaiSourcesToEnvelopeChunks, withLineage, type RetrievedSourceLike } from "../../../services/intelligence/research/spec/directLineage";
import { compileSystemInstruction, type Section } from "../../../services/intelligence/research/spec/researchSpecV1";
import { OPENAI_RESEARCH_MODEL, OPENAI_SEARCH_CONTEXT_SIZE } from "./openaiWebSearch";


export const OPENAI_DIRECT_PROVIDER_ID = "openai_direct";
/** Research / Fact Mode reasoning budget (production rule, PR #448 §5): explicit, never the model default. */
export const OPENAI_RESEARCH_REASONING = { effort: (process.env.OPENAI_RESEARCH_REASONING_EFFORT ?? "low") as "low" | "medium" | "high" | "minimal" };

export interface OpenAIDirectRaw { text: string; sources: RetrievedSourceLike[]; searchQueries: string[]; annotations: number; finishReason?: string; responseId?: string; promptTokens?: number; completionTokens?: number; cachedTokens?: number }

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set (benchmark harness: put it in the local .env; it is not a Cloud Run variable)");
  return (_client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 180_000, maxRetries: 0 }));
}

export function parseDirectResponse(response: any): OpenAIDirectRaw {
  let text = ""; const sources: RetrievedSourceLike[] = []; const searchQueries: string[] = []; let annotations = 0;
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type === "web_search_call") {
      const a = item.action ?? {};
      if (typeof a.query === "string" && a.query) searchQueries.push(a.query);
      for (const s of Array.isArray(a.sources) ? a.sources : []) { const url = typeof s === "string" ? s : s?.url; if (typeof url === "string" && url) sources.push({ url, title: typeof s?.title === "string" ? s.title : null }); }
      continue;
    }
    if (item?.type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) if (part?.type === "output_text" && typeof part.text === "string") { text += (text ? "\n" : "") + part.text; annotations += Array.isArray(part.annotations) ? part.annotations.length : 0; }
  }
  const usage = response?.usage ?? {};
  return { text, sources, searchQueries, annotations, finishReason: response?.status === "incomplete" ? `incomplete:${response?.incomplete_details?.reason ?? "unknown"}` : (response?.status ?? "unknown"), responseId: typeof response?.id === "string" ? response.id : undefined, promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, cachedTokens: usage.input_tokens_details?.cached_tokens };
}

export async function runOpenAIDirectOnce(request: string, contract: DirectContract = "v2"): Promise<OpenAIDirectRaw> {
  const response: any = await (client() as any).responses.create({
    model: OPENAI_RESEARCH_MODEL,
    instructions: `${compileSystemInstruction("openai")} ${contract === "v2" ? DIRECT_V2_OUTPUT_RULE_JSON : DIRECT_OUTPUT_RULE_JSON}`,
    input: request,
    tools: [{ type: "web_search", search_context_size: OPENAI_SEARCH_CONTEXT_SIZE }],
    include: ["web_search_call.action.sources"],
    reasoning: OPENAI_RESEARCH_REASONING,
  });
  return parseDirectResponse(response);
}

export async function openaiDirect(request: string, opts: Omit<DirectCallOpts, "call"> & { call?: (request: string) => Promise<OpenAIDirectRaw> }): Promise<DirectCallResult> {
  const contract: DirectContract = opts.contract ?? "v2";
  if (contract === "v2" && !opts.query) throw new Error("openaiDirect: contract v2 needs opts.query");
  const call = opts.call ?? ((r: string) => runOpenAIDirectOnce(r, contract));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchedAt = new Date().toISOString();
  const t0 = Date.now();
  const errors: SearchEnvelope["errors"] = [];
  const totals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, incomplete: false };
  let last: OpenAIDirectRaw = { text: "", sources: [], searchQueries: [], annotations: 0 };
  let parsed: ParsedDirect | null = null; let parsedV2: ParsedDirectV2 | null = null;
  let attempts = 0, refused = false;
  const maxAttempts = 1 + Math.max(0, opts.retryMax);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!(await opts.reserve())) { refused = true; errors.push({ step: `attempt-${attempt}`, message: "LLM budget reservation refused — no call made", class: "budget" }); break; }
    attempts++;
    const nonce = attempt > 1 ? ` [retry-${attempt}-ts:${Date.now()}]` : "";
    try {
      const r = await call(request + nonce);
      last = r;
      totals.promptTokens += r.promptTokens ?? 0; totals.completionTokens += r.completionTokens ?? 0; totals.cachedTokens += r.cachedTokens ?? 0;
      if (r.promptTokens == null && r.completionTokens == null) totals.incomplete = true;
      const p1 = contract === "v1" ? parseDirectEvidence(r.text, opts.sections) : null;
      const p2 = contract === "v2" ? parseDirectEvidenceV2(r.text, opts.query!, opts.sections) : null;
      const parseError = p1?.parseError ?? p2?.parseError ?? null;
      if (!r.text.trim()) errors.push({ step: `attempt-${attempt}`, message: `empty answer (${r.finishReason ?? "unknown"})`, class: "empty" });
      else if (parseError) { errors.push({ step: `attempt-${attempt}`, message: `JSON did not parse: ${parseError}`, class: "empty" }); parsed = p1; parsedV2 = p2; }
      else { parsed = p1; parsedV2 = p2; break; }
    } catch (e: any) {
      totals.incomplete = true;
      errors.push({ step: `attempt-${attempt}`, message: String(e?.message ?? e).slice(0, 300), class: "transient" });
    }
    if (attempt < maxAttempts) await sleep(Math.pow(2, attempt - 1) * 1000 + Math.random() * 500);
  }
  const completed = (contract === "v1" && !!parsed && !parsed.parseError) || (contract === "v2" && !!parsedV2 && !parsedV2.parseError);
  const chunks = openaiSourcesToEnvelopeChunks(last.sources, opts.envelopeId);
  if (parsed) parsed = { ...parsed, claims: parsed.claims.map((c) => withLineage(c, matchOpenAIClaim(c.sources, last.sources, opts.envelopeId))) };
  if (parsedV2) parsedV2 = { ...parsedV2, items: Object.fromEntries(Object.entries(parsedV2.items).map(([id, it]) => [id, it ? { ...it, findings: it.findings.map((f) => ({ ...f, lineage: matchOpenAIClaim(f.sources, last.sources, opts.envelopeId) })) } : it])) };
  const envelope: SearchEnvelope = {
    id: opts.envelopeId, provider: OPENAI_DIRECT_PROVIDER_ID, model: OPENAI_RESEARCH_MODEL, queryName: opts.queryName, query: request, fetchedAt,
    answerText: "", chunks, supports: [],
    raw: { text: last.text, sources: last.sources, searchQueries: last.searchQueries, annotations: last.annotations, finishReason: last.finishReason ?? null, responseId: last.responseId ?? null },
    request: { path: "responses.create", params: { model: OPENAI_RESEARCH_MODEL, tools: "web_search", include: "web_search_call.action.sources", mode: "direct_json", contract, reasoning: OPENAI_RESEARCH_REASONING, queryName: opts.queryName } },
    usage: { promptTokens: attempts ? totals.promptTokens : undefined, completionTokens: attempts ? totals.completionTokens : undefined, cachedTokens: attempts ? totals.cachedTokens : undefined, calls: attempts, latencyMs: Date.now() - t0, ...(totals.incomplete ? { usageIncomplete: true } : {}) },
    errors: completed ? [] : errors,
  };
  return { envelope, parsed, parsedV2, prose: "", markerFound: false, attempts, refused, completed, nativeSources: last.sources.length, searchQueries: last.searchQueries.length };
}
