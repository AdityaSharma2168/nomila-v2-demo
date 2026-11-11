/**
 * outcome/attribution.ts — OUTCOME INTELLIGENCE, experimental and unmounted. Given observations and the execution
 * lineage that now resolves, it answers six questions and stops: what happened · what observable result occurred ·
 * what execution or judgment it relates to · what evidence supports it · what changed versus the RECORDED baseline ·
 * and whether that is enough to reconsider something. It proposes no strategy, writes no Athlete State and edits no
 * Objective. It builds the EXISTING ledger contracts (`MeasuredOutcome`, `CorrelationalObservation`, `CalibrationPair`)
 * and adds nothing the forcing cases did not prove missing — see §"subject" below for the one extension.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { campaignDeliverables, creativeIntents, generationJobs, mediaAssets, socialFeatures, studioStitchJobs } from "../../../../shared/schema";
import { MAX_DERIVATION_HOPS } from "../creative/store";
import type { RecommendationLedger, RecommendationRecord } from "../brain/recommendation";
import type { Adoption, CalibrationPair, CorrelationalObservation, LedgerSubjectType, MeasurableEntry, MeasuredOutcome } from "../contracts/intelligenceLedger";
import { calibrationError } from "../contracts/intelligenceLedger";
import type { ObservationRow } from "./publishedIdentity";

type Db = PgDatabase<any, any, any>;

/**
 * SUBJECT — the amendment landed: `LedgerSubjectType` is now the one shared vocabulary (contracts/subjects.ts), so an
 * outcome names its real subject and these are the ledger's own types with no local widening left.
 */
export type OutcomeSubjectType = LedgerSubjectType;
export type AttributedOutcome = MeasuredOutcome;
export type AttributedObservation = CorrelationalObservation;

/** Where a result came from, by reference. Never a copy of the reading. */
export type SourceRef = `observation:${number}` | `deal:${string}` | `payment:${string}` | `campaign_confirmation:${string}` | `publish:${string}` | `campaign:${string}` | (string & {});

export interface Lineage {
  assetId: string | null; jobId: string | null; creativeIntentId: string | null;
  campaignId: string | null; campaignDeliverableId: string | null; specVersion: number | null;
  outreachPlanId: string | null; recommendationId: string | null;
  source: "athlete" | "campaign" | "planner" | "none";
  /**
   * Present only when the asset's own job does not carry the intent and the lineage was reached through recorded hops,
   * nearest first; `jobId` is then the job that carries the intent, not the asset's own.
   */
  through?: LineageHop[];
}
/** A recorded hop from an asset back toward the job that carries its intent. */
export type LineageHop =
  | { by: "edit"; assetId: string; jobId: string | null; derivedFromAssetId: string }
  | { by: "stitch"; assetId: string; stitchJobId: string };
const EMPTY: Lineage = { assetId: null, jobId: null, creativeIntentId: null, campaignId: null, campaignDeliverableId: null, specVersion: null, outreachPlanId: null, recommendationId: null, source: "none" };

/**
 * Upward from an asset: job -> creative intent -> its lineage. Every hop is a recorded id; nothing is inferred. When the
 * asset's own job carries no intent (an edit from studio/edit, whose job has none) or it has no job at all (a stitched
 * reel), the walk follows media_assets.derived_from_asset_id or the succeeded studio_stitch_jobs row that produced it
 * (spec.clips[].assetId) to the job that does, and records each hop in `through`. A reel whose clips trace to MORE THAN
 * ONE intent resolves to none: which one it "came from" is not recorded, so it is not chosen here.
 */
