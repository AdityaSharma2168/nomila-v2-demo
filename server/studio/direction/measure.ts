/**
 * studio/direction/measure — the distinctness measure the route runner has used since 6c
 * (server/scripts/studioPlanRoute.ts), lifted so the PRODUCT applies it too: pairwise word overlap of
 * two lines, |A∩B| / |A∪B| over words of four letters or more with a short stop list removed. The
 * pre-registered bar is < 0.5; propose_campaign drops the later of two proposals at or over it.
 */
const STOP = new Set([
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "their",
  "them",
  "they",
  "then",
  "than",
  "what",
  "when",
  "each",
  "just",
  "over",
  "about",
  "before",
  "after",
  "every",
  "while",
  "being",
]);

export const words = (t: string): Set<string> =>
  new Set(
    (t.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !STOP.has(w)),
  );

/** Pairwise word overlap of two lines — |A∩B| / |A∪B|. The pre-registered distinctness bar is < 0.5. */
export const jaccard = (a: string, b: string): number => {
  const x = words(a);
  const y = words(b);
  const inter = [...x].filter((w) => y.has(w)).length;
  const union = new Set([...x, ...y]).size;
  return union ? inter / union : 0;
};

export const DISTINCT_BELOW = 0.5;
