/**
 * purgeStoredBodiesCore — remove stored mail content from EXISTING inbox rows
 * ("Mailbox Owns Correspondence" §11 step 4; the ingest side is MAILBOX_ZERO_RETENTION).
 *
 * Per thread, and only for a thread whose derived facts already exist, it:
 *   1. fills inbox_messages.body_sha256 where it is missing, from the stored body — the
 *      fingerprint the echo gate matches on (lib/inboxBodyFingerprint: SHA-256 of the text
 *      trimmed exactly as JavaScript's String.prototype.trim trims it) — BEFORE the body goes;
 *   2. nulls inbox_messages.body, subject and sender_name;
 *   3. keeps sender_email only for a counterparty (the thread has a deal); any other sender
 *      becomes `sha256-<hex>@<domain>` (lib/mailbox/retention.ts pseudonymousSender, same
 *      bytes) so sender memory still recognises them; a value with no '@' (a display name
 *      stored as a sender) is nulled;
 *   4. nulls inbox_threads.subject.
 *
 * DERIVED FACTS FIRST. A thread is purged only when nothing would be lost that Nomila still
 * needs to derive: it has a classification AND a conversation_state, OR it is junk (archived,
 * or classified NOISE), OR it is closed (its deal is completed / rejected, or the deal's
 * opportunity is closed). Any other thread with stored content is REFUSED and listed by id —
 * run the summarizer / requalify on it first.
 *
 * Instagram threads are never touched: their DMs have no reliable live re-read (the
 * MAILBOX_ZERO_RETENTION exception — see lib/mailbox/retention.ts). Nor are Nomila-relayed threads
 * (platform 'nomila', partner requests from her public card): they are Nomila's own relay record,
 * not mailbox content, and nothing could re-read them. Both are counted as `instagramThreads` (the
 * exception count; the field name predates the second exception).
 *
 * Content never enters this process: counts, byte sums and the hash are computed in SQL.
 * No imports from server/db: the CLI decides the session (read-only for the dry run) before
 * the pool loads; tests hand in a PGlite drizzle instance.
 */

import { sql, type SQL } from "drizzle-orm";
import type { PurgeScope } from "./purgeJunkSamplesCore";

export type { PurgeScope };

/** Exactly the characters String.prototype.trim removes (ECMAScript WhiteSpace + LineTerminator). */
const JS_TRIM_CHARS =
  "\t\n\u000b\f\r                  　﻿";
/** POSIX regex for a JS trim; passed as a bound parameter, never spliced into SQL text. */
const JS_TRIM_RE = `^[${JS_TRIM_CHARS}]+|[${JS_TRIM_CHARS}]+$`;

/** The stored-body fingerprint, in SQL: sha256(utf8(jsTrim(body))) as lowercase hex. */
function fingerprintSql(col: SQL): SQL {
  return sql`encode(sha256(convert_to(regexp_replace(${col}, ${JS_TRIM_RE}, '', 'g'), 'UTF8')), 'hex')`;
}

function scopeSql(scope: PurgeScope): SQL {
  return "athleteId" in scope ? sql`t.athlete_id = ${scope.athleteId}` : sql`true`;
}

/** A JS-trimmed, lower-cased address — the exact input pseudonymousSender hashes. */
function normalisedAddressSql(col: SQL): SQL {
  return sql`lower(regexp_replace(${col}, ${JS_TRIM_RE}, '', 'g'))`;
}

/**
 * Does message row `m` still hold content? Body, subject or sender name; or a sender_email
 * that is neither a pseudonym nor a counterparty's address (a thread with a deal keeps its
 * counterparty's address — decision 3). `dealIdSql` is the owning thread's deal_id.
 */
function messageHoldsSql(dealIdSql: SQL): SQL {
  return sql`(
    m.body is not null or m.subject is not null or m.sender_name is not null
    or (m.sender_email is not null
        and m.sender_email !~ '^sha256-[0-9a-f]{64}@'
        and (${dealIdSql} is null or position('@' in m.sender_email) = 0))
  )`;
}

