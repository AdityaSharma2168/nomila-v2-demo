/**
 * voiceContext.ts — what a voice session DISCUSSED and DECIDED, as structure.
 *
 * One row per conversation (shared/schema.ts § 13c, migrations/0018). This is the
 * artifact a later session is seeded from, and the reason it exists in this shape
 * rather than as a transcript summary is a security boundary, not a preference:
 *
 *   `chat_messages` holds brand- and email-derived prose — draft bodies, quoted
 *   threads, get_brand's <external_content>. Anything seeded into a voice session
 *   is read aloud by a TTS layer, where prompt delimiters mean nothing (the same
 *   reasoning that keeps free text off ./dealRoutes and ./brandBriefRoute). So the
 *   seed is REBUILT FROM STRUCTURE, never quoted from history, and this module is
 *   that structure.
 *
 * ── THE INVARIANT, and why the schema cannot hold it ─────────────────────────
 * The three columns are jsonb, chosen because this data is read whole, bounded by
 * one conversation, and never queried into. The cost of that choice is that
 * POSTGRES CANNOT ENFORCE WHAT LANDS IN THEM. So the rule lives here:
 *
 *   ONLY ids, closed-vocabulary enums, booleans and timestamps.
 *   NEVER prose. Never a brand string, never a model sentence, never a label.
 *
 * It is enforced three ways. The interfaces below have no free-text field at all.
 * The serializers validate every value against a fixed vocabulary or a uuid/
 * integer shape, and DROP an entry rather than coerce it. And — the load-bearing
 * part — every serializer builds its object KEY BY KEY. Nothing is spread from
 * input, so a field the caller invents cannot ride along even if it typechecks at
 * some future call site.
 *
 * ── Bounded, deliberately ────────────────────────────────────────────────────
 * Each list keeps only the most recent MAX_ENTRIES. Unbounded growth would cost
 * seed tokens on every future session and push against the very context ceiling
 * this memory exists to survive. The seed says the list is capped rather than
 * implying it is complete.
 *
 * ── Degrades when the table is not there yet ─────────────────────────────────
 * migrations/0018 documents the DDL but does not execute it — the deploy.yml block
 * does, and that merges separately. Until it lands, `voice_context` does not exist
 * in the database this code talks to. A missing relation is therefore an EXPECTED
 * state, not a failure: reads return null and writes no-op, both logged once, so
 * the voice path keeps working exactly as it does today. Same posture as every
 * other voice module: degrade, never throw at the caller.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { voiceContext } from "../../shared/schema";
import { createLogger } from "../logger";
import { UUID_RE } from "./auth";
import { recActionOf } from "./dealRoutes";
import {
  CHANNELS,
  DEFAULT_CHANNEL,
  MAX_ENTRIES,
  OPEN_TOPICS,
  REPLY_INTENTS,
  type BrandDiscussed,
  type Channel,
  type DealDiscussed,
  type DraftOpened,
  type OpenThread,
  type OpenTopic,
  type ReplyIntentValue,
  type VoiceContextState,
} from "./voiceContextTypes";

// Re-exported so callers have one import site for the artifact, while ./voiceSeed
// can take the DB-free half on its own.
export {
  CHANNELS,
  DEFAULT_CHANNEL,
  MAX_ENTRIES,
  OPEN_TOPICS,
  REPLY_INTENTS,
  type BrandDiscussed,
  type Channel,
  type DealDiscussed,
  type DraftOpened,
  type OpenThread,
  type OpenTopic,
  type ReplyIntentValue,
  type VoiceContextState,
};

const logger = createLogger("voice/voiceContext");

const EMPTY: VoiceContextState = {
  dealsDiscussed: [],
  brandsDiscussed: [],
  openThreads: [],
  draftsOpened: [],
  lastVoiceAt: null,
};

// ── Validators. Reject-don't-coerce, exactly as the voice wire does. ──────────

const uuidOr = (v: unknown): string | null =>
  typeof v === "string" && UUID_RE.test(v) ? v : null;

const intOr = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;

const boolOr = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

/** ISO 8601 or nothing. A timestamp we cannot parse is not a timestamp. */
const isoOr = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

const topicOr = (v: unknown): OpenTopic | null =>
  typeof v === "string" && OPEN_TOPICS.some((t) => t === v)
    ? (v as OpenTopic)
    : null;

/**
 * The one validator here that DEFAULTS instead of rejecting, and it is deliberate.
 *
 * Every other field follows reject-don't-coerce, and a required field that fails
 * takes the whole entry with it — half a record is worse than none. `channel` is
 * the exception because it was added to a table that ALREADY HAS ROWS. Every one
 * of those entries is channel-less and perfectly valid; dropping them would erase
 * live memory on deploy, which is a far worse outcome than reading an old entry
 * as what it almost certainly was.
 *
 * "Voice" is the right default rather than a guess: voice was the only writer in
 * existence when those rows were written.
 *
 * Note what this does NOT do — it never stores an unrecognised value. A string
 * that is not a known channel is discarded exactly like any other bad enum; it
 * just lands on the default instead of taking the entry down.
 */
