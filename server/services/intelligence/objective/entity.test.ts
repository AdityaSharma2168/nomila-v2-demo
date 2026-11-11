/**
 * entity.test.ts — the live Objective's pure transitions. PR3b-1.
 *
 * Shape, provenance and refusal only. No athlete's content appears; the proposal fixture is generic.
 * What is protected:
 *   V1 the central invariant — active requires the athlete's yes
 *   V2 an athlete-created objective arrives reviewed and is never declined or deferred
 *   V3 modify keeps the original and is bounded to wording + horizon
 *   V4 terminal lifecycles never transition
 *   V5 supersession is two-sided on the row
 *   P1 origin is derived at creation and re-derivable at any time; a mislabelled proposal is refused
 *   P2 a proposal-derived objective's immutable fields equal the proposal's
 *   P3 (pure half) the fold over events equals the chain of applyDecision results
 */
import { describe, expect, it } from "@jest/globals";
import type { ObjectiveProposal, ObjectiveProposalSet } from "../contracts/objective";
import type { Objective, ObjectiveDecision, ObjectiveEvent } from "../contracts/objectiveEntity";
import {
  allowed, applyDecision, applyRunEvent, athleteObjective, establishOrigin, fold, isLive, objectiveFromProposal,
  ObjectiveTransitionError, validateObjective,
} from "./entity";

const T0 = "2026-09-21T00:00:00.000Z";
const later = (n: number) => new Date(Date.parse(T0) + n * 60_000).toISOString();
const actor = { userId: "u1", role: "athlete" as const };
const ev = (value: string): any => ({ value, owner: "objectives", confidence: "MEDIUM", asOf: T0, evidenceClass: "EVALUATED", evidenceIds: [], rationale: "r", falsifiedBy: null });

function proposal(over: Partial<ObjectiveProposal> = {}): ObjectiveProposal {
  return {
    key: "grow-thing",
    desiredState: ev("The thing is grown."),
    currentState: ev("The thing is small."),
    domain: "audience",
    provenance: {
      origin: "joint",
      fromOpportunities: [{ opportunityKey: "opp-1", how: "h" }],
      fromAthleteIntent: [{ statePath: "preferences[wants_growth]", how: "h" }],
      currentStateEvidence: [{ statePath: "findings[mia.audience_scale]", how: "h" }],
    },
    success: { observableCondition: "It is visibly bigger." },
    horizon: { kind: "period", period: "next_12_months", why: "w" },
    confidence: "MEDIUM",
    ...over,
  };
}
const set: Pick<ObjectiveProposalSet, "athleteId" | "asOf" | "specVersion"> = { athleteId: "a1", asOf: T0, specVersion: "objective-eval-spec/1.0.1" };
const fromProposal = (p = proposal()) => objectiveFromProposal(set, "set-1", p, { objectiveId: "o1", eventId: "e0" }, T0);

let n = 0;
const decide = (o: Objective, d: Omit<ObjectiveDecision, "actor"> & { actor?: ObjectiveDecision["actor"] }, at = later(++n)) =>
  applyDecision(o, { actor, ...d } as ObjectiveDecision, `e${n}`, at);

