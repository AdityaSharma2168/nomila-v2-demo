/**
 * dealDraft.ts — the single source of draft truth for a deal reply.
 *
 * Extracted verbatim from the POST /me/deals/:id/draft handler (WS3 §3.1) so there
 * is ONE place that turns a deal + intent into brand-facing copy: the route calls it
 * (passing `onToken` to keep its live SSE stream), and Mila's `draft_reply` tool calls
 * the SAME function (omitting `onToken`, collecting the final text). Both get the same
 * three strip-guards — a deterministic greeting/signature composed in code, the
 * `sanitizeDraftBody` pass, and the `lintDraftForLeaks` regenerate/refuse loop (every
 * intent, every floor she has set) — so a confidential figure can never reach a brand no
 * matter which caller drafts.
 *
 * Money and safety (12 Oct 2026):
 *   · the only figure a draft may propose is the counter SHE typed — never her floor;
 *   · the offer it answers is the LATEST one (lib/latestOffer), not the detection snapshot;
 *   · a model-written instruction carries no figures (draftPrompt.prepareInstruction);
 *   · the thread is the ONE reply thread (lib/replyThread), the same one propose sends on;
 *   · "my team" signs only as a real person she named in Settings — never an invented agency.
 *
 * It returns a discriminated result instead of writing to `res`, so any caller can map it.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  deals,
  inboxThreads,
  inboxMessages,
  athletes,
} from "../../shared/schema";
import { kimiStream } from "../lib/kimi";
import { guardStream } from "../lib/streamGuard";
import {
  buildGreeting,
  buildSignature,
  sanitizeDraftBody,
  assembleReplyEmail,
  type ReplySignaturePref,
} from "../lib/draftFormat";
import {
  buildDraftPrompt,
  lintDraftForLeaks,
  prepareInstruction,
  type InstructionSource,
  type ReplyIntent,
  type DraftStyle,
  type DraftVoice,
} from "../lib/draftPrompt";
import { createLogger } from "../logger";
import { readThreadConversation } from "./liveConversation";
import { resolveReplyThread } from "../lib/replyThread";
import { pickLatestOffer } from "../lib/latestOffer";
import { effectiveQualification } from "../skills/dealQualification";
import { dealTypeOf, floorKeyOf, TERM_KEYS, type ReplyIntent as SharedReplyIntent, type TermKey } from "../../shared/deals";
import { minimumFor } from "./ratesFloor";

const logger = createLogger("services/dealDraft");

/** How many recent messages the drafter reads. */
const RECENT_MESSAGES = 5;

/** A finite, strictly-positive number, else null — so a 0/NaN rate never reads as "set". */
function positiveNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Every floor she has set, across all kinds of work (and the legacy scalar). The leak check
 * protects all of them on every draft: a press reply must not carry her per-post floor either.
 */
export function allFloors(prefs: Record<string, unknown> | null | undefined): number[] {
  const out = new Set<number>();
  const rates = (prefs?.minimum_rates ?? {}) as Record<string, unknown>;
  for (const v of Object.values(rates)) {
    const n = positiveNum(v);
    if (n != null) out.add(n);
  }
  const scalar = positiveNum(prefs?.minimum_rate);
  if (scalar != null) out.add(scalar);
  return [...out];
}

/**
 * Who signs "my team" replies. Only a real person she named in Settings (agent_name, with
 * agent_role or agency_name as the line under it). No name → null, and the reply is signed as
 * her (decision D2, 12 Oct 2026). Never an invented "{Surname} Management".
 */
export function teamSigner(prefs: Record<string, unknown> | null | undefined): { name: string; line: string | null } | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = str(prefs?.agent_name);
  if (!name) return null;
  return { name, line: str(prefs?.agent_role) ?? str(prefs?.agency_name) };
}

