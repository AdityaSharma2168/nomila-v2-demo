/** direct-evidence/1 + native lineage — contract text, parser, degenerate detection, Gemini index binding, OpenAI URL matching. Synthetic; no network. */

import { describe, expect, it } from "@jest/globals";
import { contractFor, DIRECT_OUTPUT_RULE_HYBRID, DIRECT_OUTPUT_RULE_JSON, directDegenerate, directRequest, HYBRID_MARKER, parseDirectEvidence, splitHybrid } from "./directEvidenceV1";
import { bindGeminiClaim, geminiChunksToEnvelopeChunks, matchOpenAIClaim, normalizeUrl, openaiSourcesToEnvelopeChunks, withLineage } from "./directLineage";
import { compileRequest, FORBIDDEN_IN_REQUESTS, QUERIES, sectionsFor } from "./researchSpecV1";

const ADULT = { fullName: "Jane Doe", sport: "basketball", anchor: "basketball athlete, Example University", isMinor: false };
const all = sectionsFor(false);
const Q1 = QUERIES[0];

describe("direct-evidence/1 contract and request", () => {
  it("names only the query's sections and items, keeps the frozen request text, and contains no forbidden words", () => {
    for (const q of QUERIES) {
      const c = contractFor(q, all);
      for (const s of all) expect(c.includes(`"${s.id}": {`)).toBe(q.sections.includes(s.id));
      const req = directRequest(compileRequest(ADULT, q, "2026-09-13"), q, all);
      expect(req.startsWith("Athlete identity anchor: basketball athlete, Example University\nAthlete: Jane Doe — basketball\nAs-of date: 2026-09-13\n\n")).toBe(true);
      expect(req).not.toContain("FOUND / NOT FOUND / CONFLICTING / NOT APPLICABLE");   // the prose/status closing line is replaced by the contract
      expect(req).toContain("Output contract (direct-evidence/1)");
      for (const re of FORBIDDEN_IN_REQUESTS) expect(req).not.toMatch(re);
    }
    for (const rule of [DIRECT_OUTPUT_RULE_JSON, DIRECT_OUTPUT_RULE_HYBRID]) { expect(rule).toMatch(/Prefer NOT FOUND over invention/); for (const re of FORBIDDEN_IN_REQUESTS) expect(rule).not.toMatch(re); }
    expect(DIRECT_OUTPUT_RULE_HYBRID).toContain(HYBRID_MARKER);
  });
});

