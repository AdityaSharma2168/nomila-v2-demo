/**
 * studio/compile/text — the one piece of English the compile tier's sentences share.
 */

/** "a", "a and b", "a, b and c". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
