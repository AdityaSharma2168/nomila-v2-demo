/**
 * brandMatch.fixtures — ONE table both sides of the brand-name rule are pinned to (PR 7, Lane E).
 *
 * The server's `brandNamesMatch` (services/mediaSearch.ts, the v1 rule) and the client's copy
 * (client/screens/studio/directionLogic.ts) are the same pure function written twice — a client
 * cannot import the server's module. Each side's test runs this table, so if either copy drifts,
 * one of them reds by name. Plain data, no imports.
 */
export const BRAND_MATCH_FIXTURES: readonly {
  a: string;
  b: string;
  match: boolean;
  why: string;
}[] = [
  { a: "Nike", b: "nike", match: true, why: "case-insensitive" },
  { a: "NIKE", b: "Nike", match: true, why: "case-insensitive" },
  {
    a: "adidas",
    b: "Adidas Originals",
    match: true,
    why: "a sub-label / variant of the same brand",
  },
  { a: "Adidas Originals", b: "adidas", match: true, why: "either direction" },
  {
    a: "Nike, Inc.",
    b: "nike inc",
    match: true,
    why: "punctuation and whitespace fold",
  },
  { a: "Nike", b: "adidas", match: false, why: "unrelated" },
  { a: "Northwind Apparel", b: "Southgale", match: false, why: "unrelated" },
  { a: "", b: "Nike", match: false, why: "an empty side never matches" },
  { a: "Nike", b: "", match: false, why: "an empty side never matches" },
  {
    a: "On",
    b: "Onitsuka Tiger",
    match: false,
    why: "under three characters is never a substring match",
  },
  {
    a: "GO",
    b: "go",
    match: true,
    why: "under three characters still matches exactly",
  },
];
