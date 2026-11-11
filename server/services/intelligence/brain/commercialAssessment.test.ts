/**
 * brain/commercialAssessment.test.ts — the experimental envelope renders what it is given, marks hand lines, and never
 * adds a reading of its own. Synthetic lines only; no athlete, no outcome.
 */
import { describe, expect, it } from "@jest/globals";
import { COMMERCIAL_ASSESSMENT_VERSION, assessmentStateObject, renderAssessmentStateSection, renderAssessmentUnderWork, type CommercialAssessment } from "./commercialAssessment";

const a: CommercialAssessment = {
  version: COMMERCIAL_ASSESSMENT_VERSION, subject: "w-1", subjectRef: "deal[w-1]", condition: "C2", assembledBy: "code+hand", asOf: "2026-01-01T00:00:00Z",
  lines: [
    { key: "band", text: "NOT_ESTABLISHED (NA_CASH) — no rate card", source: "code" },
    { key: "unknown", text: "usage rights: UNKNOWN — not established by this evidence path", source: "code" },
    { key: "observed", text: "no deal recorded by Nomila; not observed is not none", source: "hand", rule: "MISSING ≠ NONE" },
  ],
  values: {}, provenance: { functions: ["economicsBand"], rules: ["MISSING ≠ NONE"], transcription: "t" },
};

describe("Brain (experimental) — commercial assessment envelope", () => {
  it("renders under the work item with per-line citations and marks hand-applied lines", () => {
    const L = renderAssessmentUnderWork(a);
    expect(L[0]).toContain(`(${COMMERCIAL_ASSESSMENT_VERSION}`);
    expect(L[0]).toContain("Cite as deal[w-1].<key>.");
    expect(L[1]).toMatch(/^\s+deal\[w-1\]\.band  NOT_ESTABLISHED/);
    expect(L[3]).toMatch(/^\s+‡ deal\[w-1\]\.observed/);
    expect(L.join("\n")).not.toMatch(/accept|counter|reject|score/i);
  });
  it("renders the state placement as state paths and exposes the same keys for resolution", () => {
    const s = renderAssessmentStateSection(a);
    expect(s).toContain("COMMERCIAL ASSESSMENT — about deal[w-1]");
    expect(s).toContain("commercialPosition.assessment.band  NOT_ESTABLISHED");
    expect(s).toContain("‡ commercialPosition.assessment.observed");
    expect(Object.keys(assessmentStateObject(a))).toEqual(["band", "unknown", "observed"]);
  });
  it("labels the numbers-only condition as numbers only", () => {
    const c1: CommercialAssessment = { ...a, condition: "C1", assembledBy: "code", lines: [{ key: "rateCard.socialPost", text: "USD 1 / USD 2 / USD 3", source: "code" }] };
    expect(renderAssessmentUnderWork(c1)[0]).toContain("numbers only");
  });
});
