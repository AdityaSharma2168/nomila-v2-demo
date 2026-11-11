/**
 * entity.ts — the live Objective as pure functions. PR3b-1.
 *
 * No database, no provider, no clock of its own. Three things live here and nothing else:
 *
 *   objectiveFromProposal()   the ONLY transition from a frozen ObjectiveProposal to a durable Objective. Copies the
 *                             immutable fields byte for byte, derives origin from provenance, and arrives
 *                             `unreviewed · proposed`. It never activates anything.
 *   athleteObjective()        an Objective with no proposal behind it. Her goal arrives reviewed.
 *   applyDecision()           a decision → an event, validated against the transition table, and the new row.
 *   fold()                    events → row. The row is a projection; this is the projection. A store that disagrees
 *                             with this function is wrong, and the rebuild test says so.
 *
 * THE CENTRAL INVARIANT: `lifecycle: active` requires `disposition ∈ {accepted, modified}`. A proposal cannot become
 * the athlete's goal by sitting unread, by a timer, by the Brain, or by a reconciliation rule. Every path below
 * that produces `active` goes through `accept` or `modify`.
 */
import type { ObjectiveProposal, ObjectiveProposalSet, ObjectiveProvenance, ObjectiveHorizon } from "../contracts/objective";
import { HORIZON_PERIODS } from "../contracts/objective";
import {
  ACCEPTED_OBJECTIVE_VERSIONS, DEFER_PERIOD_DAYS, DEFERRAL_KINDS, OBJECTIVE_VERSION, RUN_ACTIONS, TERMINAL_LIFECYCLES,
  type Objective, type ObjectiveAction, type ObjectiveActor, type ObjectiveDecision, type ObjectiveDelta,
  type ObjectiveDisposition, type ObjectiveEvent, type ObjectiveLifecycle, type ObjectiveLineage, type RunAction,
} from "../contracts/objectiveEntity";
import type { MeasuredValue } from "../contracts/provenance";
import { deriveOrigin } from "./grounding";

export class ObjectiveTransitionError extends Error {
  constructor(message: string, public readonly code: string) { super(message); this.name = "ObjectiveTransitionError"; }
}

/** Ids are the caller's (the store uses the database's). Pure code never invents identity. */
export interface Ids { objectiveId: string; eventId: string }

// ─────────────────────────────────────────────────────────────────────────────
// Creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Origin is ESTABLISHED, never inferred: computed once from what actually created the Objective, by the same
 * function PR3a used on the proposal, then frozen. The proposal's own `origin` label is checked, not trusted.
 */
export function establishOrigin(p: ObjectiveProvenance): ObjectiveProvenance["origin"] {
  const derived = deriveOrigin(p.fromOpportunities.length, p.fromAthleteIntent.length);
  if (!derived) throw new ObjectiveTransitionError("an objective must rest on an opportunity, an athlete intent, or both", "no_origin");
  return derived;
}

/**
 * The transition. `unreviewed · proposed`, whatever the origin: even a proposal that rests only on her recorded
 * intent is Nomila's PHRASING of it, and she has not seen the phrasing. (The contract's "athlete + unreviewed is
 * impossible" row describes athlete-CREATED objectives, see `athleteObjective`; the evaluator was later allowed to
 * emit athlete-origin proposals, and those arrive unreviewed. The checkpoint inspects whether `athlete` overstates
 * authorship for them — flagged, not redesigned.)
 */
