/**
 * knowledge.identity.test.ts — identityOf (knowledge/2.1): the Me header's identity, pure (no DB, no provider).
 *
 *   I1 nationality comes from the current, sourced `nationality` fact(s): the registry's { country } shape, each value once;
 *      a legacy-blob fact (no source) never shows; none ⇒ null
 *   I2 role is the current primary affiliation's `role` (Concept 0.4 B1), title-cased; absent ⇒ null
 *   I3 the rest of the identity is unchanged (display name, primary label, facts)
 */
// identityOf is pure; the module graph reaches server/db (via mila/onboarding), so stand it in — nothing here queries.
jest.mock("../../../../db", () => ({ db: {}, pool: {} }));

import { identityOf, KNOWLEDGE_VIEW_VERSION } from "./knowledge";
import type { AffiliationRow, CanonicalAthleteContext, Fact } from "../contract";

const fact = <T>(value: T, over: Partial<Fact<T>> = {}): Fact<T> => ({
  value, origin: "research", sourceClass: "web_researched", authorityTier: 3, status: "current", retrievedAt: "2026-09-01T00:00:00.000Z",
  validFrom: null, validTo: null, evidenceIds: [], freshness: "fresh", factKey: "nationality", ...over,
} as Fact<T>);

const aff = (over: Partial<AffiliationRow> = {}): AffiliationRow => ({
  id: "a1", org: "Example University", kind: "school", level: null, conference: null, role: null, position: null, from: null, to: null,
  primary: true, current: true, kindOfFact: "said", source: null, recordedAt: null, ...over,
});

function ctxWith(o: { nationality?: Fact<any>[]; current?: AffiliationRow | null }): CanonicalAthleteContext {
  return {
    identity: {
      name: fact({ full: "Sam Example", first: "Sam", last: "Example" }, { origin: "legacy_row", factKey: "name" }),
      aliases: [], sport: fact({ sport: "soccer" }, { factKey: "sport" }), hometown: null,
      nationality: o.nationality ?? [], careerStatus: fact({ status: "active" }, { factKey: "career_status" }),
      identityConfidence: 1, researchStatus: "research_complete", firstName: "Sam", photoUrl: null, createdAt: null,
    },
    // knowledge/3: identityOf reads the SHOWN teams (shownAffiliations), so the current row is also in `all`.
    affiliations: { current: o.current === undefined ? aff() : o.current, all: o.current === undefined ? [aff()] : o.current ? [o.current] : [], level: {}, teamsLine: null },
    profile: { position: fact({ text: "Midfielder" }, { factKey: "position" }), classYear: null },
    assertions: [],
  } as unknown as CanonicalAthleteContext;
}

describe("identityOf (knowledge/2.1)", () => {
  it("is versioned (knowledge/3 since PR 4)", () => {
    expect(KNOWLEDGE_VIEW_VERSION).toBe("knowledge/3");   // knowledge/3 (Concept 0.4 PR 4) keeps identityOf unchanged
  });

  it("I1 nationality: current sourced facts, each country once; unsourced never; none ⇒ null", () => {
    const i = identityOf(ctxWith({ nationality: [fact({ country: "Testland" }), fact({ country: "testland" }), fact({ country: "Otherland" }, { authorityTier: 1 }), fact({ country: "Blobland" }, { origin: "legacy_blob" })] }));
    expect(i.nationality).toBe("Testland · Otherland");
    expect(identityOf(ctxWith({})).nationality).toBeNull();
    expect(identityOf(ctxWith({ nationality: [fact({ country: "Blobland" }, { origin: "legacy_blob" })] })).nationality).toBeNull();
  });

  it("I2 role: the current primary affiliation's role, title-cased; absent ⇒ null", () => {
    expect(identityOf(ctxWith({ current: aff({ role: "team captain" }) })).role).toBe("Team Captain");
    expect(identityOf(ctxWith({ current: aff({ role: "  " }) })).role).toBeNull();
    expect(identityOf(ctxWith({ current: aff() })).role).toBeNull();
    expect(identityOf(ctxWith({ current: null })).role).toBeNull();
  });

  it("I3 the rest of the identity is unchanged", () => {
    const i = identityOf(ctxWith({ current: aff({ role: "captain" }) }));
    expect(i).toMatchObject({ displayName: "Sam", fullName: "Sam Example", primary: { label: "Example Soccer", org: "Example University", orgKind: "school", sport: "Soccer" }, facts: ["Midfielder"] });
  });
});
