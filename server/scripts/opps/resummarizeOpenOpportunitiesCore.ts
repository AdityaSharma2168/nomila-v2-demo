/**
 * resummarizeOpenOpportunitiesCore — which threads sit behind an OPEN opportunity, and a check for
 * third-person phrasing in a conversation_state.
 *
 * "Open" is the board's own definition (services/opportunityBoard.readOpportunityBoard): an
 * opportunities row with status = 'open', its member deals (deals.opportunity_id, same athlete),
 * and every inbox thread on those deals (inbox_threads.deal_id). Across every athlete; nothing here
 * writes or calls a model.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";

export interface OpenOpportunityThread {
  athlete_id: string;
  athlete_name: string | null;
  athlete_first_name: string | null;
  opportunity_id: string;
  brand_name: string | null;
  deal_id: string;
  thread_id: string;
  message_count: number;
  /** The one-line read currently on the thread (conversation_state.conversation_state). */
  current_state: string | null;
}

export async function selectOpenOpportunityThreads(dbx: any = db): Promise<OpenOpportunityThread[]> {
  const res = await dbx.execute(sql`
    SELECT o.athlete_id,
           a.full_name   AS athlete_name,
           a.first_name  AS athlete_first_name,
           o.id          AS opportunity_id,
           COALESCE(b.name, d.brand_name) AS brand_name,
           d.id          AS deal_id,
           t.id          AS thread_id,
           COALESCE(t.message_count, 0)::int AS message_count,
           t.conversation_state->>'conversation_state' AS current_state
      FROM opportunities o
      JOIN athletes a       ON a.id = o.athlete_id
      LEFT JOIN inbox_brands b ON b.id = o.brand_id
      JOIN deals d          ON d.opportunity_id = o.id AND d.athlete_id = o.athlete_id
      JOIN inbox_threads t  ON t.deal_id = d.id
     WHERE o.status = 'open'
     ORDER BY o.athlete_id, o.last_activity_at DESC, t.id`);
  return ((res as any).rows ?? res) as OpenOpportunityThread[];
}

/** Third-person references to the athlete left in a summary line ("the athlete", "athlete's", her name). */
export function thirdPersonHits(text: string | null | undefined, names: Array<string | null | undefined>): string[] {
  if (!text) return [];
  const hits: string[] = [];
  if (/\bthe athlete\b/i.test(text)) hits.push("the athlete");
  if (/\bathlete['’]s\b/i.test(text)) hits.push("athlete's");
  const tokens = new Set<string>();
  for (const n of names) for (const part of (n ?? "").split(/\s+/)) if (part.length >= 2) tokens.add(part);
  for (const tok of tokens) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${esc}\\b`, "i").test(text)) hits.push(tok);
  }
  return hits;
}
