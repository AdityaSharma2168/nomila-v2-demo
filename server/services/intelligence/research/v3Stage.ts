/**
 * research/v3Stage.ts — the research_refresh v3 provider stage (PR E2a; design record
 * docs/architecture/phase-a/pr-e-identity-resolution-design.md §5.1–§5.5; arch #709 §9.2 adaptations 1–4).
 *
 * One call = ONE research-spec/1 query (Q1–Q6) or the signals lane, persisted on its own research_runs row:
 *
 *   runV3Query(qN)    not planned → skipped · (Q2–Q6) identity gate → held in `pending`, nothing called ·
 *                     Q5 with every platform connected → skipped · reuse (workflow_run_id, query_id) · guard the request ·
 *                     open the row BEFORE the call · the injected direct provider for qN only · Q5 post-filter (D12) ·
 *                     item-mapping · persistResearchRun with the ACCEPTANCE set (every domain qN's items land in) and
 *                     the SETTLE set (planned domains whose covering queries have all run) · Q1: classify and hand the
 *                     determination to the identity gate.
 *   runV3Signals()    the v2 Trends/GDELT lane carried over UNCHANGED (refresh.ts:133-143; D13): same providers, same
 *                     non-LLM lane accounting, same completion rule, same `signals` outcome and TTL; gated like Q2–Q6.
 *
 * Provider trouble never throws (the outcome vocabulary carries it, so a failed Q2 does not fail Q3–Q6); programming
 * errors throw so the runner retries. Providers are INJECTED (V3Providers): this module stays provider-free
 * (boundary.test.ts); server/skills/researchRefresh.ts binds the real adapters.
 *
 * Two modes:
 *   workflow     research_refresh v3 steps. Needs the one execution gate (researchPlannerExecutionEnabled); the
 *                skills binding additionally requires RESEARCH_REFRESH_PROVIDER=direct.
 *   calibration  the calibration CLI (runDirectResearch). Needs only RESEARCH_SUBSTRATE_WRITE (gate before spend, as
 *                before); never governs identity: the gate is observed (`wouldGate`), never enforced, never written (D9).
 *
 * The legacy identityResolved / identityConfidence persist inputs keep their ACCOUNT meaning (hasIdentitySignal, D1)
 * and are never fed from Q1.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db";
import { createLogger } from "../../../logger";
import { athleteResearchState, athletes, connectedAccounts, researchEvidence, researchRuns, researchSourcePayloads } from "../../../../shared/schema";
import { collectResearchSecrets } from "../../../lib/research/secrets";
import type { DirectCallOpts, DirectCallResult } from "../../../lib/research/providers/geminiDirect";
import type { SourceReadInput, SourceReadOpts, SourceReadResult } from "../../../lib/research/providers/geminiSourceRead";
import { assertionsFor, hintsFor } from "./researchInputs";
import { searchInputsFor } from "../context/searchInputs";
import { getResearchPolicy, GROUNDED_READ_MATCH, researchPlannerExecutionEnabled, researchSubstrateWriteEnabled, researchTargetedReadMax, researchTargetedReadMaxAttempts, type ResearchPolicy } from "./config";
import { BLOCKING_KEYS } from "./factRegistry";
import { applyQ1Gate, checkIdentityGate, holdForIdentityGate, identityGateEnforced, type Q1GateResult } from "./identityGate";
import { anchorHash, classifyQ1, HANDLE_PLATFORM_HOSTS, type IdentityAnchor, type IdentityValue, type Q1Determination } from "./identityResolution";
import { recordNonLlmCall, reserveLlmCall, type RunCapGroup } from "./ledger";
import type { DomainAcceptance, DomainQueryStatus } from "./outcomes";
import { persistResearchRun, redactErrorRecord, redactMessage, type PersistResult } from "./persist";
import { planV3, SPEC_V1_DOMAIN_QUERIES, v3AcceptanceDomains, v3SettleDomains } from "./plans";
import type { ExtractedClaim, ExtractionEnvelope, IdentityHints, SearchEnvelope, SignalEnvelope } from "./providers";
import { buildSearchName, hasIdentitySignal, knownHandlesFor } from "./refresh";
import { RESEARCH_DOMAINS, RESEARCH_TRIGGERS, SECTION_DOMAIN, type DomainOutcome, type ResearchDomain, type ResearchTrigger } from "./registries";
import { ACCEPTED_LEVELS, type ProvenanceLevel } from "./spec/directEvidenceV1";
import { hostOf } from "./spec/directLineage";
import { DIRECT_EVIDENCE_V2_VERSION, directRequestV2, itemsFor, type Finding } from "./spec/directEvidenceV2";
import { deriveCareerStatus, ITEM_MAPPING_VERSION, mapFindings } from "./spec/itemMapping";
import { FORBIDDEN_IN_REQUESTS, QUERIES, QUERY_IDS, sectionsFor, type QueryDef, type QueryId } from "./spec/researchSpecV1";
import { assertReadRequestClean, chunkMatchText, domainLabel, groundedCandidates, isGroundingRedirectUrl, mapSourceRead, outletDomainLabel, parseSourceRead, rankReadCandidates, READ_QUERY_ID, readKeyUrl, registrableDomain, SOURCE_READ_VERSION, sourceReadRequest, surnameToken, toReadTarget, youtubeVideoUrl, type GroundedChunk, type MediaHint, type ReadSkipped, type ReadTarget } from "./spec/sourceReadV1";

const logger = createLogger("research-refresh-v3");

export const RESEARCH_REFRESH_V3_STAGE = "research-refresh-v3/1";
const ACCEPTED = new Set<ProvenanceLevel>(ACCEPTED_LEVELS.retrieved);

// ── providers (injected) ──────────────────────────────────────────────────────

/** The direct research call (default binding: the Gemini direct adapter, in server/skills/researchRefresh.ts). */
export type DirectProviderCall = (request: string, opts: DirectCallOpts) => Promise<DirectCallResult>;
export interface V3Providers {
  direct: DirectProviderCall;
  /** Signals lane (no LLM), exactly the v2 RefreshProviders.trends / .gdelt. */
  trends: (name: string, sport: string | null, fetchedAt: string) => Promise<SignalEnvelope>;
  gdelt: (name: string, fetchedAt: string) => Promise<SignalEnvelope>;
  /** The targeted source read (one model call per selected source; default binding: geminiSourceRead). */
  read?: (input: SourceReadInput, opts: SourceReadOpts) => Promise<SourceReadResult>;
  /** Resolves a search-grounding redirect link to the source's real URL (URL resolution only; default binding:
   *  resolveGroundingRedirect). Without it a redirect candidate stays unreadable. */
  resolveRedirect?: (url: string) => Promise<string | null>;
  /** A public YouTube video's existence and title (oEmbed; metadata only; default binding: youtubeVideoInfo). Checked before a
   *  YouTube chunk is matched or read: not existing ⇒ `video_unavailable`, no call; the title is that chunk's match text.
   *  Without it no check is made (and a video chunk has no title to match on). */
  videoInfo?: (watchUrl: string) => Promise<{ exists: boolean; title: string | null }>;
}

// ── the run input (references only) ───────────────────────────────────────────

/** research_refresh v3 run input (§5.1): references only. */
export interface V3RunInput {
  /** The queries to run, in spec order. Default: the queries of `domains` (specV1QueriesFor), or all six. */
  queries?: QueryId[];
  /** Run the signals lane. Default: `signals` is among the domains. */
  signals?: boolean;
  /** The due domains (no profile ↔ affiliations companion, D11). Default: the domains the queries cover (+ signals). */
  domains?: ResearchDomain[];
  trigger?: ResearchTrigger;
  reason?: string | null;
  /** Enforce the Q1 identity gate and write the determination (lifecycle / governed runs). Default false. */
  governIdentity?: boolean;
  plannerRunId?: string | null;
  dueToDispute?: ResearchDomain[];
}
export interface V3Plan { queries: QueryId[]; signals: boolean; domains: ResearchDomain[]; trigger: ResearchTrigger; reason: string | null; governIdentity: boolean; dueToDispute: ResearchDomain[] }

