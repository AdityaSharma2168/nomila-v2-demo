/**
 * restoreMessageDatesCore.ts — put back the dates a re-process or a split moved (Bug: one brand's deals all read
 * "Oct 8" though the paperwork was signed in August and the conversation began in July).
 *
 * Two stored dates drifted away from the mail they summarise:
 *   · inbox_threads.last_message_at — ingest stamped the PROCESSING time, not the message's own date, so a
 *     backfill / re-process / late delivery of an old message read as activity on the day it ran;
 *   · opportunities.last_activity_at — a split moved a chain (and its newest messages) to a new thread, and the
 *     thread and opportunity left behind kept the moved chain's newest date.
 * Ingest and split are fixed in code (skills/dealDetector advanceLastMessageAt, skills/dealSplit resync*); this
 * restores rows written before the fix, for every selected athlete, from the messages' own dates:
 *   thread.last_message_at       := newest message on the thread now
 *   opportunity.last_activity_at := newest message across its deals' threads and their paperwork / meeting threads
 * A row is changed only when it is more than a minute off (ingest lag is seconds) and it holds at least one message.
 *
 * Reads and writes dates and ids only — never message content. planRestore only SELECTs (the CLI also opens a
 * read-only session for the dry run); applyRestore plans and writes in ONE transaction per athlete. The plan JSON
 * carries every old value: the rollback record.
 */
import { sql } from "drizzle-orm";
import { opportunityLastMessageAt, resyncOpportunityActivity, resyncThreadLastMessage, threadLastMessageAt } from "../../skills/opportunities";

/** Drift tolerated before a row counts as wrong: ingest lag is seconds; a re-process is hours to months. */
export const TOLERANCE_SECONDS = 60;

export interface DateFix { id: string; stored: string | null; actual: string }
export interface RestorePlan {
  athlete_id: string;
  generated_at: string;
  threads: DateFix[];
  opportunities: DateFix[];
  /** Deals whose own thread or whose opportunity is in the plan: what the screens showed with a wrong date. */
  deal_ids: string[];
  counts: { threads: number; opportunities: number; deals: number };
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as any).toISOString());
const rowsOf = (r: any): any[] => r?.rows ?? r ?? [];

export async function planRestore(dbx: any, athleteId: string, now: Date = new Date()): Promise<RestorePlan> {
  const threads = rowsOf(await dbx.execute(sql`
    SELECT x.id, x.stored, x.actual FROM (
      SELECT t.id, t.last_message_at AS stored, ${threadLastMessageAt(sql`t.id`)} AS actual
        FROM inbox_threads t WHERE t.athlete_id = ${athleteId}) x
     WHERE x.actual IS NOT NULL
       AND (x.stored IS NULL OR abs(extract(epoch FROM (x.stored - x.actual))) > ${TOLERANCE_SECONDS})
     ORDER BY x.id`)).map((r) => ({ id: String(r.id), stored: iso(r.stored), actual: iso(r.actual)! }));

  const opps = rowsOf(await dbx.execute(sql`
    SELECT x.id, x.stored, x.actual FROM (
      SELECT o.id, o.last_activity_at AS stored, ${opportunityLastMessageAt(sql`o.id`)} AS actual
        FROM opportunities o WHERE o.athlete_id = ${athleteId}) x
     WHERE x.actual IS NOT NULL
       AND (x.stored IS NULL OR abs(extract(epoch FROM (x.stored - x.actual))) > ${TOLERANCE_SECONDS})
     ORDER BY x.id`)).map((r) => ({ id: String(r.id), stored: iso(r.stored), actual: iso(r.actual)! }));

  const threadIds = threads.map((t) => t.id);
  const oppIds = opps.map((o) => o.id);
  const dealIds = threadIds.length || oppIds.length
    ? rowsOf(await dbx.execute(sql`
        SELECT DISTINCT d.id FROM deals d
         WHERE d.athlete_id = ${athleteId}
           AND (d.id IN (SELECT t.deal_id FROM inbox_threads t WHERE t.athlete_id = ${athleteId} AND t.deal_id IS NOT NULL
                          AND t.id::text = ANY(${`{${threadIds.join(",")}}`}::text[]))
                OR d.opportunity_id::text = ANY(${`{${oppIds.join(",")}}`}::text[]))
         ORDER BY d.id`)).map((r) => String(r.id))
    : [];

  return {
    athlete_id: athleteId,
    generated_at: now.toISOString(),
    threads,
    opportunities: opps,
    deal_ids: dealIds,
    counts: { threads: threads.length, opportunities: opps.length, deals: dealIds.length },
  };
}

/** Plan and write in ONE transaction for this athlete; each row is recomputed from its messages inside it. */
export async function applyRestore(dbx: any, athleteId: string, now: Date = new Date()): Promise<RestorePlan> {
  return dbx.transaction(async (tx: any) => {
    const plan = await planRestore(tx, athleteId, now);
    for (const t of plan.threads) await resyncThreadLastMessage(tx, athleteId, t.id);
    for (const o of plan.opportunities) await resyncOpportunityActivity(tx, athleteId, o.id);
    return plan;
  });
}

export function renderMarkdown(plan: RestorePlan, mode: "dry-run" | "apply"): string {
  const line = (f: DateFix) => `- \`${f.id}\` ${f.stored ?? "—"} → ${f.actual}`;
  return [
    `# Restore message dates — ${mode} — athlete \`${plan.athlete_id}\``,
    "",
    `Generated ${plan.generated_at}. Deals showing a wrong date: **${plan.counts.deals}**.`,
    "",
    `## Threads (${plan.counts.threads}) — last_message_at`,
    ...plan.threads.map(line),
    "",
    `## Opportunities (${plan.counts.opportunities}) — last_activity_at`,
    ...plan.opportunities.map(line),
    "",
  ].join("\n");
}
