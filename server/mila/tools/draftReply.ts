/**
 * draftReply.ts — Mila's ONE action-shaped tool: draft a brand reply for review.
 *
 * It DRAFTS ONLY. It never sends, never creates a pending action, never writes an
 * outbound row — the send is a deliberate on-screen tap the athlete makes on the
 * reply_action card (client hook → pending-actions propose→approve). This tool is
 * the "Generate" step, run server-side so the client never has to stream the draft
 * on device (that SSE path is the unfixed native bug); the finished, strip-guarded
 * copy ships as widget DATA.
 *
 * IDOR guard: the model supplies `deal_id`, but every query ANDs it with the
 * server-injected athleteId, so another athlete's deal_id resolves to null. Platform
 * is read from the thread's latest inbound message — the SAME `lastInbound.platform ??
 * "gmail"` the send route decides on — so the card's Send gate can't disagree with it.
 * The actual drafting reuses the shared `generateDealDraft` core (same three
 * strip-guards as the reply endpoint), so no scoring/prompt internals reach the card.
 */

import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { deals, inboxThreads, inboxMessages } from "../../../shared/schema";
import {
  generateDealDraft,
  type GenerateDealDraftResult,
} from "../../services/dealDraft";
import { createLogger } from "../../logger";
import { isSendableWithDraft } from "../../lib/sendGate";
import { resolveReplyThread } from "../../lib/replyThread";
import type { MilaTool } from "../types";

const logger = createLogger("mila/tools/draftReply");

// Honest, deterministic copy shown when drafting fails (generation error or an
// unexpected throw). It renders as a no-Send refusal card so the failure never
// depends on model prose — no fabricated "glitch", no nudge to send manually.
const DRAFT_UNAVAILABLE =
  "I couldn't draft that reply right now. Want me to try again?";

