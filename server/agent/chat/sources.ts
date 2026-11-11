/**
 * agent/chat/sources.ts — what a chat turn reads and writes outside the AgentStore port, as one seam (ChatSources).
 *
 *   mia · connected · openThreads · preferences   the plan's sources (plan/sources.ts), reused as they are
 *   pendingTaps        the athlete's agent_action items still waiting for a tap (WAITING FOR YOUR TAP)
 *   recentSummaries    the rolling summaries of the athlete's most recent OTHER conversations
 *   scouting           the Scouting report (scouting/1), no model call
 *   addPreference      a preference the athlete confirmed (remember_preference, on the tap)
 *   correctFact        the athlete's correction (correct_fact, on the tap): the same path as PATCH /me/facts/:id —
 *                      a new said fact supersedes the old one, the review is recorded, and what used it re-runs
 *
 * dbChatSources is the app's; a test can pass an in-memory one. Every query is scoped to the
 * athlete; nothing here takes an athlete id from a model.
 */
import { and, desc, eq, gt, isNotNull, ne, or, isNull } from "drizzle-orm";
import { db } from "../../db";
import { conversations, pendingActions } from "../../../shared/schema";
import type { PreferenceKind } from "../../../shared/agent";
import type { ScoutingResponse } from "../../../shared/meScouting";
import { addPreference } from "../memory";
import { AGENT_ACTION_KIND } from "../approvals";
import { dbPlanSources } from "../plan/sources";
import type { PlanSources } from "../plan/input";

export interface ChatSources extends PlanSources {
  pendingTaps(athleteId: string): Promise<Array<{ title: string; verb: string }>>;
  recentSummaries(athleteId: string, excludeConversationId: string | null): Promise<string[]>;
  scouting(athleteId: string): Promise<ScoutingResponse>;
  addPreference(athleteId: string, p: { kind: PreferenceKind; statement: string }, runId: string | null): Promise<{ id: string }>;
  correctFact(athleteId: string, factId: string, c: { claim: string; date: string | null }): Promise<{ id: string }>;
}

async function pendingTaps(athleteId: string): Promise<Array<{ title: string; verb: string }>> {
  const rows = await db.select({ payload: pendingActions.payload }).from(pendingActions)
    .where(and(
      eq(pendingActions.athlete_id, athleteId), eq(pendingActions.kind, AGENT_ACTION_KIND), eq(pendingActions.status, "pending"),
      or(isNull(pendingActions.expires_at), gt(pendingActions.expires_at, new Date())),
    ))
    .orderBy(desc(pendingActions.created_at)).limit(10);
  return rows.map((r) => {
    const p = (r.payload ?? {}) as { title?: unknown; verb?: unknown };
    return { title: String(p.title ?? "Waiting for your tap"), verb: String(p.verb ?? "other_act") };
  });
}

async function recentSummaries(athleteId: string, excludeConversationId: string | null): Promise<string[]> {
  const rows = await db.select({ summary: conversations.summary }).from(conversations)
    .where(and(
      eq(conversations.athlete_id, athleteId), isNotNull(conversations.summary),
      ...(excludeConversationId ? [ne(conversations.id, excludeConversationId)] : []),
    ))
    .orderBy(desc(conversations.updated_at)).limit(2);
  return rows.map((r) => r.summary ?? "").filter(Boolean);
}

export const dbChatSources: ChatSources = {
  ...dbPlanSources,
  pendingTaps,
  recentSummaries,
  async scouting(athleteId) {
    const { getScoutingReport } = await import("../../services/meScouting");
    return getScoutingReport(athleteId);
  },
  async addPreference(athleteId, p, runId) {
    const row = await addPreference(athleteId, { kind: p.kind, statement: p.statement, source: "said" }, runId);
    return { id: row.id };
  },
  async correctFact(athleteId, factId, c) {
    const { correctFact } = await import("../../services/meKnows");
    const r = await correctFact(athleteId, factId, { claim: c.claim, ...(c.date ? { date: c.date } : {}) });
    return { id: r.fact.id };
  },
};
