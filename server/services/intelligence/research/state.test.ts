/**
 * state.test.ts — domain statuses and the research lifecycle (design §5.1, R2, R7).
 * Connection is not an input: it is orthogonal to research.
 */

import { deriveResearchState, domainStatus } from "./state";
import { DEFAULT_RESEARCH_POLICY } from "./policy";

const asOf = new Date("2026-09-11T00:00:00.000Z");
const ttl = DEFAULT_RESEARCH_POLICY.ttlDays;
const d = (domain: any, over: Partial<Parameters<typeof domainStatus>[0]> = {}) => ({ domain, lastResearchedAt: "2026-09-10T00:00:00.000Z", cited: 1, uncited: 0, disputedBlocking: false, disputedNonBlocking: false, ...over });

describe("domainStatus", () => {
  it("missing → partial (uncited only) → complete → stale (past TTL) → disputed", () => {
    expect(domainStatus(d("press", { lastResearchedAt: null, cited: 0 }), ttl, asOf)).toBe("missing");
    expect(domainStatus(d("press", { cited: 0, uncited: 3 }), ttl, asOf)).toBe("partial");
    expect(domainStatus(d("press"), ttl, asOf)).toBe("complete");
    expect(domainStatus(d("press", { lastResearchedAt: "2026-07-01T00:00:00.000Z" }), ttl, asOf)).toBe("stale");   // press TTL 30 d
    expect(domainStatus(d("achievements", { lastResearchedAt: "2020-01-01T00:00:00.000Z" }), ttl, asOf)).toBe("complete");   // achievements never expire
    expect(domainStatus(d("profile", { disputedNonBlocking: true }), ttl, asOf)).toBe("disputed");
  });
});

describe("deriveResearchState", () => {
  it("no research → seed_only, or identity_resolved when identity is resolved", () => {
    expect(deriveResearchState({ identityResolved: false, domains: {} }).status).toBe("seed_only");
    expect(deriveResearchState({ identityResolved: true, domains: { press: "missing" } }).status).toBe("identity_resolved");
  });
  it("a blocking domain (identity, affiliations) missing or disputed holds research_partial", () => {
    const base = { identity: "complete", profile: "complete", affiliations: "complete", achievements: "complete", press: "complete" } as const;
    expect(deriveResearchState({ identityResolved: true, domains: base }).status).toBe("research_complete");
    expect(deriveResearchState({ identityResolved: true, domains: { ...base, affiliations: "disputed" }, blockingDisputes: ["affiliations"] })).toMatchObject({ status: "research_partial", blockingIssues: ["affiliations"] });
    // the same domain disputed only through a NON-blocking key (e.g. hometown in identity) does not block
    expect(deriveResearchState({ identityResolved: true, domains: { ...base, identity: "disputed" }, blockingDisputes: [] })).toMatchObject({ status: "research_complete", disputedDomains: ["identity"], blockingIssues: [] });
    expect(deriveResearchState({ identityResolved: true, domains: { ...base, identity: "partial" } }).status).toBe("research_partial");
  });
  it("a disputed NON-blocking domain leaves research_complete and is reported (R7)", () => {
    const r = deriveResearchState({ identityResolved: true, domains: { identity: "complete", profile: "disputed", affiliations: "complete", achievements: "complete", press: "complete" } });
    expect(r.status).toBe("research_complete");
    expect(r.disputedDomains).toEqual(["profile"]);
    expect(r.blockingIssues).toEqual([]);
  });
  it("a required domain past TTL → research_stale; a missing required non-blocking domain → research_partial", () => {
    expect(deriveResearchState({ identityResolved: true, domains: { identity: "complete", profile: "complete", affiliations: "complete", achievements: "complete", press: "stale" } }).status).toBe("research_stale");
    expect(deriveResearchState({ identityResolved: true, domains: { identity: "complete", profile: "complete", affiliations: "complete", achievements: "missing", press: "complete" } }).status).toBe("research_partial");
  });
});