/**
 * Reply drafts used to run at 0.2, so the same tone + terms regenerated
 * near-identically. That was chosen as a feature and turned out to be two
 * problems.
 *
 * The drafts read templated — same intent, same style, same three beats — because
 * at 0.2 the model barely deviates from the intent script in ../lib/draftPrompt.
 * And REGENERATION is where it bit hardest: "try again" and "I don't love it" are
 * revision requests, and near-identical output is the one thing a revision must
 * not produce. The athlete asks for something different and gets the same letter.
 *
 * 0.7 is warm enough for the prose to vary between attempts while staying well
 * inside instruction-following.
 *
 * Nothing about SAFETY rests on this number. The rate floor, the leak lint and
 * the retry below are deterministic checks applied AFTER generation, so a hotter
 * draft passes through exactly the same gates as a cold one — a leak is caught
 * by `lintDraftForLeaks`, not by the model being too timid to write one.
 */
const DRAFT_TEMPERATURE = 0.7;
// If a regenerated draft still leaks, refuse rather than send it.
const LEAK_RETRY_SUFFIX =
  "\n\nCRITICAL: your previous draft exposed a confidential figure or internal note. State NO dollar amount except the single rate you were told to propose, if any. Never mention a minimum, market rate, or any internal analysis. Keep it warm and brief.";

// Stream guards for the draft — kimiStream has no built-in timeout, so a Vertex
// stall would hang the caller (and, for the route, the client spinner) forever.
//
// IDLE is the guard that detects a genuine stall: no token for 20s means the stream
// is dead. TOTAL is only a backstop against a stream that dribbles forever.
//
// TOTAL was 60s, and every draft_stream_timeout ever recorded in prod fired on
// `total`, never `idle` — five of them, four on one long gorjana thread in a single
// afternoon. That is the signature of killing a HEALTHY generation: tokens were
// arriving the whole time and we cut the athlete off at the one minute mark. It was
// also half the client's own 120s ceiling, so the server always gave up first and the
// client's budget never applied. Matched to the client now; idle stays the real
// stall detector, so a hung stream still fails in 20s rather than 120.
const DRAFT_STREAM_IDLE_MS = Number(process.env.KIMI_STREAM_IDLE_MS ?? 20_000);
const DRAFT_STREAM_TOTAL_MS = Number(
  process.env.KIMI_STREAM_TOTAL_MS ?? 120_000,
);

// Input caps (A14) — keep uncontrolled strings out of the LLM prompt / JSONB history.
const MAX_SELECTED_TERMS = 10;
const MAX_TERM_LEN = 200;
const MAX_CUSTOM_INSTR_LEN = 400;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GenerateDealDraftParams {
  athleteId: string;
  dealId: string;
  replyIntent: ReplyIntent;
  style: DraftStyle;
  voice: DraftVoice;
  selectedTerms?: string[];
  customInstruction?: string;
  /**
   * Who wrote customInstruction. "athlete" (default): her typed text — her counter is read from
   * it. "model": Mila wrote it — every figure is stripped before it reaches the prompt.
   */
  instructionSource?: InstructionSource;
  /** Her typed counter, when the caller has it as a number. The ONLY figure the draft may propose. */
  counterAmount?: number | null;
  /** The thread to reply on; must be hers and linked to the deal. Omitted → the one reply thread. */
  threadId?: string | null;
  includeMediaKit?: boolean;
  /**
   * The deal type's own intent (the reply sheet's chip, shared/deals). With DEALS_REPLY_V2 it is drafted as chosen
   * instead of mapping `replyIntent`; the type-aware reply refuses one the type doesn't offer.
   */
  typeIntent?: SharedReplyIntent;
  /** Her term rows ({ term, ask }) — passed to the type-aware reply as its term asks. */
  termAsks?: Array<{ term: string; ask: string }>;
  /** Abort the underlying model call (route: client disconnect; tool: timeout). */
  signal?: AbortSignal;
  /** Called with the deterministic greeting first, then each body delta (unless the
   *  negotiate leak-buffer is active). Omit to draft without streaming. */
  onToken?: (token: string) => void;
}

/** The params the draft was actually produced with (caps applied) — for the widget. */
export interface GeneratedDraftParams {
  replyIntent: ReplyIntent;
  style: DraftStyle;
  voice: DraftVoice;
  selectedTerms: string[];
  includeMediaKit: boolean;
}

