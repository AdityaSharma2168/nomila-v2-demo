/**
 * reconcile.test.ts — reconciliation 2.0: relationships by strategic lineage. L1.
 *
 * The invariant under test: reruns may describe a different topology over the same territory; they cannot merge,
 * split, reshape, replace, suppress or redefine athlete-governed live Objectives. Shape only; no athlete's content.
 *
 *   R1 same-ground proposals relate by lineage even when every word changed (tier A within a map, tier B across)
 *   R2 one proposal over two live Objectives is `spans`; two proposals over one live Objective is `splits`
 *   R3 athlete-created Objectives never match by lineage; only a weak wording finding, never a verdict
 *   R4 the parameters are one versioned object; lineageMin is a relationship candidate, not equivalence
 *   R5 what a `continues` DOES is decided by the match's governed state
 *   R6 a second-person rewording of a third-person Objective continues it (lineage), and wording ignores pronouns
 */
import { describe, expect, it } from "@jest/globals";
import type { ObjectiveProposal } from "../contracts/objective";
import type { Objective } from "../contracts/objectiveEntity";
import { OPPORTUNITY_MAP_VERSION, type OpportunityMap } from "../contracts/opportunity";
import { RECONCILIATION_PARAMS, candidatesFor, continuesVerdict, lineageFor, normalisePath, relate, splitsIn } from "./reconcile";

const T0 = "2026-09-01T00:00:00.000Z";
const days = (n: number) => new Date(Date.parse(T0) + n * 86_400_000).toISOString();
const ev = (value: string): any => ({ value, owner: "objectives", confidence: "MEDIUM", asOf: T0, evidenceClass: "EVALUATED", evidenceIds: [], rationale: "why", falsifiedBy: null });

const opp = (key: string, domain: string, rests: string[]): any => ({ key, kind: "GROW", domain, statement: ev(`Opening ${key}.`), restsOn: rests.map((statePath) => ({ statePath, how: "h" })), impact: { level: "medium", claim: "c" }, feasibility: { level: "high", claim: "c" }, urgency: null, confidence: "HIGH" });
const mapAt = (asOf: string, opps: any[]): OpportunityMap => ({ athleteId: "a1", asOf, version: OPPORTUNITY_MAP_VERSION, specVersion: "opportunity-eval-spec/1.0.0", stateAsOf: asOf, opportunities: opps, notes: [], inputs: { stateBlock: "" } as any, overallConfidence: "MEDIUM" });

const MAP1 = mapAt(T0, [
  opp("cadence", "content", ["contentPerformance[instagram]", "findings[mia.audience_scale]"]),
  opp("tiktok", "content", ["contentPerformance[tiktok]", "findings[mia.audience_scale]"]),
  opp("positioning", "positioning", ["findings[mia.narrative_power]", "findings[mia.brand_fit]"]),
  opp("impact", "impact", ["findings[mia.narrative_power]", "findings[mia.cultural_relevance]"]),
  opp("inbound", "commercial", ["commercialPosition.inbound[2]", "commercialPosition.pipeline"]),
]);
/** A LATER Opportunity run: different keys, same ground. */
const MAP2 = mapAt(days(30), [
  opp("post-more", "content", ["contentPerformance[instagram]", "findings[mia.audience_scale]"]),
  opp("wake-tiktok", "content", ["contentPerformance[tiktok]", "findings[mia.audience_scale]"]),
  opp("brand-territory", "positioning", ["findings[mia.narrative_power]", "findings[mia.brand_fit]"]),
  opp("csr", "impact", ["findings[mia.narrative_power]", "findings[mia.cultural_relevance]"]),
]);

