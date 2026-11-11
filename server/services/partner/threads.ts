/**
 * partner/threads.ts — a partner request's conversation, which lives ON HER OPPORTUNITY (design §7a, v3.1):
 * inbox_threads.deal_id = the request's deal, messages in inbox_messages with platform 'nomila' and the relay's
 * moderation state. Bookings keep their own booking_messages; only the relay (services/relay) is shared.
 *
 * This file is the partner relay HOME (write + deliver) and the ONLY reader of Nomila-relayed message text:
 *   - every query here is pinned to platform = NOMILA_PLATFORM, so it can never read stored MAIL content (the
 *     zero-retention inventory, lib/mailbox/storedContentReaders.test.ts, lists this file with that guard);
 *   - a held or blocked message is stored with body NULL — so no other reader of inbox_messages (deal detail, Mila,
 *     the summariser) ever sees its text — and its text kept in held_body for its own sender's view and for review.
 *
 * Who sees what: the visitor sees every delivered message plus their OWN held ones ("This message is being
 * checked"); she sees every delivered message plus her own held ones. Neither ever sees the other's held text.
 */
import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { inboxMessages, inboxThreads, partnerRequests, type PartnerRequest } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { inboxBodyFingerprint } from "../../lib/inboxBodyFingerprint";
import { noteThreadActivity } from "../../skills/opportunities";
import { submitRelayMessage, type RelayHome, type RelayResult } from "../relay/relay";
import { PARTNER_TEMPLATES } from "../notify/templates/partner";
import { replyAddressFor, sendPartnerEmail, statusUrlFor } from "./links";
import { NOMILA_PLATFORM } from "./requests";

const logger = createLogger("services/partner/threads");

export type PartnerSender = "visitor" | "athlete";

export interface ThreadMessage {
  id: string;
  from: PartnerSender;
  /** "[First]" for her, the sender's name for the visitor. */
  name: string;
  /** null while held: the page shows "This message is being checked". */
  body: string | null;
  state: "delivered" | "checking";
  at: string;
}

/** The partner home over one confirmed request's thread. */
export function partnerRelayHome(row: PartnerRequest): RelayHome<PartnerSender> {
  if (!row.inbox_thread_id || !row.deal_id) throw new Error("request has no thread yet");
  const threadId = row.inbox_thread_id;
  return {
    threadKey: `partner:${row.id}`,
    async write(msg) {
      const held = msg.moderation !== "clean";
      const [ins] = await db.insert(inboxMessages).values({
        thread_id: threadId, athlete_id: row.athlete_id,
        direction: msg.sender === "visitor" ? "inbound" : "outbound",
        sender_email: msg.sender === "visitor" ? row.contact_email : null,
        sender_name: msg.sender === "visitor" ? row.contact_name : row.display_name,
        subject: null,
        body: held ? null : msg.body,
        held_body: held ? msg.body : null,
        body_sha256: inboxBodyFingerprint(msg.body),
        received_at: msg.at,
        external_message_id: msg.externalId ?? `nomila:${row.id}:${msg.at.getTime()}:${Math.random().toString(36).slice(2, 10)}`,
        platform: NOMILA_PLATFORM,
        moderation: msg.moderation,
        moderation_reason: msg.reason,
      }).onConflictDoNothing().returning({ id: inboxMessages.id });
      return ins ?? null;
    },
    async deliver(msg) { await deliverPartnerMessage(row, msg.sender, msg.at); },
  };
}

/**
 * A clean message reached the thread: count it, flip whose move it is, advance the opportunity, and tell the other
 * side without content. Her message → the visitor gets "You have a new message from [First]" (with the per-thread
 * reply-to address). The visitor's message → her card shows it is her move (no push exists in this app yet).
 */
