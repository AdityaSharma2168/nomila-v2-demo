/**
 * outcomes.test.ts — the pure domain-outcome rule (design §3.1; review of PR #400).
 */

import { domainOutcome } from "./outcomes";

const q = { completed: true, chunksReviewed: 3 };
const opts = { extractionFailed: false, llmDomain: true };

describe("domainOutcome", () => {
  it("evidence-only domain: accepted evidence or inference alone ⇒ refreshed", () => {
    expect(domainOutcome("press", q, undefined, { evidence: 1, factBearing: 0, facts: 0 }, opts)).toBe("refreshed");
    expect(domainOutcome("narrative", q, undefined, { evidence: 1, factBearing: 0, facts: 0 }, opts)).toBe("refreshed");
    expect(domainOutcome("signals", { completed: true, chunksReviewed: 2 }, undefined, { evidence: 2, factBearing: 0, facts: 0 }, { extractionFailed: true, llmDomain: false })).toBe("refreshed");
  });

  it("fact-bearing domain: accepted evidence WITHOUT an accepted/corroborated/re-confirmed fact is NEVER refreshed", () => {
    for (const d of ["identity", "profile", "affiliations", "achievements", "brand_mentions"] as const) {
      expect(domainOutcome(d, q, undefined, { evidence: 3, factBearing: 1, facts: 0 }, opts)).toBe("no_relevant");      // non-fact evidence present: no bypass
      expect(domainOutcome(d, q, undefined, { evidence: 1, factBearing: 1, facts: 0 }, opts)).toBe("no_relevant");
      expect(domainOutcome(d, q, undefined, { evidence: 1, factBearing: 1, facts: 1 }, opts)).toBe("refreshed");
    }
  });

  it("explicit none_found is trusted only with completed queries and reviewed chunks; an incomplete query is failed", () => {
    expect(domainOutcome("achievements", q, { status: "none_found", reviewedChunkIds: ["g0:c0"] }, { evidence: 0, factBearing: 0, facts: 0 }, opts)).toBe("confirmed_empty");
    expect(domainOutcome("achievements", { completed: true, chunksReviewed: 0 }, { status: "none_found", reviewedChunkIds: [] }, { evidence: 0, factBearing: 0, facts: 0 }, opts)).toBe("no_relevant");
    expect(domainOutcome("achievements", { completed: false, chunksReviewed: 0 }, { status: "none_found", reviewedChunkIds: [] }, { evidence: 0, factBearing: 0, facts: 0 }, opts)).toBe("failed");
    expect(domainOutcome("achievements", undefined, undefined, { evidence: 0, factBearing: 0, facts: 0 }, opts)).toBe("failed");
    expect(domainOutcome("achievements", q, undefined, { evidence: 0, factBearing: 0, facts: 0 }, { extractionFailed: true, llmDomain: true })).toBe("failed");
  });
});