const proposal = (key: string, domain: ObjectiveProposal["domain"], desired: string, opps: string[], evidence: string[] = [], intent: string[] = []): ObjectiveProposal => ({
  key, desiredState: ev(desired), currentState: ev("now"), domain,
  provenance: { origin: intent.length ? (opps.length ? "joint" : "athlete") : "nomila", fromOpportunities: opps.map((opportunityKey) => ({ opportunityKey, how: "h" })), fromAthleteIntent: intent.map((statePath) => ({ statePath, how: "h" })), currentStateEvidence: evidence.map((statePath) => ({ statePath, how: "h" })) },
  success: { observableCondition: "seen" }, horizon: null, confidence: "MEDIUM",
});
/** An existing Objective, materialised from MAP1 with lineage. */
const objective = (id: string, p: ObjectiveProposal, over: Partial<Objective> = {}): Objective => ({
  id, athleteId: "a1", version: "objective/1.1.0", desiredState: p.desiredState, currentState: p.currentState, domain: p.domain,
  provenance: p.provenance, success: p.success, horizon: null, confidence: "MEDIUM", lineage: lineageFor(p, MAP1),
  disposition: "modified", lifecycle: "active", fromProposal: { key: p.key, setId: "s1", setAsOf: T0, specVersion: "v" }, createdAt: T0, ...over,
});

const AUD = proposal("audience", "audience", "Her audience grows across both platforms.", ["cadence", "tiktok"], ["audienceTrajectory"], ["preferences[onboarding_goal.grow]"]);
const POS = proposal("positioning", "positioning", "She partners with STEM brands.", ["positioning"], ["commercialPosition.activeRelationships"]);
const IMP = proposal("impact", "impact", "Her Northfield work attracts CSR sponsors.", ["impact"]);
const liveAud = objective("o-aud", AUD, { desiredState: { value: "Grow my audience and build a consistent presence.", owner: "athlete_intelligence", confidence: "HIGH", asOf: T0, evidenceClass: "MEASURED", evidenceIds: ["e"], sourceMethod: "objective_event" } as any, modifiedFrom: { desiredState: AUD.desiredState.value, at: T0 } });
const livePos = objective("o-pos", POS, { desiredState: { value: "Build my positioning at the intersection of athletics and technology.", owner: "athlete_intelligence", confidence: "HIGH", asOf: T0, evidenceClass: "MEASURED", evidenceIds: ["e"], sourceMethod: "objective_event" } as any });
const liveImp = objective("o-imp", IMP, { desiredState: { value: "Expand the impact of my work with Northfield.", owner: "athlete_intelligence", confidence: "HIGH", asOf: T0, evidenceClass: "MEASURED", evidenceIds: ["e"], sourceMethod: "objective_event" } as any });

describe("R4 — parameters", () => {
  it("are one versioned object, and lineageMin is a candidate threshold, not equivalence", () => {
    expect(RECONCILIATION_PARAMS).toEqual({ version: "objective-reconciliation/2.0.0", lineageMin: 0.5, wordingTieBreak: 0.6, declineWindowDays: 90 });
  });
  it("normalises positional indices and keeps keyed selectors", () => {
    expect(normalisePath("commercialPosition.inbound[2]")).toBe("commercialPosition.inbound[]");
    expect(normalisePath("findings[mia.x]")).toBe("findings[mia.x]");
  });
});

describe("lineageFor", () => {
  it("unions the proposal's own citations with each cited opportunity's restsOn, normalised and sorted", () => {
    const l = lineageFor(proposal("x", "commercial", "d", ["inbound"], ["commercialPosition.inbound[5]", "commercialPosition.closedDeals"]), MAP1);
    expect(l).toEqual({ domain: "commercial", opportunityKeys: ["inbound"], mapAsOf: T0, evidencePaths: ["commercialPosition.closedDeals", "commercialPosition.inbound[]", "commercialPosition.pipeline"], intentPaths: [] });
  });
});