export async function lineageForAsset(db: Db, athleteId: string, assetId: string): Promise<Lineage> {
  const [asset] = await db.select({ id: mediaAssets.id, job: mediaAssets.generation_job_id }).from(mediaAssets).where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId))).limit(1);
  if (!asset) return EMPTY;
  const anchor = await anchorFor(db, athleteId, asset.id, 0, new Set());
  const hopped = anchor && anchor !== "ambiguous" && anchor.through.length ? anchor : null;
  const out: Lineage = { ...EMPTY, assetId: asset.id, jobId: hopped?.jobId ?? asset.job ?? null, ...(hopped ? { through: hopped.through } : {}) };
  if (!out.jobId) return out;
  const [job] = await db.select({ intent: generationJobs.creative_intent_id, specId: generationJobs.source_spec_id, specVersion: generationJobs.source_spec_version, deliverable: generationJobs.campaign_deliverable_id }).from(generationJobs).where(eq(generationJobs.id, out.jobId)).limit(1);
  if (!job) return out;
  out.campaignDeliverableId = job.deliverable ?? null; out.specVersion = job.specVersion ?? null;
  if (!job.intent) return out;
  out.creativeIntentId = job.intent;
  const [intent] = await db.select({ kind: creativeIntents.source_kind, lineage: creativeIntents.lineage }).from(creativeIntents).where(eq(creativeIntents.id, job.intent)).limit(1);
  if (!intent) return out;
  const l = (intent.lineage ?? {}) as { campaignId?: string; specVersion?: number; campaignDeliverableId?: string; outreachPlanId?: string; recommendationId?: string };
  return { ...out, source: intent.kind as Lineage["source"], campaignId: l.campaignId ?? null, campaignDeliverableId: out.campaignDeliverableId ?? l.campaignDeliverableId ?? null, specVersion: out.specVersion ?? l.specVersion ?? null, outreachPlanId: l.outreachPlanId ?? null, recommendationId: l.recommendationId ?? null };
}

type Anchor = { jobId: string; intent: string; through: LineageHop[] };

/** The job carrying an intent that this asset traces to by recorded hops; null when none; "ambiguous" when a stitch mixes intents. */
async function anchorFor(db: Db, athleteId: string, assetId: string, depth: number, seen: Set<string>): Promise<Anchor | null | "ambiguous"> {
  if (depth > MAX_DERIVATION_HOPS || seen.has(assetId)) return null;
  seen.add(assetId);
  const [a] = await db.select({ id: mediaAssets.id, job: mediaAssets.generation_job_id, from: mediaAssets.derived_from_asset_id, intent: generationJobs.creative_intent_id })
    .from(mediaAssets).leftJoin(generationJobs, eq(generationJobs.id, mediaAssets.generation_job_id))
    .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId))).limit(1);
  if (!a) return null;
  if (a.job && a.intent) return { jobId: a.job, intent: a.intent, through: [] };
  if (a.from) {
    const up = await anchorFor(db, athleteId, a.from, depth + 1, seen);
    return up && up !== "ambiguous" ? { ...up, through: [{ by: "edit", assetId: a.id, jobId: a.job ?? null, derivedFromAssetId: a.from }, ...up.through] } : up;
  }
  if (a.job) return null;
  const [s] = await db.select({ id: studioStitchJobs.id, spec: studioStitchJobs.spec }).from(studioStitchJobs)
    .where(and(eq(studioStitchJobs.athlete_id, athleteId), eq(studioStitchJobs.output_asset_id, a.id), eq(studioStitchJobs.status, "succeeded")))
    .orderBy(desc(studioStitchJobs.completed_at)).limit(1);
  if (!s) return null;
  const found: Anchor[] = [];
  for (const c of (s.spec as { clips?: Array<{ assetId?: string }> }).clips ?? []) {
    if (!c.assetId) continue;
    const r = await anchorFor(db, athleteId, c.assetId, depth + 1, new Set(seen));
    if (r === "ambiguous") return r;
    if (r) found.push(r);
  }
  if (!found.length) return null;
  if (new Set(found.map((f) => f.intent)).size > 1) return "ambiguous";
  return { ...found[0], through: [{ by: "stitch", assetId: a.id, stitchJobId: s.id }, ...found[0].through] };
}

/** A campaign's own lineage, for an obligation with no asset (an appearance). */
export async function lineageForDeliverable(db: Db, athleteId: string, deliverableId: string, recommendationId: string | null): Promise<Lineage> {
  const [d] = await db.select({ id: campaignDeliverables.id, campaign: campaignDeliverables.campaign_id }).from(campaignDeliverables).where(and(eq(campaignDeliverables.id, deliverableId), eq(campaignDeliverables.athlete_id, athleteId))).limit(1);
  if (!d) return EMPTY;
  return { ...EMPTY, campaignId: d.campaign, campaignDeliverableId: d.id, recommendationId, source: "campaign" };
}

