/**
 * lib/research/providers/geminiGrounded.ts — Gemini grounded search → SearchEnvelope (Step 2a).
 *
 * A pure mapping over the response researchAthlete already receives (no second call). The
 * provider's own citation structure is preserved: every groundingChunk becomes a Chunk (its own
 * url/title) whose text is the union of the PROVIDER's answer segments the groundingSupports
 * attribute to it — Gemini grounding returns no page text, so `textKind` is
 * `provider_answer_segments` and nothing here is a source-page excerpt; every groundingSupport
 * becomes a Support. A claim can then cite chunk ids and be validated against exactly this
 * structure (design §3.2, review: grounding semantics).
 */

import { genai, GEMINI } from "../../models";
import type { Chunk, SearchEnvelope, Support } from "../../../services/intelligence/research/providers";

export interface GeminiGroundingRaw {
  text: string;
  groundingChunks: Array<{ uri: string; title: string; domain: string }>;
  groundingSupports?: Array<{ segment?: { startIndex?: number; endIndex?: number; text?: string }; groundingChunkIndices?: number[]; confidenceScores?: number[] }>;
  webSearchQueries?: string[];
  finishReason?: string;
  promptTokens?: number;
  candidateTokens?: number;
}

export const GEMINI_PROVIDER_ID = "gemini_grounded";

export function toSearchEnvelope(raw: GeminiGroundingRaw, opts: { envelopeId: string; queryName: string; query: string; model: string; fetchedAt: string; latencyMs?: number; errors?: SearchEnvelope["errors"] }): SearchEnvelope {
  const chunkText: string[] = raw.groundingChunks.map(() => "");
  const supports: Support[] = (raw.groundingSupports ?? []).map((s, j) => {
    const idxs = (s.groundingChunkIndices ?? []).filter((n) => Number.isInteger(n) && n >= 0 && n < raw.groundingChunks.length);
    const text = s.segment?.text ?? (s.segment?.startIndex != null && s.segment?.endIndex != null ? raw.text.slice(s.segment.startIndex, s.segment.endIndex) : "");
    for (const n of idxs) chunkText[n] = chunkText[n] ? `${chunkText[n]}\n${text}` : text;
    return { id: `${opts.envelopeId}:s${j}`, chunkIds: idxs.map((n) => `${opts.envelopeId}:c${n}`), text, start: s.segment?.startIndex, end: s.segment?.endIndex, confidence: s.confidenceScores?.[0] };
  });
  const chunks: Chunk[] = raw.groundingChunks.map((c, n) => ({ id: `${opts.envelopeId}:c${n}`, url: c.uri || null, domain: c.domain || safeHost(c.uri), title: c.title || null, text: chunkText[n], textKind: "provider_answer_segments" }));
  return {
    id: opts.envelopeId, provider: GEMINI_PROVIDER_ID, model: opts.model, queryName: opts.queryName, query: opts.query, fetchedAt: opts.fetchedAt,
    answerText: raw.text, chunks, supports,
    raw: { text: raw.text, groundingChunks: raw.groundingChunks, groundingSupports: raw.groundingSupports ?? [], webSearchQueries: raw.webSearchQueries ?? [], finishReason: raw.finishReason ?? null },
    request: { path: "generateContent", params: { model: opts.model, tools: "googleSearch", queryName: opts.queryName } },
    usage: { promptTokens: raw.promptTokens, completionTokens: raw.candidateTokens, calls: 1, latencyMs: opts.latencyMs },
    errors: opts.errors ?? [],
  };
}

function safeHost(uri: string): string | null { try { return new URL(uri).hostname; } catch { return null; } }


// ── Step 2b: the grounded CALL for planner refresh runs ─────────────────────────
// A COPY of researchAthlete.ts runGemini / runGeminiWithRetry (same client, model, system prompt,
// nonce and empty-result handling) with two differences the design requires (§4.4, §5.1): the retry
// cap comes from the policy, and an atomic LLM budget reservation is awaited BEFORE EVERY attempt —
// there is no code path to Gemini without a successful reservation. researchAthlete.ts is untouched
// (D4); this duplicate is removed in 2d when the legacy procedure retires.

export const GROUNDED_SYSTEM =
  "You are a sports research analyst compiling a verified athlete dossier. " +
  "Always use Google Search to find current, accurate information — do not answer from memory. " +
  "Search multiple distinct facets: profile and background, social media accounts, local and national press, " +
  "conference and league awards, statistics and records, brand partnerships, and media assets. " +
  "Attribute every fact to a specific source. If a fact cannot be found, say so explicitly. " +
  "Be thorough — a richer dossier is always better than a brief one.";