/** Threads in scope that still hold stored content (a thread subject, or a message that does). */
function holdingContentSql(): SQL {
  return sql`(
    t.subject is not null
    or exists (select 1 from inbox_messages m where m.thread_id = t.id and ${messageHoldsSql(sql`t.deal_id`)})
  )`;
}

/** Instagram and Nomila-relayed threads keep their content (the zero-retention exceptions). */
function notInstagramSql(): SQL {
  return sql`not exists (select 1 from inbox_messages mi where mi.thread_id = t.id and mi.platform in ('instagram', 'nomila'))`;
}

/** The thread's derived facts exist, or it is junk / closed. */
function derivedReadySql(): SQL {
  return sql`(
    (t.classification is not null and t.conversation_state is not null)
    or t.status = 'archived'
    or t.classification ->> 'category' = 'NOISE'
    or exists (select 1 from deals d where d.id = t.deal_id and d.status in ('completed', 'rejected'))
    or exists (select 1 from deals d join opportunities o on o.id = d.opportunity_id
                where d.id = t.deal_id and o.status = 'closed')
  )`;
}

export interface StoredBodyCounts {
  /** Threads in scope holding stored content (Instagram excluded). */
  threads:          number;
  /** Of those, threads whose derived facts are ready — the ones --apply purges. */
  eligibleThreads:  number;
  /** Threads holding content WITHOUT derived facts — refused, by id. */
  refusedThreadIds: string[];
  /** Message rows holding content, on eligible threads. */
  messages:         number;
  /** Message rows on eligible threads that would get a body_sha256 backfilled first. */
  missingFingerprint: number;
  /** Bytes of stored content on eligible threads, per column. */
  bytes: { body: number; subject: number; sender_name: number; thread_subject: number };
  /** Instagram threads skipped (exception). */
  instagramThreads: number;
  athletes:         number;
}

function rowsOf(res: unknown): any[] {
  return ((res as any)?.rows ?? res) as any[];
}

/** Counts, bytes and refused ids — never a value. Safe under a read-only session. */
export async function countStoredBodies(dbx: any, scope: PurgeScope): Promise<StoredBodyCounts> {
  const threadRes = await dbx.execute(sql`
    select t.id, t.athlete_id, ${derivedReadySql()} as ready
      from inbox_threads t
     where ${scopeSql(scope)} and ${notInstagramSql()} and ${holdingContentSql()}
     order by t.id
  `);
  const threads = rowsOf(threadRes);
  const eligible = threads.filter((r) => r.ready === true || r.ready === "t");
  const refused  = threads.filter((r) => !(r.ready === true || r.ready === "t")).map((r) => String(r.id));

  const igRes = await dbx.execute(sql`
    select count(*)::int as n from inbox_threads t
     where ${scopeSql(scope)} and not ${notInstagramSql()} and ${holdingContentSql()}
  `);

  const msgRes = await dbx.execute(sql`
    select count(*) filter (where ${messageHoldsSql(sql`t.deal_id`)})::int as messages,
           count(*) filter (where m.body_sha256 is null and m.body is not null)::int as missing_fp,
           coalesce(sum(octet_length(m.body)), 0)::bigint        as body_bytes,
           coalesce(sum(octet_length(m.subject)), 0)::bigint     as subject_bytes,
           coalesce(sum(octet_length(m.sender_name)), 0)::bigint as sender_name_bytes
      from inbox_messages m
      join inbox_threads t on t.id = m.thread_id
     where ${scopeSql(scope)} and ${notInstagramSql()} and ${holdingContentSql()} and ${derivedReadySql()}
  `);
  const subjRes = await dbx.execute(sql`
    select coalesce(sum(octet_length(t.subject)), 0)::bigint as n
      from inbox_threads t
     where ${scopeSql(scope)} and ${notInstagramSql()} and ${holdingContentSql()} and ${derivedReadySql()}
  `);
  const m = rowsOf(msgRes)[0] ?? {};
  return {
    threads:            threads.length,
    eligibleThreads:    eligible.length,
    refusedThreadIds:   refused,
    messages:           Number(m.messages ?? 0),
    missingFingerprint: Number(m.missing_fp ?? 0),
    bytes: {
      body:           Number(m.body_bytes ?? 0),
      subject:        Number(m.subject_bytes ?? 0),
      sender_name:    Number(m.sender_name_bytes ?? 0),
      thread_subject: Number(rowsOf(subjRes)[0]?.n ?? 0),
    },
    instagramThreads: Number(rowsOf(igRes)[0]?.n ?? 0),
    athletes:         new Set(threads.map((r) => String(r.athlete_id))).size,
  };
}

