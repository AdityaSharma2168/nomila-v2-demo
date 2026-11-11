/**
 * research/reprocessKnowledge.ts — GENERIC DETERMINISTIC REPROCESSING of already-stored research (Concept 0.4 PR 4).
 *
 * The question it answers, for one athlete: "what canonical facts do TODAY's rules support from the evidence Nomila
 * already holds?" — after an item-mapping / registry / resolver change (e.g. registry v3 education, affiliation role,
 * national-team year), without asking any provider anything.
 *
 *   inputs   research_source_payloads (the provider's stored, sanitized answer) + research_evidence (the rows each
 *            finding became) + athlete_facts + her assertions — all already in Postgres
 *   A  re-map  every stored direct-evidence/2 search payload (gemini_direct, hybrid prose + JSON) is re-parsed and its
 *            findings re-bound and re-mapped with TODAY's parser / binder / item mapping (parseDirectEvidenceV2 →
 *            bindGeminiFinding → mapFindings), exactly as the live path does. Each mapped claim is tied back to the
 *            ORIGINAL evidence row of the same finding (same run, same item, same quoted text); a claim with no such row
 *            was never acquired and is refused — this module never writes evidence.
 *   B  re-read  every other stored evidence row that carries a registry key keeps its stored claim (the payload is gone
 *            or is not a re-parseable contract) and goes through today's registry only.
 *   then     the same derivation persist uses: education institution binding + captaincy role (item-mapping/4,
 *            persist.ts) → claim-canonicalization → strict registry → resolveFacts (rules 1–7, athlete authority first).
 *
 * Guarantees:
 *   - NO provider call, no `lib/models` import, no new evidence: research_evidence / research_source_payloads are read only.
 *   - Original evidence rows are untouched. A fact it creates cites them (provenance.evidenceIds = the ORIGINAL ids) and
 *     carries the ORIGINAL retrieved_at / observed_at (the resolver's normal fields from the evidence row) — never "now" —
 *     plus `provenance.reprocessed = { at, version, registryVersion, resolverVersion, mappingVersion }`, so it never
 *     looks newly acquired.
 *   - Idempotent: a candidate whose key + value is already recorded from the SAME evidence row (any status, the value's
 *     fields all present) is `unchanged`; a second run therefore creates nothing. Existing facts are left alone, or
 *     superseded only by the resolver's own rules (a better tier, a stated role carried, an older team ending).
 *   - Athlete authority outranks: her assertions are passed to the resolver (rule 2) and, with said/proof teams,
 *     research only proposes (rule 7). The resolver's assertion inserts are NOT written here (her record path owns them).
 *   - Dry run writes nothing and reports the same plan.
 *   - Generic: nothing names an athlete, sport, school or league.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../db";
import { athleteAffiliations, athleteFacts, athletes, researchEvidence, researchSourcePayloads, type AthleteFactRow } from "../../../../shared/schema";
import { assertionsFor } from "./researchInputs";
import { getResearchPolicy, researchSubstrateWriteEnabled, type ResearchPolicy } from "./config";
import { FACT_REGISTRY_VERSION, isRegisteredKey, validateFactValue, valueTextFor } from "./factRegistry";
import { recomputeState, toFactRow, toInsert } from "./persist";
import { syncAffiliationsFromFacts } from "./affiliationSync";
import { resolveFacts, RESOLVER_VERSION, type Assertion, type Candidate, type FactRow, type NewFact } from "./resolve";
import { resolverLineageOf, type LineageStatus, type SourceType } from "./registries";
import { canonicalizeValue } from "./spec/canonicalize";
import { splitHybrid } from "./spec/directEvidenceV1";
import { parseDirectEvidenceV2 } from "./spec/directEvidenceV2";
import { bindGeminiFinding, type GroundingChunkLike, type GroundingSupportLike } from "./spec/directLineage";
import { affiliationNamedIn, captaincyAffiliation, INSTITUTION_REF, ITEM_MAPPING_VERSION, mapFindings, ROLE_SOURCE_TYPES, type CurrentAffiliation, type MappedClaim } from "./spec/itemMapping";
import { QUERIES, sectionsFor } from "./spec/researchSpecV1";
import { canonicalJson } from "../params";

export const REPROCESS_KNOWLEDGE_VERSION = "knowledge-reprocess/1";

// ── inputs (rows as stored) ──────────────────────────────────────────────────

export interface StoredPayload { id: string; runId: string; provider: string; endpointFamily: string; request: unknown; payload: unknown }
export interface StoredEvidence {
  id: string; runId: string | null; kind: string; claim: Record<string, unknown>; support: Record<string, unknown> | null;
  lineage: string; sourceType: string; sourceDomain: string | null; sourceClass: string; suspect: boolean; supersededBy: string | null;
  confidence: number; publishedAt: string | null; retrievedAt: string;
}
export interface PlanInput {
  payloads: StoredPayload[];
  evidence: StoredEvidence[];
  /** Every athlete_facts row of the athlete (all statuses — superseded rows prove "already derived from this evidence"). */
  facts: FactRow[];
  assertions: Assertion[];
  hasAssertedAffiliations: boolean;
  policy: Pick<ResearchPolicy, "ttlDays" | "minCorroboration" | "uncitedConfidenceCap">;
  /** The resolver's clock (class-year validity, TTL); never a fact's retrieved_at. */
  asOf: Date;
}

