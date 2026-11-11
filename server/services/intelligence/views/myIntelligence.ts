/**
 * views/myIntelligence.ts — Concept 0.4 Slice 2, the `my-intelligence/0.1` read model (FROZEN contract, 1 Oct 2026,
 * with the user's decisions D-1..D-3) behind GET /api/v1/me/intelligence, and the Me entry point that replaces
 * `MeOverview.intelligence { status: "coming" }` (O-10).
 *
 * WHAT IT READS, AND ONLY THAT:
 *   - the assessment of record through getMarketability() — the ONE reader of the ledger; no ledger query here;
 *   - State's labels by CALLING findingsFromMia (its 75/45 bands and imputed-share rule are never restated here);
 *   - citation strength from the LEDGER row with citationStrength() — never State's merged `citedEvidence` list;
 *   - identity from E3's readResearchStatus().identity, and only while identityResolutionEnabled() is on;
 *   - the active M.I.A. evaluation workflow run (via the orchestrator) that H1 would permit (D-1) — never E3 Axis 1 / Q1–Q6 research activity;
 *   - the bridge (requests, goals, review count) only behind their own flags.
 *
 * WHAT IT NEVER CARRIES: assumed counts (imputedShare), an ASSUMED signal's value, a score for an unknown dimension, any
 * threshold, numeric `value.confidence`, `identityConfidence`, drivers/composite, actions or URLs for identity (D-2).
 * Under an ambiguous or failed identity the assessment is withheld HERE, server-side: it is absent from the payload (O-6).
 *
 * 0.2 (My Intelligence 6b, Oct 2026 — additive, read-only, no new computation): each dimension also carries the ledger
 * row's stored `weight` and `contribution` (score × weight, what sizes the ring's bands) and its `signals` — the row's
 * NormalizedSignal values by key, with the source class and the imputed flag. A measured or researched signal carries
 * its value; an IMPUTED one carries `value: null` (a prior is never served as her number — it is listed only so the
 * client can say what connecting would resolve). `bridge.waitingOnYou.items[]` also carries the request's `sourceClass`
 * (who the evidence must come from), so the client can show only what she herself can resolve.
 *
 * Oct 2026 (same shape): a citation M.I.A. cannot back — not_support (asserted_only, unsupported) or unrecorded (no
 * grounding record) — is no longer sent: it is absent from `evidence`, from each dimension's and component's sources and
 * so from every count. `sources` still carries every strength key; those two are always empty. The ledger keeps them.
 *
 * Read-only: SELECTs only, no provider, no writes. Copy is the client's job; the contract carries reason codes only.
 */

import { getMarketability, readActiveEvaluations, type CurrentMarketability } from "../../marketabilityBeta1Orchestrator";
import { findingsFromMia } from "../state/build";
import { citationStrength, type CitationStrength, type LedgerEvidenceCitation } from "../contracts/intelligenceLedger";
import type { FindingDirection } from "../contracts/athleteState";
import { MARKETABILITY_DIMENSIONS, type MarketabilityDimension } from "../types";
import type { IdentityValue } from "../research/identityResolution";
import { currentStatusConfig, readResearchStatus, type IdentityBasis, type ResearchStatusConfig } from "../research/status";
import { isMemoryAthlete, readMemoryIdentity } from "../../miaPreview/memoryAdapter";
import { readPreviewMeta, type MiaSharpen } from "../../miaPreview/previewMeta";

export const MY_INTELLIGENCE_CONTRACT = "my-intelligence/0.2" as const;

// ── the contract (frozen) ─────────────────────────────────────────────────────

export type PageState =
  | "identity_ambiguous"     // S6b  flag on, identity ambiguous — assessment withheld (O-6)
  | "identity_failed"        // S6c  flag on, identity failed — assessment withheld (O-6)
  | "identity_pending"       // S6a  flag on, identity pending — assessment shown if present, with a line
  | "identity_not_started"   // S6-NULL flag on, identity NULL, no assessment
  | "updating"               // S5   no assessment, an M.I.A. evaluation in flight            [D-1]
  | "no_assessment"          // S4
  | "insufficient"           // S3   all eight dimensions unknown
  | "assessed_partial"       // S2   one to seven unknown
  | "assessed";              // S1