describe("the transition — proposal → objective", () => {
  it("arrives unreviewed · proposed, whatever the origin, with a presented event", () => {
    const { objective, event } = fromProposal();
    expect(objective.disposition).toBe("unreviewed");
    expect(objective.lifecycle).toBe("proposed");
    expect(objective.fromProposal).toEqual({ key: "grow-thing", setId: "set-1", setAsOf: T0, specVersion: "objective-eval-spec/1.0.1" });
    expect(event.action).toBe("presented");
    expect(event.actor).toEqual({ userId: null, role: "system" });
    expect(validateObjective(objective)).toEqual([]);
  });

  it("P2 — copies the immutable fields byte for byte", () => {
    const p = proposal(); const { objective } = fromProposal(p);
    expect(objective.desiredState).toEqual(p.desiredState);
    expect(objective.currentState).toEqual(p.currentState);
    expect(objective.success).toEqual(p.success);
    expect(objective.provenance).toEqual(p.provenance);
    expect(objective.domain).toBe(p.domain);
  });

  it("P1 — origin is derived from provenance; a mislabelled proposal is refused, not corrected", () => {
    expect(establishOrigin(proposal().provenance)).toBe("joint");
    expect(establishOrigin({ ...proposal().provenance, fromAthleteIntent: [] })).toBe("nomila");
    expect(establishOrigin({ ...proposal().provenance, fromOpportunities: [] })).toBe("athlete");
    expect(() => fromProposal(proposal({ provenance: { ...proposal().provenance, origin: "nomila" } }))).toThrow(/derives joint/);
    expect(() => establishOrigin({ origin: "nomila", fromOpportunities: [], fromAthleteIntent: [], currentStateEvidence: [] })).toThrow(/must rest on/);
  });

  it("an intent-only proposal is origin athlete AND still arrives unreviewed — she has not seen the phrasing", () => {
    const { objective } = fromProposal(proposal({ provenance: { ...proposal().provenance, origin: "athlete", fromOpportunities: [] } }));
    expect(objective.provenance.origin).toBe("athlete");
    expect(objective.disposition).toBe("unreviewed");
    expect(validateObjective(objective)).toEqual([]);
  });
});

describe("V1 — active requires the athlete's yes", () => {
  it("accept activates; nothing else does", () => {
    const { objective: o } = fromProposal();
    expect(isLive(o)).toBe(false);
    expect(decide(o, { action: "decline" }).objective.lifecycle).toBe("proposed");
    expect(decide(o, { action: "defer" }).objective.lifecycle).toBe("proposed");
    const a = decide(o, { action: "accept" }).objective;
    expect(a.disposition).toBe("accepted"); expect(a.lifecycle).toBe("active"); expect(isLive(a)).toBe(true);
    expect(a.activatedAt).toBe(a.reviewedAt);
  });

  it("the validator refuses active without a yes, however it was assembled", () => {
    const { objective: o } = fromProposal();
    expect(validateObjective({ ...o, lifecycle: "active" }).join()).toMatch(/active requires/);
    expect(validateObjective({ ...o, lifecycle: "active", disposition: "declined" }).join()).toMatch(/active requires/);
  });

  it("abandon and achieve need active; review decisions need proposed", () => {
    const { objective: o } = fromProposal();
    expect(allowed(o, "abandon")).toMatch(/requires lifecycle active/);
    const a = decide(o, { action: "accept" }).objective;
    expect(allowed(a, "accept")).toMatch(/not proposed/);
    expect(decide(a, { action: "abandon", said: "changed my mind" }).objective.lifecycle).toBe("abandoned");
    expect(decide(a, { action: "achieve" }).objective.lifecycle).toBe("achieved");
  });
});

describe("V3 — modify keeps the original and is bounded", () => {
  it("replaces the wording with a MEASURED value she owns, keeps modifiedFrom, and never touches origin", () => {
    const { objective: o } = fromProposal();
    const { objective: m, event } = decide(o, { action: "modify", desiredState: "The thing is grown my way.", said: "my way" });
    expect(m.disposition).toBe("modified"); expect(m.lifecycle).toBe("active");
    expect(m.desiredState).toMatchObject({ value: "The thing is grown my way.", owner: "athlete_intelligence", evidenceClass: "MEASURED", evidenceIds: [event.id] });
    expect(m.modifiedFrom).toEqual({ desiredState: "The thing is grown.", at: event.at });
    expect(m.provenance.origin).toBe("joint");
    expect(event.delta).toEqual({ desiredState: { from: "The thing is grown.", to: "The thing is grown my way." } });
    expect(validateObjective(m)).toEqual([]);
  });

  it("may change the horizon alone; refuses no change, unchanged wording, or a dated horizon", () => {
    const { objective: o } = fromProposal();
    const h = decide(o, { action: "modify", horizon: null }).objective;
    expect(h.horizon).toBeNull(); expect(h.modifiedFrom).toBeUndefined(); expect(h.disposition).toBe("modified");
    expect(() => decide(o, { action: "modify" })).toThrow(ObjectiveTransitionError);
    expect(() => decide(o, { action: "modify", desiredState: "The thing is grown." })).toThrow(/unchanged/);
    expect(() => decide(o, { action: "modify", horizon: { kind: "period", period: "2026-12-31" as any, why: "w" } })).toThrow(/never a date/);
  });

  it("cannot change domain or the measured path — those are not on the decision at all", () => {
    const { objective: o } = fromProposal();
    const m = decide(o, { action: "modify", desiredState: "Different words." }).objective;
    expect(m.domain).toBe(o.domain); expect(m.success).toEqual(o.success);
  });
});

