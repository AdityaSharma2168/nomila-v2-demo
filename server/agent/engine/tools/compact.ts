/**
 * agent/engine/tools/compact.ts (moved from agent/mcp/, 5 Nov 2026) — keep a tool result under the result budget (config.ts
 * TOOL_RESULT_MAX_CHARS_DEFAULT), and say so when it was cut. Every Mastra tool call's result goes through it.
 *
 * First written for TrueForge (retired 9 Nov 2026), which without a sandbox replaced a result over ~6,000 tokens with a
 * 100-character preview the model could do nothing with. So we cut first, in a way the model can act on:
 *   1. the longest top-level lists are shortened (halved, repeatedly) and `truncated` says which, how many are shown
 *      and how many there were, with a hint to narrow the request;
 *   2. if that is still too long (one huge text), the JSON is clipped with a marker, as the harness does.
 * A result already under budget is returned unchanged.
 */

export const TRUNCATION_HINT = "Shortened to fit. Ask again with a narrower request (a filter, a smaller limit, or the next page) to see the rest.";

export function compactJson(result: Record<string, unknown>, maxChars: number): string {
  let json = JSON.stringify(result);
  if (json.length <= maxChars) return json;

  const out: Record<string, unknown> = { ...result };
  const totals: Record<string, number> = {};
  const lists = () => Object.entries(out).filter(([, v]) => Array.isArray(v) && (v as unknown[]).length > 1) as Array<[string, unknown[]]>;
  const withNote = () => {
    const shown = Object.fromEntries(Object.entries(totals).map(([k, total]) => [k, { shown: (out[k] as unknown[]).length, total }]));
    return Object.keys(shown).length ? { ...out, truncated: { ...shown, hint: TRUNCATION_HINT } } : out;
  };

  for (let guard = 0; guard < 64; guard++) {
    const candidates = lists();
    if (!candidates.length) break;
    // The list contributing the most characters is shortened first.
    const [key, arr] = candidates.sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length)[0];
    totals[key] ??= arr.length;
    out[key] = arr.slice(0, Math.max(1, Math.floor(arr.length / 2)));
    json = JSON.stringify(withNote());
    if (json.length <= maxChars) return json;
  }
  json = JSON.stringify(withNote());
  if (json.length <= maxChars) return json;
  const marker = `… [truncated: ${TRUNCATION_HINT}]`;
  return `${json.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}
