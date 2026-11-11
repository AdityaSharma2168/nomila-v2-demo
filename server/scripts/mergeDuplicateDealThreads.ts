/**
 * mergeDuplicateDealThreads.ts — fold cross-mailbox duplicate deal cards into one.
 *
 * WHY THIS EXISTS: a Gmail threadId is scoped to ONE mailbox. The same pitch delivered to
 * athlete@gmail.com and athlete@her-own-domain.com arrives with two different
 * external_thread_ids, so we used to mint two deal cards for one conversation. PR #151
 * fixed that going forward — every Message-ID echo now registers the arriving thread id
 * in classification.alias_thread_ids (server/lib/threadAliases.ts) — but it never merged
 * the cards already created. As of 2026-08-09 prod has 22 same-brand/same-subject groups,
 * of which exactly ONE is a provable cross-mailbox split (gorjana, athlete@gmail.com vs
 * athlete@her-own-domain.com). The rest are re-sends or unprovable — see the buckets below.
 *
 * WHAT COUNTS AS A DUPLICATE: same athlete, same brand_id, same subject after stripping
 * Re:/Fwd: prefixes, and more than one deal_id. That set contains two different things:
 *
 *   CROSS_MAILBOX — the threads sit in two different mailbox ADDRESSES. One real
 *                   conversation, split by Gmail's per-mailbox threading. Merge these.
 *   RESEND        — same address, weeks apart. A brand that pitched twice. Two genuine
 *                   deals; merging them would destroy real history. Reported, never merged.
 *   UNKNOWN       — at least one thread predates connected_account_id being recorded
 *                   (127 of 265 prod threads). We cannot prove which mailbox it came from,
 *                   so we do not guess. Reported, never merged.
 *
 * Mailbox identity is the ADDRESS (connected_accounts.platform_username), not the
 * connection row: athlete@her-own-domain.com and athlete@gmail.com each have two rows (an
 * active one and a revoked one), so keying on connected_account_id reported same-mailbox
 * resends as cross-mailbox duplicates.
 *
 * SAFETY: only CROSS_MAILBOX merges, and only when every losing deal is status
 * detected/pending with NO payments. Money never moves silently. (The v1 payment_offers
 * table this also counted was dropped by 0092.)
 * agent_actions and pending_actions DO move — they're bookkeeping that should follow the
 * surviving deal rather than block the merge or dangle on a deleted row.
 *
 *   npx tsx --require dotenv/config server/scripts/mergeDuplicateDealThreads.ts           # report
 *   APPLY=1 npx tsx --require dotenv/config server/scripts/mergeDuplicateDealThreads.ts   # merge
 */
import { db } from "../db";
import { refuseUnderZeroRetention } from "./privacy/storedContentGuard";
import { sql } from "drizzle-orm";

const APPLY = process.env.APPLY === "1" || process.env.APPLY === "true";

interface ThreadRow extends Record<string, unknown> {
  thread_id:            string;
  athlete_id:           string;
  brand_id:             number | null;
  nsubj:                string;
  subject:              string | null;
  external_thread_id:   string | null;
  connected_account_id: string | null;
  mailbox:              string | null;
  deal_id:              string;
  deal_status:          string | null;
  detected_at:          string | null;
  /** Money attached to this deal. Non-zero = never auto-merge. */
  money:                number;
  /** Bookkeeping rows that get repointed at the winner during a merge. */
  bookkeeping:          number;
}

/**
 * Pass 2 — collapse the same email appearing twice INSIDE one thread.
 *
 * Keyed on gmail_message_id_header (the RFC 2822 Message-ID), which is identical in every
 * mailbox that received the email. Two sources produce these: a cross-mailbox thread that
 * was merged, and an app-sent reply that the poller then re-ingested from the mailbox.
 * Either way the athlete sees the same email twice in "view full conversation".
 *
 * Survivor rule: an OUTBOUND row always beats an inbound one. A mixed-direction pair is
 * the app-sent echo, and keeping the inbound copy would re-create the "my own Gmail reply
 * renders as the brand" bug. Otherwise the earliest row wins.
 *
 * Only ever runs where the bodies are byte-identical — if two rows share a Message-ID but
 * differ in content, something else is wrong and a human should look.
 */
