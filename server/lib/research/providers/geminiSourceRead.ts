/**
 * lib/research/providers/geminiSourceRead.ts — research v3's targeted source read (source-read/1): ONE Gemini call that reads ONE
 * public source directly, with the existing Vertex genai client and model (GEMINI.flash).
 *
 *   page     a web page (article, written interview, team/league feature, transcript page) through the URL-context tool:
 *            `tools: [{ urlContext: {} }]`, the URL in the request text. The read counts only when the response's
 *            urlContextMetadata reports URL_RETRIEVAL_STATUS_SUCCESS for a URL — no metadata or no success ⇒ not read.
 *   youtube  a public YouTube video through native video input: a `fileData` part whose fileUri is the watch URL
 *            (Vertex requires a MIME type; video/mp4 per the Vertex YouTube-URL examples). No download, no tools.
 *
 * Exactly one attempt per source (no retry: each read is a single, budgeted model call); the reservation is taken BEFORE the
 * call and a refusal means no call. Bounded by a client timeout. Never throws. No page fetch and no transcript is stored: the
 * stored payload is the model's extraction output.
 */

import { genai, GEMINI } from "../../models";
import type { SearchEnvelope } from "../../../services/intelligence/research/providers";
import { DEFAULT_GEMINI_CALL_TIMEOUT_MS } from "../../../services/intelligence/research/policy";
import { hostOf } from "../../../services/intelligence/research/spec/directLineage";
import { SOURCE_READ_SYSTEM_INSTRUCTION, SOURCE_READ_VERSION, type ReadMode } from "../../../services/intelligence/research/spec/sourceReadV1";
import { geminiResearchThinkingConfig, GEMINI_DIRECT_PROVIDER_ID } from "./geminiDirect";

/** The MIME type sent with a YouTube fileUri on Vertex. */
export const YOUTUBE_MIME_TYPE = "video/mp4";
export const URL_RETRIEVAL_SUCCESS = "URL_RETRIEVAL_STATUS_SUCCESS";

export interface SourceReadInput { url: string; mode: ReadMode; request: string; envelopeId: string }
export interface SourceReadRaw { text: string; urlMetadata: Array<{ retrievedUrl: string | null; status: string | null }>; finishReason?: string; promptTokens?: number; candidateTokens?: number; thoughtTokens?: number }
export interface SourceReadOpts { reserve: () => Promise<boolean>; timeoutMs?: number; call?: (input: SourceReadInput, abortSignal?: AbortSignal) => Promise<SourceReadRaw> }
export interface SourceReadResult { envelope: SearchEnvelope; text: string; attempts: number; refused: boolean; completed: boolean; error: string | null }

/** The generateContent parameters for one read (pure; tested for both request shapes). */
export function sourceReadParams(input: Pick<SourceReadInput, "url" | "mode" | "request">, abortSignal?: AbortSignal) {
  const base = { systemInstruction: SOURCE_READ_SYSTEM_INSTRUCTION, temperature: 0.2, maxOutputTokens: 16384, thinkingConfig: geminiResearchThinkingConfig(), ...(abortSignal ? { abortSignal } : {}) };
  if (input.mode === "youtube") {
    return { model: GEMINI.flash, contents: [{ role: "user", parts: [{ fileData: { fileUri: input.url, mimeType: YOUTUBE_MIME_TYPE } }, { text: input.request }] }], config: base };
  }
  return { model: GEMINI.flash, contents: [{ role: "user", parts: [{ text: input.request }] }], config: { ...base, tools: [{ urlContext: {} }] } };
}

export async function runGeminiSourceReadOnce(input: SourceReadInput, abortSignal?: AbortSignal): Promise<SourceReadRaw> {
  const response: any = await genai().models.generateContent(sourceReadParams(input, abortSignal) as any);
  const cand = response.candidates?.[0];
  const meta = (cand?.urlContextMetadata?.urlMetadata ?? []) as Array<{ retrievedUrl?: string; urlRetrievalStatus?: string }>;
  const u = response.usageMetadata;
  return { text: response.text ?? "", urlMetadata: meta.map((m) => ({ retrievedUrl: m.retrievedUrl ?? null, status: m.urlRetrievalStatus ?? null })), finishReason: cand?.finishReason ?? "unknown", promptTokens: u?.promptTokenCount, candidateTokens: u?.candidatesTokenCount, thoughtTokens: u?.thoughtsTokenCount };
}

class ReadTimeout extends Error { constructor(ms: number) { super(`source read timed out after ${ms} ms`); } }

/** One budgeted read. completed = the model answered AND (video, or the URL-context tool reported a successful retrieval). */
export async function geminiSourceRead(input: SourceReadInput, opts: SourceReadOpts): Promise<SourceReadResult> {
  const call = opts.call ?? runGeminiSourceReadOnce;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GEMINI_CALL_TIMEOUT_MS;
  const fetchedAt = new Date().toISOString();
  const t0 = Date.now();
  let raw: SourceReadRaw | null = null; let error: string | null = null; let errorClass = "empty"; let attempts = 0; let refused = false;
  if (!(await opts.reserve())) { refused = true; error = "LLM budget reservation refused — no call made"; errorClass = "budget"; }
  else {
    attempts = 1;
    const ac = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      raw = await Promise.race([call(input, ac.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new ReadTimeout(timeoutMs)); }, timeoutMs); })]);
    } catch (e: any) { error = String(e?.message ?? e).slice(0, 300); errorClass = e instanceof ReadTimeout ? "timeout" : "transient"; }
    finally { clearTimeout(timer); }
  }
  const text = raw?.text ?? "";
  const retrieved = input.mode === "youtube" || (raw?.urlMetadata ?? []).some((m) => m.status === URL_RETRIEVAL_SUCCESS);
  if (raw && !text.trim()) error = `empty answer (${raw.finishReason ?? "unknown"})`;
  else if (raw && !retrieved) { error = (raw.urlMetadata.length ? `URL context did not retrieve the page (${raw.urlMetadata.map((m) => m.status).join(", ")})` : "no URL-context retrieval metadata: the page was not read"); errorClass = "not_read"; }
  const completed = !!raw && !!text.trim() && retrieved;
  const envelope: SearchEnvelope = {
    id: input.envelopeId, provider: GEMINI_DIRECT_PROVIDER_ID, model: GEMINI.flash, queryName: "source_read", query: input.request, fetchedAt,
    answerText: "", chunks: [{ id: `${input.envelopeId}:c0`, url: input.url, domain: hostOf(input.url), title: null, text: "", textKind: "provider_answer_segments" }], supports: [],
    raw: { text, urlMetadata: raw?.urlMetadata ?? [], finishReason: raw?.finishReason ?? null },
    request: { path: "source-read", params: { model: GEMINI.flash, mode: input.mode, tools: input.mode === "page" ? "urlContext" : "fileData:youtube", readSpec: SOURCE_READ_VERSION, url: input.url, thinking: geminiResearchThinkingConfig() } },
    usage: { promptTokens: raw?.promptTokens, completionTokens: raw ? (raw.candidateTokens ?? 0) + (raw.thoughtTokens ?? 0) : undefined, calls: attempts, latencyMs: Date.now() - t0, ...(attempts && raw?.promptTokens == null ? { usageIncomplete: true } : {}) },
    errors: completed ? [] : [{ step: "read", message: error ?? "not completed", class: errorClass }],
  };
  return { envelope, text, attempts, refused, completed, error: completed ? null : error };
}
