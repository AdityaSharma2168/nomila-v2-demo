/**
 * research/reprocessLineage.ts — DEV-ONLY deterministic lineage recovery (13 Sep 2026, slice E).
 *
 * bindGeminiFinding (quote/statement precedence + normalization, spec/directLineage.ts) binds more findings than the
 * quote-only binder it replaces. This re-derives lineage for the already-stored direct-evidence/2 claims of an
 * athlete's most recent `gemini_direct` research run WITHOUT any new provider call: it rebuilds the run's stored
 * SearchEnvelopes from research_source_payloads, re-binds every `asserted_only` / `native_supported` claim against
 * them, and opens a NEW research_runs row (`trigger: "backfill"`) so persistResearchRun's normal path (canonicalize →
 * registry → resolver) re-derives athlete_facts on the recovered evidence. The old run's research_evidence rows are
 * then marked superseded so the context builder stops reading them (facts are already superseded by persist's own
 * resolver rule — this module never touches athlete_facts directly).
 *
 * Never downgrades an existing native_supported claim: if the new binder cannot re-bind it in any envelope, its
 * level is kept and only `bindingMethod`/`detail` record that a legacy binding was kept. No provider call, no
 * `lib/models` import (the intelligence boundary rule, boundary.test.ts) — this module is pure re-derivation over
 * rows already in Postgres.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../db";
import { athletes, athleteFacts, researchEvidence, researchRuns, researchSourcePayloads } from "../../../../shared/schema";
import { canonicalJson } from "../params";
import { collectResearchSecrets } from "../../../lib/research/secrets";
import { assertionsFor, hintsFor } from "./researchInputs";
import { researchSubstrateWriteEnabled } from "./config";
import { persistResearchRun } from "./persist";
import type { ExtractionEnvelope, SearchEnvelope } from "./providers";
import { hasIdentitySignal } from "./refresh";
import { bindGeminiFinding, type GroundingChunkLike, type GroundingSupportLike } from "./spec/directLineage";
import type { DirectClaimLineage } from "./spec/directEvidenceV1";

export const REPROCESS_LINEAGE_VERSION = "lineage-recovery/1";

export interface LineageCounts { native_supported: number; asserted_only: number; native_retrieved: number; other: number }
const zeroCounts = (): LineageCounts => ({ native_supported: 0, asserted_only: 0, native_retrieved: 0, other: 0 });
function bump(c: LineageCounts, level: unknown): void {
  if (level === "native_supported" || level === "asserted_only" || level === "native_retrieved") c[level]++;
  else c.other++;
}

export interface ReprocessAthleteResult {
  athleteId: string;
  status: "reprocessed" | "dry_run" | "skipped";
  reason?: string;
  oldRunId: string | null;
  newRunId: string | null;
  before: LineageCounts;
  after: LineageCounts;
  bindingMethodHistogram: Record<string, number>;
  factsBefore: number;
  factsAfter: number;
  supersededCount: number;
  unmatchedCount: number;
  legacyKeptCount: number;
  ambiguousBindings: number;
}

export interface ReprocessOpts { dryRun?: boolean; asOf?: Date }

/** Every athlete whose MOST RECENT research run carrying `providers[0].provider === "gemini_direct"` has status
 *  ok/partial and trigger !== "backfill" (the default CLI selection). */
export async function findEligibleAthleteIds(): Promise<string[]> {
  const rows = await db.select({ athlete_id: researchRuns.athlete_id, status: researchRuns.status, trigger: researchRuns.trigger, providers: researchRuns.providers })
    .from(researchRuns).orderBy(desc(researchRuns.started_at));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const providers = (r.providers ?? []) as Array<{ provider?: string }>;
    if (providers[0]?.provider !== "gemini_direct") continue;   // not this athlete's most recent gemini_direct run
    if (seen.has(r.athlete_id)) continue;                       // a later (more recent) run already decided this athlete
    seen.add(r.athlete_id);
    if ((r.status === "ok" || r.status === "partial") && r.trigger !== "backfill") out.push(r.athlete_id);
  }
  return out;
}

async function latestGeminiDirectRun(athleteId: string) {
  const rows = await db.select().from(researchRuns).where(eq(researchRuns.athlete_id, athleteId)).orderBy(desc(researchRuns.started_at));
  return rows.find((r) => ((r.providers ?? []) as Array<{ provider?: string }>)[0]?.provider === "gemini_direct") ?? null;
}

