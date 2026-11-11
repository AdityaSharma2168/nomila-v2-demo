/**
 * research/persist.ts — ResearchService.persist (Step 2a).
 *
 * One research run's provider envelopes → the substrate, ATOMICALLY:
 *   research_runs row (telemetry, outside the transaction so a failure is still recorded)
 *   then, in ONE transaction: sanitize → research_source_payloads → research_evidence
 *   (citation-validated, injection-checked, source-typed) → resolveFacts by the authority
 *   policy → athlete_facts (+ supersedes) → athlete_inferences → per-domain statuses →
 *   athlete_research_state. Any failure rolls every canonical write back; the run row is then
 *   closed `failed` with the normalized error. The only writer of the six research tables.
 *   Gated by RESEARCH_SUBSTRATE_WRITE. Never throws into the caller. No provider import.
 *
 * Secrets: the caller passes the live provider credentials (collected at runtime, never
 * logged); every payload and request is sanitized with them and refused if anything
 * secret-like survives (the Step 1a contract).
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db";
import { createLogger } from "../../../logger";
import { athleteFacts, athleteInferences, athleteResearchState, researchEvidence, researchRuns, researchSourcePayloads, type AthleteFactRow } from "../../../../shared/schema";
import { canonicalJson } from "../params";
import { assertNoSecrets, sanitizePayload, SanitizerLeakError, SANITIZER_VERSION } from "../social/sanitize";
import type { ExtractionEnvelope, ExtractedClaim, IdentityHints, SearchEnvelope, SignalEnvelope } from "./providers";
import { validateCitation } from "./lineage";
import { claimIsSuspect, domainAllowed } from "./injection";
import { getResearchPolicy, researchSubstrateWriteEnabled, resolveSourceType, type ResearchPolicy } from "./config";
import { syncAffiliationsFromFacts, type SyncResult } from "./affiliationSync";
import { resolveFacts, type Assertion, type Candidate, type FactRow, type NewFact } from "./resolve";
import { deriveResearchState, domainStatus, type DomainEvidenceSummary } from "./state";
import { getFactDefinition, isRegisteredKey, BLOCKING_KEYS } from "./factRegistry";
import { DOMAIN_FRESHNESS, domainOfEvidence, EVIDENCE_KINDS_V2, isCitedLineage, RESEARCH_DOMAINS, resolverLineageOf, type DomainOutcome, type LineageStatus, type ResearchDomain, type ResearchTrigger, type RunDomain } from "./registries";
import { canonicalizeValue } from "./spec/canonicalize";
import { affiliationNamedIn, captaincyAffiliation, INSTITUTION_REF, ROLE_SOURCE_TYPES, type CurrentAffiliation } from "./spec/itemMapping";
import type { DirectClaimLineage } from "./spec/directEvidenceV1";
import { modelOutletType } from "./policy";
import { domainOutcome, isFreshOutcome, type DomainAcceptance, type DomainQueryStatus } from "./outcomes";
import { estimateCallUsd } from "./plans";

const logger = createLogger("research-substrate");
const DAY = 86_400_000;

/** A message for a log line or an error record: the live secrets redacted; withheld entirely if anything secret-like survives. */
export function redactMessage(message: unknown, secrets: string[]): string {
  const text = String(message ?? "").slice(0, 300);
  const clean = sanitizePayload(text, secrets).out;
  try { assertNoSecrets(clean, secrets, "telemetry"); return clean; } catch { return "[withheld: secret-like content]"; }
}

/** The only error shape research_runs.error may hold, sanitized with the live secrets (the Step 1a closeSyncRun rule). */
export function redactErrorRecord(rec: { reason: string; message: string | null; subCalls?: Array<{ step: string; message: string }> }, secrets: string[]) {
  const clean = sanitizePayload({ reason: String(rec.reason).slice(0, 60), message: rec.message == null ? null : String(rec.message).slice(0, 300), subCalls: (rec.subCalls ?? []).slice(0, 50).map((c) => ({ step: String(c.step).slice(0, 120), message: String(c.message).slice(0, 300) })) }, secrets).out;
  try { assertNoSecrets(clean, secrets, "research_runs.error"); return clean; }
  catch { return { reason: "sanitizer_leak", message: "error record withheld: a secret-like string survived sanitization", subCalls: [] }; }
}

/** A transaction handle or the root client — every canonical write goes through the transaction. */
export type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Which domain an evidence kind / fact key belongs to. */

/** Step 2b: per-domain record on research_runs.summary.domains and athlete_research_state.domains. */
export interface DomainSummary { outcome: DomainOutcome; accepted: DomainAcceptance; freshnessSkipped?: "older_than_current" }

