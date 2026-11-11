/**
 * research/confirmation.ts — the athlete confirmation service for public identity (PR E2b; design record
 * docs/architecture/phase-a/pr-e-identity-resolution-design.md §1.2 T6/T8, §2.3, D8). Service functions only: the UI is
 * the Concept 0.4 / Mila handoff.
 *
 *   confirmPublicIdentity      T6 (ambiguous → resolved): she confirms evidence FROM A Q1 RUN as herself.
 *   confirmByProofAffiliation  T6 by a verified proof affiliation (athlete_affiliations kind 'proof') that an accepted Q1
 *                              current-affiliation finding names exactly (normalizeText equality): it breaks a namesake tie.
 *   rejectPublicIdentity       T8 (resolved → ambiguous): "that is not me".
 *
 * Each statement is an athlete_asserted row (field "public_identity", value {confirms, evidenceIds, q1ResearchRunId}),
 * and the provenance detail points at it (assertedId). The row is written only once every precondition holds, and is
 * retracted again if the compare-and-set is lost, so a refused statement leaves nothing behind.
 *
 * What NEVER resolves identity here (§2.3): account ownership — the self membership, claim, auth, an OAuth connection —
 * is only who may SPEAK for the athlete (the caller must be her self user); the evidence must come from a Q1 run of
 * hers. Confirmation applies ONLY from `ambiguous`: never from NULL, pending or failed (from failed her statement cannot
 * create a public identity). Behind identityResolutionEnabled(), like every identity write.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../../db";
import { athleteAffiliations, athleteAsserted, researchEvidence, researchRuns } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { selfUserOf } from "../identity/users";
import { identityResolutionEnabled } from "./config";
import { normalizeText } from "./factRegistry";
import { applyIdentityTransition, readIdentityState, type ApplyResult, type IdentityState, type IdentityValue, type Q1Detail } from "./identityResolution";
import { ACCEPTED_LEVELS } from "./spec/directEvidenceV1";

const logger = createLogger("research-identity-confirmation");

export const PUBLIC_IDENTITY_FIELD = "public_identity";
type AssertedSource = "chat" | "voice" | "settings";
type AssertedMode = "chat" | "voice" | "form";

export type ConfirmationResult =
  | { ok: true; transition: "T6" | "T8"; assertedId: string; evidenceIds: string[]; q1ResearchRunId: string | null }
  | { ok: false; reason: "disabled" | "not_self" | "not_ambiguous" | "not_resolved" | "no_q1_run" | "q1_run_mismatch" | "no_evidence" | "evidence_not_q1" | "not_a_namesake_tie" | "no_proof_affiliation" | "proof_not_corroborated"; value?: IdentityValue }
  | { ok: false; reason: "transition_lost"; result: ApplyResult };

const ACCEPTED = new Set<string>(ACCEPTED_LEVELS.retrieved);

/** The Q1 run a confirmation must be made against: the in-force Q1 determination's run, else her latest completed Q1 row. */
async function q1RunFor(athleteId: string, state: IdentityState): Promise<string | null> {
  const d = state.detail as Partial<Q1Detail> | null;
  if (d?.basis === "q1" && d.researchRunId) return d.researchRunId;
  const [r] = await db.select({ id: researchRuns.id }).from(researchRuns)
    .where(and(eq(researchRuns.athlete_id, athleteId), eq(researchRuns.query_id, "Q1"), inArray(researchRuns.status, ["ok", "partial"])))
    .orderBy(desc(researchRuns.started_at)).limit(1);
  return r?.id ?? null;
}

/** A completed Q1 research_runs row of THIS athlete. */
async function isQ1RunOf(athleteId: string, runId: string): Promise<boolean> {
  const [r] = await db.select({ id: researchRuns.id }).from(researchRuns)
    .where(and(eq(researchRuns.id, runId), eq(researchRuns.athlete_id, athleteId), eq(researchRuns.query_id, "Q1"), inArray(researchRuns.status, ["ok", "partial"]))).limit(1);
  return !!r;
}

