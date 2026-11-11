/**
 * agent/deals/numbers.ts — "only numbers she said". A reply's term asks may carry a number only when the athlete said
 * that number in this conversation (her own messages, never a tool result, an email or Mila's text). That is how a
 * brand email can never put a figure — her floor included — into a draft: the model cannot invent the number, and the
 * floor never reaches the model as a number in the first place. Pure.
 */

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100,
};

/**
 * Every number a text states: "2k" → 2000, "$1,800" → 1800, "1.5k" → 1500, "3 months" → 3, "10%" → 10, "three" → 3.
 * Also the bare figure of a k-number ("2k" also yields 2), so "2k" covers a fee of 2000 and nothing smaller is invented.
 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand)?\b/gi;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    out.push(m[2] ? Math.round(n * 1000) : n);
  }
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) if (WORD_NUMBERS[w] != null) out.push(WORD_NUMBERS[w]);
  return out;
}

/** The numbers in a term ask that she never said. Empty = every number is hers. */
export function unsaidNumbers(asked: number[], herWords: readonly string[]): number[] {
  const said = new Set(herWords.flatMap(numbersIn));
  return asked.filter((n) => !said.has(n));
}
