/**
 * research/lineage.ts — claim-to-source citation validation (design §3.2, R5).
 *
 * A claim is `cited` only when the chunks it names exist in a stored search envelope AND the
 * quoted span occurs in the text attributed to those chunks. For Gemini grounding that text is
 * the PROVIDER's answer segments (quoteKind `provider_answer`), never a page excerpt: the
 * stored support says so, and no source quotation is ever reconstructed. A quote that occurs in the answer but is
 * supported by OTHER chunks is `conflicting`. Anything else is `uncited`: source_url stays
 * NULL, confidence is capped, and the claim cannot establish a current fact on its own. No URL
 * is ever attached from anywhere but the cited chunk.
 */

import type { Chunk, ClaimCitation, QuoteKind, SearchEnvelope, Support } from "./providers";
import type { LineageStatus } from "./registries";

export const MAX_QUOTE_CHARS = 300;

export interface CitationCheck {
  status: LineageStatus;
  /** The primary cited chunk (first valid id) — the ONLY source of url/domain/title for the evidence row. */
  chunk: Chunk | null;
  chunks: Chunk[];
  supports: Support[];
  /** What the validated quote is: `provider_answer` for grounding-style chunks, `source_excerpt` only when the chunk holds page text. Null when uncited/conflicting. */
  quoteKind: QuoteKind | null;
  reason: string | null;
}
const kindOf = (c: Chunk): QuoteKind => (c.textKind === "source_excerpt" ? "source_excerpt" : "provider_answer");

export const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function findChunk(id: string, envelopes: SearchEnvelope[]): { chunk: Chunk; envelope: SearchEnvelope } | null {
  for (const e of envelopes) { const c = e.chunks.find((x) => x.id === id); if (c) return { chunk: c, envelope: e }; }
  return null;
}

export function validateCitation(citation: ClaimCitation | null | undefined, envelopes: SearchEnvelope[]): CitationCheck {
  const uncited = (reason: string): CitationCheck => ({ status: "uncited", chunk: null, chunks: [], supports: [], quoteKind: null, reason });
  if (!citation || !Array.isArray(citation.chunkIds) || citation.chunkIds.length === 0) return uncited("no citation");
  const quote = typeof citation.quote === "string" ? citation.quote.trim() : "";
  if (!quote) return uncited("no quote");
  if (quote.length > MAX_QUOTE_CHARS) return uncited(`quote longer than ${MAX_QUOTE_CHARS} chars`);

  const found = citation.chunkIds.map((id) => findChunk(id, envelopes)).filter((x): x is { chunk: Chunk; envelope: SearchEnvelope } => !!x);
  if (!found.length) return uncited("unknown chunk id");
  const q = norm(quote);

  // 1. The quote occurs in a cited chunk's own text → cited.
  const inCited = found.filter((f) => norm(f.chunk.text).includes(q));
  if (inCited.length) {
    const supports = inCited[0].envelope.supports.filter((s) => s.chunkIds.includes(inCited[0].chunk.id) && norm(s.text).includes(q));
    return { status: "cited", chunk: inCited[0].chunk, chunks: inCited.map((f) => f.chunk), supports, quoteKind: kindOf(inCited[0].chunk), reason: found.length > inCited.length ? "some cited chunks do not contain the quote" : null };
  }

  // 2. The quote occurs in the answer but its supports point elsewhere → conflicting; nowhere → uncited.
  for (const f of found) {
    const answer = norm(f.envelope.answerText);
    if (!answer.includes(q)) continue;
    const covering = f.envelope.supports.filter((s) => norm(s.text).includes(q) || q.includes(norm(s.text)));
    if (!covering.length) return uncited("quote is in the answer but no provider support covers it");
    const citedIds = new Set(citation.chunkIds);
    const agree = covering.some((s) => s.chunkIds.some((id) => citedIds.has(id)));
    if (agree) {
      const chunk = f.chunk;
      return { status: "cited", chunk, chunks: found.map((x) => x.chunk), supports: covering.filter((s) => s.chunkIds.includes(chunk.id)), quoteKind: kindOf(chunk), reason: null };
    }
    return { status: "conflicting", chunk: null, chunks: found.map((x) => x.chunk), supports: covering, quoteKind: null, reason: `quote is supported by chunks ${covering.flatMap((s) => s.chunkIds).join(",")}, not by the cited ${citation.chunkIds.join(",")}` };
  }
  return uncited("quote not found in the cited chunks or their answer");
}