export interface PurgeResult {
  threadsPurged:        number;
  fingerprintsFilled:   number;
  messagesCleared:      number;
  refusedThreadIds:     string[];
}

/**
 * Purge the eligible threads in scope, in ONE transaction: fingerprints first, then content.
 * Refused threads (no derived facts) are left exactly as they are and returned by id.
 */
export async function purgeStoredBodies(dbx: any, scope: PurgeScope): Promise<PurgeResult> {
  return dbx.transaction(async (tx: any) => {
    const idsRes = await tx.execute(sql`
      select t.id, ${derivedReadySql()} as ready
        from inbox_threads t
       where ${scopeSql(scope)} and ${notInstagramSql()} and ${holdingContentSql()}
       order by t.id
       for update of t
    `);
    const rows = rowsOf(idsRes);
    const ready = rows.filter((r) => r.ready === true || r.ready === "t").map((r) => String(r.id));
    const refused = rows.filter((r) => !(r.ready === true || r.ready === "t")).map((r) => String(r.id));
    if (ready.length === 0) return { threadsPurged: 0, fingerprintsFilled: 0, messagesCleared: 0, refusedThreadIds: refused };

    const idList = sql.join(ready.map((id) => sql`${id}::uuid`), sql`, `);

    // 1. Fingerprint before the body goes.
    const fp = await tx.execute(sql`
      update inbox_messages m
         set body_sha256 = ${fingerprintSql(sql`m.body`)}
       where m.thread_id in (${idList}) and m.body_sha256 is null and m.body is not null
    `);

    // 2–3. Content off the message rows; a counterparty's address stays, anyone else's is
    //      pseudonymised (same bytes as pseudonymousSender), a non-address is nulled.
    const cleared = await tx.execute(sql`
      update inbox_messages m
         set body = null,
             subject = null,
             sender_name = null,
             sender_email = case
               when m.sender_email is null then null
               when m.sender_email ~ '^sha256-[0-9a-f]{64}@' then m.sender_email
               when position('@' in m.sender_email) = 0 then null
               when exists (select 1 from inbox_threads tt where tt.id = m.thread_id and tt.deal_id is not null)
                 then m.sender_email
               else 'sha256-' || encode(sha256(convert_to(${normalisedAddressSql(sql`m.sender_email`)}, 'UTF8')), 'hex')
                    || '@' || substring(${normalisedAddressSql(sql`m.sender_email`)} from '@([^@]*)$')
             end
       where m.thread_id in (${idList})
         and ${messageHoldsSql(sql`(select tt.deal_id from inbox_threads tt where tt.id = m.thread_id)`)}
    `);

    // 4. The thread's subject.
    await tx.execute(sql`update inbox_threads set subject = null where id in (${idList}) and subject is not null`);

    return {
      threadsPurged:      ready.length,
      fingerprintsFilled: Number((fp as any).rowCount ?? (fp as any).affectedRows ?? 0),
      messagesCleared:    Number((cleared as any).rowCount ?? (cleared as any).affectedRows ?? 0),
      refusedThreadIds:   refused,
    };
  });
}