export interface GroundedSearchOpts {
  envelopeId: string;
  queryName: string;
  /** Extra attempts after the first (policy.planner.geminiRetryMax). */
  retryMax: number;
  /** Awaited before EVERY attempt, retries included. false ⇒ no call. */
  reserve: () => Promise<boolean>;
  /** Tests: the raw call. Defaults to the real Gemini grounded call. */
  call?: (query: string) => Promise<GeminiGroundingRaw>;
  sleep?: (ms: number) => Promise<void>;
  /** Step 4 benchmark: a system instruction other than GROUNDED_SYSTEM (research-spec/1 compiled for Gemini). Production callers never set it. */
  systemInstruction?: string;
}

export interface GroundedSearchResult { envelope: SearchEnvelope; attempts: number; refused: boolean; completed: boolean }

export async function runGeminiOnce(query: string, systemInstruction: string = GROUNDED_SYSTEM): Promise<GeminiGroundingRaw> {
  const ai = genai();
  const response: any = await ai.models.generateContent({
    model: GEMINI.flash,
    contents: [{ role: "user", parts: [{ text: query }] }],
    config: { systemInstruction, tools: [{ googleSearch: {} }], temperature: 1.0, maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 256 } as any },
  });
  const cand = response.candidates?.[0];
  const text = response.text ?? "";
  const gm = (cand?.groundingMetadata ?? {}) as any;
  const groundingChunks = (gm.groundingChunks ?? []).map((c: any) => ({ uri: c.web?.uri ?? "", title: c.web?.title ?? "", domain: c.web?.domain ?? (() => { try { return new URL(c.web?.uri ?? "http://x").hostname; } catch { return ""; } })() }));
  const groundingSupports = (gm.groundingSupports ?? []).map((sp: any) => ({ segment: { startIndex: sp.segment?.startIndex, endIndex: sp.segment?.endIndex, text: sp.segment?.text }, groundingChunkIndices: Array.isArray(sp.groundingChunkIndices) ? sp.groundingChunkIndices : [], confidenceScores: Array.isArray(sp.confidenceScores) ? sp.confidenceScores : [] }));
  const usage = response.usageMetadata;
  return { text, groundingChunks, groundingSupports, webSearchQueries: gm.webSearchQueries ?? [], finishReason: cand?.finishReason ?? "unknown", promptTokens: usage?.promptTokenCount, candidateTokens: usage?.candidatesTokenCount };
}

export async function groundedSearch(query: string, opts: GroundedSearchOpts): Promise<GroundedSearchResult> {
  const call = opts.call ?? ((q: string) => runGeminiOnce(q, opts.systemInstruction ?? GROUNDED_SYSTEM));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchedAt = new Date().toISOString();
  const t0 = Date.now();
  const errors: SearchEnvelope["errors"] = [];
  let last: GeminiGroundingRaw = { text: "", groundingChunks: [], groundingSupports: [], webSearchQueries: [], finishReason: "unknown" };
  let attempts = 0;
  let refused = false;
  // Every attempt is billed: token usage is SUMMED across attempts; an attempt that threw has no usage record → usageIncomplete.
  const totals = { promptTokens: 0, completionTokens: 0, incomplete: false };
  const maxAttempts = 1 + Math.max(0, opts.retryMax);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!(await opts.reserve())) { refused = true; errors.push({ step: `attempt-${attempt}`, message: "LLM budget reservation refused — no call made", class: "budget" }); break; }
    attempts++;
    const nonce = attempt > 1 ? ` [retry-${attempt}-ts:${Date.now()}]` : "";
    try {
      const result = await call(query + nonce);
      last = result;
      totals.promptTokens += result.promptTokens ?? 0; totals.completionTokens += result.candidateTokens ?? 0;
      if (result.promptTokens == null && result.candidateTokens == null) totals.incomplete = true;
      const empty = result.text.trim().length === 0 || result.groundingChunks.length === 0;
      if (!empty) break;
      errors.push({ step: `attempt-${attempt}`, message: `empty grounded answer (${result.finishReason ?? "unknown"})`, class: "empty" });
    } catch (e: any) {
      totals.incomplete = true;
      errors.push({ step: `attempt-${attempt}`, message: String(e?.message ?? e).slice(0, 300), class: "transient" });
    }
    if (attempt < maxAttempts) await sleep(Math.pow(2, attempt - 1) * 1000 + Math.random() * 500);
  }
  const completed = last.groundingChunks.length > 0 && last.text.trim().length > 0;
  const envelope = toSearchEnvelope(last, { envelopeId: opts.envelopeId, queryName: opts.queryName, query, model: GEMINI.flash, fetchedAt, latencyMs: Date.now() - t0, errors: completed ? [] : errors });
  envelope.usage = { ...(envelope.usage ?? {}), promptTokens: attempts ? totals.promptTokens : undefined, completionTokens: attempts ? totals.completionTokens : undefined, calls: attempts, ...(totals.incomplete ? { usageIncomplete: true } : {}) };
  return { envelope, attempts, refused, completed };
}
