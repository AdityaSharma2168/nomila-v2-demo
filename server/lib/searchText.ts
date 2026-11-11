/**
 * lib/searchText.ts — the plain-words matching All deals and All bookings share (services/opportunitySearch,
 * services/bookings/search). Code only, never a model. No imports: both search services and their routes can use it
 * without pulling the other's layer in. (Its switch, DEALS_SEARCH, was retired on 2 Nov 2026: always on.)
 */

export const SEARCH_TABS = ["active", "done", "closed"] as const;

/** Rows one search returns: `?limit=` when it is a whole number, held to 1…SEARCH_LIMIT_MAX; else the default. */
export const SEARCH_LIMIT_DEFAULT = 50;
export const SEARCH_LIMIT_MAX = 200;
export function searchLimit(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? Math.min(n, SEARCH_LIMIT_MAX) : SEARCH_LIMIT_DEFAULT;
}
export type SearchTab = (typeof SEARCH_TABS)[number];

/** Lower-case, accents off, thousands commas out of numbers ("$1,200" → "$1200"), other punctuation to spaces. */
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/(\d),(?=\d{3})/g, "$1")
  .replace(/[^\p{L}\p{N}$]+/gu, " ").trim();

/** Every word of the query appears somewhere in the row's searchable text. Amounts match with or without $ and commas. */
export function matches(q: string, haystack: string): boolean {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const h = ` ${norm(haystack)} `;
  // A word matches inside the text ("gym" finds a brand starting with it); "$1200" and "1200" both find "$1,200".
  return words.every((w) => h.includes(w) || h.includes(w.replace(/^\$/, "")));
}

