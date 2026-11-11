/**
 * directLineage.test.ts — bindGeminiFinding: deterministic quote/statement precedence, uniqueness-in-prose,
 * conservative normalization (NFKC + whitespace + terminal punctuation + case), and grounding-support
 * containment. No fuzzy/semantic matching, no response-level inheritance. bindGeminiClaim is the quote-only
 * backward-compatible wrapper. No network.
 */

import { describe, expect, it } from "@jest/globals";
import { bindGeminiClaim, bindGeminiFinding, type GroundingChunkLike, type GroundingSupportLike } from "./directLineage";

const CHUNKS: GroundingChunkLike[] = [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "Roster", domain: "athletics.example.edu" } }];

/** A support whose segment covers exactly the given text's span in `prose`. */
const supportFor = (prose: string, text: string, chunkIndices: number[] = [0]): GroundingSupportLike => {
  const start = prose.indexOf(text);
  return { segment: { startIndex: start, endIndex: start + text.length, text }, groundingChunkIndices: chunkIndices };
};

describe("bindGeminiFinding — precedence and uniqueness", () => {
  it("(a) an exact quote occurring once, covered by a support, binds quote_exact", () => {
    const prose = "Jane Doe plays midfield for Example University.";
    const supports = [supportFor(prose, "Jane Doe plays midfield for Example University")];
    const l = bindGeminiFinding({ quote: "Jane Doe plays midfield for Example University.", statement: null }, prose, supports, CHUNKS, "gd0");
    expect(l).toMatchObject({ level: "native_supported", match: "index_support", bindingMethod: "quote_exact", boundChunkIds: ["gd0:c0"] });
  });

  it("(b) no quote, but the statement occurs verbatim once in a supported span → statement_exact", () => {
    const prose = "She was named All-ACC First Team in 2025.";
    const supports = [supportFor(prose, "She was named All-ACC First Team in 2025")];
    const l = bindGeminiFinding({ quote: null, statement: "She was named All-ACC First Team in 2025." }, prose, supports, CHUNKS, "gd0");
    expect(l).toMatchObject({ level: "native_supported", bindingMethod: "statement_exact", boundChunkIds: ["gd0:c0"] });
  });

  it("(c) a quote differing only by case, trailing period, doubled whitespace and NFKC-normalizable characters binds quote_normalized_exact, with the bound span in ORIGINAL prose coordinates", () => {
    // full-width "Ｄ" (NFKC → "D") plus a curly closing quote that is stripped as trailing punctuation.
    const prose = 'Jane Ｄoe is from Springfield, Illinois.';
    const supports = [supportFor(prose, "Jane Ｄoe is from Springfield, Illinois")];
    // differs by: case (upper QUOTE), doubled internal whitespace, trailing curly quote instead of period, NFKC full-width already handled by the prose side here — invert: put the variant in the needle.
    const quote = "JANE  DOE  IS FROM SPRINGFIELD, ILLINOIS”"; // extra spaces + upper-case + trailing curly quote
    const l = bindGeminiFinding({ quote, statement: null }, prose, supports, CHUNKS, "gd0");
    expect(l).toMatchObject({ level: "native_supported", bindingMethod: "quote_normalized_exact", boundChunkIds: ["gd0:c0"] });
    // the bound chunk's source resolves through the original-coordinate span (containment succeeded against the
    // support built from the ORIGINAL prose text), proving the located span was translated back correctly.
    expect(l.boundSources[0]).toMatchObject({ domain: "athletics.example.edu" });
  });

  it("(d) no quote; a normalized statement (case + trailing punctuation + whitespace) binds statement_normalized_exact", () => {
    const prose = "Her hometown is Springfield, Illinois.";
    const supports = [supportFor(prose, "Her hometown is Springfield, Illinois")];
    const statement = "her   hometown is springfield, illinois!!!";
    const l = bindGeminiFinding({ quote: null, statement }, prose, supports, CHUNKS, "gd0");
    expect(l).toMatchObject({ level: "native_supported", bindingMethod: "statement_normalized_exact", boundChunkIds: ["gd0:c0"] });
  });

  it("(e) a needle occurring twice does not bind at that level; falls through to asserted_only with an ambiguity detail", () => {
    const prose = "Springfield, Illinois. Springfield, Illinois.";
    const supports = [supportFor(prose, "Springfield, Illinois")];
    const l = bindGeminiFinding({ quote: "Springfield, Illinois.", statement: null }, prose, supports, CHUNKS, "gd0");
    expect(l.level).toBe("asserted_only");
    expect(l.bindingMethod).toBe("none");
    expect(l.detail).toMatch(/ambiguous: occurs 2 times/);
  });

  it("(f) a needle present in the prose but outside every support stays asserted_only, bindingMethod none", () => {
    const prose = "Jane Doe plays midfield. **STATUS**: FOUND.";
    const supports = [supportFor(prose, "Jane Doe plays midfield")];
    const l = bindGeminiFinding({ quote: "STATUS**: FOUND.", statement: null }, prose, supports, CHUNKS, "gd0");
    expect(l).toMatchObject({ level: "asserted_only", bindingMethod: "none" });
    expect(l.detail).toMatch(/no grounding support covers/);
  });

  it("(g) a paraphrase (word order changed) never binds — no fuzzy matching", () => {
    const prose = "Jane Doe plays midfield for Example University.";
    const supports = [supportFor(prose, "Jane Doe plays midfield for Example University")];
    const l = bindGeminiFinding({ quote: null, statement: "For Example University, Jane Doe plays midfield." }, prose, supports, CHUNKS, "gd0");
    expect(l.level).not.toBe("native_supported");
    expect(l.bindingMethod).toBe("none");
  });

  it("(h) precedence: when both quote and statement would independently bind, quote_exact wins", () => {
    const prose = "Her full name is Jane Doe. She plays midfield for Example University.";
    const supports = [supportFor(prose, "Her full name is Jane Doe"), supportFor(prose, "She plays midfield for Example University")];
    const l = bindGeminiFinding({ quote: "Her full name is Jane Doe.", statement: "She plays midfield for Example University." }, prose, supports, CHUNKS, "gd0");
    expect(l.bindingMethod).toBe("quote_exact");
    expect(l.boundSources[0]).toMatchObject({ domain: "athletics.example.edu" });
  });

  it("neither quote nor statement present → unsupported, bindingMethod none", () => {
    const l = bindGeminiFinding({ quote: null, statement: undefined }, "some prose", [], CHUNKS, "gd0");
    expect(l).toMatchObject({ level: "unsupported", bindingMethod: "none" });
  });

  it("a statement found in the prose but with no covering support stays asserted_only, bindingMethod none (per-level containment is still required)", () => {
    const prose = "Jane Doe plays midfield for Example University.";
    const l = bindGeminiFinding({ quote: null, statement: "Jane Doe plays midfield for Example University." }, prose, [], CHUNKS, "gd0");
    expect(l).toMatchObject({ level: "asserted_only", bindingMethod: "none" });
  });
});

