/**
 * saveThreadDraft.ts — persist a reply draft in app + optional Gmail Drafts.
 *
 * Writes `inbox_threads.latest_draft` and, when asked, mirrors the text into a
 * nested Gmail Draft so the athlete sees the same composition in web/mobile Gmail.
 *
 * The mirror is OPT-IN (`mirrorToGmail`). Every generation used to mirror, which
 * meant merely trying three phrasings wrote three times to the athlete's real
 * mailbox before they had decided anything — and a Gmail draft nested in the thread
 * is then re-ingested by the poll path and shown in "view full conversation" as if
 * it had been sent. Saving in Nomila is cheap and private, so it always happens;
 * reaching into Gmail is an explicit act ("Save as draft"). There is no exception: what
 * sits in the athlete's Gmail is always exactly what they last pressed the button on.
 */

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxThreads, inboxMessages } from "../../shared/schema";
import { resolveReplyEnvelope } from "./replyEnvelope";
import { mailboxZeroRetentionEnabled } from "../lib/mailbox/retention";
import { upsertGmailDraft } from "../lib/integrations/gmail";
import { createLogger } from "../logger";
import { INSUFFICIENT_SCOPE_ERROR } from "../lib/connectionScopes";
import { resolveThreadInbox, toInboxRef } from "./threadInbox";
import { resolveReplyThread } from "../lib/replyThread";

const logger = createLogger("services/saveThreadDraft");

/**
 * What happened to the Gmail mirror. Stored on `latest_draft.gmail_draft` and returned
 * in the PUT response's `latest_draft`, so the app can say which one occurred.
 *   "saved"              — a real Gmail Draft exists (gmail_draft_id is set)
 *   "scope_missing"      — the thread's inbox is connected but lacks gmail.compose
 *   "reconnect_required" — the thread's inbox is revoked, expired or gone
 *   "no_inbox"           — the thread predates inbox tracking; no connection to use
 *   "unavailable"        — the call was tried (or the inbox isn't Gmail) and failed
 *   "skipped"            — nothing to address it to: no inbound sender on the thread
 *   "not_requested"      — a Nomila-only save (autosave); Gmail was deliberately untouched
 * Every result other than saved / not_requested also sets `latest_draft.gmail_draft_inbox`
 * `{ connection_id, email }` when the thread has a connection, so the app can name the
 * inbox and reconnect that exact account.
 */
export type GmailDraftOutcome =
  | "saved" | "scope_missing" | "reconnect_required" | "no_inbox"
  | "unavailable" | "skipped" | "not_requested";

export type SaveDraftResult =
  | { ok: true; latest_draft: Record<string, unknown> }
  | { ok: false; status: number; error: string };

/**
 * Discard the draft on a deal's thread, and the mirrored Gmail Draft with it.
 *
 * Without this there is no way to abandon a draft short of sending one: an emptied
 * editor is "nothing to save", so the old text survives and — now that reopening
 * restores — comes straight back, which reads as the app refusing to forget.
 */
export async function clearThreadDraft(params: {
  athleteId: string;
  dealId: string;
}): Promise<SaveDraftResult> {
  const { athleteId, dealId } = params;

  // The ONE reply thread (lib/replyThread) — the same one the draft was written for.
  const resolved = await resolveReplyThread(athleteId, dealId);
  const [thread] = resolved.ok && resolved.threadId
    ? await db
        .select({
          id:                   inboxThreads.id,
          latest_draft:         inboxThreads.latest_draft,
        })
        .from(inboxThreads)
        .innerJoin(deals, eq(deals.id, inboxThreads.deal_id))
        .where(and(
          eq(inboxThreads.id, resolved.threadId),
          eq(inboxThreads.athlete_id, athleteId),
          eq(deals.athlete_id, athleteId),
        ))
        .limit(1)
    : [];
  if (!thread) return { ok: false, status: 404, error: "No thread for this deal" };

  const prev = (thread.latest_draft && typeof thread.latest_draft === "object")
    ? (thread.latest_draft as Record<string, unknown>)
    : {};
  const gmailDraftId = typeof prev.gmail_draft_id === "string" ? prev.gmail_draft_id : null;

  await db
    .update(inboxThreads)
    .set({ latest_draft: null })
    .where(eq(inboxThreads.id, thread.id));

  // Best-effort, and deliberately after the local clear: leaving an orphan Gmail draft
  // is survivable, but refusing to forget the draft in Nomila is the reported problem.
  // The same inbox the draft was saved through (message first, then thread) — the draft
  // only exists in that mailbox. A non-active row can't reach Gmail, so don't try.
  if (gmailDraftId) {
    const inbox = await resolveThreadInbox(athleteId, thread.id);
    if (inbox?.status === "active" && inbox.platform === "gmail") {
      const { deleteGmailDraft } = await import("../lib/integrations/gmail.js");
      await deleteGmailDraft(inbox.connection_id, gmailDraftId).catch((err: any) =>
        logger.warn({ dealId, err: err?.message }, "Gmail draft delete failed on clear"),
      );
    } else {
      logger.warn(
        { dealId, connectionId: inbox?.connection_id ?? null, status: inbox?.status ?? null },
        "Gmail draft left in place on clear — the thread's inbox is not active",
      );
    }
  }

  logger.info({ athleteId, dealId, hadGmailDraft: !!gmailDraftId }, "Thread draft cleared");
  return { ok: true, latest_draft: {} };
}

