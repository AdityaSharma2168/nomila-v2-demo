/**
 * grounding.test.ts — a proposal's claims about its own inputs must be true against the exact state and map given.
 *
 * Resolution ≠ entailment; nothing here claims otherwise. These prove the deterministic invariants: paths and keys
 * resolve, intent is a WANTS, a quantified metric holds a number, every opportunity is accounted for exactly once,
 * and origin can be derived from what is cited.
 */
import { describe, expect, it } from "@jest/globals";
import { deriveOrigin, jaccard, numericAt, validateObjectiveGrounding } from "./grounding";
import { ATHLETE_STATE_VERSION, type AthleteState } from "../contracts/athleteState";
import { OPPORTUNITY_MAP_VERSION, type OpportunityMap } from "../contracts/opportunity";

const T = "2026-09-21T00:00:00.000Z";
const measured = <V,>(value: V, owner = "marketability"): any => ({ value, owner, confidence: "HIGH", asOf: T, evidenceClass: "MEASURED", evidenceIds: ["e1"], sourceMethod: "test" });
const evaluated = (value: string): any => ({ value, owner: "opportunity", confidence: "MEDIUM", asOf: T, evidenceClass: "EVALUATED", evidenceIds: [], rationale: "r", falsifiedBy: null });

const state: AthleteState = {
  athleteId: "a1", asOf: T, version: ATHLETE_STATE_VERSION,
  identity: { name: "Test Athlete", sport: "handball", competitionContext: null, careerStatus: "active" },
  findings: [{ key: "mia.narrative_power", direction: "strength", basis: measured(88), evidence: [{ source: "mia", locator: "row-1", asOf: T }] }],
  audienceTrajectory: { value: null, owner: "athlete_intelligence", asOf: T, evidenceClass: "MISSING", reason: "none" } as any,
  commercialPosition: { closedDeals: measured(1, "athlete_state"), activeRelationships: measured(["Acme"], "athlete_state"), demonstratedEconomics: measured({ low: 1000, high: 1000, currency: "USD" }, "athlete_state"), pricingEvidence: "athlete_transactions", pipeline: { value: { detected: 0, negotiating: 0, rejected: 0, accepted: 1, completed: 0 }, owner: "athlete_state", confidence: "HIGH", asOf: "x", evidenceClass: "MEASURED", evidenceIds: [], sourceMethod: "test" } as any, inbound: [] },
  constraints: [],
  preferences: [
    { subject: "wants_fashion_venture", stance: "wants", source: { source: "assertion", locator: "x", asOf: T }, note: "I want to build a fashion business" },
    { subject: "avoids_coaching", stance: "avoids", source: { source: "assertion", locator: "y", asOf: T } },
  ],
  audience: [], contentPerformance: [], representation: null, dates: [], athleteNotes: [],
  materialGaps: ["Audience demographics unavailable."],
  overallConfidence: "MEDIUM", sources: [],
};

const opp = (key: string, statement: string): OpportunityMap["opportunities"][number] => ({
  key, kind: "AMPLIFY", domain: "positioning", statement: evaluated(statement),
  restsOn: [{ statePath: "findings[mia.narrative_power]", how: "h" }],
  impact: { level: "medium", claim: "c" }, feasibility: { level: "medium", claim: "c" }, urgency: null, confidence: "MEDIUM",
});
const map: OpportunityMap = {
  athleteId: "a1", asOf: T, version: OPPORTUNITY_MAP_VERSION, specVersion: "opportunity-eval-spec/1.0.0", stateAsOf: T,
  opportunities: [opp("amplify-story", "Extend her public positioning as a trailblazer."), opp("amplify-impact", "Scale her Northfield involvement into co-branded initiatives.")],
  notes: [], inputs: [], overallConfidence: "MEDIUM",
};

