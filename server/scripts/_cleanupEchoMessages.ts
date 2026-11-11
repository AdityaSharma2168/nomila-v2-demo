/**
 * _cleanupEchoMessages.ts — one-time repair for the mirror-message data
 * (docs/plans/inbox-thread-fidelity.md, Phase 1).
 *
 * What it does, in order:
 *   1. Finds phantom INBOUND rows that are echoes of the athlete's own sends:
 *      a. Message-ID match — same gmail_message_id_header as an outbound row
 *         for the same athlete;
 *      b. body twins — identical trimmed body as an outbound row in the same
 *         thread (echoes ingested before the send's Message-ID was recorded).
 *   2. Deletes them (--apply), then backfills the surviving outbound twin with
 *      the ids the phantom carried (Message-ID / external id / gmail thread id)
 *      so the echo gate catches any future redelivery.
 *   3. Recounts message_count from the actual rows for every drifted thread.
 *   4. Re-derives awaiting_response_from / last_contact mechanically for every
 *      thread whose stored turn contradicts its last message (no LLM calls).
 *
 * DRY-RUN by default — prints what it would do and touches nothing.
 *
 *   npx tsx --require dotenv/config server/scripts/_cleanupEchoMessages.ts
 *   npx tsx --require dotenv/config server/scripts/_cleanupEchoMessages.ts --apply
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { refuseUnderZeroRetention } from "./privacy/storedContentGuard";
import { db, pool } from "../db";
import { inboxMessages } from "../../shared/schema";
import { updateMechanicalThreadState } from "../skills/threadSummarizer";

const APPLY = process.argv.includes("--apply");

interface PhantomRow {
  id: string;
  thread_id: string;
  subject: string | null;
  received_at: Date | null;
  body: string | null;
  gmail_message_id_header: string | null;
  external_message_id: string | null;
  gmail_thread_id: string | null;
  via: string;
}

async function main() {
  refuseUnderZeroRetention("_cleanupEchoMessages");
  console.log(APPLY ? "APPLY mode — changes will be written.\n" : "DRY-RUN — nothing will be written. Pass --apply to execute.\n");

  // ── 1. Collect phantoms ────────────────────────────────────────────────────
  const { rows: phantoms } = (await db.execute(sql`
    SELECT i.id, i.thread_id, t.subject, i.received_at, i.body,
           i.gmail_message_id_header, i.external_message_id, i.gmail_thread_id,
           CASE WHEN EXISTS (
             SELECT 1 FROM inbox_messages o
             WHERE o.direction = 'outbound' AND o.athlete_id = i.athlete_id
               AND o.gmail_message_id_header = i.gmail_message_id_header AND o.id <> i.id
           ) THEN 'message-id' ELSE 'body-twin' END AS via
    FROM inbox_messages i
    JOIN inbox_threads t ON t.id = i.thread_id
    WHERE i.direction = 'inbound'
      AND (
        (i.gmail_message_id_header IS NOT NULL AND EXISTS (
          SELECT 1 FROM inbox_messages o
          WHERE o.direction = 'outbound' AND o.athlete_id = i.athlete_id
            AND o.gmail_message_id_header = i.gmail_message_id_header AND o.id <> i.id))
        OR EXISTS (
          SELECT 1 FROM inbox_messages o
          WHERE o.direction = 'outbound' AND o.thread_id = i.thread_id AND o.id <> i.id
            AND length(btrim(i.body)) > 20 AND btrim(o.body) = btrim(i.body))
      )
    ORDER BY i.received_at
  `)) as unknown as { rows: PhantomRow[] };

  console.log(`Phantom inbound echoes found: ${phantoms.length}`);
  for (const p of phantoms) {
    const head = (p.body ?? "").replace(/\s+/g, " ").slice(0, 56);
    console.log(`  [${p.via}] ${String(p.received_at).slice(0, 10)}  "${p.subject?.slice(0, 32)}"  ${head}`);
  }

  const affectedThreadIds = [...new Set(phantoms.map((p) => p.thread_id))];

  // ── 2. Delete phantoms, then heal the surviving outbound twins ────────────
  if (APPLY && phantoms.length > 0) {
    await db.delete(inboxMessages).where(inArray(inboxMessages.id, phantoms.map((p) => p.id)));
    console.log(`\nDeleted ${phantoms.length} phantom rows.`);

    let healed = 0;
    for (const p of phantoms) {
      if (!p.body) continue;
      const [twin] = await db
        .select()
        .from(inboxMessages)
        .where(and(
          eq(inboxMessages.thread_id, p.thread_id),
          eq(inboxMessages.direction, "outbound"),
          sql`btrim(${inboxMessages.body}) = ${p.body.trim()}`,
        ))
        .limit(1);
      if (!twin) continue;

      const patch: Record<string, unknown> = {};
      if (!twin.gmail_message_id_header && p.gmail_message_id_header) patch.gmail_message_id_header = p.gmail_message_id_header;
      if (!twin.external_message_id && p.external_message_id)         patch.external_message_id     = p.external_message_id;
      if (!twin.gmail_thread_id && p.gmail_thread_id)                 patch.gmail_thread_id         = p.gmail_thread_id;
      if (Object.keys(patch).length > 0) {
        await db.update(inboxMessages).set(patch).where(eq(inboxMessages.id, twin.id));
        healed++;
      }
    }
    console.log(`Backfilled ids onto ${healed} outbound twins.`);
  }

  // ── 3. Recount message_count where it drifted ─────────────────────────────
  const { rows: drift } = (await db.execute(sql`
    SELECT t.id, t.message_count, COUNT(m.id)::int AS actual
    FROM inbox_threads t LEFT JOIN inbox_messages m ON m.thread_id = t.id
    GROUP BY t.id, t.message_count
    HAVING t.message_count IS DISTINCT FROM COUNT(m.id)::int
  `)) as unknown as { rows: Array<{ id: string; message_count: number | null; actual: number }> };

  console.log(`\nThreads with drifted message_count: ${drift.length}`);
  if (APPLY && drift.length > 0) {
    await db.execute(sql`
      UPDATE inbox_threads t SET message_count = c.actual
      FROM (SELECT thread_id, COUNT(*)::int AS actual FROM inbox_messages GROUP BY thread_id) c
      WHERE c.thread_id = t.id AND t.message_count IS DISTINCT FROM c.actual
    `);
    await db.execute(sql`
      UPDATE inbox_threads t SET message_count = 0
      WHERE NOT EXISTS (SELECT 1 FROM inbox_messages m WHERE m.thread_id = t.id)
        AND t.message_count IS DISTINCT FROM 0
    `);
    console.log("Recounted from actual rows.");
  }

  // ── 4. Heal turn state where it contradicts the last message ──────────────
  const { rows: staleTurns } = (await db.execute(sql`
    WITH last AS (
      SELECT DISTINCT ON (thread_id) thread_id, direction
      FROM inbox_messages ORDER BY thread_id, received_at DESC
    )
    SELECT t.id FROM inbox_threads t JOIN last l ON l.thread_id = t.id
    WHERE t.conversation_state IS NOT NULL
      AND t.conversation_state->'key_details'->>'awaiting_response_from' IS DISTINCT FROM
          (CASE WHEN l.direction = 'outbound' THEN 'brand' ELSE 'athlete' END)
  `)) as unknown as { rows: Array<{ id: string }> };

  const toHeal = [...new Set([...staleTurns.map((r) => r.id), ...(APPLY ? affectedThreadIds : [])])];
  console.log(`\nThreads with stale turn state: ${staleTurns.length}`);
  if (APPLY && toHeal.length > 0) {
    let ok = 0;
    for (const id of toHeal) {
      try {
        await updateMechanicalThreadState(id);
        ok++;
      } catch (err: any) {
        console.error(`  ✗ ${id}: ${err.message}`);
      }
    }
    console.log(`Mechanically re-derived turn state on ${ok} threads (no LLM).`);
  }

  console.log(APPLY ? "\nDone." : "\nDry-run complete. Re-run with --apply to execute.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
