/**
 * askTerms.ts — WS4 "Ask for terms" batch PROPOSE endpoint (review-first, co-pilot).
 *
 * ONE endpoint: POST /api/v1/me/deals/ask-terms-batch  { dealIds: string[] }
 *
 * For each selected deal it composes a request-terms reply and creates a
 * `pending_action` (kind `send_reply`, reply_intent `request_terms`) in status
 * `pending`. That is ALL it does. It NEVER sends: creating a pending action is inert
 * (same guarantee as pendingActions.ts). Sending happens ONLY when the athlete
 * approves each pending action through the EXISTING approve endpoint
 * (POST /pending-actions/:id/approve), which the client calls in a paced loop after
 * the athlete taps the final confirm. There is no new send path here.
 *
 * Money-safety: the composed body is a deterministic request-terms template — it asks
 * for budget / deliverables / usage / timeline and NEVER names a rate. A deal that
 * already has a price is skipped (asking for terms on a priced deal is wrong), as are
 * settled, filed, or un-repliable threads. Per-athlete ownership is enforced on every
 * deal, and the batch is capped.
 */

import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxThreads, inboxMessages, pendingActions, athletes } from "../../shared/schema";
import { requireAuth } from "../lib/auth";
import { buildGreeting, buildSignature, assembleReplyEmail, type ReplySignaturePref } from "../lib/draftFormat";
import { createLogger } from "../logger";
import { readThreadConversation } from "../services/liveConversation";
import { effectiveDealStatus } from "../lib/observedStage";
import { effectiveQualification } from "../skills/dealQualification";

const logger = createLogger("routes/askTerms");
const router = Router();

// Hard cap per batch — a co-pilot control, not a blast tool. The design ships
// "fresh only" (~18) first; even the full unpriced pile (~77) sits well under this.
const MAX_BATCH = 100;

// Proposals shouldn't be approvable forever — give the batch a 7-day TTL (matches the
// pendingActions "stale proposal" contract).
const PROPOSAL_TTL_MS = 7 * 86_400_000;

const DAY_MS = 86_400_000;
const FRESH_MAX_DAYS = 30;
const QUIET_MAX_DAYS = 90;

export type AskSegment = "fresh" | "agency" | "quiet" | "old";
export type MissingTerm = "price" | "deliverables" | "timeline";

// ─── Per-deal missing-terms detection (from structured fields — no LLM) ─────────
// Each email asks ONLY for what's genuinely unresolved for THAT brand, computed from
// the fields the classifier + threadSummarizer already extract. Never a uniform blast.

// Cash-bearing offer_struct units (a real guaranteed fee). gifting_only / commission_only
// / null are NOT cash → the price is still open.
const CASH_UNITS = new Set(["per_post", "per_deliverable", "total", "monthly", "annual", "per_appearance"]);

export interface MissingTermsResult {
  missing:      MissingTerm[];
  /** Whether to append the light "confirm usage rights + exclusivity" line — only for
   *  deals that look like a genuine paid partnership (we don't gap-detect usage cleanly). */
  includeUsage: boolean;
}

/**
 * Which terms are genuinely unresolved for a deal, from the structured extraction:
 *   · PRICE       — classification.offer_amount null AND offer_struct shows no cash
 *                   (unit gifting_only / commission_only / null, amount null/0).
 *   · DELIVERABLES— classification.deliverables empty AND offer_struct.deliverable_counts null/0.
 *   · TIMELINE    — classification.deadline null AND key_details.deadlines empty.
 * USAGE/EXCLUSIVITY isn't extracted as a clean field, so we don't claim to gap-detect it —
 * we only append a brief confirm line when the deal has/expects cash (not gifting-only).
 * Exported for unit tests.
 */