/** Normalize a run input into the plan every step reads. Pure. */
export function resolveV3Plan(input: V3RunInput | null | undefined): V3Plan {
  const i = input ?? {};
  const trigger = (i.trigger ?? "manual") as ResearchTrigger;
  if (!(RESEARCH_TRIGGERS as readonly string[]).includes(trigger)) throw new Error(`research_refresh v3: unknown trigger ${String(trigger)}`);
  for (const q of i.queries ?? []) if (!(QUERY_IDS as readonly string[]).includes(q)) throw new Error(`research_refresh v3: unknown query ${String(q)}`);
  for (const d of i.domains ?? []) if (!(RESEARCH_DOMAINS as readonly string[]).includes(d)) throw new Error(`research_refresh v3: unknown domain ${String(d)}`);
  let domains: ResearchDomain[]; let queries: QueryId[]; let signals: boolean;
  if (i.domains?.length) {
    const p = planV3(i.domains);
    domains = p.domains; queries = i.queries ? QUERY_IDS.filter((q) => i.queries!.includes(q)) : p.queries; signals = i.signals ?? p.signals;
  } else {
    queries = i.queries ? QUERY_IDS.filter((q) => i.queries!.includes(q)) : [...QUERY_IDS];
    signals = i.signals ?? !i.queries;
    domains = RESEARCH_DOMAINS.filter((d) => (d === "signals" ? signals : SPEC_V1_DOMAIN_QUERIES[d].some((q) => queries.includes(q))));
  }
  return { queries, signals, domains, trigger, reason: i.reason ?? null, governIdentity: i.governIdentity === true, dueToDispute: i.dueToDispute ?? [] };
}

// ── the step record ───────────────────────────────────────────────────────────

export type V3Skip = "not_planned" | "identity_gate" | "all_platforms_connected" | "read_disabled" | "no_read_candidates";
export interface DirectQueryRecord { id: QueryId; name: string; attempts: number; completed: boolean; refused: boolean; findings: number; lineage: Record<string, number>; identity: { anchorMatch: string | null; confidence: number | null } | null; latencyMs: number | null }

/** One query step's output (JSON, references only): what later steps of the same run need to settle and carry. */
export interface V3QueryOutput {
  queryId: QueryId | "signals" | typeof READ_QUERY_ID;
  /** A research_runs row was opened for it (the provider was reached, or the budget refused it). */
  ran: boolean;
  skipped?: V3Skip;
  researchRunId: string | null;
  status: "ok" | "partial" | "failed" | "refused" | null;
  completed: boolean;
  chunks: number;
  /** Acceptance this row counted per domain (carried into later settles of the same run). */
  accepted: Record<string, DomainAcceptance>;
  /** Per covered domain: an accepted finding landed (found) or every covering section completed without one (none_found). */
  domainFindings: Record<string, "found" | "none_found">;
  /** Outcomes of the domains this row SETTLED. */
  outcomes: Record<string, DomainOutcome>;
  /** The minor policy is active after this query (stated, or a cited birth year established it). */
  minorActive: boolean;
  record?: DirectQueryRecord;
  droppedConnected?: Record<string, number>;
  /** Q2–Q6 / signals: the gate as read. `wouldGate` is set when it is only observed (calibration, D9). */
  gate?: { enforced: boolean; value: IdentityValue; wouldGate?: boolean; held?: ResearchDomain[] };
  /** Q1 only: the determination and what the gate did with it. */
  identity?: { determination: Q1Determination; requestAnchorHash: string; currentAnchorHash: string; namesakeEvidenceIds: string[]; applied: AppliedSummary };
  reused?: boolean;
  error?: string;
  /** READ only: what the targeted source read selected and extracted. */
  read?: V3ReadRecord;
}
/** The read step's record (references only): selection, per-source outcome, statements and paraphrases extracted. */
export interface V3ReadRecord {
  spec: string; max: number; maxAttempts?: number; candidates: number; skipped: ReadSkipped;
  /** One entry per read attempted (a model call reserved), in walk order. */
  sources: Array<{ url: string; discoveredUrl?: string; evidenceId?: string | null; origin?: string; mode: string; completed: boolean; refused: boolean; claims: number; statements: number; paraphrases: number; dropped: string | null; error: string | null }>;
  /** Sources passed over without a call, with the reason. An ungrounded item carries no URL: the URL the model wrote is never recorded as a source. */
  skippedSources?: Array<{ reason: "ungrounded" | "video_unavailable" | "unreadable" | "alreadyRead" | "duplicate"; evidenceId: string | null; title: string | null; url?: string; discoveredUrl?: string }>;
}
/** What the gate did with a Q1 determination, compact for the step output (the provenance itself is in the column). */
export interface AppliedSummary { written: boolean; reason?: string; transition?: string; from?: IdentityValue; to?: string; detail?: string; expected?: IdentityValue; observed?: IdentityValue | "no_row" }
export function summarizeApplied(r: Q1GateResult): AppliedSummary {
  if (r.written) return { written: true, transition: r.transition, from: r.from, to: r.to };
  const { detail, ...rest } = r as Record<string, unknown>;
  return { ...(rest as unknown as AppliedSummary), ...(typeof detail === "string" ? { detail } : {}) };
}

/** Not JSON: the findings, for the calibration loop's career-status derivation. */
export interface V3QueryRun { output: V3QueryOutput; findings: Finding[]; persist: PersistResult | null; claims: number }

const emptyOutput = (queryId: V3QueryOutput["queryId"], extra: Partial<V3QueryOutput> = {}): V3QueryOutput => ({ queryId, ran: false, researchRunId: null, status: null, completed: false, chunks: 0, accepted: {}, domainFindings: {}, outcomes: {}, minorActive: false, ...extra });

export type V3Mode = "workflow" | "calibration";
export interface V3StepArgs {
  athleteId: string;
  workflowRunId: string | null;
  plan: V3Plan;
  /** Outputs of the earlier query steps of this run, in order (the runner's ctx.outputs; the CLI loop's own list). */
  prior: V3QueryOutput[];
  mode: V3Mode;
  asOf?: Date;
  /** Calibration only: the cohort subject (name, sport, anchor, stated minor). The workflow reads the athlete row. */
  subject?: { fullName: string; sport: string; anchor: string; isMinor: boolean };
  /** Calibration only: raise the ledger caps for this process (the persisted policy row is never changed). */
  plannerOverride?: Partial<{ maxLlmCallsPerNight: number; maxCallsPerRun: number; geminiRetryMax: number }>;
}

/** Words that must never reach a provider (research-spec/1 §4.3). Throws before any call. */
export function assertDirectRequestClean(request: string): void {
  for (const re of FORBIDDEN_IN_REQUESTS) if (re.test(request)) throw new Error(`direct research request contains a forbidden word (${re})`);
}

/** Under-18 established deterministically from a cited birth year (year-only): as-of-year − birth year ≤ 17. */
export function citedBirthYearEstablishesMinor(findings: Finding[], asOf: Date): boolean {
  const y = asOf.getUTCFullYear();
  return findings.some((f) => f.item === "birth_year" && ACCEPTED.has(f.lineage.level) && (() => { const b = Number(String(f.value.year ?? f.value.date ?? "").slice(0, 4)); return Number.isInteger(b) && b >= 1900 && y - b <= 17; })());
}

// ── Q5 narrowing (D12) ────────────────────────────────────────────────────────

