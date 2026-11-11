/**
 * research/providers.ts — the provider-independent contracts of the research substrate.
 *
 * Adapters (server/lib/research/providers/*) produce these envelopes from Gemini, Kimi, Trends
 * and GDELT today and from any later provider. The service receives envelopes by value; it
 * never imports an adapter (the intelligence boundary test). Provider choice never reaches a
 * schema: evidence rows carry provider/model names as provenance strings only.
 */

import type { EvidenceKind } from "./registries";

/** What a chunk's `text` actually is. Gemini grounding never returns page text: its chunks carry only the
 *  provider's own answer segments attributed to that source. A provider that fetches pages returns excerpts. */
export type ChunkTextKind = "provider_answer_segments" | "source_excerpt";

/** A citable unit of a provider response. For Gemini grounding: one groundingChunk (its own url/title) whose text is
 *  the PROVIDER's answer segments the groundingSupports attribute to it — not an excerpt of the source page. */
export interface Chunk {
  id: string;            // `${envelopeId}:c${index}` — stable within the stored payload
  url: string | null;
  domain: string | null;
  title: string | null;
  /** Text attributable to this chunk. Its nature is `textKind`; never treat provider answer text as a page quotation. */
  text: string;
  textKind: ChunkTextKind;
}

/** The provider's own mapping from a span of its answer to the chunks that support it. */
export interface Support {
  id: string;            // `${envelopeId}:s${index}`
  chunkIds: string[];
  text: string;
  start?: number;
  end?: number;
  confidence?: number;
}

/** Token counts are SUMMED across every attempt of a retried call (each attempt is billed). `usageIncomplete` is true when
 *  at least one attempt produced no usage record (a thrown transport error), so the sums are a lower bound. */
export interface Usage { promptTokens?: number; completionTokens?: number; cachedTokens?: number; calls?: number; latencyMs?: number; estimatedCostUsd?: number; usageIncomplete?: boolean; /** grounding search queries summed over every attempt (gemini_direct; billed per query) */ searchQueries?: number }

export interface SearchEnvelope {
  id: string;
  provider: string;       // e.g. gemini_grounded
  model?: string;
  queryName: string;
  query: string;
  fetchedAt: string;
  answerText: string;
  chunks: Chunk[];
  supports: Support[];
  /** The provider's raw response and the request record (allow-listed), sanitized before storage. */
  raw: unknown;
  request: Record<string, unknown>;
  usage?: Usage;
  errors: Array<{ step: string; message: string; class?: string }>;
}

export interface ClaimCitation {
  chunkIds: string[];
  supportIds?: string[];
  /** ≤ 300 chars of the text the claim relied on; must occur in the cited chunks' text. For Gemini grounding that
   *  text is the provider's answer attributed to the source, and it is stored as such (quoteKind), never as a page excerpt. */
  quote: string;
}
/** What a stored quote is: provider answer text attributed to a source, a real source-page excerpt, or a provider API record (signals). */
export type QuoteKind = "provider_answer" | "source_excerpt" | "provider_record";

export interface ExtractedClaim {
  kind: EvidenceKind;
  /** Kind-specific claim; for fact-bearing kinds it carries `factKey` + `value` in the Fact Registry shape. */
  claim: Record<string, unknown>;
  citation: ClaimCitation | null;
  confidence?: number;
  publishedAt?: string | null;
}

export interface ExtractedInference { key: "story_arc" | "sentiment" | string; value: unknown; citation?: ClaimCitation | null }

export interface ExtractionEnvelope {
  id: string;
  provider: string;       // e.g. kimi_extract
  model?: string;
  schemaVersion: string;  // extraction schema version (cited-claims schema)
  fetchedAt: string;
  claims: ExtractedClaim[];
  inferences: ExtractedInference[];
  /** Step 2b: the extractor's explicit per-domain outcome for the domains it was ASKED about. Absent = no assertion (never `none_found`). */
  domainOutcomes?: Record<string, { status: "found" | "none_found"; reviewedChunkIds: string[] }>;
  raw: unknown;
  request: Record<string, unknown>;
  usage?: Usage;
  errors: Array<{ step: string; message: string; class?: string }>;
  parseError?: string | null;
}

export interface SignalEnvelope {
  id: string;
  provider: "google_trends" | "gdelt" | string;
  fetchedAt: string;
  windowDays?: number;
  values: Record<string, number>;
  items?: Array<{ url?: string | null; title?: string | null; date?: string | null; domain?: string | null }>;
  raw: unknown;
  request: Record<string, unknown>;
}

/** What the service knows about the athlete before research; the ledger, never the projection. */
export interface IdentityHints {
  athleteId: string;
  fullName: string;
  aliases: string[];
  sport: string | null;
  currentAffiliation: string | null;
  hometown: string | null;
  knownHandles: Record<string, string>;
}

// ── provider interfaces (implemented under server/lib/research/providers; injected) ──
export interface DomainQueryPlan { domain: string; queries: Array<{ name: string; query: string }> }
export interface SearchProvider   { id: string; search(plan: DomainQueryPlan, hints: IdentityHints, opts: { maxCalls: number }): Promise<SearchEnvelope[]> }
export interface ExtractProvider  { id: string; extract(envelopes: SearchEnvelope[], hints: IdentityHints): Promise<ExtractionEnvelope> }
export interface SignalProvider   { id: string; fetch(hints: IdentityHints): Promise<SignalEnvelope> }
export interface ResearchProviders { search: SearchProvider[]; extract: ExtractProvider; signals: SignalProvider[] }
