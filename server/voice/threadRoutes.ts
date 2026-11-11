/**
 * threadRoutes.ts — the email thread behind one deal, for the voice worker.
 *
 * GET /athletes/:id/deals/:dealId/thread, mounted at /api/internal/voice
 * (server/index.ts).
 *
 * The caller is TRUSTED INFRASTRUCTURE, not a user: there is no session and no
 * `req.athleteId`, so the athlete id comes from the path and the shared secret is
 * the entire authorization boundary. See ./auth for the guard and why the secret
 * is its own rather than shared with CRON_SECRET.
 *
 * ── THIS ROUTE DELIBERATELY CROSSES A LINE ./dealRoutes DREW ──────────────────
 * Read that header first. It reduces the whole thread to a `hasThread` boolean and
 * says, in as many words, that "not one character of external text crosses this
 * boundary". This route exists to carry exactly that text, because the athlete
 * asking "what is this deal actually about?" cannot be answered from a boolean and
 * a grid verdict — the answer is in the brand's own words.
 *
 * So the ban is narrowed, not lifted, and it is worth being precise about what
 * changed and what did not:
 *
 *   - `get_deal` still returns `hasThread` only. Nothing about that route moves.
 *     A caller that does not want email text keeps getting none.
 *   - The text crosses HERE, on a route whose entire purpose is that text, so the
 *     exposure is one endpoint the reader can audit rather than a field quietly
 *     added to a general-purpose payload.
 *   - Everything crossing is ALLOW-LISTED field by field below and bounded in both
 *     count and length. `score`, `classification`, `conversation_state`,
 *     `latest_draft` and `negotiation_state` — untyped jsonb, model-written prose,
 *     nothing an athlete asked for — stay out, same as they do everywhere else.
 *
 * ── WHERE THE <external_content> WRAPPER LIVES, AND WHY NOT HERE ──────────────
 * ./dealRoutes and ./brandBriefRoute both reject the wrapper as an HTTP-layer
 * defence, and that reasoning is CORRECT and unchanged: `<external_content>` is a
 * PROMPT construct. Over HTTP it is decoration — it protects nothing, and it puts
 * a string on the wire that a naive consumer would either read aloud verbatim or
 * have to strip.
 *
 * The wrapper therefore lives at the only boundary where it means anything: the
 * voice worker's tool result, immediately before the text enters a model's context
 * (mila-voice src/agent.ts, `get_thread`). That is also the only consumer this
 * route has. The contract between the two halves is:
 *
 *   this route  — returns thread text as PLAIN, allow-listed, bounded JSON fields
 *                 whose names say what they are (`subject`, `messages[].body`).
 *   the worker  — wraps every one of those strings in <external_content> before
 *                 the model sees them, and neutralizes any closing delimiter
 *                 inside the text so the wrapper cannot be escaped.
 *
 * If you add a consumer of this endpoint, it inherits that obligation. The
 * response is untrusted brand-authored text and is documented as such on every
 * field below.
 *
 * ── TENANCY: three ANDs, not one ─────────────────────────────────────────────
 * The model supplies `:dealId`. It is never trusted on its own:
 *
 *   1. the deal is read with `deal_id AND athlete_id`  — another athlete's deal
 *      resolves to nothing, exactly as `get_deal` does it;
 *   2. the thread is read with `deal_id AND athlete_id` — so even a deal somehow
 *      resolved out of scope cannot drag a thread with it;
 *   3. the messages are read with `thread_id AND athlete_id` — defence in depth
 *      against a thread whose messages were mis-attributed at ingest.
 *
 * Every miss answers 404 with the same body, so "not yours" and "does not exist"
 * are indistinguishable from the outside.
 */

import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxThreads, inboxMessages } from "../../shared/schema";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, UUID_RE } from "./auth";
import { mailboxLiveReadsEnabled } from "../lib/mailbox";
import { readThreadConversation, type LiveUnavailable } from "../services/liveConversation";

const logger = createLogger("voice/thread");

const router = Router();

/**
 * Bounds the whole answer. Three indexed reads, same 2s stalled-pool backstop the
 * other voice routes use — a timeout is a 500 here rather than a degrade, because
 * a partial thread is a worse answer than no thread.
 */
const READ_TIMEOUT_MS = 2_000;

/**
 * Under MAILBOX_LIVE_READS the answer includes one mailbox round-trip (≈0.3–1.5 s, plus
 * retry backoff on a blip), so the backstop is wider. A timeout is still a 500.
 */
