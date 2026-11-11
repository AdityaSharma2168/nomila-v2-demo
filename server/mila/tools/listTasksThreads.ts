/**
 * listTasksThreads.ts — Mila read tool: "what needs my attention?"
 *
 * An athlete-scoped count plus the top few:
 *   · unread threads — `inbox_threads` in status 'unread'
 * (The v1 `tasks` half — open background jobs — went with the table in 0089; the workflow runner
 * replaced it and nothing wrote tasks any more. The tool keeps its name so prompts, evals and chips
 * that know it still resolve.)
 * Thread subjects are email-derived (attacker-controlled) and wrapped in
 * <external_content>. Brand names come from the global `inbox_brands` reference
 * table (not athlete data) and are left as-is, matching list_deals' brand_name.
 */

import { z } from "zod";
// Wraps external text as data the model must never obey, with any smuggled delimiter neutralised.
import { external } from "../../lib/externalContent";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { inboxThreads, inboxBrands } from "../../../shared/schema";
import { MILA } from "../config";
import type { MilaTool } from "../types";
import { mailboxZeroRetentionEnabled } from "../../lib/mailbox/retention";
import { derivedThreadTitle } from "../../lib/threadTitle";

const TOP_N = 5;


export const listTasksThreadsTool: MilaTool<
  z.ZodObject<Record<string, never>>
> = {
  name: "list_tasks_threads",
  description:
    "Get what needs the athlete's attention right now: a count of unread inbox " +
    "threads from brands (and the top few, newest first). The count is zero " +
    "when there's nothing pending.",
  argsSchema: z.object({}),
  async execute(athleteId, _args) {
    const unreadThreads = await db
      .select({
        // Zero retention: no stored subject is read; a Nomila-written title stands in.
        subject: mailboxZeroRetentionEnabled() ? sql<string | null>`NULL` : inboxThreads.subject,
        classification: inboxThreads.classification,
        brand_name: inboxBrands.name,
        last_message_at: inboxThreads.last_message_at,
      })
      .from(inboxThreads)
      .leftJoin(inboxBrands, eq(inboxBrands.id, inboxThreads.brand_id))
      .where(
        and(
          eq(inboxThreads.athlete_id, athleteId),
          eq(inboxThreads.status, "unread"),
        ),
      )
      .orderBy(desc(inboxThreads.last_message_at))
      .limit(100);

    const result = {
      unread_threads: {
        count: unreadThreads.length,
        items: unreadThreads.slice(0, TOP_N).map((t) => ({
          subject: external(
            mailboxZeroRetentionEnabled()
              ? derivedThreadTitle({ brandName: t.brand_name, classification: t.classification })
              : t.subject,
          ),
          brand_name: t.brand_name,
          last_message_at: t.last_message_at,
        })),
      },
    };

    // Budget guard: trim the item previews (never the counts) until under.
    while (
      JSON.stringify(result).length > MILA.TOOL_RESULT_MAX_CHARS &&
      result.unread_threads.items.length > 0
    ) {
      result.unread_threads.items.pop();
    }
    return result;
  },
};
