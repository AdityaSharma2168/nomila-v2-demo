/**
 * lib/research/providers/kimiExtractV3.ts — cited-claims/3 extraction for the research provider benchmark.
 *
 * Same model, client and JSON mode as kimiExtract.ts (the production cited-claims/2 adapter, untouched);
 * the prompt, parser, degenerate check and partition merge come from the pure spec module. Identical in
 * both benchmark arms. Never throws.
 *
 * Since 13 Sep 2026 the extraction is PARTITIONED (`extractPartitionedV3`): one Kimi call per ResearchSpec
 * query over that query's envelopes and sections, each under the same 300 s limit, merged deterministically.
 * `extractWithCitationsV3` (one call over everything) is kept for tests and for the record of how the first
 * attempts were made.
 */

import { kimiInstant } from "../../kimi";
import { KIMI } from "../../models";
import type { ExtractionEnvelope, IdentityHints, SearchEnvelope } from "../../../services/intelligence/research/providers";
import { armDegenerate, buildCitedExtractionPromptV3, CITED_EXTRACTION_SYSTEM_V3, degenerateReason, EXTRACTION_V3_REQUEST, mergePartitions, parseCitedExtractionV3, partitionPlan, rebuildPartitionsFromRaw, type PartitionResult } from "../../../services/intelligence/research/spec/extractionV3";
import { CITED_CLAIMS_V3, type ExtractedClaimV3, type ReportedSectionOutcome, type Section, type SectionId } from "../../../services/intelligence/research/spec/researchSpecV1";

export const KIMI_EXTRACT_V3_PROVIDER_ID = "kimi_extract";
/** Benchmark/v3 only (recovery path 13 Sep 2026). Production cited-claims/2 keeps its own 60 s. Not to be raised further without a decision. */
export const V3_TIMEOUT_MS = 300_000;

export interface ExtractionEnvelopeV3 extends Omit<ExtractionEnvelope, "claims"> {
  claims: ExtractedClaimV3[];
  sectionOutcomes: Partial<Record<SectionId, ReportedSectionOutcome>>;
  extractionMode: "single" | "partitioned";
  /** Per-partition record (partitioned mode). */
  partitions?: Array<Omit<PartitionResult, "parsed">>;
  degenerate?: { degenerate: boolean; reason: string | null };
}

export type ExtractCall = (system: string, prompt: string) => Promise<any>;
const defaultCall: ExtractCall = (system, user) => kimiInstant(system, user, true, V3_TIMEOUT_MS);

/** One call over every envelope (the original mode). */
export async function extractWithCitationsV3(envelopes: SearchEnvelope[], hints: IdentityHints, envelopeId: string, sections: Section[], opts: { reserve?: () => Promise<boolean>; call?: ExtractCall } = {}): Promise<ExtractionEnvelopeV3> {
  const fetchedAt = new Date().toISOString();
  const t0 = Date.now();
  const prompt = buildCitedExtractionPromptV3(envelopes, hints, sections);
  const chunks = envelopes.reduce((a, e) => a + e.chunks.length, 0);
  const base: ExtractionEnvelopeV3 = { id: envelopeId, provider: KIMI_EXTRACT_V3_PROVIDER_ID, model: KIMI.vertexModel, schemaVersion: CITED_CLAIMS_V3, extractionMode: "single", fetchedAt, claims: [], inferences: [], sectionOutcomes: {}, raw: null, request: EXTRACTION_V3_REQUEST(KIMI.vertexModel, chunks, sections, "single"), errors: [], parseError: null };
  if (!chunks) return { ...base, errors: [{ step: "extract", message: "no chunks to extract from" }] };
  if (opts.reserve && !(await opts.reserve())) return { ...base, errors: [{ step: "extract", message: "LLM budget reservation refused — no call made", class: "budget" }] };
  try {
    const response: any = await (opts.call ?? defaultCall)(CITED_EXTRACTION_SYSTEM_V3, prompt);
    const raw = response?.choices?.[0]?.message?.content ?? "{}";
    const p = parseCitedExtractionV3(raw, sections);
    const degenerate = degenerateReason(p, envelopes, sections);
    return { ...base, claims: p.claims, inferences: p.inferences, sectionOutcomes: p.sectionOutcomes, degenerate, raw: { content: raw, aboutIdentityConfidence: p.aboutIdentityConfidence, unknownSectionKeys: p.unknownSectionKeys }, parseError: p.parseError, usage: { promptTokens: response?.usage?.prompt_tokens, completionTokens: response?.usage?.completion_tokens, calls: 1, latencyMs: Date.now() - t0 } };
  } catch (e: any) {
    return { ...base, errors: [{ step: "extract", message: String(e?.message ?? e).slice(0, 300), class: "transient" }], usage: { calls: 1, latencyMs: Date.now() - t0 } };
  }
}