export interface PersistInput {
  athleteId: string;
  trigger: ResearchTrigger;
  domain?: RunDomain;
  hints: IdentityHints;
  search: SearchEnvelope[];
  extraction: ExtractionEnvelope | null;
  signals: SignalEnvelope[];
  /** The athlete's current assertions for registry keys (from athlete_asserted), for rule 2. */
  assertions?: Assertion[];
  /** The athlete has said/proof affiliation rows in the ledger (rule 7). */
  hasAssertedAffiliations: boolean;
  identityResolved?: boolean;
  identityConfidence?: number;
  /** Live provider credentials, redacted from every stored byte and asserted absent. Never logged. */
  secrets: string[];
  asOf?: Date;
  /** Backfill: evidence is uncited by construction and retrieved_at is the original run's time. Also the run's monotonic freshness key (§3.2). */
  retrievedAt?: Date;
  /** Step 2b: a run row already opened by the refresh step (its lane counters live there); persist updates it instead of inserting. */
  runId?: string;
  workflowRunId?: string | null;
  /** Step 2b: the planned domains and per-domain query completion (§3.1). Absent = a full run: every domain planned, completion inferred from the envelopes. */
  plan?: {
    domains: ResearchDomain[]; queryStatus: Partial<Record<ResearchDomain, DomainQueryStatus>>; dueToDispute?: ResearchDomain[];
    /**
     * PR E2a (design record §3, §5.2; finding #3) — the per-query split of research_refresh v3. Both absent = today's
     * behaviour byte for byte (acceptance = settle = `domains`).
     *   acceptance  every domain the executed query covers: a claim outside it is dropped before any canonical write
     *               (so Q1's profile evidence is kept although profile settles only with Q6);
     *   settle      the domains whose covering queries in this run have all run: ONLY these get an outcome, which
     *               drives freshness and refresh_failures. Every other domain is `not_planned` on this row.
     */
    acceptance?: ResearchDomain[];
    settle?: ResearchDomain[];
    /** Acceptance already counted for a settle domain by EARLIER queries of the same run, added before its outcome is decided. */
    carryAccepted?: Partial<Record<ResearchDomain, DomainAcceptance>>;
  };
  /** PR E2a (0081): the research-spec/1 query this row persists (research_runs.query_id). Absent/null = today's rows. */
  queryId?: string | null;
  /** PR E2a: extra keys merged into research_runs.summary (the query's identity block and step record). */
  summaryExtra?: Record<string, unknown>;
  /** Tests only: runs inside the transaction after every canonical write, before commit. */
  __onBeforeCommit?: () => Promise<void>;
}

export interface PersistResult { runId: string; status: "ok" | "partial" | "failed"; payloads: number; evidence: number; cited: number; uncited: number; conflicting: number; suspect: number; facts: number; disputed: number; refused: number; proposals: number; inferences: number; researchStatus: string; domains: Record<string, DomainSummary>; droppedOutOfPlan: number; affiliationSync?: SyncResult; /** Acceptance this row counted per domain (settled or not; carry excluded). */ accepted: Record<string, DomainAcceptance> }

export async function persistResearchRun(i: PersistInput): Promise<PersistResult | null> {
  if (!researchSubstrateWriteEnabled()) return null;
  const asOf = i.asOf ?? new Date();
  const retrievedAt = i.retrievedAt ?? asOf;
  const t0 = Date.now();
  let runId: string | null = null;
  try {
    const policy = await getResearchPolicy();
    const providers = [...i.search.map((e) => ({ role: "search", provider: e.provider, model: e.model ?? null })), ...(i.extraction ? [{ role: "extract", provider: i.extraction.provider, model: i.extraction.model ?? null }] : []), ...i.signals.map((e) => ({ role: "signal", provider: e.provider, model: null }))];
    const hintsClean = sanitizePayload(i.hints, i.secrets).out;
    assertNoSecrets(hintsClean, i.secrets, "research hints");
    // The run row lives outside the transaction: a failed run keeps its telemetry and error. A Step 2b
    // refresh opens the row BEFORE its provider calls (the ledger counts on it); persist then updates it.
    const runFields = { domain: i.domain ?? "full", trigger: i.trigger, providers: providers as any, identity_hints: hintsClean as any, hints_hash: createHash("sha256").update(canonicalJson(hintsClean)).digest("hex").slice(0, 16), as_of: retrievedAt, workflow_run_id: i.workflowRunId ?? null, ...(i.queryId ? { query_id: i.queryId } : {}) };
    if (i.runId) {
      await db.update(researchRuns).set(runFields).where(eq(researchRuns.id, i.runId));
      runId = i.runId;
    } else {
      const [run] = await db.insert(researchRuns).values({ athlete_id: i.athleteId, ...runFields, status: "running", started_at: asOf }).returning({ id: researchRuns.id });
      runId = run.id;
    }

    const out = await db.transaction(async (tx) => writeRun(tx, i, runId!, policy, asOf, retrievedAt, hintsClean));

    // A planned (Step 2b) run is `partial` when any planned domain did not reach a fresh outcome; a full
    // legacy/dual-write run keeps the Step 2a rule (sub-calls, conflicting or suspect items).
    const domainProblems = !!i.plan && Object.values(out.domains).some((d) => d.outcome === "failed" || d.outcome === "no_relevant");
    const status = out.subCalls.length || out.counts.conflicting || out.counts.suspect || domainProblems ? "partial" : "ok";
    const split = !!i.plan && (!!i.plan.acceptance || !!i.plan.settle);
    const summary = { payloads: out.payloads, evidence: out.evidence, ...out.counts, facts: out.facts, disputed: out.disputed, refused: out.refused, proposals: out.proposals, inferences: out.inferences, researchStatus: out.researchStatus, domains: out.domains, droppedOutOfPlan: out.droppedOutOfPlan, plan: i.plan ? { domains: i.plan.domains, ...(split ? { acceptance: i.plan.acceptance ?? i.plan.domains, settle: i.plan.settle ?? i.plan.domains } : {}) } : null, ...(split ? { accepted: out.accepted } : {}), ...(i.summaryExtra ?? {}) };
    await db.update(researchRuns).set({ status, finished_at: new Date(), calls: i.runId ? sql`llm_attempts + signal_calls + other_calls` : i.search.length + (i.extraction ? 1 : 0) + i.signals.length, tokens_in: sumTokens(i, "promptTokens"), tokens_out: sumTokens(i, "completionTokens"), tokens_cached: sumTokens(i, "cachedTokens"), latency_ms: Date.now() - t0, estimated_cost_usd: String(runCost(i, policy)), confidence_out: String(avgConfidence(i.extraction?.claims ?? [])), summary: summary as any, error: out.subCalls.length ? (redactErrorRecord({ reason: "partial", message: null, subCalls: out.subCalls }, i.secrets) as any) : null }).where(eq(researchRuns.id, runId));
    const result: PersistResult = { runId, status, payloads: out.payloads, evidence: out.evidence, ...out.counts, facts: out.facts, disputed: out.disputed, refused: out.refused, proposals: out.proposals, inferences: out.inferences, researchStatus: out.researchStatus, domains: out.domains, droppedOutOfPlan: out.droppedOutOfPlan , affiliationSync: out.affiliationSync, accepted: out.accepted };
    logger.info({ athleteId: i.athleteId, ...result }, "research persist");
    return result;
  } catch (err: any) {
    const reason = err instanceof SanitizerLeakError ? "sanitizer_leak" : "error";
    // Never log or persist an unsanitized exception message: it may carry a provider credential.
    logger.error({ athleteId: i.athleteId, reason, error: redactMessage(err?.message ?? err, i.secrets) }, "research persist failed (rolled back)");
    if (runId) await db.update(researchRuns).set({ status: "failed", finished_at: new Date(), latency_ms: Date.now() - t0, error: redactErrorRecord({ reason, message: redactMessage(err?.message ?? err, i.secrets) }, i.secrets) as any }).where(eq(researchRuns.id, runId)).catch(() => {});
    return null;
  }
}