describe("(i) bindGeminiClaim — thin quote-only wrapper reproduces the prior single-method results", () => {
  const prose = "### PART 1\n* **Full Name**: Her full name is Jane Elizabeth Doe. **STATUS**: FOUND.\n* **Hometown**: She is from Springfield, Illinois.";
  const chunks: GroundingChunkLike[] = [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "Roster", domain: "example.edu" } }, { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def", title: "Wiki", domain: "wikipedia.org" } }];
  const seg = (t: string) => ({ startIndex: prose.indexOf(t), endIndex: prose.indexOf(t) + t.length, text: t });
  const supports: GroundingSupportLike[] = [
    { segment: seg("Full Name**: Her full name is Jane Elizabeth Doe"), groundingChunkIndices: [0, 1] },
    { segment: seg("She is from Springfield, Illinois"), groundingChunkIndices: [1] },
  ];

  it("binds a unique quote by index containment and records the bound chunk as the source", () => {
    const l = bindGeminiClaim("Her full name is Jane Elizabeth Doe.", prose, supports, chunks, "gd0");
    expect(l).toMatchObject({ level: "native_supported", match: "index_support", bindingMethod: "quote_exact", boundChunkIds: ["gd0:c0", "gd0:c1"], boundSources: [expect.objectContaining({ domain: "example.edu" }), expect.objectContaining({ domain: "wikipedia.org" })], detail: null });
  });

  it("stays asserted_only when the quote is not verbatim in the prose, and unsupported without a quote", () => {
    expect(bindGeminiClaim("Her full name is Jane E. Doe.", prose, supports, chunks, "gd0")).toMatchObject({ level: "asserted_only", bindingMethod: "none", detail: expect.stringContaining("not found verbatim") });
    expect(bindGeminiClaim("", prose, supports, chunks, "gd0")).toMatchObject({ level: "unsupported", bindingMethod: "none" });
  });

  it("binds by byte offsets too when the prose has multi-byte characters before the quote", () => {
    const p2 = "Jane Doe — “the Maestro” — plays. Her hometown is Springfield.";
    const q = "Her hometown is Springfield.";
    const b = Buffer.byteLength(p2.slice(0, p2.indexOf(q)), "utf8");
    const byteSupports: GroundingSupportLike[] = [{ segment: { startIndex: b, endIndex: b + Buffer.byteLength(q, "utf8") - 1 }, groundingChunkIndices: [0] }];
    expect(bindGeminiClaim(q, p2, byteSupports, chunks, "gd0")).toMatchObject({ level: "native_supported", bindingMethod: "quote_exact" });
  });
});