/** The platforms Q5's handle / verification / follower items can be answered for by a connection (the T-e platform set). */
export const Q5_PLATFORMS: readonly string[] = Object.keys(HANDLE_PLATFORM_HOSTS);
/** Q5 items that are platform data and therefore yield to an active connection. */
export const Q5_CONNECTED_ITEMS: ReadonlySet<string> = new Set(["official_accounts", "verification_status", "follower_counts_as_stated"]);
/** A finding's platform, normalized: lower-case letters only; twitter / x (twitter) → x. Exact after normalization. */
export function normalizePlatform(p: unknown): string | null {
  const t = String(p ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (t === "twitter" || t === "xtwitter" || t === "twitterx") return "x";
  return t;
}
/** Drop Q5 platform findings for connected platforms (connected data stays authoritative). Pure. */
export function filterConnectedQ5(findings: Finding[], connected: ReadonlySet<string>): { kept: Finding[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {};
  const kept = findings.filter((f) => {
    if (f.section !== "S8" || !Q5_CONNECTED_ITEMS.has(f.item)) return true;
    const p = normalizePlatform(f.value.platform);
    if (p && connected.has(p)) { dropped[p] = (dropped[p] ?? 0) + 1; return false; }
    return true;
  });
  return { kept, dropped };
}
async function connectedPlatforms(athleteId: string): Promise<Set<string>> {
  const rows = await db.select({ platform: connectedAccounts.platform }).from(connectedAccounts).where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active")));
  return new Set(rows.map((r) => normalizePlatform(r.platform)).filter((p): p is string => !!p));
}

// ── shared bookkeeping ────────────────────────────────────────────────────────

/** Close a still-`running` row as failed; a row persist already closed is left as it is. */
async function closeRunFailed(runId: string, error: { reason: string; message: string }, secrets: string[]): Promise<void> {
  await db.update(researchRuns).set({ status: "failed", finished_at: new Date(), error: redactErrorRecord(error, secrets) as any }).where(and(eq(researchRuns.id, runId), eq(researchRuns.status, "running")));
}

function gateBeforeSpend(mode: V3Mode): string | null {
  if (mode === "workflow") return researchPlannerExecutionEnabled() ? null : "execution_disabled";
  return researchSubstrateWriteEnabled() ? null : "RESEARCH_SUBSTRATE_WRITE is not true: persist would write nothing, so no row is opened and no provider is called";
}
const enforcedFor = (a: V3StepArgs) => a.mode === "workflow" && identityGateEnforced(a.plan.governIdentity);

/** Q2–Q6 / signals: the gate, read fresh. Enforced and not resolved → hold the step's planned domains in `pending`. */
async function gateStep(a: V3StepArgs, queryId: QueryId | "signals" | typeof READ_QUERY_ID, covered: ResearchDomain[], asOf: Date): Promise<V3QueryOutput | { gate: NonNullable<V3QueryOutput["gate"]> }> {
  const governed = a.mode === "workflow" && a.plan.governIdentity;
  const g = await checkIdentityGate(a.athleteId, governed);
  if (g.hold) {
    const toHold = covered.filter((d) => a.plan.domains.includes(d));
    const { held } = await holdForIdentityGate(a.athleteId, toHold, governed, asOf);
    return emptyOutput(queryId, { skipped: "identity_gate", gate: { enforced: true, value: g.value, held }, minorActive: priorMinor(a) });
  }
  if (g.enforced) return { gate: { enforced: true, value: g.value } };
  // Observed (D9): Q1 of this run decides it when it ran; else the recorded determination.
  const q1 = a.prior.find((p) => p.queryId === "Q1" && p.identity);
  const wouldGate = q1?.identity ? q1.identity.determination.outcome !== "resolved" : g.value !== "resolved";
  return { gate: { enforced: false, value: g.value, wouldGate } };
}
const priorMinor = (a: V3StepArgs) => !!a.subject?.isMinor || a.prior.some((p) => p.minorActive);

interface AthleteCtx { a: { id: string; full_name: string; school: string | null; sport: string | null; socials: unknown }; hints: IdentityHints; hasAssertedAffiliations: boolean; anchor: IdentityAnchor; searchAnchor: string }
/** The athlete's search inputs, hints and identity anchor (refresh.ts's construction, byte for byte). */
async function athleteContext(athleteId: string): Promise<AthleteCtx | null> {
  const [a] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!a) return null;
  const inputs = await searchInputsFor(a.id, { anchor: buildSearchName(a), handles: await knownHandlesFor(a.id, a.socials) });
  const legacy = await hintsFor(a as any, inputs.handles);
  const hints = legacy.hints;
  return { a, hints, hasAssertedAffiliations: legacy.hasAssertedAffiliations, searchAnchor: inputs.anchor, anchor: { fullName: a.full_name, sport: a.sport ?? "", team: inputs.currentTeam, handles: inputs.handles } };
}

async function policyFor(a: V3StepArgs): Promise<ResearchPolicy> {
  const base = await getResearchPolicy();
  return a.plannerOverride ? { ...base, planner: { ...base.planner, ...a.plannerOverride } } : base;
}

// ── one query ─────────────────────────────────────────────────────────────────

export async function runV3Query(a: V3StepArgs, queryId: QueryId, providers: Pick<V3Providers, "direct">): Promise<V3QueryRun> {
  const asOf = a.asOf ?? new Date();
  const asOfStr = asOf.toISOString().slice(0, 10);
  const secrets = collectResearchSecrets();
  const done = (output: V3QueryOutput, extra: Partial<Omit<V3QueryRun, "output">> = {}): V3QueryRun => ({ output, findings: [], persist: null, claims: 0, ...extra });

  const refusal = gateBeforeSpend(a.mode);
  if (refusal) return done(emptyOutput(queryId, { status: "refused", error: refusal, minorActive: priorMinor(a) }));
  if (!a.plan.queries.includes(queryId)) return done(emptyOutput(queryId, { skipped: "not_planned", minorActive: priorMinor(a) }));
  const q = QUERIES.find((x) => x.id === queryId) as QueryDef;
  const acceptance = v3AcceptanceDomains(queryId);
  const covered = RESEARCH_DOMAINS.filter((d) => SPEC_V1_DOMAIN_QUERIES[d].includes(queryId));

  // ── the identity gate (Q2–Q6; Q1 is never gated) ──
  let gate: V3QueryOutput["gate"];
  if (queryId !== "Q1") {
    const g = await gateStep(a, queryId, covered, asOf);
    if ("queryId" in g) return done(g);
    gate = g.gate;
  }

  // ── Q5 narrowing: nothing to ask when every platform it can answer is connected ──
  const connected = queryId === "Q5" ? await connectedPlatforms(a.athleteId) : new Set<string>();
  if (queryId === "Q5" && Q5_PLATFORMS.every((p) => connected.has(p))) return done(emptyOutput(queryId, { skipped: "all_platforms_connected", gate, minorActive: priorMinor(a) }));

  // ── reuse (workflow_run_id, query_id): a completed row is returned; an abandoned one is closed ──
  if (a.workflowRunId) {
    const existing = await db.select({ id: researchRuns.id, status: researchRuns.status, summary: researchRuns.summary }).from(researchRuns).where(and(eq(researchRuns.workflow_run_id, a.workflowRunId), eq(researchRuns.query_id, queryId)));
    const hit = existing.find((r) => r.status === "ok" || r.status === "partial");
    if (hit) return done(await reusedOutput(a, queryId, hit.id, hit.status as "ok" | "partial", hit.summary, gate));
    for (const r of existing) if (r.status === "running") await closeRunFailed(r.id, { reason: "abandoned", message: "a previous attempt of this workflow step did not close its research run" }, secrets);
  }

  const ctx = await athleteContext(a.athleteId);
  if (!ctx) throw new Error(`Athlete ${a.athleteId} not found`);
  const policy = await policyFor(a);
  let isMinor = priorMinor(a);
  const subject = { fullName: a.subject?.fullName ?? ctx.a.full_name, sport: a.subject?.sport ?? ctx.a.sport ?? "", anchor: a.subject?.anchor ?? ctx.searchAnchor, isMinor };
  const sections = sectionsFor(isMinor);
  const request = directRequestV2(subject, q, sections, asOfStr);
  assertDirectRequestClean(request);                                   // a forbidden word aborts with no call and no row
  const requestAnchorHash = anchorHash(ctx.anchor);

  // ── open the row BEFORE the call (the ledger counts on it) ──
  const [run] = await db.insert(researchRuns).values({ athlete_id: a.athleteId, domain: "refresh", trigger: a.plan.trigger, status: "running", started_at: asOf, as_of: asOf, workflow_run_id: a.workflowRunId, query_id: queryId, providers: [{ role: "search", provider: "gemini_direct", model: null }] as any, summary: { plan: { domains: acceptance }, reason: a.plan.reason } as any }).returning({ id: researchRuns.id });
  const runId = run.id;
  // The per-run cap spans the whole LOGICAL run: every query row of this workflow run, or (calibration, no workflow
  // run) every row of this invocation — never one query row alone (same limit, same counted attempts).
  const capGroup: RunCapGroup = a.workflowRunId ? { workflowRunId: a.workflowRunId } : { runIds: a.prior.map((p) => p.researchRunId).filter((x): x is string => !!x) };
  const reserve = () => reserveLlmCall(runId, { policy, asOf, capGroup });

  try {
    const r = await providers.direct(request, { envelopeId: `d${QUERY_IDS.indexOf(queryId)}`, queryName: q.name, sections: sections.filter((s) => q.sections.includes(s.id)), retryMax: policy.planner.geminiRetryMax, timeoutMs: policy.planner.geminiCallTimeoutMs, reserve, contract: "v2", query: q });
    // T2's "current anchor": read when the answer comes back, before Q1's own persist can move the ledger's team.
    const currentAnchorHash = queryId === "Q1" ? anchorHash((await athleteContext(a.athleteId))!.anchor) : requestAnchorHash;

    const all = r.parsedV2 && !r.parsedV2.parseError ? Object.values(r.parsedV2.items).flatMap((it) => it?.findings ?? []) : [];
    const { kept: findings, dropped } = queryId === "Q5" ? filterConnectedQ5(all, connected) : { kept: all, dropped: {} };
    const lineage = findings.reduce<Record<string, number>>((m, f) => { m[f.lineage.level] = (m[f.lineage.level] ?? 0) + 1; return m; }, {});
    const record: DirectQueryRecord = { id: q.id, name: q.name, attempts: r.attempts, completed: r.completed, refused: r.refused, findings: findings.length, lineage, identity: r.parsedV2?.identity ? { anchorMatch: r.parsedV2.identity.anchorMatch, confidence: r.parsedV2.identity.confidence } : null, latencyMs: r.envelope.usage?.latencyMs ?? null };
    const claims: ExtractedClaim[] = [];
    if (r.completed) {
      for (const m of mapFindings(findings)) claims.push({ ...(m as unknown as ExtractedClaim), claim: { ...m.claim, item: m.item, registryStatus: m.registryStatus, mappingVersion: m.mappingVersion, ...(m.unmappedFields.length ? { unmappedFields: m.unmappedFields } : {}) } });
      if (!isMinor && citedBirthYearEstablishesMinor(findings, asOf)) isMinor = true;
    }
    // Per covered domain (directResearch's rule, per query): found when an accepted claim landed in a section's domain;
    // none_found when the query completed without one.
    const domainFindings: Record<string, "found" | "none_found"> = {};
    if (r.completed) for (const s of q.sections) {
      const d = SECTION_DOMAIN[s];
      const found = claims.some((c) => (c as any).section === s && ACCEPTED.has((c as any).lineage?.level));
      if (found) domainFindings[d] = "found"; else if (!domainFindings[d]) domainFindings[d] = "none_found";
    }

    // ── settle: planned domains whose covering queries have ALL run (this one included) ──
    const ran = new Set<QueryId>([queryId, ...a.prior.filter((p) => p.ran && p.queryId !== "signals").map((p) => p.queryId as QueryId)]);
    const settle = v3SettleDomains(queryId, a.plan.domains, ran);
    const byQuery = new Map<string, V3QueryOutput>(a.prior.filter((p) => p.ran).map((p) => [p.queryId, p]));
    const self = { completed: r.completed, chunks: r.envelope.chunks.length, domainFindings };
    const queryStatus: Partial<Record<ResearchDomain, DomainQueryStatus>> = {};
    const domainOutcomes: NonNullable<ExtractionEnvelope["domainOutcomes"]> = {};
    const carryAccepted: Partial<Record<ResearchDomain, DomainAcceptance>> = {};
    for (const d of settle) {
      const rs = SPEC_V1_DOMAIN_QUERIES[d].map((x) => (x === queryId ? self : byQuery.get(x)!));
      queryStatus[d] = { completed: rs.every((x) => x.completed), chunksReviewed: rs.reduce((n, x) => n + x.chunks, 0) };
      const marks = rs.map((x) => x.domainFindings[d]);
      if (marks.includes("found")) domainOutcomes[d] = { status: "found", reviewedChunkIds: [] };
      else if (marks.every((m) => m === "none_found")) domainOutcomes[d] = { status: "none_found", reviewedChunkIds: [] };
      const carry = a.prior.reduce<DomainAcceptance>((acc, p) => { const x = p.accepted[d]; return x ? { evidence: acc.evidence + x.evidence, factBearing: acc.factBearing + x.factBearing, facts: acc.facts + x.facts } : acc; }, { evidence: 0, factBearing: 0, facts: 0 });
      if (carry.evidence || carry.factBearing || carry.facts) carryAccepted[d] = carry;
    }

    const errors: ExtractionEnvelope["errors"] = r.completed ? [] : [{ step: `direct:${q.id}`, message: r.refused ? "budget refused" : (r.envelope.errors[0]?.message ?? "no parsable direct-evidence response"), class: r.refused ? "refused" : "empty" }];
    const extraction: ExtractionEnvelope = {
      id: "d-map", provider: "gemini_direct", model: r.envelope.model, schemaVersion: DIRECT_EVIDENCE_V2_VERSION, fetchedAt: new Date().toISOString(),
      claims, inferences: [], domainOutcomes,
      raw: { version: RESEARCH_REFRESH_V3_STAGE, itemMapping: ITEM_MAPPING_VERSION, queryId, identityByQuery: r.parsedV2?.identity ? { [queryId]: r.parsedV2.identity } : {}, itemStatuses: Object.fromEntries(Object.entries(r.parsedV2?.items ?? {}).map(([id, it]) => [id, it?.status])), minorPolicy: { statedMinor: !!a.subject?.isMinor, active: isMinor }, careerStatusDerived: deriveCareerStatus(findings), queries: [record], ...(queryId === "Q5" ? { droppedConnected: dropped } : {}) },
      request: { path: "direct-research", params: { contract: DIRECT_EVIDENCE_V2_VERSION, queries: [queryId], asOf: asOfStr, ...(r.refused ? { refusedAt: queryId } : {}) } },
      errors, parseError: null,
    };

    // T-c input: blocking disputes on identity/affiliations before this run's persist.
    const blockingBefore = queryId === "Q1" ? await blockingDomains(a.athleteId) : new Set<string>();
    const assertions = await assertionsFor(a.athleteId);
    const identitySignal = await hasIdentitySignal(a.athleteId);   // the legacy ACCOUNT signal (D1); never Q1
    const step = { queryId, completed: r.completed, chunks: self.chunks, domainFindings, minorActive: isMinor, record, ...(queryId === "Q5" ? { droppedConnected: dropped } : {}) };
    const persisted = await persistResearchRun({
      athleteId: a.athleteId, runId, workflowRunId: a.workflowRunId, trigger: a.plan.trigger, domain: "refresh", hints: ctx.hints, search: [r.envelope], extraction, signals: [],
      assertions, hasAssertedAffiliations: ctx.hasAssertedAffiliations, identityResolved: identitySignal, identityConfidence: identitySignal ? 1 : undefined, secrets, asOf, retrievedAt: asOf,
      plan: { domains: acceptance, acceptance, settle, queryStatus, dueToDispute: a.plan.dueToDispute.filter((d) => settle.includes(d)), carryAccepted },
      queryId, summaryExtra: { step, reason: a.plan.reason },
    });
    if (!persisted) await closeRunFailed(runId, { reason: "persist_null", message: "persist wrote nothing" }, secrets);
    const status: V3QueryOutput["status"] = persisted ? persisted.status : "failed";
    const output: V3QueryOutput = {
      queryId, ran: true, researchRunId: runId, status, completed: r.completed, chunks: self.chunks, accepted: persisted?.accepted ?? {}, domainFindings,
      outcomes: Object.fromEntries(Object.entries(persisted?.domains ?? {}).map(([d, v]) => [d, v.outcome])), minorActive: isMinor, record,
      ...(queryId === "Q5" ? { droppedConnected: dropped } : {}), ...(gate ? { gate } : {}),
    };

    // ── Q1: classify after persist, then the gate (§5.3) ──
    if (queryId === "Q1") {
      const blockingAfter = await blockingDomains(a.athleteId);
      const raised = ["identity", "affiliations"].some((d) => blockingAfter.has(d) && !blockingBefore.has(d));
      const againstHerStatement = ctx.hasAssertedAffiliations || assertions.some((x) => BLOCKING_KEYS.includes(x.factKey));
      const determination = classifyQ1({ completed: r.completed && !!persisted, parsed: r.parsedV2, nativeSources: r.nativeSources, askedItems: itemsFor(q, sections).length, conflictsAthleteStatement: raised && againstHerStatement }, ctx.anchor);
      const namesakeEvidenceIds = persisted ? (await db.select({ id: researchEvidence.id }).from(researchEvidence).where(and(eq(researchEvidence.run_id, runId), eq(researchEvidence.kind, "identity_signal"), sql`${researchEvidence.claim}->>'topic' = 'namesake'`))).map((x) => x.id) : [];
      const applied = a.mode === "workflow" ? await applyQ1Gate({ athleteId: a.athleteId, governIdentity: a.plan.governIdentity, determination, researchRunId: runId, workflowRunId: a.workflowRunId, requestAnchorHash, currentAnchorHash, namesakeEvidenceIds, at: asOf }) : { written: false as const, reason: "observed" as const };
      output.identity = { determination, requestAnchorHash, currentAnchorHash, namesakeEvidenceIds, applied: summarizeApplied(applied) };
      // The identity block on the Q1 row (the full history lives here; the column holds current + one).
      await db.update(researchRuns).set({ summary: sql`COALESCE(${researchRuns.summary}, '{}'::jsonb) || ${JSON.stringify({ identity: { block: r.parsedV2?.identity ?? null, determination, requestAnchorHash, currentAnchorHash, namesakeEvidenceIds } })}::jsonb` }).where(eq(researchRuns.id, runId));
    }
    logger.info({ athleteId: a.athleteId, workflowRunId: a.workflowRunId, queryId, runId, status, settle, enforced: enforcedFor(a) }, "research_refresh v3 query");
    return done(output, { findings, persist: persisted, claims: claims.length });
  } catch (err: any) {
    const message = redactMessage(err?.message ?? err, secrets);
    await closeRunFailed(runId, { reason: "error", message }, secrets).catch(() => {});
    throw err;   // a programming error: the runner records it and retries the step
  }
}

/** Blocking disputes currently recorded on identity/affiliations (athlete_research_state.domains[d].blockingDispute). */
async function blockingDomains(athleteId: string): Promise<Set<string>> {
  const [row] = await db.select({ domains: athleteResearchState.domains }).from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)).limit(1);
  const ds = (row?.domains ?? {}) as Record<string, { blockingDispute?: boolean }>;
  return new Set(Object.entries(ds).filter(([, v]) => v?.blockingDispute).map(([d]) => d));
}