/** Partitioned mode: one call per ResearchSpec query (its envelopes, its sections), sequential, merged deterministically. Partitions with no envelopes or no sections are skipped (no call). */
export async function extractPartitionedV3(envelopes: SearchEnvelope[], hints: IdentityHints, envelopeId: string, sections: Section[], opts: { reserve?: () => Promise<boolean>; call?: ExtractCall; onPartition?: (r: Omit<PartitionResult, "parsed">) => void } = {}): Promise<ExtractionEnvelopeV3> {
  const fetchedAt = new Date().toISOString();
  const t0 = Date.now();
  const plan = partitionPlan(envelopes, sections);
  const results: PartitionResult[] = [];
  let calls = 0, promptTokens = 0, completionTokens = 0, usageIncomplete = false;
  for (const part of plan) {
    const chunks = part.envelopes.reduce((a, e) => a + e.chunks.length, 0);
    const baseR = { queryId: part.queryId, queryName: part.queryName, sections: part.sections.map((s) => s.id), envelopeIds: part.envelopes.map((e) => e.id), chunks };
    if (!chunks || !part.sections.length) { results.push({ ...baseR, status: "skipped", reason: !part.sections.length ? "no section in scope" : "no chunks", latencyMs: null, promptTokens: null, completionTokens: null, claims: 0, parsed: null, raw: null, error: null }); continue; }
    if (opts.reserve && !(await opts.reserve())) { results.push({ ...baseR, status: "failed", reason: "budget", latencyMs: null, promptTokens: null, completionTokens: null, claims: 0, parsed: null, raw: null, error: "LLM budget reservation refused — no call made" }); continue; }
    const p0 = Date.now();
    calls++;
    try {
      const response: any = await (opts.call ?? defaultCall)(CITED_EXTRACTION_SYSTEM_V3, buildCitedExtractionPromptV3(part.envelopes, hints, part.sections));
      const raw = response?.choices?.[0]?.message?.content ?? "{}";
      const parsed = parseCitedExtractionV3(raw, part.sections);
      const deg = degenerateReason(parsed, part.envelopes, part.sections);
      const pt = response?.usage?.prompt_tokens ?? null, ct = response?.usage?.completion_tokens ?? null;
      promptTokens += pt ?? 0; completionTokens += ct ?? 0; if (pt == null) usageIncomplete = true;
      results.push({ ...baseR, status: deg.degenerate ? "degenerate" : "ok", reason: deg.reason, latencyMs: Date.now() - p0, promptTokens: pt, completionTokens: ct, claims: parsed.claims.length, parsed, raw, error: null });
    } catch (e: any) {
      usageIncomplete = true;
      results.push({ ...baseR, status: "failed", reason: "transient", latencyMs: Date.now() - p0, promptTokens: null, completionTokens: null, claims: 0, parsed: null, raw: null, error: String(e?.message ?? e).slice(0, 300) });
    }
    opts.onPartition?.(stripParsed(results[results.length - 1]));
  }
  const merged = mergePartitions(results);
  const failed = results.filter((r) => r.status === "failed");
  return {
    id: envelopeId, provider: KIMI_EXTRACT_V3_PROVIDER_ID, model: KIMI.vertexModel, schemaVersion: CITED_CLAIMS_V3, extractionMode: "partitioned", fetchedAt,
    claims: merged.claims, inferences: [], sectionOutcomes: merged.sectionOutcomes,
    partitions: results.map(stripParsed),
    // ARM-level rule in extractionV3.armDegenerate: a degenerate partition alone leaves its sections unknown (never an abstention).
    degenerate: armDegenerate(merged, results),
    raw: { partitions: Object.fromEntries(results.map((r) => [r.queryId, r.raw])), aboutIdentityConfidence: merged.aboutIdentityConfidence, identityConfidenceByPartition: merged.identityConfidenceByPartition, unknownSectionKeys: merged.unknownSectionKeys, sectionsUnavailable: merged.sectionsUnavailable },
    request: EXTRACTION_V3_REQUEST(KIMI.vertexModel, envelopes.reduce((a, e) => a + e.chunks.length, 0), sections, "partitioned"),
    errors: failed.map((r) => ({ step: `extract:${r.queryId}`, message: r.error ?? "failed", class: r.reason === "budget" ? "budget" : "transient" })),
    parseError: null,
    usage: { promptTokens, completionTokens, calls, latencyMs: Date.now() - t0, ...(usageIncomplete ? { usageIncomplete: true } : {}) },
  };
}

function stripParsed(r: PartitionResult): Omit<PartitionResult, "parsed"> { const { parsed: _p, ...rest } = r; return rest; }

/** Re-derive a SAVED partitioned extraction from its stored partition raws with the current merge rules — deterministic, no call. Usage, timings and partition records are preserved. */
export function rebuildPartitionedExtraction(saved: ExtractionEnvelopeV3, envelopes: SearchEnvelope[], sections: Section[]): ExtractionEnvelopeV3 {
  if (saved.extractionMode !== "partitioned" || !saved.partitions) return saved;
  const results = rebuildPartitionsFromRaw(saved.partitions, envelopes, sections);
  const merged = mergePartitions(results);
  return {
    ...saved,
    claims: merged.claims, sectionOutcomes: merged.sectionOutcomes,
    partitions: results.map(stripParsed),
    degenerate: armDegenerate(merged, results),
    raw: { ...(saved.raw as object ?? {}), aboutIdentityConfidence: merged.aboutIdentityConfidence, identityConfidenceByPartition: merged.identityConfidenceByPartition, unknownSectionKeys: merged.unknownSectionKeys, sectionsUnavailable: merged.sectionsUnavailable },
  };
}