/** The chunk-id prefix an envelope's own chunks/supports already use (e.g. "d0:c3" → "d0"), so a re-bound claim's
 *  boundChunkIds keep pointing at the SAME stored chunk ids. Falls back to a positional id when nothing is found. */
function recoverEnvelopePrefix(chunks: Array<{ id?: unknown }>, supports: Array<{ chunkIds?: unknown }>, fallback: string): string {
  for (const c of chunks) if (typeof c.id === "string" && c.id.includes(":")) return c.id.split(":")[0];
  for (const s of supports) { const cid = Array.isArray(s.chunkIds) ? s.chunkIds[0] : undefined; if (typeof cid === "string" && cid.includes(":")) return cid.split(":")[0]; }
  return fallback;
}

/** Rebuild one SearchEnvelope from a stored `search:<queryName>` payload row — same shape refresh.ts's
 *  storedSearchEnvelopes builds, but keeping the ORIGINAL envelope id/chunk ids (recovered, never re-minted) so
 *  re-bound boundChunkIds stay consistent with what is already on disk, and carrying `raw` through (it holds the
 *  groundingChunks/groundingSupports the binder needs — refresh.ts's version drops it, it doesn't need it). */
function rebuildEnvelope(row: typeof researchSourcePayloads.$inferSelect, index: number): SearchEnvelope {
  const p = (row.payload ?? {}) as { answerText?: unknown; chunks?: unknown; supports?: unknown; raw?: unknown };
  const chunks = Array.isArray(p.chunks) ? p.chunks : [];
  const supports = Array.isArray(p.supports) ? p.supports : [];
  const id = recoverEnvelopePrefix(chunks, supports, `p${index}`);
  return {
    id, provider: row.provider, model: row.model ?? undefined, queryName: row.endpoint_family.replace(/^search:/, ""), query: "(reprocessed, no call)",
    fetchedAt: row.fetched_at.toISOString(), answerText: String(p.answerText ?? ""), chunks: chunks as SearchEnvelope["chunks"], supports: supports as SearchEnvelope["supports"],
    raw: p.raw ?? null, request: { path: "reprocess", params: { payloadId: row.id } }, errors: [],
  };
}

/** Re-bind one claim against the run's rebuilt envelopes. Returns the new lineage and whether more than one envelope
 *  independently bound it (rare; the first one found is kept — noted via `ambiguous`). */
function rebindClaim(claim: { lineage?: { level?: string; boundChunkIds?: string[]; boundSources?: unknown; detail?: string | null }; sources?: Array<{ quote?: string }>; statement?: string | null }, envelopes: SearchEnvelope[]): { lineage: DirectClaimLineage; legacyKept: boolean; ambiguous: boolean } {
  const level = claim.lineage?.level;
  const quote = claim.sources?.[0]?.quote;
  const statement = claim.statement;
  let bound: DirectClaimLineage | null = null;
  let bindingEnvelopes = 0;
  for (const env of envelopes) {
    const raw = (env.raw ?? {}) as { groundingSupports?: GroundingSupportLike[]; groundingChunks?: GroundingChunkLike[] };
    const supports = Array.isArray(raw.groundingSupports) ? raw.groundingSupports : [];
    const chunks = Array.isArray(raw.groundingChunks) ? raw.groundingChunks : [];
    if (!supports.length || !chunks.length) continue;
    const result = bindGeminiFinding({ quote, statement }, env.answerText, supports, chunks, env.id);
    if (result.level === "native_supported") { bindingEnvelopes++; if (!bound) bound = result; }
  }
  if (bound) return { lineage: bound, legacyKept: false, ambiguous: bindingEnvelopes > 1 };
  if (level === "native_supported") {
    // Never downgrade: no envelope re-binds it, so the old binding stands — only the method/detail record that.
    const old = claim.lineage as DirectClaimLineage;
    return { lineage: { ...old, bindingMethod: "quote_exact", detail: "legacy binding kept" }, legacyKept: true, ambiguous: false };
  }
  return { lineage: { level: "asserted_only", match: "none", boundChunkIds: [], boundSources: [], bindingMethod: "none", detail: claim.lineage?.detail ?? "no binding method matched" }, legacyKept: false, ambiguous: false };
}