const channelOr = (v: unknown): Channel =>
  typeof v === "string" && CHANNELS.some((c) => c === v)
    ? (v as Channel)
    : DEFAULT_CHANNEL;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * ── The serializers ──────────────────────────────────────────────────────────
 * Each returns a NEW object built key by key. This is the load-bearing detail:
 * `{ ...input }` would carry whatever the caller happened to have — a label, a
 * brand name, a model sentence — straight into untyped jsonb, and neither the
 * type system nor Postgres would object. Building explicitly means the only way
 * a field reaches storage is if it is written out here on purpose.
 *
 * A required field that fails validation drops the WHOLE entry. Half a record is
 * worse than no record: the seed would speak from it as if it were complete.
 */
function toDealDiscussed(input: unknown): DealDiscussed | null {
  if (!isRecord(input)) return null;
  const dealId = uuidOr(input.dealId);
  const spokenAt = isoOr(input.spokenAt);
  if (!dealId || !spokenAt) return null;
  return {
    dealId,
    brandId: intOr(input.brandId),
    recommendationGiven: recActionOf(input.recommendationGiven),
    spokenAt,
    channel: channelOr(input.channel),
  };
}

function toBrandDiscussed(input: unknown): BrandDiscussed | null {
  if (!isRecord(input)) return null;
  const brandId = intOr(input.brandId);
  const hadDeal = boolOr(input.hadDeal);
  const spokenAt = isoOr(input.spokenAt);
  if (brandId === null || hadDeal === null || !spokenAt) return null;
  return { brandId, hadDeal, spokenAt, channel: channelOr(input.channel) };
}

/**
 * The ONE serializer here that lets a string through, and the bound is the point.
 *
 * `brandName` is `deals.brand_name` for a deal this athlete owns — see
 * ./voiceContextTypes for why it is stored rather than resolved at read time. It
 * is still treated as untrusted on the way in: model-extracted names can carry
 * newlines and markup, and this artifact is read back into a session that speaks
 * aloud. So it is flattened, bounded and refused on angle brackets HERE, and
 * again in ./voiceSeed before it reaches a sentence. Two gates because they
 * protect different things: this one keeps the row clean, that one keeps speech
 * clean even when a row was written by an older build.
 *
 * A name that fails takes the whole entry with it. A draft entry with no brand
 * is unspeakable — "you already pulled up a reply to" — so half a record is
 * worse than none, exactly as for the other three lists.
 */
const DRAFT_BRAND_MAX = 60;

function safeBrandName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const flat = v.replace(/\s+/g, " ").trim();
  if (!flat || flat.length > DRAFT_BRAND_MAX) return null;
  if (/[<>]/.test(flat)) return null;
  return flat;
}

const replyIntentOr = (v: unknown): ReplyIntentValue | null =>
  typeof v === "string" && REPLY_INTENTS.some((i) => i === v)
    ? (v as ReplyIntentValue)
    : null;

function toDraftOpened(input: unknown): DraftOpened | null {
  if (!isRecord(input)) return null;
  const dealId = uuidOr(input.dealId);
  const brandName = safeBrandName(input.brandName);
  const replyIntent = replyIntentOr(input.replyIntent);
  const at = isoOr(input.at);
  if (!dealId || !brandName || !replyIntent || !at) return null;
  return {
    dealId,
    brandName,
    replyIntent,
    channel: channelOr(input.channel),
    at,
  };
}

function toOpenThread(input: unknown): OpenThread | null {
  if (!isRecord(input)) return null;
  const topic = topicOr(input.topic);
  if (!topic) return null;
  return {
    topic,
    dealId: uuidOr(input.dealId),
    channel: channelOr(input.channel),
  };
}