export type ReadState = "assessed" | "assessed_partial" | "insufficient";
export type Level = "HIGH" | "MEDIUM" | "LOW";
export type ComponentEvidenceClass = "MEASURED" | "EVALUATED" | "ASSUMED" | "MISSING";
/** The ledger's SourceClass (types.ts), verbatim; null when the row did not record one. */
export type SignalSource = "connected_verified" | "platform_public" | "web_researched" | "inferred" | "imputed";

/** 0.2: one stored sub-signal of a dimension. An imputed signal never carries its value. */
export interface MyIntelligenceSignal {
  key: string;
  value: number | null;                         // 0–100 when measured / researched; null when imputed
  source: SignalSource | null;
  imputed: boolean;
}

export interface MyIntelligenceIdentity {
  value: IdentityValue;                         // null = no determination recorded (NOT pending)
  basis: IdentityBasis | null;                  // "q1" | "athlete_confirmed" | "athlete_rejected"
  reason: string | null;                        // AmbiguousReason | "no_public_match" | null — the D-3 copy key
  determinedAt: string | null;                  // null while pending
}

export interface MyIntelligenceDimension {
  key: MarketabilityDimension;
  state: FindingDirection;                      // State's, verbatim; `neutral` carried, the client shows no label (O-2)
  score: number | null;                         // 0–100; null when state === "unknown" (O-3) or absent
  confidence: Level | null;
  confidenceReason: string | null;
  rationale: string | null;                     // "Nomila's interpretation" (O-11)
  components: Array<{
    key: string;
    evidenceClass: ComponentEvidenceClass;
    confidence: Level | null;
    rationale: string | null;
    sources: string[];                          // support-eligible evidence ids only (no not_support, no dangling)
  }>;                                           // no `value` (O-4)
  sources: Record<CitationStrength, string[]>;  // every key present; not_support and unrecorded always empty (Oct 2026)
  /** 0.2: the row's stored top-level weight and score × weight; null when the row holds no scored dimension. */
  weight: number | null;
  contribution: number | null;
  /** 0.2: the row's stored sub-signals (see MyIntelligenceSignal); [] when the row holds none. */
  signals: MyIntelligenceSignal[];
}

export interface MyIntelligenceEvidence {
  id: string; claim: string;
  sourceTitle: string | null; sourceUrl: string | null; sourceType: string | null; observedAt: string | null;
  strength: CitationStrength;
  domain: string | null;
}

export interface MyIntelligenceAssessment {
  entryId: string;
  evidenceAsOf: string;
  createdAt: string;
  versions: { methodology: string | null; evaluator: string | null; params: string | null };
  score: number;
  readState: ReadState;
  overall: { level: Level | null; explanation: string | null };
  confidenceBand: null;
  summary: string | null;
  hasReasons: boolean;
  dimensions: MyIntelligenceDimension[];
  evidence: MyIntelligenceEvidence[];
  notes: { strengths: string[]; constraints: string[]; missingEvidence: string[]; evaluationRisks: string[] };
}

/**
 * Additive (Oct 2026, M.I.A. preview): for a new-agent athlete (memory_facts) the read is a PREVIEW built from her
 * memory; this says whether it is preliminary and what would sharpen it. Null for everyone else.
 */
export interface MyIntelligencePreview {
  preliminary: boolean;
  /** "Preliminary — connect to sharpen" while preliminary; null otherwise. */
  label: string | null;
  inputs: { public: number; measured: number };
  sharpen: MiaSharpen[];
}

