/**
 * research/spec/directLineage.ts — deterministic provider-native lineage for direct-evidence claims (13 Sep 2026;
 * quote/statement precedence + normalization tightening added 13 Sep 2026, slice E).
 *
 * Levels (evidence about provenance, never a provider score):
 *   native_supported — the provider's native metadata binds the claim to a retrieved source deterministically
 *                      (Gemini: the finding's quote or statement occurs exactly once in the factual prose, and
 *                      that character range is contained in a grounding support's index range, which points to
 *                      grounding chunks);
 *   native_retrieved — the claim's source URL is confirmed in the provider's native retrieved-source list, but native
 *                      metadata cannot bind that source to the individual claim (OpenAI web_search_call.action.sources);
 *   asserted_only    — the model supplied a URL that cannot be confirmed in native retrieved-source metadata, or a
 *                      Gemini quote/statement that cannot be bound to a supported span by any of the four methods;
 *   unsupported      — no usable source lineage.
 * No fuzzy, semantic or LLM matching. For Gemini, binding tries four methods in order, stopping at the first that
 * binds (`BindingMethod`): (1) exact quote, (2) exact statement, (3) conservatively normalized exact quote,
 * (4) conservatively normalized exact statement. A needle must occur EXACTLY ONCE in the prose at that level — a
 * second occurrence means that level does not bind (ambiguous), never "first occurrence wins" — and the located
 * span must be contained in a provider-native grounding support (the API's own index ranges absorb punctuation
 * differences between support text and quote; a 1-char end tolerance is kept). Conservative normalization is ONLY
 * Unicode NFKC, whitespace collapsed to single spaces (trimmed), terminal punctuation stripped, and lower-casing —
 * never fuzzy or semantic. There is no response-level inheritance: a claim binds on its own evidence or it doesn't.
 * For OpenAI: exact URL, then conservative deterministic normalization. The bound chunk's metadata is the
 * authoritative source record; a model-written redirect URI is not. Pure.
 */

import type { Chunk } from "../providers";
import type { DirectClaim, DirectClaimLineage, ProvenanceLevel } from "./directEvidenceV1";

/** Which of the four deterministic methods bound a Gemini finding (`"none"` when nothing bound). */
export type BindingMethod = "quote_exact" | "statement_exact" | "quote_normalized_exact" | "statement_normalized_exact" | "none";

// ── Gemini: quote/statement → prose → support index range → chunks ──
export interface GroundingSupportLike { segment?: { startIndex?: number; endIndex?: number; text?: string }; groundingChunkIndices?: number[]; confidenceScores?: number[] }
export interface GroundingChunkLike { web?: { uri?: string; title?: string; domain?: string } }

/** Gemini index ranges are byte offsets into the UTF-8 text on some surfaces and character offsets on others; both are computed and either containment counts. */
function byteOffset(text: string, charIndex: number): number { return Buffer.byteLength(text.slice(0, charIndex), "utf8"); }

/** Count of EXACT (case-sensitive, unnormalized) non-overlapping occurrences of `needle` in `hay`. */
function countExact(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0, pos = 0;
  for (;;) { const i = hay.indexOf(needle, pos); if (i < 0) break; count++; pos = i + needle.length; }
  return count;
}

/** A trailing run of these characters is stripped by conservative normalization. */
const TERMINAL_PUNCT = new Set([".", ",", ";", ":", "!", "?", "\"", "'", "”", "’", ")", "]"]);

/**
 * Conservative normalization: Unicode NFKC + lower-case per code point, whitespace runs collapsed to a single
 * space (leading/trailing trimmed), then a trailing run of terminal punctuation stripped. Never fuzzy or semantic.
 * Returns, for every character kept in the normalized string, the original text's [start, end) character offsets
 * it came from, so a match located in normalized coordinates can be translated back to original-prose coordinates
 * (the grounding supports' indices are in original coordinates).
 */
