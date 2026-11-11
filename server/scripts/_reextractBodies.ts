/**
 * _reextractBodies.ts — best-effort repair for message bodies stored before
 * emailBody.ts existed (docs/plans/inbox-thread-fidelity.md, Phase 3.4):
 * html-only mail saved as raw markup/CSS, and empty bodies from nested
 * multipart. Re-fetches each message from Gmail by its stable message id and
 * runs it through the current extraction pipeline.
 *
 * DRY-RUN by default — lists candidates and touches nothing.
 *
 *   npx tsx --require dotenv/config server/scripts/_reextractBodies.ts
 *   npx tsx --require dotenv/config server/scripts/_reextractBodies.ts --apply
 */

import { eq, sql } from "drizzle-orm";
import { refuseUnderZeroRetention } from "./privacy/storedContentGuard";
import { db, pool } from "../db";
import { inboxMessages } from "../../shared/schema";
import { refreshTokenIfNeeded, fetchFullMessage } from "../lib/integrations/gmail";

const APPLY    = process.argv.includes("--apply");
const DELAY_MS = 300; // stay polite with the Gmail API

interface Candidate {
  id: string;
  external_message_id: string;
  /** Every active Gmail mailbox for this athlete, the message's own one first.
   *  Pre-#91 rows often carry a null connected_account_id, and older accounts get
   *  revoked on re-auth, so the id a row was written with is frequently gone. A
   *  Gmail message id only resolves inside the mailbox it came from, so the only
   *  honest approach is to try each live mailbox and take the first that has it. */
  account_ids: string[];
  body: string | null;
  subject: string | null;
}

async function main() {
  refuseUnderZeroRetention("_reextractBodies");
  console.log(APPLY ? "APPLY mode — bodies will be rewritten.\n" : "DRY-RUN — nothing will be written. Pass --apply to execute.\n");

  const { rows: candidates } = (await db.execute(sql`
    SELECT m.id, m.external_message_id, m.body, m.subject,
           array(select c.id::text
                   from connected_accounts c
                  where c.athlete_id = m.athlete_id
                    and c.platform = 'gmail' and c.status = 'active'
                  order by (c.id = m.connected_account_id) desc) AS account_ids
    FROM inbox_messages m
    WHERE m.platform = 'gmail'
      AND m.external_message_id IS NOT NULL
      AND (m.body IS NULL OR m.body = '' OR m.body ~* '<(html|head|style|div|!doctype)' OR m.body ~ 'a\\[href')
      AND EXISTS (select 1 from connected_accounts c
                   where c.athlete_id = m.athlete_id
                     and c.platform = 'gmail' and c.status = 'active')
    ORDER BY m.athlete_id
  `)) as unknown as { rows: Candidate[] };

  console.log(`Messages with junk/empty bodies (re-fetchable): ${candidates.length}`);
  for (const c of candidates) {
    const head = (c.body ?? "(empty)").replace(/\s+/g, " ").slice(0, 48);
    console.log(`  "${c.subject?.slice(0, 36)}"  ${head}`);
  }
  if (!APPLY || candidates.length === 0) {
    console.log("\nDry-run complete. Re-run with --apply to execute.");
    return;
  }

  // Token refresh is cached on the connection row, so grouping by account
  // keeps this to one refresh per inbox.
  const tokens = new Map<string, string>();
  let fixed = 0, unchanged = 0, failed = 0;

  for (const c of candidates) {
    try {
      let msg: Awaited<ReturnType<typeof fetchFullMessage>> | null = null;
      for (const acct of c.account_ids) {
        let token = tokens.get(acct);
        if (!token) {
          token = await refreshTokenIfNeeded(acct);
          tokens.set(acct, token);
        }
        try {
          msg = await fetchFullMessage(token, c.external_message_id);
          if (msg?.body?.trim()) break;   // found it in this mailbox
        } catch {
          msg = null;                     // not in this mailbox — try the next
        }
      }
      if (!msg?.body?.trim()) {
        unchanged++;   // nothing better available — leave the stored body alone
      } else {
        await db.update(inboxMessages).set({ body: msg.body }).where(eq(inboxMessages.id, c.id));
        fixed++;
        console.log(`  ✓ "${c.subject?.slice(0, 40)}" → ${msg.body.replace(/\s+/g, " ").slice(0, 48)}`);
      }
    } catch (err: any) {
      failed++;
      console.error(`  ✗ ${c.id}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone: ${fixed} rewritten, ${unchanged} left as-is (no better source), ${failed} failed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
