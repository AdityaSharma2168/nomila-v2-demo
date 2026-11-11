/**
 * reclassifyThread.ts — one re-run of classify for a thread, written back the way detectDeal writes it. Shared by
 * POST /inbox/threads/:id/reclassify (her tap) and scripts/deals/reclassifyThreads (an all-athlete re-run after a
 * classifier prompt change), so both re-read and re-write a thread exactly the same way.
 *
 * Re-classifies off the thread's most-recent INBOUND message (the sender's words — outbound replies would skew the
 * classifier; the newest message of any direction when there is no inbound row). MAILBOX_LIVE_READS: the message is
 * read live from the mailbox; unreadable → nothing is re-classified and nothing is written. No live reader (flag off,
 * Instagram): the stored message, as before.
 *
 * `dryRun` classifies and reports what would change, and writes nothing. `classify` is the provider seam (tests and
 * scripts inject it; the default is the production classifyMessage).
 *
 * Tenancy: the thread must be hers (404 otherwise).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { inboxThreads, inboxMessages } from "../../shared/schema";
import { readStoredMessageLive, textWithBrief } from "./liveConversation";
import { getMailboxAdapter, mailboxProviderOf } from "../lib/mailbox";
import { isBillingNotice, isPaymentToAthlete, statedPaymentAmount } from "../lib/emailFilters";
import { classifyMessage, SCOREABLE_CATEGORIES, upsertDealForThread, demoteDealThread, type Classification } from "../skills/dealDetector";
import { enforceQualification, loadQualificationFloors } from "../skills/dealQualification";
import { placePaperwork, matchPaperwork } from "../skills/paperwork";
import { domainOf, isWorkflowDomain } from "../lib/senderProfile";
import { mailboxZeroRetentionEnabled } from "../lib/mailbox/retention";
import { threadColumns } from "../lib/threadTitle";
import { createLogger } from "../logger";
import { notPlaceholderOnly } from "../lib/integrations/instagramAttachments";

const logger = createLogger("services/reclassifyThread");

export type ClassifyFn = (from: string, subject: string, body: string) => Promise<Classification>;

export type ReclassifyResult =
  | { ok: false; status: 400 | 404 | 409; error: string; code?: string; reason?: string }
  | {
      ok: true;
      /** The thread row after the write (dry run: as it is now). */
      thread: any;
      classification: Classification;
      /** What the write did (dry run: would do). Paperwork is reported as "updated" to the route, as before. */
      outcome: "promoted" | "demoted" | "updated";
      previous_category: string | null;
      previous_media_kind: string | null;
      dry_run: boolean;
      /**
       * Set when the deterministic billing rule (isBillingNotice) decided this re-read, with no model call, AND the
       * thread holds a single message — so the deal was minted from that very message. Only then may a script apply the
       * demotion without --allow-demote: on a longer thread the latest message (a payment notice on a real deal, say)
       * does not speak for the whole conversation.
       */
      structural?: string;
      /**
       * A payment notice paying her (isPaymentToAthlete): where it lands as payment paperwork — "deal" (her deal with
       * the payer), "brand" (the payer's brand record, no deal) — or null (stays noise). Absent for other mail.
       */
      payment?: "deal" | "brand" | null;
    };

