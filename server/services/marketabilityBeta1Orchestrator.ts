/**
 * marketabilityBeta1Orchestrator.ts — the four steps between "something about this athlete changed" and a score of
 * record. It builds evidence, decides whether asking again is worth it, calls the evaluator, scores, and records.
 *
 * IT DOES NOT JUDGE. No threshold, no interpretation, no correction lives here. Anything in this file that looks like
 * an opinion about an athlete is a bug: the evaluator owns qualitative judgment (ADR-017) and the frozen params own
 * the arithmetic. What the orchestrator owns is *when*, *once*, and *which result stands*.
 *
 * THE ORDER IS THE DESIGN: event → coalesce → execute → build a FRESH snapshot → digest → compare → evaluate only if
 * changed. The snapshot is built when the work runs, never when it was scheduled. If Instagram connects at 10:00,
 * YouTube at 10:04 and a social sync lands at 10:07, the run that fires at 10:10 must evaluate the athlete as they are
 * at 10:10 — evaluating a 10:00 capture would spend a real provider call on evidence we already knew was stale. The
 * debounce exists to coalesce ORCHESTRATION, never to freeze evidence.
 *
 * IDEMPOTENCY IS A COST DECISION, NOT A CORRECTNESS ONE. The evaluator is non-deterministic: re-asking the same
 * question samples drift (a measured mean of 20.5 MIA points) rather than learning anything, at ~$0.21 a call. So an
 * unchanged digest skips. A MANUAL refresh is the deliberate exception — it asks anyway, but against a snapshot whose
 * digest is computed the same way, so "same evidence, different answer" stays visible as exactly that.
 */
import { assessmentValueFor, evidenceFor, type ScoredDimension } from "./marketabilityLedgerMapping";
import { groundCitations, groundingContextFor, judgementSourceOf } from "./marketabilityCitationLineage";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { intelligenceLedger, memoryFacts, miaEvaluationRuns, miaEvidenceSnapshots, workflowRuns, workflowSteps } from "../../shared/schema";
import {
  EVALUATOR_VERSION,
  EvaluatorRefusedError, EvaluatorValidationError, callEvaluator, extractJson, judgementsDigest, parseEvaluatorResponse,
} from "./marketabilityBeta1Evaluator";
import { MARKETABILITY_BETA1_VERSION, computeMarketabilityBeta1, type MarketabilityBeta1Input } from "./marketabilityBeta1";
import { buildBeta1Dimensions } from "./marketabilityBeta1Freeze";
import { createBeta1Normalizer } from "./marketabilityBeta1Normalization";
import { loadBeta1Params } from "./marketabilityBeta1Params";
import { type EvidenceSnapshot, type TriggerReason } from "./marketabilityBeta1Snapshot";
import type { NormalizedSignal } from "./intelligence/types";
import type { MarketabilityAssessedEvent } from "./intelligence/contracts/marketabilityEvents";
import type { AssessmentEntry } from "./intelligence/contracts/intelligenceLedger";
import { createLogger } from "../logger";
import { isAgentFrontAthlete } from "./agentFrontAthlete";
import { identityResolutionEnabled } from "./intelligence/research/config";
import { readIdentityState, type IdentityValue } from "./intelligence/research/identityResolution";
import { buildMemoryFactsSnapshot, isMemoryAthlete, readMemoryIdentity } from "./miaPreview/memoryAdapter";
import {
  MIA_FACTS_EVALUATOR_CONDITIONS, MIA_FACTS_EVALUATOR_VERSION_GEMINI_NO_ECHO, MIA_FACTS_PROMPT_VERSION_NO_ECHO, MIA_FACTS_METHODOLOGY_VERSION, MIA_FACTS_PROMPT_VERSION,
  allowedFromSources, citedEvidenceIds, completeEvidence, enforceFactsOnly, evidenceFromSnapshot, factRefs, factsOnlyPrompt, isFactsOnlyBlock, miaFactsEvaluatorProvider,
  miaFactsEvaluatorVersion, notesFrom, resolveFactRefs,
} from "./miaPreview/factsOnlySpec";
import { callFactsEvaluatorOpenAI } from "./miaPreview/factsOnlyOpenAI";

const log = createLogger("mia:orchestrator");

/**
 * Publish MARKETABILITY_ASSESSED. See the contract module for what this does and does not promise — in short, it
 * records the fact and returns; there is no delivery, no subscriber, and no guarantee anything ever learns of it.
 *
 * IT CANNOT FAIL THE ASSESSMENT. The score is already durably written and correct by the time this runs, so a throw
 * here would be catastrophically disproportionate: the `score` step would fail, the runner would retry it, and the
 * retry would re-enter scoreAndRecord — turning a logging error into duplicated ledger history. The guard below makes
 * that repeat a no-op, but a publisher that cannot throw in the first place is the stronger arrangement.
 */
function publishMarketabilityAssessed(event: MarketabilityAssessedEvent): void {
  try {
    log.info({ event }, "MARKETABILITY_ASSESSED");
  } catch (err) {
    log.warn({ err }, "MARKETABILITY_ASSESSED publish failed — the assessment is unaffected");
  }
}

/** The workflow process name. One active run per athlete per scope is what collapses an event cascade into one call. */
export const MIA_EVALUATION_PROCESS = "mia_evaluation";