export type GenerateDealDraftResult =
  /** threadId: the thread this draft was written for — propose sends on the same one. */
  | { ok: true; fullText: string; params: GeneratedDraftParams; threadId: string | null }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "refusal"; message: string }
  | { ok: false; reason: "gen_error" }
  /**
   * MAILBOX_LIVE_READS: the conversation could not be read from the mailbox
   * (disconnected / deleted / unreachable). Drafting pauses and says why.
   */
  | { ok: false; reason: "mailbox_unavailable"; message: string }
  /**
   * The model completed normally and produced no body. Separate from `gen_error`
   * only so it is countable in logs — every consumer treats the two the same, and
   * should: both mean "no draft, offer a retry". See the guard for why shipping the
   * assembled greeting instead was worse than failing.
   */
  | { ok: false; reason: "empty_body" };

/** Fixed, brand-safe refusal shown when the leak-lint can't produce clean copy. */
export const DRAFT_LEAK_REFUSAL =
  "Couldn't draft a safe reply — please write this one manually.";

/**
 * Generate a strip-guarded reply draft for `dealId`, owned by `athleteId`.
 *
 * Never throws for expected failure modes — a missing/foreign deal comes back as
 * `not_found`, a leak the linter can't clear as `refusal`, a model/stream failure as
 * `gen_error`, and a model that answered with nothing as `empty_body`. On success the
 * body is guaranteed non-empty; returns the complete, sendable email (`greeting + body +
 * signature`) and persists it as the thread's `latest_draft`.
 */
