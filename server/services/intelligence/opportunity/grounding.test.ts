/**
 * grounding.test.ts — a cited path must actually resolve against the state that was supplied.
 *
 * The structural validator proves a citation is well-formed. These tests prove it is TRUE. Without them, the claim
 * that `rests_on` separates an opportunity from an invention is a claim about a string being non-empty.
 */
import { describe, expect, it } from "@jest/globals";
import { formatGroundingProblems, parseStatePath, resolveStatePath, validateGrounding } from "./grounding";
import { ATHLETE_STATE_VERSION, type AthleteState } from "../contracts/athleteState";

const measured = <T,>(value: T): any => ({
  value, owner: "marketability", confidence: "HIGH", asOf: "2026-09-01T00:00:00.000Z",
  evidenceClass: "MEASURED", evidenceIds: ["e1"], sourceMethod: "test",
});

const state: AthleteState = {
  athleteId: "a1",
  asOf: "2026-09-21T00:00:00.000Z",
  version: ATHLETE_STATE_VERSION,
  identity: { name: "Test Athlete", sport: "handball", competitionContext: "Some Club", careerStatus: "active" },
  findings: [
    { key: "mia.narrative_power", direction: "strength", basis: measured(88), evidence: [{ source: "mia", locator: "r1", asOf: "2026-09-01T00:00:00.000Z" }] },
    { key: "mia.audience_scale", direction: "unknown", basis: measured(50), imputedShare: { imputed: 3, total: 4 }, evidence: [] },
  ],
  audienceTrajectory: { value: null, owner: "athlete_intelligence", asOf: "x", evidenceClass: "MISSING", reason: "no growth measurement" } as any,
  commercialPosition: {
    closedDeals: measured(1),
    activeRelationships: measured(["Acme"]),
    demonstratedEconomics: measured({ low: 1000, high: 1000, currency: "USD" }),
    pricingEvidence: "athlete_transactions", pipeline: { value: { detected: 0, negotiating: 0, rejected: 0, accepted: 1, completed: 0 }, owner: "athlete_state", confidence: "HIGH", asOf: "x", evidenceClass: "MEASURED", evidenceIds: [], sourceMethod: "test" } as any, inbound: [{ category: "PAID", counterparty: "Acme", deadline: null, confidence: 0.9, lastMessageAt: "x", threadStatus: "read", evidence: { source: "inbox", locator: "t1", asOf: "x" } }],
  },
  constraints: [{ key: "availability_window", kind: "availability_window", basis: measured("off-season"), evidence: [] }],
  preferences: [{ subject: "avoids_coaching", stance: "avoids", source: { source: "assertion", locator: "avoids_coaching", asOf: "x" } }],
  audience: [{ platform: "instagram", followers: measured(12000), topCountry: { bucket: "US", pct: 61 }, asOf: "x", evidence: [] }],
  contentPerformance: [{ platform: "instagram", postsPerWeek: 2.5, asOf: "x", evidence: [] }],
  representation: { agent: null, agency: null, floors: [{ key: "social_feed_post", amount: 500 }], evidence: { source: "assertion", locator: "athletes.deal_preferences", asOf: "x" } },
  dates: [{ kind: "deal_term_end", date: "2026-12-31", subject: "Acme (accepted)", evidence: { source: "deals", locator: "d1", asOf: "x" } }],
  athleteNotes: [],
  materialGaps: ["Audience demographics unavailable."],
  overallConfidence: "MEDIUM",
  sources: [],
};

const cite = (state_path: string) => ({
  key: "k", kind: "GROW", domain: "audience", statement: "s", rationale: "r",
  rests_on: [{ state_path, how: "h" }],
  impact: { level: "low", claim: "c" }, feasibility: { level: "low", claim: "c" },
  urgency: null, confidence: "LOW",
});

describe("state path grammar", () => {
  it("parses the forms the state deliberately exposes", () => {
    expect(parseStatePath("audienceTrajectory")).toEqual([{ name: "audienceTrajectory" }]);
    expect(parseStatePath("commercialPosition.demonstratedEconomics"))
      .toEqual([{ name: "commercialPosition" }, { name: "demonstratedEconomics" }]);
    expect(parseStatePath("materialGaps[0]")).toEqual([{ name: "materialGaps", selector: "0" }]);
  });

  it("reassembles a selector that contains dots", () => {
    // `findings[mia.narrative_power]` splits on "." like everything else; the key is one token, not two segments.
    expect(parseStatePath("findings[mia.narrative_power]"))
      .toEqual([{ name: "findings", selector: "mia.narrative_power" }]);
    expect(parseStatePath("findings[mia.narrative_power].direction"))
      .toEqual([{ name: "findings", selector: "mia.narrative_power" }, { name: "direction" }]);
  });

  it("refuses prototype traversal and malformed input", () => {
    // Arbitrary path evaluation over model output is an injection surface; the grammar is the defence.
    expect(parseStatePath("__proto__")).toBeNull();
    expect(parseStatePath("constructor.prototype")).toBeNull();
    expect(parseStatePath("findings[unterminated")).toBeNull();
    expect(parseStatePath("")).toBeNull();
    expect(parseStatePath("  ")).toBeNull();
  });
});

