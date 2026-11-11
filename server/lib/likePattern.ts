/**
 * likePattern.ts — user input inside a LIKE / ILIKE pattern must match literally: `%`, `_` and the escape character
 * itself are escaped (Postgres' default LIKE escape is the backslash).
 */

/** Escapes LIKE / ILIKE wildcards (`%`, `_`) and the backslash, so user input matches literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `%<input>%` with the input escaped: a literal substring match. */
export function containsPattern(input: string): string {
  return `%${escapeLike(input)}%`;
}