const draftReplyArgs = z.object({
  deal_id: z
    .string()
    .describe(
      "The id of the deal to draft a reply for (from list_deals / get_deal).",
    ),
  reply_intent: z
    .enum(["accept", "negotiate", "request_terms", "decline"])
    .describe(
      "What the reply should do: accept (express interest, ask next steps), negotiate " +
        "(counter on terms), request_terms (ask for scope/budget on a vague inbound, name no rate), " +
        "or decline (pass warmly).",
    ),
  style: z
    .enum(["friendly", "professional"])
    .default("friendly")
    .describe("Tone of the draft. Defaults to friendly."),
  voice: z
    .enum(["athlete", "agent"])
    .default("athlete")
    .describe(
      "Who signs it: the athlete themselves, or their team/agent. Defaults to athlete.",
    ),
  selected_terms: z
    .array(z.string())
    .optional()
    .describe(
      "For negotiate only: the specific terms to push on (e.g. 'Rate', 'Usage rights', 'Timeline').",
    ),
  custom_instruction: z
    .string()
    .optional()
    .describe(
      "A free-text nudge for the draft's tone or focus, e.g. 'keep it warm, mention the timeline'. " +
        "Figures are removed from it: the only rate a reply may state is one the athlete typed.",
    ),
  include_media_kit: z
    .boolean()
    .optional()
    .describe(
      "Offer to share the athlete's media kit at the end of the reply.",
    ),
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const draftReplyTool: MilaTool<typeof draftReplyArgs> = {
  name: "draft_reply",
  description:
    "Draft a reply to a brand for one of the athlete's deals and surface it as an " +
    "interactive Draft Reply card the athlete can review, edit, and SEND with a tap. " +
    "Use this when the athlete wants to respond to a deal — accept, negotiate, ask for " +
    "terms, or decline. This ONLY drafts; it never sends. Returns null if the deal isn't " +
    "theirs or doesn't exist. After calling it, tell the athlete you've drafted the reply " +
    "for them to review and send — do NOT paste the draft text into your message (it's on " +
    "the card) and NEVER say you've sent or will send it; only their tap on Send sends.",
  argsSchema: draftReplyArgs,
  // Drafting calls a model, so it runs well past the 8s read-tool default. The
  // service's own stream guards bound the actual Vertex call; this is the loop's
  // backstop, generous enough for one negotiate leak-retry.
  timeoutMs: 90_000,
  async execute(athleteId, args) {
    // Malformed id → null, never a DB cast error (matches get_deal).
    if (!UUID_RE.test(args.deal_id)) return null;

    // IDOR: the deal must belong to this athlete.
    const [deal] = await db
      .select({ id: deals.id, brand_name: deals.brand_name })
      .from(deals)
      .where(and(eq(deals.id, args.deal_id), eq(deals.athlete_id, athleteId)))
      .limit(1);
    if (!deal) return null;

    // The thread to reply into — the ONE reply-thread resolver draft, propose and send share
    // (lib/replyThread), scoped by athleteId too (defense in depth).
    const resolvedThread = await resolveReplyThread(athleteId, deal.id);
    const thread = resolvedThread.ok && resolvedThread.threadId ? { id: resolvedThread.threadId } : null;

    // Platform + recipient come from the thread's latest INBOUND message — exactly
    // the row `sendThreadReply` replies to. No inbound → nothing to reply to.
    let platform = "gmail";
    let hasInbound = false;
    if (thread) {
      const [lastInbound] = await db
        .select({ platform: inboxMessages.platform })
        .from(inboxMessages)
        .where(
          and(
            eq(inboxMessages.thread_id, thread.id),
            eq(inboxMessages.direction, "inbound"),
          ),
        )
        .orderBy(desc(inboxMessages.received_at))
        .limit(1);
      if (lastInbound) {
        hasInbound = true;
        platform = lastInbound.platform ?? "gmail";
      }
    }

    // Draft through the shared, strip-guarded core (deterministic greeting/signature +
    // sanitize + negotiate leak-lint). No onToken — the tool collects the final text.
    // The core is documented not to throw on expected failures, but guard anyway so an
    // unexpected error still surfaces as an honest no-Send card, never a model excuse.
    let result: GenerateDealDraftResult;
    try {
      result = await generateDealDraft({
        athleteId,
        dealId: deal.id,
        replyIntent: args.reply_intent,
        style: args.style,
        voice: args.voice,
        selectedTerms: args.selected_terms,
        // Model-written: every figure is stripped from it before it reaches the draft. A brand
        // email the model read can ask it to "confirm her minimum"; it can't carry a number in.
        instructionSource: "model",
        threadId: thread?.id ?? null,
        customInstruction: args.custom_instruction,
        includeMediaKit: args.include_media_kit,
      });
    } catch (err) {
      logger.warn(
        { athleteId, dealId: deal.id, error: (err as Error).message },
        "draft_reply: generateDealDraft threw",
      );
      result = { ok: false, reason: "gen_error" } as const;
    }

    // A race deleted the deal → no card; the model just notes it's gone.
    if (!result.ok && result.reason === "not_found") return null;

    const draft = result.ok ? result.fullText : null;
    // Every failure renders as an honest no-Send refusal card. The leak refusal keeps
    // its own (route-shared) message; a generation failure gets the honest "couldn't
    // draft right now". NEVER a fabricated cause, NEVER a nudge to send manually.
    const refusal = !result.ok
      ? result.reason === "refusal" || result.reason === "mailbox_unavailable"
        ? result.message
        : DRAFT_UNAVAILABLE
      : null;

    // The Send gate: a real reply path (gmail|instagram) AND a thread with an inbound
    // to reply to AND clean draft copy. The server re-verifies all of this at send
    // time — this is the card's UX gate only.
    //
    // The rule itself lives in server/lib/sendGate.ts and is shared with
    // widgets.ts and the voice resolve. It used to be spelled out here, in
    // widgets.ts and in draftIntentRoute.ts independently, and widgets.ts drifted.
    const sendable = isSendableWithDraft(
      { threadId: thread?.id ?? null, hasInbound, platform },
      { draft, refusal },
    );

    // Widget/model-facing result. Brand-facing draft copy + scalars ONLY — no thread
    // text, no scoring, no prompt internals. `draft` is the single free-text field
    // (the athlete's own guarded outgoing copy). buildWidget re-derives `sendable`.
    //
    // `has_inbound` is on the wire BECAUSE buildWidget re-derives rather than
    // trusting `sendable`, and it cannot re-derive a term it was never given. That
    // is precisely how the inbound term went missing from the text card: computed
    // here, folded into `sendable`, then dropped.
    return {
      deal_id: deal.id,
      thread_id: thread?.id ?? null,
      platform,
      has_inbound: hasInbound,
      sendable,
      brand_name: deal.brand_name,
      draft,
      refusal,
      reply_intent: args.reply_intent,
      style: args.style,
      voice: args.voice,
      selected_terms: args.selected_terms ?? [],
      include_media_kit: !!args.include_media_kit,
    };
  },
};