export async function generateDealDraft(
  params: GenerateDealDraftParams,
): Promise<GenerateDealDraftResult> {
  const { athleteId, dealId, replyIntent, style, signal, onToken } =
    params;
  const includeMediaKit = !!params.includeMediaKit;
  const instructionSource: InstructionSource = params.instructionSource ?? "athlete";

  // Cap uncontrolled input before it reaches the LLM prompt — both callers get this.
  // A model-written term carries no figures either (same rule as its instruction).
  const selectedTerms = (params.selectedTerms ?? [])
    .slice(0, MAX_SELECTED_TERMS)
    .map((t) => t.slice(0, MAX_TERM_LEN))
    .map((t) => (instructionSource === "model" ? prepareInstruction(t, "model").instruction : t))
    .filter((t) => t.trim());
  // Her counter is the only number: read it (explicit, or from her own "Counter at $X"), and strip
  // every other figure — including a "do not go below $floor" guard rail — before the prompt.
  const { instruction: customInstruction, counterAmount } = prepareInstruction(
    (params.customInstruction ?? "").slice(0, MAX_CUSTOM_INSTR_LEN),
    instructionSource,
    params.counterAmount ?? null,
  );

  // Malformed id → not_found, never a Postgres cast error.
  if (!UUID_RE.test(dealId)) return { ok: false, reason: "not_found" };

  // DEALS_REPLY_V2 (D7): the type-aware reply skill on OpenAI writes it; Kimi is not called. The legacy four intents
  // map onto the deal type's own (an "accept" on an interview request is "accept and suggest times").
  if ((process.env.DEALS_REPLY_V2 ?? "").trim().toLowerCase() === "true") {
    const { draftDealReply } = await import("./dealReply.js");
    const r = await draftDealReply({
      athleteId, dealId, style,
      ...(params.typeIntent ? { intent: params.typeIntent } : { legacyIntent: replyIntent }),
      voice: params.voice === "agent" ? "team" : "athlete",
      termAsks: params.termAsks?.length
        ? params.termAsks.map((t) => ({ term: (TERM_KEYS as readonly string[]).includes(t.term) ? (t.term as TermKey) : ("other" as const), ask: t.ask }))
        : (params.selectedTerms ?? []).map((t) => ({ term: "other" as const, ask: t })),
      figure: params.counterAmount ?? null,
      note: params.customInstruction,
      noteSource: params.instructionSource ?? "athlete",
      threadId: params.threadId ?? null,
      includeMediaKit,
      signal,
    });
    if (r.ok) {
      return {
        ok: true, fullText: r.fullText, threadId: r.threadId,
        params: { replyIntent, style, voice: r.voice === "team" ? "agent" : "athlete", selectedTerms: params.selectedTerms ?? [], includeMediaKit },
      };
    }
    if (r.reason === "intent_not_allowed") {
      return { ok: false, reason: "refusal", message: "That kind of reply doesn't fit this request. Pick another option." };
    }
    return r;
  }

  // Narrow projection — drafting needs only these columns. A bare select().from(deals)
  // expands to EVERY schema column, so a column the local Postgres is behind on
  // (e.g. the payments-engine payment_status/deposit_status) makes the whole draft
  // path throw. Mirror the explicit column lists get_deal / list_deals use.
  const [deal] = await db
    .select({
      id: deals.id,
      brand_name: deals.brand_name,
      amount: deals.amount,
      deal_type: deals.deal_type,
      source: deals.source,
      raw_data: deals.raw_data,
    })
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
    .limit(1);

  if (!deal) return { ok: false, reason: "not_found" };

  // THE reply thread — the same resolver propose uses, so the draft quotes the thread it sends on.
  const resolved = await resolveReplyThread(athleteId, dealId, params.threadId ?? null);
  if (!resolved.ok) return { ok: false, reason: "not_found" };

  // Thread(s), athlete — parallel. All of the deal's threads are read for the LATEST offer.
  const [threadRows, athleteResult] = await Promise.all([
    // Narrow — never let a bare select() pull a column the local DB is behind on.
    db
      .select({
        id: inboxThreads.id,
        summary: inboxThreads.summary,
        classification: inboxThreads.classification,
        conversation_state: inboxThreads.conversation_state,
        last_message_at: inboxThreads.last_message_at,
      })
      .from(inboxThreads)
      .where(and(eq(inboxThreads.deal_id, dealId), eq(inboxThreads.athlete_id, athleteId))),
    db
      .select({
        full_name: athletes.full_name,
        sport: athletes.sport,
        // Phase A Step 2d-3 (#28): `school` was selected here and never read; the projection column leaves.
        deal_preferences: athletes.deal_preferences,
      })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1),
  ]);

  const thread = threadRows.find((t) => t.id === resolved.threadId) ?? null;
  const athlete = athleteResult[0] ?? null;

  // Newest first, five deep. MAILBOX_LIVE_READS: read from the mailbox; if it can't be
  // read, drafting pauses with the reason (no draft is persisted, nothing else moves).
  let recentMessages: { direction: string | null; body: string | null; sender_name: string | null }[] = [];
  if (thread) {
    const live = await readThreadConversation(athleteId, thread.id);
    if (live && !live.ok) {
      return { ok: false, reason: "mailbox_unavailable", message: live.message };
    }
    recentMessages = live
      ? live.messages.slice(-RECENT_MESSAGES).reverse().map((m) => ({
          direction: m.direction,
          body: m.text,
          sender_name: m.fromName,
        }))
      : await db
          .select({
            direction: inboxMessages.direction,
            body: inboxMessages.body,
            sender_name: inboxMessages.sender_name,
          })
          .from(inboxMessages)
          .where(eq(inboxMessages.thread_id, thread.id))
          .orderBy(desc(inboxMessages.received_at))
          .limit(RECENT_MESSAGES);
  }

  const prefs = athlete?.deal_preferences as any;

  // Her floor for THIS kind of work — the one floor key (shared/deals floorKeyOf), the same one the
  // qualification check reads, so an appearance is never judged against her per-post floor. It is
  // private: never proposed (draftPrompt), only protected. The leak check protects EVERY floor she
  // has set (allFloors), on every intent.
  const cls = (thread?.classification ?? {}) as Record<string, unknown>;
  // The LATEST offer on the table — not the detection-time deals.amount (lib/latestOffer).
  const offeredAmount = pickLatestOffer(deal, threadRows)?.amount ?? null;
  // A stored "workable" that names no amount reads as needs_terms (paid, no figure: nothing to accept).
  const qualification = effectiveQualification(cls, {
    statedCash: offeredAmount, offerUnit: (thread?.conversation_state as any)?.key_details?.offer_struct?.unit ?? null,
  }) ?? (cls.qualification as string | undefined);
  const dealType = dealTypeOf({
    category:       cls.category as string | undefined,
    workKind:       cls.work_kind as string | undefined,
    mediaKind:      cls.media_kind as string | undefined,
    compKind:       cls.comp_kind as string | undefined,
    qualification,
    dealTypeColumn: deal.deal_type,
  });
  // Her minimum through the one reader (services/ratesFloor minimumFor) — no fallback to the retired single
  // `minimum_rate`: the board says "no minimum set" for this kind of work, so the draft must not counter at an old
  // scalar floor (deals audit B §4 issue 7). allFloors still protects that scalar from leaking.
  const minimumRate = minimumFor(prefs?.minimum_rates, floorKeyOf({ dealType, workKind: cls.work_kind as string | undefined }))?.value ?? null;
  const floors = allFloors(prefs);

  // Legacy retirement, phase 1 (owner decision 8 Oct 2026): no computed market rate.
  const marketRate: number | null = null;

  // Deterministic email frame — the LLM writes only the letter body; greeting
  // and signature are composed in code so every draft is sendable as-is.
  const greeting = buildGreeting({
    senderName:
      recentMessages.find((m) => m.direction === "inbound")?.sender_name ??
      null,
    brandName: deal.brand_name,
  });
  // Signature depends on voice: the athlete signs as themselves (reply_signature
  // pref). "My team" signs as the real team member she named in Settings (D2); with no
  // one named, the reply is hers — never an invented "{LastName} Management".
  const signer = params.voice === "agent" ? teamSigner(prefs) : null;
  const voice: DraftVoice = signer ? "agent" : "athlete";
  let signature: string;
  if (signer) {
    signature = buildSignature({ name: signer.line ? `${signer.name}\n${signer.line}` : signer.name }, null);
  } else {
    signature = buildSignature(
      (prefs?.reply_signature ?? null) as ReplySignaturePref | null,
      athlete?.full_name,
    );
  }

  const outParams: GeneratedDraftParams = {
    replyIntent,
    style,
    voice,
    selectedTerms,
    includeMediaKit,
  };

  const { systemPrompt, userPrompt, proposedRate } = buildDraftPrompt({
    athleteName: athlete?.full_name ?? null,
    athleteSport: athlete?.sport ?? null,
    style,
    replyIntent,
    voice,
    selectedTerms,
    includeMediaKit,
    customInstruction,
    instructionSource,
    minimumRate,
    marketRate,
    counterAmount,
    dealAmount: offeredAmount,
    brandName: deal.brand_name,
    dealType: deal.deal_type,
    threadSummary: thread?.summary ?? null,
    recentMessages: recentMessages.map((m) => ({
      direction: m.direction,
      body: m.body,
    })),
  });

  // The greeting is deterministic, so it streams instantly.
  onToken?.(`${greeting}\n\n`);

  // Own the abort wiring: chain the caller's signal (client disconnect / tool
  // timeout) into an internal controller that a stream-guard timeout can also
  // trip, so either cancels the Vertex call instead of leaving it running.
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else
      signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  // EVERY intent is linted (a brand email can steer a figure into an accept or decline as easily
  // as into a counter). When she has any floor to protect, the body is buffered and vetted before
  // anything reaches the caller — otherwise a leaked token has already been streamed. With no floor
  // set, the body streams live and is still linted (an internal phrase) before it is returned.
  const leakOpts = { minimumRate, marketRate, floors, proposedRate, offeredAmount };
  const bufferForLeak = floors.length > 0 || minimumRate != null || marketRate != null;

  // Runs one generation, streaming raw tokens live unless we're buffering to vet
  // for leaks first. Returns the sanitized body.
  async function runOnce(system: string): Promise<string> {
    let raw = "";
    const stream = await kimiStream(
      [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      [],
      { temperature: DRAFT_TEMPERATURE, signal: controller.signal },
    );
    const guarded = guardStream(stream, {
      idleMs: DRAFT_STREAM_IDLE_MS,
      totalMs: DRAFT_STREAM_TOTAL_MS,
      onTimeout: (kind) => {
        logger.error(
          {
            event: "pipeline_failure",
            kind: "draft_stream_timeout",
            timeout: kind,
            dealId,
            athleteId,
          },
          "draft stream timed out",
        );
        controller.abort();
      },
    });
    for await (const chunk of guarded) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        raw += delta;
        if (!bufferForLeak) onToken?.(delta);
      }
    }
    return sanitizeDraftBody(raw) || raw.trim();
  }

  let body: string;
  try {
    body = await runOnce(systemPrompt);

    // Every intent, every draft. (A streamed draft that fails is replaced by the final text.)
    {
      let leak = lintDraftForLeaks(body, leakOpts);
      if (leak.leaked) {
        logger.warn(
          {
            event: "pipeline_failure",
            kind: "draft_leak",
            reason: leak.reason,
            dealId,
            athleteId,
          },
          "draft leaked confidential info — regenerating",
        );
        body = await runOnce(systemPrompt + LEAK_RETRY_SUFFIX);
        leak = lintDraftForLeaks(body, leakOpts);
        if (leak.leaked) {
          logger.error(
            {
              event: "pipeline_failure",
              kind: "draft_leak",
              reason: leak.reason,
              dealId,
              athleteId,
            },
            "draft still leaked after retry — refusing",
          );
          return { ok: false, reason: "refusal", message: DRAFT_LEAK_REFUSAL };
        }
      }
    }
  } catch (err: any) {
    logger.error({ err: err.message, dealId }, "kimiStream draft failed");
    return { ok: false, reason: "gen_error" };
  }

  // AN EMPTY BODY IS A FAILURE, NOT A DRAFT.
  //
  // `runOnce` returns `sanitizeDraftBody(raw) || raw.trim()`. That is "" in exactly
  // one case — `raw` itself was empty or whitespace, i.e. the model completed
  // normally having streamed no content. (It is NOT "" merely because sanitize
  // stripped everything: a model reply that was only a greeting and a sign-off gets
  // stripped to "" and then rescued by the `|| raw.trim()` fallback.)
  //
  // Nothing downstream noticed. `assembleReplyEmail` filters empty parts, so
  // `fullText` collapsed to the code-composed frame with no letter in it — the
  // greeting plus the sign-off (buildSignature always yields at least
  // DEFAULT_SIGN_OFF, so it is the greeting + "Best," rather than the greeting
  // alone) — and we still returned ok. The route sent it as `replace` + `done`, the
  // client set generated=true, and the card rendered it as a finished email with a
  // Review & Send button under it. That is Mia's "draft only said Hi Iva".
  //
  // This is NOT the timeout path: guardStream throws StreamTimeoutError, which the
  // catch above already turns into gen_error.
  //
  // Trim-aware on purpose: sanitizeDraftBody can return whitespace, which is truthy,
  // so it survives the `||` and would otherwise pass a `!body` check.
  //
  // Its own reason rather than gen_error so it is distinguishable in logs; both
  // consumers already route anything that is not `not_found`/`refusal` to their
  // generic failure copy, so no caller needs to change (routes/deals.ts -> "Draft
  // generation failed — try again"; mila/tools/draftReply.ts -> DRAFT_UNAVAILABLE,
  // no Send). Failing here fixes the chat path too, which shipped the same bare
  // greeting with sendable: true.
  if (!body.trim()) {
    logger.error(
      {
        event: "pipeline_failure",
        kind: "draft_empty_body",
        dealId,
        athleteId,
        reply_intent: replyIntent,
      },
      "draft generation produced no body — refusing to ship the bare greeting",
    );
    return { ok: false, reason: "empty_body" };
  }

  // Greeting + sanitized body + code-composed signature — a complete, sendable email.
  const fullText = assembleReplyEmail({ greeting, body, signature });

  // Persist the completed draft so closing the sheet without sending never loses it —
  // reopening the deal restores this text. Nomila-only: no `mirrorToGmail`, so trying
  // three phrasings no longer writes three times into the athlete's real mailbox. The
  // explicit "Save as draft" button is what reaches Gmail (saveThreadDraft's module note).
  //
  // `body` is non-empty past the empty-body guard above; the check stays because
  // `thread` can still be null (a deal with no thread has nothing to persist against).
  if (thread && body) {
    try {
      const { saveThreadDraft } = await import("./saveThreadDraft.js");
      await saveThreadDraft({
        athleteId,
        dealId,
        threadId: thread.id,
        body: fullText,
        meta: {
          reply_intent: replyIntent,
          style,
          voice,
          generated_at: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, "Failed to persist draft");
    }
  }

  logger.info(
    {
      dealId,
      athleteId,
      reply_intent: replyIntent,
      style,
      voice,
      chars: fullText.length,
    },
    "Draft generated",
  );
  return { ok: true, fullText, params: outParams, threadId: thread?.id ?? null };
}