async function collapseDuplicateMessages(): Promise<void> {
  const dupes = await db.execute<{
    thread_id: string; hdr: string; copies: number; dirs: number; bodies: number;
  }>(sql`
    SELECT thread_id, gmail_message_id_header AS hdr, count(*)::int AS copies,
           count(DISTINCT direction)::int AS dirs,
           count(DISTINCT md5(coalesce(body,'')))::int AS bodies
    FROM inbox_messages
    WHERE gmail_message_id_header IS NOT NULL
    GROUP BY 1, 2
    HAVING count(*) > 1
  `);
  const groups = ((dupes as any).rows ?? dupes) as { thread_id: string; hdr: string; copies: number; dirs: number; bodies: number }[];

  if (!groups.length) {
    console.log("\n✅ No duplicated messages inside a thread.");
    return;
  }

  const divergent = groups.filter((g) => g.bodies > 1);
  const safe      = groups.filter((g) => g.bodies === 1);
  const extra     = safe.reduce((n, g) => n + (g.copies - 1), 0);

  console.log(
    `\nDUPLICATE MESSAGES — ${safe.length} group(s), ${extra} extra row(s) ` +
    `(${safe.filter((g) => g.dirs > 1).length} are app-sent echoes where the outbound copy wins).`,
  );
  if (divergent.length) {
    console.log(`  ⚠️  ${divergent.length} group(s) share a Message-ID but differ in body — skipped, look by hand.`);
  }
  if (!extra) return;

  if (!APPLY) {
    console.log("  Report only — re-run with APPLY=1 to collapse them.");
    return;
  }

  const removed = await db.execute<{ id: string }>(sql`
    DELETE FROM inbox_messages m
    USING (
      SELECT id,
             row_number() OVER (
               PARTITION BY thread_id, gmail_message_id_header
               -- outbound first, then oldest, then a stable id tiebreak
               ORDER BY (direction = 'outbound') DESC, received_at ASC, id ASC
             ) AS rn
      FROM inbox_messages
      WHERE gmail_message_id_header IS NOT NULL
        AND (thread_id, gmail_message_id_header) IN (
          SELECT thread_id, gmail_message_id_header
          FROM inbox_messages
          WHERE gmail_message_id_header IS NOT NULL
          GROUP BY 1, 2
          HAVING count(*) > 1 AND count(DISTINCT md5(coalesce(body,''))) = 1
        )
    ) ranked
    WHERE m.id = ranked.id AND ranked.rn > 1
    RETURNING m.id
  `);
  const n = ((removed as any).rows ?? removed).length;

  // Counters must follow the rows we just deleted.
  await db.execute(sql`
    UPDATE inbox_threads t
    SET message_count   = (SELECT count(*)          FROM inbox_messages m WHERE m.thread_id = t.id),
        last_message_at = (SELECT max(received_at)  FROM inbox_messages m WHERE m.thread_id = t.id)
    WHERE EXISTS (SELECT 1 FROM inbox_messages m WHERE m.thread_id = t.id)
  `);

  console.log(`  ✅ Removed ${n} duplicate message row(s).`);
}

