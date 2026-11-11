/**
 * claims.test.ts — the admissibility policy identity-admissibility/0.2 (Concept 0.4 Part B), pure.
 *
 *   C1 source tiers per policy (facts, evidence by lineage × source type)
 *   C2 claim grouping by fact key + normalised value; free text only on an exact normalised match
 *   C3 corroboration: ≥ N named reputable outlets, pages NOT retrieved → Reported; ≥ N retrieved → Established;
 *      syndication on one registrable domain counts once; a single blog → Unconfirmed
 *   C4 her denial → Excluded (beats everything); her confirmation → Established; a source's own tier never changes
 * Fixtures are fictional; no person, sport or school is assumed.
 */
import { assessClaim, assessClaims, normaliseText, registrableDomain, sourceTierOfEvidence, sourceTierOfFact, withoutTierLabels } from "./claims";
import { refKey, type BasisItem, type BasisRef } from "./contract";

let n = 0;
function ev(text: string, sourceType: string, lineage: string, domain: string, claimKey: string | null = `text:${normaliseText(text)}`): BasisItem {
  const ref: BasisRef = { kind: "evidence", id: `e${++n}` };
  const t = sourceTierOfEvidence({ lineage, sourceType });
  return { key: refKey(ref), ref, text, sourceTier: t, tier: t, claimKey, source: { type: sourceType, lineage, domain }, athleteAuthority: false, athleticIdentity: false, asOf: null, salience: 0 };
}
function fact(text: string, status: string, claimKey: string): BasisItem {
  const ref: BasisRef = { kind: "fact", id: `f${++n}` };
  const t = sourceTierOfFact(status);
  return { key: refKey(ref), ref, text, sourceTier: t, tier: t, claimKey, source: { status }, athleteAuthority: false, athleticIdentity: false, asOf: null, salience: 0 };
}
const verdicts = (denied: string[] = [], confirmed: string[] = []) => ({ denied: new Set(denied), confirmed: new Set(confirmed) });

describe("C1 source tiers per policy", () => {
  it("facts: current/historical Established, disputed Unconfirmed, retracted Excluded", () => {
    expect(sourceTierOfFact("current")).toBe("established");
    expect(sourceTierOfFact("historical")).toBe("established");
    expect(sourceTierOfFact("disputed")).toBe("unconfirmed");
    expect(sourceTierOfFact("retracted")).toBe("excluded");
  });
  it("evidence: official/major/reference + native_supported Established; one retrieved regional or first-party source Reported", () => {
    expect(sourceTierOfEvidence({ lineage: "native_supported", sourceType: "official_team_or_school" })).toBe("established");
    expect(sourceTierOfEvidence({ lineage: "native_supported", sourceType: "major_news" })).toBe("established");
    expect(sourceTierOfEvidence({ lineage: "native_supported", sourceType: "reference" })).toBe("established");
    expect(sourceTierOfEvidence({ lineage: "native_retrieved", sourceType: "major_news" })).toBe("reported");
    expect(sourceTierOfEvidence({ lineage: "native_supported", sourceType: "regional_news" })).toBe("reported");
    expect(sourceTierOfEvidence({ lineage: "cited", sourceType: "athlete_authored_public" })).toBe("reported");
  });
  it("evidence: a blog, an unknown source, or an unretrieved citation is Unconfirmed on its own", () => {
    expect(sourceTierOfEvidence({ lineage: "native_supported", sourceType: "aggregator_or_blog" })).toBe("unconfirmed");
    expect(sourceTierOfEvidence({ lineage: "native_supported", sourceType: "unknown" })).toBe("unconfirmed");
    expect(sourceTierOfEvidence({ lineage: "asserted_only", sourceType: "major_news" })).toBe("unconfirmed");
  });
  it("withoutTierLabels blanks honour-tier labels, case-insensitively, and keeps a genuine first", () => {
    for (const t of ["All-Conference First Team", "first-team all-region", "1st Team pick", "named to the First XI", "a first-class debut", "a FIRST-ROUND pick"]) {
      expect(withoutTierLabels(t).toLowerCase()).not.toMatch(/\bfirst\b|\b1st\b/);
    }
    expect(withoutTierLabels("First player from the region to make the squad")).toContain("First player");
  });
  it("0.2: source_read is a retrieved lineage; her verbatim words are Reported only when the targeted read found them", () => {
    expect(sourceTierOfEvidence({ lineage: "source_read", sourceType: "major_news" })).toBe("reported");
    expect(sourceTierOfEvidence({ lineage: "source_read", sourceType: "aggregator_or_blog" })).toBe("unconfirmed");
    expect(sourceTierOfEvidence({ lineage: "source_read", sourceType: "unknown", kind: "athlete_statement" })).toBe("reported");
    expect(sourceTierOfEvidence({ lineage: "asserted_only", sourceType: "major_news", kind: "athlete_statement" })).toBe("excluded");
    expect(sourceTierOfEvidence({ lineage: "native_supported", sourceType: "major_news", kind: "athlete_statement" })).toBe("excluded");
  });
});