export function computeMissingTerms(classification: any, conversationState: any): MissingTermsResult {
  const kd    = conversationState?.key_details ?? {};
  const os    = kd?.offer_struct ?? {};
  const unit  = os?.unit ?? null;

  const cashAmount = typeof os?.amount === "number" && os.amount > 0;
  const hasCash    = cashAmount || CASH_UNITS.has(unit);
  const priceMissing = (classification?.offer_amount == null) && !hasCash;

  const declaredDeliverables = Array.isArray(classification?.deliverables) && classification.deliverables.length > 0;
  const counts = os?.deliverable_counts;
  const countTotal = counts && typeof counts === "object"
    ? Object.values(counts).reduce((s: number, v: any) => s + (typeof v === "number" ? v : 0), 0)
    : 0;
  const deliverablesMissing = !declaredDeliverables && !(countTotal > 0);

  const hasClassDeadline = classification?.deadline != null && String(classification.deadline).trim() !== "";
  const hasThreadDeadlines = Array.isArray(kd?.deadlines) && kd.deadlines.length > 0;
  const timelineMissing = !hasClassDeadline && !hasThreadDeadlines;

  const missing: MissingTerm[] = [];
  if (priceMissing)        missing.push("price");
  if (deliverablesMissing) missing.push("deliverables");
  if (timelineMissing)     missing.push("timeline");

  // Paid-looking = has/expects cash and isn't explicitly gifting-only. Newsletter/gifting
  // inbounds (unit gifting_only) skip the usage/exclusivity line.
  const includeUsage = unit !== "gifting_only";

  return { missing, includeUsage };
}

// Human-facing label for a missing term (surfaced on the row + used in copy).
const TERM_LABEL: Record<MissingTerm, string> = {
  price:        "budget",
  deliverables: "deliverables",
  timeline:     "timeline",
};

// The phrase each missing term contributes to the ask sentence.
const TERM_PHRASE: Record<MissingTerm, string> = {
  price:        "the budget or fee you're working with",
  deliverables: "the deliverables and scope you have in mind",
  timeline:     "your ideal timeline",
};

