/**
 * store.ts — persistence for the live Objective. PR3b-1 + PR3b-2.
 *
 * Every decision goes through entity.ts's pure functions first; this module only writes what they return. There
 * is no UPDATE of a proposal set, no UPDATE of an event, and no DELETE of anything, and a test asserts this module
 * exports nothing that could do those. The `objectives` row is a projection of its events; `rebuild()` folds the
 * events over the immutable `created_snapshot` and the integration test asserts the result equals the row.
 *
 * PR3b-2 adds the two readers the design fixes as the Brain's only doors — `liveObjectives`, `objectiveHistory` —
 * the review queue, and reconciliation inside `materialiseProposalSet` (reconcile.ts): a proposal that echoes an
 * Objective she already has does not become a second row; it becomes an event on the first.
 *
 * Tenancy: every read and write takes `athleteId` and scopes by it. A borrowed objective id resolves to nothing.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { objectiveEvents, objectiveProposalSets, objectives } from "../../../../shared/schema";
import type { ObjectiveProposalSet } from "../contracts/objective";
import type { Objective, ObjectiveActor, ObjectiveDecision, ObjectiveEvent } from "../contracts/objectiveEntity";
import {
  applyDecision, applyRunEvent, athleteObjective, fold, isLive, objectiveFromProposal, validateObjective,
  ObjectiveTransitionError, type AthleteObjectiveInput,
} from "./entity";
import { RECONCILIATION_PARAMS, continuesVerdict, lineageFor, relate, splitsIn, type Candidate, type Relationship } from "./reconcile";
import { resolveStatePath } from "../opportunity/grounding";
import { reviewContextFor, type EvidenceAsSeen, type ReviewContext } from "./context";
import type { AthleteState } from "../contracts/athleteState";
import type { OpportunityMap } from "../contracts/opportunity";
import type { ChangeAssessmentRecord } from "./currentBasis";
import { requestIdentityRefresh } from "../identityIntelligence/refresh";

type Db = PgDatabase<any, any, any>;

export class ObjectiveNotFound extends Error {
  constructor(id: string) { super(`objective ${id} not found for this athlete`); this.name = "ObjectiveNotFound"; }
}

/** What the evaluator run produced, as the orchestrator records it. Only what the set row needs is typed. */
export interface ProposalRunRecord {
  canonicalSha256: string;
  [k: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposal sets — immutable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a set with the exact structured inputs it was judged from (L0). The invariants are the writer's:
 * the snapshot is the State the map was judged from, and both are the ones the set cites.
 */
export function evidenceProblems(set: ObjectiveProposalSet, seen: EvidenceAsSeen): string[] {
  const p: string[] = [];
  if (seen.state.athleteId !== set.athleteId) p.push(`state is for athlete ${seen.state.athleteId}, set is for ${set.athleteId}`);
  if (seen.state.asOf !== set.stateAsOf) p.push(`state.asOf ${seen.state.asOf} != set.stateAsOf ${set.stateAsOf}`);
  if (seen.map.stateAsOf !== seen.state.asOf) p.push(`map.stateAsOf ${seen.map.stateAsOf} != state.asOf ${seen.state.asOf}`);
  if (seen.map.asOf !== set.opportunityMapAsOf) p.push(`map.asOf ${seen.map.asOf} != set.opportunityMapAsOf ${set.opportunityMapAsOf}`);
  return p;
}

export async function persistProposalSet(db: Db, set: ObjectiveProposalSet, record: ProposalRunRecord, seen: EvidenceAsSeen): Promise<string> {
  const problems = evidenceProblems(set, seen);
  if (problems.length) throw new ObjectiveTransitionError(`evidence-as-seen does not match the set: ${problems.join("; ")}`, "evidence_mismatch");
  const [row] = await db.insert(objectiveProposalSets).values({
    state_snapshot: seen.state as any,
    opportunity_map: seen.map as any,
    athlete_id: set.athleteId,
    as_of: new Date(set.asOf),
    spec_version: set.specVersion,
    canonical_sha256: record.canonicalSha256,
    state_as_of: new Date(set.stateAsOf),
    opportunity_map_as_of: new Date(set.opportunityMapAsOf),
    set: set as any,
    record: record as any,
  }).returning({ id: objectiveProposalSets.id });
  return row!.id;
}

/** A candidate as the report shows it: which Objective, how found, how strong — without the whole row. */
export interface CandidateReport { objectiveId: string; proposalKey: string | null; disposition: string; lifecycle: string; domain: string; sameDomain: boolean; tier: "A" | "B" | "C"; strength: number; evidenceJaccard: number; wordingJaccard: number; opportunityKeyOverlap: number }
const report = (c: Candidate): CandidateReport => ({ objectiveId: c.objective.id, proposalKey: c.objective.fromProposal?.key ?? null, disposition: c.objective.disposition, lifecycle: c.objective.lifecycle, domain: c.objective.domain, sameDomain: c.sameDomain, tier: c.tier, strength: c.strength, evidenceJaccard: c.evidenceJaccard, wordingJaccard: c.wordingJaccard, opportunityKeyOverlap: c.opportunityKeyOverlap });

/** What one materialisation did, proposal by proposal. Every line here is also an event. */
export interface Materialisation {
  setId: string;
  params: typeof RECONCILIATION_PARAMS;
  /** Per proposal: its lineage, EVERY candidate considered, and the relationship chosen. */
  proposals: Array<{ proposalKey: string; lineage: Objective["lineage"]; candidates: CandidateReport[]; relationship: Relationship["kind"]; verdict: string; objectiveIds: string[] }>;
  created: Objective[];
  reaffirmed: Array<{ proposalKey: string; objectiveId: string; similarity: number }>;
  repeatedDeclines: Array<{ proposalKey: string; objectiveId: string; similarity: number; declinedAt: string }>;
  reSurfaced: Array<{ proposalKey: string; objectiveId: string; similarity: number }>;
  spans: Array<{ proposalKey: string; objectiveIds: string[]; strengths: number[] }>;
  splits: Array<{ objectiveId: string; proposalKeys: string[] }>;
  mayRelate: Array<{ proposalKey: string; objectiveId: string; wordingJaccard: number }>;
}

/**
 * Turn a persisted set into the review queue, reconciled against what she already has (§7).
 *
 * A proposal with nothing close becomes an Objective row (`unreviewed · proposed`) with its `presented` event.
 * A proposal that echoes a live, queued, recently declined, or deferred Objective becomes an event on that row
 * instead — and only `re_surfaced` moves the row. Materialising the same set twice therefore creates nothing the
 * second time: every proposal reaffirms the row the first pass made.
 */
export async function materialiseProposalSet(db: Db, athleteId: string, setId: string, now = new Date()): Promise<Materialisation> {
  const [setRow] = await db.select().from(objectiveProposalSets)
    .where(and(eq(objectiveProposalSets.id, setId), eq(objectiveProposalSets.athlete_id, athleteId))).limit(1);
  if (!setRow) throw new ObjectiveNotFound(setId);
  const set = setRow.set as ObjectiveProposalSet;
  const map = setRow.opportunity_map as OpportunityMap | null;
  const currentState = setRow.state_snapshot as AthleteState | null;
  if (!map) throw new ObjectiveTransitionError(`set ${setId} carries no opportunity_map; lineage cannot be computed (backfill evidence-as-seen first)`, "no_evidence_as_seen");
  const nowIso = now.toISOString();
  const existing = await allObjectives(db, athleteId);
  const out: Materialisation = { setId, params: RECONCILIATION_PARAMS, proposals: [], created: [], reaffirmed: [], repeatedDeclines: [], reSurfaced: [], spans: [], splits: [], mayRelate: [] };

  // Pass 1: relate every proposal to what exists BEFORE this set changes anything, so two proposals in one set are
  // judged against the same portfolio and `splits` can be seen.
  const relations = set.proposals.map((p) => ({ p, lineage: lineageFor(p, map), relationship: relate(p, lineageFor(p, map), existing) }));
  const splits = splitsIn(relations.map((r) => ({ proposalKey: r.p.key, relationship: r.relationship })));

  // Pass 2: act. Rows only for `new` and `may_relate`; everything else is an event on an existing Objective.
  for (const { p, lineage, relationship: rel } of relations) {
    const base = { setId, proposalKey: p.key, rationale: p.desiredState.rationale };
    const line = { proposalKey: p.key, lineage, candidates: rel.candidates.map(report), relationship: rel.kind, verdict: "", objectiveIds: [] as string[] };
    const create = async (delta: Record<string, unknown>) => {
      const objectiveId = crypto.randomUUID(); const eventId = crypto.randomUUID();
      const { objective, event } = objectiveFromProposal(set, setId, p, { objectiveId, eventId }, nowIso, lineage);
      await insertObjective(db, objective, setId, p.key);
      await insertEvent(db, { ...event, delta: { setId, ...delta } });
      existing.push(objective); out.created.push(objective); line.objectiveIds.push(objectiveId);
    };
    switch (rel.kind) {
      case "new": { await create({}); line.verdict = "new"; break; }
      case "may_relate": {
        const { event } = applyRunEvent(rel.match.objective, "may_relate", { ...base, tier: "C", similarity: rel.match.wordingJaccard }, crypto.randomUUID(), nowIso);
        await insertEvent(db, event);
        out.mayRelate.push({ proposalKey: p.key, objectiveId: rel.match.objective.id, wordingJaccard: rel.match.wordingJaccard });
        await create({ relatedObjectiveId: rel.match.objective.id, similarity: rel.match.wordingJaccard });
        line.verdict = "new (may_relate recorded)"; line.objectiveIds.push(rel.match.objective.id);
        break;
      }
      case "spans": {
        const ids = rel.matches.map((m) => m.objective.id);
        for (const m of rel.matches) {
          const { event } = applyRunEvent(m.objective, "spans_live", { ...base, tier: m.tier, evidenceJaccard: m.evidenceJaccard, similarity: m.strength, siblingObjectiveIds: ids.filter((i) => i !== m.objective.id) }, crypto.randomUUID(), nowIso);
          await insertEvent(db, event);
        }
        out.spans.push({ proposalKey: p.key, objectiveIds: ids, strengths: rel.matches.map((m) => m.strength) });
        line.verdict = "spans — no row, her Objectives unchanged"; line.objectiveIds.push(...ids);
        break;
      }
      case "continues": {
        const m = rel.match; const v = continuesVerdict(m.objective, nowIso);
        const delta = { ...base, tier: m.tier, evidenceJaccard: m.evidenceJaccard, similarity: m.strength };
        line.objectiveIds.push(m.objective.id);
        switch (v.kind) {
          case "reaffirms": {
            // An information deferral records whether the evidence at its lineage paths changed — a signal for the
            // audit and the later intelligence-gap step. It triggers nothing (objectives-lineage-design.md §2).
            const deferred = m.objective.disposition === "deferred" && m.objective.lifecycle === "proposed";
            const evidenceChanged = deferred && currentState ? await evidenceChangedFor(db, athleteId, m.objective, currentState) : undefined;
            const { event } = applyRunEvent(m.objective, "reaffirmed_by_run", { ...delta, ...(evidenceChanged !== undefined ? { evidenceChanged } : {}) }, crypto.randomUUID(), nowIso);
            await insertEvent(db, event);
            out.reaffirmed.push({ proposalKey: p.key, objectiveId: m.objective.id, similarity: m.strength });
            line.verdict = deferred ? `continues → deferred (${m.objective.deferral?.kind ?? "information, pre-L2"}), stays deferred; evidence ${evidenceChanged ? "CHANGED (signal only)" : "unchanged"}` : "continues → reaffirmed"; break;
          }
          case "repeats_decline": {
            const { event } = applyRunEvent(m.objective, "re_proposed_while_declined", delta, crypto.randomUUID(), nowIso);
            await insertEvent(db, event);
            out.repeatedDeclines.push({ proposalKey: p.key, objectiveId: m.objective.id, similarity: m.strength, declinedAt: v.declinedAt });
            line.verdict = `continues → declined ${v.declinedAt.slice(0, 10)}, inside the window; recorded, not shown`; break;
          }
          case "re_surfaces": {
            const { objective, event } = applyRunEvent(m.objective, "re_surfaced", { ...delta, because: v.because }, crypto.randomUUID(), nowIso);
            await insertEvent(db, event);
            await db.update(objectives).set(projection(objective)).where(and(eq(objectives.id, objective.id), eq(objectives.athlete_id, athleteId)));
            const i = existing.findIndex((o) => o.id === objective.id); if (i >= 0) existing[i] = objective;
            out.reSurfaced.push({ proposalKey: p.key, objectiveId: objective.id, similarity: m.strength });
            line.verdict = `continues → deferred (time), its period has passed → re-surfaced`; break;
          }
          case "new_with_history": {
            await create({ relatedObjectiveId: m.objective.id, similarity: m.strength });
            line.verdict = "continues a closed or window-expired Objective → new row with history"; break;
          }
        }
        break;
      }
    }
    out.proposals.push(line);
  }
  for (const s of splits) {
    const o = existing.find((x) => x.id === s.objectiveId)!;
    const { event } = applyRunEvent(o, "splits_live", { setId, proposalKeys: s.proposalKeys }, crypto.randomUUID(), nowIso);
    await insertEvent(db, event);
    out.splits.push(s);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Athlete-created
// ─────────────────────────────────────────────────────────────────────────────

export async function createAthleteObjective(
  db: Db, input: AthleteObjectiveInput, actor: Exclude<ObjectiveActor, { role: "system" }>, now = new Date(),
): Promise<Objective> {
  const objectiveId = crypto.randomUUID(); const eventId = crypto.randomUUID();
  const { objective, event } = athleteObjective(input, actor, { objectiveId, eventId }, now.toISOString());
  if (input.replaces) await loadObjective(db, input.athleteId, input.replaces); // must be hers, before anything is written
  // ATOMIC: the successor, its event and the predecessor's supersede land together or not at all — a refused supersede
  // (e.g. the predecessor is already terminal) must not leave an orphan successor. Transactionality only: what a
  // successor inherits (lineage, currentState, quantified, basis) is a separate, undecided question and is unchanged.
  //
  // LOCKED: the predecessor's row is locked (SELECT … FOR UPDATE) before anything is written, so two concurrent
  // replaces of the same Objective serialise: the second waits, then reads it as already superseded and is refused —
  // its successor rolls back with it. The refresh / re-plan requests run once, after the commit (never inside the
  // transaction, never twice).
  await (db as any).transaction(async (tx: Db) => {
    if (input.replaces) {
      const [locked] = await tx.select({ id: objectives.id }).from(objectives)
        .where(and(eq(objectives.id, input.replaces), eq(objectives.athlete_id, input.athleteId)))
        .for("update");
      if (!locked) throw new ObjectiveNotFound(input.replaces);
    }
    await insertObjective(tx, objective, null, null);
    await insertEvent(tx, event);
    if (input.replaces) {
      // Lineage on both sides: the replaced Objective records its successor through the normal transition.
      await decide(tx, input.athleteId, input.replaces, { action: "supersede", actor, supersededBy: objectiveId }, now, { sideEffects: false });
    }
  });
  await requestIdentityRefresh(input.athleteId, "objective created");   // her goals feed My Story; never fatal
  return objective;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply one decision to an Objective. `sideEffects: false` skips the identity-refresh and re-plan requests, for a caller
 * that runs this inside its own transaction and makes those requests itself after the commit (createAthleteObjective).
 */
export async function decide(
  db: Db, athleteId: string, objectiveId: string, decision: ObjectiveDecision, now = new Date(),
  opts: { sideEffects?: boolean } = {},
): Promise<Objective> {
  const current = await loadObjective(db, athleteId, objectiveId);
  if (decision.action === "supersede" && decision.supersededBy) {
    await loadObjective(db, athleteId, decision.supersededBy); // the successor must exist, for THIS athlete
  }
  const { objective, event } = applyDecision(current, decision, crypto.randomUUID(), now.toISOString());
  const problems = validateObjective(objective);
  if (problems.length) throw new ObjectiveTransitionError(problems.join("; "), "invalid_result");
  await insertEvent(db, event);
  await db.update(objectives).set(projection(objective)).where(and(eq(objectives.id, objectiveId), eq(objectives.athlete_id, athleteId)));
  if (opts.sideEffects !== false) {
    await requestIdentityRefresh(athleteId, `objective ${decision.action}`);   // her goals feed My Story; never fatal
  }
  return objective;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Did the evidence a deferred Objective rests on change between the set it was deferred from and this set?
 * Compares the resolved values at its lineage paths (positional collections compared whole). OBSERVATIONAL ONLY.
 */
async function evidenceChangedFor(db: Db, athleteId: string, o: Objective, current: AthleteState): Promise<boolean | undefined> {
  const paths = o.lineage?.evidencePaths; const setId = o.fromProposal?.setId;
  if (!paths?.length || !setId) return undefined;
  const then = await evidenceAsSeen(db, athleteId, setId);
  if (!then) return undefined;
  const at = (s: AthleteState, p: string) => { const r = resolveStatePath(s, p.replace(/\[\]$/, "")); return r.ok ? JSON.stringify(r.value) : null; };
  return paths.some((p) => at(then.state, p) !== at(current, p));
}

/** THE BRAIN'S ONLY DOOR. Active, and she said yes. No other reader here may be mistaken for intent. */
export async function liveObjectives(db: Db, athleteId: string): Promise<Objective[]> {
  return (await allObjectives(db, athleteId)).filter(isLive);
}

/** What she has not answered yet. `re_surfaced` puts a deferred Objective back here. */
export async function reviewQueue(db: Db, athleteId: string): Promise<Objective[]> {
  return (await allObjectives(db, athleteId)).filter((o) => o.lifecycle === "proposed" && o.disposition === "unreviewed");
}

/**
 * The queue as the review surface needs it: each Objective with the reasoning and provenance the evaluator was shown,
 * read from its proposal set's persisted run record (PR3b-3). Nothing is recomputed; a missing line is null.
 */
export async function reviewQueueWithContext(db: Db, athleteId: string): Promise<Array<Objective & { context: ReviewContext }>> {
  const queue = await reviewQueue(db, athleteId);
  const seen = new Map<string, EvidenceAsSeen | null>();
  for (const o of queue) {
    const setId = o.fromProposal?.setId;
    if (!setId || seen.has(setId)) continue;
    seen.set(setId, await evidenceAsSeen(db, athleteId, setId));
  }
  return queue.map((o) => ({ ...o, context: reviewContextFor(o, o.fromProposal ? seen.get(o.fromProposal.setId) ?? null : null) }));
}

/** The structured State and map a set was judged from. Null for a set written before 0068 and not backfilled. */
export async function evidenceAsSeen(db: Db, athleteId: string, setId: string): Promise<EvidenceAsSeen | null> {
  const [row] = await db.select({ state: objectiveProposalSets.state_snapshot, map: objectiveProposalSets.opportunity_map }).from(objectiveProposalSets)
    .where(and(eq(objectiveProposalSets.id, setId), eq(objectiveProposalSets.athlete_id, athleteId))).limit(1);
  if (!row?.state || !row?.map) return null;
  return { state: row.state as AthleteState, map: row.map as OpportunityMap };
}

/** Everything that is not live, with its events: declined, deferred, queued, superseded, abandoned, achieved. Context, never intent. */
export async function objectiveHistory(db: Db, athleteId: string): Promise<Array<Objective & { events: ObjectiveEvent[] }>> {
  const rest = (await allObjectives(db, athleteId)).filter((o) => !isLive(o));
  return Promise.all(rest.map(async (o) => ({ ...o, events: await loadEvents(db, athleteId, o.id) })));
}

/**
 * HER STANDING DECISIONS, ONE READING. From `objectiveHistory`: what she has deferred (still `proposed`, awaiting her)
 * and what she has declined. Shared by every reasoner that must respect them — the Brain's inputs and the planner's
 * governed exclusions — so no reasoner keeps its own copy or its own interpretation. A re-surfaced / revisited Objective
 * is `unreviewed` again and is in neither list. A time deferral's `after` is not an expiry here. Pure.
 */
export function deferredAndDeclined<T extends Pick<Objective, "disposition" | "lifecycle">>(history: T[]): { deferred: T[]; declined: T[] } {
  return {
    deferred: history.filter((o) => o.disposition === "deferred" && o.lifecycle === "proposed"),
    declined: history.filter((o) => o.disposition === "declined"),
  };
}

/** The append-only event that put an Objective in its current deferred / declined disposition: its latest defer / decline. */
export function governingEventOf(o: Pick<Objective, "disposition"> & { events: Array<Pick<ObjectiveEvent, "id" | "action">> }): string | null {
  const action = o.disposition === "deferred" ? "defer" : o.disposition === "declined" ? "decline" : null;
  if (!action) return null;
  for (let i = o.events.length - 1; i >= 0; i--) if (o.events[i].action === action) return o.events[i].id;
  return null;
}

/**
 * Slice 3 B: the saved change assessments of these Objectives, oldest first — the only events `currentBasis` reads.
 * (`objectiveHistory` carries only non-live Objectives, so live ones are read here.)
 */
export async function changeAssessmentsFor(db: Db, athleteId: string, objectiveIds: string[]): Promise<Map<string, ChangeAssessmentRecord[]>> {
  const out = new Map<string, ChangeAssessmentRecord[]>();
  if (!objectiveIds.length) return out;
  const rows = await db.select().from(objectiveEvents)
    .where(and(eq(objectiveEvents.athlete_id, athleteId), eq(objectiveEvents.action, "change_assessed"), inArray(objectiveEvents.objective_id, objectiveIds)))
    .orderBy(asc(objectiveEvents.at), asc(objectiveEvents.created_at), asc(objectiveEvents.id));
  for (const r of rows) {
    const rec = (r.delta as { changeAssessment?: ChangeAssessmentRecord } | null)?.changeAssessment;
    if (rec) out.set(r.objective_id, [...(out.get(r.objective_id) ?? []), rec]);
  }
  return out;
}

/** Slice 3 B: append the saved assessment of her edit. A system event; it never changes the Objective (the fold ignores it). */
export async function appendChangeAssessment(db: Db, athleteId: string, objectiveId: string, record: ChangeAssessmentRecord, now = new Date()): Promise<string> {
  const id = crypto.randomUUID();
  await insertEvent(db, { id, objectiveId, athleteId, at: now.toISOString(), actor: { userId: null, role: "system" }, action: "change_assessed", said: null, delta: { changeAssessment: record as unknown as Record<string, unknown> } });
  return id;
}

export async function loadObjective(db: Db, athleteId: string, id: string): Promise<Objective> {
  const [row] = await db.select().from(objectives).where(and(eq(objectives.id, id), eq(objectives.athlete_id, athleteId))).limit(1);
  if (!row) throw new ObjectiveNotFound(id);
  return fromRow(row);
}

export async function loadEvents(db: Db, athleteId: string, objectiveId: string): Promise<ObjectiveEvent[]> {
  const rows = await db.select().from(objectiveEvents)
    .where(and(eq(objectiveEvents.objective_id, objectiveId), eq(objectiveEvents.athlete_id, athleteId)))
    // `at` is the caller's clock and two events may share it; `created_at` is the database's insertion time.
    .orderBy(asc(objectiveEvents.at), asc(objectiveEvents.created_at), asc(objectiveEvents.id));
  return rows.map((r) => ({
    id: r.id, objectiveId: r.objective_id, athleteId: r.athlete_id, at: r.at.toISOString(),
    actor: r.actor_role === "system" ? { userId: null, role: "system" } : { userId: r.actor_user_id!, role: r.actor_role as "athlete" | "admin" },
    action: r.action as ObjectiveEvent["action"], said: r.said, delta: (r.delta as ObjectiveEvent["delta"]) ?? null,
  }));
}

/** The row, rebuilt from its immutable snapshot and its events. Must equal `loadObjective` — the P3 test. */
export async function rebuild(db: Db, athleteId: string, objectiveId: string): Promise<Objective> {
  const [row] = await db.select({ snapshot: objectives.created_snapshot, lineage: objectives.lineage }).from(objectives)
    .where(and(eq(objectives.id, objectiveId), eq(objectives.athlete_id, athleteId))).limit(1);
  if (!row) throw new ObjectiveNotFound(objectiveId);
  // Lineage is immutable and, for rows backfilled after creation, lives on the column rather than in the snapshot.
  const created = { ...(row.snapshot as Objective), ...(row.lineage ? { lineage: row.lineage as Objective["lineage"] } : {}) };
  return fold(created, await loadEvents(db, athleteId, objectiveId));
}

async function allObjectives(db: Db, athleteId: string): Promise<Objective[]> {
  const rows = await db.select().from(objectives).where(eq(objectives.athlete_id, athleteId)).orderBy(asc(objectives.created_at), asc(objectives.id));
  return rows.map(fromRow);
}

// ─────────────────────────────────────────────────────────────────────────────
// Row ↔ entity
// ─────────────────────────────────────────────────────────────────────────────

const ts = (s: string | undefined) => (s ? new Date(s) : null);

/** Only the MUTABLE columns. Immutable columns are written once by insertObjective and never appear here. */
function projection(o: Objective) {
  return {
    desired_state: o.desiredState as any,
    horizon: (o.horizon ?? null) as any,
    success: o.success as any,
    disposition: o.disposition,
    lifecycle: o.lifecycle,
    modified_from: (o.modifiedFrom ?? null) as any,
    deferral: (o.deferral ?? null) as any,
    superseded_by: o.supersededBy ?? null,
    reviewed_at: ts(o.reviewedAt), activated_at: ts(o.activatedAt), closed_at: ts(o.closedAt),
  };
}

async function insertObjective(db: Db, o: Objective, setId: string | null, key: string | null): Promise<void> {
  const problems = validateObjective(o);
  if (problems.length) throw new ObjectiveTransitionError(problems.join("; "), "invalid_create");
  await db.insert(objectives).values({
    id: o.id, athlete_id: o.athleteId, version: o.version, origin: o.provenance.origin, domain: o.domain,
    current_state: (o.currentState ?? null) as any, provenance: o.provenance as any, // success: written by projection()
    athlete_stance: (o.athleteStance ?? null) as any, confidence: o.confidence,
    from_proposal: (o.fromProposal ?? null) as any, lineage: (o.lineage ?? null) as any, proposal_set_id: setId, proposal_key: key,
    created_snapshot: o as any, created_at: new Date(o.createdAt),
    ...projection(o),
  });
}

async function insertEvent(db: Db, e: ObjectiveEvent): Promise<void> {
  await db.insert(objectiveEvents).values({
    id: e.id, objective_id: e.objectiveId, athlete_id: e.athleteId, at: new Date(e.at),
    actor_user_id: e.actor.userId, actor_role: e.actor.role, action: e.action, said: e.said, delta: (e.delta ?? null) as any,
  });
}

function fromRow(r: typeof objectives.$inferSelect): Objective {
  const snap = r.created_snapshot as Objective;
  return {
    ...snap,
    desiredState: r.desired_state as Objective["desiredState"],
    horizon: (r.horizon as Objective["horizon"]) ?? null,
    // Slice 3 A: her governed success line. `created_snapshot.success` stays the original, as history.
    success: r.success as Objective["success"],
    disposition: r.disposition as Objective["disposition"],
    lifecycle: r.lifecycle as Objective["lifecycle"],
    ...(r.lineage ? { lineage: r.lineage as Objective["lineage"] } : {}),
    ...(r.deferral ? { deferral: r.deferral as Objective["deferral"] } : {}),
    ...(r.modified_from ? { modifiedFrom: r.modified_from as Objective["modifiedFrom"] } : {}),
    ...(r.superseded_by ? { supersededBy: r.superseded_by } : {}),
    ...(r.reviewed_at ? { reviewedAt: r.reviewed_at.toISOString() } : {}),
    ...(r.activated_at ? { activatedAt: r.activated_at.toISOString() } : {}),
    ...(r.closed_at ? { closedAt: r.closed_at.toISOString() } : {}),
  };
}
