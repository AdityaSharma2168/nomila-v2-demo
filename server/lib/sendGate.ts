/**
 * sendGate.ts — the ONE definition of "can this reply card offer a Send button".
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * The rule used to be written out three times, independently:
 *
 *   server/mila/tools/draftReply.ts   the text tool's own `sendable`
 *   server/mila/widgets.ts            the text CARD builder, which re-derives it
 *   server/voice/draftIntentRoute.ts  the voice resolve
 *
 * Two of the three agreed. `widgets.ts` did not: it checked thread, platform and
 * draft, and silently dropped the INBOUND term. Its comment said it recomputed
 * "from the gates so the card can't offer Send on an Outlook/thread-less/refused
 * draft" — three gates listed, four gates required.
 *
 * The consequence was a live bug, not a tidiness problem. A thread the brand has
 * not written into yet has a thread id, a gmail platform and a perfectly good
 * draft — so the text card rendered "Review & Send", and tapping it reached
 * `sendThreadReply`, which refuses at its first check:
 *
 *     if (!lastInbound) return { ok: false, status: 400,
 *                                error: "No inbound messages to reply to" }
 *                                      — server/services/threadReply.ts
 *
 * The client surfaced that as the generic "Couldn't send your reply. Please try
 * again." — a lie, because retrying cannot produce an inbound message. Voice, which
 * kept the term, correctly showed its no-in-app-send footer for the same deal, so
 * the two surfaces disagreed about the same thread.
 *
 * `draftIntentRoute` already carried the warning that made this predictable: "If
 * the two disagreed, a card's Send gate would promise something the send route
 * refuses." It was right; there were three, and one drifted.
 *
 * ── What this is, and what it is NOT ─────────────────────────────────────────
 * STRUCTURAL only: is there a real reply path on the wire. It deliberately does
 * not know about draft text or refusals — voice has no draft at the point it
 * decides (the client generates the body afterwards), so a gate that required one
 * could not be shared. Callers that also hold a draft AND it with their own
 * checks; see `isSendableWithDraft`.
 *
 * This is a UX gate. `sendThreadReply` re-derives everything authoritatively at
 * send time and is the only thing that actually guarantees anything. The point of
 * this file is that the button and the send route agree about when to appear.
 */

import { replyPlatform, sendablePlatforms } from "./replyPlatforms";

/**
 * Platforms with a real in-app send path RIGHT NOW — derived from the one platform table
 * (lib/replyPlatforms.ts) that `sendThreadReply` also dispatches through, so the button and the
 * send route cannot disagree about a platform. Outlook is in it only while OUTLOOK_SEND is on.
 */
export { sendablePlatforms };

/** Is `platform` one a reply can be sent on right now (the table has a sender and its switch is on). */
export function isSendablePlatform(platform: string): boolean {
  return replyPlatform(platform)?.enabled() === true;
}

/** What every caller can see about a deal's reply path before any draft exists. */
export interface ReplyPathFacts {
  /** The thread to reply into, or null when the deal has none. */
  threadId: string | null;
  /**
   * Whether that thread holds at least one INBOUND message. The send route
   * replies TO the newest inbound, so with none there is nothing to reply to and
   * no recipient address to reply to it at.
   */
  hasInbound: boolean;
  /** Platform of the newest inbound — the exact row `sendThreadReply` answers. */
  platform: string;
}

/**
 * The structural send gate. All four terms, in one place.
 *
 * Mirrors `sendThreadReply`'s own preconditions: it looks up the thread, requires
 * a `lastInbound`, and switches on that inbound's platform.
 */
export function isStructurallySendable(facts: ReplyPathFacts): boolean {
  return (
    facts.threadId !== null &&
    facts.hasInbound &&
    isSendablePlatform(facts.platform)
  );
}

/**
 * The structural gate AND the draft-dependent half, for callers that have already
 * produced copy: a card with no draft has nothing to send, and a refusal must
 * never be sendable.
 *
 * Split from `isStructurallySendable` rather than folded in because voice decides
 * before any draft exists — see the header.
 */
export function isSendableWithDraft(
  facts: ReplyPathFacts,
  copy: { draft: string | null; refusal: string | null },
): boolean {
  return (
    copy.draft !== null && copy.refusal === null && isStructurallySendable(facts)
  );
}