/** A completed row of this (workflow run, query): its stored step record; Q1 re-applies its stored determination (idempotent). */
async function reusedOutput(a: V3StepArgs, queryId: QueryId, runId: string, status: "ok" | "partial", summary: unknown, gate: V3QueryOutput["gate"]): Promise<V3QueryOutput> {
  const s = (summary ?? {}) as { step?: Partial<V3QueryOutput> & { chunks?: number }; accepted?: Record<string, DomainAcceptance>; domains?: Record<string, { outcome: DomainOutcome }>; identity?: { determination: Q1Determination; requestAnchorHash: string; currentAnchorHash: string; namesakeEvidenceIds: string[] } };
  const out: V3QueryOutput = {
    queryId, ran: true, researchRunId: runId, status, completed: !!s.step?.completed, chunks: s.step?.chunks ?? 0, accepted: s.accepted ?? {}, domainFindings: s.step?.domainFindings ?? {},
    outcomes: Object.fromEntries(Object.entries(s.domains ?? {}).map(([d, v]) => [d, v.outcome])), minorActive: !!s.step?.minorActive || priorMinor(a), reused: true,
    ...(s.step?.record ? { record: s.step.record } : {}), ...(s.step?.droppedConnected ? { droppedConnected: s.step.droppedConnected } : {}), ...(gate ? { gate } : {}),
  };
  if (queryId === "Q1" && s.identity?.determination) {
    const applied = a.mode === "workflow" ? await applyQ1Gate({ athleteId: a.athleteId, governIdentity: a.plan.governIdentity, determination: s.identity.determination, researchRunId: runId, workflowRunId: a.workflowRunId, requestAnchorHash: s.identity.requestAnchorHash, currentAnchorHash: s.identity.currentAnchorHash, namesakeEvidenceIds: s.identity.namesakeEvidenceIds ?? [] }) : { written: false as const, reason: "observed" as const };
    out.identity = { ...s.identity, namesakeEvidenceIds: s.identity.namesakeEvidenceIds ?? [], applied: summarizeApplied(applied) };
  }
  return out;
}

