/**
 * getDeal.ts — Mila read tool: one deal in full, with its thread summary.
 *
 * IDOR guard: the model supplies `deal_id`, but the query ANDs it with the
 * server-injected athleteId, so another athlete's deal_id resolves to null.
 * A uuid-format guard returns null before the query so a malformed id can't
 * throw a Postgres cast error. The linked thread's subject/summary are
 * email-derived (attacker-controlled) and are wrapped in <external_content>.
 */

import { z } from "zod";
// Wraps external text as data the model must never obey, with any smuggled delimiter neutralised.
import { external } from "../../lib/externalContent";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { deals, inboxThreads } from "../../../shared/schema";
import { MILA } from "../config";
import { resolveVoiceOffer } from "../offerMoney";
import type { MilaTool } from "../types";
import { withoutDealScore } from "./modelView";
import { mailboxZeroRetentionEnabled } from "../../lib/mailbox/retention";
import { derivedThreadTitle } from "../../lib/threadTitle";

const getDealArgs = z.object({
  deal_id: z.string().describe("The id of the deal to fetch."),
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


const toNumber = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const getDealTool: MilaTool<typeof getDealArgs> = {
  name: "get_deal",
  description:
    "Get one deal in detail by its id: brand, amount, status, type, source, " +
    "and a summary of the linked email thread if there is one. Also returns " +
    "`offer`: the money resolved from the live thread (amount or low/high span, " +
    "what it buys, whether it recurs, any commission) plus `offer.deliverables` " +
    "— the real per-type counts, e.g. two reels and three stories, which is far " +
    "more specific than `deal_type`. `offer.moneyState` says whether the figure " +
    "is confirmed, a span, uncorroborated, or simply never named; prefer " +
    "`offer.amount` over `amount`, which is a stale detection-time snapshot. " +
    "Returns null if " +
    "the deal doesn't exist or doesn't belong to this athlete. Calling this also " +
    "surfaces that deal's card inline in the chat, so use it to spotlight the one " +
    "specific deal your answer is about.",
  argsSchema: getDealArgs,
  // The retired 1–10 score and its verdict never reach a model (owner decision, 5 Oct 2026).
  // `verdict`/`score_numeric` stay on the raw result only for the chat card ring, which the
  // screens PR removes. See ./modelView.
  modelView: (result) => withoutDealScore(result),
  async execute(athleteId, args) {
    // Malformed id → null, never a DB cast error.
    if (!UUID_RE.test(args.deal_id)) return null;

    const [deal] = await db
      .select({
        id: deals.id,
        brand_name: deals.brand_name,
        amount: deals.amount,
        status: deals.status,
        deal_type: deals.deal_type,
        source: deals.source,
        detected_at: deals.detected_at,
        created_at: deals.created_at,
        negotiation_state: deals.negotiation_state,
        // Read for ONE key — `deliverables`, the classifier's untrusted string
        // list — which `resolveVoiceOffer` parses into integers. The rest of the
        // blob (summary, contact_name, contact_email, deadline, thread ids) is
        // PII and prose and is never returned; `raw_data` itself must stay out
        // of `result` below.
        raw_data: deals.raw_data,
      })
      .from(deals)
      // IDOR guard: deal_id is only ever ANDed with the server-side athleteId.
      .where(and(eq(deals.id, args.deal_id), eq(deals.athlete_id, athleteId)))
      .limit(1);

    if (!deal) return null;

    const [thread] = await db
      .select({
        id: inboxThreads.id,
        // Zero retention: no stored subject is read; a Nomila-written title stands in.
        subject: mailboxZeroRetentionEnabled() ? sql<string | null>`NULL` : inboxThreads.subject,
        summary: inboxThreads.summary,
        // Read for its STRUCTURED money fields only, via `resolveVoiceOffer`.
        // The column also holds prose (`conversation_state`, `offer_display`,
        // `key_details.offer`) which is model-written from brand email — none of
        // it is returned, and the resolver has no path to reach it.
        conversation_state: inboxThreads.conversation_state,
      })
      .from(inboxThreads)
      .where(
        and(
          eq(inboxThreads.deal_id, deal.id),
          eq(inboxThreads.athlete_id, athleteId),
        ),
      )
      .orderBy(desc(inboxThreads.last_message_at))
      .limit(1);

    const result: Record<string, unknown> = {
      id: deal.id,
      brand_name: deal.brand_name,
      amount: toNumber(deal.amount),
      // The SPEAKABLE offer, resolved from the thread's structured fields.
      // `amount` above is `deals.amount` — a detection-time snapshot that drifts
      // stale (server/lib/dealVoice.ts:14-17 forbids speaking it). The voice
      // wire maps its money from THIS and drops the column at the boundary; the
      // column stays here because the chat widgets still key off it.
      offer: resolveVoiceOffer(
        thread?.conversation_state,
        deal.amount != null,
        toNumber(deal.amount),
        // Only the one key crosses into the parser, and only integers come back.
        (deal.raw_data as { deliverables?: unknown } | null)?.deliverables,
      ),
      status: deal.status,
      deal_type: deal.deal_type,
      source: deal.source,
      detected_at: deal.detected_at,
      created_at: deal.created_at,
      // The 1–10 deal score is retired (owner decision, 6 Oct 2026): nothing is scored any more.
      verdict: null,
      score_numeric: null,
      // The linked thread's id — an opaque nav handle so a chat nav-chip can open
      // this exact deal (which the app renders as its Thread screen). null when the
      // deal has no thread. A uuid, not email text, so it stays outside
      // <external_content>; the deal_card widget never carries it.
      thread_id: thread?.id ?? null,
      negotiation_state: deal.negotiation_state,
      thread: thread
        ? {
            subject: external(
              mailboxZeroRetentionEnabled()
                ? derivedThreadTitle({ brandName: deal.brand_name, conversationState: thread.conversation_state })
                : thread.subject,
            ),
            summary: external(thread.summary),
          }
        : null,
    };

    // Budget guard: drop the unbounded jsonb first, then the thread text, so the
    // core scalar fields always survive.
    if (JSON.stringify(result).length > MILA.TOOL_RESULT_MAX_CHARS) {
      result.negotiation_state = null;
      result.truncated = true;
    }
    if (JSON.stringify(result).length > MILA.TOOL_RESULT_MAX_CHARS) {
      result.thread = null;
    }
    return result;
  },
};