export async function reclassifyThread(
  athleteId: string,
  threadId: string,
  opts: { classify?: ClassifyFn; dryRun?: boolean } = {},
): Promise<ReclassifyResult> {
  const classify = opts.classify ?? classifyMessage;
  const dryRun = opts.dryRun === true;

  const [thread] = await db
    .select(threadColumns())
    .from(inboxThreads)
    .where(and(eq(inboxThreads.id, threadId), eq(inboxThreads.athlete_id, athleteId)))
    .limit(1);
  if (!thread) return { ok: false, status: 404, error: "Thread not found" };

  // Ids only: the stored headers / text are read below only when no live reader applies.
  const idCols = {
    id:                      inboxMessages.id,
    platform:                inboxMessages.platform,
    connected_account_id:    inboxMessages.connected_account_id,
    external_message_id:     inboxMessages.external_message_id,
    gmail_thread_id:         inboxMessages.gmail_thread_id,
    gmail_message_id_header: inboxMessages.gmail_message_id_header,
  };
  const [inbound] = await db
    .select(idCols)
    .from(inboxMessages)
    // A placeholder-only DM ("[Photo]") is not text to classify: the newest message the sender wrote is.
    .where(and(eq(inboxMessages.thread_id, threadId), eq(inboxMessages.direction, "inbound"), notPlaceholderOnly))
    .orderBy(desc(inboxMessages.received_at))
    .limit(1);
  const [latest] = inbound
    ? [inbound]
    : await db
        .select(idCols)
        .from(inboxMessages)
        .where(and(eq(inboxMessages.thread_id, threadId), notPlaceholderOnly))
        .orderBy(desc(inboxMessages.received_at))
        .limit(1);
  if (!latest) return { ok: false, status: 400, error: "Thread has no messages to reclassify" };

  let from    = "";
  let subject = "";
  let body    = "";
  let senderEmail: string | null = null;

  // MAILBOX_LIVE_READS: classify the message as the mailbox holds it now. Unreadable →
  // nothing is re-classified and nothing is written.
  const live = await readStoredMessageLive(latest);
  if (live && !live.ok) return { ok: false, status: 409, error: live.message, code: "MAILBOX_UNAVAILABLE", reason: live.reason };
  if (!live) {
    // No live reader (flag off, or Instagram): the stored message, exactly as before.
    const [stored] = await db
      .select({
        sender_email: inboxMessages.sender_email,
        sender_name:  inboxMessages.sender_name,
        subject:      inboxMessages.subject,
        body:         inboxMessages.body,
      })
      .from(inboxMessages)
      .where(eq(inboxMessages.id, latest.id))
      .limit(1);
    from        = stored?.sender_name ? `${stored.sender_name} <${stored.sender_email ?? ""}>` : (stored?.sender_email ?? "");
    subject     = stored?.subject ?? thread.subject ?? "";
    body        = stored?.body ?? "";
    senderEmail = stored?.sender_email ?? null;
  }
  if (live?.ok) {
    from    = live.message.from;
    // Zero retention: the live subject or nothing — never a stored subject.
    subject = live.message.subject || (mailboxZeroRetentionEnabled() ? "" : thread.subject) || "";
    // The text with any PDF brief appended, as ingest classified it: mail whose content is a PDF (an invoice, a payment
    // advice, a brief) is otherwise judged on its email footer alone.
    const provider = mailboxProviderOf(latest.platform ?? "gmail");
    const adapter = provider ? await getMailboxAdapter(provider) : null;
    body = adapter ? await textWithBrief({ adapter }, live.message) : live.message.text;
  }

  // A billing notice (invoice, receipt, remittance or payment advice with no ask) is never a deal: the same
  // deterministic rule ingest runs before any model call. Only this rule, not all of structuralNonDeal: its
  // "nothing to evaluate" rule would file a thread whose stored text is withheld (zero retention) as empty.
  const nonDeal = body.trim() && isBillingNotice(from, subject, body)
    ? { reason: "billing: invoice, receipt, statement or payment notice with no ask" }
    : null;
  const cls: Classification = nonDeal
    ? {
        category: "NOISE", is_deal: false, noise_reason: nonDeal.reason, confidence: 0,
        brand_name: null, brand_domain: domainOf(live?.ok ? live.message.fromEmail : senderEmail), advertiser: null,
        agency_name: null, via_agency: false, summary: subject, offer_amount: null, deliverables: [], deadline: null,
        contact_name: null, contact_email: null,
      }
    : await classify(from, subject, body);
  const [{ n: messageCount }] = nonDeal
    ? await db.select({ n: sql<number>`count(*)::int` }).from(inboxMessages).where(eq(inboxMessages.thread_id, threadId))
    : [{ n: 0 }];
  const structural = nonDeal && Number(messageCount) === 1 ? nonDeal.reason : undefined;

  // Persist classification in the same JSONB shape detectDeal writes.
  //
  // Spread the EXISTING object first. `classification` is not owned solely by the
  // classifier: threadAliases.ts stores alias_thread_ids there — the cross-mailbox dedupe
  // keys that stop the same conversation minting a second deal card. Rebuilding the
  // object from scratch dropped them, so recovering one thread here silently re-opened
  // the duplicate-card bug PR #151 fixed. Classifier fields still win; anything else
  // written by another subsystem survives.
  const priorClassification =
    thread.classification && typeof thread.classification === "object"
      ? (thread.classification as Record<string, unknown>)
      : {};
  const previous_category = typeof priorClassification.category === "string" ? priorClassification.category : null;
  const previous_media_kind = typeof priorClassification.media_kind === "string" ? priorClassification.media_kind : null;

  const isDeal  = SCOREABLE_CATEGORIES.has(cls.category);
  const hadDeal = !!thread.deal_id;
  // E-sign / payment mail never mints a deal or an opportunity, on this path either: it is
  // matched to an existing deal or held as paperwork (skills/paperwork). Not scored.
  // The live sender when the mailbox was read; a stored pseudonym keeps its domain too.
  const senderDomain = domainOf(live?.ok ? live.message.fromEmail : senderEmail);
  const paperwork = isDeal && !hadDeal && !!senderDomain && isWorkflowDomain(senderDomain);
  const outcome: "promoted" | "demoted" | "updated" =
    paperwork ? "updated" : isDeal ? (hadDeal ? "updated" : "promoted") : hadDeal ? "demoted" : "updated";

  // A payment notice paying her: payment paperwork on her deal with the payer (never the deal minted from this very
  // notice), else on the payer's brand record, else nothing (it stays noise).
  const paymentInput = nonDeal && isPaymentToAthlete(from, subject, body)
    ? { athleteId, senderDomain, subject, body, payment: statedPaymentAmount(body) ?? { amountCents: null, currency: "usd" }, excludeDealIds: thread.deal_id ? [thread.deal_id] : [] }
    : null;
  const paymentMatch = paymentInput ? await matchPaperwork(paymentInput).catch(() => null) : null;
  const payment: "deal" | "brand" | null | undefined = !paymentInput ? undefined
    : paymentMatch?.opp && paymentMatch.deal && paymentMatch.matchedBy ? "deal" : paymentMatch?.brandOnly != null ? "brand" : null;

  if (dryRun) {
    return { ok: true, thread, classification: cls, outcome, previous_category, previous_media_kind, dry_run: true, ...(structural ? { structural } : {}), ...(payment !== undefined ? { payment } : {}) };
  }

  // Re-qualify on the same classify (Opportunities PR 1). A deliberate re-read is a fresh
  // judgement, so it replaces what was stored; no model output ⇒ the prior fields survive.
  const qualification = cls.model_qualification
    ? enforceQualification({
        model:        cls.model_qualification,
        from,
        deliverables: cls.deliverables,
        floors:       await loadQualificationFloors(athleteId).catch(() => null),
        messageId:    latest.external_message_id ?? null,
        category:     cls.category,
      })
    : null;

  const classificationJson = {
    ...priorClassification,
    ...(qualification ?? {}),
    category:     cls.category,
    confidence:   cls.confidence,
    brand_name:   cls.brand_name,
    brand_domain: cls.brand_domain,
    advertiser:   cls.advertiser,
    agency_name:  cls.agency_name,
    via_agency:   cls.via_agency,
    advertiser_named: cls.advertiser_named ?? null,
    media_kind:   cls.media_kind ?? null,
    offer_amount: cls.offer_amount,
    deliverables: cls.deliverables,
    deadline:     cls.deadline,
    contact_name: cls.contact_name,
    // Provenance of these derived fields (replaced on the next classify).
    source_message_ids: latest.external_message_id ? [latest.external_message_id] : [],
  };

  const patch: Record<string, unknown> = {
    classification: classificationJson,
    summary:        cls.summary,
  };
  if (isDeal && !paperwork) {
    patch.status = "deal_detected"; // it's a deal now (the deal score is retired; nothing is scored)
  }

  const [updated] = await db
    .update(inboxThreads)
    .set(patch)
    .where(and(eq(inboxThreads.id, threadId), eq(inboxThreads.athlete_id, athleteId)))
    .returning(threadColumns());

  // PROMOTE: a scoreable result must actually surface as a deal — create + link the
  // `deals` row (idempotent; won't duplicate if the thread already had one). Without
  // this the thread flips status but GET /deals (reads FROM deals) never sees it.
  if (paperwork) {
    await placePaperwork({ athleteId, threadId, senderDomain, subject, body });
  } else if (isDeal) {
    await upsertDealForThread(athleteId, threadId, cls);
  } else if (hadDeal) {
    // DEMOTE (user-triggered "Not a deal"): re-read as non-commercial while a deal
    // exists → set it aside (thread archived + reversible receipt). The deal row is
    // kept; Undo/Pull-it-back restore it.
    await demoteDealThread(athleteId, threadId, {
      dealId:     thread.deal_id,
      fromStatus: thread.status,
      toCategory: String(cls.category),
      reason:     `Re-read as ${String(cls.category).toLowerCase()} — set aside as not a deal`,
    });
  }

  if (paymentInput && payment) await placePaperwork({ ...paymentInput, threadId });

  logger.info({ athleteId, threadId, category: cls.category, isDeal, outcome, payment }, "Thread reclassified");
  return { ok: true, thread: updated, classification: cls, outcome, previous_category, previous_media_kind, dry_run: false, ...(payment !== undefined ? { payment } : {}) };
}