/** "the budget or fee…, the deliverables…, and your ideal timeline" (Oxford-joined). */
function joinPhrases(terms: MissingTerm[]): string {
  const parts = terms.map((t) => TERM_PHRASE[t]);
  if (parts.length === 0) return "the budget, the deliverables and scope, and your timeline"; // defensive fallback
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

// Variant-flavored opener + closer (age × sender-type) so no two read identically. The
// MIDDLE (the actual ask) is assembled from the missing terms, so it's brand-specific.
const OPENER: Record<AskSegment, string> = {
  fresh: "Thanks so much for reaching out — I'd genuinely love to explore this.",
  agency: "Thanks for thinking of me for this — I'm happy to take a look.",
  quiet: "Thanks for your patience — this one stayed on my list, and I'd love to pick it back up if it's still open.",
  old: "I know it's been a while — apologies for the slow follow-up. If there's still interest on your end, I'd be glad to revisit this.",
};
const CLOSER: Record<AskSegment, string> = {
  fresh: "Once I have that, I can come back to you quickly with a clear answer.",
  agency: "With that in hand I can turn around a clear response.",
  quiet: "That'll let me give you a straight answer.",
  old: "No pressure at all if the moment has passed.",
};

/**
 * Compose the full request-terms reply (greeting + brand-specific ask + signature).
 * Asks ONLY for the `missing` terms; appends a brief usage/exclusivity confirm only when
 * `includeUsage`. Pure + exported so tests can assert no rate leaks, the variant, and
 * that only the missing terms are requested. NEVER contains a dollar figure.
 */
export function composeRequestTermsBody(input: {
  segment:         AskSegment;
  missing:         MissingTerm[];
  includeUsage:    boolean;
  brandName:       string | null;
  senderName:      string | null;
  athleteFullName: string | null;
  signaturePref:   ReplySignaturePref | null;
}): string {
  const greeting  = buildGreeting({ senderName: input.senderName, brandName: input.brandName });
  const lead      = input.segment === "agency" ? "To put real terms on the table, could you send over your client's side on" : "To see if it's the right fit, could you share a bit more on";
  const ask       = `${lead} ${joinPhrases(input.missing)}?`;
  const usageLine = input.includeUsage ? " It'd also be good to confirm usage rights (paid ads or whitelisting, and duration) and any exclusivity." : "";
  const body      = `${OPENER[input.segment]} ${ask}${usageLine}\n\n${CLOSER[input.segment]}`;
  const signature = buildSignature(input.signaturePref, input.athleteFullName);
  return assembleReplyEmail({ greeting, body, signature });
}

/** The human labels for what an email asks (for the row's "asking for: …" line). */
export function askingLabels(missing: MissingTerm[], includeUsage: boolean): string[] {
  const labels = missing.map((t) => TERM_LABEL[t]);
  if (includeUsage) labels.push("usage");
  return labels;
}

/** Server-side segment (mirrors client askTermsLogic.segmentOf): sender-type wins,
 *  else age bucket from the thread's last activity. */
export function segmentFor(params: {
  viaAgency:    boolean;
  lastActivity: Date | null;
  now:          Date;
}): AskSegment {
  if (params.viaAgency) return "agency";
  const ms = params.lastActivity ? params.lastActivity.getTime() : NaN;
  const age = isFinite(ms) ? Math.max(0, Math.floor((params.now.getTime() - ms) / DAY_MS)) : 0;
  if (age < FRESH_MAX_DAYS) return "fresh";
  if (age < QUIET_MAX_DAYS) return "quiet";
  return "old";
}

// A deal counts as PRICED (→ not an ask-for-terms candidate) if it has a stated amount — on the deal,
// or in the summariser's structured offer (offer_struct.amount, or any stated figure in amounts[]).
// The retired scorer's economicsState.state ("priced") was derived from exactly those stated figures;
// it went with inbox_threads.score (0088).
function isPriced(dealAmount: string | null, conversationState: any): boolean {
  const positive = (v: unknown) => { const n = typeof v === "string" ? Number(v) : v; return typeof n === "number" && isFinite(n) && n > 0; };
  if (positive(dealAmount)) return true;
  const kd = conversationState?.key_details ?? null;
  if (positive(kd?.offer_struct?.amount)) return true;
  return Array.isArray(kd?.amounts) && kd.amounts.some(positive);
}

/**
 * Does this thread need terms asked for? Opportunities PR 1: the thread's qualification
 * (written by the classify on every message) is the answer when it exists — only
 * `needs_terms` qualifies. Threads qualified before PR 1 have no field and fall back to the
 * old "unpriced" rule. Returns the skip reason, or null when the deal is a candidate.
 * Exported for unit tests.
 */
export function needsTermsSkip(
  classification: unknown,
  dealAmount: string | null,
  conversationState: unknown,
): "already_priced" | "not_needs_terms" | "unverifiable_sender" | null {
  // Never ask a sender we can't verify for terms in a one-tap batch: an unverifiable channel is
  // answered one at a time, by her, from its own card (or verified first).
  if ((classification as { channel?: unknown } | null)?.channel === "unverifiable") return "unverifiable_sender";
  // An interview / press ask or a school request is answered, never asked for a budget.
  const cat = (classification as { category?: unknown } | null)?.category;
  if (cat === "MEDIA" || cat === "SCHOOL_NIL") return "not_needs_terms";
  // A stored "workable" that names no amount (paid, no figure) is needs_terms: there is nothing to accept yet.
  const stored = (classification as { qualification?: unknown } | null)?.qualification;
  const q = typeof stored === "string" && stored.length > 0
    ? effectiveQualification(classification, {
        statedCash: isPriced(dealAmount, conversationState) ? 1 : null,
        offerUnit: (conversationState as any)?.key_details?.offer_struct?.unit ?? null,
      }) ?? stored
    : stored;
  if (typeof q === "string" && q.length > 0) {
    if (q === "needs_terms") return null;
    return q === "below_floor" || q === "workable" ? "already_priced" : "not_needs_terms";
  }
  return isPriced(dealAmount, conversationState) ? "already_priced" : null;
}

type SkipReason =
  | "not_found" | "not_open" | "already_priced" | "no_thread" | "filed"
  | "gifting_only" | "commission_only" | "declined" | "not_needs_terms"
  | "mailbox_unavailable" | "unverifiable_sender";

// ─── POST /api/v1/me/deals/ask-terms-batch ─────────────────────────────────────

router.post("/deals/ask-terms-batch", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const now = new Date();

  const { dealIds } = req.body as { dealIds?: unknown };
  if (!Array.isArray(dealIds) || dealIds.some((d) => typeof d !== "string")) {
    res.status(400).json({ error: "dealIds must be an array of strings" });
    return;
  }
  // Dedup + drop empties. A caller can't propose the same deal twice in one batch.
  const uniqueIds = Array.from(new Set((dealIds as string[]).map((s) => s.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) {
    res.status(400).json({ error: "dealIds must contain at least one deal" });
    return;
  }
  if (uniqueIds.length > MAX_BATCH) {
    res.status(400).json({ error: `A batch can hold at most ${MAX_BATCH} deals (got ${uniqueIds.length})` });
    return;
  }

  // Athlete identity for the deterministic email frame (greeting/signature).
  const [athlete] = await db
    .select({ full_name: athletes.full_name, deal_preferences: athletes.deal_preferences })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  const prefs         = (athlete?.deal_preferences ?? null) as any;
  const signaturePref = (prefs?.reply_signature ?? null) as ReplySignaturePref | null;

  const created: any[] = [];
  const skipped: { deal_id: string; reason: SkipReason }[] = [];

  for (const dealId of uniqueIds) {
    // Ownership + the deal's economics.
    const [deal] = await db
      .select({ id: deals.id, brand_name: deals.brand_name, amount: deals.amount, status: deals.status })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
      .limit(1);
    if (!deal) {
      skipped.push({ deal_id: dealId, reason: "not_found" });
      continue;
    }
    if (!["detected", "pending", "negotiating"].includes(deal.status ?? "")) {
      skipped.push({ deal_id: dealId, reason: "not_open" });
      continue;
    }

    // The deal's thread (target of the reply) + its classification.
    const [thread] = await db
      .select({
        id:                 inboxThreads.id,
        status:             inboxThreads.status,
        last_message_at:    inboxThreads.last_message_at,
        classification:     inboxThreads.classification,
        conversation_state: inboxThreads.conversation_state,
      })
      .from(inboxThreads)
      .where(and(eq(inboxThreads.deal_id, dealId), eq(inboxThreads.athlete_id, athleteId)))
      .limit(1);

    if (!thread) {
      skipped.push({ deal_id: dealId, reason: "no_thread" });
      continue;
    }
    // The summarizer reading the thread as signed means terms are past asking — protect it from a
    // request-terms (max(status, observed); the status itself is not changed).
    if (!["detected", "pending", "negotiating"].includes(effectiveDealStatus(deal.status, thread.conversation_state) ?? "")) {
      skipped.push({ deal_id: dealId, reason: "not_open" });
      continue;
    }
    if (thread.status === "archived") {
      // Filed / set aside — asking would reopen a killed deal.
      skipped.push({ deal_id: dealId, reason: "filed" });
      continue;
    }
    const termsSkip = needsTermsSkip(thread.classification, deal.amount, thread.conversation_state);
    if (termsSkip) {
      // Already priced / termed → a negotiate or a reply, not a request-terms. Or the thread
      // qualified as something that is not a terms conversation at all (verify first, not relevant).
      skipped.push({ deal_id: dealId, reason: termsSkip });
      continue;
    }

    // Value qualification (defense-in-depth; the client predicate already filters these,
    // but the endpoint must never propose on a low-value thread if one is passed in).
    const unit = (thread.conversation_state as any)?.key_details?.offer_struct?.unit ?? null;
    if (unit === "gifting_only") {
      // No budget to ask for — that's the Gifting pile (silence = pass).
      skipped.push({ deal_id: dealId, reason: "gifting_only" });
      continue;
    }
    if (unit === "commission_only") {
      // Commission/referral — no fixed fee to qualify.
      skipped.push({ deal_id: dealId, reason: "commission_only" });
      continue;
    }

    // Must have an inbound message to reply to (and a name for the greeting).
    // Existence + id only; the stored sender name is read below ONLY when no live reader
    // applies (flag off, or Instagram) — never on the live path.
    const [lastInbound] = await db
      .select({ id: inboxMessages.id })
      .from(inboxMessages)
      .where(and(eq(inboxMessages.thread_id, thread.id), eq(inboxMessages.direction, "inbound")))
      .orderBy(desc(inboxMessages.received_at))
      .limit(1);
    if (!lastInbound) {
      skipped.push({ deal_id: dealId, reason: "no_thread" });
      continue;
    }

    // MAILBOX_LIVE_READS: the greeting's name comes from the conversation as the mailbox
    // holds it now. Unreadable (disconnected / deleted) → skip this deal with the reason:
    // a request-terms email can't go out through a mailbox we can't read, and nothing
    // about the deal changes.
    let senderName: string | null = null;
    const live = await readThreadConversation(athleteId, thread.id);
    if (live && !live.ok) {
      skipped.push({ deal_id: dealId, reason: "mailbox_unavailable" });
      continue;
    }
    if (live?.ok) {
      senderName = [...live.messages].reverse().find((m) => m.direction === "inbound")?.fromName ?? null;
    } else {
      const [stored] = await db
        .select({ sender_name: inboxMessages.sender_name })
        .from(inboxMessages)
        .where(eq(inboxMessages.id, lastInbound.id))
        .limit(1);
      senderName = stored?.sender_name ?? null;
    }

    const viaAgency = (thread.classification as any)?.via_agency === true;
    const segment   = segmentFor({ viaAgency, lastActivity: thread.last_message_at ?? null, now });

    // Per-deal gap analysis: ask ONLY for the terms genuinely unresolved for THIS brand.
    const { missing, includeUsage } = computeMissingTerms(thread.classification, thread.conversation_state);
    const asking = askingLabels(missing, includeUsage);

    const body = composeRequestTermsBody({
      segment,
      missing,
      includeUsage,
      brandName:       deal.brand_name,
      senderName,
      athleteFullName: athlete?.full_name ?? null,
      signaturePref,
    });

    // Create the proposal — status 'pending', NO send. Approve (existing endpoint)
    // is the only path that executes it.
    const [row] = await db
      .insert(pendingActions)
      .values({
        athlete_id: athleteId,
        deal_id:    dealId,
        thread_id:  thread.id,
        kind:       "send_reply",
        status:     "pending",
        payload: {
          body,
          reply_intent: "request_terms",
          source:       "ask_terms_batch",
          segment,
          // What THIS email asks for (only the missing terms) — surfaced on the row.
          asking,
          missing,
        },
        expires_at: new Date(now.getTime() + PROPOSAL_TTL_MS),
      })
      .returning();

    created.push(row);
  }

  logger.info(
    { athleteId, requested: uniqueIds.length, created: created.length, skipped: skipped.length },
    "Ask-terms batch proposed (nothing sent — awaiting per-action approval)",
  );

  // 201: proposals created. Nothing has been sent. The client approves each (paced)
  // to actually send. `skipped` explains any deal that didn't become a proposal.
  res.status(201).json({ created, skipped, cap: MAX_BATCH });
});

// ─── PATCH /api/v1/me/deals/ask-terms/:id ──────────────────────────────────────
// Edit the EXACT email body of a proposed (not-yet-approved) ask-terms row, so the
// athlete can tweak wording before it sends. Still inert — editing a pending proposal
// sends nothing; approve remains the only send path, and it reads this body verbatim.
// The trust guarantee: what the athlete reads/edits here is byte-for-byte what goes out.

const MAX_BODY_LEN = 4000;

router.patch("/deals/ask-terms/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const id        = req.params.id;

  const { body } = req.body as { body?: unknown };
  if (typeof body !== "string" || !body.trim()) {
    res.status(400).json({ error: "body is required" });
    return;
  }
  if (body.length > MAX_BODY_LEN) {
    res.status(400).json({ error: `body must be at most ${MAX_BODY_LEN} characters` });
    return;
  }

  const [pa] = await db
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.id, id), eq(pendingActions.athlete_id, athleteId)))
    .limit(1);

  if (!pa) {
    res.status(404).json({ error: "Pending action not found" });
    return;
  }
  // Only an ask-terms proposal that hasn't been acted on can be edited.
  if (pa.status !== "pending") {
    res.status(409).json({ error: `Pending action is already ${pa.status}` });
    return;
  }
  if ((pa.payload as any)?.source !== "ask_terms_batch") {
    res.status(400).json({ error: "Not an ask-terms proposal" });
    return;
  }

  const nextPayload = { ...(pa.payload as Record<string, unknown>), body, edited: true };
  const [updated] = await db
    .update(pendingActions)
    .set({ payload: nextPayload })
    .where(eq(pendingActions.id, id))
    .returning();

  logger.info({ athleteId, pendingActionId: id }, "Ask-terms proposal edited (still pending — nothing sent)");
  res.json(updated);
});

export default router;
