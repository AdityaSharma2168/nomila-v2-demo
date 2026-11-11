/**
 * context.test.ts — the review context resolves structured evidence; it never parses rendered prose. L0.
 */
import { describe, expect, it } from "@jest/globals";
import { ATHLETE_STATE_VERSION, type AthleteState } from "../contracts/athleteState";
import type { Objective } from "../contracts/objectiveEntity";
import { OPPORTUNITY_MAP_VERSION, type OpportunityMap } from "../contracts/opportunity";
import { describeStateValue, reviewContextFor } from "./context";

const T = "2026-09-21T00:00:00.000Z";
const measured = <V,>(value: V, owner = "athlete_state"): any => ({ value, owner, confidence: "MEDIUM", asOf: T, evidenceClass: "MEASURED", evidenceIds: ["e"], sourceMethod: "test" });
const ev = (value: string): any => ({ value, owner: "opportunity", confidence: "HIGH", asOf: T, evidenceClass: "EVALUATED", evidenceIds: [], rationale: "r", falsifiedBy: null });

const state: AthleteState = {
  athleteId: "a1", asOf: T, version: ATHLETE_STATE_VERSION,
  identity: { name: "Test Athlete", sport: null, competitionContext: null, careerStatus: null },
  findings: [{ key: "mia.audience_scale", direction: "neutral", basis: measured(50, "marketability"), imputedShare: { imputed: 0, total: 4 }, evidence: [] }],
  audienceTrajectory: { value: null, owner: "athlete_intelligence", asOf: T, evidenceClass: "MISSING", reason: "no growth measurement" } as any,
  commercialPosition: {
    closedDeals: measured(1), activeRelationships: measured(["Acme"]),
    demonstratedEconomics: { value: null, owner: "athlete_state", asOf: T, evidenceClass: "MISSING", reason: "none" } as any,
    pricingEvidence: "none",
    pipeline: measured({ detected: 3, negotiating: 1, rejected: 0, accepted: 1, completed: 0 }),
    inbound: [{ category: "PAID", counterparty: "Acme", deadline: null, confidence: 0.9, lastMessageAt: "2026-09-14T00:00:00.000Z", threadStatus: "read", evidence: { source: "inbox", locator: "t1", asOf: T } }],
  },
  constraints: [],
  preferences: [{ subject: "onboarding_goal.grow", stance: "wants", source: { source: "onboarding", locator: "athletes.goal_archetype", asOf: T }, note: "grow", recordedAs: { method: "onboarding_v1_choice", at: "2026-05-30T00:00:00.000Z" } }],
  audience: [], contentPerformance: [{ platform: "instagram", postsPerWeek: 0.4667, daysSinceLastPost: 10.1, asOf: T, evidence: [] }], representation: null, dates: [], athleteNotes: [],
  materialGaps: ["Adidas terms"], overallConfidence: "LOW", sources: [],
};
const map: OpportunityMap = {
  athleteId: "a1", asOf: T, version: OPPORTUNITY_MAP_VERSION, specVersion: "opportunity-eval-spec/1.0.0", stateAsOf: T,
  opportunities: [{ key: "grow-cadence", kind: "GROW", domain: "content", statement: ev("Post more often to reverse the cooling trajectory."), restsOn: [], impact: { level: "medium", claim: "c" }, feasibility: { level: "high", claim: "c" }, urgency: null, confidence: "HIGH" } as any],
  notes: [], inputs: { stateBlock: "" } as any, overallConfidence: "MEDIUM",
};
const objective = (): Objective => ({
  id: "o1", athleteId: "a1", version: "objective/1.1.0",
  desiredState: { value: "Outcome.", owner: "objectives", confidence: "MEDIUM", asOf: T, evidenceClass: "EVALUATED", evidenceIds: [], rationale: "Because.", falsifiedBy: null },
  currentState: null, domain: "content",
  provenance: {
    origin: "joint",
    fromOpportunities: [{ opportunityKey: "grow-cadence", how: "carries it" }, { opportunityKey: "missing-key", how: "h" }],
    fromAthleteIntent: [{ statePath: "preferences[onboarding_goal.grow]", how: "she chose it" }],
    currentStateEvidence: [
      { statePath: "findings[mia.audience_scale]", how: "mid" }, { statePath: "commercialPosition.pipeline", how: "counts" },
      { statePath: "commercialPosition.inbound[0]", how: "a thread" }, { statePath: "contentPerformance[instagram]", how: "cadence" },
      { statePath: "materialGaps[0]", how: "gap" }, { statePath: "materialGaps[9]", how: "absent" }, { statePath: "audienceTrajectory", how: "missing" },
    ],
  },
  success: { observableCondition: "Seen." }, horizon: null, confidence: "MEDIUM",
  disposition: "unreviewed", lifecycle: "proposed", createdAt: T,
});

describe("reviewContextFor resolves every citation structurally", () => {
  it("resolves each cited path through the grounding grammar and describes the value; an unresolvable path is null", () => {
    const c = reviewContextFor(objective(), { state, map });
    expect(c.rationale).toBe("Because.");
    expect(c.evidence.map((e) => e.line)).toEqual([
      "NEUTRAL · score 50 · 0/4 signals imputed",
      '{"detected":3,"negotiating":1,"rejected":0,"accepted":1,"completed":0}  [measured · MEDIUM confidence]',
      "PAID · Acme · 2026-09-14",
      "0.4667 posts/week · 10.1 days since last post",
      "Adidas terms",
      null,
      "not known (no growth measurement)",
    ]);
    expect(c.intent[0]!.line).toBe('wants — "grow"  [ONBOARDING CHOICE · 2026-05-30]');
  });
  it("reads the opportunity from the map by key; null for a key the map does not carry", () => {
    const c = reviewContextFor(objective(), { state, map });
    expect(c.opportunities).toEqual([
      { key: "grow-cadence", how: "carries it", kind: "GROW", statement: "Post more often to reverse the cooling trajectory." },
      { key: "missing-key", how: "h", kind: null, statement: null },
    ]);
  });
  it("is honest with no evidence at all", () => {
    const c = reviewContextFor(objective(), null);
    expect(c.evidence.every((e) => e.line === null)).toBe(true);
    expect(c.opportunities.every((o) => o.statement === null)).toBe(true);
  });
  it("has no rationale for an athlete-worded objective", () => {
    const o = objective();
    o.desiredState = { value: "Mine.", owner: "athlete_intelligence", confidence: "HIGH", asOf: T, evidenceClass: "MEASURED", evidenceIds: ["e"], sourceMethod: "objective_event" };
    expect(reviewContextFor(o, { state, map }).rationale).toBeNull();
  });
});

describe("describeStateValue", () => {
  it("renders the stance in the contract's spelling, never uppercase", () => {
    expect(describeStateValue(state.preferences[0])).toMatch(/^wants /);
    expect(describeStateValue(state.preferences[0])).not.toMatch(/WANTS/);
  });
  it("falls back to JSON for a shape it does not know", () => {
    expect(describeStateValue({ odd: 1 })).toBe('{"odd":1}');
  });
});
