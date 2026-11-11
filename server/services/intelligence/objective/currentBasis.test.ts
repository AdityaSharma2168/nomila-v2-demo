/**
 * currentBasis.test.ts — Slice 3 B (slice3-b-design.md §7), pure. Which historical openings stand as the Brain's
 * CURRENT strategic basis, and that a withheld opening can be neither rendered nor cited while history is untouched.
 */
import { describe, expect, it } from "@jest/globals";
import type { Objective, ObjectiveEvent } from "../contracts/objectiveEntity";
import type { OpportunityMap } from "../contracts/opportunity";
import type { BrainInputs } from "../brain/contract";
import { renderObjectivesBlock } from "../brain/inputBlock";
import { resolveRef } from "../brain/grounding";
import { renderOpportunityBlock } from "./inputBlock";
import { basisFor, changeAssessmentsFrom, currentBrainBasis, type ChangeAssessmentRecord } from "./currentBasis";
import { OBJECTIVE_CHANGE_ASSESSMENT_VERSION as V } from "./changeAssessment";

const T0 = "2026-09-21T00:00:00.000Z";
const opening = (key: string, statement: string) => ({ key, kind: "GROW", domain: "positioning", statement: { value: statement }, restsOn: [], impact: { level: "medium", claim: "c" }, feasibility: { level: "medium", claim: "c" }, urgency: null, confidence: "HIGH" }) as any;
const MAP = (): OpportunityMap => ({ asOf: T0, specVersion: "s", stateAsOf: T0, overallConfidence: "MEDIUM", notes: [],
  opportunities: [opening("o1", "Target EdTech and STEM partnerships."), opening("o2", "Grow her Instagram."), opening("o3", "An unrelated opening.")] } as any);

const obj = (id: string, keys: string[], wording: string, modifiedFrom?: string): Objective => ({
  id, athleteId: "a", version: "objective/1.1.0", domain: "positioning",
  desiredState: { value: wording } as any, currentState: null, provenance: { origin: "joint" } as any,
  success: { observableCondition: "She signs a tech partnership." }, horizon: null, confidence: "HIGH",
  disposition: modifiedFrom ? "modified" : "accepted", lifecycle: "active", createdAt: T0,
  lineage: { domain: "positioning", opportunityKeys: keys, mapAsOf: T0, evidencePaths: [], intentPaths: [] },
  ...(modifiedFrom ? { modifiedFrom: { desiredState: modifiedFrom, at: T0 } } : {}),
} as any);

const model = (verdicts: Record<string, "all" | "part" | "none">) => ({ status: "assessed", version: V, by: "model", model: "m", promptSha256: "p",
  assessment: { success: { verdict: "needs_review", reason: "r", objectiveQuote: "q", successQuote: "q" },
    openings: Object.entries(verdicts).map(([key, supports]) => ({ key, supports, ...(supports === "part" ? { part: "x" } : {}), openingQuote: "q", reason: "r" })) } }) as any;
const rule = { status: "assessed", version: V, by: "rule", carriesForward: true, because: "typo" } as any;
const failed = { status: "unassessed", version: V, reason: "timed out" } as any;
const rec = (wording: string, result: any, o: Partial<ChangeAssessmentRecord> = {}): ChangeAssessmentRecord => ({
  version: V, modifyEventId: "m", wording, previousWording: "Old.", previousWasOriginal: true,
  openings: [{ key: "o1", statement: "Target EdTech and STEM partnerships." }, { key: "o2", statement: "Grow her Instagram." }], result, ...o,
});
const NEW = "Build my positioning at the intersection of athletics, technology and AI.";