async function countCurrentFacts(athleteId: string): Promise<number> {
  const rows = await db.select({ id: athleteFacts.id }).from(athleteFacts).where(and(eq(athleteFacts.athlete_id, athleteId), eq(athleteFacts.status, "current")));
  return rows.length;
}

/** Match old run evidence to new run evidence on kind + canonical claim (minus `canonicalization`, which the
 *  resolver/canonicalizer re-applies deterministically and so never differs) and set `superseded_by`. A row with
 *  no match is left alone (its `unmatchedCount` is reported, never guessed). */
async function supersedeOldEvidence(oldRunId: string, newRunId: string): Promise<{ supersededCount: number; unmatchedCount: number }> {
  const keyOf = (kind: string, claim: unknown) => { const c = { ...(claim as Record<string, unknown>) }; delete c.canonicalization; return `${kind}|${canonicalJson(c)}`; };
  const [oldRows, newRows] = await Promise.all([
    db.select().from(researchEvidence).where(eq(researchEvidence.run_id, oldRunId)),
    db.select().from(researchEvidence).where(eq(researchEvidence.run_id, newRunId)),
  ]);
  const newByKey = new Map<string, string>();
  for (const n of newRows) { const k = keyOf(n.kind, n.claim); if (!newByKey.has(k)) newByKey.set(k, n.id); }
  let supersededCount = 0, unmatchedCount = 0;
  for (const o of oldRows) {
    const newId = newByKey.get(keyOf(o.kind, o.claim));
    if (newId) { await db.update(researchEvidence).set({ superseded_by: newId }).where(eq(researchEvidence.id, o.id)); supersededCount++; }
    else unmatchedCount++;
  }
  return { supersededCount, unmatchedCount };
}

const skipped = (athleteId: string, reason: string): ReprocessAthleteResult => ({
  athleteId, status: "skipped", reason, oldRunId: null, newRunId: null, before: zeroCounts(), after: zeroCounts(),
  bindingMethodHistogram: {}, factsBefore: 0, factsAfter: 0, supersededCount: 0, unmatchedCount: 0, legacyKeptCount: 0, ambiguousBindings: 0,
});

/**
 * Re-derive one athlete's most recent gemini_direct run's lineage, deterministically, with no provider call.
 * `dryRun` (default false): compute before/after counts without writing anything (no new run, no supersession).
 * Writing requires RESEARCH_SUBSTRATE_WRITE=true — the module refuses otherwise, matching persist's own gate.
 */
