/**
 * research/benchmark/recovery.ts — arm status and re-extraction from saved evidence (recovery path approved 13 Sep 2026).
 *
 * Four states that must never be confused:
 *   - `search_failed`        — the provider produced no usable search evidence (every query incomplete or refused);
 *   - `extraction_failed`    — searches completed but the extraction (or a partition of it) errored or timed out;
 *   - `extraction_degenerate`— searches completed and the extractor answered, but the answer is structurally unusable
 *                              (malformed schema, no section outcome matching an exact alias, a template echo, or zero
 *                              claims on clearly substantive evidence);
 *   - `complete`             — searches and extraction ran and parsed; only here can "abstained" (a semantic research
 *                              outcome: not_found / conflicting / not_applicable / unresolved identity) be asserted.
 *
 * Re-extraction reuses the saved search envelopes byte-for-byte (same as-of, timestamps, usage/cost, citations, provider
 * text) and replaces only the extraction/result layer, recording every attempt (single, recovery or partitioned) in
 * `extractionHistory`. Pure.
 */

import { degenerateReason } from "../spec/extractionV3";
import { sectionsFor } from "../spec/researchSpecV1";
import type { ArmExtraction, ArmRun, ArmStatus, ExtractionAttempt } from "./types";

export function searchCompleted(arm: Pick<ArmRun, "queries" | "search">): { completed: number; total: number } {
  const total = arm.queries.length || arm.search.length;
  const completed = arm.queries.length ? arm.queries.filter((q) => q.completed).length : arm.search.filter((e) => e.chunks.length > 0 && e.answerText.trim().length > 0).length;
  return { completed, total };
}

export function extractionFailed(extraction: ArmExtraction | null): boolean {
  return !extraction || extraction.errors.length > 0;
}

/** Degenerate = the extractor answered but the answer is unusable. Uses the stored check when present, else recomputes it from the saved envelopes (legacy artifacts). */
export function extractionDegenerate(arm: Pick<ArmRun, "search" | "extraction">, isMinor = false): { degenerate: boolean; reason: string | null } {
  const x = arm.extraction;
  if (!x || x.errors.length) return { degenerate: false, reason: null };
  if (x.degenerate) return x.degenerate;
  if (x.parseError) return { degenerate: true, reason: `malformed: ${x.parseError}` };
  const rawUnknown = (x.raw as any)?.unknownSectionKeys;
  return degenerateReason({ claims: x.claims, aboutIdentityConfidence: (x.raw as any)?.aboutIdentityConfidence ?? null, parseError: x.parseError ?? null, sectionOutcomes: x.sectionOutcomes ?? {}, unknownSectionKeys: Array.isArray(rawUnknown) ? rawUnknown : [] }, arm.search, sectionsFor(isMinor));
}

/** Derive the arm status from what actually happened (also used to upgrade artifacts written before `status` existed). */
export function armStatus(arm: Pick<ArmRun, "queries" | "search" | "extraction">, isMinor = false): ArmStatus {
  const s = searchCompleted(arm);
  if (s.total === 0 || s.completed === 0) return "search_failed";
  if (extractionFailed(arm.extraction)) return "extraction_failed";
  if (extractionDegenerate(arm, isMinor).degenerate) return "extraction_degenerate";
  return "complete";
}

export function attemptFrom(extraction: ArmExtraction | null, at: string, mode: ExtractionAttempt["mode"], arm?: Pick<ArmRun, "search">): ExtractionAttempt {
  const failed = extractionFailed(extraction);
  const deg = !failed && extraction && arm ? extractionDegenerate({ search: arm.search, extraction }) : { degenerate: false, reason: null };
  const outcome: ExtractionAttempt["outcome"] = failed ? "failed" : deg.degenerate ? "degenerate" : "ok";
  const parts = extraction?.partitions?.map((p) => ({ queryId: p.queryId, sections: p.sections, chunks: p.chunks, status: p.status, latencyMs: p.latencyMs, claims: p.claims, reason: p.reason ?? p.error ?? null })) ?? null;
  return {
    at, mode, outcome,
    error: failed ? (extraction?.errors.map((e) => e.message).join("; ") || "no extraction") : deg.degenerate ? deg.reason : null,
    latencyMs: extraction?.usage?.latencyMs ?? null, promptTokens: extraction?.usage?.promptTokens ?? null, completionTokens: extraction?.usage?.completionTokens ?? null,
    claims: extraction?.claims.length ?? 0, partitions: parts,
  };
}