/** Write her statement, apply the transition by compare-and-set, supersede her previous statement — or retract on a lost CAS. */
async function stateAndApply(i: { athleteId: string; userId: string; state: IdentityState; confirms: boolean; evidenceIds: string[]; q1ResearchRunId: string | null; extra?: Record<string, unknown>; said?: string | null; source: AssertedSource; mode: AssertedMode | null; at: Date }): Promise<ConfirmationResult> {
  const [prev] = await db.select({ id: athleteAsserted.id }).from(athleteAsserted)
    .where(and(eq(athleteAsserted.athlete_id, i.athleteId), eq(athleteAsserted.field, PUBLIC_IDENTITY_FIELD), isNull(athleteAsserted.retracted_at), isNull(athleteAsserted.superseded_by)))
    .orderBy(desc(athleteAsserted.created_at)).limit(1);
  const [row] = await db.insert(athleteAsserted).values({
    athlete_id: i.athleteId, field: PUBLIC_IDENTITY_FIELD, value: { confirms: i.confirms, evidenceIds: i.evidenceIds, q1ResearchRunId: i.q1ResearchRunId, ...(i.extra ?? {}) } as any,
    said: i.said ?? null, source: i.source, mode: i.mode,
  }).returning({ id: athleteAsserted.id });
  const r = i.confirms
    ? await applyIdentityTransition(i.athleteId, i.state, { kind: "athlete_confirmed", assertedId: row.id, evidenceIds: i.evidenceIds, q1ResearchRunId: i.q1ResearchRunId!, by: i.userId }, { at: i.at })
    : await applyIdentityTransition(i.athleteId, i.state, { kind: "athlete_rejected", assertedId: row.id, by: i.userId }, { at: i.at });
  if (!r.written) {
    await db.update(athleteAsserted).set({ retracted_at: new Date() }).where(eq(athleteAsserted.id, row.id));
    logger.info({ athleteId: i.athleteId, result: r }, "public identity statement not applied; retracted");
    return { ok: false, reason: "transition_lost", result: r };
  }
  if (prev) await db.update(athleteAsserted).set({ superseded_by: row.id }).where(eq(athleteAsserted.id, prev.id));
  logger.info({ athleteId: i.athleteId, transition: r.transition, assertedId: row.id }, "public identity statement applied");
  return { ok: true, transition: r.transition as "T6" | "T8", assertedId: row.id, evidenceIds: i.evidenceIds, q1ResearchRunId: i.q1ResearchRunId };
}

/** Common preconditions: the boundary, the caller is her self user, and the determination in force. */
async function precheck(athleteId: string, userId: string, want: "ambiguous" | "resolved"): Promise<{ ok: true; state: IdentityState } | { ok: false; reason: "disabled" | "not_self" | "not_ambiguous" | "not_resolved"; value?: IdentityValue }> {
  if (!identityResolutionEnabled()) return { ok: false, reason: "disabled" };
  if ((await selfUserOf(athleteId)) !== userId) return { ok: false, reason: "not_self" };
  const state = (await readIdentityState(athleteId)) ?? { value: null, detail: null };
  if (state.value !== want) return { ok: false, reason: want === "ambiguous" ? "not_ambiguous" : "not_resolved", value: state.value };
  return { ok: true, state };
}

/**
 * T6: she confirms one Q1 candidate / evidence set as herself. Only from `ambiguous`; the run must be the Q1 run of the
 * determination in force (or, after a rejection, her latest completed Q1 run); every evidence id must be a
 * research_evidence row of that run and of her.
 */
export async function confirmPublicIdentity(i: { athleteId: string; userId: string; evidenceIds: string[]; q1ResearchRunId: string; said?: string | null; source?: AssertedSource; mode?: AssertedMode | null; at?: Date }): Promise<ConfirmationResult> {
  const pre = await precheck(i.athleteId, i.userId, "ambiguous");
  if (!pre.ok) return pre;
  const expected = await q1RunFor(i.athleteId, pre.state);
  if (!expected) return { ok: false, reason: "no_q1_run" };
  if (i.q1ResearchRunId !== expected || !(await isQ1RunOf(i.athleteId, i.q1ResearchRunId))) return { ok: false, reason: "q1_run_mismatch" };
  const ids = [...new Set(i.evidenceIds)];
  if (!ids.length) return { ok: false, reason: "no_evidence" };
  const found = await db.select({ id: researchEvidence.id }).from(researchEvidence)
    .where(and(inArray(researchEvidence.id, ids), eq(researchEvidence.run_id, i.q1ResearchRunId), eq(researchEvidence.athlete_id, i.athleteId)));
  if (found.length !== ids.length) return { ok: false, reason: "evidence_not_q1" };
  return stateAndApply({ athleteId: i.athleteId, userId: i.userId, state: pre.state, confirms: true, evidenceIds: ids, q1ResearchRunId: i.q1ResearchRunId, said: i.said, source: i.source ?? "settings", mode: i.mode ?? null, at: i.at ?? new Date() });
}