// ── the calibration loop (the CLI on the same stage; D9) ──────────────────────

export interface V3CalibrationInput {
  athleteId: string;
  subject: { fullName: string; sport: string; anchor: string; isMinor: boolean };
  trigger?: ResearchTrigger;
  asOf?: Date;
  /** Default: all six, in spec order. */
  queryIds?: QueryId[];
  plannerOverride?: V3StepArgs["plannerOverride"];
}
export interface V3CalibrationResult {
  version: string;
  status: "ok" | "partial" | "failed" | "refused";
  /** One research_runs row per query that ran. */
  runIds: string[];
  queries: DirectQueryRecord[];
  outputs: V3QueryOutput[];
  claims: number;
  evidence: number; facts: number; refused: number;
  minorActivated: boolean;
  careerStatus: ReturnType<typeof deriveCareerStatus>;
  /** The Q1 gate, OBSERVED only (D9): would Q2–Q6 have been held? null when Q1 did not run. */
  wouldGate: boolean | null;
  error?: string;
}

/**
 * The calibration CLI's run: the same per-query stage, sequentially, with governIdentity false — no identity write, no
 * pending hold, the gate observed (`wouldGate`) and Q2–Q6 still run so the false-stop rate can be measured (G5). No
 * workflow run: every call opens new rows. Stops after a budget refusal (the CLI's established behaviour).
 */
export async function runV3Calibration(i: V3CalibrationInput, providers: Pick<V3Providers, "direct">): Promise<V3CalibrationResult> {
  const plan = resolveV3Plan({ queries: i.queryIds?.length ? i.queryIds : [...QUERY_IDS], signals: false, trigger: i.trigger ?? "manual", governIdentity: false });
  const result: V3CalibrationResult = { version: RESEARCH_REFRESH_V3_STAGE, status: "ok", runIds: [], queries: [], outputs: [], claims: 0, evidence: 0, facts: 0, refused: 0, minorActivated: false, careerStatus: { status: null, basis: null }, wouldGate: null };
  const findingsAll: Finding[] = [];
  const asOf = i.asOf ?? new Date();
  for (const q of plan.queries) {
    let r: V3QueryRun;
    try { r = await runV3Query({ athleteId: i.athleteId, workflowRunId: null, plan, prior: result.outputs, mode: "calibration", asOf, subject: i.subject, plannerOverride: i.plannerOverride }, q, providers); }
    catch (err: any) { result.status = "failed"; result.error = String(err?.message ?? err).slice(0, 200); break; }
    const o = r.output;
    if (o.status === "refused" && !o.ran) { result.status = "refused"; result.error = o.error; break; }
    result.outputs.push(o);
    if (o.researchRunId) result.runIds.push(o.researchRunId);
    if (o.record) result.queries.push(o.record);
    result.claims += r.claims; findingsAll.push(...r.findings);
    if (r.persist) { result.evidence += r.persist.evidence; result.facts += r.persist.facts; result.refused += r.persist.refused; }
    if (o.status === "failed") result.status = "failed"; else if (o.status === "partial" && result.status === "ok") result.status = "partial";
    if (q === "Q1" && o.identity) result.wouldGate = o.identity.determination.outcome !== "resolved";
    if (o.record?.refused) break;
  }
  result.minorActivated = !i.subject.isMinor && result.outputs.some((o) => o.minorActive);
  result.careerStatus = deriveCareerStatus(findingsAll);
  return result;
}

// ── the signals lane (D13: v2's lane, unchanged) ──────────────────────────────