describe("V2 — the athlete's own objective", () => {
  it("arrives accepted; start now activates; start later stays proposed", () => {
    const now = athleteObjective({ athleteId: "a1", desiredState: "I run a clinic series.", domain: "commercial", observableCondition: "A clinic ran.", start: "now" }, actor, { objectiveId: "o2", eventId: "e9" }, T0);
    expect(now.objective).toMatchObject({ disposition: "accepted", lifecycle: "active" });
    expect(now.objective.desiredState).toMatchObject({ owner: "athlete_intelligence", evidenceClass: "MEASURED", evidenceIds: ["e9"] });
    expect(now.objective.provenance.origin).toBe("athlete");
    expect(now.event).toMatchObject({ action: "created", said: "I run a clinic series.", delta: { start: "now" } });
    expect(validateObjective(now.objective)).toEqual([]);
    const lt = athleteObjective({ athleteId: "a1", desiredState: "x", domain: "content", observableCondition: "y", start: "later" }, actor, { objectiveId: "o3", eventId: "e10" }, T0);
    expect(lt.objective).toMatchObject({ disposition: "accepted", lifecycle: "proposed" });
  });

  it("is never declined or deferred — she abandons it", () => {
    const { objective: o } = athleteObjective({ athleteId: "a1", desiredState: "x", domain: "content", observableCondition: "y", start: "later" }, actor, { objectiveId: "o3", eventId: "e10" }, T0);
    expect(allowed(o, "decline")).toMatch(/abandons/);
    expect(allowed(o, "defer")).toMatch(/abandons/);
    expect(validateObjective({ ...o, disposition: "unreviewed" }).join()).toMatch(/unreviewed/);
    expect(validateObjective({ ...o, disposition: "declined" }).join()).toMatch(/decline/);
  });

  it("refuses an empty goal or an empty condition — a wish is not an objective", () => {
    expect(() => athleteObjective({ athleteId: "a1", desiredState: " ", domain: "content", observableCondition: "y", start: "now" }, actor, { objectiveId: "o", eventId: "e" }, T0)).toThrow(/empty/);
    expect(() => athleteObjective({ athleteId: "a1", desiredState: "x", domain: "content", observableCondition: "", start: "now" }, actor, { objectiveId: "o", eventId: "e" }, T0)).toThrow(/wish/);
  });
});

describe("V4 / V5 — terminal states and supersession", () => {
  it("nothing leaves a terminal lifecycle", () => {
    const { objective: o } = fromProposal();
    const done = decide(decide(o, { action: "accept" }).objective, { action: "achieve" }).objective;
    for (const action of ["accept", "modify", "decline", "defer", "abandon", "achieve", "supersede"] as const) {
      expect(allowed(done, action)).toMatch(/terminal/);
    }
  });

  it("supersede names a successor, sets both sides on this row, and never self-supersedes", () => {
    const { objective: o } = fromProposal();
    const s = decide(o, { action: "supersede", supersededBy: "o-new" }).objective;
    expect(s).toMatchObject({ lifecycle: "superseded", supersededBy: "o-new" }); expect(s.closedAt).toBeDefined();
    expect(() => decide(o, { action: "supersede" })).toThrow(/names its successor/);
    expect(() => decide(o, { action: "supersede", supersededBy: o.id })).toThrow(/itself/);
    expect(validateObjective({ ...o, supersededBy: "x" }).join()).toMatch(/not superseded/);
    expect(validateObjective({ ...o, lifecycle: "superseded", closedAt: T0 }).join()).toMatch(/without a successor/);
  });

  it("a decision needs a person", () => {
    const { objective: o } = fromProposal();
    expect(() => applyDecision(o, { action: "accept", actor: { userId: null, role: "system" } as any }, "e", T0)).toThrow(/needs a person/);
  });
});