/** Can this saved arm be re-extracted from its own evidence? extraction_failed and extraction_degenerate qualify; a minor-minimized artifact keeps its (PII-redacted) text and qualifies too. */
export function canReextract(arm: ArmRun, isMinor = false): { ok: true } | { ok: false; reason: string } {
  const st = armStatus(arm, isMinor);
  if (st !== "extraction_failed" && st !== "extraction_degenerate") return { ok: false, reason: `status is ${st}` };
  if (!arm.search.some((e) => e.chunks.some((c) => c.text.trim().length > 0))) return { ok: false, reason: "saved envelopes carry no chunk text" };
  return { ok: true };
}

/**
 * Merge a fresh extraction into a saved arm: search envelopes, queries, as-of, timestamps, search usage and search cost are
 * preserved untouched; the extraction layer is replaced; extraction usage/cost/latency ACCUMULATE across attempts (every
 * attempt was billed, a timed-out attempt with unknown usage makes the cost incomplete); the attempt is appended to history.
 */
export function mergeReextraction(saved: ArmRun, extraction: ArmExtraction, at: string, extractUsdForAttempt: number, mode: ExtractionAttempt["mode"] = "recovery", isMinor = false): ArmRun {
  const prevAttempts = saved.extractionHistory?.length ? saved.extractionHistory : [attemptFrom(saved.extraction, saved.finishedAt, "single", saved)];
  const history = [...prevAttempts, attemptFrom(extraction, at, mode, saved)];
  const prevExtractPrompt = prevAttempts.reduce((a, x) => a + (x.promptTokens ?? 0), 0);
  const prevExtractCompletion = prevAttempts.reduce((a, x) => a + (x.completionTokens ?? 0), 0);
  const searchPrompt = saved.search.reduce((a, e) => a + (e.usage?.promptTokens ?? 0), 0);
  const searchCompletion = saved.search.reduce((a, e) => a + (e.usage?.completionTokens ?? 0), 0);
  const unknownUsage = history.some((x) => x.outcome === "failed" && x.promptTokens == null) || !!extraction.usage?.usageIncomplete || saved.search.some((e) => e.usage?.usageIncomplete);
  return {
    ...saved,
    extraction,
    extractionHistory: history,
    extractionRetried: true,
    status: armStatus({ queries: saved.queries, search: saved.search, extraction }, isMinor),
    finishedAt: at,
    usage: {
      ...saved.usage,
      extractCalls: history.reduce((a, x) => a + (x.partitions ? x.partitions.filter((p) => p.status !== "skipped").length : 1), 0),
      promptTokens: searchPrompt + prevExtractPrompt + (extraction.usage?.promptTokens ?? 0),
      completionTokens: searchCompletion + prevExtractCompletion + (extraction.usage?.completionTokens ?? 0),
      latencyMs: saved.search.reduce((a, e) => a + (e.usage?.latencyMs ?? 0), 0) + history.reduce((a, x) => a + (x.latencyMs ?? 0), 0),
    },
    estimatedCostUsd: { search: saved.estimatedCostUsd.search, extract: r4(saved.estimatedCostUsd.extract + extractUsdForAttempt), total: r4(saved.estimatedCostUsd.search + saved.estimatedCostUsd.extract + extractUsdForAttempt), complete: !unknownUsage },
  };
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Upgrade an artifact arm written before `status`/`extractionHistory` existed (or before extraction_degenerate). Pure; idempotent. */
export function normalizeSavedArm(arm: ArmRun, isMinor = false): ArmRun {
  const history = arm.extractionHistory?.length ? arm.extractionHistory.map((h) => ({ ...h, mode: h.mode ?? "single", claims: h.claims ?? 0, partitions: h.partitions ?? null })) : [attemptFrom(arm.extraction, arm.finishedAt, "single", arm)];
  return { ...arm, status: armStatus(arm, isMinor), extractionHistory: history, extractionRetried: arm.extractionRetried ?? history.length > 1 };
}