export interface MyIntelligenceView {
  contract: typeof MY_INTELLIGENCE_CONTRACT;
  athleteId: string;
  asOf: string;
  pageState: PageState;
  /** null ⇔ identityResolutionEnabled() is false. Never null-as-pending. */
  identity: MyIntelligenceIdentity | null;
  /** An M.I.A. evaluation is in flight and would be permitted by H1. [D-1] */
  inProgress: boolean;
  /** null when there is no assessment of record, OR it is withheld (identity_ambiguous / identity_failed). */
  assessment: MyIntelligenceAssessment | null;
  movement: { displayable: false; reason: "no_governed_stability_threshold" };
  /** Additive: the M.I.A. preview's labels for a new-agent athlete (see MyIntelligencePreview); null otherwise. */
  preview: MyIntelligencePreview | null;
  /**
   * Additive (agent research refresh, 12 Oct 2026): her identity is now uncertain (memory holds an unsettled disputed
   * identity fact) but she has a score of record — the LAST read is shown, flagged, instead of being withheld. No new
   * read is made until it settles (the evaluation gate). null otherwise.
   */
  identityUnconfirmed: null | { reason: "disputed_identity_fact"; since: string | null };
  bridge: {
    waitingOnYou: null | {
      count: number;
      items: Array<{ requestId: string; status: string; nomilaSays: string; sheAsked: string | null; cta: { kind: "add_contract" | "add_document"; label: string } | null; sourceClass: "athlete" | "connected" | "external" }>;
    };
    goals: null | Array<{
      objectiveId: string;
      domain: string;
      text: string;
      buildsOn: MarketabilityDimension[];
      fromEarlierRead: boolean;
    }>;
    reviewCount: number | null;
  };
}

/** The Me entry point (O-10). Derived from a built view only, so Me can never show a score the page withholds. */
export interface MyIntelligenceEntry {
  status: "ready";
  pageState: PageState;
  score: number | null;
  evidenceAsOf: string | null;
  /** Additive: true while a new-agent athlete's shown read is a preliminary preview; null when not a preview. */
  preliminary: boolean | null;
  /** Additive: the shown read is her LAST one, kept while her identity is unconfirmed (view.identityUnconfirmed). */
  identityUnconfirmed?: boolean;
}

// ── the state function (one, shared by the page and the Me slot) ──────────────

const STRENGTHS: readonly CitationStrength[] = ["grounded", "site_only", "nomila_supplied", "not_support", "unrecorded"];
const LEVELS: readonly string[] = ["HIGH", "MEDIUM", "LOW"];
const CLASSES: readonly string[] = ["MEASURED", "EVALUATED", "ASSUMED", "MISSING"];
const SIGNAL_SOURCES: readonly string[] = ["connected_verified", "platform_public", "web_researched", "inferred", "imputed"];
/** The strengths the payload carries. not_support and unrecorded stay in the ledger only (see projectAssessment). */
const SHOWN: ReadonlySet<CitationStrength> = new Set<CitationStrength>(["grounded", "site_only", "nomila_supplied"]);

/** Rules 7–9 applied to a read: every dimension unknown ⇒ insufficient; some ⇒ partial; none ⇒ assessed. */
export function readStateOf(dimensions: ReadonlyArray<{ state: FindingDirection }>): ReadState {
  const unknown = dimensions.filter((d) => d.state === "unknown").length;
  return unknown === dimensions.length ? "insufficient" : unknown > 0 ? "assessed_partial" : "assessed";
}

/**
 * THE state selection (frozen contract, first match wins):
 *   ambiguous/failed > pending > not started > updating > no assessment > insufficient > partial > assessed.
 * `readState` is the read of record's own rules 7–9 (null when there is no read). `withheld` tells the caller to drop
 * the assessment from the payload (O-6). Pure: the page and the Me slot both go through it via buildMyIntelligence.
 */
export function selectPageState(i: {
  identity: MyIntelligenceIdentity | null;
  readState: ReadState | null;
  inProgress: boolean;
}): { pageState: PageState; withheld: boolean } {
  const flagOn = i.identity !== null;
  const v = i.identity?.value ?? null;
  if (flagOn && v === "ambiguous") return { pageState: "identity_ambiguous", withheld: true };
  if (flagOn && v === "failed") return { pageState: "identity_failed", withheld: true };
  if (flagOn && v === "pending") return { pageState: "identity_pending", withheld: false };
  if (flagOn && v === null && i.readState === null) return { pageState: "identity_not_started", withheld: false };
  if (i.readState === null) return { pageState: i.inProgress ? "updating" : "no_assessment", withheld: false };
  return { pageState: i.readState, withheld: false };
}

