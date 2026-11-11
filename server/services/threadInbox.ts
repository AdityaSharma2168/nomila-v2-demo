/**
 * threadInbox.ts — which connection a thread answers through, and what it can do.
 *
 * Draft save, send, draft clear and the thread/deal payloads all need "the inbox this
 * thread uses". They used to pick it three slightly different ways, and the app used a
 * fourth (any active Gmail row), so Settings could say "connected" while the thread's
 * own row was revoked or lacked the drafts permission. This is the one rule:
 *
 *   the newest INBOUND message that recorded a connection, else the thread's connection.
 *
 * It never searches for a working row. The row a thread points at is the answer; if that
 * row is revoked or missing a scope, the caller says so and names the inbox, so the
 * athlete can reconnect THAT account (connection-identity plan §4.4, §4.6).
 */

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { connectedAccounts, inboxMessages, inboxThreads } from "../../shared/schema";
import { GMAIL_DRAFT_SCOPE } from "../lib/connectionScopes";
import { replyPlatform } from "../lib/replyPlatforms";

/** The thread's connection. `status: "missing"` = an id is stored but no row (for this athlete) exists. */
export interface ThreadInbox {
  connection_id: string;
  /** platform_username — the mailbox address for Gmail, the handle for Instagram. */
  email:         string | null;
  platform:      string | null;
  status:        string;
  can_draft:     boolean;
  can_send:      boolean;
}

/** The API shape of a thread's inbox (plan §4.6). */
export type ThreadInboxPayload = Pick<ThreadInbox, "connection_id" | "email" | "status" | "can_draft" | "can_send">;

/** The short form every draft/send failure carries, so the app can name and reconnect it. */
export type InboxRef = { connection_id: string; email: string | null };

/**
 * What a row can do. Mirrors GET /connections, with ONE deliberate difference for send:
 * a Gmail row with NULL scopes counts as able to send. Every row since late May requested
 * gmail.send, and refusing on a null would turn an unknown into a hard failure; if Google
 * disagrees, the send itself maps the 403 to SCOPE_MISSING.
 *
 * can_send comes from the reply-platform table (lib/replyPlatforms.ts): the platform's send switch
 * is on, and — where the platform has a per-grant send scope — the stored grant carries it. So an
 * Outlook row can send only with OUTLOOK_SEND on AND Mail.Send granted.
 */
export function inboxCapability(row: { platform: string | null; status: string | null; scopes: string | null }): {
  can_draft: boolean;
  can_send:  boolean;
} {
  const active = row.status === "active";
  const entry = replyPlatform(row.platform);
  return {
    can_draft: active && row.platform === "gmail" && GMAIL_DRAFT_SCOPE.test(row.scopes ?? ""),
    can_send:
      active &&
      !!entry &&
      entry.sender.kind === "mailbox" &&
      entry.enabled() &&
      (entry.grantCanSend ? entry.grantCanSend(row.scopes) : true),
  };
}

/**
 * Resolve the inbox for many threads at once (the deal list). Threads with no connection
 * on any inbound message or on the thread itself map to null (legacy, pre-8 Jul).
 * Only rows owned by `athleteId` count; a foreign or deleted id reads as "missing".
 */
export async function resolveThreadInboxes(
  athleteId: string,
  threadIds: string[],
): Promise<Map<string, ThreadInbox | null>> {
  const out = new Map<string, ThreadInbox | null>();
  const ids = [...new Set(threadIds.filter(Boolean))];
  if (ids.length === 0) return out;

  // Newest inbound message per thread that recorded a connection. Same ordering as the
  // send path's `desc(received_at)` so the two can never pick different rows.
  const [msgRows, threadRows] = await Promise.all([
    db
      .selectDistinctOn([inboxMessages.thread_id], {
        thread_id:            inboxMessages.thread_id,
        connected_account_id: inboxMessages.connected_account_id,
      })
      .from(inboxMessages)
      .where(and(
        inArray(inboxMessages.thread_id, ids),
        eq(inboxMessages.direction, "inbound"),
        isNotNull(inboxMessages.connected_account_id),
      ))
      .orderBy(inboxMessages.thread_id, desc(inboxMessages.received_at)),
    db
      .select({ id: inboxThreads.id, connected_account_id: inboxThreads.connected_account_id })
      .from(inboxThreads)
      .where(and(inArray(inboxThreads.id, ids), eq(inboxThreads.athlete_id, athleteId))),
  ]);

  const connByThread = new Map<string, string | null>();
  for (const t of threadRows) connByThread.set(t.id, t.connected_account_id ?? null);
  for (const m of msgRows) {
    // Only threads the athlete owns (threadRows is already athlete-scoped).
    if (connByThread.has(m.thread_id) && m.connected_account_id) {
      connByThread.set(m.thread_id, m.connected_account_id);
    }
  }

  const connIds = [...new Set([...connByThread.values()].filter((v): v is string => !!v))];
  const accounts = connIds.length
    ? await db
        .select({
          id:                connectedAccounts.id,
          platform:          connectedAccounts.platform,
          status:            connectedAccounts.status,
          scopes:            connectedAccounts.scopes,
          platform_username: connectedAccounts.platform_username,
        })
        .from(connectedAccounts)
        .where(and(inArray(connectedAccounts.id, connIds), eq(connectedAccounts.athlete_id, athleteId)))
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));

  for (const threadId of ids) {
    const connId = connByThread.get(threadId) ?? null;
    if (!connId) {
      out.set(threadId, null);
      continue;
    }
    const row = byId.get(connId);
    if (!row) {
      out.set(threadId, {
        connection_id: connId, email: null, platform: null, status: "missing", can_draft: false, can_send: false,
      });
      continue;
    }
    out.set(threadId, {
      connection_id: row.id,
      email:         row.platform_username ?? null,
      platform:      row.platform,
      status:        row.status ?? "missing",
      ...inboxCapability(row),
    });
  }
  return out;
}

/** Resolve one thread's inbox. See {@link resolveThreadInboxes}. */
export async function resolveThreadInbox(athleteId: string, threadId: string): Promise<ThreadInbox | null> {
  return (await resolveThreadInboxes(athleteId, [threadId])).get(threadId) ?? null;
}

/** The wire shape for thread/deal payloads. */
export function toInboxPayload(inbox: ThreadInbox | null | undefined): ThreadInboxPayload | null {
  if (!inbox) return null;
  const { connection_id, email, status, can_draft, can_send } = inbox;
  return { connection_id, email, status, can_draft, can_send };
}

/** The short form attached to every draft/send failure. */
export function toInboxRef(inbox: ThreadInbox | null | undefined): InboxRef | null {
  return inbox ? { connection_id: inbox.connection_id, email: inbox.email } : null;
}