describe("C2 grouping", () => {
  it("groups structured items by fact key + normalised value and lifts every member to the claim's tier", () => {
    const a = fact("Team: Northfield Hawks", "current", "fact:affiliation:northfield hawks school");
    const b = ev("Team: Northfield Hawks", "aggregator_or_blog", "native_supported", "fanblog.example", "fact:affiliation:northfield hawks school");
    const c = ev("Something else", "aggregator_or_blog", "native_supported", "other.example");
    const claims = assessClaims([a, b, c]);
    expect(claims).toHaveLength(2);
    expect(b.sourceTier).toBe("unconfirmed");      // its OWN tier never changes
    expect(b.tier).toBe("established");            // the claim it belongs to is Established
    expect(c.tier).toBe("unconfirmed");
    expect(claims.find((x) => x.basis.length === 2)!.tier).toBe("established");
  });
  it("free text groups only on an exact normalised match — never similarity", () => {
    expect(normaliseText("First-ever  Title, won!")).toBe(normaliseText("first ever title won"));
    const x = ev("Wins the regional title", "major_news", "asserted_only", "paper-a.example");
    const y = ev("Wins the regional title.", "major_news", "asserted_only", "paper-b.example");
    const z = ev("Wins regional title", "major_news", "asserted_only", "paper-c.example");
    assessClaims([x, y, z]);
    expect(x.claimKey).toBe(y.claimKey);
    expect(z.claimKey).not.toBe(x.claimKey);
    expect(x.tier).toBe("reported");
    expect(z.tier).toBe("unconfirmed");
  });
});

describe("C3 corroboration", () => {
  it("≥ 2 named reputable outlets whose pages were NOT retrieved → Reported (Q1)", () => {
    const t = assessClaim([ev("Named first in the program", "major_news", "asserted_only", "outlet-one.example"), ev("Named first in the program", "regional_news", "asserted_only", "outlet-two.example")]);
    expect(t.tier).toBe("reported");
    expect(t.independentDomains).toBe(2);
    expect(t.confidenceReason).toMatch(/2 reputable outlets named; 2 not retrieved/);
  });
  it("≥ 2 independent reputable domains, retrieved → Established", () => {
    expect(assessClaim([ev("x", "regional_news", "native_supported", "a-news.example"), ev("x", "regional_news", "native_retrieved", "b-news.example")]).tier).toBe("established");
  });
  it("syndicated copies on one registrable domain count once", () => {
    expect(registrableDomain("sports.paper.example")).toBe("paper.example");
    expect(registrableDomain("www.paper.co.uk")).toBe("paper.co.uk");
    const t = assessClaim([ev("x", "major_news", "asserted_only", "www.paper.example"), ev("x", "major_news", "asserted_only", "sports.paper.example")]);
    expect(t.independentDomains).toBe(1);
    expect(t.tier).toBe("unconfirmed");
  });
  it("a single blog → Unconfirmed; blogs never count as reputable", () => {
    expect(assessClaim([ev("x", "aggregator_or_blog", "native_supported", "blog.example")]).tier).toBe("unconfirmed");
    expect(assessClaim([ev("x", "aggregator_or_blog", "asserted_only", "blog-a.example"), ev("x", "unknown", "asserted_only", "blog-b.example")]).tier).toBe("unconfirmed");
  });
});

describe("C4 athlete authority", () => {
  it("her denial excludes the claim, even over an Established source", () => {
    const f = fact("Award: Example Award, 2025", "current", "fact:award:x");
    expect(assessClaim([f], verdicts([f.key])).tier).toBe("excluded");
  });
  it("her confirmation lifts an Unconfirmed claim to Established", () => {
    const e = ev("x", "aggregator_or_blog", "native_supported", "blog.example");
    const t = assessClaim([e], verdicts([], [e.key]));
    expect(t.tier).toBe("established");
    expect(t.athleteConfirmed).toBe(true);
    expect(e.sourceTier).toBe("unconfirmed");
  });
});