/** H1's gate, mirrored on the identity this view already read: permitted ⇔ boundary off, or identity resolved. */
export const h1WouldPermit = (identity: MyIntelligenceIdentity | null): boolean =>
  identity === null || identity.value === "resolved";

/**
 * [D-1] Is one active mia_evaluation run (status running|waiting) going to evaluate? A run whose `snapshot` step
 * already returned `blocked` (H1), `skipped`, or `unchanged: true` without `force` will not; any other active run may.
 * Pure over what the reader fetched. A finished run never counts: whether a new read exists is the ledger's answer.
 */
export function runMayEvaluate(run: { input: unknown; snapshotOutput: unknown }): boolean {
  const out = run.snapshotOutput as Record<string, unknown> | null | undefined;
  if (!out || typeof out !== "object") return true;
  if ("blocked" in out || "skipped" in out) return false;
  const force = !!(run.input as { force?: unknown } | null)?.force;
  return !(out.unchanged === true && !force);
}

/** The Me slot: a projection of the page's own view, never a second read. */
export function myIntelligenceEntry(view: MyIntelligenceView): MyIntelligenceEntry {
  return {
    status: "ready",
    pageState: view.pageState,
    score: view.assessment?.score ?? null,
    evidenceAsOf: view.assessment?.evidenceAsOf ?? null,
    preliminary: view.preview && view.assessment ? view.preview.preliminary : null,
    ...(view.identityUnconfirmed && view.assessment ? { identityUnconfirmed: true } : {}),
  };
}

// ── the assessment projection (pure) ──────────────────────────────────────────

const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const level = (x: unknown): Level | null => (typeof x === "string" && LEVELS.includes(x) ? (x as Level) : null);

/**
 * 0.2: the row's stored sub-signals for one dimension (DimensionScore.signals), by key. An imputed signal (the flag, or
 * source "imputed") never carries its value. Pure over the row; nothing is recomputed.
 */