interface WriteOut { payloads: number; evidence: number; counts: { cited: number; uncited: number; conflicting: number; suspect: number }; facts: number; disputed: number; refused: number; proposals: number; inferences: number; researchStatus: string; subCalls: Array<{ step: string; message: string }>; domains: Record<string, DomainSummary>; droppedOutOfPlan: number; affiliationSync?: SyncResult; accepted: Record<string, DomainAcceptance> }

/** Every canonical write of one run, inside the caller's transaction. Throws to roll back. */
async function writeRun(tx: DbClient, i: PersistInput, runId: string, policy: ResearchPolicy, asOf: Date, retrievedAt: Date, hintsClean: unknown): Promise<WriteOut> {
  const subCalls: Array<{ step: string; message: string }> = [];

  // ── payloads ──
  const payloadIds = new Map<string, string>();   // envelope id → payload id
  let payloads = 0;
  const store = async (envelopeId: string, provider: string, model: string | null | undefined, family: string, request: Record<string, unknown>, body: unknown, fetchedAt: string) => {
    const { out } = sanitizePayload(body, i.secrets);
    const req = sanitizePayload(request, i.secrets).out;
    assertNoSecrets(out, i.secrets, `research ${family}`);
    assertNoSecrets(req, i.secrets, `research ${family} request`);
    const text = canonicalJson(out);
    const [row] = await tx.insert(researchSourcePayloads).values({ run_id: runId, athlete_id: i.athleteId, provider, model: model ?? null, endpoint_family: family, request: req as any, payload: out as any, payload_hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), sanitizer_version: SANITIZER_VERSION, fetched_at: new Date(fetchedAt), retained_until: new Date(new Date(fetchedAt).getTime() + policy.rawRetentionDays * DAY) }).returning({ id: researchSourcePayloads.id });
    payloadIds.set(envelopeId, row.id); payloads++;
  };
  for (const e of i.search) { await store(e.id, e.provider, e.model, `search:${e.queryName}`, e.request, { answerText: e.answerText, chunks: e.chunks, supports: e.supports, raw: e.raw }, e.fetchedAt); for (const err of e.errors) subCalls.push({ step: `search:${e.queryName}:${err.step}`, message: redactMessage(err.message, i.secrets) }); }
  if (i.extraction) { await store(i.extraction.id, i.extraction.provider, i.extraction.model, "extraction", i.extraction.request, { claims: i.extraction.claims, inferences: i.extraction.inferences, raw: i.extraction.raw, parseError: i.extraction.parseError ?? null }, i.extraction.fetchedAt); for (const err of i.extraction.errors) subCalls.push({ step: `extraction:${err.step}`, message: redactMessage(err.message, i.secrets) }); if (i.extraction.parseError) subCalls.push({ step: "extraction:parse", message: redactMessage(i.extraction.parseError, i.secrets) }); }
  for (const e of i.signals) await store(e.id, e.provider, null, `signal:${e.provider}`, e.request, { values: e.values, items: e.items ?? [], raw: e.raw }, e.fetchedAt);

  // ── evidence ──
  const counts = { cited: 0, uncited: 0, conflicting: 0, suspect: 0, native_supported: 0, native_retrieved: 0, asserted_only: 0, unsupported_skipped: 0 } as { cited: number; uncited: number; conflicting: number; suspect: number; native_supported: number; native_retrieved: number; asserted_only: number; unsupported_skipped: number; source_read?: number };   // source_read appears only on a run that has one (v2 summaries unchanged)
  const candidates: Candidate[] = [];
  const evidenceIds: string[] = [];
  const claims: ExtractedClaim[] = i.extraction?.claims ?? [];
  // Step 2b (§3.1): which domains this run planned, and what it ACCEPTED per domain. Only accepted
  // evidence/facts (or an explicit none_found) make a domain fresh; "touched" never does.
  const planned = new Set<ResearchDomain>(i.plan?.acceptance ?? i.plan?.domains ?? RESEARCH_DOMAINS);
  // PR E2a: the domains that get an outcome on this row (default: today's `planned`).
  const settled = new Set<ResearchDomain>(i.plan?.settle ?? i.plan?.domains ?? RESEARCH_DOMAINS);
  const accepted: Record<string, DomainAcceptance> = {};
  const acc = (d: ResearchDomain): DomainAcceptance => (accepted[d] ??= { evidence: 0, factBearing: 0, facts: 0 });
  let droppedOutOfPlan = 0;
  // Registry v3 / item-mapping/4 binding targets (read before any write of this run): the athlete's CURRENT affiliation
  // facts, plus — for an education institution only — this run's own current-affiliation claims (Q1 states both).
  const existingRows = await tx.select().from(athleteFacts).where(and(eq(athleteFacts.athlete_id, i.athleteId), inArray(athleteFacts.status, ["current", "historical", "disputed"])));
  const currentAffiliations: CurrentAffiliation[] = existingRows.filter((r) => r.fact_key === "affiliation" && r.status === "current" && typeof (r.value as any)?.org === "string").map((r) => ({ id: r.id, value: r.value as CurrentAffiliation["value"], domains: ((r.provenance as any)?.domains ?? []) as string[] }));
  const chunkDomain = (id: string | undefined) => (id ? i.search.flatMap((e) => e.chunks).find((ch) => ch.id === id)?.domain : undefined);
  const runAffiliations: CurrentAffiliation[] = claims.flatMap((c, idx) => {
    const cl = c.claim as any;
    if (!(cl?.factKey === "affiliation" && cl.timeframe === "current" && typeof cl.value?.org === "string" && typeof cl.value?.orgKind === "string")) return [];
    const d = chunkDomain((c as { lineage?: DirectClaimLineage }).lineage?.boundChunkIds[0] ?? c.citation?.chunkIds?.[0]);
    return [{ id: `claim:${idx}`, value: cl.value, domains: d ? [d] : [] }];
  });
  for (const [idx, c] of claims.entries()) {
    if (!(EVIDENCE_KINDS_V2 as readonly string[]).includes(c.kind) || !c.claim || typeof c.claim !== "object") { subCalls.push({ step: `evidence:${idx}`, message: `unknown evidence kind ${String((c as any)?.kind)}` }); continue; }
    // Direct path (direct-evidence/2): the finding carries its provider-native lineage. `unsupported` (no source at all) is never stored.
    const native = (c as { lineage?: DirectClaimLineage }).lineage ?? null;
    if (native && native.level === "unsupported") { counts.unsupported_skipped++; subCalls.push({ step: `evidence:${idx}`, message: "unsupported finding (no source) not stored" }); continue; }
    // Sanitize the claim ONCE; assert it is clean; everything downstream (evidence row, dedupe key,
    // resolver candidate -> athlete_facts.value / value_text) uses only this sanitized copy.
    const claimClean = sanitizePayload(c.claim, i.secrets).out as Record<string, unknown>;
    assertNoSecrets(claimClean, i.secrets, `research claim ${idx}`);
    const factKey0 = typeof claimClean.factKey === "string" && isRegisteredKey(claimClean.factKey) ? claimClean.factKey : null;
    const claimDomain: ResearchDomain = factKey0 ? getFactDefinition(factKey0).domain : (domainOfEvidence(c.kind, claimClean) ?? "profile");
    if (i.plan && !planned.has(claimDomain)) { droppedOutOfPlan++; continue; }   // out of plan: dropped before any canonical write
    const citationClean = c.citation ? sanitizePayload(c.citation, i.secrets).out : null;
    const check = validateCitation(c.citation, i.search);
    const suspect = claimIsSuspect({ claim: claimClean, citation: citationClean });
    // Stored lineage: the native level when the finding carries one (the bound chunk is its authoritative source), else the citation check.
    const lineageStatus: LineageStatus = native ? native.level as LineageStatus : check.status;
    const boundChunk = native && native.boundChunkIds.length ? i.search.flatMap((e) => e.chunks).find((ch) => ch.id === native.boundChunkIds[0]) ?? null : null;
    const chunk = native ? (boundChunk ?? check.chunk) : check.chunk;
    if (chunk && !domainAllowed(chunk.domain, policy.domains)) { subCalls.push({ step: `evidence:${idx}`, message: `domain denied: ${chunk.domain}` }); continue; }
    // Outlet classification (resolveSourceType): a listed outlet domain keeps its class; on a platform host the model's outlet type
    // decides, else her own only when the URL's handle/channel matches a handle Nomila holds for her; an unlisted domain takes the model's.
    const sourceType = resolveSourceType(modelOutletType(c as { sources?: unknown }, claimClean, chunk?.domain ?? null), chunk?.domain ?? null, policy,
      { urls: [chunk?.url, typeof claimClean.url === "string" ? claimClean.url : null], names: [claimClean.outlet as string, claimClean.sourceOutlet as string], knownHandles: Object.values(i.hints?.knownHandles ?? {}) });
    const envelopeId = chunk ? chunk.id.split(":")[0] : (i.extraction?.id ?? "");
    const dedupe = `${c.kind}|${canonicalJson(claimClean)}|${chunk?.domain ?? ""}`;
    counts[lineageStatus] = (counts[lineageStatus] ?? 0) + 1; if (suspect) counts.suspect++;
    // Domain match (affiliationNamedIn step 1) only for an official team/school or governing-body source: a news domain
    // that corroborated an affiliation says nothing about which team other evidence on it concerns.
    const officialDomain = chunk && ROLE_SOURCE_TYPES.includes(sourceType) ? chunk.domain : null;
    // item-mapping/4: an education claim with no institution of its own takes the ONE current school affiliation this
    // finding is about (its official domain, else named in its statement or verbatim quote); none → left without, and
    // the registry refuses it. Recorded on the row.
    if (factKey0 === "education" && claimClean.institutionRef === INSTITUTION_REF && claimClean.value && typeof claimClean.value === "object" && !(claimClean.value as any).institution) {
      const text = [(c as any).statement, ...(((c as any).sources ?? []) as Array<{ quote?: string }>).map((x) => x.quote)].filter((x) => typeof x === "string").join(" | ");
      const named = affiliationNamedIn(text, [...currentAffiliations, ...runAffiliations], ["school"], officialDomain);
      if (named) { claimClean.value = { ...(claimClean.value as object), institution: named.value.org }; claimClean.institutionBinding = { affiliation: named.id.startsWith("claim:") ? "this_run" : named.id, org: named.value.org }; }
    }
    // item-mapping/4: a captaincy milestone from an official source (native_supported) about exactly one current
    // affiliation becomes that affiliation's role; otherwise it stays career_event evidence only.
    const role = claimClean.captaincy ? captaincyAffiliation(claimClean, lineageStatus, sourceType, currentAffiliations, officialDomain) : null;
    if (role) claimClean.roleBinding = { affiliationFactId: role.factId, org: role.org };
    // claim-canonicalization/2 before the strict registry (deterministic; every rule application recorded on the evidence row)
    let canonicalValue: unknown = claimClean.value;
    if (factKey0 && "value" in claimClean) { const canon = canonicalizeValue(factKey0, claimClean.value); canonicalValue = canon.value; if (canon.applied.length) claimClean.canonicalization = { version: canon.version, applied: canon.applied, raw: canon.raw }; }
    // `quoteKind` records what the quoted text IS: provider answer text attributed to the source
    // (Gemini grounding) or a source-page excerpt (a provider that returns page text). Never a
    // reconstructed source quotation.
    const support = citationClean ? { chunkIds: citationClean.chunkIds, supportIds: check.supports.map((s) => s.id), quote: citationClean.quote.slice(0, 300), quoteKind: check.quoteKind, sourceExcerpt: null, reason: check.reason, bindingMethod: native?.bindingMethod ?? null } : null;
    const [row] = await tx.insert(researchEvidence).values({
      athlete_id: i.athleteId, run_id: runId, payload_id: payloadIds.get(envelopeId) ?? payloadIds.get(i.extraction?.id ?? "") ?? null,
      kind: c.kind, claim: claimClean as any, support: support as any,
      lineage_status: lineageStatus, source_url: chunk?.url ?? null, source_domain: chunk?.domain ?? null, source_type: sourceType,
      published_at: c.publishedAt ? new Date(c.publishedAt) : null, retrieved_at: retrievedAt,
      extractor: i.extraction ? `${i.extraction.provider}@${i.extraction.model ?? "?"}` : null, extraction_schema_version: i.extraction?.schemaVersion ?? null,
      confidence: String(Math.max(0, Math.min(1, c.confidence ?? 0.5))), source_class: "web_researched", suspect, dedupe_key: createHash("sha1").update(dedupe).digest("hex").slice(0, 24),
    }).returning({ id: researchEvidence.id });
    evidenceIds.push(row.id);
    if (isCitedLineage(lineageStatus) && !suspect) { const a = acc(claimDomain); a.evidence++; if (factKey0) a.factBearing++; }
    const factKey = typeof claimClean.factKey === "string" ? claimClean.factKey : null;
    if (factKey && isRegisteredKey(factKey) && "value" in claimClean) {
      candidates.push({ factKey, value: canonicalValue, evidenceId: row.id, sourceClass: "web_researched", sourceType, sourceDomain: chunk?.domain ?? null, lineageStatus: resolverLineageOf(lineageStatus), suspect, confidence: c.confidence ?? 0.5, publishedAt: c.publishedAt ?? null, retrievedAt: retrievedAt.toISOString(), origin: i.trigger === "backfill" ? "backfill" : "research" });
    }
    if (role) candidates.push({ factKey: "affiliation", value: role.value, evidenceId: row.id, sourceClass: "web_researched", sourceType, sourceDomain: chunk?.domain ?? null, lineageStatus: resolverLineageOf(lineageStatus), suspect, confidence: c.confidence ?? 0.5, publishedAt: c.publishedAt ?? null, retrievedAt: retrievedAt.toISOString(), origin: i.trigger === "backfill" ? "backfill" : "research" });
  }
  for (const e of i.signals) {
    // Same invariant as extraction claims: the canonical signal claim is sanitized ONCE, asserted clean, and only that copy is persisted.
    const signalClaim = sanitizePayload({ provider: e.provider, values: e.values, windowDays: e.windowDays ?? null }, i.secrets).out as { provider: string; values: Record<string, number>; windowDays: number | null };
    assertNoSecrets(signalClaim, i.secrets, `research signal ${e.id}`);
    acc("signals").evidence++;
    await tx.insert(researchEvidence).values({ athlete_id: i.athleteId, run_id: runId, payload_id: payloadIds.get(e.id) ?? null, kind: "signal", claim: signalClaim as any, support: { chunkIds: [], supportIds: [], quote: "", quoteKind: "provider_record", sourceExcerpt: null, reason: "provider API record" } as any, lineage_status: "cited", source_url: null, source_domain: signalClaim.provider, source_type: "reference", retrieved_at: new Date(e.fetchedAt), extractor: null, confidence: "0.90", source_class: "web_researched", suspect: false, dedupe_key: createHash("sha1").update(`signal|${signalClaim.provider}|${e.fetchedAt}`).digest("hex").slice(0, 24) });
    counts.cited++;
  }

  // ── facts ──
  const resolved = resolveFacts(existingRows.map(toFactRow), candidates, i.assertions ?? [], { asOf: asOf.toISOString(), ttlDays: policy.ttlDays, minCorroboration: policy.minCorroboration, uncitedConfidenceCap: policy.uncitedConfidenceCap, hasAssertedAffiliations: i.hasAssertedAffiliations });
  let facts = 0, disputed = 0, refused = 0, proposals = 0;
  for (const d of resolved.decisions) {
    if (d.action === "refuse") { refused++; subCalls.push({ step: `resolve:${d.factKey}`, message: `refused: ${d.reason}` }); continue; }
    if (d.action === "propose") { proposals++; continue; }
    if (d.action === "noop") { if (d.reason === "already recorded") acc(getFactDefinition(d.factKey).domain).facts++; continue; }   // re-confirmed by new evidence
    const [row] = await tx.insert(athleteFacts).values(toInsert(i.athleteId, d.fact)).returning({ id: athleteFacts.id });
    facts++; if (d.fact.status === "disputed") disputed++;
    // Only an EVIDENCE-backed fact counts toward the domain outcome: the athlete's own assertion/proof is authority, not research acceptance.
    if (d.fact.status !== "disputed" && (d.fact.origin === "research" || d.fact.origin === "backfill")) acc(getFactDefinition(d.fact.factKey).domain).facts++;
    if (d.supersedes.length) await tx.update(athleteFacts).set({ status: "superseded", superseded_by: row.id }).where(and(eq(athleteFacts.athlete_id, i.athleteId), inArray(athleteFacts.id, d.supersedes)));
  }
  // Phase A Step 2d-6 (§3.5): rule-7 affiliation facts become found ledger rows, idempotently, then the projection follows the ledger.
  const affiliationSync = await syncAffiliationsFromFacts(i.athleteId, tx, asOf);

  // ── inferences ──
  let inferences = 0;
  for (const inf of i.extraction?.inferences ?? []) {
    if (inf.value == null || inf.value === "") continue;
    const check = validateCitation(inf.citation ?? null, i.search);
    // Same invariant: the inference value is sanitized ONCE, asserted clean, and only that copy is persisted.
    const valueClean = sanitizePayload(inf.value, i.secrets).out;
    assertNoSecrets(valueClean, i.secrets, `research inference ${inf.key}`);
    const prior = await tx.select({ id: athleteInferences.id }).from(athleteInferences).where(and(eq(athleteInferences.athlete_id, i.athleteId), eq(athleteInferences.inference_key, inf.key), isNull(athleteInferences.superseded_by)));
    const [row] = await tx.insert(athleteInferences).values({ athlete_id: i.athleteId, inference_key: inf.key, value: valueClean as any, taxonomy_version: null, producer: `${i.extraction!.provider}@${i.extraction!.model ?? "?"}`, lineage: { runId, evidenceIds, chunkIds: check.chunks.map((c) => c.id), lineageStatus: check.status, quoteKind: check.quoteKind }, confidence: null }).returning({ id: athleteInferences.id });
    if (prior.length) await tx.update(athleteInferences).set({ superseded_by: row.id }).where(inArray(athleteInferences.id, prior.map((p) => p.id)));
    inferences++;
    if (inf.key === "story_arc") acc("narrative").evidence++;
  }

  // ── domain outcomes (§3.1) ──
  const queryStatus = i.plan?.queryStatus ?? inferQueryStatus(i);
  const extractionFailed = !i.extraction || !!i.extraction.parseError || i.extraction.errors.length > 0;
  const outcomes: Partial<Record<ResearchDomain, DomainOutcome>> = {};
  const ownAccepted: Record<string, DomainAcceptance> = Object.fromEntries(Object.entries(accepted).map(([d, a]) => [d, { ...a }]));
  const withCarry = (d: ResearchDomain): DomainAcceptance => { const a = acc(d); const c = i.plan?.carryAccepted?.[d]; return c ? { evidence: a.evidence + c.evidence, factBearing: a.factBearing + c.factBearing, facts: a.facts + c.facts } : a; };
  for (const d of RESEARCH_DOMAINS) outcomes[d] = settled.has(d) ? domainOutcome(d, queryStatus[d], i.extraction?.domainOutcomes?.[d], withCarry(d), { extractionFailed, llmDomain: d !== "signals" }) : "not_planned";

  // ── state ──
  const state = await recomputeState(tx, i.athleteId, policy, asOf, { identityResolved: i.identityResolved ?? false, identityConfidence: i.identityConfidence, hints: hintsClean, runId, outcomes, retrievedAt, plan: i.plan, cost: runCost(i, policy) });
  const domains: Record<string, DomainSummary> = {};
  for (const d of RESEARCH_DOMAINS) if (outcomes[d] !== "not_planned") domains[d] = { outcome: outcomes[d]!, accepted: i.plan?.carryAccepted?.[d] ? withCarry(d) : acc(d), ...(state.freshnessSkipped[d] ? { freshnessSkipped: state.freshnessSkipped[d] } : {}) };
  if (i.__onBeforeCommit) await i.__onBeforeCommit();
  return { payloads, evidence: claims.length + i.signals.length, counts, facts, disputed, refused, proposals, inferences, researchStatus: state.status, subCalls, domains, droppedOutOfPlan, affiliationSync, accepted: ownAccepted };
}

