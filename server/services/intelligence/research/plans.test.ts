/**
 * plans.test.ts — the research-spec/1 plan table (#709 §9.2 adaptation 1) and the direct-plan budget arithmetic
 * (adaptation 2). Pure: no database, no provider.
 */

import { describe, expect, it } from "@jest/globals";
import { DEFAULT_PLANNER_POLICY } from "./policy";
import { DOMAIN_PLANS, directPlanAttempts, planTableFor, SPEC_V1_DOMAIN_QUERIES, specV1QueriesFor } from "./plans";
import { RESEARCH_DOMAINS, SECTION_DOMAIN, type ResearchDomain } from "./registries";
import { QUERIES, QUERY_IDS } from "./spec/researchSpecV1";

describe("research-spec/1 plan table", () => {
  it("is the #709 table: each research domain → the research-spec/1 queries that cover it", () => {
    expect(SPEC_V1_DOMAIN_QUERIES).toEqual({
      identity: ["Q1"], affiliations: ["Q1"], achievements: ["Q2"], press: ["Q3", "Q6"], narrative: ["Q3"],
      brand_mentions: ["Q4"], social_handles: ["Q5"], profile: ["Q1", "Q6"], signals: [],
    });
  });

  it("cannot drift from SECTION_DOMAIN: every section's home domain is planned with the query that asks that section", () => {
    for (const [section, domain] of Object.entries(SECTION_DOMAIN)) {
      const q = QUERIES.find((x) => (x.sections as string[]).includes(section));
      expect(q).toBeDefined();
      expect(SPEC_V1_DOMAIN_QUERIES[domain]).toContain(q!.id);
    }
    // and nothing planned is outside the spec: every query reaches at least one domain, every table entry is a real query
    for (const id of QUERY_IDS) expect(Object.values(SPEC_V1_DOMAIN_QUERIES).some((qs) => qs.includes(id))).toBe(true);
    for (const d of RESEARCH_DOMAINS) for (const q of SPEC_V1_DOMAIN_QUERIES[d]) expect(QUERY_IDS).toContain(q);
  });

  it("due domains → the union of their queries, Q1 first whenever it is present", () => {
    expect(specV1QueriesFor(["press", "identity"])).toEqual(["Q1", "Q3", "Q6"]);
    expect(specV1QueriesFor(["social_handles", "profile"])).toEqual(["Q1", "Q5", "Q6"]);
    expect(specV1QueriesFor(["narrative", "press"])).toEqual(["Q3", "Q6"]);   // no Q1 when no due domain needs it
    expect(specV1QueriesFor([...RESEARCH_DOMAINS])).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
    expect(specV1QueriesFor(["signals"])).toEqual([]);
    expect(specV1QueriesFor([])).toEqual([]);
    for (const d of RESEARCH_DOMAINS) { const qs = specV1QueriesFor([d, "identity"]); expect(qs[0]).toBe("Q1"); }
  });

  it("is selected by the provider binding; the kimi (v2) binding keeps the legacy table unchanged", () => {
    const kimi = planTableFor("kimi");
    expect(kimi.binding).toBe("kimi");
    expect(kimi.queries).toEqual(Object.fromEntries(RESEARCH_DOMAINS.map((d) => [d, DOMAIN_PLANS[d].queries])));
    expect(kimi.queries).toEqual({
      identity: ["Profile + Social"], profile: ["Profile + Social"], affiliations: ["Profile + Social"], achievements: ["Performance + Press"],
      press: ["Performance + Press"], brand_mentions: ["Commercial + Brand"], narrative: [], social_handles: ["Social Handles"], signals: [],
    } satisfies Record<ResearchDomain, string[]>);
    const direct = planTableFor("direct");
    expect(direct).toEqual({ binding: "direct", queries: SPEC_V1_DOMAIN_QUERIES });
  });
});

describe("direct plan budget (adaptation 2): policy-driven, defaults unchanged", () => {
  it("a full plan needs 18 attempts at the default retry count; the reservation is capped only by the policy", () => {
    const full = specV1QueriesFor([...RESEARCH_DOMAINS]);
    expect(DEFAULT_PLANNER_POLICY.maxCallsPerRun).toBe(8);   // unchanged here: values wait for measured runs + verified pricing
    expect(directPlanAttempts(full, DEFAULT_PLANNER_POLICY)).toEqual({ attempts: 18, reserveCalls: 8 });
    expect(directPlanAttempts(full, { ...DEFAULT_PLANNER_POLICY, maxCallsPerRun: 18 })).toEqual({ attempts: 18, reserveCalls: 18 });
    expect(directPlanAttempts(["Q1"], DEFAULT_PLANNER_POLICY)).toEqual({ attempts: 3, reserveCalls: 3 });
  });
});