/**
 * How long events for one athlete collapse together. Ten minutes is long enough to absorb a connect cascade (an
 * athlete linking three platforms in a sitting, each firing a sync that lands minutes apart) and short enough that a
 * person who just connected an account does not sit in front of a stale score wondering whether it worked.
 */
export const MIA_DEBOUNCE_MS = 10 * 60_000;

/**
 * THE IDENTITY GATE (PR H1; research-acquisition architecture, "Invariant: identity before identity-dependent work").
 * No identity-dependent M.I.A. evaluation may run against an unresolved or ambiguous public identity — whatever the
 * trigger: IDENTITY_RESOLVED at signup, SOCIAL_BLOCK_CHANGED after a connect, a manual/admin refresh, or any future one.
 *
 * ONE CHOKE POINT. Every trigger reaches the evaluator only through the mia_evaluation workflow (requestEvaluation →
 * startRun), and that workflow asks this function at EXECUTION time, before any snapshot or provider call. A future
 * trigger is therefore covered without being listed anywhere. Read at execution, like the snapshot, so a debounced run
 * sees identity as it is when the run fires, not as it was when the first event arrived.
 *
 * Behind the ONE shared boundary, identityResolutionEnabled() (PR E design §5.7). Off ⇒ permitted without reading
 * anything: Beta.1 behaviour is byte-for-byte unchanged. On ⇒ permitted only for `resolved`; NULL (no determination
 * recorded, including a missing athlete_research_state row), pending, ambiguous and failed are blocked. No historical-
 * user exceptions. Identity resolution itself (Q1) never passes through here, so it is never blocked by it.
 *
 * A blocked request is not dropped: its workflow run is kept with the reason on its steps (see miaEvaluation.ts). Once
 * identity resolves, requestEvaluationIfOwed (PR H2, below) re-requests it. This gate stays the FINAL guard: the
 * re-trigger and the admin preflight only decide when to ask; a run is still refused here if identity has moved since.
 */
export type MiaIdentityGate =
  | { permitted: true }
  | { permitted: false; reason: "identity_gate"; identity: IdentityValue };

export async function miaIdentityGate(athleteId: string): Promise<MiaIdentityGate> {
  // NEW-AGENT ATHLETES (memory_facts): identity comes from memory, whatever the legacy flag says — a disputed identity
  // fact she has not settled holds the evaluation (miaPreview/memoryAdapter.ts). athlete_research_state is never read.
  if (await isMemoryAthlete(athleteId)) {
    return (await readMemoryIdentity(athleteId)).uncertain ? { permitted: false, reason: "identity_gate", identity: "ambiguous" } : { permitted: true };
  }
  if (!identityResolutionEnabled()) return { permitted: true };
  const identity = (await readIdentityState(athleteId))?.value ?? null;
  return identity === "resolved" ? { permitted: true } : { permitted: false, reason: "identity_gate", identity };
}

export interface SnapshotStepOutput {
  snapshotId: string;
  digest: string;
  evidenceAsOf: string;
  /** True when this digest already produced a successful evaluation — the reason to skip the provider call. */
  unchanged: boolean;
}

export interface EvaluateStepOutput {
  runId: string;
  status: "ok" | "skipped_unchanged" | "failed_validation";
  judgementsDigest?: string;
}

/**
 * Build the athlete's evidence AS IT IS NOW and persist it, with the verdict on whether we have asked this exact
 * question before and got an answer.
 *
 * "Before" means a snapshot whose digest matches AND whose evaluation actually succeeded. A digest that was built,
 * sent, and failed must not suppress the retry — otherwise one provider outage would freeze an athlete's score
 * permanently, and the freeze would look like a decision rather than an accident.
 */
export async function buildAndPersistSnapshot(
  athleteId: string,
  triggerReason: TriggerReason,
  opts: { triggerDetail?: string | null; now?: Date } = {},
): Promise<SnapshotStepOutput | null> {
  // M.I.A. scores only from the facts we hold (4 Nov 2026: the search-enabled evaluator is retired). An athlete with no
  // memory facts has nothing to score from: no snapshot (the snapshot step records "no facts yet"), and nothing searches
  // for her — research fills her memory, and its merge asks for the evaluation then.
  if (!(await isMemoryAthlete(athleteId))) return null;
  const snapshot = await buildMemoryFactsSnapshot(athleteId, triggerReason, opts);
  if (!snapshot) return null;
  return persistSnapshot(snapshot);
}

/** Persist a built snapshot, with the verdict on whether this exact question already has a successful answer. */
export async function persistSnapshot(snapshot: EvidenceSnapshot): Promise<SnapshotStepOutput> {
  const athleteId = snapshot.athleteId;

  const [prior] = await db
    .select({ digest: miaEvidenceSnapshots.digest })
    .from(miaEvidenceSnapshots)
    .innerJoin(miaEvaluationRuns, eq(miaEvaluationRuns.snapshot_id, miaEvidenceSnapshots.id))
    .where(and(
      eq(miaEvidenceSnapshots.athlete_id, athleteId),
      eq(miaEvidenceSnapshots.digest, snapshot.digest),
      eq(miaEvaluationRuns.status, "ok"),
    ))
    .limit(1);

  const [row] = await db.insert(miaEvidenceSnapshots).values({
    athlete_id: snapshot.athleteId,
    name: snapshot.name,
    sport: snapshot.sport,
    social_block: snapshot.socialBlock,
    social_sources: snapshot.socialSources as any,
    evidence_as_of: new Date(snapshot.evidenceAsOf),
    digest: snapshot.digest,
    trigger_reason: snapshot.triggerReason,
    built_at: new Date(snapshot.builtAt),
  }).returning({ id: miaEvidenceSnapshots.id });

  // The snapshot row is written EVEN WHEN we are about to skip. It is the record that we looked, and what we saw —
  // without it, "nothing happened" and "nothing changed" are indistinguishable afterwards.
  return { snapshotId: row.id, digest: snapshot.digest, evidenceAsOf: snapshot.evidenceAsOf, unchanged: !!prior };
}