/** A full run (no explicit plan): every domain is planned; a domain's queries "completed" when the run has grounded search results without provider errors. */
function inferQueryStatus(i: PersistInput): Partial<Record<ResearchDomain, DomainQueryStatus>> {
  const chunks = i.search.reduce((a, e) => a + e.chunks.length, 0);
  const searched = i.search.length > 0 && i.search.every((e) => e.errors.length === 0) && chunks > 0;
  const out: Partial<Record<ResearchDomain, DomainQueryStatus>> = {};
  for (const d of RESEARCH_DOMAINS) out[d] = d === "signals" ? { completed: i.signals.length > 0, chunksReviewed: i.signals.length } : d === "narrative" ? { completed: !!i.extraction, chunksReviewed: chunks } : { completed: searched, chunksReviewed: chunks };
  return out;
}

export function toFactRow(r: AthleteFactRow): FactRow {
  return { id: r.id, factKey: r.fact_key, value: r.value, valueText: r.value_text, status: r.status as FactRow["status"], origin: r.origin as FactRow["origin"], sourceClass: (r.source_class as FactRow["sourceClass"]) ?? null, authorityTier: r.authority_tier, confidence: Number(r.confidence), retrievedAt: r.retrieved_at.toISOString(), observedAt: r.observed_at?.toISOString() ?? null, validFrom: r.valid_from, validTo: r.valid_to, provenance: r.provenance as FactRow["provenance"] };
}
export function toInsert(athleteId: string, f: NewFact) {
  return { athlete_id: athleteId, fact_key: f.factKey, value: f.value as any, value_text: f.valueText, status: f.status, valid_from: f.validFrom, valid_to: f.validTo, observed_at: f.observedAt ? new Date(f.observedAt) : null, retrieved_at: new Date(f.retrievedAt), origin: f.origin, source_class: f.sourceClass, authority_tier: f.authorityTier, confidence: String(Math.round(f.confidence * 100) / 100), provenance: f.provenance as any, freshness_family: f.freshnessFamily, resolver_version: f.resolverVersion, registry_version: f.registryVersion };
}
const sumTokens = (i: PersistInput, k: "promptTokens" | "completionTokens" | "cachedTokens") => [...i.search, ...(i.extraction ? [i.extraction] : [])].reduce((a, e) => a + (e.usage?.[k] ?? 0), 0) || null;
/** Provisional run cost: a provider's own estimate when it gave one, else the cost model over the measured usage (design §5). */
const runCost = (i: PersistInput, policy: ResearchPolicy) => Math.round([...i.search, ...(i.extraction ? [i.extraction] : []), ...i.signals].reduce((a, e) => a + ((e as any).usage?.estimatedCostUsd ?? estimateCallUsd(e.provider, (e as any).usage, policy.costModel)), 0) * 10_000) / 10_000;
const avgConfidence = (claims: ExtractedClaim[]) => claims.length ? Math.round((claims.reduce((a, c) => a + (c.confidence ?? 0.5), 0) / claims.length) * 100) / 100 : 0;

