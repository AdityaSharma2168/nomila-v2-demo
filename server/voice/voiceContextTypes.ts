/**
 * voiceContextTypes.ts — the shape of the voice memory artifact, and nothing else.
 *
 * Split out of ./voiceContext so that consumers which do not touch the database
 * do not import one. ./voiceSeed is a pure function by design and its test runs
 * with no DATABASE_URL; importing `MAX_ENTRIES` (a value, not a type) from the
 * store would have dragged `server/db` in behind it and quietly made that false.
 *
 * Types and closed vocabularies only. No queries, no io, no imports that have
 * side effects.
 */

import type { RecAction } from "../skills/dealScoreGrid";

/** Most recent N kept per list. See the header on why bounded beats faithful. */
export const MAX_ENTRIES = 10;

/**
 * WHERE an entry happened. A closed two-value vocabulary, same class as
 * `OpenTopic` — not a description of the channel, an identifier for it.
 *
 * The artifact is keyed on `conversation_id`, and a conversation spans BOTH
 * surfaces: the browser hands voice the id of the athlete's active chat thread
 * (client/screens/MilaSearchOverlay.tsx), so a voice session and the text
 * session before it write the same row. Without this field the seed cannot tell
 * a call from a chat, and says "you went through their deal" about something the
 * athlete typed.
 *
 * ── Defaults to "voice", and that is load-bearing ────────────────────────────
 * Rows written before this field existed have no `channel`, and there are live
 * ones. The serializer therefore DEFAULTS rather than rejecting — the usual
 * "a required field that fails validation drops the whole entry" rule must not
 * apply here, or the first deploy carrying this change would silently wipe every
 * athlete's existing memory. Voice is the correct default because voice was the
 * only writer that existed when those rows were made.
 */
export const CHANNELS = ["voice", "text"] as const;
export type Channel = (typeof CHANNELS)[number];

/** What a channel-less legacy entry is read as. See `CHANNELS`. */
export const DEFAULT_CHANNEL: Channel = "voice";

/**
 * What was left hanging. A CLOSED vocabulary, derived from which watch-item the
 * worker named — and it names that from the softest TERM GRADE, which is already
 * an enum. So this is a grade→topic mapping, never a phrase→topic one: no text is
 * interpreted to produce it.
 */
export const OPEN_TOPICS = [
  "exclusivity",
  "rate",
  "scope",
  "usage_rights",
  "timing",
] as const;
export type OpenTopic = (typeof OPEN_TOPICS)[number];

/**
 * A deal she gave a read on. Every field is an id, an enum or a timestamp.
 *
 * `recommendationGiven` is OUR reconciled recommendation for the deal, not a
 * record of what she said out loud — the two can differ, because the tool
 * guidance tells her to report the call and then give her own take on top. The
 * seed's wording is careful about that distinction; see ./voiceSeed.
 */
export interface DealDiscussed {
  dealId: string;
  brandId: number | null;
  recommendationGiven: RecAction | null;
  spokenAt: string;
  channel: Channel;
}

/** A brand that came up, deal or not. */
export interface BrandDiscussed {
  brandId: number;
  hadDeal: boolean;
  spokenAt: string;
  channel: Channel;
}

/** A term left open — the watch-item she raised. */
export interface OpenThread {
  topic: OpenTopic;
  dealId: string | null;
  channel: Channel;
}

/**
 * What a reply card can be opened to do. The same four values the draft tools
 * take on both surfaces — voice `open_draft` and text `draft_reply` — restated
 * here because this module must not import from either.
 */
export const REPLY_INTENTS = [
  "accept",
  "negotiate",
  "request_terms",
  "decline",
] as const;
export type ReplyIntentValue = (typeof REPLY_INTENTS)[number];

/**
 * A draft card that was actually OPENED for a deal.
 *
 * The other three lists record what was discussed and decided. This records what
 * was DONE — the one category where the athlete can be more certain than the
 * agent, because they watched the card appear. So a wrong answer here is
 * immediately obvious to them, and "did we already pull up a reply to Handshake?"
 * had no answer at all before this.
 *
 * ── The one string, and why it is allowed ────────────────────────────────────
 * Every other field in this artifact is an id, an enum or a timestamp, and that
 * rule is what makes the whole thing safe to speak. `brandName` is the single
 * exception, and a narrow one: it is `deals.brand_name` for a deal this athlete
 * owns, resolved server-side, and it already crosses the voice wire unwrapped in
 * `list_deals` and `get_deal_brief`.
 *
 * It is STORED rather than resolved at read time because the seed is built on the
 * session-start path, where a second query costs the athlete their greeting. It
 * is still sanitised before it reaches speech — `safeName` in ./voiceSeed bounds
 * it, flattens newlines and refuses angle brackets, exactly as it does for the
 * names the seed resolves itself.
 */
export interface DraftOpened {
  dealId: string;
  brandName: string;
  replyIntent: ReplyIntentValue;
  channel: Channel;
  /** ISO 8601. `at` rather than `spokenAt`: a card is opened, not spoken. */
  at: string;
}

export interface VoiceContextState {
  dealsDiscussed: DealDiscussed[];
  brandsDiscussed: BrandDiscussed[];
  openThreads: OpenThread[];
  draftsOpened: DraftOpened[];
  lastVoiceAt: string | null;
}