export async function reprocessAthleteLineage(athleteId: string, opts: ReprocessOpts = {}): Promise<ReprocessAthleteResult> {
  const dryRun = opts.dryRun ?? false;

  const oldRun = await latestGeminiDirectRun(athleteId);
  if (!oldRun) return skipped(athleteId, "no gemini_direct research run found for this athlete");
  if (oldRun.status !== "ok" && oldRun.status !== "partial") return skipped(athleteId, `latest gemini_direct run status is "${oldRun.status}", not ok/partial`);
  if (oldRun.trigger === "backfill") return skipped(athleteId, "latest gemini_direct run is already a reprocessing (backfill) run");

  const payloadRows = await db.select().from(researchSourcePayloads).where(eq(researchSourcePayloads.run_id, oldRun.id)).orderBy(researchSourcePayloads.created_at);
  const searchRows = payloadRows.filter((r) => r.endpoint_family.startsWith("search:"));
  const extractionRow = payloadRows.find((r) => r.endpoint_family === "extraction") ?? null;
  if (!extractionRow) return skipped(athleteId, "the run has no extraction payload to reprocess");

  const envelopes = searchRows.map((r, i) => rebuildEnvelope(r, i));
  const oldExtractionPayload = (extractionRow.payload ?? {}) as { claims?: unknown[]; raw?: unknown; domainOutcomes?: unknown };
  const oldClaims: any[] = Array.isArray(oldExtractionPayload.claims) ? oldExtractionPayload.claims : [];

  const before = zeroCounts(), after = zeroCounts();
  const bindingMethodHistogram: Record<string, number> = {};
  let legacyKeptCount = 0, ambiguousBindings = 0;

  const reboundClaims = oldClaims.map((claim) => {
    const level = claim?.lineage?.level;
    bump(before, level);
    if (level !== "asserted_only" && level !== "native_supported") { bump(after, level); return claim; }   // native_retrieved (OpenAI path) or malformed: untouched
    const { lineage, legacyKept, ambiguous } = rebindClaim(claim, envelopes);
    if (legacyKept) legacyKeptCount++;
    if (ambiguous) ambiguousBindings++;
    bump(after, lineage.level);
    bindingMethodHistogram[lineage.bindingMethod] = (bindingMethodHistogram[lineage.bindingMethod] ?? 0) + 1;
    const quote = claim?.sources?.[0]?.quote;
    const citation = lineage.boundChunkIds.length || quote ? { chunkIds: lineage.boundChunkIds, quote: String(quote ?? "").slice(0, 300) } : null;
    return { ...claim, lineage, citation };
  });

  if (dryRun) {
    return { athleteId, status: "dry_run", oldRunId: oldRun.id, newRunId: null, before, after, bindingMethodHistogram, factsBefore: await countCurrentFacts(athleteId), factsAfter: -1, supersededCount: 0, unmatchedCount: 0, legacyKeptCount, ambiguousBindings };
  }

  if (!researchSubstrateWriteEnabled()) throw new Error("RESEARCH_SUBSTRATE_WRITE must be \"true\" in the environment to write a reprocessing run (persist would otherwise write nothing)");

  const asOf = opts.asOf ?? new Date();
  const factsBefore = await countCurrentFacts(athleteId);
  const [athleteRow] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!athleteRow) return skipped(athleteId, "athlete row no longer exists");
  const knownHandles = Object.fromEntries(Object.entries((athleteRow.socials ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => [k === "twitter" ? "x" : k, String(v).replace(/^@/, "")]));
  const legacy = await hintsFor(athleteRow as any, knownHandles);
  const identityResolved = await hasIdentitySignal(athleteId);
  const retrievedAt = oldRun.as_of ?? oldRun.started_at ?? asOf;

  const [newRun] = await db.insert(researchRuns).values({
    athlete_id: athleteId, domain: "full", trigger: "backfill", status: "running", started_at: asOf, as_of: retrievedAt,
    providers: oldRun.providers, summary: { reprocess: { version: REPROCESS_LINEAGE_VERSION, sourceRunId: oldRun.id } } as any,
  }).returning({ id: researchRuns.id });
  const newRunId = newRun.id;

  const newExtraction: ExtractionEnvelope = {
    id: "d-map", provider: "gemini_direct", model: extractionRow.model ?? undefined, schemaVersion: "direct-evidence/2", fetchedAt: new Date().toISOString(),
    claims: reboundClaims, inferences: [], domainOutcomes: (oldExtractionPayload as any).domainOutcomes ?? undefined,
    raw: { ...((oldExtractionPayload.raw as Record<string, unknown>) ?? {}), reprocess: REPROCESS_LINEAGE_VERSION, sourceRunId: oldRun.id },
    request: { path: "reprocess-direct-lineage", params: { sourceRunId: oldRun.id } }, errors: [], parseError: null,
  };

  const persisted = await persistResearchRun({
    athleteId, runId: newRunId, trigger: "backfill", domain: "full", hints: legacy.hints, search: envelopes, extraction: newExtraction, signals: [],
    assertions: await assertionsFor(athleteId), hasAssertedAffiliations: legacy.hasAssertedAffiliations, identityResolved, identityConfidence: identityResolved ? 1 : undefined,
    secrets: collectResearchSecrets(), asOf: retrievedAt, retrievedAt,
  });
  if (!persisted) throw new Error(`persistResearchRun returned null for athlete ${athleteId} (run ${newRunId} closed failed — see research_runs.error)`);

  const { supersededCount, unmatchedCount } = await supersedeOldEvidence(oldRun.id, newRunId);
  const factsAfter = await countCurrentFacts(athleteId);
  return { athleteId, status: "reprocessed", oldRunId: oldRun.id, newRunId, before, after, bindingMethodHistogram, factsBefore, factsAfter, supersededCount, unmatchedCount, legacyKeptCount, ambiguousBindings };
}
