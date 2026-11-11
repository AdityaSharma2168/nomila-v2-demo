/**
 * lib/research/providers/geminiDirect.ts — Gemini one-call direct research (path B; 13 Sep 2026).
 *
 * Research / Fact Mode: Google Search grounding ON. One call per ResearchSpec query returns factual research prose
 * (grounded: chunks + supports attach to it) followed by the direct-evidence/1 JSON whose quotes are copied
 * verbatim from that prose. Lineage is bound downstream by exact quote occurrence + grounding-support index
 * containment (native_supported). The prose is evidence prose only; it is never a precedent for creative output.
 *
 * Production-intended configuration: the model's default thinking (no low budget), grounding temperature 1.0,
 * a large output cap. Same retry / nonce / reservation-before-every-attempt semantics as the search adapters.
 * Retries for an empty answer, a missing marker, unparseable JSON, a thrown call or a timed-out attempt. Every attempt
 * is bounded by a client timeout (opts.timeoutMs, default policy.planner.geminiCallTimeoutMs); a timed-out attempt was
 * reserved, is counted and is recorded like any other failed attempt. Never throws.
 */

import type { ThinkingConfig } from "@google/genai";
import { genai, GEMINI } from "../../models";
import type { SearchEnvelope } from "../../../services/intelligence/research/providers";
import { DIRECT_OUTPUT_RULE_HYBRID, parseDirectEvidence, splitHybrid, type ParsedDirect } from "../../../services/intelligence/research/spec/directEvidenceV1";
import { DIRECT_V2_OUTPUT_RULE_HYBRID, parseDirectEvidenceV2, type ParsedDirectV2 } from "../../../services/intelligence/research/spec/directEvidenceV2";
import { compileSystemInstruction, type QueryDef, type Section } from "../../../services/intelligence/research/spec/researchSpecV1";
import { DEFAULT_GEMINI_CALL_TIMEOUT_MS } from "../../../services/intelligence/research/policy";
import { bindGeminiClaim, bindGeminiFinding, geminiChunksToEnvelopeChunks, withLineage, type GroundingChunkLike, type GroundingSupportLike } from "../../../services/intelligence/research/spec/directLineage";


export const GEMINI_DIRECT_PROVIDER_ID = "gemini_direct";

/**
 * Research / Fact Mode reasoning budget (production rule, PR #448 §5): explicit LOWEST supported bounded thinking, never
 * dynamic/default. Exact Vertex acceptance on gemini-3.5-flash is verified by the configuration probe before any rerun:
 * `thinkingLevel` (MINIMAL preferred) or, if the level is rejected, a small explicit `thinkingBudget`. Env-overridable so
 * the verified value is a config flip. `includeThoughts` stays false.
 */
export function geminiResearchThinkingConfig(): ThinkingConfig {
  const budget = process.env.GEMINI_RESEARCH_THINKING_BUDGET;
  if (budget != null && budget !== "") return { thinkingBudget: Number(budget), includeThoughts: false };
  return { thinkingLevel: (process.env.GEMINI_RESEARCH_THINKING_LEVEL ?? "MINIMAL") as ThinkingConfig["thinkingLevel"], includeThoughts: false };
}
export type DirectContract = "v1" | "v2";

export interface GeminiDirectRaw { text: string; groundingChunks: GroundingChunkLike[]; groundingSupports: GroundingSupportLike[]; webSearchQueries: string[]; finishReason?: string; promptTokens?: number; candidateTokens?: number; thoughtTokens?: number }