/**
 * Ask the evaluator, and record what came back — including when it came back unusable.
 *
 * THREE failure classes, deliberately handled differently:
 *   transport   (throws)   a timeout or provider error; the caller retries and gets a new sample
 *   parse       (throws)   malformed or absent JSON — a formatting accident against a stochastic model, so the next
 *                          sample is very likely usable. Recorded as failed_parse, then rethrown to be retried.
 *   refusal     (returns)  parsed cleanly and scored nothing; the evaluator considered the athlete and declined.
 *                          Recorded as failed_validation and NOT retried — the same answer costs ~$0.21 again.
 * Either way there is no ledger entry. A partial assessment is worse than none, and a failure must never supersede a
 * good result: an athlete's score going blank because a provider had a bad minute is a worse outcome than a stale one.
 */
export async function runEvaluation(snapshotId: string, attempt = 1): Promise<EvaluateStepOutput> {
  const [snap] = await db.select().from(miaEvidenceSnapshots).where(eq(miaEvidenceSnapshots.id, snapshotId)).limit(1);
  if (!snap) throw new Error(`snapshot ${snapshotId} not found`);

  const { params } = await loadBeta1Params();
  // Only a facts-only block (miaPreview/factsOnlySpec.ts) is evaluated: the search-enabled frozen call is retired
  // (4 Nov 2026). A snapshot built for it before the deploy is refused here without a call (the step fails; the next
  // trigger builds a facts-only snapshot).
  const factsOnly = isFactsOnlyBlock(snap.social_block);
  if (!factsOnly) throw new Error("this snapshot was built for the retired search-enabled evaluator; it is not evaluated");
  // The provider MIA_FACTS_EVALUATOR_PROVIDER selects (default gemini, the 0.4.0 call; openai is the opt-in 0.5.0 call).
  const provider = miaFactsEvaluatorProvider();
  // 0.6.0 (MIA_FACTS_NO_EVIDENCE_ECHO, Gemini only): the same prompt plus one paragraph; the evidence list is rebuilt below.
  const noEcho = miaFactsEvaluatorVersion(provider) === MIA_FACTS_EVALUATOR_VERSION_GEMINI_NO_ECHO;
  const prompt = factsOnlyPrompt({ name: snap.name, sport: snap.sport }, snap.social_block, noEcho ? MIA_FACTS_PROMPT_VERSION_NO_ECHO : MIA_FACTS_PROMPT_VERSION);
  const startedAt = new Date();

  // Transport failures propagate untouched: the retry policy is the caller's, and swallowing here would turn a
  // retryable blip into a permanent gap in the athlete's history.
  const call = provider === "openai" ? await callFactsEvaluatorOpenAI(prompt, params.config.subWeights) : await callEvaluator(prompt);
  const conditions = "conditions" in call ? call.conditions : MIA_FACTS_EVALUATOR_CONDITIONS;

  const base = {
    snapshot_id: snapshotId, athlete_id: snap.athlete_id,
    evaluator_version: miaFactsEvaluatorVersion(provider), provider, model: call.model,
    raw: { text: call.text, native: call.native, conditions, modelVersion: call.modelVersion, responseId: call.responseId, finishReason: call.finishReason, truncated: call.truncated } as any,
    attempt, cost_usd: call.costUsd.toFixed(4), latency_ms: call.latencyMs, usage: call.usage as any,
    started_at: startedAt, finished_at: new Date(),
  };

  try {
    // A provider-side refusal (OpenAI returns one instead of the schema) is the evaluator declining: not retried.
    if (call.finishReason === "refusal") throw new EvaluatorRefusedError("the provider refused to answer");
    let out = parseEvaluatorResponse(call.text, params.config.subWeights);
    if (factsOnly) {
      // The facts-only contract, held in code: only supplied facts as evidence, care facts for momentum only (never
      // brand_safety), and a signal left with no valid evidence is missing. What changed is kept with the run.
      // The notes and summary come back tagged {text, dimension, evidence_ids} (0.4.0): read from the raw answer and
      // held to the same rules (no personal care fact, no context-only support, no note on a missing dimension).
      // The prompt showed each fact as F1 … Fn (factRefs, from this snapshot's block): resolve them to the full fact ids
      // first, so everything below reads Nomila's ids. A full id cited the old way passes through; a reference the
      // prompt never showed stays unknown and is dropped by enforceFactsOnly.
      const refs = resolveFactRefs(out, notesFrom(extractJson(call.text).json), factRefs(snap.social_block).refs);
      out = refs.output;
      const notes = refs.notes;
      base.raw.factRefs = refs.resolution;
      if (refs.resolution.unknownRefs) log.warn({ athleteId: snap.athlete_id, snapshotId, ...refs.resolution }, "facts-only answer cited fact references the prompt never showed (dropped)");
      // Every Gemini facts-only run: the evidence list is completed from the snapshot the evaluator was sent (the cited
      // facts' own claim, source and date, and their outlet type from memory) BEFORE the contract is enforced, so
      // everything from here on — enforcement, the stored judgements, the ledger's cited evidence — reads the same shape.
      //   0.4.0  the "evidence" echo leaves out some of the facts it cites (a citation with no entry dangles: no source
      //          listed for it on My Intelligence); the echoed items stay as they came and only the omitted ids are added.
      //   0.6.0  (MIA_FACTS_NO_EVIDENCE_ECHO) the evaluator returns "evidence": [], so the completed list IS the rebuild.
      // Only the source listing changes, never a judgement.
      if (provider === "gemini") {
        const completed = completeEvidence(out.evidence, await rebuiltEvidence(snap.social_block, citedEvidenceIds(out, notes), snap.athlete_id));
        out = { ...out, evidence: completed.evidence };
        base.raw.evidenceCompleted = completed.added;
        if (completed.added) log.info({ athleteId: snap.athlete_id, snapshotId, noEcho, echoed: completed.evidence.length - completed.added, added: completed.added }, "facts-only evidence completed from the snapshot");
      }
      const held = enforceFactsOnly(out, allowedFromSources(snap.social_sources), notes);
      out = held.output;
      base.raw.enforcement = held.enforcement;
      if (!out.judgements.some((j) => j.status === "scored")) throw new EvaluatorRefusedError("no signal scored from the supplied facts");
    }
    const [run] = await db.insert(miaEvaluationRuns).values({
      ...base, status: "ok", judgements: out as any, judgements_digest: judgementsDigest(out.judgements),
    }).returning({ id: miaEvaluationRuns.id });
    return { runId: run.id, status: "ok", judgementsDigest: judgementsDigest(out.judgements) };
  } catch (err) {
    if (!(err instanceof EvaluatorValidationError)) throw err;

    // RECORDED EITHER WAY, and the attempt number distinguishes the samples. A retry is a new sample of a
    // non-deterministic model, never a repeat, so every attempt earns its own row — which is also what lets the
    // parse-failure RATE be measured later rather than inferred.
    const status = err.retryable ? "failed_parse" : "failed_validation";
    const [run] = await db.insert(miaEvaluationRuns).values({
      ...base, status, error: err.message,
    }).returning({ id: miaEvaluationRuns.id });

    // A PARSE failure is a formatting accident against a stochastic model: throw, and the step's bounded retry asks
    // again. A REFUSAL is the evaluator having considered the athlete and declined: return, because asking again
    // buys the same answer at ~$0.21. Neither writes a ledger entry — a partial assessment is worse than none.
    if (err.retryable) throw err;
    return { runId: run.id, status: "failed_validation" };
  }
}