function conservativeNormalizeWithMap(s: string): { norm: string; starts: number[]; ends: number[] } {
  // Step 1: per-code-point NFKC + lower-case (tracks each produced char's original [start, end)).
  const chars: string[] = []; const starts: number[] = []; const ends: number[] = [];
  let i = 0;
  for (const ch of s) {
    const start = i; i += ch.length; const end = i;
    for (const tc of ch.normalize("NFKC").toLowerCase()) { chars.push(tc); starts.push(start); ends.push(end); }
  }
  // Step 2: collapse whitespace runs to a single space; trim both ends.
  const cChars: string[] = []; const cStarts: number[] = []; const cEnds: number[] = [];
  let pendingWs: { start: number; end: number } | null = null;
  for (let k = 0; k < chars.length; k++) {
    if (/\s/.test(chars[k])) { pendingWs = pendingWs ? { start: pendingWs.start, end: ends[k] } : { start: starts[k], end: ends[k] }; continue; }
    if (pendingWs) { if (cChars.length) { cChars.push(" "); cStarts.push(pendingWs.start); cEnds.push(pendingWs.end); } pendingWs = null; }
    cChars.push(chars[k]); cStarts.push(starts[k]); cEnds.push(ends[k]);
  }
  // Step 3: strip a trailing run of terminal punctuation.
  while (cChars.length && TERMINAL_PUNCT.has(cChars[cChars.length - 1])) { cChars.pop(); cStarts.pop(); cEnds.pop(); }
  return { norm: cChars.join(""), starts: cStarts, ends: cEnds };
}

/** The same normalization, text only (no positional map) — for normalizing a needle (quote/statement). */
function conservativeNormalize(s: string): string { return conservativeNormalizeWithMap(s).norm; }

type Located = { start: number; end: number };
/** Locate `needle` in `hay`: `null` when absent, `"ambiguous"` when it occurs more than once, else its span. */
function locateUnique(hay: string, needle: string): Located | "ambiguous" | null {
  if (!needle) return null;
  const count = countExact(hay, needle);
  if (count === 0) return null;
  if (count > 1) return "ambiguous";
  const start = hay.indexOf(needle);
  return { start, end: start + needle.length };
}

type CoverageResult = { idx: number[] } | { idx: null; reason: "no_support_covers" | "no_chunk_named" };
/** Grounding chunk indices whose support covers the original-prose char range [cStart, cEnd). */
function coveringChunkIndices(cStart: number, cEnd: number, prose: string, supports: GroundingSupportLike[], chunks: GroundingChunkLike[]): CoverageResult {
  const bStart = byteOffset(prose, cStart), bEnd = byteOffset(prose, cEnd);
  const covering = supports.filter((s) => {
    const a = s.segment?.startIndex ?? -1, b = s.segment?.endIndex ?? -1;
    if (a < 0 || b < 0) return false;
    // containment with a 1-char tolerance at the end: the API's segment text may omit the closing punctuation the needle keeps
    return (a <= cStart && b >= cEnd - 1) || (a <= bStart && b >= bEnd - 1);
  });
  if (!covering.length) return { idx: null, reason: "no_support_covers" };
  const idx = [...new Set(covering.flatMap((s) => s.groundingChunkIndices ?? []))].filter((i) => i >= 0 && i < chunks.length);
  return idx.length ? { idx } : { idx: null, reason: "no_chunk_named" };
}

function boundLineage(idx: number[], chunkIdPrefix: string, chunks: GroundingChunkLike[], bindingMethod: BindingMethod, detail: string | null): DirectClaimLineage {
  return {
    level: "native_supported", match: "index_support", bindingMethod,
    boundChunkIds: idx.map((i) => `${chunkIdPrefix}:c${i}`),
    boundSources: idx.map((i) => ({ url: chunks[i].web?.uri ?? "", domain: chunks[i].web?.domain ?? null, title: chunks[i].web?.title ?? null })),
    detail,
  };
}

/**
 * Deterministic lineage binder for a Gemini direct-evidence finding: binds `input.quote` or `input.statement` to a
 * grounding-supported span in the factual prose. Precedence, stopping at the first that binds:
 *   1. exact quote → supported span                              (bindingMethod "quote_exact")
 *   2. exact statement → supported span                          (bindingMethod "statement_exact")
 *   3. conservatively normalized exact quote → supported span    (bindingMethod "quote_normalized_exact")
 *   4. conservatively normalized exact statement → supported span (bindingMethod "statement_normalized_exact")
 * Otherwise `asserted_only` with `bindingMethod: "none"` (or `unsupported` when both quote and statement are
 * empty). A needle occurring more than once in the prose does not bind at that level — no "first occurrence wins",
 * no fuzzy/semantic matching, no response-level inheritance.
 */