export async function runGeminiDirectOnce(request: string, contract: DirectContract = "v2", abortSignal?: AbortSignal): Promise<GeminiDirectRaw> {
  const ai = genai();
  const response: any = await ai.models.generateContent({
    model: GEMINI.flash,
    contents: [{ role: "user", parts: [{ text: request }] }],
    config: { systemInstruction: `${compileSystemInstruction("gemini")} ${contract === "v2" ? DIRECT_V2_OUTPUT_RULE_HYBRID : DIRECT_OUTPUT_RULE_HYBRID}`, tools: [{ googleSearch: {} }], temperature: 1.0, maxOutputTokens: 32768, thinkingConfig: geminiResearchThinkingConfig(), ...(abortSignal ? { abortSignal } : {}) },
  });
  const cand = response.candidates?.[0];
  const gm = (cand?.groundingMetadata ?? {}) as any;
  const u = response.usageMetadata;
  return { text: response.text ?? "", groundingChunks: gm.groundingChunks ?? [], groundingSupports: gm.groundingSupports ?? [], webSearchQueries: gm.webSearchQueries ?? [], finishReason: cand?.finishReason ?? "unknown", promptTokens: u?.promptTokenCount, candidateTokens: u?.candidatesTokenCount, thoughtTokens: u?.thoughtsTokenCount };
}

export interface DirectCallOpts { envelopeId: string; queryName: string; sections: Section[]; retryMax: number; reserve: () => Promise<boolean>; call?: (request: string, abortSignal?: AbortSignal) => Promise<GeminiDirectRaw>; /** Client timeout per attempt (ms); default DEFAULT_GEMINI_CALL_TIMEOUT_MS. */ timeoutMs?: number; sleep?: (ms: number) => Promise<void>; /** direct-evidence contract; v2 (item-centric) is the production-intended one. */ contract?: DirectContract; /** required for v2 parsing (items are per query). */ query?: QueryDef }

export interface DirectCallResult {
  envelope: SearchEnvelope;            // native sources as chunks (Gemini: prose segments attributed to them)
  parsed: ParsedDirect | null;         // v1 claims with lineage bound
  parsedV2: ParsedDirectV2 | null;     // v2 findings with lineage bound
  prose: string;
  markerFound: boolean;
  attempts: number; refused: boolean; completed: boolean;
  nativeSources: number;
  searchQueries: number;
}

export class DirectCallTimeoutError extends Error {
  constructor(ms: number) { super(`provider call timed out after ${ms} ms`); this.name = "DirectCallTimeoutError"; }
}

/** One attempt, bounded client-side: the request is aborted (client-only; the provider may still bill it) and the attempt rejects. */
async function callWithTimeout(call: (request: string, abortSignal?: AbortSignal) => Promise<GeminiDirectRaw>, request: string, timeoutMs: number): Promise<GeminiDirectRaw> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new DirectCallTimeoutError(timeoutMs)); }, timeoutMs); });
  try { return await Promise.race([call(request, ac.signal), timeout]); }
  finally { clearTimeout(timer); }
}