/**
 * NOT SERIALIZED — #164 M2 is deliberately not carried here.
 *
 * The race is real: two near-simultaneous saves on the same thread each read an empty
 * gmail_draft_id, so each CREATES a Gmail draft and one is orphaned in her real mailbox,
 * where the poll path re-ingests it as though it had been sent.
 *
 * The fix #164 proposed — wrap the read-modify-write in a transaction with SELECT … FOR
 * UPDATE — could not be verified: drizzle's transaction API hangs against the PGlite test
 * harness, and this is the only PGlite-backed suite that would exercise one, so there is no
 * precedent to copy. Shipping an unverifiable lock on the path that writes to her real
 * mailbox is worse than shipping the known race with a note on it.
 *
 * A session-scoped advisory lock is the likely answer, but it binds to a connection rather
 * than a statement, so it needs its own change with a test that can actually prove it.
 */
export async function saveThreadDraft(params: {
  athleteId: string;
  dealId: string;
  body: string;
  /** The thread the draft was written for (generateDealDraft's result). Omitted → the one reply thread. */
  threadId?: string | null;
  /** Also write a native Gmail Draft. Off by default — see the module note. */
  mirrorToGmail?: boolean;
  meta?: {
    reply_intent?: string;
    style?: string;
    voice?: string;
    generated_at?: string;
  };
}): Promise<SaveDraftResult> {
  const { athleteId, dealId, body, meta } = params;
  if (typeof body !== "string" || !body.trim()) {
    return { ok: false, status: 400, error: "body is required" };
  }

  const [deal] = await db
    .select({ id: deals.id })
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
    .limit(1);
  if (!deal) return { ok: false, status: 404, error: "Deal not found" };

  // The ONE reply thread (lib/replyThread): the one this draft was written for and will send on.
  const resolved = await resolveReplyThread(athleteId, dealId, params.threadId ?? null);
  const [thread] = resolved.ok && resolved.threadId
    ? await db
        .select({
          id:                   inboxThreads.id,
          // Zero retention never reads a stored subject (the envelope reads it live instead).
          subject:              mailboxZeroRetentionEnabled() ? sql<string | null>`NULL` : inboxThreads.subject,
          latest_draft:         inboxThreads.latest_draft,
          external_thread_id:   inboxThreads.external_thread_id,
        })
        .from(inboxThreads)
        .where(and(eq(inboxThreads.id, resolved.threadId), eq(inboxThreads.athlete_id, athleteId)))
        .limit(1)
    : [];
  if (!thread) return { ok: false, status: 404, error: "No thread for this deal" };

  const prev = (thread.latest_draft && typeof thread.latest_draft === "object")
    ? (thread.latest_draft as Record<string, unknown>)
    : {};

  const draftPayload: Record<string, unknown> = {
    ...prev,
    body: body.trim(),
    reply_intent: meta?.reply_intent ?? prev.reply_intent ?? null,
    style:        meta?.style ?? prev.style ?? null,
    voice:        meta?.voice ?? prev.voice ?? null,
    generated_at: meta?.generated_at ?? prev.generated_at ?? new Date().toISOString(),
    saved_at:     new Date().toISOString(),
  };

  // Mirror into Gmail Drafts. Best-effort — the app draft is saved either way — but the
  // OUTCOME is recorded, not swallowed. This ran as a bare `warn` until 2026-08-09, which
  // is how it went unnoticed that every active Gmail grant predates the gmail.compose
  // scope: drafts.create 403'd on every attempt, so 43 threads carried a draft and none
  // carried a gmail_draft_id. The client reads gmail_draft to say which happened — see
  // GmailDraftOutcome for the values.
  //
  // ONLY an explicit request mirrors. An earlier version also mirrored whenever the
  // thread already had a `gmail_draft_id`, reasoning that the athlete had opted in for
  // this conversation — but that quietly re-created the reported bug: press Save as
  // draft on polished copy, type half a sentence more, close, and the autosave rewrites
  // the athlete's real Gmail draft with the half sentence. What is in Gmail is now
  // exactly what they last pressed the button on. The cost is that Gmail can hold older
  // text than Nomila; that is visible and intentional, and sending clears both.
  const shouldMirror = params.mirrorToGmail === true;

  let gmailDraft: GmailDraftOutcome = shouldMirror ? "skipped" : "not_requested";
  let draftInbox: ReturnType<typeof toInboxRef> = null;
  if (shouldMirror) {
    try {
      const inbound = await db
        .select({
          sender_email:            inboxMessages.sender_email,
          gmail_message_id_header: inboxMessages.gmail_message_id_header,
          gmail_thread_id:         inboxMessages.gmail_thread_id,
          platform:                inboxMessages.platform,
          connected_account_id:    inboxMessages.connected_account_id,
          external_message_id:     inboxMessages.external_message_id,
        })
        .from(inboxMessages)
        .where(and(
          eq(inboxMessages.thread_id, thread.id),
          eq(inboxMessages.direction, "inbound"),
          isNotNull(inboxMessages.sender_email),
        ))
        .orderBy(desc(inboxMessages.received_at))
        .limit(1);

      const lastIn = inbound[0];
      // Stored recipient / subject when there are any; under MAILBOX_ZERO_RETENTION the thread
      // keeps no subject and a non-counterparty sender is a pseudonym, so they are read live.
      const envelope = await resolveReplyEnvelope(mailboxZeroRetentionEnabled() ? null : thread.subject, lastIn ? [lastIn] : []);
      const toEmail = envelope.toEmail;
      // Exactly one row is checked: the one this thread answers through. No searching for
      // another working row — that hid the stale-connection defect for months.
      const inbox = await resolveThreadInbox(athleteId, thread.id);
      draftInbox = toInboxRef(inbox);

      if (!inbox) {
        gmailDraft = "no_inbox";
      } else if (!toEmail) {
        gmailDraft = "skipped";
      } else if (inbox.status !== "active") {
        gmailDraft = "reconnect_required";
      } else if (inbox.platform !== "gmail") {
        // An Outlook/Instagram thread has no Gmail Drafts to mirror into.
        gmailDraft = "unavailable";
      } else if (!inbox.can_draft) {
        gmailDraft = "scope_missing";
      } else {
        // Full References chain for proper nesting — same shape as send path.
        const chain = await db
          .select({ hdr: inboxMessages.gmail_message_id_header })
          .from(inboxMessages)
          .where(and(
            eq(inboxMessages.thread_id, thread.id),
            isNotNull(inboxMessages.gmail_message_id_header),
          ))
          .orderBy(inboxMessages.received_at);
        const references = chain.map((r) => r.hdr!).filter(Boolean);

        let failure: { status: number | null; message: string } | null = null;
        const draftId = await upsertGmailDraft({
          connectionId:    inbox.connection_id,
          toEmail,
          subject:         envelope.subject ?? "Re: deal",
          body:            body.trim(),
          gmailThreadId:   lastIn?.gmail_thread_id ?? thread.external_thread_id,
          messageIdHeader: lastIn?.gmail_message_id_header ?? null,
          references,
          existingDraftId: typeof prev.gmail_draft_id === "string" ? prev.gmail_draft_id : null,
          onFailure:       (f) => { failure = f; },
        });
        if (draftId) {
          draftPayload.gmail_draft_id = draftId;
          gmailDraft = "saved";
        } else {
          // The stored scopes say compose, but Google is the authority: a 403 naming
          // insufficient scopes means the grant never actually included it.
          const f = failure as { status: number | null; message: string } | null;
          gmailDraft = f && f.status === 403 && INSUFFICIENT_SCOPE_ERROR.test(f.message)
            ? "scope_missing"
            : "unavailable";
          logger.error(
            {
              event: "gmail_draft_unavailable", dealId, threadId: thread.id,
              connectionId: inbox.connection_id, outcome: gmailDraft, status: f?.status ?? null,
            },
            "Gmail draft mirror produced no draft",
          );
        }
      }
      if (gmailDraft !== "saved") {
        logger.warn(
          {
            event: "gmail_draft_not_saved", dealId, threadId: thread.id, outcome: gmailDraft,
            connectionId: inbox?.connection_id ?? null,
          },
          "Gmail draft not saved",
        );
      }
    } catch (err: any) {
      gmailDraft = "unavailable";
      logger.error(
        { event: "gmail_draft_unavailable", dealId, err: err?.message },
        "Gmail draft mirror threw (app draft still saved)",
      );
    }
  }

  draftPayload.gmail_draft = gmailDraft;
  // Carried only on a failed mirror; a later success or autosave must not leave a stale one.
  if (gmailDraft !== "saved" && gmailDraft !== "not_requested" && draftInbox) {
    draftPayload.gmail_draft_inbox = draftInbox;
  } else {
    delete draftPayload.gmail_draft_inbox;
  }

  await db
    .update(inboxThreads)
    .set({ latest_draft: draftPayload })
    .where(eq(inboxThreads.id, thread.id));

  return { ok: true, latest_draft: draftPayload };
}