export async function deliverPartnerMessage(row: PartnerRequest, sender: PartnerSender, at: Date): Promise<void> {
  const threadId = row.inbox_thread_id!;
  await db.update(inboxThreads).set({
    last_message_at: at,
    message_count: sql`${inboxThreads.message_count} + 1`,
    conversation_state: sql`jsonb_set(coalesce(${inboxThreads.conversation_state}, '{}'::jsonb), '{key_details,awaiting_response_from}', ${JSON.stringify(sender === "visitor" ? "athlete" : "brand")}::jsonb, true)`,
  }).where(eq(inboxThreads.id, threadId));
  await noteThreadActivity({ athleteId: row.athlete_id, threadId, dealId: row.deal_id! });
  // "Your requests" lists newest activity first.
  await db.update(partnerRequests).set({ updated_at: at }).where(eq(partnerRequests.id, row.id));
  if (sender === "athlete") {
    if (!row.first_reply_at) {
      await db.update(partnerRequests).set({ first_reply_at: at, updated_at: at })
        .where(and(eq(partnerRequests.id, row.id), sql`${partnerRequests.first_reply_at} IS NULL`));
    }
    if (row.contact_email) {
      try {
        await sendPartnerEmail(row.contact_email, PARTNER_TEMPLATES.newMessage, { first: row.display_name, ref: row.public_ref, link: statusUrlFor(row) }, replyAddressFor(row));
      } catch (err: any) { logger.warn({ requestId: row.id, error: err?.message }, "new-message notice failed"); }
    }
  }
}

/** Relay one message onto a request's thread. */
export async function relayPartnerMessage(row: PartnerRequest, sender: PartnerSender, body: unknown, opts: { externalId?: string; now?: Date } = {}): Promise<RelayResult> {
  if (row.status !== "confirmed") return { ok: false, status: 400, error: "this request isn't open for messages" };
  return submitRelayMessage(partnerRelayHome(row), { sender, body, externalId: opts.externalId, now: opts.now });
}

/** The thread as `viewer` may see it (oldest first). Pinned to platform 'nomila' — never mail content. */
export async function readPartnerThread(row: PartnerRequest, viewer: PartnerSender): Promise<ThreadMessage[]> {
  if (!row.inbox_thread_id) return [];
  const own = viewer === "visitor" ? "inbound" : "outbound";
  const rows = await db.select({
    id: inboxMessages.id, direction: inboxMessages.direction, body: inboxMessages.body, held_body: inboxMessages.held_body,
    moderation: inboxMessages.moderation, received_at: inboxMessages.received_at,
  }).from(inboxMessages).where(and(
    eq(inboxMessages.thread_id, row.inbox_thread_id), eq(inboxMessages.athlete_id, row.athlete_id), eq(inboxMessages.platform, NOMILA_PLATFORM),
    or(eq(inboxMessages.moderation, "clean"), and(eq(inboxMessages.direction, own), eq(inboxMessages.moderation, "held"))),
  )).orderBy(asc(inboxMessages.received_at), asc(inboxMessages.created_at));
  return rows.map((m) => {
    const from: PartnerSender = m.direction === "inbound" ? "visitor" : "athlete";
    const checking = m.moderation !== "clean";
    return {
      id: m.id, from, name: from === "athlete" ? row.display_name : (row.contact_name ?? "Sender"),
      body: checking ? (m.held_body ?? null) : m.body, state: checking ? "checking" : "delivered",
      at: new Date(m.received_at ?? 0).toISOString(),
    };
  });
}

// ─── Review of held messages (admin) ───────────────────────────────────────────────────────────────────────────

export interface HeldMessage { id: string; requestRef: string; from: PartnerSender; reason: string | null; state: "held" | "blocked"; body: string | null; at: string }