const LIVE_READ_TIMEOUT_MS = 8_000;

/**
 * How many messages cross, newest-first at selection then re-ordered oldest-first
 * for reading.
 *
 * A cap is not tidiness. This text lands in a realtime model's context, where it
 * is charged per token on every subsequent turn of the call, and a long
 * back-and-forth thread is unbounded input the athlete never asked to pay for.
 * Ten is roughly a full negotiation and well inside what the model can use.
 */
const MAX_MESSAGES = 10;

/**
 * Per-body character cap, applied AFTER selection so a single enormous message
 * cannot crowd out the rest of the thread.
 *
 * Also a containment property, not only a cost one: the longer the untrusted span
 * inside the wrapper, the more room an injection has to establish a false context.
 * Truncation is marked so the model can say the email goes on rather than
 * implying it has read all of it.
 */
const MAX_BODY_CHARS = 2_000;

/** Subjects are one line by construction; this only catches abuse. */
const MAX_SUBJECT_CHARS = 300;

/** One message as the voice wire carries it. Every string field is UNTRUSTED. */
interface VoiceThreadMessage {
  /**
   * Who sent it, as the brand wrote it. UNTRUSTED — a display name is free text
   * and is a perfectly good place to hide an instruction.
   */
  from: string | null;
  /** 'inbound' (brand -> athlete) or 'outbound' (athlete -> brand). Our own enum. */
  direction: "inbound" | "outbound" | null;
  /** ISO timestamp, or null. Ours, not theirs. */
  receivedAt: string | null;
  /** The email body. UNTRUSTED, and the single most attacker-controlled field here. */
  body: string | null;
  /** True when `body` was cut at MAX_BODY_CHARS. Ours. */
  truncated: boolean;
}

/** The whole answer. `subject` and everything in `messages` is UNTRUSTED. */
interface VoiceThread {
  dealId: string;
  /** The deal's brand name as WE stored it on the deal row. */
  brand: string | null;
  /** The email subject. UNTRUSTED. */
  subject: string | null;
  /** Oldest-first, so the model reads the negotiation in the order it happened. */
  messages: VoiceThreadMessage[];
  /** Total messages on the thread, so a capped answer can say what it left out. */
  totalMessages: number;
}

const DIRECTIONS = new Set(["inbound", "outbound"]);
const directionOf = (v: unknown): "inbound" | "outbound" | null =>
  typeof v === "string" && DIRECTIONS.has(v)
    ? (v as "inbound" | "outbound")
    : null;

const isoOf = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : null;