export function bindGeminiFinding(input: { quote: string | null | undefined; statement: string | null | undefined }, prose: string, supports: GroundingSupportLike[], chunks: GroundingChunkLike[], chunkIdPrefix: string): DirectClaimLineage {
  const quote = (input.quote ?? "").trim();
  const statement = (input.statement ?? "").trim();
  if (!quote && !statement) return { level: "unsupported", match: "none", boundChunkIds: [], boundSources: [], detail: "no quote", bindingMethod: "none" };

  const normProse = conservativeNormalizeWithMap(prose);
  const attempts: Array<{ method: BindingMethod; needle: string; label: string; exact: boolean }> = [
    { method: "quote_exact", needle: quote, label: "quote (exact)", exact: true },
    { method: "statement_exact", needle: statement, label: "statement (exact)", exact: true },
    { method: "quote_normalized_exact", needle: conservativeNormalize(quote), label: "quote (normalized)", exact: false },
    { method: "statement_normalized_exact", needle: conservativeNormalize(statement), label: "statement (normalized)", exact: false },
  ];

  // Track the most informative failure reason across attempted levels, for the eventual asserted_only detail.
  let fallbackDetail: string | null = null; let fallbackPriority = -1;
  const note = (detail: string, priority: number) => { if (priority > fallbackPriority) { fallbackDetail = detail; fallbackPriority = priority; } };
  const isQuoteMethod = (m: BindingMethod) => m === "quote_exact" || m === "quote_normalized_exact";

  for (const a of attempts) {
    if (!a.needle) continue;
    if (a.exact) {
      const loc = locateUnique(prose, a.needle);
      if (loc === null) { note(`${isQuoteMethod(a.method) ? "quote" : "statement"} not found verbatim in the factual prose`, 1); continue; }
      if (loc === "ambiguous") { note(`ambiguous: occurs ${countExact(prose, a.needle)} times`, 3); continue; }
      const cov = coveringChunkIndices(loc.start, loc.end, prose, supports, chunks);
      if (!cov.idx) { note(cov.reason === "no_chunk_named" ? "covering support names no grounding chunk" : "found in prose but no grounding support covers its index range", 2); continue; }
      // quote_exact was already the (undecorated) default before this precedence chain existed — keep detail null there.
      return boundLineage(cov.idx, chunkIdPrefix, chunks, a.method, a.method === "quote_exact" ? null : `bound by ${a.label}`);
    } else {
      const loc = locateUnique(normProse.norm, a.needle);
      if (loc === null) { note(`normalized ${isQuoteMethod(a.method) ? "quote" : "statement"} not found in the normalized prose`, 1); continue; }
      if (loc === "ambiguous") { note(`ambiguous: occurs ${countExact(normProse.norm, a.needle)} times (normalized)`, 3); continue; }
      const origStart = normProse.starts[loc.start], origEnd = normProse.ends[loc.end - 1];
      const cov = coveringChunkIndices(origStart, origEnd, prose, supports, chunks);
      if (!cov.idx) { note(cov.reason === "no_chunk_named" ? "covering support names no grounding chunk" : "found in normalized prose but no grounding support covers its original index range", 2); continue; }
      return boundLineage(cov.idx, chunkIdPrefix, chunks, a.method, `bound by ${a.label}`);
    }
  }
  return { level: "asserted_only", match: "none", boundChunkIds: [], boundSources: [], bindingMethod: "none", detail: fallbackDetail ?? "no binding method matched" };
}

/** Backward-compatible thin wrapper: quote-only binding (the v1 path, and any caller with no statement text). */
export function bindGeminiClaim(quote: string, prose: string, supports: GroundingSupportLike[], chunks: GroundingChunkLike[], chunkIdPrefix: string): DirectClaimLineage {
  return bindGeminiFinding({ quote, statement: null }, prose, supports, chunks, chunkIdPrefix);
}

