/**
 * scripts/calibration/providerBenchmark.ts — research provider benchmark harness (DEV / calibration only).
 *
 * Runs ResearchSpec v1 (`research-spec/1`: six queries, nine sections, item-level outcomes) through two
 * search arms — Gemini Grounded (the substrate's adapter, gemini-3.5-flash on Vertex) and OpenAI web
 * search (gpt-5.4-mini, Responses API) — with the SAME identity anchor, the SAME request text, the SAME
 * as-of date and the SAME Kimi cited-claims/3 extraction (PARTITIONED per query since 13 Sep 2026), then
 * derives evidence (with claim-canonicalization/2 before the strict registry), facts and item coverage in
 * memory and writes one artifact per athlete per arm under calibration/runs/<as-of>/ (gitignored). It
 * writes NOTHING to any database and never touches Cloud Run. Beta.1 scoring columns stay null.
 *
 *   npx tsx --require dotenv/config server/scripts/calibration/providerBenchmark.ts                       # dry run: projection + request guard, no calls
 *   npx tsx --require dotenv/config server/scripts/calibration/providerBenchmark.ts --run --provider both [--athlete <key>]... [--as-of YYYY-MM-DD]
 *   npx tsx --require dotenv/config server/scripts/calibration/providerBenchmark.ts --reprocess --as-of YYYY-MM-DD [--athlete <key>]...
 *       reprocess = NO searches: every existing artifact is re-extracted (partitioned) from its saved envelopes byte-for-byte,
 *       then canonicalized, derived, minimized (minor policy) and rewritten with full provenance and attempt history.
 *
 * Stopping rule: a partition that fails (timeout/transport) at the 300 s v3 limit stops the pass.
 * Credentials: Gemini via Application Default Credentials (gcloud) on GCP_PROJECT_ID; OPENAI_API_KEY and
 * MOONSHOT/Vertex for Kimi from the local .env. The holdout guard (cohort.ts) refuses any athlete not in cohort.dev20.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groundedSearch, GEMINI_PROVIDER_ID, type GroundedSearchResult } from "../../lib/research/providers/geminiGrounded";
import { webSearch, OPENAI_PROVIDER_ID, OPENAI_RESEARCH_MODEL } from "../../lib/research/providers/openaiWebSearch";
import { extractPartitionedV3, KIMI_EXTRACT_V3_PROVIDER_ID, rebuildPartitionedExtraction, type ExtractionEnvelopeV3 } from "../../lib/research/providers/kimiExtractV3";
import { geminiDirect, GEMINI_DIRECT_PROVIDER_ID, type DirectCallResult , DirectContract } from "../../lib/research/providers/geminiDirect";
import { openaiDirect, OPENAI_DIRECT_PROVIDER_ID } from "../../lib/research/providers/openaiDirect";
import { DIRECT_EVIDENCE_VERSION, directDegenerate, directRequest, parseDirectEvidence, splitHybrid, type DirectClaim } from "../../services/intelligence/research/spec/directEvidenceV1";
import { DIRECT_EVIDENCE_V2_VERSION, directDegenerateV2, directRequestV2, itemsFor, type Finding } from "../../services/intelligence/research/spec/directEvidenceV2";
import { deriveCareerStatus, ITEM_MAPPING_VERSION, mapFindings, type MappedClaim } from "../../services/intelligence/research/spec/itemMapping";

import { bindGeminiClaim, matchOpenAIClaim, withLineage } from "../../services/intelligence/research/spec/directLineage";
import { collectResearchSecrets } from "../../lib/research/secrets";
import { GEMINI, KIMI } from "../../lib/models";
import { assertNoSecrets, sanitizePayload } from "../../services/intelligence/social/sanitize";
import { estimateCallUsd } from "../../services/intelligence/research/plans";
import { DEFAULT_RESEARCH_POLICY, type CostModel } from "../../services/intelligence/research/policy";
import type { IdentityHints, SearchEnvelope } from "../../services/intelligence/research/providers";
import { compileRequest, compileSystemInstruction, FORBIDDEN_IN_REQUESTS, QUERIES, RESEARCH_SPEC_VERSION, sectionsFor } from "../../services/intelligence/research/spec/researchSpecV1";
import { CANONICALIZATION_VERSION } from "../../services/intelligence/research/spec/canonicalize";
import { deriveArm } from "../../services/intelligence/research/benchmark/evidence";
import { armMetrics } from "../../services/intelligence/research/benchmark/compare";
import { establishesMinor, minimizeArmForMinor, MINOR_POLICY_VERSION } from "../../services/intelligence/research/benchmark/minorPolicy";
import { armStatus, attemptFrom, mergeReextraction, normalizeSavedArm } from "../../services/intelligence/research/benchmark/recovery";
import type { ArmMetrics, ArmRun, BenchmarkAthlete, DerivedArm } from "../../services/intelligence/research/benchmark/types";
import { loadCohort, loadGold, selectAthletes, RUNS_DIR } from "./cohort";

export const HARNESS_VERSION = "provider-benchmark/6";

/** Benchmark cost ESTIMATES (list prices read 12 Sep 2026; Vertex grounding per-call price assumed from the substrate's cost model). Reporting only. */
export const BENCHMARK_COST_MODEL: CostModel = {
  [GEMINI_PROVIDER_ID]: { perCallUsd: 0.035, perMTokInUsd: 1.5, perMTokOutUsd: 9.0 },
  [OPENAI_PROVIDER_ID]: { perCallUsd: 0.01, perMTokInUsd: 0.75, perMTokOutUsd: 4.5 },
  [GEMINI_DIRECT_PROVIDER_ID]: { perCallUsd: 0.035, perMTokInUsd: 1.5, perMTokOutUsd: 9.0 },
  [OPENAI_DIRECT_PROVIDER_ID]: { perCallUsd: 0.01, perMTokInUsd: 0.75, perMTokOutUsd: 4.5 },
  [KIMI_EXTRACT_V3_PROVIDER_ID]: { perMTokInUsd: 0.6, perMTokOutUsd: 2.5 },
};
/** Token assumptions for the DRY-RUN projection only (per call). Actuals come from provider usage. */
const PROJECTION = { searchIn: 900, searchOut: 3000, openaiSearchContentIn: 8000, extractIn: 7000, extractOut: 2500 };

