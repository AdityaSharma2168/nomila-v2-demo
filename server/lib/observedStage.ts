/**
 * observedStage.ts — the summarizer's read of a deal's stage, kept as an OBSERVATION.
 *
 * threadSummarizer writes `conversation_state.deal_stage` (outreach | negotiating | agreed |
 * signed | declined) on every message. It used to promote that read straight into
 * deals.status; it no longer does — a model's read of a thread is not commercial state.
 * Status changes only through governed paths (her actions, an approved pending action, a
 * contract she saves, the explicit routes).
 *
 * What remains is this: places that PROTECT a deal (keep it in the Brief's live set, keep it out
 * of an automatic filing, count it as worked when matching paperwork) read max(status, observed)
 * through effectiveDealStatus. The stage SHOWN to her (board, cards, Home, brand page, deals list)
 * is deals.status alone and never this read (owner, 22 Oct 2026); so is every place that COMMITS
 * (earned deals, scoring, payments, the status column itself).
 */

import { sql, type SQL } from "drizzle-orm";

/** Forward order of the live deal statuses. `rejected` and unknown values are off the ladder. */
export const DEAL_STATUS_RANK: Record<string, number> = {
  detected: 0, pending: 1, negotiating: 2, accepted: 3, completed: 4,
};

/** The summarizer's stages that read as a deal status. `outreach` and `declined` read as none. */
const STAGE_STATUS: Record<string, string> = {
  negotiating: "negotiating",
  agreed:      "negotiating",
  signed:      "accepted",
};

const STAGES = new Set(["outreach", "negotiating", "agreed", "signed", "declined"]);

/** The raw deal_stage from a thread's conversation_state, or null when absent/unknown. */
export function observedStageOf(conversationState: unknown): string | null {
  const s = (conversationState as { deal_stage?: unknown } | null | undefined)?.deal_stage;
  return typeof s === "string" && STAGES.has(s) ? s : null;
}

/** The observed stage in deals.status vocabulary (negotiating | accepted), or null. */
export function observedStatusOf(conversationState: unknown): string | null {
  const stage = observedStageOf(conversationState);
  return stage ? STAGE_STATUS[stage] ?? null : null;
}

/**
 * max(status, observed) — for PROTECTION only: never shown as her stage, never for a write. Forward-only and
 * never off a terminal or unknown status (rejected stays rejected), the same rule the old
 * auto-advance used.
 */
export function effectiveDealStatus(status: string | null | undefined, conversationState: unknown): string | null {
  const cur = status ?? null;
  const observed = observedStatusOf(conversationState);
  if (!observed || cur == null) return cur;
  const c = DEAL_STATUS_RANK[cur];
  if (c == null) return cur;
  return DEAL_STATUS_RANK[observed] > c ? observed : cur;
}

/** SQL: true when a thread's conversation_state reads as being worked (negotiating or later). */
export function observedWorkedSql(conversationState: unknown): SQL {
  return sql`coalesce(${conversationState} ->> 'deal_stage', '') in ('negotiating', 'agreed', 'signed')`;
}