/** Held (and blocked) relayed messages, oldest first, for the review queue. */
export async function listHeldMessages(limit = 100): Promise<HeldMessage[]> {
  const rows = await db.select({
    id: inboxMessages.id, direction: inboxMessages.direction, held_body: inboxMessages.held_body, moderation: inboxMessages.moderation,
    reason: inboxMessages.moderation_reason, at: inboxMessages.received_at, ref: partnerRequests.public_ref,
  }).from(inboxMessages)
    .innerJoin(partnerRequests, eq(partnerRequests.inbox_thread_id, inboxMessages.thread_id))
    .where(and(eq(inboxMessages.platform, NOMILA_PLATFORM), or(eq(inboxMessages.moderation, "held"), eq(inboxMessages.moderation, "blocked")), isNotNull(inboxMessages.moderation)))
    .orderBy(asc(inboxMessages.received_at)).limit(Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({
    id: r.id, requestRef: r.ref, from: r.direction === "inbound" ? "visitor" : "athlete", reason: r.reason,
    state: r.moderation === "blocked" ? "blocked" : "held", body: r.held_body, at: new Date(r.at ?? 0).toISOString(),
  }));
}

/**
 * A reviewer's decision on a HELD message. release → delivered exactly as if it had been clean (notices included);
 * block → never delivered. Blocked messages are final. Returns false when it isn't a held relayed message.
 */
export async function decideHeldMessage(messageId: string, decision: "release" | "block", now: Date = new Date()): Promise<boolean> {
  const [m] = await db.select({ id: inboxMessages.id, thread_id: inboxMessages.thread_id, direction: inboxMessages.direction, held_body: inboxMessages.held_body })
    .from(inboxMessages)
    .where(and(eq(inboxMessages.id, messageId), eq(inboxMessages.platform, NOMILA_PLATFORM), eq(inboxMessages.moderation, "held"))).limit(1);
  if (!m) return false;
  if (decision === "block") {
    await db.update(inboxMessages).set({ moderation: "blocked", moderation_reason: sql`coalesce(${inboxMessages.moderation_reason} || ',', '') || 'reviewed'` })
      .where(eq(inboxMessages.id, m.id));
    return true;
  }
  const [row] = await db.select().from(partnerRequests).where(eq(partnerRequests.inbox_thread_id, m.thread_id)).limit(1);
  if (!row) return false;
  await db.update(inboxMessages).set({ moderation: "clean", body: m.held_body, held_body: null }).where(eq(inboxMessages.id, m.id));
  await deliverPartnerMessage(row, m.direction === "inbound" ? "visitor" : "athlete", now);
  return true;
}

// ─── Her reply (by her tap: the governed send path, sendThreadReply → here) ──────────────────────────────────

export type PartnerReplyResult = { ok: true; sentMessageId?: null } | { ok: false; status: number; error: string; code?: string };

/**
 * Her reply on a request thread, from her own tap (a send_reply pending action she approved, or the reply route).
 * Sent through the relay from Nomila's address — the visitor gets a content-free notice with the status link and the
 * per-thread reply-to. A held reply is NOT sent, and she is told why.
 */
export async function replyOnPartnerThread(athleteId: string, threadId: string, body: string): Promise<PartnerReplyResult> {
  const { partnerIntakeEnabled } = await import("./config");
  if (!partnerIntakeEnabled()) return { ok: false, status: 409, error: "Replies to public-card requests are switched off right now.", code: "PARTNER_OFF" };
  const [row] = await db.select().from(partnerRequests)
    .where(and(eq(partnerRequests.inbox_thread_id, threadId), eq(partnerRequests.athlete_id, athleteId))).limit(1);
  if (!row) return { ok: false, status: 404, error: "Thread not found" };
  const r = await relayPartnerMessage(row, "athlete", body);
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  if (r.duplicate || r.moderation === "clean") return { ok: true, sentMessageId: null };
  return r.moderation === "held"
    ? { ok: false, status: 409, code: "HELD_FOR_REVIEW", error: `This message is being checked before it reaches ${row.brand_name}: it seems to include contact details, a payment request or a link. Nomila keeps those private on both sides.` }
    : { ok: false, status: 409, code: "BLOCKED", error: "This message can't be sent." };
}
