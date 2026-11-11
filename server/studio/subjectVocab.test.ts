import { SUBJECT_NOUNS, normalizeSubjectNoun } from "./subjectVocab";
import { GARMENT_NOUNS, normalizeGarmentNoun } from "./garmentVocab";
import { normalizeObjectNoun } from "./objectVocab";

describe("subjectVocab — the words that mean PRESERVE, kept apart from the words that mean EDIT", () => {
  it("holds the one probed subject noun", () => {
    expect(SUBJECT_NOUNS).toEqual(["person"]);
  });

  it("normalizes case and whitespace, because a model capitalizes", () => {
    expect(normalizeSubjectNoun("Person")).toBe("person");
    expect(normalizeSubjectNoun("  person  ")).toBe("person");
  });

  it("returns null for a near miss rather than substituting", () => {
    for (const near of ["people", "subject", "athlete", "human", "woman", "girl", ""]) {
      expect(normalizeSubjectNoun(near)).toBeNull();
    }
  });

  it("returns null for anything that is not a string", () => {
    for (const bad of [null, undefined, 42, {}, ["person"]]) expect(normalizeSubjectNoun(bad)).toBeNull();
  });
});

// ─── THE SEPARATION IS THE POINT, SO IT IS THE TEST ────────────────────────────────────────────

describe("the two vocabularies cannot leak into each other", () => {
  it("no garment noun is accepted as a subject noun", () => {
    // A garment noun reaching the inversion path would paste the new background everywhere EXCEPT
    // the jersey. Valid geometry, real mask, passing leak guard, wrong half of the picture.
    for (const g of GARMENT_NOUNS) expect(normalizeSubjectNoun(g)).toBeNull();
  });

  it("no subject noun is accepted as a garment noun", () => {
    // And this direction paints the new background over the athlete herself.
    for (const s of SUBJECT_NOUNS) expect(normalizeGarmentNoun(s)).toBeNull();
  });

  it("the two sets are disjoint", () => {
    const overlap = SUBJECT_NOUNS.filter((n) => GARMENT_NOUNS.includes(n));
    expect(overlap).toEqual([]);
  });

  // ─── AND THE SAME SEPARATION AGAINST THE OPEN SIDE, WHERE IT IS NO LONGER FREE ───────────────
  //
  // Everything above holds because both vocabularies are closed lists that happen not to share a
  // word. studio/objectVocab.ts is not a list, so "no subject noun is accepted as an object noun"
  // stops being a property of two constants and becomes a property of a deny set somebody has to
  // maintain. That is precisely why it is asserted here, next to the closed-set version, rather than
  // only in objectVocab's own suite: this is the file that says the separation is a correctness
  // boundary, and it should fail if the boundary moves.

  it("no subject noun is accepted as an OBJECT noun, with the open vocabulary live", () => {
    for (const sub of SUBJECT_NOUNS) expect(normalizeObjectNoun(sub, true)).toBeNull();
  });

  it("nor is any way of naming her that the subject list never had to enumerate", () => {
    // SUBJECT_NOUNS holds one word because one was PROBED. The open side has to deny the whole
    // referent, which is a much larger set — see objectVocab.test.ts for the exhaustive version.
    for (const her of ["woman", "athlete", "body", "face", "legs", "her body"]) {
      expect(normalizeObjectNoun(her, true)).toBeNull();
    }
  });

  it("every garment noun is still accepted as an object noun, on both sides of the flag", () => {
    // The other direction of the same worry: widening the edit side must not drop what already
    // works there.
    for (const g of GARMENT_NOUNS) {
      expect(normalizeObjectNoun(g, true)).toBe(g);
      expect(normalizeObjectNoun(g, false)).toBe(g);
    }
  });
});
