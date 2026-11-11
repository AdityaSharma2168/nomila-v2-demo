/**
 * voiceMemory.ts — the TEXT agent's write into the shared voice artifact.
 *
 * ── Why the text side writes a "voice" table ─────────────────────────────────
 * `voice_context` is keyed on `conversation_id`, and a conversation is not a
 * channel: the browser hands the voice session the id of the athlete's ACTIVE
 * CHAT THREAD (client/screens/MilaSearchOverlay.tsx passes `useMilaChat()`'s
 * conversationId into `useMilaVoice`), which `resolveVoiceConversation` then
 * confirms ownership of. So a call and the chat before it are the same
 * conversation and the same row. Voice has always written it; this is the other
 * writer, and it is what lets a session that starts by speaking know what the
 * athlete typed ten minutes earlier.
 *
 * The design was anticipated where the seed is built — server/voice/voiceSeed.ts
 * names "the TEXT side also populating voice_context, written from its own tool
 * results" as the safe bridge. This is that.
 *
 * ── The boundary this must not cross ─────────────────────────────────────────
 * THE FORBIDDEN VERSION OF THIS FEATURE IS LOADING `chat_messages` INTO VOICE.
 * That table holds brand- and email-derived prose — draft bodies, quoted threads,
 * `<external_content>` — and anything seeded into a voice session is read aloud
 * by a TTS layer, where prompt delimiters mean nothing. Nothing here reads it.
 *
 * What this module consumes is TOOL RESULTS, and it takes only ids and closed
 * enums out of them, key by key. `server/voice/voiceContext.ts` then re-validates
 * every value on the way in and again on the way out; a field this module
 * invented could not reach storage even if it typechecked. The `thread.subject`
 * and `thread.summary` sitting in a `get_deal` result are never read.
 *
 * ── What it records, and the one thing it deliberately does not ──────────────
 * `get_deal` only. That is the text equivalent of voice's `get_deal_brief`: the
 * moment the athlete engaged with ONE named deal. `list_deals` is excluded on
 * purpose — a ranking sweep touches ten deals and engages with none of them, and
 * recording all ten would evict everything else from a bounded list.
 *
 * Brands come from `get_brand` / `get_brand_fit`. Those tools return public
 * company facts and, by design, nothing about the athlete's own deals — so
 * `hadDeal` cannot be read off the result and is RESOLVED HERE, athlete-scoped,
 * before anything is written. That check is the whole reason brands are in:
 * guessing `false` would let the seed say "they also asked about gorjana — no
 * deal with them" about a brand they hold, which is a false claim about their
 * records spoken aloud.
 *
 * ── Why hadDeal takes two signals ────────────────────────────────────────────
 * Either `deals.brand_id` pointing at the brand, or the deal's own `brand_name`
 * normalizing to the brand row's name. Both, because each alone is wrong on live
 * data: `brand_id` is nullable and sparse (legacy rows carry only `brand_name`),
 * while a deal can be recorded under an agency's name that never normalizes to
 * the advertiser it is linked to. Requiring both would report held deals as
 * missing; either one is enough to say "yes, they have something with these
 * people". Note this reads `deals.brand_id` — the DEAL's own column — never
 * `inbox_threads.brand_id`, which server/voice/dealResolver.ts documents as
 * mis-linked on live data.
 *
 * A brand id with no `inbox_brands` row is SKIPPED rather than recorded: without
 * the row there is no name to key on, so the name signal is blind and a `false`
 * would be a guess again.
 */

import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxBrands } from "../../shared/schema";
import { normalizeBrand } from "../lib/brandResolver";
import { recordVoiceContext } from "../voice/voiceContext";
import { createLogger } from "../logger";
import { UUID_RE } from "../voice/auth";

const logger = createLogger("mila/voiceMemory");

/** Everything written by this module carries it. See the header. */
const CHANNEL = "text" as const;

/**
 * Ord, weakest first. Mirrors `ORD_RANK` in mila-voice src/memory.ts — the two
 * channels must agree about which term is the soft one, or the same deal would
 * produce a different watch-item depending on where it was discussed.
 */
const ORD_RANK: Record<string, number | undefined> = {
  poor: 0,
  fair: 1,
  good: 2,
  great: 3,
};
const GOOD_RANK = 2;

/**
 * Which term grade maps to a watch-item topic, in the SNAKE_CASE the text tool
 * returns. Voice reads the same grades under camelCase names off the voice wire
 * (`rateComparison`); this is the same table for the other spelling.
 *
 * `brand_relevance` is absent for the reason it is absent on the voice side: it
 * grades whether the brand fits the athlete, which is not something you can go
 * back and renegotiate. A watch-item has to be actionable.
 */