type ArmId = "gemini" | "openai";
const ARM_PROVIDER: Record<ArmId, string> = { gemini: GEMINI_PROVIDER_ID, openai: OPENAI_PROVIDER_ID };
const PROVIDER_ARM: Record<string, ArmId> = { [GEMINI_PROVIDER_ID]: "gemini", [OPENAI_PROVIDER_ID]: "openai" };
const ARM_MODEL: Record<ArmId, string> = { gemini: GEMINI.flash, openai: OPENAI_RESEARCH_MODEL };
const retryMax = DEFAULT_RESEARCH_POLICY.planner.geminiRetryMax;

function args() {
  const a = process.argv.slice(2);
  const get = (flag: string) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; };
  const all = (flag: string) => a.flatMap((x, i) => (x === flag && a[i + 1] ? [a[i + 1]] : []));
  const provider = (get("--provider") ?? "both") as ArmId | "both";
  if (!["gemini", "openai", "both"].includes(provider)) throw new Error(`--provider must be gemini|openai|both`);
  const contract = (get("--contract") ?? "v2") as DirectContract;
  if (!["v1", "v2"].includes(contract)) throw new Error("--contract must be v1|v2");
  return { contract, run: a.includes("--run"), reprocess: a.includes("--reprocess"), rederive: a.includes("--rederive"), direct: a.includes("--direct"), showRequests: a.includes("--show-requests"), arms: (provider === "both" ? ["gemini", "openai"] : [provider]) as ArmId[], keys: all("--athlete"), asOf: get("--as-of") ?? new Date().toISOString().slice(0, 10), out: get("--out") ?? RUNS_DIR };
}

export function hintsFor(a: BenchmarkAthlete): IdentityHints {
  return { athleteId: `benchmark:${a.key}`, fullName: a.fullName, aliases: a.aliases ?? [], sport: a.sport, currentAffiliation: a.currentAffiliation ?? null, hometown: a.hometown ?? null, knownHandles: {} };
}

/** Guard: nothing in a request may name the score, the cohort or a calibration label (§4.3). */
export function assertRequestClean(text: string): void {
  for (const re of FORBIDDEN_IN_REQUESTS) if (re.test(text)) throw new Error(`request text contains forbidden content matching ${re}`);
}