export async function runV3Signals(a: V3StepArgs, providers: Pick<V3Providers, "trends" | "gdelt">): Promise<V3QueryOutput> {
  const asOf = a.asOf ?? new Date();
  const secrets = collectResearchSecrets();
  const refusal = gateBeforeSpend(a.mode);
  if (refusal) return emptyOutput("signals", { status: "refused", error: refusal, minorActive: priorMinor(a) });
  if (!a.plan.signals) return emptyOutput("signals", { skipped: "not_planned", minorActive: priorMinor(a) });
  const g = await gateStep(a, "signals", ["signals"], asOf);
  if ("queryId" in g) return g;

  if (a.workflowRunId) {
    const existing = await db.select({ id: researchRuns.id, status: researchRuns.status, summary: researchRuns.summary }).from(researchRuns).where(and(eq(researchRuns.workflow_run_id, a.workflowRunId), isNull(researchRuns.query_id), eq(researchRuns.domain, "signals")));
    const hit = existing.find((r) => r.status === "ok" || r.status === "partial");
    if (hit) { const s = (hit.summary ?? {}) as any; return { ...emptyOutput("signals"), ran: true, researchRunId: hit.id, status: hit.status as "ok" | "partial", completed: !!s.step?.completed, chunks: s.step?.chunks ?? 0, accepted: s.accepted ?? {}, outcomes: Object.fromEntries(Object.entries((s.domains ?? {}) as Record<string, { outcome: DomainOutcome }>).map(([d, v]) => [d, v.outcome])), minorActive: priorMinor(a), reused: true, gate: g.gate }; }
    for (const r of existing) if (r.status === "running") await closeRunFailed(r.id, { reason: "abandoned", message: "a previous attempt of this workflow step did not close its research run" }, secrets);
  }

  const ctx = await athleteContext(a.athleteId);
  if (!ctx) throw new Error(`Athlete ${a.athleteId} not found`);
  const policy = await policyFor(a);
  const [run] = await db.insert(researchRuns).values({ athlete_id: a.athleteId, domain: "signals", trigger: a.plan.trigger, status: "running", started_at: asOf, as_of: asOf, workflow_run_id: a.workflowRunId, summary: { plan: { domains: ["signals"] }, reason: a.plan.reason } as any }).returning({ id: researchRuns.id });
  const runId = run.id;
  const name = ctx.a.full_name, sport = ctx.a.sport;
  try {
    // ── exactly refresh.ts:133-143 ──
    const signals: SignalEnvelope[] = [];
    const fetchedAt = new Date().toISOString();
    const [t, gd] = await Promise.all([
      (await recordNonLlmCall(runId, "signals", { policy, asOf })) ? providers.trends(name, sport, fetchedAt).catch((e: any) => { logger.warn({ athleteId: a.athleteId, error: redactMessage(e?.message ?? e, secrets) }, "trends failed"); return null; }) : Promise.resolve(null),
      (await recordNonLlmCall(runId, "signals", { policy, asOf })) ? providers.gdelt(name, fetchedAt).catch((e: any) => { logger.warn({ athleteId: a.athleteId, error: redactMessage(e?.message ?? e, secrets) }, "gdelt failed"); return null; }) : Promise.resolve(null),
    ]);
    for (const s of [t, gd]) if (s) signals.push(s);
    const completed = !!t && !!gd;

    const identitySignal = await hasIdentitySignal(a.athleteId);
    const persisted = await persistResearchRun({
      athleteId: a.athleteId, runId, workflowRunId: a.workflowRunId, trigger: a.plan.trigger, domain: "signals", hints: ctx.hints, search: [], extraction: null, signals,
      assertions: await assertionsFor(a.athleteId), hasAssertedAffiliations: ctx.hasAssertedAffiliations, identityResolved: identitySignal, identityConfidence: identitySignal ? 1 : undefined, secrets, asOf, retrievedAt: asOf,
      plan: { domains: ["signals"], acceptance: ["signals"], settle: ["signals"], queryStatus: { signals: { completed, chunksReviewed: signals.length } }, dueToDispute: a.plan.dueToDispute.filter((d) => d === "signals") },
      summaryExtra: { step: { queryId: "signals", completed, chunks: signals.length }, reason: a.plan.reason },
    });
    if (!persisted) await closeRunFailed(runId, { reason: "persist_null", message: "persist wrote nothing" }, secrets);
    return { ...emptyOutput("signals"), ran: true, researchRunId: runId, status: persisted ? persisted.status : "failed", completed, chunks: signals.length, accepted: persisted?.accepted ?? {}, outcomes: Object.fromEntries(Object.entries(persisted?.domains ?? {}).map(([d, v]) => [d, v.outcome])), minorActive: priorMinor(a), gate: g.gate };
  } catch (err: any) {
    await closeRunFailed(runId, { reason: "error", message: redactMessage(err?.message ?? err, secrets) }, secrets).catch(() => {});
    throw err;
  }
}

// ── the targeted source read (identity sources; source-read/1) ────────────────

/** Every domain a read's items can land in. The read never SETTLES a domain (no freshness, no failure count): it only adds evidence. */
const READ_ACCEPTANCE: ResearchDomain[] = RESEARCH_DOMAINS.filter((d) => d !== "signals");
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * This workflow run's athlete_media items (its Q3 row), as HINTS. The URL the model wrote (`claimedUrl`) is untrusted: it is used
 * only to match the item to a grounding chunk, never read and never stored as a source. The evidence rows are not changed.
 */
export async function mediaHintsFor(workflowRunId: string): Promise<MediaHint[]> {
  const rows = await db.select({ id: researchEvidence.id, claim: researchEvidence.claim, lineage: researchEvidence.lineage_status, sourceType: researchEvidence.source_type, publishedAt: researchEvidence.published_at })
    .from(researchEvidence).innerJoin(researchRuns, eq(researchRuns.id, researchEvidence.run_id))
    .where(and(eq(researchRuns.workflow_run_id, workflowRunId), eq(researchRuns.query_id, "Q3"), eq(researchEvidence.suspect, false), sql`${researchEvidence.claim}->>'item' = 'athlete_media'`));
  return rows.map((r) => {
    const c = (r.claim ?? {}) as Record<string, unknown>;
    return { evidenceId: r.id, claimedUrl: str(c.url), title: str(c.title), outlet: str(c.outlet), outletType: str(c.outletType), sourceType: r.sourceType, medium: str(c.medium), participation: str(c.participation), athleteQuoted: c.athleteQuoted === true, date: str(c.date) ?? (r.publishedAt ? r.publishedAt.toISOString().slice(0, 10) : null), lineage: r.lineage };
  });
}

/** What Google actually retrieved during this workflow run's discovery queries (Q1–Q6): the grounding chunks of their stored search payloads. */
export async function groundedChunksFor(workflowRunId: string): Promise<GroundedChunk[]> {
  const rows = await db.select({ queryId: researchRuns.query_id, payload: researchSourcePayloads.payload })
    .from(researchSourcePayloads).innerJoin(researchRuns, eq(researchRuns.id, researchSourcePayloads.run_id))
    .where(and(eq(researchRuns.workflow_run_id, workflowRunId), inArray(researchRuns.query_id, [...QUERY_IDS]), sql`${researchSourcePayloads.endpoint_family} like 'search:%'`));
  const out: GroundedChunk[] = []; const seen = new Set<string>();
  for (const r of [...rows].sort((x, y) => String(x.queryId).localeCompare(String(y.queryId)))) {
    const chunks = ((r.payload ?? {}) as { chunks?: unknown }).chunks;
    for (const [n, ch] of (Array.isArray(chunks) ? chunks : []).entries()) {
      const url = str((ch as any)?.url);
      if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ chunkId: `${r.queryId}:${str((ch as any)?.id) ?? `c${n}`}`, url, domain: str((ch as any)?.domain), title: str((ch as any)?.title) });
    }
  }
  return out;
}