const GRADE_TOPIC: Array<[field: string, topic: string]> = [
  ["rate_comparison", "rate"],
  ["exclusivity", "exclusivity"],
  ["deliverable_scope", "scope"],
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The softest negotiable term, or null when nothing was graded softly.
 *
 * Only worth carrying forward if it is actually soft — a deal whose weakest term
 * is "great" has no watch-item, and inventing one would be noise in a bounded
 * list.
 */
function softestTopic(deal: Record<string, unknown>): string | null {
  let best: { topic: string; rank: number } | null = null;
  for (const [field, topic] of GRADE_TOPIC) {
    const grade = deal[field];
    if (typeof grade !== "string") continue;
    const rank = ORD_RANK[grade];
    if (rank === undefined) continue;
    if (!best || rank < best.rank) best = { topic, rank };
  }
  return best && best.rank <= GOOD_RANK ? best.topic : null;
}

/** The delta shape `recordVoiceContext` accepts. Unknown-typed on purpose: it
 * re-validates everything, so this module never asserts a validated type it did
 * not itself check. */
export interface TextDelta {
  deals?: unknown[];
  brands?: unknown[];
  openThreads?: unknown[];
  draftsOpened?: unknown[];
  /**
   * Brand ids seen this round, awaiting a `hadDeal` verdict.
   *
   * Deliberately NOT `brands`: this stage is pure, and `hadDeal` is a fact about
   * the athlete's deals that only a query can supply. Keeping the candidates
   * separate means the pure mapping stays testable without a database, and no
   * half-built brand entry can reach `recordVoiceContext` by accident — it would
   * fail validation there anyway, which is the belt to this braces.
   */
  brandCandidates?: number[];
}

/**
 * The text tool that OPENS a reply card. Its result carries everything a
 * `drafts_opened` entry needs — deal id, the resolved brand name, and the intent
 * the card was opened with — so nothing has to be re-derived or looked up.
 *
 * Note this fires on a card being OPENED, not sent. `draft_reply` produces a
 * card with a body and a Send button; only the athlete's tap sends it. The seed
 * says "pulled up", never "sent", for exactly that reason.
 */
const DRAFT_TOOL = "draft_reply";

/** Tools whose result identifies one brand the athlete engaged with. */
const BRAND_TOOLS = new Set(["get_brand", "get_brand_fit"]);

/**
 * One tool round → what is worth remembering.
 *
 * Pure: no database, no clock beyond `toISOString`. `calls` and `results` are
 * positionally paired the way the loop produced them; a mismatch in length is
 * tolerated rather than thrown on, because a memory write must never be the
 * thing that fails a turn.
 */
export function buildTextDelta(
  calls: { name?: string | null }[],
  results: unknown[],
): TextDelta {
  const deals: unknown[] = [];
  const openThreads: unknown[] = [];
  const draftsOpened: unknown[] = [];
  const brandCandidates: number[] = [];
  const spokenAt = new Date().toISOString();

  calls.forEach((call, i) => {
    const name = call?.name ?? "";
    const result = results[i];
    if (!isRecord(result)) return;
    // A failed tool returns `{ error }`. There is nothing to remember about a
    // lookup that did not happen.
    if (typeof result.error === "string") return;

    if (BRAND_TOOLS.has(name)) {
      // A NUMERIC brand_id is what proves the brand resolved to one of our own
      // rows. `get_brand_fit` falls back to `cleanName ?? cleanDomain` — model-
      // supplied text — when it does not, and an entry built from that would be
      // keyed on nothing. Deduped so a brand looked at twice is one entry.
      const brandId = result.brand_id;
      if (typeof brandId === "number" && !brandCandidates.includes(brandId)) {
        brandCandidates.push(brandId);
      }
      return;
    }

    if (name === DRAFT_TOOL) {
      // A refusal is not an opened card. `draft_reply` returns a `refusal`
      // string when the leak lint could not produce clean copy, and the athlete
      // sees no draft — remembering one would be a claim about their screen
      // that is simply false.
      if (typeof result.refusal === "string" && result.refusal) return;
      const dealId = result.deal_id;
      const brandName = result.brand_name;
      const replyIntent = result.reply_intent;
      if (typeof dealId !== "string" || typeof brandName !== "string") return;
      if (typeof replyIntent !== "string") return;
      // Built key by key, like everything else here — the result also carries
      // `draft`, the brand-facing BODY, which must never enter this artifact.
      draftsOpened.push({
        dealId,
        brandName,
        replyIntent,
        channel: CHANNEL,
        at: spokenAt,
      });
      return;
    }

    if (name !== "get_deal") return;

    const dealId = result.id;
    if (typeof dealId !== "string") return;

    // Built key by key — never spread from the result. `get_deal` carries
    // `thread.subject`, `thread.summary` and the model-written labels beside
    // every grade, and a spread would put all of it into untyped jsonb.
    deals.push({
      dealId,
      brandId: typeof result.brand_id === "number" ? result.brand_id : null,
      recommendationGiven:
        typeof result.recommendation === "string"
          ? result.recommendation
          : null,
      spokenAt,
      channel: CHANNEL,
    });

    const topic = softestTopic(result);
    if (topic) openThreads.push({ topic, dealId, channel: CHANNEL });
  });

  const delta: TextDelta = {};
  if (deals.length) delta.deals = deals;
  if (openThreads.length) delta.openThreads = openThreads;
  if (draftsOpened.length) delta.draftsOpened = draftsOpened;
  if (brandCandidates.length) delta.brandCandidates = brandCandidates;
  return delta;
}

/**
 * Does this athlete hold a deal with each of these brands?
 *
 * Two queries regardless of how many brands, and both athlete-scoped. The
 * comparison runs in memory rather than SQL because `normalizeBrand` is a JS
 * function — the same reasoning server/voice/dealResolver.ts gives for doing it
 * this way: one normalizer, no second implementation in SQL that could drift.
 *
 * A brand absent from the returned map has no `inbox_brands` row and must not be
 * recorded at all — see the header on why a blind `false` is worse than nothing.
 */
async function resolveHadDeal(
  athleteId: string,
  brandIds: number[],
): Promise<Map<number, boolean>> {
  const verdicts = new Map<number, boolean>();
  if (!brandIds.length) return verdicts;

  const [brandRows, dealRows] = await Promise.all([
    db
      .select({ id: inboxBrands.id, name: inboxBrands.name })
      .from(inboxBrands)
      .where(inArray(inboxBrands.id, brandIds)),
    // TENANCY: the deal side is filtered by athlete, which is what confines the
    // whole answer to its owner. `inbox_brands` is global reference data with no
    // athlete_id (see getBrand.ts), so it needs no filter and leaks nothing —
    // the verdict is only ever "does THIS athlete hold one".
    db
      .select({ brand_name: deals.brand_name, brand_id: deals.brand_id })
      .from(deals)
      .where(eq(deals.athlete_id, athleteId)),
  ]);

  const dealKeys = new Set<string>();
  const dealBrandIds = new Set<number>();
  for (const d of dealRows) {
    const key = normalizeBrand(d.brand_name ?? "");
    if (key) dealKeys.add(key);
    if (typeof d.brand_id === "number") dealBrandIds.add(d.brand_id);
  }

  for (const b of brandRows) {
    const key = normalizeBrand(b.name ?? "");
    verdicts.set(b.id, dealBrandIds.has(b.id) || (!!key && dealKeys.has(key)));
  }
  return verdicts;
}

/**
 * Record one text tool round into the shared artifact.
 *
 * ── conversationId is `string | undefined`, and undefined means STOP ─────────
 * `persistToolRound` types it that way because a round can happen before a
 * conversation row exists. Minting one here would key a row on an id no session
 * will ever read — an orphan that costs a write and remembers nothing. So the
 * absent case is a silent no-op. Nothing in this module generates a uuid, and
 * nothing should: if a turn has no conversation, it has no memory.
 *
 * Never throws and never awaits anything the caller depends on: a memory write
 * must not be able to cost the athlete a turn. `recordVoiceContext` already
 * swallows its own failures (including the table not existing yet); this adds
 * the guard for anything thrown before it.
 */
export async function recordTextTurn(
  athleteId: string,
  conversationId: string | undefined,
  calls: { name?: string | null }[],
  results: unknown[],
): Promise<void> {
  if (!conversationId || !UUID_RE.test(conversationId)) return;

  try {
    const delta = buildTextDelta(calls, results);

    // Brands need a verdict before they are entries at all. Resolved here, not
    // in the pure stage, and only when there is something to resolve.
    if (delta.brandCandidates?.length) {
      const verdicts = await resolveHadDeal(athleteId, delta.brandCandidates);
      const spokenAt = new Date().toISOString();
      const brands = delta.brandCandidates
        .filter((id) => verdicts.has(id))
        .map((brandId) => ({
          brandId,
          hadDeal: verdicts.get(brandId)!,
          spokenAt,
          channel: CHANNEL,
        }));
      if (brands.length) delta.brands = brands;
    }
    // Never persisted — it is scaffolding for the step above, and
    // recordVoiceContext would ignore it anyway.
    delete delta.brandCandidates;

    if (
      !delta.deals &&
      !delta.openThreads &&
      !delta.brands &&
      !delta.draftsOpened
    )
      return;
    await recordVoiceContext(athleteId, conversationId, delta);
  } catch (err) {
    // Ids and counts only — never a brand, never a grade label.
    logger.warn(
      { athleteId, error: (err as Error).message },
      "Text voice-context write failed — turn not remembered",
    );
  }
}