/** The evidence list rebuilt from the snapshot for the cited ids (0.4.0: to complete the echo; 0.6.0: the whole list); outlet types are read from memory (one SELECT). */
async function rebuiltEvidence(block: string | null, cited: string[], athleteId: string) {
  const ids = [...new Set(cited.map((x) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(x)?.[0]?.toLowerCase()).filter((x): x is string => !!x))];
  const rows = ids.length
    ? await db.select({ id: memoryFacts.id, sourceType: memoryFacts.source_type }).from(memoryFacts)
      .where(and(eq(memoryFacts.athlete_id, athleteId), inArray(memoryFacts.id, ids)))
    : [];
  const outlet = new Map(rows.map((r) => [String(r.id).toLowerCase(), r.sourceType ?? null]));
  return evidenceFromSnapshot(block, cited, (id) => outlet.get(id) ?? null);
}

export interface ScoreStepOutput {
  ledgerId: string;
  score: number;
  composite: number;
  confidence: number;
  /** False when an older-evidence result arrived late and the current entry was left standing. */
  becameCurrent: boolean;
}

/**
 * Turn judgements into the score of record.
 *
 * Supersession compares EVIDENCE AS-OF, never completion time. Jobs finish out of order — a retried run started at
 * 10:00 can land after a clean run started at 10:20 — and an assessment built on older evidence must never overwrite
 * one built on newer, however recently it happened to finish. When that happens the late result is still written (it
 * is what we believed, and the cost was already paid) and is marked superseded on arrival rather than discarded.
 *
 * Ties break on arrival: a manual refresh produces identical evidence with a fresh answer, and the point of asking
 * again is to stand on the new answer.
 */