describe("R1 — same ground, different words", () => {
  it("tier A: same map, an opportunity key in common — every word changed, wording Jaccard 0", () => {
    const fresh = proposal("audience-2", "audience", "Momentum on Instagram and TikTok is upward and sustained.", ["cadence", "tiktok"], ["audienceTrajectory"]);
    const r = relate(fresh, lineageFor(fresh, MAP1), [liveAud, livePos, liveImp]);
    expect(r.kind).toBe("continues");
    if (r.kind === "continues") { expect(r.match.objective.id).toBe("o-aud"); expect(r.match.tier).toBe("A"); expect(r.match.evidenceJaccard).toBe(1); expect(r.match.wordingJaccard).toBeLessThan(0.2); }
  });
  it("tier B: a later map with new keys — evidence paths still relate it", () => {
    const fresh = proposal("audience-3", "audience", "Something else entirely.", ["post-more", "wake-tiktok"], ["audienceTrajectory"]);
    const r = relate(fresh, lineageFor(fresh, MAP2), [liveAud, livePos, liveImp]);
    expect(r.kind).toBe("continues");
    if (r.kind === "continues") { expect(r.match.tier).toBe("B"); expect(r.match.opportunityKeyOverlap).toBe(0); expect(r.match.evidenceJaccard).toBe(1); }
  });
  it("different ground in the same domain is new, and every candidate considered is reported", () => {
    const fresh = proposal("aud-other", "audience", "Her audience grows across both platforms.", [], ["audience[instagram]", "audience[tiktok]"]);
    const r = relate(fresh, lineageFor(fresh, MAP1), [liveAud]);
    // same domain, no lineage overlap, but the WORDING equals the original — so tier C, a finding only
    expect(r.kind).toBe("may_relate");
    expect(candidatesFor(fresh, lineageFor(fresh, MAP1), [liveAud]).map((c) => c.tier)).toEqual(["C"]);
  });
});

describe("R2 — athlete topology over evaluator topology", () => {
  it("one proposal over two live Objectives is `spans`: both matched, ordered by strength, no single winner — ACROSS domains", () => {
    // The experiment's own case: a positioning proposal that folded the impact Objective. Lineage is not domain-gated.
    const consolidated = proposal("premium", "positioning", "CSR, STEM or EdTech partners.", ["positioning", "impact"], ["commercialPosition.activeRelationships"]);
    const r = relate(consolidated, lineageFor(consolidated, MAP1), [liveAud, livePos, liveImp]);
    expect(r.kind).toBe("spans");
    if (r.kind === "spans") {
      expect(r.matches.map((m) => [m.objective.id, m.sameDomain])).toEqual([["o-pos", true], ["o-imp", false]]);
      expect(r.matches[0]!.evidenceJaccard).toBeGreaterThan(r.matches[1]!.evidenceJaccard);
    }
  });
  it("the wording tie-breaker stays domain-gated: identical words in another domain are not a relationship", () => {
    const fresh = proposal("elsewhere", "career", "Grow my audience and build a consistent presence.", [], ["identity.careerStatus"]);
    expect(relate(fresh, lineageFor(fresh, MAP1), [liveAud]).kind).toBe("new");
  });
  it("spans needs LIVE matches: a deferred sibling does not make a span", () => {
    const consolidated = proposal("premium", "positioning", "CSR, STEM or EdTech partners.", ["positioning", "impact"]);
    const deferredImp = { ...liveImp, disposition: "deferred" as const, lifecycle: "proposed" as const };
    const r = relate(consolidated, lineageFor(consolidated, MAP1), [livePos, deferredImp]);
    expect(r.kind).toBe("continues");
    if (r.kind === "continues") expect(r.match.objective.id).toBe("o-pos");
  });
  it("two proposals over one live Objective is `splits`: her Objective is named once with both keys", () => {
    const a = proposal("post-more", "audience", "Instagram cadence is up.", ["cadence"]);
    const b = proposal("wake-tiktok", "audience", "TikTok is alive again.", ["tiktok"]);
    const rels = [a, b].map((p) => ({ proposalKey: p.key, relationship: relate(p, lineageFor(p, MAP1), [liveAud]) }));
    expect(rels.every((r) => r.relationship.kind === "continues")).toBe(true);
    expect(splitsIn(rels)).toEqual([{ objectiveId: "o-aud", proposalKeys: ["post-more", "wake-tiktok"] }]);
  });
});

describe("R3 — athlete-created Objectives", () => {
  const hers: Objective = { ...liveAud, id: "o-hers", lineage: undefined, fromProposal: undefined, provenance: { origin: "athlete", fromOpportunities: [], fromAthleteIntent: [{ statePath: "objective_events[e]", how: "h" }], currentStateEvidence: [] } };
  it("never match by lineage, whatever ground the proposal stands on", () => {
    const fresh = proposal("audience-2", "audience", "Totally different words.", ["cadence", "tiktok"]);
    expect(relate(fresh, lineageFor(fresh, MAP1), [hers]).kind).toBe("new");
  });
  it("can be RELATED by wording, as a finding — never reaffirmed, suppressed or re-surfaced", () => {
    const fresh = proposal("audience-2", "audience", "Grow my audience and build a consistent presence.", ["cadence"]);
    const r = relate(fresh, lineageFor(fresh, MAP1), [hers]);
    expect(r.kind).toBe("may_relate");
    if (r.kind === "may_relate") expect(r.match.tier).toBe("C");
  });
});

