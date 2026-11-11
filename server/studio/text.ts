/**
 * studio/text — SEMANTIC caps for model-filled fields (PR 7, Adi's walk, 23 Sep 2026).
 *
 * A model-filled field that a screen renders needs a cap at a WORD, never at a byte: a bare `slice` on
 * model text is a display bug waiting for realistic input — the concept step's angle came back as
 * "rapid-fire iterative repetition (fits her 'fast paced' ask a" the first time a real brief fed it.
 * Prompt fencing (a corpus cut to a budget) and log truncation are not display and keep their bytes.
 *
 *   capWords(s, max)   whitespace collapsed; unchanged when it fits; otherwise cut at the last word
 *                      boundary before the cap (a head that ends exactly on a word keeps it), trailing
 *                      punctuation dropped. A quote cut this way is still a verbatim substring.
 *   capTitle(s, max)   for a title: an over-long one first loses a trailing parenthetical — a model's
 *                      justification, never the title — then capWords.
 *
 * ⚠️ MUTATION (text.test): `s.slice(0, max)` — "a cap lands on a word, never inside one" reds by name.
 */

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

export function capWords(s: string, max: number): string {
  const t = collapse(s);
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  // A head that ends exactly on a word keeps it; otherwise back up to the last space — unless that
  // would throw away more than half the room, in which case the head stands (one very long token).
  const onBoundary = /\s/.test(t.charAt(max));
  const lastSpace = head.lastIndexOf(" ");
  const atWord =
    onBoundary || lastSpace <= max / 2 ? head : head.slice(0, lastSpace);
  return atWord.replace(/[\s,;:—–-]+$/, "").trim() || head.trim();
}

export function capTitle(s: string, max: number): string {
  const t = collapse(s);
  if (t.length <= max) return t;
  const withoutAside = t.replace(/\s*\([^)]*\)?\s*$/, "").trim();
  return capWords(withoutAside || t, max);
}