export async function scoreAndRecord(runId: string): Promise<ScoreStepOutput | null> {
  const [run] = await db.select().from(miaEvaluationRuns).where(eq(miaEvaluationRuns.id, runId)).limit(1);
  if (!run || run.status !== "ok" || !run.judgements) return null;
  const [snap] = await db.select().from(miaEvidenceSnapshots).where(eq(miaEvidenceSnapshots.id, run.snapshot_id)).limit(1);
  if (!snap) throw new Error(`snapshot ${run.snapshot_id} not found for run ${runId}`);

  const { params, bundle, versions } = await loadBeta1Params();
  // The versions this run was produced under: the frozen evaluator (Beta.1 methodology), or the facts-only one.
  const evaluatorVersion = run.evaluator_version || EVALUATOR_VERSION;
  // Any facts-only version (0.3.0, 0.4.0 …) is the facts methodology; the frozen evaluator is Beta.1.
  const methodology = evaluatorVersion.startsWith("facts-eval-spec/") ? MIA_FACTS_METHODOLOGY_VERSION : MARKETABILITY_BETA1_VERSION;
  const normalizer = createBeta1Normalizer(bundle);
  const judgements = run.judgements as any;
  // Each scored judgement is labelled by what it cites: restating Nomila's connected-account block is connected data,
  // not web research (judgementSourceOf). Classified against this run's own grounding and snapshot.
  const grounding = groundingContextFor(run.raw, snap);
  const supplied = (Array.isArray(snap.social_sources) ? snap.social_sources : []).map((s: any) => String(s?.sourceClass ?? ""));
  const sourceOf = judgementSourceOf(groundCitations([], evidenceFor(judgements), grounding).evidence, supplied, grounding?.suppliedFacts);
  const dimensions = buildBeta1Dimensions(
    { signals: judgements.judgements ?? judgements.signals } as any,
    snap.sport,
    (path, scope) => normalizer.prior(path as never, scope as never) as NormalizedSignal,
    // The SAME subWeights the response was parsed against and the scorer is about to use. One loaded version, three
    // consumers — parse, build, score — so an activated params row can never leave them disagreeing.
    params.config.subWeights,
    // scoringAsOf = evidenceAsOf. An assessment is scored as of the evidence state it assesses, so freshness never
    // depends on when an asynchronous job happened to finish.
    snap.evidence_as_of.toISOString(),
    sourceOf,
  ) as MarketabilityBeta1Input["dimensions"];

  const result = computeMarketabilityBeta1(
    { athleteId: snap.athlete_id, asOf: snap.evidence_as_of.toISOString(), dimensions },
    params,
  );

  // AT-LEAST-ONCE IS THE RUNNER'S CONTRACT: "a step may run twice. Check before writing, or key writes so a repeat is
  // a no-op." A lease expiry or a transient error after the insert would otherwise file a SECOND assessment for the
  // same evaluation run — identical numbers, duplicated history, and the duplicate superseding the original. One
  // assessment per evaluation run is the natural key, so a repeat returns what the first attempt wrote.
  const [already] = await db
    .select({ id: intelligenceLedger.id, supersededBy: intelligenceLedger.superseded_by })
    .from(intelligenceLedger)
    .where(eq(intelligenceLedger.evaluation_run_id, runId))
    .limit(1);
  if (already) {
    // No event on a repeat: the fact was already announced, and announcing it twice would wake consumers into
    // believing an athlete's score moved again when nothing happened.
    return {
      ledgerId: already.id, score: result.score, composite: result.composite, confidence: result.confidence,
      becameCurrent: already.supersededBy === null,
    };
  }

  const [current] = await db
    .select({ id: intelligenceLedger.id, evidenceAsOf: intelligenceLedger.evidence_as_of })
    .from(intelligenceLedger)
    .where(and(
      eq(intelligenceLedger.subject_type, "athlete"),
      eq(intelligenceLedger.subject_id, snap.athlete_id),
      eq(intelligenceLedger.kind, "ASSESSMENT"),
      eq(intelligenceLedger.owner, "marketability"),
      isNull(intelligenceLedger.superseded_by),
    ))
    .orderBy(desc(intelligenceLedger.evidence_as_of))
    .limit(1);

  const becameCurrent = !current || snap.evidence_as_of.getTime() >= current.evidenceAsOf.getTime();

  // Built as the CONTRACT TYPE FIRST, then serialized. Postgres would accept any shape in a jsonb column, and that
  // flexibility is precisely what quietly defeats the type architecture the engines are supposed to share: a write
  // cast into place looks like it works while satisfying nothing. Compile-time conformance is the point, so the only
  // casts below are at the jsonb boundary itself, after the shape has already been checked.
  const draft: Omit<AssessmentEntry, "entryId" | "createdAt"> = {
    kind: "ASSESSMENT",
    subjectType: "athlete",
    subjectId: snap.athlete_id,
    owner: "marketability",
    value: {
      score: result.score, composite: result.composite, confidence: result.confidence,
      dimensions: result.dimensions, drivers: result.drivers,
      summary: judgements.summary ?? null,
      overallConfidence: judgements.overallConfidence ?? null,
      identityConfidence: judgements.identityConfidence ?? null,
      // The evaluator's own note about evidence it could not find. Part of what it said, so it belongs in `value`.
      importantMissingData: judgements.importantMissingData ?? [],

      // THE GENERIC PROJECTION — findings, cited evidence and typed notes, in the shape any engine writes.
      //
      // Until now this row carried the scoring layer's numbers and almost none of the evaluator's reasoning:
      // dimensionAssessments, evidence, keyStrengths, keyConstraints and identityOrEvidenceRisks were all discarded,
      // and per-signal rationale with them. A downstream layer saw `narrative_power = 88.65` with no meaning
      // attached, and reconstructed the meaning by guessing — from the word "Stanford", as it turned out.
      //
      // `dimensions` above is kept for the readers that already use it; `findings` is what new readers project. The
      // overlap is transitional and deliberate rather than unnoticed: removing `dimensions` in the same change would
      // break every existing consumer at once.
      //
      // Each cited source also carries its LINEAGE: whether the provider's stored grounding shows it was retrieved,
      // or the evaluator merely wrote the URL. Derived here, from this run's own grounding metadata and snapshot.
      ...assessmentValueFor(result.dimensions as unknown as ScoredDimension[], result.score, judgements, grounding),
    },
    // NOT ESTABLISHED for Beta.1. The frozen numeric confidence is in `value`; no versioned policy says what number
    // becomes HIGH, so any threshold written here would be methodology invented at the keyboard and frozen by use.
    confidence: null,
    versions: {
      methodology, evaluator: evaluatorVersion, params: versions.marketability,
      lookups: versions.lookups, policy: versions.policy, priors: versions.priors, cohorts: versions.cohorts,
    },
    // EMPTY, AND THAT IS THE ASSERTION. `inputs` records upstream INTELLIGENCE a judgment consumed, and ADR-011
    // forbids Marketability consuming any: were Nomila's own predictions to feed MIA, MIA would become a disguised
    // predictor of the thing it exists to describe independently. So [] here is ADR-011 made machine-checkable.
    // Evidence lineage is deliberately NOT recorded here — it is recoverable as ledger -> evaluation_run_id -> run
    // -> snapshot_id -> digest, and putting it in `inputs` would duplicate a link that already exists AND leave the
    // next engine to copy the wrong meaning of the field it depends on.
    inputs: [],
    // Also empty, and also deliberate. A P-4 assumption is an invisible constant made visible, carrying a basis and
    // a version. MIA's imputed priors genuinely are assumptions in that sense, and are recorded today by the `priors`
    // version plus each signal's `imputed` flag inside `value`. Enumerating them per signal as structured Assumption
    // entries is real work worth doing deliberately; inventing half-shaped ones here would be worse than none.
    assumptions: [],
    evidenceAsOf: snap.evidence_as_of.toISOString(),
    // An older-evidence result is superseded THE MOMENT it is written: it is a true record of what we believed and a
    // false claim about what is current, and only one of those should be readable as the athlete's score.
    supersededBy: becameCurrent ? null : current.id,
  };

  const [entry] = await db.insert(intelligenceLedger).values({
    subject_type: draft.subjectType, subject_id: draft.subjectId, owner: draft.owner, kind: draft.kind,
    value: draft.value as Record<string, unknown>,
    confidence: draft.confidence,
    versions: draft.versions,
    inputs: draft.inputs,
    assumptions: draft.assumptions,
    evidence_as_of: new Date(draft.evidenceAsOf),
    evaluation_run_id: runId,
    superseded_by: draft.supersededBy ?? null,
  }).returning({ id: intelligenceLedger.id });

  if (becameCurrent && current) {
    await db.update(intelligenceLedger)
      .set({ superseded_by: entry.id })
      .where(and(eq(intelligenceLedger.id, current.id), isNull(intelligenceLedger.superseded_by)));
  }

  // Published only now: after the entry is durable AND supersession is resolved, so becameCurrent is settled rather
  // than provisional. A reference, never intelligence — a consumer reads the assessment through getMarketability().
  publishMarketabilityAssessed({
    kind: "MARKETABILITY_ASSESSED",
    athleteId: snap.athlete_id,
    ledgerEntryId: entry.id,
    evaluationRunId: runId,
    becameCurrent,
    evidenceAsOf: snap.evidence_as_of.toISOString(),
    versions: { methodology, evaluator: evaluatorVersion, params: versions.marketability },
    createdAt: new Date().toISOString(),
  });

  return { ledgerId: entry.id, score: result.score, composite: result.composite, confidence: result.confidence, becameCurrent };
}