describe("resolution is existence, not truth", () => {
  it("resolves a real finding by its own key", () => {
    const r = resolveStatePath(state, "findings[mia.narrative_power]");
    expect(r.ok).toBe(true);
    expect((r as any).value.direction).toBe("strength");
  });

  it("resolves a nested commercial path and an identity field", () => {
    expect(resolveStatePath(state, "commercialPosition.demonstratedEconomics").ok).toBe(true);
    expect(resolveStatePath(state, "commercialPosition.pricingEvidence").ok).toBe(true);
    expect(resolveStatePath(state, "identity.sport").ok).toBe(true);
  });

  it("resolves a MISSING value, because citing what we cannot see is correct reasoning", () => {
    // An evidence-domain opportunity resting on an absent trajectory is the most honest output available.
    // Rejecting the citation for having a null value would punish exactly that.
    const r = resolveStatePath(state, "audienceTrajectory");
    expect(r.ok).toBe(true);
    expect((r as any).value.evidenceClass).toBe("MISSING");
  });

  it("resolves a field of a selected element", () => {
    const r = resolveStatePath(state, "findings[mia.audience_scale].imputedShare");
    expect(r.ok).toBe(true);
    expect((r as any).value).toEqual({ imputed: 3, total: 4 });
  });

  it("resolves preferences by subject and constraints by key", () => {
    expect(resolveStatePath(state, "preferences[avoids_coaching]").ok).toBe(true);
    expect(resolveStatePath(state, "constraints[availability_window]").ok).toBe(true);
  });
});

describe("invented citations are rejected", () => {
  it("rejects a finding key that does not exist, and names what does", () => {
    const r = resolveStatePath(state, "findings[mia.invented_dimension]");
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain("is not in the athlete state");
    expect((r as any).reason).toContain("mia.narrative_power");
  });

  it("rejects an invented preference — the exact hallucination the review named", () => {
    const r = resolveStatePath(state, "preferences[future_media_goal]");
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain("is not in the athlete state");
  });

  it("rejects an invented constraint", () => {
    expect(resolveStatePath(state, "constraints[ncaa_eligibility]").ok).toBe(false);
  });

  it("rejects an out-of-range materialGaps index", () => {
    expect(resolveStatePath(state, "materialGaps[0]").ok).toBe(true);
    const r = resolveStatePath(state, "materialGaps[7]");
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain("out of range — 1 present");
  });

  it("rejects an unknown top-level field and an unknown nested field", () => {
    expect(resolveStatePath(state, "athleticTrajectory").ok).toBe(false);
    expect(resolveStatePath(state, "commercialPosition.projectedEarnings").ok).toBe(false);
  });

  it("rejects selecting from something that is not a collection", () => {
    expect(resolveStatePath(state, "audienceTrajectory[0]").ok).toBe(false);
    expect(resolveStatePath(state, "materialGaps[first]").ok).toBe(false);
  });
});

describe("1.1.0 — support citations resolve against what was supplied", () => {
  const body = (refs: string[]) => ({ opportunities: [{ key: "k", rests_on: [{ state_path: "identity.name", how: "h" }], supported_by: refs.map((ref) => ({ ref, how: "h" })) }] });
  it("ctx[n] needs a CONTEXT block with more than n items; research[n] a supplied block; nothing supplied refuses both", () => {
    expect(validateGrounding(state, body(["ctx[0]", "research[0]"]), { contextItems: 1, researchBlocks: 1 })).toEqual([]);
    expect(validateGrounding(state, body(["ctx[1]"]), { contextItems: 1, researchBlocks: 0 }).map((p) => p.reason)).toEqual(["context has 1 item(s); ctx[1] does not exist"]);
    expect(validateGrounding(state, body(["research[2]"]), { contextItems: 0, researchBlocks: 2 }).map((p) => p.reason)).toEqual(["2 research block(s) supplied; research[2] does not exist"]);
    expect(validateGrounding(state, body(["ctx[0]", "research[0]"])).map((p) => p.reason)).toEqual(["no CONTEXT was supplied", "no RESPONSIVE EVIDENCE was supplied"]);
  });
  it("a support ref is recorded under statePath for the diagnostic table, with the opening's index and key", () => {
    expect(validateGrounding(state, body(["ctx[3]"]), { contextItems: 1, researchBlocks: 0 })[0]).toMatchObject({ index: 0, key: "k", statePath: "ctx[3]" });
  });
});

describe("validateGrounding over a whole response", () => {
  it("passes a response whose every citation resolves", () => {
    expect(validateGrounding(state, { opportunities: [cite("findings[mia.narrative_power]"), cite("materialGaps[0]")] }))
      .toEqual([]);
  });

  it("reports every bad citation at once, labelled by index and key", () => {
    const out = validateGrounding(state, {
      opportunities: [
        { ...cite("preferences[future_media_goal]"), key: "a" },
        { ...cite("findings[mia.invented]"), key: "b" },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.key)).toEqual(["a", "b"]);
    expect(formatGroundingProblems(out)[0]).toContain("opportunities[0] (a)");
  });

  it("says nothing about structure: an empty rests_on is not a grounding failure", () => {
    const empty = { opportunities: [{ ...cite("x"), rests_on: [] }] };
    expect(validateGrounding(state, empty)).toEqual([]);
  });

  it("passes a real citation and rejects an invented one", () => {
    expect(validateGrounding(state, { opportunities: [cite("findings[mia.narrative_power]")] })).toEqual([]);
    expect(validateGrounding(state, { opportunities: [cite("preferences[future_media_goal]")] })).toHaveLength(1);
  });
});
