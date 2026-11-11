/**
 * factHygiene.test.ts — the formatting rules every memory_facts writer goes through (pure; no database, no provider).
 *
 *   H1 cleanClaim strips inline markdown citations (one or several in a parenthetical, a bare link, a bare URL) and
 *      leaves ordinary prose — brackets, numbers, abbreviations — untouched
 *   H2 normalizeSourceUrl: http(s) with a real host only; page assets, credentials, whitespace and markdown residue are
 *      rejected; tracking parameters and fragments are removed
 *   H3 cleanNewFact: a junk primary URL falls back to an also-seen URL, else to the ref; nothing usable ⇒ refused
 */
import { cleanClaim, cleanNewFact, FactHygieneError, normalizeSourceUrl } from "./factHygiene";

test("H1: inline markdown citations leave the claim; ordinary prose is untouched", () => {
  expect(cleanClaim("The season opens in October. ([example.org](https://example.org/cal?utm_source=openai))")).toBe("The season opens in October.");
  expect(cleanClaim("Finals are in December ([a.org](https://a.org/x); [b.org](https://b.org/y)).")).toBe("Finals are in December.");
  expect(cleanClaim("Named to the [conference team](https://example.org/team) in 2025.")).toBe("Named to the conference team in 2025.");
  expect(cleanClaim("Ranked third (https://example.org/rank) nationally.")).toBe("Ranked third nationally.");
  for (const plain of ["Scored 3 goals (2 assists) in the U.S. team's 4-1 win.", "Plays for Example FC [reserve squad].", "A 4.80% engagement rate."]) {
    expect(cleanClaim(plain)).toBe(plain);
  }
  expect(cleanClaim("([example.org](https://example.org))")).toBe("");
});

test("H2: a usable source URL, normalised; junk rejected", () => {
  expect(normalizeSourceUrl("https://WWW.Example.org/page?utm_source=openai&id=7#section")).toBe("https://www.example.org/page?id=7");
  expect(normalizeSourceUrl("https://example.org/a?trk=public_post")).toBe("https://example.org/a");
  expect(normalizeSourceUrl("<https://example.org/a>).")).toBe("https://example.org/a");
  expect(normalizeSourceUrl("https://example.org/report.pdf")).toBe("https://example.org/report.pdf");
  for (const junk of [
    "https://example.org/teamroster/id/1/img/bootstrap-colorpicker/alpha-horizontal.png",
    "https://example.org/logo.SVG", "https://example.org/app.js", "https://example.org/font.woff2",
    "ftp://example.org/a", "https://user:pw@example.org/a", "https://localhost/a", "https://10.0.0.1/a",
    "https://example.org/a b", "https://example.org/a](https://b.org", "not a url", "", null, undefined,
  ]) expect([junk, normalizeSourceUrl(junk as any)]).toEqual([junk, null]);
});

test("H3: cleanNewFact — fallbacks, de-duplication, and refusal", () => {
  const base = { subject: { kind: "athlete", name: "A" }, type: "found", runId: null, date: null, confidence: 0.9 };
  const a = cleanNewFact({ ...base, claim: "x ([s](https://s.org/1))", source: { url: "https://s.org/1/img/a.png", title: "T" }, alsoSeenAt: [{ url: "https://s.org/2?utm_source=x", title: "T2" }, { url: "https://s.org/2" }, { url: "junk" }] });
  expect(a).toMatchObject({ claim: "x", source: { url: "https://s.org/2", title: "T2" }, alsoSeenAt: [] });
  const b = cleanNewFact({ ...base, claim: "y", source: { url: "https://s.org/a.png", ref: "media_assets/9", title: "Post" } });
  expect(b.source).toEqual({ ref: "media_assets/9", title: "Post" });
  expect(() => cleanNewFact({ ...base, claim: "z", source: { url: "https://s.org/a.png" } })).toThrow(FactHygieneError);
  expect(() => cleanNewFact({ ...base, claim: "([s](https://s.org))", source: { url: "https://s.org" } })).toThrow(/claim_required/);
  expect(() => cleanNewFact({ ...base, claim: "w", source: {} })).toThrow(/source_required/);
});
