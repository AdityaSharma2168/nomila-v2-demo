/**
 * validate.test.ts — the invariants a composed AthleteState must satisfy.
 *
 * Shape and provenance only. Nothing here says what any athlete's state should contain; every test starts from one
 * minimal valid state and breaks exactly one invariant.
 */
import { describe, expect, it } from "@jest/globals";
import { ATHLETE_STATE_VERSION, type AthleteState } from "../contracts/athleteState";
import { INBOUND_CAP, validateAthleteState } from "./validate";

const T = "2026-09-21T00:00:00.000Z";
const measured = <V,>(value: V, owner = "athlete_state"): any => ({ value, owner, confidence: "HIGH", asOf: T, evidenceClass: "MEASURED", evidenceIds: ["e"], sourceMethod: "test" });
const inbound = (n: number) => ({ category: "PAID", counterparty: `Brand ${n}`, deadline: null, confidence: 0.8, lastMessageAt: T, threadStatus: "read", evidence: { source: "inbox" as const, locator: `t${n}`, asOf: T } });

function valid(): AthleteState {
  return {
    athleteId: "a1", asOf: T, version: ATHLETE_STATE_VERSION,
    identity: { name: "Test Athlete", sport: null, competitionContext: null, careerStatus: null },
    findings: [{ key: "mia.x", direction: "neutral", basis: measured(50, "marketability"), evidence: [{ source: "mia", locator: "r1", asOf: T }] }],
    audienceTrajectory: { value: null, owner: "athlete_intelligence", asOf: T, evidenceClass: "MISSING", reason: "none" } as any,
    commercialPosition: {
      closedDeals: measured(1), activeRelationships: measured(["Acme"]),
      demonstratedEconomics: { value: null, owner: "athlete_state", asOf: T, evidenceClass: "MISSING", reason: "none" } as any,
      pricingEvidence: "none",
      pipeline: measured({ detected: 3, negotiating: 1, rejected: 0, accepted: 1, completed: 0 }),
      inbound: [inbound(1)],
    },
    constraints: [],
    preferences: [
      { subject: "onboarding_goal.grow", stance: "wants", source: { source: "onboarding", locator: "athletes.goal_archetype", asOf: T }, recordedAs: { method: "onboarding_v1_choice", at: T } },
      { subject: "avoids_x", stance: "avoids", source: { source: "assertion", locator: "avoids_x", asOf: T } },
    ],
    audience: [{ platform: "instagram", followers: measured(100, "athlete_intelligence"), topCountry: { bucket: "US", pct: 60 }, asOf: T, evidence: [] }],
    contentPerformance: [{ platform: "instagram", postsPerWeek: 1, asOf: T, evidence: [] }],
    representation: { agent: null, agency: "X", floors: [{ key: "social_feed_post", amount: 500 }], evidence: { source: "assertion", locator: "athletes.deal_preferences", asOf: T } },
    dates: [{ kind: "deal_term_end", date: "2026-12-31", subject: "Acme (accepted)", evidence: { source: "deals", locator: "d1", asOf: T } }],
    athleteNotes: [],
    materialGaps: [], overallConfidence: "LOW", sources: [],
  };
}

describe("validateAthleteState", () => {
  it("accepts a minimal valid state", () => {
    expect(validateAthleteState(valid())).toEqual([]);
  });

  it("refuses the wrong contract version", () => {
    const s = valid(); (s as any).version = "athlete-state/1.1.0";
    expect(validateAthleteState(s).join()).toMatch(/version/);
  });

  it("refuses anything athlete_state owns that is EVALUATED — composition never judges", () => {
    const s = valid();
    (s.commercialPosition as any).closedDeals = { ...measured(1), evidenceClass: "EVALUATED" };
    expect(validateAthleteState(s).join()).toMatch(/may not emit EVALUATED/);
  });

  it("refuses a finding whose basis is not M.I.A.'s", () => {
    const s = valid(); s.findings[0]!.basis = measured(50, "athlete_state");
    expect(validateAthleteState(s).join()).toMatch(/expected marketability/);
  });

  it("refuses a pipeline that disagrees with the closed-deal count", () => {
    const s = valid(); s.commercialPosition.pipeline.value.accepted = 4;
    expect(validateAthleteState(s).join()).toMatch(/closedDeals 1 != accepted\+completed 4/);
  });

  it("refuses an inbound signal carrying an amount — interest is never a deal", () => {
    const s = valid(); (s.commercialPosition.inbound[0] as any).amount = 5000;
    expect(validateAthleteState(s).join()).toMatch(/never a deal/);
  });

  it("refuses an inbound signal that does not cite an inbox thread", () => {
    const s = valid(); s.commercialPosition.inbound[0]!.evidence = { source: "deals", locator: "d1", asOf: T };
    expect(validateAthleteState(s).join()).toMatch(/must cite an inbox thread/);
  });

  it("refuses more inbound signals than the cap — State stays thin", () => {
    const s = valid(); s.commercialPosition.inbound = Array.from({ length: INBOUND_CAP + 1 }, (_, i) => inbound(i));
    expect(validateAthleteState(s).join()).toMatch(/cap is/);
  });

  it("refuses an onboarding preference not labelled as a fixed-set choice", () => {
    const s = valid(); delete s.preferences[0]!.recordedAs;
    expect(validateAthleteState(s).join()).toMatch(/onboarding_v1_choice/);
  });

  it("refuses duplicate preference subjects — the keyed citation would be ambiguous", () => {
    const s = valid(); s.preferences.push({ ...s.preferences[1]! });
    expect(validateAthleteState(s).join()).toMatch(/duplicate subjects/);
  });

  it("refuses an audience share outside 0–100 and duplicate platforms", () => {
    const s = valid(); s.audience[0]!.topCountry = { bucket: "US", pct: 160 }; s.audience.push({ ...s.audience[0]! });
    const p = validateAthleteState(s).join();
    expect(p).toMatch(/out of range/); expect(p).toMatch(/duplicate platforms/);
  });

  it("refuses a non-positive floor and duplicate floor keys", () => {
    const s = valid(); s.representation!.floors = [{ key: "a", amount: 0 }, { key: "a", amount: 1 }];
    const p = validateAthleteState(s).join();
    expect(p).toMatch(/not a positive amount/); expect(p).toMatch(/duplicate keys/);
  });

  it("refuses a date with an unknown meaning or that does not parse", () => {
    const s = valid(); s.dates = [{ kind: "birthday" as any, date: "soon", subject: "x", evidence: { source: "deals", locator: "d", asOf: T } }];
    const p = validateAthleteState(s).join();
    expect(p).toMatch(/kind invalid/); expect(p).toMatch(/not a date/);
  });

  it("accepts a representation of null and empty collections — absence is valid", () => {
    const s = valid(); s.representation = null; s.audience = []; s.contentPerformance = []; s.dates = []; s.commercialPosition.inbound = [];
    expect(validateAthleteState(s)).toEqual([]);
  });
});