export interface ReprocessCreated { factKey: string; valueText: string; status: string; evidenceIds: string[]; retrievedAt: string; supersedes: string[] }
export interface ReprocessReport {
  athleteId: string;
  version: typeof REPROCESS_KNOWLEDGE_VERSION;
  dryRun: boolean;
  wrote: boolean;
  at: string;
  versions: { registry: string; resolver: string; mapping: string };
  payloads: { examined: number; remapped: number; skipped: Array<{ payloadId: string; reason: string }> };
  /** Fact-bearing claims examined (re-mapped findings + stored claims), and how they ended. */
  counts: { examined: number; created: number; unchanged: number; refused: number; proposed: number };
  created: ReprocessCreated[];
  refused: Array<{ factKey: string; evidenceId: string | null; reason: string }>;
  proposed: Array<{ factKey: string; evidenceIds: string[]; reason: string }>;
}

export interface ReprocessPlan {
  inserts: Array<{ fact: NewFact; supersedes: string[] }>;
  report: Omit<ReprocessReport, "athleteId" | "dryRun" | "wrote" | "at">;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const quoteOf = (support: Record<string, unknown> | null): string => (typeof support?.quote === "string" ? support.quote : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The chunk-id prefix the stored envelope's own chunks use ("d0:c3" → "d0"), so re-bound chunk ids match the stored ones. */
function envelopePrefix(chunks: unknown[], fallback: string): string {
  for (const c of chunks) { const id = isObj(c) ? c.id : null; if (typeof id === "string" && id.includes(":")) return id.split(":")[0]; }
  return fallback;
}

/** Every field of `want` equals the same field of `have` (structural); `primary` is bookkeeping, not meaning. */
function covers(have: unknown, want: unknown): boolean {
  if (!isObj(have) || !isObj(want)) return canonicalJson(have) === canonicalJson(want);
  return Object.entries(want).every(([k, v]) => k === "primary" || v == null || canonicalJson(have[k]) === canonicalJson(v));
}

/**
 * Re-parse one stored direct-evidence/2 search payload with TODAY's parser, binder and item mapping. Pure: the stored
 * raw answer + grounding are the only input. Returns null with a reason when the payload is not that contract.
 */
export function remapPayload(p: StoredPayload): { claims: MappedClaim[]; chunkDomain: (id: string | undefined) => string | null } | { skip: string } {
  if (!p.endpointFamily.startsWith("search:")) return { skip: `not a search payload (${p.endpointFamily})` };
  const req = isObj(p.request) ? p.request : {};
  const params = isObj(req.params) ? req.params : {};
  if (p.provider !== "gemini_direct" || params.contract !== "v2") return { skip: "not a direct-evidence/2 payload (only that contract is re-parsed; its stored evidence is re-read)" };
  const body = isObj(p.payload) ? p.payload : {};
  const raw = isObj(body.raw) ? body.raw : {};
  if (typeof raw.text !== "string" || !raw.text.trim()) return { skip: "stored answer text is gone (retention) — its stored evidence is re-read" };
  const query = QUERIES.find((q) => q.name === p.endpointFamily.slice("search:".length));
  if (!query) return { skip: `unknown query "${p.endpointFamily.slice(7)}"` };
  const split = splitHybrid(raw.text);
  if (!split.markerFound) return { skip: "no hybrid marker in the stored answer" };
  const parsed = parseDirectEvidenceV2(split.jsonText, query, sectionsFor(false));
  if (parsed.parseError) return { skip: `stored answer does not parse: ${parsed.parseError.slice(0, 120)}` };
  const chunks = Array.isArray(body.chunks) ? body.chunks : [];
  const prefix = envelopePrefix(chunks, "d0");
  const supports = (Array.isArray(raw.groundingSupports) ? raw.groundingSupports : []) as GroundingSupportLike[];
  const gchunks = (Array.isArray(raw.groundingChunks) ? raw.groundingChunks : []) as GroundingChunkLike[];
  const findings = Object.values(parsed.items).flatMap((it) => it?.findings ?? [])
    .map((f) => ({ ...f, lineage: bindGeminiFinding({ quote: f.sources[0]?.quote, statement: f.statement }, split.prose, supports, gchunks, prefix) }));
  const domains = new Map<string, string | null>();
  for (const c of chunks) if (isObj(c) && typeof c.id === "string") domains.set(c.id, typeof c.domain === "string" ? c.domain : null);
  return { claims: mapFindings(findings), chunkDomain: (id) => (id ? domains.get(id) ?? null : null) };
}

/**
 * The ORIGINAL evidence row a re-mapped claim came from: same run, same item (v3 rows record it), same quoted text.
 * Several rows of one finding (a years[] split, an `also` key) → the one stored under the same key, else the first.
 */
function originalRow(c: MappedClaim, runRows: StoredEvidence[]): StoredEvidence | null {
  const quote = (c.citation?.quote ?? "").slice(0, 300);
  if (!quote) return null;
  const same = runRows.filter((r) => quoteOf(r.support) === quote && (typeof r.claim.item === "string" ? r.claim.item === c.item : r.kind === c.kind));
  if (!same.length) return null;
  const key = isObj(c.claim) ? c.claim.factKey : undefined;
  return same.find((r) => r.claim.factKey === key) ?? same[0];
}

// ── the plan (pure) ──────────────────────────────────────────────────────────

export function planKnowledgeReprocess(i: PlanInput): ReprocessPlan {
  const refused: ReprocessReport["refused"] = [];
  const proposed: ReprocessReport["proposed"] = [];
  const skipped: ReprocessReport["payloads"]["skipped"] = [];
  let examined = 0, unchanged = 0, remapped = 0;

  const live = i.facts.filter((f) => f.status === "current" || f.status === "historical" || f.status === "disputed");
  const currentAffiliations: CurrentAffiliation[] = live.filter((r) => r.factKey === "affiliation" && r.status === "current" && typeof r.value?.org === "string")
    .map((r) => ({ id: r.id, value: r.value, domains: r.provenance?.domains ?? [] }));
  const usable = (r: StoredEvidence) => !r.suspect && !r.supersededBy;
  const candidates: Candidate[] = [];
  const covered = new Set<string>();   // evidence rows whose finding was re-mapped (B skips them)

  const candidateFrom = (claim: Record<string, unknown>, row: StoredEvidence, officialDomain: string | null, runAffiliations: CurrentAffiliation[], text: string) => {
    const factKey0 = typeof claim.factKey === "string" && isRegisteredKey(claim.factKey) ? claim.factKey : null;
    const lineage = row.lineage as LineageStatus;
    // item-mapping/4 (as persist): an education claim with no institution takes the ONE current school this finding names.
    if (factKey0 === "education" && claim.institutionRef === INSTITUTION_REF && isObj(claim.value) && !claim.value.institution) {
      const named = affiliationNamedIn(text, [...currentAffiliations, ...runAffiliations], ["school"], officialDomain);
      if (named) claim = { ...claim, value: { ...claim.value, institution: named.value.org } };
    }
    // item-mapping/4 (as persist): an official, native_supported captaincy about exactly one current affiliation → its role.
    const role = claim.captaincy ? captaincyAffiliation(claim, lineage, row.sourceType, currentAffiliations, officialDomain) : null;
    const base = { evidenceId: row.id, sourceClass: row.sourceClass, sourceType: row.sourceType as SourceType, sourceDomain: row.sourceDomain, lineageStatus: resolverLineageOf(lineage), suspect: row.suspect, confidence: row.confidence, publishedAt: row.publishedAt, retrievedAt: row.retrievedAt, origin: "research" as const };
    const out: Candidate[] = [];
    if (factKey0 && "value" in claim) out.push({ ...base, factKey: factKey0, value: canonicalizeValue(factKey0, claim.value).value });
    if (role) out.push({ ...base, factKey: "affiliation", value: role.value });
    return out;
  };

  // ── A: re-map stored direct-evidence/2 payloads with today's mapping ──
  const byRun = new Map<string, StoredEvidence[]>();
  for (const r of i.evidence) if (r.runId) (byRun.get(r.runId) ?? byRun.set(r.runId, []).get(r.runId)!).push(r);
  for (const p of i.payloads) {
    const m = remapPayload(p);
    if ("skip" in m) { skipped.push({ payloadId: p.id, reason: m.skip }); continue; }
    remapped++;
    const runRows = byRun.get(p.runId) ?? [];
    const runAffiliations: CurrentAffiliation[] = m.claims.flatMap((c, idx) => {
      const cl = c.claim as any;
      if (!(cl?.factKey === "affiliation" && cl.timeframe === "current" && typeof cl.value?.org === "string" && typeof cl.value?.orgKind === "string")) return [];
      const d = m.chunkDomain(c.lineage.boundChunkIds[0]);
      return [{ id: `claim:${idx}`, value: cl.value, domains: d ? [d] : [] }];
    });
    for (const c of m.claims) {
      const claim = isObj(c.claim) ? c.claim : {};
      const factBearing = (typeof claim.factKey === "string" && isRegisteredKey(claim.factKey)) || !!claim.captaincy;
      const row = originalRow(c, runRows);
      if (row) covered.add(row.id);
      if (!factBearing) continue;
      examined++;
      if (!row) { refused.push({ factKey: String(claim.factKey ?? "affiliation"), evidenceId: null, reason: "no stored evidence row for this finding (it was never acquired); nothing is created from it" }); continue; }
      if (!usable(row)) { refused.push({ factKey: String(claim.factKey ?? "affiliation"), evidenceId: row.id, reason: row.suspect ? "suspect evidence" : "superseded evidence" }); continue; }
      const officialDomain = row.sourceDomain && ROLE_SOURCE_TYPES.includes(row.sourceType) ? row.sourceDomain : null;
      const text = [c.statement, ...c.sources.map((s) => s.quote)].filter((x): x is string => typeof x === "string").join(" | ");
      candidates.push(...candidateFrom({ ...claim }, row, officialDomain, runAffiliations, text));
    }
  }

  // ── B: every other stored evidence row with a registry key keeps its stored claim (today's registry only) ──
  for (const row of i.evidence) {
    if (covered.has(row.id)) continue;
    const claim = row.claim;
    const factBearing = (typeof claim.factKey === "string" && isRegisteredKey(claim.factKey) && "value" in claim) || !!claim.captaincy;
    if (!factBearing) continue;
    examined++;
    if (!usable(row)) { refused.push({ factKey: String(claim.factKey ?? "affiliation"), evidenceId: row.id, reason: row.suspect ? "suspect evidence" : "superseded evidence" }); continue; }
    const officialDomain = row.sourceDomain && ROLE_SOURCE_TYPES.includes(row.sourceType) ? row.sourceDomain : null;
    candidates.push(...candidateFrom({ ...claim }, row, officialDomain, [], quoteOf(row.support)));
  }

  // ── unchanged: already derived from the same evidence row (any status), or already the live value ──
  const seen = new Set<string>();
  const fresh: Candidate[] = [];
  for (const c of candidates) {
    let value: unknown, valueText: string;
    try { value = validateFactValue(c.factKey, c.value); valueText = valueTextFor(c.factKey, value); }
    catch { fresh.push(c); continue; }   // the resolver refuses it with the registry's own reason
    const k = `${c.factKey}|${valueText}|${c.evidenceId}|${canonicalJson(value)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const done = i.facts.some((f) => f.factKey === c.factKey && f.valueText === valueText && covers(f.value, value)
      && ((f.provenance?.evidenceIds ?? []).includes(c.evidenceId) || f.status === "current" || f.status === "historical" || f.status === "disputed"));
    if (done) { unchanged++; continue; }
    fresh.push({ ...c, value });
  }

  // ── today's resolver, athlete authority first ──
  const resolved = resolveFacts(live, fresh, i.assertions, { asOf: i.asOf.toISOString(), ttlDays: i.policy.ttlDays, minCorroboration: i.policy.minCorroboration, uncitedConfidenceCap: i.policy.uncitedConfidenceCap, hasAssertedAffiliations: i.hasAssertedAffiliations });
  const inserts: ReprocessPlan["inserts"] = [];
  for (const d of resolved.decisions) {
    if (d.action === "refuse") { refused.push({ factKey: d.factKey, evidenceId: d.evidenceId, reason: d.reason }); continue; }
    if (d.action === "propose") { proposed.push({ factKey: d.factKey, evidenceIds: d.evidenceIds, reason: d.reason }); continue; }
    if (d.action === "noop") { if (d.evidenceIds.length) unchanged++; continue; }
    // Her assertions are written by her record path, never by a research reprocess.
    if (d.fact.origin === "athlete_asserted" || d.fact.origin === "athlete_proof") continue;
    inserts.push({ fact: d.fact, supersedes: d.supersedes });
  }
  return {
    inserts,
    report: {
      version: REPROCESS_KNOWLEDGE_VERSION,
      versions: { registry: FACT_REGISTRY_VERSION, resolver: RESOLVER_VERSION, mapping: ITEM_MAPPING_VERSION },
      payloads: { examined: i.payloads.length, remapped, skipped },
      counts: { examined, created: inserts.length, unchanged, refused: refused.length, proposed: proposed.length },
      created: inserts.map((x) => ({ factKey: x.fact.factKey, valueText: x.fact.valueText, status: x.fact.status, evidenceIds: x.fact.provenance.evidenceIds, retrievedAt: x.fact.retrievedAt, supersedes: x.supersedes })),
      refused, proposed,
    },
  };
}

/** The provenance marker every reprocessed fact carries (so it never reads as newly acquired). */
export function markReprocessed(f: NewFact, at: Date): NewFact {
  return { ...f, provenance: { ...f.provenance, reprocessed: { at: at.toISOString(), version: REPROCESS_KNOWLEDGE_VERSION, registryVersion: FACT_REGISTRY_VERSION, resolverVersion: RESOLVER_VERSION, mappingVersion: ITEM_MAPPING_VERSION } } as NewFact["provenance"] };
}

// ── the run (reads Postgres; writes only athlete_facts + the derived ledger/state, in one transaction) ──

export class ReprocessDisabledError extends Error {}

export async function reprocessKnowledge(athleteId: string, opts: { dryRun?: boolean; asOf?: Date } = {}): Promise<ReprocessReport | null> {
  const dryRun = opts.dryRun ?? false;
  const at = opts.asOf ?? new Date();
  const [a] = await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!a) return null;
  if (!dryRun && !researchSubstrateWriteEnabled()) throw new ReprocessDisabledError("RESEARCH_SUBSTRATE_WRITE is not \"true\": only a dry run is possible");

  const [policy, payloadRows, evidenceRows, factRows, assertions, saidTeams] = await Promise.all([
    getResearchPolicy(),
    db.select({ id: researchSourcePayloads.id, runId: researchSourcePayloads.run_id, provider: researchSourcePayloads.provider, family: researchSourcePayloads.endpoint_family, request: researchSourcePayloads.request, payload: researchSourcePayloads.payload })
      .from(researchSourcePayloads).where(eq(researchSourcePayloads.athlete_id, athleteId)),
    db.select().from(researchEvidence).where(eq(researchEvidence.athlete_id, athleteId)),
    db.select().from(athleteFacts).where(eq(athleteFacts.athlete_id, athleteId)),
    assertionsFor(athleteId),
    db.select({ id: athleteAffiliations.id }).from(athleteAffiliations).where(and(eq(athleteAffiliations.athlete_id, athleteId), inArray(athleteAffiliations.kind, ["said", "proof"]))).limit(1),
  ]);
  const plan = planKnowledgeReprocess({
    payloads: payloadRows.filter((p) => p.family.startsWith("search:")).map((p) => ({ id: p.id, runId: p.runId, provider: p.provider, endpointFamily: p.family, request: p.request, payload: p.payload })),
    evidence: evidenceRows.map((r) => ({
      id: r.id, runId: r.run_id, kind: r.kind, claim: (r.claim ?? {}) as Record<string, unknown>, support: (r.support ?? null) as Record<string, unknown> | null,
      lineage: r.lineage_status, sourceType: r.source_type, sourceDomain: r.source_domain, sourceClass: r.source_class, suspect: r.suspect, supersededBy: r.superseded_by,
      confidence: Number(r.confidence ?? 0.5), publishedAt: r.published_at?.toISOString() ?? null, retrievedAt: r.retrieved_at.toISOString(),
    })),
    facts: factRows.map((r: AthleteFactRow) => toFactRow(r)),
    assertions, hasAssertedAffiliations: saidTeams.length > 0, policy, asOf: at,
  });

  const report: ReprocessReport = { athleteId, dryRun, wrote: false, at: at.toISOString(), ...plan.report };
  if (dryRun || !plan.inserts.length) return report;

  await db.transaction(async (tx) => {
    for (const x of plan.inserts) {
      const [row] = await tx.insert(athleteFacts).values(toInsert(athleteId, markReprocessed(x.fact, at))).returning({ id: athleteFacts.id });
      if (x.supersedes.length) await tx.update(athleteFacts).set({ status: "superseded", superseded_by: row.id }).where(and(eq(athleteFacts.athlete_id, athleteId), inArray(athleteFacts.id, x.supersedes)));
    }
    // The same follow-ups persist runs after facts change: the found-affiliation ledger, then the research state
    // (no outcome ⇒ no domain's freshness moves; nothing here is a research run).
    await syncAffiliationsFromFacts(athleteId, tx, at);
    await recomputeState(tx, athleteId, policy, at, { identityResolved: false });
  });
  return { ...report, wrote: true };
}