/**
 * ADOPTION — the anti-self-confirmation classification. A judgment must have reached the decision-maker BEFORE the
 * outcome for anything but `not_recommended`, and the record must say whether she followed it. `unknown` is returned
 * honestly when the lineage names a Recommendation the caller cannot resolve (the ledger is not mounted in production).
 */
export function adoptionFor(lineage: Lineage, ledger: RecommendationLedger | null): { adoption: Adoption; entryId: string | null; because: string; record: RecommendationRecord | null } {
  if (!lineage.recommendationId) return { adoption: "not_recommended", entryId: null, because: "no Recommendation stands behind this execution — it happened anyway", record: null };
  const record = ledger?.records.find((r) => r.id === lineage.recommendationId) ?? null;
  if (!record) return { adoption: "unknown", entryId: lineage.recommendationId, because: "the lineage names a Recommendation that could not be resolved (no ledger on this path)", record: null };
  const declined = record.response.state === "declined";
  const followed = record.response.state === "accepted" || record.response.state === "modified";
  if (declined) return { adoption: "recommended_and_not_followed", entryId: record.id, because: "she declined the Recommendation and the result occurred anyway", record };
  if (!followed) return { adoption: "unknown", entryId: record.id, because: `the Recommendation was presented and its response is "${record.response.state}"`, record };
  return { adoption: "recommended_and_followed", entryId: record.id, because: `she ${record.response.state} it and it reached execution`, record };
}

/**
 * BASELINE — never invented. A comparison exists only against something already recorded: an Objective's quantified
 * baseline, or an earlier derived social feature at an earlier `as_of` under the same calculation version. With neither,
 * the observation is reported and the comparison is explicitly unavailable.
 */
export interface Comparison { available: boolean; because: string; baseline?: { value: number; asOf: string; from: string }; observed?: { value: number; asOf: string }; delta?: { absolute: number; relative: number | null } }

export async function comparisonForFeature(db: Db, athleteId: string, featureKey: string, observed: { value: number; asOf: string }, calculationVersion?: string): Promise<Comparison> {
  const rows = await db.select({ value: socialFeatures.value, asOf: socialFeatures.as_of, version: socialFeatures.calculation_version })
    .from(socialFeatures)
    .where(and(eq(socialFeatures.athlete_id, athleteId), eq(socialFeatures.feature_key, featureKey), lt(socialFeatures.as_of, new Date(observed.asOf))))
    .orderBy(asc(socialFeatures.as_of));
  const usable = rows.filter((r: any) => r.value !== null && (!calculationVersion || r.version === calculationVersion));
  const prior = usable[usable.length - 1];
  if (!prior) return { available: false, because: `no earlier ${featureKey} on record under this calculation version — comparison unavailable`, observed };
  const baseValue = Number(prior.value);
  const absolute = observed.value - baseValue;
  return { available: true, because: `compared against the recorded ${featureKey} at ${new Date(prior.asOf).toISOString()}`, baseline: { value: baseValue, asOf: new Date(prior.asOf).toISOString(), from: `social_features[${featureKey}]` }, observed, delta: { absolute, relative: baseValue === 0 ? null : absolute / Math.abs(baseValue) } };
}

export function comparisonForObjectiveBaseline(baseline: { value: number; asOf: string } | null, observed: { value: number; asOf: string }, statePath: string): Comparison {
  if (!baseline) return { available: false, because: "the Objective records no quantified baseline — comparison unavailable", observed };
  const absolute = observed.value - baseline.value;
  return { available: true, because: `compared against the Objective's recorded baseline (${statePath})`, baseline: { value: baseline.value, asOf: baseline.asOf, from: `objective.success.quantified.baseline` }, observed, delta: { absolute, relative: baseline.value === 0 ? null : absolute / Math.abs(baseline.value) } };
}

/**
 * RECONSIDERATION ELIGIBILITY — the same vocabulary the existing bridge uses (`eligible`, `because`), with `subjects`
 * where that one has `blocks`: an outcome does not block a decision, it gives reason to re-evaluate named subjects.
 * Eligibility is not a Decision and not a Recommendation. Nothing here changes a judgment; only the Brain can.
 */