function projection(athletes: BenchmarkAthlete[], arms: ArmId[]) {
  const q = QUERIES.length;
  const rows = arms.map((arm) => {
    const p = ARM_PROVIDER[arm];
    const searchUsd = estimateCallUsd(p, { calls: 1, promptTokens: PROJECTION.searchIn + (arm === "openai" ? PROJECTION.openaiSearchContentIn : 0), completionTokens: PROJECTION.searchOut }, BENCHMARK_COST_MODEL);
    const extractUsd = q * estimateCallUsd(KIMI_EXTRACT_V3_PROVIDER_ID, { calls: 1, promptTokens: PROJECTION.extractIn, completionTokens: PROJECTION.extractOut }, BENCHMARK_COST_MODEL);
    const perAthlete = q * searchUsd + extractUsd;
    return { arm, provider: p, model: ARM_MODEL[arm], searchCalls: q * athletes.length, maxRetries: q * retryMax * athletes.length, extractCalls: q * athletes.length, usdPerAthlete: Math.round(perAthlete * 1000) / 1000, usdTotal: Math.round(perAthlete * athletes.length * 100) / 100, usdWorstCase: Math.round((perAthlete + q * retryMax * searchUsd) * athletes.length * 100) / 100 };
  });
  return { athletes: athletes.length, queries: QUERIES.map((x) => x.id), retryMax, extractor: `${KIMI_EXTRACT_V3_PROVIDER_ID}@${KIMI.vertexModel} (partitioned, ${q} calls per arm)`, arms: rows, usdTotal: Math.round(rows.reduce((s, r) => s + r.usdTotal, 0) * 100) / 100, usdWorstCase: Math.round(rows.reduce((s, r) => s + r.usdWorstCase, 0) * 100) / 100 };
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

// ── Path B: one direct research call per query; the provider returns direct-evidence/1; no Kimi ──
const DIRECT_PROVIDER: Record<ArmId, string> = { gemini: GEMINI_DIRECT_PROVIDER_ID, openai: OPENAI_DIRECT_PROVIDER_ID };

async function runDirectArm(a: BenchmarkAthlete, arm: ArmId, asOf: string, contract: DirectContract = "v2"): Promise<ArmRun> {
  const provider = DIRECT_PROVIDER[arm];
  const v2 = contract === "v2";
  const findingsAll: Finding[] = [];
  const startedAt = new Date().toISOString();
  const cap = QUERIES.length * (1 + retryMax);
  let attempts = 0;
  const reserve = async () => attempts++ < cap;
  const sections = sectionsFor(!!a.isMinor);
  const search: SearchEnvelope[] = [];
  const queries: ArmRun["queries"] = [];
  const claims: DirectClaim[] = [];
  const sectionOutcomes: NonNullable<ArmRun["extraction"]>["sectionOutcomes"] = {};
  const partitions: NonNullable<NonNullable<ArmRun["extraction"]>["partitions"]> = [];
  const identityByQuery: Record<string, { anchorMatch: string | null; confidence: number | null; namesakes: number }> = {};
  const rawByQuery: Record<string, unknown> = {};
  for (const [idx, q] of QUERIES.entries()) {
    const qSections = sections.filter((s) => q.sections.includes(s.id));
    const specReq = compileRequest({ fullName: a.fullName, sport: a.sport, anchor: a.anchor, isMinor: !!a.isMinor }, q, asOf);
    const subject = { fullName: a.fullName, sport: a.sport, anchor: a.anchor, isMinor: !!a.isMinor };
    const request = v2 ? directRequestV2(subject, q, sections, asOf) : directRequest(specReq, q, sections);
    assertRequestClean(request);
    const opts = { envelopeId: `${arm[0]}d${idx}`, queryName: q.name, sections: qSections, retryMax, reserve, contract, query: q };
    const r: DirectCallResult = arm === "gemini" ? await geminiDirect(request, opts) : await openaiDirect(request, opts);
    search.push(r.envelope);
    queries.push({ id: q.id, name: q.name, sections: q.sections, query: request, attempts: r.attempts, completed: r.completed, refused: r.refused, chunks: r.envelope.chunks.length, latencyMs: r.envelope.usage?.latencyMs ?? null });
    const deg = v2 ? (r.parsedV2 ? directDegenerateV2(r.parsedV2, r.nativeSources, itemsFor(q, sections).length) : { degenerate: false, reason: null }) : (r.parsed ? directDegenerate(r.parsed, r.nativeSources, qSections) : { degenerate: false, reason: null });
    const status = !r.completed ? "failed" : deg.degenerate ? "degenerate" : "ok";
    let qClaims = 0;
    if (!v2 && r.parsed && status === "ok") { for (const c of r.parsed.claims) claims.push({ ...c, section: c.section ?? qSections[0]?.id ?? null }); for (const [sid, o] of Object.entries(r.parsed.sectionOutcomes)) if (!(sid in sectionOutcomes)) (sectionOutcomes as any)[sid] = o; qClaims = r.parsed.claims.length; }
    if (v2 && r.parsedV2 && status === "ok") {
      // item-mapping/1: findings → claims for the unchanged downstream derivation; item statuses → section outcomes per item id
      const findings = Object.values(r.parsedV2.items).flatMap((it) => it?.findings ?? []);
      findingsAll.push(...findings);
      const mapped: MappedClaim[] = mapFindings(findings);
      for (const m of mapped) claims.push({ ...(m as unknown as DirectClaim), kind: m.kind as DirectClaim["kind"], claim: { ...m.claim, item: m.item, registryStatus: m.registryStatus, mappingVersion: m.mappingVersion, ...(m.unmappedFields.length ? { unmappedFields: m.unmappedFields } : {}) } });
      qClaims = mapped.length;
      for (const sct of qSections) {
        const items: Record<string, "found_cited" | "not_found" | "conflicting" | "not_applicable"> = {};
        for (const it of sct.items) { const st = r.parsedV2.items[it.id]?.status; if (st) items[it.id] = st === "found" ? "found_cited" : st; }
        const vals = Object.values(items);
        if (vals.length) (sectionOutcomes as any)[sct.id] = { status: vals.includes("conflicting") ? "conflicting" : vals.includes("found_cited") ? "found_cited" : vals.every((x) => x === "not_applicable") ? "not_applicable" : "not_found", items, reviewedChunkIds: [], conflicts: [], reason: null };
      }
    }
    const ident = v2 ? r.parsedV2?.identity : r.parsed?.identity;
    if (ident) identityByQuery[q.id] = { anchorMatch: ident.anchorMatch, confidence: ident.confidence, namesakes: ident.namesakes.length };
    rawByQuery[q.id] = (r.envelope.raw as any)?.text ?? null;
    const lineages = v2 ? (r.parsedV2 ? Object.values(r.parsedV2.items).flatMap((it) => it?.findings.map((f) => f.lineage.level) ?? []) : []) : (r.parsed?.claims.map((c) => c.lineage.level) ?? []);
    const lv = lineages.reduce<Record<string, number>>((m, l) => { m[l] = (m[l] ?? 0) + 1; return m; }, {});
    partitions.push({ queryId: q.id, queryName: q.name, sections: qSections.map((s) => s.id), envelopeIds: [r.envelope.id], chunks: r.envelope.chunks.length, status, reason: deg.reason ?? (r.completed ? null : "no parsable direct-evidence response"), latencyMs: r.envelope.usage?.latencyMs ?? null, promptTokens: r.envelope.usage?.promptTokens ?? null, completionTokens: r.envelope.usage?.completionTokens ?? null, claims: qClaims, raw: typeof (r.envelope.raw as any)?.text === "string" ? (r.envelope.raw as any).text : null, error: r.completed ? null : r.envelope.errors.map((e) => e.message).join("; ") });
    console.log(`  ${provider} ${q.id}: ${status} attempts=${r.attempts} sources=${r.nativeSources} searches=${r.searchQueries} claims=${qClaims} lineage=${JSON.stringify(lv)} ${((r.envelope.usage?.latencyMs ?? 0) / 1000).toFixed(1)}s${deg.reason ? ` (${deg.reason.slice(0, 70)})` : ""}`);
  }
  const failed = partitions.filter((p) => p.status === "failed"), degenerate = partitions.filter((p) => p.status === "degenerate"), okParts = partitions.filter((p) => p.status === "ok");
  const at = new Date().toISOString();
  const extraction: NonNullable<ArmRun["extraction"]> = {
    id: "d0", provider, model: search[0]?.model, schemaVersion: v2 ? DIRECT_EVIDENCE_V2_VERSION : DIRECT_EVIDENCE_VERSION, extractionMode: "provider_direct", fetchedAt: at,
    claims, inferences: [], sectionOutcomes, partitions, identityByQuery,
    degenerate: degenerate.length && !failed.length && (okParts.length === 0 || (degenerate.length >= okParts.length && claims.length === 0)) ? { degenerate: true, reason: degenerate.map((p) => `${p.queryId}: ${p.reason}`).join("; ") } : { degenerate: false, reason: degenerate.length ? `partitions degenerate (sections unknown): ${degenerate.map((p) => `${p.queryId}: ${p.reason}`).join("; ")}` : null },
    raw: { byQuery: rawByQuery, aboutIdentityConfidence: identityByQuery.Q1?.confidence ?? null, identityByQuery, ...(v2 ? { itemMapping: ITEM_MAPPING_VERSION, careerStatusDerived: deriveCareerStatus(findingsAll) } : {}) },
    request: { path: arm === "gemini" ? "generateContent" : "responses.create", params: { mode: "provider_direct", contract: v2 ? DIRECT_EVIDENCE_V2_VERSION : DIRECT_EVIDENCE_VERSION, queries: QUERIES.map((q) => q.id) } },
    errors: failed.map((p) => ({ step: `direct:${p.queryId}`, message: p.error ?? "failed", class: "transient" })),
    parseError: null,
    usage: { promptTokens: search.reduce((s, e) => s + (e.usage?.promptTokens ?? 0), 0), completionTokens: search.reduce((s, e) => s + (e.usage?.completionTokens ?? 0), 0), calls: 0, latencyMs: 0 },
  };
  const sum = (f: (u: NonNullable<SearchEnvelope["usage"]>) => number | undefined) => search.reduce((s, e) => s + (e.usage ? f(e.usage) ?? 0 : 0), 0);
  const providerUsd = search.reduce((s, e) => s + estimateCallUsd(provider, e.usage, BENCHMARK_COST_MODEL), 0);
  const run: ArmRun = {
    athleteKey: a.key, provider, path: "direct", model: search[0]?.model ?? null, extractor: `${provider} (direct-evidence/1, no Kimi)`, specVersion: RESEARCH_SPEC_VERSION, asOf, startedAt, finishedAt: at,
    queries, search, extraction, extractionHistory: [attemptFrom(extraction, at, "direct", { search })], extractionRetried: false,
    usage: { searchCalls: sum((u) => u.calls), extractCalls: 0, promptTokens: sum((u) => u.promptTokens), completionTokens: sum((u) => u.completionTokens), cachedTokens: sum((u) => u.cachedTokens), latencyMs: sum((u) => u.latencyMs) },
    estimatedCostUsd: { search: r4(providerUsd), extract: 0, total: r4(providerUsd), complete: !search.some((e) => e.usage?.usageIncomplete) },
    minorRedacted: false,
  };
  run.status = armStatus(run, !!a.isMinor);
  return run;
}

/** Re-derive a SAVED direct arm from its stored per-query raw responses and native metadata — deterministic, no call. */
export function rebuildDirectArm(saved: ArmRun, isMinor: boolean): ArmRun {
  const x = saved.extraction;
  if (!x || x.extractionMode !== "provider_direct" || !x.partitions) return saved;
  const sections = sectionsFor(isMinor);
  const claims: DirectClaim[] = [];
  const sectionOutcomes: NonNullable<ArmRun["extraction"]>["sectionOutcomes"] = {};
  const identityByQuery: Record<string, { anchorMatch: string | null; confidence: number | null; namesakes: number }> = {};
  const partitions = x.partitions.map((p) => {
    const env = saved.search.find((e) => p.envelopeIds.includes(e.id));
    if (!env || p.raw == null || p.status === "failed") return p;
    const qSections = sections.filter((s) => p.sections.includes(s.id));
    // Native metadata is rebuilt from the ENVELOPE structures (kept, and minimized in step with the text under the minor policy),
    // never from `raw`, which the minor policy nulls: Gemini supports/chunks and the (minimized) prose; OpenAI retrieved sources.
    const isGemini = saved.provider === GEMINI_DIRECT_PROVIDER_ID;
    const split = isGemini ? { ...splitHybrid(p.raw), prose: env.answerText } : { prose: "", jsonText: p.raw, markerFound: false };
    const parsed = parseDirectEvidence(split.jsonText, qSections);
    const chunkIndex = new Map(env.chunks.map((c, i) => [c.id, i]));
    const supports = env.supports.map((sp) => ({ segment: { startIndex: sp.start, endIndex: sp.end, text: sp.text }, groundingChunkIndices: sp.chunkIds.map((id) => chunkIndex.get(id)).filter((i): i is number => i != null), confidenceScores: sp.confidence != null ? [sp.confidence] : [] }));
    const gChunks = env.chunks.map((c) => ({ web: { uri: c.url ?? "", title: c.title ?? undefined, domain: c.domain ?? undefined } }));
    const bound = parsed.claims.map((c) => withLineage(c, isGemini ? bindGeminiClaim(c.sources[0]?.quote ?? "", split.prose, supports, gChunks, env.id) : matchOpenAIClaim(c.sources, env.chunks.map((ch) => ({ url: ch.url ?? "", title: ch.title })), env.id)));
    const deg = directDegenerate(parsed, env.chunks.length, qSections);
    const status: "ok" | "degenerate" = deg.degenerate ? "degenerate" : "ok";
    if (status === "ok") { for (const c of bound) claims.push({ ...c, section: c.section ?? qSections[0]?.id ?? null }); for (const [sid, o] of Object.entries(parsed.sectionOutcomes)) if (!(sid in sectionOutcomes)) (sectionOutcomes as any)[sid] = o; }
    identityByQuery[p.queryId] = { anchorMatch: parsed.identity.anchorMatch, confidence: parsed.identity.confidence, namesakes: parsed.identity.namesakes.length };
    return { ...p, status, reason: deg.reason, claims: parsed.claims.length };
  });
  const failed = partitions.filter((p) => p.status === "failed"), degenerate = partitions.filter((p) => p.status === "degenerate"), okParts = partitions.filter((p) => p.status === "ok");
  const extraction: NonNullable<ArmRun["extraction"]> = { ...x, claims, sectionOutcomes, partitions, identityByQuery, degenerate: degenerate.length && !failed.length && (okParts.length === 0 || (degenerate.length >= okParts.length && claims.length === 0)) ? { degenerate: true, reason: degenerate.map((p) => `${p.queryId}: ${p.reason}`).join("; ") } : { degenerate: false, reason: degenerate.length ? `partitions degenerate (sections unknown): ${degenerate.map((p) => `${p.queryId}: ${p.reason}`).join("; ")}` : null }, raw: { ...(x.raw as object ?? {}), aboutIdentityConfidence: identityByQuery.Q1?.confidence ?? null, identityByQuery } };
  const run: ArmRun = { ...saved, extraction };
  run.status = armStatus(run, isMinor);
  return run;
}

async function runDirect(o: { arms: ArmId[]; keys: string[]; asOf: string; out: string; showRequests: boolean; run: boolean; rederive: boolean; contract: DirectContract }) {
  const cohort = loadCohort();
  const gold = loadGold();
  const athletes = selectAthletes(cohort, o.keys);
  const q = QUERIES.length;
  const build = (a: BenchmarkAthlete, qq: typeof QUERIES[number]) => { const r = compileRequest({ fullName: a.fullName, sport: a.sport, anchor: a.anchor, isMinor: !!a.isMinor }, qq, o.asOf); return o.contract === "v2" ? directRequestV2({ fullName: a.fullName, sport: a.sport, anchor: a.anchor, isMinor: !!a.isMinor }, qq, sectionsFor(!!a.isMinor), o.asOf) : directRequest(r, qq, sectionsFor(!!a.isMinor)); };
  console.log(`${RESEARCH_SPEC_VERSION} · ${o.contract === "v2" ? DIRECT_EVIDENCE_V2_VERSION + " · " + ITEM_MAPPING_VERSION : DIRECT_EVIDENCE_VERSION} · ${CANONICALIZATION_VERSION} · cohort ${cohort.version}: ${athletes.length} athletes × ${o.arms.length} direct arm(s); ${q} calls per arm (+ up to ${q * retryMax} retries), no Kimi`);
  for (const a of athletes) for (const qq of QUERIES) assertRequestClean(build(a, qq));
  console.log(`  request guard: ${athletes.length * q} direct request texts contain no score, cohort or calibration words`);
  if (o.showRequests) for (const a of athletes) for (const qq of QUERIES) console.log(`--- ${a.key} ${qq.id}\n${build(a, qq)}`);
  const secrets = collectResearchSecrets();
  const dir = join(o.out, o.contract === "v2" ? `${o.asOf}-direct-v2` : `${o.asOf}-direct`);
  mkdirSync(dir, { recursive: true });
  for (const a of athletes) {
    console.log(`\n${a.fullName} [${a.group}${a.isMinor ? ", MINOR (cohort)" : ""}] anchor="${a.anchor}"`);
    const produced: ArmRun[] = [];
    for (const arm of o.arms) {
      const file = join(dir, a.key, `${DIRECT_PROVIDER[arm]}.json`);
      if (existsSync(file)) {
        if (o.rederive) { const saved = normalizeSavedArm((JSON.parse(readFileSync(file, "utf8")) as { arm: ArmRun }).arm, !!a.isMinor); const rebuilt = rebuildDirectArm(saved, !!a.isMinor); console.log(`  ${DIRECT_PROVIDER[arm]}: re-derived from saved direct responses (no calls): ${(rebuilt.extraction?.partitions ?? []).map((p) => `${p.queryId}:${p.status}`).join(" ")}`); produced.push(rebuilt); continue; }
        console.log(`  ${DIRECT_PROVIDER[arm]}: artifact exists, skipping`); continue;
      }
      if (o.rederive) { console.log(`  ${DIRECT_PROVIDER[arm]}: no saved artifact, skipping (rederive never calls)`); continue; }
      if (!o.run) { console.log(`  ${DIRECT_PROVIDER[arm]}: dry run — add --run to make the direct calls`); continue; }
      const fresh = await runDirectArm(a, arm, o.asOf, o.contract);
      // crash safety: the paid responses are persisted BEFORE derivation; a derivation error leaves this raw artifact for --rederive
      mkdirSync(join(dir, a.key), { recursive: true });
      writeFileSync(file, JSON.stringify(sanitizePayload({ harnessVersion: HARNESS_VERSION, specVersion: RESEARCH_SPEC_VERSION, canonicalization: CANONICALIZATION_VERSION, minorPolicy: null, provenance: { search: "direct provider research (this run; RAW — derivation pending)" }, athlete: { key: a.key, group: a.group, isMinor: !!a.isMinor }, arm: fresh, derived: null, metrics: null }, secrets).out, null, 2));
      produced.push(fresh);
    }
    if (!produced.length) continue;
    const derivedByProvider = new Map(produced.map((p) => [p.provider, deriveArm(p, DEFAULT_RESEARCH_POLICY, !!a.isMinor, "retrieved")]));
    const established = [...derivedByProvider.entries()].map(([prov, d]) => ({ prov, ...establishesMinor(d.evidence, o.asOf) })).find((x) => x.minor);
    const minorTrigger: "cohort_flag" | "cited_birth_year" | null = a.isMinor ? "cohort_flag" : established ? "cited_birth_year" : null;
    if (minorTrigger === "cited_birth_year") console.log(`  minor policy activated: cited birth year ${established!.birthYear} in ${established!.prov} (${established!.evidenceId}) establishes under 18 at ${o.asOf}`);
    for (const armRun of produced) {
      const derivedFull = derivedByProvider.get(armRun.provider)!;
      const metrics = armMetrics(armRun, derivedFull, gold.get(a.key) ?? null, minorTrigger ? { policy: MINOR_POLICY_VERSION, trigger: minorTrigger, birthYear: established?.birthYear ?? null } : null, (acc) => deriveArm(armRun, DEFAULT_RESEARCH_POLICY, !!a.isMinor, acc));
      let toStore = { arm: armRun, derived: derivedFull };
      let minorInfo: Parameters<typeof writeArtifact>[5] = null;
      if (minorTrigger) { const m = minimizeArmForMinor(armRun, derivedFull); toStore = { arm: m.arm, derived: m.derived }; minorInfo = { policy: MINOR_POLICY_VERSION, trigger: minorTrigger, birthYear: established?.birthYear ?? null, report: m.report }; }
      const file = writeArtifact(dir, a, toStore.arm, toStore.derived, metrics, minorInfo, secrets, "direct provider research (this run; provider returned direct-evidence/1; native lineage validated deterministically)");
      const pv = metrics.provenance!;
      console.log(`  ${armRun.provider}: status=${metrics.status} claims=${metrics.evidence.claims} provenance s/r/a/u=${pv.native_supported}/${pv.native_retrieved}/${pv.asserted_only}/${pv.unsupported} items(strict/retrieved)=${metrics.policies.strict.itemsFound}/${metrics.policies.retrieved.itemsFound} facts(strict/retrieved)=${metrics.policies.strict.factsAccepted}/${metrics.policies.retrieved.factsAccepted} registry a/c/r=${metrics.registry.accepted}/${metrics.registry.acceptedCanonicalized}/${metrics.registry.refused} identity=${metrics.directIdentity?.anchorMatch ?? "—"}/${metrics.directIdentity?.confidence ?? "—"} cost=$${metrics.costUsd} lat=${Math.round(metrics.latencyMs / 1000)}s${minorInfo ? ` minor:${minorInfo.trigger}` : ""} → ${file}`);
    }
  }
  console.log(`
done. Build the four-path comparison with: npx tsx server/scripts/calibration/providerBenchmarkReport.ts --as-of <A as-of> --direct-as-of ${o.asOf}`);
}
const extractUsdOf = (x: { usage?: { promptTokens?: number; completionTokens?: number; calls?: number } }) => estimateCallUsd(KIMI_EXTRACT_V3_PROVIDER_ID, { calls: x.usage?.calls ?? 1, promptTokens: x.usage?.promptTokens ?? 0, completionTokens: x.usage?.completionTokens ?? 0 }, BENCHMARK_COST_MODEL);
const logPartition = (provider: string) => (r: { queryId: string; status: string; claims: number; latencyMs: number | null; chunks: number; reason: string | null }) => console.log(`    ${provider} ${r.queryId}: ${r.status} claims=${r.claims} chunks=${r.chunks} ${r.latencyMs == null ? "" : `${(r.latencyMs / 1000).toFixed(1)}s`}${r.reason ? ` (${r.reason.slice(0, 80)})` : ""}`);

/** Fresh searches + partitioned extraction. */
async function runArm(a: BenchmarkAthlete, arm: ArmId, asOf: string): Promise<ArmRun> {
  const provider = ARM_PROVIDER[arm];
  const startedAt = new Date().toISOString();
  const cap = QUERIES.length * (1 + retryMax) + QUERIES.length;   // every query with all retries + one extraction per partition
  let attempts = 0;
  const reserve = async () => attempts++ < cap;
  const hints = hintsFor(a);
  const sections = sectionsFor(!!a.isMinor);
  const systemInstruction = compileSystemInstruction(arm);
  const search: SearchEnvelope[] = [];
  const queries: ArmRun["queries"] = [];
  for (const [idx, q] of QUERIES.entries()) {
    const query = compileRequest({ fullName: a.fullName, sport: a.sport, anchor: a.anchor, isMinor: !!a.isMinor }, q, asOf);
    assertRequestClean(query);
    const opts = { envelopeId: `${arm[0]}${idx}`, queryName: q.name, retryMax, reserve, systemInstruction };
    const r: GroundedSearchResult = arm === "gemini" ? await groundedSearch(query, opts) : await webSearch(query, opts);
    search.push(r.envelope);
    queries.push({ id: q.id, name: q.name, sections: q.sections, query, attempts: r.attempts, completed: r.completed, refused: r.refused, chunks: r.envelope.chunks.length, latencyMs: r.envelope.usage?.latencyMs ?? null });
    console.log(`  ${provider} ${q.id} ${q.name}: attempts=${r.attempts} completed=${r.completed} chunks=${r.envelope.chunks.length} ${((r.envelope.usage?.latencyMs ?? 0) / 1000).toFixed(1)}s`);
  }
  const extraction = await extractPartitionedV3(search, hints, "x0", sections, { reserve, onPartition: logPartition(provider) });
  const at = new Date().toISOString();
  const history = [attemptFrom(extraction, at, "partitioned", { search })];
  const sum = (f: (u: NonNullable<SearchEnvelope["usage"]>) => number | undefined) => search.reduce((s, e) => s + (e.usage ? f(e.usage) ?? 0 : 0), 0);
  const searchUsd = search.reduce((s, e) => s + estimateCallUsd(provider, e.usage, BENCHMARK_COST_MODEL), 0);
  const extractUsd = extractUsdOf(extraction);
  const run: ArmRun = {
    athleteKey: a.key, provider, model: ARM_MODEL[arm], extractor: `${extraction.provider}@${extraction.model ?? "?"}`, specVersion: RESEARCH_SPEC_VERSION, asOf, startedAt, finishedAt: at,
    queries, search, extraction, extractionHistory: history, extractionRetried: false,
    usage: { searchCalls: sum((u) => u.calls), extractCalls: extraction.usage?.calls ?? 0, promptTokens: sum((u) => u.promptTokens) + (extraction.usage?.promptTokens ?? 0), completionTokens: sum((u) => u.completionTokens) + (extraction.usage?.completionTokens ?? 0), cachedTokens: sum((u) => u.cachedTokens), latencyMs: sum((u) => u.latencyMs) + (extraction.usage?.latencyMs ?? 0) },
    estimatedCostUsd: { search: r4(searchUsd), extract: r4(extractUsd), total: r4(searchUsd + extractUsd), complete: !search.some((e) => e.usage?.usageIncomplete) && !extraction.usage?.usageIncomplete },
    minorRedacted: false,
  };
  run.status = armStatus(run, !!a.isMinor);
  return run;
}

/** Re-extraction (partitioned) of a saved arm from its own envelopes: no search is made or changed. */
async function reprocessArm(a: BenchmarkAthlete, saved: ArmRun): Promise<ArmRun> {
  const provider = saved.provider;
  console.log(`  ${provider}: partitioned re-extraction from ${saved.search.length} saved envelopes (${saved.search.reduce((n, e) => n + e.chunks.length, 0)} chunks); prior attempts ${saved.extractionHistory?.length ?? 1} (${(saved.extractionHistory ?? []).map((h) => `${h.mode}:${h.outcome}`).join(", ") || "single"})`);
  const at = new Date().toISOString();
  const extraction = await extractPartitionedV3(saved.search, hintsFor(a), "x0", sectionsFor(!!a.isMinor), { onPartition: logPartition(provider) });
  return mergeReextraction(saved, extraction, at, extractUsdOf(extraction), "partitioned", !!a.isMinor);
}

interface Artifact { harnessVersion: string; specVersion: string; canonicalization: string; minorPolicy: string | null; provenance: Record<string, unknown>; athlete: { key: string; group: string; isMinor: boolean }; arm: ArmRun; derived: DerivedArm; metrics: ArmMetrics }

function writeArtifact(dir: string, a: BenchmarkAthlete, armRun: ArmRun, derived: DerivedArm, metrics: ArmMetrics, minor: { policy: string; trigger: "cohort_flag" | "cited_birth_year"; birthYear: number | null; report: unknown } | null, secrets: string[], searchProvenance: string): string {
  const file = join(dir, a.key, `${armRun.provider}.json`);
  const artifact: Artifact = {
    harnessVersion: HARNESS_VERSION, specVersion: RESEARCH_SPEC_VERSION, canonicalization: CANONICALIZATION_VERSION, minorPolicy: minor?.policy ?? null,
    provenance: { search: searchProvenance, searchTimestamps: armRun.search.map((e) => e.fetchedAt), extraction: armRun.extraction?.extractionMode ?? "single", extractionAttempts: (armRun.extractionHistory ?? []).map((h) => ({ at: h.at, mode: h.mode, outcome: h.outcome })), canonicalizationRulesApplied: derived.registry.rulesApplied, minor: minor ? { trigger: minor.trigger, birthYear: minor.birthYear, report: minor.report } : null },
    athlete: { key: a.key, group: a.group, isMinor: !!a.isMinor }, arm: armRun, derived, metrics,
  };
  const clean = sanitizePayload(artifact, secrets).out;
  assertNoSecrets(clean, secrets, `benchmark artifact ${a.key}/${armRun.provider}`);
  mkdirSync(join(dir, a.key), { recursive: true });
  writeFileSync(file, JSON.stringify(clean, null, 2));
  return file;
}

async function main() {
  const { run, reprocess, rederive, direct, showRequests, arms, keys, asOf, out, contract } = args();
  if (direct) return runDirect({ arms, keys, asOf, out, showRequests, run, rederive, contract });
  const cohort = loadCohort();
  const gold = loadGold();
  const athletes = selectAthletes(cohort, keys);
  const proj = projection(athletes, arms);
  console.log(`${RESEARCH_SPEC_VERSION} · ${CANONICALIZATION_VERSION} · cohort ${cohort.version}: ${athletes.length} athletes × ${arms.length} arm(s); queries=${proj.queries.join(",")} retryMax=${retryMax}; extractor ${proj.extractor}`);
  for (const r of proj.arms) console.log(`  ${r.provider} (${r.model}): search calls ${r.searchCalls} (+ up to ${r.maxRetries} retries), extraction calls ${r.extractCalls}, ≈$${r.usdPerAthlete}/athlete, ≈$${r.usdTotal} total (worst case with all retries $${r.usdWorstCase})`);
  console.log(`  projected total ≈$${proj.usdTotal} (worst case $${proj.usdWorstCase}); Beta.1 columns: blocked (no parameter bundle)`);
  for (const a of athletes) for (const q of QUERIES) assertRequestClean(compileRequest({ fullName: a.fullName, sport: a.sport, anchor: a.anchor, isMinor: !!a.isMinor }, q, asOf));
  console.log(`  request guard: ${athletes.length * QUERIES.length} request texts contain no score, cohort or calibration words`);
  if (showRequests) for (const a of athletes) { console.log(`\n===== ${a.key}${a.isMinor ? " (MINOR)" : ""}`); for (const q of QUERIES) console.log(`--- ${q.id}\n${compileRequest({ fullName: a.fullName, sport: a.sport, anchor: a.anchor, isMinor: !!a.isMinor }, q, asOf)}`); }
  if (!run && !reprocess && !rederive) { console.log("dry run — no provider calls made. Add --run (searches + extraction), --reprocess (extraction only, from saved envelopes) or --rederive (no calls: re-parse saved partition outputs with the current merge/canonicalization rules)."); return; }
  if ([run, reprocess, rederive].filter(Boolean).length > 1) throw new Error("--run, --reprocess and --rederive are exclusive");

  const secrets = collectResearchSecrets();
  const dir = join(out, asOf);
  mkdirSync(dir, { recursive: true });
  let stop = false;
  for (const a of athletes) {
    if (stop) break;
    console.log(`\n${a.fullName} [${a.group}${a.isMinor ? ", MINOR (cohort)" : ""}] anchor="${a.anchor}"`);
    // Every arm of the athlete is produced first, so the minor policy (cohort flag OR cited birth year from ANY arm) applies to all of them.
    const produced: { armRun: ArmRun; searchProvenance: string }[] = [];
    for (const arm of arms) {
      const file = join(dir, a.key, `${ARM_PROVIDER[arm]}.json`);
      const exists = existsSync(file);
      if (rederive) {
        if (!exists) { console.log(`  ${ARM_PROVIDER[arm]}: no saved artifact, skipping`); continue; }
        const saved = normalizeSavedArm((JSON.parse(readFileSync(file, "utf8")) as { arm: ArmRun }).arm, !!a.isMinor);
        if (saved.extraction?.extractionMode !== "partitioned") { console.log(`  ${ARM_PROVIDER[arm]}: extraction is not partitioned; nothing to re-derive`); continue; }
        const rebuilt = rebuildPartitionedExtraction(saved.extraction as ExtractionEnvelopeV3, saved.search, sectionsFor(!!a.isMinor));
        const armRun: ArmRun = { ...saved, extraction: rebuilt };
        armRun.status = armStatus(armRun, !!a.isMinor);
        // the last history entry describes the same partitioned attempt; refresh its outcome under the current rules
        const hist = [...(saved.extractionHistory ?? [])];
        if (hist.length) hist[hist.length - 1] = { ...attemptFrom(rebuilt, hist[hist.length - 1].at, "partitioned", armRun), at: hist[hist.length - 1].at };
        armRun.extractionHistory = hist;
        console.log(`  ${ARM_PROVIDER[arm]}: re-derived from saved partition outputs (no calls): ${rebuilt.partitions!.map((p) => `${p.queryId}:${p.status}`).join(" ")}`);
        produced.push({ armRun, searchProvenance: "original provider search (saved envelopes reused byte-for-byte); extraction re-derived from saved partition outputs" });
        continue;
      }
      if (reprocess) {
        if (!exists) { console.log(`  ${ARM_PROVIDER[arm]}: no saved artifact — reprocess never searches, skipping`); continue; }
        const saved = normalizeSavedArm((JSON.parse(readFileSync(file, "utf8")) as { arm: ArmRun }).arm, !!a.isMinor);
        if (saved.minorRedacted && !saved.search.some((e) => e.chunks.some((c) => c.text.trim()))) { console.log(`  ${ARM_PROVIDER[arm]}: saved evidence text was stripped by minor-evidence-policy/1; cannot re-extract`); continue; }
        if (saved.status === "search_failed") { console.log(`  ${ARM_PROVIDER[arm]}: search_failed — needs a full rerun (not done here)`); continue; }
        produced.push({ armRun: await reprocessArm(a, saved), searchProvenance: "original provider search (saved envelopes reused byte-for-byte)" });
      } else {
        if (exists) {
          const saved = normalizeSavedArm((JSON.parse(readFileSync(file, "utf8")) as { arm: ArmRun }).arm, !!a.isMinor);
          if (saved.status === "complete") { console.log(`  ${ARM_PROVIDER[arm]}: artifact complete, skipping`); continue; }
          if (saved.status === "search_failed") { console.log(`  ${ARM_PROVIDER[arm]}: search_failed — delete the artifact for a full rerun`); continue; }
          produced.push({ armRun: await reprocessArm(a, saved), searchProvenance: "original provider search (saved envelopes reused byte-for-byte)" });
        } else {
          produced.push({ armRun: await runArm(a, arm, asOf), searchProvenance: "original provider search (this run)" });
        }
      }
    }
    if (!produced.length) continue;
    // derive (full evidence), decide minor status, minimize, compute metrics, write
    const derivedByProvider = new Map(produced.map((p) => [p.armRun.provider, deriveArm(p.armRun, DEFAULT_RESEARCH_POLICY, !!a.isMinor)]));
    const established = [...derivedByProvider.entries()].map(([prov, d]) => ({ prov, ...establishesMinor(d.evidence, asOf) })).find((x) => x.minor);
    const minorTrigger: "cohort_flag" | "cited_birth_year" | null = a.isMinor ? "cohort_flag" : established ? "cited_birth_year" : null;
    if (minorTrigger === "cited_birth_year") console.log(`  minor policy activated: cited birth year ${established!.birthYear} in ${established!.prov} (${established!.evidenceId}) establishes under 18 at ${asOf}`);
    for (const { armRun, searchProvenance } of produced) {
      const derivedFull = derivedByProvider.get(armRun.provider)!;
      const metrics = armMetrics(armRun, derivedFull, gold.get(a.key) ?? null, minorTrigger ? { policy: MINOR_POLICY_VERSION, trigger: minorTrigger, birthYear: established?.birthYear ?? null } : null);
      let toStore = { arm: armRun, derived: derivedFull };
      let minorInfo: Parameters<typeof writeArtifact>[5] = null;
      if (minorTrigger) { const m = minimizeArmForMinor(armRun, derivedFull); toStore = { arm: m.arm, derived: m.derived }; minorInfo = { policy: MINOR_POLICY_VERSION, trigger: minorTrigger, birthYear: established?.birthYear ?? null, report: m.report }; }
      const file = writeArtifact(dir, a, toStore.arm, toStore.derived, metrics, minorInfo, secrets, searchProvenance);
      console.log(`  ${armRun.provider}: status=${metrics.status}${metrics.statusReason ? ` (${metrics.statusReason.slice(0, 70)})` : ""} claims=${metrics.evidence.claims} cited=${metrics.evidence.cited} items=${metrics.coverage.itemsFound}/${metrics.coverage.itemsRequested} registry a/c/r=${metrics.registry.accepted}/${metrics.registry.acceptedCanonicalized}/${metrics.registry.refused} facts=${metrics.facts.count} identity=${metrics.identity.aboutIdentityConfidence ?? "—"} abstained=${metrics.identity.abstention.abstained} cost=${metrics.costComplete ? "" : "≥"}$${metrics.costUsd}${minorInfo ? ` minor:${minorInfo.trigger} redactions=${(minorInfo.report as any).textRedactions}` : ""} → ${file}`);
      if (armRun.status === "extraction_failed") { console.error(`STOP: a partition failed at the 300 s v3 limit for ${a.key}/${armRun.provider}. Stopping rule: no further timeout changes, no evidence changes, until a decision.`); stop = true; }
    }
  }
  if (stop) process.exit(3);
  console.log(`\ndone. Build the comparison with: npx tsx server/scripts/calibration/providerBenchmarkReport.ts --as-of ${asOf}`);
}

if (require.main === module) main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