async function main() {
  refuseUnderZeroRetention("mergeDuplicateDealThreads");
  // One row per deal-bearing thread, with everything the classification needs. The
  // encumbrance count is what decides whether a losing deal is safe to retire.
  const res = await db.execute<ThreadRow>(sql`
    SELECT
      t.id                                        AS thread_id,
      t.athlete_id,
      t.brand_id,
      regexp_replace(lower(coalesce(t.subject,'')), '^\\s*((re|fwd?|fw)\\s*:\\s*)+', '', 'g') AS nsubj,
      t.subject,
      t.external_thread_id,
      t.connected_account_id,
      ca.platform_username                        AS mailbox,
      t.deal_id,
      d.status                                    AS deal_status,
      d.detected_at,
      (SELECT count(*) FROM payments p WHERE p.deal_id = d.id)::int AS money,
      (
        (SELECT count(*) FROM agent_actions   a WHERE a.deal_id = d.id) +
        (SELECT count(*) FROM pending_actions n WHERE n.deal_id = d.id)
      )::int                                      AS bookkeeping
    FROM inbox_threads t
    JOIN deals d ON d.id = t.deal_id
    LEFT JOIN connected_accounts ca ON ca.id = t.connected_account_id
    WHERE t.deal_id IS NOT NULL
  `);
  const rows = ((res as any).rows ?? res) as ThreadRow[];

  // Group by (athlete, brand, normalised subject); keep only multi-deal groups.
  const groups = new Map<string, ThreadRow[]>();
  for (const r of rows) {
    const key = `${r.athlete_id}|${r.brand_id ?? "null"}|${r.nsubj}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const dupes = [...groups.values()].filter(
    (g) => new Set(g.map((r) => r.deal_id)).size > 1,
  );

  if (!dupes.length) {
    console.log("✅ No duplicate deal cards.");
    await collapseDuplicateMessages();
    return 0;
  }

  const mergeable: ThreadRow[][] = [];
  const resends:   ThreadRow[][] = [];
  const unknown:   ThreadRow[][] = [];
  const blocked:   ThreadRow[][] = [];

  for (const g of dupes) {
    // Winner = earliest detected. Everything else in the group loses.
    const ordered = [...g].sort(
      (a, b) => new Date(a.detected_at ?? 0).getTime() - new Date(b.detected_at ?? 0).getTime(),
    );

    // Identity is the ADDRESS. Any thread with no recorded mailbox makes the whole group
    // unprovable — a merge there would be a guess, and an unmergeable pair is a far
    // cheaper mistake than two real conversations collapsed into one.
    if (ordered.some((r) => !r.mailbox)) { unknown.push(ordered); continue; }

    const addresses = new Set(ordered.map((r) => r.mailbox!.toLowerCase()));
    if (addresses.size < 2) { resends.push(ordered); continue; }

    const losers = ordered.slice(1);
    const unsafe = losers.some(
      (r) => r.money > 0 || !["detected", "pending"].includes(r.deal_status ?? ""),
    );
    (unsafe ? blocked : mergeable).push(ordered);
  }

  const show = (label: string, gs: ThreadRow[][], note: string) => {
    if (!gs.length) return;
    console.log(`\n${label} — ${gs.length} group(s). ${note}`);
    for (const g of gs) {
      console.log(`  "${(g[0].subject ?? "").slice(0, 52)}"  brand=${g[0].brand_id}`);
      for (const [i, r] of g.entries()) {
        const when = r.detected_at ? new Date(r.detected_at).toISOString().slice(0, 10) : "?";
        const role = i === 0 ? "KEEP " : "merge";
        console.log(
          `    ${role} ${when}  deal=${r.deal_id.slice(0, 8)}  mailbox=${r.mailbox ?? "unrecorded"}` +
          `  status=${r.deal_status}` +
          `${r.money ? `  MONEY(${r.money})` : ""}${r.bookkeeping ? `  actions(${r.bookkeeping})` : ""}`,
        );
      }
    }
  };

  show("CROSS_MAILBOX (mergeable)", mergeable, "One conversation split across two addresses.");
  show("RESEND (left alone)", resends, "Same address — genuinely separate pitches, not duplicates.");
  show("UNKNOWN (left alone)", unknown, "A thread has no recorded mailbox; can't prove a duplicate.");
  show("BLOCKED", blocked, "A losing deal has money attached — merge by hand.");

  if (!mergeable.length) {
    console.log("\nNothing safe to merge.");
    await collapseDuplicateMessages();
    return 0;
  }
  if (!APPLY) {
    console.log("\nReport only — no rows changed. Re-run with APPLY=1 to merge CROSS_MAILBOX groups.");
    await collapseDuplicateMessages();
    return 0;
  }

  let merged = 0;
  for (const group of mergeable) {
    const [winner, ...losers] = group;
    await db.transaction(async (tx) => {
      for (const loser of losers) {
        // 1. Register the loser's Gmail thread id as an alias of the winner, so a future
        //    reply arriving on that mailbox resolves here instead of minting a new card.
        //    This is the same key findThreadByExternalId reads (lib/threadAliases.ts).
        if (loser.external_thread_id) {
          await tx.execute(sql`
            UPDATE inbox_threads
            SET classification = jsonb_set(
              coalesce(classification, '{}'::jsonb),
              '{alias_thread_ids}',
              (
                SELECT to_jsonb(array_agg(DISTINCT v))
                FROM unnest(
                  array(SELECT jsonb_array_elements_text(
                          coalesce(classification->'alias_thread_ids', '[]'::jsonb)))
                  || ARRAY[${loser.external_thread_id}::text]
                ) AS v
              ),
              true
            )
            WHERE id = ${winner.thread_id}
          `);
        }

        // 2. Drop the loser's copies of emails the winner already has.
        //
        //    Match on gmail_message_id_header — the RFC 2822 Message-ID, which is the
        //    SAME value in every mailbox that received the email. external_message_id is
        //    Gmail's per-mailbox id and therefore never matches across mailboxes, which
        //    is the whole reason these threads split in the first place; deduping on it
        //    let all 13 of the loser's messages through and the merged thread rendered
        //    three emails twice. Fall back to external_message_id only when the header is
        //    missing (older rows predating the header backfill).
        await tx.execute(sql`
          DELETE FROM inbox_messages loser_msg
          WHERE loser_msg.thread_id = ${loser.thread_id}
            AND EXISTS (
              SELECT 1 FROM inbox_messages keep
              WHERE keep.thread_id = ${winner.thread_id}
                AND (
                  (loser_msg.gmail_message_id_header IS NOT NULL
                   AND keep.gmail_message_id_header = loser_msg.gmail_message_id_header)
                  OR
                  (loser_msg.gmail_message_id_header IS NULL
                   AND keep.external_message_id IS NOT DISTINCT FROM loser_msg.external_message_id)
                )
            )
        `);

        // 3. Move the rest onto the winning thread.
        await tx.execute(sql`
          UPDATE inbox_messages SET thread_id = ${winner.thread_id}
          WHERE thread_id = ${loser.thread_id}
        `);

        // 4. Move bookkeeping onto the surviving deal. Without this the DELETE below
        //    would fail the agent_actions / pending_actions FKs — and the history belongs
        //    with the conversation that survives, not with a row we're about to remove.
        await tx.execute(sql`UPDATE agent_actions   SET deal_id = ${winner.deal_id} WHERE deal_id = ${loser.deal_id}`);
        await tx.execute(sql`UPDATE pending_actions SET deal_id = ${winner.deal_id} WHERE deal_id = ${loser.deal_id}`);

        // 5. Retire the losing thread and its deal. Detaching the thread first keeps the
        //    inbox_threads → deals FK satisfied at every step.
        await tx.execute(sql`UPDATE inbox_threads SET deal_id = NULL WHERE id = ${loser.thread_id}`);
        await tx.execute(sql`DELETE FROM inbox_threads WHERE id = ${loser.thread_id}`);
        await tx.execute(sql`DELETE FROM deals WHERE id = ${loser.deal_id}`);
        merged++;
      }

      // 6. The winner now owns the whole conversation — refresh its counters.
      await tx.execute(sql`
        UPDATE inbox_threads t
        SET message_count  = (SELECT count(*) FROM inbox_messages m WHERE m.thread_id = t.id),
            last_message_at = (SELECT max(received_at) FROM inbox_messages m WHERE m.thread_id = t.id)
        WHERE t.id = ${winner.thread_id}
      `);
    });
    console.log(`  merged ${losers.length} duplicate(s) into deal ${winner.deal_id.slice(0, 8)}`);
  }

  console.log(`\n✅ Retired ${merged} duplicate deal card(s).`);
  await collapseDuplicateMessages();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("mergeDuplicateDealThreads failed:", err.message);
    process.exit(1);
  });