export function projectSignals(signals: unknown): MyIntelligenceSignal[] {
  if (!Array.isArray(signals)) return [];
  const out: MyIntelligenceSignal[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    const key = str(s?.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const source = typeof s?.source === "string" && SIGNAL_SOURCES.includes(s.source) ? (s.source as SignalSource) : null;
    const imputed = s?.imputed === true || source === "imputed";
    out.push({ key, value: imputed ? null : num(s?.value), source, imputed });
  }
  return out;
}
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
const hostOf = (url: string | null): string | null => { if (!url) return null; try { return new URL(url).host || null; } catch { return null; } };
const emptySources = (): Record<CitationStrength, string[]> =>
  Object.fromEntries(STRENGTHS.map((k) => [k, [] as string[]])) as unknown as Record<CitationStrength, string[]>;

/**
 * The read of record → `assessment` (contract shape, every field explicit so nothing else rides along). `readState` is
 * included; whether the result reaches the payload is selectPageState's call.
 */
export function projectAssessment(a: CurrentMarketability): MyIntelligenceAssessment {
  const value = (a.value ?? {}) as Record<string, any>;
  const ledgerFindings: any[] = Array.isArray(value.findings) ? value.findings : [];
  const findingByKey = new Map<string, any>(ledgerFindings.map((f) => [String(f?.key), f]));
  const evidenceRows: LedgerEvidenceCitation[] = (Array.isArray(value.evidence) ? value.evidence : [])
    .filter((e: any) => e && typeof e.id === "string");
  const evidenceById = new Map<string, LedgerEvidenceCitation>(evidenceRows.map((e) => [e.id, e]));
  // Strength from the LEDGER row's own lineage — the one classification every consumer shares. A citation that cannot
  // be backed (not_support: asserted_only / unsupported; unrecorded: no grounding record) is treated like a dangling id:
  // absent from the evidence list, the sources and the counts. The ledger keeps it.
  const strengthOf = (id: string): CitationStrength | null => { const e = evidenceById.get(id); const s = e ? citationStrength(e) : null; return s && SHOWN.has(s) ? s : null; };

  // State's conclusions, by calling State. Keys come back as `mia.<dim>`.
  const stateFindings = findingsFromMia({ id: a.entryId, value, evidence_as_of: new Date(a.evidenceAsOf) });
  const stateByDim = new Map(stateFindings.map((f) => [f.key.replace(/^mia\./, ""), f]));
  const scoredByDim = new Map<string, any>((Array.isArray(value.dimensions) ? value.dimensions : []).map((d: any) => [String(d?.dimension), d]));

  const dimensions: MyIntelligenceDimension[] = MARKETABILITY_DIMENSIONS.map((key) => {
    const sf = stateByDim.get(key);
    if (!sf) {
      // Absent from the row: unknown, and nothing else claimed about it.
      return { key, state: "unknown" as const, score: null, confidence: null, confidenceReason: null, rationale: null, components: [], sources: emptySources(), weight: null, contribution: null, signals: [] };
    }
    const lf = findingByKey.get(key);
    const scored = scoredByDim.get(key);
    const rawScore = typeof lf?.value === "number" ? lf.value : typeof scored?.score === "number" ? scored.score : null;
    const sources = emptySources();
    for (const id of strings(lf?.citedEvidence)) {
      const s = strengthOf(id);
      if (s && !sources[s].includes(id)) sources[s].push(id);   // dangling (unresolved) ids are never rendered
    }
    const components = (Array.isArray(lf?.components) ? lf.components : []).map((c: any) => ({
      key: String(c?.key ?? ""),
      evidenceClass: (CLASSES.includes(c?.evidenceClass) ? c.evidenceClass : "EVALUATED") as ComponentEvidenceClass,
      confidence: level(c?.confidence),
      rationale: str(c?.rationale),
      sources: [...new Set(strings(c?.citedEvidence).filter((id) => strengthOf(id) !== null))],
    }));
    return {
      key,
      state: sf.direction,
      score: sf.direction === "unknown" ? null : rawScore,
      confidence: level(lf?.confidence),
      confidenceReason: str(lf?.confidenceReason),
      rationale: str(lf?.rationale),
      components,
      sources,
      // 0.2: the row's own weight and contribution, never recomputed here; the signals as stored, imputed values withheld.
      weight: num(scored?.weight),
      contribution: num(scored?.contribution),
      signals: projectSignals(scored?.signals),
    };
  });

  const oc = value.overallConfidence && typeof value.overallConfidence === "object" ? value.overallConfidence : null;
  const notes = (value.notes && typeof value.notes === "object" ? value.notes : {}) as Record<string, unknown>;
  const versions = (a.versions ?? {}) as Record<string, unknown>;

  return {
    entryId: a.entryId,
    evidenceAsOf: a.evidenceAsOf,
    createdAt: a.createdAt,
    versions: { methodology: str(versions.methodology), evaluator: str(versions.evaluator), params: str(versions.params) },
    score: value.score,
    readState: readStateOf(dimensions),
    overall: { level: level(oc?.level), explanation: str(oc?.explanation) },
    confidenceBand: null,
    summary: str(value.summary),
    hasReasons: Array.isArray(value.findings),
    dimensions,
    evidence: evidenceRows.filter((e) => SHOWN.has(citationStrength(e))).map((e) => {
      const sourceUrl = str(e.sourceUrl);
      return {
        id: e.id,
        claim: typeof e.claim === "string" ? e.claim : "",
        sourceTitle: str(e.sourceTitle), sourceUrl, sourceType: str(e.sourceType), observedAt: str(e.observedAt),
        strength: citationStrength(e),
        domain: hostOf(sourceUrl),
      };
    }),
    notes: {
      strengths: strings(notes.strengths), constraints: strings(notes.constraints),
      missingEvidence: strings(notes.missingEvidence), evaluationRisks: strings(notes.evaluationRisks),
    },
  };
}

// ── the reader (SELECTs only) ─────────────────────────────────────────────────

/** [D-1] True when one of her active M.I.A. evaluation runs (read by the orchestrator, which owns the process) may still evaluate. */
async function evaluationInFlight(athleteId: string): Promise<boolean> {
  return (await readActiveEvaluations(athleteId)).some(runMayEvaluate);
}

/**
 * The M.I.A. score a surface may say, or null — the same number My Intelligence shows (null when there is no
 * assessment or the page withholds it). For prompt contexts that used to read the legacy
 * athletes_current.display_score (legacy retirement, phase 1).
 */
export async function miaScoreFor(athleteId: string): Promise<number | null> {
  return (await buildMyIntelligence(athleteId)).assessment?.score ?? null;
}

export async function buildMyIntelligence(athleteId: string, opts: { now?: Date; config?: ResearchStatusConfig } = {}): Promise<MyIntelligenceView> {
  const now = opts.now ?? new Date();
  const config = opts.config ?? currentStatusConfig();

  // New-agent athletes: identity comes from memory (an unsettled disputed identity fact withholds the read), never from
  // athlete_research_state, and whatever the legacy flag says. Everyone else: unchanged.
  const memory = await isMemoryAthlete(athleteId);
  let identity: MyIntelligenceIdentity | null = null;
  if (memory) {
    const mi = await readMemoryIdentity(athleteId);
    if (mi.uncertain) identity = { value: "ambiguous", basis: null, reason: "disputed_identity_fact", determinedAt: mi.since };
  } else if (config.identityResolutionEnabled) {
    const i = (await readResearchStatus(athleteId, { asOf: now, config })).identity;   // Axis 2 only; Axis 1 is never read [D-1]
    identity = { value: i.value, basis: i.basis, reason: i.reason, determinedAt: i.determinedAt };
  }

  const record = await getMarketability(athleteId);
  const projected = record ? projectAssessment(record) : null;
  // KEEP THE LAST READ: a memory athlete whose identity is now uncertain but who has a score of record (an older
  // athlete's first research refresh could not confirm her public profile) keeps seeing it, flagged; never held silently.
  let identityUnconfirmed: MyIntelligenceView["identityUnconfirmed"] = null;
  if (memory && identity?.value === "ambiguous" && identity.reason === "disputed_identity_fact" && projected) {
    identityUnconfirmed = { reason: "disputed_identity_fact", since: identity.determinedAt };
    identity = null;
  }
  // Condition (a) first: a run H1 would block is not "updating", whatever its steps say.
  const inProgress = h1WouldPermit(identity) ? await evaluationInFlight(athleteId) : false;
  const { pageState, withheld } = selectPageState({ identity, readState: projected?.readState ?? null, inProgress });
  const assessment = withheld ? null : projected;

  let preview: MyIntelligencePreview | null = null;
  if (memory) {
    const meta = await readPreviewMeta(athleteId, assessment ? record : null);
    preview = { preliminary: meta.preliminary, label: meta.label, inputs: { public: meta.inputs.public.length, measured: meta.inputs.measured.length }, sharpen: meta.sharpen };
  }

  // The retired intelligence requests: nothing is ever waiting here now (the key stays for older app builds).
  const waitingOnYou: MyIntelligenceView["bridge"]["waitingOnYou"] = null;

  // The retired Objectives (OBJECTIVES_V1, deleted 2 Nov 2026): no goals and no review count (the keys stay for older app builds).
  const goals: MyIntelligenceView["bridge"]["goals"] = null;
  const reviewCount: number | null = null;

  return {
    contract: MY_INTELLIGENCE_CONTRACT,
    athleteId,
    asOf: now.toISOString(),
    pageState,
    identity,
    inProgress,
    assessment,
    movement: { displayable: false, reason: "no_governed_stability_threshold" },
    preview,
    identityUnconfirmed,
    bridge: { waitingOnYou, goals, reviewCount },
  };
}