/** Reuse key lookup: the sources this athlete already had READ (completed) under `spec` — a lookup on stored payload rows, no cache. */
export async function readKeysAlreadyRead(athleteId: string, spec: string = SOURCE_READ_VERSION): Promise<Set<string>> {
  const rows = await db.select({ key: sql<string | null>`${researchSourcePayloads.request}->'params'->>'sourceKey'` }).from(researchSourcePayloads)
    .where(and(eq(researchSourcePayloads.athlete_id, athleteId), sql`${researchSourcePayloads.request}->>'path' = 'source-read'`, sql`${researchSourcePayloads.request}->'params'->>'readSpec' = ${spec}`, sql`${researchSourcePayloads.request}->'params'->>'completed' = 'true'`));
  return new Set(rows.map((r) => r.key).filter((k): k is string => !!k));
}

/**
 * research_refresh v3's `read` step: after the discovery queries of the SAME workflow run, read the best of the sources those
 * queries' search grounding RETRIEVED (model athlete_media items only describe them: groundedCandidates; a model-written URL is
 * never read), walking the ranked pool until RESEARCH_TARGETED_READ_MAX reads succeed or RESEARCH_TARGETED_READ_MAX_ATTEMPTS
 * model calls are spent (a failed read is backfilled by the next candidate). Live grounding gives each chunk only its domain as
 * web.title, so grounding redirects are resolved BEFORE matching (bounded, prioritized) and each chunk is matched on its resolved
 * URL's path slug or, for a YouTube video, its oEmbed title; a video oEmbed does not know is skipped before any call. Every call goes through the budget reservation (its
 * own allowance = the attempts ceiling; the daily limit unchanged). What each read yields is persisted on ONE research_runs row
 * (query_id READ): statements → athlete_statement, everything else → the existing kinds, all lineage `source_read`.
 * Gated like Q2–Q6 (identity gate); skipped when disabled (0), when Q3 is not planned, or when nothing is readable.
 */