/** Bound an untrusted string, reporting whether it was cut. */
function clamp(
  text: unknown,
  max: number,
): { text: string | null; truncated: boolean } {
  if (typeof text !== "string") return { text: null, truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

// GET /athletes/:id/deals/:dealId/thread — the brand's own words for one deal.
// 404 when the deal is not this athlete's, when it has no thread, and when the
// thread has no readable messages: all indistinguishable on purpose.
router.get(
  "/athletes/:id/deals/:dealId/thread",
  async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    const voiceAuth = await voiceAuthorized(req, req.params.id);
    if (!voiceAuth.ok) {
      sendVoiceRefusal(res, voiceAuth);
      return;
    }

    const { id, dealId } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid athlete id" });
      return;
    }
    if (!UUID_RE.test(dealId)) {
      res.status(400).json({ error: "Invalid deal id" });
      return;
    }

    try {
      const result = await withTimeout(
        readThread(id, dealId),
        mailboxLiveReadsEnabled() ? LIVE_READ_TIMEOUT_MS : READ_TIMEOUT_MS,
        "voice get_thread",
      );

      // Mailbox unreadable: say why, change nothing. Distinct from the 404 miss so the
      // worker can tell the athlete to reconnect rather than "there is no thread".
      if (result && "unavailable" in result) {
        logger.info(
          { athleteId: id, dealId, tool: "get_thread", outcome: "unavailable", reason: result.unavailable.reason },
          "Voice tool — get_thread",
        );
        res.status(503).json({
          error: result.unavailable.message,
          code: "MAILBOX_UNAVAILABLE",
          reason: result.unavailable.reason,
        });
        return;
      }
      const thread = result;

      if (!thread) {
        logger.info(
          { athleteId: id, dealId, tool: "get_thread", outcome: "miss" },
          "Voice tool — get_thread",
        );
        res.status(404).json({ error: "No thread" });
        return;
      }

      // Shape only. The subject and every body are untrusted email text and are
      // NEVER logged — logging them would put the payload in a second sink that
      // has none of the wrapper discipline the model side has.
      logger.info(
        {
          athleteId: id,
          dealId,
          tool: "get_thread",
          outcome: "hit",
          messages: thread.messages.length,
          totalMessages: thread.totalMessages,
          truncated: thread.messages.filter((m) => m.truncated).length,
          hasSubject: thread.subject !== null,
        },
        "Voice tool — get_thread",
      );
      res.json(thread);
    } catch (err: any) {
      logger.error(
        { athleteId: id, dealId, error: err.message },
        "Voice thread read failed",
      );
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * The three scoped reads. Returns null for every miss so the caller answers one
 * 404 shape and cannot leak which of the three failed.
 */
async function readThread(
  athleteId: string,
  dealId: string,
): Promise<VoiceThread | { unavailable: LiveUnavailable } | null> {
  // 1. The deal, ANDed with the athlete. Same guard as `get_deal`.
  const [deal] = await db
    .select({ id: deals.id, brand: deals.brand_name })
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
    .limit(1);
  if (!deal) return null;

  // 2. The thread, ANDed with the athlete AGAIN rather than trusting step 1.
  const [thread] = await db
    .select({ id: inboxThreads.id, subject: inboxThreads.subject })
    .from(inboxThreads)
    .where(
      and(
        eq(inboxThreads.deal_id, deal.id),
        eq(inboxThreads.athlete_id, athleteId),
      ),
    )
    .orderBy(desc(inboxThreads.last_message_at))
    .limit(1);
  if (!thread) return null;

  // 3′. MAILBOX_LIVE_READS: the brand's words come from the mailbox, read now and kept
  //     nowhere. Same allow-list and bounds as the stored path below. Unreadable →
  //     a typed answer the route turns into 503 with the athlete-facing reason.
  const live = await readThreadConversation(athleteId, thread.id);
  if (live && !live.ok) return { unavailable: live };
  if (live?.ok) {
    if (live.messages.length === 0) return null;
    return {
      dealId: deal.id,
      brand: deal.brand,
      subject: clamp(live.messages[0].subject || null, MAX_SUBJECT_CHARS).text,
      messages: live.messages.slice(-MAX_MESSAGES).map((m) => {
        const { text, truncated } = clamp(m.text, MAX_BODY_CHARS);
        return {
          from: clamp(m.fromName ?? m.fromEmail, 200).text,
          direction: m.direction,
          receivedAt: m.sentAt,
          body: text,
          truncated,
        };
      }),
      totalMessages: live.messages.length,
    };
  }

  // 3. The messages, ANDed with the athlete a third time. Newest-first so the cap
  //    keeps the RECENT end of a long negotiation, which is the part that answers
  //    "what is this about now".
  const rows = await db
    .select({
      senderName: inboxMessages.sender_name,
      direction: inboxMessages.direction,
      receivedAt: inboxMessages.received_at,
      body: inboxMessages.body,
    })
    .from(inboxMessages)
    .where(
      and(
        eq(inboxMessages.thread_id, thread.id),
        eq(inboxMessages.athlete_id, athleteId),
      ),
    )
    .orderBy(desc(inboxMessages.received_at))
    .limit(MAX_MESSAGES);

  if (rows.length === 0) return null;

  // Count separately so a capped answer can say how much it left out.
  const all = await db
    .select({ id: inboxMessages.id })
    .from(inboxMessages)
    .where(
      and(
        eq(inboxMessages.thread_id, thread.id),
        eq(inboxMessages.athlete_id, athleteId),
      ),
    );

  const messages: VoiceThreadMessage[] = rows
    .slice()
    .reverse() // oldest-first for reading
    .map((r) => {
      const { text, truncated } = clamp(r.body, MAX_BODY_CHARS);
      return {
        from: clamp(r.senderName, 200).text,
        direction: directionOf(r.direction),
        receivedAt: isoOf(r.receivedAt),
        body: text,
        truncated,
      };
    });

  return {
    dealId: deal.id,
    brand: deal.brand,
    subject: clamp(thread.subject, MAX_SUBJECT_CHARS).text,
    messages,
    totalMessages: all.length,
  };
}

export default router;
export { MAX_MESSAGES, MAX_BODY_CHARS };