export function objectiveFromProposal(
  set: Pick<ObjectiveProposalSet, "athleteId" | "asOf" | "specVersion">,
  setId: string,
  p: ObjectiveProposal,
  ids: Ids,
  now: string,
  lineage?: ObjectiveLineage,
): { objective: Objective; event: ObjectiveEvent } {
  const origin = establishOrigin(p.provenance);
  if (p.provenance.origin !== origin) {
    throw new ObjectiveTransitionError(`proposal ${p.key} labels origin ${p.provenance.origin}; provenance derives ${origin}`, "origin_mismatch");
  }
  const objective: Objective = {
    id: ids.objectiveId,
    athleteId: set.athleteId,
    version: OBJECTIVE_VERSION,
    desiredState: p.desiredState,
    currentState: p.currentState,
    domain: p.domain,
    provenance: { ...p.provenance, origin },
    success: p.success,
    horizon: p.horizon,
    ...(p.athleteStance ? { athleteStance: p.athleteStance } : {}),
    confidence: p.confidence,
    ...(lineage ? { lineage } : {}),
    disposition: "unreviewed",
    lifecycle: "proposed",
    fromProposal: { key: p.key, setId, setAsOf: set.asOf, specVersion: set.specVersion },
    createdAt: now,
  };
  const event: ObjectiveEvent = {
    id: ids.eventId, objectiveId: objective.id, athleteId: objective.athleteId, at: now,
    actor: { userId: null, role: "system" }, action: "presented", said: null, delta: { setId },
  };
  return { objective, event };
}

export interface AthleteObjectiveInput {
  athleteId: string;
  /** Her words. Becomes a MEASURED value she owns. */
  desiredState: string;
  domain: Objective["domain"];
  observableCondition: string;
  horizon?: ObjectiveHorizon;
  /** What she said is true today, if she said. Null is honest. */
  currentState?: string | null;
  /** Her choice: pursuing now, or stated for later. */
  start: "now" | "later";
  /** Set when this replaces a declined proposal — lineage survives on both sides. */
  replaces?: string;
}