/** Newest first, deduped by key, capped. Applied on read AND on write. */
function bounded<T>(entries: T[], keyOf: (e: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of entries) {
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

const parseList = <T>(v: unknown, to: (i: unknown) => T | null): T[] =>
  Array.isArray(v) ? v.map(to).filter((x): x is T => x !== null) : [];

/**
 * True when the failure is "the table has not shipped yet" rather than a real
 * fault. Postgres 42P01 is undefined_table; PGlite surfaces the same text.
 */
function isMissingTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  if (e?.code === "42P01") return true;
  return (
    typeof e?.message === "string" &&
    /relation .*voice_context.* does not exist/i.test(e.message)
  );
}

let warnedMissing = false;
function noteMissing(): void {
  if (warnedMissing) return;
  warnedMissing = true;
  logger.warn(
    "voice_context table not present — voice memory is inert until the deploy.yml DDL block ships (migrations/0018)",
  );
}

/**
 * The structured state for one conversation, or null when there is none.
 *
 * Null is the ordinary case for a first voice session and MUST stay
 * distinguishable from "empty state": the seed builder speaks nothing at all on
 * null, rather than saying we discussed nothing.
 *
 * TENANCY: keyed by conversation AND filtered by athlete. The conversation id
 * arrives from the session, not from a model, but the athlete filter is what
 * confines the row to its owner — same rule as every other athlete-scoped read.
 */
export async function getVoiceContext(
  athleteId: string,
  conversationId: string,
): Promise<VoiceContextState | null> {
  if (!UUID_RE.test(athleteId) || !UUID_RE.test(conversationId)) return null;
  try {
    const [row] = await db
      .select({
        deals: voiceContext.deals_discussed,
        brands: voiceContext.brands_discussed,
        threads: voiceContext.open_threads,
        drafts: voiceContext.drafts_opened,
        lastVoiceAt: voiceContext.last_voice_at,
      })
      .from(voiceContext)
      .where(
        and(
          eq(voiceContext.conversation_id, conversationId),
          eq(voiceContext.athlete_id, athleteId),
        ),
      )
      .limit(1);

    if (!row) return null;

    // Re-validated on the way OUT as well. The column is untyped, so a row
    // written by an older build (or by hand) cannot be trusted to match the
    // interface just because it is in our table.
    return {
      dealsDiscussed: bounded(
        parseList(row.deals, toDealDiscussed),
        (d) => d.dealId,
      ),
      brandsDiscussed: bounded(parseList(row.brands, toBrandDiscussed), (b) =>
        String(b.brandId),
      ),
      openThreads: bounded(
        parseList(row.threads, toOpenThread),
        (t) => `${t.topic}:${t.dealId ?? ""}`,
      ),
      // Keyed on the DEAL, not the deal+intent: re-opening the same card with a
      // different intent is still one card on screen, and the seed should say
      // "you pulled up a reply to X" once rather than listing every revision.
      draftsOpened: bounded(
        parseList(row.drafts, toDraftOpened),
        (d) => d.dealId,
      ),
      lastVoiceAt: row.lastVoiceAt ? row.lastVoiceAt.toISOString() : null,
    };
  } catch (err) {
    if (isMissingTable(err)) {
      noteMissing();
      return null;
    }
    logger.error(
      { athleteId, error: (err as Error).message },
      "Voice context read failed",
    );
    return null;
  }
}

/** What a turn contributes. Everything optional — a turn may add nothing. */
export interface VoiceContextDelta {
  deals?: unknown[];
  brands?: unknown[];
  openThreads?: unknown[];
  draftsOpened?: unknown[];
}

/**
 * Folds a turn's contribution into the conversation's state, newest first.
 *
 * Never throws: this runs alongside a live call and a memory write must not be
 * able to cost the athlete a turn. Returns whether anything was persisted, for
 * tests and logs only.
 */
export async function recordVoiceContext(
  athleteId: string,
  conversationId: string,
  delta: VoiceContextDelta,
): Promise<boolean> {
  if (!UUID_RE.test(athleteId) || !UUID_RE.test(conversationId)) return false;

  // Serialize FIRST. Anything that fails validation is gone before it can reach
  // a query, so a malformed delta cannot even be attempted against the DB.
  const freshDeals = parseList(delta.deals ?? [], toDealDiscussed);
  const freshBrands = parseList(delta.brands ?? [], toBrandDiscussed);
  const freshThreads = parseList(delta.openThreads ?? [], toOpenThread);
  const freshDrafts = parseList(delta.draftsOpened ?? [], toDraftOpened);
  if (
    !freshDeals.length &&
    !freshBrands.length &&
    !freshThreads.length &&
    !freshDrafts.length
  ) {
    return false;
  }

  try {
    const existing =
      (await getVoiceContext(athleteId, conversationId)) ?? EMPTY;
    const now = new Date();

    // Fresh entries lead, so `bounded` keeps the most recent and drops the
    // oldest duplicates rather than the other way round.
    const deals = bounded(
      [...freshDeals, ...existing.dealsDiscussed],
      (d) => d.dealId,
    );
    const brands = bounded([...freshBrands, ...existing.brandsDiscussed], (b) =>
      String(b.brandId),
    );
    const threads = bounded(
      [...freshThreads, ...existing.openThreads],
      (t) => `${t.topic}:${t.dealId ?? ""}`,
    );
    // Fresh first, so re-opening a card REFRESHES its entry (newest intent and
    // timestamp win) rather than appending a second one for the same deal.
    const drafts = bounded(
      [...freshDrafts, ...existing.draftsOpened],
      (d) => d.dealId,
    );

    await db
      .insert(voiceContext)
      .values({
        conversation_id: conversationId,
        athlete_id: athleteId,
        deals_discussed: deals,
        brands_discussed: brands,
        open_threads: threads,
        drafts_opened: drafts,
        last_voice_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: voiceContext.conversation_id,
        set: {
          deals_discussed: deals,
          brands_discussed: brands,
          open_threads: threads,
          drafts_opened: drafts,
          last_voice_at: now,
          updated_at: now,
        },
        // Belt and braces on tenancy: a conflicting row belonging to someone
        // else is not ours to overwrite.
        where: sql`${voiceContext.athlete_id} = ${athleteId}`,
      });
    return true;
  } catch (err) {
    if (isMissingTable(err)) {
      noteMissing();
      return false;
    }
    logger.error(
      { athleteId, error: (err as Error).message },
      "Voice context write failed",
    );
    return false;
  }
}

/** Test seam: the missing-table warning is once-per-process by design. */
export function _resetVoiceContextWarning(): void {
  warnedMissing = false;
}