export interface ReconsiderationEligibility { eligible: boolean; because: string; subjects: string[]; citing: SourceRef[] }

export function eligibilityFrom(input: { lineage: Lineage; comparison: Comparison; falsifier?: { statePath: string; condition: string; satisfied: boolean } | null; sources: SourceRef[]; objectiveIds?: string[] }): ReconsiderationEligibility {
  const subjects = [
    ...(input.objectiveIds ?? []).map((id) => `objective[${id}]`),
    ...(input.lineage.recommendationId ? [`recommendation[${input.lineage.recommendationId}]`] : []),
    ...(input.lineage.campaignId ? [`campaign[${input.lineage.campaignId}]`] : []),
  ];
  if (input.falsifier?.satisfied) return { eligible: true, because: `an observed result satisfies the judgment's own falsifier (${input.falsifier.condition})`, subjects, citing: input.sources };
  if (!input.comparison.available) return { eligible: false, because: `${input.comparison.because} — an outcome with no recorded comparison is not a reason to re-evaluate`, subjects, citing: input.sources };
  return { eligible: false, because: "the result is recorded and nothing it bears on has been falsified", subjects, citing: input.sources };
}

// ── building the existing contracts ───────────────────────────────────────────────────────────────

const oid = (...parts: string[]) => `oc_${createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 16)}`;

export interface OutcomeInput {
  subject: { type: OutcomeSubjectType; id: string };
  kind: AttributedOutcome["kind"];
  value: unknown;
  observedAt: string;
  sources: SourceRef[];
  adoption: Adoption;
  entryId: string | null;
  now?: string;
}
export const measuredOutcome = (i: OutcomeInput): AttributedOutcome => ({
  outcomeId: oid(i.subject.type, i.subject.id, i.kind, i.observedAt, ...i.sources), subjectType: i.subject.type, subjectId: i.subject.id,
  kind: i.kind, value: i.value, observedAt: i.observedAt, createdAt: i.now ?? new Date().toISOString(), sourceIds: [...i.sources], entryId: i.entryId, adoption: i.adoption,
});

/** An observation with no judgment behind it: never an outcome, never retrospectively attributed. */
export const correlationalObservation = (i: { subject: { type: OutcomeSubjectType; id: string }; observedQuantity: string; value: unknown; observedAt: string; sources: SourceRef[]; entryId: string; now?: string }): AttributedObservation => ({
  outcomeId: oid("assessment", i.subject.id, i.observedQuantity, i.observedAt), subjectType: i.subject.type, subjectId: i.subject.id,
  kind: "ASSESSMENT", entryId: i.entryId, observedQuantity: i.observedQuantity, value: i.value, observedAt: i.observedAt, createdAt: i.now ?? new Date().toISOString(), sourceIds: [...i.sources],
});

/**
 * EVIDENCE CLASS — recoverable from the sources, or named as unrecoverable. A metric observation carries its own
 * `source_class`; a domain-state source (a deal's status, an external confirmation) carries none on the row, and its
 * class is a property of the reader's rule rather than of the row.
 */
export function evidenceOf(sources: SourceRef[], observations: ObservationRow[]): { recoverable: boolean; classes: string[]; because: string } {
  const byId = new Map<string, string>(observations.map((o) => [`observation:${o.id}`, o.sourceClass]));
  const classes: string[] = []; const unresolved: SourceRef[] = [];
  for (const s of sources) { const c = byId.get(s); if (c) classes.push(c); else unresolved.push(s); }
  if (!unresolved.length) return { recoverable: true, classes: [...new Set(classes)], because: "every source carries its own source_class" };
  return { recoverable: false, classes: [...new Set(classes)], because: `${unresolved.length} source(s) carry no class on the row (${unresolved.join(", ")}) — the class is the reader's rule, not the row's` };
}

/** A judgment and what happened, in the existing pair shape. Assessments cannot form one — the type refuses them. */
export function calibrationPairFor(entry: MeasurableEntry, outcome: AttributedOutcome, numbers?: { predicted: number; actual: number }): CalibrationPair {
  const pair: CalibrationPair = { entry, outcome: outcome as unknown as MeasuredOutcome };
  if (numbers) pair.error = calibrationError(entry, numbers.predicted, numbers.actual);
  return pair;
}