export async function runV3Read(a: V3StepArgs, providers: Pick<V3Providers, "read" | "resolveRedirect" | "videoInfo">): Promise<V3QueryOutput> {
  const asOf = a.asOf ?? new Date();
  const asOfStr = asOf.toISOString().slice(0, 10);
  const secrets = collectResearchSecrets();
  const refusal = gateBeforeSpend(a.mode);
  if (refusal) return emptyOutput(READ_QUERY_ID, { status: "refused", error: refusal, minorActive: priorMinor(a) });
  const max = researchTargetedReadMax();
  if (max === 0) return emptyOutput(READ_QUERY_ID, { skipped: "read_disabled", minorActive: priorMinor(a) });
  if (!a.workflowRunId || !a.plan.queries.includes("Q3")) return emptyOutput(READ_QUERY_ID, { skipped: "not_planned", minorActive: priorMinor(a) });
  const g = await gateStep(a, READ_QUERY_ID, [], asOf);
  if ("queryId" in g) return g;

  // ── reuse (workflow_run_id, READ) ──
  const existing = await db.select({ id: researchRuns.id, status: researchRuns.status, summary: researchRuns.summary }).from(researchRuns).where(and(eq(researchRuns.workflow_run_id, a.workflowRunId), eq(researchRuns.query_id, READ_QUERY_ID)));
  const hit = existing.find((r) => r.status === "ok" || r.status === "partial");
  if (hit) { const s = (hit.summary ?? {}) as any; return { ...emptyOutput(READ_QUERY_ID), ran: true, researchRunId: hit.id, status: hit.status as "ok" | "partial", completed: !!s.step?.completed, chunks: s.step?.chunks ?? 0, accepted: s.accepted ?? {}, minorActive: priorMinor(a), reused: true, gate: g.gate, ...(s.step?.read ? { read: s.step.read } : {}) }; }
  for (const r of existing) if (r.status === "running") await closeRunFailed(r.id, { reason: "abandoned", message: "a previous attempt of this workflow step did not close its research run" }, secrets);

  // ── the candidate pool (deterministic; no model call yet). URLs come ONLY from what grounding retrieved in this run. ──
  const ctx = await athleteContext(a.athleteId);
  if (!ctx) throw new Error(`Athlete ${a.athleteId} not found`);
  const th = GROUNDED_READ_MATCH;
  const resolved = new Map<string, string | null>();
  let resolutions = 0;
  /** A chunk's link → the real URL: a grounding redirect is resolved once (cached; at most th.maxResolutions); another retrieved link is used as is. */
  const realUrlOf = async (url: string): Promise<string | null> => {
    if (!isGroundingRedirectUrl(url)) return url;
    if (resolved.has(url)) return resolved.get(url) ?? null;
    if (!providers.resolveRedirect || resolutions >= th.maxResolutions) return null;
    resolutions++;
    const real = await providers.resolveRedirect(url).catch(() => null);
    resolved.set(url, real);
    return real;
  };
  const hints = await mediaHintsFor(a.workflowRunId);
  const rawChunks = await groundedChunksFor(a.workflowRunId);
  const skipped: Required<ReadSkipped> = { unreadable: 0, alreadyRead: 0, duplicate: 0, overCap: 0, ungrounded: 0, video_unavailable: 0 };
  const skippedSources: NonNullable<V3ReadRecord["skippedSources"]> = [];

  // ── what each retrieved chunk is, from grounding-derived data only (live web.title is just the domain) ──
  // Resolve the chunk links BEFORE matching (bounded; Q3's chunks and chunks on a domain the model's items name first), dedupe by
  // the resolved URL, and give each chunk its match text: a YouTube video's oEmbed title (a video oEmbed does not know is
  // unavailable), else the resolved URL's path slug. The model's URL is never a fallback.
  const itemDomains = new Set(hints.flatMap((h) => [registrableDomain(h.claimedUrl && !isGroundingRedirectUrl(h.claimedUrl) ? hostOf(h.claimedUrl) : null), outletDomainLabel(h.outlet)]).filter((d): d is string => !!d));
  const priority = (c: GroundedChunk) => (c.chunkId.startsWith("Q3:") ? 0 : 1) + (itemDomains.has(registrableDomain(c.domain) ?? "") || itemDomains.has(domainLabel(c.domain) ?? "") ? 0 : 1);
  const ordered = [...rawChunks].sort((x, y) => priority(x) - priority(y) || (x.chunkId < y.chunkId ? -1 : x.chunkId > y.chunkId ? 1 : 0));
  const chunks: GroundedChunk[] = [];
  const seenReal = new Set<string>();
  let videoChecks = 0;
  for (const c of ordered) {
    const real = await realUrlOf(c.url);
    if (!real) continue;                                                   // unresolved (or past the bound): nothing to match or read
    const key = readKeyUrl(real);
    if (seenReal.has(key)) continue;
    seenReal.add(key);
    let videoTitle: string | null = null;
    if (youtubeVideoUrl(real) && providers.videoInfo) {
      if (videoChecks >= th.maxVideoChecks) continue;
      videoChecks++;
      const info = await providers.videoInfo(youtubeVideoUrl(real)!).catch(() => ({ exists: false, title: null }));
      if (!info.exists) { skipped.video_unavailable++; skippedSources.push({ reason: "video_unavailable", evidenceId: null, title: null, url: youtubeVideoUrl(real)!, ...(real !== c.url ? { discoveredUrl: c.url } : {}) }); continue; }
      videoTitle = info.title;
    }
    chunks.push({ ...c, title: chunkMatchText(c.title, c.domain, real, videoTitle) || null });
  }
  const pool = groundedCandidates(hints, chunks, { resolved, surname: surnameToken(ctx.a.full_name), thresholds: th });
  skipped.ungrounded = pool.ungrounded.length;
  skippedSources.unshift(...pool.ungrounded.map((h) => ({ reason: "ungrounded" as const, evidenceId: h.evidenceId, title: h.title })));
  // Platform-host ownership (resolveSourceType) is matched against the handles Nomila already holds for her.
  const knownHandles = [...Object.values(ctx.hints.knownHandles ?? {}), ...Object.values(ctx.anchor.handles ?? {})];
  const ranked = rankReadCandidates(pool.candidates, knownHandles);
  const alreadyRead = await readKeysAlreadyRead(a.athleteId);
  const maxAttempts = researchTargetedReadMaxAttempts();
  const record: V3ReadRecord = { spec: SOURCE_READ_VERSION, max, maxAttempts, candidates: ranked.length, skipped, sources: [], skippedSources };

  // The walk: the next readable candidate in rank order (links already resolved above), or null at the end of the pool.
  let cursor = 0;
  const seenKeys = new Set<string>();
  const nextTarget = async (): Promise<ReadTarget | null> => {
    while (cursor < ranked.length) {
      const c = ranked[cursor++];
      const real = await realUrlOf(c.url);
      const discoveredUrl = real && real !== c.url ? c.url : undefined;
      const t = real ? toReadTarget({ ...c, url: real, ...(discoveredUrl ? { discoveredUrl } : {}) }, knownHandles) : null;
      const pass = (reason: "unreadable" | "alreadyRead" | "duplicate" | "video_unavailable") => {
        skipped[reason]++;
        record.skippedSources!.push({ reason, evidenceId: c.evidenceId, title: c.title, ...(t ? { url: t.readUrl } : {}), ...(discoveredUrl ? { discoveredUrl } : {}) });
      };
      if (!t) { pass("unreadable"); continue; }
      if (alreadyRead.has(t.key)) { pass("alreadyRead"); continue; }
      if (seenKeys.has(t.key)) { pass("duplicate"); continue; }
      seenKeys.add(t.key);
      return t;   // a YouTube video here already passed the oEmbed check above
    }
    return null;
  };
  const first = await nextTarget();
  if (!first) return emptyOutput(READ_QUERY_ID, { skipped: "no_read_candidates", read: record, gate: g.gate, minorActive: priorMinor(a) });
  if (!providers.read) throw new Error("research_refresh v3: no source-read provider is bound");

  const policy = await policyFor(a);
  const subject = { fullName: ctx.a.full_name, sport: ctx.a.sport ?? "", anchor: ctx.searchAnchor, isMinor: priorMinor(a) };

  // ── open the row BEFORE the first call (the ledger counts on it) ──
  // The read has its OWN allowance: RESEARCH_TARGETED_READ_MAX_ATTEMPTS calls counted on the READ row alone, separate from the
  // Q1–Q6 per-run budget (maxCallsPerRun, unchanged). The daily limit (maxLlmCallsPerNight) still applies to every read.
  const [run] = await db.insert(researchRuns).values({ athlete_id: a.athleteId, domain: "refresh", trigger: a.plan.trigger, status: "running", started_at: asOf, as_of: asOf, workflow_run_id: a.workflowRunId, query_id: READ_QUERY_ID, providers: [{ role: "read", provider: "gemini_direct", model: null }] as any, summary: { plan: { domains: [] }, reason: a.plan.reason } as any }).returning({ id: researchRuns.id });
  const runId = run.id;
  const readPolicy: ResearchPolicy = { ...policy, planner: { ...policy.planner, maxCallsPerRun: maxAttempts } };
  const reserve = () => reserveLlmCall(runId, { policy: readPolicy, asOf, capGroup: { runIds: [runId] } });
  try {
    const envelopes: SearchEnvelope[] = [];
    const claims: ExtractedClaim[] = [];
    const attempted: ReadTarget[] = [];
    let refused = false, successes = 0, calls = 0;
    // Backfill: a failed read (call made, source not read) moves on to the next candidate; stop at `max` successful reads,
    // `maxAttempts` model calls, a budget refusal, or the end of the pool.
    for (let t: ReadTarget | null = first; t; t = successes < max && calls < maxAttempts ? await nextTarget() : null) {
      const request = sourceReadRequest(subject, t, asOfStr);
      assertReadRequestClean(request);
      const envelopeId = `r${attempted.length}`;
      attempted.push(t);
      const who = { ...(t.discoveredUrl ? { discoveredUrl: t.discoveredUrl } : {}), evidenceId: t.evidenceId, origin: t.origin ?? "item" };
      const res = await providers.read({ url: t.readUrl, mode: t.mode, request, envelopeId }, { reserve, timeoutMs: policy.planner.geminiCallTimeoutMs });
      if (res.refused) { refused = true; record.sources.push({ url: t.readUrl, ...who, mode: t.mode, completed: false, refused: true, claims: 0, statements: 0, paraphrases: 0, dropped: null, error: res.error }); break; }   // no call was made: stop
      calls += Math.max(1, res.attempts);
      const parsed = res.completed ? parseSourceRead(res.text) : null;
      const mapped = parsed ? mapSourceRead(parsed, t, envelopeId) : null;
      // "Read" for reuse: the model answered, the answer parsed and it says it could read the source (a not-about-her answer counts as read).
      const done = res.completed && !!parsed && !parsed.parseError && parsed.source.read !== false;
      if (done) successes++;
      res.envelope.request = { ...res.envelope.request, params: { ...((res.envelope.request as any).params ?? {}), sourceKey: t.key, completed: done, candidateEvidenceId: t.evidenceId, candidateOrigin: t.origin ?? "item", ...(t.discoveredUrl ? { discoveredUrl: t.discoveredUrl } : {}) } };
      envelopes.push(res.envelope);
      for (const m of mapped?.claims ?? []) claims.push({ ...(m as unknown as ExtractedClaim), claim: { ...m.claim, item: m.item, registryStatus: m.registryStatus, mappingVersion: m.mappingVersion, ...(m.unmappedFields.length ? { unmappedFields: m.unmappedFields } : {}) } });
      record.sources.push({ url: t.readUrl, ...who, mode: t.mode, completed: done, refused: false, claims: mapped?.claims.length ?? 0, statements: mapped?.statements ?? 0, paraphrases: mapped?.paraphrases ?? 0, dropped: mapped?.dropped ?? (parsed?.parseError ? `unparseable: ${parsed.parseError.slice(0, 120)}` : null), error: res.error });
    }
    skipped.overCap = ranked.length - cursor;   // candidates never reached (the walk stopped first)
    const completed = record.sources.some((x) => x.completed);
    const extraction: ExtractionEnvelope = {
      id: "r-map", provider: "gemini_direct", model: envelopes[0]?.model, schemaVersion: SOURCE_READ_VERSION, fetchedAt: new Date().toISOString(),
      claims, inferences: [], domainOutcomes: {},
      raw: { version: RESEARCH_REFRESH_V3_STAGE, readSpec: SOURCE_READ_VERSION, itemMapping: ITEM_MAPPING_VERSION, read: record },
      request: { path: "source-read-mapping", params: { readSpec: SOURCE_READ_VERSION, targets: attempted.map((t) => ({ url: t.readUrl, mode: t.mode, rank: t.rank })) } },
      errors: refused ? [{ step: "read", message: "budget refused", class: "refused" }] : [], parseError: null,
    };
    const identitySignal = await hasIdentitySignal(a.athleteId);
    const step = { queryId: READ_QUERY_ID, completed, chunks: envelopes.length, minorActive: priorMinor(a), read: record };
    const persisted = await persistResearchRun({
      athleteId: a.athleteId, runId, workflowRunId: a.workflowRunId, trigger: a.plan.trigger, domain: "refresh", hints: ctx.hints, search: envelopes, extraction, signals: [],
      assertions: await assertionsFor(a.athleteId), hasAssertedAffiliations: ctx.hasAssertedAffiliations, identityResolved: identitySignal, identityConfidence: identitySignal ? 1 : undefined, secrets, asOf, retrievedAt: asOf,
      plan: { domains: [], acceptance: READ_ACCEPTANCE, settle: [], queryStatus: {}, dueToDispute: [] },
      queryId: READ_QUERY_ID, summaryExtra: { step, reason: a.plan.reason },
    });
    if (!persisted) await closeRunFailed(runId, { reason: "persist_null", message: "persist wrote nothing" }, secrets);
    logger.info({ athleteId: a.athleteId, workflowRunId: a.workflowRunId, runId, read: record.sources.map((x) => ({ mode: x.mode, completed: x.completed, statements: x.statements })) }, "research_refresh v3 targeted read");
    return { ...emptyOutput(READ_QUERY_ID), ran: true, researchRunId: runId, status: persisted ? persisted.status : "failed", completed, chunks: envelopes.length, accepted: persisted?.accepted ?? {}, minorActive: priorMinor(a), read: record, gate: g.gate };
  } catch (err: any) {
    await closeRunFailed(runId, { reason: "error", message: redactMessage(err?.message ?? err, secrets) }, secrets).catch(() => {});
    throw err;
  }
}