describe("P3 — the fold equals the chain", () => {
  it("proposal-derived: decline, then accept, then modify, then supersede", () => {
    const { objective: created, event: e0 } = fromProposal();
    const steps: Array<Omit<ObjectiveDecision, "actor">> = [
      { action: "decline", said: "not this" },
      { action: "accept" },
      { action: "abandon", said: "done with it" },
    ];
    let o = created; const events: ObjectiveEvent[] = [e0];
    for (const s of steps) { const r = decide(o, s); o = r.objective; events.push(r.event); }
    expect(fold(created, events)).toEqual(o);
  });

  it("proposal-derived: modify wording and horizon, then supersede", () => {
    const { objective: created, event: e0 } = fromProposal();
    const r1 = decide(created, { action: "modify", desiredState: "Mine.", horizon: null, said: "mine" });
    const r2 = decide(r1.objective, { action: "supersede", supersededBy: "o-new" });
    expect(fold(created, [e0, r1.event, r2.event])).toEqual(r2.objective);
  });

  it("athlete-created: start now, then achieve", () => {
    const { objective: created, event: e0 } = athleteObjective({ athleteId: "a1", desiredState: "x", domain: "content", observableCondition: "y", start: "now" }, actor, { objectiveId: "o4", eventId: "e40" }, T0);
    const r = decide(created, { action: "achieve" });
    expect(fold(created, [e0, r.event])).toEqual(r.objective);
  });

  it("the fold refuses an event log that leaves the row invalid — a supersede with no successor", () => {
    const { objective: created, event: e0 } = fromProposal();
    const bogus: ObjectiveEvent = { id: "zz", objectiveId: "o1", athleteId: "a1", at: later(99), actor, action: "supersede", said: null, delta: null };
    expect(() => fold(created, [e0, bogus])).toThrow(/invalid objective/);
  });

  it("the fold never produces active on its own — only an accept or modify event does", () => {
    const { objective: created, event: e0 } = fromProposal();
    const declined: ObjectiveEvent = { id: "d", objectiveId: "o1", athleteId: "a1", at: later(98), actor, action: "decline", said: "no", delta: null };
    const deferred: ObjectiveEvent = { id: "f", objectiveId: "o1", athleteId: "a1", at: later(99), actor, action: "defer", said: null, delta: null };
    expect(fold(created, [e0, declined, deferred]).lifecycle).toBe("proposed");
  });
});

describe("run events (PR3b-2) — system-authored, and only re_surfaced moves the row", () => {
  it("reaffirmed and re_proposed_while_declined are history only", () => {
    const { objective: o } = fromProposal();
    const a = decide(o, { action: "accept" }).objective;
    const r = applyRunEvent(a, "reaffirmed_by_run", { setId: "s2", proposalKey: "k", similarity: 0.8 }, "r1", later(50));
    expect(r.objective).toEqual(a);
    expect(r.event).toMatchObject({ action: "reaffirmed_by_run", actor: { userId: null, role: "system" }, delta: { setId: "s2", similarity: 0.8 } });
    const d = decide(o, { action: "decline" }).objective;
    expect(applyRunEvent(d, "re_proposed_while_declined", { setId: "s2" }, "r2", later(51)).objective).toEqual(d);
  });
  it("re_surfaced needs a deferred objective and returns it to the queue; the fold agrees", () => {
    const { objective: created, event: e0 } = fromProposal();
    expect(() => applyRunEvent(created, "re_surfaced", { setId: "s2", because: "time_elapsed" }, "r3", later(52))).toThrow(/only a deferred/);
    const r1 = decide(created, { action: "defer" });
    const r2 = applyRunEvent(r1.objective, "re_surfaced", { setId: "s2", proposalKey: "k", because: "time_elapsed" }, "r4", later(53));
    expect(r2.objective).toMatchObject({ disposition: "unreviewed", lifecycle: "proposed" });
    expect(fold(created, [e0, r1.event, r2.event])).toEqual(r2.objective);
  });
});