const proposal = (over: Partial<Record<string, any>> = {}) => ({
  key: "p1",
  desired_state: "Her impact work is a commercially legible part of her public identity.",
  current_state: "Her impact work is documented but partners do not describe her by it.",
  rationale: "r", domain: "impact",
  from_opportunities: [{ opportunity_key: "amplify-impact", how: "h" }],
  from_athlete_intent: [],
  current_state_evidence: [{ state_path: "findings[mia.narrative_power]", how: "h" }],
  success: { observable_condition: "Inbound interest references her impact work.", quantified: null },
  horizon: null, athlete_stance: null, confidence: "MEDIUM",
  ...over,
});
const body = (proposals: any[], notes: any[] = [{ opportunity_key: "amplify-story", outcome: "not_carried", why: "w" }]) => ({ proposals, notes });
const reasons = (ps: ReturnType<typeof validateObjectiveGrounding>) => ps.map((p) => p.reason).join("\n");

describe("grounding — citations resolve", () => {
  it("passes a fully grounded set", () => {
    expect(validateObjectiveGrounding(state, map, body([proposal()]))).toEqual([]);
  });

  it("rejects an invented state path and an invented opportunity key", () => {
    expect(reasons(validateObjectiveGrounding(state, map, body([proposal({ current_state_evidence: [{ state_path: "findings[mia.invented]", how: "h" }] })])))).toContain("is not in the athlete state");
    expect(reasons(validateObjectiveGrounding(state, map, body([proposal({ from_opportunities: [{ opportunity_key: "nope", how: "h" }] })])))).toContain('"nope" is not in the opportunity map');
  });

  it("athlete intent must be a preference with stance WANTS", () => {
    const wants = proposal({ from_opportunities: [], from_athlete_intent: [{ state_path: "preferences[wants_fashion_venture]", how: "h" }] });
    expect(validateObjectiveGrounding(state, map, body([wants], [{ opportunity_key: "amplify-story", outcome: "not_carried", why: "w" }, { opportunity_key: "amplify-impact", outcome: "not_carried", why: "w" }]))).toEqual([]);
    // A refusal cannot create an objective — it bears on one.
    const avoids = proposal({ from_athlete_intent: [{ state_path: "preferences[avoids_coaching]", how: "h" }] });
    expect(reasons(validateObjectiveGrounding(state, map, body([avoids])))).toContain('stance "wants"');
    // And a non-preference is not intent at all.
    const notPref = proposal({ from_athlete_intent: [{ state_path: "findings[mia.narrative_power]", how: "h" }] });
    expect(reasons(validateObjectiveGrounding(state, map, body([notPref])))).toContain("not a preference");
  });
});

describe("grounding — outcome, not opening", () => {
  it("rejects a desired_state identical to current_state", () => {
    const same = proposal({ desired_state: "X is true.", current_state: "x is true." });
    expect(reasons(validateObjectiveGrounding(state, map, body([same])))).toContain("identical to current_state");
  });

  it("rejects a near-restatement of the cited opportunity (heuristic)", () => {
    const copy = proposal({ desired_state: "Scale her Northfield involvement into co-branded initiatives." });
    expect(reasons(validateObjectiveGrounding(state, map, body([copy])))).toContain("near-restatement of opportunity");
    expect(jaccard("Scale her Northfield involvement into co-branded initiatives", "scale her northfield involvement into co-branded initiatives")).toBe(1);
  });

  it("1.1.0: a second-person copy of a third-person opening is still a near-restatement (pronouns are not wording)", () => {
    const copy = proposal({ desired_state: "Extend your public positioning as a trailblazer.", from_opportunities: [{ opportunity_key: "amplify-story", how: "h" }] });
    expect(reasons(validateObjectiveGrounding(state, map, body([copy], [{ opportunity_key: "amplify-impact", outcome: "not_carried", why: "w" }])))).toContain('near-restatement of opportunity "amplify-story"');
    expect(jaccard("Extend her public positioning", "Extend your public positioning")).toBe(1);
    expect(jaccard("She leads the crew", "You lead the crew")).toBeLessThan(1);   // verb agreement is wording; only pronouns are not
  });

  it("rejects two proposals sharing a desired state", () => {
    const a = proposal({ key: "a" }), b = proposal({ key: "b", from_opportunities: [{ opportunity_key: "amplify-story", how: "h" }] });
    expect(reasons(validateObjectiveGrounding(state, map, body([a, b], [])))).toContain("two objectives may not share a desired state");
  });
});