/**
 * Recompute per-domain statuses from the stored facts/evidence and derive the research state (inside the
 * caller's transaction). Step 2b: a domain's freshness advances ONLY on a fresh outcome (§3.1) and only
 * monotonically in the run's retrievedAt (§3.2): an older run finishing later can never move
 * lastResearchedAt / staleAfter / lastRunId backwards. The state row is locked FOR UPDATE so two persists
 * for one athlete serialise. `pending` is never written here (the planner consumes it).
 */
export async function recomputeState(tx: DbClient, athleteId: string, policy: ResearchPolicy, asOf: Date, opts: { identityResolved: boolean; identityConfidence?: number; hints?: unknown; runId?: string | null; outcomes?: Partial<Record<ResearchDomain, DomainOutcome>>; retrievedAt?: Date; plan?: PersistInput["plan"]; cost?: number }) {
  const facts = await tx.select().from(athleteFacts).where(and(eq(athleteFacts.athlete_id, athleteId), inArray(athleteFacts.status, ["current", "historical", "disputed"])));
  const evidence = await tx.select({ kind: researchEvidence.kind, claim: researchEvidence.claim, lineage: researchEvidence.lineage_status, retrieved: researchEvidence.retrieved_at, suspect: researchEvidence.suspect }).from(researchEvidence).where(eq(researchEvidence.athlete_id, athleteId));
  const [prev] = await tx.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)).limit(1).for("update");
  const prevDomains = (prev?.domains ?? {}) as Record<string, { status?: string; lastRunId?: string | null; lastResearchedAt?: string | null; staleAfter?: string | null; outcome?: string; blockingDispute?: boolean }>;
  const ts = opts.retrievedAt ?? asOf;
  const domains: Record<string, { status: string; lastRunId: string | null; lastResearchedAt: string | null; staleAfter: string | null; outcome: string | null; blockingDispute: boolean }> = {};
  const statuses: Partial<Record<ResearchDomain, ReturnType<typeof domainStatus>>> = {};
  const blockingDisputes: ResearchDomain[] = [];
  const freshnessSkipped: Partial<Record<ResearchDomain, "older_than_current">> = {};
  let anyFresh = false;
  for (const d of RESEARCH_DOMAINS) {
    const dFacts = facts.filter((f) => isRegisteredKey(f.fact_key) && getFactDefinition(f.fact_key).domain === d);
    const dEvidence = evidence.filter((e) => !e.suspect && domainOfEvidence(e.kind, e.claim as Record<string, unknown>) === d);
    const prevD = prevDomains[d];
    const outcome = opts.outcomes?.[d] ?? "not_planned";
    const fresh = isFreshOutcome(outcome);
    const monotonicOk = !prevD?.lastResearchedAt || ts.getTime() >= new Date(prevD.lastResearchedAt).getTime();
    const advance = fresh && monotonicOk;
    if (fresh && !monotonicOk) freshnessSkipped[d] = "older_than_current";
    if (advance) anyFresh = true;
    // A domain's research date moves ONLY on a fresh outcome (never inferred from the presence of evidence — that was the Step 2a "touched" rule).
    const lastResearchedAt = advance ? ts.toISOString() : (prevD?.lastResearchedAt ?? null);
    const citedFacts = dFacts.filter((f) => f.status !== "disputed" && (f.authority_tier != null || f.origin === "athlete_asserted" || f.origin === "athlete_proof" || f.origin === "connection")).length;
    const citedEvidence = dEvidence.filter((e) => isCitedLineage(e.lineage)).length;
    const summary: DomainEvidenceSummary = {
      domain: d, lastResearchedAt, cited: citedFacts + (dFacts.length ? 0 : citedEvidence), uncited: dFacts.filter((f) => f.status === "disputed").length + dEvidence.filter((e) => e.lineage !== "cited").length,
      disputedBlocking: dFacts.some((f) => f.status === "disputed" && BLOCKING_KEYS.includes(f.fact_key)),
      disputedNonBlocking: dFacts.some((f) => f.status === "disputed" && !BLOCKING_KEYS.includes(f.fact_key)),
    };
    const st = domainStatus(summary, policy.ttlDays, asOf);
    statuses[d] = st;
    if (summary.disputedBlocking) blockingDisputes.push(d);
    const ttl = policy.ttlDays[DOMAIN_FRESHNESS[d]];
    domains[d] = { status: st, lastRunId: advance ? (opts.runId ?? null) : (prevD?.lastRunId ?? null), lastResearchedAt, staleAfter: ttl != null && lastResearchedAt ? new Date(new Date(lastResearchedAt).getTime() + ttl * DAY).toISOString() : null, outcome: outcome === "not_planned" ? (prevD?.outcome ?? null) : outcome, blockingDispute: summary.disputedBlocking };
  }
  // Failure back-off and dispute re-check bookkeeping (§7), planned domains only.
  const failures = { ...((prev?.refresh_failures ?? {}) as Record<string, { count: number; lastOutcome?: string; deferredUntil?: string | null; disputeRechecks?: number }>) };
  for (const d of RESEARCH_DOMAINS) {
    const outcome = opts.outcomes?.[d];
    if (!outcome || outcome === "not_planned") continue;
    const entry = failures[d] ?? { count: 0, disputeRechecks: 0 };
    if (opts.plan?.dueToDispute?.includes(d)) entry.disputeRechecks = (entry.disputeRechecks ?? 0) + 1;
    if (isFreshOutcome(outcome)) { entry.count = 0; entry.deferredUntil = null; entry.lastOutcome = outcome; }
    else {
      entry.count += 1; entry.lastOutcome = outcome;
      entry.deferredUntil = entry.count >= policy.planner.maxConsecutiveFailures ? new Date(ts.getTime() + policy.planner.failureDeferDays * DAY).toISOString() : null;
    }
    if (entry.count === 0 && !entry.disputeRechecks) delete failures[d]; else failures[d] = entry;
  }
  const derived = deriveResearchState({ identityResolved: opts.identityResolved || !!prev?.identity_resolved_at, domains: statuses, blockingDisputes });
  const nextDue = Object.values(domains).map((x) => x.staleAfter).filter((x): x is string => !!x).sort()[0] ?? null;
  const prevLast = prev?.last_researched_at ? prev.last_researched_at.getTime() : 0;
  const row = { research_status: derived.status, identity_confidence: String(opts.identityConfidence ?? (prev ? Number(prev.identity_confidence) : 0)), identity_resolved_at: opts.identityResolved ? (prev?.identity_resolved_at ?? asOf) : prev?.identity_resolved_at ?? null, domains: domains as any, disputed_domains: derived.disputedDomains as any, last_researched_at: anyFresh ? new Date(Math.max(prevLast, ts.getTime())) : (prev?.last_researched_at ?? null), next_due_at: nextDue ? new Date(nextDue) : null, total_cost_usd: String(Number(prev?.total_cost_usd ?? 0) + (opts.cost ?? 0)), search_hints: (opts.hints ?? prev?.search_hints ?? null) as any, refresh_failures: failures as any, updated_at: new Date() };
  await tx.insert(athleteResearchState).values({ athlete_id: athleteId, ...row }).onConflictDoUpdate({ target: athleteResearchState.athlete_id, set: row });
  return { ...derived, freshnessSkipped };
}