export interface CurrentMarketability {
  /** The ledger row id of the assessment of record (Concept 0.4 Slice 2: State's findings and the read model key on it). */
  entryId: string;
  /** When the row was written (ISO). Distinct from `evidenceAsOf`, which is what the assessment is about. */
  createdAt: string;
  score: number;
  composite: number;
  confidence: number;
  /** Null in Beta.1: no versioned policy maps the numeric confidence onto a band. `confidence` is the real value. */
  confidenceBand: string | null;
  evidenceAsOf: string;
  versions: Record<string, string>;
  value: Record<string, unknown>;
}

/**
 * The read side: the marketability of record for an athlete, or null when they have never been assessed.
 *
 * Null is a real answer and callers must render it as one. An athlete with no assessment has no score — not a zero,
 * not a default, not a placeholder that a person would reasonably read as a judgement about them.
 */
export async function getMarketability(athleteId: string): Promise<CurrentMarketability | null> {
  const [row] = await db
    .select()
    .from(intelligenceLedger)
    .where(and(
      eq(intelligenceLedger.subject_type, "athlete"),
      eq(intelligenceLedger.subject_id, athleteId),
      eq(intelligenceLedger.kind, "ASSESSMENT"),
      eq(intelligenceLedger.owner, "marketability"),
      isNull(intelligenceLedger.superseded_by),
    ))
    .orderBy(desc(intelligenceLedger.evidence_as_of), desc(intelligenceLedger.created_at))
    .limit(1);
  if (!row) return null;

  const value = row.value as any;
  return {
    entryId: row.id, createdAt: row.created_at.toISOString(),
    score: value.score, composite: value.composite, confidence: value.confidence,
    confidenceBand: row.confidence,
    evidenceAsOf: row.evidence_as_of.toISOString(),
    versions: row.versions as Record<string, string>,
    value,
  };
}

/**
 * The read side of "is an evaluation in flight": this athlete's ACTIVE mia_evaluation runs (status running|waiting,
 * either scope), each with its input and the latest output of its `snapshot` step (null until that step has run).
 * SELECTs only; starts nothing. Kept beside the process name so the workflow has one owner (Concept 0.4 Slice 2,
 * D-1: My Intelligence decides from this whether an evaluation may still produce a read; a finished run is not here).
 */