describe("R6 — second person (objective-eval-spec/1.1.0) is not a new Objective", () => {
  // A stored evaluator Objective in the third person, and the same proposal reworded to the athlete.
  const THIRD = proposal("audience", "audience", "Her audience is large enough that partners approach her rather than the reverse.", ["cadence", "tiktok"], ["audienceTrajectory"]);
  const SECOND = proposal("audience", "audience", "Your audience is large enough that partners approach you rather than the reverse.", ["cadence", "tiktok"], ["audienceTrajectory"]);
  const stored = objective("o-third", THIRD, { disposition: "accepted" });
  it("lineage carries it: the reworded proposal continues and reaffirms the stored Objective", () => {
    for (const map of [MAP1, MAP2]) {
      const p = map === MAP1 ? SECOND : proposal("audience", "audience", SECOND.desiredState.value, ["post-more", "wake-tiktok"], ["audienceTrajectory"]);
      const r = relate(p, lineageFor(p, map), [stored]);
      expect(r.kind).toBe("continues");
      if (r.kind === "continues") { expect(r.match.objective.id).toBe("o-third"); expect(continuesVerdict(r.match.objective, T0)).toEqual({ kind: "reaffirms" }); }
    }
  });
  it("the wording tie-breaker ignores pronouns: her / she / you / your / my are the same wording", () => {
    const c = candidatesFor(SECOND, lineageFor(SECOND, MAP1), [stored]);
    expect(c[0]!.wordingJaccard).toBe(1);
    // and for an athlete-created Objective, which only the wording can relate
    const hers: Objective = { ...stored, id: "o-hers", lineage: undefined, fromProposal: undefined, desiredState: { ...stored.desiredState, value: "My audience is large enough that partners approach me rather than the reverse." } };
    const r = relate(SECOND, lineageFor(SECOND, MAP1), [hers]);
    expect(r.kind).toBe("may_relate");
    if (r.kind === "may_relate") expect(r.match.wordingJaccard).toBe(1);
  });
});

describe("R5 — what `continues` does is the match's governed state", () => {
  it("live → reaffirms; unreviewed → reaffirms; declined inside the window → repeats; outside → new with history; closed → new with history", () => {
    expect(continuesVerdict(liveAud, days(1)).kind).toBe("reaffirms");
    expect(continuesVerdict({ ...liveAud, disposition: "unreviewed", lifecycle: "proposed" }, days(1)).kind).toBe("reaffirms");
    expect(continuesVerdict({ ...liveAud, disposition: "declined", lifecycle: "proposed", reviewedAt: days(0) }, days(10))).toEqual({ kind: "repeats_decline", declinedAt: days(0) });
    expect(continuesVerdict({ ...liveAud, disposition: "declined", lifecycle: "proposed", reviewedAt: days(0) }, days(91)).kind).toBe("new_with_history");
    expect(continuesVerdict({ ...liveAud, lifecycle: "abandoned", closedAt: days(1) }, days(2)).kind).toBe("new_with_history");
  });
  it("L2 — deferred: information never by a run; pre-L2 (no deferral) read as information; time only once its instant has passed; athlete never by a run", () => {
    const deferred = (deferral?: Objective["deferral"]) => ({ ...liveAud, disposition: "deferred" as const, lifecycle: "proposed" as const, ...(deferral ? { deferral } : {}) });
    expect(continuesVerdict(deferred({ kind: "information", said: null }), days(400)).kind).toBe("reaffirms");
    expect(continuesVerdict(deferred(), days(400)).kind).toBe("reaffirms");
    expect(continuesVerdict(deferred({ kind: "athlete", said: null }), days(400)).kind).toBe("reaffirms");
    expect(continuesVerdict(deferred({ kind: "time", after: days(30), said: null }), days(29)).kind).toBe("reaffirms");
    expect(continuesVerdict(deferred({ kind: "time", after: days(30), said: null }), days(30))).toEqual({ kind: "re_surfaces", because: "time_elapsed" });
  });
});
