/**
 * citations.test.ts — inline web citations are removed from a citing skill's text, whole or streamed in any chunking;
 * ordinary parentheses and brackets pass through untouched.
 */
import { createCitationFilter, stripInlineCitations } from "./citations";

const CASES: Array<[string, string]> = [
  // The two live-eval replies (10 Oct 2026), shortened.
  ["…to protect your eligibility. ([hhsaa.org](https://hhsaa.org/about/articles/x?utm_source=openai)) What state do you play in?",
    "…to protect your eligibility. What state do you play in?"],
  ["Benchmarks vary widely. ([later.com](https://later.com/blog/p/?utm_source=openai))\n\nI'd keep usage rights outside.",
    "Benchmarks vary widely.\n\nI'd keep usage rights outside."],
  ["Two sources agree ([a.org](https://a.org/1), [b.com](https://b.com/2)).", "Two sources agree."],
  ["See (https://x.org/guide) for the rules.", "See for the rules."],
  ["Read [the guide](https://x.org/g) first.", "Read the guide first."],
  // Untouched.
  ["Post twice a week (three if a match lands) and keep it short.", "Post twice a week (three if a match lands) and keep it short."],
  ["Your options [A or B] are both fine.", "Your options [A or B] are both fine."],
  ["A range (as an estimate): $300–$800.", "A range (as an estimate): $300–$800."],
  ["Open with (h)ighlights.", "Open with (h)ighlights."],
];

test.each(CASES)("whole text: %s", (input, want) => {
  expect(stripInlineCitations(input)).toBe(want);
});

test.each(CASES)("streamed in every chunk size, the same result: %s", (input, want) => {
  for (const size of [1, 2, 3, 5, 8, 13, 50, 1000]) {
    let got = "";
    const f = createCitationFilter((s) => { got += s; });
    for (let i = 0; i < input.length; i += size) f.push(input.slice(i, i + size));
    f.flush();
    expect([size, got]).toEqual([size, want]);
  }
});

test("a citation is never streamed then taken back: no emitted chunk contains a URL", () => {
  const chunks: string[] = [];
  const f = createCitationFilter((s) => chunks.push(s));
  for (const ch of "Done. ([site.org](https://site.org/a)) Next?") f.push(ch);
  f.flush();
  expect(chunks.join("")).toBe("Done. Next?");
  expect(chunks.some((c) => /https?:|site\.org/.test(c))).toBe(false);
});