// ── OpenAI: claim source URL → action.sources ──
/** Conservative deterministic URL normalization: scheme to https, drop www., drop hash, drop tracking params (utm_*, ref, src, fbclid, gclid), drop a trailing slash, lower-case host. Never touches the path otherwise. */
export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_.*|ref|src|fbclid|gclid|mc_cid|mc_eid)$/i.test(k)) x.searchParams.delete(k);
    const host = x.hostname.toLowerCase().replace(/^www\./, "");
    const path = x.pathname.replace(/\/+$/, "") || "";
    const qs = x.searchParams.toString();
    return `https://${host}${path}${qs ? `?${qs}` : ""}`;
  } catch { return u.trim().toLowerCase(); }
}

export interface RetrievedSourceLike { url: string; title?: string | null }

export function matchOpenAIClaim(sources: Array<{ url: string }>, retrieved: RetrievedSourceLike[], chunkIdPrefix: string): DirectClaimLineage {
  if (!sources.length) return { level: "unsupported", match: "none", boundChunkIds: [], boundSources: [], detail: "no source given", bindingMethod: "none" };
  const exact = new Map(retrieved.map((r, i) => [r.url, i]));
  const norm = new Map<string, number>(); for (const [i, r] of retrieved.entries()) if (!norm.has(normalizeUrl(r.url))) norm.set(normalizeUrl(r.url), i);
  const boundIdx: number[] = []; let match: DirectClaimLineage["match"] = "none";
  for (const s of sources) {
    const e = exact.get(s.url); if (e != null) { boundIdx.push(e); match = match === "none" ? "url_exact" : match; continue; }
    const n = norm.get(normalizeUrl(s.url)); if (n != null) { boundIdx.push(n); if (match === "none") match = "url_normalized"; }
  }
  const idx = [...new Set(boundIdx)];
  if (!idx.length) return { level: "asserted_only", match: "none", boundChunkIds: [], boundSources: [], detail: "no claim source URL matches a retrieved source (exact or normalized)", bindingMethod: "none" };
  return { level: "native_retrieved", match, boundChunkIds: idx.map((i) => `${chunkIdPrefix}:c${i}`), boundSources: idx.map((i) => ({ url: retrieved[i].url, domain: hostOf(retrieved[i].url), title: retrieved[i].title ?? null })), detail: null, bindingMethod: "none" };
}

export function hostOf(u: string): string | null { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } }

/** Apply a lineage result onto the claim: the citation's chunk ids become the bound chunks (empty when unbound). */
export function withLineage(claim: DirectClaim, lineage: DirectClaimLineage): DirectClaim {
  return { ...claim, lineage, citation: claim.citation ? { ...claim.citation, chunkIds: lineage.boundChunkIds } : (lineage.boundChunkIds.length ? { chunkIds: lineage.boundChunkIds, quote: "" } : null) };
}

/** Chunks for the SearchEnvelope of a direct arm: Gemini grounding chunks (text = the prose segments the supports attribute to them) or OpenAI retrieved sources (no text). */
export function geminiChunksToEnvelopeChunks(chunks: GroundingChunkLike[], supports: GroundingSupportLike[], prose: string, prefix: string): Chunk[] {
  const texts: string[] = chunks.map(() => "");
  for (const s of supports) {
    const t = s.segment?.text ?? (s.segment?.startIndex != null && s.segment?.endIndex != null ? prose.slice(s.segment.startIndex, s.segment.endIndex) : "");
    for (const i of s.groundingChunkIndices ?? []) if (i >= 0 && i < chunks.length && t) texts[i] = texts[i] ? (texts[i].includes(t) ? texts[i] : `${texts[i]}\n${t}`) : t;
  }
  return chunks.map((c, i) => ({ id: `${prefix}:c${i}`, url: c.web?.uri ?? null, domain: c.web?.domain ?? hostOf(c.web?.uri ?? ""), title: c.web?.title ?? null, text: texts[i], textKind: "provider_answer_segments" as const }));
}
export function openaiSourcesToEnvelopeChunks(sources: RetrievedSourceLike[], prefix: string): Chunk[] {
  return sources.map((s, i) => ({ id: `${prefix}:c${i}`, url: s.url, domain: hostOf(s.url), title: s.title ?? null, text: "", textKind: "source_excerpt" as const }));
}

export const levelAccepted = (level: ProvenanceLevel, accepted: readonly ProvenanceLevel[]) => accepted.includes(level);