/** An Objective with no proposal behind it. Her goal arrives reviewed; Nomila is not its author. */
export function athleteObjective(
  input: AthleteObjectiveInput, actor: Exclude<ObjectiveActor, { role: "system" }>, ids: Ids, now: string,
): { objective: Objective; event: ObjectiveEvent } {
  if (!input.desiredState.trim()) throw new ObjectiveTransitionError("desiredState is empty", "empty_desired_state");
  if (!input.observableCondition.trim()) throw new ObjectiveTransitionError("observableCondition is empty — a wish, not an objective", "empty_condition");
  validateHorizon(input.horizon ?? null);
  const stated: MeasuredValue<string> = {
    value: input.desiredState, owner: "athlete_intelligence", confidence: "HIGH", asOf: now,
    evidenceClass: "MEASURED", evidenceIds: [ids.eventId], sourceMethod: "objective_event",
  };
  const active = input.start === "now";
  const objective: Objective = {
    id: ids.objectiveId, athleteId: input.athleteId, version: OBJECTIVE_VERSION,
    desiredState: stated,
    currentState: null,
    domain: input.domain,
    provenance: {
      origin: "athlete",
      fromOpportunities: [],
      fromAthleteIntent: [{ statePath: `objective_events[${ids.eventId}]`, how: "the athlete stated this objective" }],
      currentStateEvidence: [],
      ...(input.replaces ? { supersedes: input.replaces } : {}),
    },
    success: { observableCondition: input.observableCondition },
    horizon: input.horizon ?? null,
    confidence: "HIGH",
    disposition: "accepted",
    lifecycle: active ? "active" : "proposed",
    createdAt: now, reviewedAt: now, ...(active ? { activatedAt: now } : {}),
  };
  const event: ObjectiveEvent = {
    id: ids.eventId, objectiveId: objective.id, athleteId: objective.athleteId, at: now,
    actor, action: "created", said: input.desiredState, delta: { start: input.start },
  };
  return { objective, event };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions
// ─────────────────────────────────────────────────────────────────────────────

/** objectives-pr3b-design.md §5, as data. `from` is (lifecycle, disposition); the action names what may happen. */
export function allowed(o: Pick<Objective, "lifecycle" | "disposition" | "fromProposal">, action: ObjectiveAction): string | null {
  if (TERMINAL_LIFECYCLES.includes(o.lifecycle)) return `lifecycle ${o.lifecycle} is terminal`;
  switch (action) {
    case "modify":
      // Slice 3 A: she owns an Objective after activation too — she may restate it while `active`.
      return o.lifecycle === "proposed" || o.lifecycle === "active" ? null : `modify requires lifecycle proposed or active; it is ${o.lifecycle}`;
    case "success_confirmed":
      return o.lifecycle === "proposed" || o.lifecycle === "active" ? null : `success_confirmed requires lifecycle proposed or active; it is ${o.lifecycle}`;
    case "accept": case "decline": case "defer":
      if (o.lifecycle !== "proposed") return `${action} is a review decision; lifecycle is ${o.lifecycle}, not proposed`;
      if (!o.fromProposal && (action === "decline" || action === "defer")) return "an athlete does not decline or defer her own objective — she abandons it";
      return null;
    case "abandon": case "achieve":
      return o.lifecycle === "active" ? null : `${action} requires lifecycle active; it is ${o.lifecycle}`;
    case "revisit":
      return o.lifecycle === "proposed" && o.disposition === "deferred" ? null : "only a deferred objective can be revisited";
    case "supersede":
      return null; // proposed or active; terminal already refused above
    case "presented": case "created":
      return `${action} is a creation event, not a transition`;
    case "reaffirmed_by_run": case "re_proposed_while_declined": case "spans_live": case "splits_live": case "may_relate":
      return null; // history only; the row does not move
    case "re_surfaced":
      return o.lifecycle === "proposed" && o.disposition === "deferred" ? null : "only a deferred objective is re-surfaced";
    case "change_assessed":
      return "change_assessed is a system record about her edit, not a transition"; // appended by store.appendChangeAssessment only
  }
}

/**
 * A reconciliation event → the next row. System-authored, never a person's decision. Only `re_surfaced` moves the
 * row: a deferred Objective returns to the queue as `unreviewed`, and her earlier defer stays in the events.
 */
export function applyRunEvent(o: Objective, action: RunAction, delta: ObjectiveDelta, eventId: string, now: string): { objective: Objective; event: ObjectiveEvent } {
  const why = allowed(o, action);
  if (why) throw new ObjectiveTransitionError(why, "not_allowed");
  if (action === "re_surfaced") {
    // The system may re-surface only for a reason the contract admits, and never because evidence changed.
    if (delta.because !== "time_elapsed" && delta.because !== "information_available") throw new ObjectiveTransitionError(`the system may not re-surface for "${delta.because}"`, "bad_resurface");
  }
  const event: ObjectiveEvent = { id: eventId, objectiveId: o.id, athleteId: o.athleteId, at: now, actor: { userId: null, role: "system" }, action, said: null, delta };
  if (action !== "re_surfaced") return { objective: o, event };
  const { deferral: _d, ...rest } = o;
  return { objective: { ...rest, disposition: "unreviewed" }, event };
}

/**
 * A decision → an event and the next row. Throws `ObjectiveTransitionError` rather than returning a row for
 * anything the table refuses. `now` and ids come from the caller so the function stays pure.
 */
export function applyDecision(o: Objective, d: ObjectiveDecision, eventId: string, now: string): { objective: Objective; event: ObjectiveEvent } {
  const why = allowed(o, d.action);
  if (why) throw new ObjectiveTransitionError(why, "not_allowed");
  // The type already excludes `system`; the runtime guard is for callers that arrive untyped (a route body).
  if ((d.actor as ObjectiveActor).role === "system") throw new ObjectiveTransitionError("a decision needs a person", "system_actor");

  let delta: ObjectiveDelta | null = null;
  const base = (): ObjectiveEvent => ({
    id: eventId, objectiveId: o.id, athleteId: o.athleteId, at: now, actor: d.actor, action: d.action,
    said: d.said ?? null, delta,
  });

  switch (d.action) {
    case "accept":
      return { event: base(), objective: { ...o, disposition: "accepted", lifecycle: "active", reviewedAt: now, activatedAt: now } };

    case "modify": {
      const to = (d.desiredState ?? "").trim();
      const successTo = (d.success ?? "").trim();
      const horizonChanges = d.horizon !== undefined && JSON.stringify(d.horizon) !== JSON.stringify(o.horizon);
      if (!to && !horizonChanges && !successTo) throw new ObjectiveTransitionError("modify changes wording, horizon or success; none was given", "empty_modify");
      if (d.horizon !== undefined) validateHorizon(d.horizon);
      const from = o.desiredState.value;
      if (to && to === from) throw new ObjectiveTransitionError("the wording is unchanged", "unchanged_wording");
      // Slice 3 A: keeping the line is `success_confirmed`, never a modify that changes nothing.
      if (successTo && successTo === o.success.observableCondition) throw new ObjectiveTransitionError("the success line is unchanged — to keep it, confirm it", "unchanged_success");
      delta = {
        ...(to ? { desiredState: { from, to } } : {}),
        ...(horizonChanges ? { horizon: { from: o.horizon, to: d.horizon! } } : {}),
        ...(successTo ? { success: { from: o.success.observableCondition, to: successTo } } : {}),
      };
      const ev = base();
      const restated: MeasuredValue<string> | undefined = to ? {
        value: to, owner: "athlete_intelligence", confidence: "HIGH", asOf: now,
        evidenceClass: "MEASURED", evidenceIds: [eventId], sourceMethod: "objective_event",
      } : undefined;
      return {
        event: ev,
        objective: {
          ...o,
          ...(restated ? { desiredState: restated, modifiedFrom: { desiredState: from, at: now } } : {}),
          ...(horizonChanges ? { horizon: d.horizon! } : {}),
          ...(successTo ? { success: { ...o.success, observableCondition: successTo } } : {}),
          // A restatement of an active Objective is not a re-activation: it keeps its original activatedAt.
          // "modified" means she reworded it (it pairs with modifiedFrom); a success-only or horizon-only restatement of an
          // ACTIVE Objective keeps its disposition. From `proposed`, unchanged: the modify is her yes.
          disposition: to || o.lifecycle !== "active" ? "modified" : o.disposition,
          lifecycle: "active", reviewedAt: now, activatedAt: o.lifecycle === "active" && o.activatedAt ? o.activatedAt : now,
        },
      };
    }

    case "success_confirmed":
      // Slice 3 A: she kept the line, reviewed against her CURRENT wording. History only; the row does not move.
      // Whether anything was awaiting her is the caller's check (objective/successReview.ts needs the saved assessments).
      delta = { successConfirmed: { condition: o.success.observableCondition, forWording: o.desiredState.value } };
      return { event: base(), objective: o };

    case "decline":
      return { event: base(), objective: { ...o, disposition: "declined", reviewedAt: now } };

    case "defer": {
      const kind = d.deferral?.kind ?? "information";
      if (!(DEFERRAL_KINDS as readonly string[]).includes(kind)) throw new ObjectiveTransitionError(`deferral kind invalid: ${kind}`, "bad_deferral");
      let after: string | undefined;
      if (kind === "time") {
        const period = d.deferral?.period;
        if (period !== "this_season" && period !== "next_12_months") throw new ObjectiveTransitionError("a time deferral names its period", "bad_deferral");
        after = new Date(Date.parse(now) + DEFER_PERIOD_DAYS[period] * 86_400_000).toISOString();
      }
      const deferral = { kind, ...(after ? { after } : {}), said: d.said ?? null };
      delta = { deferral };
      return { event: base(), objective: { ...o, disposition: "deferred", deferral, reviewedAt: now } };
    }

    case "revisit": {
      // Her own deferred Objective, back in the queue by her hand. The defer stays in the events; the row moves.
      delta = { because: "athlete" };
      const ev = { ...base(), action: "re_surfaced" as const };
      const { deferral: _d, ...rest } = o;
      return { event: ev, objective: { ...rest, disposition: "unreviewed" } };
    }

    case "abandon":
      return { event: base(), objective: { ...o, lifecycle: "abandoned", closedAt: now } };

    case "achieve":
      return { event: base(), objective: { ...o, lifecycle: "achieved", closedAt: now } };

    case "supersede": {
      if (!d.supersededBy) throw new ObjectiveTransitionError("supersede names its successor", "no_successor");
      if (d.supersededBy === o.id) throw new ObjectiveTransitionError("an objective cannot supersede itself", "self_supersede");
      delta = { supersededBy: d.supersededBy };
      return { event: base(), objective: { ...o, lifecycle: "superseded", supersededBy: d.supersededBy, closedAt: now } };
    }
  }
}

function validateHorizon(h: ObjectiveHorizon): void {
  if (h === null) return;
  if (typeof h !== "object" || h.kind !== "period" || !(HORIZON_PERIODS as readonly string[]).includes(h.period) || !String(h.why ?? "").trim()) {
    throw new ObjectiveTransitionError("horizon is a period with a reason, or null — never a date", "bad_horizon");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The fold — events → row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild the MUTABLE fields of an Objective from its creation row and its events, in order. The store's row must
 * equal this; that is the rebuild test (P3). Immutable fields are taken from `created` and never touched.
 *
 * The fold trusts the events' deltas rather than re-running decisions, because an event is a record of what
 * happened, and re-deciding could differ if validation ever changed. It re-checks only the central invariant.
 */
export function fold(created: Objective, events: ObjectiveEvent[]): Objective {
  // Reset every mutable field; the events put them back. `created` is the row AS CREATED (the store keeps that
  // snapshot immutably), so desiredState and horizon here are the originals, whatever a later modify did.
  let o: Objective = {
    ...created,
    disposition: created.fromProposal ? "unreviewed" : "accepted",
    lifecycle: "proposed",
  };
  delete (o as any).modifiedFrom; delete (o as any).supersededBy;
  delete (o as any).reviewedAt; delete (o as any).activatedAt; delete (o as any).closedAt;

  // Events arrive in store order (at, insertion time, id); a stable sort on `at` keeps that order for ties.
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    switch (e.action) {
      case "presented": break;
      case "created":
        o = { ...o, disposition: "accepted", reviewedAt: e.at, ...(e.delta?.start === "now" ? { lifecycle: "active", activatedAt: e.at } : {}) };
        break;
      case "accept": o = { ...o, disposition: "accepted", lifecycle: "active", reviewedAt: e.at, activatedAt: e.at }; break;
      case "modify": {
        const ds = e.delta?.desiredState;
        o = {
          ...o,
          ...(ds ? {
            desiredState: { value: ds.to, owner: "athlete_intelligence", confidence: "HIGH", asOf: e.at, evidenceClass: "MEASURED", evidenceIds: [e.id], sourceMethod: "objective_event" },
            modifiedFrom: { desiredState: ds.from, at: e.at },
          } : {}),
          ...(e.delta?.horizon ? { horizon: e.delta.horizon.to } : {}),
          ...(e.delta?.success ? { success: { ...o.success, observableCondition: e.delta.success.to } } : {}),
          disposition: ds || o.lifecycle !== "active" ? "modified" : o.disposition,
          lifecycle: "active", reviewedAt: e.at, activatedAt: o.lifecycle === "active" && o.activatedAt ? o.activatedAt : e.at,
        };
        break;
      }
      case "decline": o = { ...o, disposition: "declined", reviewedAt: e.at }; break;
      case "defer": o = { ...o, disposition: "deferred", reviewedAt: e.at, ...(e.delta?.deferral ? { deferral: e.delta.deferral } : {}) }; break;
      case "revisit": break; // never persisted as an action: a revisit is a re_surfaced event with an athlete actor
      case "abandon": o = { ...o, lifecycle: "abandoned", closedAt: e.at }; break;
      case "achieve": o = { ...o, lifecycle: "achieved", closedAt: e.at }; break;
      case "supersede": o = { ...o, lifecycle: "superseded", supersededBy: e.delta?.supersededBy, closedAt: e.at }; break;
      case "reaffirmed_by_run": case "re_proposed_while_declined": case "spans_live": case "splits_live": case "may_relate": break;
      case "change_assessed": break; // a record about her edit, never a change to the Objective (Slice 3 B)
      case "success_confirmed": break; // her answer about the success line; the row does not move (Slice 3 A)
      case "re_surfaced": { const { deferral: _d, ...rest } = o; o = { ...rest, disposition: "unreviewed" }; break; }
    }
  }
  const problems = validateObjective(o);
  if (problems.length) throw new ObjectiveTransitionError(`fold produced an invalid objective: ${problems.join("; ")}`, "invalid_fold");
  return o;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation — the invariants, as one function on the path
// ─────────────────────────────────────────────────────────────────────────────

export function validateObjective(o: Objective): string[] {
  const p: string[] = [];
  if (!ACCEPTED_OBJECTIVE_VERSIONS.includes(o.version)) p.push(`version ${o.version} not in ${ACCEPTED_OBJECTIVE_VERSIONS.join(", ")}`);
  if (o.lineage && o.lineage.domain !== o.domain) p.push("lineage.domain differs from domain");
  if (o.deferral && o.disposition !== "deferred") p.push("deferral present but disposition is not deferred");
  if (o.deferral?.kind === "time" && !o.deferral.after) p.push("a time deferral carries `after`");
  // V1 — the central invariant
  if (o.lifecycle === "active" && !(o.disposition === "accepted" || o.disposition === "modified")) p.push("active requires disposition accepted or modified");
  // V2 — an athlete-CREATED objective arrives reviewed and is never declined
  if (!o.fromProposal) {
    if (o.provenance.origin !== "athlete") p.push("an objective with no proposal must be athlete-originated");
    if (o.disposition === "unreviewed") p.push("an athlete's own objective does not arrive unreviewed");
    if (o.disposition === "declined" || o.disposition === "deferred") p.push("an athlete does not decline or defer her own objective");
  }
  // V3 — modified keeps the original
  if (o.disposition === "modified" && !o.modifiedFrom && o.desiredState.owner !== "athlete_intelligence") p.push("modified without modifiedFrom");
  // V5 — supersession is two-sided on this row
  if (o.supersededBy && o.lifecycle !== "superseded") p.push("supersededBy set but lifecycle is not superseded");
  if (o.lifecycle === "superseded" && !o.supersededBy) p.push("superseded without a successor");
  // P1 — origin equals its derivation
  const derived = deriveOrigin(o.provenance.fromOpportunities.length, o.provenance.fromAthleteIntent.length);
  if (derived !== o.provenance.origin) p.push(`origin ${o.provenance.origin} does not match provenance (${derived})`);
  // authorship
  if (o.desiredState.evidenceClass === "MEASURED" && o.desiredState.owner !== "athlete_intelligence") p.push("a MEASURED desiredState must be the athlete's");
  if (o.desiredState.evidenceClass === "EVALUATED" && o.desiredState.owner !== "objectives") p.push("an EVALUATED desiredState must be owned by objectives");
  // shape
  if (!o.success?.observableCondition?.trim()) p.push("success.observableCondition is required");
  if (!o.provenance.currentStateEvidence.length && o.fromProposal) p.push("a proposal-derived objective cites current-state evidence");
  if (TERMINAL_LIFECYCLES.includes(o.lifecycle) && !o.closedAt) p.push(`${o.lifecycle} without closedAt`);
  return p;
}

/** The Brain's only door, as a predicate. Live = active AND the athlete said yes (accepted or modified). */
export const isLive = (o: Pick<Objective, "lifecycle" | "disposition">): boolean =>
  o.lifecycle === "active" && (o.disposition === "accepted" || o.disposition === "modified");

export const isRunAction = (a: ObjectiveAction): a is RunAction => (RUN_ACTIONS as readonly string[]).includes(a);

export type { ObjectiveDisposition, ObjectiveLifecycle };