export async function geminiDirect(request: string, opts: DirectCallOpts): Promise<DirectCallResult> {
  const contract: DirectContract = opts.contract ?? "v2";
  if (contract === "v2" && !opts.query) throw new Error("geminiDirect: contract v2 needs opts.query");
  const call = opts.call ?? ((r: string, signal?: AbortSignal) => runGeminiDirectOnce(r, contract, signal));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GEMINI_CALL_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchedAt = new Date().toISOString();
  const t0 = Date.now();
  const errors: SearchEnvelope["errors"] = [];
  const totals = { promptTokens: 0, completionTokens: 0, thoughtTokens: 0, searchQueries: 0, incomplete: false };
  let last: GeminiDirectRaw = { text: "", groundingChunks: [], groundingSupports: [], webSearchQueries: [] };
  let parsed: ParsedDirect | null = null; let parsedV2: ParsedDirectV2 | null = null; let prose = ""; let markerFound = false;
  let attempts = 0, refused = false;
  const maxAttempts = 1 + Math.max(0, opts.retryMax);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!(await opts.reserve())) { refused = true; errors.push({ step: `attempt-${attempt}`, message: "LLM budget reservation refused — no call made", class: "budget" }); break; }
    attempts++;
    const nonce = attempt > 1 ? ` [retry-${attempt}-ts:${Date.now()}]` : "";
    try {
      const r = await callWithTimeout(call, request + nonce, timeoutMs);
      last = r;
      totals.promptTokens += r.promptTokens ?? 0; totals.completionTokens += r.candidateTokens ?? 0; totals.thoughtTokens += r.thoughtTokens ?? 0; totals.searchQueries += r.webSearchQueries?.length ?? 0;
      if (r.promptTokens == null && r.candidateTokens == null) totals.incomplete = true;
      const split = splitHybrid(r.text);
      prose = split.prose; markerFound = split.markerFound;
      const p1 = contract === "v1" ? parseDirectEvidence(split.jsonText, opts.sections) : null;
      const p2 = contract === "v2" ? parseDirectEvidenceV2(split.jsonText, opts.query!, opts.sections) : null;
      const parseError = p1?.parseError ?? p2?.parseError ?? null;
      if (!r.text.trim()) { errors.push({ step: `attempt-${attempt}`, message: `empty answer (${r.finishReason ?? "unknown"})`, class: "empty" }); }
      else if (!split.markerFound) { errors.push({ step: `attempt-${attempt}`, message: "hybrid marker missing — no grounded prose part to bind to", class: "empty" }); parsed = p1; parsedV2 = p2; }
      else if (parseError) { errors.push({ step: `attempt-${attempt}`, message: `JSON did not parse: ${parseError}`, class: "empty" }); parsed = p1; parsedV2 = p2; }
      else { parsed = p1; parsedV2 = p2; break; }
    } catch (e: any) {
      totals.incomplete = true;
      errors.push({ step: `attempt-${attempt}`, message: String(e?.message ?? e).slice(0, 300), class: e instanceof DirectCallTimeoutError ? "timeout" : "transient" });
    }
    if (attempt < maxAttempts) await sleep(Math.pow(2, attempt - 1) * 1000 + Math.random() * 500);
  }
  const completed = ((contract === "v1" && !!parsed && !parsed.parseError) || (contract === "v2" && !!parsedV2 && !parsedV2.parseError)) && markerFound;
  const chunks = geminiChunksToEnvelopeChunks(last.groundingChunks, last.groundingSupports, prose, opts.envelopeId);
  if (parsed) parsed = { ...parsed, claims: parsed.claims.map((c) => withLineage(c, bindGeminiClaim(c.sources[0]?.quote ?? "", prose, last.groundingSupports, last.groundingChunks, opts.envelopeId))) };
  if (parsedV2) parsedV2 = { ...parsedV2, items: Object.fromEntries(Object.entries(parsedV2.items).map(([id, it]) => [id, it ? { ...it, findings: it.findings.map((f) => ({ ...f, lineage: bindGeminiFinding({ quote: f.sources[0]?.quote, statement: f.statement }, prose, last.groundingSupports, last.groundingChunks, opts.envelopeId) })) } : it])) };
  const envelope: SearchEnvelope = {
    id: opts.envelopeId, provider: GEMINI_DIRECT_PROVIDER_ID, model: GEMINI.flash, queryName: opts.queryName, query: request, fetchedAt,
    answerText: prose, chunks,
    supports: last.groundingSupports.map((s, j) => ({ id: `${opts.envelopeId}:s${j}`, chunkIds: (s.groundingChunkIndices ?? []).filter((n) => n >= 0 && n < chunks.length).map((n) => `${opts.envelopeId}:c${n}`), text: s.segment?.text ?? "", start: s.segment?.startIndex, end: s.segment?.endIndex, confidence: s.confidenceScores?.[0] })),
    raw: { text: last.text, groundingChunks: last.groundingChunks, groundingSupports: last.groundingSupports, webSearchQueries: last.webSearchQueries, finishReason: last.finishReason ?? null },
    request: { path: "generateContent", params: { model: GEMINI.flash, tools: "googleSearch", mode: "direct_hybrid", contract, thinking: geminiResearchThinkingConfig(), queryName: opts.queryName } },
    usage: { promptTokens: attempts ? totals.promptTokens : undefined, completionTokens: attempts ? totals.completionTokens + totals.thoughtTokens : undefined, calls: attempts, searchQueries: totals.searchQueries, latencyMs: Date.now() - t0, ...(totals.incomplete ? { usageIncomplete: true } : {}) },
    errors: completed ? [] : errors,
  };
  return { envelope, parsed, parsedV2, prose, markerFound, attempts, refused, completed, nativeSources: last.groundingChunks.length, searchQueries: last.webSearchQueries.length };
}