describe("grounding — quantification is evidence-bound", () => {
  it("accepts a metric whose path holds a number and rejects one that does not", () => {
    const num = proposal({ success: { observable_condition: "x", quantified: { metric: "closed deals", state_path: "commercialPosition.closedDeals", direction: "increase", target: null } } });
    expect(validateObjectiveGrounding(state, map, body([num]))).toEqual([]);
    const score = proposal({ success: { observable_condition: "x", quantified: { metric: "narrative", state_path: "findings[mia.narrative_power].basis", direction: "maintain", target: null } } });
    expect(validateObjectiveGrounding(state, map, body([score]))).toEqual([]);
    const prose = proposal({ success: { observable_condition: "x", quantified: { metric: "gap", state_path: "materialGaps[0]", direction: "decrease", target: null } } });
    expect(reasons(validateObjectiveGrounding(state, map, body([prose])))).toContain("holds no number");
  });

  it("numericAt reads a MEASURED envelope or a bare number, nothing else", () => {
    expect(numericAt(measured(7))).toBe(7);
    expect(numericAt(7)).toBe(7);
    expect(numericAt("7")).toBeNull();
    expect(numericAt({ value: null, evidenceClass: "MISSING" })).toBeNull();
    expect(numericAt({ value: 7, evidenceClass: "EVALUATED" })).toBeNull();
  });
});

describe("grounding — every opportunity exactly once", () => {
  it("flags a silent drop", () => {
    expect(reasons(validateObjectiveGrounding(state, map, body([proposal()], [])))).toContain('"amplify-story" is neither carried by a proposal nor accounted for in notes');
  });

  it("flags an opportunity both carried and noted", () => {
    expect(reasons(validateObjectiveGrounding(state, map, body([proposal()], [{ opportunity_key: "amplify-impact", outcome: "not_carried", why: "w" }, { opportunity_key: "amplify-story", outcome: "not_carried", why: "w" }])))).toContain("appears both in a proposal's provenance and in notes");
  });

  it("a consolidation must name a proposal in this set", () => {
    expect(reasons(validateObjectiveGrounding(state, map, body([proposal()], [{ opportunity_key: "amplify-story", outcome: "consolidated", into: "ghost", why: "w" }])))).toContain('"ghost", which is not a proposal in this set');
    expect(validateObjectiveGrounding(state, map, body([proposal()], [{ opportunity_key: "amplify-story", outcome: "consolidated", into: "p1", why: "w" }]))).toEqual([]);
  });

  it("an empty proposal set is valid when every opportunity is noted", () => {
    expect(validateObjectiveGrounding(state, map, body([], [{ opportunity_key: "amplify-story", outcome: "not_carried", why: "w" }, { opportunity_key: "amplify-impact", outcome: "not_carried", why: "w" }]))).toEqual([]);
  });

  it("refuses a map judged from a different state", () => {
    expect(reasons(validateObjectiveGrounding({ ...state, asOf: "2026-09-22T00:00:00.000Z" }, map, body([proposal()])))).toContain("judged from a state as of");
  });
});

describe("origin is derived, never read", () => {
  it("maps the three cases and refuses none", () => {
    expect(deriveOrigin(2, 0)).toBe("nomila");
    expect(deriveOrigin(0, 1)).toBe("athlete");
    expect(deriveOrigin(1, 1)).toBe("joint");
    expect(deriveOrigin(0, 0)).toBeNull();
  });
});