/** The organization an affiliation evidence row names (persisted claim shape, or its value). */
function evidenceOrg(claim: unknown): string {
  const c = (claim ?? {}) as Record<string, any>;
  return normalizeText(c.org ?? c.organization ?? c.value?.org ?? c.value?.organization);
}
function evidenceIsCurrent(claim: unknown): boolean {
  const c = (claim ?? {}) as Record<string, any>;
  const tf = c.timeframe ?? c.extra?.timeframe ?? c.value?.timeframe;
  return tf === "current" || c.item === "current_affiliation";
}

/**
 * T6 by proof: a namesake tie (the Q1 determination in force is ambiguous for namesakes) is broken by a CURRENT proof
 * affiliation (athlete_affiliations kind 'proof' — a contract that names the team) that an accepted (native-lineage)
 * current-affiliation finding of that Q1 run names exactly, after normalizeText. No fuzzy match: "Stanford" never
 * corroborates "Stanford University". A proof cannot stand in for Q1 from pending (this applies only from ambiguous).
 */
export async function confirmByProofAffiliation(i: { athleteId: string; userId: string; source?: AssertedSource; at?: Date }): Promise<ConfirmationResult> {
  const pre = await precheck(i.athleteId, i.userId, "ambiguous");
  if (!pre.ok) return pre;
  const d = pre.state.detail as Partial<Q1Detail> | null;
  if (d?.basis !== "q1" || !d.researchRunId || !(d.reason === "namesakes_unseparated" || d.reason === "namesakes_uncorroborated")) return { ok: false, reason: "not_a_namesake_tie" };
  const proofs = await db.select({ id: athleteAffiliations.id, org: athleteAffiliations.org_name }).from(athleteAffiliations)
    .where(and(eq(athleteAffiliations.athlete_id, i.athleteId), eq(athleteAffiliations.kind, "proof"), isNull(athleteAffiliations.ended_on)));
  const proofOrgs = new Map(proofs.map((p) => [normalizeText(p.org), p.id] as const).filter(([k]) => !!k));
  if (!proofOrgs.size) return { ok: false, reason: "no_proof_affiliation" };
  const ev = await db.select({ id: researchEvidence.id, claim: researchEvidence.claim, lineage: researchEvidence.lineage_status }).from(researchEvidence)
    .where(and(eq(researchEvidence.run_id, d.researchRunId), eq(researchEvidence.athlete_id, i.athleteId), eq(researchEvidence.kind, "affiliation")));
  const matched = ev.filter((e) => ACCEPTED.has(e.lineage) && evidenceIsCurrent(e.claim) && proofOrgs.has(evidenceOrg(e.claim)));
  if (!matched.length) return { ok: false, reason: "proof_not_corroborated" };
  const proofAffiliationIds = [...new Set(matched.map((e) => proofOrgs.get(evidenceOrg(e.claim))!))];
  return stateAndApply({ athleteId: i.athleteId, userId: i.userId, state: pre.state, confirms: true, evidenceIds: matched.map((e) => e.id), q1ResearchRunId: d.researchRunId, extra: { proofAffiliationIds }, source: i.source ?? "settings", mode: null, at: i.at ?? new Date() });
}

/** T8: "that is not me". Only from `resolved` (resolved → ambiguous). */
export async function rejectPublicIdentity(i: { athleteId: string; userId: string; said?: string | null; source?: AssertedSource; mode?: AssertedMode | null; at?: Date }): Promise<ConfirmationResult> {
  const pre = await precheck(i.athleteId, i.userId, "resolved");
  if (!pre.ok) return pre;
  const d = pre.state.detail as { researchRunId?: string; q1ResearchRunId?: string } | null;
  const runId = d?.researchRunId ?? d?.q1ResearchRunId ?? null;
  return stateAndApply({ athleteId: i.athleteId, userId: i.userId, state: pre.state, confirms: false, evidenceIds: [], q1ResearchRunId: runId, said: i.said, source: i.source ?? "settings", mode: i.mode ?? null, at: i.at ?? new Date() });
}