describe("parser", () => {
  const json = JSON.stringify({
    contract: "direct-evidence/1", query: "Q1",
    identity: { anchor_match: "matched", confidence: 0.95, namesakes: [{ description: "an actress", source_url: "https://x.example/a" }] },
    sections: { S1: { status: "found_cited", items: { full_name: "found_cited", aliases: "not_found" }, reason: null }, "S2 Biography & affiliations": { status: "not_found", items: { current_affiliation: "not_found" } }, "Section 9": { status: "found_cited", items: {} } },
    claims: [
      { section: "S1", item: "full_name", kind: "profile_attribute", factKey: "name", value: { full: "Jane Doe" }, statement: "Her full name is Jane Doe.", sources: [{ url: "https://www.example.edu/roster/jane", title: "Roster", published_at: "2026-08-01", quote: "Her full name is Jane Doe." }], confidence: 0.9 },
      { section: "S9", item: "reported_allegations", kind: "reputation_event", event: "x", statement: "x", sources: [] },   // no stage → dropped
      { section: "S1", item: "namesakes", kind: "identity_signal", topic: "namesake", text: "an actress", statement: "An actress shares the name.", sources: [] },
    ],
  });
  it("maps claims to the cited-claims/3 shape, keeps sources, applies exact section aliases, and starts every claim as asserted_only or unsupported", () => {
    const p = parseDirectEvidence(json, all);
    expect(p.parseError).toBeNull();
    expect(p.identity).toEqual({ anchorMatch: "matched", confidence: 0.95, namesakes: [{ description: "an actress", sourceUrl: "https://x.example/a" }] });
    expect(Object.keys(p.sectionOutcomes).sort()).toEqual(["S1", "S2"]);
    expect(p.unknownSectionKeys).toEqual(["Section 9"]);
    expect(p.claims).toHaveLength(2);
    expect(p.claims[0]).toMatchObject({ kind: "profile_attribute", claim: { factKey: "name", value: { full: "Jane Doe" } }, section: "S1", item: "full_name", publishedAt: "2026-08-01", citation: { chunkIds: [], quote: "Her full name is Jane Doe." }, lineage: { level: "asserted_only" } });
    expect(p.claims[1].lineage.level).toBe("unsupported");
    expect(parseDirectEvidence("```json\n" + json + "\n```", all).claims).toHaveLength(2);
    expect(parseDirectEvidence("not json at all", all).parseError).toBeTruthy();
  });

  it("splits a hybrid response at the exact marker and detects degenerate answers", () => {
    const h = splitHybrid(`PART 1 prose\n${HYBRID_MARKER}\n${json}`);
    expect(h).toMatchObject({ markerFound: true, prose: "PART 1 prose\n" });
    expect(parseDirectEvidence(h.jsonText, all).claims).toHaveLength(2);
    expect(splitHybrid("no marker").markerFound).toBe(false);
    const empty = parseDirectEvidence(JSON.stringify({ identity: { anchor_match: "matched", confidence: 0.9 }, sections: { S1: { status: "not_found", items: { full_name: "not_found" } } }, claims: [] }), all);
    expect(directDegenerate(empty, 12, all).reason).toMatch(/zero claims although the identity was matched/);
    const abst = parseDirectEvidence(JSON.stringify({ identity: { anchor_match: "not_resolved", confidence: 0.1 }, sections: { S1: { status: "not_found", items: { full_name: "not_found" } } }, claims: [] }), all);
    expect(directDegenerate(abst, 12, all).degenerate).toBe(false);   // a not_resolved identity with zero claims is a valid abstention
    expect(directDegenerate(parseDirectEvidence("{}", all), 3, all).reason).toMatch(/no section_outcomes/);
  });
});

describe("Gemini native lineage: quote → prose → support index range → chunks", () => {
  const prose = "### PART 1\n* **Full Name**: Her full name is Jane Elizabeth Doe. **STATUS**: FOUND.\n* **Hometown**: She is from Springfield, Illinois. Springfield, Illinois. **STATUS**: FOUND.";
  const chunks = [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "Roster", domain: "example.edu" } }, { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def", title: "Wiki", domain: "wikipedia.org" } }];
  const seg = (t: string) => ({ startIndex: prose.indexOf(t), endIndex: prose.indexOf(t) + t.length, text: t });
  const supports = [
    { segment: seg("Full Name**: Her full name is Jane Elizabeth Doe"), groundingChunkIndices: [0, 1] },   // the API drops the closing period
    { segment: seg("She is from Springfield, Illinois"), groundingChunkIndices: [1] },
  ];
  it("binds by index containment, tolerating the trailing punctuation the support text omits, and records the bound chunk as the source", () => {
    const l = bindGeminiClaim("Her full name is Jane Elizabeth Doe.", prose, supports, chunks, "gd0");
    expect(l).toMatchObject({ level: "native_supported", match: "index_support", boundChunkIds: ["gd0:c0", "gd0:c1"], boundSources: [expect.objectContaining({ domain: "example.edu" }), expect.objectContaining({ domain: "wikipedia.org" })], detail: null });
    // deterministic tightening (13 Sep 2026, slice E): a quote occurring more than once in the prose no longer
    // "first occurrence wins" — it does not bind at all, and falls through to asserted_only with an ambiguity detail.
    const rep = bindGeminiClaim("Springfield, Illinois.", prose, supports, chunks, "gd0");
    expect(rep.level).toBe("asserted_only");
    expect(rep.detail).toMatch(/occurs more than once|ambiguous: occurs 2 times/);
  });
  it("stays asserted_only when the quote is not verbatim in the prose or no support covers it, and unsupported without a quote", () => {
    expect(bindGeminiClaim("Her full name is Jane E. Doe.", prose, supports, chunks, "gd0")).toMatchObject({ level: "asserted_only", detail: expect.stringContaining("not found verbatim") });
    // "STATUS**: FOUND." occurs twice in the prose (once per bullet): ambiguous takes precedence over the
    // no-coverage reason, since uniqueness is now checked before containment.
    expect(bindGeminiClaim("STATUS**: FOUND.", prose, supports, chunks, "gd0")).toMatchObject({ level: "asserted_only", detail: expect.stringContaining("ambiguous: occurs 2 times") });
    expect(bindGeminiClaim("", prose, supports, chunks, "gd0").level).toBe("unsupported");
    expect(bindGeminiClaim("Her full name is Jane Elizabeth Doe.", prose, [{ segment: seg("Full Name**: Her full name is Jane Elizabeth Doe"), groundingChunkIndices: [] }], chunks, "gd0").detail).toMatch(/names no grounding chunk/);
  });
  it("binds by byte offsets too when the prose has multi-byte characters before the quote", () => {
    const p2 = "Jane Doe — “the Maestro” — plays. Her hometown is Springfield.";
    const q = "Her hometown is Springfield.";
    const b = Buffer.byteLength(p2.slice(0, p2.indexOf(q)), "utf8");
    const byteSupports = [{ segment: { startIndex: b, endIndex: b + Buffer.byteLength(q, "utf8") - 1 }, groundingChunkIndices: [0] }];
    expect(bindGeminiClaim(q, p2, byteSupports, chunks, "gd0").level).toBe("native_supported");
  });
  it("builds envelope chunks whose text is the prose segments attributed to them", () => {
    const ch = geminiChunksToEnvelopeChunks(chunks, supports, prose, "gd0");
    expect(ch[1].text).toContain("She is from Springfield, Illinois");
    expect(ch[0]).toMatchObject({ id: "gd0:c0", domain: "example.edu", textKind: "provider_answer_segments" });
  });
});