describe("the domain rule is per Objective (basisFor)", () => {
  it("an Objective whose wording was never modified keeps its lineage openings — today's behaviour", () => {
    expect(basisFor(obj("p", ["o1"], "As proposed."), [], MAP())).toEqual({ kept: ["o1"], excluded: [] });
  });
  it("modified: `all` is kept; `part`, `none` and an opening the result does not cover are excluded, each with its reason", () => {
    const o = obj("q", ["o1", "o2"], NEW, "Old.");
    expect(basisFor(o, [rec(NEW, model({ o1: "all", o2: "all" }))], MAP())).toEqual({ kept: ["o1", "o2"], excluded: [] });
    expect(basisFor(o, [rec(NEW, model({ o1: "part", o2: "none" }))], MAP()).excluded.map((x) => x.because)).toEqual(["part", "none"]);
    expect(basisFor(o, [rec(NEW, model({ o1: "all" }))], MAP()).excluded).toEqual([{ key: "o2", objectiveId: "q", because: "missing_from_result" }]);
  });
  it("fails closed: unassessed, no assessment, or only an assessment of an older wording", () => {
    const o = obj("q", ["o1"], NEW, "Old.");
    expect(basisFor(o, [rec(NEW, failed)], MAP()).excluded).toEqual([{ key: "o1", objectiveId: "q", because: "unassessed" }]);
    expect(basisFor(o, [], MAP()).excluded).toEqual([{ key: "o1", objectiveId: "q", because: "not_assessed" }]);
    expect(basisFor(o, [rec("An earlier wording of hers.", model({ o1: "all" }))], MAP()).excluded[0]!.because).toBe("not_assessed");
  });
  it("a typo edit (assessed by rule) carries forward the basis of the wording it corrected", () => {
    const typoOfOriginal = obj("q", ["o1"], "Grow my audience.", "Grow my audiance.");
    expect(basisFor(typoOfOriginal, [rec("Grow my audience.", rule, { previousWording: "Grow my audiance.", previousWasOriginal: true })], MAP()).kept).toEqual(["o1"]);
    const typoOfEdit = obj("q", ["o1"], NEW + " ", NEW);
    const chain = [rec(NEW, model({ o1: "part" })), rec(NEW + " ", rule, { previousWording: NEW, previousWasOriginal: false })];
    expect(basisFor(typoOfEdit, chain, MAP()).excluded[0]!.because).toBe("part");
  });
  it("text inequality is not evidence: `all` for the assessed statement, but the current map rewords the key → excluded", () => {
    const o = obj("q", ["o1"], NEW, "Old.");
    const reworded = { ...MAP(), opportunities: [opening("o1", "Target partnerships in technology and AI."), opening("o3", "An unrelated opening.")] } as OpportunityMap;
    expect(basisFor(o, [rec(NEW, model({ o1: "all" }))], reworded).excluded[0]!.because).toBe("statement_changed");
  });
  it("the same key and the same statement in a newer map keeps the assessment's `part`", () => {
    const newer = { ...MAP(), asOf: "2026-10-01T00:00:00.000Z" } as OpportunityMap;
    expect(basisFor(obj("q", ["o1"], NEW, "Old."), [rec(NEW, model({ o1: "part" }))], newer).excluded[0]!.because).toBe("part");
  });
  it("reconciliation's continuity findings are not read: only change_assessed events count", () => {
    const e = (action: ObjectiveEvent["action"], delta: any = null): ObjectiveEvent => ({ id: action, objectiveId: "q", athleteId: "a", at: T0, actor: { userId: null, role: "system" }, action, said: null, delta });
    expect(changeAssessmentsFrom([e("modify"), e("reaffirmed_by_run", { proposalKey: "k" }), e("spans_live"), e("may_relate")])).toEqual([]);
    const r = rec(NEW, model({ o1: "all" }));
    expect(changeAssessmentsFrom([e("reaffirmed_by_run"), e("change_assessed", { changeAssessment: r })])).toEqual([r]);
  });
  it("a new Objective created through reconciliation (unmodified) has its lineage as basis", () => {
    expect(basisFor(obj("n", ["o3"], "A new proposal."), [], MAP()).kept).toEqual(["o3"]);
  });
});

describe("what the Brain is given (currentBrainBasis)", () => {
  const P = obj("p", ["o1"], "As proposed.");            // unmodified: o1 is its basis
  const Q = obj("q", ["o1", "o2"], NEW, "Old.");          // modified: o1 part, o2 all
  const assessments = new Map([["q", [rec(NEW, model({ o1: "part", o2: "all" }))]]]);

  it("no modified Objective → the same map object, nothing recorded", () => {
    const map = MAP();
    const r = currentBrainBasis(map, [P], new Map());
    expect(r.map).toBe(map); expect(r.excludedOpenings).toEqual([]);
  });
  it("v1 LIMITATION: a key one Objective excludes is withheld from the shared map; the Objective that kept it records `shared_map`", () => {
    const r = currentBrainBasis(MAP(), [P, Q], assessments);
    expect(r.map!.opportunities.map((o) => o.key)).toEqual(["o2", "o3"]);
    expect(r.excludedOpenings).toEqual([{ key: "o1", objectiveId: "q", because: "part" }, { key: "o1", objectiveId: "p", because: "shared_map" }]);
  });
  it("an opening in no Objective's lineage is untouched and never rendered as rests-on", () => {
    const r = currentBrainBasis(MAP(), [P, Q], assessments);
    expect(r.map!.opportunities.some((o) => o.key === "o3")).toBe(true);
    expect(renderObjectivesBlock([P, Q], [], [], new Set(r.excludedOpenings.map((x) => x.key)))).not.toMatch(/rests on openings: .*o3/);
  });

  it("LEAK: a withheld opening is neither rendered (map block, rests-on) nor citable; the persisted map is untouched", () => {
    const persisted = MAP(); const snapshot = JSON.parse(JSON.stringify(persisted));
    const r = currentBrainBasis(persisted, [P, Q], assessments);
    const excluded = new Set(r.excludedOpenings.map((x) => x.key));
    const block = renderOpportunityBlock(r.map!);
    expect(block).not.toContain("o1"); expect(block).not.toContain("Target EdTech and STEM partnerships.");
    const objectives = renderObjectivesBlock([P, Q], [], [], excluded);
    expect(objectives).not.toMatch(/rests on openings: .*\bo1\b/);
    expect(objectives).toContain("        rests on openings: o2");                  // Q keeps o2
    expect(objectives.split("\n").filter((l) => l.includes("rests on openings")).length).toBe(1); // P's line is omitted, not empty
    const inputs = { map: r.map, excludedOpenings: r.excludedOpenings } as unknown as BrainInputs;
    expect(resolveRef(inputs, "opportunity[o1]")).toEqual({ ok: false, reason: "no such opportunity key" });
    expect(resolveRef(inputs, "opportunity[o2]").ok).toBe(true);
    expect(persisted).toEqual(snapshot);
  });
  it("nothing withheld renders byte-identically to before", () => {
    expect(renderObjectivesBlock([P, Q], [], [], new Set())).toBe(renderObjectivesBlock([P, Q], [], []));
  });
});