export async function readActiveEvaluations(athleteId: string): Promise<Array<{ runId: string; input: unknown; snapshotOutput: unknown }>> {
  const runs = await db.select({ id: workflowRuns.id, input: workflowRuns.input }).from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, MIA_EVALUATION_PROCESS), inArray(workflowRuns.status, ["running", "waiting"])));
  if (!runs.length) return [];
  const steps = await db.select({ runId: workflowSteps.run_id, output: workflowSteps.output }).from(workflowSteps)
    .where(and(inArray(workflowSteps.run_id, runs.map((r) => r.id)), eq(workflowSteps.step, "snapshot")))
    .orderBy(desc(workflowSteps.attempt));
  return runs.map((r) => ({ runId: r.id, input: r.input, snapshotOutput: steps.find((s) => s.runId === r.id && s.output != null)?.output ?? null }));
}

/**
 * The entry point every trigger uses: ask for an evaluation, get back the run that will do it.
 *
 * Callers do not schedule, debounce, or check anything — they state that something changed and stop. The runner
 * decides whether that means a new run or joining one already in flight, atomically, through a unique constraint
 * rather than a read-then-write that two simultaneous connects could both win.
 */
export interface EvaluationRequest {
  athleteId: string;
  trigger: TriggerReason;
  /** Manual refresh: skip the debounce and evaluate even when the evidence is unchanged. */
  force?: boolean;
  /**
   * Start now, but still skip unchanged evidence (the M.I.A. preview: someone is waiting on the read, and the same
   * question must not be paid for twice). Its own active scope, so it never waits behind a debounced run.
   */
  immediate?: boolean;
  /** Why a person asked. Recorded on the snapshot, never sent. */
  reason?: string | null;
  createdBy?: string;
}

export async function requestEvaluation(req: EvaluationRequest): Promise<{ runId: string; created: boolean }> {
  const { startRun } = await import("../workflow/runner");
  const { run, created } = await startRun({
    process: MIA_EVALUATION_PROCESS,
    athleteId: req.athleteId,
    input: { trigger: req.trigger, force: !!req.force, ...(req.immediate ? { immediate: true } : {}), reason: req.reason ?? null },
    createdBy: req.createdBy,
  });
  // created:false is the debounce working, not an error: a second event inside the window joins the run already
  // scheduled. The caller gets the same run id either way and needs no special case.
  return { runId: run.id, created };
}

// ── PR H2 (R-a): after identity resolves ──────────────────────────────────────

/**
 * What the athlete's LATEST mia_evaluation run (either scope) actually did. A workflow run that ends `done` is NOT an
 * evaluation: since H1 an identity-blocked run ends `done` too, and so does a digest skip. So this reads the run's step
 * outputs, and the LEDGER decides "evaluated": only an assessment row written for the run's evaluation counts.
 *
 *   none               no mia_evaluation run has ever been requested for this athlete
 *   in_flight          the latest run is still running/waiting and its snapshot step has not decided anything yet
 *   blocked_identity   its snapshot step was refused by the identity gate (H1) — even while the run is still finishing
 *   evaluated          its evaluation succeeded AND a ledger assessment exists for that evaluation run
 *   skipped_unchanged  the digest matched an earlier successful evaluation; nothing was asked
 *   skipped            no snapshot could be built (no resolvable sport); nothing was asked
 *   not_evaluated      it ended without an assessment: a refusal (failed_validation), a failed/canceled run, or an ok
 *                      evaluation that left no ledger row
 *
 * SELECTs only; starts nothing.
 */
export type EvaluationOutcome = "none" | "in_flight" | "blocked_identity" | "evaluated" | "skipped_unchanged" | "skipped" | "not_evaluated";

export interface LatestEvaluationOutcome {
  outcome: EvaluationOutcome;
  runId: string | null;
  runStatus: string | null;
  /** The trigger the latest run was requested with (its input). */
  trigger: TriggerReason | null;
  /** blocked_identity: the identity value the gate read. */
  identity?: IdentityValue;
  /** evaluated: the ledger assessment written for this run's evaluation. */
  ledgerId?: string;
}

export async function latestEvaluationOutcome(athleteId: string): Promise<LatestEvaluationOutcome> {
  const [run] = await db.select({ id: workflowRuns.id, status: workflowRuns.status, input: workflowRuns.input }).from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, MIA_EVALUATION_PROCESS)))
    .orderBy(desc(workflowRuns.started_at), desc(workflowRuns.id)).limit(1);
  if (!run) return { outcome: "none", runId: null, runStatus: null, trigger: null };

  const base = { runId: run.id, runStatus: run.status, trigger: ((run.input as any)?.trigger ?? null) as TriggerReason | null };
  const steps = await db.select({ step: workflowSteps.step, output: workflowSteps.output }).from(workflowSteps)
    .where(eq(workflowSteps.run_id, run.id)).orderBy(desc(workflowSteps.attempt));
  const out = (name: string) => (steps.find((s) => s.step === name && s.output != null)?.output ?? null) as any;
  const snapshot = out("snapshot");
  const evaluate = out("evaluate");
  const active = run.status === "running" || run.status === "waiting";

  if (snapshot?.blocked === "identity_gate") return { ...base, outcome: "blocked_identity", identity: (snapshot.identity ?? null) as IdentityValue };
  if (evaluate?.status === "ok" && evaluate.runId) {
    const [entry] = await db.select({ id: intelligenceLedger.id }).from(intelligenceLedger)
      .where(eq(intelligenceLedger.evaluation_run_id, evaluate.runId)).limit(1);
    if (entry) return { ...base, outcome: "evaluated", ledgerId: entry.id };
    return { ...base, outcome: active ? "in_flight" : "not_evaluated" };
  }
  if (active) return { ...base, outcome: "in_flight" };
  if (evaluate?.status === "skipped_unchanged") return { ...base, outcome: "skipped_unchanged" };
  if (evaluate?.status === "skipped_no_identity" || (snapshot && "skipped" in snapshot)) return { ...base, outcome: "skipped" };
  return { ...base, outcome: "not_evaluated" };
}

