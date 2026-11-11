/**
 * orgImagery.test — an organisation's or team's logo comes ONLY from an official domain Nomila already holds (research
 * evidence from an official source that names it, or a verified fact citing such evidence), else from a domain she wrote
 * herself; never from the name. No domain ⇒ no logo. Read-only; no provider. Fictional orgs and domains throughout.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { athleteAsserted, athleteFacts, researchEvidence, researchRuns } from "../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { orgDomainFromAssertions, orgDomainFromResearch, orgLogos } from "./orgImagery";

const ev = (id: string, over: Record<string, unknown> = {}): any => ({ id, claim: {}, source_domain: "northfieldgirls.org", source_type: "official_team_or_school", suspect: false, superseded_by: null, ...over });

describe("the official domain, pure", () => {
  it("a verified fact naming the org, citing official evidence → that evidence's domain", () => {
    const facts = [{ value: { org: "Northfield Girls Program", orgKind: "club" }, status: "current", provenance: { evidenceIds: ["e1"] } }];
    expect(orgDomainFromResearch("Northfield Girls Program", facts, [ev("e1", { source_domain: "www.northfieldgirls.org" })])).toBe("northfieldgirls.org");
    expect(orgDomainFromResearch("northfield girls program", facts, [ev("e1")])).toBe("northfieldgirls.org");   // the same name, any case
  });
  it("official evidence whose own claim names the org", () => {
    expect(orgDomainFromResearch("Riverside Rovers", [], [ev("e2", { claim: { value: { organization: "Riverside Rovers" } }, source_domain: "riversiderovers.com" })])).toBe("riversiderovers.com");
  });
  it("never: a non-official source, suspect or superseded evidence, a social host, another org's page, a retracted fact", () => {
    const named = { claim: { org: "Riverside Rovers" } };
    expect(orgDomainFromResearch("Riverside Rovers", [], [ev("a", { ...named, source_type: "major_news" })])).toBeNull();
    expect(orgDomainFromResearch("Riverside Rovers", [], [ev("b", { ...named, suspect: true })])).toBeNull();
    expect(orgDomainFromResearch("Riverside Rovers", [], [ev("c", { ...named, superseded_by: "x" })])).toBeNull();
    expect(orgDomainFromResearch("Riverside Rovers", [], [ev("d", { ...named, source_domain: "instagram.com" })])).toBeNull();
    expect(orgDomainFromResearch("Riverside Rovers", [], [ev("e", { claim: { org: "Another Club" } })])).toBeNull();
    expect(orgDomainFromResearch("Riverside Rovers", [{ value: { org: "Riverside Rovers" }, status: "retracted", provenance: { evidenceIds: ["f"] } }], [ev("f")])).toBeNull();
  });
  it("her own words: a domain she wrote beside the org's name; an email address or a name alone is not one", () => {
    expect(orgDomainFromAssertions("Northfield Girls Program", [{ value: "I coach at the Northfield Girls Program (northfieldgirls.org)", said: null }])).toBe("northfieldgirls.org");
    expect(orgDomainFromAssertions("Northfield Girls Program", [{ value: "Northfield Girls Program — write to me at hi@northfieldgirls.org", said: null }])).toBeNull();
    expect(orgDomainFromAssertions("Northfield Girls Program", [{ value: "I coach at the Northfield Girls Program", said: null }])).toBeNull();
    expect(orgDomainFromAssertions("Northfield Girls Program", [{ value: "my site is herownsite.com", said: null }])).toBeNull();   // does not name the org
  });
});

describe("orgLogos, on PGlite", () => {
  jest.setTimeout(180_000);
  beforeAll(async () => { await initTestDb(); });
  afterAll(async () => { await closeTestDb(); });

  it("an org with an official domain → its logo through the brands pipeline; an org with none → absent", async () => {
    const a = await seedAthlete("Org Athlete");
    const [run] = await db.insert(researchRuns).values({ athlete_id: a, domain: "affiliations", trigger: "manual", status: "ok" } as any).returning({ id: researchRuns.id });
    const [e] = await db.insert(researchEvidence).values({ athlete_id: a, run_id: run.id, kind: "affiliation", claim: { factKey: "affiliation" } as any, lineage_status: "native_supported", source_url: "https://riversiderovers.com/roster", source_domain: "riversiderovers.com", source_type: "official_team_or_school", retrieved_at: new Date("2026-09-01"), confidence: "0.9", source_class: "web_researched", suspect: false, dedupe_key: "aff:rr" } as any).returning({ id: researchEvidence.id });
    await db.insert(athleteFacts).values({ athlete_id: a, fact_key: "affiliation", value: { org: "Riverside Rovers", orgKind: "club" } as any, value_text: "riverside rovers", status: "current", retrieved_at: new Date("2026-09-01"), origin: "research", source_class: "web_researched", authority_tier: 2, confidence: "0.9", provenance: { evidenceIds: [e.id] } as any, freshness_family: "affiliations", resolver_version: "v2", registry_version: "v3" } as any);
    await db.insert(athleteAsserted).values({ athlete_id: a, field: "causes", value: "I volunteer with the Northfield Girls Program, northfieldgirls.org" as any, source: "chat" } as any);
    const m = await orgLogos(db as any, a, ["Riverside Rovers", "Northfield Girls Program", "Unknown Youth League"]);
    expect(m.get("riversiderovers")).toEqual({ name: "Riverside Rovers", domain: "riversiderovers.com", logoUrl: "https://www.google.com/s2/favicons?domain=riversiderovers.com&sz=128", source: "official_research" });
    expect(m.get("northfieldgirlsprogram")).toMatchObject({ domain: "northfieldgirls.org", source: "her_words" });
    expect(m.has("unknownyouthleague")).toBe(false);
    // another athlete holds nothing for these names
    const b = await seedAthlete("Someone Else");
    expect((await orgLogos(db as any, b, ["Riverside Rovers"])).size).toBe(0);
  });
});