describe("OpenAI native lineage: claim URL → retrieved sources", () => {
  const retrieved = [{ url: "https://www.wnba.com/player/1/jane-doe/bio", title: "Bio" }, { url: "http://example.edu/roster/jane/?utm_source=openai" }];
  it("matches exact first, then conservative normalization, and records which", () => {
    expect(matchOpenAIClaim([{ url: "https://www.wnba.com/player/1/jane-doe/bio" }], retrieved, "od0")).toMatchObject({ level: "native_retrieved", match: "url_exact", boundChunkIds: ["od0:c0"], boundSources: [{ url: "https://www.wnba.com/player/1/jane-doe/bio", domain: "wnba.com", title: "Bio" }] });
    expect(matchOpenAIClaim([{ url: "https://example.edu/roster/jane" }], retrieved, "od0")).toMatchObject({ level: "native_retrieved", match: "url_normalized", boundChunkIds: ["od0:c1"] });
    expect(matchOpenAIClaim([{ url: "https://example.edu/roster/other" }], retrieved, "od0")).toMatchObject({ level: "asserted_only", match: "none" });
    expect(matchOpenAIClaim([], retrieved, "od0").level).toBe("unsupported");
    expect(normalizeUrl("HTTP://WWW.Example.edu/roster/jane/?utm_source=openai&ref=x#frag")).toBe("https://example.edu/roster/jane");
    expect(normalizeUrl("https://example.edu/a?b=1")).toBe("https://example.edu/a?b=1");   // ordinary query strings are kept
    expect(openaiSourcesToEnvelopeChunks(retrieved, "od0")[1]).toMatchObject({ id: "od0:c1", domain: "example.edu", text: "", textKind: "source_excerpt" });
  });
  it("withLineage puts the bound chunk ids on the citation and never invents a quote", () => {
    const c = parseDirectEvidence(JSON.stringify({ identity: {}, sections: {}, claims: [{ section: "S1", item: "full_name", kind: "profile_attribute", factKey: "name", value: { full: "Jane Doe" }, statement: "s", sources: [{ url: "https://www.wnba.com/player/1/jane-doe/bio", quote: "Jane Doe" }] }] }), all).claims[0];
    const bound = withLineage(c, matchOpenAIClaim(c.sources, retrieved, "od0"));
    expect(bound.citation).toEqual({ chunkIds: ["od0:c0"], quote: "Jane Doe" });
    expect(bound.lineage.level).toBe("native_retrieved");
  });
});