export type EvaluationOwed =
  | { owed: true; why: "blocked_request" | "no_assessment"; latest: LatestEvaluationOutcome }
  | { owed: false; why: "disabled" | "agent_path" | "no_facts" | "identity_not_resolved" | "in_flight" | "current_assessment"; latest?: LatestEvaluationOutcome };

/**
 * Is an identity-dependent evaluation OWED now? Only behind identityResolutionEnabled(), only for a resolved athlete,
 * and only when (a) the latest request was refused by the identity gate, or (b) she has no current assessment and no
 * run is about to produce one. A run still in flight is not owed again: it reads identity when it executes.
 * Never for an AGENT-FRONT athlete who has no memory yet (legacy intelligence switch-off, 12 Oct 2026): her M.I.A. runs
 * only through the agent path (the onboarding preview on her memory: miaPreview/preview.ts, agent/memoryRerun.ts). Before
 * her memory exists an evaluation here would score the LEGACY evidence snapshot — the duplicate spend at agent signup.
 * Once she has memory, the snapshot and the identity gate read her memory (the agent path), so the blocked-run re-check
 * below keeps working for her.
 */
export async function evaluationOwed(athleteId: string): Promise<EvaluationOwed> {
  if (!identityResolutionEnabled()) return { owed: false, why: "disabled" };
  if ((await isAgentFrontAthlete(athleteId)) && !(await isMemoryAthlete(athleteId))) return { owed: false, why: "agent_path" };
  // No memory facts ⇒ nothing to score from (the search-enabled evaluator is retired, 4 Nov 2026): never owed.
  if (!(await isMemoryAthlete(athleteId))) return { owed: false, why: "no_facts" };
  if (!(await miaIdentityGate(athleteId)).permitted) return { owed: false, why: "identity_not_resolved" };
  const latest = await latestEvaluationOutcome(athleteId);
  if (latest.outcome === "blocked_identity") return { owed: true, why: "blocked_request", latest };
  if (latest.outcome === "in_flight") return { owed: false, why: "in_flight", latest };
  if (await getMarketability(athleteId)) return { owed: false, why: "current_assessment", latest };
  return { owed: true, why: "no_assessment", latest };
}

/**
 * R-a: the account-creation evaluation, and any request the identity gate held, are requested HERE once identity
 * resolves (T2 by Q1, T6 by her confirmation, T10 by a TTL re-run) — the listener the mia_evaluation workflow registers
 * on identityResolution's onIdentityResolved seam.
 *
 * Trigger IDENTITY_RESOLVED (research-acquisition architecture §10(c): the call moves from signup to after Q1; the
 * trigger is recorded, never sent, so spec, digest and prompt are unchanged). Through the ordinary requestEvaluation:
 * debounced, NOT forced, so the digest skip still applies. Idempotent: a resolution re-written (a Q1 step retry, T10)
 * while the request is pending joins it or finds it in flight; once it has evaluated nothing is owed.
 */
export async function requestEvaluationIfOwed(athleteId: string, cause: { transition: string }): Promise<{ requested: false; owed: EvaluationOwed } | { requested: true; owed: EvaluationOwed; runId: string; created: boolean }> {
  const owed = await evaluationOwed(athleteId);
  if (!owed.owed) {
    log.info({ athleteId, transition: cause.transition, why: owed.why }, "identity resolved: no M.I.A. evaluation owed");
    return { requested: false, owed };
  }
  const { runId, created } = await requestEvaluation({ athleteId, trigger: "IDENTITY_RESOLVED", reason: `identity resolved (${cause.transition}; ${owed.why})`, createdBy: "identity_resolved" });
  log.info({ athleteId, transition: cause.transition, why: owed.why, runId, created }, "identity resolved: M.I.A. evaluation requested");
  return { requested: true, owed, runId, created };
}

/**
 * The PREFLIGHT for a deliberate refresh (admin route, cohort script): the same gate the run applies, asked BEFORE
 * enqueueing, so the caller gets "held for identity" instead of a 202 and a run that silently blocks. Advisory only —
 * miaIdentityGate inside the workflow remains the final guard. Flag off ⇒ { held: false } without reading anything.
 */
export type MiaIdentityPreflight =
  | { held: false }
  | { held: "identity"; identity: { value: IdentityValue; reason: string | null } };

export async function miaIdentityPreflight(athleteId: string): Promise<MiaIdentityPreflight> {
  const gate = await miaIdentityGate(athleteId);
  if (gate.permitted) return { held: false };
  if (await isMemoryAthlete(athleteId)) return { held: "identity", identity: { value: gate.identity, reason: "disputed_identity_fact" } };
  const detail = (await readIdentityState(athleteId))?.detail as { reason?: string } | null | undefined;
  return { held: "identity", identity: { value: gate.identity, reason: detail?.reason ?? null } };
}