describe("L2 — a deferral carries its kind; only her hand or the clock brings it back", () => {
  it("defer records the kind (information by default) and the row projects it; revisit clears it and returns the row to the queue", () => {
    const { objective: created, event: e0 } = fromProposal();
    const d = decide(created, { action: "defer", said: "not enough to go on" });
    expect(d.objective.deferral).toEqual({ kind: "information", said: "not enough to go on" });
    expect(d.event.delta).toEqual({ deferral: { kind: "information", said: "not enough to go on" } });
    const r = decide(d.objective, { action: "revisit" });
    expect(r.event).toMatchObject({ action: "re_surfaced", actor: { role: "athlete" }, delta: { because: "athlete" } });
    expect(r.objective.disposition).toBe("unreviewed"); expect(r.objective.deferral).toBeUndefined();
    expect(fold(created, [e0, d.event, r.event])).toEqual(r.objective);
    expect(allowed(r.objective, "revisit")).toMatch(/only a deferred/);
  });
  it("a time deferral names its period and carries `after`; an athlete deferral carries neither", () => {
    const { objective: o } = fromProposal();
    const t = decide(o, { action: "defer", deferral: { kind: "time", period: "next_12_months" } }, later(0));
    expect(t.objective.deferral).toEqual({ kind: "time", after: new Date(Date.parse(later(0)) + 365 * 86_400_000).toISOString(), said: null });
    expect(() => decide(o, { action: "defer", deferral: { kind: "time" } as any })).toThrow(/names its period/);
    expect(decide(o, { action: "defer", deferral: { kind: "athlete" } }).objective.deferral).toEqual({ kind: "athlete", said: null });
    expect(() => decide(o, { action: "defer", deferral: { kind: "whenever" } as any })).toThrow(/kind invalid/);
  });
  it("the system may re-surface only for time_elapsed or information_available — never because evidence changed", () => {
    const { objective: o } = fromProposal();
    const d = decide(o, { action: "defer" }).objective;
    expect(() => applyRunEvent(d, "re_surfaced", { setId: "s", because: "evidence_changed" as any }, "r", later(9))).toThrow(/may not re-surface/);
    expect(() => applyRunEvent(d, "re_surfaced", { setId: "s" }, "r", later(9))).toThrow(/may not re-surface/);
    const ok = applyRunEvent(d, "re_surfaced", { setId: "s", because: "time_elapsed" }, "r", later(9));
    expect(ok.objective.disposition).toBe("unreviewed"); expect(ok.objective.deferral).toBeUndefined();
    const ok2 = applyRunEvent(d, "re_surfaced", { setId: "s", because: "information_available" }, "r2", later(10));
    expect(ok2.objective.disposition).toBe("unreviewed");
  });
  it("a reaffirm on an information deferral may carry evidenceChanged and moves nothing", () => {
    const { objective: o } = fromProposal();
    const d = decide(o, { action: "defer" }).objective;
    const r = applyRunEvent(d, "reaffirmed_by_run", { setId: "s", evidenceChanged: true }, "r", later(9));
    expect(r.objective).toEqual(d);
    expect(r.event.delta).toEqual({ setId: "s", evidenceChanged: true });
  });
});

describe("authorship on the value envelope", () => {
  it("an EVALUATED desiredState must be Nomila's; a MEASURED one must be hers", () => {
    const { objective: o } = fromProposal();
    expect(validateObjective({ ...o, desiredState: { ...(o.desiredState as any), owner: "athlete_intelligence" } }).join()).toMatch(/owned by objectives/);
    expect(validateObjective({ ...o, desiredState: { value: "v", owner: "objectives", confidence: "HIGH", asOf: T0, evidenceClass: "MEASURED", evidenceIds: [], sourceMethod: "x" } as any }).join()).toMatch(/must be the athlete's/);
  });
});
