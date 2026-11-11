/**
 * modelView.ts — what a model may see of a tool result.
 *
 * Opportunities PR 1, owner decision (5 Oct 2026): Mila stops quoting deal scores NOW. The 1–10
 * per-thread score and its verdict word are retired as something any model reasons over or says
 * — chat (get_deal / list_deals) and voice (the deal routes and the deal brief) alike. Everything
 * else the deal tools return is kept.
 *
 * The in-app chat deal card still renders from the RAW result: its score ring is a screen, and the
 * screens PR removes it. So the strip happens at the model boundary, not in the query.
 */

import type { MilaTool } from "../types";

/** The retired per-thread score fields, as the deal tools name them. */
export const RETIRED_DEAL_SCORE_KEYS = ["verdict", "score_numeric"] as const;

/** One deal row without the retired score. Non-objects pass through. */
export function withoutDealScore<T>(row: T): T {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of RETIRED_DEAL_SCORE_KEYS) delete out[k];
  return out as T;
}

/** The tool's model view of a result, or the result itself when the tool declares none. */
export function modelViewOf(tool: Pick<MilaTool, "modelView"> | undefined, result: unknown): unknown {
  return tool?.modelView ? tool.modelView(result) : result;
}
